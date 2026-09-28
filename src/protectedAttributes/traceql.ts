import {
  AttributeField,
  BlockComment,
  FieldExpression,
  FieldOp,
  Identifier,
  LineComment,
  MetricsOperation,
  parser,
  Pipe,
  SelectArgs,
  SelectOperation,
  Span,
  SpansetFilter,
  SpansetPipeline,
  SpansetPipelineExpression,
  Static,
  String as StringNode,
  TemplateVariable,
  TraceQL,
  WithHint,
} from '@grafana/lezer-traceql';
import type { SyntaxNode } from '@lezer/common';

import type { ProtectedAttributeKey } from './crypto';

const invalid = (): never => {
  throw new Error('Invalid or unsupported protected TraceQL query.');
};

/** Only canonical stored-attribute envelopes may bypass browser-side encryption. */
export function isEncryptedAttributeEnvelope(value: string): boolean {
  const match = /^enc:v1:[0-9a-f]{32}:([A-Za-z0-9_-]{22,})$/.exec(value);
  if (!match) {
    return false;
  }
  const payload = match[1];
  const remainder = payload.length % 4;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(payload[payload.length - 1]);
  return (
    remainder !== 1 && (remainder === 0 || (remainder === 2 && last % 16 === 0) || (remainder === 3 && last % 4 === 0))
  );
}

type Edit = { from: number; to: number; text: string };
type Predicate = { field: string; lhs: SyntaxNode; rhs: SyntaxNode; comparison: SyntaxNode; op: '=' | '!=' | '@>' | '!@>' };
type Attribute = { field: string; protected: boolean; dynamic: boolean };
export interface ProtectedTraceQLPredicate {
  predicate: string;
  field: string;
  operator: string;
  from: number;
  to: number;
  keyRequired: boolean;
}
/** Positions plus field/operator prevent a moved predicate inheriting another predicate's choice. */
export function protectedTraceQLPredicates(query: string, substringEnabled = false): ProtectedTraceQLPredicate[] {
  return inspect(query, false, substringEnabled).predicates.map(({ field, op, rhs, comparison }) => ({
    predicate: JSON.stringify([comparison.from, comparison.to, field, op]),
    field,
    operator: op,
    keyRequired: op === '@>' || op === '!@>' || !isEncryptedAttributeEnvelope(literal(rhs, query)),
    from: comparison.from,
    to: comparison.to,
  }));
}
/** Reject incomplete or forgotten choices before a plaintext draft can reach host onChange. */
export function assertProtectedTraceQLKeyChoices(
  query: string,
  keys: readonly { kid: string }[],
  choices: readonly { predicate: string; kid: string }[],
  substringEnabled = false
): void {
  const predicates = protectedTraceQLPredicates(query, substringEnabled);
  const chosen = new Map<string, string>();
  for (const choice of choices) {
    if (!/^[0-9a-f]{32}$/.test(choice.kid) || chosen.has(choice.predicate) ||
      !predicates.some((item) => item.predicate === choice.predicate) ||
      !keys.some((key) => key.kid === choice.kid)) {
      invalid();
    }
    chosen.set(choice.predicate, choice.kid);
  }
  if (predicates.some((predicate) => predicate.keyRequired && !chosen.has(predicate.predicate) && keys.length !== 1)) {
    invalid();
  }
}
/** Rebind only unchanged, unambiguous predicate text after a local editor edit. */
export function rebaseProtectedTraceQLKeys(
  previous: string,
  next: string,
  choices: readonly { predicate: string; kid: string }[],
  substringEnabled = false
): Array<{ predicate: string; kid: string }> {
  if (!choices.length || previous === next) {
    return [...choices];
  }
  const prior = protectedTraceQLPredicates(previous, substringEnabled);
  const current = protectedTraceQLPredicates(next, substringEnabled);
  const result: Array<{ predicate: string; kid: string }> = [];
  for (const choice of choices) {
    const predicate = prior.find((item) => item.predicate === choice.predicate);
    if (!predicate) {
      continue;
    }
    const text = previous.slice(predicate.from, predicate.to);
    const matches = current.filter((item) =>
      item.field === predicate.field &&
      item.operator === predicate.operator &&
      next.slice(item.from, item.to) === text);
    if (matches.length === 1 && prior.filter((item) =>
      item.field === predicate.field &&
      item.operator === predicate.operator &&
      previous.slice(item.from, item.to) === text).length === 1) {
      result.push({ predicate: matches[0].predicate, kid: choice.kid });
    }
  }
  return result;
}

