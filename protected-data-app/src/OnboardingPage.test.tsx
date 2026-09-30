import { webcrypto } from 'node:crypto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { OnboardingPage } from './OnboardingPage';

jest.mock('@grafana/ui', () => ({
  Alert: ({ title, children }: { title: string; children: React.ReactNode }) => <div role="note"><strong>{title}</strong>{children}</div>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
  useStyles2: () => new Proxy({}, { get: () => '' }),
}));

const expectedMaster = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const expectedKid = '630dcd2966c4336691125448bbb25b4f';
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: webcrypto.subtle,
      getRandomValues: (array: Uint8Array) => {
        array.set(Uint8Array.from({ length: 32 }, (_, index) => index));
        return array;
      },
    },
  });
});

afterEach(() => {
  if (originalCrypto) { Object.defineProperty(globalThis, 'crypto', originalCrypto); }
  else { Reflect.deleteProperty(globalThis, 'crypto'); }
  if (originalCreateObjectURL) { Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL); }
  else { Reflect.deleteProperty(URL, 'createObjectURL'); }
  if (originalRevokeObjectURL) { Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL); }
  else { Reflect.deleteProperty(URL, 'revokeObjectURL'); }
  if (originalClipboard) { Object.defineProperty(navigator, 'clipboard', originalClipboard); }
  else { Reflect.deleteProperty(navigator, 'clipboard'); }
  jest.restoreAllMocks();
});

test('downloads a compatible master key before allowing replacement and clears it on leave', async () => {
  const user = userEvent.setup();
  let created: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn((blob: Blob) => { created = blob; return 'blob:test-key'; }) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const clicked = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  let generated: Uint8Array | undefined;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: webcrypto.subtle,
      getRandomValues: (array: Uint8Array) => {
        array.set(Uint8Array.from({ length: 32 }, (_, index) => index));
        generated = array;
        return array;
      },
    },
  });
  const { unmount } = render(<OnboardingPage />);
  expect(screen.getByRole('button', { name: 'Download key file' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Generate key' }));
  expect(await screen.findByText(expectedKid)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate another key' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Download key file' }));
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(created).toBeDefined();
  expect(screen.getByRole('button', { name: 'Generate another key' })).toBeEnabled();
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(created!);
  });
  expect(content).toBe(`${expectedMaster}\n`);
  unmount();
  expect(Array.from(generated!)).toEqual(Array(32).fill(0));
});

test('switches between real Alloy pipelines and copies config without key material', async () => {
  const user = userEvent.setup();
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<OnboardingPage />);
  await user.click(screen.getByRole('button', { name: 'Generate key' }));
  expect(await screen.findByText(expectedKid)).toBeInTheDocument();
  const panel = screen.getByRole('tabpanel');
  expect(within(panel).getByText(/processors:.*encrypted_attributes/s)).toHaveTextContent('span_attributes: [secret, api.token]');
  expect(within(panel).getByText(/processors:.*encrypted_attributes/s)).not.toHaveTextContent('substring_index: ordered-trigram-v1');
  fireEvent.click(screen.getByLabelText(/Include substring index/));
  expect(within(panel).getByText(/processors:.*encrypted_attributes/s)).toHaveTextContent('substring_index: ordered-trigram-v1');
  await user.click(within(panel).getByRole('button', { name: 'Copy config' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('processors: [encrypted_attributes, batch]')));
  await user.click(screen.getByRole('tab', { name: 'Loki logs' }));
  expect(within(panel).getByText(/loki.encrypted_logs/, { selector: 'pre code' })).toHaveTextContent('fields = ["line.api_token"]');
  expect(screen.queryByLabelText(/Include substring index/)).not.toBeInTheDocument();
  expect(screen.getByText('{job="api"} | logfmt | enc.api_token="value"')).toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Copy config' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('forward_to = [loki.write.demo.receiver]')));
  expect(writeText.mock.calls.flat().join('')).not.toContain(expectedMaster);
});
