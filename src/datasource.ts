import { groupBy } from 'lodash';
import { EMPTY, defer, from, merge, type Observable, of } from 'rxjs';
import { catchError, concatMap, finalize, map, mergeMap, toArray } from 'rxjs/operators';

import {
  CoreApp,
  type DataFrame,
  type DataFrameDTO,
  type DataFrameJSON,
  type DataLink,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataQueryResponseData,
  type DataSourceGetTagKeysOptions,
  type DataSourceGetTagValuesOptions,
  type DataSourceInstanceSettings,
  dateTime,
  FieldType,
  LoadingState,
  MetricFindValue,
  NodeGraphDataFrameFieldNames,
  rangeUtil,
  type ScopedVars,
  type SelectableValue,
  type TestDataSourceResponse,
  type TimeRange,
} from '@grafana/data';
import { type NodeGraphOptions, type SpanBarOptions, type TraceToLogsOptions } from '@grafana/o11y-ds-frontend';
import {
  config,
  DataSourceWithBackend,
  getDataSourceSrv,
  getTemplateSrv,
  reportInteraction,
  type TemplateSrv,
} from '@grafana/runtime';
import { BarGaugeDisplayMode, TableCellDisplayMode, VariableFormatID } from '@grafana/schema';

import { interpolateFilters } from './SearchTraceQLEditor/utils';
import { type TempoVariableQuery, TempoVariableQueryType } from './VariableQueryEditor';
import { type PrometheusDatasource, type PromQuery } from './_importedDependencies/datasources/prometheus/types';
import { type TagLimitOptions } from './configuration/TagLimitSettings';
import { type TraceqlFilter, TraceqlSearchScope } from './dataquery';
import {
  defaultTableFilter,
  durationMetric,
  errorRateMetric,
  failedMetric,
  histogramMetric,
  nativeHistogramMetric,
  mapPromMetricsToServiceMap,
  rateMetric,
  serviceMapMetrics,
  totalsMetric,
  nativeHistogramDurationMetric,
} from './graphTransform';
import { importKey, type ProtectedAttributeKey } from './protectedAttributes/crypto';
import { registerProtectedDisplayMode, setProtectedDisplayKey } from './protectedAttributes/display';
import {
  assertProtectedQueryModelSafe,
  assertStaticProtectedFilterDefaultsSafe,
  classifyProtectedFilter,
  isProtectedTagValueRequest,
  isVariableBearing,
  openProtectedQueryModel,
} from './protectedAttributes/model';
import { classifyProtectedTraceQL, isMetricsTraceQL, rewriteProtectedTraceQL } from './protectedAttributes/traceql';
import TempoLanguageProvider from './language_provider';
import {
  enhanceTraceQlMetricsResponse,
  transformFromOTLP as transformFromOTEL,
  transformTrace,
} from './resultTransformer';
import { doTempoMetricsStreaming, doTempoSearchStreaming } from './streaming';
import { type TempoJsonData, type TempoQuery } from './types';
import { getErrorMessage, mapErrorMessage, migrateFromSearchToTraceQLSearch } from './utils';
import { enumIntrinsics, intrinsics, operators } from './traceql/traceql';
import { TempoVariableSupport } from './variables';

export const DEFAULT_LIMIT = 20;
export const DEFAULT_SPSS = 3; // spans per span set

export enum FeatureName {
  searchStreaming = 'searchStreaming',
  metricsStreaming = 'metricsStreaming',
}

/* Map, for each feature (e.g., streaming), the minimum Tempo version required to have that
 ** feature available. If the running Tempo instance on the user's backend is older than the
 ** target version, the feature is disabled in Grafana (frontend).
 */
export const featuresToTempoVersion = {
  [FeatureName.searchStreaming]: '2.2.0',
  [FeatureName.metricsStreaming]: '2.7.0',
};

interface ServiceMapQueryResponse {
  nodes: DataFrame;
  edges: DataFrame;
}

interface ServiceMapQueryResponseWithRates {
  rates: Array<DataFrame | DataFrameDTO>;
  nodes: DataFrame;
  edges: DataFrame;
}

interface TempoQueryMetrics {
  success: boolean;
  streaming?: boolean;
  latencyMs: number;
  query?: string;
  error?: string;
  statusCode?: number;
  statusText?: string;
}
// Tracks sanitized requests without placing a protection flag on the HTTP/Live payload.
const protectedRequests = new WeakSet<DataQueryRequest<TempoQuery>>();
const templateReference = /\$\{[^}]+\}|\$[A-Za-z_]\w*|\[\[[^\]]+\]\]/g;
const attributeName = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
const staticTraceQLValue =
  /^(?:"(?:\\["\\]|[^"\\\u0000-\u001f\u007f])*"|-?(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|ms|s|m|h|d|w)?|true|false|nil)$/;
const enumRhs = /(?:^|[({&|])\s*((?:span:)?(?:kind|status))\s*(?:=|!=)\s*$/;
const kindValue = /^(?:server|client|producer|consumer|internal)$/;
const statusValue = /^(?:ok|error|unset)$/;

function isSafeEnumRhs(source: string, start: number, value: string): boolean {
  const field = enumRhs.exec(source.slice(0, start))?.[1];
  return (
    !!field &&
    enumIntrinsics.includes(field) &&
    (field.endsWith('kind') ? kindValue.test(value) : statusValue.test(value))
  );
}
// SDK re-applies template variables to every target passed to super.query.
// Identity, rather than an on-wire marker, distinguishes already compiled targets.
const preparedTargets = new WeakSet<TempoQuery>();

function assertHostAdHocFilterSourcesSafe(filters: DataQueryRequest<TempoQuery>['filters']): void {
  for (const filter of filters ?? []) {
    if (
      (!attributeName.test(filter.key) && !intrinsics.includes(filter.key)) ||
      isProtectedTagValueRequest(filter.key) ||
      isVariableBearing(filter.key) ||
      !operators.includes(filter.operator) ||
      typeof filter.value !== 'string' ||
      /[\u0000-\u001f\u007f]/.test(filter.value) ||
      isVariableBearing(filter.value) ||
      (enumIntrinsics.includes(filter.key) && !/^[\p{L}\p{N}_-]+$/u.test(filter.value))
    ) {
      throw new Error('Protected ad-hoc filters are not supported.');
    }
  }
}
function assertLegacyProtectedSearchSafe(query: TempoQuery, kid?: string): void {
  const { search, spanName, serviceName, minDuration, maxDuration, ...current } = query;
  assertProtectedQueryModelSafe(current as TempoQuery, kid);
  if ([spanName, serviceName, minDuration, maxDuration, search].some((value) => value && isVariableBearing(value))) {
    throw new Error('Legacy host-variable search values cannot be protected.');
  }
  if (search) {
    for (const term of search.trim().split(/\s+/)) {
      const equal = term.indexOf('=');
      const name = term.slice(0, equal);
      if (
        equal <= 0 ||
        equal === term.length - 1 ||
        term.indexOf('=', equal + 1) !== -1 ||
        !attributeName.test(name) ||
        isProtectedTagValueRequest(name) ||
        /^(?:span|resource|event|link|instrumentation)\.enc\./.test(name)
      ) {
        throw new Error('Legacy search must be migrated before running a protected query.');
      }
    }
  }
  assertProtectedQueryModelSafe(migrateFromSearchToTraceQLSearch(query), kid);
}

function assertProtectedSavedModelSafe(query: TempoQuery, kid?: string): void {
  if (query.queryType === 'nativeSearch') {
    assertLegacyProtectedSearchSafe(query, kid);
  } else if (query.queryType === 'traceId' && query.query && !/^[0-9a-f]+$/i.test(query.query.trim())) {
    // A trace-ID template is safe to keep in a host model only as the entire ID.
    // Its result is hex-validated before it reaches the SDK or transport.
    if (!/^(?:\$\{[^}]+\}|\$[A-Za-z_]\w*|\[\[[^\]]+\]\])$/.test(query.query.trim())) {
      throw new Error('Invalid trace ID query.');
    }
    assertProtectedQueryModelSafe({ ...query, query: '' }, kid);
  } else {
    assertProtectedQueryModelSafe(query, kid);
  }
}

