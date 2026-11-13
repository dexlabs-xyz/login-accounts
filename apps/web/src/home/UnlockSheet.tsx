/**
 * "Your wallet is locked" (Figma 562:9856 loading, 562:9903 unlocked successfully; Gold, 13 Nov).
 * Opens over whichever page you're on when the wallet locks, so the app keeps its layout. Three phases, after Apple's
 * Face ID unlock (Gold's .lottie): the blue spinner turns while it waits; once the passkey opens the wallet, five ring
 * outlines tumble as if turning in 3D and settle into one circle; then the ring redraws along its path and the check
 * draws stroke by stroke, short leg first. Errors (e.g. the passkey prompt closed) are toasts; Unlock works again.
 */
import { AnimatePresence, motion } from 'motion/react';

export type UnlockStage = 'locked' | 'busy' | 'done';

/** Lucide's loader spokes, with each spoke's opacity from Figma (top 60%, top-right 70%, right 80%, bottom-right 90%). */
const SPOKES: [string, number][] = [
  ['M12 2v4', 0.6],
  ['m16.2 7.8 2.9-2.9', 0.7],
  ['M18 12h4', 0.8],
  ['m16.2 16.2 2.9 2.9', 0.9],
  ['M12 18v4', 1],
  ['m4.9 19.1 2.9-2.9', 1],
  ['M2 12h4', 1],
  ['m4.9 4.9 2.9 2.9', 1],
];
/** Lucide's circle-check-big: the ring (from its right side, round to the gap at the top right), then the check. */
const RING = 'M21.801 10A10 10 0 1 1 17 3.335';
const CHECK = 'm9 11 3 3L22 4';
const EASE = [0.25, 1, 0.5, 1] as const; // ease-out: quick start, soft landing

const TUMBLE_TIMES = [0.0, 0.133, 0.267, 0.4, 0.533, 0.733, 0.867, 1.0];
/** Five ring outlines from Gold's Face ID .lottie (frames 27–72 at 60fps), scaled to Lucide's 24 box. */
const TUMBLE = [
  { cx: [11.42, 11.42, 12.15, 12.15, 12.15, 9.98, 11.44, 11.44], cy: [12.48, 12.48, 11.8, 11.8, 11.8, 12.13, 12.35, 12.35], rx: [11.08, 11.08, 11.08, 10.24, 10.24, 10.24, 10.24, 10.24], ry: [4.92, 4.92, 10.74, 8.43, 6.35, 9.81, 10.05, 10.05], rotate: [193.9, 210.1, 238.9, 254.9, 254.9, 254.9, 254.9, 254.9], opacity: [1.0, 1.0, 1.0, 1.0, 0.26, 0.1, 0.03, 0.03], strokeWidth: [0.67, 0.89, 0.89, 0.89, 2.0, 2.0, 2.0, 2.0] },
  { cx: [11.42, 11.96, 12.18, 12.18, 12.18, 11.47, 11.94, 11.94], cy: [12.48, 13.29, 12.26, 12.26, 12.26, 12.08, 11.99, 11.99], rx: [11.08, 11.08, 10.8, 10.8, 10.8, 10.49, 10.49, 10.49], ry: [4.92, 4.92, 6.13, 6.8, 7.38, 8.86, 10.16, 10.16], rotate: [-6.6, 60.5, 100.4, 100.4, 79.2, 79.2, 79.2, 79.2], opacity: [0.26, 0.22, 1.0, 1.0, 1.0, 0.78, 0.78, 0.0], strokeWidth: [0.67, 3.11, 0.89, 0.89, 1.56, 1.56, 0.22, 0.22] },
  { cx: [12.0, 11.96, 12.05, 12.04, 12.05, 10.79, 12.04, 12.04], cy: [12.0, 13.29, 11.82, 11.83, 11.83, 12.06, 11.83, 11.83], rx: [11.08, 11.08, 10.31, 10.31, 10.31, 10.31, 10.31, 10.31], ry: [4.92, 4.92, 4.27, 4.6, 2.82, 8.9, 10.09, 10.09], rotate: [0, 60.5, 103.7, 98.2, 79.3, 79.3, 79.3, 79.3], opacity: [0.58, 0.22, 1.0, 1.0, 1.0, 1.0, 1.0, 0.05], strokeWidth: [2.0, 3.11, 0.89, 0.44, 0.44, 0.44, 1.11, 1.11] },
  { cx: [12.0, 12.0, 12.01, 12.01, 12.01, 11.47, 12.0, 12.0], cy: [12.0, 13.23, 11.92, 11.92, 11.92, 12.26, 12.0, 12.0], rx: [11.08, 10.0, 10.0, 10.0, 10.0, 10.11, 10.0, 10.0], ry: [6.62, 4.15, 3.35, 2.62, 0.49, 10.23, 10.0, 10.0], rotate: [0, 0, -11.7, -86.8, -101.8, -83.9, 0, 0], opacity: [0.13, 0.42, 0.87, 0.38, 0.46, 0.23, 0.87, 0.87], strokeWidth: [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0] },
  { cx: [11.18, 11.02, 11.1, 11.53, 11.53, 9.88, 10.92, 10.92], cy: [12.62, 13.45, 11.56, 11.08, 11.07, 11.9, 12.0, 12.0], rx: [9.47, 5.71, 2.0, 8.24, 10.0, 10.0, 10.0, 10.0], ry: [8.65, 10.0, 10.0, 10.0, 10.0, 7.69, 10.0, 10.0], rotate: [-7.8, -7.8, 26, 63.4, 63.4, 96.0, 0, 0], opacity: [0.07, 0.42, 0.87, 0.87, 0.87, 0.21, 0.0, 0.0], strokeWidth: [2.0, 2.0, 2.0, 2.0, 2.0, 3.56, 2.0, 2.0] },
];
/** Phase timings (seconds from a successful unlock): spinner out, tumble, ring redraw, check. ~1.6s in all. */
const TUMBLE_AT = 0.1;
const TUMBLE_FOR = 0.75;
const RING_AT = TUMBLE_AT + TUMBLE_FOR - 0.05;
const RING_FOR = 0.45;
const CHECK_AT = RING_AT + RING_FOR;
const CHECK_FOR = 0.3;
/** How long the whole success animation takes, so the pop-up can close after it. */
export const UNLOCK_DONE_MS = Math.round((CHECK_AT + CHECK_FOR) * 1000) + 450;

