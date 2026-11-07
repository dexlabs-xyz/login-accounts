/**
 * Full deposit against live services: Tidepool (NEAR Intents testnet) and
 * Sepolia. TESTNET ONLY: uses a throwaway sending wallet created per run, test
 * USDC from Tidepool's faucet, and gas from Login's testnet gas faucet (needs
 * TESTNET_GAS_FAUCET_KEY in .env).
 */
import { expect, test } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet, encodeBase58, parseUnits } from 'ethers';
import { Device, disableAutofill, recordSecrets, signUp } from './helpers.ts';

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const TIDEPOOL = 'https://www.usetidepool.tech';
const SEPOLIA_USDC = '0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2'; // Tidepool's test USDC (from /v0/tokens)
const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe'; // Tidepool's test USDT (verified)
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

test.describe.configure({ timeout: 15 * 60_000 });

test.beforeEach(async ({ page }, info) => {
  await disableAutofill(page);
  page.on('console', (m) => m.type() === 'error' && /railgun|tidepool/i.test(m.text()) && console.log(`[${info.title}] ${m.text().slice(0, 500)}`));
});

/** Polls the active deposit's status line until Done, logging each change. */
async function untilDone(add: import('@playwright/test').Locator, log: (m: string) => void, timeout: number) {
  const status = add.getByTestId('active-deposit-status');
  let last = '';
  await expect
    .poll(async () => {
      const t = (await status.textContent()) ?? '';
      if (t !== last) log(`status: ${(last = t)}`);
      return t;
    }, { timeout, intervals: [3_000] })
    .toMatch(/^Done\./);
}

test('EVM: ETH and USDC sent to one address → swapped through Tidepool → private USDT only', async ({ page }) => {
  const provider = new JsonRpcProvider(RPC);
  const sender = Wallet.createRandom().connect(provider); // throwaway, testnet only
  const usdc = new Contract(SEPOLIA_USDC, ERC20, sender);
  const log = (m: string) => console.log(`[evm] ${m}`);
  const leaks = await recordSecrets(page);

  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });
  await expect(card.getByTestId('fee-reserve-empty')).toBeVisible();

  // The sending wallet: ETH from our testnet faucet, test USDC from Tidepool's faucet.
  expect((await page.request.post('/api/testnet-gas', { data: { address: sender.address } })).ok()).toBe(true);
  const drip = await page.request.post(`${TIDEPOOL}/v0/faucet`, { data: { chain: 'eth', address: sender.address } });
  expect(drip.ok(), await drip.text()).toBe(true);
  await expect.poll(async () => (await provider.getBalance(sender.address)) >= parseUnits('0.0035', 18), { timeout: 180_000, intervals: [5_000] }).toBe(true);
  await expect.poll(async () => ((await usdc.balanceOf!(sender.address)) as bigint) >= parseUnits('1', 6), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  // Add money → From an Ethereum wallet: one address, no token or amount to pick.
  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  const to = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();
  expect(to).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await expect(add.getByText('Only these three tokens')).toBeVisible();
  // Read-only mainnet NEAR Intents price check (approved exception): shown, nothing sent.
  await expect(add.getByTestId('mainnet-price')).toContainText('nothing is sent', { timeout: 20_000 });

  // The user sends ETH and USDC back to back.
  const ethTx = await sender.sendTransaction({ to, value: parseUnits('0.003', 18) });
  const usdcTx = await usdc.transfer!(to, parseUnits('1', 6));
  await Promise.all([ethTx.wait(1), usdcTx.wait(1)]);
  log(`sent 0.003 ETH + 1 USDC to ${to}`);

  await untilDone(add, log, 15 * 60_000);
  log(`private balance: ${(await card.innerText()).replace(/\n+/g, ' | ').slice(-200)}`);

  // One currency: USDT shows; USDC and ETH don't (ETH is the hidden fee reserve).
  await expect(card.getByText('USDT')).toBeVisible({ timeout: 300_000 });
  await expect(card.getByText('USDC')).toHaveCount(0);
  await expect(card.getByText(/^ETH/)).toHaveCount(0);
  await expect(card.getByTestId(/fee-reserve-(pending|ready)/)).toBeVisible({ timeout: 300_000 });

  // Nothing secret left the device (Tidepool, faucet, RPC, Railgun traffic).
  expect(leaks.hosts()).toEqual(expect.arrayContaining(['www.usetidepool.tech', 'ethereum-sepolia-rpc.publicnode.com', '1click.chaindefuser.com']));
  await leaks.assertNoLeaks();
});

