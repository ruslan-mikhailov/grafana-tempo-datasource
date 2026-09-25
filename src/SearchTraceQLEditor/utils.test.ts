import { uniq } from 'lodash';

import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoDatasource } from '../datasource';
import TempoLanguageProvider from '../language_provider';
import { assertProtectedQueryModelSafe } from '../protectedAttributes/model';
import { classifyProtectedTraceQL } from '../protectedAttributes/traceql';
import { intrinsics } from '../traceql/traceql';
import { type TempoQuery } from '../types';

import { emptyTags, testIntrinsics, v1Tags, v2Tags } from './mocks';
import {
  filterTitle,
  filterToQuerySection,
  getAllTags,
  getFilteredTags,
  getIntrinsicTags,
  getTagsByScope,
  getUnscopedTags,
} from './utils';

const datasource: TempoDatasource = {
  search: {
    filters: [],
  },
} as unknown as TempoDatasource;
const lp = new TempoLanguageProvider(datasource);

describe('gets correct tags', () => {
  const datasource: TempoDatasource = {
    search: {
      filters: [],
    },
  } as unknown as TempoDatasource;
  const lp = new TempoLanguageProvider(datasource);

  it('for filtered tags when no tags supplied', () => {
    const tags = getFilteredTags(emptyTags, []);
    expect(tags).toEqual([]);
  });

  it('for filtered tags when API v1 tags supplied', () => {
    const tags = getFilteredTags(v1Tags, []);
    expect(tags).toEqual(['bar', 'foo']);
  });

  it('for filtered tags when API v1 tags supplied with tags to filter out', () => {
    const tags = getFilteredTags(v1Tags, ['foo']);
    expect(tags).toEqual(['bar']);
  });

  it('for filtered tags when API v2 tags supplied', () => {
    const tags = getFilteredTags(uniq(getUnscopedTags(v2Tags)), []);
    expect(tags).toEqual(['cluster', 'container', 'db']);
  });

  it('for filtered tags when API v2 tags supplied with tags to filter out', () => {
    const tags = getFilteredTags(getUnscopedTags(v2Tags), ['cluster']);
    expect(tags).toEqual(['container', 'db']);
  });

  it('for filtered tags when API v2 tags set', () => {
    lp.setV2Tags(v2Tags);
    const tags = getFilteredTags(uniq(getUnscopedTags(v2Tags)), []);
    expect(tags).toEqual(['cluster', 'container', 'db']);
  });

  it('for unscoped tags', () => {
    const tags = getUnscopedTags(v2Tags);
    expect(tags).toEqual(['cluster', 'container', 'db']);
  });

  it('for all tags', () => {
    const tags = getAllTags(v2Tags);
    expect(tags).toEqual(uniq(['cluster', 'container', 'db', 'duration', 'kind', 'name', 'status'].concat(intrinsics)));
  });

  it('for tags by resource scope', () => {
    const tags = getTagsByScope(v2Tags, TraceqlSearchScope.Resource);
    expect(tags).toEqual(['cluster', 'container']);
  });

  it('for tags by span scope', () => {
    const tags = getTagsByScope(v2Tags, TraceqlSearchScope.Span);
    expect(tags).toEqual(['db']);
  });

  it('for intrinsic tags', () => {
    const tags = getIntrinsicTags(v2Tags);
    expect(tags).toEqual(testIntrinsics);
  });
});

