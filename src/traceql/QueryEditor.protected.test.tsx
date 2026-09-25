import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TraceqlSearchScope } from '../dataquery';
import { type TempoDatasource } from '../datasource';
import { type TempoQuery } from '../types';

import { QueryEditor } from './QueryEditor';

jest.mock('./TraceQLEditor', () => ({
  TraceQLEditor: ({ onPendingChange }: { onPendingChange: (pending: boolean) => void }) =>
    <button onClick={() => onPendingChange(true)}>Edit raw draft</button>,
}));
jest.mock('./TempoQueryBuilderOptions', () => ({ TempoQueryBuilderOptions: () => null }));

const kid = '630dcd2966c4336691125448bbb25b4f';

test('a newer raw draft cancels an in-flight Search-to-TraceQL copy before host onChange', async () => {
  let resolveOpen!: (value: string) => void;
  const opened = new Promise<string>((resolve) => { resolveOpen = resolve; });
  const key = {
    kid,
    openQueryModel: jest.fn().mockReturnValue(opened),
    sealQueryModel: jest.fn().mockResolvedValue(`qenc:v1:${kid}:${'B'.repeat(40)}`),
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: key,
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { generateQueryFromFilters: jest.fn().mockReturnValue('{span.enc.password="old"}') },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  const query: TempoQuery = {
    refId: 'A', queryType: 'traceql', query: '{}',
    filters: [{ id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: `qenc:v1:${kid}:${'A'.repeat(40)}` }],
  };
  const hostChange = jest.fn();
  const clear = jest.fn();
  render(<QueryEditor datasource={datasource} query={query} onChange={hostChange} onRunQuery={() => {}}
    onClearResults={clear} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy query from Search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit raw draft' }));
  await act(async () => { resolveOpen('old'); });
  expect(key.sealQueryModel).toHaveBeenCalledWith('{span.enc.password=\"old\"}', JSON.stringify(['tempo-uid', 'query']));
  expect(hostChange).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

test('successful protected copy releases the pending gate before clearing results and only emits sealed source/target', async () => {
  const originalEnvelope = `qenc:v1:${kid}:${'A'.repeat(40)}`;
  const nextEnvelope = `qenc:v1:${kid}:${'B'.repeat(40)}`;
  const key = {
    kid,
    openQueryModel: jest.fn().mockResolvedValue('abc'),
    sealQueryModel: jest.fn().mockResolvedValue(nextEnvelope),
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: key,
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { generateQueryFromFilters: jest.fn().mockReturnValue('{span.enc.password=\"abc\"}') },
    isStreamingSearchEnabled: () => false,
    isStreamingMetricsEnabled: () => false,
  } as unknown as TempoDatasource;
  const query: TempoQuery = {
    refId: 'A', queryType: 'traceql', query: '{}',
    filters: [{ id: 'password', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: originalEnvelope }],
  };
  let blocked = false;
  const onPendingChange = jest.fn((pending: boolean) => { blocked = pending; });
  const clear = jest.fn(() => { expect(blocked).toBe(false); });
  const hostChange = jest.fn();
  render(<QueryEditor datasource={datasource} query={query} onChange={hostChange} onRunQuery={() => {}}
    onClearResults={clear} onPendingChange={onPendingChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy query from Search' }));
  await waitFor(() => expect(hostChange).toHaveBeenCalledTimes(1));
  expect(clear).toHaveBeenCalledTimes(1);
  expect(hostChange.mock.calls[0][0].query).toBe(nextEnvelope);
  expect(hostChange.mock.calls[0][0].filters[0].value).toBe(originalEnvelope);
  expect(query.query).toBe('{}');
});
