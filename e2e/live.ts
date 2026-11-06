/** Shared setup for live Sepolia tests (send, withdraw). TESTNET ONLY. */
import { expect, type Page } from '@playwright/test';
import { Contract, JsonRpcProvider, Wallet, parseUnits } from 'ethers';
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
      const t = (await page.getByTestId(testId).textContent().catch(() => '')) ?? '';
      if (t && t !== last) say(`${testId}: ${(last = t)}`);
      return t;
    }, { timeout, intervals: [3_000] })
    .toMatch(until);
}

/**
 * Signs up a new account and deposits `usdt` USDT directly (fastest path), which
 * also funds the fee balance, then waits until both are Spendable.
 * Returns the deposit address used (it's publicly linked to this account).
 */
export async function fundedAccount(page: Page, usdt: string, say: (m: string) => void) {
  await disableAutofill(page);
  page.on('console', (m) => m.type() === 'error' && /railgun/i.test(m.text()) && say(`console: ${m.text().slice(0, 400)}`));
  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  const funder = Wallet.createRandom().connect(provider); // throwaway, testnet only
  expect((await page.request.post('/api/testnet-gas', { data: { address: funder.address } })).ok()).toBe(true);
  // Tidepool's faucet is community-run and sometimes refuses briefly: retry, logging why.
  await expect
    .poll(
      async () => {
        const r = await page.request.post(`${TIDEPOOL}/v0/faucet`, { data: { chain: 'eth', address: funder.address } });
        if (!r.ok()) say(`Tidepool faucet ${r.status()}: ${(await r.text()).slice(0, 200)}`);
        return r.ok();
      },
      { timeout: 10 * 60_000, intervals: [30_000] },
    )
    .toBe(true);
  const token = new Contract(SEPOLIA_USDT, ERC20, funder);
  await expect.poll(async () => (await provider.getBalance(funder.address)) > 0n, { timeout: 180_000, intervals: [5_000] }).toBe(true);
  await expect.poll(async () => ((await token.balanceOf!(funder.address)) as bigint) >= parseUnits(usdt, 6), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByLabel('Send from').selectOption({ label: 'USDT on Ethereum Sepolia (direct, no swap)' });
  await add.getByLabel('Amount').fill(usdt);
  await add.getByRole('button', { name: 'Get deposit address' }).click();
  const depositTo = (await add.getByTestId('tidepool-deposit-address').textContent())!.trim();
  await (await token.transfer!(depositTo, parseUnits(usdt, 6))).wait(1);
  await watch(page, 'active-deposit-status', /^Done\./, 8 * 60_000, say);

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
  await expect(card.getByTestId('balance-Spendable-eth')).toBeVisible({ timeout: 10 * 60_000 });
  say(`spendable after ${Math.round((Date.now() - t0) / 1000)}s`);
  return { card, depositTo };
}
