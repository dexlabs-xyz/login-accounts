/**
 * Wallet vault: keeps the user's root secret encrypted so that only their
 * passkeys can open it. Runs in the browser (and in Node for tests).
 *
 * Design (docs/design/passkeys.md, decision D1):
 *
 *   passkey ──PRF(PRF_INPUT)──► prfOutput ──HKDF-SHA256──► wrapping key (one per passkey)
 *   wrapping key ──AES-GCM unwrap──► data key (one per account)
 *   data key ──AES-GCM decrypt──► root secret (32 random bytes, made on device)
 *
 * The root secret is the entropy of the recovery phrase that the Railgun
 * wallet and edge addresses will be derived from. It never leaves the device
 * unencrypted. Only the encrypted vault and the wrapped data keys go to the
 * server, which cannot open them.
 *
 * No homemade cryptography: only WebCrypto's standard HKDF and AES-GCM.
 * Additional authenticated data (AAD) binds every ciphertext to its user and
 * passkey, so a blob swapped in from another account fails to decrypt.
 */

export const VAULT_VERSION = 1;

/** Bytes backed by a plain ArrayBuffer, as WebCrypto requires. */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Fixed input to the WebAuthn PRF extension. Changing it changes every
 * user's wrapping key, so it is versioned and must never be edited in place.
 */
export const PRF_INPUT: Bytes = new TextEncoder().encode('withlogin.com/prf/wallet/v1');

const HKDF_SALT = new TextEncoder().encode('withlogin.com/vault/hkdf/v1');
const ROOT_SECRET_BYTES = 32;
const IV_BYTES = 12;

/** Encrypted root secret. Safe to store on the server. */
export interface EncryptedVault {
  v: number;
  iv: string; // base64url
  ct: string; // base64url
}

/** The data key, wrapped by one passkey's wrapping key. Safe to store on the server. */
export interface WrappedKey {
  v: number;
  iv: string;
  ct: string;
}

