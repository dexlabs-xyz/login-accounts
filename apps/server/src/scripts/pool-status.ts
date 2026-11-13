/**
 * TESTNET ONLY. Prints the test-funds pool's private balance by bucket
 * (Spendable, ShieldPending, ...). Read-only. Never prints the phrase or keys.
 * Run from apps/server: npx tsx --env-file=../../.env src/scripts/pool-status.ts
 */
import { formatUnits } from 'ethers';
import { openPool, SEPOLIA_USDT } from '../test-funds/pool.ts';

async function main() {
  const pool = await openPool({
    mnemonic: process.env.TESTNET_POOL_MNEMONIC ?? '',
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    artifactDir: process.env.RAILGUN_ARTIFACT_DIR ?? './railgun-artifacts',
  });
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    await pool.refresh();
  }
  for (const [bucket, m] of pool.balances) {
    for (const [token, amount] of m) {
      if (amount > 0n) console.log(`${bucket}: ${token === SEPOLIA_USDT.toLowerCase() ? `${formatUnits(amount, 6)} USDT` : `${formatUnits(amount, 18)} WETH`}`);
    }
  }
  process.exit(0);
}
void main();