test('EVM: USDT sent to the address goes straight in, no swap', async ({ page }) => {
  const provider = new JsonRpcProvider(RPC);
  const sender = Wallet.createRandom().connect(provider); // throwaway, testnet only
  const usdt = new Contract(SEPOLIA_USDT, ERC20, sender);
  const log = (m: string) => console.log(`[usdt] ${m}`);

  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  expect((await page.request.post('/api/testnet-gas', { data: { address: sender.address } })).ok()).toBe(true);
  expect((await page.request.post(`${TIDEPOOL}/v0/faucet`, { data: { chain: 'eth', address: sender.address } })).ok()).toBe(true);
  await expect.poll(async () => (await provider.getBalance(sender.address)) > 0n, { timeout: 180_000, intervals: [5_000] }).toBe(true);
  await expect.poll(async () => ((await usdt.balanceOf!(sender.address)) as bigint) >= parseUnits('2', 6), { timeout: 180_000, intervals: [5_000] }).toBe(true);

  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  const to = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();
  const tx = await usdt.transfer!(to, parseUnits('2', 6));
  await tx.wait(1);
  log(`sent 2 USDT: https://sepolia.etherscan.io/tx/${tx.hash}`);

  await untilDone(add, log, 8 * 60_000);
  await expect(card.getByText('USDT')).toBeVisible({ timeout: 300_000 });
  log(`private balance: ${(await card.innerText()).replace(/\n+/g, ' | ').slice(-120)}`);
});

test('Solana devnet: asks for a refund address, then gets a Solana deposit address', async ({ page }) => {
  await Device.add(page);
  await signUp(page);
  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From Solana' }).click({ timeout: 240_000 });
  await add.getByLabel('Send from').selectOption({ label: 'USDC on Solana devnet' }, { timeout: 60_000 });
  await add.getByLabel('Amount').fill('1');

  const refund = add.getByLabel(/Your Solana address/);
  await refund.fill('0x1111111111111111111111111111111111111111'); // an Ethereum address: refused
  await expect(add.getByText('That isn’t a Solana address.')).toBeVisible();
  await expect(add.getByRole('button', { name: 'Get deposit address' })).toBeDisabled();

  // A throwaway Solana public key (32-byte ed25519, base58), testnet only.
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  await refund.fill(encodeBase58(raw));
  await add.getByRole('button', { name: 'Get deposit address' }).click();
  await expect(add.getByTestId('tidepool-deposit-address')).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, { timeout: 60_000 });
  await expect(add.getByText(/Send exactly .* USDC/)).toBeVisible();
  await expect(add.getByText('Solana devnet', { exact: true })).toBeVisible();
});

test('EVM: more ETH than Tidepool takes in one swap (0.006) is split into several swaps', async ({ page }) => {
  const provider = new JsonRpcProvider(RPC);
  const log = (m: string) => console.log(`[eth-split] ${m}`);

  await Device.add(page);
  await signUp(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  await expect(card.getByTestId('private-empty')).toBeVisible({ timeout: 240_000 });

  // Three throwaway senders, each with 0.004 ETH from our testnet faucet (testnet only).
  const senders = [0, 1, 2].map(() => Wallet.createRandom().connect(provider));
  for (const s of senders) expect((await page.request.post('/api/testnet-gas', { data: { address: s.address } })).ok()).toBe(true);
  for (const s of senders) {
    await expect.poll(async () => (await provider.getBalance(s.address)) >= parseUnits('0.004', 18), { timeout: 180_000, intervals: [5_000] }).toBe(true);
  }

  const add = page.getByRole('region', { name: /Add money/ });
  await add.getByRole('button', { name: 'From an Ethereum wallet' }).click();
  const to = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();

  // 3 x 0.0039 = 0.0117 ETH. After 0.001 gas and a 0.001 fee reserve, ~0.0097 is swapped: 0.006 + ~0.0037.
  const txs = await Promise.all(senders.map((s) => s.sendTransaction({ to, value: parseUnits('0.0039', 18) })));
  await Promise.all(txs.map((t) => t.wait(1)));
  log(`sent 0.0117 ETH to ${to}`);

  const status = add.getByTestId('active-deposit-status');
  const seen: string[] = [];
  await expect
    .poll(async () => {
      const t = (await status.textContent()) ?? '';
      if (t !== seen[seen.length - 1]) log(`status: ${t}`), seen.push(t);
      return t;
    }, { timeout: 15 * 60_000, intervals: [2_000] })
    .toMatch(/^Done\./);
  // Two separate ETH swaps happened: 2 swap transfers + approve + shield + fee-reserve shield = at least 5
  // transactions from the deposit address (a single swap would make 4).
  const sent = await provider.getTransactionCount(to);
  log(`transactions sent by the deposit address: ${sent}`);
  expect(sent).toBeGreaterThanOrEqual(5);
  await expect(card.getByText('USDT')).toBeVisible({ timeout: 300_000 });
  log(`private balance: ${(await card.innerText()).replace(/\n+/g, ' | ').slice(-160)}`);
});
