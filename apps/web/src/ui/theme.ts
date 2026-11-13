/**
 * Dark (Gold's Figma) or light (from Gold's page colour #FAFAFA, 13 Nov). Follows the device's setting until the
 * person picks one in Settings › Theme (Gold, 13 Nov); that choice is remembered on this browser.
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
// v2: the first preview (13 Nov) saved "light" from a ?theme=light link on every reload, overriding both the
// device's setting and the choice in Settings. That link is gone; its leftover choice is ignored.
const KEY = 'login.theme.v2';
const listeners = new Set<() => void>();
const systemLight = () => matchMedia('(prefers-color-scheme: light)').matches;

/** What the person picked (null: follow the device). */
let picked: Theme | null = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
})();

function apply() {
  const theme: Theme = picked ?? (systemLight() ? 'light' : 'dark');
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#FAFAFA' : '#080808');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  listeners.forEach((l) => l());
}

export function initTheme() {
  try {
    localStorage.removeItem('login.theme');
  } catch {
    /* nothing to clean up */
  }
  apply();
  // While nothing is picked, follow the device when it switches (e.g. at sunset).
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
}

export function setTheme(theme: Theme) {
  picked = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: it still switches for this visit */
  }
  apply();
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    currentTheme,
  );
}
