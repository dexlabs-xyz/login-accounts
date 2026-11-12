/**
 * Pop-up over a blurred page (Figma: Receive / Send). Built on <dialog>, so the
 * browser handles focus, Esc to close and keeping the page behind inert.
 */
import { useEffect, useRef } from 'react';

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Wider panel for the older forms shown here until their pop-ups are redesigned. */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      aria-labelledby="modal-title"
      onClose={onClose}
      onCancel={(e) => (e.preventDefault(), onClose())}
      // A click on the blurred backdrop (the dialog box itself, outside the panel) closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <div className="modal-panel">
          <div className="modal-head">
            <h2 id="modal-title">{title}</h2>
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
