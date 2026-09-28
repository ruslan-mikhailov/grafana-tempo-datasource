import { css } from '@emotion/css';
import { defaults } from 'lodash';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CoreApp, type GrafanaTheme2, type QueryEditorProps } from '@grafana/data';
import { config, reportInteraction } from '@grafana/runtime';
import { Alert, Button, InlineLabel, TextLink, useStyles2 } from '@grafana/ui';

import { type TempoDatasource } from '../datasource';
import {
  assertProtectedQueryModelSafe,
  openProtectedQueryModel,
  prepareProtectedQueryModel,
} from '../protectedAttributes/model';
import { defaultQuery, type MyDataSourceOptions, type TempoQuery } from '../types';

import { TempoQueryBuilderOptions } from './TempoQueryBuilderOptions';
import { TraceQLEditor } from './TraceQLEditor';

type EditorProps = {
  onClearResults: () => boolean | void;
  onPendingChange?: (pending: boolean) => void;
};

type Props = EditorProps & QueryEditorProps<TempoDatasource, TempoQuery, MyDataSourceOptions>;

export function QueryEditor(props: Props) {
  const styles = useStyles2(getStyles);
  const query = defaults(props.query, defaultQuery);
  const [showCopyFromSearchButton, setShowCopyFromSearchButton] = useState(() => {
    if (props.datasource.instanceSettings?.jsonData?.protectedAttributesEnabled) {
      return false;
    }
    const genQuery = props.datasource.languageProvider.generateQueryFromFilters({
      traceqlFilters: query.filters || [],
    });
    return genQuery === query.query || genQuery === '{}';
  });
  const [copyError, setCopyError] = useState<string>();
  const generation = useRef(0);
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const rawPending = useRef(false);
  const copyPending = useRef(false);
  const onRawPendingChange = useCallback(
    (pending: boolean) => {
      rawPending.current = pending;
      if (pending) {
        generation.current++;
        copyPending.current = false;
      }
      props.onPendingChange?.(pending || copyPending.current);
    },
    [props.onPendingChange]
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const copyFromSearch = async () => {
    const current = ++generation.current;
    const original = query;
    copyPending.current = true;
    props.onPendingChange?.(true);
    try {
      const protectedMode = props.datasource.instanceSettings?.jsonData?.protectedAttributesEnabled;
      const key = props.datasource.protectedKey;
      if (protectedMode) {
        assertProtectedQueryModelSafe(
          query,
          (props.datasource.protectedKeys ?? (key ? [key] : [])).map((item) => item.kid)
        );
      }
      const opened = protectedMode
        ? await openProtectedQueryModel(
            query,
            props.datasource.getProtectedKey?.bind(props.datasource) ?? key,
            props.datasource.uid
          )
        : query;
      const raw = props.datasource.languageProvider.generateQueryFromFilters({
        traceqlFilters: opened.filters || [],
      });
      const candidate: TempoQuery = { ...query, query: raw, queryType: 'traceql' };
      const sealed =
        protectedMode && key
          ? await prepareProtectedQueryModel(
              candidate,
              key,
              props.datasource.uid,
              query,
              props.datasource.getProtectedKey?.bind(props.datasource)
            )
          : candidate;
      if (protectedMode) {
        assertProtectedQueryModelSafe(
          sealed,
          (props.datasource.protectedKeys ?? (key ? [key] : [])).map((item) => item.kid)
        );
      }
      if (
        generation.current === current &&
        latestQuery.current === original &&
        !rawPending.current &&
        (!protectedMode || props.datasource.protectedKey === key)
      ) {
        copyPending.current = false;
        props.onPendingChange?.(false);
        if (props.onClearResults() === false) {
          throw new Error('Cannot clear while the previous query is pending');
        }
        props.onChange(sealed);
        setShowCopyFromSearchButton(true);
      }
    } catch {
      setCopyError('Unlock or correct protected search filters before copying');
    } finally {
      if (generation.current === current) {
        copyPending.current = false;
        props.onPendingChange?.(rawPending.current);
      }
    }
  };

  const alertingWarning = (
    <Alert title="Tempo metrics is an experimental feature" severity="warning">
      Please note that TraceQL metrics is an experimental feature and should not be used in production. Read more about
      it in{' '}
      <TextLink external href="https://grafana.com/docs/tempo/latest/operations/traceql-metrics/">
        documentation
      </TextLink>
      .
    </Alert>
  );
  const inAlerting = props.app === CoreApp.UnifiedAlerting || props.app === CoreApp.CloudAlerting;

  return (
    <>
      {inAlerting && alertingWarning}
      <InlineLabel>
        Build complex queries using TraceQL to select a list of traces.{' '}
        <TextLink external href="https://grafana.com/docs/tempo/latest/traceql/">
          Documentation
        </TextLink>
      </InlineLabel>
      {!showCopyFromSearchButton && (
        <div className={styles.copyContainer}>
          <span>Continue editing the query from the Search tab?</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              reportInteraction('grafana_traces_copy_to_traceql_clicked', {
                app: props.app ?? '',
                grafana_version: config.buildInfo.version,
                location: 'traceql_tab',
              });

              void copyFromSearch();
            }}
            style={{ marginLeft: '10px' }}
          >
            Copy query from Search
          </Button>
        </div>
      )}
      {copyError && <Alert severity="error" title={copyError} />}
      <TraceQLEditor
        placeholder="Enter a TraceQL query or trace ID (run with Shift+Enter)"
        query={query}
        onChange={props.onChange}
        onPendingChange={onRawPendingChange}
        datasource={props.datasource}
        onRunQuery={props.onRunQuery}
        range={props.range}
      />
      <div className={styles.optionsContainer}>
        <TempoQueryBuilderOptions
          query={query}
          onChange={(next) => {
            if (rawPending.current || copyPending.current) {
              setCopyError('Complete or unlock the query before changing options');
              return;
            }
            props.onChange(next);
          }}
          searchStreaming={props.datasource.isStreamingSearchEnabled() ?? false}
          metricsStreaming={props.datasource.isStreamingMetricsEnabled() ?? false}
          app={props.app}
        />
      </div>
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  optionsContainer: css({
    marginTop: '10px',
  }),
  copyContainer: css({
    backgroundColor: theme.colors.background.secondary,
    padding: theme.spacing(0.5, 1),
    fontSize: theme.typography.body.fontSize,
  }),
});
