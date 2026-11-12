import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import { api, ApiError } from './api.ts';
import { KycCard, type KycStatus } from './Kyc.tsx';
import { ConnectedApps } from './ConnectedApps.tsx';
import { Activity } from './History.tsx';
import { ClaimWatcher, TestUsdtButton } from './TestFunds.tsx';
import { Frame, useCopyAddress, useHideBalance, usePage, useUsdTotal } from './home/Frame.tsx';
import { BalanceChart } from './home/BalanceChart.tsx';
import { CopyAddressButton } from './home/CopyButton.tsx';
import { Modal } from './ui/Modal.tsx';
import { ToastProvider } from './ui/toast.tsx';
import { usd } from './money.ts';
import { privateWallet } from './railgun/client.ts';
import { SEPOLIA_USDC, SEPOLIA_USDT, SEPOLIA_WETH, USDC_DECIMALS, USDT_DECIMALS } from './railgun/protocol.ts';
import { AddMoney } from './deposits/AddMoney.tsx';
import { SendPrivately, Withdraw } from './send/SendPrivately.tsx';
import { formatUnits } from './deposits/tidepool.ts';
import {
  addPasskey,
  connectPasskey,
  removePasskey,
  setUpWalletHere,
  signIn,
  syncPasskeysWithPasswordManager,
  type PasskeyPlace,
  signUp,
  unlock,
  wallet,
  type Me,
  type ConnectResult,
  type PublicCredential,
  type WalletOutcome,
} from './passkey.ts';

function connectNote(r: ConnectResult): string {
  switch (r) {
    case 'connected':
      return 'Done. This passkey can now open your wallet on its own.';
    case 'no-wallet':
      return 'Passkey added.';
    case 'wallet-locked':
      return 'Passkey added for signing in. To let it open your wallet too, unlock your wallet and press “Connect” next to it.';
    case 'no-prf':
      return '';
  }
}

// ---------- plain-language messages (feedback-coherent) ----------

function explain(err: unknown): string {
  if (err instanceof ApiError) {
    const m: Record<string, string> = {
      'invalid-email': 'That email address doesn’t look right.',
      'wrong-code': `That code isn’t right. ${err.body.attemptsLeft} tries left.`,
      'too-many-attempts': 'Too many wrong codes. Ask for a new one.',
      'code-expired': 'That code has expired. Ask for a new one.',
      'no-code-sent': 'Ask for a code first.',
      'wait-before-resending': 'A code was just sent. Wait a few seconds before asking again.',
      'signup-expired': 'Sign-up took too long. Start again with your email.',
      'unknown-credential': 'This passkey isn’t linked to a Login account anymore. Your device has been told to forget it.',
      'passkey-not-verified': 'The passkey couldn’t be checked. Try again.',
      'ceremony-expired': 'That took too long. Try again.',
      'last-passkey': 'You can’t remove your only passkey.',
      'last-wallet-passkey':
        'This is the only passkey that can open your wallet. Add another one first, or you’d lose access to your money.',
      'email-taken': 'That email already has an account. Sign in instead.',
      'signed-out': 'You’ve been signed out. Sign in again.',
    };
    return m[err.code] ?? 'Something went wrong. Try again.';
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || err.name === 'InvalidStateError') {
      return 'This device already has a passkey for this account. Use “Sign in with passkey” instead.';
    }
    if (err.name === 'NotAllowedError')
      return 'The passkey prompt was closed or timed out. Nothing changed. Try again when ready.';
    if (err.name === 'AbortError') return '';
    return err.message;
  }
  return 'Something went wrong. Try again.';
}

function outcomeNote(o: WalletOutcome): string | null {
  switch (o.kind) {
    case 'opened':
    case 'created':
      return null;
    case 'no-prf':
      return 'You’re signed in, and you can use Login to sign in to apps from this device. But this device can’t open your Login wallet. Open Login on your phone or another computer to use it.';
    case 'passkey-not-enrolled':
      return 'This passkey isn’t connected to your wallet yet. Unlock with a passkey that is, then add this one from that session.';
    case 'no-wallet':
      return 'Your account doesn’t have a wallet yet. You can set it up from this device.';
  }
}

// ---------- app ----------

export function App() {
  const path = location.pathname;
  if (path === '/dev/outbox') return <DevOutbox />;
  if (path === '/signin') return <SignInHandoff />;
  return (
    <ToastProvider>
      <Main />
    </ToastProvider>
  );
}

function useWalletOpen() {
  return useSyncExternalStore(wallet.subscribe, wallet.isOpen);
}

function usePrivateWallet() {
  return useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
}

const BUCKET_LABELS: Record<string, string> = {
  Spendable: 'Spendable',
  ShieldPending: 'Arriving (being checked)',
  ShieldBlocked: 'Blocked by sanctions screening',
  ProofSubmitted: 'Being confirmed',
  MissingInternalPOI: 'Waiting for privacy check',
  MissingExternalPOI: 'Waiting for privacy check',
};

