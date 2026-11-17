import type { ReactNode } from 'react';
import type { AstraTipPosition } from './Button';
import { cx } from './cx';

export interface AstraSegmentedOption<T> {
  readonly value: T;
  readonly label: ReactNode;
  readonly tip?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

/** A row of mutually-exclusive options: lab-mode switcher, quality preset, evidence filter, etc. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  accent,
  fill,
  tipPos,
}: {
  value: T;
  options: ReadonlyArray<AstraSegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
  accent?: boolean;
  fill?: boolean;
  tipPos?: AstraTipPosition;
}) {
  return (
    <div className={cx('astra-segmented', accent && 'astra-segmented--accent', fill && 'astra-segmented--fill')} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          aria-label={option.ariaLabel ?? (typeof option.label === 'string' ? undefined : option.tip)}
          aria-description={typeof option.label === 'string' ? option.tip : undefined}
          disabled={option.disabled}
          data-astra-tip={option.tip}
          data-astra-tip-pos={tipPos}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
