import { type DataQueryResponse } from '@grafana/data';

export const protectedDemoTraceID = '54e7f01d257543762f87a794493c112';
export const protectedDemoSpanID = 'af8fdfc419aa7141';

/** Encrypted Tempo search and trace-ID frames, shaped like the stock Explore renderers' inputs. */
export function protectedDisplayMock(envelope: string): DataQueryResponse {
  return {
    data: [
      {
        name: 'Traces',
        refId: 'A',
        length: 1,
        fields: [
          { name: 'traceID', values: [protectedDemoTraceID] },
          { name: 'traceService', values: ['protected-demo'] },
          { name: 'nested', values: [[{
            name: 'Spans',
            length: 1,
            fields: [
              { name: 'traceIdHidden', values: [protectedDemoTraceID] },
              { name: 'spanID', values: [protectedDemoSpanID] },
              { name: 'enc.secret', values: [envelope] },
            ],
          }]] },
        ],
      },
      {
        name: 'Trace',
        refId: 'B',
        length: 1,
        meta: { preferredVisualisationType: 'trace', custom: { traceFormat: 'otlp' } },
        fields: [
          { name: 'traceID', values: [protectedDemoTraceID] },
          { name: 'spanID', values: [protectedDemoSpanID] },
          { name: 'serviceName', values: ['protected-demo'] },
          { name: 'serviceTags', values: [[{ key: 'service.name', value: 'protected-demo' }]] },
          { name: 'tags', values: [[{ key: 'enc.secret', value: envelope }]] },
        ],
      },
    ],
  } as unknown as DataQueryResponse;
}
