/**
 * History: deposits, private sends and receipts, and withdrawals.
 *
 * Built by the wallet worker from Railgun's own transaction history, decrypted
 * with this wallet's keys on this device (no request to Login's server, no new
 * data stored). It shows only while the wallet is unlocked, like the balance.
 * Withdrawals swapped through NEAR Intents are matched to their record (by
 * Tidepool's one-time address) to show the token and the user's own address.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { privateWallet } from './railgun/client.ts';
import { SEPOLIA_USDC, SEPOLIA_USDT, SEPOLIA_WETH, USDC_DECIMALS, USDT_DECIMALS, type HistoryEntry } from './railgun/protocol.ts';
import { formatUnits } from './deposits/tidepool.ts';

const TOKENS: Record<string, { label: string; decimals: number }> = {
  [SEPOLIA_USDT.toLowerCase()]: { label: 'USDT', decimals: USDT_DECIMALS },
  [SEPOLIA_USDC.toLowerCase()]: { label: 'USDC', decimals: USDC_DECIMALS },
  [SEPOLIA_WETH.toLowerCase()]: { label: 'ETH', decimals: 18 },
};
const WETH = SEPOLIA_WETH.toLowerCase();
const CHAINS: Record<string, string> = { eth: 'Ethereum Sepolia', base: 'Base Sepolia', arb: 'Arbitrum Sepolia', sol: 'Solana devnet' };
const SHOWN = 20;

/** Newest first; entries without a time yet (just sent, not yet in a block) go on top. */
const newestFirst = (a: HistoryEntry, b: HistoryEntry) => (b.timestamp ?? Infinity) - (a.timestamp ?? Infinity);

const STATUS: Record<NonNullable<HistoryEntry['status']>, string> = {
  checking: 'Being checked (privacy check)',
  spendable: 'Spendable',
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
const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

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

export function History() {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const [claims, setClaims] = useState<Set<string>>(new Set());
  // Reload whenever the balance changes (a new deposit, send or withdrawal shows up there first).
  const balanceKey = JSON.stringify(pw.balances.Spendable ?? []) + JSON.stringify(pw.balances.ShieldPending ?? []);

  useEffect(() => {
    if (pw.status !== 'ready') return;
    let live = true;
    privateWallet
      .call<HistoryEntry[]>('history')
      .then((h) => live && (setEntries([...h].sort(newestFirst)), setFailed(false)))
      .catch(() => live && setFailed(true));
    // Which deposits are test-funds claims (testnet only; the card works without it).
    api<TestFundsView>('GET', '/api/test-funds').then(
      (v) => live && setClaims(claimHashes(v)),
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

  const list = entries ? (all ? entries : entries.slice(0, SHOWN)) : [];
  return (
    <section className="card" aria-labelledby="history-h">
      <h2 id="history-h">History</h2>
      {failed && <p className="muted">Couldn’t load your history. Lock and unlock to try again.</p>}
      {!failed && !entries && <p className="muted">Loading…</p>}
      {entries && entries.length === 0 && <p className="muted">Nothing yet. Deposits, sends and withdrawals show up here.</p>}
      {list.length > 0 && (
        <ul className="history" data-testid="history">
          {list.map((e) => (
            <li key={e.txid + e.kind} data-kind={claims.has(hex(e.txid)) && e.kind === 'deposit' ? 'claim' : e.kind} data-status={e.status ?? undefined}>
              <span>{describe(e)}</span>{' '}
              <span className="muted small">
                {e.status && <>{STATUS[e.status]} · </>}
                {when(e.timestamp)}{' '}
                <a href={`https://sepolia.etherscan.io/tx/${hex(e.txid)}`} target="_blank" rel="noreferrer">
                  Etherscan
                </a>
              </span>
              {claims.has(hex(e.txid)) && e.kind === 'deposit' && (
                <span className="muted small"> Our server saw your private address for this one claim only.</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {entries && entries.length > SHOWN && !all && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {entries.length}
        </button>
      )}
      <p className="muted small">
        Only you see this. It’s worked out on this device from your wallet’s own data, and it’s hidden whenever your wallet is
        locked. On Etherscan, a private send shows only that a Railgun transaction happened; deposits and withdrawals are public
        there, as they always are.
      </p>
    </section>
  );
}
