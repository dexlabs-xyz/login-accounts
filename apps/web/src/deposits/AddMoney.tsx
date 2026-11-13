/**
 * "Add money": into the private balance, always as USDT. TESTNET ONLY.
 *   - From an Ethereum wallet: our own fresh address on Ethereum Sepolia; send
 *     USDT, USDC or ETH, any amount (USDC and ETH are swapped through Tidepool).
 *   - From Solana: Tidepool's own deposit address (team decision, 6 Nov).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { QrCode } from '../ui/QrCode.tsx';
import { useToast } from '../ui/toast.tsx';
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

export function stageText(stage: Stage | undefined, record: DepositRecord): string {
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
      return record.withdrawal
        ? 'Waiting for Tidepool’s refund to arrive…'
        : 'Waiting for USDT, USDC or ETH to arrive at your deposit address…';
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
      return 'Done. It’s in your private balance. A privacy check runs first, so it shows as “being checked” before you can spend it, from a few minutes to about two hours. Your wallet may lock while you wait; the balance catches up when you unlock.';
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

type Step = 'choose' | 'evm' | 'sol' | 'sol-address';

/** Gold's timing (12 Nov): easeOut, 0.2s for the height change and the fade-in (was 0.4s; "50% faster"). */
const STEP_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };
// The step you leave disappears at once (it showed through while the height changed: Gold, 12 Nov); the next fades in.
const STEP_FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } };

/**
 * The Receive pop-up (Figma 433:5445, 433:5643, 444:6036, 444:6213): choose a chain, then the Ethereum
 * address (with QR), or the Solana form and its one-time address. The deposit logic is unchanged.
 */
