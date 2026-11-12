/**
 * Two Login accounts in one browser: each must open its own private wallet,
 * even after the other has saved deposit records. TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { closeSheet, Device, disableAutofill, openSheet, signOut, signUp } from './helpers.ts';

test.describe.configure({ timeout: 6 * 60_000 });

test('a second account in the same browser loads its wallet', async ({ page }) => {
  await disableAutofill(page);
  await Device.add(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  const addMoney = page.getByRole('region', { name: /Add money/ });

  // Account A saves a deposit record (an Ethereum deposit address).
  await signUp(page);
  await expect(card.getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });
  await openSheet(page, 'Receive');
  await addMoney.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  await expect(addMoney.locator('code.address').first()).toHaveText(/^0x/, { timeout: 60_000 });
  await closeSheet(page);
  await signOut(page);
  await page.goto('/'); // back to Home for account B

  // Account B, same browser.
  await signUp(page);
  await expect(card.getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });
  await expect(page.getByText('Couldn’t load your private balance')).toHaveCount(0);
});
