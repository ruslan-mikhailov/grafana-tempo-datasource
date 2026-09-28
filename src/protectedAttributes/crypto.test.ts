import { webcrypto } from 'node:crypto';
import { importKey, ProtectedAttributeCryptoError } from './crypto';

const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const kid = '630dcd2966c4336691125448bbb25b4f';
const queryContext = JSON.stringify(['tempo-uid', 'query']);
const filterContext = JSON.stringify(['tempo-uid', 'filters', 'filter-id', 'value', '0']);

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});

afterAll(() => {
  if (originalCrypto) {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  } else {
    Reflect.deleteProperty(globalThis, 'crypto');
  }
});

const vectors = [
  ['enc.password', 'abc', `enc:v1:${kid}:7aUwjY5fPtHvu_dUnzcxBJc6XQ`],
  ['enc.password', '', `enc:v1:${kid}:l4ghA-S-aF9uZIBVXGBXsA`],
  ['enc.password', 'π🙂', `enc:v1:${kid}:Q7TnRtl8MzhotH3OUlYfe4R-HKvCyg`],
  ['enc.token', 'abc', `enc:v1:${kid}:Tmlsk4UeuIxW4e8k0i4OmCaSPg`],
] as const;

test('AES-256-SIV matches the four independently frozen stored-field vectors', async () => {
  const key = await importKey(` \n${master}\t`);
  expect(key.kid).toBe(kid);
  for (const [field, plaintext, envelope] of vectors) {
    expect(key.encrypt(field, plaintext)).toBe(envelope);
    expect(key.decrypt(field, envelope)).toBe(plaintext);
  }
  expect(key.encrypt('enc.password', 'abc')).toBe(vectors[0][2]);
});

test('authenticated UTF-8 preserves an initial byte-order mark in both domains', async () => {
  const key = await importKey(master);
  const plaintext = '\uFEFFabc';
  expect(key.decrypt('enc.password', key.encrypt('enc.password', plaintext))).toBe(plaintext);
  expect(await key.openQueryModel(await key.sealQueryModel(plaintext, queryContext), queryContext)).toBe(plaintext);
});

test('field binding, key identity, envelope canonicality and authentication fail closed', async () => {
  const key = await importKey(master);
  const other = await importKey(Buffer.alloc(32, 7).toString('base64'));
  const envelope = vectors[0][2];
  expect(() => key.decrypt('enc.token', envelope)).toThrow(ProtectedAttributeCryptoError);
  expect(() => other.decrypt('enc.password', envelope)).toThrow('key-mismatch');
  expect(() => key.decrypt('enc.password', `${envelope.slice(0, -1)}A`)).toThrow('authentication-failed');
  expect(() => key.decrypt('enc.password', envelope.replace('enc:v1:', 'enc:v2:'))).toThrow('invalid-envelope');
  expect(() => key.decrypt('enc.password', `enc:v1:${kid}:AAAA`)).toThrow('invalid-envelope');
  expect(() => key.decrypt('enc.password', `${envelope}=`)).toThrow('invalid-envelope');
  expect(() => key.decrypt('enc.password', `${envelope}\n`)).toThrow('invalid-envelope');
  expect(() => key.decrypt('enc.password', `${envelope.slice(0, -1)}R`)).toThrow('invalid-envelope');
  expect(() => key.encrypt('password', 'abc')).toThrow('invalid-field');
  expect(() => key.encrypt('enc.', 'abc')).toThrow('invalid-field');
});

test('base64 key input rejects noncanonical characters, padding and lengths', async () => {
  await expect(importKey('%%%')).rejects.toMatchObject({ code: 'invalid-key' });
  await expect(importKey(`${master}=`)).rejects.toMatchObject({ code: 'invalid-key' });
  await expect(importKey(Buffer.alloc(31).toString('base64'))).rejects.toMatchObject({ code: 'invalid-key' });
  expect((await importKey(master.replace(/=$/, ''))).kid).toBe(kid);
});

