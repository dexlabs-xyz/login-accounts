/**
 * The Railgun wallet, isolated in a Web Worker.
 *
 * Why a worker: this is the only code that holds the recovery phrase, and the
 * Railgun SDK brings a large third-party dependency tree. In a worker it can't
 * read the page, the session cookie or the passkey ceremonies, so a problem in
 * one of those dependencies is contained to the wallet. Locking terminates the
 * worker, which drops every key it held.
 *
 * Everything goes through the official Railgun SDK (team rule). Network use,
 * all directly from this browser to third parties (never to Login's server):
 *   - Sepolia RPC (publicnode): chain reads
 *   - rail-squid.squids.live: quick sync (not specific to this wallet)
 *   - ipfs-lb.com: circuit artifacts and the POI list
 *   - the POI node, when configured
 *
 * TESTNET ONLY: Sepolia.
 */
import './polyfills.ts';
import LevelJS from 'level-js';
import {
  ArtifactStore,
  createRailgunWallet,
  getWalletTransactionHistory,
  loadProvider,
  refreshBalances,
  refreshReceivePOIsForWallet,
  setLoggers,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  startRailgunEngine,
} from '@railgun-community/wallet';
import { NETWORK_CONFIG, NetworkName, TXIDVersion, type RailgunBalancesEvent } from '@railgun-community/shared-models';
import { Mnemonic } from 'ethers';
import { DERIVED_KEY_LABELS, deriveKeyMaterial } from '@login/vault';
import { createDeposits } from './deposits.ts';
import { createSender } from './send.ts';
import { getProver } from '@railgun-community/wallet';
import { groth16 } from 'snarkjs';
import type { FromWorker, HistoryEntry, ToWorker } from './protocol.ts';
import { TransactionHistoryItemCategory, type TransactionHistoryItem } from '@railgun-community/shared-models';

const NETWORK = NetworkName.EthereumSepolia;
const CHAIN = NETWORK_CONFIG[NETWORK].chain;
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const WALLET_SOURCE = 'loginaccounts'; // shown on-chain as the shield source; lowercase, max 16 chars

const post = (m: FromWorker) => self.postMessage(m);
let walletId: string | null = null;
let deposits: ReturnType<typeof createDeposits> | null = null;
let sender: ReturnType<typeof createSender> | null = null;
/** Latest spendable private balances by token (lowercase address), for send checks. */
const spendable = new Map<string, bigint>();
let shieldFeeBasisPoints: string | null = null;
let unshieldFeeBasisPoints: string | null = null;

/**
 * Shields stay "pending" until the wallet fetches their Proof of Innocence
 * result from the POI node, and the SDK doesn't do that by itself. While any
 * received funds are still pending, ask once a minute, then update balances.
 */
const POI_REFRESH_MS = 60_000;
let hasPendingReceive = false;
let poiTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshPOIs() {
  if (!walletId) return;
  try {
    await refreshReceivePOIsForWallet(TXIDVersion.V2_PoseidonMerkle, NETWORK, walletId);
    await refreshBalances(CHAIN, [walletId]);
  } catch {
    // The POI node is a third party and may be slow; try again next round.
  }
}

/**
 * After a shield we sent, the chain indexer may not have it yet, so one
 * refresh can miss it, and the once-a-minute loop above only starts once
 * something pending is visible. So keep refreshing for a while until it shows.
 */
const AFTER_SHIELD_REFRESH_MS = 20_000;
const AFTER_SHIELD_WINDOW_MS = 15 * 60_000;
let expectIncomingUntil = 0;
let incomingTimer: ReturnType<typeof setTimeout> | undefined;

function expectIncoming() {
  expectIncomingUntil = Date.now() + AFTER_SHIELD_WINDOW_MS;
  clearTimeout(incomingTimer);
  const tick = async () => {
    if (!walletId || hasPendingReceive || Date.now() > expectIncomingUntil) return;
    await refreshBalances(CHAIN, [walletId]).catch(() => {});
    incomingTimer = setTimeout(tick, AFTER_SHIELD_REFRESH_MS);
  };
  incomingTimer = setTimeout(tick, AFTER_SHIELD_REFRESH_MS);
}

function schedulePOIRefresh() {
  clearTimeout(poiTimer);
  if (!hasPendingReceive) return;
  poiTimer = setTimeout(async () => {
    await refreshPOIs();
    schedulePOIRefresh();
  }, POI_REFRESH_MS);
}

const errorDetail = (err: unknown) => {
  // Development only, to debug the SDK. Never in production builds.
  if (!import.meta.env.DEV || !(err instanceof Error)) return undefined;
  // Libraries attach the real reason as `cause` (e.g. a broadcaster's refusal).
  const causes: string[] = [];
  for (let c: unknown = err.cause, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    causes.push(`Caused by: ${c instanceof Error ? c.message : String(c)}`);
  }
  return [err.message, ...causes, err.stack ?? ''].join('\n').slice(0, 2000);
};

/**
 * Railgun's history item, cut down to what the History card shows. Leaves out
 * memos, change outputs and the relay's fee (paid from the hidden fee reserve).
 */
