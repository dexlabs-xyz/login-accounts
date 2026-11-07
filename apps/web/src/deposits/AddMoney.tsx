/**
 * "Add money": into the private balance, always as USDT. TESTNET ONLY.
 *   - From an Ethereum wallet: our own fresh address on Ethereum Sepolia; send
 *     USDT, USDC or ETH, any amount (USDC and ETH are swapped through Tidepool).
 *   - From Solana: Tidepool's own deposit address (team decision, 6 Nov).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { SEPOLIA_USDC, USDC_DECIMALS, USDT_DECIMALS, type DepositRecord } from '../railgun/protocol.ts';
import { depositProgress, resumeAll, startDeposit, startEvmDeposit, track, type Stage } from './flow.ts';
import { mainnetPriceCheck, type MainnetPrice } from './mainnet.ts';
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

/** USDC that ended up in the private balance as USDC: say so. */
function usdcNote(record: DepositRecord): string | null {
  if (record.quote?.anyToken) {
    const refunded = record.swaps?.some((s) => s.token === 'USDC' && (s.status === 'refunded' || s.status === 'failed'));
    return refunded ? 'Tidepool couldn’t swap your USDC into USDT, so it went into your private balance as USDC.' : null;
  }
  const shielded = record.shieldedTokens?.find((t) => t.token.toLowerCase() === SEPOLIA_USDC.toLowerCase())?.amount;
  const seen = shielded ?? depositProgress.usdc(record.index);
  if (!seen) return null;
  const amount = formatUnits(seen, USDC_DECIMALS, 6);
  return shielded
    ? `You sent ${amount} USDC instead of USDT. It went into your private balance as USDC.`
    : `You sent ${amount} USDC instead of USDT. That’s fine: it’s going into your private balance as USDC.`;
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
    case 'waiting-evm':
      return 'Waiting for USDT, USDC or ETH to arrive at your deposit address…';
    case 'swapping':
      return {
        PENDING_DEPOSIT: `Swapping your ${stage.token} into USDT…`,
        KNOWN_DEPOSIT_TX: `Swapping your ${stage.token} into USDT…`,
        PROCESSING: `Swapping your ${stage.token} into USDT…`,
        SUCCESS: `Swapped your ${stage.token} into USDT.`,
        INCOMPLETE_DEPOSIT: `Swapping your ${stage.token} into USDT…`,
        REFUNDED: `Tidepool couldn’t swap your ${stage.token}; it was returned to your deposit address.`,
        FAILED: `The ${stage.token} swap failed.`,
      }[stage.swap];
    case 'waiting-direct':
      return 'Waiting for your USDT to arrive at your deposit address…';
    case 'arriving':
      return record.quote?.anyToken ? 'Arrived at your deposit address…' : 'USDT arriving at your deposit address…';
    case 'adding-gas':
      return 'Adding testnet gas (Login testnet faucet)…';
    case 'shielding':
      return 'Moving it into your private balance…';
    case 'done':
      return 'Done. It’s in your private balance. A privacy check runs first, so it shows as “being checked” before you can spend it, usually about an hour, sometimes longer. Your wallet may lock while you wait; the balance catches up when you unlock.';
    case 'refunded':
      return record.quote?.originChain === 'sol'
        ? 'The swap didn’t happen. Your tokens were refunded to your Solana wallet.'
        : 'The swap didn’t happen. Your tokens were refunded to your deposit address on the sending chain.';
    case 'failed':
      return stage.reason;
    case 'needs-finish':
      return 'This deposit arrived but isn’t in your private balance yet.';
    case 'late-funds':
      return 'More money arrived at this deposit address after the deposit finished. Press “Finish deposit” to move it into your private balance.';
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
  const [evm, setEvm] = useState<DepositRecord | null>(null);
  const [source, setSource] = useState<'evm' | 'sol' | null>(null);
  /** Read-only mainnet NEAR Intents price check (approved exception); hidden on any error. */
  const [mainnet, setMainnet] = useState<MainnetPrice | null>(null);
  useEffect(() => {
    if (!evm) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    mainnetPriceCheck(ctl.signal).then(setMainnet, () => setMainnet(null)).finally(() => clearTimeout(timer));
    return () => (ctl.abort(), clearTimeout(timer));
  }, [evm]);
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

  const startEvm = async () => {
    setError('');
    setBusy(true);
    try {
      setEvm(await startEvmDeposit());
    } catch (e) {
      setError(e instanceof Error && e.message !== 'Error' ? e.message : 'Couldn’t start the deposit. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setActive(null);
    setEvm(null);
    setSource(null);
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  const history = [...pw.deposits].filter((d) => d.status !== 'new').reverse();

  return (
    <section className="card" aria-labelledby="add-h">
      <h2 id="add-h">
        Add money <span className="badge">Testnet</span>
      </h2>
      <p className="muted small">
        Whatever you send arrives as USDT in your private balance. Swaps use Tidepool, a community testnet for NEAR Intents.
      </p>
      {loadError && <p className="error" role="alert">Couldn’t reach Tidepool: {loadError}</p>}

      {!active && !evm && !source && (
        <div className="row" role="group" aria-label="Where are you sending from?">
          <button className="primary" disabled={busy} onClick={() => (setSource('evm'), void startEvm())}>
            {busy ? 'Creating your address…' : 'From an Ethereum wallet'}
          </button>
          <button onClick={() => setSource('sol')}>From Solana</button>
        </div>
      )}

      {evm && (
        <div className="stack" aria-label="Deposit instructions">
          <p>
            Send <strong>USDT, USDC or ETH</strong> on <strong>Ethereum Sepolia</strong> to this address, any amount:
          </p>
          <div className="row">
            <code className="address" data-testid="tidepool-deposit-address">
              {evm.address}
            </code>
            <button className="link" onClick={() => copy(evm.address)}>
              Copy
            </button>
          </div>
          <p className="warning small">
            Only these three tokens, and only on Ethereum Sepolia. Other tokens or networks won’t arrive in your balance.
          </p>
          <p className="small muted">
            It all becomes private USDT: USDC and ETH are swapped at Tidepool’s rate, and Railgun keeps{' '}
            {shieldFeeBp !== null ? `${shieldFeeBp / 100}%` : 'a small fee'} as money enters the private pool. A little ETH is kept
            to pay future network fees. Gas is covered on testnet. On-chain, the wallet you send from is visible as this
            address’s funder. The address is yours and stays open for 24 hours.
          </p>
          {mainnet && (
            <p className="small muted" data-testid="mainnet-price">
              On mainnet today, NEAR Intents swaps {mainnet.usdcIn} USDC into <strong>{mainnet.usdtOut} USDT</strong>
              {mainnet.seconds ? ` in about ${mainnet.seconds} seconds` : ''}. Live price check only: nothing is sent.
            </p>
          )}
          <p role="status" className="info" data-testid="active-deposit-status">
            {stageText(depositProgress.get(evm.index), pw.deposits.find((d) => d.index === evm.index) ?? evm)}
          </p>
          {usdcNote(pw.deposits.find((d) => d.index === evm.index) ?? evm) && (
            <p className="warning small" data-testid="active-deposit-usdc-note">
              {usdcNote(pw.deposits.find((d) => d.index === evm.index) ?? evm)}
            </p>
          )}
          <button className="link" onClick={reset}>
            Start another deposit
          </button>
        </div>
      )}

      {source === 'sol' && !active && tokens && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void submit())}>
          <label>
            Send from
            <select value={choice} onChange={(e) => setChoice(e.target.value)} required>
              <option value="">Choose a token…</option>
              {tokens.origins.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol} on {CHAIN_NAMES[t.blockchain as OriginChain]}
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
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !units || !solanaOk}>
              {busy ? 'Getting a quote…' : 'Get deposit address'}
            </button>
            <button type="button" className="link" onClick={reset}>
              Back
            </button>
          </div>
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
            <button className="link" onClick={() => copy(active.quote.depositAddress)}>
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
          {usdcNote(active.record) && (
            <p className="warning small" data-testid="active-deposit-usdc-note">
              {usdcNote(active.record)}
            </p>
          )}
          <button className="link" onClick={reset}>
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
              const canFinish =
                stage?.kind === 'needs-finish' || stage?.kind === 'late-funds' || (stage?.kind === 'failed' && d.status === 'delivered');
              return (
                <li key={d.index}>
                  <div>
                    <strong>
                      {d.quote?.anyToken
                        ? `Deposit on Ethereum Sepolia`
                        : d.quote
                          ? `${d.quote.amountInFormatted || d.quote.amountIn} ${d.quote.originSymbol} from ${CHAIN_NAMES[d.quote.originChain as OriginChain]}`
                          : `Deposit #${d.index + 1}`}
                    </strong>
                    <div className="muted small" data-testid={`deposit-${d.index}-status`}>
                      {stageText(stage, d)}
                    </div>
                    {usdcNote(d) && <div className="small" data-testid={`deposit-${d.index}-usdc-note`}>{usdcNote(d)}</div>}
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
