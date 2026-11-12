/**
 * Private send between two accounts, live on Sepolia, through a real Railgun
 * broadcaster. Slow (deposit + privacy checks + proof). TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { chooseSend, Device, disableAutofill, signUp } from './helpers.ts';
import { fundedAccount, log, watch } from './live.ts';

test.describe.configure({ timeout: 180 * 60_000 });
const say = log('send');

test('A sends USDT privately to B through a broadcaster', async ({ page, browser }) => {
  // --- A: a funded account with spendable USDT and ETH for fees.
  await fundedAccount(page, say);

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
  const send = await chooseSend(page, 'Privately via Railgun');
  await send.getByLabel('0zk address').fill(addressB);
  await send.getByLabel('Enter amount').fill('0.5');
  await send.getByRole('button', { name: 'Review' }).click();
  await expect(send.getByText('Network fee')).toBeVisible({ timeout: 120_000 });
  say(`review: ${(await send.innerText()).replace(/\n+/g, ' | ').slice(0, 300)}`);
  await send.getByRole('button', { name: 'Confirm with passkey' }).click();
  await watch(page, 'transfer-status', /^Sent /, 10 * 60_000, say);
  say(`tx: ${await send.getByRole('link', { name: /View on Sepolia Etherscan/ }).getAttribute('href')}`);

  // --- B sees the USDT arrive (it may still be "being checked").
  await expect(cardB.getByText('USDT')).toBeVisible({ timeout: 10 * 60_000 });
  say(`B: ${(await cardB.innerText()).replace(/\n+/g, ' | ').slice(-160)}`);
  await ctxB.close();
});
