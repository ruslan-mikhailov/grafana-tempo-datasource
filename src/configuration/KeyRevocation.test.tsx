import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { getBackendSrv } from '@grafana/runtime';

import { KeyRevocation } from './KeyRevocation';

jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));
jest.mock('@grafana/ui', () => {
  const TestReact: typeof React = jest.requireActual('react');
  return {
    Alert: ({ title, children }: { title: string; children: React.ReactNode }) => <div role="alert"><strong>{title}</strong>{children}</div>,
    Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
    Input: TestReact.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => <input {...props} ref={ref} />),
    Modal: ({ title, children, isOpen }: { title: string; children: React.ReactNode; isOpen: boolean }) => isOpen ? <div role="dialog" aria-label={title}>{children}</div> : null,
    Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MultiSelect: ({ options, value, onChange, disabled }: {
      options: Array<{ label: string; value: string }>;
      value: string[];
      onChange: (items: Array<{ label: string; value: string }>) => void;
      disabled?: boolean;
    }) => {
      return <div>{options.map((item) =>
          <button type="button" key={item.value} disabled={disabled} aria-pressed={value.includes(item.value)}
            onClick={() => onChange((value.includes(item.value) ? value.filter((v) => v !== item.value) : [...value, item.value]).map((v) => ({ label: v, value: v })))}>{item.label}</button>)}
      </div>;
    },
  };
});

const secret = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const kid = '630dcd2966c4336691125448bbb25b4f';
const scopedTags = { scopes: [
  { name: 'span', tags: ['enc.secret', 'enc.secret', 'enc.token', 'misc.enc.not-secret'] },
  { name: 'resource', tags: ['enc.secret', 'enc.resource'] },
  { name: 'intrinsic', tags: ['enc.invalid'] },
  { name: 'event', tags: ['enc.invalid'] },
] };
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const get = jest.fn();
const post = jest.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); });
afterAll(() => {
  if (originalCrypto) { Object.defineProperty(globalThis, 'crypto', originalCrypto); }
  else { Reflect.deleteProperty(globalThis, 'crypto'); }
});
beforeEach(() => {
  get.mockReset(); post.mockReset();
  (getBackendSrv as jest.Mock).mockReturnValue({ get, post });
  get.mockImplementation((url: string) => Promise.resolve(url.endsWith('/capabilities') ? { enabled: true, canSubmit: true } : scopedTags));
  post.mockResolvedValue({ batchId: 'batch-123', jobsCreated: 2 });
});

async function loadPastedKey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Paste base64' }));
  await user.type(screen.getByLabelText('Base64 key'), secret);
  await user.click(screen.getByRole('button', { name: 'Load pasted key' }));
  await screen.findByText(kid);
}

it('derives a key ID from pasted key without saving or transmitting key material; filters deduplicated scoped names', async () => {
  const user = userEvent.setup();
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByText('span.enc.secret');
  expect(screen.getAllByRole('button', { name: 'span.enc.secret' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'resource.enc.secret' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'intrinsic.enc.invalid' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'span.misc.enc.not-secret' })).not.toBeInTheDocument();
  await loadPastedKey(user);
  expect(screen.queryByLabelText('Base64 key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'span.enc.secret' }));
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  expect(screen.getByRole('button', { name: 'Confirm redaction' })).toBeDisabled();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(post).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(kid);
  expect(screen.getByRole('dialog')).toHaveTextContent('span.enc.secret');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm redaction' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenCalledWith('/api/datasources/uid/tempo-uid/resources/redaction', {
    attributeRedaction: { key: 'span.enc.secret', valuePrefix: `enc:v1:${kid}` },
  });
  expect(JSON.stringify([...get.mock.calls, ...post.mock.calls])).not.toContain(secret);
  expect(screen.getByRole('status', { name: 'Revocation submission results' })).toHaveTextContent('Queued 2 job(s), batch batch-123');
  expect(screen.getByRole('status', { name: 'Revocation submission results' })).toHaveTextContent('not completed');
});

it('opens the key picker directly, including after switching from paste mode', async () => {
  const user = userEvent.setup();
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByText('span.enc.secret');
  const fileInput = screen.getByLabelText('Key file') as HTMLInputElement;
  const openPicker = jest.spyOn(fileInput, 'click').mockImplementation(() => {});
  await user.click(screen.getByRole('button', { name: 'Choose local key file' }));
  expect(openPicker).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Paste base64' }));
  expect(screen.getByLabelText('Base64 key')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Choose local key file' }));
  expect(openPicker).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('Base64 key')).not.toBeInTheDocument();
});

