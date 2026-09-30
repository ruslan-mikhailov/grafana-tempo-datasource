import { css } from '@emotion/css';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, useStyles2 } from '@grafana/ui';

type Destination = 'tempo' | 'loki';
type Feedback = { message: string; error?: boolean };

// These values and component names match the distributed demo's alloy-otel.yaml
// and alloy-logs.alloy. The pipeline/source and writer must already exist.
const tempoConfig = (substring: boolean) => [
  'processors:',
  '  encrypted_attributes:',
  '    policies:',
  '      - span_attributes: [secret, api.token]',
  '        key_file: /etc/alloy/secret-key',
  '        value_scheme: aes256siv-hkdf-v1',
  ...(substring ? ['        substring_index: ordered-trigram-v1'] : []),
  '  batch: {}',
  '',
  'service:',
  '  pipelines:',
  '    traces:',
  '      receivers: [otlp]',
  '      processors: [encrypted_attributes, batch]',
  '      exporters: [otlp]',
].join('\n');

const lokiConfig = [
  'loki.encrypted_logs "demo" {',
  '  policy {',
  '    fields       = ["line.api_token"]',
  '    key_file     = "/etc/alloy/token-key"',
  '    value_scheme = "aes256siv-hkdf-v1"',
  '  }',
  '  forward_to = [loki.write.demo.receiver]',
  '}',
].join('\n');

function keyId(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const encoder = new TextEncoder();
const prfInput = encoder.encode('tempo-protected-attributes:master:v1');
const hkdfSalt = encoder.encode('tempo-passkey-master-v1');
const hkdfInfo = encoder.encode('aes256siv-hkdf-v1');

function requirePasskeyBrowser() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.create ||
      !navigator.credentials?.get || !globalThis.crypto?.subtle) {
    throw new Error('Passkeys and Web Crypto require a supported browser on localhost or HTTPS.');
  }
}

function passkeyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Passkey prompt cancelled or unavailable. No key was derived.';
  }
  return error instanceof Error ? error.message : 'Passkey operation failed.';
}