function toHistoryEntry(h: TransactionHistoryItem): HistoryEntry {
  const pick = (list: { tokenAddress: string; amount: bigint }[]) =>
    list.filter((a) => a.amount > 0n).map((a) => ({ tokenAddress: a.tokenAddress, amount: a.amount.toString() }));
  const base = { txid: h.txid, timestamp: h.timestamp ?? null, status: null };
  const incoming = (list: TransactionHistoryItem['receiveERC20Amounts']): HistoryEntry['status'] => {
    const buckets = list.filter((a) => a.amount > 0n).map((a) => a.balanceBucket as string);
    if (buckets.includes('ShieldBlocked')) return 'blocked';
    return buckets.every((b) => b === 'Spendable' || b === 'Spent') ? 'spendable' : 'checking';
  };
  switch (h.category) {
    case TransactionHistoryItemCategory.ShieldERC20s:
      return { ...base, kind: 'deposit', amounts: pick(h.receiveERC20Amounts), to: null, status: incoming(h.receiveERC20Amounts) };
    case TransactionHistoryItemCategory.TransferReceiveERC20s:
      return { ...base, kind: 'received', amounts: pick(h.receiveERC20Amounts), to: null, status: incoming(h.receiveERC20Amounts) };
    case TransactionHistoryItemCategory.TransferSendERC20s:
      return { ...base, kind: 'sent', amounts: pick(h.transferERC20Amounts), to: h.transferERC20Amounts[0]?.recipientAddress ?? null };
    case TransactionHistoryItemCategory.UnshieldERC20s:
      return {
        ...base,
        kind: 'withdrew',
        amounts: pick(h.unshieldERC20Amounts),
        fees: h.unshieldERC20Amounts.filter((a) => a.unshieldFee).map((a) => ({ tokenAddress: a.tokenAddress, amount: a.unshieldFee! })),
        to: h.unshieldERC20Amounts[0]?.recipientAddress ?? null,
      };
    default: {
      const all = [...h.receiveERC20Amounts, ...h.transferERC20Amounts, ...h.unshieldERC20Amounts];
      return { ...base, kind: 'other', amounts: pick(all), to: null };
    }
  }
}

// ---------- circuit artifacts, cached in IndexedDB (public files, not secret) ----------

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('login-railgun-artifacts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('files', mode).objectStore('files'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const artifactStore = new ArtifactStore(
  async (path) => ((await idbDo('readonly', (s) => s.get(path))) as string | Buffer | undefined) ?? null,
  async (_dir, path, item) => void (await idbDo('readwrite', (s) => s.put(item, path))),
  async (path) => (await idbDo('readonly', (s) => s.count(path))) > 0,
);

// ---------- engine ----------

let engineStarted: Promise<void> | null = null;

function startEngine(poiNodeURLs: string[]) {
  engineStarted ??= (async () => {
    // Never log from the SDK: messages could include wallet details.
    setLoggers(undefined, undefined);
    await startRailgunEngine(
      WALLET_SOURCE,
      new LevelJS('login-railgun'), // IndexedDB; wallet data inside is encrypted with the derived DB key
      false,
      artifactStore,
      false, // browser: use downloaded (not native) artifacts
      false,
      poiNodeURLs.length > 0 ? poiNodeURLs : undefined,
    );
    // Zero-knowledge proofs for private sends are generated in this worker.
    getProver().setSnarkJSGroth16(groth16 as Parameters<ReturnType<typeof getProver>['setSnarkJSGroth16']>[0]);
    setOnUTXOMerkletreeScanCallback((e) =>
      post({ type: 'scan', status: e.scanStatus as 'Started', progress: e.progress }),
    );
    setOnBalanceUpdateCallback((e: RailgunBalancesEvent) => {
      if (e.railgunWalletID !== walletId) return;
      if (e.balanceBucket === 'Spendable') {
        spendable.clear();
        for (const a of e.erc20Amounts) spendable.set(a.tokenAddress.toLowerCase(), a.amount);
      }
      if (e.balanceBucket === 'ShieldPending' || e.balanceBucket === 'MissingExternalPOI') {
        const pending = e.erc20Amounts.some((a) => a.amount > 0n);
        if (pending !== hasPendingReceive) {
          hasPendingReceive = pending;
          schedulePOIRefresh();
        }
      }
      post({
        type: 'balances',
        bucket: e.balanceBucket as 'Spendable',
        erc20: e.erc20Amounts.map((a) => ({ tokenAddress: a.tokenAddress, amount: a.amount.toString() })),
      });
    });
  })();
  return engineStarted;
}

