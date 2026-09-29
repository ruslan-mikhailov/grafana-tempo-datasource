import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoQuery } from '../types';
import { intrinsics } from '../traceql/traceql';

import { type ProtectedAttributeKey } from './crypto';
import { classifyProtectedTraceQL, isCiphertextQueryValue, protectedTraceQLPredicates } from './traceql';

// The shortest envelope seals an empty value: 12-byte nonce and 16-byte tag.
// The canonical base64url spelling is checked here; opening authenticates it.
const modelEnvelope = /^qenc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]{38,})$/;
const variable = /\$\{[^}]+\}|\$[A-Za-z_][\w]*|\[\[[^\]]+\]\]/;
const scopeVariable = /^(?:\$\{[^}\s]+\}|\$[A-Za-z_]\w*|\[\[[^\]\s]+\]\])$/;
const builderTag = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;
const quotedTagPart = /"(?:\\["\\]|[^"\\\u0000-\u001f])*"/g;
const variableTagPart = /\$\{[^}\s]+\}|\$[A-Za-z_]\w*|\[\[[^\]\s]+\]\]/g;
const builderOperators = ['=', '!=', '>', '<', '>=', '<=', '=~', '!~', '@>', '!@>'];
const unsafe = () => new Error('Protected query model cannot be saved or opened');

export function isProtectedModelEnvelope(value: string): boolean {
  const match = modelEnvelope.exec(value);
  if (!match || match[2].length % 4 === 1) {
    return false;
  }
  // Canonical base64url has zero unused bits in its final character.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const remainder = match[2].length % 4;
  const trailing = alphabet.indexOf(match[2][match[2].length - 1]);
  return remainder === 0 || (remainder === 2 && trailing % 16 === 0) || (remainder === 3 && trailing % 4 === 0);
}

export function isVariableBearing(value: string): boolean {
  return variable.test(value);
}