export class VaultError extends Error {
  constructor(
    readonly code: 'bad-prf' | 'unsupported-version' | 'decrypt-failed',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

/** An opened vault. Lives in memory only; never persist this object. */
export interface OpenVault {
  rootSecret: Bytes;
  /** Kept so another passkey can be added without re-entering anything. */
  dataKey: CryptoKey;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

const enc = (s: string) => new TextEncoder().encode(s);
const vaultAad = (userId: string) => enc(`withlogin.com/vault/v${VAULT_VERSION}/user:${userId}`);
const wrapAad = (userId: string, credentialId: string) =>
  enc(`withlogin.com/wrap/v${VAULT_VERSION}/user:${userId}/cred:${credentialId}`);

async function deriveWrappingKey(prfOutput: Bytes, credentialId: string): Promise<CryptoKey> {
  if (prfOutput.byteLength !== 32) {
    throw new VaultError('bad-prf', 'Passkey did not return a valid PRF result.');
  }
  const ikm = await subtle().importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc(`wrap:${credentialId}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Wrap the data key for one more passkey (sign-up, or "add a passkey"). */
export async function wrapForPasskey(
  dataKey: CryptoKey,
  prfOutput: Bytes,
  userId: string,
  credentialId: string,
): Promise<WrappedKey> {
  const wrappingKey = await deriveWrappingKey(prfOutput, credentialId);
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().wrapKey('raw', dataKey, wrappingKey, {
    name: 'AES-GCM',
    iv,
    additionalData: wrapAad(userId, credentialId),
  });
  return { v: VAULT_VERSION, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) };
}

/**
 * Create a brand-new vault on this device. Returns the open vault (memory
 * only) and the encrypted pieces to upload.
 */
export async function createVault(
  prfOutput: Bytes,
  userId: string,
  credentialId: string,
): Promise<{ open: OpenVault; vault: EncryptedVault; wrapped: WrappedKey }> {
  const rootSecret = randomBytes(ROOT_SECRET_BYTES);
  // Extractable only so it can be wrapped for additional passkeys.
  const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: vaultAad(userId) },
    dataKey,
    rootSecret,
  );
  const wrapped = await wrapForPasskey(dataKey, prfOutput, userId, credentialId);
  return {
    open: { rootSecret, dataKey },
    vault: { v: VAULT_VERSION, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) },
    wrapped,
  };
}

/** Open the vault with one passkey's PRF output. Fails closed on any mismatch. */
export async function openVault(
  prfOutput: Bytes,
  userId: string,
  credentialId: string,
  wrapped: WrappedKey,
  vault: EncryptedVault,
): Promise<OpenVault> {
  if (wrapped.v !== VAULT_VERSION || vault.v !== VAULT_VERSION) {
    throw new VaultError('unsupported-version', 'This wallet was saved in a format this app does not know.');
  }
  const wrappingKey = await deriveWrappingKey(prfOutput, credentialId);
  let dataKey: CryptoKey;
  let plain: ArrayBuffer;
  try {
    dataKey = await subtle().unwrapKey(
      'raw',
      fromB64u(wrapped.ct),
      wrappingKey,
      { name: 'AES-GCM', iv: fromB64u(wrapped.iv), additionalData: wrapAad(userId, credentialId) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64u(vault.iv), additionalData: vaultAad(userId) },
      dataKey,
      fromB64u(vault.ct),
    );
  } catch {
    // Never include key material or ciphertext in the error.
    throw new VaultError('decrypt-failed', 'This passkey could not open the wallet.');
  }
  return { rootSecret: new Uint8Array(plain), dataKey };
}

/** Best-effort wipe when locking. JS can't guarantee memory is cleared. */
export function closeVault(open: OpenVault | null): void {
  open?.rootSecret.fill(0);
}

/**
 * Labels for keys derived from the root secret. Each use gets its own label so
 * no two features ever share a key. Never reuse or edit a label; add a new one.
 */
export const DERIVED_KEY_LABELS = {
  /** Encrypts the Railgun SDK's local wallet database (IndexedDB) on this device. */
  railgunDbKey: 'withlogin.com/derive/railgun-db-key/v1',
  /** Encrypts this device's deposit records (which fresh addresses are in use). */
  depositRecordsKey: 'withlogin.com/derive/deposit-records-key/v1',
} as const;

const DERIVE_SALT = new TextEncoder().encode('withlogin.com/derive/hkdf/v1');

/**
 * Derive 32 bytes for one labelled purpose from the root secret (HKDF-SHA256,
 * WebCrypto). One-way: the result reveals nothing about the root secret or
 * about keys derived with other labels.
 */
export async function deriveKeyMaterial(
  rootSecret: Bytes,
  label: (typeof DERIVED_KEY_LABELS)[keyof typeof DERIVED_KEY_LABELS],
): Promise<Bytes> {
  if (rootSecret.byteLength !== ROOT_SECRET_BYTES) throw new Error('Root secret must be 32 bytes.');
  const ikm = await subtle().importKey('raw', rootSecret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: DERIVE_SALT, info: enc(label) }, ikm, 256);
  return new Uint8Array(bits);
}

/** Encrypted JSON for local storage, bound to a purpose by AAD. */
export interface SealedJson {
  v: number;
  iv: string;
  ct: string;
}

async function aesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error('Key must be 32 bytes.');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a JSON value with a 32-byte key (AES-GCM). `purpose` must match on open. */
export async function sealJson(key: Bytes, purpose: string, value: unknown): Promise<SealedJson> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc(`withlogin.com/sealed/v1/${purpose}`) },
    await aesKey(key),
    enc(JSON.stringify(value)),
  );
  return { v: 1, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) };
}

/** Decrypt a value from sealJson. Fails closed on a wrong key, purpose or tampering. */
export async function openJson<T>(key: Bytes, purpose: string, sealed: SealedJson): Promise<T> {
  if (sealed.v !== 1) throw new VaultError('unsupported-version', 'Unknown sealed format.');
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64u(sealed.iv), additionalData: enc(`withlogin.com/sealed/v1/${purpose}`) },
      await aesKey(key),
      fromB64u(sealed.ct),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new VaultError('decrypt-failed', 'Could not open stored data.');
  }
}

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
