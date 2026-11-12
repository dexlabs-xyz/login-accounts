/**
 * Pop-up over a blurred page (Figma: Receive / Send).
 *
 * Not a native modal <dialog>: the browser puts those in a "top layer" above everything, toasts
 * included, and pop-up toasts must show over the blur (Gold, 12 Nov). So it's a layer of its own,
 * below the toasts, and it does what a modal dialog does itself: the page behind becomes inert,
 * focus moves in and comes back on close, Esc and a click on the backdrop close it.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
  bare = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Wider panel for the older forms shown here until their pop-ups are redesigned. */
  wide?: boolean;
  /** The content draws its own header (Figma pop-ups: title with < > step chevrons). */
  bare?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const page = document.querySelector('.app');
    const before = document.activeElement as HTMLElement | null;
    page?.setAttribute('inert', '');
    const first = panel.current?.querySelector<HTMLElement>('button:not([disabled]), input, select, [href], [tabindex]:not([tabindex="-1"])');
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      page?.removeAttribute('inert');
      before?.focus?.();
    };
  }, [open]);

  return createPortal(
    // Kept mounted while closed, so a deposit address or a half-filled form is still there when you reopen it.
    // Closed = invisible, not removed from layout: content inside can still be measured (the step animation needs
    // real heights), while staying out of reach for clicks, the keyboard and screen readers.
    <div className={`modal-layer${open ? ' is-open' : ' is-closed'}`} aria-hidden={!open}>
      <div className="modal-backdrop" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`modal${wide ? ' modal-wide' : ''}`}
      >
        <div className="modal-panel">
          {!bare && (
            <div className="modal-head">
              <h2>{title}</h2>
              <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
                ×
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
