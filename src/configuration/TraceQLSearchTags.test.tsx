import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { type DataSourcePluginOptionsEditorProps } from '@grafana/data';

import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoJsonData } from '../types';

import { TraceQLSearchTags } from './TraceQLSearchTags';

jest.mock('react-use/lib/useAsync', () => ({ __esModule: true, default: () => ({ loading: false }) }));
jest.mock('../SearchTraceQLEditor/TagsInput', () => ({
  __esModule: true,
  default: ({ updateFilter, deleteFilter, filters }: {
    updateFilter: (filter: TraceqlFilter) => void;
    deleteFilter: (filter: TraceqlFilter) => void;
    filters: TraceqlFilter[];
  }) => (
    <>
      <button type="button" onClick={() => updateFilter({
        id: 'public', scope: TraceqlSearchScope.Span, tag: 'http.route', operator: '=', value: 'public',
      })}>Add public filter</button>
      <button type="button" onClick={() => updateFilter({
        id: 'secret', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: 'secret',
      })}>Add protected filter</button>
      <button type="button" onClick={() => updateFilter({
        id: 'dynamic', scope: TraceqlSearchScope.Span, tag: '${attribute}', operator: '=', value: 'secret',
      })}>Add dynamic filter</button>
      <button type="button" onClick={() => deleteFilter(filters[0])}>Delete first filter</button>
    </>
  ),
}));

const kid = '630dcd2966c4336691125448bbb25b4f';
const protectedDefault: TraceqlFilter = {
  id: 'secret', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: 'secret',
};

function renderTags(filters: TraceqlFilter[], protectedKeyId?: string) {
  const onOptionsChange = jest.fn();
  const options = { jsonData: { protectedKeyId: protectedKeyId ?? kid, search: { filters } } } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<TraceQLSearchTags options={options} onOptionsChange={onOptionsChange} datasource={{} as never} />);
  return onOptionsChange;
}

test('checks the entire prospective static filter array before host writes, including dynamic names', async () => {
  const user = userEvent.setup();
  const onOptionsChange = renderTags([]);
  await user.click(screen.getByRole('button', { name: 'Add protected filter' }));
  expect(onOptionsChange).not.toHaveBeenCalled();
  expect(screen.getByText(/span\.enc\.password/)).not.toHaveTextContent('secret');
  await user.click(screen.getByRole('button', { name: 'Add dynamic filter' }));
  expect(onOptionsChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Add public filter' }));
  expect(onOptionsChange).toHaveBeenCalledWith(expect.objectContaining({
    jsonData: expect.objectContaining({ search: { filters: [expect.objectContaining({ tag: 'http.route' })] } }),
  }));
});

test('does not mutate or persist retained protected defaults, but permits explicitly deleting the unsafe filter', async () => {
  const user = userEvent.setup();
  const filters = [protectedDefault];
  const onOptionsChange = renderTags(filters);
  await user.click(screen.getByRole('button', { name: 'Add public filter' }));
  expect(onOptionsChange).not.toHaveBeenCalled();
  expect(filters).toEqual([protectedDefault]);
  await user.click(screen.getByRole('button', { name: 'Delete first filter' }));
  expect(onOptionsChange).toHaveBeenCalledWith(expect.objectContaining({
    jsonData: expect.objectContaining({ search: { filters: [] } }),
  }));
});

test('retains ordinary unconfigured static-filter behavior', async () => {
  const user = userEvent.setup();
  const onOptionsChange = renderTags([], '');
  await user.click(screen.getByRole('button', { name: 'Add dynamic filter' }));
  expect(onOptionsChange).toHaveBeenCalledWith(expect.objectContaining({
    jsonData: expect.objectContaining({ search: { filters: [expect.objectContaining({ value: 'secret' })] } }),
  }));
});
