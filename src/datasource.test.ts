import { webcrypto } from 'node:crypto';

import { lastValueFrom, type Observable, of, throwError } from 'rxjs';

import {
  type DataFrame,
  dataFrameToJSON,
  type DataSourceInstanceSettings,
  dateTime,
  FieldType,
  type Field,
  getDefaultTimeRange,
  LoadingState,
  createDataFrame,
  PluginType,
  CoreApp,
  type DataSourceApi,
  type DataQueryRequest,
  getTimeZone,
  type PluginMetaInfo,
  type DataLink,
  NodeGraphDataFrameFieldNames,
} from '@grafana/data';
import {
  type BackendDataSourceResponse,
  type BackendSrv,
  config,
  type FetchResponse,
  getGrafanaLiveSrv,
  reportInteraction,
  setBackendSrv,
  setDataSourceSrv,
  type TemplateSrv,
  type DataSourceSrv,
} from '@grafana/runtime';
import { BarGaugeDisplayMode, type DataQuery, TableCellDisplayMode } from '@grafana/schema';

import { TempoVariableQueryType } from './VariableQueryEditor';
import { createFetchResponse } from './_importedDependencies/test/helpers/createFetchResponse';
import { TraceqlSearchScope } from './dataquery';
import { importKey } from './protectedAttributes/crypto';
import { prepareProtectedQueryModel } from './protectedAttributes/model';
import {
  TempoDatasource,
  buildExpr,
  buildLinkExpr,
  getRateAlignedValues,
  makeServiceGraphViewRequest,
  makeTempoLink,
  getFieldConfig,
  getEscapedRegexValues,
  getEscapedValues,
  makeHistogramLink,
  makePromServiceMapRequest,
  parseTimeRangeForTags,
} from './datasource';
import mockJson from './test/mockJsonResponse.json';
import mockServiceGraph from './test/mockServiceGraph.json';
import { createTempoDatasource } from './test/mocks';
import { initTemplateSrv } from './test/test_utils';
import { type TempoJsonData, type TempoQuery } from './types';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
  getGrafanaLiveSrv: jest.fn(() => ({ getStream: () => jest.requireActual('rxjs').of({}) })),
}));

describe('Tempo data source', () => {
  // Mock the console error so that running the test suite doesnt throw the error
  const origError = console.error;
  const consoleErrorMock = jest.fn();
  afterEach(() => (console.error = origError));
  beforeEach(() => (console.error = consoleErrorMock));

  describe('runs correctly', () => {
    const handleStreamingQuery = jest.spyOn(TempoDatasource.prototype, 'handleStreamingQuery');
    const templateSrv: TemplateSrv = { replace: (s: string) => s } as unknown as TemplateSrv;

    const range = {
      from: dateTime(new Date(2022, 8, 13, 16, 0, 0, 0)),
      to: dateTime(new Date(2022, 8, 13, 16, 15, 0, 0)),
      raw: { from: 'now-15m', to: 'now' },
    };
    const traceqlQuery = {
      targets: [{ refId: 'refid1', queryType: 'traceql', query: '{}' }],
      range,
    };
    const traceqlSearchQuery = {
      targets: [
        {
          refId: 'refid1',
          queryType: 'traceqlSearch',
          filters: [
            {
              id: 'service-name',
              operator: '=',
              scope: TraceqlSearchScope.Resource,
              tag: 'service.name',
              valueType: 'string',
            },
          ],
        },
      ],
      range,
    };

    it('for traceql queries when live is enabled', async () => {
      config.liveEnabled = true;
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      await lastValueFrom(ds.query(traceqlQuery as DataQueryRequest<TempoQuery>));
      expect(handleStreamingQuery).toHaveBeenCalledTimes(1);
    });

    it('for traceqlSearch queries when live is enabled', async () => {
      config.liveEnabled = true;
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      await lastValueFrom(ds.query(traceqlSearchQuery as DataQueryRequest<TempoQuery>));
      expect(handleStreamingQuery).toHaveBeenCalledTimes(1);
    });

    it('for traceql queries when live is not enabled', async () => {
      config.liveEnabled = false;
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      await lastValueFrom(ds.query(traceqlQuery as DataQueryRequest<TempoQuery>));
      expect(handleStreamingQuery).toHaveBeenCalledTimes(1);
    });

    it('for traceqlSearch queries when live is not enabled', async () => {
      config.liveEnabled = false;
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      await lastValueFrom(ds.query(traceqlSearchQuery as DataQueryRequest<TempoQuery>));
      expect(handleStreamingQuery).toHaveBeenCalledTimes(1);
    });
  });

  it('returns empty response when traceId is empty', async () => {
    const templateSrv: TemplateSrv = { replace: jest.fn() } as unknown as TemplateSrv;
    const ds = new TempoDatasource(defaultSettings, templateSrv);
    const response = await lastValueFrom(
      ds.query({
        targets: [{ refId: 'refid1', queryType: 'traceql', query: '' } as Partial<TempoQuery>],
      } as DataQueryRequest<TempoQuery>),
      { defaultValue: 'empty' }
    );
    expect(response).toBe('empty');
  });

  describe('Variables should be interpolated correctly', () => {
    function getQuery(serviceMapQuery: string | string[] = '$interpolationVar'): TempoQuery {
      return {
        refId: 'x',
        queryType: 'traceql',
        query: '$interpolationVarWithPipe',
        serviceMapQuery,
        filters: [
          {
            id: 'service-name',
            operator: '=',
            scope: TraceqlSearchScope.Resource,
            tag: 'service.name',
            value: '$interpolationVarWithPipe',
            valueType: 'string',
          },
          {
            id: 'tagId',
            operator: '=',
            scope: TraceqlSearchScope.Span,
            tag: '$interpolationVar',
            value: '$interpolationVar',
            valueType: 'string',
          },
        ],
      };
    }
    let templateSrv: TemplateSrv;
    const text = 'interpolationText';
    const textWithPipe = 'interpolationTextOne|interpolationTextTwo';

    beforeEach(() => {
      const expectedValues = {
        interpolationVar: 'scopedInterpolationText',
        interpolationText: 'interpolationText',
        interpolationVarWithPipe: 'interpolationTextOne|interpolationTextTwo',
        scopedInterpolationText: 'scopedInterpolationText',
      };
      templateSrv = initTemplateSrv([{ name: 'templateVariable1' }, { name: 'templateVariable2' }], expectedValues);
    });

    it('when moving from dashboard to explore', async () => {
      const expectedValues = {
        interpolationVar: 'interpolationText',
        interpolationText: 'interpolationText',
        interpolationVarWithPipe: 'interpolationTextOne|interpolationTextTwo',
        scopedInterpolationText: 'scopedInterpolationText',
      };
      templateSrv = initTemplateSrv([{ name: 'templateVariable1' }, { name: 'templateVariable2' }], expectedValues);

      const ds = new TempoDatasource(defaultSettings, templateSrv);
      const queries = ds.interpolateVariablesInQueries([getQuery()], {});
      expect(queries[0].query).toBe(textWithPipe);
      expect(queries[0].serviceMapQuery).toBe(text);
      expect(queries[0].filters[0].value).toBe(textWithPipe);
      expect(queries[0].filters[1].value).toBe(text);
      expect(queries[0].filters[1].tag).toBe(text);
    });

    it('when applying template variables', async () => {
      const scopedText = 'scopedInterpolationText';
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      const resp = ds.applyTemplateVariables(getQuery(), {
        interpolationVar: { text: scopedText, value: scopedText },
      });
      expect(resp.query).toBe(textWithPipe);
      expect(resp.filters[0].value).toBe(textWithPipe);
      expect(resp.filters[1].value).toBe(scopedText);
      expect(resp.filters[1].tag).toBe(scopedText);
    });

    it('when serviceMapQuery is an array', async () => {
      const ds = new TempoDatasource(defaultSettings, templateSrv);
      const queries = ds.interpolateVariablesInQueries([getQuery(['$interpolationVar', '$interpolationVar'])], {});
      expect(queries[0].serviceMapQuery?.[0]).toBe('scopedInterpolationText');
      expect(queries[0].serviceMapQuery?.[1]).toBe('scopedInterpolationText');
    });
  });

  it('parses json fields from backend', async () => {
    setDataSourceSrv({
      getInstanceSettings: () => defaultSettings,
    } as unknown as DataSourceSrv);
    setupBackendSrv(
      createDataFrame({
        fields: [
          { name: 'traceID', values: ['04450900759028499335'] },
          { name: 'spanID', values: ['4322526419282105830'] },
          { name: 'parentSpanID', values: [''] },
          { name: 'operationName', values: ['store.validateQueryTimeRange'] },
          { name: 'startTime', values: [1619712655875.4539] },
          { name: 'duration', values: [14.984] },
          { name: 'serviceTags', values: [{ key: 'servicetag1', value: 'service' }] },
          { name: 'logs', values: [{ timestamp: 12345, fields: [{ key: 'count', value: 1 }] }] },
          { name: 'tags', values: [{ key: 'tag1', value: 'val1' }] },
          { name: 'serviceName', values: ['service'] },
        ],
      })
    );
    const templateSrv = { replace: jest.fn() } as unknown as TemplateSrv;
    const ds = new TempoDatasource(defaultSettings, templateSrv);
    const response = await lastValueFrom(
      ds.query({ targets: [{ refId: 'refid1', query: '12345' }] } as DataQueryRequest<TempoQuery>)
    );

    expect(
      (response.data[0] as DataFrame).fields.map((f) => ({
        name: f.name,
        values: f.values,
      }))
    ).toMatchObject([
      { name: 'traceID', values: ['04450900759028499335'] },
      { name: 'spanID', values: ['4322526419282105830'] },
      { name: 'parentSpanID', values: [''] },
      { name: 'operationName', values: ['store.validateQueryTimeRange'] },
      { name: 'startTime', values: [1619712655875.4539] },
      { name: 'duration', values: [14.984] },
      { name: 'serviceTags', values: [{ key: 'servicetag1', value: 'service' }] },
      { name: 'logs', values: [{ timestamp: 12345, fields: [{ key: 'count', value: 1 }] }] },
      { name: 'tags', values: [{ key: 'tag1', value: 'val1' }] },
      { name: 'serviceName', values: ['service'] },
    ]);

    expect(
      (response.data[1] as DataFrame).fields.map((f) => ({
        name: f.name,
        values: f.values,
      }))
    ).toMatchObject([
      { name: 'id', values: ['4322526419282105830'] },
      { name: 'title', values: ['service'] },
      { name: 'subtitle', values: ['store.validateQueryTimeRange'] },
      { name: 'mainstat', values: ['14.98ms (100%)'] },
      { name: 'secondarystat', values: ['14.98ms (100%)'] },
      { name: 'color', values: [1.000007560204647] },
    ]);

    expect(
      (response.data[2] as DataFrame).fields.map((f) => ({
        name: f.name,
        values: f.values,
      }))
    ).toMatchObject([
      { name: 'id', values: [] },
      { name: 'target', values: [] },
      { name: 'source', values: [] },
    ]);
  });

  it('should handle json file upload', async () => {
    const ds = new TempoDatasource(defaultSettings);
    ds.uploadedJson = JSON.stringify(mockJson);
    const response = await lastValueFrom(
      ds.query({
        targets: [{ queryType: 'upload', refId: 'A' }],
      } as DataQueryRequest<TempoQuery>)
    );
    const field = response.data[0].fields[0];
    expect(field.name).toBe('traceID');
    expect(field.type).toBe(FieldType.string);
    expect(field.values[0]).toBe('000000000000000060ba2abb44f13eae');
    expect(field.values.length).toBe(6);
  });

  it('should fail on invalid json file upload', async () => {
    const ds = new TempoDatasource(defaultSettings);
    ds.uploadedJson = JSON.stringify(mockInvalidJson);
    const response = await lastValueFrom(
      ds.query({
        targets: [{ queryType: 'upload', refId: 'A' }],
      } as DataQueryRequest<TempoQuery>)
    );
    expect(response.error?.message).toBeDefined();
    expect(response.data.length).toBe(0);
  });

  it('should handle service graph upload', async () => {
    const ds = new TempoDatasource(defaultSettings);
    ds.uploadedJson = JSON.stringify(mockServiceGraph);
    const response = await lastValueFrom(
      ds.query({
        targets: [{ queryType: 'upload', refId: 'A' }],
      } as DataQueryRequest<TempoQuery>)
    );
    expect(response.data).toHaveLength(2);
    const nodesFrame = response.data[0];
    expect(nodesFrame.name).toBe('Nodes');
    expect(nodesFrame.meta?.preferredVisualisationType).toBe('nodeGraph');

    const edgesFrame = response.data[1];
    expect(edgesFrame.name).toBe('Edges');
    expect(edgesFrame.meta?.preferredVisualisationType).toBe('nodeGraph');
  });

  describe('test the metadataRequest function', () => {
    it('should return the data from getResource', async () => {
      const ds = new TempoDatasource(defaultSettings);
      jest.spyOn(ds, 'getResource').mockResolvedValue({ data: 'test-data' });
      const response = await ds.metadataRequest('api/v2/search/tags');
      expect(response).toBe('test-data');
    });
  });

  it('should include time shift when querying for traceID', () => {
    const ds = new TempoDatasource({
      ...defaultSettings,
      jsonData: { traceQuery: { timeShiftEnabled: true, spanStartTimeShift: '2m', spanEndTimeShift: '4m' } },
    });

    const range = {
      from: dateTime(new Date(2022, 8, 13, 16, 0, 0, 0)),
      to: dateTime(new Date(2022, 8, 13, 16, 15, 0, 0)),
      raw: { from: 'now-15m', to: 'now' },
    };

    const request = ds.makeTraceIdRequest(
      {
        requestId: 'test',
        interval: '',
        intervalMs: 5,
        scopedVars: {},
        targets: [],
        timezone: '',
        app: '',
        startTime: 0,
        range,
      },
      [{ refId: 'refid1', queryType: 'traceql', query: '' } as TempoQuery]
    );

    expect(request.range.from.valueOf()).toBe(new Date(2022, 8, 13, 15, 58, 0, 0).valueOf());
    expect(request.range.to.valueOf()).toBe(new Date(2022, 8, 13, 16, 19, 0, 0).valueOf());

    // Making sure we don't modify the original range
    expect(range.from.valueOf()).toBe(new Date(2022, 8, 13, 16, 0, 0, 0).valueOf());
    expect(range.to.valueOf()).toBe(new Date(2022, 8, 13, 16, 15, 0, 0).valueOf());
  });

  it('should not include time shift when querying for traceID and time shift config is off', () => {
    const ds = new TempoDatasource({
      ...defaultSettings,
      jsonData: { traceQuery: { timeShiftEnabled: false, spanStartTimeShift: '2m', spanEndTimeShift: '4m' } },
    });

    const request = ds.makeTraceIdRequest(
      {
        requestId: 'test',
        interval: '',
        intervalMs: 5,
        scopedVars: {},
        targets: [],
        timezone: '',
        app: '',
        startTime: 0,
        range: {
          from: dateTime(new Date(2022, 8, 13, 16, 0, 0, 0)),
          to: dateTime(new Date(2022, 8, 13, 16, 15, 0, 0)),
          raw: { from: 'now-15m', to: 'now' },
        },
      },
      [{ refId: 'refid1', queryType: 'traceql', query: '' } as TempoQuery]
    );

    expect(request.range.from.unix()).toBe(dateTime(0).unix());
    expect(request.range.to.unix()).toBe(dateTime(0).unix());
  });
});