/** Private balance from the Railgun wallet (Sepolia testnet). Shown only while unlocked. */
/** Known tokens in the private balance. TESTNET addresses (Sepolia). */
const KNOWN_TOKENS: Record<string, { key: string; label: string; decimals: number }> = {
  [SEPOLIA_USDT.toLowerCase()]: {
    key: 'usdt',
    label: 'USDT',
    decimals: USDT_DECIMALS,
  },
  [SEPOLIA_USDC.toLowerCase()]: {
    key: 'usdc',
    label: 'USDC',
    decimals: USDC_DECIMALS,
  },
  [SEPOLIA_WETH.toLowerCase()]: {
    key: 'eth',
    label: 'ETH (for network fees)',
    decimals: 18,
  },
};
const tokenKey = (address: string) => KNOWN_TOKENS[address.toLowerCase()]?.key ?? 'other';
const tokenLabel = (address: string) => {
  const t = KNOWN_TOKENS[address.toLowerCase()];
  return t ? <strong>{t.label}</strong> : <code>{address.slice(0, 8)}…</code>;
};
const tokenAmount = (address: string, amount: string) => {
  const t = KNOWN_TOKENS[address.toLowerCase()];
  return t ? formatUnits(amount, t.decimals, t.decimals === 18 ? 5 : 2) : amount;
};

/** How long a sync may show no progress before we say so and offer a retry. */
const SYNC_STALL_MS = 45_000;

/**
 * Home's top block (Figma: Private balance, then Test USDT / Send / Receive / Copy address).
 * The big number is everything private; the small line under it says what's spendable now and
 * what's still in Railgun's privacy check (the browser tests read it: balance-<Bucket>-<token>).
 */
function PrivateBalance({ hidden, onSend, onReceive }: { hidden: boolean; onSend: () => void; onReceive: () => void }) {
  const pw = usePrivateWallet();
  const total = useUsdTotal();
  const { address } = useCopyAddress();
  const [stalled, setStalled] = useState(false);
  // Any change in status or progress resets the stall timer.
  useEffect(() => {
    setStalled(false);
    if (pw.status !== 'syncing') return;
    const t = setTimeout(() => setStalled(true), SYNC_STALL_MS);
    return () => clearTimeout(t);
  }, [pw.status, pw.scanProgress]);
  if (pw.status === 'off') return null;
  const isReserve = (a: string) => a.toLowerCase() === SEPOLIA_WETH.toLowerCase();
  const all = Object.entries(pw.balances)
    .filter(([bucket]) => bucket !== 'Spent')
    .flatMap(([bucket, list]) => (list ?? []).filter((t) => t.amount !== '0').map((t) => ({ bucket, ...t })));
  // One currency on screen: the private ETH that pays network fees (testnet only) is not shown as a balance.
  const rows = all.filter((r) => !isReserve(r.tokenAddress));
  const reserve = all.filter((r) => isReserve(r.tokenAddress));
  const reserveState = reserve.some((r) => r.bucket === 'Spendable') ? 'ready' : reserve.length ? 'pending' : 'empty';
  const money = (address: string, amount: string) => {
    const t = KNOWN_TOKENS[address.toLowerCase()];
    if (hidden) return '••••';
    return t && t.key !== 'eth' ? usd(amount, t.decimals) : tokenAmount(address, amount);
  };
  const ready = pw.status === 'ready' || pw.status === 'syncing';

  return (
    <section className="hero" aria-labelledby="private-h">
      <h2 id="private-h" className="hero-label">
        Private balance
      </h2>
      {/* Amount, with what's happening beside it (Figma: "10% Syncing…", bottom-aligned, 9px apart). */}
      <div className="hero-row">
        <p className="hero-amount">{total === null ? '—' : hidden ? '••••••' : usd(total, 6)}</p>
        <div className="hero-meta">
          {pw.status === 'starting' && <p className="hero-status">Opening your private wallet…</p>}
          {pw.status === 'needs-poi' && (
            <p className="hero-status" role="status">
              Balance not available yet: this test build has no Railgun Proof of Innocence node configured.
            </p>
          )}
          {pw.status === 'syncing' && !stalled && (
            <p className="hero-status hero-syncing" role="status">
              {Math.round(pw.scanProgress * 100)}% Syncing…
            </p>
          )}
          {pw.status === 'syncing' && stalled && (
            <div className="hero-status" role="status">
              Syncing is taking longer than usual (stuck at {Math.round(pw.scanProgress * 100)}%). One of the networks your wallet
              reads from may be slow. Your funds aren’t affected.{' '}
              <button className="link" onClick={() => (setStalled(false), privateWallet.refresh())}>
                Retry sync
              </button>
            </div>
          )}
          {ready &&
            (rows.length === 0 ? (
              // "$0.00" says it on screen (Gold: no extra empty-state text); kept for screen readers and the tests.
              <p className="visually-hidden" data-testid="private-empty">
                {pw.status === 'ready' ? 'No private funds yet.' : ''}
              </p>
            ) : (
              <p className="hero-status">
                {rows.map((r, i) => (
                  <span key={r.bucket + r.tokenAddress}>
                    {i > 0 && ' · '}
                    <span data-testid={`balance-${r.bucket}-${tokenKey(r.tokenAddress)}`}>
                      {money(r.tokenAddress, r.amount)} {BUCKET_LABELS[r.bucket]?.toLowerCase() ?? r.bucket}
                    </span>
                  </span>
                ))}
              </p>
            ))}
          {pw.status === 'ready' && (
            <p
              className={reserveState === 'empty' ? 'visually-hidden' : 'hero-status'}
              data-testid={`fee-reserve-${reserveState}`}
            >
              {reserveState === 'ready'
                ? 'Network fees are covered.'
                : reserveState === 'pending'
                  ? 'Network fees: being set up. Covered once your new funds clear.'
                  : 'Your next deposit sets aside a little to cover network fees for sending and withdrawing.'}
            </p>
          )}
        </div>
      </div>
      {pw.status === 'error' && (
        <p className="error" role="alert">
          Couldn’t load your private balance. Lock and unlock to try again.
          {/* Only the error's type name (e.g. TypeError), never its message: safe to show, and it tells us where to look. */}
          {pw.error && <span className="muted small"> (Error code: {pw.error})</span>}
        </p>
      )}
      <div className="hero-actions">
        <TestUsdtButton />
        <button type="button" className="hero-btn" onClick={onSend}>
          <img src="/img/send.svg" alt="" width={18} height={18} />
          Send
        </button>
        <button type="button" className="hero-btn" onClick={onReceive}>
          <img src="/img/qr.svg" alt="" width={18} height={18} />
          Receive
        </button>
        <CopyAddressButton address={address} />
      </div>
      {/* The private address itself, for screen readers and the browser tests; "Copy address" copies it. */}
      {address && (
        <p className="visually-hidden">
          Your private address:{' '}
          <code className="address" title={address}>
            {address}
          </code>
        </p>
      )}
    </section>
  );
}

