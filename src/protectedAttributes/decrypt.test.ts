import { webcrypto } from 'node:crypto';
import { type DataFrame, type DataQueryResponse } from '@grafana/data';

import { type TraceSearchMetadata } from '../types';
import { importKey } from './crypto';
import {
  extractProtectedDisplayEntries,
  extractProtectedSearchEntries,
  ProtectedValuesStore,
  type ProtectedDisplayEntry,
} from './decrypt';

const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const encrypted = 'enc:v1:630dcd2966c4336691125448bbb25b4f:7aUwjY5fPtHvu_dUnzcxBJc6XQ';
const encryptedEmpty = 'enc:v1:630dcd2966c4336691125448bbb25b4f:l4ghA-S-aF9uZIBVXGBXsA';
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
afterAll(() => {
  if (originalCrypto) {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  } else {
    Reflect.deleteProperty(globalThis, 'crypto');
  }
});

function response(...frames: Array<{ name?: string; fields: Array<{ name: string; values: unknown[] }>; length?: number }>): DataQueryResponse {
  return { data: frames as unknown as DataFrame[] };
}

test('HTTP trace tags and nested, flat and Raw search frames decrypt without altering host ciphertext', async () => {
  const key = await importKey(master);
  const tags = Object.freeze([{ key: 'enc.password', value: encrypted }, { key: 'enc.password', value: encrypted }]);
  const child = { fields: [
    { name: 'traceIdHidden', values: ['trace-nested'] },
    { name: 'spanID', values: ['nested-span'] },
    { name: 'enc.password', values: [encryptedEmpty] },
    { name: 'enc.token', values: [null] },
  ] };
  const backendChild = JSON.stringify({
    schema: { fields: [{ name: 'traceIdHidden' }, { name: 'spanID' }, { name: 'enc.password' }] },
    data: { values: [['trace-nested', 'trace-nested'], ['backend-span', 'absent-span'], [encrypted, null]] },
  });
  const raw = JSON.stringify([{ traceID: 'trace-raw', spanSets: [{ spans: [
    { spanID: 'raw-span', attributes: [{ key: 'enc.password', value: { Value: { string_value: encrypted } } }] },
  ] }] }]);
  const result = response(
    { name: 'Trace', fields: [
      { name: 'traceID', values: ['trace-tags', 'trace-json-tags'] },
      { name: 'spanID', values: ['tags-span', 'json-tags-span'] },
      { name: 'tags', values: [tags, JSON.stringify([{ key: 'enc.password', value: encrypted }])] },
      { name: 'serviceTags', values: [[{ key: 'enc.password', value: 'resource-secret' }], []] },
      { name: 'logs', values: [[{ fields: [{ key: 'enc.password', value: 'event-secret' }] }], []] },
    ] },
    { name: 'Traces', fields: [{ name: 'traceID', values: ['trace-nested'] }, { name: 'nested', values: [[child, backendChild]] }] },
    { name: 'Spans', fields: [
      { name: 'traceIdHidden', values: ['trace-flat', 'trace-flat'] },
      { name: 'spanID', values: ['flat-span', 'missing-span'] },
      { name: 'enc.password', values: [encrypted, undefined] },
    ] },
    { name: 'Raw response', fields: [{ name: 'response', values: [raw] }] }
  );
  const original = JSON.stringify(result);
  const entries = await extractProtectedDisplayEntries(result, key);
  expect(entries).toEqual([
    { traceID: 'trace-tags', spanID: 'tags-span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    { traceID: 'trace-json-tags', spanID: 'json-tags-span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    { traceID: 'trace-nested', spanID: 'nested-span', storedField: 'enc.password', value: '', status: 'decrypted' },
    { traceID: 'trace-nested', spanID: 'backend-span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    { traceID: 'trace-flat', spanID: 'flat-span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    { traceID: 'trace-raw', spanID: 'raw-span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
  ]);
  expect(JSON.stringify(result)).toBe(original);
  expect(JSON.stringify(result)).not.toContain('"value":"abc"');
  expect(result.data[2].fields[2].values[0]).toBe(encrypted);
});

test('Live metadata deduplicates projected span attributes, preserving missing cells, empty plaintext and invalid markers', async () => {
  const key = await importKey(master);
  const traces = [{ traceID: 'trace', rootServiceName: 'svc', rootTraceName: 'op', spanSet: {
    attributes: [{ key: 'enc.password', value: { stringValue: encrypted } }],
    spans: [
      { spanID: 'span-a', attributes: [
        { key: 'enc.password', value: { stringValue: encryptedEmpty } },
        { key: 'enc.token', value: { stringValue: 'bad-envelope' } },
      ] },
      { spanID: 'span-b', attributes: [
        { key: 'enc.token', value: { stringValue: undefined } },
        { key: 'enc.secret', value: { Value: { string_value: null } } },
      ] },
    ],
  } }] as unknown as TraceSearchMetadata[];
  const original = JSON.stringify(traces);
  expect(await extractProtectedSearchEntries(traces, key)).toEqual([
    { traceID: 'trace', spanID: 'span-a', storedField: 'enc.password', value: '', status: 'decrypted' },
    { traceID: 'trace', spanID: 'span-a', storedField: 'enc.token', value: '[encrypted: invalid data]', status: 'invalid-data' },
    { traceID: 'trace', spanID: 'span-b', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
  ]);
  expect(await extractProtectedSearchEntries(traces)).toEqual([
    { traceID: 'trace', spanID: 'span-a', storedField: 'enc.password', value: '[encrypted: key unavailable]', status: 'key-unavailable' },
    { traceID: 'trace', spanID: 'span-a', storedField: 'enc.token', value: '[encrypted: key unavailable]', status: 'key-unavailable' },
    { traceID: 'trace', spanID: 'span-b', storedField: 'enc.password', value: '[encrypted: key unavailable]', status: 'key-unavailable' },
  ]);
  expect(await extractProtectedSearchEntries(null, key)).toEqual([]);
  expect(await extractProtectedSearchEntries(undefined, key)).toEqual([]);
  expect(JSON.stringify(traces)).toBe(original);
});

test('malformed Raw JSON reports only a non-secret error and does not block other frames', async () => {
  const key = await importKey(master);
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const result = response(
    { name: 'Raw response', fields: [{ name: 'response', values: ['{"traces":', '{"unexpected":true}'] }] },
    { name: 'Spans', fields: [
      { name: 'traceIdHidden', values: ['still-here'] },
      { name: 'spanID', values: ['span'] },
      { name: 'enc.password', values: [encrypted] },
    ] }
  );
  try {
    expect(await extractProtectedDisplayEntries(result, key)).toEqual([
      { traceID: 'still-here', spanID: 'span', storedField: 'enc.password', value: 'abc', status: 'decrypted' },
    ]);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls.flat().join(' ')).not.toContain('traces');
  } finally {
    warning.mockRestore();
  }
});

test('store partitions by refId and refuses stale request tokens and key epochs', () => {
  let epoch = 1;
  const store = new ProtectedValuesStore(() => epoch);
  const snapshots: Array<readonly ProtectedDisplayEntry[]> = [];
  const unsubscribe = store.subscribe((entries) => snapshots.push(entries));
  const token = store.beginRequest();
  const a: ProtectedDisplayEntry = { traceID: 'a', storedField: 'enc.password', value: 'first', status: 'decrypted' };
  const b: ProtectedDisplayEntry = { traceID: 'b', storedField: 'enc.password', value: 'second', status: 'decrypted' };
  store.replace('b', [b], epoch, token);
  store.replace('a', [a], epoch, token);
  expect(store.snapshot()).toEqual([a, b]);
  store.replace('a', [], epoch, token);
  expect(store.snapshot()).toEqual([b]);
  epoch++;
  store.replace('a', [a], 1, token);
  expect(store.snapshot()).toEqual([b]);
  store.clear();
  store.replace('b', [b], epoch, token);
  expect(store.snapshot()).toEqual([]);
  const newer = store.beginRequest();
  store.replace('a', [a], epoch, token);
  store.replace('a', [a], epoch, newer);
  expect(store.snapshot()).toEqual([a]);
  a.value = 'modified outside store';
  expect(store.snapshot()[0].value).toBe('first');
  expect(snapshots[0]).toEqual([]);
  expect(snapshots[snapshots.length - 1][0].value).toBe('first');
  unsubscribe();
  store.clear();
  expect(snapshots[snapshots.length - 1][0].value).toBe('first');
});
