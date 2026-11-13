/**
 * "Copy address" (Figma: Home). Instead of a toast, the button itself confirms (Gold, 12 Nov):
 * the copy icon turns into a check (opacity 0→1, scale 0.25→1, blur 4px→0), "Copy address" becomes
 * "Copied!" (opacity only), and the box collapses from the right to fit, keeping its inner padding and
 * left edge, and shrinks to 95%. Every change is a spring (Motion). It returns to normal after a moment.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate } from 'motion';
import { reducedMotion } from '../ui/motion.ts';

const PAD = 20; // inner padding each side (Figma: 111 of content in a 151 box)
const GAP = 5;
const ICON = 18;
const BACK_AFTER_MS = 1800;

const ICON_HIDDEN = { opacity: 0, scale: 0.25, filter: 'blur(4px)' };
const ICON_SHOWN = { opacity: 1, scale: 1, filter: 'blur(0px)' };
/** Starting styles only, never changed by React after mount: Motion owns them from then on. */
const RESTING_SHOWN = { opacity: 1 };
const RESTING_HIDDEN = { opacity: 0 };
/** One spring for every part of the change (Gold: "use spring for all transitions"). */
const SPRING = { type: 'spring' as const, stiffness: 420, damping: 32 };

export function CopyAddressButton({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const icons = [useRef<HTMLImageElement>(null), useRef<HTMLImageElement>(null)] as const; // copy, check
  const texts = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)] as const; // "Copy address", "Copied!"
  const shown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The box's width for each state, from the text actually rendered (fonts differ slightly from Figma).
  const widthFor = (isCopied: boolean) => PAD + ICON + GAP + (texts[isCopied ? 1 : 0].current?.offsetWidth ?? 0) + PAD;

  // Phones lay the buttons out in a grid: there the box keeps the grid's width and only the content changes.
  const fixedWidth = () => !window.matchMedia('(max-width: 820px)').matches;

  useLayoutEffect(() => {
    const set = () => {
      if (!btn.current) return;
      btn.current.style.width = fixedWidth() ? `${widthFor(shown.current)}px` : '';
    };
    set();
    void document.fonts.ready.then(set); // the text's width is only final once Geist has loaded
    addEventListener('resize', set);
    return () => removeEventListener('resize', set);
  }, []);

  useEffect(() => {
    if (shown.current === copied) return;
    shown.current = copied;
    const b = btn.current;
    if (!b) return;
    const t = reducedMotion() ? { duration: 0 } : SPRING;
    const [iconOut, iconNew] = copied ? [icons[0], icons[1]] : [icons[1], icons[0]];
    const [textOut, textNew] = copied ? [texts[0], texts[1]] : [texts[1], texts[0]];
    if (iconNew.current) animate(iconNew.current, ICON_SHOWN, t);
    if (iconOut.current) animate(iconOut.current, ICON_HIDDEN, t);
    if (textNew.current) animate(textNew.current, { opacity: 1, filter: 'blur(0px)' }, t);
    if (textOut.current) animate(textOut.current, { opacity: 0, filter: 'blur(0px)' }, t);
    const scale = copied ? 0.95 : 1;
    if (!fixedWidth()) {
      animate(b, { scale }, t);
      return;
    }
    animate(b, { width: `${widthFor(copied)}px`, scale }, t);
  }, [copied]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = () => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), BACK_AFTER_MS);
    });
  };

  return (
    <button type="button" ref={btn} className="hero-btn copy-btn" onClick={onClick} disabled={!address} aria-label="Copy address">
      <span className="copy-icons" aria-hidden="true">
        <img ref={icons[0]} src="/img/copy-sm.svg" alt="" width={ICON} height={ICON} style={RESTING_SHOWN} />
        <img ref={icons[1]} src="/img/check.svg" alt="" width={ICON} height={ICON} style={RESTING_HIDDEN} />
      </span>
      <span className="copy-texts" aria-hidden="true">
        <span ref={texts[0]} className={copied ? 'is-out' : undefined} style={RESTING_SHOWN}>
          Copy address
        </span>
        <span ref={texts[1]} className={copied ? undefined : 'is-out'} style={RESTING_HIDDEN}>
          Copied!
        </span>
      </span>
      <span className="visually-hidden" role="status">
        {copied ? 'Address copied' : ''}
      </span>
    </button>
  );
}
