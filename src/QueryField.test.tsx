import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { CoreApp, type GrafanaTheme, type GrafanaTheme2, toUtc } from '@grafana/data';
import { config, reportInteraction, type TemplateSrv } from '@grafana/runtime';
import { type Themeable } from '@grafana/ui';

import QueryField from './QueryField';
import { createTempoDatasource } from './test/mocks';
import { importKey } from './protectedAttributes/crypto';
import { type TempoQuery } from './types';

jest.mock('@grafana/assistant', () => ({
  QueryWithAssistantButton: () => <div data-testid="query-with-assistant-button" />,
}));

jest.mock('./SearchTraceQLEditor/TraceQLSearch', () => ({
  __esModule: true,
  default: () => <div data-testid="traceql-search-editor" />,
}));

jest.mock('./ServiceGraphSection', () => ({
  ServiceGraphSection: () => <div data-testid="service-graph-section" />,
}));

const mockEditorPendingCallbacks: Array<(pending: boolean) => void> = [];
const mockEditorCommitCallbacks: Array<(query: TempoQuery) => void> = [];

jest.mock('./traceql/QueryEditor', () => ({
  QueryEditor: ({
    onChange,
    onRunQuery,
    onPendingChange,
  }: {
    onChange: (query: TempoQuery) => void;
    onRunQuery: () => void;
    onPendingChange: (pending: boolean) => void;
  }) => {
    mockEditorPendingCallbacks.push(onPendingChange);
    mockEditorCommitCallbacks.push(onChange);
    return (
      <div data-testid="traceql-editor">
        <button
          type="button"
          onClick={() =>
            onChange({
              refId: 'A',
              queryType: 'traceql',
              query: '{span.enc.password="secret"}',
            } as TempoQuery)
          }
        >
          Unsafe host change
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              refId: 'A',
              queryType: 'traceql',
              query: '{span.http.route="public"}',
            } as TempoQuery)
          }
        >
          Ordinary host change
        </button>
        <button type="button" onClick={() => onPendingChange(true)}>
          Start protected seal
        </button>
        <button type="button" onClick={() => onRunQuery()}>
          Run from editor
        </button>
      </div>
    );
  },
}));

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');

  return {
    ...actual,
    Button: ({
      children,
      onClick,
      disabled,
      'aria-label': ariaLabel,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      'aria-label'?: string;
    }) => (
      <button onClick={onClick} disabled={disabled} type="button" aria-label={ariaLabel}>
        {children}
      </button>
    ),
    FileDropzone: ({ onLoad }: { onLoad: (result: string | null) => void }) => (
      <button onClick={() => onLoad('{"trace":"uploaded"}')} type="button">
        Mock file dropzone
      </button>
    ),
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => (
      <input {...props} ref={ref} />
    )),
    InlineField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    InlineFieldRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Modal: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: string }) =>
      isOpen ? (
        <div role="dialog" aria-label={title}>
          {children}
        </div>
      ) : null,
    RadioButtonGroup: ({
      options,
      onChange,
    }: {
      options: Array<{ label?: string; value?: string }>;
      onChange: (value: string) => void;
    }) => (
      <div>
        {options.map((option) => (
          <button key={option.value} onClick={() => option.value && onChange(option.value)} type="button">
            {option.label}
          </button>
        ))}
      </div>
    ),
    Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    withTheme2: (Component: React.ComponentType<Partial<Themeable>>) => (props: Record<string, unknown>) => (
      <Component
        {...props}
        theme={
          {
            spacing: (value: number) => `${value * 8}px`,
          } as unknown as GrafanaTheme2 & GrafanaTheme
        }
      />
    ),
  };
});

const mockedReportInteraction = jest.mocked(reportInteraction);

const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const kid = '630dcd2966c4336691125448bbb25b4f';
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

afterAll(() => {
  if (originalCrypto) {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  } else {
    Reflect.deleteProperty(globalThis, 'crypto');
  }
});

