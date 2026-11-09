/** Shared setup for live Sepolia tests (send, withdraw). TESTNET ONLY. */
import { expect, type Page } from '@playwright/test';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { Device, disableAutofill, signUp } from './helpers.ts';

export const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const TIDEPOOL = 'https://www.usetidepool.tech';
export const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
export const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
export const provider = new JsonRpcProvider(RPC);

export const log = (tag: string) => (m: string) => console.log(`[${tag}] ${m}`);

export async function watch(page: Page, testId: string, until: RegExp, timeout: number, say: (m: string) => void) {
  let last = '';
  await expect
    .poll(async () => {
      // Short timeout: once the status is gone (e.g. back to the form on an error), don't hang.
      const t = (await page.getByTestId(testId).textContent({ timeout: 1_000 }).catch(() => '')) ?? '';
      if (t && t !== last) say(`${testId}: ${(last = t)}`);
      return t;
    }, { timeout, intervals: [3_000] })
    .toMatch(until);
}

/**
 * Signs up a new account and funds it with Login's own testnet pieces only
 * (Tidepool's faucet is no longer available through its API, 8 Nov 2026):
 * 1. the in-app test-funds claim (250 USDT + the hidden fee reserve);
 * 2. a deposit of 0.003 ETH from a throwaway wallet funded by Login's gas
 *    faucet, through "From an Ethereum wallet" (so the ETH path runs too).
 * Then waits until USDT and the fee reserve are Spendable. Returns the deposit
 * address (publicly linked to this account) and the wallet that funded it.
 */
export async function fundedAccount(page: Page, say: (m: string) => void) {
  await disableAutofill(page);
  page.on('console', (m) => m.type() === 'error' && /railgun/i.test(m.text()) && say(`console: ${m.text().slice(0, 400)}`));
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  const funds = page.getByRole('region', { name: /Test funds/ });
  // A freshly started local server needs a few minutes to open the pool ("still starting"): retry.
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift'); // stay "active" (15-minute idle lock)
        if (await funds.getByTestId('testfunds-status').isVisible()) return true;
        const button = funds.getByRole('button', { name: /^Get \d+ test USDT/ });
        if (await button.isEnabled().catch(() => false)) await button.click();
        await page.waitForTimeout(3_000);
        return funds.getByTestId('testfunds-status').isVisible();
      },
      { timeout: 30 * 60_000, intervals: [30_000] },
    )
    .toBe(true);
  await expect(funds.getByTestId('testfunds-status')).toHaveText(/^Sent /, { timeout: 10 * 60_000 });
  say('test funds sent');

  const funder = Wallet.createRandom().connect(provider); // throwaway, testnet only
  expect((await page.request.post('/api/testnet-gas', { data: { address: funder.address } })).ok()).toBe(true);
  await expect.poll(async () => (await provider.getBalance(funder.address)) >= parseEther('0.0035'), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  const depositTo = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();
  await (await funder.sendTransaction({ to: depositTo, value: parseEther('0.003') })).wait(1);
  await watch(page, 'active-deposit-status', /^Done\./, 20 * 60_000, say);

  // Measured on Sepolia, 5 Nov 2026: fresh shields took 52, 74 and over 90 minutes to clear.
  // The wallet locks after 15 minutes idle (D5), so act like a user who's still here,
  // and log each change to the balance card to measure how long the privacy check takes.
  const t0 = Date.now();
  let lastCard = '';
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift');
        const t = (await card.innerText().catch(() => '')).replace(/\n+/g, ' | ');
        if (t !== lastCard) say(`+${Math.round((Date.now() - t0) / 1000)}s card: ${(lastCard = t).slice(-200)}`);
        return card.getByTestId('balance-Spendable-usdt').isVisible();
      },
      { timeout: 150 * 60_000, intervals: [30_000] },
    )
    .toBe(true);
  await expect(card.getByTestId('fee-reserve-ready')).toBeVisible({ timeout: 10 * 60_000 });
  say(`spendable after ${Math.round((Date.now() - t0) / 1000)}s`);
  return { card, depositTo, funder: funder.address };
}
