/**
 * Passkey edge cases. Each test names the design decision it checks
 * (docs/design/passkeys.md).
 */
import { expect, test } from '@playwright/test';
import { Device, disableAutofill, freshEmail, latestCode, recordSecrets, recordWebAuthnCalls, signOut, signUp, verifyEmail, walletCheck } from './helpers.ts';

// Chrome's virtual authenticator answers autofill requests instantly, which a
// real user never does. Keep autofill off except where a test turns it on.
test.beforeEach(async ({ page }) => {
  await disableAutofill(page);
});

test.describe('sign-up', () => {
  test('happy path: synced passkey with PRF creates and opens a wallet (D1, D3)', async ({ page }) => {
    await Device.add(page, { prf: true, synced: true });
    await signUp(page);
    await expect(page.getByText('Unlocked')).toBeVisible();
    await expect(page.getByText('Synced passkey')).toBeVisible();
    await expect(page.getByText('You could lose access')).toHaveCount(0);
  });

  test('device-only passkey shows the lose-your-money warning (D4)', async ({ page }) => {
    await Device.add(page, { prf: true, synced: false });
    await signUp(page);
    await expect(page.getByText('Device-only passkey')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'You could lose access to your money' })).toBeVisible();
  });

  test('no PRF: account works for sign-in, wallet is clearly unavailable here (D7)', async ({ page }) => {
    await Device.add(page, { prf: false });
    await signUp(page);
    await expect(page.getByText('this device can’t open your Login wallet')).toBeVisible();
    await expect(page.getByText('No wallet yet.')).toBeVisible();
  });

  test('user cancels Face ID / fingerprint: nothing is created, clear message', async ({ page }) => {
    const device = await Device.add(page);
    await device.setUserVerified(false);
    await verifyEmail(page, freshEmail());
    await expect(page.getByRole('alert')).toContainText(/closed or timed out|couldn’t be checked/);
    expect(await device.credentials()).toHaveLength(0);
  });

  test('email that already has an account is sent to passkey sign-in (D2)', async ({ page }) => {
    await Device.add(page);
    const email = await signUp(page);
    await signOut(page);
    await verifyEmail(page, email);
    await expect(page.getByText('You already have an account. Sign in with your passkey.')).toBeVisible();
  });

  test('wrong email code shows tries left', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill(freshEmail());
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toContainText(/tries left|isn’t right/);
  });
});

test.describe('sign-in and unlock', () => {
  test('sign out, sign back in: same wallet opens (D5)', async ({ page }) => {
    await Device.add(page);
    await signUp(page);
    const before = await walletCheck(page);
    await signOut(page);
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(page.getByText('Unlocked')).toBeVisible();
    expect(await walletCheck(page)).toBe(before);
  });

  test('refreshing the page locks the wallet; passkey unlocks it (D5)', async ({ page }) => {
    await Device.add(page);
    await signUp(page);
    const before = await walletCheck(page);
    await page.reload();
    await expect(page.getByText('Locked')).toBeVisible();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    expect(await walletCheck(page)).toBe(before);
  });

  test('passkey deleted from the device: sign-in fails with a clear message', async ({ page }) => {
    const device = await Device.add(page);
    await signUp(page);
    await signOut(page);
    await device.forgetAll();
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText('closed or timed out');
  });
});