function replaceSafeTraceQLTemplate(
  source: string,
  replace: (value: string) => string,
  allowProtectedName = false
): string {
  const original = classifyProtectedTraceQL(source);
  let quoted = false;
  let escaped = false;
  let scanned = 0;
  let reconstructed = '';
  const hostValues: Array<{ from: number; to: number }> = [];
  for (const match of source.matchAll(templateReference)) {
    const start = match.index;
    for (let i = scanned; i < start; i++) {
      if (escaped) {
        escaped = false;
      } else if (source[i] === '\\' && quoted) {
        escaped = true;
      } else if (source[i] === '"') {
        quoted = !quoted;
      }
    }
    const end = start + match[0].length;
    const value = replace(match[0]);
    const namePosition =
      !quoted &&
      (source[start - 1] === '.' || source[end] === '.' || /^(?:\s*)(?:=~|!~|!=|>=|<=|=|>|<)/.test(source.slice(end)));
    if (namePosition) {
      if (!attributeName.test(value) || (!allowProtectedName && /(?:^|\.)enc\./.test(value))) {
        throw new Error('A host variable cannot introduce a protected attribute name.');
      }
    } else if (
      original.protectedRhsRanges.some(({ from, to }) => start >= from && end <= to) ||
      (quoted
        ? /["\\\u0000-\u001f\u007f]/.test(value)
        : !staticTraceQLValue.test(value) && !isSafeEnumRhs(source, start, value))
    ) {
      throw new Error('A host variable cannot introduce a protected query expression.');
    }
    const replacementStart = reconstructed.length + start - scanned;
    reconstructed += source.slice(scanned, start) + value;
    if (!namePosition) {
      hostValues.push({ from: replacementStart, to: replacementStart + value.length });
    }
    scanned = end;
  }
  reconstructed += source.slice(scanned);
  const final = replace(source);
  // A template service may expand nested references or nonstandard tokens.
  // Neither is safe unless it is exactly the checked, single-pass substitution.
  if (final !== reconstructed) {
    throw new Error('A host variable cannot introduce a protected query expression.');
  }
  const expanded = classifyProtectedTraceQL(final);
  if (hostValues.some(({ from, to }) => expanded.protectedRhsRanges.some((rhs) => from >= rhs.from && to <= rhs.to))) {
    throw new Error('A protected query value cannot come from a host variable.');
  }
  return final;
}

export class TempoDatasource extends DataSourceWithBackend<TempoQuery, TempoJsonData> {
  tracesToLogs?: TraceToLogsOptions;
  serviceMap?: {
    datasourceUid?: string;
  };
  search?: {
    hide?: boolean;
    filters?: TraceqlFilter[];
  };
  nodeGraph?: NodeGraphOptions;
  traceQuery?: {
    timeShiftEnabled?: boolean;
    spanStartTimeShift?: string;
    spanEndTimeShift?: string;
  };
  uploadedJson?: string | null = null;
  spanBar?: SpanBarOptions;
  tagLimit?: TagLimitOptions;
  languageProvider: TempoLanguageProvider;

  streamingEnabled?: {
    search?: boolean;
    metrics?: boolean;
  };

  timeRangeForTags?: number;
  private importedProtectedKey?: ProtectedAttributeKey;
  private keyEpoch = 0;
  private importGeneration = 0;
  private readonly keyListeners = new Set<(epoch: number) => void>();

  get protectedKey(): ProtectedAttributeKey | undefined {
    return this.importedProtectedKey;
  }

  get protectedKeyEpoch(): number {
    return this.keyEpoch;
  }

  subscribeProtectedKey(listener: (epoch: number) => void): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  async importProtectedKey(base64: string): Promise<string> {
    if (!this.instanceSettings.jsonData.protectedAttributesEnabled) {
      throw new Error('Protected attributes must be enabled before importing a key.');
    }
    const generation = ++this.importGeneration;
    const next = await importKey(base64);
    if (generation !== this.importGeneration || !this.instanceSettings.jsonData.protectedAttributesEnabled) {
      next.clear();
      throw new Error('Protected key import was superseded.');
    }
    const previous = this.importedProtectedKey;
    this.importedProtectedKey = next;
    setProtectedDisplayKey(this, next.kid, next);
    previous?.clear();
    this.notifyProtectedKeyChange();
    return next.kid;
  }

  clearProtectedKey(): void {
    this.importGeneration++;
    const currentKid = this.importedProtectedKey?.kid;
    this.importedProtectedKey?.clear();
    this.importedProtectedKey = undefined;
    setProtectedDisplayKey(this, currentKid);
    this.notifyProtectedKeyChange();
  }

  private notifyProtectedKeyChange(): void {
    this.keyEpoch++;
    for (const listener of this.keyListeners) {
      listener(this.keyEpoch);
    }
  }

  constructor(
    public instanceSettings: DataSourceInstanceSettings<TempoJsonData>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv()
  ) {
    super(instanceSettings);
    if ('protectedKeyId' in instanceSettings.jsonData && !instanceSettings.jsonData.protectedAttributesEnabled) {
      throw new Error('Legacy protected key configuration requires enabling protected attributes before use.');
    }
    if (instanceSettings.jsonData.protectedAttributesEnabled) {
      registerProtectedDisplayMode();
    }

    this.tracesToLogs = instanceSettings.jsonData.tracesToLogs;
    this.serviceMap = instanceSettings.jsonData.serviceMap;
    this.search = instanceSettings.jsonData.search;
    this.nodeGraph = instanceSettings.jsonData.nodeGraph;
    this.traceQuery = instanceSettings.jsonData.traceQuery;
    this.streamingEnabled = instanceSettings.jsonData.streamingEnabled;
    this.timeRangeForTags = parseTimeRangeForTags(instanceSettings.jsonData.timeRangeForTags);
    this.languageProvider = new TempoLanguageProvider(this);

    if (!this.search?.filters) {
      this.search = {
        ...this.search,
        filters: [
          {
            id: 'service-name',
            tag: 'service.name',
            operator: '=',
            scope: TraceqlSearchScope.Resource,
          },
          { id: 'span-name', tag: 'name', operator: '=', scope: TraceqlSearchScope.Span },
        ],
      };
    }

    this.variables = new TempoVariableSupport(this);
  }

  async executeVariableQuery(query: TempoVariableQuery, range?: TimeRange) {
    // Avoid failing if the user did not select the query type (label names, label values, etc.)
    if (query.type === undefined) {
      return new Promise<Array<{ text: string }>>(() => []);
    }

    switch (query.type) {
      case TempoVariableQueryType.LabelNames: {
        return await this.labelNamesQuery(range);
      }
      case TempoVariableQueryType.LabelValues: {
        return this.labelValuesQuery(query.label, range);
      }
      default: {
        throw Error('Invalid query type: ' + query.type);
      }
    }
  }

  async labelNamesQuery(range?: TimeRange): Promise<Array<{ text: string }>> {
    await this.languageProvider.start(range, this.timeRangeForTags);
    const tags = this.languageProvider.getAutocompleteTags();
    return tags
      .filter(
        (tag): tag is string =>
          tag !== undefined &&
          (!this.instanceSettings.jsonData.protectedAttributesEnabled || !isProtectedTagValueRequest(tag))
      )
      .map((tag) => ({ text: tag }));
  }

  async labelValuesQuery(labelName?: string, range?: TimeRange): Promise<Array<{ text: string }>> {
    if (
      !labelName ||
      (this.instanceSettings.jsonData.protectedAttributesEnabled && isProtectedTagValueRequest(labelName))
    ) {
      return [];
    }

    await this.languageProvider.start(range, this.timeRangeForTags);

    // Retrieve the scope of the tag
    // Example: given `http.status_code`, we want scope `span`
    // Note that we ignore possible name clashes, e.g., `http.status_code` in both `span` and `resource`
    const scope: string | undefined = (this.languageProvider.tagsV2 || [])
      // flatten the Scope objects
      .flatMap((tagV2) => tagV2.tags.map((tag) => ({ scope: tagV2.name, name: tag })))
      // find associated scope
      .find((tag) => tag.name === labelName)?.scope;
    if (!scope) {
      throw Error(`Scope for tag ${labelName} not found`);
    }

    // For V2, we need to send scope and tag name, e.g. `span.http.status_code`,
    // unless the tag has intrinsic scope
    const scopeAndTag = scope === 'intrinsic' ? labelName : `${scope}.${labelName}`;
    const options = await this.languageProvider.getOptionsV2({
      tag: scopeAndTag,
      timeRangeForTags: this.timeRangeForTags,
      range,
    });

    return options.flatMap((option: SelectableValue<string>) =>
      option.value !== undefined ? [{ text: option.value }] : []
    );
  }

  // Allows to retrieve the list of tags for ad-hoc filters
  async getTagKeys(options: DataSourceGetTagKeysOptions<TempoQuery>): Promise<Array<{ text: string }>> {
    await this.languageProvider.fetchTags(this.timeRangeForTags, options?.timeRange ?? undefined);
    const tags = this.languageProvider.tagsV2 || [];
    return tags
      .map(({ name, tags }) =>
        tags.filter((tag) => tag !== undefined).map((tag) => (name !== 'intrinsic' ? `${name}.${tag}` : `${tag}`))
      )
      .flat()
      .filter((tag) => !this.instanceSettings.jsonData.protectedAttributesEnabled || !isProtectedTagValueRequest(tag))
      .map((tag) => ({ text: tag }));
  }

  // Allows to retrieve the list of tag values for ad-hoc filters
  getTagValues(options: DataSourceGetTagValuesOptions<TempoQuery>): Promise<MetricFindValue[]> {
    if (this.instanceSettings.jsonData.protectedAttributesEnabled) {
      try {
        assertHostAdHocFilterSourcesSafe(options.filters);
        if (
          (!attributeName.test(options.key) && !intrinsics.includes(options.key)) ||
          isProtectedTagValueRequest(options.key) ||
          isVariableBearing(options.key)
        ) {
          return Promise.resolve([]);
        }
        const query = this.languageProvider.generateQueryFromFilters({ adhocFilters: options.filters });
        return this.tagValuesQuery(options.key, query, options?.timeRange ?? undefined);
      } catch {
        return Promise.resolve([]);
      }
    }
    const query = this.languageProvider.generateQueryFromFilters({ adhocFilters: options.filters });
    return this.tagValuesQuery(options.key, query, options?.timeRange ?? undefined);
  }

  async tagValuesQuery(tag: string, query: string, range?: TimeRange): Promise<MetricFindValue[]> {
    if (this.instanceSettings.jsonData.protectedAttributesEnabled) {
      if (isProtectedTagValueRequest(tag) || typeof query !== 'string') {
        return [];
      }
      try {
        const classification = classifyProtectedTraceQL(query);
        if (classification.protectedReferences || classification.dynamicReferences || isVariableBearing(query)) {
          return [];
        }
      } catch {
        return [];
      }
    }
    // For V2, we need to send scope and tag name, e.g. `span.http.status_code`,
    // unless the tag has intrinsic scope
    const options = await this.languageProvider.getOptionsV2({
      tag,
      query,
      timeRangeForTags: this.timeRangeForTags,
      range,
    });

    return options.flatMap((option: SelectableValue<string>) =>
      option.value !== undefined ? [{ text: option.value, ...this.getTagValueProperties(option) }] : []
    );
  }

  // TODO: Implement this function in Prometheus datasource https://github.com/grafana/grafana/issues/109706
  async getNativeHistograms(timeRange?: TimeRange): Promise<boolean> {
    if (!this.serviceMap?.datasourceUid) {
      return false;
    }

    // remove _bucket from the metric name to get the native histogram metric name
    const metricName = histogramMetric.replace('_bucket', '');

    try {
      // Get the Prometheus datasource instance
      const promDs = await getDataSourceSrv().get(this.serviceMap.datasourceUid);
      // Use provided time range or default to last hour
      const from = timeRange?.from || dateTime().subtract(1, 'hour');
      const to = timeRange?.to || dateTime();

      // Convert to Unix timestamps (seconds since epoch)
      const start = Math.floor(from.valueOf() / 1000);
      const end = Math.floor(to.valueOf() / 1000);

      // Use the series endpoint to check if native histogram metrics exist
      // this has a 90% chance of returning correctly due to sparse data
      if (!('metadataRequest' in promDs) || typeof promDs.metadataRequest !== 'function') {
        return false;
      }

      const seriesResult = await promDs.metadataRequest('/api/v1/series', {
        'match[]': metricName,
        limit: 1,
        start: start,
        end: end,
      });

      // Check if any native histogram series exist
      const seriesData = seriesResult?.data?.data;
      if (seriesData && Array.isArray(seriesData)) {
        // If the series array has any entries, native histograms exist
        return seriesData.length > 0;
      }

      return false;
    } catch (error) {
      console.warn('Failed to check for native histograms:', error);
      return false;
    }
  }

  /**
   * Check if streaming for search queries is enabled (and available).
   *
   * We need to check:
   * - the Tempo data source plugin toggle, to disable streaming if the user disabled it in the data source configuration
   * - if Grafana Live is enabled
   *
   * @return true if streaming for search queries is enabled, false otherwise
   */
  isStreamingSearchEnabled() {
    return this.streamingEnabled?.search && config.liveEnabled;
  }
  /**
   * Check if streaming for metrics queries is enabled (and available).
   *
   * We need to check:
   * - the Tempo data source plugin toggle, to disable streaming if the user disabled it in the data source configuration
   * - if Grafana Live is enabled
   *
   * @return true if streaming for metrics queries is enabled, false otherwise
   */
  isStreamingMetricsEnabled() {
    return this.streamingEnabled?.metrics && config.liveEnabled;
  }

  isTraceQlMetricsQuery(query: string): boolean {
    if (this.instanceSettings.jsonData.protectedAttributesEnabled) {
      return isMetricsTraceQL(query);
    }
    // Tempo's server grammar accepts valid queries beyond the pinned frontend parser.
    const metricsFnRegex =
      /\|\s*(rate|count_over_time|avg_over_time|max_over_time|min_over_time|sum_over_time|quantile_over_time|histogram_over_time|compare)\s*\(/;
    return !!query.trim().match(metricsFnRegex);
  }

  isTraceIdQuery(query: string): boolean {
    const hexOnlyRegex = /^[0-9A-Fa-f]*$/;
    // Check whether this is a trace ID or traceQL query by checking if it only contains hex characters
    return !!query.trim().match(hexOnlyRegex);
  }

  query(options: DataQueryRequest<TempoQuery>): Observable<DataQueryResponse> {
    return defer(() =>
      from(this.prepareTargets(options)).pipe(mergeMap((prepared) => this.dispatchPreparedQueries(prepared)))
    ).pipe(
      catchError((error) =>
        of({
          error: {
            message: this.instanceSettings.jsonData.protectedAttributesEnabled
              ? 'The protected query could not be prepared. Check the query and imported key.'
              : getErrorMessage(error?.message),
          },
          data: [],
        })
      )
    );
  }

  private async prepareTargets(options: DataQueryRequest<TempoQuery>): Promise<DataQueryRequest<TempoQuery>> {
    const protectedEnabled = !!this.instanceSettings.jsonData.protectedAttributesEnabled;
    const originalTargets = options.targets.filter((target) => !target.hide);
    const key = this.protectedKey;
    const keyEpoch = this.keyEpoch;
    if (protectedEnabled) {
      assertStaticProtectedFilterDefaultsSafe(this.search?.filters ?? []);
      for (const target of originalTargets) {
        assertProtectedSavedModelSafe(target, key?.kid);
      }
    }

    // Ad-hoc filters are persisted by Grafana, outside the plugin's model-sealing gate.
    // Never use a protected or variable-bearing host-owned filter as a query source.
    if (protectedEnabled && options.filters?.length) {
      assertHostAdHocFilterSourcesSafe(options.filters);
      const adHoc = this.languageProvider.generateQueryFromFilters({ adhocFilters: options.filters });
      const classification = classifyProtectedTraceQL(adHoc);
      if (classification.protectedReferences || classification.dynamicReferences || isVariableBearing(adHoc)) {
        throw new Error('Protected ad-hoc filters are not supported.');
      }
    }

    const targets = await Promise.all(
      originalTargets.map(async (original) => {
        const migrated = original.queryType === 'nativeSearch' ? migrateFromSearchToTraceQLSearch(original) : original;
        const traceIdTemplate =
          protectedEnabled && migrated.queryType === 'traceId' && isVariableBearing(migrated.query ?? '');
        const opened = protectedEnabled
          ? await openProtectedQueryModel(traceIdTemplate ? { ...migrated, query: '' } : migrated, key, this.uid)
          : migrated;
        let query = traceIdTemplate ? (migrated.query ?? '') : (opened.query ?? '');
        let queryType = opened.queryType || 'traceql';

        if (queryType === 'traceqlSearch') {
          if (opened.groupBy?.length) {
            throw new Error('The aggregate by query is deprecated. Please remove it and create a new query.');
          }
          const filters = protectedEnabled
            ? (opened.filters ?? []).map((filter) => ({
                ...filter,
                scope: filter.scope
                  ? (this.templateSrv.replace(filter.scope, options.scopedVars ?? {}) as TraceqlSearchScope)
                  : filter.scope,
                tag: this.templateSrv.replace(filter.tag ?? '', options.scopedVars ?? {}),
                value: Array.isArray(filter.value)
                  ? filter.value.map((value) =>
                      this.templateSrv.replace(value, options.scopedVars ?? {}, VariableFormatID.Pipe)
                    )
                  : filter.value === undefined
                    ? undefined
                    : this.templateSrv.replace(filter.value, options.scopedVars ?? {}, VariableFormatID.Pipe),
              }))
            : this.applyVariables(opened, options.scopedVars ?? {}).filters;
          if (protectedEnabled) {
            for (const [index, filter] of filters.entries()) {
              if (filter.value === undefined) {
                continue;
              }
              const savedFilter = opened.filters?.[index];
              if (
                (isVariableBearing(savedFilter?.tag ?? '') || isVariableBearing(String(savedFilter?.scope ?? ''))) &&
                (!attributeName.test(filter.tag ?? '') || !attributeName.test(String(filter.scope ?? '')))
              ) {
                throw new Error('A host variable cannot introduce a query expression through a filter name.');
              }
              const effective = classifyProtectedFilter(filter);
              if (effective.protectedReference && filter.value !== undefined) {
                const savedValue = migrated.filters?.[index]?.value;
                const savedValues = Array.isArray(savedValue) ? savedValue : [savedValue];
                const openedValue = opened.filters?.[index]?.value;
                const actualValues = Array.isArray(filter.value) ? filter.value : [filter.value];
                const plainValues = Array.isArray(openedValue) ? openedValue : [openedValue];
                if (
                  savedValues.some((value) => typeof value !== 'string' || !value.startsWith('qenc:v1:')) ||
                  plainValues.some(
                    (value, item) =>
                      typeof value !== 'string' || isVariableBearing(value) || value !== actualValues[item]
                  )
                ) {
                  throw new Error('A protected filter value must come from a sealed model, not a host variable.');
                }
              } else if (!effective.protectedReference) {
                assertProtectedQueryModelSafe(
                  { refId: original.refId, queryType: 'traceqlSearch', filters: [filter] },
                  key?.kid
                );
              }
            }
          }
          query = this.languageProvider.generateQueryFromFilters({
            traceqlFilters: filters,
            adhocFilters: options.filters,
          });
        } else if (queryType === 'traceql') {
          const source = opened.query ?? '';
          query = this.isTraceIdQuery(source)
            ? source
            : protectedEnabled && source
              ? replaceSafeTraceQLTemplate(
                  source,
                  (value) => this.templateSrv.replace(value, options.scopedVars ?? {}, VariableFormatID.Pipe),
                  migrated.query?.startsWith('qenc:v1:') ?? false
                )
              : this.templateSrv.replace(source, options.scopedVars ?? {}, VariableFormatID.Pipe);
        } else if (queryType === 'traceId' && query) {
          query = this.templateSrv.replace(query, options.scopedVars ?? {}, VariableFormatID.Pipe);
        }
        if (queryType === 'traceId' && (!query || !this.isTraceIdQuery(query))) {
          throw new Error('Invalid trace ID query.');
        }

        if (
          protectedEnabled &&
          (queryType === 'traceql' || queryType === 'traceqlSearch') &&
          query &&
          !this.isTraceIdQuery(query)
        ) {
          query = await rewriteProtectedTraceQL(query, key, this.isTraceQlMetricsQuery(query) ? 'metrics' : 'search');
        }
        // Only backend/Live protocol fields cross the boundary, never editor, legacy,
        // ad-hoc, qenc, or arbitrary host model properties.
        return {
          refId: original.refId,
          datasource: this.getRef(),
          queryType,
          query:
            queryType === 'traceql' || queryType === 'traceqlSearch' || queryType === 'traceId' ? query : undefined,
          limit: opened.limit,
          spss: opened.spss,
          tableType: opened.tableType,
          step: opened.step,
          exemplars: opened.exemplars,
          metricsQueryType: opened.metricsQueryType,
          ...(queryType === 'serviceMap' && {
            serviceMapQuery: this.applyVariables(opened, options.scopedVars ?? {}).serviceMapQuery,
            serviceMapUseNativeHistograms: opened.serviceMapUseNativeHistograms,
            serviceMapIncludeNamespace: opened.serviceMapIncludeNamespace,
          }),
        } as TempoQuery;
      })
    );
    if (protectedEnabled && (this.keyEpoch !== keyEpoch || this.protectedKey !== key)) {
      throw new Error('Protected key changed during query preparation.');
    }
    for (const target of targets) {
      preparedTargets.add(target);
    }
    const { requestId, interval, intervalMs, maxDataPoints, range, timezone, app, startTime } = options;
    const request = {
      requestId,
      interval,
      intervalMs,
      maxDataPoints,
      range,
      timezone,
      app,
      startTime,
      targets,
    } as DataQueryRequest<TempoQuery>;
    if (protectedEnabled) {
      protectedRequests.add(request);
    }
    return request;
  }

  private dispatchPreparedQueries(options: DataQueryRequest<TempoQuery>): Observable<DataQueryResponse> {
    const subQueries: Array<Observable<DataQueryResponse>> = [];
    const targets: { [type: string]: TempoQuery[] } = groupBy(options.targets, (t) => t.queryType || 'traceql');
    if (targets.clear) {
      return of({ data: [], state: LoadingState.Done });
    }
    const searchTargets = [...(targets.traceqlSearch ?? [])];
    const traceIdTargets: TempoQuery[] = [...(targets.traceId ?? [])];
    const metricsTargets: TempoQuery[] = [];
    for (const target of targets.traceql ?? []) {
      if (this.isTraceIdQuery(target.query ?? '')) {
        traceIdTargets.push(target);
      } else if (this.isTraceQlMetricsQuery(target.query ?? '')) {
        metricsTargets.push(target);
      } else {
        searchTargets.push(target);
      }
    }

    if (traceIdTargets.length) {
      reportInteraction('grafana_traces_traceID_queried', {
        datasourceType: 'tempo',
        app: options.app ?? '',
        grafana_version: config.buildInfo.version,
        hasQuery: traceIdTargets.some((target) => !!target.query),
      });
      subQueries.push(this.handleTraceIdQuery(options, traceIdTargets, traceIdTargets[0].query ?? ''));
    }
    if (metricsTargets.length) {
      const useStreaming =
        this.isStreamingMetricsEnabled() &&
        options.app !== CoreApp.CloudAlerting &&
        options.app !== CoreApp.UnifiedAlerting &&
        options.app !== 'grafana-assistant-app';
      reportInteraction('grafana_traces_traceql_metrics_queried', {
        datasourceType: 'tempo',
        app: options.app ?? '',
        grafana_version: config.buildInfo.version,
        ...(!this.instanceSettings.jsonData.protectedAttributesEnabled && { query: metricsTargets[0].query ?? '' }),
        streaming: useStreaming,
      });
      subQueries.push(
        useStreaming
          ? this.handleMetricsStreamingQuery(options, metricsTargets, metricsTargets[0].query ?? '')
          : this.handleTraceQlMetricsQuery(options, metricsTargets, metricsTargets[0].query ?? '')
      );
    }
    if (searchTargets.length) {
      const useStreaming = this.isStreamingSearchEnabled() && options.app !== 'grafana-assistant-app';
      reportInteraction(
        searchTargets[0].queryType === 'traceqlSearch'
          ? 'grafana_traces_traceql_search_queried'
          : 'grafana_traces_traceql_queried',
        {
          datasourceType: 'tempo',
          app: options.app ?? '',
          grafana_version: config.buildInfo.version,
          ...(!this.instanceSettings.jsonData.protectedAttributesEnabled && { query: searchTargets[0].query ?? '' }),
          streaming: useStreaming,
        }
      );
      subQueries.push(
        useStreaming
          ? this.handleStreamingQuery(options, searchTargets, searchTargets[0].query ?? '')
          : this.handleTraceQlQuery(options, { traceql: searchTargets })
      );
    }
    // Upload
    if (targets.upload?.length) {
      if (this.uploadedJson) {
        reportInteraction('grafana_traces_json_file_uploaded', {
          datasourceType: 'tempo',
          app: options.app ?? '',
          grafana_version: config.buildInfo.version,
        });

        const jsonData = JSON.parse(this.uploadedJson);
        const isTraceData = jsonData.batches;
        const isServiceGraphData =
          Array.isArray(jsonData) && jsonData.some((df) => df?.meta?.preferredVisualisationType === 'nodeGraph');

        if (isTraceData) {
          subQueries.push(of(transformFromOTEL(jsonData.batches, this.nodeGraph?.enabled)));
        } else if (isServiceGraphData) {
          subQueries.push(of({ data: jsonData, state: LoadingState.Done }));
        } else {
          subQueries.push(of({ error: { message: 'Unable to parse uploaded data.' }, data: [] }));
        }
      } else {
        subQueries.push(of({ data: [], state: LoadingState.Done }));
      }
    }

    // Service Map
    if (this.serviceMap?.datasourceUid && targets.serviceMap?.length > 0) {
      reportInteraction('grafana_traces_service_graph_queried', {
        datasourceType: 'tempo',
        app: options.app ?? '',
        grafana_version: config.buildInfo.version,
        hasServiceMapQuery: targets.serviceMap[0].serviceMapQuery ? true : false,
      });

      const { datasourceUid } = this.serviceMap;

      // if the query contains the serviceMapUseNativeHistograms flag,
      // then use the native histograms
      const useNativeHistogram = options.targets[0].serviceMapUseNativeHistograms;

      const tempoDsUid = this.uid;
      subQueries.push(
        serviceMapQuery(options, datasourceUid, tempoDsUid, useNativeHistogram).pipe(
          concatMap((result) =>
            rateQuery(options, result, datasourceUid).pipe(
              concatMap((result) =>
                errorAndDurationQuery(options, result, datasourceUid, tempoDsUid, useNativeHistogram)
              )
            )
          )
        )
      );
    }

    return merge(...subQueries).pipe(
      map((response) => {
        if (protectedRequests.has(options) && (response.error || response.errors?.length)) {
          return { data: [], error: { message: 'The protected query failed.' } };
        }
        if (response.errors?.[0]?.message) {
          response.errors[0].message = mapErrorMessage(response.errors[0].message);
        }
        return response;
      })
    );
  }

  applyTemplateVariables(query: TempoQuery, scopedVars: ScopedVars) {
    return preparedTargets.has(query) ? query : this.applyVariables(query, scopedVars);
  }

  interpolateVariablesInQueries(queries: TempoQuery[], scopedVars: ScopedVars): TempoQuery[] {
    if (!queries || queries.length === 0) {
      return [];
    }

    return queries.map((query) => {
      return {
        ...query,
        datasource: this.getRef(),
        ...this.applyVariables(query, scopedVars),
      };
    });
  }

  applyVariables(query: TempoQuery, scopedVars: ScopedVars) {
    if (preparedTargets.has(query)) {
      return query;
    }
    const protectedEnabled = !!this.instanceSettings.jsonData.protectedAttributesEnabled;
    if (protectedEnabled) {
      assertProtectedSavedModelSafe(query, this.protectedKey?.kid);
    }
    const expandedQuery = { ...query };

    if (query.filters) {
      expandedQuery.filters = interpolateFilters(query.filters, scopedVars);
    }

    const source = query.query ?? '';
    const interpolated = {
      ...expandedQuery,
      query:
        protectedEnabled &&
        source &&
        !source.startsWith('qenc:') &&
        !this.isTraceIdQuery(source) &&
        query.queryType !== 'traceId'
          ? replaceSafeTraceQLTemplate(source, (value) =>
              this.templateSrv.replace(value, scopedVars, VariableFormatID.Pipe)
            )
          : this.templateSrv.replace(source, scopedVars, VariableFormatID.Pipe),
      serviceMapQuery: Array.isArray(query.serviceMapQuery)
        ? query.serviceMapQuery.map((item) => this.templateSrv.replace(item, scopedVars))
        : this.templateSrv.replace(query.serviceMapQuery ?? '', scopedVars),
    };
    if (protectedEnabled) {
      assertProtectedSavedModelSafe(interpolated, this.protectedKey?.kid);
    }
    return interpolated;
  }

  /**
   * Handles the simplest of the queries where we have just a trace id and return trace data for it.
   * @param options
   * @param targets
   * @private
   */
  handleTraceIdQuery(
    options: DataQueryRequest<TempoQuery>,
    targets: TempoQuery[],
    query: string
  ): Observable<DataQueryResponse> {
    const validTargets = targets
      .filter((t) => t.query)
      .map((t): TempoQuery => ({ ...t, query: t.query?.trim(), queryType: 'traceId' }));
    if (!validTargets.length) {
      return EMPTY;
    }
    for (const target of validTargets) {
      preparedTargets.add(target);
    }

    const startTime = performance.now();
    const request = this.makeTraceIdRequest(options, validTargets);
    return super.query(request).pipe(
      map((response) => {
        if (response.error) {
          reportTempoQueryMetrics('grafana_traces_traceID_response', options, {
            success: false,
            streaming: false,
            latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
            query: query ?? '',
            error: getErrorMessage(response.error.message),
            statusCode: response.error.status,
            statusText: response.error.statusText,
          });
          return response;
        }
        reportTempoQueryMetrics('grafana_traces_traceID_response', options, {
          success: true,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
        });
        return transformTrace(response, this.instanceSettings, this.nodeGraph?.enabled);
      }),
      catchError((error) => {
        reportTempoQueryMetrics('grafana_traces_traceID_response', options, {
          success: false,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
          error: getErrorMessage(error.message),
          statusCode: error.status,
          statusText: error.statusText,
        });
        throw error;
      })
    );
  }

  handleTraceQlQuery(options: DataQueryRequest<TempoQuery>, targets: { [type: string]: TempoQuery[] }) {
    const startTime = performance.now();
    const queries = targets.traceqlSearch || targets.traceql;
    if (!queries?.length) {
      return EMPTY;
    }
    return super.query({ ...options, targets: queries }).pipe(
      map((response: DataQueryResponse) => {
        reportTempoQueryMetrics('grafana_traces_traceql_response', options, {
          success: !response.error,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime),
          query: queries[0].query ?? '',
        });
        if (response.data?.length) {
          response.data.forEach((frame) => {
            if (frame.name !== 'Traces' || !frame.fields[5]) {
              return;
            }
            // The backend does not support nested data frames directly, so we return
            // what should be nested as a JSON array in a column: e.g. "[{dataframe}]".
            // Here, we take the frames from that column, and change the type to "nestedFrames"
            // This allows the frontend to render the nested frames as intended.
            const nested = frame.fields[5];
            nested.type = 'nestedFrames';
            nested.typeInfo.frame = 'nestedFrames';

            // The returned JSON data frame structure does not fully match what the frontend expects for
            // rendering nested frames. Here, we transform each nested frame array to the correct format:
            //
            // - For each row in the main data frame, there is an array of nested frames (nestedFrameArray).
            // - Each nested frame (nestedFrame) contains a 'schema' (with 'fields' and 'meta') and 'data' (with 'values').
            // - We create a new frame object (newNestedFrame) with the expected 'fields' and 'meta' properties.
            // - For each field, we copy its definition and assign the corresponding values from nestedFrame.data.values.
            // - We also set the 'length' property on the new frame, which is required by the frontend to know how many rows it contains.
            // - Finally, we replace the original nestedFrame in the array with the transformed newNestedFrame.
            // const mestedFrames = nested.values as DataFrameJSON[][];
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            const mestedFrames = nested.values as DataFrameJSON[][];

            nested.values = mestedFrames.map((nestedFrameArray) => {
              return nestedFrameArray.map((nestedFrame) => {
                const newNestedFrame = { fields: nestedFrame.schema?.fields, meta: nestedFrame.schema?.meta };

                newNestedFrame.fields = newNestedFrame.fields?.map((field, fieldIndex: number) => {
                  return { ...field, values: nestedFrame.data?.values[fieldIndex] };
                });

                const rowCount = Array.isArray(nestedFrame.data?.values?.[0]) ? nestedFrame.data.values?.[0].length : 0;

                return { fields: newNestedFrame.fields, meta: nestedFrame.schema?.meta, length: rowCount };
              });
            });
          });
        }
        return response;
      }),
      catchError((err) => {
        reportTempoQueryMetrics('grafana_traces_traceql_response', options, {
          success: false,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime),
          query: queries[0].query ?? '',
          error: getErrorMessage(err.message),
          statusCode: err.status,
          statusText: err.statusText,
        });
        return of({ error: { message: getErrorMessage(err?.data?.message) }, data: [] });
      })
    );
  }

  handleTraceQlMetricsQuery(
    options: DataQueryRequest<TempoQuery>,
    targets: TempoQuery[],
    query: string
  ): Observable<DataQueryResponse> {
    const validTargets = targets.filter((t) => t.query);
    if (!validTargets.length) {
      return EMPTY;
    }

    const startTime = performance.now();
    const request = { ...options, targets: validTargets };
    return super.query(request).pipe(
      map((response) => {
        reportTempoQueryMetrics('grafana_traces_traceql_metrics_response', options, {
          success: true,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
        });
        return enhanceTraceQlMetricsResponse(response, this.instanceSettings);
      }),
      catchError((err) => {
        reportTempoQueryMetrics('grafana_traces_traceql_metrics_response', options, {
          success: false,
          streaming: false,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
          error: getErrorMessage(err?.data?.message),
          statusCode: err.status,
          statusText: err.statusText,
        });
        return of({ error: { message: getErrorMessage(err?.data?.message) }, data: [] });
      })
    );
  }

  // Each target already contains its own compiled query.
  handleStreamingQuery(
    options: DataQueryRequest<TempoQuery>,
    targets: TempoQuery[],
    query: string
  ): Observable<DataQueryResponse> {
    const validTargets = targets.filter((target) => !!target.query);
    if (!validTargets.length) {
      return EMPTY;
    }

    const startTime = performance.now();
    return merge(
      ...validTargets.map((target) => doTempoSearchStreaming(target, this, options, this.instanceSettings))
    ).pipe(
      catchError((error) => {
        reportTempoQueryMetrics('grafana_traces_traceql_response', options, {
          success: false,
          streaming: true,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
          error: getErrorMessage(error?.data?.message),
          statusCode: error.status,
          statusText: error.statusText,
        });
        // Re-throw the error to maintain the error chain
        throw error;
      }),
      finalize(() => {
        reportTempoQueryMetrics('grafana_traces_traceql_response', options, {
          success: true,
          streaming: true,
          query: query ?? '',
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
        });
      })
    );
  }

  // Each target already contains its own compiled query.
  handleMetricsStreamingQuery(
    options: DataQueryRequest<TempoQuery>,
    targets: TempoQuery[],
    query: string
  ): Observable<DataQueryResponse> {
    const validTargets = targets.filter((target) => !!target.query);
    if (!validTargets.length) {
      return EMPTY;
    }

    const startTime = performance.now();
    return merge(...validTargets.map((target) => doTempoMetricsStreaming(target, this, options))).pipe(
      map((response) => {
        return enhanceTraceQlMetricsResponse(response, this.instanceSettings);
      }),
      catchError((error) => {
        reportTempoQueryMetrics('grafana_traces_traceql_metrics_response', options, {
          success: false,
          streaming: true,
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
          query: query ?? '',
          error: getErrorMessage(error?.data?.message),
          statusCode: error.status,
          statusText: error.statusText,
        });
        // Re-throw the error to maintain the error chain
        throw error;
      }),
      finalize(() => {
        reportTempoQueryMetrics('grafana_traces_traceql_metrics_response', options, {
          success: true,
          streaming: true,
          query: query ?? '',
          latencyMs: Math.round(performance.now() - startTime), // rounded to nearest millisecond
        });
      })
    );
  }

  makeTraceIdRequest(options: DataQueryRequest<TempoQuery>, targets: TempoQuery[]): DataQueryRequest<TempoQuery> {
    const request = {
      ...options,
      targets,
    };

    if (this.traceQuery?.timeShiftEnabled) {
      request.range = options.range && {
        ...options.range,
        from: dateTime(options.range.from).subtract(
          rangeUtil.intervalToMs(this.traceQuery?.spanStartTimeShift || '30m'),
          'milliseconds'
        ),
        to: dateTime(options.range.to).add(
          rangeUtil.intervalToMs(this.traceQuery?.spanEndTimeShift || '30m'),
          'milliseconds'
        ),
      };
    } else {
      request.range = { from: dateTime(0), to: dateTime(0), raw: { from: dateTime(0), to: dateTime(0) } };
    }

    return request;
  }

  async metadataRequest(url: string, params: Record<string, unknown> = {}) {
    const protectedConfigured = !!this.instanceSettings.jsonData.protectedAttributesEnabled;
    try {
      if (url.startsWith('/') || (protectedConfigured && url.includes('?'))) {
        throw new Error('Invalid metadata request path.');
      }
      const { q, limit, start, end, tag } = params;
      if (protectedConfigured) {
        if (
          (tag !== undefined && typeof tag !== 'string') ||
          [limit, start, end].some((value) => value !== undefined && typeof value !== 'number')
        ) {
          throw new Error('Invalid metadata parameters.');
        }
        if (typeof tag === 'string') {
          const decodedTag = decodeURIComponent(tag);
          if (isProtectedTagValueRequest(decodedTag)) {
            throw new Error('Protected tag values are not available as metadata suggestions.');
          }
        }
      }
      if (q !== undefined && typeof q !== 'string') {
        throw new Error('Invalid contextual query.');
      }
      if (typeof q === 'string' && q.startsWith('qenc:')) {
        throw new Error('Sealed query models cannot be used directly as metadata queries.');
      }
      let finalQuery =
        typeof q === 'string'
          ? protectedConfigured && q
            ? replaceSafeTraceQLTemplate(q, (value) => this.templateSrv.replace(value, {}, VariableFormatID.Pipe))
            : this.templateSrv.replace(q, {}, VariableFormatID.Pipe)
          : undefined;
      if (protectedConfigured && finalQuery) {
        finalQuery = await rewriteProtectedTraceQL(finalQuery, this.protectedKey, 'metadata');
      }
      const safeParams = { limit, start, end, tag, ...(finalQuery !== undefined && { q: finalQuery }) };
      const res = await this.getResource(url, safeParams, { method: 'GET', hideFromInspector: true });
      return res?.data ?? res;
    } catch (error) {
      if (protectedConfigured) {
        throw new Error('Protected metadata request failed.');
      }
      throw error;
    }
  }

  async testDatasource(): Promise<TestDataSourceResponse> {
    return await super.testDatasource();
  }

  getQueryDisplayText(query: TempoQuery) {
    if (query.queryType === 'traceql' || query.queryType === 'traceId') {
      return query.query ?? '';
    }

    const appliedQuery = this.applyVariables(query, {});
    return this.languageProvider.generateQueryFromFilters({ traceqlFilters: appliedQuery.filters });
  }

  private getTagValueProperties(option: SelectableValue<string>) {
    if (!option.type) {
      return {};
    }

    return { properties: { valueType: option.type } };
  }
}