export type ProtectedTraceQLClassification = {
  requiresSealing: boolean;
  protectedReferences: boolean;
  dynamicReferences: boolean;
  protectedRhsRanges: Array<{ from: number; to: number }>;
};

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.id !== LineComment && child.type.id !== BlockComment) {
      result.push(child);
    }
  }
  return result;
}

function sameNode(left: SyntaxNode | null, right: SyntaxNode | null): boolean {
  return !!left && !!right && left.type.id === right.type.id && left.from === right.from && left.to === right.to;
}

// The Identifier token includes all dotted components. A dot inside a quoted
// component belongs to the name, not to the TraceQL scope.
function decodedIdentifier(source: string): string {
  let result = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '"') {
      if (source[i] === '\\' || source.charCodeAt(i) < 32 || source[i] === '}') {
        invalid();
      }
      result += source[i];
      continue;
    }
    i++;
    let closed = false;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"') {
        closed = true;
        break;
      }
      if (ch === '\\') {
        i++;
        if (source[i] !== '"' && source[i] !== '\\') {
          invalid();
        }
        result += source[i];
      } else {
        if (ch.charCodeAt(0) < 32) {
          invalid();
        }
        result += ch;
      }
    }
    if (!closed) {
      invalid();
    }
  }
  return result;
}

function attribute(node: SyntaxNode, query: string): Attribute {
  const parts = children(node);
  const scope = parts[0]?.type.id;
  const name = parts.find((part) => part.type.id === Identifier) ?? invalid();
  const raw = query.slice(name.from, name.to);
  const dynamic = raw.includes('$') || parts.some((part) => part.type.id === TemplateVariable);
  // A variable can change the stored field, even if today's value is ordinary.
  if (dynamic) {
    return { field: '', protected: false, dynamic: true };
  }
  const field = decodedIdentifier(raw);
  if (field.startsWith('bi.')) {
    invalid(); // The sidecar is an internal transport field, never a user query.
  }
  const protectedField = field.startsWith('enc.');
  if (protectedField && (scope !== Span || parts[0]?.from !== node.from || name.from <= parts[0].to)) {
    invalid();
  }
  return { field, protected: protectedField, dynamic: false };
}

