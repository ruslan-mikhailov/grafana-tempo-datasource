import { aessiv } from '@noble/ciphers/aes.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const attributePrefix = encoder.encode('tempo:span:v1');
const modelPrefix = encoder.encode('tempo:query-model:v1');
const attributeSalt = encoder.encode('tempo-attr-v1');
const attributeInfo = encoder.encode('aes-256-siv');
const modelSalt = encoder.encode('tempo-query-model-v1');
const modelInfo = encoder.encode('aes-256-gcm');
const envelopePatterns = {
  enc: /^enc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]+)$/,
  qenc: /^qenc:v1:([0-9a-f]{32}):([A-Za-z0-9_-]+)$/,
};

export type ProtectedAttributeCryptoErrorCode =
  | 'invalid-key'
  | 'crypto-unavailable'
  | 'invalid-field'
  | 'invalid-context'
  | 'invalid-envelope'
  | 'key-mismatch'
  | 'authentication-failed'
  | 'cleared';

export class ProtectedAttributeCryptoError extends Error {
  constructor(readonly code: ProtectedAttributeCryptoErrorCode) {
    super(`Protected attribute crypto: ${code}`);
    this.name = 'ProtectedAttributeCryptoError';
  }
}

export interface ProtectedAttributeKey {
  readonly kid: string;
  encrypt(storedField: string, plaintext: string): string;
  decrypt(storedField: string, envelope: string): string;
  sealQueryModel(plaintext: string, context: string): Promise<string>;
  openQueryModel(envelope: string, context: string): Promise<string>;
  clear(): void;
}

function error(code: ProtectedAttributeCryptoErrorCode): ProtectedAttributeCryptoError {
  return new ProtectedAttributeCryptoError(code);
}

function webCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') {
    throw error('crypto-unavailable');
  }
  return crypto;
}

function encodeBase64url(bytes: Uint8Array): string {
  // btoa takes a binary string, not UTF-8. Bound each argument list for long query models.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(input: string, url: boolean, code: ProtectedAttributeCryptoErrorCode): Uint8Array {
  if (typeof input !== 'string') {
    throw error(code);
  }
  const normalized = url ? input.replace(/-/g, '+').replace(/_/g, '/') : input;
  const valid = url
    ? /^[A-Za-z0-9_-]+$/.test(input) && input.length % 4 !== 1
    : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(input);
  if (!valid) {
    throw error(code);
  }
  try {
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const canonical = encodeBase64url(bytes);
    const received = url ? input : input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (canonical !== received) {
      bytes.fill(0);
      throw error(code);
    }
    return bytes;
  } catch {
    throw error(code);
  }
}

function associatedData(prefix: Uint8Array, name: string): Uint8Array {
  const encoded = encoder.encode(name);
  if (encoded.length > 0xffffffff) {
    throw error('invalid-context');
  }
  const result = new Uint8Array(prefix.length + 5 + encoded.length);
  result.set(prefix);
  new DataView(result.buffer).setUint32(prefix.length + 1, encoded.length, false);
  result.set(encoded, prefix.length + 5);
  return result;
}

function fieldData(storedField: string): Uint8Array {
  if (typeof storedField !== 'string' || !storedField.startsWith('enc.') || storedField.length <= 4) {
    throw error('invalid-field');
  }
  return associatedData(attributePrefix, storedField);
}

function modelData(context: string): Uint8Array {
  if (typeof context !== 'string') {
    throw error('invalid-context');
  }
  let slot: unknown;
  try {
    slot = JSON.parse(context);
  } catch {
    throw error('invalid-context');
  }
  const querySlot = Array.isArray(slot) && slot.length === 2 && slot[1] === 'query';
  const filterSlot = Array.isArray(slot) && (slot.length === 4 || slot.length === 5) &&
    slot[1] === 'filters' && !!slot[2] && slot[3] === 'value' &&
    (slot.length === 4 || /^(?:0|[1-9][0-9]*)$/.test(slot[4]));
  if (!Array.isArray(slot) || !slot.every((part) => typeof part === 'string') || !slot[0] ||
    !(querySlot || filterSlot) || JSON.stringify(slot) !== context) {
    throw error('invalid-context');
  }
  return associatedData(modelPrefix, context);
}

