/** TESTNET ONLY, read-only: is the pool's stuck transfer in the synced Railgun transaction list yet? */
import { getLatestRailgunTxidData, syncRailgunTransactionsV2, validateRailgunTxidExists } from '@railgun-community/wallet';
import { JsonRpcProvider } from 'ethers';
import { NETWORK, openPool, V2 } from '../test-funds/pool.ts';

async function main() {
  await openPool({ mnemonic: process.env.TESTNET_POOL_MNEMONIC ?? '', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', artifactDir: './railgun-artifacts' });
  await syncRailgunTransactionsV2(NETWORK);
  const latest = await getLatestRailgunTxidData(V2, NETWORK);
  console.log('latest synced txid data:', JSON.stringify(latest).slice(0, 300));
  console.log('stuck txid in list:', await validateRailgunTxidExists(V2, NETWORK, 'bcf46e57b3f49147d12a4169f47abe921357c780ca278afc5b7397f406d5f411'));
  console.log('current block:', await new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com').getBlockNumber());
  process.exit(0);
}
void main();
