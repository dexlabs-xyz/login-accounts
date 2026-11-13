/**
 * "Send privately" (to another private 0zk address) and "Withdraw" (out to a
 * public Sepolia address). Same steps for both: review, confirm with passkey,
 * proof, broadcaster. TESTNET ONLY.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { useToast } from '../ui/toast.tsx';
import { sendJobs } from './jobs.ts';
import { usd } from '../money.ts';
import { SEPOLIA_USDT, USDT_DECIMALS } from '../railgun/protocol.ts';
import { CHAIN_NAMES, formatUnits, loadTokens, toUnits, TidepoolError, type OriginChain, type Quote as SwapQuote, type Token } from '../deposits/tidepool.ts';
import { depositProgress, prepareSwapWithdrawal, saveWithdrawal, trackWithdrawal } from '../deposits/flow.ts';
import type { DepositRecord, WithdrawalSwap } from '../railgun/protocol.ts';

type Kind = 'transfer' | 'unshield';

const ZK_ADDRESS = /^0zk1[02-9ac-hj-np-z]{100,140}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const chainName = (chain: string) => CHAIN_NAMES[chain as OriginChain] ?? chain;
const sepoliaTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const ERRORS: Record<string, string> = {
  'invalid-address': 'That address isn’t valid.',
  'own-deposit-address':
    'That’s one of your own Login deposit addresses. It’s publicly linked to your deposits, so withdrawing there would undo the privacy. Use a different address.',
  'insufficient-usdt':
    'You don’t have that much spendable USDT. New deposits become spendable once their privacy check clears. What’s left over after a send stays locked on this test network, so add money to send more.',
  'insufficient-fee-balance':
    'There’s nothing spendable to pay the network fee, so nothing was sent. On this test network, what’s left after a send or withdrawal stays locked, so each deposit covers one transaction. Add money (for example 0.003 ETH from Add money), or if a deposit is still being checked, try again once it clears.',
  'no-broadcaster': 'No network relay is available right now. Try again in a minute.',
  'fee-too-high': 'The network fee quoted is unusually high, so we stopped. Try again later.',
  'quote-expired': 'The fee quote expired. Review it again.',
  'broadcaster-refused':
    'The network relay couldn’t confirm the privacy check on your funds, so nothing was sent. Press Review again to use a different relay.',
  'still-confirming':
    'Your last transaction is still being confirmed, so its money can’t be used yet. Nothing was sent. Wait a minute, then press Review again.',
  'Wallet locked.': 'Your wallet locked. Unlock and try again.',
  'swap-mismatch': 'The swap quote didn’t match the withdrawal, so we stopped. Review it again.',
};
const explain = (e: unknown, kind: Kind) =>
  (e instanceof TidepoolError &&
    (/capped/i.test(e.message)
      ? 'Tidepool’s testnet sends at most 0.006 ETH per withdrawal (about 12 USDT). Withdraw less, or choose USDC.'
      : 'Tidepool couldn’t price this swap right now. Try again, or withdraw as USDT.')) ||
  (e instanceof Error && ERRORS[e.message]) ||
  (kind === 'transfer' ? 'The send didn’t go through. Nothing was sent.' : 'The withdrawal didn’t go through. Nothing was sent.');

/**
 * One currency on screen: the fee is paid from the hidden ETH reserve (testnet),
 * shown as USDT at Tidepool's ETH price. Without a price, say it's covered.
 */
