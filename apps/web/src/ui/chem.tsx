import { Fragment } from 'react';
import type { ReactNode } from 'react';

const PHASE = /\((g|l|s|aq|cr)\)$/;
const CLOSERS = new Set([')', ']', '}']);

/** Charge as chemists write it: "2−", "+", "3+". */
function chargeText(sign: string, magnitude: number): string {
  return `${magnitude === 1 ? '' : magnitude}${sign === '+' ? '+' : '−'}`;
}

/** Splits a trailing charge off a formula written in plain notation: "SO4^2-", "NH4+", "Ca++", "SO4-2". */
function splitCharge(body: string): [string, string | null] {
  let m = /\^(\d*)([+-])$/.exec(body);
  if (m) return [body.slice(0, m.index), chargeText(m[2]!, m[1] ? Number(m[1]) : 1)];
  m = /([+-])(\d+)$/.exec(body);
  if (m && m.index > 0) return [body.slice(0, m.index), chargeText(m[1]!, Number(m[2]))];
  m = /(\++|-+)$/.exec(body);
  if (m && m.index > 0) return [body.slice(0, m.index), chargeText(m[1]![0]!, m[1]!.length)];
  return [body, null];
}

/**
 * Typesets a formula written in plain text ("H2O", "SO4^2-", "CuSO4.5H2O", "CO2(g)") with true
 * subscripts and a superscript charge. Text that is not a formula passes through unchanged.
 */
export function ChemText({ text }: { text: string }) {
  const phase = PHASE.exec(text)?.[0] ?? '';
  const [body, charge] = splitCharge(phase ? text.slice(0, -phase.length) : text);
  const parts: ReactNode[] = [];
  let run = '';
  const flush = () => {
    if (run) parts.push(<Fragment key={parts.length}>{run}</Fragment>);
    run = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const previous = i > 0 ? body[i - 1]! : '';
    // A number counts atoms when it follows an element symbol or a closing bracket; after a dot it multiplies a hydrate.
    if (/\d/.test(c) && (/[A-Za-z]/.test(previous) || CLOSERS.has(previous))) {
      let digits = c;
      while (i + 1 < body.length && /\d/.test(body[i + 1]!)) digits += body[++i];
      flush();
      parts.push(<sub key={parts.length}>{digits}</sub>);
    } else if (c === '.' || c === '*') {
      run += '·';
    } else {
      run += c;
    }
  }
  flush();
  return (
    <span className="ml-chem">
      {parts}
      {charge && <sup>{charge}</sup>}
      {phase && <span className="ml-chem__phase">{phase}</span>}
    </span>
  );
}

const ARROWS: Readonly<Record<string, string>> = { '->': '→', '=>': '→', '=': '→', '→': '→', '⟶': '→', '⇒': '→', '<=>': '⇌', '<->': '⇌', '⇌': '⇌', '⇄': '⇌', '⇋': '⇌', '↔': '⇌' };

/** Typesets a reaction equation written in plain text, e.g. "CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)". */
export function EquationText({ text }: { text: string }) {
  const tokens = text.trim().split(/\s+/);
  return (
    <span className="ml-equation">
      {tokens.map((token, i) => {
        if (token === '+') return <span key={i} className="ml-equation__op">+</span>;
        if (ARROWS[token]) return <span key={i} className="ml-equation__arrow">{ARROWS[token]}</span>;
        if (/^\d+(\.\d+)?$|^\d+\/\d+$/.test(token)) return <span key={i} className="ml-equation__coef">{token}</span>;
        return <ChemText key={i} text={token} />;
      })}
    </span>
  );
}
