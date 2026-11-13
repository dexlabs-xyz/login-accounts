/**
 * History card, live on Sepolia: after a deposit, a private send and a
 * withdrawal, the sender's History lists all three and the receiver's lists
 * the receipt. Built from Railgun's own history in the browser. TESTNET ONLY.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { chooseSend, closeSheet, Device, disableAutofill, errorTexts, goTo, openSheet, signUp } from './helpers.ts';
import { fundedAccount, log, watch } from './live.ts';

test.describe.configure({ timeout: 240 * 60_000 });
const say = log('history');

/** Review → passkey, retrying when a relay refuses (the app asks to review again). */
async function confirm(page: Page, panel: Locator, statusId: string, done: RegExp) {
  for (let attempt = 1; ; attempt++) {
    await panel.getByRole('button', { name: 'Review' }).click();
    await panel.getByRole('button', { name: 'Confirm with passkey' }).click({ timeout: 180_000 });
    const ok = await watch(page, statusId, done, 10 * 60_000, say).then(
      () => true,
      () => false,
    );
    if (ok) return;
    const alert = await errorTexts(page);
    say(`attempt ${attempt}: ${alert}`);
    if (!/network relay couldn’t confirm/.test(alert) || attempt >= 4) throw new Error(`Failed: ${alert}`);
  }
}

test('History lists the deposit, the private send and the withdrawal; the receiver sees the receipt', async ({ page, browser }) => {
  await fundedAccount(page, say); // two deposits: test funds + ETH deposit, so two spends (each deposit pays for one)

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await disableAutofill(pageB);
  await Device.add(pageB);
  await signUp(pageB);
  // Keep B "active" while A works, so B's wallet doesn't idle-lock (15 minutes, D5).
  const keepB = setInterval(() => void pageB.keyboard.press('Shift').catch(() => {}), 60_000);
  const addressB = (await pageB.getByRole('region', { name: /Private balance/ }).locator('code.address').getAttribute('title', { timeout: 120_000 }))!;

  const spendableBefore = (await page.getByRole('region', { name: /Private balance/ }).getByTestId('balance-Spendable-usdt').textContent()) ?? '';
  const send = await chooseSend(page, 'Privately via Railgun');
  await send.getByLabel('0zk address').fill(addressB);
  await send.getByLabel('Enter amount').fill('0.5');
  await confirm(page, send, 'transfer-status', /^Sent /);
  say('sent 0.5 USDT to B');

  // The second spend uses the other deposit (and its fee reserve). Wait, like a person would, until
  // the balance shows the send (250 USDT no longer all spendable), then until fees are covered.
  await closeSheet(page);
  const card = page.getByRole('region', { name: /Private balance/ });
  let lastLine = '';
  await expect
    .poll(async () => {
      await page.keyboard.press('Shift');
      const line = (await card.locator('.hero-status').allInnerTexts().catch(() => [] as string[])).join(' / ');
      if (line !== lastLine) say(`balance: ${(lastLine = line)}`);
      return (await card.getByTestId('balance-Spendable-usdt').textContent().catch(() => '')) ?? '';
    }, {
      timeout: 30 * 60_000,
      intervals: [15_000],
    })
    .not.toBe(spendableBefore);
  await expect.poll(async () => (await page.keyboard.press('Shift'), page.getByTestId('fee-reserve-ready').isVisible()), { timeout: 30 * 60_000, intervals: [15_000] }).toBe(true);
  const withdraw = await chooseSend(page, 'To an Ethereum address');
  const to = Wallet.createRandom().address; // throwaway, testnet only
  await withdraw.getByLabel('Address').fill(to);
  await withdraw.getByLabel('Enter amount').fill('1');
  await confirm(page, withdraw, 'unshield-status', /^Withdrew /);
  say('withdrew 1 USDT');

  await closeSheet(page);
  await goTo(page, 'Notifications'); // the full list (Home shows the latest four)
  const history = page.getByRole('region', { name: 'Notifications' });
  const want = [/Added 250 test USDT/, /Sent 0\.5 USDT privately to 0zk/, new RegExp(`Withdrew 1 USDT to ${to.slice(0, 8)}`)];
  let last = '';
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Shift');
        const t = (await history.innerText().catch(() => '')).replace(/\n+/g, ' | ');
        if (t !== last) say(`A history: ${(last = t).slice(0, 700)}`);
        return want.every((w) => w.test(t));
      },
      { timeout: 20 * 60_000, intervals: [15_000] },
    )
    .toBe(true);

  const historyB = pageB.getByRole('region', { name: 'Notifications' }); // Home's card
  await expect(historyB).toContainText(/Received 0\.5 USDT privately/, { timeout: 20 * 60_000 });
  await expect(historyB.locator('li[data-kind="received"]')).toHaveAttribute('data-status', /checking|spendable/);
  say(`B history: ${(await historyB.innerText()).replace(/\n+/g, ' | ').slice(0, 300)}`);
  clearInterval(keepB);
  await ctxB.close();
});