describe('Tempo service graph view', () => {
  it('runs service graph queries', async () => {
    const ds = new TempoDatasource({
      ...defaultSettings,
      jsonData: {
        serviceMap: {
          datasourceUid: 'prom',
        },
      },
    });
    setDataSourceSrv(dataSourceSrvWithPrometheus(prometheusMock()));
    const response = await lastValueFrom(
      ds.query({
        targets: [{ queryType: 'serviceMap' }],
        range: getDefaultTimeRange(),
        app: CoreApp.Explore,
      } as DataQueryRequest<TempoQuery>)
    );

    expect(response.data).toHaveLength(3);
    expect(response.state).toBe(LoadingState.Done);

    // Service Graph view
    expect(response.data[0].fields[0].name).toBe('Name');
    expect(response.data[0].fields[0].values.length).toBe(2);
    expect(response.data[0].fields[0].values[0]).toBe('HTTP Client');
    expect(response.data[0].fields[0].values[1]).toBe('HTTP GET - root');

    expect(response.data[0].fields[1].name).toBe('Rate');
    expect(response.data[0].fields[1].values.length).toBe(2);
    expect(response.data[0].fields[1].values[0]).toBe(12.75164671814457);
    expect(response.data[0].fields[1].values[1]).toBe(12.121331111401608);
    expect(response.data[0].fields[1]?.config?.decimals).toBe(2);
    expect(response.data[0].fields[1]?.config?.links?.[0]?.title).toBe('Rate');
    expect(response.data[0].fields[1]?.config?.links?.[0]?.internal?.query.expr).toBe(
      'sum(rate(traces_spanmetrics_calls_total{span_name="${__data.fields[0]}"}[$__rate_interval]))'
    );
    expect(response.data[0].fields[1]?.config?.links?.[0]?.internal?.query.range).toBe(true);
    expect(response.data[0].fields[1]?.config?.links?.[0]?.internal?.query.exemplar).toBe(true);
    expect(response.data[0].fields[1]?.config?.links?.[0]?.internal?.query.instant).toBe(false);

    expect(response.data[0].fields[2].values.length).toBe(2);
    expect(response.data[0].fields[2].values[0]).toBe(12.75164671814457);
    expect(response.data[0].fields[2].values[1]).toBe(12.121331111401608);
    expect(response.data[0].fields[2]?.config?.color?.mode).toBe('continuous-BlPu');
    expect(response.data[0].fields[2]?.config?.custom.cellOptions.mode).toBe(BarGaugeDisplayMode.Lcd);
    expect(response.data[0].fields[2]?.config?.custom.cellOptions.type).toBe(TableCellDisplayMode.Gauge);
    expect(response.data[0].fields[2]?.config?.decimals).toBe(3);

    expect(response.data[0].fields[3].name).toBe('Error Rate');
    expect(response.data[0].fields[3].values.length).toBe(2);
    expect(response.data[0].fields[3].values[0]).toBe(3.75164671814457);
    expect(response.data[0].fields[3].values[1]).toBe(3.121331111401608);
    expect(response.data[0].fields[3]?.config?.decimals).toBe(2);
    expect(response.data[0].fields[3]?.config?.links?.[0]?.title).toBe('Error Rate');
    expect(response.data[0].fields[3]?.config?.links?.[0]?.internal?.query.expr).toBe(
      'sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR",span_name="${__data.fields[0]}"}[$__rate_interval]))'
    );
    expect(response.data[0].fields[3]?.config?.links?.[0]?.internal?.query.range).toBe(true);
    expect(response.data[0].fields[3]?.config?.links?.[0]?.internal?.query.exemplar).toBe(true);
    expect(response.data[0].fields[3]?.config?.links?.[0]?.internal?.query.instant).toBe(false);

    expect(response.data[0].fields[4].values.length).toBe(2);
    expect(response.data[0].fields[4].values[0]).toBe(3.75164671814457);
    expect(response.data[0].fields[4].values[1]).toBe(3.121331111401608);
    expect(response.data[0].fields[4]?.config?.color?.mode).toBe('continuous-RdYlGr');
    expect(response.data[0].fields[4]?.config?.custom.cellOptions.mode).toBe(BarGaugeDisplayMode.Lcd);
    expect(response.data[0].fields[4]?.config?.custom.cellOptions.type).toBe(TableCellDisplayMode.Gauge);
    expect(response.data[0].fields[4]?.config?.decimals).toBe(3);

    expect(response.data[0].fields[5].name).toBe('Duration (p90)');
    expect(response.data[0].fields[5].values.length).toBe(2);
    expect(response.data[0].fields[5].values[0]).toBe('0');
    expect(response.data[0].fields[5].values[1]).toBe(0.12003505696757232);
    expect(response.data[0].fields[5]?.config?.unit).toBe('s');
    expect(response.data[0].fields[5]?.config?.links?.[0]?.title).toBe('Duration');
    expect(response.data[0].fields[5]?.config?.links?.[0]?.internal?.query.expr).toBe(
      'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{span_name="${__data.fields[0]}"}[$__rate_interval])) by (le))'
    );
    expect(response.data[0].fields[5]?.config?.links?.[0]?.internal?.query.range).toBe(true);
    expect(response.data[0].fields[5]?.config?.links?.[0]?.internal?.query.exemplar).toBe(true);
    expect(response.data[0].fields[5]?.config?.links?.[0]?.internal?.query.instant).toBe(false);

    expect(response.data[0].fields[6]?.config?.links?.[0].url).toBe('');
    expect(response.data[0].fields[6]?.config?.links?.[0].title).toBe('Tempo');
    expect(response.data[0].fields[6]?.config?.links?.[0].internal.query.queryType).toBe('traceqlSearch');
    expect(response.data[0].fields[6]?.config?.links?.[0].internal.query.filters[0].value).toBe('${__data.fields[0]}');

    // Service graph
    expect(response.data[1].name).toBe('Nodes');
    expect(response.data[1].fields[0].values.length).toBe(3);
    expect(response.data[1].fields[0]?.config?.links?.length).toBeGreaterThan(0);
    expect(response.data[1].fields[0]?.config?.links).toEqual(serviceGraphLinks);

    const viewServicesLink = response.data[1].fields[0]?.config?.links.find(
      (link: DataLink) => link.title === 'View traces'
    );
    expect(viewServicesLink).toBeDefined();
    expect(viewServicesLink.internal.query({ replaceVariables: replaceVariablesInstrumented })).toEqual({
      refId: 'A',
      queryType: 'traceqlSearch',
      filters: [
        {
          id: 'service-name',
          operator: '=',
          scope: 'resource',
          tag: 'service.name',
          value: 'my-service',
          valueType: 'string',
        },
      ],
    });
    expect(viewServicesLink.internal.query({ replaceVariables: replaceVariablesUninstrumented })).toEqual({
      refId: 'A',
      queryType: 'traceql',
      filters: [],
      query:
        '{span.db.name="my-service" || span.db.system="my-service" || span.peer.service="my-service" || span.messaging.system="my-service" || span.net.peer.name="my-service"}',
    });

    expect(response.data[2].name).toBe('Edges');
    expect(response.data[2].fields[0].values.length).toBe(2);
  });

  it('runs correct queries with single serviceMapQuery defined', async () => {
    const ds = new TempoDatasource({
      ...defaultSettings,
      jsonData: {
        serviceMap: {
          datasourceUid: 'prom',
        },
      },
    });
    const promMock = prometheusMock();
    setDataSourceSrv(dataSourceSrvWithPrometheus(promMock));
    const response = await lastValueFrom(
      ds.query({
        targets: [{ queryType: 'serviceMap', serviceMapQuery: '{ foo="bar" }', refId: 'foo', filters: [] }],
        range: getDefaultTimeRange(),
        app: CoreApp.Explore,
        requestId: '1',
        interval: '60s',
        intervalMs: 60000,
        scopedVars: {},
        startTime: Date.now(),
        timezone: getTimeZone(),
      })
    );

    expect(response.data).toHaveLength(2);
    expect(response.state).toBe(LoadingState.Done);
    expect(response.data[0].name).toBe('Nodes');
    expect(response.data[1].name).toBe('Edges');
    expect(promMock.query).toHaveBeenCalledTimes(3);
    const nthQuery = (n: number) =>
      (promMock.query as jest.MockedFn<jest.MockableFunction>).mock.calls[n][0] as DataQueryRequest<PromQuery>;
    expect(nthQuery(0).targets[0].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_server_seconds_sum{ foo="bar" }[$__range]))'
    );
    expect(nthQuery(0).targets[1].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_server_seconds_sum{ foo="bar" })'
    );
    expect(nthQuery(0).targets[2].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_total{ foo="bar" }[$__range]))'
    );
    expect(nthQuery(0).targets[3].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_total{ foo="bar" })'
    );
    expect(nthQuery(0).targets[4].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_failed_total{ foo="bar" }[$__range]))'
    );
    expect(nthQuery(0).targets[5].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_failed_total{ foo="bar" })'
    );
    expect(nthQuery(0).targets[6].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_server_seconds_bucket{ foo="bar" }[$__range]))'
    );
    expect(nthQuery(0).targets[7].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_server_seconds_bucket{ foo="bar" })'
    );
  });

  it('runs correct queries with multiple serviceMapQuery defined', async () => {
    const ds = new TempoDatasource({
      ...defaultSettings,
      jsonData: {
        serviceMap: {
          datasourceUid: 'prom',
        },
      },
    });
    const promMock = prometheusMock();
    setDataSourceSrv(dataSourceSrvWithPrometheus(promMock));
    const response = await lastValueFrom(
      ds.query({
        targets: [
          { queryType: 'serviceMap', serviceMapQuery: ['{ foo="bar" }', '{baz="bad"}'], refId: 'foo', filters: [] },
        ],
        requestId: '1',
        interval: '60s',
        intervalMs: 60000,
        scopedVars: {},
        startTime: Date.now(),
        timezone: getTimeZone(),
        range: getDefaultTimeRange(),
        app: CoreApp.Explore,
      })
    );

    expect(response.data).toHaveLength(2);
    expect(response.state).toBe(LoadingState.Done);
    expect(response.data[0].name).toBe('Nodes');
    expect(response.data[1].name).toBe('Edges');
    expect(promMock.query).toHaveBeenCalledTimes(3);
    const nthQuery = (n: number) =>
      (promMock.query as jest.MockedFn<jest.MockableFunction>).mock.calls[n][0] as DataQueryRequest<PromQuery>;
    expect(nthQuery(0).targets[0].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_server_seconds_sum{ foo="bar" }[$__range])) OR sum by (client, server) (rate(traces_service_graph_request_server_seconds_sum{baz="bad"}[$__range]))'
    );
    expect(nthQuery(0).targets[1].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_server_seconds_sum{ foo="bar" }) OR group by (client, connection_type, server) (traces_service_graph_request_server_seconds_sum{baz="bad"})'
    );
    expect(nthQuery(0).targets[2].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_total{ foo="bar" }[$__range])) OR sum by (client, server) (rate(traces_service_graph_request_total{baz="bad"}[$__range]))'
    );
    expect(nthQuery(0).targets[3].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_total{ foo="bar" }) OR group by (client, connection_type, server) (traces_service_graph_request_total{baz="bad"})'
    );
    expect(nthQuery(0).targets[4].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_failed_total{ foo="bar" }[$__range])) OR sum by (client, server) (rate(traces_service_graph_request_failed_total{baz="bad"}[$__range]))'
    );
    expect(nthQuery(0).targets[5].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_failed_total{ foo="bar" }) OR group by (client, connection_type, server) (traces_service_graph_request_failed_total{baz="bad"})'
    );
    expect(nthQuery(0).targets[6].expr).toBe(
      'sum by (client, server) (rate(traces_service_graph_request_server_seconds_bucket{ foo="bar" }[$__range])) OR sum by (client, server) (rate(traces_service_graph_request_server_seconds_bucket{baz="bad"}[$__range]))'
    );
    expect(nthQuery(0).targets[7].expr).toBe(
      'group by (client, connection_type, server) (traces_service_graph_request_server_seconds_bucket{ foo="bar" }) OR group by (client, connection_type, server) (traces_service_graph_request_server_seconds_bucket{baz="bad"})'
    );
  });

  it('should build expr correctly', () => {
    let targets = { targets: [{ queryType: 'serviceMap' }] } as DataQueryRequest<TempoQuery>;
    let builtQuery = buildExpr(
      { expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)', params: [], topk: 5 },
      '',
      targets
    );
    expect(builtQuery).toBe('topk(5, sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name))');

    builtQuery = buildExpr(
      {
        expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)',
        params: ['status_code="STATUS_CODE_ERROR"'],
        topk: 5,
      },
      'span_name=~"HTTP Client|HTTP GET|HTTP GET - root|HTTP POST|HTTP POST - post"',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR",span_name=~"HTTP Client|HTTP GET|HTTP GET - root|HTTP POST|HTTP POST - post"}[$__range])) by (span_name))'
    );

    builtQuery = buildExpr(
      {
        expr: 'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{}[$__range])) by (le))',
        params: ['status_code="STATUS_CODE_ERROR"'],
      },
      'span_name=~"HTTP Client"',
      targets
    );
    expect(builtQuery).toBe(
      'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{status_code="STATUS_CODE_ERROR",span_name=~"HTTP Client"}[$__range])) by (le))'
    );

    targets = {
      targets: [{ queryType: 'serviceMap', serviceMapQuery: '{client="app",service="app"}' }],
    } as DataQueryRequest<TempoQuery>;
    builtQuery = buildExpr(
      { expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)', params: [], topk: 5 },
      '',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app",service="app"}[$__range])) by (span_name))'
    );

    targets = {
      targets: [{ queryType: 'serviceMap', serviceMapQuery: '{client="app",service="app"}' }],
    } as DataQueryRequest<TempoQuery>;
    builtQuery = buildExpr(
      { expr: 'topk(5, sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name))', params: [] },
      '',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app",service="app"}[$__range])) by (span_name))'
    );

    targets = {
      targets: [{ queryType: 'serviceMap', serviceMapQuery: ['{foo="app"}', '{bar="app"}'] }],
    } as DataQueryRequest<TempoQuery>;
    builtQuery = buildExpr(
      { expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)', params: [], topk: 5 },
      '',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{foo="app"}[$__range])) by (span_name) OR sum(rate(traces_spanmetrics_calls_total{bar="app"}[$__range])) by (span_name))'
    );

    targets = {
      targets: [{ queryType: 'serviceMap', serviceMapQuery: '{client="${app}",service="$app"}' }],
    } as DataQueryRequest<TempoQuery>;
    builtQuery = buildExpr(
      { expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)', params: [], topk: 5 },
      '',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{service="${app}",service="$app"}[$__range])) by (span_name))'
    );

    targets = {
      targets: [
        { queryType: 'serviceMap', serviceMapQuery: '{client="app",client_deployment_environment="production"}' },
      ],
    } as DataQueryRequest<TempoQuery>;
    builtQuery = buildExpr(
      { expr: 'sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name)', params: [], topk: 5 },
      '',
      targets
    );
    expect(builtQuery).toBe(
      'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app",deployment_environment="production"}[$__range])) by (span_name))'
    );
  });

  it('should build link expr correctly', () => {
    let builtQuery = buildLinkExpr('topk(5, sum(rate(traces_spanmetrics_calls_total{}[$__range])) by (span_name))');
    expect(builtQuery).toBe('sum(rate(traces_spanmetrics_calls_total{}[$__rate_interval]))');
  });

  it('should escape span names correctly', () => {
    const spanNames = [
      '/actuator/health/**',
      '$type + [test]|HTTP POST - post',
      'server.cluster.local:9090^/sample.test(.*)?',
      'test\\path',
    ];
    let escaped = getEscapedRegexValues(getEscapedValues(spanNames));
    expect(escaped).toEqual([
      '/actuator/health/\\\\*\\\\*',
      '\\\\$type \\\\+ \\\\[test\\\\]\\\\|HTTP POST - post',
      'server\\\\.cluster\\\\.local:9090\\\\^/sample\\\\.test\\\\(\\\\.\\\\*\\\\)\\\\?',
      'test\\\\path',
    ]);
  });

  it('should escape span with multi line content correctly', () => {
    const spanContent = [
      `
      SELECT * from "my_table"
      WHERE "data_enabled" = 1
      ORDER BY "name" ASC`,
    ];
    let escaped = getEscapedRegexValues(getEscapedValues(spanContent));
    expect(escaped).toEqual([
      '\\n      SELECT \\\\* from \\"my_table\\"\\n      WHERE \\"data_enabled\\" = 1\\n      ORDER BY \\"name\\" ASC',
    ]);
  });

  it('should get field config correctly', () => {
    let datasourceUid = 's4Jvz8Qnk';
    let tempoDatasourceUid = 'EbPO1fYnz';
    let targetField = '__data.fields.target';
    let tempoField = '__data.fields.target';
    let sourceField = '__data.fields.source';

    let fieldConfig = getFieldConfig(datasourceUid, tempoDatasourceUid, targetField, tempoField, sourceField);

    let resultObj = {
      links: [
        {
          url: '',
          title: 'Request rate',
          internal: {
            query: {
              expr: 'sum by (client, server)(rate(traces_service_graph_request_total{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval]))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'Request classic histogram',
          internal: {
            query: {
              expr: 'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds_bucket{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval])) by (le, client, server))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'Failed request rate',
          internal: {
            query: {
              expr: 'sum by (client, server)(rate(traces_service_graph_request_failed_total{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval]))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'View traces',
          internal: {
            datasourceName: '',
            datasourceUid: 'EbPO1fYnz',
            query: expect.any(Function),
          },
        },
      ],
    };
    expect(fieldConfig).toStrictEqual(resultObj);

    const viewServicesLink: DataLink | undefined = fieldConfig.links.find(
      (link: DataLink) => link.title === 'View traces'
    );
    expect(viewServicesLink).toBeDefined();
    expect(viewServicesLink!.internal!.query({ replaceVariables: replaceVariablesInstrumented })).toEqual({
      refId: 'A',
      queryType: 'traceqlSearch',
      filters: [
        {
          id: 'service-name',
          operator: '=',
          scope: 'resource',
          tag: 'service.name',
          value: 'my-target-service',
          valueType: 'string',
        },
      ],
    });
  });

  it('should get field config correctly when namespaces are present', () => {
    let datasourceUid = 's4Jvz8Qnk';
    let tempoDatasourceUid = 'EbPO1fYnz';
    let targetField = '__data.fields.targetName';
    let tempoField = '__data.fields.target';
    let sourceField = '__data.fields.sourceName';
    let namespaceFields = {
      targetNamespace: '__data.fields.targetNamespace',
      sourceNamespace: '__data.fields.sourceNamespace',
    };

    let fieldConfig = getFieldConfig(
      datasourceUid,
      tempoDatasourceUid,
      targetField,
      tempoField,
      sourceField,
      namespaceFields
    );

    let resultObj = {
      links: [
        {
          url: '',
          title: 'Request rate',
          internal: {
            query: {
              expr: 'sum by (client, server, server_service_namespace, client_service_namespace)(rate(traces_service_graph_request_total{client="${__data.fields.sourceName}",client_service_namespace="${__data.fields.sourceNamespace}",server="${__data.fields.targetName}",server_service_namespace="${__data.fields.targetNamespace}"}[$__rate_interval]))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'Request classic histogram',
          internal: {
            query: {
              expr: 'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds_bucket{client="${__data.fields.sourceName}",client_service_namespace="${__data.fields.sourceNamespace}",server="${__data.fields.targetName}",server_service_namespace="${__data.fields.targetNamespace}"}[$__rate_interval])) by (le, client, server, server_service_namespace, client_service_namespace))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'Failed request rate',
          internal: {
            query: {
              expr: 'sum by (client, server, server_service_namespace, client_service_namespace)(rate(traces_service_graph_request_failed_total{client="${__data.fields.sourceName}",client_service_namespace="${__data.fields.sourceNamespace}",server="${__data.fields.targetName}",server_service_namespace="${__data.fields.targetNamespace}"}[$__rate_interval]))',
              range: true,
              exemplar: true,
              instant: false,
            },
            datasourceUid: 's4Jvz8Qnk',
            datasourceName: '',
          },
        },
        {
          url: '',
          title: 'View traces',
          internal: {
            datasourceName: '',
            datasourceUid: 'EbPO1fYnz',
            query: expect.any(Function),
          },
        },
      ],
    };
    expect(fieldConfig).toStrictEqual(resultObj);

    const viewServicesLink: DataLink | undefined = fieldConfig.links.find(
      (link: DataLink) => link.title === 'View traces'
    );
    expect(viewServicesLink).toBeDefined();
    expect(viewServicesLink!.internal!.query({ replaceVariables: replaceVariablesInstrumented })).toEqual({
      refId: 'A',
      queryType: 'traceqlSearch',
      filters: [
        {
          id: 'service-namespace',
          operator: '=',
          scope: 'resource',
          tag: 'service.namespace',
          value: 'my-target-namespace-service',
          valueType: 'string',
        },
        {
          id: 'service-name',
          operator: '=',
          scope: 'resource',
          tag: 'service.name',
          value: 'my-target-name-service',
          valueType: 'string',
        },
      ],
    });
  });

  it('should get rate aligned values correctly', () => {
    const resp = [
      {
        refId:
          'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app",service="app"}[$__range])) by (span_name))',
        fields: [
          {
            name: 'Time',
            type: FieldType.time,
            config: {},
            values: [1653828275000, 1653828275000, 1653828275000, 1653828275000, 1653828275000],
          },
          {
            name: 'span_name',
            config: {
              filterable: true,
            },
            type: FieldType.string,
            values: ['HTTP Client', 'HTTP GET', 'HTTP GET - root', 'HTTP POST', 'HTTP POST - post'],
          },
        ],
        values: [],
      },
    ];

    const objToAlign = {
      'HTTP GET - root': {
        value: '0.1234',
      },
      'HTTP GET': {
        value: '0.6789',
      },
      'HTTP POST - post': {
        value: '0.4321',
      },
    };

    let value = getRateAlignedValues(resp, objToAlign);
    expect(value.toString()).toBe('0,0.6789,0.1234,0,0.4321');
  });

  it('should make service graph view request correctly', () => {
    const request = makeServiceGraphViewRequest([
      'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app"}[$__range])) by (span_name))"',
      'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{status_code="STATUS_CODE_ERROR",service="app",service="app",span_name=~"HTTP Client"}[$__range])) by (le))',
    ]);
    expect(request).toEqual([
      {
        refId: 'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app"}[$__range])) by (span_name))"',
        expr: 'topk(5, sum(rate(traces_spanmetrics_calls_total{service="app"}[$__range])) by (span_name))"',
        instant: true,
      },
      {
        refId:
          'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{status_code="STATUS_CODE_ERROR",service="app",service="app",span_name=~"HTTP Client"}[$__range])) by (le))',
        expr: 'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{status_code="STATUS_CODE_ERROR",service="app",service="app",span_name=~"HTTP Client"}[$__range])) by (le))',
        instant: true,
      },
    ]);
  });

  it('should make tempo link correctly without namespace', () => {
    const tempoLink = makeTempoLink('Tempo', undefined, '', '"${__data.fields[0]}"', 'gdev-tempo');
    expect(tempoLink).toEqual({
      url: '',
      title: 'Tempo',
      internal: {
        query: {
          queryType: 'traceqlSearch',
          refId: 'A',
          filters: [
            {
              id: 'span-name',
              operator: '=',
              scope: 'span',
              tag: 'name',
              value: '"${__data.fields[0]}"',
              valueType: 'string',
            },
          ],
        },
        datasourceUid: 'gdev-tempo',
        datasourceName: 'Tempo',
      },
    });
  });

  it('should make tempo link correctly with namespace', () => {
    const tempoLink = makeTempoLink('Tempo', '"${__data.fields.subtitle}"', '', '"${__data.fields[0]}"', 'gdev-tempo');
    expect(tempoLink).toEqual({
      url: '',
      title: 'Tempo',
      internal: {
        query: {
          queryType: 'traceqlSearch',
          refId: 'A',
          filters: [
            {
              id: 'service-namespace',
              operator: '=',
              scope: 'resource',
              tag: 'service.namespace',
              value: '"${__data.fields.subtitle}"',
              valueType: 'string',
            },
            {
              id: 'span-name',
              operator: '=',
              scope: 'span',
              tag: 'name',
              value: '"${__data.fields[0]}"',
              valueType: 'string',
            },
          ],
        },
        datasourceUid: 'gdev-tempo',
        datasourceName: 'Tempo',
      },
    });
  });
});

describe('label names - v2 tags', () => {
  let datasource: TempoDatasource;

  beforeEach(() => {
    datasource = createTempoDatasource();
    // Mock the language provider to return v2 tags
    datasource.languageProvider.tagsV2 = [{ name: 'span', tags: ['label1', 'label2'] }];
    jest.spyOn(datasource.languageProvider, 'start').mockResolvedValue([]);
  });

  it('get label names', async () => {
    // label_names()
    const response = await datasource.executeVariableQuery({ refId: 'test', type: TempoVariableQueryType.LabelNames });

    expect(response).toEqual([{ text: 'label1' }, { text: 'label2' }]);
  });
});

describe('label values', () => {
  let datasource: TempoDatasource;

  beforeEach(() => {
    datasource = createTempoDatasource();
    // Mock the language provider to return v2 tags that includes the "label" tag
    datasource.languageProvider.tagsV2 = [{ name: 'span', tags: ['label'] }];
    jest.spyOn(datasource.languageProvider, 'start').mockResolvedValue([]);
    jest.spyOn(datasource.languageProvider, 'getOptionsV2').mockResolvedValue([
      { type: 'string', value: 'value1', label: 'value1' },
      { type: 'string', value: 'value2', label: 'value2' },
    ]);
  });

  it('get label values for given label', async () => {
    // label_values("label")
    const response = await datasource.executeVariableQuery({
      refId: 'test',
      type: TempoVariableQueryType.LabelValues,
      label: 'label',
    });

    expect(response).toEqual([{ text: 'value1' }, { text: 'value2' }]);
  });

  it('do not raise error when label is not set', async () => {
    // label_values()
    const response = await datasource.executeVariableQuery({
      refId: 'test',
      type: TempoVariableQueryType.LabelValues,
      label: undefined,
    });

    expect(response).toEqual([]);
  });
});

describe('should provide functionality for ad-hoc filters', () => {
  let datasource: TempoDatasource;

  beforeEach(() => {
    datasource = createTempoDatasource();
    // Mock the language provider to return v2 tags
    datasource.languageProvider.tagsV2 = [{ name: 'span', tags: ['label1', 'label2'] }];
    jest.spyOn(datasource.languageProvider, 'fetchTags').mockResolvedValue();
    jest.spyOn(datasource.languageProvider, 'getOptionsV2').mockResolvedValue([
      { type: 'string', value: 'value1', label: 'value1' },
      { type: 'string', value: 'value2', label: 'value2' },
    ]);
  });

  it('for getTagKeys', async () => {
    const response = await datasource.getTagKeys({
      filters: [],
      timeRange: {
        from: dateTime('2021-04-20T15:55:00Z'),
        to: dateTime('2021-04-20T15:55:00Z'),
        raw: {
          from: 'now-15m',
          to: 'now',
        },
      },
    });
    expect(response).toEqual([{ text: 'span.label1' }, { text: 'span.label2' }]);
  });

  it('for getTagValues', async () => {
    const now = dateTime('2021-04-20T15:55:00Z');
    const options = {
      key: 'span.label1',
      filters: [],
      timeRange: {
        from: now,
        to: now,
        raw: {
          from: 'now-15m',
          to: 'now',
        },
      },
    };
    const response = await datasource.getTagValues(options);
    expect(response).toEqual([
      { text: 'value1', properties: { valueType: 'string' } },
      { text: 'value2', properties: { valueType: 'string' } },
    ]);
  });

  it('for getTagValues with missing type', async () => {
    jest.spyOn(datasource.languageProvider, 'getOptionsV2').mockResolvedValue([
      { value: 'value1', label: 'value1' },
      { value: 'value2', label: 'value2' },
    ]);
    const now = dateTime('2021-04-20T15:55:00Z');
    const options = {
      key: 'span.label1',
      filters: [],
      timeRange: {
        from: now,
        to: now,
        raw: {
          from: 'now-15m',
          to: 'now',
        },
      },
    };
    const response = await datasource.getTagValues(options);
    expect(response).toEqual([{ text: 'value1' }, { text: 'value2' }]);
  });
});

describe('histogram type functionality', () => {
  it('should create correct histogram links for classic histogram type', () => {
    const datasourceUid = 'prom';
    const source = 'client="${__data.fields.source}",';
    const target = 'server="${__data.fields.target}"';
    const serverSumBy = 'server';

    const links = makeHistogramLink(datasourceUid, source, target, serverSumBy, false);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe('Request classic histogram');
    expect(links[0].internal.query.expr).toBe(
      'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds_bucket{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval])) by (le, client, server))'
    );
  });

  it('should create correct histogram links for native histogram type', () => {
    const datasourceUid = 'prom';
    const source = 'client="${__data.fields.source}",';
    const target = 'server="${__data.fields.target}"';
    const serverSumBy = 'server';

    const links = makeHistogramLink(datasourceUid, source, target, serverSumBy, true);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe('Request native histogram');
    expect(links[0].internal.query.expr).toBe(
      'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval])) by (le, client, server))'
    );
  });

  it('should include histogram type in field config', () => {
    const datasourceUid = 'prom';
    const tempoDatasourceUid = 'tempo';
    const targetField = '__data.fields.target';
    const tempoField = '__data.fields.target';
    const sourceField = '__data.fields.source';

    const fieldConfig = getFieldConfig(
      datasourceUid,
      tempoDatasourceUid,
      targetField,
      tempoField,
      sourceField,
      undefined,
      true
    );
    const histogramLink = fieldConfig.links.find((link) => link.title === 'Request native histogram');
    expect(histogramLink).toBeDefined();
    expect(histogramLink?.internal?.query).toBeDefined();
    if (histogramLink?.internal?.query && 'expr' in histogramLink.internal.query) {
      expect(histogramLink.internal.query.expr).toBe(
        'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds{client="${__data.fields.source}",server="${__data.fields.target}"}[$__rate_interval])) by (le, client, server))'
      );
    }
  });

  it('should handle histogram type in service map query', () => {
    const request = makePromServiceMapRequest(
      {
        targets: [{ serviceMapQuery: '{service="test"}' }],
        range: getDefaultTimeRange(),
      } as DataQueryRequest<TempoQuery>,
      true
    );

    const bucketMetric = request.targets.find((t: PromQuery) => t.expr.includes('_bucket'));
    expect(bucketMetric).toBeUndefined();

    const nativeMetric = request.targets.find((t: PromQuery) =>
      t.expr.includes('traces_service_graph_request_server_seconds')
    );
    expect(nativeMetric).toBeDefined();
  });
});

const prometheusMock = (): DataSourceApi => {
  return {
    query: jest.fn(() =>
      of({
        data: [
          rateMetric,
          errorRateMetric,
          durationMetric,
          emptyDurationMetric,
          totalsPromMetric,
          secondsPromMetric,
          failedPromMetric,
        ],
      })
    ),
  } as unknown as DataSourceApi;
};

const dataSourceSrvWithPrometheus = (promMock: DataSourceApi) =>
  ({
    async get(uid: string) {
      if (uid === 'prom') {
        return promMock;
      }
      throw new Error('unexpected uid');
    },
    getInstanceSettings(uid: string) {
      if (uid === 'prom') {
        return { name: 'Prometheus' };
      } else if (uid === 'gdev-tempo') {
        return { name: 'Tempo' };
      }
      return '';
    },
  }) as unknown as DataSourceSrv;

function setupBackendSrv(frame: DataFrame) {
  setBackendSrv({
    fetch(): Observable<FetchResponse<BackendDataSourceResponse>> {
      return of(
        createFetchResponse({
          results: {
            refid1: {
              frames: [dataFrameToJSON(frame)],
            },
          },
        })
      );
    },
  } as unknown as BackendSrv);
}

export const defaultSettings: DataSourceInstanceSettings<TempoJsonData> = {
  uid: 'gdev-tempo',
  type: 'tracing',
  name: 'tempo',
  access: 'proxy',
  meta: {
    id: 'tempo',
    name: 'tempo',
    type: PluginType.datasource,
    info: {} as PluginMetaInfo,
    module: '',
    baseUrl: '',
  },
  jsonData: {
    nodeGraph: {
      enabled: true,
    },
    streamingEnabled: {
      search: true,
    },
  },
  readOnly: false,
};

const rateMetric = createDataFrame({
  refId: 'topk(5, sum(rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[$__range])) by (span_name))',
  fields: [
    { name: 'Time', values: [1653725618609, 1653725618609] },
    { name: 'span_name', values: ['HTTP Client', 'HTTP GET - root'] },
    {
      name: 'Value #topk(5, sum(rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[$__range])) by (span_name))',
      values: [12.75164671814457, 12.121331111401608],
    },
  ],
});

const errorRateMetric = createDataFrame({
  refId:
    'topk(5, sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR",span_name=~"HTTP Client|HTTP GET - root"}[$__range])) by (span_name))',
  fields: [
    { name: 'Time', values: [1653725618609, 1653725618609] },
    { name: 'span_name', values: ['HTTP Client', 'HTTP GET - root'] },
    {
      name: 'Value #topk(5, sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[$__range])) by (span_name))',
      values: [3.75164671814457, 3.121331111401608],
    },
  ],
});

const durationMetric = createDataFrame({
  refId:
    'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{span_name=~"HTTP GET - root"}[$__range])) by (le))',
  fields: [
    { name: 'Time', values: [1653725618609] },
    {
      name: 'Value #histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{span_name=~"HTTP GET - root"}[$__range])) by (le))',
      values: [0.12003505696757232],
    },
  ],
});

const emptyDurationMetric = createDataFrame({
  refId:
    'histogram_quantile(.9, sum(rate(traces_spanmetrics_latency_bucket{span_name=~"HTTP GET - root"}[$__range])) by (le))',
  fields: [],
});

const totalsPromMetric = createDataFrame({
  refId: 'traces_service_graph_request_total',
  fields: [
    { name: 'Time', values: [1628169788000, 1628169788000] },
    { name: 'client', values: ['app', 'lb'] },
    { name: 'instance', values: ['127.0.0.1:12345', '127.0.0.1:12345'] },
    { name: 'job', values: ['local_scrape', 'local_scrape'] },
    { name: 'server', values: ['db', 'app'] },
    { name: 'tempo_config', values: ['default', 'default'] },
    { name: 'Value #traces_service_graph_request_total', values: [10, 20] },
  ],
});

const secondsPromMetric = createDataFrame({
  refId: 'traces_service_graph_request_server_seconds_sum',
  fields: [
    { name: 'Time', values: [1628169788000, 1628169788000] },
    { name: 'client', values: ['app', 'lb'] },
    { name: 'instance', values: ['127.0.0.1:12345', '127.0.0.1:12345'] },
    { name: 'job', values: ['local_scrape', 'local_scrape'] },
    { name: 'server', values: ['db', 'app'] },
    { name: 'tempo_config', values: ['default', 'default'] },
    { name: 'Value #traces_service_graph_request_server_seconds_sum', values: [10, 40] },
  ],
});

const failedPromMetric = createDataFrame({
  refId: 'traces_service_graph_request_failed_total',
  fields: [
    { name: 'Time', values: [1628169788000, 1628169788000] },
    { name: 'client', values: ['app', 'lb'] },
    { name: 'instance', values: ['127.0.0.1:12345', '127.0.0.1:12345'] },
    { name: 'job', values: ['local_scrape', 'local_scrape'] },
    { name: 'server', values: ['db', 'app'] },
    { name: 'tempo_config', values: ['default', 'default'] },
    { name: 'Value #traces_service_graph_request_failed_total', values: [2, 15] },
  ],
});

const mockInvalidJson = {
  batches: [
    {
      resource: {
        attributes: [],
      },
      instrumentation_library_spans: [
        {
          instrumentation_library: {},
          spans: [
            {
              trace_id: 'AAAAAAAAAABguiq7RPE+rg==',
              span_id: 'cmteMBAvwNA=',
              parentSpanId: 'OY8PIaPbma4=',
              name: 'HTTP GET - root',
              kind: 'SPAN_KIND_SERVER',
              startTimeUnixNano: '1627471657255809000',
              endTimeUnixNano: '1627471657256268000',
              attributes: [
                { key: 'http.status_code', value: { intValue: '200' } },
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.url', value: { stringValue: '/' } },
                { key: 'component', value: { stringValue: 'net/http' } },
              ],
              status: {},
            },
          ],
        },
      ],
    },
  ],
};

const serviceGraphLinks = [
  {
    url: '',
    title: 'Request rate',
    internal: {
      query: {
        expr: 'sum by (client, server)(rate(traces_service_graph_request_total{server="${__data.fields.id}"}[$__rate_interval]))',
        instant: false,
        range: true,
        exemplar: true,
      },
      datasourceUid: 'prom',
      datasourceName: 'Prometheus',
    },
  },
  {
    url: '',
    title: 'Request classic histogram',
    internal: {
      query: {
        expr: 'histogram_quantile(0.9, sum(rate(traces_service_graph_request_server_seconds_bucket{server="${__data.fields.id}"}[$__rate_interval])) by (le, client, server))',
        instant: false,
        range: true,
        exemplar: true,
      },
      datasourceUid: 'prom',
      datasourceName: 'Prometheus',
    },
  },
  {
    url: '',
    title: 'Failed request rate',
    internal: {
      query: {
        expr: 'sum by (client, server)(rate(traces_service_graph_request_failed_total{server="${__data.fields.id}"}[$__rate_interval]))',
        instant: false,
        range: true,
        exemplar: true,
      },
      datasourceUid: 'prom',
      datasourceName: 'Prometheus',
    },
  },
  {
    url: '',
    title: 'View traces',
    internal: {
      query: expect.any(Function),
      datasourceUid: 'gdev-tempo',
      datasourceName: 'Tempo',
    },
  },
];

const replaceVariablesInstrumented = (variable: string): string => {
  const variables: Record<string, string> = {
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.id}}`]: 'my-service',
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.target}}`]: 'my-target-service',
    [`\${__data.fields.targetName}`]: 'my-target-name-service',
    [`\${__data.fields.targetNamespace}`]: 'my-target-namespace-service',
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.subTitle}}`]: 'my-namespace',
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.isInstrumented}}`]: 'true',
  };
  return variables[variable];
};

const replaceVariablesUninstrumented = (variable: string): string => {
  const variables: Record<string, string> = {
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.id}}`]: 'my-service',
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.subTitle}}`]: 'my-namespace',
    [`\${__data.fields.${NodeGraphDataFrameFieldNames.isInstrumented}}`]: 'false',
  };
  return variables[variable];
};

