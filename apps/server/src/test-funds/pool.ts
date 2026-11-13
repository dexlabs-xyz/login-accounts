/**
 * TESTNET ONLY. The test-funds pool: a Railgun wallet run by Login's server,
 * holding Tidepool's test USDT privately, so new users can claim test funds
 * (team decision, 6 Nov 2026). Its recovery phrase comes from the host's
 * settings (TESTNET_POOL_MNEMONIC) and is never logged.
 *
 * The same phrase gives the pool's public address (standard path, receives
 * Tidepool's tokens, pays gas) and its private Railgun wallet (sends claims).
 * Everything here is Sepolia; any other chain is refused.
 */
import { hkdfSync } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import MemDown from 'memdown';
import {
  ArtifactStore,
  createRailgunWallet,
  gasEstimateForShield,
  gasEstimateForShieldBaseToken,
  getProver,
  getShieldPrivateKeySignatureMessage,
  loadProvider,
  populateShield,
  populateShieldBaseToken,
  refreshBalances,
  refreshReceivePOIsForWallet,
  setLoggers,
  setOnBalanceUpdateCallback,
  startRailgunEngine,
} from '@railgun-community/wallet';
import { EVMGasType, NETWORK_CONFIG, NetworkName, TXIDVersion, type RailgunBalancesEvent } from '@railgun-community/shared-models';
import { Contract, HDNodeWallet, JsonRpcProvider, keccak256 } from 'ethers';
import { groth16 } from 'snarkjs';

