import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../ui/kit';

/** Text of a number for editing: plain digits in the everyday range, exponent notation outside it. */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e6) return String(Number(value.toPrecision(8)));
  return value
    .toExponential(6)
    .replace(/\.?0+e/, 'e')
    .replace('e+', 'e');
}

/**
 * A field for a physical quantity. It accepts plain and exponent notation ("3e12", "2.5E-3"),
 * commits on Enter or when focus leaves, and reverts on Escape, so a half-typed number is never used.
 */
export function ValueField({
  value,
  onCommit,
  label,
  min = -Infinity,
  max = Infinity,
  exclusiveMin = false,
  allowEmpty = false,
  placeholder,
  disabled,
  testId,
}: {
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  label: string;
  min?: number;
  max?: number;
  /** When set, `min` itself is not allowed (a temperature must be above zero). */
  exclusiveMin?: boolean;
  /** Lets the field be cleared, which commits `undefined`. */
  allowEmpty?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const shown = value === undefined ? '' : numberText(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);

  const trimmed = text.trim();
  const parsed = Number(trimmed.replace(',', '.').replace(/×10\^?/, 'e'));
  const empty = trimmed === '';
  const valid = empty ? allowEmpty : Number.isFinite(parsed) && (exclusiveMin ? parsed > min : parsed >= min) && parsed <= max;

  const commit = () => {
    setEditing(false);
    if (!valid) setText(shown);
    else if (empty) {
      if (value !== undefined) onCommit(undefined);
    } else if (parsed !== value) onCommit(parsed);
    else setText(shown);
  };

  return (
    <input
      ref={input}
      className={cx('ml-input ml-input--num', editing && !valid && 'is-invalid')}
      type="text"
      inputMode="decimal"
      spellCheck={false}
      autoComplete="off"
      aria-label={label}
      aria-invalid={editing && !valid}
      placeholder={placeholder}
      disabled={disabled}
      value={text}
      data-testid={testId}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') input.current?.blur();
        else if (e.key === 'Escape') {
          setText(shown);
          setEditing(false);
          requestAnimationFrame(() => input.current?.blur());
          e.stopPropagation();
        }
      }}
    />
  );
}

/** A text field with the same commit-on-blur behaviour, for names and formulas. */
export function TextField({
  value,
  onCommit,
  label,
  placeholder,
  mono,
  invalid,
  testId,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  return (
    <input
      ref={input}
      className={cx('ml-input', mono && 'ml-mono', invalid && !editing && 'is-invalid')}
      type="text"
      spellCheck={false}
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid}
      placeholder={placeholder}
      value={text}
      data-testid={testId}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (text.trim() !== value) onCommit(text.trim());
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') input.current?.blur();
        else if (e.key === 'Escape') {
          setText(value);
          setEditing(false);
          requestAnimationFrame(() => input.current?.blur());
          e.stopPropagation();
        }
      }}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  testId,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <select className={cx('ml-select', className)} aria-label={label} value={value} data-testid={testId} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A labelled control in a form grid. */
export function Labelled({ label, unit, children }: { label: string; unit?: ReactNode; children: ReactNode }) {
  return (
    <label className="ml-labelled">
      <span>
        {label}
        {unit && <em>{unit}</em>}
      </span>
      {children}
    </label>
  );
}
