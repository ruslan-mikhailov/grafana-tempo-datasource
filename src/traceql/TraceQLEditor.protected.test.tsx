import type * as GrafanaUI from '@grafana/ui';
import type * as ReactType from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { type TempoDatasource } from '../datasource';
import { type TempoQuery } from '../types';

import { TraceQLEditor } from './TraceQLEditor';

// Monaco registers the first onChange closure when mounted. Preserve that
// behavior so the test fails if unlocking merely replaces a React callback.
jest.mock('@grafana/ui', () => {
  const ui = jest.requireActual<typeof GrafanaUI>('@grafana/ui');
  const React = jest.requireActual<typeof ReactType>('react');
  return {
    ...ui,
    CodeEditor: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly?: boolean }) => {
      const firstChange = React.useRef(onChange);
      return React.createElement('textarea', {
        'aria-label': 'raw traceql',
        value,
        readOnly,
        onChange: (event: ReactType.ChangeEvent<HTMLTextAreaElement>) => firstChange.current(event.target.value),
      });
    },
  };
});

const kid = '630dcd2966c4336691125448bbb25b4f';

test('unlocking Monaco keeps its initial handler current and host receives only authenticated model envelopes', async () => {
  const saved = `qenc:v1:${kid}:${'A'.repeat(40)}`;
  const next = `qenc:v1:${kid}:${'B'.repeat(40)}`;
  const key = {
    kid,
    openQueryModel: jest.fn().mockResolvedValue('{span.enc.password="old"}'),
    sealQueryModel: jest.fn().mockResolvedValue(next),
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: key,
    instanceSettings: { jsonData: { protectedKeyId: kid } },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      shouldRefreshLabels: () => false,
    },
  } as unknown as TempoDatasource;
  const query: TempoQuery = { refId: 'A', queryType: 'traceql', query: saved, filters: [] };
  const hostChange = jest.fn();
  const pending = jest.fn();
  render(<TraceQLEditor placeholder="TraceQL" query={query} datasource={datasource}
    onChange={hostChange} onRunQuery={() => {}} onPendingChange={pending} />);
  const editor = screen.getByRole('textbox', { name: 'raw traceql' });
  expect(editor).toHaveAttribute('readonly');
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  fireEvent.change(editor, { target: { value: '{span.enc.password="new"}' } });
  expect(hostChange).not.toHaveBeenCalled();
  await waitFor(() => expect(hostChange).toHaveBeenCalledTimes(1));
  expect(hostChange.mock.calls[0][0].query).toBe(next);
  expect(key.sealQueryModel).toHaveBeenCalledWith('{span.enc.password="new"}', JSON.stringify(['tempo-uid', 'query']));
  expect(pending).toHaveBeenCalledWith(true);
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(query.query).toBe(saved);
});
