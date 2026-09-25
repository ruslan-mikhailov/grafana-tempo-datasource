/** @jest-environment node */

import { webcrypto } from 'node:crypto';

import { TraceqlSearchScope } from '../dataquery';
import { type TempoQuery } from '../types';

import { importKey } from './crypto';
import {
  assertProtectedQueryModelSafe,
  assertStaticProtectedFilterDefaultsSafe,
  classifyProtectedFilter,
  openProtectedQueryModel,
  prepareProtectedQueryModel,
} from './model';

const uid = 'tempo-uid';
const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const kid = '630dcd2966c4336691125448bbb25b4f';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});

function query(raw = '', filters: TempoQuery['filters'] = []): TempoQuery {
  return { refId: 'A', queryType: 'traceql', query: raw, filters };
}

const protectedFilter = (value: string | string[]) => ({
  id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value,
});

test('host raw query stays plain only for a fixed ordinary field; protected and dynamic names seal', async () => {
  const key = await importKey(master);
  const ordinary = query('{span.password="abc"}');
  expect(await prepareProtectedQueryModel(ordinary, key, uid)).toEqual(ordinary);
  const ordinaryVariable = query('{span.password=\"${ordinary}\"}');
  expect(await prepareProtectedQueryModel(ordinaryVariable, key, uid)).toEqual(ordinaryVariable);
  const protectedRaw = query('{span.enc.password="abc"}');
  const sealed = await prepareProtectedQueryModel(protectedRaw, key, uid);
  expect(sealed.query).toMatch(/^qenc:v1:/);
  expect(sealed.query).not.toContain('abc');
  expect(() => assertProtectedQueryModelSafe(protectedRaw, kid)).toThrow();
  expect(() => assertProtectedQueryModelSafe(sealed, kid)).not.toThrow();
  expect((await openProtectedQueryModel(sealed, key, uid)).query).toBe(protectedRaw.query);
  await expect(openProtectedQueryModel(sealed, undefined, uid)).rejects.toThrow();
  await expect(openProtectedQueryModel(sealed, key, 'different-uid')).rejects.toThrow();

  const variableName = query('{span.${attribute}="abc"}');
  const dynamic = await prepareProtectedQueryModel(variableName, key, uid);
  expect(dynamic.query).toMatch(/^qenc:v1:/);
  expect((await openProtectedQueryModel(dynamic, key, uid)).query).toBe(variableName.query);
  expect(() => assertProtectedQueryModelSafe(variableName, kid)).toThrow();
});

test('each protected filter array element authenticates against its filter ID and original index', async () => {
  const key = await importKey(master);
  const source = query('', [protectedFilter(['', '123', 'π🙂'])]);
  const sealed = await prepareProtectedQueryModel(source, key, uid);
  const values = sealed.filters[0].value as string[];
  expect(values).toHaveLength(3);
  expect(values.every((v) => v.startsWith('qenc:v1:') && !v.includes('π🙂'))).toBe(true);
  expect((await openProtectedQueryModel(sealed, key, uid)).filters[0].value).toEqual(['', '123', 'π🙂']);
  await expect(openProtectedQueryModel({ ...sealed, filters: [{ ...sealed.filters[0], value: [values[1], values[0], values[2]] }] }, key, uid)).rejects.toThrow();
  await expect(openProtectedQueryModel({ ...sealed, filters: [{ ...sealed.filters[0], id: 'other' }] }, key, uid)).rejects.toThrow();
  expect(() => assertProtectedQueryModelSafe(source, kid)).toThrow();
});
test('a qenc-looking user literal is sealed as plaintext; only unchanged source slots retain prior envelopes', async () => {
  const key = await importKey(master);
  const literal = `qenc:v1:${kid}:${'A'.repeat(40)}`;
  const created = await prepareProtectedQueryModel(query('', [protectedFilter(literal)]), key, uid);
  expect(created.filters[0].value).not.toBe(literal);
  expect((await openProtectedQueryModel(created, key, uid)).filters[0].value).toBe(literal);
  const changedOption = { ...created, limit: 30 };
  const preserved = await prepareProtectedQueryModel(changedOption, key, uid, created);
  expect(preserved.filters[0].value).toBe(created.filters[0].value);
  const wrongUID = await key.sealQueryModel('abc', JSON.stringify(['other-uid', 'filters', 'password', 'value']));
  const foreign = query('', [protectedFilter(wrongUID)]);
  await expect(prepareProtectedQueryModel(foreign, key, uid, foreign)).rejects.toThrow();
  const wrongSlot = query(await key.sealQueryModel('abc', JSON.stringify([uid, 'filters', 'password', 'value'])));
  await expect(prepareProtectedQueryModel(wrongSlot, key, uid, wrongSlot)).rejects.toThrow();
});

