/**
 * Deposits that haven't finished, for the Notifications list (Gold, 12 Nov: ongoing transactions stay there so
 * they can be resumed any time). Read from the deposit records on this device, like the rest of the wallet.
 */
import { useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import type { DepositRecord } from '../railgun/protocol.ts';
import { depositProgress, track } from './flow.ts';
import { CHAIN_NAMES, type OriginChain } from './tidepool.ts';
import { stageText } from './AddMoney.tsx';
import { useSendJobs } from '../send/jobs.ts';
import type { SendMode } from '../send/SendPrivately.tsx';

export interface PendingItem {
  key: string;
  title: string;
  detail: string;
  /** Unix seconds, for sorting and the date line. */
  when: number;
  /**
   * "Resume" reopens the deposit's address; "Finish" moves money that arrived into the private balance; "View"
   * reopens the screen of something still being processed (Gold, 13 Nov).
   */
  action: { label: 'Resume' | 'Finish' | 'View'; run: () => void } | null;
  /** Finished: the row says "Successful" until the wallet's history lists the same transaction (`doneTx`). */
  done?: boolean;
  doneTx?: string;
  /** Etherscan, once there's a transaction to show. */
  href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function titleOf(d: DepositRecord): string {
  if (d.withdrawal) return `Refund of a withdrawal (${d.withdrawal.symbol} on ${CHAIN_NAMES[d.withdrawal.chain as OriginChain] ?? d.withdrawal.chain})`;
  if (d.quote?.anyToken) return 'Deposit on Ethereum Sepolia';
  if (d.quote) return `${d.quote.amountInFormatted || d.quote.amountIn} ${d.quote.originSymbol} from ${CHAIN_NAMES[d.quote.originChain as OriginChain]}`;
  return `Deposit #${d.index + 1}`;
}

export function usePendingDeposits(onResume: (index: number) => void): PendingItem[] {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  useSyncExternalStore(depositProgress.subscribe, depositProgress.version);
  const now = Date.now();
  const items: PendingItem[] = [];
  for (const d of pw.deposits) {
    const stage = depositProgress.get(d.index);
    // Finished while you watched: "Successful" (not a screen to resume) until the history row takes over.
    if (stage?.kind === 'done' && d.shieldTx) {
      items.push({
        key: `deposit-${d.index}`,
        title: titleOf(d),
        detail: 'Etherscan',
        href: `https://sepolia.etherscan.io/tx/${d.shieldTx}`,
        when: Math.round((d.updatedAt || d.createdAt) / 1000),
        action: null,
        done: true,
        doneTx: d.shieldTx.toLowerCase(),
      });
      continue;
    }
    const canFinish = stage?.kind === 'needs-finish' || stage?.kind === 'late-funds' || (stage?.kind === 'failed' && d.status === 'delivered');
    if (!canFinish && ['new', 'shielded', 'refunded', 'failed'].includes(d.status)) continue;
    const waiting = d.status === 'awaiting-delivery';
    // An address nobody paid into is only worth resuming while it's still open.
    if (waiting && !canFinish) {
      if (d.quote?.anyToken && now - d.createdAt > DAY_MS) continue;
      if (d.quote && !d.quote.anyToken && !d.quote.direct && Date.parse(d.quote.deadline) < now && (!stage || (stage.kind === 'waiting-payment' && stage.swap === 'PENDING_DEPOSIT'))) continue;
    }
    items.push({
      key: `deposit-${d.index}`,
      title: titleOf(d),
      detail: waiting && !canFinish ? 'Waiting for your payment' : stageText(stage, d),
      when: Math.round((d.updatedAt || d.createdAt) / 1000),
      action: canFinish
        ? { label: 'Finish', run: () => void track({ ...d, status: 'delivered' }) }
        : waiting && !d.withdrawal
          ? { label: 'Resume', run: () => onResume(d.index) }
          : !d.withdrawal && d.quote
            ? { label: 'View', run: () => onResume(d.index) } // being processed: reopen its Receive screen
            : null,
    });
  }
  return items.sort((a, b) => b.when - a.when);
}

/** Sends and withdrawals from this tab (send/jobs.ts): "View" reopens the Send pop-up on their screen. */
export function usePendingSends(onView: (mode: SendMode) => void): PendingItem[] {
  const jobs = useSendJobs();
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const progress = pw.sendProgress === null || pw.sendProgress < 100 ? `Creating the privacy proof… ${Math.round(pw.sendProgress ?? 0)}%` : 'Submitting through the network relay…';
  return jobs
    .map((j): PendingItem =>
      j.state === 'sent'
        ? { key: `send-${j.id}`, title: j.title.replace(/^Sending /, 'Sent ').replace(/^Withdrawing /, 'Withdrew '), detail: 'Etherscan', href: `https://sepolia.etherscan.io/tx/${j.txHash}`, when: j.startedAt, action: null, done: true, doneTx: j.txHash }
        : { key: `send-${j.id}`, title: j.title, detail: progress, when: j.startedAt, action: { label: 'View', run: () => onView(j.mode) } },
    )
    .sort((a, b) => b.when - a.when);
}