export function OnboardingPage() {
  const styles = useStyles2(getStyles);
  const [destination, setDestination] = useState<Destination>('tempo');
  const [substring, setSubstring] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [currentId, setCurrentId] = useState<string>();
  const [downloaded, setDownloaded] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState<Feedback>();
  const [copyFeedback, setCopyFeedback] = useState<Feedback>();
  const master = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pending = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pendingCredential = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const downloadInitiated = useRef(false);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<number>());
  const tempoTab = useRef<HTMLButtonElement>(null);
  const lokiTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const objectUrls = urls.current;
    const clear = () => {
      generation.current++;
      pending.current?.fill(0);
      pending.current = null;
      pendingCredential.current?.fill(0);
      pendingCredential.current = null;
      master.current?.fill(0);
      master.current = null;
      for (const timer of timers.current) {
        window.clearTimeout(timer);
      }
      timers.current.clear();
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
      objectUrls.clear();
    };
    const pagehide = () => {
      clear();
      setCurrentId(undefined);
      setDownloaded(false);
      downloadInitiated.current = false;
      busy.current = false;
      setGenerating(false);
      setKeyFeedback(undefined);
    };
    window.addEventListener('pagehide', pagehide);
    return () => {
      window.removeEventListener('pagehide', pagehide);
      clear();
    };
  }, []);

  const generateKey = async () => {
    if (busy.current || (master.current && !downloadInitiated.current)) {
      return;
    }
    busy.current = true;
    setGenerating(true);
    setKeyFeedback({ message: 'Generating a key in this browser…' });
    const run = generation.current;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let digest: Uint8Array | null = null;
    try {
      if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) {
        throw new Error('Key generation requires a secure browser context (HTTPS or localhost).');
      }
      bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      pending.current = bytes;
      digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      if (run !== generation.current) {
        return;
      }
      const id = keyId(digest);
      master.current?.fill(0);
      master.current = bytes;
      bytes = null;
      pending.current = null;
      pendingCredential.current?.fill(0);
      pendingCredential.current = null;
      downloadInitiated.current = false;
      setDownloaded(false);
      setCurrentId(id);
      setKeyFeedback({ message: 'Key ready. Download it and keep a backup before configuring Alloy.' });
    } catch {
      if (run === generation.current) {
        setKeyFeedback({ message: 'Could not generate a key. Use a secure browser context and try again.', error: true });
      }
    } finally {
      digest?.fill(0);
      bytes?.fill(0);
      if (run === generation.current) {
        pending.current = null;
        busy.current = false;
        setGenerating(false);
      }
    }
  };

  const createPasskeyKey = async () => {
    if (busy.current || (master.current && !downloadInitiated.current)) {
      return;
    }
    busy.current = true;
    setGenerating(true);
    const run = generation.current;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let output: Uint8Array<ArrayBuffer> | null = null;
    let digest: Uint8Array<ArrayBuffer> | null = null;
    try {
      requirePasskeyBrowser();
      if (!pendingCredential.current) {
        setKeyFeedback({ message: 'Create a discoverable passkey with PRF support. Choose your YubiKey if you need to use it on another computer.' });
        const credential = await navigator.credentials.create({ publicKey: {
          challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'Protected data' },
          user: {
            id: globalThis.crypto.getRandomValues(new Uint8Array(32)),
            name: `protected-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
            displayName: 'Protected data key',
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: {} },
          timeout: 120000,
        } }) as PublicKeyCredential | null;
        if (run !== generation.current) {
          return;
        }
        if (!credential || credential.getClientExtensionResults().prf?.enabled !== true) {
          throw new Error('The new passkey did not report PRF support. It cannot derive this key; a credential may remain in your provider.');
        }
        pendingCredential.current = new Uint8Array(credential.rawId);
      }
      setKeyFeedback({ message: 'Authenticate with the newly created passkey to derive its 32-byte key.' });
      const selectedId = pendingCredential.current;
      if (!selectedId) {
        throw new Error('The newly created credential is unavailable.');
      }
      const assertion = await navigator.credentials.get({ publicKey: {
        challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: selectedId }],
        extensions: { prf: { eval: { first: prfInput } } },
        timeout: 120000,
      } }) as PublicKeyCredential | null;
      if (run !== generation.current) {
        return;
      }
      if (!assertion ||
          assertion.rawId.byteLength !== selectedId.byteLength ||
          !new Uint8Array(assertion.rawId).every((byte, index) => byte === selectedId[index])) {
        throw new Error('The selected passkey does not match the newly created credential.');
      }
      const result = assertion.getClientExtensionResults().prf?.results?.first;
      if (!(result instanceof ArrayBuffer) || result.byteLength !== 32) {
        throw new Error('This passkey returned no WebAuthn PRF output. Choose a PRF-capable passkey and browser; a signature cannot recover the key.');
      }
      output = new Uint8Array(result);
      const source = await globalThis.crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveBits']);
      bytes = new Uint8Array(await globalThis.crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: hkdfInfo }, source, 256));
      if (run !== generation.current) {
        return;
      }
      pending.current = bytes;
      digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      if (run !== generation.current) {
        return;
      }
      const id = keyId(digest);
      master.current?.fill(0);
      master.current = bytes;
      bytes = null;
      pending.current = null;
      pendingCredential.current?.fill(0);
      pendingCredential.current = null;
      downloadInitiated.current = false;
      setDownloaded(false);
      setCurrentId(id);
      setKeyFeedback({ message: 'Passkey key ready. Download it for Alloy and back it up. Use the same passkey and site hostname to load it in Explore.' });
    } catch (error) {
      if (run === generation.current) {
        setKeyFeedback({ message: passkeyError(error), error: true });
      }
    } finally {
      output?.fill(0);
      digest?.fill(0);
      bytes?.fill(0);
      if (run === generation.current) {
        pending.current = null;
        busy.current = false;
        setGenerating(false);
      }
    }
  };

  const downloadKey = () => {
    const bytes = master.current;
    if (!bytes || !currentId) {
      return;
    }
    let url: string | undefined;
    try {
      const base64 = btoa(String.fromCharCode(...bytes));
      url = URL.createObjectURL(new Blob([`${base64}\n`], { type: 'text/plain' }));
      urls.current.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `protected-${currentId}.key`;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      downloadInitiated.current = true;
      setDownloaded(true);
      setKeyFeedback({ message: 'Download requested. Confirm the file is saved before generating another key.' });
      const objectUrl = url;
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        urls.current.delete(objectUrl);
        timers.current.delete(timer);
      }, 30_000);
      timers.current.add(timer);
    } catch {
      if (url) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
      setKeyFeedback({ message: 'Download could not start. Try again before generating another key.', error: true });
    }
  };

  const switchDestination = (next: Destination) => {
    setDestination(next);
    setCopyFeedback(undefined);
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: Destination;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        next = destination === 'tempo' ? 'loki' : 'tempo';
        break;
      case 'Home':
        next = 'tempo';
        break;
      case 'End':
        next = 'loki';
        break;
      default:
        return;
    }
    event.preventDefault();
    switchDestination(next);
    (next === 'tempo' ? tempoTab : lokiTab).current?.focus();
  };
  const config = destination === 'tempo' ? tempoConfig(substring) : lokiConfig;
  const copyConfig = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(config);
      setCopyFeedback({ message: `${destination === 'tempo' ? 'Tempo' : 'Loki'} config copied. No key material was copied.` });
    } catch {
      setCopyFeedback({ message: 'Clipboard access unavailable. Select the config text to copy it.', error: true });
    }
  };

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Protect trace and log fields</h1>
      <p className={styles.intro}>Alloy encrypts selected fields before Tempo or Loki stores them. Explore decrypts in your browser with the matching key.</p>
      <Alert title="Check your ingest path" severity="info">
        Other fields and routes that bypass Alloy remain exposed. Verify your ingest path before using real data.
      </Alert>

      <section className={styles.section} aria-labelledby="key-heading">
        <div className={styles.sectionHeading}><span className={styles.step}>01</span><h2 id="key-heading">Create a key</h2></div>
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <div className={styles.keyLayout}>
              <div>
                <h3 className={styles.subheading}>Browser-local master key</h3>
                <p className={styles.help}>Choose a random or passkey-derived 32-byte master for <code>aes256siv-hkdf-v1</code>. Only its key ID is displayed; this page sends no key to Grafana.</p>
              </div>
              <div className={styles.actions}>
                <Button type="button" variant="secondary" disabled={!currentId || generating} onClick={downloadKey}>Download key file</Button>
              </div>
            </div>
            <div className={styles.keyMethods} aria-label="Choose a key method">
              <div className={styles.keyMethod}>
                <h3 className={styles.subheading}>Random key</h3>
                <p className={styles.help}>Generate a key in this browser. Keep the downloaded file: a random key cannot be recovered from a passkey later.</p>
                <Button type="button" disabled={generating || (!!currentId && !downloaded)} onClick={() => void generateKey()}>
                  {currentId ? 'Generate another key' : 'Generate key'}
                </Button>
              </div>
              <div className={styles.keyMethod}>
                <h3 className={styles.subheading}>Passkey-derived key</h3>
                <p className={styles.help}>Create a discoverable, PRF-capable passkey on a YubiKey or backed-up passkey provider, then authenticate to derive its key. Requires localhost or HTTPS. To load it on another computer or browser, use the same passkey at the same site hostname (the WebAuthn RP ID); the port may differ. Back up the key file too. Existing random keys are not stored on your YubiKey.</p>
                <Button type="button" disabled={generating || (!!currentId && !downloaded)} onClick={() => void createPasskeyKey()}>
                  {pendingCredential.current ? 'Retry key derivation' : 'Create passkey and key'}
                </Button>
              </div>
            </div>
            {currentId && (
              <div className={styles.keySummary}>
                <strong>Key ready · only in this browser tab</strong>
                <dl className={styles.keyDetails}>
                  <div><dt>Key ID</dt><dd><code>{currentId}</code></dd></div>
                  <div><dt>Download</dt><dd><code>protected-{currentId}.key</code></dd></div>
                </dl>
              </div>
            )}
            <p className={keyFeedback?.error ? styles.errorFeedback : styles.feedback} role={keyFeedback?.error ? 'alert' : 'status'} aria-live="polite">{keyFeedback?.message}</p>
            <p className={styles.keyGuidance}><strong>Keep a backup.</strong> Store the downloaded file in a secret manager. Mount it read-only in Alloy and share it only with authorized readers. Use separate keys for separate access groups. Losing a key permanently loses access to its old encrypted values. Download the current key before generating or deriving another.</p>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="alloy-heading">
        <div className={styles.sectionHeading}><span className={styles.step}>02</span><h2 id="alloy-heading">Add it to Alloy</h2></div>
        <div className={styles.panel}>
          <div className={styles.tabs} role="tablist" aria-label="Alloy destination">
            <button type="button" ref={tempoTab} id="protected-tempo-tab" role="tab" aria-selected={destination === 'tempo'} aria-controls="protected-alloy-panel" tabIndex={destination === 'tempo' ? 0 : -1} onClick={() => switchDestination('tempo')} onKeyDown={handleTabKeyDown}>Tempo traces</button>
            <button type="button" ref={lokiTab} id="protected-loki-tab" role="tab" aria-selected={destination === 'loki'} aria-controls="protected-alloy-panel" tabIndex={destination === 'loki' ? 0 : -1} onClick={() => switchDestination('loki')} onKeyDown={handleTabKeyDown}>Loki logs</button>
            <span className={styles.tabHint}>Choose a pipeline</span>
          </div>
          <div className={styles.panelBody} id="protected-alloy-panel" role="tabpanel" aria-labelledby={destination === 'tempo' ? 'protected-tempo-tab' : 'protected-loki-tab'} tabIndex={0}>
            <div className={styles.snippetHeading}>
              <div>
                <h3 className={styles.subheading}>{destination === 'tempo' ? 'Tempo · OTel Collector config' : 'Loki · Alloy River config'}</h3>
                <p className={styles.help}>{destination === 'tempo' ? 'Add this processor and traces pipeline to your existing alloy otel YAML config (with an OTLP receiver and exporter).' : 'Add this component to your existing Alloy River config (with a loki.write.demo writer).'}</p>
              </div>
              <Button type="button" variant="secondary" onClick={() => void copyConfig()}>Copy config</Button>
            </div>
            <div className={styles.codeBox}><pre><code>{config}</code></pre></div>
            {destination === 'tempo' && (
              <label className={styles.toggle}>
                <input type="checkbox" checked={substring} onChange={(event) => { setSubstring(event.currentTarget.checked); setCopyFeedback(undefined); }} />
                <span>Include substring index<small>Enables Tempo substring search and increases exported data size.</small></span>
              </label>
            )}
            <p className={styles.configNote}>
              {destination === 'tempo' ? (
                <>Mount the downloaded <code>protected-{currentId ?? '<kid>'}.key</code> read-only as <code>/etc/alloy/secret-key</code> (or change <code>key_file</code> to your mount path). The demo protects <code>secret</code> and <code>api.token</code>; route traces through <code>encrypted_attributes → batch → Tempo</code>. Enable <code>protectedAttributesEnabled</code> on the Tempo datasource; substring search also requires <code>protectedAttributesSubstringEnabled</code>.</>
              ) : (
                <>Mount the downloaded <code>protected-{currentId ?? '<kid>'}.key</code> read-only as <code>/etc/alloy/token-key</code> (or change <code>key_file</code> to your mount path). The demo protects <code>line.api_token</code>. Route your source to <code>loki.encrypted_logs.demo.receiver</code>, then to your writer; replace <code>loki.write.demo</code> if your writer has another name. Do not add plaintext-producing stages or external labels downstream.</>
              )}
            </p>
            <p className={copyFeedback?.error ? styles.errorFeedback : styles.feedback} role={copyFeedback?.error ? 'alert' : 'status'} aria-live="polite">{copyFeedback?.message}</p>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="explore-heading">
        <div className={styles.sectionHeading}><span className={styles.step}>03</span><h2 id="explore-heading">Search and read in Explore</h2></div>
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <h3 className={styles.subheading}>{destination === 'tempo' ? 'Tempo' : 'Loki'}</h3>
            <p className={styles.help}>Import the downloaded <code>protected-{currentId ?? '<kid>'}.key</code> from your own device into the matching datasource in <a href="/explore">Explore</a>, then search the stored field:</p>
            <code className={styles.query}>{destination === 'tempo' ? '{span.enc.secret="value"}' : '{job="api"} | logfmt | enc.api_token="value"'}</code>
            <p className={styles.help}>{destination === 'tempo' ? 'Tempo stores ciphertext; only the browser display decrypts it. Keep this key in the browser to run protected queries.' : 'Loki stores ciphertext under api_token. Protected searches support exact matches; adjust the public stream selector and parser to your logs.'}</p>
          </div>
          <div className={styles.panelBody}>
            <p className={styles.help}>Raw results must contain <code>enc:v1</code> or <code>lenc:v1</code>, never the selected plaintext. <strong>Forget</strong> only clears browser keys; Tempo revocation and Loki whole-entry deletion are separate asynchronous operations and do not stop future writes.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({ maxWidth: 1050, padding: `${theme.spacing(3)} ${theme.spacing(4)} ${theme.spacing(7)}`, '@media (max-width: 650px)': { padding: `${theme.spacing(2)} ${theme.spacing(1.5)} ${theme.spacing(5)}` } }),
  title: css({ margin: 0, fontWeight: 400, fontSize: 28, lineHeight: 1.25, color: theme.colors.text.primary }),
  intro: css({ margin: `${theme.spacing(0.5)} 0 ${theme.spacing(2)}`, maxWidth: 780, color: theme.colors.text.secondary }),
  section: css({ marginTop: theme.spacing(3) }),
  sectionHeading: css({ display: 'flex', alignItems: 'baseline', gap: theme.spacing(1), marginBottom: theme.spacing(1) , '& h2': { margin: 0, fontSize: 19, fontWeight: 500 } }),
  step: css({ color: theme.colors.warning.main, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }),
  panel: css({ border: `1px solid ${theme.colors.border.medium}`, background: theme.colors.background.secondary, borderRadius: theme.shape.radius.default }),
  panelBody: css({ padding: theme.spacing(2), '& + &': { borderTop: `1px solid ${theme.colors.border.medium}` }, '@media (max-width: 650px)': { padding: theme.spacing(1.5) } }),
  subheading: css({ margin: 0, fontWeight: 500, fontSize: 15 }),
  help: css({ margin: `${theme.spacing(0.5)} 0 0`, color: theme.colors.text.secondary, fontSize: 13, lineHeight: 1.5, '& code': { overflowWrap: 'anywhere' } }),
  keyLayout: css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing(2), '& > div:first-child': { maxWidth: 570 }, '@media (max-width: 970px)': { flexDirection: 'column', alignItems: 'stretch' } }),
  actions: css({ display: 'flex', flex: 'none', gap: theme.spacing(1), flexWrap: 'wrap', justifyContent: 'flex-end', '@media (max-width: 970px)': { justifyContent: 'flex-start' } }),
  keyMethods: css({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: theme.spacing(1.5), marginTop: theme.spacing(2), '@media (max-width: 650px)': { gridTemplateColumns: '1fr' } }),
  keyMethod: css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: theme.spacing(1), padding: theme.spacing(1.5), border: `1px solid ${theme.colors.border.medium}`, borderRadius: theme.shape.radius.default, '& p': { flex: 1 } }),
  keySummary: css({ marginTop: theme.spacing(2), padding: theme.spacing(1.5), borderRadius: theme.shape.radius.default, border: `1px solid ${theme.colors.success.border}`, background: theme.colors.success.transparent, '& strong': { color: theme.colors.success.text } }),
  keyDetails: css({ display: 'flex', flexWrap: 'wrap', gap: theme.spacing(3), margin: `${theme.spacing(1)} 0 0`, '& div': { display: 'grid', gap: 2 }, '& dt': { color: theme.colors.text.secondary, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }, '& dd': { margin: 0, overflowWrap: 'anywhere' }, '@media (max-width: 650px)': { display: 'grid', gap: theme.spacing(1) } }),
  keyGuidance: css({ margin: `${theme.spacing(2)} 0 0`, paddingTop: theme.spacing(1.5), borderTop: `1px solid ${theme.colors.border.medium}`, color: theme.colors.text.secondary, fontSize: 13, lineHeight: 1.5, '& strong': { color: theme.colors.text.primary } }),
  feedback: css({ minHeight: 18, margin: `${theme.spacing(1)} 0 0`, color: theme.colors.success.text, fontSize: 13 }),
  errorFeedback: css({ minHeight: 18, margin: `${theme.spacing(1)} 0 0`, color: theme.colors.error.text, fontSize: 13 }),
  tabs: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(2), padding: `0 ${theme.spacing(2)}`, borderBottom: `1px solid ${theme.colors.border.medium}`, '& button': { appearance: 'none', background: 'transparent', color: theme.colors.text.secondary, border: 0, borderBottom: '2px solid transparent', padding: `${theme.spacing(1.5)} ${theme.spacing(0.5)} ${theme.spacing(1)}`, font: 'inherit', cursor: 'pointer' }, '& button[aria-selected="true"]': { color: theme.colors.text.primary, borderBottomColor: theme.colors.warning.main }, '& button:focus-visible': { outline: `2px solid ${theme.colors.primary.main}`, outlineOffset: 2 } }),
  tabHint: css({ marginLeft: 'auto', color: theme.colors.text.secondary, fontSize: 12, '@media (max-width: 650px)': { display: 'none' } }),
  snippetHeading: css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: theme.spacing(1.5), marginBottom: theme.spacing(1) }),
  codeBox: css({ overflow: 'auto', background: theme.colors.background.primary, border: `1px solid ${theme.colors.border.medium}`, borderRadius: theme.shape.radius.default, '& pre': { margin: 0, padding: theme.spacing(2), minWidth: 'max-content', fontSize: 12, lineHeight: 1.55 } }),
  toggle: css({ display: 'flex', alignItems: 'flex-start', gap: theme.spacing(1), paddingTop: theme.spacing(1.5), cursor: 'pointer', '& input': { width: 16, height: 16, margin: '2px 0 0', accentColor: theme.colors.primary.main }, '& small': { display: 'block', color: theme.colors.text.secondary, fontSize: 12, marginTop: 2 } }),
  configNote: css({ margin: `${theme.spacing(1.5)} 0 0`, color: theme.colors.text.secondary, fontSize: 13, lineHeight: 1.5, '& code': { overflowWrap: 'anywhere' } }),
  query: css({ display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere', margin: `${theme.spacing(1)} 0`, padding: theme.spacing(1), border: `1px solid ${theme.colors.border.medium}`, background: theme.colors.background.primary, borderRadius: theme.shape.radius.default, fontSize: 12 }),
});

export default OnboardingPage;