function queryPrometheus(request: DataQueryRequest<PromQuery>, datasourceUid: string) {
  return from(getDataSourceSrv().get(datasourceUid)).pipe(
    mergeMap((ds) => {
      return (ds as PrometheusDatasource).query(request);
    })
  );
}

function serviceMapQuery(
  request: DataQueryRequest<TempoQuery>,
  datasourceUid: string,
  tempoDatasourceUid: string,
  useNativeHistogram?: boolean
): Observable<ServiceMapQueryResponse> {
  const serviceMapRequest = makePromServiceMapRequest(request, useNativeHistogram);

  return queryPrometheus(serviceMapRequest, datasourceUid).pipe(
    // Just collect all the responses first before processing into node graph data
    toArray(),
    map((responses: DataQueryResponse[]) => {
      const errorRes = responses.find((res) => !!res.error);
      if (errorRes) {
        throw new Error(getErrorMessage(errorRes.error?.message));
      }

      const { nodes, edges } = mapPromMetricsToServiceMap(responses, request.range);
      if (nodes.fields.length > 0 && edges.fields.length > 0) {
        const nodeLength = nodes.fields[0].values.length;
        const edgeLength = edges.fields[0].values.length;

        reportInteraction('grafana_traces_service_graph_size', {
          datasourceType: 'tempo',
          grafana_version: config.buildInfo.version,
          nodeLength,
          edgeLength,
        });
      }

      // No handling of multiple targets assume just one. NodeGraph does not support it anyway, but still should be
      // fixed at some point.
      const { serviceMapIncludeNamespace, refId } = request.targets[0];
      nodes.refId = refId;
      edges.refId = refId;

      if (serviceMapIncludeNamespace) {
        nodes.fields[0].config = getFieldConfig(
          datasourceUid, // datasourceUid
          tempoDatasourceUid, // tempoDatasourceUid
          '__data.fields.title', // targetField
          '__data.fields[0]', // tempoField
          undefined, // sourceField
          { targetNamespace: '__data.fields.subtitle' },
          useNativeHistogram
        );

        edges.fields[0].config = getFieldConfig(
          datasourceUid, // datasourceUid
          tempoDatasourceUid, // tempoDatasourceUid
          '__data.fields.targetName', // targetField
          '__data.fields.target', // tempoField
          '__data.fields.sourceName', // sourceField
          { targetNamespace: '__data.fields.targetNamespace', sourceNamespace: '__data.fields.sourceNamespace' },
          useNativeHistogram
        );
      } else {
        nodes.fields[0].config = getFieldConfig(
          datasourceUid,
          tempoDatasourceUid,
          '__data.fields.id',
          '__data.fields[0]',
          undefined,
          undefined,
          useNativeHistogram
        );
        edges.fields[0].config = getFieldConfig(
          datasourceUid,
          tempoDatasourceUid,
          '__data.fields.target',
          '__data.fields.target',
          '__data.fields.source',
          undefined,
          useNativeHistogram
        );
      }

      return {
        nodes,
        edges,
        state: LoadingState.Done,
      };
    })
  );
}