function literal(node: SyntaxNode, query: string): string {
  const raw = query.slice(node.from, node.to);
  if (raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    invalid();
  }
  for (let i = 1; i < raw.length - 1; i++) {
    const char = raw[i];
    if (char === '\\') {
      if (raw[++i] !== '"' && raw[i] !== '\\') {
        invalid();
      }
    } else if (char === '"' || raw.charCodeAt(i) < 32) {
      invalid();
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return invalid();
  }
}

function directSelect(attributeNode: SyntaxNode): SyntaxNode | undefined {
  const expression = attributeNode.parent;
  const args = expression?.parent;
  const parts = expression ? children(expression) : [];
  if (
    expression?.type.id !== FieldExpression ||
    parts.length !== 1 ||
    !sameNode(parts[0], attributeNode) ||
    args?.type.id !== SelectArgs
  ) {
    return undefined;
  }
  for (let current: SyntaxNode | null = args; current; current = current.parent) {
    if (current.type.id === SelectOperation) {
      return current;
    }
    if (current.type.id !== SelectArgs) {
      break;
    }
  }
  return undefined;
}

function predicateFor(attributeNode: SyntaxNode, query: string): Predicate {
  const lhs = attributeNode.parent;
  const comparison = lhs?.parent;
  const lhsParts = lhs ? children(lhs) : [];
  if (
    lhs?.type.id !== FieldExpression ||
    lhsParts.length !== 1 ||
    !sameNode(lhsParts[0], attributeNode) ||
    comparison?.type.id !== FieldExpression
  ) {
    return invalid();
  }
  const nodes = children(comparison);
  if (
    nodes.length !== 3 ||
    !sameNode(nodes[0], lhs) ||
    nodes[1].type.id !== FieldOp ||
    nodes[2].type.id !== FieldExpression
  ) {
    return invalid();
  }
  const op = query.slice(nodes[1].from, nodes[1].to);
  if (op !== '=' && op !== '!=' && op !== '@>' && op !== '!@>') {
    return invalid();
  }
  const right = children(nodes[2]);
  if (right.length !== 1 || right[0].type.id !== Static) {
    return invalid();
  }
  const literalNodes = children(right[0]);
  if (literalNodes.length !== 1 || literalNodes[0].type.id !== StringNode) {
    return invalid();
  }
  let ancestor: SyntaxNode | null = comparison.parent;
  while (ancestor?.type.id === FieldExpression) {
    ancestor = ancestor.parent;
  }
  if (ancestor?.type.id !== SpansetFilter) {
    return invalid();
  }
  literal(literalNodes[0], query);
  return { field: '', lhs, rhs: literalNodes[0], comparison, op };
}

function variableMayNameField(node: SyntaxNode, query: string): boolean {
  for (let expression = node.parent; expression; expression = expression.parent) {
    const parent = expression.parent;
    if (expression.type.id !== FieldExpression || parent?.type.id !== FieldExpression) {
      continue;
    }
    const parts = children(parent);
    if (parts.length !== 3 || parts[1].type.id !== FieldOp) {
      continue;
    }
    const operator = query.slice(parts[1].from, parts[1].to);
    if (
      operator === '=' ||
      operator === '!=' ||
      operator === '@>' ||
      operator === '!@>' ||
      operator === '>' ||
      operator === '<' ||
      operator === '>=' ||
      operator === '<=' ||
      operator === '=~' ||
      operator === '!~'
    ) {
      return node.from >= parts[0].from && node.to <= parts[0].to;
    }
  }
  return true; // A free-standing template expression may supply a whole field or query fragment.
}

function inspect(
  query: string,
  allowVariableRecovery = false,
  substringEnabled = false
): {
  classification: ProtectedTraceQLClassification;
  predicates: Predicate[];
  selects: SyntaxNode[];
  root: SyntaxNode;
} {
  const tree = parser.parse(query);
  const root = tree.topNode;
  if (root.type.id !== TraceQL || root.to !== query.length) {
    invalid();
  }
  let hasRecovery = false;
  let hasTemplateVariable = query.includes('$');
  tree.iterate({
    enter(node) {
      hasRecovery ||= node.type.isError || node.type.id === 0;
      hasTemplateVariable ||= node.type.id === TemplateVariable;
    },
  });
  if (hasRecovery) {
    if (allowVariableRecovery && hasTemplateVariable) {
      return {
        root,
        selects: [],
        predicates: [],
        classification: {
          protectedReferences: false,
          dynamicReferences: true,
          requiresSealing: true,
          protectedRhsRanges: [],
        },
      };
    }
    invalid();
  }
  let protectedReferences = false;
  let dynamicReferences = false;
  const predicates: Predicate[] = [];
  const selects: SyntaxNode[] = [];
  // Recovery was handled above: outbound always fails closed, while the model
  // classifier may seal an unresolved variable-bearing draft conservatively.
  tree.iterate({
    enter(node) {
      if (node.type.id === TemplateVariable && variableMayNameField(node.node, query)) {
        dynamicReferences = true;
      }
      if (node.type.id === SelectOperation) {
        selects.push(node.node);
      }
      if (node.type.id !== AttributeField) {
        return;
      }
      const parsed = attribute(node.node, query);
      dynamicReferences ||= parsed.dynamic;
      if (!parsed.protected) {
        return;
      }
      protectedReferences = true;
      if (directSelect(node.node)) {
        return;
      }
      const predicate = predicateFor(node.node, query);
      if ((predicate.op === '@>' || predicate.op === '!@>') && !substringEnabled) {
        invalid();
      }
      predicate.field = parsed.field;
      predicates.push(predicate);
    },
  });
  return {
    root,
    selects,
    predicates,
    classification: {
      protectedReferences,
      dynamicReferences,
      requiresSealing:
        dynamicReferences ||
        (protectedReferences &&
          (!predicates.length || predicates.some(({ rhs, op }) => op === '@>' || op === '!@>' || !isEncryptedAttributeEnvelope(literal(rhs, query))))),
      protectedRhsRanges: predicates.map(({ rhs }) => ({ from: rhs.from, to: rhs.to })),
    },
  };
}

/** Classify an original editor query before it can enter a Grafana host model. */
export function classifyProtectedTraceQL(query: string, substringEnabled = false): ProtectedTraceQLClassification {
  return inspect(query, true, substringEnabled).classification;
}

/** Inspect pipeline syntax only: compiled inequality guards contain protected != nil. */
export function isMetricsTraceQL(query: string): boolean {
  const tree = parser.parse(query);
  if (tree.topNode.type.id !== TraceQL || tree.topNode.to !== query.length) {
    invalid();
  }
  let metrics = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError || node.type.id === 0) {
        invalid();
      }
      if (node.type.id === MetricsOperation && node.node.parent?.type.id === SpansetPipeline) {
        metrics = true;
      }
    },
  });
  return metrics;
}

