/**
 * Sends and withdrawals in progress, so Notifications can list them and reopen their processing screen in the Send
 * pop-up (Gold, 13 Nov: "You can close this; it keeps going" needs a way back). Kept in memory for this tab only:
 * nothing is stored. Once a send has gone out it shows as "Successful" until the wallet's own history lists it.
 */
import { useSyncExternalStore } from 'react';
import type { SendMode } from './SendPrivately.tsx';

export interface SendJob {
  id: number;
  mode: SendMode;
  /** What the Notifications row says, e.g. "Sending 25 USDT privately to 0zk1qy…". */
  title: string;
  /** Unix seconds. */
  startedAt: number;
  state: 'sending' | 'sent';
  /** Lowercase 0x hash once sent, to hand over to the history row with the same transaction. */
  txHash?: string;
}

let jobs: SendJob[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const sendJobs = {
  start(mode: SendMode, title: string): number {
    const id = nextId++;
    jobs = [...jobs, { id, mode, title, startedAt: Math.round(Date.now() / 1000), state: 'sending' }];
    emit();
    return id;
  },
  sent(id: number, txHash: string) {
    jobs = jobs.map((j) => (j.id === id ? { ...j, state: 'sent', txHash: txHash.toLowerCase() } : j));
    emit();
  },
  /** Refused or failed: the error toast says why, and there's nothing to come back to. */
  drop(id: number) {
    jobs = jobs.filter((j) => j.id !== id);
    emit();
  },
  /** Locking or signing out ends this tab's sends. */
  clear() {
    if (!jobs.length) return;
    jobs = [];
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => jobs,
};

export const useSendJobs = () => useSyncExternalStore(sendJobs.subscribe, sendJobs.get);
