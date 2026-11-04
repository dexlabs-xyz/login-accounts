/**
 * Passkey ceremonies in the browser, plus the wallet vault.
 *
 * Rule: the PRF output is the key to the wallet. It is read here, used here,
 * and stripped from every response before anything is sent to the server.
 */
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import {
  PRF_INPUT,
  closeVault,
  createVault,
  openVault,
  wrapForPasskey,
  type Bytes,
  type EncryptedVault,
  type OpenVault,
  type WrappedKey,
} from '@login/vault';
import { api, ApiError } from './api.ts';

export interface PublicCredential {
  id: string;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  canOpenWallet: boolean;
  /** null = not known yet (e.g. added while the wallet was locked). */
  prfSupported: boolean | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Me {
  userId: string;
  email: string;
  webauthnUserId: string;
  hasVault: boolean;
  credentials: PublicCredential[];
}

// ---------- PRF plumbing ----------

function withPrf<T extends { extensions?: object }>(options: T): T {
  return { ...options, extensions: { ...options.extensions, prf: { eval: { first: PRF_INPUT } } } };
}

type PrfExt = { enabled?: boolean; results?: { first?: BufferSource } };

/** Take the PRF output out of a passkey response, returning a copy that is safe to send. */
function takePrf<R extends { clientExtensionResults: object }>(response: R): {
  safe: R;
  prf: Bytes | null;
  prfEnabled: boolean;
} {
  const { prf, ...otherExt } = response.clientExtensionResults as { prf?: PrfExt };
  const first = prf?.results?.first;
  const bytes = first
    ? new Uint8Array(ArrayBuffer.isView(first) ? first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) : first.slice(0))
    : null;
  const safe = {
    ...response,
    clientExtensionResults: { ...otherExt, ...(prf ? { prf: { enabled: prf.enabled } } : {}) },
  };
  return { safe, prf: bytes as Bytes | null, prfEnabled: prf?.enabled === true || !!bytes };
}

// ---------- in-memory wallet (D5) ----------

const IDLE_LOCK_MS = 15 * 60_000;
let open: OpenVault | null = null;
let openUserId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export const wallet = {
  isOpen: () => open !== null,
  /** Short, non-secret fingerprint so testers can see two passkeys open the same wallet. */
  async fingerprint(): Promise<string | null> {
    if (!open) return null;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', open.rootSecret));
    return Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  },
  lock() {
    closeVault(open);
    open = null;
    openUserId = null;
    clearTimeout(idleTimer);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  touch() {
    if (!open) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => wallet.lock(), IDLE_LOCK_MS);
  },
};

function setOpen(v: OpenVault, userId: string) {
  closeVault(open);
  open = v;
  openUserId = userId;
  wallet.touch();
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => wallet.lock());
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => wallet.touch(), { passive: true });
}

// ---------- ceremonies ----------

export type WalletOutcome =
  | { kind: 'opened' }
  | { kind: 'created' }
  | { kind: 'no-prf' } // this device/passkey can't produce the secret (D7)
  | { kind: 'passkey-not-enrolled' } // wallet exists but this passkey wasn't added to it
  | { kind: 'no-wallet' }; // account has no wallet yet; can be set up from here

/** Ask a specific passkey (or any) for its PRF output. Also signs in. */
async function passkeySignIn(opts: { credentialId?: string; credentialIds?: string[]; autofill?: boolean } = {}) {
  const { ceremonyId, options } = await api<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    'POST',
    '/api/login/options',
    {},
  );
  const optionsJSON = withPrf({
    ...options,
    ...(opts.credentialId || opts.credentialIds?.length
      ? {
          allowCredentials: (opts.credentialId ? [opts.credentialId] : opts.credentialIds!).map((id) => ({
            id,
            type: 'public-key' as const,
          })),
        }
      : {}),
  });
  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON,
    useBrowserAutofill: opts.autofill ?? false,
  });
  const { safe, prf } = takePrf(response);
  try {
    const result = await api<{
      userId: string;
      credentialId: string;
      vault: EncryptedVault | null;
      wrapped: WrappedKey | null;
    }>('POST', '/api/login/verify', { ceremonyId, response: safe });
    return { ...result, prf };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unknown-credential') {
      // Tell the password manager this passkey is dead so it stops offering it.
      const signal = (PublicKeyCredential as unknown as {
        signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
      }).signalUnknownCredential;
      await signal?.({ rpId: location.hostname, credentialId: response.id }).catch(() => {});
    }
    throw err;
  }
}

