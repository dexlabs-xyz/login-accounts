/**
 * Live Sepolia diagnostic (TESTNET ONLY, slow): does new money still clear its privacy check on an account that has
 * already spent (and so holds a locked leftover)? Gold saw new balances never clear after a spend (13 Nov).
 * Run: LIVE=1 npx playwright test e2e/after-spend.spec.ts
 */
import { expect, test } from '@playwright/test';
import { parseEther, Wallet } from 'ethers';
import { chooseSend, closeSheet, Device, disableAutofill, errorTexts, openSheet, signUp } from './helpers.ts';
import { fundedAccount, log, provider, watch } from './live.ts';

test.skip(!process.env.LIVE, 'Live diagnostic; set LIVE=1');
test.describe.configure({ timeout: 150 * 60_000 });

test('a deposit made after a send still clears', async ({ page, browser }) => {
  const say = log('after-spend');
  const { card } = await fundedAccount(page, say);

  // Somewhere to send to.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await disableAutofill(pageB);
  await Device.add(pageB);
  await signUp(pageB);
  const addressB = (await pageB.getByRole('region', { name: /Private balance/ }).locator('code.address').getAttribute('title', { timeout: 120_000 }))!;

  // 1. One send: its leftover becomes the locked kind.
  const send = await chooseSend(page, 'Privately via Railgun');
  await send.getByLabel('0zk address').fill(addressB);
  await send.getByLabel('Enter amount').fill('0.5');
  for (let attempt = 1; ; attempt++) {
    await send.getByRole('button', { name: 'Review' }).click();
    if (await send.getByText('Network fee').waitFor({ timeout: 120_000 }).then(() => true, () => false)) break;
    const errors = await errorTexts(page);
    if (!/still being confirmed/.test(errors) || attempt >= 4) throw new Error(`Review failed: ${errors}`);
    await page.waitForTimeout(60_000);
  }
  for (let attempt = 1; ; attempt++) {
    await send.getByRole('button', { name: 'Confirm with passkey' }).click({ timeout: 180_000 });
    if (await watch(page, 'transfer-status', /^Sent /, 15 * 60_000, say).then(() => true, () => false)) break;
    const errors = await errorTexts(page);
    say(`confirm attempt ${attempt}: ${errors}`);
    if (!/relays turned this down/.test(errors) || attempt >= 4) throw new Error(`Send failed: ${errors}`);
    await page.waitForTimeout(60_000);
    await send.getByRole('button', { name: 'Review' }).click();
  }
  await closeSheet(page);
  say('sent once');

  // 2. New money after the spend: 0.003 ETH to a fresh deposit address.
  const funder = Wallet.createRandom().connect(provider);
  const gas = await page.request.post('/api/testnet-gas', { data: { address: funder.address } });
  expect(gas.ok()).toBe(true);
  await expect.poll(async () => (await provider.getBalance(funder.address)) >= parseEther('0.0035'), { timeout: 180_000, intervals: [5_000] }).toBe(true);
  await openSheet(page, 'Receive');
  const add = page.getByRole('dialog', { name: 'Receive' });
  await add.getByRole('button', { name: 'Ethereum Sepolia' }).click();
  const depositTo = (await add.getByTestId('tidepool-deposit-address').textContent({ timeout: 60_000 }))!.trim();
  for (let attempt = 1; ; attempt++) {
    try {
      await (await funder.sendTransaction({ to: depositTo, value: parseEther('0.003') })).wait(1);
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await page.waitForTimeout(10_000);
    }
  }
  await watch(page, 'active-deposit-status', /^Done\./, 20 * 60_000, say);
  await closeSheet(page);
  say('second deposit shielded');

  // 3. Watch the balance buckets until nothing is "arriving" any more.
  const t0 = Date.now();
  let last = '';
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift');
        const ids = await card.locator('[data-testid^="balance-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')}=${e.textContent}`));
        const t = ids.join(' | ');
        if (t !== last) say(`+${Math.round((Date.now() - t0) / 1000)}s ${(last = t)}`);
        return ids.some((x) => x.startsWith('balance-ShieldPending'));
      },
      { timeout: 120 * 60_000, intervals: [30_000] },
    )
    .toBe(false);
  say(`second deposit cleared after ${Math.round((Date.now() - t0) / 1000)}s`);
  await ctxB.close();
});