function decodedBuilderTag(tag: string): string {
  return tag.replace(/"((?:\\[\\"]|[^"\\])*)"/g, (_, identifier: string) => identifier.replace(/\\(["\\])/g, '$1'));
}
export function classifyProtectedFilter(filter: TraceqlFilter): {
  requiresSealing: boolean;
  protectedReference: boolean;
  dynamicReference: boolean;
} {
  const scope = filter.scope ?? TraceqlSearchScope.Unscoped;
  const tag = filter.tag ?? '';
  const dynamicReference = isVariableBearing(String(scope)) || isVariableBearing(tag);
  if (decodedBuilderTag(tag).startsWith('bi.')) {
    throw unsafe();
  }
  const protectedReference =
    decodedBuilderTag(tag).startsWith('enc.') || (tag.startsWith('\"enc.') && tag.includes('enc.'));
  return { requiresSealing: protectedReference || dynamicReference, protectedReference, dynamicReference };
}

export function isProtectedTagValueRequest(tag: string): boolean {
  const decoded = decodedBuilderTag(tag);
  return decoded.startsWith('enc.') || decoded.startsWith('.enc.') || decoded.startsWith('span.enc.') ||
    decoded.startsWith('bi.') || decoded.startsWith('.bi.') ||
    /^(?:span|resource|event|link|instrumentation)\.bi\./.test(decoded);
}

function filterContext(uid: string, filter: TraceqlFilter, index?: number): string {
  if (!uid || !filter.id) {
    throw unsafe();
  }
  return JSON.stringify(
    index === undefined ? [uid, 'filters', filter.id, 'value'] : [uid, 'filters', filter.id, 'value', String(index)]
  );
}

function queryContext(uid: string): string {
  if (!uid) {
    throw unsafe();
  }
  return JSON.stringify([uid, 'query']);
}

function assertFilterShape(filter: TraceqlFilter, substringEnabled = false): void {
  if (
    filter.scope &&
    !Object.values(TraceqlSearchScope).includes(filter.scope) &&
    !scopeVariable.test(String(filter.scope))
  ) {
    throw unsafe();
  }
  if (
    filter.tag &&
    !builderTag.test(filter.tag.replace(quotedTagPart, 'x').replace(variableTagPart, 'x')) &&
    !(
      intrinsics.includes(filter.tag) &&
      (!filter.scope ||
        filter.scope === TraceqlSearchScope.Intrinsic ||
        filter.scope === TraceqlSearchScope.Unscoped ||
        filter.scope === filter.tag.split(':', 1)[0])
    )
  ) {
    throw unsafe();
  }
  if (filter.operator && !builderOperators.includes(filter.operator)) {
    throw unsafe();
  }
  if (filter.protectedKeyId !== undefined &&
    (!/^[0-9a-f]{32}$/.test(filter.protectedKeyId) ||
      !classifyProtectedFilter(filter).protectedReference ||
      !['=', '!=', '=~', '!~', '@>', '!@>'].includes(filter.operator ?? ''))) {
    throw unsafe();
  }
  const { requiresSealing, dynamicReference, protectedReference } = classifyProtectedFilter(filter);
  const directSubstring = typeof filter.value === 'string' && protectedReference && !dynamicReference &&
    isCiphertextQueryValue(filter.value);
  if ((filter.operator === '@>' || filter.operator === '!@>') &&
    (Array.isArray(filter.value) || dynamicReference ||
      (filter.value !== undefined && !protectedReference && filter.valueType !== 'string') ||
      (protectedReference && ((!substringEnabled && !directSubstring) || filter.scope !== TraceqlSearchScope.Span)))) {
    throw unsafe();
  }
  if (requiresSealing && filter.operator && !['=', '!=', '=~', '!~',
    ...(substringEnabled || directSubstring ? ['@>', '!@>'] : [])].includes(filter.operator)) {
    throw unsafe();
  }
  if (protectedReference && !dynamicReference && filter.scope !== TraceqlSearchScope.Span) {
    throw unsafe();
  }
  const hasValue = typeof filter.value === 'string' || (Array.isArray(filter.value) && filter.value.length > 0);
  if (
    requiresSealing &&
    hasValue &&
    (!filter.tag || !filter.operator || (filter.scope !== TraceqlSearchScope.Span && !dynamicReference))
  ) {
    throw unsafe();
  }
  if (requiresSealing) {
    for (const value of Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value]) {
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('Protected string contains a character unsupported by TraceQL');
      }
    }
  }
  if (!requiresSealing) {
    for (const value of Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value]) {
      if (/[\u0000-\u001f\u007f]/.test(value) || (filter.valueType !== 'string' && /["\\{}&|=;]/.test(value))) {
        throw unsafe();
      }
    }
  }
}

function assertFilterIds(filters: TraceqlFilter[]): void {
  const ids = new Set<string>();
  for (const filter of filters) {
    if (!filter.id || ids.has(filter.id)) {
      throw unsafe();
    }
    ids.add(filter.id);
  }
}

export function assertStaticProtectedFilterDefaultsSafe(filters: TraceqlFilter[] | undefined, substringEnabled = false): void {
  for (const filter of filters ?? []) {
    assertFilterShape(filter, substringEnabled);
    if (
      filter.value !== undefined &&
      (!Array.isArray(filter.value) || filter.value.length > 0) &&
      (classifyProtectedFilter(filter).requiresSealing || !filter.tag || isVariableBearing(filter.operator ?? ''))
    ) {
      throw new Error('Configured search filter value may target a protected attribute');
    }
  }
}

function classifyRaw(value: string, substringEnabled = false): boolean {
  if (!value || /^[0-9A-Fa-f]*$/.test(value.trim())) {
    return false;
  }
  return classifyProtectedTraceQL(value, substringEnabled).requiresSealing;
}

function assertNoLegacyCarriers(model: TempoQuery): void {
  if (model.search) {
    throw unsafe();
  }
  for (const filter of model.groupBy ?? []) {
    assertFilterShape(filter);
    if (classifyProtectedFilter(filter).requiresSealing) {
      throw unsafe();
    }
  }
}

export function assertProtectedQueryModelSafe(model: TempoQuery, kids?: string | readonly string[], substringEnabled = false): void {
  if ((typeof kids === 'string' ? [kids] : (kids ?? [])).some((kid) => !/^[0-9a-f]{32}$/.test(kid))) {
    throw unsafe();
  }
  assertNoLegacyCarriers(model);
  if (model.protectedQueryKeys !== undefined) {
    if (!Array.isArray(model.protectedQueryKeys) || model.queryType !== 'traceql' ||
      model.protectedQueryKeys.some((item) => {
        if (!item || typeof item.predicate !== 'string' || !/^[0-9a-f]{32}$/.test(item.kid)) {
          return true;
        }
        try {
          const identity = JSON.parse(item.predicate);
          return !Array.isArray(identity) || identity.length !== 4 ||
            !Number.isSafeInteger(identity[0]) || identity[0] < 0 ||
            !Number.isSafeInteger(identity[1]) || identity[1] <= identity[0] ||
            typeof identity[2] !== 'string' || !identity[2].startsWith('enc.') ||
            !['=', '!=', '=~', '!~', '@>', '!@>'].includes(identity[3]) ||
            JSON.stringify(identity) !== item.predicate;
        } catch {
          return true;
        }
      }) ||
      new Set(model.protectedQueryKeys.map((item) => item.predicate)).size !== model.protectedQueryKeys.length) {
      throw unsafe();
    }
  }
  if (model.query) {
    if (model.query.startsWith('qenc:')) {
      if (!isProtectedModelEnvelope(model.query)) {
        throw unsafe();
      }
    } else if (classifyRaw(model.query, substringEnabled)) {
      throw unsafe();
    }
  }
  assertFilterIds(model.filters ?? []);
  for (const filter of model.filters ?? []) {
    assertFilterShape(filter, substringEnabled);
    const { requiresSealing } = classifyProtectedFilter(filter);
    const values = Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value];
    for (const value of values) {
      if (value.startsWith('qenc:')) {
        if (!isProtectedModelEnvelope(value) || !requiresSealing) {
          throw unsafe();
        }
      } else if (requiresSealing && !isDirectCiphertextFilter(filter, value)) {
        throw unsafe();
      }
    }
  }
}

function isDirectCiphertextFilter(filter: TraceqlFilter, value: string): boolean {
  const { protectedReference, dynamicReference } = classifyProtectedFilter(filter);
  return (
    protectedReference &&
    !dynamicReference &&
    filter.scope === TraceqlSearchScope.Span &&
    ['=', '!=', '=~', '!~', '@>', '!@>'].includes(filter.operator ?? '') &&
    isCiphertextQueryValue(value)
  );
}

/** The builder emits protected predicates in filter order, including each multi-value arm. */
export function protectedFilterSelections(query: string, filters: TraceqlFilter[], substringEnabled = false): Array<{ predicate: string; kid: string }> {
  const predicates = protectedTraceQLPredicates(query, substringEnabled);
  const selections: Array<{ predicate: string; kid: string }> = [];
  let cursor = 0;
  for (const filter of filters) {
    if (filter.value === undefined || !classifyProtectedFilter(filter).protectedReference) {
      continue;
    }
    const count = Array.isArray(filter.value) ? filter.value.length : 1;
    const assigned = predicates.slice(cursor, cursor + count);
    if (assigned.length !== count || assigned.some((predicate) =>
      predicate.field !== decodedBuilderTag(filter.tag ?? '') || predicate.operator !== filter.operator)) {
      throw unsafe();
    }
    if (filter.protectedKeyId) {
      selections.push(...assigned.map((predicate) => ({ predicate: predicate.predicate, kid: filter.protectedKeyId! })));
    }
    cursor += count;
  }
  if (cursor !== predicates.length) {
    throw unsafe();
  }
  return selections;
}

type KeyLookup = ProtectedAttributeKey | ((kid: string) => ProtectedAttributeKey | undefined) | undefined;

function keyForEnvelope(envelope: string, keys: KeyLookup): ProtectedAttributeKey {
  const kid = modelEnvelope.exec(envelope)?.[1];
  const key = kid && (typeof keys === 'function' ? keys(kid) : keys?.kid === kid ? keys : undefined);
  if (!key) {
    throw unsafe();
  }
  return key;
}

export async function prepareProtectedQueryModel(
  draft: TempoQuery,
  key: ProtectedAttributeKey,
  uid: string,
  source?: TempoQuery,
  lookup?: (kid: string) => ProtectedAttributeKey | undefined,
  substringEnabled = false
): Promise<TempoQuery> {
  if (!key || !uid) {
    throw unsafe();
  }
  assertNoLegacyCarriers(draft);
  let query = draft.query;
  if (query && source?.query === query && isProtectedModelEnvelope(query)) {
    await keyForEnvelope(query, lookup ?? key).openQueryModel(query, queryContext(uid));
  } else if (query && classifyRaw(query, substringEnabled)) {
    query = await key.sealQueryModel(query, queryContext(uid));
  }
  const filters = draft.filters ?? [];
  assertFilterIds(filters);
  const sealedFilters = await Promise.all(
    filters.map(async (filter) => {
      assertFilterShape(filter, substringEnabled);
      if (!classifyProtectedFilter(filter).requiresSealing || filter.value === undefined) {
        return filter;
      }
      const sourceValue = source?.filters?.find((item) => item.id === filter.id)?.value;
      const seal = async (value: string, index?: number) => {
        const original =
          index === undefined ? sourceValue : Array.isArray(sourceValue) ? sourceValue[index] : undefined;
        const context = filterContext(uid, filter, index);
        if (original === value && isProtectedModelEnvelope(value)) {
          await keyForEnvelope(value, lookup ?? key).openQueryModel(value, context);
          return value;
        }
        if (isDirectCiphertextFilter(filter, value)) {
          return value;
        }
        return key.sealQueryModel(value, context);
      };
      const value = Array.isArray(filter.value)
        ? await Promise.all(filter.value.map((item, index) => seal(item, index)))
        : await seal(filter.value);
      return { ...filter, value, valueType: 'string' };
    })
  );
  const prepared = { ...draft, query, filters: sealedFilters };
  assertProtectedQueryModelSafe(prepared, key.kid, substringEnabled);
  return prepared;
}

export async function openProtectedQueryModel(model: TempoQuery, keys: KeyLookup, uid: string, substringEnabled = false): Promise<TempoQuery> {
  if (!uid) {
    throw unsafe();
  }
  assertProtectedQueryModelSafe(model, undefined, substringEnabled);
  const query = model.query?.startsWith('qenc:')
    ? await keyForEnvelope(model.query, keys).openQueryModel(model.query, queryContext(uid))
    : model.query;
  const filters = await Promise.all(
    (model.filters ?? []).map(async (filter) => {
      if (!classifyProtectedFilter(filter).requiresSealing || filter.value === undefined) {
        return filter;
      }
      const open = (value: string, index?: number) =>
        value.startsWith('qenc:')
          ? keyForEnvelope(value, keys).openQueryModel(value, filterContext(uid, filter, index))
          : value;
      const value = Array.isArray(filter.value)
        ? await Promise.all(filter.value.map((item, index) => open(item, index)))
        : await open(filter.value);
      return { ...filter, value };
    })
  );
  return { ...model, query, filters };
}
