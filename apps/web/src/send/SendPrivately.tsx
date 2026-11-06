/**
 * "Send privately" (to another private 0zk address) and "Withdraw" (out to a
 * public Sepolia address). Same steps for both: review, confirm with passkey,
 * proof, broadcaster. TESTNET ONLY.
 */
import { useRef, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { SEPOLIA_USDT, USDT_DECIMALS } from '../railgun/protocol.ts';
import { formatUnits, toUnits } from '../deposits/tidepool.ts';

type Kind = 'transfer' | 'unshield';

const ZK_ADDRESS = /^0zk1[02-9ac-hj-np-z]{100,140}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const sepoliaTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const ERRORS: Record<string, string> = {
  'invalid-address': 'That address isn’t valid.',
  'own-deposit-address':
    'That’s one of your own Login deposit addresses. It’s publicly linked to your deposits, so withdrawing there would undo the privacy. Use a different address.',
  'insufficient-usdt': 'You don’t have that much spendable USDT. Deposits become spendable once their privacy check clears.',
  'insufficient-fee-balance': 'Not enough private ETH for the network fee. Your next deposit adds some automatically.',
  'no-broadcaster': 'No network relay is available right now. Try again in a minute.',
  'fee-too-high': 'The network fee quoted is unusually high, so we stopped. Try again later.',
  'quote-expired': 'The fee quote expired. Review it again.',
  'broadcaster-refused':
    'The network relay couldn’t confirm the privacy check on your funds, so nothing was sent. Press Review again to use a different relay.',
  'Wallet locked.': 'Your wallet locked. Unlock and try again.',
};
const explain = (e: unknown, kind: Kind) =>
  (e instanceof Error && ERRORS[e.message]) ||
  (kind === 'transfer' ? 'The send didn’t go through. Nothing was sent.' : 'The withdrawal didn’t go through. Nothing was sent.');

/** Sepolia gas is nearly free, so show enough digits that a real fee never reads as 0. */
const formatFee = (wei: string) => (BigInt(wei) < 1_000_000_000n ? '< 0.000000001' : formatUnits(wei, 18, 9));
const usdt = (units: string) => formatUnits(units, USDT_DECIMALS, 6);
const short = (a: string) => `${a.slice(0, 14)}…${a.slice(-8)}`;

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
    intro: 'Out of your private balance to a public Sepolia address, as USDT.',
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
  receives: string;
  expiresAt: number;
}

type Step =
  | { kind: 'form' }
  | { kind: 'quoting' }
  | ({ kind: 'review'; amount: string } & Quote)
  | { kind: 'sending' }
  | { kind: 'sent'; txHash: string; amount: string };

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
  const copy = COPY[kind];
  const headingId = `${kind}-h`;

  if (pw.status !== 'ready') return null;
  const spendableUsdt =
    pw.balances.Spendable?.find((b) => b.tokenAddress.toLowerCase() === SEPOLIA_USDT.toLowerCase())?.amount ?? '0';
  const units = toUnits(amount, USDT_DECIMALS);
  const target = to.trim();
  const addressProblem =
    kind === 'transfer'
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
      const q = await privateWallet.call<Quote>('send.quote', { kind, to: target, amount: units });
      setStep({ kind: 'review', amount: units, ...q });
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
    try {
      const { txHash } = await privateWallet.call<{ txHash: string }>('send.execute', { quoteId: s.quoteId });
      setStep({ kind: 'sent', txHash, amount: s.amount });
      setTo('');
      setAmount('');
    } catch (e) {
      fail(e, 'send');
      setStep({ kind: 'form' });
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
          <label>
            {copy.toLabel}
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={copy.placeholder} required />
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
            </>
          )}
          <p className="small">
            Network fee: <strong>{formatFee(step.feeWei)} ETH</strong>, paid from your private ETH balance to the relay that
            submits it. Quote valid until {new Date(step.expiresAt).toLocaleTimeString()}.
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
            {copy.sent(step.amount)}
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
