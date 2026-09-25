import { useCallback, useEffect, useState } from 'react';
import useAsync from 'react-use/lib/useAsync';

import { type DataSourcePluginOptionsEditorProps, updateDatasourcePluginJsonDataOption } from '@grafana/data';
import { Alert } from '@grafana/ui';

import TagsInput from '../SearchTraceQLEditor/TagsInput';
import { replaceAt } from '../SearchTraceQLEditor/utils';
import { type TraceqlFilter, TraceqlSearchScope } from '../dataquery';
import { type TempoDatasource } from '../datasource';
import { assertStaticProtectedFilterDefaultsSafe } from '../protectedAttributes/model';
import { type TempoJsonData } from '../types';
import { getErrorMessage } from '../utils';

interface Props extends DataSourcePluginOptionsEditorProps<TempoJsonData> {
  datasource?: TempoDatasource;
}

/** Keep the rejected value (including text embedded in a malformed tag) out of errors. */
export function protectedStaticFilterError(filters: TraceqlFilter[] | undefined): string | undefined {
  try {
    assertStaticProtectedFilterDefaultsSafe(filters);
    return undefined;
  } catch {
    const index = filters?.findIndex((filter) => {
      try {
        assertStaticProtectedFilterDefaultsSafe([filter]);
        return false;
      } catch {
        return true;
      }
    }) ?? -1;
    const filter = index >= 0 ? filters?.[index] : undefined;
    const scope = String(filter?.scope ?? 'unscoped');
    const field = filter?.tag && /^[a-zA-Z0-9_.-]+$/.test(filter.tag) && /^[a-zA-Z0-9_-]+$/.test(scope)
      ? `${scope}.${filter.tag}`
      : `filter ${index + 1} (dynamic or invalid field)`;
    return `Cannot save static search filter ${field}: its value could target a protected attribute. Remove its value or filter.`;
  }
}

export function TraceQLSearchTags({ options, onOptionsChange, datasource }: Props) {
  const [protectionError, setProtectionError] = useState<string>();
  const saveFilters = useCallback((filters: TraceqlFilter[]) => {
    const message = options.jsonData.protectedKeyId ? protectedStaticFilterError(filters) : undefined;
    setProtectionError(message);
    if (message) {
      return;
    }
    updateDatasourcePluginJsonDataOption({ onOptionsChange, options }, 'search', {
      ...options.jsonData.search,
      filters,
    });
  }, [onOptionsChange, options]);

  const fetchTags = async () => {
    if (!datasource) {
      throw new Error('Unable to retrieve datasource');
    }

    try {
      await datasource.languageProvider.start();
    } catch (err) {
      // @ts-ignore
      throw new Error(getErrorMessage(err.data.message, 'Unable to query Tempo'));
    }
  };

  const { error, loading } = useAsync(fetchTags, [datasource, options]);

  const updateFilter = useCallback(
    (filter: TraceqlFilter) => {
      const filters = options.jsonData.search?.filters ?? [];
      const index = filters.findIndex((existing) => existing.id === filter.id);
      saveFilters(index < 0 ? [...filters, filter] : replaceAt(filters, index, filter));
    },
    [options.jsonData.search?.filters, saveFilters]
  );

  const deleteFilter = (filter: TraceqlFilter) => {
    saveFilters((options.jsonData.search?.filters ?? []).filter((existing) => existing.id !== filter.id));
  };

  useEffect(() => {
    if (!options.jsonData.search?.filters) {
      saveFilters([
        { id: 'service-name', tag: 'service.name', operator: '=', scope: TraceqlSearchScope.Resource },
        { id: 'span-name', tag: 'name', operator: '=', scope: TraceqlSearchScope.Span },
      ]);
    }
  }, [options.jsonData.search?.filters, saveFilters]);

  // filter out tags that already exist in TraceQLSearch editor
  const staticTags = ['duration'];

  const missingTag = options.jsonData.search?.filters?.find((f) => !f.tag);

  return (
    <>
      {datasource ? (
        <TagsInput
          updateFilter={updateFilter}
          deleteFilter={deleteFilter}
          filters={options.jsonData.search?.filters || []}
          datasource={datasource}
          setError={() => {}}
          staticTags={staticTags}
          isTagsLoading={loading}
          hideValues={true}
          showLabels={true}
          generateQueryWithoutFilter={() => '{}'}
        />
      ) : (
        <div>Invalid data source, please create a valid data source and try again</div>
      )}
      {protectionError && <Alert title="Unsafe static search filter" severity="error">{protectionError}</Alert>}
      {error && (
        <Alert title={'Unable to fetch TraceQL tags'} severity={'error'} topSpacing={1}>
          {error.message}
        </Alert>
      )}
      {missingTag && (
        <Alert title={'Please ensure each filter has a selected tag'} severity={'warning'} topSpacing={1}></Alert>
      )}
    </>
  );
}
