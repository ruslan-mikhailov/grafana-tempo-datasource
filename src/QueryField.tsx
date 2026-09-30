import { css } from '@emotion/css';
import { createRef, PureComponent, type ClipboardEvent } from 'react';

import { QueryWithAssistantButton } from '@grafana/assistant';
import { CoreApp, type QueryEditorProps, type SelectableValue } from '@grafana/data';
import { config, reportInteraction } from '@grafana/runtime';
import {
  Button,
  Icon,
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
import { importKey } from './protectedAttributes/crypto';
import { registerProtectedKeyRequest } from './protectedAttributes/display';
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
  keyView?: 'import' | 'manager';
  requestedKid?: string;
  importMethod: 'paste' | 'file';
  keyFiles?: File[];
  keyInputCount: number;
  keyBusy: boolean;
  keyForgetBusy: boolean;
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
  private unsubscribeKeyRequest?: () => void;
  private sealPending = false;
  private awaitingHostCommit?: TempoQuery;
  private editorCommitSource?: TempoDatasource;
  private editorCommitEpoch?: number;
  private editorCommitType?: TempoQueryType;
  private editorCommit?: (next: TempoQuery) => void;
  private editorPending?: (pending: boolean) => void;
  private readonly keyTextInputs: Array<HTMLInputElement | null> = [];
  private readonly keyAliasInputs: Array<HTMLInputElement | null> = [];
  private readonly keyAliases = new Map<string, string>();
  private readonly keyFileInput = createRef<HTMLInputElement>();
  private keyImportSequence = 0;
  private keyImportController?: AbortController;
  private readonly protectedKeyLabel = (kid: string): string => {
    const shortened = `${kid.slice(0, 8)}…${kid.slice(-6)}`;
    const alias = this.keyAliases.get(kid);
    return alias ? `${alias} · ${shortened}` : shortened;
  };

  constructor(props: Props) {
    super(props);
    this.state = {
      uploadModalOpen: false,
      keyBusy: false,
      keyForgetBusy: false,
      importMethod: 'paste',
      keyInputCount: 1,
      keyEpoch: props.datasource.protectedKeyEpoch,
    };
  }

  private subscribeDatasource = (datasource: TempoDatasource) => {
    this.unsubscribeKey?.();
    this.unsubscribeKeyRequest?.();
    this.unsubscribeKeyRequest = registerProtectedKeyRequest((kid) => {
      if (
        !this._isMounted ||
        this.props.datasource !== datasource ||
        !datasource.instanceSettings.jsonData.protectedAttributesEnabled ||
        this.props.app === CoreApp.UnifiedAlerting ||
        this.state.keyBusy
      ) {
        return false;
      }
      this.clearKeyInputs();
      if (this.keyFileInput.current) {
        this.keyFileInput.current.value = '';
      }
      this.setState({ keyView: 'import', requestedKid: kid, importMethod: 'paste', keyInputCount: 1, keyFiles: undefined, keyError: undefined });
      return true;
    });
    this.unsubscribeKey = datasource.subscribeProtectedKey((keyEpoch) => {
      if (this.props.datasource === datasource) {
        this.keyImportController?.abort();
        for (const aliasKid of this.keyAliases.keys()) {
          if (!datasource.getProtectedKey(aliasKid)) {
            this.keyAliases.delete(aliasKid);
          }
        }
        this.keyImportSequence++;
        this.sealPending = false;
        this.awaitingHostCommit = undefined;
        this.clearKeyInputs();
        if (this.keyFileInput.current) {
          this.keyFileInput.current.value = '';
        }
        this.setState({
          keyEpoch,
          keyView: this.state.keyView === 'manager' ? 'manager' : undefined,
          requestedKid: undefined,
          importMethod: 'paste',
          keyInputCount: 1,
          keyFiles: undefined,
          keyBusy: false,
          keyError: undefined,
        });
      }
    });
    this.setState({
      keyEpoch: datasource.protectedKeyEpoch,
      keyView: undefined,
      requestedKid: undefined,
      importMethod: 'paste',
      keyInputCount: 1,
      keyFiles: undefined,
      keyBusy: false,
      keyForgetBusy: false,
      keyError: undefined,
      queryError: undefined,
    });
  };

  componentDidUpdate(previous: Props) {
    if (previous.datasource !== this.props.datasource) {
      this.keyImportController?.abort();
      this.keyAliases.clear();
      this.keyImportSequence++;
      this.sealPending = false;
      this.awaitingHostCommit = undefined;
      this.clearKeyInputs();
      if (this.keyFileInput.current) {
        this.keyFileInput.current.value = '';
      }
      this.subscribeDatasource(this.props.datasource);
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
    const protectedMode = this.props.datasource.instanceSettings.jsonData.protectedAttributesEnabled;
    const keys =
      this.props.datasource.protectedKeys ??
      (this.props.datasource.protectedKey ? [this.props.datasource.protectedKey] : []);
    const kids = keys.map((key) => key.kid);
    try {
      if (protectedMode) {
        assertProtectedQueryModelSafe(next, kids, !!this.props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
      }
    } catch {
      this.setState({ queryError: 'Protected query cannot be saved until it is sealed or corrected.' });
      return false;
    }
    this.setState({ queryError: undefined });
    if (protectedMode && next !== this.props.query) {
      this.awaitingHostCommit = next;
    }
    this.props.onChange(next);
    return true;
  };

  private onSafeRunQuery = (target: TempoQuery = this.props.query) => {
    if (this.props.datasource.protectedKeyStorageState === 'loading') {
      const datasource = this.props.datasource;
      void datasource.whenProtectedKeysReady().then(() => {
        if (this._isMounted && this.props.datasource === datasource) {
          this.onSafeRunQuery(target);
        }
      });
      return;
    }
    if (this.sealPending) {
      this.setState({ queryError: 'Complete or correct the query before running it.' });
      return;
    }
    if (this.awaitingHostCommit && (target.queryType === 'traceql' || target.queryType === 'traceqlSearch')) {
      this.setState({ queryError: 'Wait for the protected query to be saved before running it.' });
      return;
    }
    const datasource = this.props.datasource;
    const protectedMode = datasource.instanceSettings.jsonData.protectedAttributesEnabled;
    const keys = datasource.protectedKeys ?? (datasource.protectedKey ? [datasource.protectedKey] : []);
    try {
      if (protectedMode) {
        assertProtectedQueryModelSafe(
          target,
          keys.map((key) => key.kid),
          !!datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
        );
        const sealedValues = [
          target.query,
          ...(target.filters ?? []).flatMap((filter) => (Array.isArray(filter.value) ? filter.value : [filter.value])),
        ];
        if (
          (target.queryType === 'traceql' || target.queryType === 'traceqlSearch') &&
          sealedValues.some(
            (value) => value?.startsWith('qenc:') && !keys.some((key) => value.startsWith(`qenc:v1:${key.kid}:`))
          )
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

  private clearKeyInputs = () => {
    for (const input of [...this.keyTextInputs, ...this.keyAliasInputs]) {
      if (input) {
        input.value = '';
      }
    }
  };

  private pasteKeys = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[\r\n]/.test(pasted)) {
      return;
    }
    event.preventDefault();
    const keys = pasted
      .split(/\r\n|\r|\n/)
      .map((key) => key.trim())
      .filter(Boolean);
    for (const input of this.keyTextInputs.slice(index)) {
      if (input) {
        input.value = '';
      }
    }
    if (this.keyFileInput.current) {
      this.keyFileInput.current.value = '';
    }
    this.setState({ keyInputCount: index + Math.max(keys.length, 1), keyFiles: undefined, keyError: undefined }, () =>
      keys.forEach((key, offset) => {
        const input = this.keyTextInputs[index + offset];
        if (input) {
          input.value = key;
        }
      })
    );
  };

  private closeKeyModal = () => {
    this.keyImportController?.abort();
    this.keyImportSequence++;
    this.clearKeyInputs();
    if (this.keyFileInput.current) {
      this.keyFileInput.current.value = '';
    }
    this.setState({
      keyView: undefined,
      requestedKid: undefined,
      importMethod: 'paste',
      keyInputCount: 1,
      keyFiles: undefined,
      keyBusy: false,
      keyError: undefined,
    });
  };

  private forgetKey = async (kid?: string) => {
    if (this.state.keyForgetBusy) {
      return;
    }
    const datasource = this.props.datasource;
    this.setState({ keyForgetBusy: true, keyError: undefined });
    const forgotten = kid
      ? await datasource.clearProtectedKey(kid)
      : await datasource.clearAllProtectedKeys();
    if (this._isMounted && this.props.datasource === datasource) {
      this.setState({
        keyForgetBusy: false,
        keyError: forgotten ? undefined : 'The key was cleared from this page, but its saved browser copy may return after refresh. Retry removal or clear this site’s browser data.',
      });
    }
  };

  private importKey = async () => {
    if (this.state.keyBusy) {
      return;
    }
    const files = this.state.importMethod === 'file' ? this.state.keyFiles : undefined;
    const entries = this.keyTextInputs.map((input, index) => ({
      value: input?.value.trim() ?? '',
      alias: this.keyAliasInputs[index]?.value.trim() ?? '',
    })).filter((entry) => entry.value);
    if (!files?.length && entries.length === 0) {
      this.setState({ keyError: 'Paste a base64 key or choose a local key file.' });
      return;
    }
    const datasource = this.props.datasource;
    const epoch = datasource.protectedKeyEpoch;
    const sequence = ++this.keyImportSequence;
    const controller = new AbortController();
    this.keyImportController = controller;
    this.setState({ keyBusy: true, keyError: undefined });
    try {
      if (files?.some((file) => file.size > 64 * 1024)) {
        throw new Error('Key file exceeds the maximum size.');
      }
      const base64Keys = files?.length
        ? (await Promise.all(files.map((file) => file.text()))).flatMap((content) => {
            const lines = content
              .split(/\r\n|\r|\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            return lines.length ? lines : [''];
          })
        : entries.map((entry) => entry.value);
      if (this.state.requestedKid) {
        const requestedKid = this.state.requestedKid;
        let foundMatch = false;
        for (const base64 of base64Keys) {
          if (controller.signal.aborted || this.keyImportSequence !== sequence) {
            return;
          }
          const staged = await importKey(base64);
          foundMatch ||= staged.kid === requestedKid;
          staged.clear();
        }
        if (!foundMatch) {
          throw new Error('Key does not match the required ID.');
        }
      }
      if (
        this._isMounted &&
        this.props.datasource === datasource &&
        datasource.protectedKeyEpoch === epoch &&
        this.keyImportSequence === sequence
      ) {
        const importedKids = await datasource.importProtectedKeys(base64Keys, controller.signal);
        // This import's synchronous key notification advances both counters before the promise resolves.
        // A later notification, replacement datasource, or unmount must not attach an alias to stale keys.
        if (
          this._isMounted &&
          this.props.datasource === datasource &&
          datasource.protectedKeyEpoch === epoch + 1 &&
          this.keyImportSequence === sequence + 1
        ) {
          let aliasesChanged = false;
          importedKids.forEach((importedKid, index) => {
            const alias = files?.length ? '' : entries[index]?.alias;
            if (alias) {
              this.keyAliases.set(importedKid, alias);
              aliasesChanged = true;
            }
          });
          if (aliasesChanged) {
            this.forceUpdate();
          }
        }
      }
    } catch (error) {
      if (
        this._isMounted &&
        this.props.datasource === datasource &&
        datasource.protectedKeyEpoch === epoch &&
        this.keyImportSequence === sequence
      ) {
        this.setState({
          keyError: error instanceof Error && error.message === 'Key file exceeds the maximum size.'
            ? 'A key file exceeds 64 KB'
            : error instanceof Error && error.message === 'Key does not match the required ID.'
              ? 'Key does not match the required ID. No keys were loaded.'
              : 'Unable to import keys. Check that every key contains 32 valid base64-encoded bytes.',
        });
      }
    } finally {
      if (this.keyImportController === controller) {
        this.keyImportController = undefined;
      }
      if (this._isMounted && this.props.datasource === datasource && this.keyImportSequence === sequence) {
        this.clearKeyInputs();
        if (this.keyFileInput.current) {
          this.keyFileInput.current.value = '';
        }
        this.setState({ keyBusy: false, keyInputCount: 1, keyFiles: undefined });
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
    this.keyImportController?.abort();
    this.unsubscribeKey?.();
    this.unsubscribeKeyRequest?.();
  }

  onClearResults = (): boolean => {
    // Do not discard a draft whose seal has not finished.
    if (this.sealPending || this.awaitingHostCommit) {
      this.setState({ queryError: 'Complete or unlock the protected query before changing it.' });
      return false;
    }
    const clear = { ...this.props.query, queryType: 'clear' as const };
    delete clear.protectedQueryKeys;
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
    const protectedMode = datasource.instanceSettings.jsonData.protectedAttributesEnabled;
    const keys = datasource.protectedKeys ?? (datasource.protectedKey ? [datasource.protectedKey] : []);
    const keyLoaded = keys.length > 0;
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
      !protectedMode &&
      config.featureToggles.queryWithAssistant &&
      (app === CoreApp.Explore || app === CoreApp.Dashboard || app === CoreApp.PanelEditor);
    const storageState = datasource.protectedKeyStorageState;
    const storageDescription = storageState === 'persistent'
      ? 'Keys are saved in this browser profile and restored after navigation or refresh. Logging out does not erase them; someone with access to this browser profile can use them. Forget removes the saved copy.'
      : storageState === 'loading'
        ? 'Restoring keys saved in this browser profile.'
        : 'Browser storage is unavailable. Keys remain in memory for this page and are cleared on refresh.';
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
                delete upload.protectedQueryKeys;
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
                    const next = { ...query, queryType: v };
                    delete next.protectedQueryKeys;
                    this.onSafeChange(next);
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
        {!isAlerting && protectedMode && (
          <>
            <div className={css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: this.props.theme.spacing(1), marginBottom: this.props.theme.spacing(1) })}>
              <Icon name="shield" aria-hidden="true" />
              <strong>Protected data</strong><span aria-hidden="true">·</span>
              <span role="status">{keyLoaded ? `${keys.length} ${keys.length === 1 ? 'key' : 'keys'} loaded` : 'No keys loaded'}</span>
              <Button variant="secondary" size="sm" onClick={() => this.setState({ keyView: keyLoaded ? 'manager' : 'import', requestedKid: undefined, keyError: undefined })}>
                {keyLoaded ? 'Manage keys' : 'Load keys'}
              </Button>
            </div>
            <Modal title={this.state.requestedKid ? 'Load matching key' : 'Load keys'} isOpen={this.state.keyView === 'import'} onDismiss={this.closeKeyModal}>
              <div className={css({ display: 'grid', gap: this.props.theme.spacing(2), padding: this.props.theme.spacing(2) })}>
                {this.state.requestedKid && <div>Required key ID: <code>{this.state.requestedKid}</code></div>}
                <div><strong>Browser keys</strong><span> · {storageDescription} Keys are not sent to Grafana, Tempo, or Loki.</span></div>
                <RadioButtonGroup<'paste' | 'file'>
                  options={[{ label: 'Paste keys', value: 'paste' }, { label: 'Import files', value: 'file' }]}
                  value={this.state.importMethod}
                  onChange={(importMethod) => {
                    this.clearKeyInputs();
                    if (this.keyFileInput.current) {
                      this.keyFileInput.current.value = '';
                    }
                    this.setState({ importMethod, keyFiles: undefined, keyInputCount: 1, keyError: undefined });
                  }}
                  size="md"
                />
                {this.state.importMethod === 'paste' ? (
                  <>
                    <span>Paste newline-separated keys to fill masked fields.</span>
                    {Array.from({ length: this.state.keyInputCount }, (_, index) => (
                      <div key={index} className={css({ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: this.props.theme.spacing(1), alignItems: 'end' })}>
                        <div>
                          <label htmlFor={`protected-key-${datasource.uid}-${index}`}>{index === 0 ? 'Paste base64 key' : `Paste base64 key ${index + 1}`}</label>
                          <Input
                            id={`protected-key-${datasource.uid}-${index}`}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            className={css({ display: 'block', width: '100%' })}
                            ref={(input) => { this.keyTextInputs[index] = input; }}
                            disabled={this.state.keyBusy}
                            onPaste={(event) => this.pasteKeys(index, event)}
                            onChange={() => this.state.keyError && this.setState({ keyError: undefined })}
                          />
                        </div>
                        <div>
                          <label htmlFor={`protected-name-${datasource.uid}-${index}`}>Local name (optional)</label>
                          <Input
                            id={`protected-name-${datasource.uid}-${index}`}
                            autoComplete="off"
                            className={css({ display: 'block', width: '100%' })}
                            ref={(input) => { this.keyAliasInputs[index] = input; }}
                            disabled={this.state.keyBusy}
                          />
                        </div>
                      </div>
                    ))}
                    <Button variant="secondary" size="sm" disabled={this.state.keyBusy} onClick={() => this.setState({ keyInputCount: this.state.keyInputCount + 1, keyError: undefined })}>Add another key</Button>
                  </>
                ) : (
                  <>
                    <span>Each file may contain newline-separated keys.</span>
                    <div className={css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: this.props.theme.spacing(1) })}>
                      <Button variant="secondary" size="sm" disabled={this.state.keyBusy} onClick={() => this.keyFileInput.current?.click()}>Choose local key files</Button>
                      <span aria-live="polite">{this.state.keyFiles?.length ? `${this.state.keyFiles.length} file(s) selected` : 'No files selected'}</span>
                    </div>
                    {this.state.keyFiles?.length ? <span>{this.state.keyFiles.map((file) => file.name).join(', ')}</span> : null}
                    <input
                      aria-label="Protected key file"
                      type="file"
                      multiple
                      accept=".txt,.key,text/plain"
                      ref={this.keyFileInput}
                      disabled={this.state.keyBusy}
                      className={css({ display: 'none' })}
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        if (files.length) {
                          this.setState({ keyFiles: files, keyError: undefined });
                        }
                      }}
                    />
                  </>
                )}
                {this.state.keyError && <div role="alert">{this.state.keyError}</div>}
                <Stack gap={1} justifyContent="flex-end">
                  <Button variant="secondary" onClick={this.closeKeyModal}>Cancel</Button>
                  <Button disabled={this.state.keyBusy} onClick={() => void this.importKey()}>Add keys</Button>
                </Stack>
              </div>
            </Modal>
            <Modal title="Browser keys" isOpen={this.state.keyView === 'manager'} onDismiss={() => {
              if (!this.state.keyForgetBusy) {
                this.closeKeyModal();
              }
            }}>
              <div className={css({ display: 'grid', gap: this.props.theme.spacing(2), padding: this.props.theme.spacing(2) })}>
                <div><strong>Browser keys</strong><span> · {storageDescription} Keys are not sent to Grafana, Tempo, or Loki.</span></div>
                {keys.length === 0 && <span>{storageState === 'loading' ? 'Restoring saved keys…' : 'No keys loaded. Public data is still available.'}</span>}
                {keys.map((key) => (
                  <div key={key.kid} className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: this.props.theme.spacing(1) })}>
                    <div>
                      {this.keyAliases.get(key.kid) && <strong>{this.keyAliases.get(key.kid)} · </strong>}
                      <code>{key.kid}</code>
                    </div>
                    <Button variant="secondary" size="sm" aria-label={`Forget key ${key.kid}`} disabled={this.state.keyForgetBusy} onClick={() => void this.forgetKey(key.kid)}>Forget</Button>
                  </div>
                ))}
                <Stack gap={1} justifyContent="flex-end">
                  {(keyLoaded || this.state.keyError) && <Button variant="secondary" disabled={this.state.keyForgetBusy} onClick={() => void this.forgetKey()}>Forget all</Button>}
                  <Button variant="secondary" disabled={this.state.keyForgetBusy} onClick={this.closeKeyModal}>Close</Button>
                  <Button disabled={this.state.keyForgetBusy} onClick={() => this.setState({ keyView: 'import', requestedKid: undefined, keyError: undefined })}>Add keys</Button>
                </Stack>
                {this.state.keyError && <div role="alert">{this.state.keyError}</div>}
              </div>
            </Modal>
          </>
        )}
        {this.state.queryError && <div role="alert">{this.state.queryError}</div>}
        {query.queryType === 'traceqlSearch' && (
          <TraceQLSearch
            key={editorKey}
            protectedKeyLabel={this.protectedKeyLabel}
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
            protectedKeyLabel={this.protectedKeyLabel}
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
