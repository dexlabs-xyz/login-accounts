/**
 * Private send between two accounts, live on Sepolia, through a real Railgun
 * broadcaster. Slow (deposit + privacy checks + proof). TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { chooseSend, Device, disableAutofill, errorTexts, signUp } from './helpers.ts';
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
  // Review; if the wallet is still catching up with the chain, the app says so and a person presses Review again.
  for (let attempt = 1; ; attempt++) {
    await send.getByRole('button', { name: 'Review' }).click();
    const ok = await send.getByText('Network fee').waitFor({ timeout: 120_000 }).then(() => true, () => false);
    if (ok) break;
    const errors = await errorTexts(page);
    say(`review attempt ${attempt}: ${errors}`);
    if (!/still being confirmed/.test(errors) || attempt >= 4) throw new Error(`Review failed: ${errors}`);
    await page.waitForTimeout(60_000);
  }
  say(`review: ${(await send.innerText()).replace(/\n+/g, ' | ').slice(0, 300)}`);
  // Confirm; if a relay refuses (the app says so and nothing is sent), a person presses Review again.
  for (let attempt = 1; ; attempt++) {
    await send.getByRole('button', { name: 'Confirm with passkey' }).click({ timeout: 180_000 });
    const sent = await watch(page, 'transfer-status', /^Sent /, 10 * 60_000, say).then(() => true, () => false);
    if (sent) break;
    const errors = await errorTexts(page);
    say(`confirm attempt ${attempt}: ${errors}`);
    if (!/network relay couldn’t confirm/.test(errors) || attempt >= 4) throw new Error(`Send failed: ${errors}`);
    await send.getByRole('button', { name: 'Review' }).click();
  }
  say(`tx: ${await send.getByRole('link', { name: /View on Sepolia Etherscan/ }).getAttribute('href')}`);

  // --- B sees the USDT arrive (it may still be "being checked").
  await expect(cardB.getByText('USDT')).toBeVisible({ timeout: 10 * 60_000 });
  say(`B: ${(await cardB.innerText()).replace(/\n+/g, ' | ').slice(-160)}`);
  await ctxB.close();
});