describe('QueryField', () => {
  const range = {
    from: toUtc('2024-01-01T00:00:00Z'),
    to: toUtc('2024-01-01T01:00:00Z'),
    raw: {
      from: toUtc('2024-01-01T00:00:00Z'),
      to: toUtc('2024-01-01T01:00:00Z'),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEditorPendingCallbacks.length = 0;
    mockEditorCommitCallbacks.length = 0;
    config.featureToggles.queryWithAssistant = true;
    config.buildInfo.version = '11.0.0';
  });

  function renderQueryField(
    overrides: Partial<React.ComponentProps<typeof QueryField>> = {},
    nativeHistograms = false
  ) {
    const datasource = createTempoDatasource({} as unknown as TemplateSrv);
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(nativeHistograms);

    const props = {
      app: CoreApp.Explore,
      datasource,
      onBlur: jest.fn(),
      onChange: jest.fn(),
      onRunQuery: jest.fn(),
      query: { refId: 'A', queryType: 'traceql' } as TempoQuery,
      range,
      ...overrides,
    };

    return {
      ...render(<QueryField {...props} />),
      datasource,
      props,
    };
  }

  it('sets the default query type on mount when it is missing', async () => {
    const onChange = jest.fn();

    const { datasource } = renderQueryField({
      onChange,
      query: { refId: 'A' } as TempoQuery,
    });

    await waitFor(() => expect(datasource.getNativeHistograms).toHaveBeenCalledWith(range));

    expect(onChange).toHaveBeenNthCalledWith(1, { refId: 'A', queryType: 'traceql' });
    expect(onChange).toHaveBeenNthCalledWith(2, { refId: 'A', serviceMapUseNativeHistograms: false });
  });

  it('runs the query when a service graph query migrates to native histograms', async () => {
    const onRunQuery = jest.fn();
    const query = { refId: 'A', queryType: 'serviceMap' } as TempoQuery;

    renderQueryField(
      {
        onRunQuery,
        query,
      },
      true
    );

    await waitFor(() => expect(onRunQuery).toHaveBeenCalled());
  });

  it('clears results, updates the query type, and reports the interaction when switching query type', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onRunQuery = jest.fn();

    renderQueryField({
      onChange,
      onRunQuery,
      query: { refId: 'A', queryType: 'traceql' } as TempoQuery,
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ refId: 'A', queryType: 'traceql', serviceMapUseNativeHistograms: false })
    );
    onChange.mockClear();
    onRunQuery.mockClear();

    await user.click(screen.getByRole('button', { name: 'Service Graph' }));

    expect(onChange).toHaveBeenNthCalledWith(1, { refId: 'A', queryType: 'clear' });
    expect(onRunQuery).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenNthCalledWith(2, { refId: 'A', queryType: 'serviceMap' });
    expect(mockedReportInteraction).toHaveBeenCalledWith('grafana_traces_query_type_changed', {
      datasourceType: 'tempo',
      app: CoreApp.Explore,
      grafana_version: '11.0.0',
      newQueryType: 'serviceMap',
      previousQueryType: 'traceql',
    });
  });

  it('shows the assistant button only in supported apps', () => {
    const { rerender } = renderQueryField({ app: CoreApp.Explore });

    expect(screen.getByTestId('query-with-assistant-button')).toBeInTheDocument();

    rerender(
      <QueryField
        app={CoreApp.UnifiedAlerting}
        datasource={createTempoDatasource({} as unknown as TemplateSrv)}
        onBlur={jest.fn()}
        onChange={jest.fn()}
        onRunQuery={jest.fn()}
        query={{ refId: 'A', queryType: 'traceql' } as TempoQuery}
        range={range}
      />
    );

    expect(screen.queryByTestId('query-with-assistant-button')).not.toBeInTheDocument();
  });

  it('does not show the assistant button when the feature toggle is disabled', () => {
    config.featureToggles.queryWithAssistant = false;

    renderQueryField({ app: CoreApp.Explore });

    expect(screen.queryByTestId('query-with-assistant-button')).not.toBeInTheDocument();
  });

  it('uploads a trace, switches to upload mode, and runs the query', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onRunQuery = jest.fn();
    const query = { refId: 'A', queryType: 'traceql' } as TempoQuery;

    const { datasource } = renderQueryField({
      onChange,
      onRunQuery,
      query,
    });

    await user.click(screen.getByRole('button', { name: 'Import trace' }));
    await user.click(screen.getByRole('button', { name: 'Mock file dropzone' }));

    expect(datasource.uploadedJson).toBe('{"trace":"uploaded"}');
    expect(onChange).toHaveBeenLastCalledWith({ refId: 'A', queryType: 'upload' });
    expect(onRunQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects protected plaintext at every parent host callback and blocks a pending run', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onRunQuery = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource, onChange, onRunQuery });
    await waitFor(() => expect(datasource.getNativeHistograms).toHaveBeenCalled());
    onChange.mockClear();

    await user.click(screen.getByRole('button', { name: 'Unsafe host change' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Ordinary host change' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ query: '{span.http.route="public"}' }));
    await user.click(screen.getByRole('button', { name: 'Start protected seal' }));
    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'Service Graph' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Run from editor' }));
    expect(onRunQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('secret');
    expect(screen.queryByTestId('query-with-assistant-button')).not.toBeInTheDocument();
  });

  it('blocks the outer run while an ordinary partial draft remains browser-local', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onRunQuery = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({
      datasource,
      query: { refId: 'A', queryType: 'traceql', query: '{span.http.route="old"}', filters: [] },
      onChange,
      onRunQuery,
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    onChange.mockClear();
    act(() => {
      mockEditorPendingCallbacks[mockEditorPendingCallbacks.length - 1](true);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run from editor' }));
    expect(onRunQuery).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Complete or correct the query before running it');
  });

  it('clears protected predicate key choices before changing query type without releasing a plaintext draft', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const sealed = await (await importKey(master)).sealQueryModel(
      '{span.enc.password="secret"}',
      JSON.stringify(['tempo-uid', 'query'])
    );
    const query = {
      refId: 'A',
      queryType: 'traceql' as const,
      query: sealed,
      filters: [],
      protectedQueryKeys: [{ predicate: JSON.stringify([1, 20, 'enc.password', '=']), kid }],
    };
    const mounted = renderQueryField({ datasource, query, onChange });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    mounted.rerender(<QueryField {...mounted.props} query={onChange.mock.lastCall![0]} />);
    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'Service Graph' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ queryType: 'clear', query: sealed }));
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('protectedQueryKeys');
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('secret');
  });

  it('loads a browser key without configured fingerprint, rejects invalid bytes without replacing it, and never writes key material to host models', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource, onChange });

    expect(screen.getByRole('status')).toHaveTextContent('No keys loaded');
    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    const importDialog = screen.getByRole('dialog', { name: 'Load keys' });
    expect(importDialog).not.toHaveTextContent('Required key ID');
    expect(importDialog).toHaveTextContent('Only in this browser session');
    expect(importDialog).toHaveTextContent('Keys stay in browser memory and are not sent to Grafana, Tempo, or Loki. Reloading clears this session’s keys.');
    await user.type(screen.getByLabelText('Paste base64 key'), master);
    await user.click(within(importDialog).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 key loaded'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const previousKey = datasource.protectedKey;
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getByRole('button', { name: 'Add keys' }));
    await user.type(screen.getByLabelText('Paste base64 key'), 'not-valid-base64');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to import key'));
    expect(datasource.protectedKey).toBe(previousKey);
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');

    const fileMaster = Buffer.alloc(32, 7).toString('base64');
    const fileKid = (await importKey(fileMaster)).kid;
    const file = new File([fileMaster], 'key.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'text', { value: async () => fileMaster });
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    expect(screen.getByText('No files selected')).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Protected key file'), file);
    expect(screen.getByText('1 file(s) selected')).toBeInTheDocument();
    expect(screen.getByText('key.txt')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([kid, fileKid]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(master);
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(fileMaster);
  });

  it('imports two pasted keys in one action through masked fields and keeps raw keys out of host models', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource, onChange });
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKid = (await importKey(otherMaster)).kid;

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    const firstInput = screen.getByLabelText('Paste base64 key');
    expect(firstInput).toHaveAttribute('type', 'password');
    fireEvent.paste(firstInput, { clipboardData: { getData: () => `${master}\n${otherMaster}` } });
    expect(screen.getByLabelText('Paste base64 key 2')).toHaveAttribute('type', 'password');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));

    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([kid, otherKid]));
    expect(screen.getByRole('status')).toHaveTextContent('2 keys loaded');
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(screen.getByRole('button', { name: `Forget key ${kid}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Forget key ${otherKid}` })).toBeInTheDocument();
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(master);
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(otherMaster);
  });

  it('rejects a later invalid pasted key without changing existing keys or exposing supplied values', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const original = datasource.protectedKey;
    renderQueryField({ datasource });
    const otherMaster = Buffer.alloc(32, 7).toString('base64');

    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getByRole('button', { name: 'Add keys' }));
    await user.type(screen.getByLabelText('Paste base64 key'), otherMaster);
    await user.click(screen.getByRole('button', { name: 'Add another key' }));
    await user.type(screen.getByLabelText('Paste base64 key 2'), 'not-a-key');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to import key'));
    expect(datasource.protectedKeys).toEqual([original]);
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');
    expect(screen.queryByLabelText('Paste base64 key 2')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('not-a-key');
    expect(screen.getByRole('alert')).not.toHaveTextContent(otherMaster);
  });

  it('loads multiple local files in one action and clears file selections on completion', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource });
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKid = (await importKey(otherMaster)).kid;
    const first = new File([master], 'first.key', { type: 'text/plain' });
    const second = new File([otherMaster], 'second.key', { type: 'text/plain' });
    Object.defineProperty(first, 'text', { value: async () => master });
    Object.defineProperty(second, 'text', { value: async () => otherMaster });

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    await user.upload(screen.getByLabelText('Protected key file'), [first, second]);
    expect(screen.getByText('2 file(s) selected')).toBeInTheDocument();
    expect(screen.getByText('first.key, second.key')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([kid, otherKid]));
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getByRole('button', { name: 'Add keys' }));
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');
  });

  it('rejects an oversized file before reading any selected file or importing a partial batch', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource });
    const small = new File([master], 'small.key', { type: 'text/plain' });
    const large = new File(['x'.repeat(64 * 1024 + 1)], 'large.key', { type: 'text/plain' });
    const readSmall = jest.fn(async () => master);
    const readLarge = jest.fn(async () => master);
    Object.defineProperty(small, 'text', { value: readSmall });
    Object.defineProperty(large, 'text', { value: readLarge });

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    await user.upload(screen.getByLabelText('Protected key file'), [small, large]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(readSmall).not.toHaveBeenCalled();
    expect(readLarge).not.toHaveBeenCalled();
    expect(datasource.protectedKeys).toEqual([]);
    expect(screen.getByText('No files selected')).toBeInTheDocument();
  });

  it('keeps pasted and file keys exclusive and cancel discards the unsent key', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource });

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Paste a base64 key or choose a local key file.');
    await user.type(screen.getByLabelText('Paste base64 key'), 'wrong');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const file = new File([master], 'key.txt', { type: 'text/plain' });
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    await user.upload(screen.getByLabelText('Protected key file'), file);
    await user.click(screen.getByRole('button', { name: 'Paste keys' }));
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');
    await user.type(screen.getByLabelText('Paste base64 key'), 'wrong-again');
    expect(screen.queryByText('key.txt')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(datasource.protectedKey).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');
    expect(screen.queryByText('key.txt')).not.toBeInTheDocument();
  });

  it('cancels an in-flight file read without installing keys or clearing a later import', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    const importSpy = jest.spyOn(datasource, 'importProtectedKeys');
    renderQueryField({ datasource });
    let completeRead!: (value: string) => void;
    const file = new File([master], 'slow.key', { type: 'text/plain' });
    Object.defineProperty(file, 'text', {
      value: () => new Promise<string>((resolve) => { completeRead = resolve; }),
    });

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    await user.upload(screen.getByLabelText('Protected key file'), file);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.type(screen.getByLabelText('Paste base64 key'), master);
    await act(async () => { completeRead(master); });
    expect(importSpy).not.toHaveBeenCalled();
    expect(datasource.protectedKeys).toEqual([]);
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue(master);
    expect(screen.queryByText('slow.key')).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([kid]));
  });

  it('does not automatically reopen key import after the last key is forgotten', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const onChange = jest.fn();
    renderQueryField({ datasource, onChange });

    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getByRole('button', { name: `Forget key ${kid}` }));
    expect(datasource.protectedKey).toBeUndefined();
    expect(screen.queryByRole('dialog', { name: 'Load keys' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.type(screen.getByLabelText('Paste base64 key'), master);
    await user.click(within(screen.getByRole('dialog', { name: 'Load keys' })).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKey?.kid).toBe(kid));
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(master);
  });

  it('lists each imported key ID and forgets only the selected key', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const otherKid = await datasource.importProtectedKey(Buffer.alloc(32, 7).toString('base64'));
    renderQueryField({ datasource });
    expect(screen.getByRole('status')).toHaveTextContent('2 keys loaded');
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(screen.getByText(kid)).toBeInTheDocument();
    expect(screen.getByText(otherKid)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Forget key ${kid}` }));
    expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([otherKid]);
    expect(screen.queryByText(kid)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    expect(datasource.protectedKeys).toEqual([]);
  });

  it('notifies mounted editors on key clear without rendering a separate protected-values pane', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const sealed = await (
      await importKey(master)
    ).sealQueryModel('{span.enc.password="secret"}', JSON.stringify(['tempo-uid', 'query']));
    const query = { refId: 'A', queryType: 'traceql', query: sealed } as TempoQuery;
    const rendered = renderQueryField({ datasource, query });
    const second = renderQueryField({ datasource, query });
    const originalEditors = screen.getAllByTestId('traceql-editor');
    expect(screen.queryByRole('region', { name: 'Protected span attributes' })).not.toBeInTheDocument();

    await user.click(within(rendered.container).getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getAllByRole('button', { name: `Forget key ${kid}` })[0]);
    const nextEditors = screen.getAllByTestId('traceql-editor');
    expect(nextEditors[0]).not.toBe(originalEditors[0]);
    expect(nextEditors[1]).not.toBe(originalEditors[1]);
    expect(second.container).toHaveTextContent('No keys loaded');
    expect(screen.queryByRole('region', { name: 'Protected span attributes' })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Run from editor' })[1]);
    expect(second.props.onRunQuery).not.toHaveBeenCalled();
  });

  it('does not let a late native histogram callback overwrite a sealed editor commit before host acknowledgement', async () => {
    let completeNative!: (enabled: boolean) => void;
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          completeNative = resolve;
        })
    );
    const onChange = jest.fn();
    const query = { refId: 'A', queryType: 'traceql' } as TempoQuery;
    renderQueryField({ datasource, query, onChange });
    const sealed = await (
      await importKey(master)
    ).sealQueryModel('{span.enc.password="secret"}', JSON.stringify(['tempo-uid', 'query']));
    const pending = mockEditorPendingCallbacks[mockEditorPendingCallbacks.length - 1];
    const commit = mockEditorCommitCallbacks[mockEditorCommitCallbacks.length - 1];
    act(() => {
      pending(true);
      commit({ ...query, query: sealed });
      pending(false);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(async () => {
      completeNative(false);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ query: sealed }));
  });

  it('ignores stale pending completion after a key epoch remount', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const onChange = jest.fn();
    const mounted = renderQueryField({ datasource, onChange });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const accepted = onChange.mock.lastCall![0] as TempoQuery;
    mounted.rerender(<QueryField {...mounted.props} query={accepted} />);
    onChange.mockClear();
    const stalePending = mockEditorPendingCallbacks[0];
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    await user.click(screen.getByRole('button', { name: `Forget key ${kid}` }));
    const currentPending = mockEditorPendingCallbacks[mockEditorPendingCallbacks.length - 1];
    expect(currentPending).not.toBe(stalePending);
    act(() => {
      currentPending(true);
      stalePending(false);
    });
    await user.click(screen.getByRole('button', { name: 'Service Graph' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('discards a deferred file read when another editor forgets the shared key', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    await datasource.importProtectedKey(master);
    const importSpy = jest.spyOn(datasource, 'importProtectedKeys');
    const pendingEditor = renderQueryField({ datasource });
    const forgetter = renderQueryField({ datasource });
    let completeRead!: (value: string) => void;
    const file = new File([master], 'key.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          completeRead = resolve;
        }),
    });
    await user.click(within(pendingEditor.container).getByRole('button', { name: 'Manage keys' }));
    await user.click(within(pendingEditor.container).getByRole('button', { name: 'Add keys' }));
    await user.click(within(pendingEditor.container).getByRole('button', { name: 'Import files' }));
    await user.upload(within(pendingEditor.container).getByLabelText('Protected key file'), file);
    await user.click(within(pendingEditor.container).getByRole('button', { name: 'Add keys' }));
    expect(within(pendingEditor.container).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(within(forgetter.container).getByRole('button', { name: 'Manage keys' }));
    await user.click(within(forgetter.container).getByRole('button', { name: `Forget key ${kid}` }));
    await act(async () => {
      completeRead(master);
    });
    expect(importSpy).not.toHaveBeenCalled();
    expect(datasource.protectedKey).toBeUndefined();
    expect(within(pendingEditor.container).queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(forgetter.container).getByRole('dialog', { name: 'Session keys' })).toBeInTheDocument();
    expect(within(forgetter.container).queryByRole('dialog', { name: 'Load keys' })).not.toBeInTheDocument();
  });
  it('discards a pending file read when the mounted editor changes datasource', async () => {
    const user = userEvent.setup();
    const oldDatasource = createTempoDatasource(
      {},
      { uid: 'tempo-old', jsonData: { protectedAttributesEnabled: true } }
    );
    const newDatasource = createTempoDatasource(
      {},
      { uid: 'tempo-new', jsonData: { protectedAttributesEnabled: true } }
    );
    jest.spyOn(oldDatasource, 'getNativeHistograms').mockResolvedValue(false);
    jest.spyOn(newDatasource, 'getNativeHistograms').mockResolvedValue(false);
    const importSpy = jest.spyOn(oldDatasource, 'importProtectedKeys');
    const mounted = renderQueryField({ datasource: oldDatasource });
    let completeRead!: (value: string) => void;
    const file = new File([master], 'old.key', { type: 'text/plain' });
    Object.defineProperty(file, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          completeRead = resolve;
        }),
    });
    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.click(screen.getByRole('button', { name: 'Import files' }));
    await user.upload(screen.getByLabelText('Protected key file'), file);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    mounted.rerender(<QueryField {...mounted.props} datasource={newDatasource} />);
    await act(async () => {
      completeRead(master);
    });
    expect(importSpy).not.toHaveBeenCalled();
    expect(oldDatasource.protectedKeys).toEqual([]);
    expect(newDatasource.protectedKeys).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    expect(screen.getByLabelText('Paste base64 key')).toHaveValue('');
  });

  it('opens one mounted editor for a matching-key request, rejects mismatches atomically, and unregisters on unmount', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKid = (await importKey(otherMaster)).kid;
    await datasource.importProtectedKey(otherMaster);
    const first = renderQueryField({ datasource });
    const second = renderQueryField({ datasource });
    const bridge = (globalThis as unknown as Record<symbol, { requestKey(kid: string): boolean }>)[
      Symbol.for('grafana.tempo.protected-attribute-display.v1')
    ];
    expect(bridge.requestKey('invalid')).toBe(false);
    act(() => expect(bridge.requestKey(kid)).toBe(true));
    expect(within(second.container).getByRole('dialog', { name: 'Load matching key' })).toHaveTextContent(kid);
    expect(within(first.container).queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(within(second.container).getByLabelText('Paste base64 key'), otherMaster);
    await user.click(within(second.container).getByRole('button', { name: 'Add another key' }));
    await user.type(within(second.container).getByLabelText('Paste base64 key 2'), otherMaster);
    await user.click(within(second.container).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(within(second.container).getByRole('alert')).toHaveTextContent('does not match'));
    expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([otherKid]);
    second.unmount();
    act(() => expect(bridge.requestKey(kid)).toBe(true));
    expect(within(first.container).getByRole('dialog', { name: 'Load matching key' })).toHaveTextContent(kid);
    first.unmount();
    expect(bridge.requestKey(kid)).toBe(false);
  });

  it('imports a batch containing the requested key and another valid key', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource });
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKid = (await importKey(otherMaster)).kid;
    const bridge = (globalThis as unknown as Record<symbol, { requestKey(kid: string): boolean }>)[
      Symbol.for('grafana.tempo.protected-attribute-display.v1')
    ];
    act(() => expect(bridge.requestKey(kid)).toBe(true));
    await user.type(screen.getByLabelText('Paste base64 key'), otherMaster);
    await user.click(screen.getByRole('button', { name: 'Add another key' }));
    await user.type(screen.getByLabelText('Paste base64 key 2'), master);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([otherKid, kid]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a local key name only in the mounted manager and removes it when forgotten', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource, onChange });
    const originalEditor = screen.getByTestId('traceql-editor');
    await user.click(screen.getByRole('button', { name: 'Load keys' }));
    await user.type(screen.getByLabelText('Paste base64 key'), master);
    await user.type(screen.getByLabelText('Local name (optional)'), 'Private session label');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKey?.kid).toBe(kid));
    expect(screen.getByTestId('traceql-editor')).not.toBe(originalEditor);
    await user.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(screen.getByText(/Private session label/)).toBeInTheDocument();
    expect(screen.getByText(kid)).toBeInTheDocument();
    expect(JSON.stringify(datasource.instanceSettings.jsonData)).not.toContain('Private session label');
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('Private session label');
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(master);
    await user.click(screen.getByRole('button', { name: `Forget key ${kid}` }));
    expect(screen.queryByText(/Private session label/)).not.toBeInTheDocument();
    expect(screen.queryByText(master)).not.toBeInTheDocument();
    expect(screen.queryByText('Use demo key')).not.toBeInTheDocument();
  });

  it('loads the requested key when no key was previously loaded', async () => {
    const user = userEvent.setup();
    const datasource = createTempoDatasource({}, { uid: 'tempo-uid', jsonData: { protectedAttributesEnabled: true } });
    jest.spyOn(datasource, 'getNativeHistograms').mockResolvedValue(false);
    renderQueryField({ datasource });
    const bridge = (globalThis as unknown as Record<symbol, { requestKey(kid: string): boolean }>)[
      Symbol.for('grafana.tempo.protected-attribute-display.v1')
    ];
    act(() => expect(bridge.requestKey(kid)).toBe(true));
    expect(screen.getByRole('dialog', { name: 'Load matching key' })).toHaveTextContent(kid);
    await user.type(screen.getByLabelText('Paste base64 key'), master);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add keys' }));
    await waitFor(() => expect(datasource.protectedKeys.map((key) => key.kid)).toEqual([kid]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