function pipelineSelect(root: SyntaxNode, selects: SyntaxNode[]): SyntaxNode | undefined {
  const parts = children(root);
  const top = parts[0];
  if (top?.type.id !== SpansetPipelineExpression || parts.length > 2 || (parts[1] && parts[1].type.id !== WithHint)) {
    invalid();
  }
  const stages: SyntaxNode[] = [];
  const walk = (node: SyntaxNode): void => {
    const parts = children(node);
    if (
      parts.length === 3 &&
      parts[1].type.id === Pipe &&
      parts[0].type.id === SpansetPipelineExpression &&
      parts[2].type.id === SpansetPipelineExpression
    ) {
      walk(parts[0]);
      walk(parts[2]);
    } else if (parts.length === 1 && parts[0].type.id === SpansetPipeline) {
      const operation = children(parts[0]);
      if (operation.length !== 1) {
        invalid();
      }
      stages.push(operation[0]);
    } else {
      invalid();
    }
  };
  walk(top);
  if (
    stages.length < 1 ||
    stages[0].type.id !== SpansetFilter ||
    stages.length > 2 ||
    (stages.length === 2 && stages[1].type.id !== SelectOperation) ||
    selects.length > 1
  ) {
    invalid();
  }
  return stages[1];
}

function selectedFields(select: SyntaxNode, query: string): Set<string> {
  const args = children(select)[0];
  if (args?.type.id !== SelectArgs || query[select.to - 1] !== ')') {
    invalid();
  }
  const fields = new Set<string>();
  const collect = (node: SyntaxNode): void => {
    for (const child of children(node)) {
      if (child.type.id === SelectArgs) {
        collect(child);
      } else if (child.type.id === FieldExpression) {
        const parts = children(child);
        if (parts.length !== 1) {
          invalid();
        }
        if (parts[0].type.id === AttributeField) {
          const parsed = attribute(parts[0], query);
          if (parsed.dynamic) {
            invalid();
          }
          if (parsed.protected) {
            fields.add(parsed.field);
          }
        }
      } else {
        invalid();
      }
    }
  };
  collect(args);
  return fields;
}

