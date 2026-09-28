import { css } from '@emotion/css';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type CoreApp, type GrafanaTheme2, type TimeRange } from '@grafana/data';
import { TemporaryAlert } from '@grafana/o11y-ds-frontend';
import { config, type FetchError, getTemplateSrv, reportInteraction } from '@grafana/runtime';
import { Alert, Button, Stack, Select, useStyles2, TextLink } from '@grafana/ui';

import { RawQuery } from '../_importedDependencies/datasources/prometheus/RawQuery';
import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoDatasource } from '../datasource';
import {
  assertProtectedQueryModelSafe,
  assertStaticProtectedFilterDefaultsSafe,
  openProtectedQueryModel,
  prepareProtectedQueryModel,
  protectedFilterSelections,
} from '../protectedAttributes/model';
import { assertProtectedTraceQLKeyChoices } from '../protectedAttributes/traceql';
import { TempoQueryBuilderOptions } from '../traceql/TempoQueryBuilderOptions';
import { traceqlGrammar } from '../traceql/traceql';
import { type TempoQuery } from '../types';

import { AggregateByAlert } from './AggregateByAlert';
import DurationInput from './DurationInput';
import InlineSearchField from './InlineSearchField';
import SearchField from './SearchField';
import TagsInput from './TagsInput';
import { filterScopedTag, filterTitle, interpolateFilters, replaceAt } from './utils';

interface Props {
  datasource: TempoDatasource;
  query: TempoQuery;
  onChange: (value: TempoQuery) => void;
  onPendingChange?: (pending: boolean) => void;
  protectedKeyLabel?: (kid: string) => string;
  onBlur?: () => void;
  onClearResults: () => boolean | void;
  app?: CoreApp;
  addVariablesToOptions?: boolean;
  range?: TimeRange;
}

const hardCodedFilterIds = ['min-duration', 'max-duration', 'status'];

