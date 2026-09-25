import { type ProtectedAttributeKey } from './crypto';

const displaySymbol = Symbol.for('grafana.tempo.protected-attribute-display.v1');
const displayChangeEvent = 'grafana.tempo.protected-attribute-display-change';
const envelopePattern = /^enc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]{22,})$/;
const envelopeKidPattern = /^enc:[^:]*:([0-9a-f]{32}):/;

interface DisplayRegistry {
  epoch: number;
  resolve(storedField: string, envelope: string): string | undefined;
}

let protectedModeRegistered = false;
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
  if (!protectedModeRegistered) {
    return undefined;
  }
  const kid = envelopeKidPattern.exec(envelope)?.[1];
  if (!kid) {
    return undefined;
  }
  const match = envelopePattern.exec(envelope);
  const encoded = match?.[2];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const remainder = encoded ? encoded.length % 4 : 1;
  const trailing = encoded ? alphabet.indexOf(encoded[encoded.length - 1]) : -1;
  if (
    !encoded ||
    remainder === 1 ||
    (remainder === 2 && trailing % 16 !== 0) ||
    (remainder === 3 && trailing % 4 !== 0)
  ) {
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

/** Enable locked display for encrypted values before any browser key is imported. */
export function registerProtectedDisplayMode(): void {
  if (!protectedModeRegistered) {
    protectedModeRegistered = true;
    changed();
  }
}

/** A datasource owns its imported key; a stale datasource cannot revoke another one's key. */
export function setProtectedDisplayKey(owner: object, kid: string | undefined, key?: ProtectedAttributeKey): void {
  if (!kid || typeof window === 'undefined') {
    return;
  }
  registerProtectedDisplayMode();
  if (key) {
    for (const [oldKid, current] of importedKeys) {
      if (oldKid !== kid && current.owner === owner) {
        importedKeys.delete(oldKid);
      }
    }
    importedKeys.set(kid, { owner, key });
    changed();
  } else if (importedKeys.get(kid)?.owner === owner) {
    importedKeys.delete(kid);
    changed();
  }
}