function rateQuery(
  request: DataQueryRequest<TempoQuery>,
  serviceMapResponse: ServiceMapQueryResponse,
  datasourceUid: string,
  useNativeHistogram?: boolean
): Observable<ServiceMapQueryResponseWithRates> {
  const serviceMapRequest = makePromServiceMapRequest(request, useNativeHistogram);
  serviceMapRequest.targets = makeServiceGraphViewRequest([buildExpr(rateMetric, defaultTableFilter, request)]);

  return queryPrometheus(serviceMapRequest, datasourceUid).pipe(
    toArray(),
    map((responses: DataQueryResponse[]) => {
      const errorRes = responses.find((res) => !!res.error);
      if (errorRes) {
        throw new Error(getErrorMessage(errorRes.error?.message));
      }
      return {
        rates: responses[0]?.data ?? [],
        nodes: serviceMapResponse.nodes,
        edges: serviceMapResponse.edges,
      };
    })
  );
}

// we need the response from the rate query to get the rate span_name(s),
// -> which determine the errorRate/duration span_name(s) we need to query
function errorAndDurationQuery(
  request: DataQueryRequest<TempoQuery>,
  rateResponse: ServiceMapQueryResponseWithRates,
  datasourceUid: string,
  tempoDatasourceUid: string,
  useNativeHistogram?: boolean
) {
  let serviceGraphViewMetrics = [];
  let errorRateBySpanName = '';
  let durationsBySpanName: string[] = [];

  let labels = [];
  if (rateResponse.rates[0] && request.app === CoreApp.Explore) {
    const spanNameField = rateResponse.rates[0].fields.find((field) => field.name === 'span_name');
    if (spanNameField && spanNameField.values) {
      labels = spanNameField.values;
    }
  } else if (rateResponse.rates) {
    rateResponse.rates.map((df: DataFrame | DataFrameDTO) => {
      const spanNameLabels = df.fields.find((field) => field.labels?.['span_name']);
      if (spanNameLabels) {
        labels.push(spanNameLabels.labels?.['span_name']);
      }
    });
  }
  const spanNames = getEscapedRegexValues(getEscapedValues(labels));

  if (spanNames.length > 0) {
    errorRateBySpanName = buildExpr(errorRateMetric, 'span_name=~"' + spanNames.join('|') + '"', request);
    serviceGraphViewMetrics.push(errorRateBySpanName);
    spanNames.map((name: string) => {
      const checkedDurationMetric = useNativeHistogram ? nativeHistogramDurationMetric : durationMetric;
      const metric = buildExpr(checkedDurationMetric, 'span_name=~"' + name + '"', request);
      durationsBySpanName.push(metric);
      serviceGraphViewMetrics.push(metric);
    });
  }

  const serviceMapRequest = makePromServiceMapRequest(request, useNativeHistogram);
  serviceMapRequest.targets = makeServiceGraphViewRequest(serviceGraphViewMetrics);

  return queryPrometheus(serviceMapRequest, datasourceUid).pipe(
    // Just collect all the responses first before processing into node graph data
    toArray(),
    map((errorAndDurationResponse: DataQueryResponse[]) => {
      const errorRes = errorAndDurationResponse.find((res) => !!res.error);
      if (errorRes) {
        throw new Error(getErrorMessage(errorRes.error?.message));
      }

      const serviceGraphView = getServiceGraphViewDataFrames(
        request,
        rateResponse,
        errorAndDurationResponse[0],
        errorRateBySpanName,
        durationsBySpanName,
        datasourceUid,
        tempoDatasourceUid,
        useNativeHistogram
      );

      if (serviceGraphView.fields.length === 0) {
        return {
          data: [rateResponse.nodes, rateResponse.edges],
          state: LoadingState.Done,
        };
      }

      return {
        data: [serviceGraphView, rateResponse.nodes, rateResponse.edges],
        state: LoadingState.Done,
      };
    })
  );
}

