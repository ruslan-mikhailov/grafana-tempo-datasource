import { type DataFrame, type DataQueryResponse } from '@grafana/data';

import { type TraceSearchMetadata } from '../types';
import { type ProtectedAttributeKey } from './crypto';

export type ProtectedDisplayEntry = {
  traceID: string;
  spanID?: string;
  storedField: string;
  value: string;
  status: 'decrypted' | 'key-unavailable' | 'invalid-data';
};

const KEY_UNAVAILABLE = '[encrypted: key unavailable]';
const INVALID_DATA = '[encrypted: invalid data]';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function attributeString(value: unknown): unknown {
  if (typeof value === 'string') {
    return value;
  }
  const data = record(value);
  if (!data) {
    return value;
  }
  // Tempo search metadata and OTLP JSON use different spellings for an AnyValue.
  const nested = record(data.Value) ?? record(data.value);
  const string = data.stringValue ?? data.string_value ?? nested?.stringValue ?? nested?.string_value;
  if (string != null) {
    return string;
  }
  return 'stringValue' in data || 'string_value' in data || (nested && ('stringValue' in nested || 'string_value' in nested))
    ? undefined
    : value;
}

class Collector {
  readonly entries: ProtectedDisplayEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly key?: ProtectedAttributeKey) {}

  add(traceID: string, spanID: string | undefined, storedField: string, candidate: unknown): void {
    if (!storedField.startsWith('enc.') || storedField.length === 4 || candidate == null) {
      return;
    }
    const ciphertext = attributeString(candidate);
    if (ciphertext == null) {
      return;
    }
    const identity = JSON.stringify([traceID, spanID, storedField]);
    if (this.seen.has(identity)) {
      return;
    }
    this.seen.add(identity);
    let entry: ProtectedDisplayEntry;
    if (!this.key) {
      entry = { traceID, spanID, storedField, value: KEY_UNAVAILABLE, status: 'key-unavailable' };
    } else if (typeof ciphertext !== 'string') {
      entry = { traceID, spanID, storedField, value: INVALID_DATA, status: 'invalid-data' };
    } else {
      try {
        entry = { traceID, spanID, storedField, value: this.key.decrypt(storedField, ciphertext), status: 'decrypted' };
      } catch {
        entry = { traceID, spanID, storedField, value: INVALID_DATA, status: 'invalid-data' };
      }
    }
    this.entries.push(entry);
  }

  attributes(attributes: unknown, traceID: string, spanID: string | undefined): void {
    if (typeof attributes === 'string') {
      try {
        attributes = JSON.parse(attributes);
      } catch {
        return;
      }
    }
    if (!Array.isArray(attributes)) {
      return;
    }
    for (const attribute of attributes) {
      const attr = record(attribute);
      if (attr && typeof attr.key === 'string') {
        this.add(traceID, spanID, attr.key, attr.value);
      }
    }
  }

  traces(traces: readonly unknown[]): void {
    for (const value of traces) {
      const trace = record(value);
      if (!trace) {
        continue;
      }
      const traceID = stringValue(trace.traceID) ?? '';
      const spanSets = Array.isArray(trace.spanSets) ? trace.spanSets : trace.spanSet ? [trace.spanSet] : [];
      for (const value of spanSets) {
        const spanSet = record(value);
        if (!spanSet || !Array.isArray(spanSet.spans)) {
          continue;
        }
        for (const value of spanSet.spans) {
          const span = record(value);
          if (!span) {
            continue;
          }
          const spanID = stringValue(span.spanID) ?? stringValue(span.spanId);
          // A span's own attribute takes precedence over a repeated projected span-set attribute.
          this.attributes(span.attributes, traceID, spanID);
          this.attributes(spanSet.attributes, traceID, spanID);
        }
      }
    }
  }
}

function fieldValue(frame: DataFrame, name: string, row: number): unknown {
  return frame.fields.find((field) => field.name === name)?.values[row];
}

function rows(frame: DataFrame): number {
  return Math.max(frame.length ?? 0, ...frame.fields.map((field) => field.values.length));
}

