/**
 * Balance History (Figma: Home). Drawn from the history list on this device: each entry moves the
 * line by its dollar amount. Nothing new is stored or sent.
 *
 * Interactive like a real chart (Gold, 12 Nov): a guide line and a dot follow the pointer along the
 * curve, with a tooltip above the dot (the balance and date there, or "No balance yet" before any
 * activity). Arrow keys move between points when the chart has focus.
 *
 * Each time Home opens (a reload, or coming back from another page), the line draws itself from left
 * to right along its path, with the fill revealed alongside it (Gold, 12 Nov: cubic-bezier(.215,.61,.355,1)).
 */

const DRAW_EASE = [0.215, 0.61, 0.355, 1] as const;
const DRAW_SECONDS = 1.2;
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'motion';
import { reducedMotion } from '../ui/motion.ts';
import { useHistory, usdDelta } from '../History.tsx';
import { usd } from '../money.ts';

const W = 1011;
const H = 159.67;
const TOP = 2; // keep the highest point fully inside

/** No history yet: the peaks and dips of Figma's placeholder curve (sampled from the vector), drawn smooth again. */
const PLACEHOLDER: [number, number][] = [
  [0, 97.3], [38, 80.6], [82, 98], [167, 61.6], [283, 98.6], [422, 21.7],
  [529, 38.9], [732, 0.5], [824, 39.5], [986, 2.4], [1011, 2.7],
];

/** A smooth curve through the points that never overshoots them (monotone cubic, Fritsch–Carlson). */
function smooth(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 2) return '';
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i]![0]);
  const slope = pts.slice(1).map((p, i) => (p[1] - pts[i]![1]) / (dx[i] || 1));
  const m: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2);
  m.push(slope[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / slope[i]!;
    const b = m[i + 1]! / slope[i]!;
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * slope[i]!) / h;
      m[i + 1] = (3 * b * slope[i]!) / h;
    }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const t = dx[i]! / 3;
    d += ` C${x0 + t},${y0 + m[i]! * t} ${x1 - t},${y1 - m[i + 1]! * t} ${x1},${y1}`;
  }
  return d;
}

const shortDate = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Just now';

export function BalanceChart() {
  const { entries } = useHistory();
  // Oldest first, starting from zero; each level is the balance after one entry.
  const { pts, labels, hasData, last } = useMemo(() => {
    const list = (entries ?? []).slice().reverse();
    const levels: bigint[] = [0n];
    const when: (number | null)[] = [list[0]?.timestamp ?? null];
    for (const e of list) {
      const d = usdDelta(e);
      if (d === null) continue;
      levels.push(levels[levels.length - 1]! + d);
      when.push(e.timestamp);
    }
    const max = levels.reduce((m, v) => (v > m ? v : m), 0n);
    const has = levels.length > 1 && max > 0n;
    return {
      hasData: has,
      last: levels[levels.length - 1]!,
      pts: has
        ? levels.map((v, i): [number, number] => [(i / (levels.length - 1)) * W, H - (Number(v) / Number(max)) * (H - TOP)])
        : PLACEHOLDER,
      labels: has ? levels.map((v, i) => `${usd(v, 6)} · ${shortDate(when[i] ?? null)}`) : null,
    };
  }, [entries]);
  const line = smooth(pts);
  const area = `${line} L${W},${H + 2} L0,${H + 2} Z`;

  const svg = useRef<SVGSVGElement>(null);
  const curve = useRef<SVGPathElement>(null);
  const reveal = useRef<SVGRectElement>(null);
  // Draw in once per visit to Home (the page remounts on every visit, so reloads and tab switches both replay it).
  useLayoutEffect(() => {
    const r = reveal.current;
    if (!r) return;
    if (reducedMotion()) return void r.setAttribute('width', String(W));
    const a = animate(r, { width: [0, W] }, { duration: DRAW_SECONDS, ease: DRAW_EASE });
    return () => a.stop();
  }, []);
  /** Where the pointer is on the curve, in the chart's own pixels; null when it's not over the chart. */
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  /** The curve's height at a given x (design units): binary search along the path, which only moves left to right. */
  const yAt = (x: number) => {
    const p = curve.current;
    if (!p) return 0;
    let lo = 0;
    let hi = p.getTotalLength();
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (p.getPointAtLength(mid).x < x) lo = mid;
      else hi = mid;
    }
    return p.getPointAtLength((lo + hi) / 2).y;
  };

  const showAt = (fraction: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const f = Math.min(1, Math.max(0, fraction));
    const nearest = labels ? Math.round(f * (labels.length - 1)) : 0;
    setAt({
      x: f * box.width,
      y: (yAt(f * W) / H) * box.height,
      text: labels ? labels[nearest]! : 'No balance yet',
    });
  };

  /** Keep the tooltip inside the card: centred on the dot, but pinned to the edge near either side. */
  const tipShift = (x: number) => {
    const width = svg.current?.getBoundingClientRect().width ?? 0;
    if (x < 90) return `${-Math.min(x, 12)}px`;
    if (x > width - 90) return `calc(-100% + ${Math.min(width - x, 12)}px)`;
    return '-50%';
  };

  const onPointer = (e: React.PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (box) showAt((e.clientX - box.left) / box.width);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = labels?.length ?? PLACEHOLDER.length;
    const step = 1 / Math.max(1, n - 1);
    const now = at && svg.current ? at.x / svg.current.getBoundingClientRect().width : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      showAt(Math.round((now + (e.key === 'ArrowRight' ? step : -step)) / step) * step);
    } else if (e.key === 'Escape') setAt(null);
  };

  return (
    <section className="panel chart" aria-labelledby="chart-h">
      <div className="panel-head">
        <h2 id="chart-h">Balance History</h2>
      </div>
      <div
        className="chart-area"
        tabIndex={0}
        role="img"
        aria-label={hasData ? `Your private balance over time, from $0.00 to ${usd(last, 6)}. Use the arrow keys to read each point.` : 'No balance yet.'}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setAt(null)}
        onFocus={() => showAt(1)}
        onBlur={() => setAt(null)}
        onKeyDown={onKey}
      >
        <svg ref={svg} className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            {/* Figma's fill: 20% blue at the top of the line, fading evenly to nothing at the bottom of the card. */}
            {/* The line and fill are shown through this rectangle, which grows from the left as the line draws in. */}
            <clipPath id="chart-reveal">
              <rect ref={reveal} x="-2" y="-4" width="0" height={H + 8} />
            </clipPath>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2563eb" stopOpacity="0.2" />
              <stop offset="1" stopColor="#2563eb" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g clipPath="url(#chart-reveal)">
            <path d={area} fill="url(#chart-fill)" />
            <path ref={curve} d={line} fill="none" stroke="#2563eb" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
        {at && (
          <div className="chart-hover" style={{ transform: `translateX(${at.x}px)` }} aria-hidden="true">
            <span className="chart-guide" />
            <span className="chart-dot" style={{ top: at.y }} />
            <span className="chart-tip" style={{ top: at.y, ['--tip-x' as string]: tipShift(at.x) }}>
              {at.text}
            </span>
          </div>
        )}
      </div>
      {/* What the tooltip says, for screen readers moving with the arrow keys. */}
      <p className="visually-hidden" role="status">
        {at?.text ?? ''}
      </p>
    </section>
  );
}
