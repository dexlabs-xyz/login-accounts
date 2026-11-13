/**
 * Test USDT (TESTNET ONLY): one claim of 250 test USDT per account,
 * shielded by Login's test-funds pool straight into the account's private
 * balance, plus a small hidden reserve that pays network fees. Exception to D6: to send it, the server is told this
 * account's private address for this one claim. Disclosed once, in the success toast (Gold, 12 Nov), and in the
 * README and the design doc.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useToast } from './ui/toast.tsx';
import { useHistory, usdDelta } from './History.tsx';
import { usd } from './money.ts';
import type { HistoryEntry } from './railgun/protocol.ts';
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

/**
 * "Test USDT" (Figma: Home). One press: the plus turns into a spinner until the claim is
 * accepted, then every update about the top-up arrives as a toast (Gold, 11 Nov). The
 * button stays after claiming (repeat claims may come later); pressing it again says so.
 */
let lastView: View | null = null;

export function TestUsdtButton() {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const toast = useToast();
  // The last answer, kept in memory, so the button is there at once when you come back to Home (no pop-in).
  const [view, setView] = useState<View | null>(() => lastView);
  const [busy, setBusy] = useState(false);
  const previous = useRef<View['status']>(undefined);

  const load = () =>
    api<View>('GET', '/api/test-funds').then(
      (v) => setView((lastView = v)),
      () => setView(null),
    );
  useEffect(() => void load(), []);
  // While the pool is sending, check back every few seconds.
  useEffect(() => {
    if (view?.status !== 'queued' && view?.status !== 'sending') return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [view?.status]);

  // Toasts follow the claim (Gold, 12 Nov): a spinner while it's on its way, which becomes "Sent" when it lands,
  // then a separate note that we saw the address once. "Now spendable" follows later (ClaimWatcher).
  const amount = view?.amountUsdt ?? '250';
  useEffect(() => {
    const status = view?.status;
    const was = previous.current;
    previous.current = status;
    if (status === 'queued' || status === 'sending') {
      if (was !== 'queued' && was !== 'sending') {
        toast.show({ id: 'testfunds-claim', kind: 'loading', text: `Sending $${amount} test USDT to your private balance`, testId: 'testfunds-status' });
      }
    } else if (status === 'sent' && (was === 'queued' || was === 'sending')) {
      toast.show({
        id: 'testfunds-claim',
        kind: 'message',
        text: `Sent $${amount} to your private balance`,
        description: 'Should be spendable in about an hour, sometimes up to two (Railgun’s privacy check).',
        testId: 'testfunds-status',
      });
      // The D6 exception, disclosed once, after the claim (Gold, 12 Nov: a toast, nothing before, no ⓘ).
      toast.show({ kind: 'info', text: 'We see your private address only this once. We didn’t store it.', testId: 'testfunds-privacy' });
    }
  }, [view?.status, amount, toast]);

  // Always on Home (it's part of the design), even before the first answer arrives, so the row of buttons never
  // shifts; a server without the test-funds pool just says so when pressed.
  const claim = async () => {
    if (busy || !view) return;
    // Each press gets its own toast; they stack (Gold, 12 Nov).
    if (!view.enabled) return toast.show({ kind: 'info', text: 'Test USDT isn’t set up on this server.' });
    if (view.status === 'sent') return toast.show({ kind: 'info', text: 'You already claimed!' });
    if (view.status === 'queued' || view.status === 'sending') return toast.show({ kind: 'info', text: `Your $${amount} test USDT is on its way.` });
    if (!pw.railgunAddress) return toast.show({ kind: 'error', text: ERRORS['invalid-address']! });
    setBusy(true);
    try {
      setView(await api<View>('POST', '/api/test-funds/claim', { railgunAddress: pw.railgunAddress }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already-claimed') toast.show({ kind: 'info', text: 'You already claimed!' });
      else toast.show({ kind: 'error', text: (e instanceof ApiError && ERRORS[e.code]) || 'Couldn’t claim test funds. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className="hero-btn is-primary" onClick={() => void claim()} aria-busy={busy}>
      <img src={busy ? '/img/loader-spinning.svg' : '/img/plus.svg'} alt="" width={18} height={18} />
      Test USDT
    </button>
  );
}

/**
 * "Your $250 is now spendable": shown once when a test-funds claim clears Railgun's privacy check while you're
 * signed in. Mounted for the whole signed-in app, so it fires on whichever page you're on.
 */
export function ClaimWatcher() {
  const { entries, isClaim } = useHistory();
  const toast = useToast();
  const seen = useRef(new Map<string, HistoryEntry['status']>());
  useEffect(() => {
    for (const e of entries ?? []) {
      if (!isClaim(e)) continue;
      const before = seen.current.get(e.txid);
      seen.current.set(e.txid, e.status);
      if (before === 'checking' && e.status === 'spendable') {
        const d = usdDelta(e);
        toast.show({ kind: 'success', text: `Your ${d === null ? 'test USDT' : wholeDollars(d)} is now spendable` });
      }
    }
  }, [entries, isClaim, toast]);
  return null;
}

/** "$250" for whole amounts, "$250.50" otherwise. */
const wholeDollars = (units: bigint) => usd(units, 6).replace(/\.00$/, '');