export function AddMoney({ resume }: { resume?: { index: number; n: number } | null }) {
  const pw = useWallet();
  useProgress();
  const [tokens, setTokens] = useState<{ usdt: Token; origins: Token[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState('');
  const [amount, setAmount] = useState('');
  const [solanaRefund, setSolanaRefund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The amount was refused (e.g. over Tidepool's cap): its field shows a red outline until it's changed. */
  const [amountBad, setAmountBad] = useState(false);
  const toast = useToast();
  // Errors arrive as toasts (they stay until closed), not as text in the pop-up (Gold, 12 Nov).
  useEffect(() => {
    if (error) toast.show({ kind: 'error', text: error });
  }, [error, toast]);
  useEffect(() => {
    if (loadError) toast.show({ kind: 'error', text: `Couldn’t reach Tidepool: ${loadError}` });
  }, [loadError, toast]);
  const [active, setActive] = useState<{ record: DepositRecord; quote: Quote } | null>(null);
  const [evm, setEvm] = useState<DepositRecord | null>(null);
  const [source, setSource] = useState<'evm' | 'sol' | null>(null);
  /** The pop-up's steps, with the < > chevrons moving back and forward through the ones you've visited. */
  const [trail, setTrail] = useState<Step[]>(['choose']);
  const [pos, setPos] = useState(0);
  const step = trail[pos]!;
  const go = (next: Step) => {
    setTrail((t) => [...t.slice(0, pos + 1), next]);
    setPos((p) => p + 1);
  };
  const back = () => setPos((p) => Math.max(0, p - 1));
  // The current step's real height, which the pop-up animates to.
  // A callback ref: the steps only appear once the wallet is open, so this attaches whenever they do.
  const [stepHeight, setStepHeight] = useState<number | 'auto'>('auto');
  const watch = useRef<ResizeObserver | null>(null);
  const stepInner = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    if (!el) return;
    watch.current = new ResizeObserver(() => setStepHeight(el.offsetHeight));
    watch.current.observe(el);
  }, []);
  // "Resume" from Notifications: open that deposit's address again (Ethereum address, or the Solana quote).
  useEffect(() => {
    if (!resume) return;
    const d = privateWallet.get().deposits.find((r) => r.index === resume.index);
    if (!d?.quote) return;
    if (d.quote.anyToken) {
      setEvm(d);
      setTrail(['choose', 'evm']);
    } else {
      const q = d.quote;
      setActive({
        record: d,
        quote: { depositAddress: q.tidepoolDepositAddress, amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountOut: q.expectedUsdt, minAmountOut: q.minUsdt, deadline: q.deadline, timeEstimate: 0 },
      });
      setTrail(['choose', 'sol-address']);
    }
    setPos(1);
  }, [resume]);
  const forward = () => setPos((p) => Math.min(trail.length - 1, p + 1));
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

  /** True once there's a deposit address to show. */
  const submit = async (): Promise<boolean> => {
    if (!tokens || !origin || !units || !solanaOk) return false;
    setError('');
    setBusy(true);
    try {
      setActive(await startDeposit({ origin, usdt: tokens.usdt, amount: units, solanaRefund: solanaRefund.trim() }));
      return true;
    } catch (e) {
      setAmountBad(true);
      setError(e instanceof Error && e.message !== 'Error' ? e.message : 'Couldn’t start the deposit. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEvm = async (): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      setEvm(await startEvmDeposit());
      return true;
    } catch (e) {
      setError(e instanceof Error && e.message !== 'Error' ? e.message : 'Couldn’t start the deposit. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseEvm = async () => {
    if (evm) return go('evm');
    setSource('evm');
    if (await startEvm()) go('evm');
  };
  const getAddress = async () => {
    if (await submit()) go('sol-address');
  };
  const solActive = active && active.record.quote?.originChain === 'sol' ? active : null;
  const record = (r: DepositRecord) => pw.deposits.find((d) => d.index === r.index) ?? r;

  const warning = (text: string) => (
    <div className="sheet-warning" role="note">
      <img src="/img/alert-triangle.svg" alt="" width={15} height={15} />
      <p>{text}</p>
    </div>
  );
  // Progress shows as toasts (DepositToasts below), not as text in the pop-up (Gold, 12 Nov). The full status
  // stays as screen-reader text, which the browser tests also read.
  const status = (r: DepositRecord) => (
    <>
      <p className="visually-hidden" data-testid="active-deposit-status">
        {stageText(depositProgress.get(r.index), record(r))}
      </p>
      {usdcNote(record(r)) && (
        <p className="visually-hidden" data-testid="active-deposit-usdc-note">
          {usdcNote(record(r))}
        </p>
      )}
    </>
  );

  return (
    <div className="sheet">
      <header className="sheet-head">
        <h2>Receive</h2>
        <div className="sheet-steps">
          <button type="button" className="icon-btn" aria-label="Previous step" disabled={pos === 0} onClick={back}>
            <img src="/img/chevron-left-sm.svg" alt="" width={15} height={15} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next step" disabled={pos >= trail.length - 1} onClick={forward}>
            <img src="/img/chevron-right.svg" alt="" width={15} height={15} />
          </button>
        </div>
      </header>

      {/* The pop-up's height goes straight from one step's to the next (no folding away first: Gold, 12 Nov). It's
          centred, so it grows and shrinks up and down equally; the steps cross-fade inside it. */}
      <MotionConfig reducedMotion="user">
        <motion.div className="sheet-step" initial={false} animate={{ height: stepHeight }} transition={STEP_TRANSITION}>
        <div ref={stepInner}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={step} {...STEP_FADE} transition={STEP_TRANSITION}>
            {step === 'choose' && (
              <>
                <p className="sheet-sub">Receive any token on either chain</p>
                <div className="sheet-list" role="group" aria-label="Where are you sending from?">
                  <button type="button" className="sheet-row" onClick={() => (setSource('sol'), go('sol'))}>
                    <img src="/img/chain-solana.svg" alt="" width={22} height={22} />
                    <span>Solana</span>
                    <img className="sheet-row-go" src="/img/chevron-right.svg" alt="" width={15} height={15} />
                  </button>
                  <button type="button" className="sheet-row" onClick={() => void chooseEvm()} disabled={busy} aria-busy={busy}>
                    <img src="/img/chain-ethereum.svg" alt="" width={22} height={22} />
                    <span>Ethereum Sepolia</span>
                    <img
                      className="sheet-row-go"
                      src={busy ? '/img/loader-spinning.svg' : '/img/chevron-right.svg'}
                      alt=""
                      width={15}
                      height={15}
                    />
                  </button>
                </div>
              </>
            )}

            {step === 'evm' && evm && (
              <>
                <p className="sheet-sub">Send USDT, USDC, or ETH to this address</p>
                <div className="sheet-body">
                  <div className="sheet-qr">
                    <QrCode value={evm.address} />
                  </div>
                  <div className="sheet-group">
                    <span className="sheet-label" id="evm-wallet-label">
                      Wallet
                    </span>
                    <div className="sheet-field">
                      <code className="address" data-testid="tidepool-deposit-address" aria-labelledby="evm-wallet-label">
                        {evm.address}
                      </code>
                      <CopyIcon value={evm.address} label="Copy the deposit address" />
                    </div>
                  </div>
                  {warning(
                    'Please only receive supported assets on ETH Sepolia chain; USDC, USDT, or ETH. Sending any other asset or on any other chain may lead to permanent loss of funds.',
                  )}
                  {mainnet && (
                    <p className="sheet-note" data-testid="mainnet-price">
                      On mainnet today, NEAR Intents swaps {mainnet.usdcIn} USDC into <strong>{mainnet.usdtOut} USDT</strong>
                      {mainnet.seconds ? ` in about ${mainnet.seconds} seconds` : ''}. Live price check only: nothing is sent.
                    </p>
                  )}
                  {status(evm)}
                </div>
              </>
            )}

            {step === 'sol' && (
              <>
                <p className="sheet-sub">Receive a token on Solana</p>
                {tokens ? (
                  <form className="sheet-body is-form" onSubmit={(e) => (e.preventDefault(), void getAddress())}>
                    <label className="sheet-group">
                      <span className="sheet-label">Select token</span>
                      <span className="sheet-field is-select">
                        <select value={choice} onChange={(e) => setChoice(e.target.value)} required>
                          <option value="">Select</option>
                          {tokens.origins.map((t) => (
                            <option key={t.assetId} value={t.assetId}>
                              {t.symbol} on {CHAIN_NAMES[t.blockchain as OriginChain]}
                            </option>
                          ))}
                        </select>
                        <img src="/img/chevron-down.svg" alt="" width={15} height={15} />
                      </span>
                    </label>
                    <label className="sheet-group">
                      <span className="sheet-label">Enter amount</span>
                      <span className={`sheet-field${amountBad ? ' is-error' : ''}`}>
                        <input
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => (setAmount(e.target.value), setAmountBad(false))}
                          aria-invalid={amountBad}
                          placeholder={`E.g. ${origin?.symbol === 'SOL' ? '0.5' : '5'} ${origin?.symbol ?? ''}`.trim()}
                          required
                        />
                      </span>
                    </label>
                    {needsSolanaRefund && (
                      <label className="sheet-group">
                        <span className="sheet-label">
                          Refund address
                          <img
                            src="/img/info.svg"
                            alt=""
                            width={12}
                            height={12}
                            title="If the swap can’t happen, your tokens go back to this Solana address. Use one you control."
                          />
                        </span>
                        <span className={`sheet-field${solanaRefund && !solanaOk ? ' is-error' : ''}`}>
                          <input
                            value={solanaRefund}
                            aria-invalid={!!solanaRefund && !solanaOk}
                            onChange={(e) => {
                              setSolanaRefund(e.target.value);
                              if (isValidAddress('sol', e.target.value.trim())) toast.dismiss('sol-refund');
                            }}
                            // Red outline while it's wrong; the words come once you leave the field, not while typing (Gold, 13 Nov).
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && !isValidAddress('sol', v)) toast.show({ id: 'sol-refund', kind: 'error', text: 'That isn’t a Solana address.' });
                            }}
                            placeholder="Your Solana address"
                            aria-describedby="refund-why"
                            required
                          />
                        </span>
                        <span id="refund-why" className="visually-hidden">
                          If the swap can’t happen, your tokens go back to this Solana address.
                        </span>
                      </label>
                    )}
                    <div className="sheet-actions">
                      <button type="button" className="sheet-btn" onClick={back}>
                        Cancel
                      </button>
                      <button type="submit" className="sheet-btn is-primary" disabled={busy || !units || !solanaOk} aria-busy={busy}>
                        {busy ? 'Getting a quote…' : 'Get Deposit Address'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="sheet-status">Loading tokens…</p>
                )}
              </>
            )}

            {step === 'sol-address' && solActive && (
              <>
                <p className="sheet-sub">
                  Receive {solActive.record.quote?.originSymbol} on {CHAIN_NAMES[solActive.record.quote!.originChain as OriginChain]}
                </p>
                <div className="sheet-body">
                  <dl className="sheet-summary">
                    <div>
                      <dt>Token</dt>
                      <dd>{solActive.record.quote?.originSymbol}</dd>
                    </div>
                    <div>
                      <dt>Chain</dt>
                      <dd>{CHAIN_NAMES[solActive.record.quote!.originChain as OriginChain]}</dd>
                    </div>
                    <div>
                      <dt>Amount</dt>
                      <dd>
                        {solActive.quote.amountInFormatted || solActive.quote.amountIn} {solActive.record.quote?.originSymbol}
                        <CopyIcon value={solActive.quote.amountInFormatted || solActive.quote.amountIn} label="Copy the exact amount" />
                      </dd>
                    </div>
                    <div>
                      <dt>You receive</dt>
                      <dd>
                        about {formatUnits(afterShield(solActive.quote.amountOut) ?? solActive.quote.amountOut, USDT_DECIMALS)} USDT
                      </dd>
                    </div>
                    <div>
                      <dt>Send before</dt>
                      <dd>{new Date(solActive.quote.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
                    </div>
                  </dl>
                  <div className="sheet-group">
                    <span className="sheet-label" id="sol-wallet-label">
                      Wallet
                    </span>
                    <div className="sheet-field">
                      <code className="address" data-testid="tidepool-deposit-address" aria-labelledby="sol-wallet-label">
                        {solActive.quote.depositAddress}
                      </code>
                      <CopyIcon value={solActive.quote.depositAddress} label="Copy the deposit address" />
                    </div>
                  </div>
                  {warning(
                    `Please only send ${solActive.record.quote?.originSymbol} on Solana devnet, the exact amount above. Sending any other asset or on any other chain may lead to permanent loss of funds.`,
                  )}
                  {status(solActive.record)}
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
        </div>
        </motion.div>
      </MotionConfig>
      <DepositToasts records={[evm, solActive?.record].filter((r): r is DepositRecord => !!r)} />
    </div>
  );
}

/** A copy icon that turns into a check for a moment once the value is on the clipboard. */
function CopyIcon({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn sheet-copy"
      aria-label={done ? 'Copied' : label}
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <img src={done ? '/img/check.svg' : '/img/copy-sm.svg'} alt="" width={15} height={15} />
    </button>
  );
}

/**
 * A deposit's progress as toasts: one toast per deposit that changes as it goes (spinner while swapping and
 * moving it in, then done, refunded or failed). Waiting for the payment shows nothing (Gold, 12 Nov).
 */
function DepositToasts({ records }: { records: DepositRecord[] }) {
  useProgress();
  const toast = useToast();
  const last = useRef(new Map<number, string>());
  const key = records.map((r) => `${r.index}:${depositProgress.get(r.index)?.kind ?? r.status}:${(depositProgress.get(r.index) as { swap?: string } | undefined)?.swap ?? ''}`).join('|');
  useEffect(() => {
    for (const r of records) {
      const stage = depositProgress.get(r.index);
      const now = `${stage?.kind ?? r.status}:${(stage as { swap?: string } | undefined)?.swap ?? ''}`;
      if (last.current.get(r.index) === now) continue;
      last.current.set(r.index, now);
      const id = `deposit-${r.index}`;
      const kind = stage?.kind;
      if (!kind || kind === 'waiting-evm' || kind === 'waiting-direct') continue;
      if (kind === 'waiting-payment' && stage.swap === 'PENDING_DEPOSIT') continue;
      if (kind === 'done') {
        toast.show({ id, kind: 'success', text: 'Your deposit is in your private balance', description: 'Spendable after Railgun’s privacy check: a few minutes to about two hours.' });
      } else if (kind === 'refunded') {
        toast.show({ id, kind: 'info', text: stageText(stage, r) });
      } else if (kind === 'failed') {
        toast.show({ id, kind: 'error', text: stageText(stage, r) });
      } else if (kind === 'needs-finish' || kind === 'late-funds') {
        toast.show({ id, kind: 'warning', text: stageText(stage, r) });
      } else {
        toast.show({ id, kind: 'loading', text: stageText(stage, r) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}
