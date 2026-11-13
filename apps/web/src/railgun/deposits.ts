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
  gasEstimateForShieldBaseToken,
  getShieldPrivateKeySignatureMessage,
  populateShield,
  populateShieldBaseToken,
} from '@railgun-community/wallet';
import { EVMGasType, NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models';
import { Contract, HDNodeWallet, JsonRpcProvider, getAddress, isAddress, keccak256, zeroPadValue, ZeroAddress, type Provider } from 'ethers';
import { openJson, sealJson, type Bytes, type SealedJson } from '@login/vault';
import {
  DEPOSIT_ETH_GAS_KEEP_WEI,
  SEPOLIA_USDC,
  SEPOLIA_USDT,
  SEPOLIA_WETH,
  type DepositRecord,
  type DepositStatus,
  type DepositSwap,
} from './protocol.ts';

const NETWORK = NetworkName.EthereumSepolia;
const RAILGUN_PROXY = NETWORK_CONFIG[NETWORK].proxyContract;
// Must match Railgun's own config (checked at startup below).
if (NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress.toLowerCase() !== SEPOLIA_WETH.toLowerCase()) {
  throw new Error('Railgun WETH address changed; update SEPOLIA_WETH.');
}
/** Don't bother shielding leftover ETH below this (0.0005 ETH). */
const MIN_FEE_SHIELD_WEI = 500_000_000_000_000n;
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
/** Stop scanning after this many unused addresses in a row (like standard wallets). */
const GAP_LIMIT = 20;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The public RPC keeps logs for about 10,000 blocks (~1.4 days) and caps a query there too. */
const LOG_WINDOW_BLOCKS = 9_000;
/** Look for who sent ETH only across short gaps between two balance checks. */
const ETH_SCAN_MAX_BLOCKS = 30;
const RECORDS_PURPOSE = 'deposit-records';

export interface DepositContext {
  mnemonic: string;
  recordsKey: Bytes;
  railgunAddress: string;
  /** Railgun's wallet id: names this account's records slot (several accounts can share a browser). */
  walletId: string;
  rpcUrl: string;
  onChange: (records: DepositRecord[]) => void;
}

const pathFor = (index: number) => `m/44'/60'/0'/0/${index}`;

/** Senders of ERC-20 Transfer logs (topic 1), lowercase. Pure, for tests. */
export function sendersFromLogs(logs: readonly { topics: readonly string[] }[]): string[] {
  return logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics[1]).map((l) => `0x${l.topics[1]!.slice(-40)}`.toLowerCase());
}
/** Senders of plain transactions to `address`, lowercase. Pure, for tests. */
export function sendersOfTxs(txs: readonly { from: string; to: string | null; value: bigint }[], address: string): string[] {
  const to = address.toLowerCase();
  return txs.filter((t) => t.to?.toLowerCase() === to && t.value > 0n).map((t) => t.from.toLowerCase());
}
const union = (a: readonly string[] | undefined, b: readonly string[]) => [...new Set([...(a ?? []), ...b])];

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

/** Before 8 Nov 2026 every account in a browser used this one slot. */
export const LEGACY_RECORDS_SLOT = 'records';
export const recordsSlot = (walletId: string) => `records:${walletId}`;

interface SlotStore<S> {
  get(slot: string): Promise<S | undefined>;
  put(slot: string, value: S): Promise<void>;
  remove(slot: string): Promise<void>;
}

/**
 * This account's sealed records, or null if it has none yet. Records in the
 * old shared slot move to this account's slot only if this account's key opens
 * them; otherwise they belong to another account on this browser, which moves
 * them when it next unlocks. Pure over a small store, for tests.
 */
export async function loadSealedRecords<S, T>(store: SlotStore<S>, slot: string, open: (sealed: S) => Promise<T>): Promise<T | null> {
  const own = await store.get(slot);
  if (own !== undefined) return open(own);
  const legacy = await store.get(LEGACY_RECORDS_SLOT);
  if (legacy === undefined) return null;
  let records: T;
  try {
    records = await open(legacy);
  } catch {
    return null; // another account's records
  }
  await store.put(slot, legacy);
  await store.remove(LEGACY_RECORDS_SLOT);
  return records;
}

