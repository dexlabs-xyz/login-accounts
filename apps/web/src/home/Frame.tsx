/**
 * The signed-in frame (Figma: Login.com/Home): sidebar with the brand, four pages and
 * the account at the bottom; on phones a top bar and a bottom tab bar instead.
 * Pages live in the URL hash (#notifications…), so Back and Forward work.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { privateWallet } from '../railgun/client.ts';
import { SEPOLIA_USDC, SEPOLIA_USDT, USDC_DECIMALS, USDT_DECIMALS } from '../railgun/protocol.ts';
import { usd } from '../money.ts';
import { useToast } from '../ui/toast.tsx';

export type Page = 'home' | 'notifications' | 'verification' | 'settings';
const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '/img/nav-home.svg' },
  { id: 'notifications', label: 'Notifications', icon: '/img/nav-notifications.svg' },
  { id: 'verification', label: 'Verification', icon: '/img/nav-verification.svg' },
  { id: 'settings', label: 'Settings', icon: '/img/nav-settings.svg' },
];
const pageFromHash = (): Page => {
  const h = location.hash.replace('#', '') as Page;
  return PAGES.some((p) => p.id === h) ? h : 'home';
};

export function usePage(): [Page, (p: Page) => void] {
  const [page, setPage] = useState<Page>(pageFromHash);
  useEffect(() => {
    const on = () => setPage(pageFromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((p: Page) => {
    if (p === pageFromHash()) return;
    location.hash = p === 'home' ? '' : p;
    if (p === 'home') history.replaceState(null, '', location.pathname + location.search);
    setPage(p);
    scrollTo({ top: 0 });
  }, []);
  return [page, go];
}

const USD: Record<string, number> = { [SEPOLIA_USDT.toLowerCase()]: USDT_DECIMALS, [SEPOLIA_USDC.toLowerCase()]: USDC_DECIMALS };

/** Dollars in the private balance (USDT/USDC, all buckets except spent; the hidden ETH fee reserve is left out). */
export function useUsdTotal(): bigint | null {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  if (pw.status !== 'ready' && pw.status !== 'syncing') return null;
  let total = 0n;
  for (const [bucket, list] of Object.entries(pw.balances)) {
    if (bucket === 'Spent') continue;
    for (const t of list ?? []) {
      const d = USD[t.tokenAddress.toLowerCase()];
      if (d !== undefined) total += BigInt(t.amount) * 10n ** BigInt(6 - d);
    }
  }
  return total;
}

/** "Hide balance" (the eye): remembered on this device only. */
export function useHideBalance(): [boolean, () => void] {
  const read = () => {
    try {
      return localStorage.getItem('login.hideBalance') === '1';
    } catch {
      return false;
    }
  };
  const [hidden, setHidden] = useState(read);
  const toggle = () =>
    setHidden((h) => {
      try {
        localStorage.setItem('login.hideBalance', h ? '0' : '1');
      } catch {
        /* private mode: just not remembered */
      }
      return !h;
    });
  return [hidden, toggle];
}

export function useCopyAddress() {
  const pw = useSyncExternalStore(privateWallet.subscribe, privateWallet.get);
  const toast = useToast();
  const address = pw.railgunAddress;
  const copy = () => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(
      () => toast.show({ id: 'copy', kind: 'success', text: 'Private address copied. Share it to receive privately.' }),
      () => toast.show({ id: 'copy', kind: 'error', text: 'Couldn’t copy. Your browser blocked the clipboard.' }),
    );
  };
  return { address, copy };
}

function Brand() {
  return (
    <div className="brand-mark" aria-label="Login (accounts)">
      Login<span>(accts)</span>
    </div>
  );
}

function Account({ email, hidden, onToggleHidden }: { email: string; hidden: boolean; onToggleHidden: () => void }) {
  const total = useUsdTotal();
  const { address, copy } = useCopyAddress();
  return (
    <div className="side-account">
      <img className="side-avatar" src="/img/avatar.png" alt="" width={39} height={39} />
      <div className="side-who">
        <span className="side-email" title={email}>
          {email}
        </span>
        <span className="side-balance">
          <span>{total === null ? '—' : hidden ? '••••' : usd(total, 6)}</span>
          <button type="button" className="icon-btn" aria-label={hidden ? 'Show balance' : 'Hide balance'} aria-pressed={hidden} onClick={onToggleHidden}>
            <img src={hidden ? '/img/eye-off.svg' : '/img/eye.svg'} alt="" width={16} height={16} />
          </button>
        </span>
      </div>
      <button type="button" className="icon-btn side-copy" aria-label="Copy your private address" disabled={!address} onClick={copy}>
        <img src="/img/copy.svg" alt="" width={20} height={20} />
      </button>
    </div>
  );
}

export function Frame({
  page,
  go,
  email,
  hidden,
  onToggleHidden,
  children,
}: {
  page: Page;
  go: (p: Page) => void;
  email: string;
  hidden: boolean;
  onToggleHidden: () => void;
  children: React.ReactNode;
}) {
  const nav = (where: 'side' | 'tabs') => (
    <nav className={where === 'side' ? 'side-nav' : 'tab-nav'} aria-label="Main">
      {PAGES.map((p) => (
        <a
          key={p.id}
          href={p.id === 'home' ? '#' : `#${p.id}`}
          className={p.id === page ? 'is-current' : undefined}
          aria-current={p.id === page ? 'page' : undefined}
          onClick={(e) => (e.preventDefault(), go(p.id))}
        >
          <img src={p.icon} alt="" width={24} height={24} />
          <span>{p.label}</span>
        </a>
      ))}
    </nav>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand />
          {nav('side')}
        </div>
        <Account email={email} hidden={hidden} onToggleHidden={onToggleHidden} />
      </aside>
      <div className="app-divider" aria-hidden="true" />
      <header className="topbar">
        <Brand />
        <Account email={email} hidden={hidden} onToggleHidden={onToggleHidden} />
      </header>
      {/* Home is centred top to bottom like the Figma frame; longer pages start at the top and scroll. */}
      <main className={`app-main${page === 'home' ? ' is-home' : ' is-long'}`} key={page}>
        {children}
      </main>
      {nav('tabs')}
    </div>
  );
}
