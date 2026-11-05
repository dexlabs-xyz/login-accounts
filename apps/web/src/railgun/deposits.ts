/**
 * Deposits, inside the Railgun worker. TESTNET ONLY (Sepolia).
 *
 * Each deposit gets a fresh Sepolia address from the recovery phrase on the
 * standard Ethereum path m/44'/60'/0'/0/i, so any standard wallet can recover
 * it from the phrase. The private keys for these addresses exist only here.
 *
 * Deposit records (which addresses are in use, and how far each deposit got)
 * are stored on this device only, encrypted with a key derived from the root
 * secret. A new device rebuilds them by scanning derived addresses for activity.
 */
import {
  gasEstimateForShield,
  getShieldPrivateKeySignatureMessage,
  populateShield,
} from '@railgun-community/wallet';
import { EVMGasType, NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models';
import { Contract, HDNodeWallet, JsonRpcProvider, keccak256, type Provider } from 'ethers';
import { openJson, sealJson, type Bytes, type SealedJson } from '@login/vault';
import { SEPOLIA_USDT, type DepositRecord, type DepositStatus } from './protocol.ts';

const NETWORK = NetworkName.EthereumSepolia;
const RAILGUN_PROXY = NETWORK_CONFIG[NETWORK].proxyContract;
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
/** Stop scanning after this many unused addresses in a row (like standard wallets). */
const GAP_LIMIT = 20;
const RECORDS_PURPOSE = 'deposit-records';

export interface DepositContext {
  mnemonic: string;
  recordsKey: Bytes;
  railgunAddress: string;
  rpcUrl: string;
  onChange: (records: DepositRecord[]) => void;
}

const pathFor = (index: number) => `m/44'/60'/0'/0/${index}`;

// ---------- encrypted records in IndexedDB ----------

function recordsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('login-deposits', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await recordsDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createDeposits(ctx: DepositContext) {
  const provider: Provider = new JsonRpcProvider(ctx.rpcUrl);
  const usdt = new Contract(SEPOLIA_USDT, ERC20, provider);
  let cache: DepositRecord[] | null = null;

  const addressAt = (index: number) => HDNodeWallet.fromPhrase(ctx.mnemonic, undefined, pathFor(index)).address;

  async function load(): Promise<DepositRecord[]> {
    if (cache) return cache;
    const sealed = (await kv('readonly', (s) => s.get('records'))) as SealedJson | undefined;
    cache = sealed ? await openJson<DepositRecord[]>(ctx.recordsKey, RECORDS_PURPOSE, sealed) : [];
    return cache;
  }
  async function save(records: DepositRecord[]) {
    cache = records.sort((a, b) => a.index - b.index);
    const sealed = await sealJson(ctx.recordsKey, RECORDS_PURPOSE, cache);
    await kv('readwrite', (s) => s.put(sealed, 'records'));
    ctx.onChange(cache);
  }
  async function patch(index: number, changes: Partial<DepositRecord>) {
    const records = await load();
    const r = records.find((x) => x.index === index);
    if (!r) throw new Error('Unknown deposit.');
    Object.assign(r, changes, { updatedAt: Date.now() });
    await save(records);
    return r;
  }

  /** Has this address ever been used? Any nonce, ETH or USDT counts. */
  async function used(address: string) {
    const [nonce, eth, tokens] = await Promise.all([
      provider.getTransactionCount(address),
      provider.getBalance(address),
      usdt.balanceOf!(address) as Promise<bigint>,
    ]);
    return nonce > 0 || eth > 0n || tokens > 0n;
  }

  return {
    list: load,

    /** Reserve the next fresh address, skipping any with on-chain history (e.g. used from another device). */
    async next(): Promise<DepositRecord> {
      const records = await load();
      let index = records.length ? Math.max(...records.map((r) => r.index)) + 1 : 0;
      for (let tries = 0; tries < 50 && (await used(addressAt(index))); tries++) index++;
      const now = Date.now();
      const record: DepositRecord = { index, address: addressAt(index), status: 'new', createdAt: now, updatedAt: now };
      await save([...records, record]);
      return record;
    },

    /** Page-side progress (quote taken, delivered, refunded...). Only these fields can change here. */
    async update(params: unknown) {
      const { index, status, quote } = params as { index: number; status?: DepositStatus; quote?: DepositRecord['quote'] };
      const allowed: DepositStatus[] = ['awaiting-delivery', 'delivered', 'refunded', 'failed'];
      if (status && !allowed.includes(status)) throw new Error('Status not allowed from the page.');
      return patch(index, { ...(status ? { status } : {}), ...(quote ? { quote } : {}) });
    },

    async balances(params: unknown) {
      const { index } = params as { index: number };
      const r = (await load()).find((x) => x.index === index);
      if (!r) throw new Error('Unknown deposit.');
      const [eth, tokens] = await Promise.all([provider.getBalance(r.address), usdt.balanceOf!(r.address) as Promise<bigint>]);
      return { eth: eth.toString(), usdt: tokens.toString() };
    },

    /**
     * Move the USDT at a deposit address into the private balance: approve
     * exactly the amount (never unlimited), then shield to this wallet's 0zk
     * address. Both transactions are signed here and paid by the address itself.
     */
    async shield(params: unknown) {
      const { index } = params as { index: number };
      const r = (await load()).find((x) => x.index === index);
      if (!r) throw new Error('Unknown deposit.');
      const wallet = HDNodeWallet.fromPhrase(ctx.mnemonic, undefined, pathFor(index)).connect(provider);
      const amount = (await usdt.balanceOf!(wallet.address)) as bigint;
      if (amount === 0n) throw new Error('Nothing to shield yet.');
      await patch(index, { status: 'shielding' });

      const token = usdt.connect(wallet) as Contract;
      let approveTx: string | undefined;
      if (((await token.allowance!(wallet.address, RAILGUN_PROXY)) as bigint) < amount) {
        const tx = await token.approve!(RAILGUN_PROXY, amount);
        await tx.wait(1);
        approveTx = tx.hash as string;
      }

      // Railgun derives the shield's encryption key from a signature by the sending address.
      const shieldPrivateKey = keccak256(await wallet.signMessage(getShieldPrivateKeySignatureMessage()));
      const recipients = [{ tokenAddress: SEPOLIA_USDT, amount, recipientAddress: ctx.railgunAddress }];
      const { gasEstimate } = await gasEstimateForShield(
        TXIDVersion.V2_PoseidonMerkle,
        NETWORK,
        shieldPrivateKey,
        recipients,
        [],
        wallet.address,
      );
      const fees = await provider.getFeeData();
      const { transaction } = await populateShield(TXIDVersion.V2_PoseidonMerkle, NETWORK, shieldPrivateKey, recipients, [], {
        evmGasType: EVMGasType.Type2,
        gasEstimate,
        maxFeePerGas: fees.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      });
      const sent = await wallet.sendTransaction(transaction);
      await sent.wait(1);
      return patch(index, { status: 'shielded', approveTx, shieldTx: sent.hash });
    },

    /** New device: rebuild records by checking derived addresses until GAP_LIMIT unused in a row. */
    async rescan() {
      const records = await load();
      const known = new Set(records.map((r) => r.index));
      let gap = 0;
      for (let index = 0; gap < GAP_LIMIT; index++) {
        const address = addressAt(index);
        if (known.has(index)) {
          gap = 0;
          continue;
        }
        const [nonce, tokens] = await Promise.all([
          provider.getTransactionCount(address),
          usdt.balanceOf!(address) as Promise<bigint>,
        ]);
        if (nonce === 0 && tokens === 0n) {
          gap++;
          continue;
        }
        gap = 0;
        const now = Date.now();
        // USDT still sitting there means the deposit wasn't finished.
        records.push({ index, address, status: tokens > 0n ? 'delivered' : 'shielded', createdAt: now, updatedAt: now });
      }
      await save(records);
      return records;
    },
  };
}