export const NETWORK = NetworkName.EthereumSepolia;
export const CHAIN = NETWORK_CONFIG[NETWORK].chain;
export const V2 = TXIDVersion.V2_PoseidonMerkle;
export const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
export const SEPOLIA_WETH = NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress;
const RAILGUN_PROXY = NETWORK_CONFIG[NETWORK].proxyContract;
const POI_NODE_URLS = ['https://ppoi.fdi.network'];
const WALLET_SOURCE = 'loginpool'; // shown on-chain as the shield source; lowercase, max 16 chars
const ERC20 = [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

export type Bucket = RailgunBalancesEvent['balanceBucket'];

export interface Pool {
  /** Public address (standard path): receives Tidepool's tokens, pays gas. */
  publicWallet: HDNodeWallet;
  provider: JsonRpcProvider;
  walletId: string;
  railgunAddress: string;
  /** The pool's Railgun DB encryption key. Server memory only. */
  encryptionKey: string;
  /** Railgun's shield fee (basis points), read from the contract at start. */
  shieldFeeBasisPoints: bigint;
  /** Latest private balances by bucket, then token address (lowercase). */
  balances: Map<Bucket, Map<string, bigint>>;
  refresh(): Promise<void>;
}

/** Circuit artifacts are public files, cached on disk (the host's volume). */
function diskArtifactStore(dir: string) {
  const at = (p: string) => join(dir, p);
  return new ArtifactStore(
    async (p) => readFile(at(p)).catch(() => null),
    async (_d, p, item) => {
      await mkdir(dirname(at(p)), { recursive: true });
      await writeFile(at(p), item);
    },
    async (p) => stat(at(p)).then(() => true, () => false),
  );
}

let started: Promise<Pool> | null = null;

/** Starts Railgun in this process and opens the pool wallet. Once per process. */
export function openPool(opts: { mnemonic: string; rpcUrl: string; artifactDir: string }): Promise<Pool> {
  if (started) return started;
  started = (async () => {
    const provider = new JsonRpcProvider(opts.rpcUrl);
    if ((await provider.getNetwork()).chainId !== BigInt(CHAIN.id)) throw new Error('The pool runs on Sepolia only.');
    const publicWallet = HDNodeWallet.fromPhrase(opts.mnemonic).connect(provider);

    setLoggers(undefined, undefined); // the SDK's messages could include wallet details
    await startRailgunEngine(WALLET_SOURCE, new MemDown(), false, diskArtifactStore(opts.artifactDir), false, false, POI_NODE_URLS);
    getProver().setSnarkJSGroth16(groth16 as Parameters<ReturnType<typeof getProver>['setSnarkJSGroth16']>[0]);
    const { feesSerialized } = await loadProvider(
      { chainId: CHAIN.id, providers: [{ provider: opts.rpcUrl, priority: 1, weight: 2, maxLogsPerBatch: 10 }] },
      NETWORK,
      15_000,
    );

    // The Railgun DB key is derived from the phrase with HKDF (a standard KDF), labelled for this use only.
    const encryptionKey = Buffer.from(
      hkdfSync('sha256', opts.mnemonic, 'withlogin.com/pool/hkdf/v1', 'withlogin.com/pool/railgun-db-key/v1', 32),
    ).toString('hex');
    const info = await createRailgunWallet(encryptionKey, opts.mnemonic, undefined);

    const balances = new Map<Bucket, Map<string, bigint>>();
    setOnBalanceUpdateCallback((e) => {
      if (e.railgunWalletID !== info.id) return;
      balances.set(e.balanceBucket, new Map(e.erc20Amounts.map((a) => [a.tokenAddress.toLowerCase(), a.amount])));
    });
    const refresh = async () => {
      await refreshBalances(CHAIN, [info.id]);
      await refreshReceivePOIsForWallet(V2, NETWORK, info.id).catch(() => {});
    };
    await refresh();
    if (!feesSerialized?.shieldFeeV2) throw new Error('Railgun shield fee unavailable.');
    const shieldFeeBasisPoints = BigInt(feesSerialized.shieldFeeV2);
    return { publicWallet, provider, walletId: info.id, railgunAddress: info.railgunAddress, encryptionKey, shieldFeeBasisPoints, balances, refresh };
  })();
  return started;
}


export const balanceOf = (pool: Pool, bucket: Bucket, token: string) => pool.balances.get(bucket)?.get(token.toLowerCase()) ?? 0n;

async function shieldKey(pool: Pool) {
  return keccak256(await pool.publicWallet.signMessage(getShieldPrivateKeySignatureMessage()));
}

/** Amount to shield so that `net` arrives after Railgun's shield fee (fee = gross × bp / 10000, rounded down). */
export function grossForShield(net: bigint, feeBasisPoints: bigint): bigint {
  const keep = 10_000n - feeBasisPoints;
  return (net * 10_000n + keep - 1n) / keep;
}

/**
 * TESTNET ONLY. Splits `total` into `count` pieces that each differ by `step` and add up to `total` exactly.
 *
 * Why (team lead, 13 Nov): on Sepolia, what's left after a send or withdrawal never clears Railgun's privacy check
 * (README, Known limit), so one piece of money pays for one transaction. Railgun spends the smallest pieces that
 * cover a send, so a claim in several pieces pays for several. The pieces differ slightly so no two are identical.
 */
export function splitIntoPieces(total: bigint, count: number, step: bigint): bigint[] {
  const n = BigInt(count);
  const mid = (n - 1n) / 2n;
  // Centred offsets (…, -step, 0, +step, …) cancel out for an odd count; the rounding remainder goes on the largest.
  const offsets = Array.from({ length: count }, (_, i) => (BigInt(i) - mid) * step);
  const base = (total - offsets.reduce((a, b) => a + b, 0n)) / n;
  const pieces = offsets.map((o) => base + o);
  pieces[count - 1]! += total - pieces.reduce((a, b) => a + b, 0n);
  if (pieces.some((p) => p <= 0n)) throw new Error('Pieces too small.');
  return pieces;
}

/**
 * TESTNET ONLY. `count` pieces of at least `base`, each `step` more than the last (base, base+step, …), so no two
 * are identical and none is below `base`. Railgun spends the smallest pieces first until the amount is covered, so
 * with every piece at least $10 a send of $10 or less uses exactly one (team lead, 13 Nov: the demo sends $10 at a
 * time). A piece spread below $10 would make a $10 send take two.
 */
export function piecesFrom(base: bigint, count: number, step: bigint): bigint[] {
  return Array.from({ length: count }, (_, i) => base + BigInt(i) * step);
}

/** What the pool pays for these pieces: each is a separate shield, and Railgun takes its fee from each one. */
export const grossForPieces = (pieces: readonly bigint[], feeBasisPoints: bigint) =>
  pieces.reduce((t, p) => t + grossForShield(p, feeBasisPoints), 0n);

async function feeData(pool: Pool) {
  const f = await pool.provider.getFeeData();
  return { maxFeePerGas: f.maxFeePerGas ?? 0n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
}

/** Moves `amount` of the pool's public USDT into its private balance (approve exactly, then shield). */
export async function shieldUsdt(pool: Pool, amount: bigint): Promise<string> {
  const usdt = new Contract(SEPOLIA_USDT, ERC20, pool.publicWallet);
  const owner = pool.publicWallet.address;
  if (((await usdt.balanceOf!(owner)) as bigint) < amount) throw new Error('The pool does not hold that much public USDT.');
  if (((await usdt.allowance!(owner, RAILGUN_PROXY)) as bigint) < amount) {
    await (await usdt.approve!(RAILGUN_PROXY, amount)).wait(1);
    // A lagging RPC node may not show the approval yet.
    for (let i = 0; ((await usdt.allowance!(owner, RAILGUN_PROXY)) as bigint) < amount; i++) {
      if (i >= 30) throw new Error('Approval not visible yet.');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  const key = await shieldKey(pool);
  const recipients = [{ tokenAddress: SEPOLIA_USDT, amount, recipientAddress: pool.railgunAddress }];
  const { gasEstimate } = await gasEstimateForShield(V2, NETWORK, key, recipients, [], owner);
  const { transaction } = await populateShield(V2, NETWORK, key, recipients, [], {
    evmGasType: EVMGasType.Type2,
    gasEstimate,
    ...(await feeData(pool)),
  });
  const sent = await pool.publicWallet.sendTransaction(transaction);
  await sent.wait(1);
  return sent.hash;
}

/** Moves `amount` of the pool's public ETH into its private balance as WETH (claims hand out fee reserves from it). */
export async function shieldEth(pool: Pool, amount: bigint): Promise<string> {
  const owner = pool.publicWallet.address;
  const key = await shieldKey(pool);
  const wrapped = { tokenAddress: SEPOLIA_WETH, amount };
  const { gasEstimate } = await gasEstimateForShieldBaseToken(V2, NETWORK, pool.railgunAddress, key, wrapped, owner);
  const fees = await feeData(pool);
  if ((await pool.provider.getBalance(owner)) < amount + (gasEstimate * fees.maxFeePerGas * 13n) / 10n) {
    throw new Error('Not enough public ETH for that amount plus gas.');
  }
  const { transaction } = await populateShieldBaseToken(V2, NETWORK, pool.railgunAddress, key, wrapped, {
    evmGasType: EVMGasType.Type2,
    gasEstimate,
    ...fees,
  });
  const sent = await pool.publicWallet.sendTransaction(transaction);
  await sent.wait(1);
  return sent.hash;
}

/** The pool's public holdings, which claims are paid from. */
export async function publicBalances(pool: Pool) {
  const owner = pool.publicWallet.address;
  const [usdt, weth, eth] = await Promise.all([
    new Contract(SEPOLIA_USDT, ERC20, pool.provider).balanceOf!(owner) as Promise<bigint>,
    new Contract(SEPOLIA_WETH, ERC20, pool.provider).balanceOf!(owner) as Promise<bigint>,
    pool.provider.getBalance(owner),
  ]);
  return { usdt, weth, eth };
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  // A lagging RPC node may not show the last transaction yet.
  for (let i = 0; !(await check()); i++) {
    if (i >= 30) throw new Error(`${what} not visible yet.`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Approves the Railgun contract for the pool's whole balance of `token`, if it can't already take `amount`. */
async function ensureAllowance(pool: Pool, token: string, amount: bigint) {
  const c = new Contract(token, ERC20, pool.publicWallet);
  const owner = pool.publicWallet.address;
  const enough = async () => ((await c.allowance!(owner, RAILGUN_PROXY)) as bigint) >= amount;
  if (await enough()) return;
  const all = (await c.balanceOf!(owner)) as bigint;
  await (await c.approve!(RAILGUN_PROXY, all > amount ? all : amount)).wait(1);
  await waitFor(enough, 'Approval');
}

/**
 * TESTNET ONLY. One claim as a single shield from the pool's public address
 * straight into `to` (a 0zk address): USDT, plus WETH for the claimer's fee
 * reserve. Amounts are what the claimer receives; Railgun's shield fee is added
 * on top. Public ETH is wrapped into WETH in batches of `wrapBatchWei`.
 */
/** One shield of every piece (see splitIntoPieces): the claimer receives each piece exactly, as its own note. */
export async function shieldClaim(
  pool: Pool,
  to: string,
  net: { usdt: readonly bigint[]; weth: readonly bigint[] },
  wrapBatchWei: bigint,
): Promise<string> {
  const owner = pool.publicWallet.address;
  const usdt = grossForPieces(net.usdt, pool.shieldFeeBasisPoints);
  const weth = grossForPieces(net.weth, pool.shieldFeeBasisPoints);
  const have = await publicBalances(pool);
  if (have.usdt < usdt) throw new Error('pool-empty');
  if (have.weth < weth) {
    const wrap = wrapBatchWei > weth - have.weth ? wrapBatchWei : weth - have.weth;
    const wethContract = new Contract(SEPOLIA_WETH, ERC20, pool.publicWallet);
    await (await wethContract.deposit!({ value: wrap })).wait(1);
    await waitFor(async () => ((await wethContract.balanceOf!(owner)) as bigint) >= weth, 'Wrapped ETH');
  }
  await ensureAllowance(pool, SEPOLIA_USDT, usdt);
  await ensureAllowance(pool, SEPOLIA_WETH, weth);
  const key = await shieldKey(pool);
  const recipients = [
    ...net.usdt.map((p) => ({ tokenAddress: SEPOLIA_USDT, amount: grossForShield(p, pool.shieldFeeBasisPoints), recipientAddress: to })),
    ...net.weth.map((p) => ({ tokenAddress: SEPOLIA_WETH, amount: grossForShield(p, pool.shieldFeeBasisPoints), recipientAddress: to })),
  ];
  const { gasEstimate } = await gasEstimateForShield(V2, NETWORK, key, recipients, [], owner);
  const { transaction } = await populateShield(V2, NETWORK, key, recipients, [], {
    evmGasType: EVMGasType.Type2,
    gasEstimate,
    ...(await feeData(pool)),
  });
  const sent = await pool.publicWallet.sendTransaction(transaction);
  await sent.wait(1);
  return sent.hash;
}
