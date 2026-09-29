import { type DataSourceInstanceSettings, type PluginMetaInfo, PluginType, type TimeRange } from '@grafana/data';
import { type monacoTypes } from '@grafana/ui';

import { v2Tags, emptyTags, testIntrinsics } from '../SearchTraceQLEditor/mocks';
import { TempoDatasource } from '../datasource';
import TempoLanguageProvider from '../language_provider';
import { type Scope, type TempoJsonData } from '../types';

import { CompletionProvider } from './autocomplete';
import { intrinsicsV1, scopes } from './traceql';

const emptyPosition = {} as monacoTypes.Position;

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
}));

describe('CompletionProvider', () => {
  it('suggests tags, intrinsics and scopes (API v2)', async () => {
    const { provider, model } = setup('{}', 1, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      ...scopes.map((s) => expect.objectContaining({ label: s, insertText: s })),
      ...testIntrinsics.map((s) => expect.objectContaining({ label: s, insertText: s })),
      expect.objectContaining({ label: 'cluster', insertText: '.cluster' }),
      expect.objectContaining({ label: 'container', insertText: '.container' }),
      expect.objectContaining({ label: 'db', insertText: '.db' }),
    ]);
  });

  it('does not wrap the tag value in quotes if the type in the response is something other than "string"', async () => {
    const { provider, model } = setup('{.foo=}', 6, v2Tags);

    jest.spyOn(provider.languageProvider, 'getOptionsV2').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve([
            {
              type: 'int',
              value: 'foobar',
              label: 'foobar',
            },
          ]);
        })
    );

    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      expect.objectContaining({ label: 'foobar', insertText: 'foobar' }),
    ]);
  });

  it('wraps the tag value in quotes if the type in the response is set to "string"', async () => {
    const { provider, model } = setup('{.foo=}', 6, v2Tags);

    jest.spyOn(provider.languageProvider, 'getOptionsV2').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve([
            {
              type: 'string',
              value: 'foobar',
              label: 'foobar',
            },
          ]);
        })
    );

    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      expect.objectContaining({ label: 'foobar', insertText: '"foobar"' }),
    ]);
  });

  it('inserts the tag value without quotes if the user has entered quotes', async () => {
    const { provider, model } = setup('{.foo="}', 6, v2Tags);

    jest.spyOn(provider.languageProvider, 'getOptionsV2').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve([
            {
              value: 'foobar',
              label: 'foobar',
            },
          ]);
        })
    );

    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      expect.objectContaining({ label: 'foobar', insertText: 'foobar' }),
    ]);
  });

  it('suggests options when inside quotes', async () => {
    const { provider, model } = setup('{.foo=""}', 7, v2Tags);

    jest.spyOn(provider.languageProvider, 'getOptionsV2').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve([
            {
              type: 'string',
              value: 'foobar',
              label: 'foobar',
            },
          ]);
        })
    );

    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      expect.objectContaining({ label: 'foobar', insertText: 'foobar' }),
    ]);
  });

  it('suggests nothing without tags', async () => {
    const { provider, model } = setup('{.foo="}', 8, emptyTags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([]);
  });

  it('suggests tags on empty input (API v2)', async () => {
    const { provider, model } = setup('', 0, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      ...scopes.map((s) => expect.objectContaining({ label: s, insertText: `{ ${s}$0 }` })),
      ...testIntrinsics.map((s) => expect.objectContaining({ label: s, insertText: `{ ${s}$0 }` })),
      expect.objectContaining({ label: 'cluster', insertText: '{ .cluster' }),
      expect.objectContaining({ label: 'container', insertText: '{ .container' }),
      expect.objectContaining({ label: 'db', insertText: '{ .db' }),
    ]);
  });

  it('only suggests tags after typing the global attribute scope (API v2)', async () => {
    const { provider, model } = setup('{.}', 2, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      ['cluster', 'container', 'db'].map((s) => expect.objectContaining({ label: s, insertText: s }))
    );
  });

  it('suggests correct tags after the resource scope (API v2)', async () => {
    const { provider, model } = setup('{ resource. }', 11, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      ['cluster', 'container'].map((s) => expect.objectContaining({ label: s, insertText: s }))
    );
  });

  it('suggests correct tags after the span scope (API v2)', async () => {
    const { provider, model } = setup('{ span. }', 7, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      ['db'].map((s) => expect.objectContaining({ label: s, insertText: s }))
    );
  });

  it('suggests logical operators and close bracket after the value', async () => {
    const { provider, model } = setup('{.foo=300 }', 10, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      [...CompletionProvider.logicalOps, ...CompletionProvider.arithmeticOps, ...CompletionProvider.comparisonOps].map(
        (s) => expect.objectContaining({ label: s.label, insertText: s.insertText })
      )
    );
  });

  it('suggests spanset combining operators after spanset selector', async () => {
    const { provider, model } = setup('{.foo=300} ', 11);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      expect.arrayContaining(
        CompletionProvider.spansetOps.map((s) => expect.objectContaining({ label: s.label, insertText: s.insertText }))
      )
    );
  });

  it.each([
    ['{.foo=300} | ', 13],
    ['{.foo=300} && {.bar=200} | ', 27],
    ['{.foo=300} && {.bar=300} && {.foo=300} | ', 41],
  ])(
    'suggests operators that go after `|` (aggregators, selectorts, ...) - %s, %i',
    async (input: string, offset: number) => {
      const { provider, model } = setup(input, offset, v2Tags);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        ...CompletionProvider.functions.map((s) =>
          expect.objectContaining({ label: s.label, insertText: s.insertText, documentation: s.documentation })
        ),
        ...scopes.map((s) => expect.objectContaining({ label: s, insertText: s })),
        ...testIntrinsics.map((s) => expect.objectContaining({ label: s, insertText: s })),
        expect.objectContaining({ label: 'cluster', insertText: '.cluster' }),
        expect.objectContaining({ label: 'container', insertText: '.container' }),
        expect.objectContaining({ label: 'db', insertText: '.db' }),
      ]);
    }
  );

  it('suggests compare function in pipeline operators', async () => {
    const { provider, model } = setup('{.foo=300} | ', 13);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'compare',
          insertText: 'compare($0)',
          documentation: expect.stringContaining('Splits spans into two groups'),
        }),
      ])
    );
  });

  it('suggests with keyword after spanset completion', async () => {
    const { provider, model } = setup('{.foo=300} ', 11);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'with',
          insertText: 'with($0)',
          documentation: expect.stringContaining('query hints'),
        }),
      ])
    );
  });

  it.each([
    ['{.foo=300} | avg(.value) ', 25],
    ['{.foo=300} && {.foo=300} | avg(.value) ', 39],
  ])(
    'suggests comparison operators after aggregator (avg, max, ...) - %s, %i',
    async (input: string, offset: number) => {
      const { provider, model } = setup(input, offset);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
        CompletionProvider.comparisonOps.map((s) =>
          expect.objectContaining({ label: s.label, insertText: s.insertText })
        )
      );
    }
  );

  it.each([
    ['{.foo=300} | avg(.value) = ', 27],
    ['{.foo=300} && {.foo=300} | avg(.value) = ', 41],
  ])('does not suggest after aggregator and comparison operator - %s, %i', async (input: string, offset: number) => {
    const { provider, model } = setup(input, offset);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([]);
  });

  it('suggests when `}` missing', async () => {
    const { provider, model } = setup('{ span.http.status_code ', 24);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      [...CompletionProvider.comparisonOps, ...CompletionProvider.logicalOps].map((s) =>
        expect.objectContaining({ label: s.label, insertText: s.insertText })
      )
    );
  });

  it.each([
    ['{ .foo }', 7],
    ['{.foo   300}', 6],
    ['{.foo   300}', 7],
    ['{.foo   300}', 8],
    ['{.foo  300 && .bar = 200}', 6],
    ['{.foo  300 && .bar = 200}', 7],
    ['{.foo  300 && .bar  200}', 19],
    ['{.foo  300 && .bar  200}', 20],
    ['{ .foo = 1 && .bar }', 19],
    ['{ .foo = 1 && .bar  }', 19],
  ])('suggests with incomplete spanset - %s, %i', async (input: string, offset: number) => {
    const { provider, model } = setup(input, offset);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      [...CompletionProvider.comparisonOps, ...CompletionProvider.logicalOps, ...CompletionProvider.arithmeticOps].map(
        (s) => expect.objectContaining({ label: s.label, insertText: s.insertText })
      )
    );
  });

  it.each([
    ['{ .foo }', 6],
    ['{.foo   300}', 5],
    ['{.foo  300 && .bar = 200}', 5],
    ['{ .foo = 1 && .bar }', 18],
  ])('suggests with incomplete spanset with no space before cursor - %s, %i', async (input: string, offset: number) => {
    const { provider, model } = setup(input, offset);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([]);
  });

  it.each([
    ['{ span.d }', 8],
    ['{ span.db }', 9],
  ])('suggests to complete attribute - %s, %i', async (input: string, offset: number) => {
    const { provider, model } = setup(input, offset, v2Tags);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
      expect.objectContaining({ label: 'db', insertText: 'db' }),
    ]);
  });

  it.each([
    ['{.foo=1}  {.bar=2}', 8],
    ['{.foo=1}  {.bar=2}', 9],
    ['{.foo=1}  {.bar=2}', 10],
  ])(
    'suggests spanset combining operators in an incomplete, multi-spanset query - %s, %i',
    async (input: string, offset: number) => {
      const { provider, model } = setup(input, offset);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
        expect.arrayContaining(
          CompletionProvider.spansetOps.map((completionItem) =>
            expect.objectContaining({
              detail: completionItem.detail,
              documentation: completionItem.documentation,
              insertText: completionItem.insertText,
              label: completionItem.label,
            })
          )
        )
      );
    }
  );

  it.each([
    // After spanset
    ['{ span.http.status_code = 200 &&  }', 33],
    ['{ span.http.status_code = 200 ||  }', 33],
    ['{ span.http.status_code = 200 &&   }', 34],
    ['{ span.http.status_code = 200 ||   }', 34],
    ['{ span.http.status_code = 200 &&   }', 35],
    ['{ span.http.status_code = 200 ||   }', 35],
    ['{ .foo = 200 } &&  ', 18],
    ['{ .foo = 200 } &&  ', 19],
    ['{ .foo = 200 } || ', 18],
    ['{ .foo = 200 } >> ', 18],
    // Between spansets
    ['{ .foo = 1 } &&  { .bar = 2 }', 16],
    // Inside `()`
    ['{.foo=1} | avg()', 15],
    ['{.foo=1} | avg() < 1s', 15],
    ['{.foo=1} | max() = 3', 15],
    ['{.foo=1} | by()', 14],
    ['{.foo=1} | select()', 18],
  ])('suggests attributes - %s, %i', async (input: string, offset: number) => {
    const { provider, model } = setup(input, offset);
    const result = await provider.provideCompletionItems(model, emptyPosition);
    expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
      [...scopes, ...intrinsicsV1].map((s) => expect.objectContaining({ label: s }))
    );
  });

  it.each([
    ['{span.ht', 8],
    ['{span.http', 10],
    ['{span.http.', 11],
    ['{span.http.status', 17],
  ])(
    'suggests attributes when containing trigger characters and missing `}`- %s, %i',
    async (input: string, offset: number) => {
      const { provider, model } = setup(input, offset, [
        {
          name: 'span',
          tags: ['http.status_code'],
        },
      ]);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        expect.objectContaining({ label: 'http.status_code', insertText: 'http.status_code' }),
      ]);
    }
  );

  describe('tag value request context', () => {
    it.each([
      ['{resource.service.name=}', '{resource.service.name=}'.indexOf('=') + 1],
      ['{resource.service.name="}', '{resource.service.name="}'.indexOf('"') + 1],
      ['{resource.service.name=', '{resource.service.name='.length],
    ])('omits an incomplete draft from ordinary value metadata: %s', async (query, offset) => {
      const { provider, model, datasource, setAlertText } = setup(query, offset);
      datasource.instanceSettings.jsonData.protectedAttributesEnabled = true;
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockResolvedValue({
        tagValues: [{ type: 'string', value: 'api' }],
      });

      const result = await provider.provideCompletionItems(model, emptyPosition);

      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'api' })])
      );
      expect(metadataRequest).toHaveBeenCalledWith(
        'tag-values',
        expect.objectContaining({ tag: 'resource.service.name' })
      );
      expect(metadataRequest.mock.calls[0][1]).not.toHaveProperty('q');
      expect(setAlertText).toHaveBeenCalledWith(undefined);
    });

    it('does not send any part of a malformed draft containing protected plaintext', async () => {
      const query = '{span.enc.api.token="private" && resource.service.name=}';
      const { provider, model, datasource } = setup(query, query.lastIndexOf('=') + 1);
      datasource.instanceSettings.jsonData.protectedAttributesEnabled = true;
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockResolvedValue({
        tagValues: [{ type: 'string', value: 'api' }],
      });

      const result = await provider.provideCompletionItems(model, emptyPosition);

      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'api' })])
      );
      expect(metadataRequest).toHaveBeenCalledWith(
        'tag-values',
        expect.objectContaining({ tag: 'resource.service.name' })
      );
      expect(metadataRequest.mock.calls[0][1]).not.toHaveProperty('q');
      expect(JSON.stringify(metadataRequest.mock.calls)).not.toContain('private');
    });

    it('does not request protected value dictionaries even for incomplete drafts', async () => {
      const query = '{span.enc.api.token=}';
      const { provider, model, datasource } = setup(query, query.indexOf('=') + 1);
      datasource.instanceSettings.jsonData.protectedAttributesEnabled = true;
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest');

      const result = await provider.provideCompletionItems(model, emptyPosition);

      expect((result! as monacoTypes.languages.CompletionList).suggestions).toEqual([]);
      expect(metadataRequest).not.toHaveBeenCalled();
    });

    it('does not reuse previously cached protected value suggestions after protection is enabled', async () => {
      const query = '{span.enc.api.token=}';
      const { provider, model, datasource } = setup(query, query.indexOf('=') + 1);
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockResolvedValue({
        tagValues: [{ type: 'string', value: 'ciphertext' }],
      });

      const unprotected = await provider.provideCompletionItems(model, emptyPosition);
      expect((unprotected! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        expect.objectContaining({ label: 'ciphertext' }),
      ]);

      datasource.instanceSettings.jsonData.protectedAttributesEnabled = true;
      const protectedResult = await provider.provideCompletionItems(model, emptyPosition);
      expect((protectedResult! as monacoTypes.languages.CompletionList).suggestions).toEqual([]);
      expect(metadataRequest).toHaveBeenCalledTimes(1);
    });

    it('passes a complete context through strict metadata validation rather than dropping unsafe filters', async () => {
      const query = '{span.enc.api.token="private" && resource.service.name=""}';
      const { provider, model, datasource, setAlertText } = setup(query, query.lastIndexOf('""') + 1);
      datasource.instanceSettings.jsonData.protectedAttributesEnabled = true;
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockRejectedValue(
        new Error('Protected metadata request failed.')
      );

      await provider.provideCompletionItems(model, emptyPosition);

      expect(metadataRequest).toHaveBeenCalledWith('tag-values', expect.objectContaining({ q: query }));
      expect(setAlertText).toHaveBeenCalledWith('Error: Protected metadata request failed.');
    });

    it('preserves valid ordinary context and reports actual metadata request failures', async () => {
      const query = '{span.http.route="/users" && resource.service.name=""}';
      const { provider, model, datasource, setAlertText } = setup(query, query.lastIndexOf('""') + 1);
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockRejectedValue(new Error('Network unavailable'));

      await provider.provideCompletionItems(model, emptyPosition);

      expect(metadataRequest).toHaveBeenCalledWith('tag-values', expect.objectContaining({ q: query }));
      expect(setAlertText).toHaveBeenCalledWith('Error: Network unavailable');
    });

    it('separates unfiltered and contextual suggestions across effective time windows', async () => {
      const incomplete = '{resource.service.name=}';
      const complete = '{resource.service.name=""}';
      const { provider, model, datasource } = setup(incomplete, incomplete.indexOf('=') + 1);
      const metadataRequest = jest.spyOn(datasource, 'metadataRequest').mockImplementation(async (_url, params) => ({
        tagValues: [{
          type: 'string',
          value: params.q ? 'contextual' : params.start ? 'recent' : 'unfiltered',
        }],
      }));
      const initial = await provider.provideCompletionItems(model, emptyPosition);
      expect((initial! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        expect.objectContaining({ label: 'unfiltered' }),
      ]);

      provider.timeRangeForTags = 1;
      provider.range = {
        from: { valueOf: () => 1000, unix: () => 1 },
        to: { valueOf: () => 2000, unix: () => 2 },
      } as TimeRange;
      const recent = await provider.provideCompletionItems(model, emptyPosition);
      expect((recent! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        expect.objectContaining({ label: 'recent' }),
      ]);
      expect(metadataRequest.mock.calls[1][1]).toEqual(expect.objectContaining({ start: 1, end: 2 }));

      const validModel = makeModel(complete, complete.indexOf('""') + 1) as unknown as monacoTypes.editor.ITextModel;
      provider.editor = { getModel: () => validModel } as monacoTypes.editor.IStandaloneCodeEditor;
      const contextual = await provider.provideCompletionItems(validModel, emptyPosition);
      expect((contextual! as monacoTypes.languages.CompletionList).suggestions).toEqual([
        expect.objectContaining({ label: 'contextual' }),
      ]);
      expect(metadataRequest.mock.calls[2][1]).toHaveProperty('q', complete);
    });
  });

  describe('Query hint autocompletion', () => {
    it('suggests most_recent parameter inside with clause', async () => {
      const { provider, model } = setup('{.foo=300} with(', 17);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

      expect(suggestions).toEqual([
        expect.objectContaining({
          label: 'most_recent',
          insertText: 'most_recent=$0',
          detail: 'Get latest traces',
          documentation: expect.stringContaining('Forces Tempo to return the most recent results'),
        }),
      ]);
    });

    it('suggests boolean values after most_recent parameter', async () => {
      const { provider, model } = setup('{.foo=300} with(most_recent=', 29);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

      expect(suggestions).toEqual([
        expect.objectContaining({
          label: 'true',
          insertText: 'true',
          detail: 'Boolean true',
        }),
        expect.objectContaining({
          label: 'false',
          insertText: 'false',
          detail: 'Boolean false',
        }),
      ]);
    });

    it('suggests most_recent parameter with whitespace variations', async () => {
      const { provider, model } = setup('{.foo=300} with( ', 18);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

      expect(suggestions).toEqual([
        expect.objectContaining({
          label: 'most_recent',
          insertText: 'most_recent=$0',
        }),
      ]);
    });

    it('suggests boolean values with whitespace around equals', async () => {
      const { provider, model } = setup('{.foo=300} with(most_recent = ', 31);
      const result = await provider.provideCompletionItems(model, emptyPosition);
      const suggestions = (result! as monacoTypes.languages.CompletionList).suggestions;

      expect(suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'true', insertText: 'true' }),
          expect.objectContaining({ label: 'false', insertText: 'false' }),
        ])
      );
    });
  });
});

