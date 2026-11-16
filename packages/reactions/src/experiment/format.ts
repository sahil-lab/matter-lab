/**
 * How the experiment pipeline writes numbers in sentences. The aim is to show no more digits than the data
 * behind a number support; each helper states its rule, and `ROUNDING_RULES` states them for the reader.
 */

export const MINUS = '\u2212';

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '0': '\u2070',
  '1': '\u00b9',
  '2': '\u00b2',
  '3': '\u00b3',
  '4': '\u2074',
  '5': '\u2075',
  '6': '\u2076',
  '7': '\u2077',
  '8': '\u2078',
  '9': '\u2079',
  '-': '\u207b',
};

/** Digits and the minus sign as superscripts, for powers of ten and unit exponents. */
export const superscript = (text: string): string => Array.from(text, (ch) => SUPERSCRIPTS[ch] ?? ch).join('');

/** A number with a fixed count of decimals, a true minus sign, and no "−0". */
export function formatFixed(value: number, decimals: number): string {
  const text = value.toFixed(Math.max(0, Math.min(20, decimals)));
  if (/^-0(\.0*)?$/.test(text)) return text.slice(1);
  return text.startsWith('-') ? `${MINUS}${text.slice(1)}` : text;
}

/**
 * A number to a given count of significant figures. Ordinary notation is used when every digit it shows is
 * significant (0.0018, 47, 5.2), and a power of ten otherwise ("1.7 × 10⁻¹⁴", "2.0 × 10³"), so that the
 * text never suggests more figures than were asked for.
 */
export function formatSignificant(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const [mantissa, exponentText] = value.toExponential(Math.max(0, digits - 1)).split('e') as [string, string];
  const exponent = Number(exponentText);
  if (exponent >= -3 && exponent < Math.max(1, digits)) return formatFixed(Number(`${mantissa}e${exponent}`), Math.max(0, digits - 1 - exponent));
  const sign = mantissa.startsWith('-') ? MINUS : '';
  return `${sign}${mantissa.replace('-', '')} \u00d7 10${superscript(String(exponent))}`;
}

/** Number of decimals that show an uncertainty to two significant figures (never negative). */
export function decimalsForUncertainty(uncertainty: number): number {
  return Math.max(0, 1 - Math.floor(Math.log10(uncertainty)));
}

/**
 * "value ± uncertainty", both rounded to the decimal place of the second significant figure of the
 * uncertainty. Without an uncertainty (or with an uncertainty of exactly zero) the value alone is written,
 * with `fallbackDecimals` decimals.
 */
export function formatWithUncertainty(value: number, uncertainty: number | undefined, fallbackDecimals: number): string {
  if (uncertainty === undefined || !(uncertainty > 0) || !Number.isFinite(uncertainty)) return formatFixed(value, fallbackDecimals);
  const decimals = decimalsForUncertainty(uncertainty);
  return `${formatFixed(value, decimals)} \u00b1 ${formatFixed(uncertainty, decimals)}`;
}

/**
 * Number of decimals a source printed for a value: 3 for "-285.830 ± 0.040", 0 for "-276. ± 2.", and
 * `undefined` for a bare "0", which marks a value that is exact by definition.
 */
export function decimalsPrinted(asPrinted: string): number | undefined {
  const match = /^-?\d+(?:\.(\d*))?/.exec(asPrinted.trim());
  if (!match) return undefined;
  if (match[1] === undefined) return /^-?0$/.test(asPrinted.trim()) ? undefined : 0;
  return match[1].length;
}

/** Units as they are stored ("cm3 molecule-1 s-1") with real superscripts ("cm³ molecule⁻¹ s⁻¹"). */
export function prettyUnit(unit: string): string {
  return unit.replace(/([A-Za-z])(-?\d+)/g, (_whole, letter: string, power: string) => `${letter}${superscript(power)}`);
}

/**
 * An equilibrium constant from its natural logarithm, with as many digits as the uncertainty of the
 * logarithm supports: three significant figures when log10 K is known to better than 0.005, two below 0.05,
 * one below 0.5, and otherwise only the power of ten ("10⁻³").
 */
export function formatEquilibriumConstant(lnK: number, log10Uncertainty: number): string {
  const log10K = lnK / Math.LN10;
  const digits = log10Uncertainty < 0.005 ? 3 : log10Uncertainty < 0.05 ? 2 : log10Uncertainty < 0.5 ? 1 : 0;
  if (digits === 0) return `10${superscript(String(Math.round(log10K)))}`;
  let exponent = Math.floor(log10K);
  let mantissa = Number((10 ** (log10K - exponent)).toPrecision(digits));
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  if (exponent >= -3 && exponent < digits) return formatFixed(mantissa * 10 ** exponent, Math.max(0, digits - 1 - exponent));
  return `${mantissa.toFixed(digits - 1)} \u00d7 10${superscript(String(exponent))}`;
}

/** The rounding rules above in words, for the "confidence and uncertainty" part of an explanation. */
export const ROUNDING_RULES = {
  withUncertainty: 'A value that has an uncertainty is rounded, together with that uncertainty, to the decimal place of the second significant figure of the uncertainty.',
  withoutUncertainty: 'A thermodynamic value without an uncertainty is rounded to the last decimal place printed by the least precise table value that went into it.',
  equilibriumConstant:
    'The equilibrium constant depends exponentially on the Gibbs energy, so it is given with only as many digits as the uncertainty of the Gibbs energy supports, down to a bare power of ten.',
  estimate:
    'Outside the temperature range in which the constant-enthalpy estimate is trusted, the Gibbs energy is given to the nearest kJ/mol and the equilibrium constant as a bare power of ten, both without an uncertainty: ' +
    'the error of the estimate is unknown and is not covered by the uncertainties of the table values.',
  kinetics: 'Rate constants, half-lives and concentrations are given to two significant figures, the precision with which the source prints its rate parameters.',
} as const;
