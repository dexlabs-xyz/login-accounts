/**
 * Page-side handle on the Railgun worker. The page never sees the recovery
 * phrase or the Railgun DB key: it transfers the root secret to the worker,
 * which wipes the page's copy, and the worker derives both.
 */
import type { Bytes } from '@login/vault';
import type { BalanceBucket, DepositMethod, DepositRecord, FromWorker } from './protocol.ts';

/**
 * Railgun Proof of Innocence aggregator nodes, in priority order. Sepolia
 * requires one before the SDK reads the chain. This is the public node run by
 * the community, as given in Railgun's docs: a third party, so its responses
 * are untrusted input, and it sees the user's IP and the blinded commitments
 * the wallet asks about.
 */
const POI_NODE_URLS: string[] = ['https://ppoi.fdi.network'];

export interface PrivateWalletState {
  status: 'off' | 'starting' | 'syncing' | 'ready' | 'needs-poi' | 'error';
  railgunAddress: string | null;
  scanProgress: number;
  /**
   * A background re-scan after the first full sync (Railgun re-checks while
   * deposits clear). The wallet stays 'ready' and usable meanwhile.
   */
  refreshing: boolean;
  /** Balances by bucket. Amounts in the token's smallest unit, as strings. */
  balances: Partial<Record<BalanceBucket, { tokenAddress: string; amount: string }[]>>;
  error: string | null;
  /** This device's deposit records (decrypted inside the worker). */
  deposits: DepositRecord[];
  /** Proof generation progress for a private send in flight (0..100), or null. */
  sendProgress: number | null;
  /** How many broadcasters refused the send in flight (the next one is being tried). */
  sendRetries: number;
}

const initial: PrivateWalletState = {
  status: 'off',
  railgunAddress: null,
  scanProgress: 0,
  refreshing: false,
  balances: {},
  error: null,
  deposits: [],
  sendProgress: null,
  sendRetries: 0,
};
let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let state: PrivateWalletState = initial;
let worker: Worker | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<PrivateWalletState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}


export const privateWallet = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /** Start the Railgun wallet for this root secret (called when the vault opens). */
  start(rootSecret: Bytes): void {
    privateWallet.stop();
    set({ ...initial, status: 'starting' });
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'railgun' });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'opened') set({ railgunAddress: m.railgunAddress, status: 'syncing' });
      else if (m.type === 'needs-poi') set({ status: 'needs-poi' });
      else if (m.type === 'scan') {
        // Only the first sync makes the wallet wait. Later re-scans run in the
        // background: Send and Withdraw stay on screen while they do.
        if (state.status === 'ready') set({ scanProgress: m.progress, refreshing: m.status !== 'Complete' });
        else set({ scanProgress: m.progress, status: m.status === 'Complete' ? 'ready' : state.status === 'off' ? 'off' : 'syncing' });
      }
      else if (m.type === 'balances') set({ balances: { ...state.balances, [m.bucket]: m.erc20 } });
      else if (m.type === 'deposits') set({ deposits: m.records });
      else if (m.type === 'send-progress') set({ sendProgress: m.progress });
      else if (m.type === 'send-retry') set({ sendRetries: m.attempt, sendProgress: null });
      else if (m.type === 'result') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.ok) p?.resolve(m.value);
        else {
          const err = new Error(m.error) as Error & { reason?: string };
          if (m.reason) err.reason = m.reason;
          if (import.meta.env.DEV && m.detail) {
            console.error('[railgun worker]', m.detail);
            // Development only, so testers can copy it from the screen. Never in production builds.
            (err as Error & { devDetail?: string }).devDetail = m.detail;
          }
          p?.reject(err);
        }
      }
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
    // Transfer, not copy: after this line the page's buffer is empty (detached).
    const secret = rootSecret.buffer.slice(rootSecret.byteOffset, rootSecret.byteOffset + rootSecret.byteLength);
    rootSecret.fill(0); // callers pass a copy
    worker.postMessage({ type: 'open', rootSecret: secret, poiNodeURLs: POI_NODE_URLS }, [secret]);
  },

  refresh() {
    worker?.postMessage({ type: 'refresh' });
  },

  clearSendProgress() {
    set({ sendProgress: null, sendRetries: 0 });
  },

  /** Ask the worker to do something (deposits, sends). Rejects if the wallet is locked. */
  call<T>(method: DepositMethod, params?: unknown): Promise<T> {
    if (!worker) return Promise.reject(new Error('Wallet locked.'));
    const id = nextCallId++;
    const w = worker;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ type: 'call', id, method, params });
    });
  },

  /** Lock: terminating the worker drops every key it held. */
  stop() {
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(new Error('Wallet locked.'));
    pending.clear();
    if (state.status !== 'off') set(initial);
  },
};
