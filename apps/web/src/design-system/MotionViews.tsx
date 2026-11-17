import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { transitionFor, useReducedMotion } from './motion';

/**
 * Animates its single child in and out of the layout by height, for collapsible panels (apparatus
 * library, inspector, timeline dock). Falls back to an instant show/hide when motion is reduced.
 * Content stays mounted while collapsed so focus and scroll position are not lost on reopen.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(open ? 'auto' : 0);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const node = inner.current;
    if (!node) return;
    if (reduced) {
      setHeight(open ? 'auto' : 0);
      return;
    }
    if (open) {
      const target = node.scrollHeight;
      setAnimating(true);
      setHeight(target);
      const timer = window.setTimeout(() => {
        setHeight('auto');
        setAnimating(false);
      }, 240);
      return () => window.clearTimeout(timer);
    }
    // Closing: start from the measured height so the transition has a real starting point, then
    // collapse to 0 on the next frame.
    const start = node.scrollHeight;
    setHeight(start);
    setAnimating(true);
    const frame = requestAnimationFrame(() => setHeight(0));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced]);

  const style: CSSProperties = {
    height: height === 'auto' ? 'auto' : `${height}px`,
    overflow: animating || height !== 'auto' ? 'hidden' : undefined,
    transition: reduced ? undefined : transitionFor('base', 'height'),
  };

  return (
    <div className={className} style={style} aria-hidden={!open}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** Fades and lifts content in on mount; a no-op wrapper when motion is reduced. */
export function Reveal({ children, delayMs = 0, className }: { children: ReactNode; delayMs?: number; className?: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [reduced, delayMs]);
  return (
    <div
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(10px)',
        transition: reduced ? undefined : transitionFor('slow', 'opacity, transform', 'entrance'),
      }}
    >
      {children}
    </div>
  );
}
