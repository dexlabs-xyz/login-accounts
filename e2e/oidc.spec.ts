/** Run against npm run dev:oidc. Uses Chrome virtual passkeys against the real shared server. */
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { Device } from './helpers.ts';
// Protocol tokens and test email codes must not be written into browser traces.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(90_000);
test('passkey sign-in to OIDC: consent, pairwise IDs, fresh authentication and logout', async ({
  page,
}) => {
  // This device cannot open wallets: OIDC must work without wallet access.
  const device = await Device.add(page, { prf: false });
  // Exercise the explicit passkey button. Conditional autofill is owned/tested
  // by passkeys and can race the explicit virtual-device ceremony in Chromium.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
  let passkeyChecks = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/login/verify') passkeyChecks++;
  });
  const email = `oidc-${Date.now()}@example.com`;
  await page.goto('http://localhost:5190');
  await page.getByRole('link', { name: 'Continue with Login', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const outbox = await (await page.request.get('http://localhost:5180/api/dev/outbox')).json();
  const code = outbox.emails
    .find((entry: { to: string; subject: string }) => entry.to === email)
    ?.subject.match(/\d{6}/)?.[0];
  assert.ok(code);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByRole('button', { name: 'Allow and continue' }).click();
  await page.getByRole('heading', { name: 'Signed in to the chess demo' }).waitFor();
  const first = await page.locator('code').textContent();
  assert.ok((await page.textContent('body'))?.includes('Verified human: Not provided'));
  await page.getByRole('link', { name: 'Try another flow' }).click();
  await page.getByRole('link', { name: 'Try a second app' }).click();
  await page.getByRole('button', { name: 'Allow and continue' }).click();
  await page.getByRole('heading', { name: 'Signed in to the second demo app' }).waitFor();
  assert.ok(first !== (await page.locator('code').textContent()));
  await page.getByRole('link', { name: 'Try another flow' }).click();
  await page.getByRole('link', { name: 'Continue with Login', exact: true }).click();
  await page.getByRole('heading', { name: 'Signed in to the chess demo' }).waitFor();
  assert.ok(first === (await page.locator('code').textContent()));
  await page.getByRole('link', { name: 'Try another flow' }).click();
  // Hold the virtual device until the fresh-check screen is observable.
  await device.setResponds(false);
  const checksBeforeFresh = passkeyChecks;
  await page.getByRole('link', { name: 'Require a fresh sign-in' }).click();
  await page.getByRole('heading', { name: 'Confirm it’s you' }).waitFor();
  await device.setResponds(true);
  await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  await page.getByRole('heading', { name: 'Signed in to the chess demo' }).waitFor();
  assert.ok(passkeyChecks > checksBeforeFresh);
  // Real logout must invalidate the shared session used by OIDC.
  await device.setResponds(false);
  await page.request.post('http://localhost:5180/api/logout', { data: {} });
  await page.goto('http://localhost:5190');
  await page.getByRole('link', { name: 'Continue with Login', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor();
  await page.getByRole('button', { name: 'Cancel and go back to the app' }).click();
  await page.getByRole('heading', { name: 'Sign-in did not complete' }).waitFor();
  console.log(
    'Browser checks passed: real passkey signup without wallet access, validated OIDC sign-in, per-app IDs, consent, fresh passkey authentication, logout and cancellation.',
  );
});
