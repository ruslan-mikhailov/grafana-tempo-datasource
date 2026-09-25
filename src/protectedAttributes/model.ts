import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoQuery } from '../types';
import { intrinsics } from '../traceql/traceql';

import { type ProtectedAttributeKey } from './crypto';
import { classifyProtectedTraceQL } from './traceql';

// The shortest envelope seals an empty value: 12-byte nonce and 16-byte tag.
// The canonical base64url spelling is checked here; opening authenticates it.
const modelEnvelope = /^qenc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]{38,})$/;
const variable = /\$\{[^}]+\}|\$[A-Za-z_][\w]*|\[\[[^\]]+\]\]/;
const scopeVariable = /^(?:\$\{[^}\s]+\}|\$[A-Za-z_]\w*|\[\[[^\]\s]+\]\])$/;
const builderTag = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;
const quotedTagPart = /"(?:\\["\\]|[^"\\\u0000-\u001f])*"/g;
const variableTagPart = /\$\{[^}\s]+\}|\$[A-Za-z_]\w*|\[\[[^\]\s]+\]\]/g;
const builderOperators = ['=', '!=', '>', '<', '>=', '<=', '=~', '!~'];
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
  const protectedReference =
    decodedBuilderTag(tag).startsWith('enc.') || (tag.startsWith('\"enc.') && tag.includes('enc.'));
  return { requiresSealing: protectedReference || dynamicReference, protectedReference, dynamicReference };
}

export function isProtectedTagValueRequest(tag: string): boolean {
  const decoded = decodedBuilderTag(tag);
  return decoded.startsWith('span.enc.') || decoded.startsWith('enc.') || decoded.startsWith('.enc.');
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

function assertFilterShape(filter: TraceqlFilter): void {
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
  const { requiresSealing, dynamicReference, protectedReference } = classifyProtectedFilter(filter);
  if (requiresSealing && filter.operator && !['=', '!='].includes(filter.operator)) {
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

export function assertStaticProtectedFilterDefaultsSafe(filters: TraceqlFilter[] | undefined): void {
  for (const filter of filters ?? []) {
    assertFilterShape(filter);
    if (
      filter.value !== undefined &&
      (!Array.isArray(filter.value) || filter.value.length > 0) &&
      (classifyProtectedFilter(filter).requiresSealing || !filter.tag || isVariableBearing(filter.operator ?? ''))
    ) {
      throw new Error('Configured search filter value may target a protected attribute');
    }
  }
}

function classifyRaw(value: string): boolean {
  if (!value || /^[0-9A-Fa-f]*$/.test(value.trim())) {
    return false;
  }
  return classifyProtectedTraceQL(value).requiresSealing;
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

export function assertProtectedQueryModelSafe(model: TempoQuery, kid?: string): void {
  if (kid !== undefined && !/^[0-9a-f]{32}$/.test(kid)) {
    throw unsafe();
  }
  assertNoLegacyCarriers(model);
  if (model.query) {
    if (model.query.startsWith('qenc:')) {
      if (!isProtectedModelEnvelope(model.query) || (kid && !model.query.startsWith(`qenc:v1:${kid}:`))) {
        throw unsafe();
      }
    } else if (classifyRaw(model.query)) {
      throw unsafe();
    }
  }
  assertFilterIds(model.filters ?? []);
  for (const filter of model.filters ?? []) {
    assertFilterShape(filter);
    const { requiresSealing } = classifyProtectedFilter(filter);
    const values = Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value];
    for (const value of values) {
      if (value.startsWith('qenc:')) {
        if (!isProtectedModelEnvelope(value) || (kid && !value.startsWith(`qenc:v1:${kid}:`)) || !requiresSealing) {
          throw unsafe();
        }
      } else if (requiresSealing) {
        throw unsafe();
      }
    }
  }
}

export async function prepareProtectedQueryModel(
  draft: TempoQuery,
  key: ProtectedAttributeKey,
  uid: string,
  source?: TempoQuery
): Promise<TempoQuery> {
  if (!key || !uid) {
    throw unsafe();
  }
  assertNoLegacyCarriers(draft);
  let query = draft.query;
  if (query && source?.query === query && isProtectedModelEnvelope(query)) {
    await key.openQueryModel(query, queryContext(uid));
  } else if (query && classifyRaw(query)) {
    query = await key.sealQueryModel(query, queryContext(uid));
  }
  const filters = draft.filters ?? [];
  assertFilterIds(filters);
  const sealedFilters = await Promise.all(
    filters.map(async (filter) => {
      assertFilterShape(filter);
      if (!classifyProtectedFilter(filter).requiresSealing || filter.value === undefined) {
        return filter;
      }
      const sourceValue = source?.filters?.find((item) => item.id === filter.id)?.value;
      const seal = async (value: string, index?: number) => {
        const original =
          index === undefined ? sourceValue : Array.isArray(sourceValue) ? sourceValue[index] : undefined;
        const context = filterContext(uid, filter, index);
        if (original === value && isProtectedModelEnvelope(value)) {
          await key.openQueryModel(value, context);
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
  assertProtectedQueryModelSafe(prepared, key.kid);
  return prepared;
}

export async function openProtectedQueryModel(
  model: TempoQuery,
  key: ProtectedAttributeKey | undefined,
  uid: string
): Promise<TempoQuery> {
  if (!uid) {
    throw unsafe();
  }
  if (!key) {
    assertNoLegacyCarriers(model);
    assertFilterIds(model.filters ?? []);
    if (
      (model.query && (model.query.startsWith('qenc:') || classifyRaw(model.query))) ||
      (model.filters ?? []).some((filter) =>
        (Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value]).some(
          (value) => value.startsWith('qenc:') || classifyProtectedFilter(filter).requiresSealing
        )
      )
    ) {
      throw unsafe();
    }
    return model;
  }
  assertProtectedQueryModelSafe(model, key.kid);
  const query = model.query?.startsWith('qenc:')
    ? await key.openQueryModel(model.query, queryContext(uid))
    : model.query;
  const filters = await Promise.all(
    (model.filters ?? []).map(async (filter) => {
      if (!classifyProtectedFilter(filter).requiresSealing || filter.value === undefined) {
        return filter;
      }
      const open = (value: string, index?: number) =>
        value.startsWith('qenc:') ? key.openQueryModel(value, filterContext(uid, filter, index)) : value;
      const value = Array.isArray(filter.value)
        ? await Promise.all(filter.value.map((item, index) => open(item, index)))
        : await open(filter.value);
      return { ...filter, value };
    })
  );
  return { ...model, query, filters };
}