function parseEnvelope(envelope: string, kind: 'enc' | 'qenc', kid: string, minBytes: number): Uint8Array {
  if (typeof envelope !== 'string') {
    throw error('invalid-envelope');
  }
  const match = envelopePatterns[kind].exec(envelope);
  if (!match || match[0] !== envelope) {
    throw error('invalid-envelope');
  }
  if (match[1] !== kid) {
    throw error('key-mismatch');
  }
  const bytes = decodeBase64(match[2], true, 'invalid-envelope');
  if (bytes.length < minBytes) {
    bytes.fill(0);
    throw error('invalid-envelope');
  }
  return bytes;
}

class ImportedKey implements ProtectedAttributeKey {
  private cleared = false;

  constructor(
    readonly kid: string,
    private readonly attributeKey: Uint8Array,
    private modelKey?: CryptoKey
  ) {}

  private active(): CryptoKey {
    if (this.cleared || !this.modelKey) {
      throw error('cleared');
    }
    return this.modelKey;
  }

  encrypt(storedField: string, plaintext: string): string {
    this.active();
    const data = fieldData(storedField);
    if (typeof plaintext !== 'string') {
      throw error('invalid-field');
    }
    const encoded = encoder.encode(plaintext);
    try {
      return `enc:v1:${this.kid}:${encodeBase64url(aessiv(this.attributeKey, data).encrypt(encoded))}`;
    } finally {
      encoded.fill(0);
    }
  }

  decrypt(storedField: string, envelope: string): string {
    this.active();
    const data = fieldData(storedField);
    const bytes = parseEnvelope(envelope, 'enc', this.kid, 16);
    let plaintext: Uint8Array | undefined;
    try {
      try {
        plaintext = aessiv(this.attributeKey, data).decrypt(bytes);
        return decoder.decode(plaintext);
      } catch {
        throw error('authentication-failed');
      }
    } finally {
      plaintext?.fill(0);
      bytes.fill(0);
    }
  }

  async sealQueryModel(plaintext: string, context: string): Promise<string> {
    const key = this.active();
    const data = modelData(context);
    if (typeof plaintext !== 'string') {
      throw error('invalid-context');
    }
    const nonce = webCrypto().getRandomValues(new Uint8Array(12));
    const encoded = encoder.encode(plaintext);
    try {
      let encrypted: ArrayBuffer;
      try {
        encrypted = await webCrypto().subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: data, tagLength: 128 }, key, encoded
        );
      } catch {
        throw this.cleared ? error('cleared') : error('authentication-failed');
      }
      this.active();
      const result = new Uint8Array(nonce.length + encrypted.byteLength);
      result.set(nonce);
      result.set(new Uint8Array(encrypted), nonce.length);
      return `qenc:v1:${this.kid}:${encodeBase64url(result)}`;
    } finally {
      encoded.fill(0);
    }
  }

  async openQueryModel(envelope: string, context: string): Promise<string> {
    const key = this.active();
    const data = modelData(context);
    const bytes = parseEnvelope(envelope, 'qenc', this.kid, 28);
    let plaintext: Uint8Array | undefined;
    try {
      try {
        plaintext = new Uint8Array(await webCrypto().subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: data, tagLength: 128 },
          key,
          bytes.subarray(12)
        ));
        this.active();
        return decoder.decode(plaintext);
      } catch {
        throw this.cleared ? error('cleared') : error('authentication-failed');
      }
    } finally {
      plaintext?.fill(0);
      bytes.fill(0);
    }
  }

  clear(): void {
    this.cleared = true;
    this.attributeKey.fill(0);
    this.modelKey = undefined;
  }
}

export async function importKey(base64: string): Promise<ProtectedAttributeKey> {
  if (typeof base64 !== 'string') {
    throw error('invalid-key');
  }
  const crypto = webCrypto();
  const master = decodeBase64(base64.trim(), false, 'invalid-key');
  if (master.length !== 32) {
    master.fill(0);
    throw error('invalid-key');
  }
  let attributeKey: Uint8Array | undefined;
  let modelBytes: Uint8Array | undefined;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', master));
    const kid = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    digest.fill(0);
    const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    attributeKey = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: attributeSalt, info: attributeInfo }, hkdfKey, 512
    ));
    modelBytes = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: modelSalt, info: modelInfo }, hkdfKey, 256
    ));
    const modelKey = await crypto.subtle.importKey('raw', modelBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const handle = new ImportedKey(kid, attributeKey, modelKey);
    attributeKey = undefined;
    return handle;
  } catch {
    throw error('invalid-key');
  } finally {
    master.fill(0);
    attributeKey?.fill(0);
    modelBytes?.fill(0);
  }
}
