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
    CodeEditor: ({
      value,
      onChange,
      readOnly,
    }: {
      value: string;
      onChange: (value: string) => void;
      readOnly?: boolean;
    }) => {
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
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: {
      start: jest.fn().mockResolvedValue(undefined),
      shouldRefreshLabels: () => false,
    },
  } as unknown as TempoDatasource;
  const query: TempoQuery = { refId: 'A', queryType: 'traceql', query: saved, filters: [] };
  const hostChange = jest.fn();
  const pending = jest.fn();
  render(
    <TraceQLEditor
      placeholder="TraceQL"
      query={query}
      datasource={datasource}
      onChange={hostChange}
      onRunQuery={() => {}}
      onPendingChange={pending}
    />
  );
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

test('keeps a sealed query locked without a key or with a different imported key ID', async () => {
  const saved = `qenc:v1:${kid}:${'A'.repeat(40)}`;
  const query: TempoQuery = { refId: 'A', queryType: 'traceql', query: saved, filters: [] };
  const datasource = {
    uid: 'tempo-uid',
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { start: jest.fn().mockResolvedValue(undefined), shouldRefreshLabels: () => false },
  } as unknown as TempoDatasource;
  const hostChange = jest.fn();
  const props = { placeholder: 'TraceQL', query, datasource, onChange: hostChange, onRunQuery: jest.fn() };
  const view = render(<TraceQLEditor {...props} />);
  const editor = screen.getByRole('textbox', { name: 'raw traceql' });
  expect(editor).toHaveAttribute('readonly');
  expect(editor).toHaveValue('');

  const wrongKey = { kid: '00000000000000000000000000000000', openQueryModel: jest.fn() };
  Object.defineProperty(datasource, 'protectedKey', { value: wrongKey, configurable: true });
  view.rerender(<TraceQLEditor {...props} />);
  expect(editor).toHaveAttribute('readonly');
  expect(wrongKey.openQueryModel).not.toHaveBeenCalled();
  expect(hostChange).not.toHaveBeenCalled();

  const matchingKey = { kid, openQueryModel: jest.fn().mockResolvedValue('{span.enc.password="old"}') };
  Object.defineProperty(datasource, 'protectedKey', { value: matchingKey, configurable: true });
  view.rerender(<TraceQLEditor {...props} />);
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  expect(editor).toHaveValue('{span.enc.password="old"}');
  expect(hostChange).not.toHaveBeenCalled();
});

test('opens a saved model with its own key while a different key remains active for new seals', async () => {
  const saved = `qenc:v1:${kid}:${'A'.repeat(40)}`;
  const old = { kid, openQueryModel: jest.fn().mockResolvedValue('{span.enc.password="old"}') };
  const active = {
    kid: '00000000000000000000000000000000',
    sealQueryModel: jest.fn().mockResolvedValue(`qenc:v1:${'0'.repeat(32)}:${'B'.repeat(40)}`),
  };
  const datasource = {
    uid: 'tempo-uid',
    protectedKey: active,
    protectedKeys: [old, active],
    getProtectedKey: (id: string) => (id === kid ? old : active),
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { start: jest.fn().mockResolvedValue(undefined), shouldRefreshLabels: () => false },
  } as unknown as TempoDatasource;
  const hostChange = jest.fn();
  render(
    <TraceQLEditor
      placeholder="TraceQL"
      query={{ refId: 'A', queryType: 'traceql', query: saved, filters: [] }}
      datasource={datasource}
      onChange={hostChange}
      onRunQuery={jest.fn()}
    />
  );
  const editor = screen.getByRole('textbox', { name: 'raw traceql' });
  await waitFor(() => expect(editor).toHaveValue('{span.enc.password="old"}'));
  fireEvent.change(editor, { target: { value: '{span.enc.password="new"}' } });
  await waitFor(() =>
    expect(hostChange).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining(`qenc:v1:${active.kid}:`) })
    )
  );
  expect(old.openQueryModel).toHaveBeenCalledWith(saved, JSON.stringify(['tempo-uid', 'query']));
});

test('allows ordinary raw edits without an imported key but rejects protected plaintext', async () => {
  const datasource = {
    uid: 'tempo-uid',
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { start: jest.fn().mockResolvedValue(undefined), shouldRefreshLabels: () => false },
  } as unknown as TempoDatasource;
  const query: TempoQuery = { refId: 'A', queryType: 'traceql', query: '{span.http.route="old"}', filters: [] };
  const hostChange = jest.fn();
  render(
    <TraceQLEditor
      placeholder="TraceQL"
      query={query}
      datasource={datasource}
      onChange={hostChange}
      onRunQuery={jest.fn()}
    />
  );
  const editor = screen.getByRole('textbox', { name: 'raw traceql' });
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  fireEvent.change(editor, { target: { value: '{span.http.route="new"}' } });
  expect(hostChange).toHaveBeenCalledWith(expect.objectContaining({ query: '{span.http.route="new"}' }));
  hostChange.mockClear();
  fireEvent.change(editor, { target: { value: '{span.enc.password="secret"}' } });
  expect(hostChange).not.toHaveBeenCalled();
});

test('keyless raw ciphertext remains editable without persisting plaintext', async () => {
  const ciphertext = 'enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ';
  const raw = `{span.enc.password="${ciphertext}"}`;
  const datasource = {
    uid: 'tempo-uid',
    instanceSettings: { jsonData: { protectedAttributesEnabled: true } },
    languageProvider: { start: jest.fn().mockResolvedValue(undefined), shouldRefreshLabels: () => false },
  } as unknown as TempoDatasource;
  const hostChange = jest.fn();
  render(
    <TraceQLEditor
      placeholder="TraceQL"
      query={{ refId: 'A', queryType: 'traceql', query: raw, filters: [] }}
      datasource={datasource}
      onChange={hostChange}
      onRunQuery={jest.fn()}
    />
  );
  const editor = screen.getByRole('textbox', { name: 'raw traceql' });
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  expect(editor).toHaveValue(raw);
  fireEvent.change(editor, { target: { value: raw.replace('=', '!=') } });
  expect(hostChange).toHaveBeenCalledWith(expect.objectContaining({ query: raw.replace('=', '!=') }));
});
