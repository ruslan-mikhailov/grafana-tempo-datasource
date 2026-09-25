import { css } from '@emotion/css';
import { useEffect, useState } from 'react';

import { type DataSourcePluginOptionsEditorProps, type GrafanaTheme2 } from '@grafana/data';
import {
  NodeGraphSection,
  SpanBarSection,
  TraceToLogsSection,
  TraceToMetricsSection,
  TraceToProfilesSection,
} from '@grafana/o11y-ds-frontend';
import {
  AdvancedHttpSettings,
  Auth,
  ConfigSection,
  ConfigDescriptionLink,
  ConfigSubSection,
  ConnectionSettings,
  convertLegacyAuthProps,
  DataSourceDescription,
} from '@grafana/plugin-ui';
import { config } from '@grafana/runtime';
import { SecureSocksProxySettings, useStyles2, Divider, Stack, InlineField, Input } from '@grafana/ui';

import { type TempoJsonData } from '../types';
import { QuerySettings } from './QuerySettings';
import { ServiceGraphSettings } from './ServiceGraphSettings';
import { StreamingSection } from './StreamingSection';
import { TagLimitSection } from './TagLimitSettings';
import { TagsTimeRangeSettings } from './TagsTimeRangeSettings';
import { TraceQLSearchSettings } from './TraceQLSearchSettings';
import { protectedStaticFilterError } from './TraceQLSearchTags';

export type ConfigEditorProps = DataSourcePluginOptionsEditorProps<TempoJsonData>;

const ConfigEditor = ({ options, onOptionsChange }: ConfigEditorProps) => {
  const styles = useStyles2(getStyles);
  const [keyIdDraft, setKeyIdDraft] = useState(options.jsonData.protectedKeyId ?? '');
  const [keyIdError, setKeyIdError] = useState<string>();

  useEffect(() => {
    setKeyIdDraft(options.jsonData.protectedKeyId ?? '');
  }, [options.jsonData.protectedKeyId]);

  const guardedOptionsChange: ConfigEditorProps['onOptionsChange'] = (next) => {
    const keyId = next.jsonData.protectedKeyId;
    if (keyId && !/^[0-9a-f]{32}$/.test(keyId)) {
      setKeyIdError('Key ID must be exactly 32 lowercase hexadecimal characters.');
      return;
    }
    const unsafeFilter = keyId ? protectedStaticFilterError(next.jsonData.search?.filters) : undefined;
    if (unsafeFilter) {
      setKeyIdError(unsafeFilter);
      return;
    }
    setKeyIdError(undefined);
    onOptionsChange(next);
  };
  return (
    <div className={styles.container}>
      <DataSourceDescription
        dataSourceName="Tempo"
        docsLink="https://grafana.com/docs/grafana/latest/datasources/tempo"
        hasRequiredFields={false}
      />

      <Divider spacing={4} />
      <ConnectionSettings config={options} onChange={guardedOptionsChange} urlPlaceholder="http://localhost:3200" />

      <Divider spacing={4} />
      <Auth
        {...convertLegacyAuthProps({
          config: options,
          onChange: guardedOptionsChange,
        })}
      />
      <Divider spacing={4} />

      <StreamingSection options={options} onOptionsChange={guardedOptionsChange} />
      <Divider spacing={4} />

      <TraceToLogsSection options={options} onOptionsChange={guardedOptionsChange} />
      <Divider spacing={4} />

      <TraceToMetricsSection options={options} onOptionsChange={guardedOptionsChange} />
      <Divider spacing={4} />

      <TraceToProfilesSection options={options} onOptionsChange={guardedOptionsChange} />
      <Divider spacing={4} />

      <ConfigSection
        title="Additional settings"
        description="Additional settings are optional settings that can be configured for more control over your data source."
        isCollapsible={true}
        isInitiallyOpen={false}
      >
        <Stack gap={5} direction="column">
          <AdvancedHttpSettings config={options} onChange={guardedOptionsChange} />

          {config.secureSocksDSProxyEnabled && (
            <SecureSocksProxySettings options={options} onOptionsChange={guardedOptionsChange} />
          )}

          <ConfigSubSection
            title="Protected span attributes"
            description="Configure the public fingerprint of the browser-imported key. This is not the key and does not encrypt existing traces."
          >
            <InlineField label="Key ID" labelWidth={26} tooltip="32 lowercase hexadecimal characters; import the matching key in Explore.">
              <Input
                aria-label="Protected key ID"
                value={keyIdDraft}
                placeholder="32 lowercase hexadecimal characters"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setKeyIdDraft(value);
                  if (value && !/^[0-9a-f]{32}$/.test(value)) {
                    setKeyIdError('Key ID must be exactly 32 lowercase hexadecimal characters.');
                    return;
                  }
                  guardedOptionsChange({
                    ...options,
                    jsonData: { ...options.jsonData, protectedKeyId: value || undefined },
                  });
                }}
              />
            </InlineField>
            {keyIdError && <div role="alert">{keyIdError}</div>}
          </ConfigSubSection>

          <ConfigSubSection
            title="Service graph"
            description={
              <ConfigDescriptionLink
                description="Select a Prometheus data source that contains the service graph data."
                suffix="tempo/configure-tempo-data-source/#service-graph"
                feature="the service graph"
              />
            }
          >
            <ServiceGraphSettings options={options} onOptionsChange={guardedOptionsChange} />
          </ConfigSubSection>

          <NodeGraphSection options={options} onOptionsChange={guardedOptionsChange} />

          <ConfigSubSection
            title="Tempo search"
            description={
              <ConfigDescriptionLink
                description="Modify how traces are searched."
                suffix="tempo/configure-tempo-data-source/#tempo-search"
                feature="Tempo search"
              />
            }
          >
            <TraceQLSearchSettings options={options} onOptionsChange={guardedOptionsChange} />
          </ConfigSubSection>

          <ConfigSubSection
            title="TraceID query"
            description={
              <ConfigDescriptionLink
                description="Modify how TraceID queries are run."
                suffix="tempo/configure-tempo-data-source/#traceid-query"
                feature="the TraceID query"
              />
            }
          >
            <QuerySettings options={options} onOptionsChange={guardedOptionsChange} />
          </ConfigSubSection>

          <ConfigSubSection
            title="Tags time range"
            description={
              <ConfigDescriptionLink
                description="Modify how tags and tag values queries are run."
                suffix="tempo/configure-tempo-data-source/#tags-time-range"
                feature="the tags time range"
              />
            }
          >
            <TagsTimeRangeSettings options={options} onOptionsChange={guardedOptionsChange} />
          </ConfigSubSection>

          <TagLimitSection options={options} onOptionsChange={guardedOptionsChange} />
          <SpanBarSection options={options} onOptionsChange={guardedOptionsChange} />
        </Stack>
      </ConfigSection>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    marginBottom: theme.spacing(2),
    maxWidth: '900px',
  }),
});

export default ConfigEditor;