it('loads one valid local key file; rejects malformed and multi-key files and clears source input', async () => {
  const user = userEvent.setup();
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByText('span.enc.secret');
  const fileInput = screen.getByLabelText('Key file') as HTMLInputElement;
  const makeFile = (text: string) => {
    const file = new File([text], 'key.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
    return file;
  };
  await user.upload(fileInput, makeFile(`${secret}\n${secret}`));
  expect(await screen.findByText(/Key file must contain exactly one valid/)).toBeInTheDocument();
  expect(fileInput.value).toBe('');
  await user.upload(fileInput, makeFile(secret));
  await screen.findByText(kid);
  expect(fileInput.value).toBe('');
  await user.click(screen.getByRole('button', { name: 'Remove key' }));
  expect(screen.queryByText(kid)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Paste base64' }));
  await user.type(screen.getByLabelText('Base64 key'), '%%%');
  await user.click(screen.getByRole('button', { name: 'Load pasted key' }));
  expect(await screen.findByText(/Enter one valid base64/)).toBeInTheDocument();
  expect((screen.getByLabelText('Base64 key') as HTMLInputElement).value).toBe('');
  expect(post).not.toHaveBeenCalled();
});

it('gates requests by backend capability and unsaved datasources', async () => {
  const { rerender } = render(<KeyRevocation name="Tempo" />);
  expect(get).not.toHaveBeenCalled();
  get.mockResolvedValueOnce({ enabled: false, canSubmit: false });
  rerender(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByText(/redaction scheduler and tenant must be configured/);
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
  get.mockResolvedValueOnce({ enabled: true, canSubmit: false });
  rerender(<KeyRevocation key="second" uid="other-uid" name="Other Tempo" />);
  await screen.findByText(/requires an organization Admin/);
  expect(get).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
});

it('reports per-attribute partial success and leaves only failed attributes selected for explicit retry', async () => {
  const user = userEvent.setup();
  post.mockImplementation((_url: string, body: { attributeRedaction: { key: string } }) =>
    body.attributeRedaction.key === 'span.enc.secret'
      ? Promise.resolve({ batchId: 'accepted-batch', jobsCreated: 3 })
      : Promise.reject({ status: 409 }));
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByRole('button', { name: 'span.enc.token' });
  await loadPastedKey(user);
  await user.click(screen.getByRole('button', { name: 'span.enc.secret' }));
  await user.click(screen.getByRole('button', { name: 'span.enc.token' }));
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm redaction' }));
  const results = await screen.findByRole('status', { name: 'Revocation submission results' });
  expect(results).toHaveTextContent('accepted-batch');
  expect(results).toHaveTextContent('Another redaction batch is active');
  expect(post).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'span.enc.secret' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'span.enc.token' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('span.enc.token');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('span.enc.secret');
  expect(post).toHaveBeenCalledTimes(2);
});

it('does not duplicate a pending submission on repeated confirmation clicks', async () => {
  const pending = deferred<{ batchId: string; jobsCreated: number }>();
  post.mockImplementation(() => pending.promise);
  const user = userEvent.setup();
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByRole('button', { name: 'span.enc.secret' });
  await loadPastedKey(user);
  await user.click(screen.getByRole('button', { name: 'span.enc.secret' }));
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  await user.click(screen.getByRole('checkbox'));
  const confirm = screen.getByRole('button', { name: 'Confirm redaction' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Revoke key…' })).toBeDisabled();
  pending.resolve({ batchId: 'pending-batch', jobsCreated: 1 });
  await screen.findByText(/Queued 1 job\(s\), batch pending-batch/);
  expect(post).toHaveBeenCalledTimes(1);
});

it('submits attributes in order, never starting the second while the first is pending', async () => {
  const first = deferred<{ batchId: string; jobsCreated: number }>();
  post.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ batchId: 'second-batch', jobsCreated: 0 });
  const user = userEvent.setup();
  render(<KeyRevocation uid="tempo-uid" name="Tempo" />);
  await screen.findByRole('button', { name: 'span.enc.secret' });
  await loadPastedKey(user);
  await user.click(screen.getByRole('button', { name: 'span.enc.secret' }));
  await user.click(screen.getByRole('button', { name: 'span.enc.token' }));
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm redaction' }));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][1].attributeRedaction.key).toBe('span.enc.secret');
  await act(async () => { first.resolve({ batchId: 'first-batch', jobsCreated: 2 }); await first.promise; });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][1].attributeRedaction.key).toBe('span.enc.token');
});

it('does not start undispatched attributes after switching datasources during a submission', async () => {
  const first = deferred<{ batchId: string; jobsCreated: number }>();
  post.mockImplementationOnce(() => first.promise);
  const user = userEvent.setup();
  const { rerender } = render(<KeyRevocation uid="old-uid" name="Old Tempo" />);
  await screen.findByRole('button', { name: 'span.enc.secret' });
  await loadPastedKey(user);
  await user.click(screen.getByRole('button', { name: 'span.enc.secret' }));
  await user.click(screen.getByRole('button', { name: 'span.enc.token' }));
  await user.click(screen.getByRole('button', { name: 'Revoke key…' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm redaction' }));
  expect(post).toHaveBeenCalledTimes(1);
  rerender(<KeyRevocation uid="new-uid" name="New Tempo" />);
  await act(async () => { first.resolve({ batchId: 'old-batch', jobsCreated: 1 }); await first.promise; });
  await screen.findByText(/Data source: New Tempo/);
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(kid)).not.toBeInTheDocument();
});

it('does not attach a key from an old datasource after a UID switch during file import', async () => {
  const pending = deferred<string>();
  const file = new File([secret], 'key.txt');
  Object.defineProperty(file, 'text', { value: () => pending.promise });
  const { rerender } = render(<KeyRevocation uid="old-uid" name="Old Tempo" />);
  await screen.findByRole('button', { name: 'span.enc.secret' });
  fireEvent.change(screen.getByLabelText('Key file'), { target: { files: [file] } });
  rerender(<KeyRevocation uid="new-uid" name="New Tempo" />);
  await act(async () => { pending.resolve(secret); await pending.promise; });
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/datasources/uid/new-uid/resources/tags'));
  expect(screen.queryByText(kid)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Revoke key…' })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});