function makePromLink(title: string, expr: string, datasourceUid: string, instant: boolean) {
  return {
    url: '',
    title,
    internal: {
      query: {
        expr: expr,
        range: !instant,
        exemplar: !instant,
        instant: instant,
      },
      datasourceUid,
      datasourceName: getDataSourceSrv().getInstanceSettings(datasourceUid)?.name ?? '',
    },
  };
}

// TODO: this is basically the same as prometheus/datasource.ts#prometheusSpecialRegexEscape which is used to escape
//  template variable values. It would be best to move it to some common place.
export function getEscapedRegexValues(values: string[]) {
  return values.map((value: string) => value.replace(/[$^*{}\[\]\'+?.()|]/g, '\\\\$&'));
}

export function getEscapedValues(values: string[]) {
  return values.map((value: string) => value.replace(/["\\]/g, '\\$&').replace(/[\n]/g, '\\n'));
}

/**
 * Normalise the `timeRangeForTags` jsonData option to a number of seconds.
 *
 * The datasource UI stores this option as a number of seconds, but when the
 * datasource is provisioned via YAML the documented format is a duration string
 * (e.g. "3d", "30m"). Without normalising, a provisioned string flows straight
 * into time-range arithmetic and produces a `NaN` `start` parameter, which
 * Tempo rejects with "error parsing date range".
 *
 * Returns undefined for missing or unparseable values so callers fall back to
 * the default behaviour instead of issuing an invalid query.
 */
export function parseTimeRangeForTags(value?: number | string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number') {
    return isNaN(value) ? undefined : value;
  }
  try {
    // intervalToSeconds handles both unit-less numeric strings ("259200") and
    // duration strings ("3d", "30m"); it throws on anything else.
    const seconds = rangeUtil.intervalToSeconds(value);
    return isNaN(seconds) ? undefined : seconds;
  } catch {
    return undefined;
  }
}

export function getFieldConfig(
  datasourceUid: string,
  tempoDatasourceUid: string,
  targetField: string,
  tempoField: string,
  sourceField?: string,
  namespaceFields?: { targetNamespace: string; sourceNamespace?: string },
  useNativeHistogram?: boolean
) {
  let source = sourceField ? `client="\${${sourceField}}",` : '';
  let target = `server="\${${targetField}}"`;
  let serverSumBy = 'server';

  if (namespaceFields !== undefined) {
    const { targetNamespace } = namespaceFields;
    target += `,server_service_namespace="\${${targetNamespace}}"`;
    serverSumBy += ', server_service_namespace';

    if (source) {
      const { sourceNamespace } = namespaceFields;
      source += `client_service_namespace="\${${sourceNamespace}}",`;
      serverSumBy += ', client_service_namespace';
    }
  }

  return {
    links: [
      makePromLink(
        'Request rate',
        `sum by (client, ${serverSumBy})(rate(${totalsMetric}{${source}${target}}[$__rate_interval]))`,
        datasourceUid,
        false
      ),
      ...makeHistogramLink(datasourceUid, source, target, serverSumBy, useNativeHistogram),
      makePromLink(
        'Failed request rate',
        `sum by (client, ${serverSumBy})(rate(${failedMetric}{${source}${target}}[$__rate_interval]))`,
        datasourceUid,
        false
      ),
      makeTempoLinkServiceMap(
        'View traces',
        namespaceFields !== undefined ? `\${${namespaceFields.targetNamespace}}` : '',
        `\${${targetField}}`,
        tempoDatasourceUid
      ),
    ],
  };
}

export function makeHistogramLink(
  datasourceUid: string,
  source: string,
  target: string,
  serverSumBy: string,
  useNativeHistogram?: boolean
) {
  const createHistogramLink = (metric: string, title: string) =>
    makePromLink(
      title,
      `histogram_quantile(0.9, sum(rate(${metric}{${source}${target}}[$__rate_interval])) by (le, client, ${serverSumBy}))`,
      datasourceUid,
      false
    );
  if (useNativeHistogram) {
    return [createHistogramLink(nativeHistogramMetric, 'Request native histogram')];
  }
  return [createHistogramLink(histogramMetric, 'Request classic histogram')];
}

export function makeTempoLink(
  title: string,
  serviceNamespace: string | undefined,
  serviceName: string,
  spanName: string,
  datasourceUid: string
) {
  let query: TempoQuery = { refId: 'A', queryType: 'traceqlSearch', filters: [] };
  if (serviceNamespace !== undefined && serviceNamespace !== '') {
    query.filters.push({
      id: 'service-namespace',
      scope: TraceqlSearchScope.Resource,
      tag: 'service.namespace',
      value: serviceNamespace,
      operator: '=',
      valueType: 'string',
    });
  }
  if (serviceName !== '') {
    query.filters.push({
      id: 'service-name',
      scope: TraceqlSearchScope.Resource,
      tag: 'service.name',
      value: serviceName,
      operator: '=',
      valueType: 'string',
    });
  }
  if (spanName !== '') {
    query.filters.push({
      id: 'span-name',
      scope: TraceqlSearchScope.Span,
      tag: 'name',
      value: spanName,
      operator: '=',
      valueType: 'string',
    });
  }

  return {
    url: '',
    title,
    internal: {
      query,
      datasourceUid,
      datasourceName: getDataSourceSrv().getInstanceSettings(datasourceUid)?.name ?? '',
    },
  };
}

function makeTempoLinkServiceMap(
  title: string,
  serviceNamespaceVar: string | undefined,
  serviceNameVar: string,
  datasourceUid: string
): DataLink<TempoQuery> {
  return {
    url: '',
    title,
    internal: {
      datasourceUid,
      datasourceName: getDataSourceSrv().getInstanceSettings(datasourceUid)?.name ?? '',
      query: ({ replaceVariables, scopedVars }) => {
        const serviceName = replaceVariables?.(serviceNameVar, scopedVars);
        const serviceNamespace = serviceNamespaceVar ? replaceVariables?.(serviceNamespaceVar, scopedVars) : undefined;
        const isInstrumented =
          replaceVariables?.(`\${__data.fields.${NodeGraphDataFrameFieldNames.isInstrumented}}`, scopedVars) !==
          'false';
        const query: TempoQuery = { refId: 'A', queryType: 'traceqlSearch', filters: [] };

        // Only do the peer query if service is actively set as not instrumented
        if (isInstrumented === false) {
          const filters = ['db.name', 'db.system', 'peer.service', 'messaging.system', 'net.peer.name']
            .map((peerAttribute) => `span.${peerAttribute}="${serviceName}"`)
            .join(' || ');
          query.queryType = 'traceql';
          query.query = `{${filters}}`;
        } else {
          if (serviceNamespace) {
            query.filters.push({
              id: 'service-namespace',
              scope: TraceqlSearchScope.Resource,
              tag: 'service.namespace',
              value: serviceNamespace,
              operator: '=',
              valueType: 'string',
            });
          }
          if (serviceName) {
            query.filters.push({
              id: 'service-name',
              scope: TraceqlSearchScope.Resource,
              tag: 'service.name',
              value: serviceName,
              operator: '=',
              valueType: 'string',
            });
          }
        }

        return query;
      },
    },
  };
}

export function makePromServiceMapRequest(
  options: DataQueryRequest<TempoQuery>,
  useNativeHistogram?: boolean
): DataQueryRequest<PromQuery> {
  return {
    ...options,
    targets: serviceMapMetrics
      .map<PromQuery[]>((metric) => {
        if (useNativeHistogram) {
          metric = metric.replace('_bucket', '');
        }
        const { serviceMapQuery, serviceMapIncludeNamespace: serviceMapIncludeNamespace } = options.targets[0];
        const extraSumByFields = serviceMapIncludeNamespace
          ? ', client_service_namespace, server_service_namespace'
          : '';
        const queries = Array.isArray(serviceMapQuery) ? serviceMapQuery : [serviceMapQuery];
        const sumSubExprs = queries.map(
          (query) => `sum by (client, server${extraSumByFields}) (rate(${metric}${query || ''}[$__range]))`
        );
        const groupSubExprs = queries.map(
          (query) => `group by (client, connection_type, server${extraSumByFields}) (${metric}${query || ''})`
        );

        return [
          {
            format: 'table',
            refId: metric,
            // options.targets[0] is not correct here, but not sure what should happen if you have multiple queries for
            // service map at the same time anyway
            expr: sumSubExprs.join(' OR '),
            instant: true,
          },
          {
            format: 'table',
            refId: `${metric}_labels`,
            expr: groupSubExprs.join(' OR '),
            instant: true,
          },
        ];
      })
      .flat(),
  };
}

function getServiceGraphViewDataFrames(
  request: DataQueryRequest<TempoQuery>,
  rateResponse: ServiceMapQueryResponseWithRates,
  secondResponse: DataQueryResponse,
  errorRateBySpanName: string,
  durationsBySpanName: string[],
  datasourceUid: string,
  tempoDatasourceUid: string,
  useNativeHistogram?: boolean
) {
  let df: any = { fields: [] };

  const rate = rateResponse.rates.filter((x) => {
    return x.refId === buildExpr(rateMetric, defaultTableFilter, request);
  });
  const errorRate = secondResponse.data.filter((x) => {
    return x.refId === errorRateBySpanName;
  });
  const duration = secondResponse.data.filter((x) => {
    return durationsBySpanName.includes(x.refId ?? '');
  });

  if (rate.length > 0 && rate[0].fields?.length > 2) {
    df.fields.push({
      ...rate[0].fields[1],
      name: 'Name',
      config: {
        filterable: false,
      },
    });

    df.fields.push({
      ...rate[0].fields[2],
      name: 'Rate',
      config: {
        links: [
          makePromLink(
            'Rate',
            buildLinkExpr(buildExpr(rateMetric, 'span_name="${__data.fields[0]}"', request)),
            datasourceUid,
            false
          ),
        ],
        decimals: 2,
      },
    });

    df.fields.push({
      ...rate[0].fields[2],
      name: '  ',
      labels: null,
      config: {
        color: {
          mode: 'continuous-BlPu',
        },
        custom: {
          cellOptions: {
            mode: BarGaugeDisplayMode.Lcd,
            type: TableCellDisplayMode.Gauge,
          },
        },
        decimals: 3,
      },
    });
  }

  if (errorRate.length > 0 && errorRate[0].fields?.length > 2) {
    const errorRateNames = errorRate[0].fields[1]?.values ?? [];
    const errorRateValues = errorRate[0].fields[2]?.values ?? [];
    let errorRateObj: Record<
      string,
      {
        value: string;
      }
    > = {};
    errorRateNames.map((name: string, index: number) => {
      errorRateObj[name] = { value: errorRateValues[index] };
    });

    const values = getRateAlignedValues({ ...rate }, errorRateObj);

    df.fields.push({
      ...errorRate[0].fields[2],
      name: 'Error Rate',
      values: values,
      config: {
        links: [
          makePromLink(
            'Error Rate',
            buildLinkExpr(buildExpr(errorRateMetric, 'span_name="${__data.fields[0]}"', request)),
            datasourceUid,
            false
          ),
        ],
        decimals: 2,
      },
    });

    df.fields.push({
      ...errorRate[0].fields[2],
      name: '   ',
      values: values,
      labels: null,
      config: {
        color: {
          mode: 'continuous-RdYlGr',
        },
        custom: {
          cellOptions: {
            mode: BarGaugeDisplayMode.Lcd,
            type: TableCellDisplayMode.Gauge,
          },
        },
        decimals: 3,
      },
    });
  }

  if (duration.length > 0) {
    let durationObj: Record<
      string,
      {
        value: string;
      }
    > = {};
    duration.forEach((d) => {
      if (d.fields.length > 1) {
        const delimiter = d.refId?.includes('span_name=~"') ? 'span_name=~"' : 'span_name="';
        const name = d.refId?.split(delimiter)[1].split('"}')[0];
        durationObj[name!] = { value: d.fields[1].values[0] };
      }
    });
    if (Object.keys(durationObj).length > 0) {
      const checkedDurationMetric = useNativeHistogram ? nativeHistogramDurationMetric : durationMetric;
      df.fields.push({
        ...duration[0].fields[1],
        name: 'Duration (p90)',
        values: getRateAlignedValues({ ...rate }, durationObj),
        config: {
          links: [
            makePromLink(
              'Duration',
              buildLinkExpr(buildExpr(checkedDurationMetric, 'span_name="${__data.fields[0]}"', request)),
              datasourceUid,
              false
            ),
          ],
          unit: 's',
        },
      });
    }
  }

  if (df.fields.length > 0 && df.fields[0].values) {
    df.fields.push({
      name: 'Links',
      type: FieldType.string,
      values: df.fields[0].values.map(() => {
        return 'Tempo';
      }),
      config: {
        links: [makeTempoLink('Tempo', undefined, '', `\${__data.fields[0]}`, tempoDatasourceUid)],
      },
    });
  }

  return df;
}

/**
 * Reports metrics for Tempo query interactions.
 *
 * @param options - The data query request options containing app and other context
 * @param metrics - Object containing metrics to report:
 *   - success: Whether the query was successful
 *   - streaming: (optional) Whether streaming was used
 *   - latencyMs: Query execution time in milliseconds
 *   - query: (optional) The query string that was executed
 *   - error: (optional) Error message if query failed
 *   - statusCode: (optional) HTTP status code if query failed
 *   - statusText: (optional) HTTP status text if query failed
 * @param interactionName - (optional) Name of the interaction to report.
 *                         Defaults to 'grafana_traces_traceql_response'
 *
 * @example
 * ```typescript
 * reportTempoQueryMetrics(options, {
 *   success: true,
 *   streaming: true,
 *   latencyMs: Math.round(performance.now() - startTime),
 *   query: 'my query'
 * });
 * ```
 */
function reportTempoQueryMetrics(
  interactionName: string,
  options: DataQueryRequest<TempoQuery>,
  metrics: TempoQueryMetrics
) {
  const protectedQuery = protectedRequests.has(options);
  reportInteraction(interactionName, {
    datasourceType: 'tempo',
    app: options.app ?? '',
    grafana_version: config.buildInfo.version,
    timeRangeSeconds: options.range ? options.range.to.unix() - options.range.from.unix() : 0,
    ...(!protectedQuery && { timeRange: options.range ? options.range.raw.from + ';' + options.range.raw.to : '' }),
    ...(protectedQuery
      ? {
          success: metrics.success,
          streaming: metrics.streaming,
          latencyMs: metrics.latencyMs,
          ...(typeof metrics.statusCode === 'number' &&
            Number.isFinite(metrics.statusCode) && {
              statusCode: metrics.statusCode,
            }),
        }
      : metrics),
  });
}

export function buildExpr(
  metric: { expr: string; params: string[]; topk?: number },
  extraParams: string,
  request: DataQueryRequest<TempoQuery>
): string {
  let serviceMapQuery = request.targets[0]?.serviceMapQuery ?? '';
  const serviceMapQueries = Array.isArray(serviceMapQuery) ? serviceMapQuery : [serviceMapQuery];
  const metricParamsArray = serviceMapQueries.map((query) => {
    // remove surrounding curly braces from serviceMapQuery
    const serviceMapQueryMatch = query.match(/^{(.*)}$/);
    if (serviceMapQueryMatch?.length) {
      query = serviceMapQueryMatch[1];
    }
    // map serviceGraph metric tags to serviceGraphView metric tags
    query = query
      // client_deployment_environment="prod" -> deployment_environment="prod"
      .replaceAll('client_', '')
      .replaceAll('server_', '')
      .replace('client', 'service') // client="fooservice" -> service="fooservice"
      .replace('server', 'service');
    return query.includes('span_name')
      ? metric.params.concat(query)
      : metric.params
          .concat(query)
          .concat(extraParams)
          .filter((item: string) => item);
  });
  const exprs = metricParamsArray.map((params) => metric.expr.replace('{}', '{' + params.join(',') + '}'));
  const expr = exprs.join(' OR ');
  if (metric.topk) {
    return `topk(${metric.topk}, ${expr})`;
  }
  return expr;
}

export function buildLinkExpr(expr: string) {
  // don't want top 5 or by span name in links
  expr = expr.replace('topk(5, ', '').replace(' by (span_name))', '');
  return expr.replace('__range', '__rate_interval');
}

// query result frames can come back in any order
// here we align the table col values to the same row name (rateName) across the table
export function getRateAlignedValues(
  rateResp: DataQueryResponseData[],
  objToAlign: { [x: string]: { value: string } }
) {
  const rateNames = rateResp[0]?.fields[1]?.values ?? [];
  let values: string[] = [];

  for (let i = 0; i < rateNames.length; i++) {
    if (Object.keys(objToAlign).includes(rateNames[i])) {
      values.push(objToAlign[rateNames[i]].value);
    } else {
      values.push('0');
    }
  }

  return values;
}

export function makeServiceGraphViewRequest(metrics: string[]): PromQuery[] {
  return metrics.map((metric) => {
    return {
      refId: metric,
      expr: metric,
      instant: true,
    };
  });
}