// ---------- messages ----------

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'open') {
      await startEngine(msg.poiNodeURLs);
      // Deterministic: the same phrase and key give the same wallet every time.
      // Needs no network: the address comes from the keys alone.
      // The phrase and DB key exist only here, in the worker.
      const rootSecret = new Uint8Array(msg.rootSecret);
      // BIP-39: the 32-byte root secret is the entropy of a 24-word phrase (never shown).
      const mnemonic = Mnemonic.fromEntropy(rootSecret).phrase;
      const dbKey = await deriveKeyMaterial(rootSecret, DERIVED_KEY_LABELS.railgunDbKey);
      const recordsKey = await deriveKeyMaterial(rootSecret, DERIVED_KEY_LABELS.depositRecordsKey);
      rootSecret.fill(0);
      const dbKeyHex = Array.from(dbKey, (x) => x.toString(16).padStart(2, '0')).join('');
      dbKey.fill(0);
      const info = await createRailgunWallet(dbKeyHex, mnemonic, undefined);
      walletId = info.id;
      post({ type: 'opened', railgunAddress: info.railgunAddress });
      // The phrase and records key stay in this worker's memory for deposits; gone when it terminates.
      deposits = createDeposits({
        mnemonic,
        recordsKey,
        railgunAddress: info.railgunAddress,
        walletId: info.id,
        rpcUrl: SEPOLIA_RPC,
        onChange: (records) => post({ type: 'deposits', records }),
      });
      post({ type: 'deposits', records: await deposits.list() });
      sender = createSender({
        walletId: info.id,
        encryptionKey: dbKeyHex,
        rpcUrl: SEPOLIA_RPC,
        spendable: () => spendable,
        unshieldFeeBasisPoints: () => (unshieldFeeBasisPoints === null ? null : BigInt(unshieldFeeBasisPoints)),
        ownDepositAddresses: async () => new Set((await deposits!.list()).map((r) => r.address.toLowerCase())),
        depositFunders: async () => new Set((await deposits!.list()).flatMap((r) => r.funders ?? [])),
        onProgress: (progress) => post({ type: 'send-progress', progress }),
        onRetry: (attempt) => post({ type: 'send-retry', attempt }),
      });

      // Sepolia requires a Proof of Innocence node before the SDK will read the chain.
      if (msg.poiNodeURLs.length === 0) {
        post({ type: 'needs-poi' });
        return;
      }
      const { feesSerialized } = await loadProvider(
        { chainId: CHAIN.id, providers: [{ provider: SEPOLIA_RPC, priority: 1, weight: 2, maxLogsPerBatch: 10 }] },
        NETWORK,
        15_000,
      );
      shieldFeeBasisPoints = feesSerialized.shieldFeeV2;
      unshieldFeeBasisPoints = feesSerialized.unshieldFeeV2;
      // Starts this wallet's balance scan (loading the provider alone doesn't).
      await refreshBalances(CHAIN, [info.id]);
      // Fetch any Proof of Innocence results that arrived while the wallet was locked.
      await refreshPOIs();
    } else if (msg.type === 'refresh' && walletId) {
      await refreshBalances(CHAIN, [walletId]);
      await refreshPOIs();
    } else if (msg.type === 'call') {
      try {
        if (!deposits) throw new Error('Wallet not open.');
        const value = await (async () => {
          switch (msg.method) {
            case 'deposit.next':
              return deposits.next();
            case 'deposit.list':
              return deposits.list();
            case 'deposit.update':
              return deposits.update(msg.params);
            case 'deposit.balances':
              return deposits.balances(msg.params);
            case 'deposit.shield': {
              const r = await deposits.shield(msg.params);
              if (walletId) void refreshBalances(CHAIN, [walletId]);
              expectIncoming();
              return r;
            }
            case 'deposit.transfer':
              return deposits.transfer(msg.params);
            case 'deposit.rescan':
              return deposits.rescan();
            case 'fees':
              return { shieldFeeBasisPoints, unshieldFeeBasisPoints };
            case 'send.quote':
              if (!sender) throw new Error('Wallet not open.');
              return await sender.quote(msg.params).catch((e: unknown) => {
                // The last transaction hasn't shown up in this wallet yet: rescan, so the next Review works.
                if (e instanceof Error && e.name === 'still-confirming' && walletId) void refreshBalances(CHAIN, [walletId]);
                throw e;
              });
            case 'history':
              if (!walletId) throw new Error('Wallet not open.');
              return (await getWalletTransactionHistory(CHAIN, walletId, undefined)).map(toHistoryEntry);
            case 'send.execute': {
              if (!sender) throw new Error('Wallet not open.');
              const r = await sender.execute(msg.params);
              if (walletId) void refreshBalances(CHAIN, [walletId]);
              return r;
            }
          }
        })();
        post({ type: 'result', id: msg.id, ok: true, value });
      } catch (err) {
        post({
          type: 'result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.name : 'Error',
          detail: errorDetail(err),
          // A broadcaster's own refusal text, already cleaned (send.ts refusalReason); never wallet data.
          reason: err instanceof Error && 'reason' in err && typeof err.reason === 'string' ? err.reason : undefined,
        });
      }
      return;
    }
  } catch (err) {
    // Only a generic description: never the SDK's message, which could include wallet details.
    post({
      type: 'error',
      message: err instanceof Error ? err.name : 'Error',
      detail: errorDetail(err),
    });
  }
};