describe('parseTimeRangeForTags', () => {
  it('returns a plain number of seconds unchanged', () => {
    expect(parseTimeRangeForTags(259200)).toBe(259200);
  });

  it('parses a numeric string as seconds', () => {
    expect(parseTimeRangeForTags('259200')).toBe(259200);
    // "7" documents Tempo behaviour of 7 seconds, not 7 days
    expect(parseTimeRangeForTags('7')).toBe(7);
  });

  it('parses a duration string from provisioning into seconds', () => {
    expect(parseTimeRangeForTags('30m')).toBe(1800);
    expect(parseTimeRangeForTags('3h')).toBe(10800);
    expect(parseTimeRangeForTags('24h')).toBe(86400);
    expect(parseTimeRangeForTags('3d')).toBe(259200);
    expect(parseTimeRangeForTags('7d')).toBe(604800);
  });

  it('returns undefined for missing or invalid values instead of producing NaN', () => {
    expect(parseTimeRangeForTags(undefined)).toBeUndefined();
    expect(parseTimeRangeForTags('')).toBeUndefined();
    expect(parseTimeRangeForTags('NaN')).toBeUndefined();
    expect(parseTimeRangeForTags('not-a-duration')).toBeUndefined();
    expect(parseTimeRangeForTags(NaN)).toBeUndefined();
  });
});