const TraceQLSearch = ({
  datasource,
  query,
  onChange,
  onPendingChange,
  protectedKeyLabel,
  onClearResults,
  app,
  addVariablesToOptions = true,
  range,
}: Props) => {
  const styles = useStyles2(getStyles);
  const [alertText, setAlertText] = useState<string>();
  const [error, setError] = useState<Error | FetchError | null>(null);

  const [isTagsLoading, setIsTagsLoading] = useState(true);
  const [traceQlQuery, setTraceQlQuery] = useState<string>('');

  const protectedMode = datasource.instanceSettings?.jsonData?.protectedAttributesEnabled;
  const key = datasource.protectedKey;
  const [draftModel, setDraftModel] = useState<TempoQuery>(() =>
    protectedMode
      ? { ...query, filters: (query.filters ?? []).map((filter) => ({ ...filter, value: undefined })) }
      : query
  );
  const [locked, setLocked] = useState(Boolean(protectedMode));
  const [legacy, setLegacy] = useState(false);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const generation = useRef(0);
  const dirtyRef = useRef(false);
  const copyPendingRef = useRef(false);
  const savedModel = useRef<TempoQuery | undefined>(undefined);
  const draftRef = useRef(draftModel);
  draftRef.current = draftModel;
  const savedKey = useRef(key);
  const templateSrv = getTemplateSrv();

  useEffect(() => {
    if (savedKey.current === key && savedModel.current === query) {
      return;
    }
    const current = ++generation.current;
    if (!protectedMode) {
      draftRef.current = query;
      setDraftModel(query);
      setLocked(false);
      setLegacy(false);
      return;
    }
    try {
      assertStaticProtectedFilterDefaultsSafe(datasource.search?.filters, !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
    } catch {
      setLocked(true);
      setLegacy(false);
      setAlertText('Configured protected search defaults must be corrected before editing');
      return;
    }
    try {
      assertProtectedQueryModelSafe(
        query,
        (datasource.protectedKeys ?? (key ? [key] : [])).map((item) => item.kid),
        !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
      );
    } catch {
      setLocked(true);
      setLegacy(
        Boolean(
          key &&
          !query.query?.startsWith('qenc:') &&
          !query.filters?.some((filter) =>
            (Array.isArray(filter.value) ? filter.value : [filter.value]).some((value) => value?.startsWith('qenc:'))
          )
        )
      );
      setAlertText('Protected saved search must be corrected before editing');
      return;
    }
    setLegacy(false);
    const hasSealedValues = Boolean(
      query.query?.startsWith('qenc:') ||
      query.filters?.some((filter) =>
        (Array.isArray(filter.value) ? filter.value : [filter.value]).some((value) => value?.startsWith('qenc:'))
      )
    );
    if (!hasSealedValues) {
      draftRef.current = query;
      setDraftModel(query);
      setLocked(false);
      return;
    }
    setLocked(true);
    const keys = datasource.protectedKeys ?? (key ? [key] : []);
    const envelopes = [
      query.query,
      ...(query.filters ?? []).flatMap((filter) => (Array.isArray(filter.value) ? filter.value : [filter.value])),
    ];
    if (
      envelopes.some(
        (value) => value?.startsWith('qenc:') && !keys.some((item) => value.startsWith(`qenc:v1:${item.kid}:`))
      )
    ) {
      return;
    }
    void openProtectedQueryModel(
      query,
      datasource.getProtectedKey?.bind(datasource) ?? ((kid) => keys.find((item) => item.kid === kid)),
      datasource.uid,
      !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
    ).then(
      (opened) => {
        if (generation.current === current) {
          draftRef.current = opened;
          setDraftModel(opened);
          setLocked(false);
          setAlertText(undefined);
        }
      },
      () => {
        if (generation.current === current) {
          setAlertText('Unable to open protected search');
        }
      }
    );
    // Opening and editing share a generation; own host acknowledgements must
    // not cancel a newer local draft.
  }, [query, key, protectedMode, datasource.uid, datasource.search?.filters]);

  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  useEffect(() => {
    onPendingChange?.(locked || pending || dirty || copyPending);
  }, [locked, pending, dirty, copyPending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  const emitDraft = useCallback(
    (next: TempoQuery) => {
      if (locked) {
        return;
      }
      draftRef.current = next;
      setDraftModel(next);
      setDirty(true);
      dirtyRef.current = true;
      if (copyPendingRef.current) {
        copyPendingRef.current = false;
        setCopyPending(false);
      }
      onPendingChange?.(true);
      const current = ++generation.current;
      const epoch = datasource.protectedKeyEpoch;
      if (!protectedMode) {
        savedModel.current = next;
        savedKey.current = key;
        onChange(next);
        dirtyRef.current = false;
        setDirty(false);
        onPendingChange?.(copyPendingRef.current);
        return;
      }
      setPending(true);
      try {
        const generated = datasource.languageProvider.generateQueryFromFilters({ traceqlFilters: next.filters ?? [] });
        if (generated) {
          const substring = !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled;
          assertProtectedTraceQLKeyChoices(generated, datasource.protectedKeys ?? (key ? [key] : []),
            protectedFilterSelections(generated, next.filters ?? [], substring), substring);
        }
        if (!key) {
          assertProtectedQueryModelSafe(next, undefined, !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
          savedKey.current = key;
          savedModel.current = next;
          onChange(next);
          dirtyRef.current = false;
          setDirty(false);
          onPendingChange?.(copyPendingRef.current);
          setPending(false);
          return;
        }
        void prepareProtectedQueryModel(
          next,
          key,
          datasource.uid,
          query,
          datasource.getProtectedKey?.bind(datasource),
          !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
        ).then(
          (sealed) => {
            if (generation.current !== current || datasource.protectedKey !== key || datasource.protectedKeyEpoch !== epoch) {
              return;
            }
            savedKey.current = key;
            savedModel.current = sealed;
            onChange(sealed);
            dirtyRef.current = false;
            setDirty(false);
            onPendingChange?.(copyPendingRef.current);
            setPending(false);
            setAlertText(undefined);
          },
          () => {
            if (generation.current === current) {
              setPending(false);
              setAlertText('Complete or correct protected filter before saving');
            }
          }
        );
      } catch {
        setPending(false);
        setAlertText('Complete or correct protected filter before saving');
      }
    },
    [locked, protectedMode, key, datasource, onChange, onPendingChange, query]
  );

  const updateFilter = useCallback(
    (filter: TraceqlFilter) => {
      const current = draftRef.current;
      const filters = current.filters ?? [];
      const index = filters.findIndex((f) => f.id === filter.id);
      emitDraft({ ...current, filters: index < 0 ? [...filters, filter] : replaceAt(filters, index, filter) });
    },
    [emitDraft]
  );

  const deleteFilter = (filter: TraceqlFilter) => {
    const current = draftRef.current;
    emitDraft({ ...current, filters: (current.filters ?? []).filter((f) => f.id !== filter.id) });
  };

  const templateVariables = getTemplateSrv().getVariables();
  useEffect(() => {
    if (locked || pending || (protectedMode && (dirtyRef.current || dirty))) {
      setTraceQlQuery('');
      return;
    }
    try {
      setTraceQlQuery(
        datasource.languageProvider.generateQueryFromFilters({
          traceqlFilters: protectedMode ? draftModel.filters || [] : interpolateFilters(draftModel.filters || []),
        })
      );
    } catch {
      setTraceQlQuery('');
      setAlertText('Protected search filter cannot be displayed until corrected');
    }
  }, [datasource.languageProvider, draftModel, templateVariables, locked, pending, dirty, protectedMode]);

  const findFilter = useCallback((id: string) => draftModel.filters?.find((f) => f.id === id), [draftModel.filters]);

  useEffect(() => {
    const fetchTags = async () => {
      try {
        await datasource.languageProvider.start(range, datasource.timeRangeForTags);
        setIsTagsLoading(false);
        setAlertText(undefined);
      } catch (error) {
        if (error instanceof Error) {
          setAlertText(`Error: ${error.message}`);
        }
      }
    };
    fetchTags();
  }, [datasource, setAlertText, range, datasource.timeRangeForTags]);

  useEffect(() => {
    if (locked || pending || !datasource.search?.filters?.some((f) => f.value && !findFilter(f.id))) {
      return;
    }
    try {
      if (protectedMode) {
        assertStaticProtectedFilterDefaultsSafe(datasource.search.filters, !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
      }
      for (const filter of datasource.search.filters ?? []) {
        if (filter.value && !findFilter(filter.id)) {
          updateFilter(filter);
        }
      }
    } catch {
      setAlertText('Configured protected search defaults must be removed');
    }
  }, [datasource.search?.filters, findFilter, updateFilter, locked, pending, protectedMode]);

  // filter out tags that already exist in the static fields
  const staticTags = datasource.search?.filters?.map((f) => f.tag) || [];
  staticTags.push('duration');
  staticTags.push('traceDuration');
  staticTags.push('span:duration');
  staticTags.push('trace:duration');
  staticTags.push('status');
  staticTags.push('span:status');

  // Dynamic filters are all filters that don't match the ID of a filter in the datasource configuration
  // The duration and status fields are a special case since its selector is hard-coded
  const dynamicFilters = (draftModel.filters || []).filter(
    (f) =>
      !hardCodedFilterIds.includes(f.id) &&
      (datasource.search?.filters?.findIndex((sf) => sf.id === f.id) || 0) === -1 &&
      f.id !== 'duration-type'
  );

  // We use this function to generate queries without a specfic filter.
  // This is useful because we're sending the query to Tempo so it can return the attributes and values filtered down.
  // However, if we send the full query then we won't see more values for the filter we're trying to edit.
  // For example, if we already have a service.name value selected and try to add another one, we won't see the other
  // values if we send the full query since Tempo will only return the service.name that's already selected.
  const generateQueryWithoutFilter = (filter?: TraceqlFilter) => {
    if (locked || pending || (protectedMode && (dirtyRef.current || dirty))) {
      return '';
    }
    if (!filter) {
      return traceQlQuery;
    }
    try {
      return datasource.languageProvider.generateQueryFromFilters({
        traceqlFilters: protectedMode
          ? draftModel.filters?.filter((f) => f.id !== filter.id) || []
          : interpolateFilters(draftModel.filters?.filter((f) => f.id !== filter.id) || []),
      });
    } catch {
      return '';
    }
  };

  const contextualChoices = (filter?: TraceqlFilter) => {
    const context = generateQueryWithoutFilter(filter);
    if (!protectedMode || !context) {
      return undefined;
    }
    try {
      return protectedFilterSelections(context,
        (draftModel.filters ?? []).filter((item) => item.id !== filter?.id),
        !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
    } catch {
      return undefined;
    }
  };

  return (
    <>
      {locked ? (
        <>
          <TemporaryAlert
            severity="info"
            text="Import the matching key or correct the saved protected search before editing"
          />
          {legacy && key && (
            <Button
              variant="secondary"
              onClick={() => {
                const currentKey = datasource.protectedKey;
                if (!currentKey) {
                  return;
                }
                const current = ++generation.current;
                const epoch = datasource.protectedKeyEpoch;
                void prepareProtectedQueryModel(
                  query,
                  currentKey,
                  datasource.uid,
                  query,
                  datasource.getProtectedKey?.bind(datasource),
                  !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
                ).then(
                  (sealed) => {
                    if (generation.current === current && datasource.protectedKey === currentKey &&
                      datasource.protectedKeyEpoch === epoch) {
                      savedModel.current = undefined;
                      onChange(sealed);
                    }
                  },
                  () => setAlertText('Correct legacy search filters before migrating them')
                );
              }}
            >
              Seal legacy search filters
            </Button>
          )}
        </>
      ) : (
        <div className={styles.container}>
          <div>
            {datasource.search?.filters?.map(
              (f) =>
                f.tag && (
                  <InlineSearchField
                    key={f.id}
                    label={filterTitle(f, datasource.languageProvider)}
                    tooltip={`Filter your search by ${filterScopedTag(
                      f,
                      datasource.languageProvider
                    )}. To modify the default filters shown for search visit the Tempo datasource configuration page.`}
                  >
                    <SearchField
                      filter={findFilter(f.id) || f}
                      datasource={datasource}
                      setError={setError}
                      updateFilter={updateFilter}
                      tags={[]}
                      hideScope={true}
                      hideTag={true}
                      query={generateQueryWithoutFilter(findFilter(f.id))}
                      protectedQueryKeys={contextualChoices(findFilter(f.id))}
                      protectedKeyLabel={protectedKeyLabel}
                      addVariablesToOptions={addVariablesToOptions}
                      range={range}
                      timeRangeForTags={datasource.timeRangeForTags}
                    />
                  </InlineSearchField>
                )
            )}
            <InlineSearchField label={'Status'}>
              <SearchField
                filter={
                  findFilter('status') || {
                    id: 'status',
                    tag: 'status',
                    scope: TraceqlSearchScope.Intrinsic,
                    operator: '=',
                  }
                }
                datasource={datasource}
                setError={setError}
                updateFilter={updateFilter}
                tags={[]}
                hideScope={true}
                hideTag={true}
                query={generateQueryWithoutFilter(findFilter('status'))}
                protectedQueryKeys={contextualChoices(findFilter('status'))}
                protectedKeyLabel={protectedKeyLabel}
                isMulti={false}
                allowCustomValue={false}
                addVariablesToOptions={addVariablesToOptions}
                range={range}
                timeRangeForTags={datasource.timeRangeForTags}
              />
            </InlineSearchField>
            <InlineSearchField
              label={'Duration'}
              tooltip="The trace or span duration, i.e. end - start time of the trace/span. Accepted units are ns, ms, s, m, h"
            >
              <Stack gap={0}>
                <Select
                  width="auto"
                  options={[
                    { label: 'span', value: 'span' },
                    { label: 'trace', value: 'trace' },
                  ]}
                  value={findFilter('duration-type')?.value ?? 'span'}
                  onChange={(v) => {
                    const filter = findFilter('duration-type') || {
                      id: 'duration-type',
                      value: 'span',
                    };
                    updateFilter({ ...filter, value: v?.value });
                  }}
                  aria-label={'duration type'}
                />
                <DurationInput
                  filter={
                    findFilter('min-duration') || {
                      id: 'min-duration',
                      tag: 'duration',
                      operator: '>',
                      valueType: 'duration',
                    }
                  }
                  operators={['>', '>=']}
                  updateFilter={updateFilter}
                />
                <DurationInput
                  filter={
                    findFilter('max-duration') || {
                      id: 'max-duration',
                      tag: 'duration',
                      operator: '<',
                      valueType: 'duration',
                    }
                  }
                  operators={['<', '<=']}
                  updateFilter={updateFilter}
                />
              </Stack>
            </InlineSearchField>
            <InlineSearchField label={'Tags'}>
              <TagsInput
                filters={dynamicFilters}
                datasource={datasource}
                setError={setError}
                updateFilter={updateFilter}
                deleteFilter={deleteFilter}
                staticTags={staticTags}
                isTagsLoading={isTagsLoading}
                generateQueryWithoutFilter={generateQueryWithoutFilter}
                getProtectedQueryKeys={contextualChoices}
                protectedKeyLabel={protectedKeyLabel}
                requireTagAndValue={true}
                addVariablesToOptions={addVariablesToOptions}
                range={range}
                timeRangeForTags={datasource.timeRangeForTags}
              />
            </InlineSearchField>
            <AggregateByAlert
              query={draftModel}
              onChange={() => {
                const { groupBy, ...rest } = draftRef.current;
                emitDraft(rest as TempoQuery);
              }}
            />
          </div>
          <div className={styles.rawQueryContainer}>
            <RawQuery
              query={traceQlQuery ? templateSrv.replace(traceQlQuery) : ''}
              lang={{ grammar: traceqlGrammar, name: 'traceql' }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                reportInteraction('grafana_traces_copy_to_traceql_clicked', {
                  app: app ?? '',
                  grafana_version: config.buildInfo.version,
                  location: 'search_tab',
                });

                if (pending || dirty) {
                  setAlertText('Complete the protected filter before copying');
                  return;
                }
                copyPendingRef.current = true;
                setCopyPending(true);
                onPendingChange?.(true);
                const current = ++generation.current;
                const epoch = datasource.protectedKeyEpoch;
                try {
                  const raw = datasource.languageProvider.generateQueryFromFilters({
                    traceqlFilters: draftRef.current.filters || [],
                  });
                  const chosen = protectedMode
                    ? protectedFilterSelections(raw, draftRef.current.filters || [],
                        !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled)
                    : [];
                  if (protectedMode) {
                    assertProtectedTraceQLKeyChoices(raw, datasource.protectedKeys ?? (key ? [key] : []), chosen,
                      !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
                  }
                  const candidate: TempoQuery = { ...query, query: raw, queryType: 'traceql', protectedQueryKeys: chosen };
                  const result =
                    protectedMode && key
                      ? prepareProtectedQueryModel(
                          candidate,
                          key,
                          datasource.uid,
                          query,
                          datasource.getProtectedKey?.bind(datasource),
                          !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
                        )
                      : Promise.resolve(candidate);
                  void result
                    .then((sealed) => {
                      if (protectedMode) {
                        assertProtectedQueryModelSafe(sealed, key?.kid, !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
                      }
                      if (generation.current === current && (!protectedMode ||
                        (datasource.protectedKey === key && datasource.protectedKeyEpoch === epoch))) {
                        copyPendingRef.current = false;
                        setCopyPending(false);
                        onPendingChange?.(false);
                        if (onClearResults() === false) {
                          throw new Error('Cannot clear while the previous query is pending');
                        }
                        onChange(sealed);
                      }
                    })
                    .catch(() => setAlertText('Unlock or correct protected search before copying'))
                    .finally(() => {
                      if (generation.current === current) {
                        copyPendingRef.current = false;
                        setCopyPending(false);
                        onPendingChange?.(dirtyRef.current);
                      }
                    });
                } catch {
                  setAlertText('Unlock or correct protected search before copying');
                  copyPendingRef.current = false;
                  setCopyPending(false);
                  onPendingChange?.(dirtyRef.current);
                }
              }}
            >
              Edit in TraceQL
            </Button>
          </div>
          <TempoQueryBuilderOptions
            onChange={(next) => {
              if (pending || dirty || copyPending) {
                setAlertText('Complete the protected filter before changing options');
                return;
              }
              onChange(next);
            }}
            query={query}
            searchStreaming={datasource.isStreamingSearchEnabled() ?? false}
            metricsStreaming={datasource.isStreamingMetricsEnabled() ?? false}
            app={app}
          />
        </div>
      )}
      {error ? (
        <Alert title="Unable to connect to Tempo search" severity="info" className={styles.alert}>
          Please ensure that Tempo is configured with search enabled. If you would like to hide this tab, you can
          configure it in the <TextLink href={`/datasources/edit/${datasource.uid}`}>datasource settings</TextLink>.
        </Alert>
      ) : null}
      {alertText && <TemporaryAlert severity={'error'} text={alertText} />}
    </>
  );
};

export default TraceQLSearch;

const getStyles = (theme: GrafanaTheme2) => ({
  alert: css({
    maxWidth: '75ch',
    marginTop: theme.spacing(2),
  }),
  container: css({
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap',
    flexDirection: 'column',
  }),
  rawQueryContainer: css({
    alignItems: 'center',
    backgroundColor: theme.colors.background.secondary,
    display: 'flex',
    justifyContent: 'space-between',
    padding: theme.spacing(1),
  }),
});
