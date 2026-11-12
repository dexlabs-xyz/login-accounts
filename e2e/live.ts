/** Shared setup for live Sepolia tests (send, withdraw). TESTNET ONLY. */
import { expect, type Page } from '@playwright/test';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { closeSheet, Device, disableAutofill, openSheet, signUp } from './helpers.ts';

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
  page.on('console', (m) => (m.type() === 'error' && /railgun/i.test(m.text())) || m.text().startsWith('[railgun POI]') ? say(`console: ${m.text().slice(0, 400)}`) : undefined);
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toHaveText('No private funds yet.', { timeout: 240_000 });

  // "Test USDT" on Home; its updates arrive as toasts (testfunds-status).
  const funds = page;
  // A freshly started local server needs a few minutes to open the pool ("still starting"): retry.
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift'); // stay "active" (15-minute idle lock)
        if (await funds.getByTestId('testfunds-status').isVisible()) return true;
        const button = page.getByRole('button', { name: 'Test USDT', exact: true });
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
  const gas = await page.request.post('/api/testnet-gas', { data: { address: funder.address } });
  if (!gas.ok()) say(`gas faucet refused: HTTP ${gas.status()} ${(await gas.text()).slice(0, 200)}`);
  expect(gas.ok()).toBe(true);
  await expect.poll(async () => (await provider.getBalance(funder.address)) >= parseEther('0.0035'), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  await openSheet(page, 'Receive'); // Add money sits in the Receive pop-up until it's redesigned
  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  const depositTo = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();
  // The public RPC sometimes fails gas estimation on a plain transfer (seen 9 Nov 2026): retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await (await funder.sendTransaction({ to: depositTo, value: parseEther('0.003') })).wait(1);
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      say(`deposit send failed (attempt ${attempt}), retrying: ${String(e).slice(0, 120)}`);
      await page.waitForTimeout(10_000);
    }
  }
  await watch(page, 'active-deposit-status', /^Done\./, 20 * 60_000, say);
  await closeSheet(page);

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
