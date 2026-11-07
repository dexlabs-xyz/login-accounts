/**
 * "Get test funds" (TESTNET ONLY): one claim of 1,000 test USDT per account,
 * sent privately from Login's test-funds pool, plus a small hidden reserve
 * that pays network fees. Exception to D6, labelled on screen: to send it, the
 * server is told this account's private address for this one claim.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api.ts';
import { privateWallet } from './railgun/client.ts';

interface View {
  enabled: boolean;
  amountUsdt?: string;
  ready?: boolean;
  status?: 'queued' | 'sending' | 'sent' | null;
  txHash?: string | null;
}

const ERRORS: Record<string, string> = {
  'already-claimed': 'This account has already claimed its test funds.',
  'daily-limit-reached': 'Today’s test funds have all been claimed. Try again tomorrow.',
  'pool-starting': 'The test-funds pool is still starting up. Try again in a minute.',
  'pool-empty': 'The test-funds pool is being refilled. Try again later.',
  'invalid-address': 'Your private address isn’t ready yet. Wait for your balance to finish loading.',
};

export function TestFunds() {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api<View>('GET', '/api/test-funds').then(setView, () => setView(null));
  useEffect(() => void load(), []);
  // While the pool is sending, check back every few seconds.
  useEffect(() => {
    if (view?.status !== 'queued' && view?.status !== 'sending') return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [view?.status]);

  if (!view?.enabled || pw.status === 'off' || pw.status === 'starting') return null;

  const claim = async () => {
    if (!pw.railgunAddress) return;
    setError('');
    setBusy(true);
    try {
      setView(await api<View>('POST', '/api/test-funds/claim', { railgunAddress: pw.railgunAddress }));
    } catch (e) {
      setError((e instanceof ApiError && ERRORS[e.code]) || 'Couldn’t claim test funds. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="testfunds-h">
      <h2 id="testfunds-h">
        Test funds <span className="badge">Testnet</span>
      </h2>
      {!view.status && (
        <>
          <p className="muted small">
            Try Login without hunting for faucets: get {view.amountUsdt} test USDT in your private balance, once per account.
            Ready to spend in about an hour, after Railgun’s privacy check. Test tokens have no value.
          </p>
          <button className="primary" disabled={busy || !pw.railgunAddress} onClick={() => void claim()}>
            {busy ? 'Claiming…' : `Get ${view.amountUsdt} test USDT`}
          </button>
          <p className="small muted">
            To send them, our server is told your private address for this one claim. It isn’t stored: we only record that this
            account has claimed.
          </p>
        </>
      )}
      {(view.status === 'queued' || view.status === 'sending') && (
        <p role="status" className="info" data-testid="testfunds-status">
          Sending your test funds privately… This takes a minute or two.
        </p>
      )}
      {view.status === 'sent' && (
        <div className="stack">
          <p role="status" className="info" data-testid="testfunds-status">
            Sent {view.amountUsdt} test USDT to your private balance. Ready to spend in about an hour: it shows as “being
            checked” until Railgun’s privacy check clears.
          </p>
          {view.txHash && (
            <a className="small" href={`https://sepolia.etherscan.io/tx/${view.txHash}`} target="_blank" rel="noreferrer">
              View on Sepolia Etherscan (shows only that a private transfer happened)
            </a>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