test('dynamic tag or scope keeps adjacent builder value sealed even if it currently resolves ordinary', async () => {
  const key = await importKey(master);
  const ordinaryInterior = query('', [{
    id: 'ordinary', scope: TraceqlSearchScope.Span, tag: 'http.enc.password', operator: '=', value: 'abc', valueType: 'string',
  }]);
  expect(await prepareProtectedQueryModel(ordinaryInterior, key, uid)).toEqual(ordinaryInterior);
  const quoted = query('', [{
    id: 'quoted', scope: TraceqlSearchScope.Span, tag: '\"enc\".\"password\"', operator: '=', value: 'abc',
  }]);
  expect((await prepareProtectedQueryModel(quoted, key, uid)).filters[0].value).toMatch(/^qenc:v1:/);
  const source = query('', [{ id: 'variable', scope: TraceqlSearchScope.Span, tag: '${attribute}', operator: '=', value: 'abc' }]);
  expect(classifyProtectedFilter(source.filters[0]).requiresSealing).toBe(true);
  const sealed = await prepareProtectedQueryModel(source, key, uid);
  expect(sealed.filters[0].value).toMatch(/^qenc:v1:/);
  expect((await openProtectedQueryModel(sealed, key, uid)).filters[0].value).toBe('abc');
  const changedName = { ...sealed, filters: [{ ...sealed.filters[0], tag: 'enc.password' }] };
  expect(() => assertProtectedQueryModelSafe(changedName, kid)).not.toThrow();
  await expect(openProtectedQueryModel(changedName, key, uid)).resolves.toMatchObject({ filters: [{ value: 'abc' }] });
});

test('unsupported/ambiguous plaintext cannot cross model gate; static provisioned defaults fail closed', async () => {
  const key = await importKey(master);
  expect(() => assertProtectedQueryModelSafe(query('', [protectedFilter('secret')]), kid)).toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...protectedFilter('secret'), operator: '=~' }]), key, uid)).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...protectedFilter('secret'), scope: TraceqlSearchScope.Resource }]), key, uid)).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [protectedFilter('a\nb')]), key, uid)).rejects.toThrow();
  expect(() => assertProtectedQueryModelSafe(query('', [{
    id: 'injected', scope: TraceqlSearchScope.Span, tag: 'http.route=\"x\" && span.enc.password',
    operator: '=', value: 'abc', valueType: 'string',
  }]), kid)).toThrow();
  expect(() => assertProtectedQueryModelSafe(query('', [{
    id: 'quoted', scope: TraceqlSearchScope.Span, tag: '\"enc.password\"', operator: '=', value: 'abc',
  }]), kid)).toThrow();
  expect(() => assertStaticProtectedFilterDefaultsSafe([protectedFilter('secret')])).toThrow();
  expect(() => assertStaticProtectedFilterDefaultsSafe([{ id: 'dynamic', scope: TraceqlSearchScope.Span, tag: '${attribute}', value: 'secret' }])).toThrow();
  expect(() => assertStaticProtectedFilterDefaultsSafe([{ id: 'ordinary', scope: TraceqlSearchScope.Resource, tag: 'service.name', value: 'frontend' }])).not.toThrow();
});

test('known scoped intrinsics remain usable while malformed colon names and mismatched scopes fail closed', () => {
  const safe = query('', [
    { id: 'span-kind', scope: TraceqlSearchScope.Intrinsic, tag: 'span:kind', operator: '=', value: 'server' },
    { id: 'span-status', scope: TraceqlSearchScope.Span, tag: 'span:status', operator: '=', value: 'error' },
    { id: 'trace-duration', scope: TraceqlSearchScope.Intrinsic, tag: 'trace:duration', operator: '>', value: '100ms' },
  ]);
  expect(() => assertProtectedQueryModelSafe(safe, kid)).not.toThrow();
  expect(() => assertProtectedQueryModelSafe(query('', [
    { ...safe.filters[0], tag: 'span:enc.password' },
  ]), kid)).toThrow();
  expect(() => assertProtectedQueryModelSafe(query('', [
    { ...safe.filters[1], scope: TraceqlSearchScope.Resource },
  ]), kid)).toThrow();
});