interface PromQuery extends DataQuery {
  expr: string;
}

describe('protected datasource transport boundary', () => {
  const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const kid = '630dcd2966c4336691125448bbb25b4f';
  const attributeEnvelope = `enc:v1:${kid}:7aUwjY5fPtHvu_dUnzcxBJc6XQ`;
  const settings: DataSourceInstanceSettings<TempoJsonData> = {
    ...defaultSettings,
    jsonData: { ...defaultSettings.jsonData, protectedAttributesEnabled: true, streamingEnabled: { search: false } },
  };
  const range = getDefaultTimeRange();
  const identityTemplateSrv = { replace: (value: string) => value } as unknown as TemplateSrv;
  const fetchMock = jest.fn((_request: unknown) =>
    of(createFetchResponse({ results: { A: { frames: [] }, B: { frames: [] }, C: { frames: [] } } }))
  );
  let previousCrypto: PropertyDescriptor | undefined;
  let previousLiveEnabled: boolean;

  beforeAll(() => {
    previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  });
  afterAll(() => {
    if (previousCrypto) {
      Object.defineProperty(globalThis, 'crypto', previousCrypto);
    }
  });
  beforeEach(() => {
    previousLiveEnabled = config.liveEnabled;
    config.liveEnabled = false;
    fetchMock.mockClear();
    jest.mocked(reportInteraction).mockClear();
    setBackendSrv({ fetch: fetchMock } as unknown as BackendSrv);
    setDataSourceSrv({
      getInstanceSettings: () => settings,
    } as unknown as DataSourceSrv);
  });
  afterEach(() => {
    config.liveEnabled = previousLiveEnabled;
  });

  it('rejects a fingerprint-only legacy datasource instead of silently disabling protection', () => {
    const legacy = {
      ...settings,
      jsonData: { protectedKeyId: kid },
    } as unknown as DataSourceInstanceSettings<TempoJsonData>;
    expect(() => new TempoDatasource(legacy)).toThrow(/protected.*config|migrat/i);
  });

  it('imports a key for protected queries without a configured key fingerprint', async () => {
    const ds = new TempoDatasource({
      ...settings,
      uid: 'tempo-no-key-id',
      jsonData: { streamingEnabled: { search: false }, protectedAttributesEnabled: true } as TempoJsonData,
    });
    expect(await ds.importProtectedKey(master)).toBe(kid);
    const sealed = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    await lastValueFrom(ds.query({ targets: [sealed], range } as DataQueryRequest<TempoQuery>));
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toContain(`span.enc.password="${attributeEnvelope}"`);
    expect(JSON.stringify(sent)).not.toContain('"abc"');
  });

  it('imports by derived ID, keeps the old key on invalid input, and broadcasts only committed changes', async () => {
    const ds = new TempoDatasource(settings);
    const registry = (
      globalThis as unknown as Record<
        symbol,
        {
          epoch: number;
          resolve(storedField: string, envelope: string): string | undefined;
        }
      >
    )[Symbol.for('grafana.tempo.protected-attribute-display.v1')];
    const displayChange = jest.fn();
    window.addEventListener('grafana.tempo.protected-attribute-display-change', displayChange);
    const epochs: number[] = [];
    const unsubscribe = ds.subscribeProtectedKey((epoch) => epochs.push(epoch));
    expect(await ds.importProtectedKey(master)).toBe(kid);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    expect(displayChange).toHaveBeenCalledTimes(1);
    expect((displayChange.mock.calls[0][0] as CustomEvent).detail).toBeUndefined();
    const previous = ds.protectedKey;
    await expect(ds.importProtectedKey(Buffer.alloc(31, 7).toString('base64'))).rejects.toThrow('invalid-key');
    expect(ds.protectedKey).toBe(previous);
    expect(epochs).toEqual([1]);
    expect(displayChange).toHaveBeenCalledTimes(1);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    ds.clearProtectedKey();
    expect(ds.protectedKey).toBeUndefined();
    expect(epochs).toEqual([1, 2]);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('[encrypted: key unavailable]');
    expect(displayChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    const pending = ds.importProtectedKey(master);
    ds.clearProtectedKey();
    await expect(pending).rejects.toThrow('superseded');
    expect(ds.protectedKey).toBeUndefined();
    await ds.importProtectedKey(master);
    expect(epochs).toEqual([1, 2]);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    window.removeEventListener('grafana.tempo.protected-attribute-display-change', displayChange);
  });

  it('validates every key before a single batch commit, retaining old keys on later invalid input', async () => {
    const ds = new TempoDatasource({ ...settings, uid: 'tempo-batch-import' });
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const thirdMaster = Buffer.alloc(32, 8).toString('base64');
    const otherKid = (await importKey(otherMaster)).kid;
    const thirdKid = (await importKey(thirdMaster)).kid;
    const epochs: number[] = [];
    ds.subscribeProtectedKey((epoch) => epochs.push(epoch));

    expect(await ds.importProtectedKeys([master, otherMaster])).toEqual([kid, otherKid]);
    expect(ds.protectedKeys.map((key) => key.kid)).toEqual([kid, otherKid]);
    expect(epochs).toEqual([1]);
    const before = ds.protectedKeys;
    await expect(ds.importProtectedKeys([thirdMaster, Buffer.alloc(31, 7).toString('base64')])).rejects.toThrow(
      'invalid-key'
    );
    expect(ds.protectedKeys).toEqual(before);
    expect(ds.protectedKey).toBe(before[1]);
    expect(epochs).toEqual([1]);
    expect(settings.jsonData).not.toHaveProperty('protectedKeyId');
    expect(await ds.importProtectedKeys([thirdMaster, thirdMaster])).toEqual([thirdKid, thirdKid]);
    expect(ds.protectedKeys.map((key) => key.kid)).toEqual([kid, otherKid, thirdKid]);
    expect(epochs).toEqual([1, 2]);
    ds.clearAllProtectedKeys();
  });

  it('supersedes a pending multi-key import on forget before any staged key can commit', async () => {
    const ds = new TempoDatasource({ ...settings, uid: 'tempo-batch-forget' });
    await ds.importProtectedKey(master);
    const oldKey = ds.protectedKey;
    const pending = ds.importProtectedKeys([Buffer.alloc(32, 7).toString('base64'), master]);
    ds.clearProtectedKey(oldKey!.kid);
    await expect(pending).rejects.toThrow('superseded');
    expect(ds.protectedKeys).toEqual([]);
    expect(ds.protectedKey).toBeUndefined();
  });

  it('rejects a cancelled batch without adding a staged key or dropping existing keys', async () => {
    const ds = new TempoDatasource({ ...settings, uid: 'tempo-batch-cancel' });
    await ds.importProtectedKey(master);
    const oldKey = ds.protectedKey;
    const controller = new AbortController();
    const pending = ds.importProtectedKeys([Buffer.alloc(32, 7).toString('base64'), master], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('superseded');
    expect(ds.protectedKeys).toEqual([oldKey]);
    ds.clearAllProtectedKeys();
  });

  it('isolates distinct imported key IDs and never revives an older datasource key', async () => {
    const registry = (
      globalThis as unknown as Record<
        symbol,
        {
          epoch: number;
          resolve(storedField: string, envelope: string): string | undefined;
        }
      >
    )[Symbol.for('grafana.tempo.protected-attribute-display.v1')];
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKey = await importKey(otherMaster);
    const otherEnvelope = otherKey.encrypt('enc.password', 'other-secret');
    const first = new TempoDatasource({ ...settings, uid: 'tempo-first' });
    const second = new TempoDatasource({ ...settings, uid: 'tempo-second' });
    expect(registry.resolve('enc.password', otherEnvelope)).toBe('[encrypted: key unavailable]');
    await first.importProtectedKey(master);
    await second.importProtectedKey(otherMaster);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    expect(registry.resolve('enc.password', otherEnvelope)).toBe('other-secret');
    first.clearProtectedKey();
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('[encrypted: key unavailable]');
    expect(registry.resolve('enc.password', otherEnvelope)).toBe('other-secret');
    second.clearProtectedKey();
    expect(registry.resolve('enc.password', otherEnvelope)).toBe('[encrypted: key unavailable]');
    otherKey.clear();

    const older = new TempoDatasource({ ...settings, uid: 'tempo-older' });
    const newer = new TempoDatasource({ ...settings, uid: 'tempo-newer' });
    await older.importProtectedKey(master);
    await newer.importProtectedKey(master);
    older.clearProtectedKey();
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    newer.clearProtectedKey();
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('[encrypted: key unavailable]');
  });

  it('retains imported key histories without changing datasource configuration', async () => {
    const ds = new TempoDatasource({ ...settings, uid: 'tempo-rotate' });
    const registry = (
      globalThis as unknown as Record<
        symbol,
        {
          resolve(storedField: string, envelope: string): string | undefined;
        }
      >
    )[Symbol.for('grafana.tempo.protected-attribute-display.v1')];
    await ds.importProtectedKey(master);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    const otherMaster = Buffer.alloc(32, 7).toString('base64');
    const otherKid = await ds.importProtectedKey(otherMaster);
    expect(otherKid).not.toBe(kid);
    expect(settings.jsonData).not.toHaveProperty('protectedKeyId');
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    const rotated = ds.protectedKey!.encrypt('enc.password', 'rotated');
    expect(registry.resolve('enc.password', rotated)).toBe('rotated');
    ds.clearProtectedKey(kid);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('[encrypted: key unavailable]');
    expect(registry.resolve('enc.password', rotated)).toBe('rotated');
    expect(ds.protectedKey?.kid).toBe(otherKid);
    ds.clearAllProtectedKeys();
  });

  it('opens saved queries by their own key, forgets one history, and sends raw ciphertext keyless', async () => {
    const ds = new TempoDatasource({ ...settings, uid: 'tempo-history' });
    const oldKeyId = await ds.importProtectedKey(master);
    const oldKey = ds.protectedKey!;
    const oldSaved = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      oldKey,
      ds.uid
    );
    const newKeyId = await ds.importProtectedKey(Buffer.alloc(32, 7).toString('base64'));
    const newKey = ds.protectedKey!;
    const newEnvelope = newKey.encrypt('enc.password', 'abc');
    expect(ds.protectedKeys.map((key) => key.kid)).toEqual([oldKeyId, newKeyId]);
    await lastValueFrom(ds.query({ targets: [oldSaved], range } as DataQueryRequest<TempoQuery>));
    const sent = fetchMock.mock.calls.at(-1)![0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toContain(
      `span.enc.password="${attributeEnvelope}" || span.enc.password="${newEnvelope}"`
    );
    expect(JSON.stringify(sent)).not.toContain('"abc"');
    ds.clearProtectedKey(oldKeyId);
    expect(ds.protectedKeys.map((key) => key.kid)).toEqual([newKeyId]);
    const calls = fetchMock.mock.calls.length;
    await lastValueFrom(ds.query({ targets: [oldSaved], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).toHaveBeenCalledTimes(calls);

    ds.clearAllProtectedKeys();
    const direct = { refId: 'A', queryType: 'traceql', query: `{span.enc.password="${attributeEnvelope}"}` };
    await lastValueFrom(ds.query({ targets: [direct], range } as DataQueryRequest<TempoQuery>));
    const keyless = fetchMock.mock.calls.at(-1)![0] as { data: { queries: TempoQuery[] } };
    expect(keyless.data.queries[0].query).toBe(`${direct.query} | select(span.enc.password)`);
  });

  it('sends only compiled raw and builder targets in the entire HTTP payload and omits query telemetry', async () => {
    const ds = new TempoDatasource(settings);
    await ds.importProtectedKey(master);
    const raw = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const builder = await prepareProtectedQueryModel(
      {
        refId: 'B',
        queryType: 'traceqlSearch',
        filters: [
          {
            id: 'secret-filter',
            scope: TraceqlSearchScope.Span,
            tag: 'enc.password',
            operator: '=',
            value: 'abc',
            valueType: 'string',
          },
        ],
      },
      ds.protectedKey!,
      ds.uid
    );
    expect(raw.query).toMatch(/^qenc:v1:/);
    expect(builder.filters[0].value).toMatch(/^qenc:v1:/);
    await lastValueFrom(
      ds.query({
        targets: [{ ...raw, editorDraft: 'never-send-editor-data' }, builder],
        filters: [{ key: 'span.http.route', operator: '=', value: '/health' }],
        scopedVars: { hidden: { text: 'never-send-scoped-vars', value: 'never-send-scoped-vars' } },
        range,
        app: CoreApp.Explore,
        requestId: 'protected-http',
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const outbound = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    const body = JSON.stringify(outbound);
    expect(body).toContain(attributeEnvelope);
    expect(outbound.data.queries).toHaveLength(2);
    expect(outbound.data.queries[0].query).toContain(`span.enc.password="${attributeEnvelope}"`);
    expect(outbound.data.queries[0].query).toContain('span.http.route="/health"');
    expect(outbound.data.queries[0].query).toContain('| select(span.enc.password)');
    expect(outbound.data.queries[1].query).toContain(`span.enc.password="${attributeEnvelope}"`);
    for (const target of outbound.data.queries) {
      expect(target).not.toHaveProperty('filters');
      expect(target).not.toHaveProperty('editorDraft');
      expect(target).not.toHaveProperty('scopedVars');
    }
    expect(body).not.toContain('qenc:v1:');
    expect(body).not.toContain('never-send');
    expect(body).not.toContain('"abc"');
    for (const [, payload] of jest.mocked(reportInteraction).mock.calls) {
      expect(payload).not.toHaveProperty('query');
      expect(payload).not.toHaveProperty('error');
      expect(payload).not.toHaveProperty('statusText');
      expect(JSON.stringify(payload)).not.toContain('abc');
    }
  });

  it('keeps HTTP host frames encrypted while resolving only at the browser display boundary', async () => {
    const frames = ['A', 'B'].map((refId) =>
      createDataFrame({
        refId,
        name: 'Spans',
        fields: [
          { name: 'traceIdHidden', values: [`trace-${refId}`] },
          { name: 'spanID', values: [`span-${refId}`] },
          { name: 'enc.password', values: [attributeEnvelope] },
        ],
      })
    );
    const backend = jest.fn(() =>
      of(
        createFetchResponse({
          results: {
            A: { frames: [dataFrameToJSON(frames[0])] },
            B: { frames: [dataFrameToJSON(frames[1])] },
          },
        })
      )
    );
    setBackendSrv({ fetch: backend } as unknown as BackendSrv);
    const ds = new TempoDatasource(settings);
    await ds.importProtectedKey(master);
    const targets = ['A', 'B'].map((refId) => ({
      refId,
      queryType: 'traceql' as const,
      query: '{span.http.route="/ready"}',
      filters: [],
    }));
    const response = await lastValueFrom(ds.query({ targets, range } as unknown as DataQueryRequest<TempoQuery>));
    expect(backend).toHaveBeenCalledTimes(1);
    expect(
      response.data.map((frame) => frame.fields.find((field: Field) => field.name === 'enc.password')?.values[0])
    ).toEqual([attributeEnvelope, attributeEnvelope]);
    const registry = (
      globalThis as unknown as Record<
        symbol,
        {
          epoch: number;
          resolve(storedField: string, envelope: string): string | undefined;
        }
      >
    )[Symbol.for('grafana.tempo.protected-attribute-display.v1')];
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('abc');
    expect(registry.resolve('enc.token', attributeEnvelope)).toBe('[encrypted: invalid data]');
    expect(registry.resolve('enc.password', `enc:v1:${kid}:!`)).toBe('[encrypted: invalid data]');
    expect(registry.resolve('enc.password', `enc:v1:${'f'.repeat(32)}:7aUwjY5fPtHvu_dUnzcxBJc6XQ`)).toBe(
      '[encrypted: key unavailable]'
    );
    expect(registry.resolve('password', attributeEnvelope)).toBeUndefined();
    const epoch = registry.epoch;
    ds.clearProtectedKey();
    expect(registry.epoch).toBeGreaterThan(epoch);
    expect(registry.resolve('enc.password', attributeEnvelope)).toBe('[encrypted: key unavailable]');
    expect(
      response.data.every(
        (frame) => frame.fields.find((field: Field) => field.name === 'enc.password')?.values[0] === attributeEnvelope
      )
    ).toBe(true);
    expect(frames[0].fields[2].values[0]).toBe(attributeEnvelope);
  });

  it('keeps direct trace-ID span tags encrypted through the stock trace frame', async () => {
    const traceID = '54e7f01d257543762f87a794493c112';
    const tags = [{ key: 'enc.password', value: attributeEnvelope }];
    const frame = createDataFrame({
      name: 'Trace',
      meta: { preferredVisualisationType: 'trace', custom: { traceFormat: 'otlp' } },
      fields: [
        { name: 'traceID', values: [traceID] },
        { name: 'spanID', values: ['af8fdfc419aa7141'] },
        { name: 'tags', values: [tags] },
        { name: 'serviceTags', values: [[{ key: 'service.name', value: 'demo' }]] },
      ],
    });
    const backend = jest.fn(() => of(createFetchResponse({ results: { A: { frames: [dataFrameToJSON(frame)] } } })));
    setBackendSrv({ fetch: backend } as unknown as BackendSrv);
    const templateSrv = { replace: (value: string) => value } as TemplateSrv;
    const ds = new TempoDatasource(
      {
        ...settings,
        jsonData: { ...settings.jsonData, nodeGraph: { enabled: false } },
      },
      templateSrv
    );
    await ds.importProtectedKey(master);

    const response = await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceId', query: traceID }],
        range,
      } as unknown as DataQueryRequest<TempoQuery>)
    );

    expect(response.error).toBeUndefined();
    expect(response.data[0].meta?.preferredVisualisationType).toBe('trace');
    expect(response.data[0].fields.find((field: { name: string }) => field.name === 'tags')?.values[0]).toEqual(tags);
    expect(JSON.stringify(response.data)).not.toContain('"abc"');
    const registry = (
      globalThis as unknown as Record<
        symbol,
        {
          resolve(storedField: string, envelope: string): string | undefined;
        }
      >
    )[Symbol.for('grafana.tempo.protected-attribute-display.v1')];
    expect(registry.resolve(tags[0].key, tags[0].value)).toBe('abc');
    expect(backend).toHaveBeenCalledTimes(1);
    ds.clearProtectedKey();
  });

  it('prepares every visible target before dispatch and keeps ordinary queries usable without an imported key', async () => {
    const ds = new TempoDatasource(settings);
    const ordinary = {
      refId: 'A',
      queryType: 'traceql',
      query: '{span.http.route="/ready"}',
      filters: [],
    } as TempoQuery;
    await lastValueFrom(ds.query({ targets: [ordinary], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls[0][0])).toContain('{span.http.route=\\"/ready\\"}');
    fetchMock.mockClear();
    jest.mocked(reportInteraction).mockClear();

    const key = await importKey(master);
    const sealed = await prepareProtectedQueryModel(
      { refId: 'B', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      key,
      ds.uid
    );
    const locked = await lastValueFrom(
      ds.query({ targets: [ordinary, sealed], range } as DataQueryRequest<TempoQuery>)
    );
    expect(locked.error?.message).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportInteraction).not.toHaveBeenCalledWith('grafana_traces_traceql_queried', expect.anything());

    const legacy = await lastValueFrom(
      ds.query({
        targets: [ordinary, { refId: 'B', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] }],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    expect(legacy.error?.message).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const other = await importKey(Buffer.alloc(32, 7).toString('base64'));
    const wrongKeyModel: TempoQuery = {
      refId: 'B',
      queryType: 'traceql',
      filters: [],
      query: await other.sealQueryModel('{span.enc.password="abc"}', JSON.stringify([ds.uid, 'query'])),
    };
    const wrongKey = await lastValueFrom(
      ds.query({ targets: [ordinary, wrongKeyModel], range } as DataQueryRequest<TempoQuery>)
    );
    expect(wrongKey.error?.message).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects protected host-owned ad-hoc and template RHS before HTTP or telemetry', async () => {
    const templateSrv: TemplateSrv = {
      replace: (value: string) => value.replace('$password', 'abc'),
    } as unknown as TemplateSrv;
    const ds = new TempoDatasource(settings, templateSrv);
    await ds.importProtectedKey(master);
    const variableQuery = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="$password"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const hostRhs = await lastValueFrom(ds.query({ targets: [variableQuery], range } as DataQueryRequest<TempoQuery>));
    expect(hostRhs.error?.message).not.toContain('abc');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportInteraction).not.toHaveBeenCalled();

    const inject = new TempoDatasource(settings, {
      replace: (value: string) => value.replace('$value', '"x" || span.enc.password="host-secret"'),
    } as unknown as TemplateSrv);
    await inject.importProtectedKey(master);
    const hostFragment: TempoQuery = {
      refId: 'A',
      queryType: 'traceql',
      filters: [],
      query: await inject.protectedKey!.sealQueryModel(
        '{span.http.route=$value}',
        JSON.stringify([inject.uid, 'query'])
      ),
    };
    const injected = await lastValueFrom(
      inject.query({ targets: [hostFragment], range } as DataQueryRequest<TempoQuery>)
    );
    expect(injected.error?.message).not.toContain('host-secret');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportInteraction).not.toHaveBeenCalled();

    const adHoc = await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceqlSearch', filters: [] }],
        filters: [{ key: 'span.enc.password', operator: '=', value: 'abc' }],
        range,
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    expect(adHoc.error?.message).not.toContain('abc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reports backend-echoed query or error text for protected failures', async () => {
    setBackendSrv({
      fetch: () =>
        throwError(() => ({
          message: 'backend echoed abc',
          data: { message: 'backend echoed abc' },
          status: 500,
          statusText: 'backend echoed abc',
        })),
    } as unknown as BackendSrv);
    const ds = new TempoDatasource(settings);
    await ds.importProtectedKey(master);
    const sealed = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const response = await lastValueFrom(ds.query({ targets: [sealed], range } as DataQueryRequest<TempoQuery>));
    expect(JSON.stringify(response)).not.toContain('backend echoed abc');
    expect(JSON.stringify(jest.mocked(reportInteraction).mock.calls)).not.toContain('abc');
    for (const [, payload] of jest.mocked(reportInteraction).mock.calls) {
      expect(payload).not.toHaveProperty('query');
      expect(payload).not.toHaveProperty('error');
      expect(payload).not.toHaveProperty('statusText');
    }
  });

  it('passes compiled per-target search and metrics only to Live data', async () => {
    const stream = jest.fn((_request: unknown) => of({}));
    jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream: stream } as never);
    config.liveEnabled = true;
    const ds = new TempoDatasource(settings);
    ds.streamingEnabled = { search: true, metrics: true };
    await ds.importProtectedKey(master);
    const search = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const metrics = await prepareProtectedQueryModel(
      { refId: 'B', queryType: 'traceql', query: '{span.enc.password="abc"} | rate()', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const secondKid = await ds.importProtectedKey(Buffer.alloc(32, 7).toString('base64'));
    const secondEnvelope = ds.getProtectedKey(secondKid)!.encrypt('enc.password', 'abc');
    await lastValueFrom(
      ds.query({
        targets: [search, metrics],
        scopedVars: { secret: { text: 'never-send-live', value: 'never-send-live' } },
        range,
        app: CoreApp.Explore,
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    expect(stream).toHaveBeenCalledTimes(2);
    const calls = stream.mock.calls.map(([request]) => request as { path: string; data: TempoQuery });
    const searchCall = calls.find((call) => call.path.startsWith('search/'))!;
    const metricsCall = calls.find((call) => call.path.startsWith('metrics/'))!;
    expect(calls.map((call) => call.path.split('/')[0]).sort()).toEqual(['metrics', 'search']);
    expect(searchCall.data.query).toContain(`"${attributeEnvelope}"`);
    expect(searchCall.data.query).toContain('| select(span.enc.password)');
    expect(metricsCall.data.query).toContain(`"${attributeEnvelope}"`);
    expect(metricsCall.data.query).not.toContain('| select(');
    expect(searchCall.data.query).toContain(`"${secondEnvelope}"`);
    expect(metricsCall.data.query).toContain(`"${secondEnvelope}"`);
    expect(searchCall.data.query).toContain(' || ');
    expect(metricsCall.data.query).toContain(' || ');
    for (const call of [searchCall, metricsCall]) {
      expect(call.data).not.toHaveProperty('filters');
      expect(call.data).not.toHaveProperty('scopedVars');
      expect(JSON.stringify(call.data)).not.toContain('never-send-live');
      expect(JSON.stringify(call.data)).not.toContain('qenc:v1:');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('compiles contextual metadata once and rejects protected host-variable RHS and protected tag-value requests', async () => {
    const templateSrv: TemplateSrv = {
      replace: (value: string) =>
        value.replace('$password', 'abc').replace('$value', '"x" || span.enc.password="host-secret"'),
    } as unknown as TemplateSrv;
    const ds = new TempoDatasource(settings, templateSrv);
    await ds.importProtectedKey(master);
    const resource = jest.spyOn(ds, 'getResource').mockResolvedValue({ data: { tagValues: [] } });
    ds.languageProvider.tagsV2 = [
      { name: 'span', tags: ['enc.password', 'http.route'] },
      { name: 'resource', tags: ['enc.password'] },
    ];
    jest.spyOn(ds.languageProvider, 'fetchTags').mockResolvedValue();
    expect(await ds.getTagKeys({ filters: [], timeRange: range })).toEqual([
      { text: 'span.http.route' },
      { text: 'resource.enc.password' },
    ]);
    expect(await ds.getTagValues({ key: 'span."enc"."password"', filters: [], timeRange: range })).toEqual([]);
    expect(resource).not.toHaveBeenCalled();
    await ds.metadataRequest('tag-values', { q: '{span.enc.password="abc"}', tag: 'span.http.route', limit: 20 });
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({ q: `{span.enc.password="${attributeEnvelope}"}`, tag: 'span.http.route' }),
      expect.anything()
    );
    resource.mockClear();
    expect(
      await ds.getTagValues({
        key: 'span:name',
        filters: [{ key: 'span.http.route', operator: '=', value: 'ready' }],
        timeRange: range,
      })
    ).toEqual([]);
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({ tag: 'span%3Aname', q: '{span.http.route="ready"}' }),
      expect.anything()
    );
    resource.mockClear();
    expect(
      await ds.getTagValues({
        key: 'span:name',
        filters: [
          { key: 'span.http.route', operator: '=', value: 'say "hello"' },
          { key: 'span.http.path', operator: '=', value: 'C:\\tmp' },
        ],
        timeRange: range,
      })
    ).toEqual([]);
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({
        q: '{span.http.route="say \\"hello\\"" && span.http.path="C:\\\\tmp"}',
        tag: 'span%3Aname',
      }),
      expect.anything()
    );
    resource.mockClear();
    await expect(ds.metadataRequest('tag-values', { q: '{span.enc.password="$password"}' })).rejects.toThrow(
      'Protected metadata request failed.'
    );
    await expect(ds.metadataRequest('tag-values', { q: '{span.http.route=$value}' })).rejects.toThrow(
      'Protected metadata request failed.'
    );
    await expect(ds.metadataRequest('tag-values', { tag: 'span.enc.password' })).rejects.toThrow();
    await expect(
      ds.metadataRequest('tag-values', { tag: encodeURIComponent('span."enc"."password"') })
    ).rejects.toThrow();
    expect(
      await ds.getTagValues({
        key: 'span.http.route',
        filters: [
          { key: 'span.http.route', operator: '=', value: 'x"} //' },
          { key: 'span."enc"."password"', operator: '=', value: 'host-secret' },
        ],
        timeRange: range,
      })
    ).toEqual([]);
    expect(resource).not.toHaveBeenCalled();
    await ds.metadataRequest('tag-values', { tag: 'span.http.enc.password' });
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({ tag: 'span.http.enc.password' }),
      expect.anything()
    );
  });
  it('uses all loaded keys for metadata but passes canonical ciphertext unchanged without any key', async () => {
    const ds = new TempoDatasource(settings);
    await ds.importProtectedKey(master);
    const secondKid = await ds.importProtectedKey(Buffer.alloc(32, 7).toString('base64'));
    const secondEnvelope = ds.getProtectedKey(secondKid)!.encrypt('enc.password', 'abc');
    const resource = jest.spyOn(ds, 'getResource').mockResolvedValue({ data: { tagValues: [] } });
    await ds.metadataRequest('tag-values', { q: '{span.enc.password="abc"}', tag: 'span.http.route' });
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({
        q: `{(span.enc.password="${attributeEnvelope}" || span.enc.password="${secondEnvelope}")}`,
      }),
      expect.anything()
    );
    ds.clearAllProtectedKeys();
    resource.mockClear();
    await ds.metadataRequest('tag-values', {
      q: `{span.enc.password="${attributeEnvelope}"}`,
      tag: 'span.http.route',
    });
    expect(resource).toHaveBeenCalledWith(
      'tag-values',
      expect.objectContaining({ q: `{span.enc.password="${attributeEnvelope}"}` }),
      expect.anything()
    );
  });

  it('rejects host-variable predicate erasure but confines ordinary builder values to one literal', async () => {
    const templateSrv = {
      replace: (value: string) => value.replace('$value', 'x" || span.enc.password="host-secret"} // '),
    } as unknown as TemplateSrv;
    const ds = new TempoDatasource(settings, templateSrv);
    await ds.importProtectedKey(master);
    const sealed = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.http.route="$value" && span.enc.password="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const rawResponse = await lastValueFrom(ds.query({ targets: [sealed], range } as DataQueryRequest<TempoQuery>));
    expect(rawResponse.error?.message).not.toContain('host-secret');
    expect(fetchMock).not.toHaveBeenCalled();

    const builderResponse = await lastValueFrom(
      ds.query({
        targets: [
          {
            refId: 'B',
            queryType: 'traceqlSearch',
            filters: [
              {
                id: 'route',
                scope: TraceqlSearchScope.Span,
                tag: 'http.route',
                operator: '=',
                value: '$value',
                valueType: 'string',
              },
            ],
          },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    expect(builderResponse.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const builderSent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(builderSent.data.queries[0].query).toBe(
      String.raw`{span.http.route="x\" || span.enc.password=\"host-secret\"} // "}`
    );
    fetchMock.mockClear();
    const adHocResponse = await lastValueFrom(
      ds.query({
        targets: [{ refId: 'C', queryType: 'traceqlSearch', filters: [] }],
        filters: [
          { key: 'span.http.route', operator: '=', value: 'x" || span.enc.password="host-secret"} // ' },
          { key: 'span."enc"."password"', operator: '=', value: 'host-secret' },
        ],
        range,
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    expect(adHocResponse.error?.message).not.toContain('host-secret');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(reportInteraction).mock.calls)).not.toContain('host-secret');
  });

  it('escapes ordinary quoted and backslash ad-hoc values for HTTP without introducing predicates', async () => {
    const ds = new TempoDatasource(settings);
    await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceqlSearch', filters: [] }],
        filters: [
          { key: 'span.http.route', operator: '=', value: 'say "hello"' },
          { key: 'span.http.path', operator: '=', value: 'C:\\tmp' },
        ],
        range,
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toBe('{span.http.route="say \\"hello\\"" && span.http.path="C:\\\\tmp"}');
  });

  it('keeps pinned enum host variables ordinary without accepting a TraceQL expression', async () => {
    const ds = new TempoDatasource(settings, {
      replace: (value: string) => value.replace('$status', 'error').replace('$kind', 'server'),
    } as unknown as TemplateSrv);
    await lastValueFrom(
      ds.query({
        targets: [
          { refId: 'A', queryType: 'traceql', query: '{status=$status}' },
          { refId: 'B', queryType: 'traceql', query: '{kind=$kind}' },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries.map(({ query }) => query)).toEqual(['{status=error}', '{kind=server}']);
    fetchMock.mockClear();

    const injected = new TempoDatasource(settings, {
      replace: (value: string) => value.replace('$status', 'error || span.enc.password="host-secret"'),
    } as unknown as TemplateSrv);
    const rejected = await lastValueFrom(
      injected.query({
        targets: [{ refId: 'A', queryType: 'traceql', query: '{status=$status}' }],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    expect(rejected.error?.message).not.toContain('host-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps host interpolation callbacks from returning protected plaintext or nested template expansion', async () => {
    const inject = new TempoDatasource(settings, {
      replace: (value: string) => value.replace('$value', '"x" || span.enc.password="host-secret"'),
    } as unknown as TemplateSrv);
    const source = { refId: 'A', queryType: 'traceql', query: '{span.http.route=$value}', filters: [] } as TempoQuery;
    expect(() => inject.applyVariables(source, {})).toThrow();
    expect(() => inject.applyTemplateVariables(source, {})).toThrow();
    expect(() => inject.interpolateVariablesInQueries([source], {})).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const once = new TempoDatasource(settings, {
      replace: (value: string) =>
        value.includes('$value') ? value.replace('$value', '"safe"') : value.replace('"safe"', '"host-secret"'),
    } as unknown as TemplateSrv);
    await lastValueFrom(once.query({ targets: [source], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toBe('{span.http.route="safe"}');
    expect(JSON.stringify(sent)).not.toContain('host-secret');
  });

  it('interpolates a trace ID before validating and preserves it through backend interpolation', async () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const ds = new TempoDatasource(settings, {
      replace: (value: string) => value.replace('$traceId', traceId),
    } as unknown as TemplateSrv);
    await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceId', query: '$traceId' }],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toBe(traceId);
    expect(sent.data.queries[0]).not.toHaveProperty('scopedVars');
  });

  it('routes metrics operators by parsed syntax, not a protected literal containing a metrics function', async () => {
    const ds = new TempoDatasource(settings);
    await ds.importProtectedKey(master);
    const sealed = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc | rate("}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    await lastValueFrom(ds.query({ targets: [sealed], range } as DataQueryRequest<TempoQuery>));
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toContain('| select(span.enc.password)');
    expect(JSON.stringify(sent)).not.toContain('abc | rate(');
  });
  it('allows a sealed dynamic name and harmless ordinary variable but never a host-owned protected RHS', async () => {
    const ds = new TempoDatasource(settings, {
      replace: (value: string) =>
        value.replace('${attribute}', 'enc.password').replace('$service', 'checkout').replace('$value', 'host-secret'),
    } as unknown as TemplateSrv);
    await ds.importProtectedKey(master);
    const dynamic = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.${attribute}="abc"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const mixed = await prepareProtectedQueryModel(
      {
        refId: 'B',
        queryType: 'traceql',
        query: '{span.enc.password="abc" && resource.service.name="$service"}',
        filters: [],
      },
      ds.protectedKey!,
      ds.uid
    );
    await lastValueFrom(ds.query({ targets: [dynamic, mixed], range } as DataQueryRequest<TempoQuery>));
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toContain(`span.enc.password="${attributeEnvelope}"`);
    expect(sent.data.queries[1].query).toContain('resource.service.name="checkout"');
    expect(JSON.stringify(sent)).not.toContain('"abc"');
    fetchMock.mockClear();

    const hostRhs = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.${attribute}="$value"}', filters: [] },
      ds.protectedKey!,
      ds.uid
    );
    const rejected = await lastValueFrom(ds.query({ targets: [hostRhs], range } as DataQueryRequest<TempoQuery>));
    expect(rejected.error?.message).not.toContain('host-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains ordinary escaped array filters and static native-search migration under protection', async () => {
    const ds = new TempoDatasource(settings);
    await lastValueFrom(
      ds.query({
        targets: [
          {
            refId: 'A',
            queryType: 'traceqlSearch',
            filters: [
              {
                id: 'route',
                scope: TraceqlSearchScope.Span,
                tag: 'http.route',
                operator: '=',
                value: ['C:\\tmp'],
                valueType: 'string',
              },
            ],
          },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    const arraySent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(arraySent.data.queries[0].query).toContain('http.route="C:\\\\tmp"');
    fetchMock.mockClear();
    await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceqlSearch', filters: [] }],
        filters: [{ key: 'span:name', operator: '=', value: 'GET' }],
        range,
      } as unknown as DataQueryRequest<TempoQuery>)
    );
    const intrinsic = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(intrinsic.data.queries[0].query).toContain('span:name="GET"');
    fetchMock.mockClear();
    await ds.importProtectedKey(master);
    const sealed = await prepareProtectedQueryModel(
      {
        refId: 'A',
        queryType: 'traceqlSearch',
        filters: [
          {
            id: 'protected',
            scope: TraceqlSearchScope.Span,
            tag: 'enc.password',
            operator: '=',
            value: 'abc',
            valueType: 'string',
          },
        ],
      },
      ds.protectedKey!,
      ds.uid
    );
    await lastValueFrom(
      ds.query({
        targets: [
          {
            ...sealed,
            filters: [
              {
                id: 'route',
                scope: TraceqlSearchScope.Span,
                tag: 'http.route',
                operator: '=',
                value: ['x\\', '|| span.enc.password=', ')} //'],
                valueType: 'string',
              },
              ...sealed.filters,
            ],
          },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    const multi = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(multi.data.queries[0].query).toContain(attributeEnvelope);
    expect(multi.data.queries[0].query).not.toContain('span.enc.password="abc"');
    fetchMock.mockClear();
    await lastValueFrom(
      ds.query({
        targets: [
          {
            refId: 'A',
            queryType: 'nativeSearch',
            search: 'http.route="ready"',
          },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls[0][0])).toContain('ready');
    fetchMock.mockClear();
    const rejected = await lastValueFrom(
      ds.query({
        targets: [
          {
            refId: 'A',
            queryType: 'nativeSearch',
            search: 'enc.password="abc"',
          },
        ],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    expect(rejected.error?.message).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves unconfigured server-valid escapes outside the protected frontend parser', async () => {
    const ds = new TempoDatasource(defaultSettings);
    const serverQuery = '{span.message="line\\nbreak"}';
    await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', queryType: 'traceql', query: serverQuery }],
        range,
      } as DataQueryRequest<TempoQuery>)
    );
    const sent = fetchMock.mock.calls[0][0] as { data: { queries: TempoQuery[] } };
    expect(sent.data.queries[0].query).toBe(serverQuery);
  });
  it('keeps protected substring plaintext out of HTTP, Builder, metrics routing, and telemetry', async () => {
    const ds = new TempoDatasource(
      { ...settings, jsonData: { ...settings.jsonData, protectedAttributesSubstringEnabled: true } },
      identityTemplateSrv
    );
    await ds.importProtectedKey(master);
    await ds.importProtectedKey(Buffer.alloc(32, 7).toString('base64'));
    const raw = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.secret @> "cool"} | count_over_time()', filters: [] },
      ds.protectedKey!, ds.uid, undefined, undefined, true
    );
    const builder = await prepareProtectedQueryModel(
      { refId: 'B', queryType: 'traceqlSearch', filters: [{
        id: 'secret', tag: 'enc.secret', scope: TraceqlSearchScope.Span, operator: '@>', value: 'cool', valueType: 'string',
      }] },
      ds.protectedKey!, ds.uid, undefined, undefined, true
    );
    expect(JSON.stringify([raw, builder])).not.toContain('cool');
    await lastValueFrom(ds.query({ targets: [raw, builder], range } as DataQueryRequest<TempoQuery>));
    const sent = fetchMock.mock.calls.map(([request]) => request as { data: { queries: TempoQuery[] } });
    const body = JSON.stringify(sent);
    expect(body).not.toContain('cool');
    expect(body).not.toContain('qenc:v1:');
    expect(body).toContain('span.\\"bi.secret\\" @> [');
    expect(body).toContain('E_S8rZC-kHLrifr_71XBBSP7w8jOWNCm2j6LHigypgM');
    expect(body).toContain('zQb64aCXnVL2KksfrDxrQwVtdw6Ljmwxv37So9E7ghc');
    expect(sent.flatMap((request) => request.data.queries).find((target) => target.refId === 'B')?.query).toContain('| select(span.enc.secret)');
    expect(JSON.stringify(jest.mocked(reportInteraction).mock.calls)).not.toContain('cool');
  });

  it('fails disabled, keyless, short, host-variable, and array substring requests before HTTP or Live', async () => {
    const ds = new TempoDatasource({ ...settings, jsonData: { ...settings.jsonData, protectedAttributesSubstringEnabled: true } });
    const short = await ds.importProtectedKey(master).then(() => prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.secret @> "ab"}', filters: [] },
      ds.protectedKey!, ds.uid, undefined, undefined, true
    ));
    const response = await lastValueFrom(ds.query({ targets: [short], range } as DataQueryRequest<TempoQuery>));
    expect(response.error?.message).not.toContain('ab');
    expect(fetchMock).not.toHaveBeenCalled();
    ds.clearProtectedKey();
    await lastValueFrom(ds.query({ targets: [short], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).not.toHaveBeenCalled();
    const disabled = new TempoDatasource(settings);
    const old = { refId: 'A', queryType: 'traceql', query: '{span.enc.secret @> "cool"}' } as TempoQuery;
    await lastValueFrom(disabled.query({ targets: [old], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => new TempoDatasource({ ...settings, jsonData: { protectedAttributesSubstringEnabled: true } })).toThrow();
    const source = new TempoDatasource({ ...settings, jsonData: { ...settings.jsonData, protectedAttributesSubstringEnabled: true } },
      { replace: (value: string) => value.replace('$term', 'cool') } as unknown as TemplateSrv);
    await source.importProtectedKey(master);
    const variable = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.secret @> "$term"}', filters: [] },
      source.protectedKey!, source.uid, undefined, undefined, true
    );
    await lastValueFrom(source.query({ targets: [variable], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).not.toHaveBeenCalled();
    await lastValueFrom(source.query({ targets: [{
      refId: 'A', queryType: 'traceqlSearch', filters: [{
        id: 'secret', tag: 'enc.secret', scope: TraceqlSearchScope.Span,
        operator: '@>', value: ['cool'], valueType: 'string',
      }],
    }], range } as DataQueryRequest<TempoQuery>));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('compiles contextual metadata substring without exposing sidecar names or values as suggestions', async () => {
    const ds = new TempoDatasource(
      { ...settings, jsonData: { ...settings.jsonData, protectedAttributesSubstringEnabled: true } },
      identityTemplateSrv
    );
    await ds.importProtectedKey(master);
    const resource = jest.spyOn(ds, 'getResource').mockResolvedValue({ data: { tagValues: [] } });
    ds.languageProvider.setV2Tags([{ name: 'span', tags: ['bi.secret', 'enc.secret', 'http.route'] }]);
    expect(ds.languageProvider.getTags(TraceqlSearchScope.Span)).toEqual(['enc.secret', 'http.route']);
    await ds.metadataRequest('tag-values', { tag: 'span.http.route', q: '{span.enc.secret @> "cool"}' });
    expect(resource).toHaveBeenCalledWith('tag-values', expect.objectContaining({
      q: expect.stringContaining('span."bi.secret" @> ['),
    }), expect.anything());
    expect(JSON.stringify(resource.mock.calls)).not.toContain('cool');
    resource.mockClear();
    await expect(ds.metadataRequest('tag-values', { tag: 'span.bi.secret' })).rejects.toThrow();
    await expect(ds.metadataRequest('tag-values', { tag: 'resource.bi.secret' })).rejects.toThrow();
    await expect(ds.metadataRequest('tag-values', { tag: 'span.http.route', q: '{span.enc.secret @> "ab"}' })).rejects.toThrow();
    expect(resource).not.toHaveBeenCalled();
    expect(await ds.getTagKeys({ timeRange: range } as never)).not.toEqual(expect.arrayContaining([{ text: 'span.bi.secret' }]));
  });
  it('routes compiled substring metrics and search through separate Live channels without plaintext', async () => {
    const stream = jest.fn((_request: unknown) => of({}));
    jest.mocked(getGrafanaLiveSrv).mockReturnValue({ getStream: stream } as never);
    config.liveEnabled = true;
    const ds = new TempoDatasource({ ...settings, jsonData: {
      ...settings.jsonData, protectedAttributesSubstringEnabled: true, streamingEnabled: { search: true },
    } }, identityTemplateSrv);
    ds.streamingEnabled = { search: true, metrics: true };
    await ds.importProtectedKey(master);
    const search = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.secret @> "cool"}', filters: [] },
      ds.protectedKey!, ds.uid, undefined, undefined, true
    );
    const metrics = await prepareProtectedQueryModel(
      { refId: 'B', queryType: 'traceql', query: '{span.enc.secret @> "cool"} | count_over_time()', filters: [] },
      ds.protectedKey!, ds.uid, undefined, undefined, true
    );
    await lastValueFrom(ds.query({ targets: [search, metrics], range, app: CoreApp.Explore } as DataQueryRequest<TempoQuery>));
    const calls = stream.mock.calls.map(([request]) => request as { path: string; data: TempoQuery });
    expect(calls.map((call) => call.path.split('/')[0]).sort()).toEqual(['metrics', 'search']);
    for (const call of calls) {
      expect(JSON.stringify(call.data)).not.toContain('cool');
      expect(JSON.stringify(call.data)).not.toContain('qenc:v1:');
      expect(call.data.query).toContain('span."bi.secret" @> [');
    }
    expect(calls.find((call) => call.path.startsWith('search/'))?.data.query).toContain('| select(span.enc.secret)');
    expect(calls.find((call) => call.path.startsWith('metrics/'))?.data.query).not.toContain('| select(');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
