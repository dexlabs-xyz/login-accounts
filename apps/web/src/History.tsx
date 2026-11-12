/**
 * History: deposits, private sends and receipts, and withdrawals.
 *
 * Built by the wallet worker from Railgun's own transaction history, decrypted
 * with this wallet's keys on this device (no request to Login's server, no new
 * data stored). It shows only while the wallet is unlocked, like the balance.
 * Withdrawals swapped through NEAR Intents are matched to their record (by
 * Tidepool's one-time address) to show the token and the user's own address.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { privateWallet } from './railgun/client.ts';
import { SEPOLIA_USDC, SEPOLIA_USDT, SEPOLIA_WETH, USDC_DECIMALS, USDT_DECIMALS, type HistoryEntry, type WithdrawalSwap } from './railgun/protocol.ts';
import { formatUnits } from './deposits/tidepool.ts';
import { usd } from './money.ts';
import type { PendingItem } from './deposits/pending.ts';

const TOKENS: Record<string, { label: string; decimals: number }> = {
  [SEPOLIA_USDT.toLowerCase()]: { label: 'USDT', decimals: USDT_DECIMALS },
  [SEPOLIA_USDC.toLowerCase()]: { label: 'USDC', decimals: USDC_DECIMALS },
  [SEPOLIA_WETH.toLowerCase()]: { label: 'ETH', decimals: 18 },
};
const WETH = SEPOLIA_WETH.toLowerCase();
const CHAINS: Record<string, string> = { eth: 'Ethereum Sepolia', base: 'Base Sepolia', arb: 'Arbitrum Sepolia', sol: 'Solana devnet' };

/** Newest first; entries without a time yet (just sent, not yet in a block) go on top. */
const newestFirst = (a: HistoryEntry, b: HistoryEntry) => (b.timestamp ?? Infinity) - (a.timestamp ?? Infinity);

const STATUS: Record<NonNullable<HistoryEntry['status']>, string> = {
  checking: 'Being checked (privacy check)',
  spendable: 'Cleared',
  blocked: 'Blocked by sanctions screening',
};

/**
 * Test-funds claims arrive as a shield from Login's pool; their Ethereum tx
 * hashes come from GET /api/test-funds (`txHash`, or a future `claims` list if
 * repeat claims are allowed), so History can label them.
 */
type TestFundsView = { txHash?: string | null; claims?: { txHash?: string | null }[] };
const claimHashes = (v: TestFundsView | null) =>
  new Set([v?.txHash, ...(v?.claims ?? []).map((c) => c.txHash)].filter((h): h is string => !!h).map((h) => h.toLowerCase()));
const hex = (txid: string) => (txid.startsWith('0x') ? txid : `0x${txid}`).toLowerCase();

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** "25 USDT". The hidden fee reserve (ETH) is left out unless it's the only thing that moved. */
function amounts(list: HistoryEntry['amounts']): string {
  const main = list.filter((a) => a.tokenAddress.toLowerCase() !== WETH);
  const show = main.length ? main : list;
  return show
    .map((a) => {
      const t = TOKENS[a.tokenAddress.toLowerCase()];
      return t ? `${formatUnits(a.amount, t.decimals, t.decimals === 18 ? 5 : 2)} ${t.label}` : `${a.amount} (unknown token)`;
    })
    .join(' + ');
}

/**
 * History data (owned by the main session: worker call, wording, test ids). Shared by
 * the Home card and the Notifications page, which only differ in how many rows they show.
 */
/**
 * The last history loaded, kept in memory (never stored) so Home and Notifications show it at once when
 * you switch pages instead of rebuilding from "Loading…". Tied to one wallet, and dropped as soon as the
 * wallet locks, like everything else from it.
 */
let historyCache: { address: string; entries: HistoryEntry[]; claims: Set<string> } | null = null;

