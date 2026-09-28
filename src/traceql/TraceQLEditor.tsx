import { css } from '@emotion/css';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type GrafanaTheme2, type TimeRange } from '@grafana/data';
import { TemporaryAlert } from '@grafana/o11y-ds-frontend';
import { reportInteraction } from '@grafana/runtime';
import { Button, CodeEditor, Select, type Monaco, type monacoTypes, useTheme2 } from '@grafana/ui';

import { DEFAULT_TIME_RANGE_FOR_TAGS } from '../configuration/TagsTimeRangeSettings';
import { type TempoDatasource } from '../datasource';
import {
  assertProtectedQueryModelSafe,
  openProtectedQueryModel,
  prepareProtectedQueryModel,
} from '../protectedAttributes/model';
import { assertProtectedTraceQLKeyChoices, protectedTraceQLPredicates, rebaseProtectedTraceQLKeys, type ProtectedTraceQLPredicate } from '../protectedAttributes/traceql';
import { type TempoQuery } from '../types';

import { CompletionProvider, type CompletionItemType } from './autocomplete';
import { getErrorNodes, setMarkers } from './highlighting';
import { languageDefinition } from './traceql';

interface Props {
  placeholder: string;
  query: TempoQuery;
  onChange: (val: TempoQuery) => void;
  onRunQuery: () => void;
  onPendingChange?: (pending: boolean) => void;
  protectedKeyLabel?: (kid: string) => string;
  datasource: TempoDatasource;
  readOnly?: boolean;
  range?: TimeRange;
}

