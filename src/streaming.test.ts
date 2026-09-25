import { type DataQueryRequest, type DataSourceInstanceSettings, LoadingState } from '@grafana/data';
import { getGrafanaLiveSrv } from '@grafana/runtime';
import { firstValueFrom, merge, of, toArray } from 'rxjs';

import { SearchStreamingState, SearchTableType } from './dataquery';
import { type TempoDatasource } from './datasource';
import { type ProtectedAttributeKey } from './protectedAttributes/crypto';
import { ProtectedValuesStore, type ProtectedDisplayEntry } from './protectedAttributes/decrypt';
import { doTempoMetricsStreaming, doTempoSearchStreaming } from './streaming';
import { type TempoJsonData, type TempoQuery } from './types';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getGrafanaLiveSrv: jest.fn(),
}));

const envelope = 'enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ';
const settings = { uid: 'tempo', name: 'Tempo' } as DataSourceInstanceSettings<TempoJsonData>;
const options = { range: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-01T01:00:00Z') } } as unknown as DataQueryRequest<TempoQuery>;

function message(result: unknown, state: SearchStreamingState) {
  return { message: { schema: { fields: [
    { name: 'result', type: 'other' },
    { name: 'metrics', type: 'other' },
    { name: 'state', type: 'string' },
    { name: 'error', type: 'string' },
  ] }, data: { values: [[result], [{ completedJobs: 1, totalJobs: 2 }], [state], ['']] } } };
}

test('Live progress and Done normalize nullish results, preserve ordered ciphertext frames and clear only their refId', async () => {
  const key = { decrypt: jest.fn(() => 'abc') } as unknown as ProtectedAttributeKey;
  const store = new ProtectedValuesStore(() => 1);
  const snapshots: Array<readonly ProtectedDisplayEntry[]> = [];
  store.subscribe((entries) => snapshots.push(entries));
  const token = store.beginRequest();
  const other = { traceID: 'other', spanID: 'other-span', storedField: 'enc.password', value: 'another', status: 'decrypted' } as const;
  store.replace('B', [other], 1, token);
  const ds = { uid: 'tempo', protectedKey: key, protectedKeyEpoch: 1, protectedValues: store } as TempoDatasource;
  const traces = [{ traceID: 'trace', rootServiceName: 'svc', rootTraceName: 'op', spanSet: { spans: [{ spanID: 'span', attributes: [{ key: 'enc.password', value: { stringValue: envelope } }] }] } }];
  const getStream = jest.fn(() => of(message(traces, SearchStreamingState.Streaming), message(null, SearchStreamingState.Done)));
  jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream } as never);
  const query = { refId: 'A', tableType: SearchTableType.Raw } as TempoQuery;

  const responses = await firstValueFrom(doTempoSearchStreaming(query, ds, options, settings, token).pipe(toArray()));
  expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
  expect(responses.every((response) => response.key === 'A' && response.data.every((frame) => frame.refId === 'A'))).toBe(true);
  expect(JSON.stringify(responses[0].data)).toContain(envelope);
  expect(JSON.stringify(responses)).not.toContain('"value":"abc"');
  expect(responses[1].data[0].fields[0].values[0]).toBe('[]');
  expect(snapshots).toContainEqual([
    { traceID: 'trace', spanID: 'span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    other,
  ]);
  expect(store.snapshot()).toEqual([other]);
  expect(traces[0].spanSet.spans[0].attributes[0].value.stringValue).toBe(envelope);
  expect(getStream).toHaveBeenCalledTimes(1);
});

test('missing Live result still emits progress and Done with a metrics frame', async () => {
  const store = new ProtectedValuesStore(() => 1);
  const token = store.beginRequest();
  const ds = { uid: 'tempo', protectedKeyEpoch: 1, protectedValues: store } as TempoDatasource;
  const getStream = jest.fn(() => of(message(undefined, SearchStreamingState.Streaming), message(undefined, SearchStreamingState.Done)));
  jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream } as never);
  const query = { refId: 'A', tableType: SearchTableType.Raw } as TempoQuery;

  const responses = await firstValueFrom(doTempoSearchStreaming(query, ds, options, settings, token).pipe(toArray()));
  expect(responses).toHaveLength(2);
  expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
  expect(responses.map((response) => response.data[0].fields[0].values[0])).toEqual(['[]', '[]']);
  expect(responses.every((response) => response.key === 'A' && response.data.every((frame) => frame.refId === 'A'))).toBe(true);
  expect(store.snapshot()).toEqual([]);
});