function Main() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Me>('GET', '/api/me');
      setMe(next);
      // Keep the password manager in step with the server (e.g. a passkey removed on another device).
      void syncPasskeysWithPasswordManager(next);
    } catch {
      wallet.lock();
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onOutcome = async (o: WalletOutcome) => {
    setNote(outcomeNote(o));
    await refresh();
  };

  if (me === 'loading')
    return (
      <Shell>
        <p className="muted">Loading…</p>
      </Shell>
    );
  if (!me) return <Join onDone={onOutcome} />;
  return <Account me={me} note={note} setNote={setNote} refresh={refresh} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      <header className="brand">Login</header>
      {children}
      <footer className="muted small">Testnet build. Never use real funds.</footer>
    </main>
  );
}

// ---------- join / sign in (D2) ----------

/** "Learn more about what this is." Points at the README until the demo post is published (Gold, 11 Nov). */
const LEARN_MORE_URL = 'https://github.com/dexlabs-xyz/login-accounts#readme';

/** Format check only, in the browser. Never asks the server whether an address has an account (no account probing). */
const EMAIL_FORMAT = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** The spinner shows for 2 s after typing pauses before the result (Gold: an instant result felt abrupt). */
const EMAIL_CHECK_DELAY_MS = 2000;
type EmailCheck = 'empty' | 'checking' | 'valid' | 'invalid';

