import { webcrypto } from 'node:crypto';

import { TraceqlSearchScope } from '../dataquery';
import { type TempoQuery } from '../types';

import { importKey } from './crypto';
import {
  assertProtectedQueryModelSafe,
  assertStaticProtectedFilterDefaultsSafe,
  classifyProtectedFilter,
  openProtectedQueryModel,
  protectedFilterSelections,
  prepareProtectedQueryModel,
} from './model';
import { protectedTraceQLPredicates } from './traceql';

const uid = 'tempo-uid';
const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const kid = '630dcd2966c4336691125448bbb25b4f';
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

function query(raw = '', filters: TempoQuery['filters'] = []): TempoQuery {
  return { refId: 'A', queryType: 'traceql', query: raw, filters };
}

const protectedFilter = (value: string | string[]) => ({
  id: 'password',
  scope: TraceqlSearchScope.Span,
  tag: 'enc.password',
  operator: '=',
  value,
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

test('sealed raw and builder models carry only predicate-bound key IDs, not plaintext or master keys', async () => {
  const old = await importKey(master);
  const other = await importKey(Buffer.alloc(32, 7).toString('base64'));
  const raw = '{span.enc.password="private"}';
  const predicate = protectedTraceQLPredicates(raw)[0].predicate;
  const saved = await prepareProtectedQueryModel({ ...query(raw), protectedQueryKeys: [{ predicate, kid: other.kid }] }, old, uid);
  expect(saved.query).toMatch(/^qenc:v1:/);
  expect(saved.protectedQueryKeys).toEqual([{ predicate, kid: other.kid }]);
  expect(JSON.stringify(saved)).not.toContain('private');
  expect((await openProtectedQueryModel(saved, old, uid)).protectedQueryKeys).toEqual(saved.protectedQueryKeys);
  const filters = [protectedFilter('private'), { ...protectedFilter('other'), id: 'token', tag: 'enc.token', protectedKeyId: other.kid }];
  const builderQuery = '{span.enc.password="private" && span.enc.token="other"}';
  expect(protectedFilterSelections(builderQuery, filters)).toEqual([
    { predicate: protectedTraceQLPredicates(builderQuery)[1].predicate, kid: other.kid },
  ]);
  expect(() => assertProtectedQueryModelSafe({ ...saved, protectedQueryKeys: [
    { predicate, kid: 'invalid' },
  ] })).toThrow();
  const direct = old.encrypt('enc.password', 'private');
  expect(() => assertProtectedQueryModelSafe(query('', [{ ...protectedFilter(direct), protectedKeyId: 'invalid' }]))).toThrow();
});

test('each protected filter array element authenticates against its filter ID and original index', async () => {
  const key = await importKey(master);
  const source = query('', [protectedFilter(['', '123', 'π🙂'])]);
  const sealed = await prepareProtectedQueryModel(source, key, uid);
  const values = sealed.filters[0].value as string[];
  expect(values).toHaveLength(3);
  expect(values.every((v) => v.startsWith('qenc:v1:') && !v.includes('π🙂'))).toBe(true);
  expect((await openProtectedQueryModel(sealed, key, uid)).filters[0].value).toEqual(['', '123', 'π🙂']);
  await expect(
    openProtectedQueryModel(
      { ...sealed, filters: [{ ...sealed.filters[0], value: [values[1], values[0], values[2]] }] },
      key,
      uid
    )
  ).rejects.toThrow();
  await expect(
    openProtectedQueryModel({ ...sealed, filters: [{ ...sealed.filters[0], id: 'other' }] }, key, uid)
  ).rejects.toThrow();
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

test('saved envelopes open with their own key ID while new values seal under the active key', async () => {
  const old = await importKey(master);
  const active = await importKey(Buffer.alloc(32, 7).toString('base64'));
  const saved = await prepareProtectedQueryModel(
    query('{span.enc.password="old"}', [protectedFilter('old')]),
    old,
    uid
  );
  const lookup = (id: string) => (id === old.kid ? old : id === active.kid ? active : undefined);
  const opened = await openProtectedQueryModel(saved, lookup, uid);
  expect(opened.query).toBe('{span.enc.password="old"}');
  expect(opened.filters[0].value).toBe('old');
  const updated = await prepareProtectedQueryModel(
    { ...saved, filters: [protectedFilter('new')] },
    active,
    uid,
    saved,
    lookup
  );
  expect(updated.query).toBe(saved.query);
  expect(updated.filters[0].value).toMatch(new RegExp(`^qenc:v1:${active.kid}:`));
  expect(() => assertProtectedQueryModelSafe(updated, [active.kid, old.kid])).not.toThrow();
  await expect(
    openProtectedQueryModel(updated, (id) => (id === active.kid ? active : undefined), uid)
  ).rejects.toThrow();
  expect((await openProtectedQueryModel(updated, lookup, uid)).filters[0].value).toBe('new');
});

test('enc:-prefixed literals persist and open without keys while dynamic names still seal', async () => {
  const key = await importKey(master);
  for (const ciphertext of ['enc:custom', 'enc:v1|plain.*', `enc:v1:${kid}:bad`]) {
    const direct = query(`{span.enc.password="${ciphertext}"}`, [protectedFilter(ciphertext)]);
    expect(() => assertProtectedQueryModelSafe(direct)).not.toThrow();
    expect(await openProtectedQueryModel(direct, undefined, uid)).toEqual(direct);
    expect(await prepareProtectedQueryModel(direct, key, uid)).toMatchObject({
      query: direct.query, filters: [{ value: ciphertext }],
    });
  }
  const dynamic = query('', [{ ...protectedFilter('enc:custom'), tag: '${attribute}' }]);
  expect(() => assertProtectedQueryModelSafe(dynamic)).toThrow();
  expect((await prepareProtectedQueryModel(dynamic, key, uid)).filters[0].value).toMatch(/^qenc:v1:/);
});

test('regex with enc: prefix bypasses sealing; non-prefixed regex requires a key and seals', async () => {
  const key = await importKey(master);
  for (const text of [
    '{span.enc.api.token =~ "enc:custom"}',
    '{span.enc.api.token !~ "enc:v1|secret"}',
  ]) {
    const direct = query(text);
    expect(() => assertProtectedQueryModelSafe(direct)).not.toThrow();
    expect(await openProtectedQueryModel(direct, undefined, uid)).toEqual(direct);
    expect(await prepareProtectedQueryModel(direct, key, uid)).toEqual(direct);
  }
  for (const text of [
    `{span.enc.api.token !~ "^enc:v1:${kid}:.*$"}`,
    '{span.enc.api.token =~ "secret"}',
    '{span.enc.api.token =~ ".*"}',
  ]) {
    const raw = query(text);
    expect(() => assertProtectedQueryModelSafe(raw)).toThrow();
    const sealed = await prepareProtectedQueryModel(raw, key, uid);
    expect(sealed.query).toMatch(/^qenc:v1:/);
    expect((await openProtectedQueryModel(sealed, key, uid)).query).toBe(text);
  }
  const mixed = query('{span.enc.api.token =~ "enc:v1" && span.enc.password="secret"}');
  expect(() => assertProtectedQueryModelSafe(mixed)).toThrow();
  const sealed = await prepareProtectedQueryModel(mixed, key, uid);
  expect(sealed.query).toMatch(/^qenc:v1:/);
  expect(JSON.stringify(sealed)).not.toContain('secret');
});

test('prefixed native ciphertext substring survives save/open keyless with index disabled', async () => {
  const directQueries = [
    '{span.enc.api.token =~ "enc:custom"}',
    '{span.enc.api.token !~ "enc:v1|plain.*"}',
    '{span.enc.api.token @> "enc:custom"}',
    '{span.enc.api.token !@> "enc:v1|plain.*"}',
  ];
  for (const text of directQueries) {
    const draft = query(text);
    for (const enabled of [false, true]) {
      expect(() => assertProtectedQueryModelSafe(draft, undefined, enabled)).not.toThrow();
      expect(await openProtectedQueryModel(draft, undefined, uid, enabled)).toEqual(draft);
    }
  }
  const key = await importKey(master);
  for (const text of directQueries) {
    expect(await prepareProtectedQueryModel(query(text), key, uid)).toEqual(query(text));
  }
  for (const text of [
    '{span.enc.api.token @> "private"}',
    '{span.enc.api.token @> "$term"}',
    '{span.enc.api.token @> enc:v1}',
    '{span.enc.api.token =~ ".*|private"}',
    '{span.enc.api.token =~ $pattern}',
  ]) {
    expect(() => assertProtectedQueryModelSafe(query(text), undefined, true)).toThrow();
  }
  const mixed = query('{span.enc.api.token @> "enc:custom" && span.enc.password="secret"}');
  expect(() => assertProtectedQueryModelSafe(mixed)).toThrow();
  const sealed = await prepareProtectedQueryModel(mixed, key, uid);
  expect(sealed.query).toMatch(/^qenc:v1:/);
  expect(JSON.stringify(sealed)).not.toContain('"secret"');
});

test('dynamic tag or scope keeps adjacent builder value sealed even if it currently resolves ordinary', async () => {
  const key = await importKey(master);
  const ordinaryInterior = query('', [
    {
      id: 'ordinary',
      scope: TraceqlSearchScope.Span,
      tag: 'http.enc.password',
      operator: '=',
      value: 'abc',
      valueType: 'string',
    },
  ]);
  expect(await prepareProtectedQueryModel(ordinaryInterior, key, uid)).toEqual(ordinaryInterior);
  const quoted = query('', [
    {
      id: 'quoted',
      scope: TraceqlSearchScope.Span,
      tag: '\"enc\".\"password\"',
      operator: '=',
      value: 'abc',
    },
  ]);
  expect((await prepareProtectedQueryModel(quoted, key, uid)).filters[0].value).toMatch(/^qenc:v1:/);
  const source = query('', [
    { id: 'variable', scope: TraceqlSearchScope.Span, tag: '${attribute}', operator: '=', value: 'abc' },
  ]);
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
  const regex = query('', [{ ...protectedFilter('secret'), operator: '=~', protectedKeyId: kid }]);
  expect(() => assertProtectedQueryModelSafe(regex)).toThrow();
  const sealedRegex = await prepareProtectedQueryModel(regex, key, uid);
  expect(sealedRegex.filters[0].value).toMatch(/^qenc:v1:/);
  expect((await openProtectedQueryModel(sealedRegex, key, uid)).filters[0].value).toBe('secret');
  expect(() => assertProtectedQueryModelSafe(sealedRegex)).not.toThrow();
  await expect(
    prepareProtectedQueryModel(
      query('', [{ ...protectedFilter('secret'), scope: TraceqlSearchScope.Resource }]),
      key,
      uid
    )
  ).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [protectedFilter('a\nb')]), key, uid)).rejects.toThrow();
  expect(() =>
    assertProtectedQueryModelSafe(
      query('', [
        {
          id: 'injected',
          scope: TraceqlSearchScope.Span,
          tag: 'http.route=\"x\" && span.enc.password',
          operator: '=',
          value: 'abc',
          valueType: 'string',
        },
      ]),
      kid
    )
  ).toThrow();
  expect(() =>
    assertProtectedQueryModelSafe(
      query('', [
        {
          id: 'quoted',
          scope: TraceqlSearchScope.Span,
          tag: '\"enc.password\"',
          operator: '=',
          value: 'abc',
        },
      ]),
      kid
    )
  ).toThrow();
  expect(() => assertStaticProtectedFilterDefaultsSafe([protectedFilter('secret')])).toThrow();
  expect(() =>
    assertStaticProtectedFilterDefaultsSafe([
      { id: 'dynamic', scope: TraceqlSearchScope.Span, tag: '${attribute}', value: 'secret' },
    ])
  ).toThrow();
  expect(() =>
    assertStaticProtectedFilterDefaultsSafe([
      { id: 'ordinary', scope: TraceqlSearchScope.Resource, tag: 'service.name', value: 'frontend' },
    ])
  ).not.toThrow();
});

test('Builder direct enc: values support all operators without a key or substring index', async () => {
  const key = await importKey(master);
  for (const operator of ['=', '!=', '=~', '!~', '@>', '!@>']) {
    const filter = { ...protectedFilter('enc:custom'), operator, protectedKeyId: kid };
    const model = query('', [filter]);
    expect(() => assertProtectedQueryModelSafe(model)).not.toThrow();
    expect(await openProtectedQueryModel(model, undefined, uid)).toEqual(model);
    expect(await prepareProtectedQueryModel(model, key, uid)).toMatchObject({
      filters: [{ operator, value: 'enc:custom', protectedKeyId: kid }],
    });
  }
  expect(() => assertStaticProtectedFilterDefaultsSafe([protectedFilter('enc:custom')])).toThrow();
});

test('known scoped intrinsics remain usable while malformed colon names and mismatched scopes fail closed', () => {
  const safe = query('', [
    { id: 'span-kind', scope: TraceqlSearchScope.Intrinsic, tag: 'span:kind', operator: '=', value: 'server' },
    { id: 'span-status', scope: TraceqlSearchScope.Span, tag: 'span:status', operator: '=', value: 'error' },
    { id: 'trace-duration', scope: TraceqlSearchScope.Intrinsic, tag: 'trace:duration', operator: '>', value: '100ms' },
  ]);
  expect(() => assertProtectedQueryModelSafe(safe, kid)).not.toThrow();
  expect(() =>
    assertProtectedQueryModelSafe(query('', [{ ...safe.filters[0], tag: 'span:enc.password' }]), kid)
  ).toThrow();
  expect(() =>
    assertProtectedQueryModelSafe(query('', [{ ...safe.filters[1], scope: TraceqlSearchScope.Resource }]), kid)
  ).toThrow();
});

test('substring raw query and scalar Builder value seal before host persistence; arrays and disabled flag fail', async () => {
  const key = await importKey(master);
  const raw = query('{span."enc.password" @> "cool"}');
  expect(() => assertProtectedQueryModelSafe(raw, kid, true)).toThrow();
  const sealedRaw = await prepareProtectedQueryModel(raw, key, uid, undefined, undefined, true);
  expect(sealedRaw.query).toMatch(/^qenc:v1:/);
  expect(sealedRaw.query).not.toContain('cool');
  expect((await openProtectedQueryModel(sealedRaw, key, uid, true)).query).toBe(raw.query);
  const builder = query('', [{ ...protectedFilter('cool'), operator: '@>', valueType: 'string' }]);
  await expect(prepareProtectedQueryModel(builder, key, uid)).rejects.toThrow();
  const sealedBuilder = await prepareProtectedQueryModel(builder, key, uid, undefined, undefined, true);
  expect(sealedBuilder.filters[0].value).toMatch(/^qenc:v1:/);
  expect((await openProtectedQueryModel(sealedBuilder, key, uid, true)).filters[0].value).toBe('cool');
  expect(() => assertProtectedQueryModelSafe(builder, kid, true)).toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...builder.filters[0], value: ['cool'] }]), key, uid, undefined, undefined, true)).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...builder.filters[0], tag: 'bi.password' }]), key, uid, undefined, undefined, true)).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...builder.filters[0], tag: '${attribute}' }]), key, uid, undefined, undefined, true)).rejects.toThrow();
});

test('negative substring preserves scalar protected Builder values and rejects untyped ordinary strings', async () => {
  const key = await importKey(master);
  const protectedNegative = query('', [{ ...protectedFilter('cool'), operator: '!@>', valueType: 'string' }]);
  const sealed = await prepareProtectedQueryModel(protectedNegative, key, uid, undefined, undefined, true);
  expect(sealed.filters[0].value).toMatch(/^qenc:v1:/);
  expect((await openProtectedQueryModel(sealed, key, uid, true)).filters[0].value).toBe('cool');
  const ordinary = { ...protectedNegative.filters[0], tag: 'http.route', operator: '!@>', valueType: 'string' };
  expect(() => assertProtectedQueryModelSafe(query('', [ordinary]), kid, true)).not.toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...ordinary, valueType: 'int' }]), key, uid, undefined, undefined, true)).rejects.toThrow();
  await expect(prepareProtectedQueryModel(query('', [{ ...ordinary, value: ['cool'] }]), key, uid, undefined, undefined, true)).rejects.toThrow();
});
