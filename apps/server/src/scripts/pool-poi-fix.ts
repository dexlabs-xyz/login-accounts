/**
 * TESTNET ONLY. Generates and publishes the Proof of Innocence data for one
 * transfer the pool sent, by its Ethereum tx hash (looked up to Railgun's own
 * transaction id first). Prints the pool's received-POI status after.
 * Run from apps/server: npx tsx --env-file=../../.env src/scripts/pool-poi-fix.ts <ethTxHash>
 */
import {
  fullResetTXIDMerkletreesV2,
  generatePOIsForWalletAndRailgunTxid,
  getRailgunTransactionsForTxid,
  getTXOsReceivedPOIStatusInfoForWallet,
  refreshReceivePOIsForWallet,
  syncRailgunTransactionsV2,
} from '@railgun-community/wallet';
import { getRailgunTransactionIDHex } from '@railgun-community/engine';
import { CHAIN, NETWORK, openPool, V2 } from '../test-funds/pool.ts';

async function main() {
  const chainTxid = process.argv[2];
  if (!chainTxid) throw new Error('Pass the Ethereum tx hash.');
  const pool = await openPool({ mnemonic: process.env.TESTNET_POOL_MNEMONIC ?? '', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', artifactDir: './railgun-artifacts' });
  await new Promise((r) => setTimeout(r, 20_000));
  await pool.refresh();
  // The engine synced the transaction list at start-up, before the balance scan had the
  // pool's commitments, so it couldn't link them. Rebuild the list now that it has them.
  await fullResetTXIDMerkletreesV2(NETWORK);
  await syncRailgunTransactionsV2(NETWORK);
  const txs = await getRailgunTransactionsForTxid(CHAIN, chainTxid);
  console.log(`Railgun transactions in that Ethereum tx: ${txs.length}`);
  for (const t of txs) {
    // Railgun's own transaction id is computed from the transaction's nullifiers, commitments and bound params.
    const id = getRailgunTransactionIDHex(t as { nullifiers: string[]; commitments: string[]; boundParamsHash: string });
    console.log(`railgunTxid ${id}`);
    if (!id) continue;
    try {
      await generatePOIsForWalletAndRailgunTxid(V2, NETWORK, pool.walletId, id);
      console.log('generated and submitted');
    } catch (e) {
      console.log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
      const cause = (e as { cause?: unknown }).cause;
      if (cause) console.log(`  caused by: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    await refreshReceivePOIsForWallet(V2, NETWORK, pool.walletId).catch(() => {});
  }
  const received = (await getTXOsReceivedPOIStatusInfoForWallet(V2, NETWORK, pool.walletId)) as { strings: { position: number; commitment: string; poisPerList: Record<string, string> } }[];
  for (const r of received) console.log(`position ${r.strings.position} ${r.strings.commitment.split(' ')[1]}: ${Object.values(r.strings.poisPerList).join(',')}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(`STOPPED: ${e instanceof Error ? e.message : JSON.stringify(e).slice(0, 500)}`);
  process.exit(1);
});