/** Waits until typing pauses, then checks the format: spinner, then a tick or a cross. */
function useEmailCheck(email: string): EmailCheck {
  const [check, setCheck] = useState<EmailCheck>('empty');
  useEffect(() => {
    const value = email.trim();
    if (!value) {
      setCheck('empty');
      return;
    }
    setCheck('checking');
    const t = setTimeout(() => setCheck(EMAIL_FORMAT.test(value) ? 'valid' : 'invalid'), EMAIL_CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [email]);
  return check;
}

/** Busy states last at least this long, so a fast reply doesn't flash past (Gold, 11 Nov). */
const MIN_BUSY_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function atLeast<T>(work: Promise<T>, ms: number): Promise<T> {
  const floor = sleep(ms);
  try {
    const value = await work;
    await floor;
    return value;
  } catch (e) {
    await floor;
    throw e;
  }
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Swaps two stacked faces of a button (e.g. "Continue" and a spinner): the one leaving
 * slides down and fades, the one arriving drops in from above. 0.3 s, no bounce.
 * Nothing animates on first render. Web Animations API, no library.
 */
function useFaceSwap(showSecond: boolean) {
  const first = useRef<HTMLSpanElement>(null);
  const second = useRef<HTMLSpanElement>(null);
  // Animate only when the value actually changes. (A "first run" flag isn't enough: React's development
  // mode runs effects twice on load, which made the swap play on every reload.)
  const shown = useRef(showSecond);
  useEffect(() => {
    if (shown.current === showSecond) return;
    shown.current = showSecond;
    const [enter, exit] = showSecond ? [second.current, first.current] : [first.current, second.current];
    if (!enter || !exit || prefersReducedMotion()) return;
    const timing = { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
    enter.animate(
      [
        { opacity: 0, transform: 'translateY(-25px)' },
        { opacity: 1, transform: 'none' },
      ],
      timing,
    );
    exit.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(25px)' },
      ],
      timing,
    );
  }, [showSecond]);
  return { first, second };
}

/** The centred layout of the sign-up and sign-in screens. */
function Welcome({
  heading,
  intro,
  icon = 'none',
  onBack,
  learnMore = true,
  stepKey,
  children,
}: {
  heading: string;
  intro?: string;
  /** The sign-up screen has no image (Gold removed the globe, 11 Nov); the code screen shows the mail badge. */
  icon?: 'none' | 'mail';
  onBack?: () => void;
  /** "Learn more about what this is." shows only on the first sign-up/sign-in screen (Gold, 11 Nov). */
  learnMore?: boolean;
  /** Changes when the step changes, so the new step fades in. */
  stepKey?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="welcome">
      {onBack && (
        <button type="button" className="welcome-back" onClick={onBack}>
          <img src="/img/chevron-left.svg" alt="" width={20} height={20} />
          Go back
        </button>
      )}
      <div className="welcome-body" key={stepKey}>
        {icon === 'mail' && <img className="welcome-badge" src="/img/mail-badge.svg" alt="" width={67} height={67} />}
        <div className="welcome-title">
          <h1>{heading}</h1>
          {intro && <p>{intro}</p>}
        </div>
        {children}
      </div>
      <footer className="welcome-foot">
        {learnMore && (
          <a href={LEARN_MORE_URL} target="_blank" rel="noreferrer">
            Learn more about what this is.
          </a>
        )}
      </footer>
    </main>
  );
}

/** "olufoworagud@gmail.com" → "o…gud@gmail.com", as in the design. Short names are shown whole. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@');
  return local.length > 5 ? `${local[0]}…${local.slice(-3)}@${domain}` : `${local}@${domain}`;
}

/** checking: the server is checking (no colour yet). valid: accepted (green). wrong: refused (red). */
type CodeState = 'idle' | 'checking' | 'valid' | 'wrong';

/**
 * Six boxes over one real input (one-time-code), so typing, pasting, backspace and the
 * device's "code from email" suggestion all work, and screen readers hear one field.
 */
function CodeBoxes({
  value,
  onChange,
  state,
  shaking,
  onShakeEnd,
  inputRef,
}: {
  value: string;
  onChange: (digits: string) => void;
  state: CodeState;
  shaking: boolean;
  onShakeEnd: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, 5);
  return (
    <div
      className={`otp${shaking ? ' shake' : ''}`}
      data-state={state}
      onAnimationEnd={(e) => e.animationName === 'shake' && onShakeEnd()}
    >
      <label htmlFor="join-code" className="visually-hidden">
        6-digit code
      </label>
      <input
        ref={inputRef}
        id="join-code"
        className="otp-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        readOnly={state === 'checking' || state === 'valid'}
        aria-invalid={state === 'wrong'}
        required
      />
      <div className="otp-boxes" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`otp-box${focused && state === 'idle' && i === active ? ' is-active' : ''}`}>
            {value[i] ? (
              <span className="otp-digit" key={value[i] + i}>
                {value[i]}
              </span>
            ) : focused && state === 'idle' && i === active ? (
              <span className="otp-caret" />
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function Join({
  onDone,
  heading = 'Welcome',
  intro = 'Sign Up or Sign In to continue',
  onCancel,
}: {
  onDone: (o: WalletOutcome) => void;
  heading?: string;
  intro?: string;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<'email' | 'code' | 'working'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeState, setCodeState] = useState<CodeState>('idle');
  const [codeShaking, setCodeShaking] = useState(false);
  /** A plain wrong code is shown by the red boxes alone (Gold, 11 Nov); the words stay for screen readers only. */
  const [quietError, setQuietError] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const check = useEmailCheck(email);
  const continueFaces = useFaceSwap(sending);
  const emailInput = useRef<HTMLInputElement>(null);
  // Land in the field of each step, ready to type: the email on every visit and reload, the code once it's sent.
  useEffect(() => {
    const field = step === 'email' ? emailInput : step === 'code' ? codeInput : null;
    if (!field) return;
    const t = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(t);
  }, [step]);
  /** The email field shakes once for an error: a bad format, or the server refusing to send a code. */
  const [shaking, setShaking] = useState(false);
  useEffect(() => {
    if (check === 'invalid') setShaking(true);
  }, [check]);

  // Passkey autofill: returning users pick their passkey from the email field.
  // Started once per page visit; the ref keeps a re-render from restarting it.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    let cancelled = false;
    void browserSupportsWebAuthnAutofill().then((ok) => {
      if (!ok || cancelled) return;
      signIn({ autofill: true })
        .then((o) => onDoneRef.current(o))
        .catch((e) => !cancelled && setError(explain(e)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setInfo('');
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
      setStep((s) => (s === 'working' ? 'code' : s));
    }
  };

  const sendCode = () =>
    run(async () => {
      setSending(true);
      try {
        await atLeast(api('POST', '/api/email/start', { email }), MIN_BUSY_MS);
      } catch (e) {
        setShaking(true);
        throw e;
      } finally {
        setSending(false);
      }
      if (step === 'code') setInfo(`We sent a new code to ${email.trim().toLowerCase()}.`);
      setCode('');
      setCodeState('idle');
      setStep('code');
      codeInput.current?.focus();
    });

  /**
   * Sent as soon as the sixth digit is in (no Verify button in the design), and checked at once:
   * green only when the server accepts it, then the loading spinner; red if it's refused.
   */
  const verify = (digits: string) =>
    run(async () => {
      setCodeState('checking');
      let r: { status: 'new'; ticket: string } | { status: 'existing' };
      try {
        r = await api('POST', '/api/email/verify', { email, code: digits });
      } catch (e) {
        setCodeState('wrong');
        setCodeShaking(true);
        setQuietError(e instanceof ApiError && e.code === 'wrong-code');
        throw e;
      }
      setCodeState('valid');
      if (r.status === 'existing') {
        await sleep(600); // let the green register before going back to sign in
        setCodeState('idle');
        setCode('');
        setStep('email');
        setInfo('You already have an account. Sign in with your passkey.');
        return;
      }
      setStep('working');
      setInfo('Create your passkey. Your device may ask twice: once to create it, once to set up your wallet.');
      try {
        onDone(await signUp(r.ticket));
      } catch (e) {
        // The code is used up once accepted: start again from a fresh code.
        setCodeState('idle');
        setCode('');
        throw e;
      }
    });

  // The check is normally instant; only if it's slow does the spinner appear (no flash on a fast reply).
  const [slowCheck, setSlowCheck] = useState(false);
  useEffect(() => {
    setSlowCheck(false);
    if (codeState !== 'checking') return;
    const t = setTimeout(() => setSlowCheck(true), 400);
    return () => clearTimeout(t);
  }, [codeState]);

  const onCode = (digits: string) => {
    setCode(digits);
    if (codeState === 'wrong') {
      setCodeState('idle');
      setError('');
    }
    if (digits.length === 6 && codeState !== 'checking' && codeState !== 'valid') void verify(digits);
  };

  const backToEmail = () => {
    setStep('email');
    setCode('');
    setCodeState('idle');
    setError('');
    setInfo('');
  };

  const fieldIcon =
    check === 'checking' ? (
      <img className="field-icon" src="/img/loader-spinning.svg" alt="" width={24} height={24} />
    ) : check === 'valid' ? (
      <img className="field-icon pop" src="/img/check-circled.svg" alt="" width={24} height={24} />
    ) : check === 'invalid' ? (
      <button
        type="button"
        className="field-icon field-clear pop"
        aria-label="Clear"
        onClick={() => {
          setEmail('');
          emailInput.current?.focus();
        }}
      >
        <img src="/img/x-circled.svg" alt="" width={24} height={24} />
      </button>
    ) : null;

  return (
    <Welcome
      stepKey={step === 'email' ? 'email' : 'code'}
      heading={step === 'email' ? heading : 'Check your email'}
      intro={step === 'email' ? intro : `Enter the code we sent to ${maskEmail(email)}`}
      icon={step === 'email' ? 'none' : 'mail'}
      learnMore={step === 'email'}
      onBack={step === 'code' ? backToEmail : undefined}
    >
      {step === 'email' && (
        <form className="welcome-form" onSubmit={(e) => (e.preventDefault(), check === 'valid' && !sending && void sendCode())}>
          <div className="welcome-fields">
            <div
              className={`field${shaking ? ' shake' : ''}`}
              data-check={check}
              onAnimationEnd={(e) => e.animationName === 'shake' && setShaking(false)}
            >
              <label htmlFor="join-email" className="visually-hidden">
                Email
              </label>
              <input
                ref={emailInput}
                id="join-email"
                type="email"
                name="email"
                placeholder="Email"
                autoComplete="email webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={check === 'invalid'}
                className={check === 'valid' ? 'shimmer' : undefined}
                readOnly={sending}
                required
                autoFocus
              />
              {fieldIcon}
            </div>
            <button
              type="submit"
              className={`cta${sending ? ' is-loading' : ''}`}
              disabled={check !== 'valid' || sending}
              aria-busy={sending}
            >
              <span ref={continueFaces.first} className={`cta-face${sending ? ' is-out' : ''}`}>
                Continue
              </span>
              <span ref={continueFaces.second} className={`cta-face${sending ? '' : ' is-out'}`} aria-hidden="true">
                <img src="/img/loader-spinning.svg" alt="" width={39} height={39} />
              </span>
            </button>
          </div>
          <div className="or" aria-hidden="true">
            <span>Or</span>
          </div>
          <button
            type="button"
            className="passkey-btn"
            disabled={sending}
            onClick={() => run(async () => onDone(await signIn()))}
          >
            <img src="/img/fingerprint.svg" alt="" width={30} height={30} />
            Sign in with passkey
          </button>
        </form>
      )}
      {(step === 'code' || step === 'working') && (
        <form className="otp-form" onSubmit={(e) => (e.preventDefault(), code.length === 6 && void verify(code))}>
          <CodeBoxes
            value={code}
            onChange={onCode}
            state={step === 'working' ? 'valid' : codeState}
            shaking={codeShaking}
            onShakeEnd={() => setCodeShaking(false)}
            inputRef={codeInput}
          />
          <div className="otp-after">
            {codeState === 'valid' || step === 'working' || sending || (codeState === 'checking' && slowCheck) ? (
              <img className="otp-spinner" src="/img/loader-spinning.svg" alt="" width={28} height={28} />
            ) : (
              <button type="button" className="otp-resend" onClick={() => void sendCode()}>
                Resend code
              </button>
            )}
          </div>
          {step === 'working' && (
            <p className="visually-hidden" role="status">
              Waiting for your passkey…
            </p>
          )}
        </form>
      )}
      {/* Hangs below the centred content, so a message appearing never moves the form. */}
      <div className="welcome-messages">
        {info && (
          <p className="info" role="status">
            {info}
          </p>
        )}
        {error && (
          <p className={quietError && codeState === 'wrong' ? 'visually-hidden' : 'error'} role="alert">
            {error}
          </p>
        )}
        {onCancel && (
          <button type="button" className="link" onClick={onCancel}>
            Cancel and go back to the app
          </button>
        )}
      </div>
    </Welcome>
  );
}

// ---------- sign-in handoff for OIDC (apps using "Sign in with Login") ----------

const INTERACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * /signin?interaction=<id>[&fresh=1]. Contract: apps/server/src/oidc/README.md.
 * Only ever redirects to two fixed paths built from a validated ID: never to a
 * URL from the query string, so this page can't be used as an open redirect.
 */
function SignInHandoff() {
  const params = new URLSearchParams(location.search);
  const interaction = params.get('interaction') ?? '';
  const fresh = params.get('fresh') === '1';
  const valid = INTERACTION_ID.test(interaction);
  const [state, setState] = useState<'checking' | 'sign-in' | 'leaving'>('checking');

  // Leave exactly once: a second redirect would cancel the first (React runs
  // effects twice in development, and callbacks can race).
  const left = useRef(false);
  const leave = useCallback((path: string) => {
    if (left.current) return;
    left.current = true;
    setState('leaving');
    location.assign(path);
  }, []);
  const complete = useCallback(() => leave(`/oidc/interaction/${interaction}/complete`), [leave, interaction]);
  const cancel = () => leave(`/oidc/interaction/${interaction}/abort?reason=cancelled`);

  useEffect(() => {
    if (!valid) return;
    if (fresh) {
      setState('sign-in'); // the app asked for a new passkey check, even if signed in
      return;
    }
    api('GET', '/api/me').then(complete, () => setState('sign-in'));
  }, [valid, fresh, complete]);

  if (!valid) {
    return (
      <Shell>
        <h1>This sign-in link doesn’t work</h1>
        <p role="alert" className="error">
          Go back to the app you came from and try signing in again.
        </p>
      </Shell>
    );
  }
  if (state !== 'sign-in') {
    return (
      <Shell>
        <p className="muted">{state === 'leaving' ? 'Taking you back to the app…' : 'Checking…'}</p>
      </Shell>
    );
  }
  return (
    <Join
      heading={fresh ? 'Confirm it’s you' : 'Sign in to continue'}
      intro={
        fresh
          ? 'The app asked Login to check again with your passkey.'
          : 'Use your Login passkey. The app only gets what you agree to share.'
      }
      onDone={complete}
      onCancel={cancel}
    />
  );
}

// ---------- account ----------

function Account({
  me,
  note,
  setNote,
  refresh,
}: {
  me: Me;
  note: string | null;
  setNote: (n: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const open = useWalletOpen();
  const [fp, setFp] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** A passkey just added whose storage can't open wallets: ask to keep or remove it. */
  const [signInOnly, setSignInOnly] = useState<string | null>(null);
  const [kyc, setKyc] = useState<KycStatus | undefined>(undefined);

  useEffect(() => {
    void wallet.fingerprint().then(setFp);
  }, [open]);

  /** D5: sends and withdrawals are confirmed with the passkey after the review. */
  const confirmWithPasskey = async () => {
    try {
      const o = await unlock(me);
      return o.kind === 'opened';
    } catch (e) {
      setError(explain(e));
      return false;
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const walletOpeners = me.credentials.filter((c) => c.canOpenWallet);
  const relevant = me.hasVault ? walletOpeners : me.credentials;
  const atRisk = relevant.length > 0 && relevant.every((c) => !c.backedUp);

  const [page, go] = usePage();
  const [hidden, toggleHidden] = useHideBalance();
  const [sheet, setSheet] = useState<'send' | 'receive' | null>(null);
  const messages = (
    <>
      {note && (
        <p className="info" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  return (
    <>
      {/* Outside the pages, so it keeps watching while you switch between them. */}
      {me.hasVault && open && <ClaimWatcher />}
      <Frame page={page} go={go} email={me.email} hidden={hidden} onToggleHidden={toggleHidden}>
        {page === 'home' && (
          <>
            <h1 className="visually-hidden">Home</h1>
            {atRisk && (
              <section className="warning" role="alert">
                <strong>You could lose access to your money.</strong> Your only passkey{relevant.length > 1 ? 's are' : ' is'}{' '}
                stored on a single device. If you lose it, nobody (including Login) can recover your wallet. Add a passkey on
                another device, such as your phone, that syncs with iCloud or Google.
              </section>
            )}
            {me.hasVault && open ? (
              <>
                <PrivateBalance hidden={hidden} onSend={() => setSheet('send')} onReceive={() => setSheet('receive')} />
                <BalanceChart />
                <Activity title="Notifications" card limit={4} hidden={hidden} onViewAll={() => go('notifications')} />
              </>
            ) : (
              <section className="panel locked" aria-labelledby="locked-h">
                <h2 id="locked-h">{me.hasVault ? 'Your wallet is locked' : 'No wallet on this device yet'}</h2>
                <p className="muted">
                  {me.hasVault
                    ? 'Unlock it with your passkey to see your private balance and activity. It locks after 15 minutes idle or when you close the tab.'
                    : 'Set it up with your passkey to hold and send money privately.'}
                </p>
                {me.hasVault ? (
                  <button className="cta" disabled={busy} onClick={() => run(async () => setNote(outcomeNote(await unlock(me))))}>
                    Unlock with passkey
                  </button>
                ) : (
                  <button
                    className="cta"
                    disabled={busy}
                    onClick={() => run(async () => setNote(outcomeNote(await setUpWalletHere(me))))}
                  >
                    Set up wallet on this device
                  </button>
                )}
              </section>
            )}
            {messages}
            {/* Today's forms, until the Send and Receive pop-ups from Figma are built (next round). */}
            <Modal open={sheet === 'send'} title="Send" onClose={() => setSheet(null)} wide>
              <SendPrivately confirmWithPasskey={confirmWithPasskey} />
              <Withdraw confirmWithPasskey={confirmWithPasskey} />
            </Modal>
            <Modal open={sheet === 'receive'} title="Receive" onClose={() => setSheet(null)} wide>
              <AddMoney />
            </Modal>
          </>
        )}

        {page === 'notifications' && (
          <>
            <h1 className="page-title">Notifications</h1>
            {me.hasVault && open ? (
              <Activity title="Notifications" hideTitle limit={20} hidden={hidden} />
            ) : (
              <p className="muted">
                Unlock your wallet on Home to see your activity. It’s worked out on this device and hidden while locked.
              </p>
            )}
          </>
        )}

        {page === 'verification' && (
          <>
            <h1 className="page-title">
              Verification <span className="tag-sandbox">Sandbox</span>
            </h1>
            {kyc && (
              <p data-testid="human-status">
                {kyc.verifiedHuman ? (
                  <span className="badge ok">Verified human{kyc.sandbox ? ' · test mode' : ''}</span>
                ) : (
                  <>
                    <span className="badge">Not verified</span>{' '}
                    <a
                      href="#kyc-h"
                      className="small"
                      onClick={(e) => (
                        e.preventDefault(),
                        document.getElementById('kyc-h')?.scrollIntoView({ behavior: 'smooth' })
                      )}
                    >
                      Verify you’re human
                    </a>
                  </>
                )}
              </p>
            )}
            <KycCard onStatus={setKyc} />
          </>
        )}

        {page === 'settings' && (
          <>
            <h1 className="page-title">Settings</h1>
            <section className="card" aria-labelledby="wallet-h">
              <h2 id="wallet-h">Wallet</h2>
              {!me.hasVault && (
                <>
                  <p>No wallet yet.</p>
                  <button disabled={busy} onClick={() => run(async () => setNote(outcomeNote(await setUpWalletHere(me))))}>
                    Set up wallet on this device
                  </button>
                </>
              )}
              {me.hasVault && open && (
                <>
                  <p>
                    <span className="badge ok">Unlocked</span> Locks after 15 minutes idle or when you close the tab.
                  </p>
                  {fp && (
                    <p className="muted small">
                      Wallet check: <code>{fp}</code>. Every passkey should show the same value.
                    </p>
                  )}
                  <div className="row">
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const o = await unlock(me);
                          setNote(
                            o.kind === 'opened' ? 'Confirmed with your passkey. (Test only: nothing was sent.)' : outcomeNote(o),
                          );
                        })
                      }
                    >
                      Confirm a test send
                    </button>
                    <button onClick={() => wallet.lock()}>Lock</button>
                  </div>
                </>
              )}
              {me.hasVault && !open && (
                <>
                  <p>
                    <span className="badge">Locked</span>
                  </p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => run(async () => setNote(outcomeNote(await unlock(me))))}
                  >
                    Unlock with passkey
                  </button>
                </>
              )}
            </section>
            {atRisk && (
              <section className="warning" role="alert">
                <strong>You could lose access to your money.</strong> Your only passkey{relevant.length > 1 ? 's are' : ' is'}{' '}
                stored on a single device. If you lose it, nobody (including Login) can recover your wallet. Add a passkey on
                another device, such as your phone, that syncs with iCloud or Google.
              </section>
            )}
            <section className="card" aria-labelledby="pk-h">
              <h2 id="pk-h">Passkeys</h2>
              <ul className="passkeys">
                {me.credentials.map((c) => (
                  <PasskeyRow
                    key={c.id}
                    c={c}
                    hasVault={me.hasVault}
                    disabled={busy}
                    walletOpen={open}
                    onRemove={() => run(async () => removePasskey(me, c.id))}
                    onConnect={() =>
                      run(async () => {
                        const r = await connectPasskey(me, c.id);
                        if (r === 'no-prf') setSignInOnly(c.id);
                        else setNote(connectNote(r));
                      })
                    }
                  />
                ))}
              </ul>
              <div className="add-passkey">
                <p className="small">
                  <strong>Add a backup passkey.</strong> Put it somewhere other than this device, so losing one doesn’t lock you
                  out.
                </p>
                <div className="row">
                  {(
                    [
                      ['phone', 'Add your phone', 'primary'],
                      ['security-key', 'Add a security key', ''],
                      ['any', 'Other options', 'link'],
                    ] as [PasskeyPlace, string, string][]
                  ).map(([place, label, cls]) => (
                    <button
                      key={place}
                      className={cls}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          setSignInOnly(null);
                          const r = await addPasskey(me, place);
                          if (r.result === 'no-prf') setSignInOnly(r.credentialId);
                          else setNote(connectNote(r.result));
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {me.hasVault && !open && <p className="muted small">Unlock your wallet first so a new passkey can open it too.</p>}
            </section>
            <ConnectedApps refreshKey={kyc ? String(kyc.verifiedHuman) : ''} />
            {/* Only while that passkey still exists: it may have been removed from the list instead. */}
            {signInOnly && me.credentials.some((c) => c.id === signInOnly) && (
              <section className="warning" role="alert" aria-label="Sign-in only passkey">
                <p>
                  <strong>This passkey can sign you in, but it can’t open your wallet.</strong> The place it’s stored (for
                  example, this browser’s own passkey storage) doesn’t support the feature Login uses to protect your wallet. So
                  it is <strong>not a backup for your money</strong>.
                </p>
                <div className="row">
                  <button onClick={() => (setSignInOnly(null), setNote('Kept for signing in only.'))}>Keep for signing in</button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await removePasskey(me, signInOnly);
                        setSignInOnly(null);
                        setNote('Removed. Try adding one on your phone or with a security key instead.');
                      })
                    }
                  >
                    Remove it
                  </button>
                </div>
              </section>
            )}
            {messages}
            <button
              className="link"
              onClick={async () => {
                wallet.lock();
                await api('POST', '/api/logout');
                await refresh();
              }}
            >
              Sign out
            </button>
          </>
        )}
      </Frame>
    </>
  );
}

function PasskeyRow({
  c,
  hasVault,
  walletOpen,
  disabled,
  onRemove,
  onConnect,
}: {
  c: PublicCredential;
  hasVault: boolean;
  walletOpen: boolean;
  disabled: boolean;
  onRemove: () => void;
  onConnect: () => void;
}) {
  const walletStatus = !hasVault
    ? null
    : c.canOpenWallet
      ? 'opens wallet'
      : c.prfSupported === false
        ? 'sign-in only: where it’s stored can’t open wallets'
        : 'not connected to your wallet yet';
  const canConnect = hasVault && !c.canOpenWallet && c.prfSupported !== false;
  return (
    <li>
      <div>
        <strong>{c.backedUp ? 'Synced passkey' : 'Device-only passkey'}</strong>
        <span className="muted small">
          {' '}
          · {c.backedUp ? 'backed up by your password manager' : 'lost if this device is lost'}
          {walletStatus && ` · ${walletStatus}`}
        </span>
        <div className="muted small">
          Added {new Date(c.createdAt).toLocaleString()}
          {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleString()}` : ''}
        </div>
        {canConnect && !walletOpen && <div className="muted small">Unlock your wallet to connect it.</div>}
      </div>
      <div className="row">
        {canConnect && (
          <button className="link" disabled={disabled || !walletOpen} onClick={onConnect}>
            Connect
          </button>
        )}
        <button className="link danger" disabled={disabled} onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}

// ---------- dev outbox ----------

function DevOutbox() {
  const [emails, setEmails] = useState<{ to: string; subject: string; body: string; sentAt: number }[] | null>(null);
  useEffect(() => {
    const load = () =>
      api<{ emails: typeof emails }>('GET', '/api/dev/outbox')
        .then((r) => setEmails(r.emails))
        .catch(() => setEmails(null));
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <Shell>
      <h1>Dev outbox</h1>
      <p className="muted small">Development only. Emails that would have been sent. Refreshes every 2 seconds.</p>
      {emails === null && <p className="error">Outbox is off. Start the server with DEV_OUTBOX=1 on localhost.</p>}
      <ul className="outbox">
        {emails?.map((e) => (
          <li key={e.sentAt + e.to}>
            <div className="muted small">
              {new Date(e.sentAt).toLocaleTimeString()} · to {e.to}
            </div>
            <strong>{e.subject}</strong>
            <p>{e.body}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