export function UnlockSheet({ stage, onUnlock }: { stage: UnlockStage; onUnlock: () => void }) {
  const done = stage === 'done';
  return (
    <div className="unlock">
      <h2 className="unlock-title">Your wallet is locked</h2>
      <div className="unlock-stage" role="img" aria-label={done ? 'Unlocked' : 'Waiting to unlock'}>
        <svg width={180} height={180} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <AnimatePresence initial={false}>
            {!done && (
              <motion.g key="spinner" exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.18, ease: EASE }}>
                <g className="unlock-spinner">
                  {SPOKES.map(([d, o]) => (
                    <path key={d} d={d} opacity={o} />
                  ))}
                </g>
              </motion.g>
            )}
          </AnimatePresence>
          {done && (
            <>
              {/* The tumble: each ring squashes, stretches and spins on its own, then they settle into one circle,
                  which fades as the ring redraws over it. */}
              {TUMBLE.map((k, i) => (
                <motion.ellipse
                  key={i}
                  initial={{ cx: k.cx[0], cy: k.cy[0], rx: k.rx[0], ry: k.ry[0], rotate: k.rotate[0], opacity: 0, strokeWidth: k.strokeWidth[0] }}
                  animate={{ cx: k.cx, cy: k.cy, rx: k.rx, ry: k.ry, rotate: k.rotate, opacity: [...k.opacity.slice(0, -1), 0], strokeWidth: k.strokeWidth }}
                  transition={{ duration: TUMBLE_FOR + RING_FOR * 0.6, times: [...TUMBLE_TIMES.slice(0, -1).map((t) => (t * TUMBLE_FOR) / (TUMBLE_FOR + RING_FOR * 0.6)), 1], ease: 'easeInOut', delay: TUMBLE_AT }}
                />
              ))}
              <motion.path d={RING} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: RING_FOR, ease: EASE, delay: RING_AT }, opacity: { duration: 0.01, delay: RING_AT } }} />
              <motion.path d={CHECK} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: CHECK_FOR, ease: EASE, delay: CHECK_AT }, opacity: { duration: 0.01, delay: CHECK_AT } }} />
            </>
          )}
        </svg>
      </div>
      <button type="button" className="unlock-btn" disabled={stage !== 'locked'} aria-busy={stage === 'busy'} onClick={onUnlock}>
        Unlock
      </button>
      <span className="visually-hidden" role="status">
        {stage === 'busy' ? 'Waiting for your passkey…' : done ? 'Your wallet is open.' : ''}
      </span>
    </div>
  );
}