const idbSlots: SlotStore<SealedJson> = {
  get: (slot) => kv('readonly', (s) => s.get(slot)) as Promise<SealedJson | undefined>,
  put: async (slot, value) => void (await kv('readwrite', (s) => s.put(value, slot))),
  remove: async (slot) => void (await kv('readwrite', (s) => s.delete(slot))),
};

export function createDeposits(ctx: DepositContext) {
  const provider: Provider = new JsonRpcProvider(ctx.rpcUrl);
  const usdt = new Contract(SEPOLIA_USDT, ERC20, provider);
  // Accepted only because people send it by mistake: it goes in as private USDC.
  const usdc = new Contract(SEPOLIA_USDC, ERC20, provider);
  const DEPOSIT_TOKENS = [
    { address: SEPOLIA_USDT, contract: usdt },
    { address: SEPOLIA_USDC, contract: usdc },
  ];
  let cache: DepositRecord[] | null = null;

  const addressAt = (index: number) => HDNodeWallet.fromPhrase(ctx.mnemonic, undefined, pathFor(index)).address;

  async function load(): Promise<DepositRecord[]> {
    if (cache) return cache;
    const slot = recordsSlot(ctx.walletId);
    cache = (await loadSealedRecords(idbSlots, slot, (sealed) => openJson<DepositRecord[]>(ctx.recordsKey, RECORDS_PURPOSE, sealed))) ?? [];
    return cache;
  }
  async function save(records: DepositRecord[]) {
    cache = records.sort((a, b) => a.index - b.index);
    const sealed = await sealJson(ctx.recordsKey, RECORDS_PURPOSE, cache);
    await idbSlots.put(recordsSlot(ctx.walletId), sealed);
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

  /**
   * Note who sent tokens to a deposit address, from public Transfer logs. Asks
   * the RPC only for transfers *into* this address (which it already sees us
   * watching), never about any withdraw address. Best effort: never blocks a deposit.
   */
  async function noteTokenFunders(r: DepositRecord) {
    try {
      const latest = await provider.getBlockNumber();
      const fromBlock = Math.max(latest - LOG_WINDOW_BLOCKS, (r.fundersCheckedBlock ?? 0) + 1);
      if (fromBlock > latest) return;
      const logs = await provider.getLogs({
        address: DEPOSIT_TOKENS.map((t) => t.address),
        topics: [TRANSFER_TOPIC, null, zeroPadValue(r.address, 32)],
        fromBlock,
        toBlock: latest,
      });
      await patch(r.index, { funders: union(r.funders, sendersFromLogs(logs)), fundersCheckedBlock: latest });
    } catch {
      // The warning is a convenience; the review screen's general advice still applies.
    }
  }

  /** Last balance check per deposit, to spot ETH arriving and find who sent it. Memory only. */
  const lastEth = new Map<number, { block: number; eth: bigint }>();
  async function noteEthFunders(r: DepositRecord, eth: bigint, block: number) {
    const prev = lastEth.get(r.index);
    lastEth.set(r.index, { block, eth });
    if (!prev || eth <= prev.eth || block - prev.block > ETH_SCAN_MAX_BLOCKS) return;
    try {
      const found: string[] = [];
      // A little margin: load-balanced RPC nodes can lag each other by a block or two.
      for (let n = Math.max(0, prev.block - 2); n <= block; n++) {
        const b = await provider.getBlock(n, true);
        found.push(...sendersOfTxs(b?.prefetchedTransactions ?? [], r.address));
      }
      if (found.length) await patch(r.index, { funders: union(r.funders, found) });
    } catch {
      // Best effort, as above.
    }
  }

  /** Has this address ever been used? Any nonce, ETH, USDT or USDC counts. */
  async function used(address: string) {
    const [nonce, eth, a, b] = await Promise.all([
      provider.getTransactionCount(address),
      provider.getBalance(address),
      usdt.balanceOf!(address) as Promise<bigint>,
      usdc.balanceOf!(address) as Promise<bigint>,
    ]);
    return nonce > 0 || eth > 0n || a > 0n || b > 0n;
  }

  /** Shield (balance - gas for this transaction) of ETH as WETH. Returns the tx hash, or null if too little. */
  async function shieldLeftoverEth(wallet: HDNodeWallet, shieldPrivateKey: string): Promise<string | null> {
    const fees = await provider.getFeeData();
    const maxFee = fees.maxFeePerGas ?? 0n;
    const balance = await provider.getBalance(wallet.address);
    const probe = { tokenAddress: SEPOLIA_WETH, amount: balance / 2n };
    const { gasEstimate } = await gasEstimateForShieldBaseToken(
      TXIDVersion.V2_PoseidonMerkle,
      NETWORK,
      ctx.railgunAddress,
      shieldPrivateKey,
      probe,
      wallet.address,
    );
    // Keep a 30% margin on gas so the transaction can't fail for lack of funds.
    const reserve = (gasEstimate * maxFee * 13n) / 10n;
    const amount = balance - reserve;
    if (amount < MIN_FEE_SHIELD_WEI) return null;
    const { transaction } = await populateShieldBaseToken(
      TXIDVersion.V2_PoseidonMerkle,
      NETWORK,
      ctx.railgunAddress,
      shieldPrivateKey,
      { tokenAddress: SEPOLIA_WETH, amount },
      { evmGasType: EVMGasType.Type2, gasEstimate, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n },
    );
    const sent = await wallet.sendTransaction(transaction);
    await sent.wait(1);
    return sent.hash;
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
      const { index, status, quote, userEthWei, swaps, withdrawal } = params as {
        index: number;
        status?: DepositStatus;
        quote?: DepositRecord['quote'];
        userEthWei?: string;
        swaps?: DepositSwap[];
        withdrawal?: DepositRecord['withdrawal'];
      };
      const allowed: DepositStatus[] = ['awaiting-delivery', 'delivered', 'refunded', 'failed'];
      if (status && !allowed.includes(status)) throw new Error('Status not allowed from the page.');
      if (userEthWei !== undefined && !/^\d+$/.test(userEthWei)) throw new Error('Bad amount.');
      return patch(index, {
        ...(status ? { status } : {}),
        ...(quote ? { quote } : {}),
        ...(userEthWei !== undefined ? { userEthWei } : {}),
        ...(swaps ? { swaps } : {}),
        ...(withdrawal ? { withdrawal } : {}),
      });
    },

    /**
     * EVM deposits: send this deposit address's USDC or ETH to a Tidepool swap
     * address (the swap brings USDT back to the same address). Never more than
     * the address holds; for ETH, never so much that it can't pay for its own
     * remaining transactions.
     */
    async transfer(params: unknown) {
      const { index, token, to, amount: amountText } = params as { index: number; token: string; to: string; amount: string };
      const r = (await load()).find((x) => x.index === index);
      if (!r) throw new Error('Unknown deposit.');
      if (typeof to !== 'string' || !isAddress(to) || getAddress(to) === ZeroAddress || getAddress(to) === getAddress(r.address)) {
        throw new Error('Bad destination.');
      }
      if (typeof amountText !== 'string' || !/^\d+$/.test(amountText) || BigInt(amountText) === 0n) throw new Error('Bad amount.');
      const amount = BigInt(amountText);
      const wallet = HDNodeWallet.fromPhrase(ctx.mnemonic, undefined, pathFor(index)).connect(provider);
      if (token === 'ETH') {
        if ((await provider.getBalance(wallet.address)) < amount + DEPOSIT_ETH_GAS_KEEP_WEI) throw new Error('Not enough ETH.');
        const tx = await wallet.sendTransaction({ to: getAddress(to), value: amount });
        await tx.wait(1);
        return { txHash: tx.hash };
      }
      if (token === 'USDC') {
        const c = usdc.connect(wallet) as Contract;
        if (((await c.balanceOf!(wallet.address)) as bigint) < amount) throw new Error('Not enough USDC.');
        const tx = await c.transfer!(getAddress(to), amount);
        await tx.wait(1);
        return { txHash: tx.hash as string };
      }
      throw new Error('Unsupported token.');
    },

    async balances(params: unknown) {
      const { index } = params as { index: number };
      const r = (await load()).find((x) => x.index === index);
      if (!r) throw new Error('Unknown deposit.');
      const [eth, a, b] = await Promise.all([
        provider.getBalance(r.address),
        usdt.balanceOf!(r.address) as Promise<bigint>,
        usdc.balanceOf!(r.address) as Promise<bigint>,
      ]);
      void provider.getBlockNumber().then((block) => noteEthFunders(r, eth, block), () => {});
      return { eth: eth.toString(), usdt: a.toString(), usdc: b.toString() };
    },

    /**
     * Move the USDT at a deposit address into the private balance: approve
     * exactly the amount (never unlimited), then shield to this wallet's 0zk
     * address. Both transactions are signed here and paid by the address itself.
     * USDC sent by mistake goes in too, as private USDC, in the same shield.
     */
    async shield(params: unknown) {
      const { index } = params as { index: number };
      const r = (await load()).find((x) => x.index === index);
      if (!r) throw new Error('Unknown deposit.');
      const wallet = HDNodeWallet.fromPhrase(ctx.mnemonic, undefined, pathFor(index)).connect(provider);
      await noteTokenFunders(r); // while the public logs still have the deposit
      const held = (
        await Promise.all(
          DEPOSIT_TOKENS.map(async (t) => ({ ...t, amount: (await t.contract.balanceOf!(wallet.address)) as bigint })),
        )
      ).filter((t) => t.amount > 0n);
      if (held.length === 0) {
        // EVM deposit of a little ETH only: it all becomes the hidden fee reserve.
        if ((await provider.getBalance(wallet.address)) < MIN_FEE_SHIELD_WEI) throw new Error('Nothing to shield yet.');
        await patch(index, { status: 'shielding' });
        const key = keccak256(await wallet.signMessage(getShieldPrivateKeySignatureMessage()));
        const feeShieldTx = await shieldLeftoverEth(wallet, key);
        return patch(index, { status: 'shielded', ...(feeShieldTx ? { feeShieldTx } : {}) });
      }
      await patch(index, { status: 'shielding' });

      let approveTx: string | undefined;
      for (const t of held) {
        const token = t.contract.connect(wallet) as Contract;
        const allowance = async () => (await token.allowance!(wallet.address, RAILGUN_PROXY)) as bigint;
        if ((await allowance()) < t.amount) {
          const tx = await token.approve!(RAILGUN_PROXY, t.amount);
          await tx.wait(1);
          approveTx ??= tx.hash as string;
          // The public RPC balances requests across nodes; one may not have seen
          // the approval yet. Wait until the allowance is visible before estimating.
          for (let i = 0; (await allowance()) < t.amount; i++) {
            if (i >= 30) throw new Error('Approval not visible yet.');
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }
      }

      // Railgun derives the shield's encryption key from a signature by the sending address.
      const shieldPrivateKey = keccak256(await wallet.signMessage(getShieldPrivateKeySignatureMessage()));
      const recipients = held.map((t) => ({ tokenAddress: t.address, amount: t.amount, recipientAddress: ctx.railgunAddress }));
      const estimate = () =>
        gasEstimateForShield(TXIDVersion.V2_PoseidonMerkle, NETWORK, shieldPrivateKey, recipients, [], wallet.address);
      // Retries: a lagging RPC node can still fail the estimate ("allowance" revert seen live 13 Nov 2026,
      // after the approval was visible on another node). Nothing is sent by an estimate.
      const { gasEstimate } = await estimate().catch(async () => {
        for (let i = 0; ; i++) {
          await new Promise((r) => setTimeout(r, 5_000));
          try {
            return await estimate();
          } catch (e) {
            if (i >= 3) throw e;
          }
        }
      });
      const fees = await provider.getFeeData();
      const { transaction } = await populateShield(TXIDVersion.V2_PoseidonMerkle, NETWORK, shieldPrivateKey, recipients, [], {
        evmGasType: EVMGasType.Type2,
        gasEstimate,
        maxFeePerGas: fees.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      });
      const sent = await wallet.sendTransaction(transaction);
      await sent.wait(1);
      const done = await patch(index, {
        status: 'shielded',
        approveTx,
        shieldTx: sent.hash,
        shieldedTokens: held.map((t) => ({ token: t.address, amount: t.amount.toString() })),
      });

      // Best effort: shield the address's leftover ETH as WETH, so the private
      // balance can pay broadcaster fees for private sends (no public address
      // ever pays for a send). A failure here doesn't affect the deposit.
      try {
        const feeShieldTx = await shieldLeftoverEth(wallet, shieldPrivateKey);
        if (feeShieldTx) return patch(index, { feeShieldTx });
      } catch {
        // Leave the ETH where it is; the user's deposit is complete.
      }
      return done;
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
