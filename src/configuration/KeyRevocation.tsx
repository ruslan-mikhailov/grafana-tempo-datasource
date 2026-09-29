import { useEffect, useRef, useState } from 'react';

import { type SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Input, Modal, MultiSelect, Stack } from '@grafana/ui';

import { importKey, type ProtectedAttributeKey } from '../protectedAttributes/crypto';

type Capability = { enabled: boolean; canSubmit: boolean };
type TagResponse = { scopes?: Array<{ name: string; tags: string[] }> };
type Submission = { attribute: string; batchId?: string; jobsCreated?: number; error?: string };
type Confirmation = { uid: string; name: string; kid: string; attributes: string[] };

const keyFileLimit = 64 * 1024;

export function KeyRevocation({ uid, name }: { uid?: string; name: string }) {
  const [capability, setCapability] = useState<Capability>();
  const [capabilityError, setCapabilityError] = useState(false);
  const [attributes, setAttributes] = useState<string[]>([]);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [kid, setKid] = useState<string>();
  const [method, setMethod] = useState<'file' | 'paste'>('file');
  const [keyError, setKeyError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [results, setResults] = useState<Submission[]>([]);
  const pasteInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const importBusy = useRef(false);
  const submitBusy = useRef(false);
  const previousUid = useRef(uid);

  useEffect(() => {
    if (previousUid.current !== uid) {
      previousUid.current = uid;
      if (pasteInput.current) { pasteInput.current.value = ''; }
      if (fileInput.current) { fileInput.current.value = ''; }
      setCapability(undefined);
      setCapabilityError(false);
      setAttributes([]);
      setDiscoveryError(false);
      setSelected([]);
      setKid(undefined);
      setKeyError(undefined);
      setBusy(false);
      setSubmitting(false);
      setConfirmation(undefined);
      setAcknowledged(false);
      setResults([]);
      importBusy.current = false;
      submitBusy.current = false;
    }
    let active = true;
    if (!uid) {
      return () => { active = false; generation.current++; };
    }
    const base = `/api/datasources/uid/${encodeURIComponent(uid)}/resources`;
    void (async () => {
      try {
        const status = await getBackendSrv().get<Capability>(`${base}/redaction/capabilities`);
        if (!active) { return; }
        setCapability(status);
        if (!status.enabled || !status.canSubmit) { return; }
        try {
          // Tempo's v2 tags response includes scoped names, not attribute values.
          const response = await getBackendSrv().get<TagResponse>(`${base}/tags`);
          if (!active) { return; }
          setAttributes(Array.from(new Set((response.scopes ?? [])
            .filter((scope) => scope.name === 'span' || scope.name === 'resource')
            .flatMap((scope) => (scope.tags ?? [])
              .filter((tag) => typeof tag === 'string' && tag.startsWith('enc'))
              .map((tag) => `${scope.name}.${tag}`)))).sort());
        } catch {
          if (active) { setDiscoveryError(true); }
        }
      } catch {
        if (active) { setCapabilityError(true); }
      }
    })();
    return () => { active = false; generation.current++; };
  }, [uid]);

  const clearInputs = () => {
    if (pasteInput.current) { pasteInput.current.value = ''; }
    if (fileInput.current) { fileInput.current.value = ''; }
  };
  const removeKey = () => {
    generation.current++;
    clearInputs();
    setKid(undefined);
    setKeyError(undefined);
    setConfirmation(undefined);
    setAcknowledged(false);
    setResults([]);
    setBusy(false);
    importBusy.current = false;
  };
  const loadKey = async (text: string, fromFile = false) => {
    if (importBusy.current || submitBusy.current) { return; }
    removeKey();
    const current = generation.current;
    importBusy.current = true;
    setBusy(true);
    let imported: ProtectedAttributeKey | undefined;
    try {
      const value = text.trim();
      if (!value || /\s/.test(value)) { throw new Error('invalid key'); }
      imported = await importKey(value);
      if (generation.current === current) { setKid(imported.kid); }
    } catch {
      if (generation.current === current) {
        setKeyError(fromFile ? 'Key file must contain exactly one valid base64-encoded 32-byte key.' : 'Enter one valid base64-encoded 32-byte key.');
      }
    } finally {
      imported?.clear();
      if (generation.current === current) { setBusy(false); importBusy.current = false; }
    }
  };
  const loadFile = async (file?: File) => {
    if (!file) { return; }
    if (file.size > keyFileLimit) {
      removeKey();
      setKeyError('Key file must be 64 KiB or smaller.');
      return;
    }
    // Invalidate any prior read before awaiting File.text().
    removeKey();
    const current = generation.current;
    setBusy(true);
    importBusy.current = true;
    try {
      const text = await file.text();
      if (generation.current !== current) { return; }
      importBusy.current = false;
      await loadKey(text, true);
    } catch {
      if (generation.current === current) { setKeyError('Unable to read key file.'); }
    } finally {
      if (generation.current === current && importBusy.current) { importBusy.current = false; setBusy(false); }
    }
  };
  const review = () => {
    if (!uid || !kid || !selected.length || !capability?.enabled || !capability.canSubmit || submitBusy.current) { return; }
    // Keep accepted batch IDs visible while the operator reviews a failed attribute again.
    setAcknowledged(false);
    setConfirmation({ uid, name, kid, attributes: [...selected] });
  };
  const submit = async () => {
    if (!confirmation || !acknowledged || !capability?.enabled || !capability.canSubmit || submitBusy.current || confirmation.uid !== uid) { return; }
    const snapshot = confirmation;
    submitBusy.current = true;
    setSubmitting(true);
    setConfirmation(undefined);
    const base = `/api/datasources/uid/${encodeURIComponent(snapshot.uid)}/resources/redaction`;
    const submittedGeneration = generation.current;
    try {
      const outcomes: Submission[] = [];
      for (const attribute of snapshot.attributes) {
        // A tenant can have only one active redaction batch. Do not race its scheduler with concurrent submissions.
        if (generation.current !== submittedGeneration) { break; }
        try {
          const response = await getBackendSrv().post<{ batchId: string; jobsCreated: number }>(base, {
            attributeRedaction: { key: attribute, valuePrefix: `enc:v1:${snapshot.kid}` },
          });
          outcomes.push({ attribute, batchId: response.batchId, jobsCreated: response.jobsCreated });
        } catch (error) {
          const conflict = typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
          outcomes.push({ attribute, error: conflict
            ? 'Another redaction batch is active for this tenant. Retry this attribute after that batch completes.'
            : 'Submission could not be confirmed. Check scheduler state before retry; no automatic retry was attempted.' });
        }
      }
      if (generation.current === submittedGeneration) {
        setResults((previous) => [...previous.filter((item) => !snapshot.attributes.includes(item.attribute)), ...outcomes]);
        setSelected(outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.attribute));
      }
    } finally {
      if (generation.current === submittedGeneration) {
        submitBusy.current = false;
        setSubmitting(false);
      }
    }
  };

  if (!uid) { return <Alert title="Save the data source first" severity="info">Key revocation requires a saved data source.</Alert>; }
  if (capabilityError) { return <Alert title="Unable to check key revocation availability" severity="error">No requests can be submitted.</Alert>; }
  if (!capability) { return <p>Checking key revocation availability…</p>; }
  if (!capability.enabled) { return <Alert title="Key revocation unavailable" severity="info">A redaction scheduler and tenant must be configured for this data source.</Alert>; }
  if (!capability.canSubmit) { return <Alert title="Key revocation requires an organization Admin" severity="warning">No requests can be submitted.</Alert>; }

  const choices: Array<SelectableValue<string>> = attributes.map((value) => ({ label: value, value }));
  return (
    <section aria-label="Key revocation">
      <h4>Key revocation</h4>
      <Alert title="Permanent data rewrite, not key rotation" severity="warning">
        Matching values in all stored blocks become [REDACTED]. Traces remain. Rotate or disable the ingestion key separately to prevent future writes with this key.
      </Alert>
      <p>Attribute discovery shows current names, not a complete historical inventory. Select only span or resource names beginning with enc.</p>
      {discoveryError && <Alert title="Unable to discover attributes" severity="error">Try reopening this page when Tempo is available.</Alert>}
      <label htmlFor="redaction-attributes">Attributes to redact</label>
      <MultiSelect<string>
        inputId="redaction-attributes"
        aria-label="Attributes to redact"
        options={choices}
        value={selected}
        onChange={(values) => {
          setSelected(Array.from(new Set(values.flatMap((item) => item.value && attributes.includes(item.value) ? [item.value] : []))));
          setConfirmation(undefined);
        }}
        isSearchable
        disabled={submitting || busy || !!discoveryError}
        placeholder="Search enc attributes…"
      />
      <p>One independent scheduler request per selected attribute.</p>
      <p>Key to revoke — load one local 32-byte base64 key. Only its derived key ID is retained in this form.</p>
      {kid ? <div role="status">Key ID: <code>{kid}</code> <Button variant="secondary" disabled={submitting} onClick={removeKey}>Remove key</Button></div> : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
          <Stack gap={1}>
            <Button variant={method === 'file' ? 'primary' : 'secondary'} disabled={busy || submitting} onClick={() => { removeKey(); setMethod('file'); fileInput.current?.click(); }}>Choose local key file</Button>
            <Button variant={method === 'paste' ? 'primary' : 'secondary'} disabled={submitting} onClick={() => { removeKey(); setMethod('paste'); }}>Paste base64</Button>
          </Stack>
          {method === 'file' && <span role="status">{busy ? 'Reading key file…' : 'No key loaded'}</span>}
          <input id="redaction-key-file" aria-label="Key file" ref={fileInput} type="file" accept=".txt,.key,text/plain" style={{ display: 'none' }} disabled={busy || submitting} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void loadFile(file); }} />
          {method === 'paste' && (
            <Stack direction="column" gap={1} alignItems="flex-start">
              <label htmlFor="redaction-key-paste">Base64 key</label>
              <Input id="redaction-key-paste" ref={pasteInput} type="password" autoComplete="off" disabled={busy || submitting} onChange={() => { setKeyError(undefined); setConfirmation(undefined); }} />
              <Button disabled={busy || submitting} onClick={() => { const value = pasteInput.current?.value ?? ''; clearInputs(); void loadKey(value); }}>Load pasted key</Button>
            </Stack>
          )}
        </div>
      )}
      {keyError && <Alert title="Invalid key" severity="error">{keyError}</Alert>}
      <p>Data source: {name}. Scope: all stored blocks for this data source’s configured tenant, with no time bounds.</p>
      {kid && <p>Match: selected attributes with values starting <code>enc:v1:{kid}</code>.</p>}
      <Button variant="destructive" disabled={!kid || !selected.length || busy || submitting} onClick={review}>Revoke key…</Button>
      {submitting && <p role="status">Submitting independent requests. Queued does not mean completed.</p>}
      {results.length > 0 && <div role="status" aria-label="Revocation submission results">
        <p>Submission results — queued jobs are not completed redactions. No automatic retries.</p>
        <ul>{results.map((result) => <li key={result.attribute}>
          <code>{result.attribute}</code>: {result.error ?? `Queued ${result.jobsCreated} job(s), batch ${result.batchId}.`}
        </li>)}</ul>
      </div>}
      <Modal title="Revoke key and delete matching data?" isOpen={!!confirmation} onDismiss={() => { if (!submitting) { setConfirmation(undefined); setAcknowledged(false); } }}>
        {confirmation && <div>
          <Alert title="Irreversible redaction" severity="error">Matching values in all stored blocks become [REDACTED]. This cannot be undone. Traces survive; future writes are not stopped.</Alert>
          <p>Data source: {confirmation.name}</p><p>Key ID: <code>{confirmation.kid}</code></p>
          <p>Attributes:</p><ul>{confirmation.attributes.map((attribute) => <li key={attribute}><code>{attribute}</code></li>)}</ul>
          <p>One separate request per attribute. Accepted requests queue jobs; they do not indicate completion.</p>
          <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} /> I understand that this redaction is permanent and does not stop future writes.</label>
          <Stack gap={1} justifyContent="flex-end">
            <Button variant="secondary" onClick={() => { setConfirmation(undefined); setAcknowledged(false); }}>Cancel</Button>
            <Button variant="destructive" disabled={!acknowledged || submitting} onClick={() => void submit()}>Confirm redaction</Button>
          </Stack>
        </div>}
      </Modal>
    </section>
  );
}
