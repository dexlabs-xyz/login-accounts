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

export interface PendingItem {
  key: string;
  title: string;
  detail: string;
  /** Unix seconds, for sorting and the date line. */
  when: number;
  /** "Resume" reopens the deposit's address; "Finish" moves money that arrived into the private balance. */
  action: { label: 'Resume' | 'Finish'; run: () => void } | null;
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
          : null,
    });
  }
  return items.sort((a, b) => b.when - a.when);
}
