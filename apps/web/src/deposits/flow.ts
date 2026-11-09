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
import { SEPOLIA_WETH, type DepositRecord, type DepositSwap, type WithdrawalSwap } from '../railgun/protocol.ts';
import { ethSwapChunks, ethToSwap, MIN_ETH_SWAP_WEI } from './plan.ts';
import { formatUnits, getQuote, getStatus, isFinal, loadTokens, type Quote, type SwapStatus, type Token } from './tidepool.ts';

/** Enough Sepolia ETH for approve + shield. Below this we ask the testnet faucet. */
const MIN_GAS_WEI = 1_500_000_000_000_000n;
const POLL_MS = 5_000;
/** After the first token lands at an EVM deposit address, wait this long for others sent with it. */
const SETTLE_MS = 20_000;
/** How long after a quote's deadline we keep waiting for a late payment. */
const QUOTE_GRACE_MS = 10 * 60_000;

/** Live, non-secret progress per deposit, for the UI. */
export type Stage =
  | { kind: 'waiting-payment'; swap: SwapStatus }
  | { kind: 'waiting-direct' }
  /** EVM deposit: waiting for USDT, USDC or ETH to arrive at the fresh address. */
  | { kind: 'waiting-evm' }
  /** EVM deposit: the deposit address is swapping USDC or ETH into USDT through Tidepool. */
  | { kind: 'swapping'; token: 'USDC' | 'ETH'; swap: SwapStatus }
  | { kind: 'arriving' }
  | { kind: 'adding-gas' }
  | { kind: 'shielding' }
  | { kind: 'done' }
  | { kind: 'refunded' }
  | { kind: 'failed'; reason: string }
  | { kind: 'needs-finish' }
  /** Money reached a deposit address after its deposit finished (e.g. paid in two parts). */
  | { kind: 'late-funds' }
  /** Swapped withdrawal: Tidepool is swapping the withdrawn USDT. */
  | { kind: 'withdraw-swapping'; swap: SwapStatus }
  | { kind: 'withdraw-arrived' }
  /** Swapped withdrawal didn't go through: the USDT comes back to the private balance. */
  | { kind: 'withdraw-refunding' }
  | { kind: 'withdraw-not-sent' };

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

/**
 * EVM deposit (Ethereum Sepolia): reserve a fresh address. The user sends any
 * amount of USDT, USDC or ETH to it; no quote up front.
 */
export async function startEvmDeposit(): Promise<DepositRecord> {
  const record = await privateWallet.call<DepositRecord>('deposit.next');
  const updated = await privateWallet.call<DepositRecord>('deposit.update', {
    index: record.index,
    status: 'awaiting-delivery',
    quote: {
      tidepoolDepositAddress: record.address,
      originChain: 'eth',
      originSymbol: 'USDT, USDC or ETH',
      amountIn: '0',
      amountInFormatted: '',
      expectedUsdt: '0',
      minUsdt: '0',
      deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      refundTo: record.address,
      anyToken: true,
    },
  });
  void track(updated);
  return updated;
}

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
    if (record.quote?.anyToken) {
      if (record.status === 'awaiting-delivery') {
        setStage(record.index, { kind: 'waiting-evm' });
        let bal: Balances;
        for (;;) {
          bal = await balances(record.index);
          if (BigInt(bal.usdt) > 0n || BigInt(bal.usdc) > 0n || BigInt(bal.eth) > 0n) break;
          if (Date.now() > Date.parse(record.quote.deadline)) {
            await privateWallet.call('deposit.update', { index: record.index, status: 'failed' });
            setStage(record.index, { kind: 'failed', reason: 'Nothing arrived within a day. Start a new deposit when you’re ready.' });
            return;
          }
          await sleep(POLL_MS);
        }
        // People often send two tokens back to back: let the rest land before counting.
        await sleep(SETTLE_MS);
        bal = await balances(record.index);
        // Before any testnet gas is added: whatever ETH is here now, the user sent.
        // (ETH arriving later still goes in, as the network-fee reserve.)
        await privateWallet.call('deposit.update', { index: record.index, status: 'delivered', userEthWei: bal.eth });
        record = { ...record, status: 'delivered', userEthWei: bal.eth };
      }
      if (record.status === 'delivered' || record.status === 'shielding' || record.status === 'shielded' || record.status === 'failed') {
        await finishEvm(record.index);
      }
      return;
    }
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

