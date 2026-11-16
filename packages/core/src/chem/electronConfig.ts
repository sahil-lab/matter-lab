import { elementBySymbol, getElement } from '../elements';
import type { EvidenceLevel } from '../provenance';

export interface Subshell {
  /** Principal quantum number. */
  readonly n: number;
  /** Orbital angular momentum quantum number: 0 = s, 1 = p, 2 = d, 3 = f. */
  readonly l: number;
  readonly electrons: number;
}

const L_LETTERS = 'spdfgh';

export function subshellCapacity(l: number): number {
  return 2 * (2 * l + 1);
}

export function subshellLabel(s: Pick<Subshell, 'n' | 'l'>): string {
  return `${s.n}${L_LETTERS[s.l]}`;
}

/** Hund's rule: electrons occupy separate orbitals of a subshell before pairing. */
export function unpairedInSubshell(s: Subshell): number {
  const orbitals = 2 * s.l + 1;
  return s.electrons <= orbitals ? s.electrons : 2 * orbitals - s.electrons;
}

const byShell = (a: Subshell, b: Subshell) => a.n - b.n || a.l - b.l;

function parseTokens(text: string): { core: string | null; valence: Subshell[] } {
  const coreMatch = /\[([A-Z][a-z]?)\]/.exec(text);
  const valence: Subshell[] = [];
  const pattern = /(\d)([spdfgh])(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    valence.push({ n: Number(m[1]), l: L_LETTERS.indexOf(m[2]!), electrons: Number(m[3]) });
  }
  return { core: coreMatch ? coreMatch[1]! : null, valence };
}

interface Split {
  readonly core: Subshell[];
  readonly valence: Subshell[];
}

const neutralCache = new Map<number, Split>();

/** Ground-state configuration of the neutral atom, split into its noble-gas core and the shells outside it. */
function neutralSplit(z: number): Split {
  const cached = neutralCache.get(z);
  if (cached) return cached;
  const { core, valence } = parseTokens(getElement(z).electronConfiguration);
  let coreShells: Subshell[] = [];
  if (core) {
    const coreElement = elementBySymbol(core);
    if (!coreElement) throw new Error(`Unknown noble-gas core "${core}" in the configuration of element ${z}.`);
    const inner = neutralSplit(coreElement.z);
    coreShells = [...inner.core, ...inner.valence].sort(byShell);
  }
  const split = { core: coreShells, valence };
  neutralCache.set(z, split);
  return split;
}

/** Ground-state subshell occupancies of the neutral atom, ordered by n then l. */
export function neutralSubshells(z: number): Subshell[] {
  const { core, valence } = neutralSplit(z);
  return [...core, ...valence].sort(byShell);
}

const NOBLE_GASES = [118, 86, 54, 36, 18, 10, 2];

/** Formats occupancies like "[Ar] 3d6", using the largest noble-gas core the configuration fully contains. */
export function formatSubshells(subshells: readonly Subshell[], condensed = true): string {
  const occupied = subshells.filter((s) => s.electrons > 0).sort(byShell);
  if (occupied.length === 0) return '(no electrons)';
  if (condensed) {
    for (const gas of NOBLE_GASES) {
      const core = neutralSubshells(gas);
      const contained = core.every((c) => occupied.some((s) => s.n === c.n && s.l === c.l && s.electrons === c.electrons));
      const total = occupied.reduce((sum, s) => sum + s.electrons, 0);
      if (contained && total > gas) {
        const rest = occupied.filter((s) => !core.some((c) => c.n === s.n && c.l === s.l));
        return `[${getElement(gas).symbol}] ${rest.map((s) => `${subshellLabel(s)}${s.electrons}`).join(' ')}`;
      }
    }
  }
  return occupied.map((s) => `${subshellLabel(s)}${s.electrons}`).join(' ');
}

export interface ElectronConfiguration {
  readonly subshells: readonly Subshell[];
  /** Condensed notation, e.g. "[Ar] 3d6". */
  readonly text: string;
  /** Number of unpaired electrons predicted by Hund's rule for this configuration. */
  readonly unpaired: number;
  /** `reference` for the tabulated neutral ground state, `rule-based` for ions. */
  readonly evidence: EvidenceLevel;
  /** How the configuration was obtained, in plain language. */
  readonly basis: string;
}

/** Subshells in Madelung (n + l, then n) filling order. */
function madelungOrder(): Array<{ n: number; l: number }> {
  const shells: Array<{ n: number; l: number }> = [];
  for (let n = 1; n <= 8; n++) for (let l = 0; l < Math.min(n, L_LETTERS.length); l++) shells.push({ n, l });
  return shells.sort((a, b) => a.n + a.l - (b.n + b.l) || a.n - b.n);
}

/**
 * Electron configuration of an atom or monatomic ion with `z` protons and `electrons` electrons.
 *
 * The neutral ground state comes from reference data. Ions follow the textbook rules: cations lose
 * electrons from the shells outside the noble-gas core, highest principal quantum number first
 * (so 4s empties before 3d); anions gain electrons in Madelung order. These rules are reliable for
 * common ions but are estimates, not spectroscopic assignments.
 */
export function electronConfiguration(z: number, electrons: number): ElectronConfiguration {
  const element = getElement(z);
  const split = neutralSplit(z);
  const outermostFirst = (a: Subshell, b: Subshell) => b.n - a.n || b.l - a.l;

  if (electrons === z) {
    const subshells = [...split.core, ...split.valence].sort(byShell);
    return {
      subshells,
      text: formatSubshells(subshells),
      unpaired: subshells.reduce((sum, s) => sum + unpairedInSubshell(s), 0),
      evidence: 'reference',
      basis: element.electronConfigurationPredicted
        ? `Predicted ground state of neutral ${element.name}; it has not been confirmed experimentally.`
        : `Tabulated ground state of the neutral ${element.name} atom.`,
    };
  }

  const core = split.core.map((s) => ({ ...s }));
  const valence = split.valence.map((s) => ({ ...s }));
  let basis: string;

  if (electrons < z) {
    let toRemove = z - Math.max(0, electrons);
    for (const group of [valence.sort(outermostFirst), core.sort(outermostFirst)]) {
      for (const shell of group) {
        if (toRemove === 0) break;
        const taken = Math.min(shell.electrons, toRemove);
        (shell as { electrons: number }).electrons -= taken;
        toRemove -= taken;
      }
    }
    basis =
      'Estimated by removing electrons from the neutral ground state, outermost shell first (highest n, then highest l). This is the standard textbook rule for cations.';
  } else {
    let toAdd = electrons - z;
    const all = [...core, ...valence];
    for (const slot of madelungOrder()) {
      if (toAdd === 0) break;
      let shell = all.find((s) => s.n === slot.n && s.l === slot.l);
      const room = subshellCapacity(slot.l) - (shell?.electrons ?? 0);
      if (room <= 0) continue;
      if (!shell) {
        shell = { n: slot.n, l: slot.l, electrons: 0 };
        all.push(shell);
        valence.push(shell);
      }
      const added = Math.min(room, toAdd);
      (shell as { electrons: number }).electrons += added;
      toAdd -= added;
    }
    basis =
      'Estimated by adding electrons to the neutral ground state in Madelung (n + l) order. This is the standard textbook rule for anions.';
  }

  const subshells = [...core, ...valence].filter((s) => s.electrons > 0).sort(byShell);
  return {
    subshells,
    text: formatSubshells(subshells),
    unpaired: subshells.reduce((sum, s) => sum + unpairedInSubshell(s), 0),
    evidence: 'rule-based',
    basis,
  };
}