test('returning user signs in from the email field autofill (D2)', async ({ page }) => {
  await Device.add(page);
  await signUp(page);
  const before = await walletCheck(page);
  await signOut(page);
  // Turn autofill on for this tab: the passkey is offered in the email field.
  await page.evaluate(() => sessionStorage.setItem('e2e-autofill', 'on'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByText('Unlocked')).toBeVisible();
  expect(await walletCheck(page)).toBe(before);
});

test.describe('multiple passkeys (D1, D4)', () => {
  test('a second passkey on another device opens the same wallet on its own', async ({ page }) => {
    const laptop = await Device.add(page, { synced: false });
    await signUp(page);
    const before = await walletCheck(page);
    await expect(page.getByText('You could lose access')).toBeVisible();

    // Add a synced phone passkey while the wallet is open.
    await laptop.remove();
    const phone = await Device.add(page, { synced: true, transport: 'usb' });
    await page.getByRole('button', { name: 'Add your phone' }).click();
    await expect(page.getByText('This passkey can now open your wallet on its own.')).toBeVisible();
    await expect(page.getByText('You could lose access')).toHaveCount(0);
    expect(await phone.credentials()).toHaveLength(1);

    // Laptop is gone. The phone alone opens the same wallet.
    await signOut(page);
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(page.getByText('Unlocked')).toBeVisible();
    expect(await walletCheck(page)).toBe(before);
  });

  test('cannot remove the only passkey that opens the wallet', async ({ page }) => {
    const laptop = await Device.add(page);
    await signUp(page);
    await laptop.remove();
    await Device.add(page, { prf: false }); // sign-in only passkey
    await page.getByRole('button', { name: 'Other options' }).click();
    await page.getByRole('button', { name: 'Keep for signing in' }).click();

    const walletRow = page.getByRole('listitem').filter({ hasText: 'opens wallet' });
    await walletRow.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('alert')).toContainText('only passkey that can open your wallet');
  });

  test('a passkey whose storage has no PRF is explained, and can be kept or removed (Brave case)', async ({ page }) => {
    const laptop = await Device.add(page);
    await signUp(page);
    await laptop.remove();
    const brave = await Device.add(page, { prf: false, synced: false });
    await page.getByRole('button', { name: 'Other options' }).click();

    const panel = page.getByRole('alert', { name: 'Sign-in only passkey' });
    await expect(panel).toContainText('not a backup for your money');
    await panel.getByRole('button', { name: 'Remove it' }).click();
    await expect(page.getByText('Removed.')).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    // The password manager was told it's no longer valid, so the browser removed it too.
    await expect.poll(async () => (await brave.credentials()).length).toBe(0);

    // Keep path: label says why, and there's no Connect button.
    await page.getByRole('button', { name: 'Other options' }).click();
    await page.getByRole('button', { name: 'Keep for signing in' }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'can’t open wallets' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Connect' })).toHaveCount(0);
  });

  test('removing the sign-in-only passkey from the list also closes its keep/remove panel', async ({ page }) => {
    const laptop = await Device.add(page);
    await signUp(page);
    await laptop.remove();
    await Device.add(page, { prf: false, synced: false });
    await page.getByRole('button', { name: 'Other options' }).click();
    const panel = page.getByRole('alert', { name: 'Sign-in only passkey' });
    await expect(panel).toBeVisible();

    await page.getByRole('listitem').filter({ hasText: 'can’t open wallets' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0); // no stale error either
  });

  test('a passkey added while the wallet was locked can be connected later, then opens the wallet alone', async ({ page }) => {
    const laptop = await Device.add(page);
    await signUp(page);
    const before = await walletCheck(page);
    await page.getByRole('button', { name: 'Lock' }).click();

    const phone = await Device.add(page, { synced: true, transport: 'usb' });
    await laptop.setResponds(false); // the user registers on the phone
    await page.getByRole('button', { name: 'Add your phone' }).click();
    await laptop.setResponds(true);
    await expect(page.getByText('press “Connect” next to it')).toBeVisible();
    const phoneRow = page.getByRole('listitem').filter({ hasText: 'not connected to your wallet yet' });
    await expect(phoneRow.getByRole('button', { name: 'Connect' })).toBeDisabled();

    // Unlock with the laptop (the passkey that opens the wallet)...
    await phone.setResponds(false);
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByText('Unlocked')).toBeVisible();
    // ...then connect the phone, using the phone.
    await laptop.setResponds(false);
    await phone.setResponds(true);
    await phoneRow.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('This passkey can now open your wallet on its own.')).toBeVisible();

    // Laptop gone: the phone alone opens the same wallet.
    await laptop.remove();
    await page.reload();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByText('Unlocked')).toBeVisible();
    expect(await walletCheck(page)).toBe(before);
    expect(await phone.credentials()).toHaveLength(1);
  });
});