export function useHistory() {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  if (pw.status === 'off' || (historyCache && historyCache.address !== pw.railgunAddress)) historyCache = null;
  const [entries, setEntries] = useState<HistoryEntry[] | null>(() => historyCache?.entries ?? null);
  const [failed, setFailed] = useState(false);
  const [claims, setClaims] = useState<Set<string>>(() => historyCache?.claims ?? new Set());
  // Reload whenever the balance changes (a new deposit, send or withdrawal shows up there first).
  const balanceKey = JSON.stringify(pw.balances.Spendable ?? []) + JSON.stringify(pw.balances.ShieldPending ?? []);

  useEffect(() => {
    if (pw.status !== 'ready') return;
    let live = true;
    privateWallet
      .call<HistoryEntry[]>('history')
      .then((h) => {
        const sorted = [...h].sort(newestFirst);
        if (pw.railgunAddress) historyCache = { address: pw.railgunAddress, entries: sorted, claims: historyCache?.claims ?? new Set() };
        if (live) (setEntries(sorted), setFailed(false));
      })
      .catch(() => live && setFailed(true));
    // Which deposits are test-funds claims (testnet only; the card works without it).
    api<TestFundsView>('GET', '/api/test-funds').then(
      (v) => {
        const c = claimHashes(v);
        if (historyCache) historyCache.claims = c;
        if (live) setClaims(c);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [pw.status, balanceKey]);

  const swaps = new Map(
    pw.deposits.flatMap((d) => (d.withdrawal ? [[d.withdrawal.tidepoolDepositAddress.toLowerCase(), d.withdrawal] as const] : [])),
  );

  const describe = (e: HistoryEntry): string => {
    const a = amounts(e.amounts);
    const onlyReserve = e.amounts.length > 0 && e.amounts.every((x) => x.tokenAddress.toLowerCase() === WETH);
    // Withdrawals: show what the user entered (what arrived + Railgun's fee), and what arrived.
    const entered = e.fees?.length
      ? amounts(
          e.amounts.map((x) => {
            const fee = e.fees!.find((f) => f.tokenAddress.toLowerCase() === x.tokenAddress.toLowerCase());
            return fee ? { ...x, amount: (BigInt(x.amount) + BigInt(fee.amount)).toString() } : x;
          }),
        )
      : a;
    const arrived = entered !== a ? ` (${a} arrived after Railgun’s 0.25% fee)` : '';
    switch (e.kind) {
      case 'deposit':
        if (claims.has(hex(e.txid))) return `Added ${a.replace(/ USDT$/, ' test USDT')}`;
        return onlyReserve ? `Added ${a} for network fees` : `Added ${a}`;
      case 'received':
        return `Received ${a} privately`;
      case 'sent':
        return `Sent ${a} privately${e.to ? ` to ${short(e.to)}` : ''}`;
      case 'withdrew': {
        const w = e.to ? swaps.get(e.to.toLowerCase()) : undefined;
        if (w) return `Withdrew ${entered} as ${w.symbol} (${CHAINS[w.chain] ?? w.chain}) to ${short(w.to)}`;
        return `Withdrew ${entered}${e.to ? ` to ${short(e.to)}` : ''}${arrived}`;
      }
      default:
        return `Moved ${a}`;
    }
  };

  const isClaim = (e: HistoryEntry) => e.kind === 'deposit' && claims.has(hex(e.txid));
  /** The NEAR Intents swap behind a withdrawal, when there was one (its own status can differ from the unshield's). */
  const swapOf = (e: HistoryEntry) => (e.kind === 'withdrew' && e.to ? swaps.get(e.to.toLowerCase()) : undefined);
  return { entries, failed, describe, isClaim, swapOf };
}

const USD_TOKENS: Record<string, number> = { [SEPOLIA_USDT.toLowerCase()]: USDT_DECIMALS, [SEPOLIA_USDC.toLowerCase()]: USDC_DECIMALS };
/** Swapped withdrawals: what happened to the swap (absent = it delivered, shown as "Successful"). */
const SWAP_STATUS: Partial<Record<WithdrawalSwap['status'], string>> = {
  sending: 'Swapping…',
  sent: 'Swapping…',
  refunded: 'Refunded to your balance',
  failed: 'Swap failed, refunding',
};
const OUTGOING = new Set<HistoryEntry['kind']>(['sent', 'withdrew']);

/** Dollar change of one entry (USDT/USDC, in 6-decimal units; withdrawals include Railgun's fee). Null if no dollars moved. */
export function usdDelta(e: HistoryEntry): bigint | null {
  let total = 0n;
  let any = false;
  for (const a of e.amounts) {
    const d = USD_TOKENS[a.tokenAddress.toLowerCase()];
    if (d === undefined) continue;
    any = true;
    const fee = e.fees?.find((f) => f.tokenAddress.toLowerCase() === a.tokenAddress.toLowerCase());
    const v = (BigInt(a.amount) + (fee ? BigInt(fee.amount) : 0n)) * 10n ** BigInt(6 - d);
    total += v;
  }
  if (!any) return null;
  return OUTGOING.has(e.kind) ? -total : total;
}

const longDate = (s: number | null) => (s ? new Date(s * 1000).toLocaleDateString('en-US', { dateStyle: 'long' }) : 'Just now');

/**
 * Activity rows (Figma: Home → Notifications card, and the Notifications page).
 * Keeps History's test ids (ul "history", li data-kind / data-status), each entry's
 * Etherscan link, the claim note, and the "Only you see this…" note.
 */
export function Activity({
  title,
  limit,
  onViewAll,
  hidden = false,
  hideTitle = false,
  card = false,
  pending = [],
}: {
  title: string;
  /** Rows to show; the rest are a "Show all" away (or "View all" on Home). */
  limit?: number;
  onViewAll?: () => void;
  /** Hide amounts (the balance eye toggle). */
  hidden?: boolean;
  /** The page already shows the title (Notifications page): keep it for screen readers only. */
  hideTitle?: boolean;
  /** Home's card: full width, fixed 336px height, with a centred message when there's nothing yet (Figma 549:8784). */
  card?: boolean;
  /** Deposits not finished yet: listed first, with Resume / Finish (Gold, 12 Nov). */
  pending?: PendingItem[];
}) {
  const { entries, failed, describe, isClaim, swapOf } = useHistory();
  const [all, setAll] = useState(false);
  // Home's card changes height with the window: show only the rows that fit (first row at 78px, then every 68, 19 below).
  const box = useRef<HTMLElement>(null);
  const [fits, setFits] = useState(limit ?? Infinity);
  useLayoutEffect(() => {
    if (!card || !box.current) return;
    const el = box.current;
    const measure = () => setFits(Math.max(1, Math.floor((el.clientHeight - 78 - 19 + 33) / 68)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card]);
  const max = card ? Math.min(limit ?? Infinity, fits) : limit;
  const pend = all || !max ? pending : pending.slice(0, max);
  const room = max ? Math.max(0, max - pend.length) : Infinity;
  const shown = entries ? (all || !max ? entries : entries.slice(0, room)) : [];
  const nothing = entries?.length === 0 && pending.length === 0;
  const id = `activity-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section ref={box} className={`panel activity${card ? ' is-card' : ''}`} aria-labelledby={id}>
      <div className={hideTitle || (card && nothing) ? 'visually-hidden' : 'panel-head'}>
        <h2 id={id}>{title}</h2>
        {onViewAll && !nothing && entries && (
          <button type="button" className="panel-link" onClick={onViewAll}>
            View all
          </button>
        )}
      </div>
      {failed && <p className="panel-empty">Couldn’t load your history. Lock and unlock to try again.</p>}
      {!failed && !entries && (card ? <div className="activity-empty"><span>Loading…</span></div> : <p className="panel-empty">Loading…</p>)}
      {nothing &&
        (card ? (
          <div className="activity-empty">
            <strong>No notifications yet</strong>
            <span>All deposits, transactions, in app notifications, and sign in apps will appear here</span>
          </div>
        ) : (
          <p className="panel-empty">Nothing yet. Deposits, sends and withdrawals show up here.</p>
        ))}
      {(shown.length > 0 || pend.length > 0) && (
        <ul className="activity-list" data-testid="history">
          {pend.map((p) => (
            <li key={p.key} data-kind="pending">
              <span className="activity-icon" aria-hidden="true">
                <img src="/img/arrow-down-to-line.svg" alt="" width={18} height={18} />
              </span>
              <div className="activity-main">
                <span className="activity-what">{p.title}</span>
                <span className="activity-when">
                  {longDate(p.when)} · {p.detail}
                </span>
              </div>
              <div className="activity-side">
                {p.action ? (
                  <button type="button" className="activity-action" onClick={p.action.run}>
                    {p.action.label}
                  </button>
                ) : (
                  <span className="activity-status is-checking">In progress</span>
                )}
              </div>
            </li>
          ))}
          {shown.map((e) => {
            const out = OUTGOING.has(e.kind);
            const delta = usdDelta(e);
            // A swapped withdrawal is only "Successful" once the swap delivered; Tidepool can refund it instead.
            const swap = swapOf(e);
            const swapText = swap && SWAP_STATUS[swap.status];
            const statusText = e.status ? STATUS[e.status] : swapText ? swapText : out ? 'Successful' : '';
            const statusClass = e.status ?? (swapText ? 'checking' : 'done');
            return (
              <li key={e.txid + e.kind} data-kind={isClaim(e) ? 'claim' : e.kind} data-status={e.status ?? undefined}>
                <span className="activity-icon" aria-hidden="true">
                  <img src={out ? '/img/arrow-up-right.svg' : '/img/arrow-down-to-line.svg'} alt="" width={18} height={18} />
                </span>
                <div className="activity-main">
                  <span className="activity-what">{describe(e)}</span>
                  <span className="activity-when">
                    {longDate(e.timestamp)} ·{' '}
                    <a href={`https://sepolia.etherscan.io/tx/${hex(e.txid)}`} target="_blank" rel="noreferrer">
                      Etherscan
                    </a>
                  </span>
                </div>
                <div className="activity-side">
                  <span className="activity-amount">{hidden ? '••••' : delta !== null ? usd(delta, 6, { sign: true }) : amounts(e.amounts)}</span>
                  {statusText && <span className={`activity-status is-${statusClass}`}>{statusText}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {entries && limit && entries.length > limit && !all && !onViewAll && (
        <button type="button" className="panel-link panel-more" onClick={() => setAll(true)}>
          Show all {entries.length}
        </button>
      )}
      {!onViewAll && (
        <p className="panel-note">
          Only you see this. It’s worked out on this device from your wallet’s own data, and it’s hidden whenever your wallet is
          locked. On Etherscan, a private send shows only that a Railgun transaction happened; deposits and withdrawals are public
          there, as they always are.
        </p>
      )}
    </section>
  );
}
