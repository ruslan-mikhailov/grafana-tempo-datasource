import { css } from '@emotion/css';
import { createRef, PureComponent } from 'react';

import { QueryWithAssistantButton } from '@grafana/assistant';
import { CoreApp, type QueryEditorProps, type SelectableValue } from '@grafana/data';
import { config, reportInteraction } from '@grafana/runtime';
import {
  Button,
  FileDropzone,
  Stack,
  InlineField,
  Input,
  InlineFieldRow,
  Modal,
  RadioButtonGroup,
  type Themeable2,
  withTheme2,
} from '@grafana/ui';

import TraceQLSearch from './SearchTraceQLEditor/TraceQLSearch';
import { ServiceGraphSection } from './ServiceGraphSection';
import { type TempoQueryType } from './dataquery';
import { type TempoDatasource } from './datasource';
import { assertProtectedQueryModelSafe } from './protectedAttributes/model';
import { QueryEditor } from './traceql/QueryEditor';
import { type TempoQuery } from './types';
import { migrateFromSearchToTraceQLSearch } from './utils';

interface Props extends QueryEditorProps<TempoDatasource, TempoQuery>, Themeable2 {
  // should template variables be added to tag options. default true
  addVariablesToOptions?: boolean;
}
interface State {
  uploadModalOpen: boolean;
  keyModalOpen: boolean;
  keyFile?: File;
  keyBusy: boolean;
  keyError?: string;
  queryError?: string;
  keyEpoch: number;
}

// This needs to default to traceql for data sources like Splunk, where clicking on a
// data link should open the traceql tab and run a search based on the configured query.
const DEFAULT_QUERY_TYPE: TempoQueryType = 'traceql';

class TempoQueryFieldComponent extends PureComponent<Props, State> {
  private _isMounted = false;
  private unsubscribeKey?: () => void;
  private sealPending = false;
  private awaitingHostCommit?: TempoQuery;
  private editorCommitSource?: TempoDatasource;
  private editorCommitEpoch?: number;
  private editorCommitType?: TempoQueryType;
  private editorCommit?: (next: TempoQuery) => void;
  private editorPending?: (pending: boolean) => void;
  private readonly keyTextInput = createRef<HTMLInputElement>();
  private readonly keyFileInput = createRef<HTMLInputElement>();

  constructor(props: Props) {
    super(props);
    this.state = {
      uploadModalOpen: false,
      keyBusy: false,
      keyModalOpen: false,
      keyEpoch: props.datasource.protectedKeyEpoch,
    };
  }

  private subscribeDatasource = (datasource: TempoDatasource) => {
    this.unsubscribeKey?.();
    this.unsubscribeKey = datasource.subscribeProtectedKey((keyEpoch) => {
      if (this.props.datasource === datasource) {
        this.sealPending = false;
        this.awaitingHostCommit = undefined;
        if (this.keyTextInput.current) {
          this.keyTextInput.current.value = '';
        }
        if (this.keyFileInput.current) {
          this.keyFileInput.current.value = '';
        }
        this.setState({
          keyEpoch,
          keyModalOpen: false,
          keyFile: undefined,
          keyError: undefined,
        });
      }
    });
    this.setState({
      keyEpoch: datasource.protectedKeyEpoch,
      keyModalOpen: false,
      keyFile: undefined,
      keyError: undefined,
      queryError: undefined,
    });
  };

  componentDidUpdate(previous: Props) {
    if (previous.datasource !== this.props.datasource) {
      this.sealPending = false;
      this.awaitingHostCommit = undefined;
      this.subscribeDatasource(this.props.datasource);
      if (this.keyTextInput.current) {
        this.keyTextInput.current.value = '';
      }
      if (this.keyFileInput.current) {
        this.keyFileInput.current.value = '';
      }
    }
    if (
      this.awaitingHostCommit &&
      this.props.query.query === this.awaitingHostCommit.query &&
      JSON.stringify(this.props.query.filters) === JSON.stringify(this.awaitingHostCommit.filters)
    ) {
      this.awaitingHostCommit = undefined;
    }
    if (previous.query !== this.props.query) {
      this.migrateLegacySearch(this.props.query);
    }
  }

  private migrateLegacySearch = (query: TempoQuery) => {
    if (
      query.spanName ||
      query.serviceName ||
      query.search ||
      query.maxDuration ||
      query.minDuration ||
      query.queryType === 'nativeSearch'
    ) {
      this.onSafeChange(migrateFromSearchToTraceQLSearch(query));
    }
  };

