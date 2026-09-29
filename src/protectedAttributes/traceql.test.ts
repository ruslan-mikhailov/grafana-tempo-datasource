import type { ProtectedAttributeKey } from './crypto';
import { assertProtectedTraceQLKeyChoices, classifyProtectedTraceQL, isCiphertextQueryValue, isMetricsTraceQL, protectedTraceQLPredicates, rebaseProtectedTraceQLKeys, rewriteProtectedTraceQL } from './traceql';

const abc = 'enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ';
const empty = 'enc:v1:630dcd2966c4336691125448bbb25b4f:l4ghA-S-aF9uZIBVXGBXsA';
const unicode = 'enc:v1:630dcd2966c4336691125448bbb25b4f:Q7TnRtl8MzhotH3OUlYfe4R-HKvCyg';

const encrypt = jest.fn((field: string, value: string) => {
  if (field === 'enc.password' && value === 'abc') {
    return abc;
  }
  if (field === 'enc.password' && value === '') {
    return empty;
  }
  if (field === 'enc.password' && value === 'π🙂') {
    return unicode;
  }
  return `${field}:${value}`;
});
const key = { kid: '630dcd2966c4336691125448bbb25b4f', encrypt } as unknown as ProtectedAttributeKey;

beforeEach(() => encrypt.mockClear());

