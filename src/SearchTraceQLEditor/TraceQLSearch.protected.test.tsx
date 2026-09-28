import type * as ReactType from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TraceqlSearchScope, type TraceqlFilter } from '../dataquery';
import { type TempoDatasource } from '../datasource';
import { initTemplateSrv } from '../test/test_utils';
import { type TempoQuery } from '../types';

import TraceQLSearch from './TraceQLSearch';

jest.mock('./SearchField', () => {
  const React = jest.requireActual<typeof ReactType>('react');
  return {
    __esModule: true,
    default: ({
      filter,
      updateFilter,
      query,
    }: {
      filter: TraceqlFilter;
      updateFilter: (value: TraceqlFilter) => void;
      query: string;
    }) =>
      React.createElement(
        'button',
        {
          'aria-label': `change ${filter.id}`,
          'data-context-query': query,
          onClick: () =>
            updateFilter(
              filter.id === 'route'
                ? { ...filter, tag: 'http.route=1} //', value: 'first' }
                : { ...filter, value: filter.value === 'first' ? 'second' : 'first' }
            ),
        },
        'Change filter'
      ),
  };
});
jest.mock('./TagsInput', () => ({ __esModule: true, default: () => null }));
jest.mock('./DurationInput', () => ({ __esModule: true, default: () => null }));
jest.mock('./AggregateByAlert', () => ({ AggregateByAlert: () => null }));
jest.mock('../traceql/TempoQueryBuilderOptions', () => ({ TempoQueryBuilderOptions: () => null }));
jest.mock('../_importedDependencies/datasources/prometheus/RawQuery', () => ({ RawQuery: () => null }));

const kid = '630dcd2966c4336691125448bbb25b4f';

test('overlapping protected value edits never emit plaintext or let an earlier seal overwrite the latest host model', async () => {
  initTemplateSrv([], {});
  const resolves: Array<(value: string) => void> = [];
  const sealQueryModel = jest.fn(() => new Promise<string>((resolve) => resolves.push(resolve)));
  const key = { kid, sealQueryModel };
  const filter: TraceqlFilter = { id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=' };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: key,
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    search: { filters: [filter] },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      getIntrinsics: jest.fn().mockReturnValue([]),
      generateQueryFromFilters: jest.fn().mockReturnValue('{}'),
    },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  Object.assign(datasource.languageProvider, { datasource });
  const saved: TempoQuery = { refId: 'A', queryType: 'traceqlSearch', filters: [] };
  const hostChange = jest.fn();
  render(<TraceQLSearch datasource={datasource} query={saved} onChange={hostChange} onClearResults={() => {}} />);
  const button = await screen.findByRole('button', { name: 'change password' });
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: 'change password' }));
  expect(hostChange).not.toHaveBeenCalled();
  expect(sealQueryModel).toHaveBeenCalledWith('first', JSON.stringify(['tempo-uid', 'filters', 'password', 'value']));
  expect(sealQueryModel).toHaveBeenCalledWith('second', JSON.stringify(['tempo-uid', 'filters', 'password', 'value']));
  await act(async () => {
    resolves[1](`qenc:v1:${kid}:${'B'.repeat(40)}`);
  });
  await waitFor(() => expect(hostChange).toHaveBeenCalledTimes(1));
  expect(hostChange.mock.calls[0][0].filters[0].value).toBe(`qenc:v1:${kid}:${'B'.repeat(40)}`);
  await act(async () => {
    resolves[0](`qenc:v1:${kid}:${'A'.repeat(40)}`);
  });
  expect(hostChange).toHaveBeenCalledTimes(1);
  expect(saved.filters).toEqual([]);
});

test('rejected builder draft cannot contribute a malformed tag to metadata context', async () => {
  initTemplateSrv([], {});
  const key = {
    kid,
    openQueryModel: jest.fn().mockResolvedValue('abc'),
    sealQueryModel: jest.fn(),
  };
  const route: TraceqlFilter = {
    id: 'route',
    tag: 'http.route',
    scope: TraceqlSearchScope.Span,
    operator: '=',
    value: 'initial',
    valueType: 'string',
  };
  const password: TraceqlFilter = {
    id: 'password',
    tag: 'enc.password',
    scope: TraceqlSearchScope.Span,
    operator: '=',
    value: `qenc:v1:${kid}:${'A'.repeat(38)}`,
    valueType: 'string',
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: key,
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    search: { filters: [{ ...route, value: undefined }] },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      getIntrinsics: jest.fn().mockReturnValue([]),
      generateQueryFromFilters: jest.fn().mockReturnValue('{span.http.route="safe" && span.enc.password="abc"}'),
    },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  Object.assign(datasource.languageProvider, { datasource });
  const saved: TempoQuery = { refId: 'A', queryType: 'traceqlSearch', filters: [route, password] };
  const hostChange = jest.fn();
  render(<TraceQLSearch datasource={datasource} query={saved} onChange={hostChange} onClearResults={() => {}} />);
  const button = await screen.findByRole('button', { name: 'change route' });
  await waitFor(() =>
    expect(button).toHaveAttribute('data-context-query', '{span.http.route="safe" && span.enc.password="abc"}')
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'change route' })).toHaveAttribute('data-context-query', '')
  );
  expect(hostChange).not.toHaveBeenCalled();
});

