/** "Add money": deposit from another chain into the private balance. TESTNET ONLY. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { USDT_DECIMALS, type DepositRecord } from '../railgun/protocol.ts';
import { depositProgress, resumeAll, startDeposit, track, type Stage } from './flow.ts';
import {
  CHAIN_NAMES,
  formatUnits,
  isValidAddress,
  loadTokens,
  toUnits,
  type OriginChain,
  type Quote,
  type Token,
} from './tidepool.ts';

const sepoliaTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

function useWallet() {
  return useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
}
function useProgress() {
  useSyncExternalStore(depositProgress.subscribe, depositProgress.version);
}

function stageText(stage: Stage | undefined, record: DepositRecord): string {
  if (stage?.kind === 'waiting-payment') {
    return {
      PENDING_DEPOSIT: 'Waiting for your payment…',
      KNOWN_DEPOSIT_TX: 'Payment seen. Confirming…',
      PROCESSING: 'Swapping into USDT…',
      SUCCESS: 'Swapped.',
      INCOMPLETE_DEPOSIT: 'The payment was less than the quoted amount. Send the rest, or wait for a refund.',
      REFUNDED: 'Refunded.',
      FAILED: 'The swap failed.',
    }[stage.swap];
  }
  switch (stage?.kind) {
    case 'waiting-direct':
      return 'Waiting for your USDT to arrive at your deposit address…';
    case 'arriving':
      return 'USDT arriving at your deposit address…';
    case 'adding-gas':
      return 'Adding testnet gas (Login testnet faucet)…';
    case 'shielding':
      return 'Moving it into your private balance…';
    case 'done':
      return 'Done. It’s in your private balance (it may show as “being checked” for a few minutes).';
    case 'refunded':
      return record.quote?.originChain === 'sol'
        ? 'The swap didn’t happen. Your tokens were refunded to your Solana wallet.'
        : 'The swap didn’t happen. Your tokens were refunded to your deposit address on the sending chain.';
    case 'failed':
      return stage.reason;
    case 'needs-finish':
      return 'This deposit arrived but isn’t in your private balance yet.';
  }
  return {
    new: 'Not started.',
    'awaiting-delivery': 'Waiting for your payment…',
    delivered: 'Arrived. Not yet in your private balance.',
    shielding: 'Moving it into your private balance…',
    shielded: 'In your private balance.',
    refunded: 'Refunded.',
    failed: 'Failed.',
  }[record.status];
}

export function AddMoney() {
  const pw = useWallet();
  useProgress();
  const [tokens, setTokens] = useState<{ usdt: Token; origins: Token[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState('');
  const [amount, setAmount] = useState('');
  const [solanaRefund, setSolanaRefund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<{ record: DepositRecord; quote: Quote } | null>(null);
  const [shieldFeeBp, setShieldFeeBp] = useState<number | null>(null);

  useEffect(() => {
    loadTokens().then(setTokens, (e: Error) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    if (pw.status !== 'ready') return;
    privateWallet.call<{ shieldFeeBasisPoints: string | null }>('fees').then(
      (f) => setShieldFeeBp(f.shieldFeeBasisPoints ? Number(f.shieldFeeBasisPoints) : null),
      () => {},
    );
  }, [pw.status]);
  // Resume anything left in flight (reload, or another device).
  useEffect(() => {
    if (pw.status === 'ready' || pw.status === 'syncing') resumeAll(pw.deposits);
  }, [pw.status, pw.deposits]);

  if (pw.status === 'off' || pw.status === 'starting' || pw.status === 'error') return null;

  const origin = tokens?.origins.find((t) => t.assetId === choice);
  const units = origin ? toUnits(amount, origin.decimals) : null;
  const needsSolanaRefund = origin?.blockchain === 'sol';
  const solanaOk = !needsSolanaRefund || isValidAddress('sol', solanaRefund.trim());
  const afterShield = (usdt: string) =>
    shieldFeeBp === null ? null : ((BigInt(usdt) * BigInt(10_000 - shieldFeeBp)) / 10_000n).toString();

  const submit = async () => {
    if (!tokens || !origin || !units || !solanaOk) return;
    setError('');
    setBusy(true);
    try {
      setActive(await startDeposit({ origin, usdt: tokens.usdt, amount: units, solanaRefund: solanaRefund.trim() }));
    } catch (e) {
      setError(e instanceof Error && e.message !== 'Error' ? e.message : 'Couldn’t start the deposit. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const history = [...pw.deposits].filter((d) => d.status !== 'new').reverse();

  return (
    <section className="card" aria-labelledby="add-h">
      <h2 id="add-h">
        Add money <span className="badge">Testnet</span>
      </h2>
      <p className="muted small">
        Send tokens from another chain. They arrive as USDT in your private balance. Uses Tidepool, a community testnet for
        NEAR Intents.
      </p>
      {loadError && <p className="error" role="alert">Couldn’t reach Tidepool: {loadError}</p>}

      {!active && tokens && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void submit())}>
          <label>
            Send from
            <select value={choice} onChange={(e) => setChoice(e.target.value)} required>
              <option value="">Choose a token…</option>
              {tokens.origins.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol} on {CHAIN_NAMES[t.blockchain as OriginChain]}
                  {t.assetId === tokens.usdt.assetId ? ' (direct, no swap)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5" required />
          </label>
          {needsSolanaRefund && (
            <label>
              Your Solana address (refunds go here if the swap fails)
              <input value={solanaRefund} onChange={(e) => setSolanaRefund(e.target.value)} required />
              {solanaRefund && !solanaOk && <span className="error small">That isn’t a Solana address.</span>}
            </label>
          )}
          <button type="submit" className="primary" disabled={busy || !units || !solanaOk}>
            {busy ? 'Getting a quote…' : 'Get deposit address'}
          </button>
        </form>
      )}

      {active && (
        <div className="stack" aria-label="Deposit instructions">
          <p>
            Send exactly{' '}
            <strong>
              {active.quote.amountInFormatted || active.quote.amountIn} {active.record.quote?.originSymbol}
            </strong>{' '}
            on <strong>{CHAIN_NAMES[active.record.quote!.originChain as OriginChain]}</strong> to:
          </p>
          <div className="row">
            <code className="address" data-testid="tidepool-deposit-address">
              {active.quote.depositAddress}
            </code>
            <button className="link" onClick={() => void navigator.clipboard.writeText(active.quote.depositAddress)}>
              Copy
            </button>
          </div>
          {active.record.quote?.direct && (
            <p className="small muted">
              Direct deposit: no swap, so this skips NEAR Intents. On-chain, your wallet will be visible as the sender to
              this deposit address. To hide it, deposit a different token so the swap sends it instead.
            </p>
          )}
          <p className="small">
            You’ll receive about <strong>{formatUnits(afterShield(active.quote.amountOut) ?? active.quote.amountOut, USDT_DECIMALS)} USDT</strong>{' '}
            privately (at least {formatUnits(afterShield(active.quote.minAmountOut) ?? active.quote.minAmountOut, USDT_DECIMALS)}).
            {shieldFeeBp !== null &&
              (active.record.quote?.direct
                ? ` Includes Railgun’s ${shieldFeeBp / 100}% fee for entering the private pool.`
                : ` Includes Tidepool’s rate and Railgun’s ${shieldFeeBp / 100}% fee for entering the private pool.`)}{' '}
            Gas is covered on testnet.{' '}
            {active.record.quote?.direct
              ? 'This address stays open for 24 hours.'
              : `Quote valid until ${new Date(active.quote.deadline).toLocaleTimeString()}.`}
          </p>
          <p role="status" className="info" data-testid="active-deposit-status">
            {stageText(depositProgress.get(active.record.index), active.record)}
          </p>
          <button className="link" onClick={() => setActive(null)}>
            Start another deposit
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {history.length > 0 && (
        <>
          <h3 className="small">Your deposits</h3>
          <ul className="passkeys" aria-label="Deposits">
            {history.map((d) => {
              const stage = depositProgress.get(d.index);
              const canFinish = stage?.kind === 'needs-finish' || (stage?.kind === 'failed' && d.status === 'delivered');
              return (
                <li key={d.index}>
                  <div>
                    <strong>
                      {d.quote ? `${d.quote.amountInFormatted || d.quote.amountIn} ${d.quote.originSymbol} from ${CHAIN_NAMES[d.quote.originChain as OriginChain]}` : `Deposit #${d.index + 1}`}
                    </strong>
                    <div className="muted small" data-testid={`deposit-${d.index}-status`}>
                      {stageText(stage, d)}
                    </div>
                    {d.shieldTx && (
                      <a className="small" href={sepoliaTx(d.shieldTx)} target="_blank" rel="noreferrer">
                        View on Sepolia Etherscan
                      </a>
                    )}
                  </div>
                  {canFinish && (
                    <button onClick={() => void track({ ...d, status: 'delivered' })}>Finish deposit</button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