test.describe('choosing where a backup passkey goes', () => {
  test('each button asks the browser for the right kind of device', async ({ page }) => {
    const calls = await recordWebAuthnCalls(page);
    await Device.add(page);
    await signUp(page);
    await Device.add(page, { transport: 'usb' });

    const expected: [string, string[] | undefined, string | undefined][] = [
      ['Add your phone', ['hybrid'], 'cross-platform'],
      ['Add a security key', ['security-key'], 'cross-platform'],
    ];
    for (const [button, hints, attachment] of expected) {
      const before = (await calls.creates()).length;
      await page.getByRole('button', { name: button }).click();
      await expect.poll(async () => (await calls.creates()).length).toBe(before + 1);
      await expect(page.getByRole('button', { name: button })).toBeEnabled();
      const last = (await calls.creates()).at(-1)!;
      expect(last.hints, button).toEqual(hints);
      expect(last.attachment, button).toBe(attachment);
    }
    // Sign-up leaves the choice to the browser: no hints, no device restriction.
    const signUpCall = (await calls.creates())[0]!;
    expect(signUpCall.hints ?? []).toEqual([]);
    expect(signUpCall.attachment).toBeUndefined();
  });

  test('removing a passkey tells the password manager which passkeys are still valid', async ({ page }) => {
    const calls = await recordWebAuthnCalls(page);
    const laptop = await Device.add(page);
    await signUp(page);
    await laptop.setResponds(false);
    const key = await Device.add(page, { transport: 'usb' });
    await page.getByRole('button', { name: 'Add a security key' }).click();
    await expect(page.getByText('This passkey can now open your wallet on its own.')).toBeVisible();
    await laptop.setResponds(true);
    const [keyCred] = await key.credentials();

    // The security key is the second passkey in the list.
    await page.getByRole('listitem').nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);

    await expect.poll(async () => (await calls.signals()).length).toBeGreaterThan(0);
    const last = (await calls.signals()).at(-1)!;
    expect(last.rpId).toBe('localhost');
    expect(last.allAcceptedCredentialIds).toHaveLength(1);
    expect(last.allAcceptedCredentialIds).not.toContain(keyCred!.credentialId);
  });
});

test.describe('sign-in handoff for apps (OIDC contract)', () => {
  const complete = (id: string) => new RegExp(`/oidc/interaction/${id}/complete$`);

  const uses = async (d: Device) => (await d.credentials())[0]!.signCount;

  test('already signed in: goes straight back to OIDC with no prompt', async ({ page }) => {
    const device = await Device.add(page);
    await signUp(page);
    const before = await uses(device);
    await page.goto('/signin?interaction=abc123');
    await page.waitForURL(complete('abc123'));
    expect(await uses(device)).toBe(before); // the passkey wasn't used
  });

  test('signed out: passkey sign-in, then back to OIDC', async ({ page }) => {
    await Device.add(page);
    await signUp(page);
    await signOut(page);
    await page.goto('/signin?interaction=abc123');
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await page.waitForURL(complete('abc123'));
  });

  test('new user: signs up inside the handoff, then back to OIDC', async ({ page }) => {
    await Device.add(page);
    const email = freshEmail();
    await page.goto('/signin?interaction=new_user-1');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill(await latestCode(page, email));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(complete('new_user-1'));
  });

  test('fresh=1 demands a passkey even when signed in', async ({ page }) => {
    const device = await Device.add(page);
    await signUp(page);
    const before = await uses(device);
    await page.goto('/signin?interaction=abc123&fresh=1');
    await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await page.waitForURL(complete('abc123'));
    expect(await uses(device)).toBeGreaterThan(before); // the passkey was used
  });

  test('cancel returns a defined result', async ({ page }) => {
    await page.goto('/signin?interaction=abc123');
    await page.getByRole('button', { name: 'Cancel and go back to the app' }).click();
    await page.waitForURL(/\/oidc\/interaction\/abc123\/abort\?reason=cancelled$/);
  });

  for (const bad of ['', 'https://evil.example', '..%2F..%2Fevil', 'a/b', '%2F%2Fevil.example', 'x'.repeat(129)]) {
    test(`refuses to redirect for interaction=${JSON.stringify(bad.slice(0, 24))}`, async ({ page }) => {
      await page.goto(`/signin?interaction=${bad}`);
      await expect(page.getByRole('heading', { name: 'This sign-in link doesn’t work' })).toBeVisible();
      await page.waitForTimeout(300);
      expect(new URL(page.url()).pathname).toBe('/signin');
    });
  }
});

test('no secret ever leaves the device or lands in storage (D6)', async ({ page }) => {
  const leaks = await recordSecrets(page);
  await Device.add(page);
  await signUp(page);
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByText('Unlocked')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm a test send' }).click();
  await expect(page.getByText('Confirmed with your passkey')).toBeVisible();
  await leaks.assertNoLeaks();
});
