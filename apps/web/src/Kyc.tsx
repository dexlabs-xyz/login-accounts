/**
 * Verification card on the account page (docs/kyc-architecture.md).
 *
 * KYC is optional: nothing else in Login depends on it. Selfies and
 * documents go from the Sumsub widget straight to Sumsub (sandbox), never
 * through Login. This screen only ever shows a level and a pass/fail state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import snsWebSdk from '@sumsub/websdk';
import { api, ApiError } from './api.ts';

type Level = 'L1' | 'L2' | 'L3';
type AttemptState = 'in-progress' | 'in-review' | 'passed' | 'retry' | 'final';
type Reason = 'duplicate' | 'suspected-fraud' | 'selfie' | 'document' | 'other';

type KycView =
  | { available: false }
  | {
      available: true;
      sandbox: true;
      mode: 'webhook' | 'polling';
      level: Level | null;
      verifiedHuman: boolean;
      attempt: { level: Level; state: AttemptState; reason: Reason | null } | null;
    };

const LEVEL_INFO: Record<Level, { title: string; what: string; time: string }> = {
  L1: { title: 'Verified human', what: 'a short selfie video', time: 'about 30 seconds' },
  L2: { title: 'Verified identity', what: 'a scan of your ID document', time: 'about 2 minutes' },
  L3: { title: 'Verified address', what: 'a photo of a proof of address, like a utility bill', time: 'about 2 minutes' },
};

const next = (level: Level | null): Level | null => (level === null ? 'L1' : level === 'L1' ? 'L2' : level === 'L2' ? 'L3' : null);

function retryMessage(reason: Reason | null): string {
  switch (reason) {
    case 'selfie':
      return 'Your selfie couldn’t be checked. Find good light, keep your whole face in the frame, and try again.';
    case 'document':
      return 'Your document couldn’t be read. Make sure all of it is in the photo, sharp and without glare, and try again.';
    default:
      return 'Something in your submission needs another look. Try again.';
  }
}

function finalMessage(reason: Reason | null): string {
  switch (reason) {
    case 'duplicate':
      return 'This face is already linked to another Login account, and each person can have one verified account. If you lost access to your old account, account recovery is coming soon.';
    case 'suspected-fraud':
      return 'We couldn’t verify you, and this decision is final. Everything else in Login still works.';
    default:
      return 'This verification can’t be completed. Everything else in Login still works.';
  }
}

function explainKyc(err: unknown): string {
  if (err instanceof ApiError) {
    const m: Record<string, string> = {
      'kyc-unavailable': 'Our verification partner isn’t answering right now. Try again in a minute.',
      'kyc-off': 'Verification isn’t set up on this server.',
      'already-verified': 'You’ve already reached this level.',
      'needs-lower-level': 'Finish the previous step first.',
      'verification-closed': 'This verification can’t be retried.',
      'signed-out': 'You’ve been signed out. Sign in again.',
    };
    return m[err.code] ?? 'Something went wrong. Try again.';
  }
  return 'Something went wrong. Try again.';
}

export function KycCard() {
  const [view, setView] = useState<KycView | null>(null);
  const [stage, setStage] = useState<'idle' | 'before' | 'widget'>('idle');
  const [target, setTarget] = useState<Level | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const sdk = useRef<{ destroy(): void } | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const v = await api<KycView>(refresh ? 'POST' : 'GET', refresh ? '/api/kyc/refresh' : '/api/kyc');
      setView(v);
      return v;
    } catch (e) {
      setError(explainKyc(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => sdk.current?.destroy();
  }, [load]);

  // While Sumsub reviews, check every 5 seconds for up to 2 minutes.
  const inReview = view?.available && view.attempt?.state === 'in-review';
  useEffect(() => {
    if (!inReview) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 24) return clearInterval(t);
      void load(true);
    }, 5000);
    return () => clearInterval(t);
  }, [inReview, load]);

  const closeWidget = useCallback(async () => {
    sdk.current?.destroy();
    sdk.current = null;
    setStage('idle');
    await load(true);
  }, [load]);

  const launch = async (level: Level) => {
    setError('');
    setBusy(true);
    try {
      const start = () => api<{ token: string } & KycView>('POST', '/api/kyc/start', { level });
      const first = await start();
      setView(first);
      setStage('widget');
      const polling = first.available && first.mode === 'polling';
      // Wait a tick so the container is on screen.
      await new Promise((r) => setTimeout(r, 0));
      sdk.current?.destroy();
      const instance = snsWebSdk
        .init(first.token, async () => (await start()).token)
        .withConf({ lang: 'en', theme: 'light' })
        .withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on('idCheck.onApplicantLoaded', (p) => {
          // Local development only: the server polls Sumsub using this ID.
          if (polling) void api<KycView>('POST', '/api/kyc/applicant', { applicantId: p.applicantId }).then(setView, () => {});
        })
        .on('idCheck.onApplicantSubmitted', () => void load(true))
        .on('idCheck.onApplicantStatusChanged', () => void load(true))
        .on('idCheck.onError', () => setError('The verification window had a problem. Close it and try again.'))
        .build();
      instance.launch(container.current!);
      sdk.current = instance;
    } catch (e) {
      setError(explainKyc(e));
      setStage('idle');
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section className="card" aria-labelledby="kyc-h">
        <h2 id="kyc-h">Verification</h2>
        <p className="muted">Loading…</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    );
  }

  if (!view.available) {
    return (
      <section className="card" aria-labelledby="kyc-h">
        <h2 id="kyc-h">Verification</h2>
        <p className="muted">Verification isn’t set up on this server.</p>
      </section>
    );
  }

  const nextLevel = next(view.level);
  const a = view.attempt;
  const current = a && a.state !== 'passed' && a.level === nextLevel ? a : null;

  return (
    <section className="card" aria-labelledby="kyc-h">
      <h2 id="kyc-h">Verification</h2>
      <p className="warning small" role="note">
        <strong>Sandbox (test mode).</strong> No real checks happen here. Don’t use your real face or a real ID document.
      </p>

      {view.level ? (
        <p>
          <strong>{LEVEL_INFO[view.level].title}</strong> ({view.level}). Apps you sign in to see “verified human”. They see your
          level only if you allow it for that app.
        </p>
      ) : (
        <p className="muted">
          Optional. Verifying lets apps know you’re a real person, without them learning who you are. Everything in Login works
          without it.
        </p>
      )}

      {stage === 'before' && target && (
        <div>
          <p>
            <strong>{LEVEL_INFO[target].title}</strong> takes {LEVEL_INFO[target].time}. You’ll record {LEVEL_INFO[target].what}.
          </p>
          <p className="muted small">
            This goes to Sumsub, our verification partner, not to Login. Login only learns whether you passed. You may be asked for
            camera access. On a computer without a camera, you can continue on your phone with a QR code.
          </p>
          <div className="row">
            <button disabled={busy} onClick={() => void launch(target)}>
              Continue
            </button>
            <button className="link" onClick={() => setStage('idle')}>
              Not now
            </button>
          </div>
        </div>
      )}

      {stage === 'widget' && (
        <div>
          <div ref={container} id="sumsub-websdk-container" />
          <button className="link" onClick={() => void closeWidget()}>
            Close. You can come back to this later.
          </button>
        </div>
      )}

      {stage === 'idle' && current?.state === 'in-review' && (
        <div role="status">
          <p>Checking your {LEVEL_INFO[current.level].title.toLowerCase()} submission. This usually takes under a minute.</p>
          <button disabled={busy} onClick={() => void load(true)}>
            Check again
          </button>
        </div>
      )}

      {stage === 'idle' && current?.state === 'retry' && (
        <div role="status">
          <p>{retryMessage(current.reason)}</p>
          <button disabled={busy} onClick={() => void launch(current.level)}>
            Try again
          </button>
        </div>
      )}

      {stage === 'idle' && current?.state === 'final' && (
        <p className="info" role="status">
          {finalMessage(current.reason)}
        </p>
      )}

      {stage === 'idle' && current?.state === 'in-progress' && (
        <div>
          <p className="muted">You started {LEVEL_INFO[current.level].title.toLowerCase()} but didn’t finish.</p>
          <button disabled={busy} onClick={() => void launch(current.level)}>
            Continue where you left off
          </button>
        </div>
      )}

      {stage === 'idle' && nextLevel && !current && (
        <button
          disabled={busy}
          onClick={() => {
            setTarget(nextLevel);
            setStage('before');
          }}
        >
          {view.level ? `Add ${LEVEL_INFO[nextLevel].title.toLowerCase()} (${nextLevel})` : `Verify you’re human (${LEVEL_INFO.L1.time})`}
        </button>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