export function TraceQLEditor(props: Props) {
  const [alertText, setAlertText] = useState<string>();
  const [draft, setDraft] = useState(() =>
    props.datasource.instanceSettings?.jsonData?.protectedAttributesEnabled ? '' : props.query.query || ''
  );
  const [locked, setLocked] = useState(() =>
    Boolean(props.datasource.instanceSettings?.jsonData?.protectedAttributesEnabled)
  );
  const [draftPending, setDraftPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [choices, setChoices] = useState(() => props.query.protectedQueryKeys ?? []);

  const { query, onChange, onRunQuery, placeholder } = props;
  const setupAutocompleteFn = useAutocomplete(
    props.datasource,
    setAlertText,
    props.datasource.timeRangeForTags ?? DEFAULT_TIME_RANGE_FOR_TAGS,
    props.range
  );
  const theme = useTheme2();
  const styles = getStyles(theme, placeholder);

  // The Monaco Editor uses the first version of props.onChange in handleOnMount i.e. always has the initial
  // value of query because underlying Monaco editor is passed `query` below in the onEditorChange callback.
  // handleOnMount is called only once when the editor is mounted and does not get updates to query.
  // So we need useRef to get the latest version of query in the onEditorChange callback.
  const queryRef = useRef(query);
  queryRef.current = query;
  const generation = useRef(0);
  const savedEnvelope = useRef<string | undefined>(undefined);
  const savedChoices = useRef(JSON.stringify(query.protectedQueryKeys ?? []));
  const savedKey = useRef(props.datasource.protectedKey);
  const [legacy, setLegacy] = useState(false);
  const committed = useRef(true);
  const protectedMode = props.datasource.instanceSettings?.jsonData?.protectedAttributesEnabled;
  const key = props.datasource.protectedKey;
  const queryChoices = JSON.stringify(query.protectedQueryKeys ?? []);

  useEffect(() => {
    // A host acknowledgement of our own seal must not replace a newer Monaco draft.
    if (savedKey.current === key && savedEnvelope.current !== undefined &&
      savedEnvelope.current === query.query && savedChoices.current === queryChoices) {
      return;
    }
    const current = ++generation.current;
    setChoices(query.protectedQueryKeys ?? []);
    savedChoices.current = queryChoices;
    if (!protectedMode) {
      setDraft(query.query || '');
      setLocked(false);
      setLegacy(false);
      return;
    }
    try {
      assertProtectedQueryModelSafe(
        query,
        (props.datasource.protectedKeys ?? (key ? [key] : [])).map((item) => item.kid),
        !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
      );
    } catch {
      // Existing legacy plaintext remains in the host model. Only a key holder
      // may explicitly edit and migrate it; never forward it again unchanged.
      setDraft(key && !query.query?.startsWith('qenc:') ? query.query || '' : '');
      setLegacy(Boolean(key && !query.query?.startsWith('qenc:')));
      setLocked(true);
      return;
    }
    setLegacy(false);
    if (!query.query?.startsWith('qenc:')) {
      setDraft(query.query || '');
      setLocked(false);
      committed.current = true;
      return;
    }
    setDraft('');
    setLocked(true);
    const envelopeKid = /^qenc:v1:([0-9a-f]{32}):/.exec(query.query ?? '')?.[1];
    const openingKey =
      envelopeKid && (props.datasource.getProtectedKey?.(envelopeKid) ?? (key?.kid === envelopeKid ? key : undefined));
    if (!openingKey) {
      return;
    }
    void openProtectedQueryModel(
      query,
      props.datasource.getProtectedKey?.bind(props.datasource) ?? openingKey,
      props.datasource.uid,
      !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
    ).then(
      (opened) => {
        if (generation.current === current) {
          setDraft(opened.query || '');
          setLocked(false);
          committed.current = true;
        }
      },
      () => {
        if (generation.current === current) {
          setAlertText('Unable to open protected query');
        }
      }
    );
    // A new model increments generation at the beginning of this effect;
    // an acknowledgement of our own seal must not invalidate a newer edit.
  }, [query.query, queryChoices, protectedMode, key, props.datasource.uid]);

  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  useEffect(() => {
    props.onPendingChange?.(locked || dirty);
  }, [locked, dirty, props.onPendingChange]);
  useEffect(() => () => props.onPendingChange?.(false), [props.onPendingChange]);

  const editorChangeRef = useRef<(value: string, selected?: TempoQuery['protectedQueryKeys']) => void>(() => {});
  editorChangeRef.current = (value: string, selected?: TempoQuery['protectedQueryKeys']) => {
    if (locked || props.readOnly) {
      return;
    }
    setDraft(value);
    setDirty(true);
    props.onPendingChange?.(true);
    committed.current = false;
    const current = ++generation.current;
    const epoch = props.datasource.protectedKeyEpoch;
    setDraftPending(false);
    let retained = selected ?? choices;
    if (!selected && value !== draft) {
      try {
        retained = rebaseProtectedTraceQLKeys(draft, value, choices,
          !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
      } catch {
        retained = [];
      }
    }
    const candidate = { ...queryRef.current, query: value, protectedQueryKeys: retained };
    setChoices(retained);
    if (!protectedMode) {
      onChange(candidate);
      committed.current = true;
      setDirty(false);
      props.onPendingChange?.(false);
      return;
    }
    try {
      if (value && !/^[0-9A-Fa-f]*$/.test(value.trim())) {
        assertProtectedTraceQLKeyChoices(value, props.datasource.protectedKeys ?? (key ? [key] : []), retained,
          !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
      }
      if (!key) {
        assertProtectedQueryModelSafe(candidate, undefined, !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled);
        onChange(candidate);
        committed.current = true;
        setDirty(false);
        props.onPendingChange?.(false);
        return;
      }
      setDraftPending(true);
      void prepareProtectedQueryModel(
        candidate,
        key,
        props.datasource.uid,
        queryRef.current,
        props.datasource.getProtectedKey?.bind(props.datasource),
        !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
      ).then(
        (sealed) => {
          if (generation.current !== current || props.datasource.protectedKey !== key || props.datasource.protectedKeyEpoch !== epoch) {
            return;
          }
          savedEnvelope.current = sealed.query;
          savedKey.current = key;
          savedChoices.current = JSON.stringify(sealed.protectedQueryKeys ?? []);
          onChange(sealed);
          committed.current = true;
          setDraftPending(false);
          setDirty(false);
          props.onPendingChange?.(false);
          setAlertText(undefined);
        },
        () => {
          if (generation.current === current) {
            setDraftPending(false);
            setAlertText('Complete or correct the protected query before saving');
          }
        }
      );
    } catch {
      setAlertText('Complete or correct the protected query before saving');
    }
  };
  const onEditorChange = useCallback((value: string) => editorChangeRef.current(value), []);

  // work around the problem that `onEditorDidMount` is called once
  // and wouldn't get new version of onRunQuery
  const onRunQueryRef = useRef(onRunQuery);
  onRunQueryRef.current = () => {
    if (committed.current && !draftPending && !locked) {
      onRunQuery();
    } else {
      setAlertText('Complete or unlock the query before running it');
    }
  };

  let predicates: ProtectedTraceQLPredicate[] = [];
  if (protectedMode && !locked && !props.readOnly && (props.datasource.protectedKeys ?? (key ? [key] : [])).length > 1) {
    try {
      predicates = protectedTraceQLPredicates(draft,
        !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled).filter((predicate) => predicate.keyRequired);
    } catch {
      // Partial editor drafts remain local until valid.
    }
  }
  const errorTimeoutId = useRef<number | undefined>(undefined);

  return (
    <>
      <CodeEditor
        value={locked ? '' : draft}
        language={langId}
        onBlur={onEditorChange}
        onChange={onEditorChange}
        containerStyles={styles.queryField}
        readOnly={props.readOnly || locked}
        monacoOptions={{
          folding: false,
          fontSize: 14,
          lineNumbers: 'off',
          overviewRulerLanes: 0,
          renderLineHighlight: 'none',
          scrollbar: {
            vertical: 'hidden',
            verticalScrollbarSize: 8, // used as "padding-right"
            horizontal: 'hidden',
            horizontalScrollbarSize: 0,
          },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
        onBeforeEditorMount={ensureTraceQL}
        onEditorDidMount={(editor, monaco) => {
          if (!props.readOnly) {
            setupAutocompleteFn(editor, monaco, setupRegisterInteractionCommand(editor));
            setupActions(editor, monaco, () => onRunQueryRef.current());
            setupPlaceholder(editor, monaco, styles);
          }
          setupAutoSize(editor);

          // Parse query that might already exist (e.g., after a page refresh)
          const model = editor.getModel();
          if (model) {
            try {
              const errorNodes = getErrorNodes(model.getValue());
              setMarkers(monaco, model, errorNodes);
            } catch (err) {
              console.warn('TraceQL editor: failed to update syntax error markers', err);
            }
          }

          // Register callback for query changes
          editor.onDidChangeModelContent((changeEvent) => {
            const model = editor.getModel();

            if (!model) {
              return;
            }

            // Remove previous callback if existing, to prevent squiggles from been shown while the user is still typing
            if (errorTimeoutId.current) {
              window.clearTimeout(errorTimeoutId.current);
            }

            try {
              const errorNodes = getErrorNodes(model.getValue());
              const cursorPosition = changeEvent.changes[0].rangeOffset;

              // Immediately updates the squiggles, in case the user fixed an error,
              // excluding the error around the cursor position
              setMarkers(
                monaco,
                model,
                errorNodes.filter((errorNode) => !(errorNode.from <= cursorPosition && cursorPosition <= errorNode.to))
              );

              errorTimeoutId.current = window.setTimeout(() => {
                try {
                  setMarkers(monaco, model, errorNodes);
                } catch (err) {
                  console.warn('TraceQL editor: failed to update syntax error markers', err);
                }
              }, 500);
            } catch (err) {
              console.warn('TraceQL editor: failed to parse query for error highlighting', err);
            }
          });
        }}
      />
      {predicates.map((predicate) => (
        <div key={predicate.predicate}>
          <Select
            aria-label={`Select protected key for ${predicate.field} at ${predicate.from}`}
            placeholder="Choose key"
            options={(props.datasource.protectedKeys ?? (key ? [key] : [])).map((item) => ({ label: props.protectedKeyLabel?.(item.kid) ?? `${item.kid.slice(0, 8)}…${item.kid.slice(-6)}`, value: item.kid }))}
            value={choices.find((choice) => choice.predicate === predicate.predicate)?.kid}
            isClearable
            onChange={(choice) => {
              const next = choices.filter((item) => item.predicate !== predicate.predicate);
              if (choice?.value) {
                next.push({ predicate: predicate.predicate, kid: choice.value });
              }
              editorChangeRef.current(draft, next);
            }}
          />
        </div>
      ))}
      {locked && <TemporaryAlert severity="info" text="Import the matching key to unlock this query" />}
      {legacy && key && (
        <Button
          variant="secondary"
          onClick={() => {
            const currentKey = props.datasource.protectedKey;
            if (!currentKey) {
              return;
            }
            const current = ++generation.current;
            const epoch = props.datasource.protectedKeyEpoch;
            void prepareProtectedQueryModel(
              queryRef.current,
              currentKey,
              props.datasource.uid,
              queryRef.current,
              props.datasource.getProtectedKey?.bind(props.datasource),
              !!props.datasource.instanceSettings.jsonData.protectedAttributesSubstringEnabled
            ).then(
              (sealed) => {
                if (generation.current === current && props.datasource.protectedKey === currentKey &&
                  props.datasource.protectedKeyEpoch === epoch) {
                  savedEnvelope.current = sealed.query;
                  savedKey.current = currentKey;
                  onChange(sealed);
                  setLegacy(false);
                  setLocked(false);
                  setDirty(false);
                  props.onPendingChange?.(false);
                }
              },
              () => setAlertText('Correct the legacy query before migrating it')
            );
          }}
        >
          Seal legacy query
        </Button>
      )}
      {alertText && <TemporaryAlert severity="error" text={alertText} />}
    </>
  );
}

function setupPlaceholder(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco, styles: EditorStyles) {
  const placeholderDecorators = [
    {
      range: new monaco.Range(1, 1, 1, 1),
      options: {
        className: styles.placeholder,
        isWholeLine: true,
      },
    },
  ];

  let decorators: string[] = [];

  const checkDecorators = (): void => {
    const model = editor.getModel();

    if (!model) {
      return;
    }

    const newDecorators = model.getValueLength() === 0 ? placeholderDecorators : [];
    decorators = model.deltaDecorations(decorators, newDecorators);
  };

  checkDecorators();
  editor.onDidChangeModelContent(checkDecorators);
}

function setupActions(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco, onRunQuery: () => void) {
  editor.addAction({
    id: 'run-query',
    label: 'Run Query',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run: function () {
      onRunQuery();
    },
  });
}

function setupRegisterInteractionCommand(editor: monacoTypes.editor.IStandaloneCodeEditor): string | null {
  return editor.addCommand(0, function (_, label, type: CompletionItemType) {
    const properties: Record<string, unknown> = { datasourceType: 'tempo', type };
    // Filter out the label for TAG_VALUE completions to avoid potentially exposing sensitive data
    if (type !== 'TAG_VALUE') {
      properties.label = label;
    }
    reportInteraction('grafana_traces_traceql_completion', properties);
  });
}

function setupAutoSize(editor: monacoTypes.editor.IStandaloneCodeEditor) {
  const container = editor.getDomNode();
  const updateHeight = () => {
    if (container) {
      const contentHeight = Math.min(1000, editor.getContentHeight());
      const width = parseInt(container.style.width, 10);
      container.style.width = `${width}px`;
      container.style.height = `${contentHeight}px`;
      editor.layout({ width, height: contentHeight });
    }
  };
  editor.onDidContentSizeChange(updateHeight);
  updateHeight();
}

/**
 * Hook that returns function that will set up monaco autocomplete for the label selector
 * @param datasource the Tempo datasource instance
 * @param setAlertText setter for alert's text
 * @param timeRangeForTags time range for tags and tag values queries
 * @param range time range
 */
function useAutocomplete(
  datasource: TempoDatasource,
  setAlertText: (text?: string) => void,
  timeRangeForTags: number,
  range?: TimeRange
) {
  // We need the provider ref so we can pass it the label/values data later. This is because we run the call for the
  // values here but there is additional setup needed for the provider later on. We could run the getSeries() in the
  // returned function but that is run after the monaco is mounted so would delay the request a bit when it does not
  // need to.
  const providerRef = useRef<CompletionProvider>(
    new CompletionProvider({
      languageProvider: datasource.languageProvider,
      setAlertText,
      timeRangeForTags,
      range,
    })
  );

  const previousRangeRef = useRef<TimeRange | undefined>(range);

  useEffect(() => {
    const fetchTags = async () => {
      try {
        await datasource.languageProvider.start(range, timeRangeForTags);
        setAlertText(undefined);
      } catch (error) {
        if (error instanceof Error) {
          setAlertText(`Error: ${error.message}`);
        }
      }
    };
    fetchTags();
  }, [datasource, setAlertText, range, timeRangeForTags]);

  useEffect(() => {
    const rangeChanged = datasource.languageProvider.shouldRefreshLabels(range, previousRangeRef.current);

    if (rangeChanged) {
      providerRef.current.range = range;
      previousRangeRef.current = range;
    }
  }, [range, datasource.languageProvider]);

  useEffect(() => {
    providerRef.current.timeRangeForTags = timeRangeForTags;
  }, [timeRangeForTags]);

  const autocompleteDisposeFun = useRef<(() => void) | null>(null);
  useEffect(() => {
    // when we unmount, we unregister the autocomplete-function, if it was registered
    return () => {
      autocompleteDisposeFun.current?.();
    };
  }, []);

  // This should be run in monaco onEditorDidMount
  return (
    editor: monacoTypes.editor.IStandaloneCodeEditor,
    monaco: Monaco,
    registerInteractionCommandId: string | null
  ) => {
    providerRef.current.editor = editor;
    providerRef.current.monaco = monaco;
    providerRef.current.setRegisterInteractionCommandId(registerInteractionCommandId);

    const { dispose } = monaco.languages.registerCompletionItemProvider(langId, providerRef.current);
    autocompleteDisposeFun.current = dispose;
  };
}

// we must only run the setup code once
let traceqlSetupDone = false;
const langId = 'traceql';

function ensureTraceQL(monaco: Monaco) {
  if (!traceqlSetupDone) {
    traceqlSetupDone = true;
    const { aliases, extensions, mimetypes, def } = languageDefinition;
    monaco.languages.register({ id: langId, aliases, extensions, mimetypes });
    monaco.languages.setMonarchTokensProvider(langId, def.language);
    monaco.languages.setLanguageConfiguration(langId, def.languageConfiguration);
  }
}

interface EditorStyles {
  placeholder: string;
  queryField: string;
}

const getStyles = (theme: GrafanaTheme2, placeholder: string): EditorStyles => {
  return {
    queryField: css({
      borderRadius: theme.shape.radius.default,
      border: `1px solid ${theme.components.input.borderColor}`,
      flex: 1,
    }),
    placeholder: css({
      '::after': {
        content: `'${placeholder}'`,
        fontFamily: theme.typography.fontFamilyMonospace,
        opacity: 0.3,
      },
    }),
  };
};
