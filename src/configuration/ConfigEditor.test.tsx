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
  NodeGraphSection: () => null,
  SpanBarSection: () => null,
  TraceToLogsSection: () => null,
  TraceToMetricsSection: () => null,
  TraceToProfilesSection: () => null,
}));
jest.mock('./QuerySettings', () => ({ QuerySettings: () => null }));
jest.mock('./ServiceGraphSettings', () => ({ ServiceGraphSettings: () => null }));
jest.mock('./StreamingSection', () => ({ StreamingSection: () => null }));
jest.mock('./TagLimitSettings', () => ({ TagLimitSection: () => null }));
jest.mock('./TagsTimeRangeSettings', () => ({ TagsTimeRangeSettings: () => null }));
jest.mock('./TraceQLSearchSettings', () => ({ TraceQLSearchSettings: () => null }));
jest.mock('./KeyRevocation', () => ({ KeyRevocation: () => null }));

test('enables protected attributes without a configured key ID', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = { jsonData: {} } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  await user.click(screen.getByLabelText('Enable protected attributes'));
  expect(onOptionsChange).toHaveBeenCalledWith(
    expect.objectContaining({
      jsonData: { protectedAttributesEnabled: true },
    })
  );
});

test('migrates a legacy fingerprint-only datasource without persisting the key ID', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = {
    jsonData: { protectedKeyId: '630dcd2966c4336691125448bbb25b4f' },
  } as unknown as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  await user.click(screen.getByLabelText('Enable protected attributes'));
  expect(onOptionsChange).toHaveBeenCalledWith(
    expect.objectContaining({
      jsonData: { protectedAttributesEnabled: true },
    })
  );
});

test('refuses to enable protection while a valued protected static default remains saved', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = {
    jsonData: {
      search: {
        filters: [
          {
            id: 'secret',
            scope: TraceqlSearchScope.Span,
            tag: 'enc.password',
            operator: '=',
            value: 'sensitive',
          },
        ],
      },
    },
  } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  await user.click(screen.getByLabelText('Enable protected attributes'));
  expect(onOptionsChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('span.enc.password');
  expect(screen.getByRole('alert')).not.toHaveTextContent('sensitive');
});

test('disabling protected attributes clears provisioned substring opt-in before re-enabling', async () => {
  const user = userEvent.setup();
  const onOptionsChange = jest.fn();
  const options = {
    jsonData: { protectedAttributesEnabled: true, protectedAttributesSubstringEnabled: true },
  } as DataSourcePluginOptionsEditorProps<TempoJsonData>['options'];
  const { rerender } = render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  await user.click(screen.getByLabelText('Enable protected attributes'));
  expect(onOptionsChange).toHaveBeenLastCalledWith(expect.objectContaining({
    jsonData: { protectedAttributesEnabled: false, protectedAttributesSubstringEnabled: false },
  }));
  rerender(<ConfigEditor options={{
    ...options, jsonData: { protectedAttributesEnabled: false, protectedAttributesSubstringEnabled: false },
  }} onOptionsChange={onOptionsChange} />);
  await user.click(screen.getByLabelText('Enable protected attributes'));
  expect(onOptionsChange).toHaveBeenLastCalledWith(expect.objectContaining({
    jsonData: { protectedAttributesEnabled: true, protectedAttributesSubstringEnabled: false },
  }));
});
