import type { ProtectedAttributeKey } from './crypto';
import { classifyProtectedTraceQL, isMetricsTraceQL, rewriteProtectedTraceQL } from './traceql';

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
const key = { encrypt } as unknown as ProtectedAttributeKey;

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
    '{span.enc.password=~"abc"}',
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

  it('searches all loaded key histories and preserves canonical ciphertext even without keys', async () => {
    const secondEnvelope = `enc:v1:${'a'.repeat(32)}:${'A'.repeat(22)}`;
    const second = {
      encrypt: jest.fn(() => secondEnvelope),
    } as unknown as ProtectedAttributeKey;
    expect(await rewriteProtectedTraceQL('{span.enc.password="abc"}', [key, second], 'search')).toBe(
      `{(span.enc.password="${abc}" || span.enc.password="${secondEnvelope}")} | select(span.enc.password)`
    );
    expect(await rewriteProtectedTraceQL('{span.enc.password!="abc"}', [key, second], 'metrics')).toBe(
      `{(span.enc.password!="${abc}" && span.enc.password!="${secondEnvelope}" && span.enc.password != nil)}`
    );
    const raw = `{span.enc.password="${abc}"}`;
    expect(classifyProtectedTraceQL(raw).requiresSealing).toBe(false);
    expect(await rewriteProtectedTraceQL(raw, undefined, 'search')).toBe(`${raw} | select(span.enc.password)`);
    expect(await rewriteProtectedTraceQL(raw, [key, second], 'metrics')).toBe(raw);
    expect(second.encrypt).toHaveBeenCalledTimes(2);
    expect(second.encrypt).toHaveBeenCalledWith('enc.password', 'abc');
    expect(
      classifyProtectedTraceQL('{span.enc.password="enc:v1:630dcd2966c4336691125448bbb25b4f:AAAAA"}').requiresSealing
    ).toBe(true);
    await expect(
      rewriteProtectedTraceQL(
        '{span.enc.password="enc:v1:630dcd2966c4336691125448bbb25b4f:AAAAA"}',
        undefined,
        'search'
      )
    ).rejects.toThrow();
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
    expect(await rewriteProtectedTraceQL(raw, [first, second], 'search', true)).toBe(
      '{(span."bi.secret" subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"] || span."bi.secret" subarray_seq ["bi:v1:second:coo","bi:v1:second:ool"]) && span.http.route="users"} | select(span."enc.secret") with (most_recent=true)'
    );
    expect(first.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
    expect(second.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
    expect(await rewriteProtectedTraceQL('{span.enc.secret @> "cool"} | rate()', first, 'metrics', true)).toBe(
      '{span."bi.secret" subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"]} | rate()'
    );
    expect(await rewriteProtectedTraceQL('{span.enc.secret @> "cool"}', first, 'metadata', true)).toBe(
      '{span."bi.secret" subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"]}'
    );
    const envelopeLiteral = `enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ`;
    expect(classifyProtectedTraceQL(`{span.enc.secret @> "${envelopeLiteral}"}`, true).requiresSealing).toBe(true);
    await rewriteProtectedTraceQL(`{span.enc.secret @> "${envelopeLiteral}"}`, first, 'search', true);
    expect(first.substringTokens).toHaveBeenCalledWith('enc.secret', envelopeLiteral);
  });

  it('rewrites protected negative substring using key-matched index predicates and preserves ordinary text search', async () => {
    const query = '{span.enc.secret !@> "cool" && span.http.route !@> "users"}';
    expect(await rewriteProtectedTraceQL(query, [first, second], 'search', true)).toBe(
      '{(span."bi.secret" !subarray_seq ["bi:v1:first:coo","bi:v1:first:ool"] || span."bi.secret" !subarray_seq ["bi:v1:second:coo","bi:v1:second:ool"]) && span.http.route !@> "users"} | select(span.enc.secret)'
    );
    expect(first.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
    expect(second.substringTokens).toHaveBeenCalledWith('enc.secret', 'cool');
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