test('concurrent Live targets retain separate host packet keys, raw frames, progress frames and pane partitions', async () => {
  const key = { decrypt: jest.fn(() => 'abc') } as unknown as ProtectedAttributeKey;
  const store = new ProtectedValuesStore(() => 1);
  const token = store.beginRequest();
  const ds = { uid: 'tempo', protectedKey: key, protectedKeyEpoch: 1, protectedValues: store } as TempoDatasource;
  const getStream = jest.fn((request: { data: { refId: string } }) => {
    const traceID = `trace-${request.data.refId}`;
    const traces = [{
      traceID,
      rootServiceName: 'svc',
      rootTraceName: 'op',
      spanSet: { spans: [{ spanID: `span-${request.data.refId}`, attributes: [
        { key: 'enc.password', value: { stringValue: envelope } },
      ] }] },
    }];
    return of({}, message(traces, SearchStreamingState.Streaming));
  });
  jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream } as never);
  const a = { refId: 'A', tableType: SearchTableType.Raw } as TempoQuery;
  const b = { refId: 'B', tableType: SearchTableType.Raw } as TempoQuery;

  const packets = await firstValueFrom(merge(
    doTempoSearchStreaming(a, ds, options, settings, token),
    doTempoSearchStreaming(b, ds, options, settings, token)
  ).pipe(toArray()));
  expect(getStream.mock.calls.map(([request]) => request.data.refId)).toEqual(['A', 'B']);
  expect(packets).toHaveLength(4);
  for (const refId of ['A', 'B']) {
    const targetPackets = packets.filter((packet) => packet.key === refId);
    expect(targetPackets).toHaveLength(2);
    expect(targetPackets[0].data).toEqual([]);
    const [raw, progress] = targetPackets[1].data;
    expect(raw.refId).toBe(refId);
    expect(progress.refId).toBe(refId);
    expect(raw.name).toBe('Raw response');
    expect(progress.name).toBe('Streaming Progress');
    expect(raw.fields[0].values[0]).toContain(`trace-${refId}`);
    expect(raw.fields[0].values[0]).toContain(envelope);
    expect(raw.fields[0].values[0]).not.toContain('\"abc\"');
  }
  expect(store.snapshot()).toEqual([
    { traceID: 'trace-A', spanID: 'span-A', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    { traceID: 'trace-B', spanID: 'span-B', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
  ]);
});

test('an empty metrics B stream never replaces a concurrent encrypted search A packet', async () => {
  const ds = { uid: 'tempo', protectedKeyEpoch: 0 } as TempoDatasource;
  const getStream = jest.fn((request: { path: string }) => request.path.startsWith('metrics/')
    ? of({}, message(null, SearchStreamingState.Done))
    : of(message([{ traceID: 'trace-A', rootServiceName: 'svc', rootTraceName: 'op', spanSet: {
      spans: [{ spanID: 'span-A', attributes: [{ key: 'enc.password', value: { stringValue: envelope } }] }],
    } }], SearchStreamingState.Streaming)));
  jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream } as never);
  const search = { refId: 'A', tableType: SearchTableType.Raw } as TempoQuery;
  const metrics = { refId: 'B' } as TempoQuery;

  const packets = await firstValueFrom(merge(
    doTempoSearchStreaming(search, ds, options, settings),
    doTempoMetricsStreaming(metrics, ds, options)
  ).pipe(toArray()));
  expect(packets.filter((packet) => packet.key === 'B')).toEqual([
    expect.objectContaining({ key: 'B', state: LoadingState.NotStarted, data: [] }),
    expect.objectContaining({ key: 'B', state: LoadingState.Done, data: [] }),
  ]);
  const searchPacket = packets.find((packet) => packet.key === 'A');
  expect(searchPacket?.data[0].refId).toBe('A');
  expect(searchPacket?.data[0].fields[0].values[0]).toContain(envelope);
  expect(JSON.stringify(searchPacket)).not.toContain('\"abc\"');
});

test('two status-only metrics streams retain independent packet keys through response merging', async () => {
  const ds = { uid: 'tempo' } as TempoDatasource;
  const getStream = jest.fn(() => of({}, message(undefined, SearchStreamingState.Done)));
  jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream } as never);

  const packets = await firstValueFrom(merge(
    doTempoMetricsStreaming({ refId: 'C' } as TempoQuery, ds, options),
    doTempoMetricsStreaming({ refId: 'D' } as TempoQuery, ds, options)
  ).pipe(toArray()));
  for (const refId of ['C', 'D']) {
    expect(packets.filter((packet) => packet.key === refId)).toEqual([
      expect.objectContaining({ key: refId, state: LoadingState.NotStarted, data: [] }),
      expect.objectContaining({ key: refId, state: LoadingState.Done, data: [] }),
    ]);
  }
});