type Balances = { eth: string; usdt: string; usdc: string };
const balances = (index: number) => privateWallet.call<Balances>('deposit.balances', { index });

let tokensPromise: ReturnType<typeof loadTokens> | null = null;
const tokens = () => (tokensPromise ??= loadTokens().catch((e) => ((tokensPromise = null), Promise.reject(e))));

async function saveSwaps(index: number, swaps: DepositSwap[]) {
  await privateWallet.call('deposit.update', { index, swaps });
}

/** Follow one Tidepool swap to the end, saving each step so a reload never sends twice. */
async function runSwap(index: number, swaps: DepositSwap[], s: DepositSwap): Promise<void> {
  if (s.status === 'quoted') {
    setStage(index, { kind: 'swapping', token: s.token, swap: 'PENDING_DEPOSIT' });
    const { txHash } = await privateWallet.call<{ txHash: string }>('deposit.transfer', {
      index,
      token: s.token,
      to: s.tidepoolDepositAddress,
      amount: s.amountIn,
    });
    s.sendTx = txHash;
    s.status = 'sent';
    await saveSwaps(index, swaps);
  }
  let status: SwapStatus = 'KNOWN_DEPOSIT_TX';
  for (let i = 0; ; i++) {
    status = await getStatus(s.tidepoolDepositAddress).catch(() => status);
    setStage(index, { kind: 'swapping', token: s.token, swap: status });
    if (isFinal(status)) break;
    if (i > 360) throw new Error('Tidepool hasn’t finished the swap yet. Try “Finish deposit” again later.');
    await sleep(POLL_MS);
  }
  // Refunds come back to the same deposit address (refundTo); a refunded USDC
  // swap is then shielded as private USDC rather than lost.
  s.status = status === 'SUCCESS' ? 'success' : status === 'REFUNDED' ? 'refunded' : 'failed';
  await saveSwaps(index, swaps);
}

/** The hidden private ETH reserve for broadcaster fees, cleared or still being checked. */
function feeReserveWei(): bigint {
  const b = privateWallet.get().balances;
  let total = 0n;
  for (const bucket of ['Spendable', 'ShieldPending', 'MissingInternalPOI', 'MissingExternalPOI'] as const) {
    for (const t of b[bucket] ?? []) if (t.tokenAddress.toLowerCase() === SEPOLIA_WETH.toLowerCase()) total += BigInt(t.amount);
  }
  return total;
}

/**
 * EVM deposit: testnet gas if needed, swap USDC and the user's ETH into USDT
 * through Tidepool (back to this same address), then shield. Safe to run again.
 */
