/**
 * Railgun wallet on Sepolia, against live services (RPC, quick sync).
 * Slower and network-dependent, so kept separate from the passkey lab.
 * TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { Device, disableAutofill, recordSecrets, signUp } from './helpers.ts';

test.describe.configure({ timeout: 5 * 60_000 });

test.beforeEach(async ({ page }, info) => {
  await disableAutofill(page);
  page.on('pageerror', (e) => console.log('[pageerror]', e.name));
  // Log third-party network trouble, to diagnose sync stalls.
  const external = (u: string) => !/localhost|127\.0\.0\.1/.test(new URL(u).hostname);
  page.context().on('requestfailed', (r) => external(r.url()) && console.log(`[${info.title}] request failed: ${new URL(r.url()).hostname} ${r.failure()?.errorText}`));
  page.context().on('response', (r) => external(r.url()) && r.status() >= 400 && console.log(`[${info.title}] HTTP ${r.status()} from ${new URL(r.url()).hostname}`));
  page.on('console', (m) => m.type() === 'error' && /railgun/i.test(m.text()) && console.log(`[${info.title}] ${m.text().slice(0, 400)}`));
});

// On failure, show what the user would have seen in the wallet section.
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const card = page.getByRole('region', { name: /Private balance/ });
  console.log('[private balance at failure]', (await card.count()) ? (await card.innerText()).replace(/\n+/g, ' | ') : '(not shown)');
});

test('unlocking opens a Railgun wallet: 0zk address', async ({ page }) => {
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.locator('code.address')).toHaveText(/^0zk/, { timeout: 120_000 });
});

test('synced (empty) balance on Sepolia', async ({ page }) => {
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });
});

test('a stalled sync says so and recovers with Retry', async ({ page }) => {
  // Simulate an outage of Railgun's quick-sync service (applies to the worker too).
  await page.context().route('**/rail-squid.squids.live/**', (r) => r.abort('connectionrefused'));
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByText('Syncing is taking longer than usual')).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText('Your funds aren’t affected.')).toBeVisible();

  // Service back: Retry finishes the sync.
  await page.context().unroute('**/rail-squid.squids.live/**');
  await card.getByRole('button', { name: 'Retry sync' }).click();
  await expect(card.getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });
});

test('same passkey, same Railgun address after locking and unlocking', async ({ page }) => {
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  const address = card.locator('code.address');
  await expect(address).toHaveText(/^0zk/, { timeout: 120_000 });
  const first = await address.getAttribute('title');

  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(card).toHaveCount(0); // worker terminated, nothing shown while locked
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  await expect(address).toHaveText(/^0zk/, { timeout: 120_000 });
  expect(await address.getAttribute('title')).toBe(first);
});

test('no secret leaves the device with Railgun running (D6)', async ({ page }) => {
  const leaks = await recordSecrets(page);
  await Device.add(page);
  await signUp(page);
  await expect(page.getByRole('region', { name: /Private balance/ }).locator('code.address')).toHaveText(/^0zk/, {
    timeout: 120_000,
  });
  // Let the worker sync, and prove its traffic was captured (otherwise the check proves nothing).
  await expect.poll(() => leaks.hosts(), { timeout: 120_000 }).toContain('ethereum-sepolia-rpc.publicnode.com');
  await page.waitForTimeout(5_000);
  await leaks.assertNoLeaks();
});
