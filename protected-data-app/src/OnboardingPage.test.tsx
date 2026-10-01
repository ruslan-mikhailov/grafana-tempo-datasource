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
const originalCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
const originalPublicKeyCredential = Object.getOwnPropertyDescriptor(window, 'PublicKeyCredential');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalSaveFilePicker = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: webcrypto.subtle,
      getRandomValues: (array: Uint8Array) => {
        array.set(Uint8Array.from({ length: array.length }, (_, index) => index));
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
  if (originalCredentials) { Object.defineProperty(navigator, 'credentials', originalCredentials); }
  else { Reflect.deleteProperty(navigator, 'credentials'); }
  if (originalPublicKeyCredential) { Object.defineProperty(window, 'PublicKeyCredential', originalPublicKeyCredential); }
  else { Reflect.deleteProperty(window, 'PublicKeyCredential'); }
  if (originalSecureContext) { Object.defineProperty(window, 'isSecureContext', originalSecureContext); }
  else { Reflect.deleteProperty(window, 'isSecureContext'); }
  if (originalSaveFilePicker) { Object.defineProperty(window, 'showSaveFilePicker', originalSaveFilePicker); }
  else { Reflect.deleteProperty(window, 'showSaveFilePicker'); }
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
        array.set(Uint8Array.from({ length: array.length }, (_, index) => index));
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

test('saves the key as a named file instead of navigating to a blob URL when native save is available', async () => {
  const user = userEvent.setup();
  const write = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn().mockResolvedValue(undefined);
  const picker = jest.fn().mockResolvedValue({ createWritable: async () => ({ write, close }) });
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
  const createObjectURL = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const navigate = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<OnboardingPage />);

  await user.click(screen.getByRole('button', { name: 'Generate key' }));
  expect(await screen.findByText(expectedKid)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Download key file' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: `protected-${expectedKid}.key` }));
  expect(write).toHaveBeenCalledWith(`${expectedMaster}\n`);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Generate another key' })).toBeEnabled();
});

test('cancelled save keeps the current master available and blocks replacing it', async () => {
  const user = userEvent.setup();
  const picker = jest.fn().mockRejectedValue(new DOMException('Canceled', 'AbortError'));
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
  const createObjectURL = jest.fn(() => 'blob:test-key');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const navigate = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<OnboardingPage />);

  await user.click(screen.getByRole('button', { name: 'Generate key' }));
  expect(await screen.findByText(expectedKid)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Download key file' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate another key' })).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Download key file' })).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/cancel/i);
  expect(picker).toHaveBeenCalledTimes(1);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

test('enrolls a discoverable PRF passkey and downloads the deterministic Alloy master without replacing an unsaved key', async () => {
  const user = userEvent.setup();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
  const rawId = Uint8Array.from([1, 2, 3, 4]).buffer;
  const prfBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const create = jest.fn().mockResolvedValue({ rawId, getClientExtensionResults: () => ({ prf: { enabled: true } }) });
  const get = jest.fn().mockResolvedValue({ rawId, getClientExtensionResults: () => ({ prf: { results: { first: prfBytes.buffer } } }) });
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get } });
  let created: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn((blob: Blob) => { created = blob; return 'blob:passkey'; }) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<OnboardingPage />);

  await user.click(screen.getByRole('button', { name: 'Create passkey and key' }));
  expect(await screen.findByText('b88cf51b7d355e0041c3b5ed431b97a9')).toBeInTheDocument();
  expect(create).toHaveBeenCalledWith({ publicKey: expect.objectContaining({
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} },
  }) });
  expect(get).toHaveBeenCalledWith({ publicKey: expect.objectContaining({
    allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId) }],
    extensions: { prf: { eval: { first: new TextEncoder().encode('tempo-protected-attributes:master:v1') } } },
    userVerification: 'required',
  }) });
  expect(screen.getByRole('button', { name: 'Generate another key' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Create passkey and key' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Download key file' }));
  const file = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(created!);
  });
  expect(file).toBe('1d7Qh21vn6Ks2Dfj5b21QMZ8NSc/GBya87M0Kst/fhw=\n');
  expect(screen.getByRole('button', { name: 'Create passkey and key' })).toBeEnabled();
});

test('rejects passkeys without PRF output instead of exporting an unrelated key', async () => {
  const user = userEvent.setup();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
  const rawId = Uint8Array.from([1, 2, 3, 4]).buffer;
  const create = jest.fn().mockResolvedValue({ rawId, getClientExtensionResults: () => ({ prf: { enabled: true } }) });
  const get = jest.fn().mockResolvedValue({ rawId, getClientExtensionResults: () => ({ prf: {} }) });
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get } });
  render(<OnboardingPage />);

  await user.click(screen.getByRole('button', { name: 'Create passkey and key' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no WebAuthn PRF output');
  expect(screen.getByRole('button', { name: 'Download key file' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retry key derivation' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Retry key derivation' }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenCalledTimes(1);
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
