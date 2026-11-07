/**
 * TESTNET ONLY. One-off: move the test-funds pool's public Sepolia USDT (and
 * some ETH, as WETH for users' fee reserves) into its private Railgun balance.
 * Rehearsal unless --confirm. Never prints the phrase or keys.
 *
 * Run from apps/server:
 *   npx tsx --env-file=../../.env src/scripts/pool-shield.ts [--eth 0.15] [--confirm]
 */
import { Contract, formatEther, formatUnits, getAddress, parseEther } from 'ethers';
import { openPool, SEPOLIA_USDT, shieldEth, shieldUsdt } from '../test-funds/pool.ts';

const POOL = '0x9bd58CDFA143128e2Cd782cd17dC09f4F5c18FB1';

async function main() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const ethArg = argv.includes('--eth') ? argv[argv.indexOf('--eth') + 1] : '0.15';
  const eth = parseEther(ethArg ?? '0.15');
  const mnemonic = process.env.TESTNET_POOL_MNEMONIC;
  if (!mnemonic) throw new Error('TESTNET_POOL_MNEMONIC is not set.');

  console.log('Starting Railgun (first run downloads circuit files)…');
  const pool = await openPool({
    mnemonic,
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    artifactDir: process.env.RAILGUN_ARTIFACT_DIR ?? './railgun-artifacts',
  });
  if (getAddress(pool.publicWallet.address) !== POOL) throw new Error('The phrase does not give the pool address.');

  const usdt = new Contract(SEPOLIA_USDT, ['function balanceOf(address) view returns (uint256)'], pool.provider);
  const publicUsdt = (await usdt.balanceOf!(POOL)) as bigint;
  const publicEth = await pool.provider.getBalance(POOL);
  console.log(`Pool public: ${formatUnits(publicUsdt, 6)} USDT, ${formatEther(publicEth)} ETH. Private address: ${pool.railgunAddress.slice(0, 14)}…`);
  console.log(`Plan: shield ${formatUnits(publicUsdt, 6)} USDT and ${formatEther(eth)} ETH (as WETH); keep the rest of the ETH for gas.`);
  if (!confirm) {
    console.log('REHEARSAL: nothing sent. Run again with --confirm.');
    process.exit(0);
  }
  if (publicUsdt > 0n) console.log(`USDT shield: https://sepolia.etherscan.io/tx/${await shieldUsdt(pool, publicUsdt)}`);
  if (eth > 0n) console.log(`ETH shield: https://sepolia.etherscan.io/tx/${await shieldEth(pool, eth)}`);
  console.log('Done. Both stay "pending" until Railgun\'s privacy check clears (usually about an hour).');
  process.exit(0);
}

main().catch((e) => {
  console.error(`STOPPED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
