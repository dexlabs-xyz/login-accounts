/**
 * TESTNET ONLY. Publishes the test-funds pool's pending Proof of Innocence data
 * (for transfers it sent), then prints its balance by bucket. Shows errors.
 * Run from apps/server: npx tsx --env-file=../../.env src/scripts/pool-poi.ts
 */
import { formatUnits } from 'ethers';
import {
  generatePOIsForWallet,
  generatePOIsForWalletAndRailgunTxid,
  getChainTxidsStillPendingSpentPOIs,
  refreshSpentPOIsForWallet,
  syncRailgunTransactionsV2,
} from '@railgun-community/wallet';
import { NETWORK, openPool, SEPOLIA_USDT, V2 } from '../test-funds/pool.ts';

async function main() {
  const pool = await openPool({
    mnemonic: process.env.TESTNET_POOL_MNEMONIC ?? '',
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    artifactDir: process.env.RAILGUN_ARTIFACT_DIR ?? './railgun-artifacts',
  });
  await new Promise((r) => setTimeout(r, 20_000));
  await pool.refresh();
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      console.log(`${name}: ok${r !== undefined ? ` ${JSON.stringify(r).slice(0, 200)}` : ''}`);
    } catch (e) {
      console.log(`${name}: ERROR ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    }
  };
  // The transaction list (TXID tree) must be synced before proofs for a sent transfer can be made.
  await step('syncRailgunTransactionsV2', () => syncRailgunTransactionsV2(NETWORK));
  const pending = (await getChainTxidsStillPendingSpentPOIs(V2, NETWORK, pool.walletId)) as string[];
  console.log(`pending spent txids: ${pending.length}`);
  for (const txid of pending) await step(`generate for ${txid.slice(0, 10)}`, () => generatePOIsForWalletAndRailgunTxid(V2, NETWORK, pool.walletId, txid));
  await step('generatePOIsForWallet', () => generatePOIsForWallet(NETWORK, pool.walletId));
  await step('refreshSpentPOIsForWallet', () => refreshSpentPOIsForWallet(V2, NETWORK, pool.walletId));
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    await pool.refresh();
  }
  await step('pending spent txids (after)', () => getChainTxidsStillPendingSpentPOIs(V2, NETWORK, pool.walletId));
  for (const [bucket, m] of pool.balances) for (const [t, a] of m) if (a > 0n) console.log(`${bucket}: ${t === SEPOLIA_USDT.toLowerCase() ? `${formatUnits(a, 6)} USDT` : `${formatUnits(a, 18)} WETH`}`);
  process.exit(0);
}
void main();