function nestedFrames(value: unknown): readonly unknown[] {
  if (typeof value === 'string') {
    try {
      return nestedFrames(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function extractFrame(frame: DataFrame, collector: Collector, nested = false, parentTraceID = ''): void {
  const count = rows(frame);
  if (frame.name === 'Raw response') {
    for (let row = 0; row < count; row++) {
      const raw = fieldValue(frame, 'response', row);
      if (raw == null) {
        continue;
      }
      try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const traces = Array.isArray(parsed) ? parsed : record(parsed)?.traces;
        if (!Array.isArray(traces)) {
          throw new Error('Invalid raw search response');
        }
        collector.traces(traces);
      } catch {
        // Never log the raw response: it may contain attributes or backend error text.
        console.warn('Unable to extract protected attributes from malformed Raw JSON response');
      }
    }
    return;
  }

  for (let row = 0; row < count; row++) {
    const traceID = stringValue(fieldValue(frame, 'traceID', row)) ?? stringValue(fieldValue(frame, 'traceIdHidden', row)) ?? stringValue(fieldValue(frame, 'traceId', row)) ?? parentTraceID;
    const spanID = stringValue(fieldValue(frame, 'spanID', row));
    if (frame.name === 'Traces') {
      for (const nestedValue of nestedFrames(fieldValue(frame, 'nested', row))) {
        let child: RecordValue | undefined;
        try {
          child = record(typeof nestedValue === 'string' ? JSON.parse(nestedValue) : nestedValue);
        } catch {
          continue;
        }
        if (child && Array.isArray(child.fields)) {
          extractFrame(child as unknown as DataFrame, collector, true, traceID);
        } else {
          // The Go backend stores nested frames as DataFrameJSON inside the cell.
          const schema = record(child?.schema);
          const data = record(child?.data);
          const values = data?.values;
          if (Array.isArray(schema?.fields) && Array.isArray(values)) {
            const fields = schema.fields.map((field, index) => ({
              name: record(field)?.name,
              values: values[index],
            }));
            if (fields.every((field) => typeof field.name === 'string' && Array.isArray(field.values))) {
              extractFrame({ name: 'Spans', fields } as unknown as DataFrame, collector, true, traceID);
            }
          }
        }
      }
    }
    if (nested || frame.name === 'Spans' || frame.name === 'Traces' || frame.fields.some((field) => field.name === 'tags')) {
      collector.attributes(fieldValue(frame, 'tags', row), traceID, spanID);
      for (const field of frame.fields) {
        if (field.name.startsWith('enc.')) {
          collector.add(traceID, spanID, field.name, field.values[row]);
        }
      }
    }
  }
}

/** Read only: no returned entry is attached to a host-owned frame or metadata object. */
export async function extractProtectedDisplayEntries(
  response: DataQueryResponse,
  key?: ProtectedAttributeKey
): Promise<ProtectedDisplayEntry[]> {
  const collector = new Collector(key);
  for (const frame of response.data) {
    extractFrame(frame, collector);
  }
  return collector.entries;
}

export async function extractProtectedSearchEntries(
  traces: readonly TraceSearchMetadata[] | null | undefined,
  key?: ProtectedAttributeKey
): Promise<ProtectedDisplayEntry[]> {
  const collector = new Collector(key);
  collector.traces(traces ?? []);
  return collector.entries;
}

/** This store belongs to a single browser datasource instance; never attach it to a DataFrame. */
export class ProtectedValuesStore {
  private readonly partitions = new Map<string, readonly ProtectedDisplayEntry[]>();
  private readonly listeners = new Set<(entries: readonly ProtectedDisplayEntry[]) => void>();
  private entries: readonly ProtectedDisplayEntry[] = [];
  private requestToken = 0;

  constructor(private readonly getEpoch: () => number) {}

  subscribe(listener: (entries: readonly ProtectedDisplayEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): readonly ProtectedDisplayEntry[] {
    return this.entries;
  }

  beginRequest(): number {
    this.requestToken++;
    this.partitions.clear();
    this.publish();
    return this.requestToken;
  }

  replace(refId: string, entries: readonly ProtectedDisplayEntry[], capturedEpoch: number, token: number): void {
    if (token !== this.requestToken || capturedEpoch !== this.getEpoch()) {
      return;
    }
    this.partitions.set(refId, entries.map((entry) => Object.freeze({ ...entry })));
    this.publish();
  }

  clear(): void {
    this.requestToken++;
    this.partitions.clear();
    this.publish();
  }

  private publish(): void {
    this.entries = Object.freeze(
      [...this.partitions.keys()].sort().flatMap((refId) => this.partitions.get(refId) ?? [])
    );
    for (const listener of this.listeners) {
      listener(this.entries);
    }
  }
}