async function finishEvm(index: number) {
  setStage(index, { kind: 'arriving' });
  let bal = await balances(index);
  if (BigInt(bal.usdt) === 0n && BigInt(bal.usdc) === 0n && BigInt(bal.eth) === 0n) {
    throw new Error('Nothing has arrived at your deposit address yet.');
  }
  const record = await recordAt(index);
  const swaps: DepositSwap[] = (record.swaps ?? []).map((s) => ({ ...s }));

  if (BigInt(bal.eth) < MIN_GAS_WEI) {
    setStage(index, { kind: 'adding-gas' });
    // TESTNET-ONLY simulation: Login's faucet sees this address (contradicts D6; never on mainnet).
    const r = await api<{ status: string }>('POST', '/api/testnet-gas', { address: record.address });
    for (let i = 0; r.status === 'sent' && BigInt(bal.eth) < MIN_GAS_WEI && i < 36; i++) {
      await sleep(POLL_MS);
      bal = await balances(index);
    }
    if (BigInt(bal.eth) < MIN_GAS_WEI) throw new Error('Gas for the deposit hasn’t arrived yet. Try “Finish deposit” again soon.');
  }

  // A swap quoted but never sent (e.g. reload mid-way) is dropped: its quote may have expired.
  for (let i = swaps.length - 1; i >= 0; i--) if (swaps[i]!.status === 'quoted') swaps.splice(i, 1);
  // Resume swaps already sent.
  for (const s of swaps) if (s.status === 'sent') await runSwap(index, swaps, s);

  const { usdt, sepolia } = await tokens();
  if (!sepolia) throw new Error('Tidepool isn’t offering Sepolia USDC and ETH right now. Try “Finish deposit” later.');
  const newSwap = async (token: 'USDC' | 'ETH', amount: bigint) => {
    setStage(index, { kind: 'swapping', token, swap: 'PENDING_DEPOSIT' });
    const q = await getQuote({ origin: token === 'USDC' ? sepolia.usdc : sepolia.eth, usdt, amount: amount.toString(), recipient: record.address, refundTo: record.address });
    const s: DepositSwap = { token, amountIn: q.amountIn, tidepoolDepositAddress: q.depositAddress, minUsdt: q.minAmountOut, status: 'quoted' };
    swaps.push(s);
    await saveSwaps(index, swaps);
    await runSwap(index, swaps, s);
  };

  // USDC: swap it all, unless a USDC swap already came back refunded (then it's shielded as USDC).
  bal = await balances(index);
  if (BigInt(bal.usdc) > 0n && !swaps.some((s) => s.token === 'USDC' && (s.status === 'refunded' || s.status === 'failed'))) {
    await newSwap('USDC', BigInt(bal.usdc));
  }
  // ETH: only what the user sent, minus gas and any top-up of the hidden fee reserve.
  bal = await balances(index);
  const ethSwapped = swaps.filter((s) => s.token === 'ETH' && s.status !== 'refunded').reduce((t, s) => t + BigInt(s.amountIn), 0n);
  const userEth = BigInt(record.userEthWei ?? '0') - ethSwapped;
  const eth = ethToSwap({ balanceWei: BigInt(bal.eth), userEthWei: userEth > 0n ? userEth : 0n, reserveWei: feeReserveWei() });
  // Tidepool caps each ETH swap (0.006 ETH), so larger amounts go in several swaps, one after another.
  if (!swaps.some((s) => s.token === 'ETH' && s.status === 'failed')) {
    for (const chunk of ethSwapChunks(eth)) {
      await newSwap('ETH', chunk);
      if (swaps[swaps.length - 1]!.status !== 'success') break; // refunded or failed: stop, the rest stays here
    }
  }

  // Tidepool reports success when it sends; wait until the USDT is visible here.
  if (swaps.some((s) => s.status === 'success')) {
    for (let i = 0; i < 24 && BigInt((bal = await balances(index)).usdt) === 0n; i++) await sleep(POLL_MS);
  }
  bal = await balances(index);
  if (BigInt(bal.usdt) === 0n && BigInt(bal.usdc) === 0n) {
    // Only ETH, and too little to swap: it stays as gas and joins the fee reserve.
    if (BigInt(bal.eth) === 0n) throw new Error('Nothing to move into your private balance.');
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
    const bal = await balances(r.index);
    // EVM deposits also count ETH the user sent (more than gas leftovers).
    const eth = r.quote?.anyToken && BigInt(bal.eth) >= MIN_ETH_SWAP_WEI;
    if ((BigInt(bal.usdt) > 0n || BigInt(bal.usdc) > 0n || eth) && !running.has(r.index)) setStage(r.index, { kind: 'late-funds' });
  } catch {
    // Best effort; checked again on the next unlock.
  }
}

// ---------- withdrawals that arrive as another token or chain ----------

/**
 * Step 1 (review): reserve a fresh deposit address for refunds, and get
 * Tidepool's quote for the USDT that will reach it after Railgun's fee.
 */
