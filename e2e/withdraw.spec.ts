/**
 * Withdraw (unshield) to a public Sepolia address, live, through a real
 * Railgun broadcaster. Slow (deposit + privacy check + proof). TESTNET ONLY.
 */
import { expect, test } from '@playwright/test';
import { chooseSend, errorToast } from './helpers.ts';
import { Contract, Wallet, parseUnits } from 'ethers';
import { ERC20, SEPOLIA_USDT, fundedAccount, log, provider, watch } from './live.ts';

test.describe.configure({ timeout: 180 * 60_000 });
const say = log('withdraw');

test('withdraws USDT to a public address; refuses own deposit addresses; flags the funding wallet', async ({ page }) => {
  const { depositTo, funder } = await fundedAccount(page, say);
  const panel = await chooseSend(page, 'To an Ethereum address'); // a withdrawal (public on arrival); USDT on Sepolia by default
  const toField = panel.getByLabel('Address');

  // Instant checks in the form.
  // (A bad address gets a red outline: aria-invalid.)
  await toField.fill('0x123');
  await expect(toField).toHaveAttribute('aria-invalid', 'true');
  await toField.fill('0x0000000000000000000000000000000000000000');
  await expect(toField).toHaveAttribute('aria-invalid', 'true');

  // The account's own deposit address is publicly linked to it: refused by the worker.
  await toField.fill(depositTo);
  await panel.getByLabel('Enter amount').fill('1');
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(errorToast(page)).toContainText('one of your own Login deposit addresses', { timeout: 120_000 });

  // The wallet that funded the deposit: allowed, but the review warns that the two are linked on-chain.
  await toField.fill(funder);
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(panel.getByTestId('withdraw-linked-warning')).toContainText('This address sent money into your Login account', {
    timeout: 120_000,
  });
  await panel.getByRole('button', { name: 'Back' }).click();

  // A fresh public address: review shows Railgun's fee, what arrives, the privacy warning, the network fee.
  const recipient = Wallet.createRandom().address; // throwaway, testnet only
  await toField.fill(recipient);
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(panel.getByText('Network fee')).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByRole('note')).toContainText('This part is public.');
  // 0.25% of 1 USDT, read from the contract.
  await expect(panel.getByTestId('withdraw-receives')).toHaveText('0.9975 USDT');
  await expect(panel.getByTestId('withdraw-linked-warning')).toHaveCount(0);
  say(`review: ${(await panel.innerText()).replace(/\n+/g, ' | ').slice(0, 500)}`);

  await panel.getByRole('button', { name: 'Confirm with passkey' }).click();
  await watch(page, 'unshield-status', /^Withdrew /, 10 * 60_000, say);
  const href = await panel.getByRole('link', { name: 'View on Sepolia Etherscan' }).getAttribute('href');
  say(`tx: ${href}`);

  // On-chain: the recipient gets exactly the amount shown, and the broadcaster sent it.
  const token = new Contract(SEPOLIA_USDT, ERC20, provider);
  await expect
    .poll(async () => (await token.balanceOf!(recipient)) as bigint, { timeout: 5 * 60_000, intervals: [5_000] })
    .toBe(parseUnits('0.9975', 6));
  const receipt = await provider.getTransactionReceipt(href!.split('/').pop()!);
  expect(receipt?.status).toBe(1);
  say(`receipt: status ${receipt?.status}, from ${receipt?.from} (broadcaster), gas ${receipt?.gasUsed}`);
});
