/** "Send privately": USDT to another private (0zk) address. TESTNET ONLY. */
import { useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { SEPOLIA_USDT, USDT_DECIMALS } from '../railgun/protocol.ts';
import { formatUnits, toUnits } from '../deposits/tidepool.ts';

const ZK_ADDRESS = /^0zk1[02-9ac-hj-np-z]{100,140}$/;
const sepoliaTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const ERRORS: Record<string, string> = {
  'invalid-address': 'That isn’t a private Login (0zk) address.',
  'insufficient-usdt': 'You don’t have that much spendable USDT. Deposits become spendable once their privacy check clears.',
  'insufficient-fee-balance': 'Not enough private ETH for the network fee. Your next deposit adds some automatically.',
  'no-broadcaster': 'No network relay is available right now. Try again in a minute.',
  'fee-too-high': 'The network fee quoted is unusually high, so we stopped. Try again later.',
  'quote-expired': 'The fee quote expired. Review the send again.',
  'Wallet locked.': 'Your wallet locked. Unlock and try again.',
};
const explain = (e: unknown) => (e instanceof Error && ERRORS[e.message]) || 'The send didn’t go through. Nothing was sent.';

type Step =
  | { kind: 'form' }
  | { kind: 'quoting' }
  | { kind: 'review'; quoteId: string; to: string; amount: string; feeWei: string; expiresAt: number }
  | { kind: 'sending' }
  | { kind: 'sent'; txHash: string; to: string; amount: string };

export function SendPrivately({ confirmWithPasskey }: { confirmWithPasskey: () => Promise<boolean> }) {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState('');

  if (pw.status !== 'ready') return null;
  const spendableUsdt =
    pw.balances.Spendable?.find((b) => b.tokenAddress.toLowerCase() === SEPOLIA_USDT.toLowerCase())?.amount ?? '0';
  const units = toUnits(amount, USDT_DECIMALS);
  const toOk = ZK_ADDRESS.test(to.trim()) && to.trim() !== pw.railgunAddress;

  const review = async () => {
    if (!units || !toOk) return;
    setError('');
    setStep({ kind: 'quoting' });
    try {
      const q = await privateWallet.call<{ quoteId: string; feeWei: string; expiresAt: number }>('send.quote', {
        to: to.trim(),
        amount: units,
      });
      setStep({ kind: 'review', ...q, to: to.trim(), amount: units });
    } catch (e) {
      setError(explain(e));
      setStep({ kind: 'form' });
    }
  };

  const send = async (s: Extract<Step, { kind: 'review' }>) => {
    setError('');
    // D5: every send is confirmed with the passkey, after the summary.
    if (!(await confirmWithPasskey())) return;
    setStep({ kind: 'sending' });
    try {
      const { txHash } = await privateWallet.call<{ txHash: string }>('send.execute', { quoteId: s.quoteId });
      setStep({ kind: 'sent', txHash, to: s.to, amount: s.amount });
      setTo('');
      setAmount('');
    } catch (e) {
      setError(explain(e));
      setStep({ kind: 'form' });
    } finally {
      privateWallet.clearSendProgress();
    }
  };

  return (
    <section className="card" aria-labelledby="send-h">
      <h2 id="send-h">
        Send privately <span className="badge">Testnet</span>
      </h2>
      <p className="muted small">
        To another private address. Nobody else can see the amount, the sender or the recipient. Spendable now:{' '}
        {formatUnits(spendableUsdt, USDT_DECIMALS)} USDT.
      </p>

      {(step.kind === 'form' || step.kind === 'quoting') && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void review())}>
          <label>
            To (private 0zk address)
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0zk1…" required />
            {to && !toOk && (
              <span className="error small">
                {to.trim() === pw.railgunAddress ? 'That’s your own address.' : 'That isn’t a private 0zk address.'}
              </span>
            )}
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
        <div className="stack" aria-label="Review send">
          <p>
            Send <strong>{formatUnits(step.amount, USDT_DECIMALS, 6)} USDT</strong> to{' '}
            <code className="address">
              {step.to.slice(0, 14)}…{step.to.slice(-8)}
            </code>
          </p>
          <p className="small">
            Network fee: <strong>{formatUnits(step.feeWei, 18, 6)} ETH</strong>, paid from your private ETH balance to the
            relay that submits it. Quote valid until {new Date(step.expiresAt).toLocaleTimeString()}.
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
        <p role="status" className="info" data-testid="send-status">
          {pw.sendProgress === null || pw.sendProgress < 100
            ? `Creating the privacy proof… ${Math.round(pw.sendProgress ?? 0)}% (this takes a little while)`
            : 'Submitting through the network relay…'}
        </p>
      )}

      {step.kind === 'sent' && (
        <div className="stack">
          <p role="status" className="info" data-testid="send-status">
            Sent {formatUnits(step.amount, USDT_DECIMALS, 6)} USDT privately. The recipient will see it after their privacy
            check.
          </p>
          <a className="small" href={sepoliaTx(step.txHash)} target="_blank" rel="noreferrer">
            View on Sepolia Etherscan (shows only that a private transaction happened)
          </a>
          <button className="link" onClick={() => setStep({ kind: 'form' })}>
            Send again
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
