/**
 * Withdraw as another token or chain: private USDT is withdrawn straight to a
 * Tidepool (NEAR Intents testnet) swap address, and the chosen token arrives at
 * the user's address. Live: real broadcaster, real Tidepool swaps. Slow
 * (deposit + privacy check + proofs). TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { ERC20, fundedAccount, log, provider, watch } from './live.ts';

test.describe.configure({ timeout: 420 * 60_000 });
const say = log('withdraw-swap');

/** Tidepool's test USDC on Base Sepolia (from its token list, 9 Nov 2026). */
const BASE_USDC = '0x38d81431B9f76d9699AF7517040D5221D9dEA252';
const base = new JsonRpcProvider('https://base-sepolia-rpc.publicnode.com');
/** A valid Solana address (testnet only). The container can't reach Solana devnet, so only Tidepool's status is checked. */
const SOL_RECIPIENT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

test('withdraws as ETH on Sepolia, USDC on Base and USDC on Solana; refuses ETH over Tidepool’s cap', async ({ page }) => {
  const { funder } = await fundedAccount(page, say);
  const panel = page.getByRole('region', { name: /^Withdraw/ });
  const receiveAs = panel.getByTestId('withdraw-receive-as');
  const amount = panel.getByLabel('Amount (USDT)');
  const toField = panel.getByLabel(/^To \(/);
  await expect(receiveAs.locator('option')).toHaveCount(6, { timeout: 60_000 }); // USDT + the five agreed

  /**
   * After a withdrawal, the leftover ("change") waits for its own privacy check
   * before it can be spent again. Wait for enough Spendable USDT, and log how long.
   * Pressing Shift keeps the wallet from idle-locking (15 minutes, D5), like a user who's still here.
   */
  const waitSpendable = async (usdt: string) => {
    const t0 = Date.now();
    await expect
      .poll(async () => (await page.keyboard.press('Shift'), Number(/Spendable now: ([\d.]+) USDT/.exec((await panel.textContent({ timeout: 1_000 }).catch(() => '')) ?? '')?.[1] ?? 0)), {
        timeout: 150 * 60_000,
        intervals: [15_000],
      })
      .toBeGreaterThanOrEqual(Number(usdt));
    say(`spendable ≥ ${usdt} USDT after ${Math.round((Date.now() - t0) / 60_000)} min`);
  };

  const withdraw = async (option: RegExp, to: string, usdt: string) => {
    await waitSpendable(usdt);
    await receiveAs.selectOption({ label: (await receiveAs.locator('option').allTextContents()).find((t) => option.test(t))! });
    await toField.fill(to);
    await amount.fill(usdt);
    // A relay may refuse (its privacy-check node can't confirm our funds yet). The app
    // skips it and asks the user to review again, which picks another relay. Do the same.
    for (let attempt = 1; ; attempt++) {
      await panel.getByRole('button', { name: 'Review' }).click();
      await expect(panel.getByTestId('withdraw-swap-receives')).toBeVisible({ timeout: 180_000 });
      say(`review: ${(await panel.innerText()).replace(/\n+/g, ' | ').slice(0, 600)}`);
      await panel.getByRole('button', { name: 'Confirm with passkey' }).click();
      await expect(panel.getByTestId('unshield-status').or(panel.getByRole('alert'))).toBeVisible();
      const outcome = await expect
        .poll(
          async () =>
            (await panel.getByRole('alert').isVisible())
              ? `alert: ${await panel.getByRole('alert').textContent({ timeout: 1_000 }).catch(() => '')}`
              : ((await panel.getByTestId('unshield-status').textContent({ timeout: 1_000 }).catch(() => '')) ?? ''),
          { timeout: 20 * 60_000, intervals: [3_000] },
        )
        .toMatch(/^(alert: |Withdrew )/)
        .then(() => panel.getByRole('alert').isVisible());
      if (!outcome) break;
      const alert = (await panel.getByRole('alert').textContent()) ?? '';
      say(`attempt ${attempt}: ${alert}`);
      if (!/network relay couldn’t confirm/.test(alert) || attempt >= 4) throw new Error(`Withdrawal failed: ${alert}`);
    }
    await watch(page, 'unshield-status', /^Done: about /, 20 * 60_000, say);
    await panel.getByRole('button', { name: 'Withdraw again' }).click();
  };

  // ETH on Sepolia: over Tidepool's 0.006 ETH cap is refused before anything is sent.
  await receiveAs.selectOption({ label: 'ETH on Ethereum Sepolia (swapped through NEAR Intents)' });
  await toField.fill(Wallet.createRandom().address);
  await amount.fill('50');
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(panel.getByRole('alert')).toContainText('at most 0.006 ETH', { timeout: 120_000 });

  // The funding wallet is still flagged when the swap delivers to it (same address, same owner).
  await toField.fill(funder);
  await amount.fill('1');
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(panel.getByTestId('withdraw-linked-warning')).toBeVisible({ timeout: 180_000 });
  await panel.getByRole('button', { name: 'Back' }).click();

  const ethTo = Wallet.createRandom().address; // throwaway, testnet only
  await withdraw(/^ETH on Ethereum Sepolia/, ethTo, '3');
  await expect.poll(() => provider.getBalance(ethTo), { timeout: 5 * 60_000, intervals: [5_000] }).toBeGreaterThan(0n);
  say(`ETH arrived: ${await provider.getBalance(ethTo)} wei`);

  const baseTo = Wallet.createRandom().address;
  await withdraw(/^USDC on Base Sepolia/, baseTo, '3');
  const usdc = new Contract(BASE_USDC, ERC20, base);
  await expect.poll(async () => (await usdc.balanceOf!(baseTo)) as bigint, { timeout: 5 * 60_000, intervals: [5_000] }).toBeGreaterThan(2_900_000n);
  say(`Base USDC arrived: ${await usdc.balanceOf!(baseTo)}`);

  await withdraw(/^USDC on Solana devnet/, SOL_RECIPIENT, '2');
});
