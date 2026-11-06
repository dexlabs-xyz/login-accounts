/**
 * The deposit flow on the page. TESTNET ONLY.
 *
 *   fresh address (worker) -> Tidepool quote -> user pays -> Tidepool delivers USDT
 *   -> testnet gas faucet (contradicts D6, testnet only) -> approve + shield (worker)
 *
 * Every step can resume: records live (encrypted) in the worker, so after a
 * reload or on another device the flow picks up where it stopped.
 */
import { api } from '../api.ts';
import { privateWallet } from '../railgun/client.ts';
import type { DepositRecord } from '../railgun/protocol.ts';
import { formatUnits, getQuote, getStatus, isFinal, type Quote, type SwapStatus, type Token } from './tidepool.ts';

/** Enough Sepolia ETH for approve + shield. Below this we ask the testnet faucet. */
const MIN_GAS_WEI = 1_500_000_000_000_000n;
const POLL_MS = 5_000;
/** How long after a quote's deadline we keep waiting for a late payment. */
const QUOTE_GRACE_MS = 10 * 60_000;

/** Live, non-secret progress per deposit, for the UI. */
export type Stage =
  | { kind: 'waiting-payment'; swap: SwapStatus }
  | { kind: 'waiting-direct' }
  | { kind: 'arriving' }
  | { kind: 'adding-gas' }
  | { kind: 'shielding' }
  | { kind: 'done' }
  | { kind: 'refunded' }
  | { kind: 'failed'; reason: string }
  | { kind: 'needs-finish' }
  /** Money reached a deposit address after its deposit finished (e.g. paid in two parts). */
  | { kind: 'late-funds' };

const stages = new Map<number, Stage>();
/** USDC seen at a deposit address (sent instead of USDT), by deposit index. */
const usdcSeen = new Map<number, string>();
function noteUsdc(index: number, amount: string) {
  if (BigInt(amount) > 0n && usdcSeen.get(index) !== amount) {
    usdcSeen.set(index, amount);
    version++;
    listeners.forEach((l) => l());
  }
}
const listeners = new Set<() => void>();
const running = new Set<number>();
let version = 0;

function setStage(index: number, stage: Stage) {
  stages.set(index, stage);
  version++;
  listeners.forEach((l) => l());
}

