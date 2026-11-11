/**
 * "Send privately" (to another private 0zk address) and "Withdraw" (out to a
 * public Sepolia address). Same steps for both: review, confirm with passkey,
 * proof, broadcaster. TESTNET ONLY.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
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
  'insufficient-usdt': 'You don’t have that much spendable USDT. Deposits become spendable once their privacy check clears.',
  'insufficient-fee-balance':
    'Your network-fee reserve isn’t ready, so this can’t be sent yet. Right after a send or withdrawal, it goes through the privacy check again (your balance shows “Network fees: being set up”). Try again once it shows “Network fees are covered”. If it’s used up, your next deposit refills it.',
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

export function SendPrivately(props: PanelProps) {
  return <SendPanel kind="transfer" {...props} />;
}

export function Withdraw(props: PanelProps) {
  return <SendPanel kind="unshield" {...props} />;
}

function SendPanel({ kind, confirmWithPasskey }: PanelProps & { kind: Kind }) {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
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
    setError(explain(e, kind));
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

  if (pw.status !== 'ready') return null;
  const spendableUsdt =
    pw.balances.Spendable?.find((b) => b.tokenAddress.toLowerCase() === SEPOLIA_USDT.toLowerCase())?.amount ?? '0';
  const units = toUnits(amount, USDT_DECIMALS);
  const target = to.trim();
  const destToken = kind === 'unshield' ? destTokens.find((t) => t.assetId === dest) : undefined;
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
        ? 'That’s a private address. To send to it, use “Send privately”.'
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
      setStep({ kind: 'sent', txHash, amount: s.amount, swap: s.swap });
      setTo('');
      setAmount('');
    } catch (e) {
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

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {copy.title} <span className="badge">Testnet</span>
      </h2>
      <p className="muted small">
        {copy.intro} Spendable now: {formatUnits(spendableUsdt, USDT_DECIMALS)} USDT.
      </p>

      {(step.kind === 'form' || step.kind === 'quoting') && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void review())}>
          {kind === 'unshield' && destTokens.length > 0 && (
            <label>
              Receive as
              <select value={dest} onChange={(e) => setDest(e.target.value)} data-testid="withdraw-receive-as">
                <option value="">USDT on Ethereum Sepolia</option>
                {destTokens.map((t) => (
                  <option key={t.assetId} value={t.assetId}>
                    {t.symbol} on {chainName(t.blockchain)} (swapped through NEAR Intents)
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {destToken
              ? `To (your ${toSolana ? 'Solana' : '0x'} address on ${chainName(destToken.blockchain)})`
              : copy.toLabel}
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={toSolana ? 'Solana address' : copy.placeholder} required />
            {target && addressProblem && <span className="error small">{addressProblem}</span>}
          </label>
          <label>
            Amount (USDT)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1" required />
          </label>
          <button type="submit" className="primary" disabled={step.kind === 'quoting' || !units || !toOk}>
            {step.kind === 'quoting' ? 'Getting the network fee…' : 'Review'}
          </button>
        </form>
      )}

      {step.kind === 'review' && (
        <div className="stack" aria-label={kind === 'transfer' ? 'Review send' : 'Review withdrawal'}>
          {kind === 'transfer' ? (
            <p>
              Send <strong>{usdt(step.amount)} USDT</strong> to <code className="address">{short(step.to)}</code>
            </p>
          ) : step.swap ? (
            <>
              <p>
                Withdraw <strong>{usdt(step.amount)} USDT</strong>, arriving as{' '}
                <strong data-testid="withdraw-swap-receives">
                  about {out(step.swap.quote.amountOut, step.swap.token)} {step.swap.token.symbol}
                </strong>{' '}
                on {chainName(step.swap.token.blockchain)} at <code className="address">{step.swap.to}</code>
              </p>
              <p className="small">
                Railgun’s withdrawal fee: <strong>{usdt(step.railgunFee)} USDT</strong>. The other {usdt(step.receives)} USDT is
                swapped through NEAR Intents (Tidepool’s testnet). If the rate moves, you get at least{' '}
                {out(step.swap.quote.minAmountOut, step.swap.token)} {step.swap.token.symbol}, or the swap is cancelled and the
                USDT comes back to your private balance. Tidepool sees the address you’re withdrawing to.
              </p>
              <p className="warning small" role="note">
                <strong>This part is public.</strong> Anyone can see this amount arriving at this address, but not that it
                came from you. To keep it that way, use an address that isn’t linked to you, and don’t withdraw the exact
                amount you just deposited.
              </p>
              {step.fundedDeposits && (
                <p className="error small" role="alert" data-testid="withdraw-linked-warning">
                  <strong>This address sent money into your Login account.</strong> Anyone can see both on-chain, so this
                  withdrawal can be tied to you. To keep it private, withdraw to a fresh address instead.
                </p>
              )}
            </>
          ) : (
            <>
              <p>
                Withdraw <strong>{usdt(step.amount)} USDT</strong> to <code className="address">{step.to}</code>
              </p>
              <p className="small">
                Railgun’s withdrawal fee: <strong>{usdt(step.railgunFee)} USDT</strong>. The address receives{' '}
                <strong data-testid="withdraw-receives">{usdt(step.receives)} USDT</strong>.
              </p>
              <p className="warning small" role="note">
                <strong>This part is public.</strong> Anyone can see this amount arriving at this address, but not that it
                came from you. To keep it that way, use an address that isn’t linked to you, and don’t withdraw the exact
                amount you just deposited.
              </p>
              {step.fundedDeposits && (
                <p className="error small" role="alert" data-testid="withdraw-linked-warning">
                  <strong>This address sent money into your Login account.</strong> Anyone can see both on-chain, so this
                  withdrawal can be tied to you. To keep it private, withdraw to a fresh address instead.
                </p>
              )}
            </>
          )}
          <p className="small">
            Network fee: <strong>{feeInUsdt(step.feeWei, price)}</strong>, paid to the relay that submits it. Quote valid until{' '}
            {new Date(step.expiresAt).toLocaleTimeString()}.
          </p>
          <div className="row">
            <button className="primary" onClick={() => void send(step)}>
              Confirm with passkey
            </button>
            <button className="link" onClick={() => setStep({ kind: 'form' })}>
              Back
            </button>
          </div>
        </div>
      )}

      {step.kind === 'sending' && (
        <p role="status" className="info" data-testid={`${kind}-status`}>
          {pw.sendProgress === null || pw.sendProgress < 100
            ? `Creating the privacy proof… ${Math.round((shownProgress.current = Math.max(shownProgress.current, pw.sendProgress ?? 0)))}% (this takes a little while)`
            : 'Submitting through the network relay…'}
        </p>
      )}

      {step.kind === 'sent' && (
        <div className="stack">
          <p role="status" className="info" data-testid={`${kind}-status`}>
            {step.swap ? swapStatus(step.amount, step.swap, depositProgress.get(step.swap.refund.index)) : copy.sent(step.amount)}
          </p>
          <a className="small" href={sepoliaTx(step.txHash)} target="_blank" rel="noreferrer">
            {copy.link}
          </a>
          <button className="link" onClick={() => setStep({ kind: 'form' })}>
            {copy.again}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {import.meta.env.DEV && devDetail && (
        <details className="small">
          <summary>Technical details (development build only)</summary>
          <pre className="dev-detail" data-testid={`${kind}-dev-detail`}>{devDetail}</pre>
        </details>
      )}
    </section>
  );
}