describe('protected TraceQL compiler', () => {
  it('encrypts the pinned equality vector on the same span field, preserving ordinary query text', async () => {
    const query = '{ span.enc.password = "abc" && span.http.route="abc" } with (most_recent=true)';
    expect(await rewriteProtectedTraceQL(query, key, 'search')).toBe(
      `{ span.enc.password = "${abc}" && span.http.route="abc" } | select(span.enc.password) with (most_recent=true)`
    );
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(encrypt).toHaveBeenCalledWith('enc.password', 'abc');
  });

  it('guards inequality inside disjunction and retains exact original LHS spelling', async () => {
    expect(await rewriteProtectedTraceQL('{span.x="y" || span."enc.password"!="π🙂"}', key, 'search')).toBe(
      `{span.x="y" || (span."enc.password"!="${unicode}" && span."enc.password" != nil)} | select(span."enc.password")`
    );
  });

  it('merges missing fields into the existing select and recognizes equivalent quoted fields', async () => {
    expect(
      await rewriteProtectedTraceQL(
        '{span.enc.password=""} | select(resource.service.name) with (most_recent=true)',
        key,
        'search'
      )
    ).toBe(`{span.enc.password="${empty}"} | select(resource.service.name, span.enc.password) with (most_recent=true)`);
    expect(
      await rewriteProtectedTraceQL(
        '{span.enc.password="abc"} | select(span."enc.password", resource.service.name)',
        key,
        'search'
      )
    ).toBe(`{span.enc.password="${abc}"} | select(span."enc.password", resource.service.name)`);
  });

  it('preserves comments around predicates, pipeline stages, and query hints', async () => {
    const query =
      '/* lead */ {span.enc.password /* field */ = "abc"} /* stage */ | select(resource.service.name) // note\n with (most_recent=true)';
    expect(await rewriteProtectedTraceQL(query, key, 'search')).toBe(
      `/* lead */ {span.enc.password /* field */ = "${abc}"} /* stage */ | select(resource.service.name, span.enc.password) // note\n with (most_recent=true)`
    );
    expect(await rewriteProtectedTraceQL('/* lead */ {span.enc.password=\"abc\"} /* end */', key, 'search')).toBe(
      `/* lead */ {span.enc.password=\"${abc}\"} | select(span.enc.password) /* end */`
    );
    expect(await rewriteProtectedTraceQL('{span.enc.password="abc"} // | rate()', key, 'search')).toBe(
      `{span.enc.password="${abc}"} | select(span.enc.password) // | rate()`
    );
  });

  it('decodes dotted identifier components and literal quote/backslash escapes', async () => {
    expect(await rewriteProtectedTraceQL('{span.enc."password"="a\\\"b\\\\c"}', key, 'metrics')).toBe(
      '{span.enc."password"="enc.password:a\\\"b\\\\c"}'
    );
    expect(encrypt).toHaveBeenCalledWith('enc.password', 'a"b\\c');
  });

  it('does not project metrics or metadata and leaves ordinary static queries untouched without a key', async () => {
    expect(await rewriteProtectedTraceQL('{span.enc.password="abc"} | rate()', key, 'metrics')).toBe(
      `{span.enc.password="${abc}"} | rate()`
    );
    expect(await rewriteProtectedTraceQL('{span.enc.password="abc"}', key, 'metadata')).toBe(
      `{span.enc.password="${abc}"}`
    );
    expect(await rewriteProtectedTraceQL('{span.password="abc"}', undefined, 'search')).toBe('{span.password="abc"}');
    expect(await rewriteProtectedTraceQL('{span.enc.password="abc"} | select(span.enc.password)', key, 'search')).toBe(
      `{span.enc.password="${abc}"} | select(span.enc.password)`
    );
  });

  it('routes only actual metrics AST operations, not function names in values or comments', () => {
    expect(isMetricsTraceQL('{span.enc.password="| rate()"}')).toBe(false);
    expect(isMetricsTraceQL('{span.enc.password="abc"} /* | rate() */')).toBe(false);
    expect(isMetricsTraceQL('{span.enc.password="abc"} // | rate()')).toBe(false);
    expect(isMetricsTraceQL('{span.enc.password="abc"} | rate()')).toBe(true);
    expect(isMetricsTraceQL('{span.http.route="abc"} | count_over_time()')).toBe(true);
  });

  it('classifies compiled inequality guards without revalidating them as plaintext predicates', async () => {
    const compiledSearch = await rewriteProtectedTraceQL('{span.enc.password!="abc"}', key, 'search');
    const compiledMetrics = await rewriteProtectedTraceQL('{span.enc.password!="abc"} | rate()', key, 'metrics');
    expect(isMetricsTraceQL(compiledSearch)).toBe(false);
    expect(isMetricsTraceQL(compiledMetrics)).toBe(true);
  });

  it('classifies static, protected, and dynamic names before host persistence', () => {
    expect(classifyProtectedTraceQL('{span.http.route="abc"}').requiresSealing).toBe(false);
    expect(classifyProtectedTraceQL('{span.enc.password="abc"}')).toMatchObject({
      requiresSealing: true,
      protectedReferences: true,
      dynamicReferences: false,
      protectedRhsRanges: [{ from: 19, to: 24 }],
    });
    expect(classifyProtectedTraceQL('{span.${attribute}="abc"}')).toMatchObject({
      requiresSealing: true,
      protectedReferences: false,
      dynamicReferences: true,
    });
    expect(classifyProtectedTraceQL('{span.enc.$attribute="abc"}').requiresSealing).toBe(true);
    expect(classifyProtectedTraceQL('{span.http.route=${value}}').requiresSealing).toBe(false);
    expect(classifyProtectedTraceQL('{span.http.route=$value}').requiresSealing).toBe(false);
    expect(classifyProtectedTraceQL('{span.http.status_code > ($minimum + 1)}').requiresSealing).toBe(false);
    expect(classifyProtectedTraceQL('{span.http.status_code > ($minimum ^ 2)}').requiresSealing).toBe(false);
    expect(classifyProtectedTraceQL('{${scope}.enc.password="abc"}')).toMatchObject({
      requiresSealing: true,
      dynamicReferences: true,
    });
    expect(classifyProtectedTraceQL('${query}').requiresSealing).toBe(true);
    expect(classifyProtectedTraceQL('{span.enc.password="abc"} | select(span.enc.password)').requiresSealing).toBe(
      true
    );
  });

  it.each([
    '{resource.enc.password="abc"}',
    '{.enc.password="abc"}',
    '{parent.span.enc.password="abc"}',
    '{span.enc.password>"abc"}',
    '{span.enc.password=nil}',
    '{"abc"=span.enc.password}',
    '{span.enc.password + 1 = 2}',
    '{span.enc.password="abc"} | rate() by (span.enc.password)',
    '{span.enc.password="abc"',
    '{span.enc.password="a\\n"}',
    '{span.enc.password="a\\t"}',
    '{span.enc.password="\\u0041"}',
  ])('rejects unsupported protected syntax without sending original query: %s', async (query) => {
    expect(() => classifyProtectedTraceQL(query)).toThrow('Invalid or unsupported protected TraceQL query.');
    await expect(rewriteProtectedTraceQL(query, key, 'search')).rejects.toThrow(
      'Invalid or unsupported protected TraceQL query.'
    );
  });

  it('rejects unresolved template scopes and query fragments at the outbound boundary', async () => {
    await expect(rewriteProtectedTraceQL('{${scope}.enc.password="abc"}', key, 'search')).rejects.toThrow();
    await expect(rewriteProtectedTraceQL('${query}', key, 'search')).rejects.toThrow();
  });

  it('uses one key automatically, requires explicit choices for multiple keys, and leaves prefixed ciphertext unchanged', async () => {
    const secondEnvelope = `enc:v1:${'a'.repeat(32)}:${'A'.repeat(22)}`;
    const second = { kid: 'a'.repeat(32), encrypt: jest.fn(() => secondEnvelope) } as unknown as ProtectedAttributeKey;
    const raw = '{span.enc.password="abc"}';
    expect(await rewriteProtectedTraceQL(raw, [key], 'search')).toBe(`{span.enc.password="${abc}"} | select(span.enc.password)`);
    await expect(rewriteProtectedTraceQL(raw, [key, second], 'search')).rejects.toThrow();
    expect(second.encrypt).not.toHaveBeenCalled();
    const selected = protectedTraceQLPredicates(raw)[0].predicate;
    expect(await rewriteProtectedTraceQL(raw, [key, second], 'search', false, [{ predicate: selected, kid: second.kid }]))
      .toBe(`{span.enc.password="${secondEnvelope}"} | select(span.enc.password)`);
    expect(second.encrypt).toHaveBeenCalledWith('enc.password', 'abc');
    await expect(rewriteProtectedTraceQL(raw, [key, second], 'search', false,
      [{ predicate: selected, kid: 'b'.repeat(32) }])).rejects.toThrow();
    const direct = `{span.enc.password="${abc}"}`;
    expect(classifyProtectedTraceQL(direct).requiresSealing).toBe(false);
    expect(await rewriteProtectedTraceQL(direct, undefined, 'search')).toBe(direct);
    expect(await rewriteProtectedTraceQL(direct, [key, second], 'metrics')).toBe(direct);
    const partial = '{span.enc.password="enc:v1:630dcd2966c4336691125448bbb25b4f:AAAAA"}';
    expect(classifyProtectedTraceQL(partial).requiresSealing).toBe(false);
    expect(await rewriteProtectedTraceQL(partial, undefined, 'search')).toBe(partial);
  });

  it('ignores forgotten key selections for direct values but not plaintext', async () => {
    const direct = '{span.enc.password!="enc:custom"}';
    const staleKid = 'a'.repeat(32);
    const choice = [{ predicate: protectedTraceQLPredicates(direct)[0].predicate, kid: staleKid }];
    expect(() => assertProtectedTraceQLKeyChoices(direct, [], choice)).not.toThrow();
    for (const mode of ['search', 'metrics', 'metadata'] as const) {
      expect(await rewriteProtectedTraceQL(direct, undefined, mode, false, choice)).toBe(direct);
    }
    const plaintext = '{span.enc.password!="secret"}';
    const plaintextChoice = [{ predicate: protectedTraceQLPredicates(plaintext)[0].predicate, kid: staleKid }];
    expect(() => assertProtectedTraceQLKeyChoices(plaintext, [], plaintextChoice)).toThrow();
    await expect(rewriteProtectedTraceQL(plaintext, undefined, 'search', false, plaintextChoice)).rejects.toThrow();
    expect(() => assertProtectedTraceQLKeyChoices(direct, [], [{ predicate: choice[0].predicate, kid: 'invalid' }])).toThrow();
    expect(() => assertProtectedTraceQLKeyChoices(direct, [], [...choice, ...choice])).toThrow();
  });

  it.each([
    'enc:',
    'enc:custom',
    'enc:v2:anything',
    'enc:v1|plain.*',
    `enc:v1:${key.kid}:abc`,
    'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:.*|secret',
  ])('passes prefixed literals through unchanged for every operator and compiler mode: %s', async (value) => {
    expect(isCiphertextQueryValue(value)).toBe(true);
    const directKey = {
      kid: key.kid,
      encrypt: jest.fn(),
      substringTokens: jest.fn(),
    } as unknown as ProtectedAttributeKey;
    for (const op of ['=', '!=', '=~', '!~', '@>', '!@>']) {
      const query = `{span.enc.api.token ${op} ${JSON.stringify(value)}}`;
      for (const enabled of [false, true]) {
        expect(classifyProtectedTraceQL(query, enabled)).toMatchObject({
          requiresSealing: false, protectedReferences: true,
        });
        expect(protectedTraceQLPredicates(query, enabled)[0].keyRequired).toBe(false);
        expect(() => assertProtectedTraceQLKeyChoices(query, [], [], enabled)).not.toThrow();
        for (const mode of ['search', 'metrics', 'metadata'] as const) {
          expect(await rewriteProtectedTraceQL(query, undefined, mode, enabled)).toBe(query);
          expect(await rewriteProtectedTraceQL(query, directKey, mode, enabled)).toBe(query);
        }
      }
    }
    expect(directKey.encrypt).not.toHaveBeenCalled();
    expect(directKey.substringTokens).not.toHaveBeenCalled();
  });

  it.each(['.*', '^enc:', 'Enc:custom', 'plain.*', 'secret', '.*enc:v1'])(
    'seals non-prefixed regex RHS literally and requires its selected key: %s', async (pattern) => {
      expect(isCiphertextQueryValue(pattern)).toBe(false);
      const second = {
        kid: 'a'.repeat(32),
        encrypt: jest.fn((field: string, value: string) => `ciphertext:${field}:${value}`),
      } as unknown as ProtectedAttributeKey;
      for (const op of ['=~', '!~']) {
        const query = `{span.enc.api.token ${op} ${JSON.stringify(pattern)}}`;
        expect(classifyProtectedTraceQL(query).requiresSealing).toBe(true);
        const [predicate] = protectedTraceQLPredicates(query);
        expect(predicate.keyRequired).toBe(true);
        expect(() => assertProtectedTraceQLKeyChoices(query, [], [])).toThrow();
        expect(() => assertProtectedTraceQLKeyChoices(query, [key, second], [])).toThrow();
        await expect(rewriteProtectedTraceQL(query, undefined, 'search')).rejects.toThrow();
        await expect(rewriteProtectedTraceQL(query, [key, second], 'search')).rejects.toThrow();
        const choice = [{ predicate: predicate.predicate, kid: second.kid }];
        expect(await rewriteProtectedTraceQL(query, [key, second], 'search', false, choice)).toBe(
          `{span.enc.api.token ${op} "ciphertext:enc.api.token:${pattern}"} | select(span.enc.api.token)`
        );
        expect(second.encrypt).toHaveBeenCalledWith('enc.api.token', pattern);
      }
      expect(encrypt).not.toHaveBeenCalled();
    }
  );

  it('projects only keyed predicates when mixed with direct prefixed predicates', async () => {
    const query = '{span.enc.api.token !~ "enc:v1|plain.*" && span.enc.password="abc"}';
    expect(classifyProtectedTraceQL(query).requiresSealing).toBe(true);
    expect(protectedTraceQLPredicates(query).map((predicate) => predicate.keyRequired)).toEqual([false, true]);
    await expect(rewriteProtectedTraceQL(query, undefined, 'search')).rejects.toThrow();
    expect(await rewriteProtectedTraceQL(query, key, 'search')).toBe(
      `{span.enc.api.token !~ "enc:v1|plain.*" && span.enc.password="${abc}"} | select(span.enc.password)`
    );
    expect(encrypt).toHaveBeenCalledTimes(1);
  });

  it('selects a key only for plaintext regex beside a keyless prefixed equality', async () => {
    const second = {
      kid: 'a'.repeat(32),
      encrypt: jest.fn((field: string, value: string) => `selected:${field}:${value}`),
    } as unknown as ProtectedAttributeKey;
    const query = '{span.enc.password="enc:custom" && span.enc.api.token !~ "^enc:"}';
    const predicates = protectedTraceQLPredicates(query);
    expect(predicates.map((predicate) => predicate.keyRequired)).toEqual([false, true]);
    expect(() => assertProtectedTraceQLKeyChoices(query, [key, second], [])).toThrow();
    const choice = [{ predicate: predicates[1].predicate, kid: second.kid }];
    assertProtectedTraceQLKeyChoices(query, [key, second], choice);
    expect(await rewriteProtectedTraceQL(query, [key, second], 'search', false, choice)).toBe(
      '{span.enc.password="enc:custom" && span.enc.api.token !~ "selected:enc.api.token:^enc:"} | select(span.enc.api.token)'
    );
    expect(second.encrypt).toHaveBeenCalledTimes(1);
    expect(second.encrypt).toHaveBeenCalledWith('enc.api.token', '^enc:');
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('encrypts wildcard regex in a mixed query instead of treating it as a direct predicate', async () => {
    const query = '{span.enc.api.token =~ ".*" && span.enc.password="abc"}';
    expect(protectedTraceQLPredicates(query).map((predicate) => predicate.keyRequired)).toEqual([true, true]);
    await expect(rewriteProtectedTraceQL(query, undefined, 'search')).rejects.toThrow();
    expect(await rewriteProtectedTraceQL(query, key, 'search')).toBe(
      `{span.enc.api.token =~ "enc.api.token:.*" && span.enc.password="${abc}"} | select(span.enc.api.token, span.enc.password)`
    );
    expect(encrypt).toHaveBeenCalledWith('enc.api.token', '.*');
  });

  it('binds independent choices to protected predicates and rejects shifted or forgotten selections', async () => {
    const other = { kid: 'a'.repeat(32), encrypt: jest.fn((field: string) =>
      `enc:v1:${'a'.repeat(32)}:${'A'.repeat(22)}`) } as unknown as ProtectedAttributeKey;
    const query = '{span.enc.password="abc" && span.enc.token="private" && span.http.route="public"}';
    const [password, token] = protectedTraceQLPredicates(query);
    const choices = [
      { predicate: password.predicate, kid: key.kid },
      { predicate: token.predicate, kid: other.kid },
    ];
    assertProtectedTraceQLKeyChoices(query, [key, other], choices);
    const compiled = await rewriteProtectedTraceQL(query, [key, other], 'metrics', false, choices);
    expect(compiled).toContain(`span.enc.password="${abc}"`);
    expect(compiled).toContain(`span.enc.token="enc:v1:${other.kid}:${'A'.repeat(22)}"`);
    expect(compiled).toContain('span.http.route="public"');
    expect(other.encrypt).toHaveBeenCalledWith('enc.token', 'private');
    expect(() => assertProtectedTraceQLKeyChoices(query, [key, other], choices.slice(0, 1))).toThrow();
    expect(() => assertProtectedTraceQLKeyChoices(query, [key], choices)).toThrow();
    const shifted = `{span.http.route="public" && ${query.slice(1, -1)}}`;
    expect(() => assertProtectedTraceQLKeyChoices(shifted, [key, other], choices)).toThrow();
    const rebased = rebaseProtectedTraceQLKeys(query, shifted, choices);
    expect(rebased).toHaveLength(2);
    expect(rebased[0].predicate).toBe(protectedTraceQLPredicates(shifted)[0].predicate);
    const changed = query.replace('"abc"', '"changed"');
    expect(rebaseProtectedTraceQLKeys(query, changed, choices)).toEqual([
      { predicate: protectedTraceQLPredicates(changed)[1].predicate, kid: other.kid },
    ]);
    await expect(rewriteProtectedTraceQL(query, [key], 'search', false, choices)).rejects.toThrow();
  });

  it('fails closed without a key and on ambiguous search projection paths', async () => {
    await expect(rewriteProtectedTraceQL('{span.enc.password="abc"}', undefined, 'search')).rejects.toThrow();
    await expect(rewriteProtectedTraceQL('{span.enc.password="abc"} || {span.x="y"}', key, 'search')).rejects.toThrow();
    await expect(rewriteProtectedTraceQL('{span.enc.password="abc"} | rate()', key, 'search')).rejects.toThrow();
    await expect(
      rewriteProtectedTraceQL('{span.enc.password="abc"} | select(span.x) | select(span.y)', key, 'search')
    ).rejects.toThrow();
  });
});

describe('protected substring compiler', () => {
  const first = {
    kid: '630dcd2966c4336691125448bbb25b4f',
    substringTokens: jest.fn(async (_field: string, _value: string) => ['bi:v1:first:coo', 'bi:v1:first:ool']),
  } as unknown as ProtectedAttributeKey;
  const second = {
    kid: 'a'.repeat(32),
    substringTokens: jest.fn(async (_field: string, _value: string) => ['bi:v1:second:coo', 'bi:v1:second:ool']),
  } as unknown as ProtectedAttributeKey;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seals plaintext drafts and compiles whole per-key ordered sequences without exposing plaintext', async () => {
    const raw = '{span."enc.secret" @> "cool" && span.http.route="users"} with (most_recent=true)';
    expect(classifyProtectedTraceQL(raw, true).requiresSealing).toBe(true);
    await expect(rewriteProtectedTraceQL(raw, [first, second], 'search', true)).rejects.toThrow();
    const choice = [{ predicate: protectedTraceQLPredicates(raw, true)[0].predicate, kid: second.kid }];
    expect(await rewriteProtectedTraceQL(raw, [first, second], 'search', true, choice)).toBe(
      '{span."bi.secret" subarray_seq ["bi:v1:second:coo","bi:v1:second:ool"] && span.http.route="users"} | select(span."enc.secret") with (most_recent=true)'
    );
    expect(first.substringTokens).not.toHaveBeenCalled();
    expect(second.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
    expect(await rewriteProtectedTraceQL('{span.enc.secret @> "cool"} | rate()', first, 'metrics', true)).toBe(
      '{span."bi.secret" subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"]} | rate()'
    );
    expect(await rewriteProtectedTraceQL('{span.enc.secret @> "cool"}', first, 'metadata', true)).toBe(
      '{span."bi.secret" subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"]}'
    );
  });

  it('seals only plaintext in mixed public substring and plaintext queries', async () => {
    const query = '{span.enc.secret !@> "enc:v1:" && span.enc.password="abc"}';
    expect(classifyProtectedTraceQL(query).requiresSealing).toBe(true);
    expect(protectedTraceQLPredicates(query).map((predicate) => predicate.keyRequired)).toEqual([false, true]);
    await expect(rewriteProtectedTraceQL(query, undefined, 'search')).rejects.toThrow();
    expect(await rewriteProtectedTraceQL(query, key, 'search')).toBe(
      `{span.enc.secret !@> "enc:v1:" && span.enc.password="${abc}"} | select(span.enc.password)`
    );
    expect(first.substringTokens).not.toHaveBeenCalled();
  });

  it.each([
    `prefix:${abc}`,
    '^enc:',
    'Enc:custom',
    '.*',
    '$term',
  ])('requires substring capability and a key for non-prefixed substring text: %s', async (value) => {
    const query = `{span.enc.secret @> ${JSON.stringify(value)}}`;
    expect(() => classifyProtectedTraceQL(query)).toThrow();
    expect(classifyProtectedTraceQL(query, true).requiresSealing).toBe(true);
    expect(protectedTraceQLPredicates(query, true)[0].keyRequired).toBe(true);
    await expect(rewriteProtectedTraceQL(query, undefined, 'search', true)).rejects.toThrow();
  });

  it('rewrites protected negative substring using key-matched index predicates and preserves ordinary text search', async () => {
    const query = '{span.enc.secret !@> "cool" && span.http.route !@> "users"}';
    const choice = [{ predicate: protectedTraceQLPredicates(query, true)[0].predicate, kid: first.kid }];
    expect(await rewriteProtectedTraceQL(query, [first, second], 'search', true, choice)).toBe(
      '{span."bi.secret" !subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"] && span.http.route !@> "users"} | select(span.enc.secret)'
    );
    expect(first.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
    expect(second.substringTokens).not.toHaveBeenCalled();
    expect(classifyProtectedTraceQL('{span.http.route !@> "users"}').requiresSealing).toBe(false);
    expect(await rewriteProtectedTraceQL('{span.http.route @> "users"}', first, 'search')).toBe('{span.http.route @> "users"}');
  });

  it('rejects negative protected substring when not opted in, keyless, or using unsupported RHS', async () => {
    expect(() => classifyProtectedTraceQL('{span.enc.secret !@> "cool"}')).toThrow();
    await expect(rewriteProtectedTraceQL('{span.enc.secret !@> "cool"}', undefined, 'search', true)).rejects.toThrow();
    await expect(rewriteProtectedTraceQL('{span.enc.secret !@> $value}', first, 'search', true)).rejects.toThrow();
    expect(first.substringTokens).not.toHaveBeenCalled();
  });

  it('rejects disabled, keyless, invalid scopes, sidecar injection and nonliteral RHS before rewrite', async () => {
    expect(() => classifyProtectedTraceQL('{span.enc.secret @> "cool"}')).toThrow();
    await expect(rewriteProtectedTraceQL('{span.enc.secret @> "cool"}', undefined, 'search', true)).rejects.toThrow();
    for (const query of [
      '{resource.enc.secret @> "cool"}',
      '{span.bi.secret @> "cool"}',
      '{span.enc.secret @> nil}',
      '{span.enc.secret @> "a\\n"}',
      '{span.enc.secret @> $value}',
    ]) {
      await expect(rewriteProtectedTraceQL(query, first, 'search', true)).rejects.toThrow();
    }
    expect(first.substringTokens).not.toHaveBeenCalled();
  });
});
