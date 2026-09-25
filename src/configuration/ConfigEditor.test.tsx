import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { type DataSourcePluginOptionsEditorProps } from '@grafana/data';

import { TraceqlSearchScope } from '../dataquery';
import { type TempoJsonData } from '../types';

import ConfigEditor from './ConfigEditor';

jest.mock('@grafana/plugin-ui', () => ({
  ConfigSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  ConfigSubSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  ConfigDescriptionLink: () => null,
  AdvancedHttpSettings: () => null,
  Auth: () => null,
  ConnectionSettings: () => null,
  convertLegacyAuthProps: () => ({}),
  DataSourceDescription: () => null,
}));
jest.mock('@grafana/o11y-ds-frontend', () => ({
  NodeGraphSection: () => null, SpanBarSection: () => null, TraceToLogsSection: () => null,
  TraceToMetricsSection: () => null, TraceToProfilesSection: () => null,
}));
jest.mock('./QuerySettings', () => ({ QuerySettings: () => null }));
jest.mock('./ServiceGraphSettings', () => ({ ServiceGraphSettings: () => null }));
jest.mock('./StreamingSection', () => ({ StreamingSection: () => null }));
jest.mock('./TagLimitSettings', () => ({ TagLimitSection: () => null }));
jest.mock('./TagsTimeRangeSettings', () => ({ TagsTimeRangeSettings: () => null }));
jest.mock('./TraceQLSearchSettings', () => ({ TraceQLSearchSettings: () => null }));

const kid = '630dcd2966c4336691125448bbb25b4f';

test('persists only a valid public fingerprint and rejects uppercase or incomplete IDs', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = { jsonData: {} } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  const input = screen.getByRole('textbox', { name: 'Protected key ID' });
  await user.type(input, kid.toUpperCase());
  expect(onOptionsChange).not.toHaveBeenCalled();
  await user.clear(input);
  onOptionsChange.mockClear();
  await user.type(input, kid);
  expect(onOptionsChange).toHaveBeenCalledTimes(1);
  expect(onOptionsChange).toHaveBeenCalledWith(expect.objectContaining({
    jsonData: { protectedKeyId: kid },
  }));
});

test('refuses to enable protection while a valued protected static default remains saved', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = { jsonData: { search: { filters: [{
    id: 'secret', scope: TraceqlSearchScope.Span, tag: 'enc.password', operator: '=', value: 'sensitive',
  }] } } } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  await user.type(screen.getByRole('textbox', { name: 'Protected key ID' }), kid);
  expect(onOptionsChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('span.enc.password');
  expect(screen.getByRole('alert')).not.toHaveTextContent('sensitive');
});
