const encoder = new TextEncoder();
const prfInput = encoder.encode('tempo-protected-attributes:master:v1');
const hkdfSalt = encoder.encode('tempo-passkey-master-v1');
const hkdfInfo = encoder.encode('aes256siv-hkdf-v1');

/** Recover the same master on any browser sharing this page's WebAuthn RP ID. */
export async function loadPasskeyMaster(signal: AbortSignal): Promise<string> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get || !crypto?.subtle) {
    throw new Error('WebAuthn and Web Crypto require a supported browser on localhost or HTTPS.');
  }

  // No allowCredentials: the authenticator offers discoverable credentials for this RP ID.
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfInput } } },
      timeout: 120000,
    } as PublicKeyCredentialRequestOptions,
    signal,
  }) as PublicKeyCredential | null;
  const extension = assertion?.getClientExtensionResults();
  const prf = extension && 'prf' in extension ? extension.prf : undefined;
  const results = prf && typeof prf === 'object' && 'results' in prf ? prf.results : undefined;
  const result = results && typeof results === 'object' && 'first' in results ? results.first : undefined;
  if (!(result instanceof ArrayBuffer) || result.byteLength !== 32) {
    throw new Error('This passkey returned no WebAuthn PRF output. Choose a PRF-capable passkey and browser; a signature alone cannot recover the key.');
  }

  const prfOutput = new Uint8Array(result);
  try {
    if (signal.aborted) {
      throw new DOMException('Passkey prompt cancelled.', 'AbortError');
    }
    const source = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits']);
    const master = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: hkdfInfo }, source, 256
    ));
    try {
      if (signal.aborted) {
        throw new DOMException('Passkey prompt cancelled.', 'AbortError');
      }
      return btoa(String.fromCharCode(...master));
    } finally {
      master.fill(0);
    }
  } finally {
    prfOutput.fill(0);
  }
}
