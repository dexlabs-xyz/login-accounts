/**
 * Page-side handle on the Railgun worker. The page never holds the recovery
 * phrase longer than it takes to hand it to the worker.
 */
import { Mnemonic } from 'ethers';
import { DERIVED_KEY_LABELS, deriveKeyMaterial, type Bytes } from '@login/vault';
import type { BalanceBucket, FromWorker } from './protocol.ts';

/**
 * Railgun Proof of Innocence nodes. Empty until the team confirms the URL from
 * Railgun's docs; balances then show as pending POI and sends won't work yet.
 */
const POI_NODE_URLS: string[] = [];

export interface PrivateWalletState {
  status: 'off' | 'starting' | 'syncing' | 'ready' | 'needs-poi' | 'error';
  railgunAddress: string | null;
  scanProgress: number;
  /** Balances by bucket. Amounts in the token's smallest unit, as strings. */
  balances: Partial<Record<BalanceBucket, { tokenAddress: string; amount: string }[]>>;
  error: string | null;
}

const initial: PrivateWalletState = { status: 'off', railgunAddress: null, scanProgress: 0, balances: {}, error: null };
let state: PrivateWalletState = initial;
let worker: Worker | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<PrivateWalletState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const privateWallet = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /** Start the Railgun wallet for this root secret (called when the vault opens). */
  async start(rootSecret: Bytes): Promise<void> {
    privateWallet.stop();
    set({ ...initial, status: 'starting' });
    // BIP-39: the 32-byte root secret is the entropy of a 24-word phrase (never shown).
    const mnemonic = Mnemonic.fromEntropy(rootSecret).phrase;
    const dbKey = await deriveKeyMaterial(rootSecret, DERIVED_KEY_LABELS.railgunDbKey);

    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'railgun' });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'opened') set({ railgunAddress: m.railgunAddress, status: 'syncing' });
      else if (m.type === 'needs-poi') set({ status: 'needs-poi' });
      else if (m.type === 'scan')
        set({ scanProgress: m.progress, status: m.status === 'Complete' ? 'ready' : state.status === 'off' ? 'off' : 'syncing' });
      else if (m.type === 'balances') set({ balances: { ...state.balances, [m.bucket]: m.erc20 } });
      else if (m.type === 'error') {
        if (import.meta.env.DEV && m.detail) console.error('[railgun worker]', m.detail);
        set({ status: 'error', error: m.message });
      }
    };
    worker.onerror = (e) => {
      // Development only: worker load errors are about code, not wallet data.
      if (import.meta.env.DEV) console.error('[railgun worker]', e.message, e.filename, e.lineno);
      set({ status: 'error', error: 'WorkerError' });
    };
    worker.postMessage({ type: 'open', mnemonic, dbKeyHex: toHex(dbKey), poiNodeURLs: POI_NODE_URLS });
    dbKey.fill(0);
    rootSecret.fill(0); // callers pass a copy
  },

  refresh() {
    worker?.postMessage({ type: 'refresh' });
  },

  /** Lock: terminating the worker drops every key it held. */
  stop() {
    worker?.terminate();
    worker = null;
    if (state.status !== 'off') set(initial);
  },
};