/** Create the vault, check it locally, upload it, and check the stored copy (D3). */
async function setUpWallet(prf: Bytes, userId: string, credentialId: string) {
  const created = await createVault(prf, userId, credentialId);
  const local = await openVault(prf, userId, credentialId, created.wrapped, created.vault);
  if (!sameBytes(local.rootSecret, created.open.rootSecret)) throw new Error('Wallet check failed on this device.');
  closeVault(local);

  await api('PUT', '/api/vault', { credentialId, vault: created.vault, wrapped: created.wrapped });
  const stored = await api<{ vault: EncryptedVault; wrapped: WrappedKey }>(
    'GET',
    `/api/vault?credentialId=${encodeURIComponent(credentialId)}`,
  );
  const reopened = await openVault(prf, userId, credentialId, stored.wrapped, stored.vault);
  if (!sameBytes(reopened.rootSecret, created.open.rootSecret)) throw new Error('Wallet check failed after saving.');
  closeVault(reopened);
  setOpen(created.open, userId);
}

/** Remember (server-side, for the UI) that this passkey's storage can't open wallets. */
async function markNoPrf(credentialId: string) {
  await api('PUT', `/api/passkeys/${encodeURIComponent(credentialId)}/prf-unsupported`).catch(() => {});
}

async function useSignIn(result: Awaited<ReturnType<typeof passkeySignIn>>): Promise<WalletOutcome> {
  const { prf, vault, wrapped, userId, credentialId } = result;
  if (!prf) {
    if (!wrapped) await markNoPrf(credentialId);
    return { kind: 'no-prf' };
  }
  if (!vault) return { kind: 'no-wallet' };
  if (!wrapped) return { kind: 'passkey-not-enrolled' };
  setOpen(await openVault(prf, userId, credentialId, wrapped, vault), userId);
  return { kind: 'opened' };
}

/** Sign up after the email is verified. One passkey prompt, two if the device needs it (D3). */
export async function signUp(ticket: string): Promise<WalletOutcome> {
  const { ceremonyId, options } = await api<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    'POST',
    '/api/register/options',
    { ticket },
  );
  const response: RegistrationResponseJSON = await startRegistration({ optionsJSON: withPrf(options) });
  const { safe, prf: prfAtCreate, prfEnabled } = takePrf(response);
  const { userId, credential } = await api<{ userId: string; credential: PublicCredential }>(
    'POST',
    '/api/register/verify',
    { ticket, ceremonyId, response: safe },
  );

  let prf = prfAtCreate;
  if (!prf && prfEnabled) {
    // Passkey supports PRF but only returns it on sign-in. Second prompt.
    prf = (await passkeySignIn({ credentialId: credential.id })).prf;
  }
  if (!prf) {
    await markNoPrf(credential.id);
    return { kind: 'no-prf' };
  }
  await setUpWallet(prf, userId, credential.id);
  return { kind: 'created' };
}

export async function signIn(opts: { autofill?: boolean } = {}): Promise<WalletOutcome> {
  return useSignIn(await passkeySignIn(opts));
}

/** Unlock or re-confirm with any of *this user's* passkeys (D5). */
export async function unlock(me: Me): Promise<WalletOutcome> {
  // Only offer passkeys that can actually open the wallet.
  const openers = me.credentials.filter((c) => c.canOpenWallet).map((c) => c.id);
  const result = await passkeySignIn({ credentialIds: openers });
  if (result.userId !== me.userId) {
    wallet.lock();
    throw new Error('That passkey belongs to a different Login account. You are now signed in as that account.');
  }
  return useSignIn(result);
}

/** Set up a wallet for an account made on a device without PRF. */
export async function setUpWalletHere(me: Me): Promise<WalletOutcome> {
  const result = await passkeySignIn();
  if (result.userId !== me.userId) throw new Error('That passkey belongs to a different Login account.');
  if (!result.prf) {
    await markNoPrf(result.credentialId);
    return { kind: 'no-prf' };
  }
  if (result.vault) return useSignIn(result);
  await setUpWallet(result.prf, me.userId, result.credentialId);
  return { kind: 'created' };
}

/** What happened when a passkey was added or connected to the wallet. */
export type ConnectResult =
  | 'connected' // opens the wallet on its own now
  | 'no-prf' // its storage can't produce the secret: sign-in only, not a backup
  | 'wallet-locked' // wallet wasn't open, so it couldn't be given a key yet
  | 'no-wallet'; // account has no wallet yet