/** Translate finalized TraceQL only, never a persisted model or editor draft. */
export async function rewriteProtectedTraceQL(
  query: string,
  keys: readonly ProtectedAttributeKey[] | ProtectedAttributeKey | undefined,
  mode: 'search' | 'metrics' | 'metadata',
  substringEnabled = false,
  selections: readonly { predicate: string; kid: string }[] = []
): Promise<string> {
  const { root, predicates, selects, classification } = inspect(query, false, substringEnabled);
  if (classification.dynamicReferences) {
    invalid();
  }
  const protectedKeys = keys === undefined ? [] : Array.isArray(keys) ? keys : [keys as ProtectedAttributeKey];
  const available = new Map(protectedKeys.map((key) => [key.kid, key]));
  const selected = new Map<string, string>();
  for (const choice of selections) {
    if (!/^[0-9a-f]{32}$/.test(choice.kid) || selected.has(choice.predicate)) {
      invalid();
    }
    selected.set(choice.predicate, choice.kid);
  }
  const validPredicates = new Set(predicates.map(({ comparison, field, op }) =>
    JSON.stringify([comparison.from, comparison.to, field, op])));
  if ([...selected.keys()].some((predicate) => !validPredicates.has(predicate))) {
    invalid();
  }
  if (!predicates.length) {
    return query;
  }
  const edits: Edit[] = [];
  const fields = new Map<string, string>();
  for (const predicate of predicates) {
    const choice = selected.get(JSON.stringify([predicate.comparison.from, predicate.comparison.to, predicate.field, predicate.op]));
    const key = choice ? available.get(choice) : protectedKeys.length === 1 ? protectedKeys[0] : undefined;
    if (choice && !key) {
      invalid();
    }
    if (!fields.has(predicate.field)) {
      fields.set(predicate.field, query.slice(predicate.lhs.from, predicate.lhs.to));
    }
    if (predicate.op === '@>' || predicate.op === '!@>') {
      if (!key) {
        invalid();
      }
      const value = literal(predicate.rhs, query);
      const operator = predicate.op === '@>' ? 'subarray_seq' : '!subarray_seq';
      const tokens = await key.substringTokens(predicate.field, value);
      edits.push({
        from: predicate.comparison.from,
        to: predicate.comparison.to,
        text: `span.${JSON.stringify(`bi.${predicate.field.slice(4)}`)} ${operator} ${JSON.stringify(tokens)}`,
      });
      continue;
    }
    const value = literal(predicate.rhs, query);
    const encrypted = isEncryptedAttributeEnvelope(value)
      ? JSON.stringify(value)
      : key ? JSON.stringify(key.encrypt(predicate.field, value)) : invalid();
    const lhs = query.slice(predicate.lhs.from, predicate.lhs.to);
    const between = query.slice(predicate.lhs.to, predicate.rhs.from);
    const comparison = `${lhs}${between}${encrypted}`;
    if (predicate.op === '=') {
      edits.push({
        from: predicate.comparison.from,
        to: predicate.comparison.to,
        text: comparison,
      });
    } else {
      edits.push({
        from: predicate.comparison.from,
        to: predicate.comparison.to,
        text: `(${comparison} && ${lhs} != nil)`,
      });
    }
  }
  if (mode === 'search') {
    const select = pipelineSelect(root, selects);
    if (select) {
      const projected = selectedFields(select, query);
      const missing = [...fields].filter(([field]) => !projected.has(field));
      if (missing.length) {
        edits.push({
          from: select.to - 1,
          to: select.to - 1,
          text: `, ${missing.map(([, spelling]) => spelling).join(', ')}`,
        });
      }
    } else {
      const end = children(root)[0].to;
      edits.push({ from: end, to: end, text: ` | select(${[...fields.values()].join(', ')})` });
    }
  }
  edits.sort((a, b) => b.from - a.from);
  let previous = query.length;
  let rewritten = query;
  for (const edit of edits) {
    if (edit.to > previous) {
      invalid();
    }
    rewritten = rewritten.slice(0, edit.from) + edit.text + rewritten.slice(edit.to);
    previous = edit.from;
  }
  return rewritten;
}
