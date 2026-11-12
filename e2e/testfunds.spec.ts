/**
 * Test funds, live on Sepolia (TESTNET ONLY): a new account claims 250 test
 * USDT (shielded straight from the pool's public balance), and we measure how
 * long until it's spendable. Needs TESTNET_POOL_MNEMONIC in .env.
 */
import { expect, test } from '@playwright/test';
import { Device, disableAutofill, signUp } from './helpers.ts';
import { log } from './live.ts';

test.describe.configure({ timeout: 180 * 60_000 });
const say = log('testfunds');

test('a new account claims 250 test USDT once; it becomes spendable', async ({ page }) => {
  await disableAutofill(page);
  page.on('console', (m) => m.type() === 'error' && /railgun/i.test(m.text()) && say(`console: ${m.text().slice(0, 300)}`));
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  // "Test USDT" on Home; every update about the top-up arrives as a toast (testfunds-status).
  const funds = page;
  const button = page.getByRole('button', { name: 'Test USDT', exact: true });
  await expect(button).toBeVisible({ timeout: 60_000 });

  // The pool may still be starting or waiting for its own privacy check: retry until it accepts.
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift'); // stay "active" (15-minute idle lock)
        if (await funds.getByTestId('testfunds-status').isVisible()) return true;
        if (await button.isEnabled().catch(() => false)) await button.click();
        await page.waitForTimeout(3_000);
        // Don't wait for an error that may never come (a successful claim shows none).
        const alert = funds.getByRole('alert');
        const err = (await alert.isVisible()) ? ((await alert.textContent({ timeout: 1_000 }).catch(() => '')) ?? '') : '';
        if (err) say(`+${Math.round((Date.now() - t0) / 1000)}s claim refused: ${err}`);
        return funds.getByTestId('testfunds-status').isVisible();
      },
      { timeout: 120 * 60_000, intervals: [60_000] },
    )
    .toBe(true);
  say(`claim accepted after ${Math.round((Date.now() - t0) / 1000)}s`);

  await expect(funds.getByTestId('testfunds-status')).toHaveText(/^Sent \$250 to your private balance/, { timeout: 10 * 60_000 });
  await expect(funds.getByTestId('testfunds-privacy')).toContainText('We see your private address only this once');
  say('sent');
  await button.click(); // once only: the button stays, pressing it again says so
  await expect(page.getByRole('status').filter({ hasText: 'You already claimed!' })).toBeVisible();

  // Measure: how long until a received private transfer is spendable (decides how instant this feels).
  const t1 = Date.now();
  let last = '';
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift');
        const t = (await card.innerText().catch(() => '')).replace(/\n+/g, ' | ');
        if (t !== last) say(`+${Math.round((Date.now() - t1) / 1000)}s card: ${(last = t).slice(-180)}`);
        return card.getByTestId('balance-Spendable-usdt').isVisible();
      },
      { timeout: 150 * 60_000, intervals: [30_000] },
    )
    .toBe(true);
  say(`spendable ${Math.round((Date.now() - t1) / 1000)}s after the claim was sent`);
  await expect(card.getByTestId('fee-reserve-ready')).toBeVisible({ timeout: 10 * 60_000 });
});