function setup(value: string, offset: number, tagsV2?: Scope[]) {
  const ds = new TempoDatasource({ ...defaultSettings, jsonData: { ...defaultSettings.jsonData } });
  const lp = new TempoLanguageProvider(ds);
  if (tagsV2) {
    lp.setV2Tags(tagsV2);
  }
  const setAlertText = jest.fn();
  const provider = new CompletionProvider({ languageProvider: lp, setAlertText });
  const model = makeModel(value, offset);
  provider.monaco = {
    Range: {
      fromPositions() {
        return null;
      },
    },
    languages: {
      CompletionItemKind: {
        Enum: 1,
        EnumMember: 2,
      },
    },
  } as unknown as typeof monacoTypes;
  provider.editor = {
    getModel() {
      return model;
    },
  } as unknown as monacoTypes.editor.IStandaloneCodeEditor;

  return { provider, model: model as unknown as monacoTypes.editor.ITextModel, datasource: ds, setAlertText };
}

function makeModel(value: string, offset: number) {
  return {
    id: 'test_monaco',
    getWordAtPosition() {
      return null;
    },
    getOffsetAt() {
      return offset;
    },
    getValue() {
      return value;
    },
  };
}

const defaultSettings: DataSourceInstanceSettings<TempoJsonData> = {
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
  readOnly: false,
  jsonData: {
    nodeGraph: {
      enabled: true,
    },
  },
};
