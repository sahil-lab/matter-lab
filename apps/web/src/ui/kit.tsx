import { EVIDENCE_LEVELS, formatCharge } from '@matterlab/core';
import type { BondOrder, Composition, EvidenceLevel } from '@matterlab/core';
import { CircleAlert, Info, Minus, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export type TipPosition = 'top' | 'right' | 'bottom' | 'left' | 'bottom-end' | 'top-end';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tip?: string;
  tipPos?: TipPosition;
  active?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'primary' | 'outline' | 'danger';
  icon?: boolean;
}

export function Button({ tip, tipPos, active, size = 'md', variant = 'ghost', icon, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'ml-btn',
        icon && 'ml-btn--icon',
        size === 'lg' && 'ml-btn--lg',
        size === 'sm' && 'ml-btn--sm',
        variant === 'primary' && 'ml-btn--primary',
        variant === 'outline' && 'ml-btn--outline',
        variant === 'danger' && 'ml-btn--danger',
        className,
      )}
      data-tip={tip}
      data-tip-pos={tipPos}
      aria-label={rest['aria-label'] ?? tip}
      aria-pressed={active}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton(props: Omit<ButtonProps, 'icon'>) {
  return <Button icon {...props} />;
}

export interface SegmentedOption<T> {
  readonly value: T;
  readonly label: ReactNode;
  readonly tip?: string;
  readonly ariaLabel?: string;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  accent,
  fill,
  label,
  tipPos,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  accent?: boolean;
  fill?: boolean;
  label: string;
  tipPos?: TipPosition;
}) {
  return (
    <div className={cx('ml-segmented', accent && 'ml-segmented--accent', fill && 'ml-segmented--fill')} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          // Text options are named by their text; only icon options need an explicit name.
          aria-label={option.ariaLabel ?? (typeof option.label === 'string' ? undefined : option.tip)}
          aria-description={typeof option.label === 'string' ? option.tip : undefined}
          data-tip={option.tip}
          data-tip-pos={tipPos}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A numeric field that commits on Enter or blur and reverts on Escape, so half-typed values never
 * reach the scene. Arrow keys step the value (Shift for coarse, Alt for fine steps).
 */
export function NumberField({
  value,
  onCommit,
  digits = 3,
  step = 0.1,
  min = -Infinity,
  max = Infinity,
  label,
  disabled,
  className,
}: {
  value: number;
  onCommit: (value: number) => void;
  digits?: number;
  step?: number;
  min?: number;
  max?: number;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const format = (v: number) => (Number.isFinite(v) ? v.toFixed(digits) : '');
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, digits, editing]);

  const parsed = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max;

  const commit = () => {
    setEditing(false);
    if (valid && Math.abs(parsed - value) > 0.5 * 10 ** -digits) onCommit(parsed);
    else setText(format(value));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') input.current?.blur();
    else if (e.key === 'Escape') {
      setText(format(value));
      setEditing(false);
      requestAnimationFrame(() => input.current?.blur());
      e.stopPropagation();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = valid ? parsed : value;
      const size = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
      const next = Math.min(max, Math.max(min, base + (e.key === 'ArrowUp' ? size : -size)));
      setText(format(next));
      onCommit(next);
    }
  };

  return (
    <input
      ref={input}
      className={cx('ml-input ml-input--num', editing && !valid && 'is-invalid', className)}
      type="text"
      inputMode="decimal"
      spellCheck={false}
      aria-label={label}
      disabled={disabled}
      value={text}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

/** Whole-number stepper with minus and plus buttons, used for particle counts. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  label,
  muted,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  label: string;
  /** Shows the value de-emphasised, for a number that is implied rather than set. */
  muted?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(text);
    if (text.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max && parsed !== value) onChange(parsed);
    else setText(String(value));
  };

  return (
    <div className="ml-stepper">
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus />
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={text}
        style={muted && !editing ? { color: 'var(--text-3)' } : undefined}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setText(String(value));
            setEditing(false);
            e.currentTarget.blur();
            e.stopPropagation();
          } else if (e.key === 'ArrowUp' && value < max) {
            e.preventDefault();
            onChange(value + 1);
          } else if (e.key === 'ArrowDown' && value > min) {
            e.preventDefault();
            onChange(value - 1);
          }
        }}
      />
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus />
      </button>
    </div>
  );
}

/** States how a value was obtained. Shown next to every scientific number that needs qualifying. */
export function EvidenceBadge({ level, tipPos = 'top-end' }: { level: EvidenceLevel; tipPos?: TipPosition }) {
  const info = EVIDENCE_LEVELS[level];
  return (
    <span className="ml-evidence" data-level={level} data-tip={info.description} data-tip-pos={tipPos} tabIndex={0}>
      {info.label}
    </span>
  );
}

/** A chemical formula in Hill order, typeset with true subscripts and a superscript charge. */
export function Formula({ value, empty = '' }: { value: Composition; empty?: string }) {
  if (value.parts.length === 0) return <>{empty}</>;
  return (
    <span className="ml-chem">
      {value.parts.map((part) => (
        <span key={part.z}>
          {part.symbol}
          {part.count > 1 && <sub>{part.count}</sub>}
        </span>
      ))}
      {value.charge !== 0 && <sup>{formatCharge(value.charge)}</sup>}
    </span>
  );
}

export function BondGlyph({ order }: { order: BondOrder }) {
  const y = order === 1 ? [7] : order === 2 ? [4.5, 9.5] : order === 3 ? [3, 7, 11] : [4.5, 9.5];
  return (
    <svg className="ml-bondglyph" viewBox="0 0 18 14" aria-hidden>
      {y.map((v, i) => (
        <line key={v} x1="2" x2="16" y1={v} y2={v} strokeDasharray={order === 1.5 && i === 1 ? '3 2.6' : undefined} />
      ))}
    </svg>
  );
}

export const BOND_ORDER_NAMES: Readonly<Record<number, string>> = { 1: 'Single', 2: 'Double', 3: 'Triple', 1.5: 'Aromatic' };

export function Section({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="ml-section">
      {(title || right) && (
        <div className="ml-section__head">
          {title ? <span className="ml-label">{title}</span> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Note({ severity, children, onClick }: { severity: 'info' | 'warning' | 'error'; children: ReactNode; onClick?: () => void }) {
  const Icon = severity === 'error' ? CircleAlert : severity === 'warning' ? TriangleAlert : Info;
  const content = (
    <>
      <Icon />
      <div>{children}</div>
    </>
  );
  return onClick ? (
    <button type="button" className="ml-note" data-severity={severity} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="ml-note" data-severity={severity}>
      {content}
    </div>
  );
}

/** Closes a popover when the user clicks elsewhere or presses Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);
  return ref;
}

/** Formats a number with thin thousands separators for display. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
