/**
 * Toasts, shown with Sonner (sonner.emilkowal.ski, MIT, pinned in apps/web/package.json; Gold, 12 Nov).
 * Progress and success fade after a few seconds; errors stay until closed. Sonner announces each one to
 * screen readers. The small useToast() API below is unchanged, so callers don't depend on Sonner itself.
 */
import { createContext, useContext, useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { useTheme } from './theme.ts';

/**
 * message: a status with no icon (e.g. "Sent $250 to your private balance").
 * loading: in progress (Sonner's spinner); turn it into the outcome later by showing the same id again.
 * info / success / warning / error: Sonner's icons, in our colours.
 */
export type ToastKind = 'message' | 'loading' | 'info' | 'success' | 'warning' | 'error';
export interface ToastInput {
  text: string;
  /** A second, quieter line under the text. */
  description?: string;
  kind?: ToastKind;
  /** Replaces the toast with the same id instead of stacking a new one: only for stages of one thing (loading → done). */
  id?: string;
  /** Stays until closed. Errors always stay. */
  sticky?: boolean;
  /** Put on the message itself, for the browser tests (e.g. testfunds-status). */
  testId?: string;
  /** A button on the toast (e.g. Retry sync). Pressing it also closes the toast. */
  action?: { label: string; onClick: () => void };
  /** A second, quieter button (e.g. Keep for signing in). */
  cancel?: { label: string; onClick: () => void };
  /** No × to close it: for a reminder that stays until what it asks for is done (e.g. unlocking the wallet). */
  persistent?: boolean;
}

const FADE_AFTER_MS = 5000;

const api = {
  show({ text, description, kind = 'message', id, sticky, testId, action, cancel, persistent }: ToastInput) {
    const content = testId ? <span data-testid={testId}>{text}</span> : text;
    const stays = sticky ?? (kind === 'error' || kind === 'loading' || !!action);
    const options = {
      id,
      description,
      action,
      cancel,
      duration: stays || persistent ? Infinity : FADE_AFTER_MS,
      ...(persistent && { closeButton: false, dismissible: false }),
    };
    const show = { message: toast.message, loading: toast.loading, info: toast.info, success: toast.success, warning: toast.warning, error: toast.error }[kind];
    show(content, options);
  },
  dismiss(id: string) {
    toast.dismiss(id);
  },
};

const Ctx = createContext<typeof api | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

/**
 * Feedback, warnings, errors and status are toasts, never lines on the page (Gold, 12 Nov: a message appearing must not
 * move the layout). Shows `text` while it's set, replaces it when it changes, and closes it when it's cleared.
 */
export function useToastWhile(text: string | null | undefined, options: Omit<ToastInput, 'text'> & { id: string }) {
  const toast = useToast();
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (text) toast.show({ ...latest.current, text });
    else toast.dismiss(latest.current.id);
  }, [text, toast]);
  useEffect(() => () => toast.dismiss(latest.current.id), [toast]);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Ctx.Provider value={api}>
      {children}
      <Toaster
        theme={theme}
        position="bottom-right"
        closeButton
        offset={20}
        mobileOffset={{ bottom: 84 }}
        toastOptions={{ className: 'login-toast' }}
      />
    </Ctx.Provider>
  );
}