/** Give a passkey its own copy of the wallet key, after checking it really opens the wallet (D1). */
async function connectWith(me: Me, credentialId: string, prf: Bytes): Promise<void> {
  if (!open || openUserId !== me.userId) throw new Error('Unlock your wallet first.');
  const expected = open.rootSecret.slice();
  try {
    const wrapped = await wrapForPasskey(open.dataKey, prf, me.userId, credentialId);
    const stored = await api<{ vault: EncryptedVault }>('GET', `/api/vault?credentialId=${encodeURIComponent(credentialId)}`);
    const check = await openVault(prf, me.userId, credentialId, wrapped, stored.vault);
    const ok = sameBytes(check.rootSecret, expected);
    closeVault(check);
    if (!ok) throw new Error('That passkey could not open the wallet, so it was not connected.');
    await api('PUT', `/api/passkeys/${encodeURIComponent(credentialId)}/wrapped`, { wrapped });
  } finally {
    expected.fill(0);
  }
}

/** Add another passkey and let it open the wallet too (D1, D4). */
/**
 * Where the user wants the new passkey. 'phone' and 'security-key' ask for an
 * external device: Chrome follows the hint and opens the QR code or security-key
 * prompt directly; Safari ignores hints but honours "cross-platform".
 * 'any' leaves the choice to the browser.
 */
export type PasskeyPlace = 'phone' | 'security-key' | 'any';

function placeOptions(options: PublicKeyCredentialCreationOptionsJSON, place: PasskeyPlace) {
  if (place === 'any') return options;
  return {
    ...options,
    hints: [place === 'phone' ? ('hybrid' as const) : ('security-key' as const)],
    authenticatorSelection: { ...options.authenticatorSelection, authenticatorAttachment: 'cross-platform' as const },
  };
}

export async function addPasskey(
  me: Me,
  place: PasskeyPlace = 'any',
): Promise<{ result: ConnectResult; credentialId: string }> {
  const { ceremonyId, options } = await api<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    'POST',
    '/api/passkeys/options',
    {},
  );
  const response: RegistrationResponseJSON = await startRegistration({
    optionsJSON: withPrf(placeOptions(options, place)),
  });
  const { safe, prf: prfAtCreate, prfEnabled } = takePrf(response);
  const { credential } = await api<{ credential: PublicCredential }>('POST', '/api/passkeys/verify', {
    ceremonyId,
    response: safe,
  });
  const credentialId = credential.id;
  if (!me.hasVault) return { result: 'no-wallet', credentialId };
  if (!prfAtCreate && !prfEnabled) {
    await markNoPrf(credentialId);
    return { result: 'no-prf', credentialId };
  }
  if (!open || openUserId !== me.userId) return { result: 'wallet-locked', credentialId };

  let prf = prfAtCreate;
  if (!prf) prf = (await passkeySignIn({ credentialId })).prf;
  if (!prf) {
    await markNoPrf(credentialId);
    return { result: 'no-prf', credentialId };
  }
  await connectWith(me, credentialId, prf);
  return { result: 'connected', credentialId };
}

/** Connect an existing sign-in-only passkey to the wallet. Wallet must be unlocked. */
export async function connectPasskey(me: Me, credentialId: string): Promise<ConnectResult> {
  if (!open || openUserId !== me.userId) return 'wallet-locked';
  const r = await passkeySignIn({ credentialId });
  if (r.userId !== me.userId) throw new Error('That passkey belongs to a different Login account.');
  if (!r.prf) {
    await markNoPrf(credentialId);
    return 'no-prf';
  }
  await connectWith(me, credentialId, r.prf);
  return 'connected';
}

export async function removePasskey(me: Me, credentialId: string): Promise<void> {
  try {
    await api('DELETE', `/api/passkeys/${encodeURIComponent(credentialId)}`);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'reauth-required') throw err;
    const r = await passkeySignIn();
    if (r.userId !== me.userId) throw new Error('That passkey belongs to a different Login account.');
    await api('DELETE', `/api/passkeys/${encodeURIComponent(credentialId)}`);
  }
  await syncPasskeysWithPasswordManager(await api<Me>('GET', '/api/me'));
}

/**
 * Tell the browser's password manager which of this user's passkeys are still
 * valid, so removed ones stop being offered. Supported in recent Chrome and
 * Safari; silently skipped elsewhere. Sends nothing to our server.
 */
export async function syncPasskeysWithPasswordManager(me: Me): Promise<void> {
  const signal = (
    PublicKeyCredential as unknown as {
      signalAllAcceptedCredentials?: (o: {
        rpId: string;
        userId: string;
        allAcceptedCredentialIds: string[];
      }) => Promise<void>;
    }
  ).signalAllAcceptedCredentials;
  if (!signal || me.credentials.length === 0) return;
  await signal
    .call(PublicKeyCredential, {
      rpId: location.hostname,
      userId: me.webauthnUserId,
      allAcceptedCredentialIds: me.credentials.map((c) => c.id),
    })
    .catch(() => {});
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
