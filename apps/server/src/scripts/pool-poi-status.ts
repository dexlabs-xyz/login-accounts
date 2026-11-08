/** TESTNET ONLY, read-only: Proof of Innocence status of what the pool sent and received. */
import { getTXOsReceivedPOIStatusInfoForWallet, getTXOsSpentPOIStatusInfoForWallet, syncRailgunTransactionsV2 } from '@railgun-community/wallet';
import { NETWORK, openPool, V2 } from '../test-funds/pool.ts';

async function main() {
  if (!process.env.TESTNET_POOL_MNEMONIC) {
    console.log('TESTNET_POOL_MNEMONIC is not set locally.');
    process.exit(0);
  }
  const pool = await openPool({ mnemonic: process.env.TESTNET_POOL_MNEMONIC, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', artifactDir: './railgun-artifacts' });
  await new Promise((r) => setTimeout(r, 20_000));
  await pool.refresh();
  await syncRailgunTransactionsV2(NETWORK);
  const spent = await getTXOsSpentPOIStatusInfoForWallet(V2, NETWORK, pool.walletId);
  console.log('SPENT:', JSON.stringify(spent, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 2500));
  const received = await getTXOsReceivedPOIStatusInfoForWallet(V2, NETWORK, pool.walletId);
  console.log('RECEIVED:', JSON.stringify(received, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 2500));
  process.exit(0);
}
void main();
