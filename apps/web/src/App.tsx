import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import { api, ApiError } from './api.ts';
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
      'last-wallet-passkey': 'This is the only passkey that can open your wallet. Add another one first, or you’d lose access to your money.',
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
    if (err.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out. Nothing changed. Try again when ready.';
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
  return <Main />;
}

function useWalletOpen() {
  return useSyncExternalStore(wallet.subscribe, wallet.isOpen);
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

  if (me === 'loading') return <Shell><p className="muted">Loading…</p></Shell>;
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

function Join({
  onDone,
  heading = 'Sign up or sign in',
  intro,
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
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

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
      await api('POST', '/api/email/start', { email });
      setStep('code');
      setInfo(`We sent a 6-digit code to ${email.trim().toLowerCase()}.`);
    });

  const verify = () =>
    run(async () => {
      const r = await api<{ status: 'new'; ticket: string } | { status: 'existing' }>('POST', '/api/email/verify', {
        email,
        code,
      });
      if (r.status === 'existing') {
        setStep('email');
        setInfo('You already have an account. Sign in with your passkey.');
        return;
      }
      setStep('working');
      setInfo('Create your passkey. Your device may ask twice: once to create it, once to set up your wallet.');
      onDone(await signUp(r.ticket));
    });

  return (
    <Shell>
      <h1>{heading}</h1>
      {intro && <p className="muted">{intro}</p>}
      {step === 'email' && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void sendCode())}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="email webauthn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <button type="submit" className="primary">Continue</button>
          <div className="or">or</div>
          <button type="button" onClick={() => run(async () => onDone(await signIn()))}>
            Sign in with passkey
          </button>
        </form>
      )}
      {step === 'code' && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void verify())}>
          <label>
            6-digit code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
            />
          </label>
          <button type="submit" className="primary">Verify</button>
          <div className="row">
            <button type="button" className="link" onClick={() => (setStep('email'), setCode(''))}>
              ← Use a different email
            </button>
            <button type="button" className="link" onClick={() => void sendCode()}>
              Send a new code
            </button>
          </div>
        </form>
      )}
      {step === 'working' && <p className="muted">Waiting for your passkey…</p>}
      {info && <p className="info" role="status">{info}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {onCancel && (
        <button type="button" className="link" onClick={onCancel}>
          Cancel and go back to the app
        </button>
      )}
    </Shell>
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

  const complete = useCallback(() => {
    setState('leaving');
    location.assign(`/oidc/interaction/${interaction}/complete`);
  }, [interaction]);
  const cancel = () => {
    setState('leaving');
    location.assign(`/oidc/interaction/${interaction}/abort?reason=cancelled`);
  };

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
        <p role="alert" className="error">Go back to the app you came from and try signing in again.</p>
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

  useEffect(() => {
    void wallet.fingerprint().then(setFp);
  }, [open]);

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

  return (
    <Shell>
      <h1>Your account</h1>
      <p className="muted">{me.email}</p>

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
            {fp && <p className="muted small">Wallet check: <code>{fp}</code>. Every passkey should show the same value.</p>}
            <div className="row">
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const o = await unlock(me);
                    setNote(o.kind === 'opened' ? 'Confirmed with your passkey. (Test only: nothing was sent.)' : outcomeNote(o));
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
            <p><span className="badge">Locked</span></p>
            <button className="primary" disabled={busy} onClick={() => run(async () => setNote(outcomeNote(await unlock(me))))}>
              Unlock with passkey
            </button>
          </>
        )}
      </section>

      {atRisk && (
        <section className="warning" role="alert">
          <strong>You could lose access to your money.</strong> Your only passkey{relevant.length > 1 ? 's are' : ' is'} stored on a
          single device. If you lose it, nobody (including Login) can recover your wallet. Add a passkey on another device, such as your
          phone, that syncs with iCloud or Google.
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
            <strong>Add a backup passkey.</strong> Put it somewhere other than this device, so losing one doesn’t lock you out.
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

      {/* Only while that passkey still exists: it may have been removed from the list instead. */}
      {signInOnly && me.credentials.some((c) => c.id === signInOnly) && (
        <section className="warning" role="alert" aria-label="Sign-in only passkey">
          <p>
            <strong>This passkey can sign you in, but it can’t open your wallet.</strong> The place it’s stored (for example, this
            browser’s own passkey storage) doesn’t support the feature Login uses to protect your wallet. So it is{' '}
            <strong>not a backup for your money</strong>.
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

      {note && <p className="info" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

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
    </Shell>
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
            <div className="muted small">{new Date(e.sentAt).toLocaleTimeString()} · to {e.to}</div>
            <strong>{e.subject}</strong>
            <p>{e.body}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