  private onSafeChange = (next: TempoQuery, fromEditor = false): boolean => {
    if ((this.sealPending || this.awaitingHostCommit) && !fromEditor) {
      this.setState({ queryError: 'Complete or unlock the protected query before changing it.' });
      return false;
    }
    const kid = this.props.datasource.instanceSettings.jsonData.protectedKeyId;
    try {
      if (kid) {
        assertProtectedQueryModelSafe(next, kid);
      }
    } catch {
      this.setState({ queryError: 'Protected query cannot be saved until it is sealed or corrected.' });
      return false;
    }
    this.setState({ queryError: undefined });
    if (kid && next !== this.props.query) {
      this.awaitingHostCommit = next;
    }
    this.props.onChange(next);
    return true;
  };

  private onSafeRunQuery = (target: TempoQuery = this.props.query) => {
    if (
      this.sealPending ||
      (this.awaitingHostCommit && (target.queryType === 'traceql' || target.queryType === 'traceqlSearch'))
    ) {
      this.setState({ queryError: 'Complete or unlock the protected query before running it.' });
      return;
    }
    const datasource = this.props.datasource;
    const kid = datasource.instanceSettings.jsonData.protectedKeyId;
    try {
      if (kid) {
        assertProtectedQueryModelSafe(target, kid);
        const sealed =
          target.query?.startsWith('qenc:') ||
          target.filters?.some((filter) =>
            (Array.isArray(filter.value) ? filter.value : [filter.value]).some((value) => value?.startsWith('qenc:'))
          );
        if (
          sealed &&
          (target.queryType === 'traceql' || target.queryType === 'traceqlSearch') &&
          datasource.protectedKey?.kid !== kid
        ) {
          throw new Error('Key unavailable');
        }
      }
    } catch {
      this.setState({ queryError: 'Complete or unlock the protected query before running it.' });
      return;
    }
    this.props.onRunQuery();
  };

  private closeKeyModal = () => {
    if (this.state.keyBusy) {
      return;
    }
    if (this.keyTextInput.current) {
      this.keyTextInput.current.value = '';
    }
    if (this.keyFileInput.current) {
      this.keyFileInput.current.value = '';
    }
    this.setState({ keyModalOpen: false, keyFile: undefined, keyError: undefined });
  };

  private importKey = async () => {
    if (this.state.keyBusy) {
      return;
    }
    const file = this.state.keyFile;
    const text = this.keyTextInput.current?.value ?? '';
    if (!file && !text.trim()) {
      this.setState({ keyError: 'Paste a base64 key or choose a local key file.' });
      return;
    }
    const datasource = this.props.datasource;
    const epoch = datasource.protectedKeyEpoch;
    this.setState({ keyBusy: true, keyError: undefined });
    try {
      const base64 = file ? await file.text() : text;
      if (this._isMounted && this.props.datasource === datasource && datasource.protectedKeyEpoch === epoch) {
        await datasource.importProtectedKey(base64);
      }
    } catch {
      if (this._isMounted && this.props.datasource === datasource && datasource.protectedKeyEpoch === epoch) {
        this.setState({ keyError: 'Unable to import key. Check its base64 bytes and configured key ID.' });
      }
    } finally {
      if (this.keyTextInput.current) {
        this.keyTextInput.current.value = '';
      }
      if (this.keyFileInput.current) {
        this.keyFileInput.current.value = '';
      }
      if (this._isMounted) {
        this.setState({ keyBusy: false, keyFile: undefined });
      }
    }
  };

  // Set the default query type when the component mounts.
  // Also do this if queryType is 'clear' (which is the case when the user changes the query type)
  // otherwise if the user changes the query type and refreshes the page, no query type will be selected
  // which is inconsistent with how the UI was originally when they selected the Tempo data source.
  async componentDidMount() {
    this._isMounted = true;
    this.subscribeDatasource(this.props.datasource);
    this.migrateLegacySearch(this.props.query);

    if (!this.props.query.queryType || this.props.query.queryType === 'clear') {
      this.onSafeChange({
        ...this.props.query,
        queryType: DEFAULT_QUERY_TYPE,
      });
    }
    // TODO: Remove this automatic check for native histograms once Tempo only supports native histograms https://github.com/grafana/grafana/issues/109708
    // indentify the service map can use native histograms
    const timeRange = this.props.range;
    const datasource = this.props.datasource;
    const nativeHistograms = await datasource.getNativeHistograms(timeRange);

    // Ignore a response belonging to an editor whose datasource was replaced.
    if (!this._isMounted || this.props.datasource !== datasource) {
      return;
    }

    const saved = this.onSafeChange({
      ...this.props.query,
      serviceMapUseNativeHistograms: nativeHistograms,
    });
    // Migrate to native histograms
    // this will ensure that on navigating to the query option service map from a url,
    // the service map will be rendered with the native histograms when
    // querytype is serviceMap
    // the serviceMapUseNativeHistograms is undefined
    // and nativeHistograms is true
    if (
      this.props.query.queryType === 'serviceMap' &&
      this.props.query.serviceMapUseNativeHistograms === undefined &&
      // switch from tempo with native histograms to tempo without native histograms
      this.props.query.serviceMapUseNativeHistograms !== nativeHistograms &&
      nativeHistograms &&
      saved
    ) {
      this.onSafeRunQuery();
    }
  }