function feeInUsdt(wei: string, ethPrice: number | null): string {
  if (ethPrice === null) return 'covered by your network-fee reserve';
  const usdt = (Number(BigInt(wei)) / 1e18) * ethPrice;
  return usdt < 0.01 ? 'less than 0.01 USDT' : `about ${usdt.toFixed(2)} USDT`;
}
let ethPricePromise: Promise<number | null> | null = null;
const ethPrice = () => (ethPricePromise ??= loadTokens().then((t) => t.ethPrice, () => ((ethPricePromise = null), null)));
let swapTokensPromise: Promise<Token[]> | null = null;
const swapTokens = () => (swapTokensPromise ??= loadTokens().then((t) => t.withdraw, () => ((swapTokensPromise = null), [])));
const usdt = (units: string) => formatUnits(units, USDT_DECIMALS, 6);
const short = (a: string) => `${a.slice(0, 14)}…${a.slice(-8)}`;
const out = (units: string, t: Token) => formatUnits(units, t.decimals, t.decimals > 6 ? 6 : 2);

/** Live status of a swapped withdrawal, from the deposit flow's progress store. */
function swapStatus(amount: string, s: Swap, stage: ReturnType<typeof depositProgress.get>): string {
  const what = `${s.token.symbol} on ${chainName(s.token.blockchain)}`;
  switch (stage?.kind) {
    case 'withdraw-arrived':
      return `Done: about ${out(s.quote.amountOut, s.token)} ${what} was sent to your address.`;
    case 'withdraw-refunding':
    case 'waiting-evm':
    case 'arriving':
    case 'adding-gas':
    case 'shielding':
      return 'The swap didn’t go through, so your USDT is coming back to your private balance. You can follow it under Add money.';
    case 'done':
      return 'The swap didn’t go through. Your USDT is back in your private balance (spendable after Railgun’s privacy check).';
    case 'withdraw-not-sent':
      return 'The withdrawal wasn’t sent. Nothing left your private balance.';
    default:
      return `Withdrew ${usdt(amount)} USDT. Swapping it into ${what}… This usually takes a minute or two.`;
  }
}

const COPY = {
  transfer: {
    title: 'Send privately',
    intro: 'To another private address. Nobody else can see the amount, the sender or the recipient.',
    toLabel: 'To (private 0zk address)',
    placeholder: '0zk1…',
    sent: (amount: string) => `Sent ${usdt(amount)} USDT privately. The recipient will see it after their privacy check.`,
    link: 'View on Sepolia Etherscan (shows only that a private transaction happened)',
    again: 'Send again',
  },
  unshield: {
    title: 'Withdraw',
    intro:
      'Out of your private balance to a public address: as USDT on Ethereum Sepolia, or swapped through NEAR Intents into another token or chain.',
    toLabel: 'To (public 0x address on Ethereum Sepolia)',
    placeholder: '0x…',
    sent: (amount: string) => `Withdrew ${usdt(amount)} USDT. It arrives at the address once the transaction confirms.`,
    link: 'View on Sepolia Etherscan',
    again: 'Withdraw again',
  },
} as const;

interface Quote {
  quoteId: string;
  to: string;
  feeWei: string;
  railgunFee: string;
  /** Withdrawals: this address sent money into one of the user's deposits. */
  fundedDeposits?: boolean;
  receives: string;
  expiresAt: number;
}

/** A withdrawal swapped through Tidepool: where it arrives, and the refund record. */
interface Swap {
  token: Token;
  to: string;
  refund: DepositRecord;
  quote: SwapQuote;
  sentUsdt: string;
}

type Step =
  | { kind: 'form' }
  | { kind: 'quoting' }
  | ({ kind: 'review'; amount: string; swap?: Swap } & Quote)
  | { kind: 'sending' }
  | { kind: 'sent'; txHash: string; amount: string; swap?: Swap };

type PanelProps = { confirmWithPasskey: () => Promise<boolean> };
/** private: to a 0zk address (a private send). evm / sol: out to an Ethereum or Solana address (a withdrawal). */
export type SendMode = 'private' | 'evm' | 'sol';
const EVM_CHAINS = new Set(['eth', 'base', 'arb']);