test('rejects protected builder values before a key is imported', async () => {
  initTemplateSrv([], {});
  const filter: TraceqlFilter = { id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=' };
  const datasource = {
    uid: 'tempo-uid',
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    search: { filters: [filter] },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      getIntrinsics: jest.fn().mockReturnValue([]),
      generateQueryFromFilters: jest.fn().mockReturnValue('{}'),
    },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  Object.assign(datasource.languageProvider, { datasource });
  const hostChange = jest.fn();
  render(
    <TraceQLSearch
      datasource={datasource}
      query={{ refId: 'A', queryType: 'traceqlSearch', filters: [] }}
      onChange={hostChange}
      onClearResults={() => {}}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'change password' }));
  expect(hostChange).not.toHaveBeenCalled();
  expect(screen.getByText(/Complete or correct protected filter/)).toBeInTheDocument();
});

test('opens a canonical encrypted Builder filter without importing a key', async () => {
  initTemplateSrv([], {});
  const ciphertext = 'enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ';
  const filter: TraceqlFilter = {
    id: 'password',
    scope: TraceqlSearchScope.Span,
    tag: 'enc.password',
    operator: '=',
    value: ciphertext,
  };
  const datasource = {
    uid: 'tempo-uid',
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    search: { filters: [{ ...filter, value: undefined }] },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      getIntrinsics: jest.fn().mockReturnValue([]),
      generateQueryFromFilters: jest.fn().mockReturnValue(`{span.enc.password="${ciphertext}"}`),
    },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  Object.assign(datasource.languageProvider, { datasource });
  const hostChange = jest.fn();
  render(
    <TraceQLSearch
      datasource={datasource}
      query={{ refId: 'A', queryType: 'traceqlSearch', filters: [filter] }}
      onChange={hostChange}
      onClearResults={() => {}}
    />
  );
  expect(await screen.findByRole('button', { name: 'change password' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'change password' }));
  expect(hostChange).not.toHaveBeenCalled();
  expect(screen.getByText(/Complete or correct protected filter/)).toBeInTheDocument();
});

test('opens saved Builder filters under distinct imported key IDs without writing plaintext to the host', async () => {
  initTemplateSrv([], {});
  const old = { kid, openQueryModel: jest.fn().mockResolvedValue('old') };
  const active = {
    kid: '00000000000000000000000000000000',
    openQueryModel: jest.fn().mockResolvedValue('new'),
  };
  const password: TraceqlFilter = {
    id: 'password',
    scope: TraceqlSearchScope.Span,
    tag: 'enc.password',
    operator: '=',
    value: `qenc:v1:${kid}:${'A'.repeat(40)}`,
  };
  const token: TraceqlFilter = {
    id: 'token',
    scope: TraceqlSearchScope.Span,
    tag: 'enc.token',
    operator: '=',
    value: `qenc:v1:${active.kid}:${'B'.repeat(40)}`,
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: active,
    protectedKeys: [old, active],
    getProtectedKey: (id: string) => (id === kid ? old : id === active.kid ? active : undefined),
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    search: {
      filters: [
        { ...password, value: undefined },
        { ...token, value: undefined },
      ],
    },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      getIntrinsics: jest.fn().mockReturnValue([]),
      generateQueryFromFilters: jest.fn().mockReturnValue('{}'),
    },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  Object.assign(datasource.languageProvider, { datasource });
  const hostChange = jest.fn();
  render(
    <TraceQLSearch
      datasource={datasource}
      query={{ refId: 'A', queryType: 'traceqlSearch', filters: [password, token] }}
      onChange={hostChange}
      onClearResults={() => {}}
    />
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'change password' })).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'change token' })).toBeInTheDocument();
  expect(old.openQueryModel).toHaveBeenCalledWith(
    password.value,
    JSON.stringify(['tempo-uid', 'filters', 'password', 'value'])
  );
  expect(active.openQueryModel).toHaveBeenCalledWith(
    token.value,
    JSON.stringify(['tempo-uid', 'filters', 'token', 'value'])
  );
  expect(hostChange).not.toHaveBeenCalled();
});
