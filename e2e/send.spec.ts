/**
 * Private send between two accounts, live on Sepolia, through a real Railgun
 * broadcaster. Slow (deposit + privacy checks + proof). TESTNET ONLY.
 */
import { expect, test, type Page } from '@playwright/test';
import { Contract, JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { Device, disableAutofill, signUp } from './helpers.ts';

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const TIDEPOOL = 'https://www.usetidepool.tech';
const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

test.describe.configure({ timeout: 120 * 60_000 });
const log = (m: string) => console.log(`[send] ${m}`);

async function watch(page: Page, testId: string, until: RegExp, timeout: number) {
  let last = '';
  await expect
    .poll(async () => {
      const t = (await page.getByTestId(testId).textContent().catch(() => '')) ?? '';
      if (t && t !== last) log(`${testId}: ${(last = t)}`);
      return t;
    }, { timeout, intervals: [3_000] })
    .toMatch(until);
}

test('A sends USDT privately to B through a broadcaster', async ({ page, browser }) => {
  for (const p of [page]) {
    await disableAutofill(p);
    p.on('console', (m) => m.type() === 'error' && /railgun/i.test(m.text()) && log(`A console: ${m.text().slice(0, 400)}`));
  }

  // --- A: sign up and deposit 2 USDT directly (fastest path), which also funds the fee balance.
  await Device.add(page);
  await signUp(page);
  const cardA = page.getByRole('region', { name: /Private balance/ });
  await expect(cardA.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  const provider = new JsonRpcProvider(RPC);
  const funder = Wallet.createRandom().connect(provider); // throwaway, testnet only
  expect((await page.request.post('/api/testnet-gas', { data: { address: funder.address } })).ok()).toBe(true);
  expect((await page.request.post(`${TIDEPOOL}/v0/faucet`, { data: { chain: 'eth', address: funder.address } })).ok()).toBe(true);
  const usdt = new Contract(SEPOLIA_USDT, ERC20, funder);
  await expect.poll(async () => (await provider.getBalance(funder.address)) > 0n, { timeout: 180_000, intervals: [5_000] }).toBe(true);
  await expect.poll(async () => ((await usdt.balanceOf!(funder.address)) as bigint) >= parseUnits('2', 6), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByLabel('Send from').selectOption({ label: 'USDT on Ethereum Sepolia (direct, no swap)' });
  await add.getByLabel('Amount').fill('2');
  await add.getByRole('button', { name: 'Get deposit address' }).click();
  const depositTo = (await add.getByTestId('tidepool-deposit-address').textContent())!.trim();
  await (await usdt.transfer!(depositTo, parseUnits('2', 6))).wait(1);
  await watch(page, 'active-deposit-status', /^Done\./, 8 * 60_000);

  // Spendable once the privacy checks clear (USDT to send, ETH for the fee).
  const t0 = Date.now();
  // Railgun holds new shields as pending for a while before Proof of Innocence clears them.
  await expect(cardA.getByTestId('balance-Spendable-usdt')).toBeVisible({ timeout: 90 * 60_000 });
  await expect(cardA.getByTestId('balance-Spendable-eth')).toBeVisible({ timeout: 10 * 60_000 });
  log(`A spendable after ${Math.round((Date.now() - t0) / 1000)}s: ${(await cardA.innerText()).replace(/\n+/g, ' | ').slice(-160)}`);

  // --- B: a second account in its own browser context; we only need its private address.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await disableAutofill(pageB);
  await Device.add(pageB);
  await signUp(pageB);
  const cardB = pageB.getByRole('region', { name: /Private balance/ });
  const addressB = (await cardB.locator('code.address').getAttribute('title', { timeout: 120_000 }))!;
  expect(addressB).toMatch(/^0zk/);

  // --- A sends 0.5 USDT to B: review shows the fee, confirm with passkey, proof, broadcaster.
  const send = page.getByRole('region', { name: /Send privately/ });
  await send.getByLabel('To (private 0zk address)').fill(addressB);
  await send.getByLabel('Amount (USDT)').fill('0.5');
  await send.getByRole('button', { name: 'Review' }).click();
  await expect(send.getByText(/Network fee: .* ETH/)).toBeVisible({ timeout: 120_000 });
  log(`review: ${(await send.innerText()).replace(/\n+/g, ' | ').slice(0, 300)}`);
  await send.getByRole('button', { name: 'Confirm with passkey' }).click();
  await watch(page, 'send-status', /^Sent /, 10 * 60_000);
  log(`tx: ${await send.getByRole('link', { name: /View on Sepolia Etherscan/ }).getAttribute('href')}`);

  // --- B sees the USDT arrive (it may still be "being checked").
  await expect(cardB.getByText('USDT')).toBeVisible({ timeout: 10 * 60_000 });
  log(`B: ${(await cardB.innerText()).replace(/\n+/g, ' | ').slice(-160)}`);
  await ctxB.close();
});
