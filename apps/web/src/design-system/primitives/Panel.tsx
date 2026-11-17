import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** `raised` sits visually above `base` (e.g. a popover above its anchoring panel). */
  elevation?: 'base' | 'raised' | 'cinematic';
  /** Renders the frosted-glass treatment; set `false` for a flat, opaque surface (e.g. inside a dialog body). */
  glass?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

/** The lab UI's one surface primitive: every panel, card, dock and popover is a `Panel`. */
export function Panel({ elevation = 'base', glass = true, padding = 'md', className, children, ...rest }: PanelProps) {
  return (
    <div
      className={cx(
        'astra-panel',
        glass && 'astra-panel--glass',
        elevation === 'raised' && 'astra-panel--raised',
        elevation === 'cinematic' && 'astra-panel--cinematic',
        padding === 'none' && 'astra-panel--pad-none',
        padding === 'sm' && 'astra-panel--pad-sm',
        padding === 'lg' && 'astra-panel--pad-lg',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A small uppercase eyebrow label, used above section headings and HUD groups. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="astra-eyebrow">{children}</div>;
}

export function PanelHeader({ title, eyebrow, right }: { title: ReactNode; eyebrow?: ReactNode; right?: ReactNode }) {
  return (
    <div className="astra-panel__head">
      <div style={{ minWidth: 0 }}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <div className="astra-panel__title">{title}</div>
      </div>
      {right && <div className="astra-panel__head-right">{right}</div>}
    </div>
  );
}