export async function prepareSwapWithdrawal(p: { destination: Token; to: string; amount: string; unshieldFeeBasisPoints: bigint }) {
  const amount = BigInt(p.amount);
  // Railgun keeps its fee out of the withdrawn amount (rounded down), as in send.ts.
  const sentUsdt = (amount - (amount * p.unshieldFeeBasisPoints) / 10_000n).toString();
  const { usdt } = await tokens();
  const refund = await privateWallet.call<DepositRecord>('deposit.next');
  const quote = await getQuote({ origin: usdt, usdt, destination: p.destination, amount: sentUsdt, recipient: p.to, refundTo: refund.address });
  return { refund, quote, sentUsdt };
}

/** Save the withdrawal before it's sent, so a reload still follows it. */
export async function saveWithdrawal(index: number, withdrawal: WithdrawalSwap) {
  await privateWallet.call('deposit.update', { index, withdrawal });
}

/**
 * Follow a swapped withdrawal to the end. If Tidepool refunds it, the USDT
 * lands at this record's fresh address, and the usual deposit flow moves it
 * back into the private balance.
 */
export async function trackWithdrawal(record: DepositRecord): Promise<void> {
  const w0 = record.withdrawal;
  if (!w0 || running.has(record.index)) return;
  running.add(record.index);
  let refund: DepositRecord | null = null;
  try {
    const w: WithdrawalSwap = { ...w0 };
    let swap: SwapStatus = 'PENDING_DEPOSIT';
    for (;;) {
      swap = await getStatus(w.tidepoolDepositAddress).catch(() => swap);
      setStage(record.index, { kind: 'withdraw-swapping', swap });
      if (isFinal(swap)) break;
      // Interrupted while sending, and nothing ever arrived: it wasn't sent.
      if (w.status === 'sending' && swap === 'PENDING_DEPOSIT' && Date.now() > Date.parse(w.deadline) + QUOTE_GRACE_MS) {
        await saveWithdrawal(record.index, { ...w, status: 'failed' });
        setStage(record.index, { kind: 'withdraw-not-sent' });
        return;
      }
      await sleep(POLL_MS);
    }
    if (swap === 'SUCCESS') {
      await saveWithdrawal(record.index, { ...w, status: 'success' });
      setStage(record.index, { kind: 'withdraw-arrived' });
      return;
    }
    // Refunded (or failed, which Tidepool also refunds): watch the refund address like an EVM deposit.
    setStage(record.index, { kind: 'withdraw-refunding' });
    await saveWithdrawal(record.index, { ...w, status: swap === 'REFUNDED' ? 'refunded' : 'failed' });
    refund = await privateWallet.call<DepositRecord>('deposit.update', {
      index: record.index,
      status: 'awaiting-delivery',
      quote: {
        tidepoolDepositAddress: record.address,
        originChain: 'eth',
        originSymbol: 'USDT',
        amountIn: '0',
        amountInFormatted: '',
        expectedUsdt: w.sentUsdt,
        minUsdt: '0',
        deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        refundTo: record.address,
        anyToken: true,
      },
    });
  } catch {
    // Tidepool or the wallet hiccuped: the next unlock picks it up again.
  } finally {
    running.delete(record.index);
  }
  if (refund) void track(refund);
}

/** On unlock: resume deposits still in flight; mark ones that need a tap to finish. */
export function resumeAll(records: DepositRecord[]) {
  for (const r of records) {
    if (r.status === 'new' && (r.withdrawal?.status === 'sending' || r.withdrawal?.status === 'sent')) {
      void trackWithdrawal(r);
      continue;
    }
    // Finished deposits, and EVM deposits that timed out, may still receive money later.
    if (r.status === 'shielded' || (r.status === 'failed' && r.quote?.anyToken)) void checkLate(r);
    if (r.status === 'awaiting-delivery') void track(r);
    else if ((r.status === 'delivered' || r.status === 'shielding') && !running.has(r.index) && !stages.has(r.index)) {
      setStage(r.index, { kind: 'needs-finish' });
    }
  }
}
