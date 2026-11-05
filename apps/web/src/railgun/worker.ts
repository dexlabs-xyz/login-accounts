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
import type { FromWorker, ToWorker } from './protocol.ts';

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

function schedulePOIRefresh() {
  clearTimeout(poiTimer);
  if (!hasPendingReceive) return;
  poiTimer = setTimeout(async () => {
    await refreshPOIs();
    schedulePOIRefresh();
  }, POI_REFRESH_MS);
}

const errorDetail = (err: unknown) =>
  // Development only, to debug the SDK. Never in production builds.
  import.meta.env.DEV && err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.slice(0, 1500) : undefined;

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
        rpcUrl: SEPOLIA_RPC,
        onChange: (records) => post({ type: 'deposits', records }),
      });
      post({ type: 'deposits', records: await deposits.list() });
      sender = createSender({
        walletId: info.id,
        encryptionKey: dbKeyHex,
        rpcUrl: SEPOLIA_RPC,
        spendable: () => spendable,
        onProgress: (progress) => post({ type: 'send-progress', progress }),
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
              return r;
            }
            case 'deposit.rescan':
              return deposits.rescan();
            case 'fees':
              return { shieldFeeBasisPoints };
            case 'send.quote':
              if (!sender) throw new Error('Wallet not open.');
              return sender.quote(msg.params);
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
        post({ type: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.name : 'Error', detail: errorDetail(err) });
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
