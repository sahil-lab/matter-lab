import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type AstraTipPosition = 'top' | 'right' | 'bottom' | 'left' | 'bottom-end' | 'top-end';

export interface AstraButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tip?: string;
  tipPos?: AstraTipPosition;
  active?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'cool' | 'warm' | 'outline' | 'danger';
  icon?: boolean;
}

/**
 * The base interactive control for the Astra lab UI: ghost by default, with `cool` (instrument
 * blue) as the primary action accent and `warm` (flame amber) reserved for energetic/affirmative
 * emphasis (e.g. "Start transfer"), matching the system's cool/warm lighting contrast.
 */
export function Button({ tip, tipPos, active, size = 'md', variant = 'ghost', icon, className, children, ...rest }: AstraButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'astra-btn',
        icon && 'astra-btn--icon',
        size === 'lg' && 'astra-btn--lg',
        size === 'sm' && 'astra-btn--sm',
        variant === 'cool' && 'astra-btn--cool',
        variant === 'warm' && 'astra-btn--warm',
        variant === 'outline' && 'astra-btn--outline',
        variant === 'danger' && 'astra-btn--danger',
        className,
      )}
      data-astra-tip={tip}
      data-astra-tip-pos={tipPos}
      aria-label={rest['aria-label'] ?? tip}
      aria-pressed={active}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton(props: Omit<AstraButtonProps, 'icon'>) {
  return <Button icon {...props} />;
}

/** Visual-only keyboard shortcut chip, e.g. inside a tooltip or the shortcuts list. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="astra-kbd">{children}</kbd>;
}