describe('filterToQuerySection returns the correct query section for a filter', () => {
  it('filter with single value', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'foo', operator: '=', value: 'bar' };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('.foo=bar');
  });

  it('filter with regex operator', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'foo', operator: '=~', value: 'bar.*', valueType: 'string' };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('.foo=~"bar.*"');
  });

  it('filter with scope', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=',
      value: 'bar',
      scope: TraceqlSearchScope.Resource,
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('resource.foo=bar');
  });

  it('filter with intrinsic tag', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'duration', operator: '=', value: '100ms' };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('duration=100ms');
  });

  it('filter with multiple non-string values and scope', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('(span.foo=bar || span.foo=baz)');
  });

  it('filter with multiple string values and scope', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('(span.foo="bar" || span.foo="baz")');
  });

  it('filter with multiple string values with regex', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=~',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('span.foo=~"bar|baz"');
  });

  it('filter with single value regex is not escaped', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=~',
      value: ['.+'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('span.foo=~".+"');
  });

  it('filter with single value negative regex is not escaped', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '!~',
      value: ['.+'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('span.foo!~".+"');
  });

  it('filter with multiple values regex still escapes each value for the alternation', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '=~',
      value: ['a.b', 'c.d'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('span.foo=~"a\\\\.b|c\\\\.d"');
  });

  it('filter with multiple values and != operator', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '!=',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('(span.foo!=bar && span.foo!=baz)');
  });

  it('filter with multiple string values and != operator', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '!=',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('(span.foo!="bar" && span.foo!="baz")');
  });

  it('filter with multiple string values and !~ operator', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'foo',
      operator: '!~',
      value: ['bar', 'baz'],
      scope: TraceqlSearchScope.Span,
      valueType: 'string',
    };
    const result = filterToQuerySection(filter, [], lp);
    expect(result).toBe('span.foo!~"bar|baz"');
  });
  it('quotes protected numeric-looking, empty and escaped string values without unsupported escapes', () => {
    const protectedDatasource = {
      instanceSettings: { jsonData: { protectedKeyId: '630dcd2966c4336691125448bbb25b4f' } },
    } as TempoDatasource;
    const provider = new TempoLanguageProvider(protectedDatasource);
    const filter: TraceqlFilter = {
      id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: '123',
    };
    expect(filterToQuerySection(filter, [filter], provider)).toBe('span.enc.password=\"123\"');
    expect(filterToQuerySection({ ...filter, value: '' }, [filter], provider)).toBe('span.enc.password=\"\"');
    expect(filterToQuerySection({ ...filter, value: ['123'] }, [filter], provider)).toBe('span.enc.password=\"123\"');
    expect(filterToQuerySection({ ...filter, value: ['123', 'true'] }, [filter], provider)).toBe('(span.enc.password=\"123\" || span.enc.password=\"true\")');
    expect(filterToQuerySection({ ...filter, value: 'a\"b\\c' }, [filter], provider)).toBe('span.enc.password=\"a\\\"b\\\\c\"');
    expect(() => filterToQuerySection({ ...filter, value: `a${String.fromCharCode(10)}b` }, [filter], provider)).toThrow();
    expect(() => filterToQuerySection({ ...filter, value: '${password}' }, [filter], provider)).toThrow();
  });
  it('keeps every ordinary array element inside its own TraceQL string, including backslashes and comments', async () => {
    const metadataRequest = jest.fn().mockResolvedValue({ tagValues: [] });
    const protectedDatasource = {
      search: { filters: [] },
      metadataRequest,
      instanceSettings: { jsonData: { protectedKeyId: '630dcd2966c4336691125448bbb25b4f' } },
    } as unknown as TempoDatasource;
    const provider = new TempoLanguageProvider(protectedDatasource);
    const ordinary: TraceqlFilter = {
      id: 'route', scope: TraceqlSearchScope.Span, tag: 'http.route', operator: '=',
      value: ['x\\', '|| span.enc.password=', ')} //'], valueType: 'string',
    };
    const protectedFilter: TraceqlFilter = {
      id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=',
      value: 'genuine-secret', valueType: 'string',
    };
    const q = provider.generateQueryFromFilters({ traceqlFilters: [ordinary, protectedFilter] });
    const rhs = classifyProtectedTraceQL(q).protectedRhsRanges;
    expect(rhs).toHaveLength(1);
    expect(q.slice(rhs[0].from, rhs[0].to)).toBe('"genuine-secret"');
    await provider.getOptionsV2({ tag: 'span.http.route', query: q });
    expect(metadataRequest).toHaveBeenCalledWith('tag-values', expect.objectContaining({ q }));
  });

  it('preserves representable ordinary quotes and backslashes across the saved model and generated query', () => {
    const kid = '630dcd2966c4336691125448bbb25b4f';
    const value = 'say "hello"\\again';
    const filter: TraceqlFilter = {
      id: 'route', scope: TraceqlSearchScope.Span, tag: 'http.route', operator: '=', value, valueType: 'string',
    };
    const saved: TempoQuery = { refId: 'A', queryType: 'traceqlSearch', filters: [filter] };
    expect(() => assertProtectedQueryModelSafe(saved, kid)).not.toThrow();
    expect(() => assertProtectedQueryModelSafe({ ...saved, filters: [{ ...filter, valueType: undefined }] }, kid)).toThrow();
    const provider = new TempoLanguageProvider({
      search: { filters: [] },
      instanceSettings: { jsonData: { protectedKeyId: kid } },
    } as unknown as TempoDatasource);
    const q = provider.generateQueryFromFilters({ traceqlFilters: saved.filters });
    expect(q).toBe(`{span.http.route=${JSON.stringify(value)}}`);
    expect(classifyProtectedTraceQL(q).requiresSealing).toBe(false);
  });

});

describe('filterTitle returns the correct title for a filter', () => {
  it('uses the custom label when one is set', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'k8s.cluster.name',
      label: 'Cluster',
      scope: TraceqlSearchScope.Resource,
    };
    expect(filterTitle(filter, lp)).toBe('Cluster');
  });

  it('prefers the custom label over the intrinsic name special case', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'name', label: 'Operation' };
    expect(filterTitle(filter, lp)).toBe('Operation');
  });

  it('falls back to the generated title when no label is set', () => {
    const filter: TraceqlFilter = {
      id: 'abc',
      tag: 'k8s.cluster.name',
      scope: TraceqlSearchScope.Resource,
    };
    expect(filterTitle(filter, lp)).toBe('Resource K 8 S Cluster Name');
  });

  it('falls back to the generated title when the label is an empty string', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'name', label: '' };
    expect(filterTitle(filter, lp)).toBe('Span Name');
  });

  it('falls back to the generated title when the label is only whitespace', () => {
    const filter: TraceqlFilter = { id: 'abc', tag: 'name', label: '   ' };
    expect(filterTitle(filter, lp)).toBe('Span Name');
  });
});
