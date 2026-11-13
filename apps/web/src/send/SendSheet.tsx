/**
 * The Send pop-up (Figma 445:6734 options, 445:6965 privately, 446:7312 Ethereum, 446:7449 Solana), plus the
 * review, sending and sent screens in the same style. A private send goes to a 0zk address; sending to an
 * Ethereum or Solana address is a withdrawal (public on arrival). The money logic lives in SendPanel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { SendPanel, type SendMode } from './SendPrivately.tsx';

type Screen = 'options' | SendMode;
type PanelStep = 'form' | 'quoting' | 'review' | 'sending' | 'sent';

const STEP_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };
const STEP_FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } };

const SUBTITLE: Record<Screen, string> = {
  options: 'Your account stays private',
  private: 'Send privately to an 0zk address',
  evm: 'Send to an Ethereum address',
  sol: 'Send to a Solana address',
};
const PANEL_SUBTITLE: Partial<Record<PanelStep, string>> = {
  review: 'Check it, then confirm with your passkey',
  sending: 'Sending…',
  sent: 'Sent',
};

export function SendSheet({
  confirmWithPasskey,
  onClose,
  open,
}: {
  confirmWithPasskey: () => Promise<boolean>;
  onClose: () => void;
  /** "View" in Notifications: show this kind of send's screen (its processing screen while it runs). */
  open?: { mode: SendMode; n: number } | null;
}) {
  const [trail, setTrail] = useState<Screen[]>(['options']);
  const [pos, setPos] = useState(0);
  const screen = trail[pos]!;
  const [panelStep, setPanelStep] = useState<PanelStep>('form');
  // Every form you've opened stays mounted, even after stepping back to another one, so a send still running
  // keeps its screen to come back to.
  const [mounted, setMounted] = useState<SendMode[]>([]);
  const go = (next: Screen) => {
    if (next !== 'options') setMounted((m) => (m.includes(next) ? m : [...m, next]));
    setTrail((t) => [...t.slice(0, pos + 1), next]);
    setPos((p) => p + 1);
  };
  useEffect(() => {
    if (!open) return;
    setMounted((m) => (m.includes(open.mode) ? m : [...m, open.mode]));
    setTrail(['options', open.mode]);
    setPos(1);
  }, [open]);
  const back = () => setPos((p) => Math.max(0, p - 1));
  const forward = () => setPos((p) => Math.min(trail.length - 1, p + 1));
  const onStep = useCallback((s: PanelStep) => setPanelStep(s), []);

  // The pop-up's height follows the current screen, from its centre (same as Receive).
  const [height, setHeight] = useState<number | 'auto'>('auto');
  const watch = useRef<ResizeObserver | null>(null);
  const inner = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    if (!el) return;
    watch.current = new ResizeObserver(() => setHeight(el.offsetHeight));
    watch.current.observe(el);
  }, []);

  const sub = screen === 'options' ? SUBTITLE.options : (PANEL_SUBTITLE[panelStep] ?? SUBTITLE[screen]);
  const row = (to: SendMode, icon: string, label: string) => (
    <button type="button" className="sheet-row" onClick={() => go(to)}>
      <img src={icon} alt="" width={22} height={22} />
      <span>{label}</span>
      <img className="sheet-row-go" src="/img/chevron-right.svg" alt="" width={15} height={15} />
    </button>
  );

  return (
    <div className="sheet">
      <header className="sheet-head">
        <h2>Send</h2>
        <div className="sheet-steps">
          <button type="button" className="icon-btn" aria-label="Previous step" disabled={pos === 0} onClick={back}>
            <img src="/img/chevron-left-sm.svg" alt="" width={15} height={15} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next step" disabled={pos >= trail.length - 1} onClick={forward}>
            <img src="/img/chevron-right.svg" alt="" width={15} height={15} />
          </button>
        </div>
      </header>
      <MotionConfig reducedMotion="user">
        <motion.div className="sheet-step" initial={false} animate={{ height }} transition={STEP_TRANSITION}>
          <div ref={inner}>
            <p className="sheet-sub">{sub}</p>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={`${screen}-${screen === 'options' ? '' : panelStep === 'quoting' ? 'form' : panelStep}`} {...STEP_FADE} transition={STEP_TRANSITION}>
                {screen === 'options' && (
                  <div className="sheet-list" role="group" aria-label="Where to?">
                    {row('private', '/img/railgun.png', 'Privately via Railgun')}
                    {row('evm', '/img/chain-ethereum.svg', 'To an Ethereum address')}
                    {row('sol', '/img/chain-solana.svg', 'To a Solana address')}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
            {/* The forms stay mounted while you step back and forth, so what you typed is kept. */}
            {(['private', 'evm', 'sol'] as const).map((m) =>
              mounted.includes(m) ? (
                <div key={m} hidden={screen !== m} data-send-mode={m}>
                  <SendPanel mode={m} confirmWithPasskey={confirmWithPasskey} onBack={back} onDone={onClose} onStep={screen === m ? onStep : noop} />
                </div>
              ) : null,
            )}
          </div>
        </motion.div>
      </MotionConfig>
    </div>
  );
}

const noop = () => {};