  componentWillUnmount() {
    this._isMounted = false;
    this.unsubscribeKey?.();
  }

  onClearResults = (): boolean => {
    // Do not discard a draft whose seal has not finished.
    if (this.sealPending || this.awaitingHostCommit) {
      this.setState({ queryError: 'Complete or unlock the protected query before changing it.' });
      return false;
    }
    const clear = { ...this.props.query, queryType: 'clear' as const };
    if (!this.onSafeChange(clear)) {
      return false;
    }
    this.sealPending = false;
    this.awaitingHostCommit = undefined;
    this.onSafeRunQuery(clear);
    return true;
  };

  render() {
    const { query, datasource, app } = this.props;
    const isAlerting = app === CoreApp.UnifiedAlerting;
    const kid = datasource.instanceSettings.jsonData.protectedKeyId;
    const keyLoaded = Boolean(kid && datasource.protectedKey?.kid === kid);
    const editorKey = `${datasource.uid}:${this.state.keyEpoch}`;
    if (
      this.editorCommitSource !== datasource ||
      this.editorCommitEpoch !== datasource.protectedKeyEpoch ||
      this.editorCommitType !== query.queryType
    ) {
      const epoch = datasource.protectedKeyEpoch;
      const queryType = query.queryType;
      const isCurrentEditor = () =>
        this._isMounted &&
        this.props.datasource === datasource &&
        datasource.protectedKeyEpoch === epoch &&
        this.props.query.queryType === queryType;
      this.editorCommitSource = datasource;
      this.editorCommitEpoch = epoch;
      this.editorCommitType = queryType;
      this.editorCommit = (next) => {
        // A seal finished by an editor unmounted on a key or query-type change must not reach Grafana.
        if (isCurrentEditor()) {
          this.onSafeChange(next, true);
        }
      };
      this.editorPending = (pending) => {
        if (isCurrentEditor()) {
          this.sealPending = pending;
        }
      };
    }
    const editorCommit = this.editorCommit!;
    const editorPending = this.editorPending!;
    const graphDatasourceUid = datasource.serviceMap?.datasourceUid;

    const queryTypeOptions: Array<SelectableValue<TempoQueryType>> = [
      { value: 'traceqlSearch', label: 'Search' },
      { value: 'traceql', label: 'TraceQL' },
      { value: 'serviceMap', label: 'Service Graph' },
    ];

    // Assistant receives host query objects, not browser-only drafts.
    const showAssistant =
      !kid &&
      config.featureToggles.queryWithAssistant &&
      (app === CoreApp.Explore || app === CoreApp.Dashboard || app === CoreApp.PanelEditor);
    return (
      <>
        <Modal
          title={'Upload trace'}
          isOpen={this.state.uploadModalOpen}
          onDismiss={() => this.setState({ uploadModalOpen: false })}
        >
          <div className={css({ padding: this.props.theme.spacing(2) })}>
            <FileDropzone
              options={{ multiple: false }}
              onLoad={(result) => {
                if (typeof result !== 'string' && result !== null) {
                  throw Error(`Unexpected result type: ${typeof result}`);
                }
                const upload = { ...query, queryType: 'upload' as const };
                if (this.onSafeChange(upload)) {
                  this.props.datasource.uploadedJson = result;
                  this.setState({ uploadModalOpen: false });
                  this.onSafeRunQuery(upload);
                }
              }}
            />
          </div>
        </Modal>
        {!isAlerting && showAssistant && (
          <InlineFieldRow className={css({ marginBottom: this.props.theme.spacing(1) })}>
            <QueryWithAssistantButton
              currentQuery={query}
              queries={[query]}
              dataSourceInstanceSettings={datasource.instanceSettings}
              datasourceApi={null}
              app={app}
            />
          </InlineFieldRow>
        )}
        {!isAlerting && (
          <InlineFieldRow>
            <InlineField label="Query type" grow={true}>
              <Stack gap={1} alignItems="center" justifyContent="space-between">
                <RadioButtonGroup<TempoQueryType>
                  options={queryTypeOptions}
                  value={query.queryType}
                  onChange={(v) => {
                    if (!this.onClearResults()) {
                      return;
                    }
                    reportInteraction('grafana_traces_query_type_changed', {
                      datasourceType: 'tempo',
                      app: app ?? '',
                      grafana_version: config.buildInfo.version,
                      newQueryType: v,
                      previousQueryType: query.queryType ?? '',
                    });
                    this.onSafeChange({ ...query, queryType: v });
                  }}
                  size="md"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    this.setState({ uploadModalOpen: true });
                  }}
                >
                  Import trace
                </Button>
              </Stack>
            </InlineField>
          </InlineFieldRow>
        )}
        {!isAlerting && kid && (
          <>
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: this.props.theme.spacing(1),
                marginBottom: this.props.theme.spacing(1),
              })}
            >
              <span>Protected attributes</span>
              <span role="status">{keyLoaded ? `Key loaded · ${kid.slice(0, 8)}…${kid.slice(-5)}` : 'Key needed'}</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => this.setState({ keyModalOpen: true, keyError: undefined })}
              >
                {keyLoaded ? 'Replace key' : 'Load key'}
              </Button>
              {keyLoaded && (
                <Button variant="secondary" size="sm" onClick={() => datasource.clearProtectedKey()}>
                  Forget key
                </Button>
              )}
            </div>
            <Modal title="Load protected key" isOpen={this.state.keyModalOpen} onDismiss={this.closeKeyModal}>
              <div
                className={css({
                  display: 'grid',
                  gap: this.props.theme.spacing(2),
                  padding: this.props.theme.spacing(2),
                })}
              >
                <p>
                  Expected key ID: <code>{kid}</code>
                </p>
                <label htmlFor={`protected-key-${datasource.uid}`}>Paste base64 key</label>
                <Input
                  id={`protected-key-${datasource.uid}`}
                  aria-label="Paste base64 key"
                  type="password"
                  autoComplete="off"
                  className={css({ display: 'block', width: '100%' })}
                  ref={this.keyTextInput}
                  disabled={this.state.keyBusy}
                  onChange={() => {
                    if (this.state.keyFile || this.state.keyError) {
                      if (this.keyFileInput.current) {
                        this.keyFileInput.current.value = '';
                      }
                      this.setState({ keyFile: undefined, keyError: undefined });
                    }
                  }}
                />

                <Stack gap={1} alignItems="center">
                  <span>or</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={this.state.keyBusy}
                    onClick={() => this.keyFileInput.current?.click()}
                  >
                    Choose local key file
                  </Button>
                  {this.state.keyFile && <span>{this.state.keyFile.name}</span>}
                </Stack>
                <input
                  aria-label="Protected key file"
                  type="file"
                  accept=".txt,.key,text/plain"
                  ref={this.keyFileInput}
                  disabled={this.state.keyBusy}
                  className={css({ display: 'none' })}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) {
                      if (this.keyTextInput.current) {
                        this.keyTextInput.current.value = '';
                      }
                      this.setState({ keyFile: file, keyError: undefined });
                    }
                  }}
                />
                <p>
                  The key stays in browser memory and is forgotten on reload. It is not saved or sent to Grafana or
                  Tempo. Existing encrypted results become readable when the key loads.
                </p>
                <details>
                  <summary>About protected attributes</summary>
                  <p>
                    Only stored enc.* span attributes are protected; query them as span.enc.*. Equal values in the same
                    field remain recognizable in ciphertext. Unprefixed attributes and searches are not protected.
                  </p>
                </details>
                {this.state.keyError && <div role="alert">{this.state.keyError}</div>}
                <Stack gap={1} justifyContent="flex-end">
                  <Button variant="secondary" disabled={this.state.keyBusy} onClick={this.closeKeyModal}>
                    Cancel
                  </Button>
                  <Button disabled={this.state.keyBusy} onClick={() => void this.importKey()}>
                    Load key
                  </Button>
                </Stack>
              </div>
            </Modal>
          </>
        )}
        {this.state.queryError && <div role="alert">{this.state.queryError}</div>}
        {query.queryType === 'traceqlSearch' && (
          <TraceQLSearch
            key={editorKey}
            datasource={datasource}
            query={query}
            onChange={editorCommit}
            onPendingChange={editorPending}
            onBlur={this.props.onBlur}
            app={app}
            onClearResults={this.onClearResults}
            addVariablesToOptions={this.props.addVariablesToOptions}
            range={this.props.range}
          />
        )}
        {query.queryType === 'serviceMap' && (
          <ServiceGraphSection graphDatasourceUid={graphDatasourceUid} query={query} onChange={this.onSafeChange} />
        )}
        {query.queryType === 'traceql' && (
          <QueryEditor
            key={editorKey}
            datasource={datasource}
            query={query}
            onRunQuery={this.onSafeRunQuery}
            onChange={editorCommit}
            onPendingChange={editorPending}
            app={app}
            onClearResults={this.onClearResults}
            range={this.props.range}
          />
        )}
      </>
    );
  }
}

const TempoQueryField = withTheme2(TempoQueryFieldComponent);

export default TempoQueryField;