export const depositProgress = {
  get: (index: number) => stages.get(index),
  /** USDC (in units) seen at this deposit's address, sent instead of USDT. */
  usdc: (index: number) => usdcSeen.get(index),
  version: () => version,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Step 1: reserve a fresh address and get a quote for it. */
export async function startDeposit(p: { origin: Token; usdt: Token; amount: string; solanaRefund?: string }) {
  const record = await privateWallet.call<DepositRecord>('deposit.next');
  if (p.origin.assetId === p.usdt.assetId) return startDirect(record, p.amount);
  // EVM origins: refunds go to the same fresh address on the origin chain (same key, user-controlled).
  const refundTo = p.origin.blockchain === 'sol' ? p.solanaRefund! : record.address;
  const quote = await getQuote({ origin: p.origin, usdt: p.usdt, amount: p.amount, recipient: record.address, refundTo });
  const updated = await privateWallet.call<DepositRecord>('deposit.update', {
    index: record.index,
    status: 'awaiting-delivery',
    quote: {
      tidepoolDepositAddress: quote.depositAddress,
      originChain: p.origin.blockchain,
      originSymbol: p.origin.symbol,
      amountIn: quote.amountIn,
      amountInFormatted: quote.amountInFormatted,
      expectedUsdt: quote.amountOut,
      minUsdt: quote.minAmountOut,
      deadline: quote.deadline,
      refundTo,
    },
  });
  void track(updated);
  return { record: updated, quote };
}

/**
 * Already holding Sepolia USDT: nothing to swap. The user sends it straight to
 * the fresh address. On-chain, their wallet is then visibly the funder of the
 * deposit address (with a swap, Tidepool's address is), which our rules accept.
 */
async function startDirect(record: DepositRecord, amount: string) {
  const deadline = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const amountInFormatted = formatUnits(amount, 6, 6);
  const updated = await privateWallet.call<DepositRecord>('deposit.update', {
    index: record.index,
    status: 'awaiting-delivery',
    quote: {
      tidepoolDepositAddress: record.address,
      originChain: 'eth',
      originSymbol: 'USDT',
      amountIn: amount,
      amountInFormatted,
      expectedUsdt: amount,
      minUsdt: amount,
      deadline,
      refundTo: '',
      direct: true,
    },
  });
  void track(updated);
  const quote: Quote = {
    depositAddress: record.address,
    amountIn: amount,
    amountInFormatted,
    amountOut: amount,
    minAmountOut: amount,
    deadline,
    timeEstimate: 30,
  };
  return { record: updated, quote };
}

/** Steps 2–4: follow a deposit to the end. Safe to call again; one run per deposit. */
export async function track(record: DepositRecord): Promise<void> {
  if (running.has(record.index)) return;
  running.add(record.index);
  try {
    if (record.status === 'awaiting-delivery' && record.quote?.direct) {
      // Direct: wait for USDT to land at the fresh address itself.
      setStage(record.index, { kind: 'waiting-direct' });
      for (;;) {
        const bal = await privateWallet.call<{ usdt: string; usdc: string }>('deposit.balances', { index: record.index });
        noteUsdc(record.index, bal.usdc);
        // USDC sent by mistake also counts: it goes in as private USDC.
        if (BigInt(bal.usdt) > 0n || BigInt(bal.usdc) > 0n) break;
        if (Date.now() > Date.parse(record.quote.deadline)) {
          await privateWallet.call('deposit.update', { index: record.index, status: 'failed' });
          setStage(record.index, { kind: 'failed', reason: 'No USDT arrived within a day. Start a new deposit when you’re ready.' });
          return;
        }
        await sleep(POLL_MS);
      }
      await privateWallet.call('deposit.update', { index: record.index, status: 'delivered' });
      record = { ...record, status: 'delivered' };
    } else if (record.status === 'awaiting-delivery' && record.quote) {
      let swap: SwapStatus = 'PENDING_DEPOSIT';
      for (;;) {
        swap = await getStatus(record.quote.tidepoolDepositAddress).catch(() => swap);
        setStage(record.index, { kind: 'waiting-payment', swap });
        if (isFinal(swap)) break;
        // Never paid, and the quote has expired: stop watching. Nothing was sent.
        if (swap === 'PENDING_DEPOSIT' && Date.now() > Date.parse(record.quote.deadline) + QUOTE_GRACE_MS) {
          await privateWallet.call('deposit.update', { index: record.index, status: 'failed' });
          setStage(record.index, { kind: 'failed', reason: 'The quote expired before any payment arrived. Nothing was sent.' });
          return;
        }
        await sleep(POLL_MS);
      }
      if (swap !== 'SUCCESS') {
        await privateWallet.call('deposit.update', { index: record.index, status: swap === 'REFUNDED' ? 'refunded' : 'failed' });
        setStage(record.index, swap === 'REFUNDED' ? { kind: 'refunded' } : { kind: 'failed', reason: 'The swap failed.' });
        return;
      }
      await privateWallet.call('deposit.update', { index: record.index, status: 'delivered' });
      record = { ...record, status: 'delivered' };
    }
    if (record.status === 'delivered' || record.status === 'shielding') await finish(record.index);
  } catch (err) {
    setStage(record.index, { kind: 'failed', reason: err instanceof Error && err.message !== 'Error' ? err.message : 'Something went wrong.' });
  } finally {
    running.delete(record.index);
  }
}

/** USDT is at the fresh address: get it gas (testnet faucet) and shield it. */
async function finish(index: number) {
  setStage(index, { kind: 'arriving' });
  let bal = await privateWallet.call<{ eth: string; usdt: string; usdc: string }>('deposit.balances', { index });
  const arrived = () => BigInt(bal.usdt) > 0n || BigInt(bal.usdc) > 0n;
  for (let i = 0; !arrived() && i < 24; i++) {
    await sleep(POLL_MS);
    bal = await privateWallet.call('deposit.balances', { index });
  }
  if (!arrived()) throw new Error('The USDT hasn’t arrived at your deposit address yet. Try “Finish deposit” again soon.');
  noteUsdc(index, bal.usdc);

  if (BigInt(bal.eth) < MIN_GAS_WEI) {
    setStage(index, { kind: 'adding-gas' });
    // TESTNET-ONLY simulation: Login's faucet sees this address (contradicts D6; never on mainnet).
    const r = await api<{ status: string }>('POST', '/api/testnet-gas', { address: (await recordAt(index)).address });
    for (let i = 0; r.status === 'sent' && BigInt(bal.eth) < MIN_GAS_WEI && i < 36; i++) {
      await sleep(POLL_MS);
      bal = await privateWallet.call('deposit.balances', { index });
    }
    if (BigInt(bal.eth) < MIN_GAS_WEI) throw new Error('Gas for the deposit hasn’t arrived yet. Try “Finish deposit” again soon.');
  }

  setStage(index, { kind: 'shielding' });
  await privateWallet.call('deposit.shield', { index });
  setStage(index, { kind: 'done' });
}

async function recordAt(index: number) {
  const r = privateWallet.get().deposits.find((d) => d.index === index);
  if (!r) throw new Error('Unknown deposit.');
  return r;
}

/** When each finished deposit's address was last checked for money that arrived afterwards. */
const lateChecked = new Map<number, number>();
const LATE_CHECK_MS = 5 * 60_000;

/** A finished deposit's address received more USDT or USDC afterwards: offer to move it in. */
async function checkLate(r: DepositRecord) {
  const last = lateChecked.get(r.index);
  if ((last && Date.now() - last < LATE_CHECK_MS) || running.has(r.index)) return;
  lateChecked.set(r.index, Date.now());
  try {
    const bal = await privateWallet.call<{ usdt: string; usdc: string }>('deposit.balances', { index: r.index });
    if ((BigInt(bal.usdt) > 0n || BigInt(bal.usdc) > 0n) && !running.has(r.index)) setStage(r.index, { kind: 'late-funds' });
  } catch {
    // Best effort; checked again on the next unlock.
  }
}

/** On unlock: resume deposits still in flight; mark ones that need a tap to finish. */
export function resumeAll(records: DepositRecord[]) {
  for (const r of records) {
    if (r.status === 'shielded') void checkLate(r);
    if (r.status === 'awaiting-delivery') void track(r);
    else if ((r.status === 'delivered' || r.status === 'shielding') && !running.has(r.index) && !stages.has(r.index)) {
      setStage(r.index, { kind: 'needs-finish' });
    }
  }
}
