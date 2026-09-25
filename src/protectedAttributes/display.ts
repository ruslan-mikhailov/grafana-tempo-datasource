import { type ProtectedAttributeKey } from './crypto';

const displaySymbol = Symbol.for('grafana.tempo.protected-attribute-display.v1');
const displayChangeEvent = 'grafana.tempo.protected-attribute-display-change';
const envelopePattern = /^enc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]+)$/;
const envelopeKidPattern = /^enc:[^:]*:([0-9a-f]{32}):/;

interface DisplayRegistry {
  epoch: number;
  resolve(storedField: string, envelope: string): string | undefined;
}

const configuredKids = new Set<string>();
const importedKeys = new Map<string, { owner: object; key: ProtectedAttributeKey }>();

function resolve(storedField: string, envelope: string): string | undefined {
  if (
    typeof storedField !== 'string' ||
    !storedField.startsWith('enc.') ||
    storedField.length === 4 ||
    typeof envelope !== 'string'
  ) {
    return undefined;
  }
  const kid = envelopeKidPattern.exec(envelope)?.[1];
  if (!kid || !configuredKids.has(kid)) {
    return undefined;
  }
  if (!envelopePattern.test(envelope)) {
    return '[encrypted: invalid data]';
  }
  const key = importedKeys.get(kid)?.key;
  if (!key) {
    return '[encrypted: key unavailable]';
  }
  try {
    return key.decrypt(storedField, envelope);
  } catch {
    return '[encrypted: invalid data]';
  }
}

function registry(): DisplayRegistry | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const scope = globalThis as unknown as Record<symbol, DisplayRegistry | undefined>;
  return (scope[displaySymbol] ??= { epoch: 0, resolve });
}

function changed(): void {
  const display = registry();
  if (display) {
    display.epoch++;
    window.dispatchEvent(new Event(displayChangeEvent));
  }
}

/** Register the configured key ID without exposing the key or plaintext to Grafana. */
export function registerProtectedDisplayKid(kid: string | undefined): void {
  if (kid && /^[0-9a-f]{32}$/.test(kid) && !configuredKids.has(kid)) {
    configuredKids.add(kid);
    changed();
  }
}

/** A datasource owns its imported key; a stale datasource cannot revoke another one's key. */
export function setProtectedDisplayKey(owner: object, kid: string | undefined, key?: ProtectedAttributeKey): void {
  if (!kid || typeof window === 'undefined') {
    return;
  }
  registerProtectedDisplayKid(kid);
  const current = importedKeys.get(kid);
  if (key) {
    importedKeys.set(kid, { owner, key });
  } else if (current?.owner === owner) {
    importedKeys.delete(kid);
  }
  changed();
}
