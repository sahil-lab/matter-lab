import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { IconButton } from './Button';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: traps focus while open, restores it to the invoking element on close, and
 * closes on Escape or a backdrop click. Used for onboarding, save/duplicate and confirmation flows.
 */
export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number | string }) {
  const frame = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = frame.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? frame.current)?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !frame.current) return;
    const focusable = Array.from(frame.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="astra-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={frame} className="astra-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ width }} onKeyDown={onKeyDown}>
        <div className="astra-modal__head">
          <div className="astra-modal__title">{title}</div>
          <IconButton tip="Close (Esc)" tipPos="bottom-end" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="astra-modal__body astra-scroll">{children}</div>
      </div>
    </div>
  );
}
