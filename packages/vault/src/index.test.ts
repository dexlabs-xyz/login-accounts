import { describe, expect, it } from 'vitest';
import { closeVault, createVault, openVault, wrapForPasskey, VaultError } from './index.ts';

// Stand-ins for what two different passkeys' PRF extension would return.
const prfA = () => new Uint8Array(32).fill(1);
const prfB = () => new Uint8Array(32).fill(2);
const USER = 'user-1';
const CRED_A = 'cred-a';
const CRED_B = 'cred-b';

describe('vault', () => {
  it('round-trips: the passkey that created the vault can open it', async () => {
    const { open, vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    const reopened = await openVault(prfA(), USER, CRED_A, wrapped, vault);
    expect(reopened.rootSecret).toEqual(open.rootSecret);
    expect(open.rootSecret.byteLength).toBe(32);
  });

  it('never puts the root secret in what gets uploaded', async () => {
    const { open, vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    const uploaded = JSON.stringify({ vault, wrapped });
    const hex = Buffer.from(open.rootSecret).toString('hex');
    const b64 = Buffer.from(open.rootSecret).toString('base64url');
    expect(uploaded).not.toContain(hex);
    expect(uploaded).not.toContain(b64);
  });

  it('a second passkey opens the same vault on its own (D1)', async () => {
    const { open, vault } = await createVault(prfA(), USER, CRED_A);
    const wrappedB = await wrapForPasskey(open.dataKey, prfB(), USER, CRED_B);
    const viaB = await openVault(prfB(), USER, CRED_B, wrappedB, vault);
    expect(viaB.rootSecret).toEqual(open.rootSecret);
  });

  it('rejects the wrong passkey', async () => {
    const { vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    await expect(openVault(prfB(), USER, CRED_A, wrapped, vault)).rejects.toMatchObject({
      code: 'decrypt-failed',
    });
  });

  it("rejects one passkey's wrapped key presented as another passkey's", async () => {
    const { vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    await expect(openVault(prfA(), USER, CRED_B, wrapped, vault)).rejects.toBeInstanceOf(VaultError);
  });

  it("rejects another user's vault, even with a matching passkey (server mix-up or swap)", async () => {
    const mine = await createVault(prfA(), USER, CRED_A);
    const theirs = await createVault(prfA(), 'user-2', CRED_A);
    await expect(openVault(prfA(), USER, CRED_A, mine.wrapped, theirs.vault)).rejects.toMatchObject({
      code: 'decrypt-failed',
    });
  });

  it('fails closed on tampered ciphertext', async () => {
    const { vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    const flipped = vault.ct.startsWith('A') ? 'B' + vault.ct.slice(1) : 'A' + vault.ct.slice(1);
    await expect(openVault(prfA(), USER, CRED_A, wrapped, { ...vault, ct: flipped })).rejects.toMatchObject({
      code: 'decrypt-failed',
    });
  });

  it('refuses unknown format versions instead of guessing', async () => {
    const { vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    await expect(openVault(prfA(), USER, CRED_A, wrapped, { ...vault, v: 2 })).rejects.toMatchObject({
      code: 'unsupported-version',
    });
  });

  it('rejects a missing or malformed PRF result', async () => {
    await expect(createVault(new Uint8Array(0), USER, CRED_A)).rejects.toMatchObject({ code: 'bad-prf' });
  });

  it('error messages contain no key material', async () => {
    const { vault, wrapped } = await createVault(prfA(), USER, CRED_A);
    const err = (await openVault(prfB(), USER, CRED_A, wrapped, vault).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(vault.ct);
    expect(err.message).not.toContain(wrapped.ct);
  });

  it('closeVault zeroes the in-memory secret', async () => {
    const { open } = await createVault(prfA(), USER, CRED_A);
    closeVault(open);
    expect(open.rootSecret.every((b) => b === 0)).toBe(true);
  });
});
