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
    await loadProvider(
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
    return { publicWallet, provider, walletId: info.id, railgunAddress: info.railgunAddress, encryptionKey, balances, refresh };
  })();
  return started;
}


export const balanceOf = (pool: Pool, bucket: Bucket, token: string) => pool.balances.get(bucket)?.get(token.toLowerCase()) ?? 0n;

async function shieldKey(pool: Pool) {
  return keccak256(await pool.publicWallet.signMessage(getShieldPrivateKeySignatureMessage()));
}

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
