/**
 * D6 with KYC on: open the real Sumsub sandbox flow (its SDK loads and runs in
 * the account page, next to the unlocked wallet) and check that no secret
 * left the device in any request, to Sumsub or anywhere else.
 * Needs Sumsub sandbox keys in .env (KYC on).
 */
import { expect, test } from '@playwright/test';
import { Device, disableAutofill, recordSecrets, signUp, goTo } from './helpers.ts';

test.describe.configure({ timeout: 10 * 60_000 });

test('no secret leaves the device while the Sumsub KYC flow runs (D6)', async ({ page }) => {
  await disableAutofill(page);
  const leaks = await recordSecrets(page);
  await Device.add(page);
  await signUp(page);
  await expect(page.getByRole('region', { name: /Private balance/ }).getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });

  await goTo(page, 'Verification');
  const kyc = page.getByRole('region', { name: 'Verification' });
  await expect(kyc.getByRole('note')).toContainText('aren’t real identity checks', { timeout: 30_000 }); // KYC is on (sandbox)
  // Gold's Figma: each level is a row; Verify opens a pop-up that explains the check, then Continue loads Sumsub.
  await kyc.locator('[data-level="L1"]').getByRole('button', { name: 'Verify', exact: true }).click();
  const sumsub = page.waitForRequest((r) => /sumsub\.com/.test(new URL(r.url()).hostname), { timeout: 60_000 });
  await page.getByRole('dialog', { name: 'Verify you’re human' }).getByRole('button', { name: 'Continue' }).click();
  await sumsub; // the SDK is loaded and talking to Sumsub
  await page.waitForTimeout(15_000); // let it settle and make its usual calls

  const hosts = leaks.hosts();
  console.log(`[kyc-leak] hosts contacted: ${hosts.join(', ')}`);
  expect(hosts.some((h) => h.endsWith('sumsub.com'))).toBe(true);
  await leaks.assertNoLeaks();
});