test('AES-256-GCM seals independently and randomly, authenticated to exact model slot', async () => {
  const key = await importKey(master);
  const query = '{span.enc.password="abc"} π🙂';
  const first = await key.sealQueryModel(query, queryContext);
  const second = await key.sealQueryModel(query, queryContext);
  expect(first).toMatch(new RegExp(`^qenc:v1:${kid}:[A-Za-z0-9_-]+$`));
  expect(second).not.toBe(first);
  expect(first).not.toBe(key.encrypt('enc.password', query));
  expect(await key.openQueryModel(first, queryContext)).toBe(query);
  expect(await key.openQueryModel(second, queryContext)).toBe(query);
  const empty = await key.sealQueryModel('', filterContext);
  expect(await key.openQueryModel(empty, filterContext)).toBe('');
  await expect(key.openQueryModel(first, JSON.stringify(['other-uid', 'query']))).rejects.toMatchObject({ code: 'authentication-failed' });
  await expect(key.openQueryModel(first, filterContext)).rejects.toMatchObject({ code: 'authentication-failed' });
  await expect(key.openQueryModel(empty, JSON.stringify(['tempo-uid', 'filters', 'filter-id', 'value', '1']))).rejects.toMatchObject({ code: 'authentication-failed' });
  const other = await importKey(Buffer.alloc(32, 7).toString('base64'));
  await expect(other.openQueryModel(first, queryContext)).rejects.toMatchObject({ code: 'key-mismatch' });
  const payloadStart = first.lastIndexOf(':') + 1;
  const tampered = `${first.slice(0, payloadStart)}${first[payloadStart] === 'A' ? 'B' : 'A'}${first.slice(payloadStart + 1)}`;
  await expect(key.openQueryModel(tampered, queryContext)).rejects.toMatchObject({ code: 'authentication-failed' });
  await expect(key.openQueryModel(`qenc:v1:${kid}:AAAA`, queryContext)).rejects.toMatchObject({ code: 'invalid-envelope' });
  await expect(key.openQueryModel(first.replace('qenc:v1:', 'qenc:v2:'), queryContext)).rejects.toMatchObject({ code: 'invalid-envelope' });
  await expect(key.openQueryModel(`${first}=`, queryContext)).rejects.toMatchObject({ code: 'invalid-envelope' });
});

test('only canonical slot JSON is accepted', async () => {
  const key = await importKey(master);
  for (const context of ['', '"enc.password"', '["uid", "query"]', '["", "query"]', '["uid","filters","","value"]', '["uid","filters","f","value","01"]']) {
    await expect(key.sealQueryModel('secret', context)).rejects.toMatchObject({ code: 'invalid-context' });
  }
});

test('clear invalidates synchronous operations and asynchronous model operations in flight', async () => {
  const key = await importKey(master);
  const sealed = await key.sealQueryModel('secret', queryContext);
  const pendingSeal = key.sealQueryModel('another', queryContext);
  const pendingOpen = key.openQueryModel(sealed, queryContext);
  key.clear();
  key.clear();
  await expect(pendingSeal).rejects.toMatchObject({ code: 'cleared' });
  await expect(pendingOpen).rejects.toMatchObject({ code: 'cleared' });
  await expect(key.sealQueryModel('secret', queryContext)).rejects.toMatchObject({ code: 'cleared' });
  await expect(key.openQueryModel(sealed, queryContext)).rejects.toMatchObject({ code: 'cleared' });
  expect(() => key.encrypt('enc.password', 'secret')).toThrow('cleared');
  expect(() => key.decrypt('enc.password', vectors[0][2])).toThrow('cleared');
});

test('ordered-trigram HMAC uses NFC scalar windows, field binding, and frozen cross-language vectors', async () => {
  const key = await importKey(master);
  const coo = `bi:v1:${kid}:E_S8rZC-kHLrifr_71XBBSP7w8jOWNCm2j6LHigypgM`;
  const ool = `bi:v1:${kid}:zQb64aCXnVL2KksfrDxrQwVtdw6Ljmwxv37So9E7ghc`;
  expect(await key.substringTokens('enc.secret', 'cool')).toEqual([coo, ool]);
  expect((await key.substringTokens('enc.secret', 'some cool value')).slice(5, 7)).toEqual([coo, ool]);
  expect(await key.substringTokens('enc.secret', 'e\u0301🙂a')).toEqual(await key.substringTokens('enc.secret', 'é🙂a'));
  const repeated = await key.substringTokens('enc.secret', 'aaaabca');
  expect(repeated).toHaveLength(5);
  expect(repeated[0]).toBe(repeated[1]);
  expect(repeated[1]).not.toBe(repeated[2]);
  expect(await key.substringTokens('enc.other', 'cool')).not.toEqual([coo, ool]);
  expect(await (await importKey(Buffer.alloc(32, 7).toString('base64'))).substringTokens('enc.secret', 'cool')).not.toEqual([coo, ool]);
  expect(coo).toMatch(/^bi:v1:[0-9a-f]{32}:[A-Za-z0-9_-]{43}$/);
});

test('substring input bounds and invalid scalar sequences fail without tokens', async () => {
  const key = await importKey(master);
  expect(await key.substringTokens('enc.secret', '🙂'.repeat(512))).toHaveLength(510);
  for (const value of ['', 'a', 'é\u0301', 'a'.repeat(513), '🙂'.repeat(513), '\ud800xy', 'xy\udc00']) {
    await expect(key.substringTokens('enc.secret', value)).rejects.toMatchObject({ code: 'invalid-substring' });
  }
  await expect(key.substringTokens('enc.secret', '🙂'.repeat(512) + 'a')).rejects.toMatchObject({ code: 'invalid-substring' });
  await expect(key.substringTokens('bi.secret', 'cool')).rejects.toMatchObject({ code: 'invalid-field' });
  const pending = key.substringTokens('enc.secret', 'some cool value');
  key.clear();
  await expect(pending).rejects.toMatchObject({ code: 'cleared' });
  await expect(key.substringTokens('enc.secret', 'cool')).rejects.toMatchObject({ code: 'cleared' });
});