export function SendPanel({
  mode,
  confirmWithPasskey,
  onBack,
  onDone,
  onStep,
}: PanelProps & { mode: SendMode; onBack: () => void; onDone: () => void; onStep: (s: Step['kind']) => void }) {
  const kind: Kind = mode === 'private' ? 'transfer' : 'unshield';
  const toast = useToast();
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  useEffect(() => onStep(step.kind), [step.kind, onStep]);
  /** Fields the last attempt refused: red outline until edited (errors themselves are toasts: Gold, 12 Nov). */
  const [amountBad, setAmountBad] = useState(false);
  const [toBad, setToBad] = useState(false);
  /** Withdrawals: '' = USDT on Ethereum Sepolia, else the Tidepool asset to swap into. */
  const [dest, setDest] = useState('');
  const [destTokens, setDestTokens] = useState<Token[]>([]);
  useEffect(() => {
    if (kind === 'unshield') void swapTokens().then(setDestTokens);
  }, [kind]);
  useSyncExternalStore(depositProgress.subscribe, depositProgress.version);
  const [error, setError] = useState('');
  /** Development builds only: the worker's real error, so testers can copy it without dev tools. */
  const [devDetail, setDevDetail] = useState('');
  const fail = (e: unknown, stage: string) => {
    const msg = explain(e, kind);
    setError(msg);
    toast.show({ kind: 'error', text: msg });
    const m = e instanceof Error ? e.message : '';
    if (m === 'insufficient-usdt' || /capped/i.test(m)) setAmountBad(true);
    if (m === 'invalid-address' || m === 'own-deposit-address') setToBad(true);
    const d = import.meta.env.DEV && e instanceof Error ? (e as Error & { devDetail?: string }).devDetail : undefined;
    setDevDetail(d ? `${stage}: ${e instanceof Error ? e.message : ''}\n${d}` : import.meta.env.DEV && e instanceof Error ? `${stage}: ${e.message}` : '');
  };
  // The SDK reports progress per proof stage, so it can restart at 0. Never show it going back.
  const shownProgress = useRef(0);
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    void ethPrice().then(setPrice);
  }, []);
  const copy = COPY[kind];
  const headingId = `${kind}-h`;

  const choices = destTokens.filter((t) => (mode === 'sol' ? t.blockchain === 'sol' : EVM_CHAINS.has(t.blockchain)));
  useEffect(() => {
    if (mode === 'sol' && !dest && choices[0]) setDest(choices[0].assetId);
  }, [mode, dest, choices]);

  // The form needs a synced wallet; a send that's running or done keeps its screen whatever the wallet does next
  // (it rescans right after a send), so "View" in Notifications always has something to show.
  if (pw.status !== 'ready' && step.kind !== 'sending' && step.kind !== 'sent') return null;
  const spendableUsdt =
    pw.balances.Spendable?.find((b) => b.tokenAddress.toLowerCase() === SEPOLIA_USDT.toLowerCase())?.amount ?? '0';
  const units = toUnits(amount, USDT_DECIMALS);
  const target = to.trim();
  const destToken = kind === 'unshield' ? choices.find((t) => t.assetId === dest) : undefined;
  const toSolana = destToken?.blockchain === 'sol';
  const addressProblem =
    toSolana
      ? SOL_ADDRESS.test(target)
        ? ''
        : 'That isn’t a valid Solana address.'
      : kind === 'transfer'
      ? !ZK_ADDRESS.test(target)
        ? 'That isn’t a private 0zk address.'
        : target === pw.railgunAddress
          ? 'That’s your own address.'
          : ''
      : ZK_ADDRESS.test(target)
        ? 'That’s a private address. To send to it, choose “Privately via Railgun”.'
        : !EVM_ADDRESS.test(target) || ZERO_ADDRESS.test(target)
          ? 'That isn’t a valid 0x address.'
          : '';
  const toOk = target !== '' && !addressProblem;

  const review = async () => {
    if (!units || !toOk) return;
    setError('');
    setDevDetail('');
    setStep({ kind: 'quoting' });
    try {
      if (!destToken) {
        const q = await privateWallet.call<Quote>('send.quote', { kind, to: target, amount: units });
        setStep({ kind: 'review', amount: units, ...q });
        return;
      }
      // Swapped withdrawal: price the swap for what reaches Tidepool after Railgun's fee,
      // then withdraw exactly that much to Tidepool's one-time swap address.
      const fees = await privateWallet.call<{ unshieldFeeBasisPoints: string | number | null }>('fees');
      if (fees.unshieldFeeBasisPoints === null) throw new Error('no-broadcaster');
      const p = await prepareSwapWithdrawal({
        destination: destToken,
        to: target,
        amount: units,
        unshieldFeeBasisPoints: BigInt(fees.unshieldFeeBasisPoints),
      });
      const q = await privateWallet.call<Quote>('send.quote', { kind, to: p.quote.depositAddress, amount: units, finalTo: target });
      if (q.receives !== p.sentUsdt) throw new Error('swap-mismatch');
      setStep({
        kind: 'review',
        amount: units,
        ...q,
        expiresAt: Math.min(q.expiresAt, Date.parse(p.quote.deadline)),
        swap: { token: destToken, to: target, refund: p.refund, quote: p.quote, sentUsdt: p.sentUsdt },
      });
    } catch (e) {
      fail(e, 'review');
      setStep({ kind: 'form' });
    }
  };

  const send = async (s: Extract<Step, { kind: 'review' }>) => {
    setError('');
    setDevDetail('');
    // D5: every send is confirmed with the passkey, after the summary.
    if (!(await confirmWithPasskey())) return;
    shownProgress.current = 0;
    // Listed in Notifications while it runs, so the pop-up can be closed and this screen reopened (Gold, 13 Nov).
    const dest = short(s.swap ? s.swap.to : s.to);
    const job = sendJobs.start(
      mode,
      kind === 'transfer'
        ? `Sending ${usdt(s.amount)} USDT privately to ${dest}`
        : `Withdrawing ${usdt(s.amount)} USDT${s.swap ? ` as ${s.swap.token.symbol}` : ''} to ${dest}`,
    );
    setStep({ kind: 'sending' });
    const w: WithdrawalSwap | null = s.swap
      ? {
          tidepoolDepositAddress: s.swap.quote.depositAddress,
          chain: s.swap.token.blockchain,
          symbol: s.swap.token.symbol,
          decimals: s.swap.token.decimals,
          to: s.swap.to,
          amountUsdt: s.amount,
          sentUsdt: s.swap.sentUsdt,
          expectedOut: s.swap.quote.amountOut,
          minOut: s.swap.quote.minAmountOut,
          deadline: s.swap.quote.deadline,
          status: 'sending',
        }
      : null;
    try {
      // Saved first, so a reload mid-send still follows the swap (and any refund).
      if (w && s.swap) await saveWithdrawal(s.swap.refund.index, w);
      const { txHash } = await privateWallet.call<{ txHash: string }>('send.execute', { quoteId: s.quoteId });
      if (w && s.swap) {
        const sent: WithdrawalSwap = { ...w, txHash, status: 'sent' };
        await saveWithdrawal(s.swap.refund.index, sent).catch(() => {});
        void trackWithdrawal({ ...s.swap.refund, withdrawal: sent });
      }
      sendJobs.sent(job, txHash);
      setStep({ kind: 'sent', txHash, amount: s.amount, swap: s.swap });
      setTo('');
      setAmount('');
    } catch (e) {
      sendJobs.drop(job);
      fail(e, 'send');
      setStep({ kind: 'form' });
      if (w && s.swap) {
        // Refused before sending: nothing left. Anything else: keep watching in case it went out.
        const known = e instanceof Error && Object.hasOwn(ERRORS, e.message);
        if (known) void saveWithdrawal(s.swap.refund.index, { ...w, status: 'failed' }).catch(() => {});
        else void trackWithdrawal({ ...s.swap.refund, withdrawal: w });
      }
    } finally {
      privateWallet.clearSendProgress();
    }
  };

  // ---------- the pop-up's screens (Figma 445:6734 options, 445:6965 private, 446:7312 Ethereum, 446:7449 Solana) ----------
  const amountWarn = amountBad;
  const toWarn = (target !== '' && !!addressProblem) || toBad;
  const fieldFor = (label: string, input: React.ReactNode, bad: boolean, extra?: React.ReactNode) => (
    <label className="sheet-group">
      <span className="sheet-label">{label}</span>
      <span className={`sheet-field${bad ? ' is-error' : ''}`}>
        {input}
        {extra}
      </span>
    </label>
  );
  const setMax = () => setAmount(formatUnits(spendableUsdt, USDT_DECIMALS, 6));

  return (
    <>
      {(step.kind === 'form' || step.kind === 'quoting') && (
        <form className="sheet-body is-form" onSubmit={(e) => (e.preventDefault(), void review())}>
          {fieldFor(
            mode === 'private' ? '0zk address' : 'Address',
            <input
              value={to}
              onChange={(e) => (setTo(e.target.value), setToBad(false))}
              placeholder={mode === 'private' ? '0zk1…' : mode === 'sol' ? 'Solana address' : '0x…'}
              aria-invalid={toWarn}
              autoComplete="off"
              spellCheck={false}
              required
            />,
            toWarn,
          )}
          {mode !== 'private' && (
            <label className="sheet-group">
              <span className="sheet-label">Select token</span>
              <span className="sheet-field is-select">
                <select value={dest} onChange={(e) => setDest(e.target.value)} data-testid="withdraw-receive-as">
                  {mode === 'evm' && <option value="">USDT on Ethereum Sepolia</option>}
                  {choices.map((t) => (
                    <option key={t.assetId} value={t.assetId}>
                      {t.symbol} on {chainName(t.blockchain)}
                    </option>
                  ))}
                </select>
                <img src="/img/chevron-down.svg" alt="" width={15} height={15} />
              </span>
            </label>
          )}
          {fieldFor(
            'Enter amount',
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => (setAmount(e.target.value), setAmountBad(false))}
              placeholder="E.g. $5"
              aria-invalid={amountWarn}
              required
            />,
            amountWarn,
            <button type="button" className="icon-btn sheet-copy" onClick={setMax} aria-label={`Use everything spendable (${usd(spendableUsdt, USDT_DECIMALS)})`} title="Use everything spendable">
              <img src="/img/infinity.svg" alt="" width={15} height={15} />
            </button>,
          )}
          <div className="sheet-actions">
            <button type="button" className="sheet-btn" onClick={onBack}>
              Cancel
            </button>
            <button type="submit" className="sheet-btn is-primary" disabled={step.kind === 'quoting' || !units || !toOk} aria-busy={step.kind === 'quoting'}>
              {step.kind === 'quoting' ? <img className="sheet-btn-spinner" src="/img/loader-spinning.svg" alt="Getting the network fee" width={18} height={18} /> : 'Review'}
            </button>
          </div>
        </form>
      )}

      {step.kind === 'review' && (
        <div className="sheet-body" aria-label={kind === 'transfer' ? 'Review send' : 'Review withdrawal'}>
          <dl className="sheet-summary">
            <div>
              <dt>To</dt>
              <dd>
                <code className="address" title={step.swap ? step.swap.to : step.to}>
                  {short(step.swap ? step.swap.to : step.to)}
                </code>
              </dd>
            </div>
            <div>
              <dt>{kind === 'transfer' ? 'You send' : 'You withdraw'}</dt>
              <dd>{usd(step.amount, USDT_DECIMALS, { exact: true })}</dd>
            </div>
            {kind === 'unshield' && (
              <div>
                <dt>Railgun fee (0.25%)</dt>
                <dd>{usd(step.railgunFee, USDT_DECIMALS, { exact: true })}</dd>
              </div>
            )}
            {kind === 'unshield' && !step.swap && (
              <div>
                <dt>Arrives</dt>
                <dd data-testid="withdraw-receives">{usdt(step.receives)} USDT</dd>
              </div>
            )}
            {step.swap && (
              <div>
                <dt>Arrives</dt>
                <dd data-testid="withdraw-swap-receives">
                  about {out(step.swap.quote.amountOut, step.swap.token)} {step.swap.token.symbol} on {chainName(step.swap.token.blockchain)}
                </dd>
              </div>
            )}
            <div>
              <dt>Network fee</dt>
              <dd>{feeInUsdt(step.feeWei, price)}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{new Date(step.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
            </div>
          </dl>
          {step.swap && (
            <p className="sheet-note">
              Swapped through NEAR Intents (Tidepool’s testnet): at least {out(step.swap.quote.minAmountOut, step.swap.token)}{' '}
              {step.swap.token.symbol}, or the swap is cancelled and the USDT comes back to your private balance. Tidepool sees the
              address you’re withdrawing to.
            </p>
          )}
          {kind === 'unshield' && (
            <div className="sheet-warning" role="note">
              <img src="/img/alert-triangle.svg" alt="" width={15} height={15} />
              <p>
                <strong>This part is public.</strong> Anyone can see this amount arriving at this address, but not that it came from
                you. Use an address that isn’t linked to you, and don’t withdraw the exact amount you just deposited.
              </p>
            </div>
          )}
          {step.fundedDeposits && (
            <div className="sheet-warning is-danger" role="alert" data-testid="withdraw-linked-warning">
              <img src="/img/alert-triangle.svg" alt="" width={15} height={15} />
              <p>
                <strong>This address sent money into your Login account.</strong> Anyone can see both on-chain, so this withdrawal can be
                tied to you. To keep it private, withdraw to a fresh address instead.
              </p>
            </div>
          )}
          <div className="sheet-actions">
            <button type="button" className="sheet-btn" onClick={() => setStep({ kind: 'form' })}>
              Back
            </button>
            <button type="button" className="sheet-btn is-primary" onClick={() => void send(step)}>
              Confirm with passkey
            </button>
          </div>
        </div>
      )}

      {step.kind === 'sending' && (
        <div className="sheet-body sheet-progress">
          <img src="/img/loader-spinning.svg" alt="" width={28} height={28} />
          <p role="status" data-testid={`${kind}-status`}>
            {pw.sendProgress === null || pw.sendProgress < 100
              ? `Creating the privacy proof… ${Math.round((shownProgress.current = Math.max(shownProgress.current, pw.sendProgress ?? 0)))}%`
              : 'Submitting through the network relay…'}
          </p>
          <span className="sheet-note">This takes a little while. You can close this; it keeps going, and Notifications shows its progress.</span>
        </div>
      )}

      {step.kind === 'sent' && (
        <div className="sheet-body sheet-progress">
          <img src="/img/check-circled.svg" alt="" width={28} height={28} />
          <p role="status" data-testid={`${kind}-status`}>
            {step.swap ? swapStatus(step.amount, step.swap, depositProgress.get(step.swap.refund.index)) : copy.sent(step.amount)}
          </p>
          <a className="sheet-note" href={sepoliaTx(step.txHash)} target="_blank" rel="noreferrer">
            {copy.link}
          </a>
          <div className="sheet-actions">
            <button type="button" className="sheet-btn" onClick={onDone}>
              Close
            </button>
            <button type="button" className="sheet-btn is-primary" onClick={() => setStep({ kind: 'form' })}>
              {copy.again}
            </button>
          </div>
        </div>
      )}

      {import.meta.env.DEV && devDetail && (
        <details className="sheet-note">
          <summary>Technical details (development build only)</summary>
          <pre className="dev-detail" data-testid={`${kind}-dev-detail`}>{devDetail}</pre>
        </details>
      )}
    </>
  );
}
