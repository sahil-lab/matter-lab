import { sortedAtoms } from '@matterlab/core';
import type { Scene } from '@matterlab/core';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { CHEM_ATOM_LIMIT, useChem } from '../../science/chem';
import type { SceneChemistry } from '../../science/chem';
import { notify } from '../../state/actions';
import { useLab } from '../../state/store';
import { EvidenceBadge, IconButton, Note, Section, formatCount } from '../kit';

/** RDKit numbers atoms from zero in file order; the interface speaks of the scene's own atom numbers. */
function translateAtomNumbers(message: string, scene: Scene): string {
  const atoms = sortedAtoms(scene);
  const idOf = (index: string) => atoms[Number(index)]?.id ?? index;
  return message
    .replace(/atom #\s*(\d+)/g, (_, index: string) => `atom ${idOf(index)}`)
    .replace(/(Unkekulized atoms:)((?:\s+\d+)+)/, (_, head: string, list: string) => `${head} ${list.trim().split(/\s+/).map(idOf).join(', ')}`);
}

function CopyRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => notify('warning', 'The browser did not allow copying', 'Select the text and copy it by hand.'));
  };
  return (
    <>
      <dt>{label}</dt>
      <dd title={value} data-testid={testId}>
        {value}
      </dd>
      <IconButton size="sm" tip={copied ? 'Copied' : `Copy ${label}`} tipPos="top-end" onClick={copy}>
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </>
  );
}

function Descriptors({ analysis }: { analysis: SceneChemistry }) {
  const d = analysis.descriptors;
  if (!d) return null;
  const rows: Array<[string, string]> = [
    ['Rings', `${d.NumRings ?? 0}${d.NumAromaticRings ? ` (${d.NumAromaticRings} aromatic)` : ''}`],
    ['Rotatable bonds', String(d.NumRotatableBonds ?? 0)],
    ['H-bond donors / acceptors', `${d.NumHBD ?? 0} / ${d.NumHBA ?? 0}`],
    ['Stereocentres', `${d.NumAtomStereoCenters ?? 0}${d.NumUnspecifiedAtomStereoCenters ? ` (${d.NumUnspecifiedAtomStereoCenters} unassigned)` : ''}`],
    ['Polar surface area (TPSA)', `${(d.tpsa ?? 0).toFixed(1)} Å²`],
    ['log P (Crippen)', (d.CrippenClogP ?? 0).toFixed(2)],
  ];
  return (
    <details className="ml-details">
      <summary>
        Descriptors <EvidenceBadge level="rule-based" />
      </summary>
      <dl className="ml-kv" style={{ marginTop: 6 }}>
        {rows.map(([name, value]) => (
          <div key={name} style={{ display: 'contents' }}>
            <dt>{name}</dt>
            <dd className="ml-mono">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="ml-empty" style={{ marginTop: 6 }}>
        Counts follow RDKit’s definitions. TPSA and log P are fragment-contribution estimates (Ertl; Wildman–Crippen), not measurements.
      </p>
    </details>
  );
}

/**
 * The structure's canonical identifiers and RDKit's verdict on it: an independent cross-check of
 * MATTER LAB's own rule-based structure checks.
 */
export function IdentitySection() {
  const scene = useLab((s) => s.scene);
  const state = useChem();
  const current = state.scene === scene;
  const analysis = current && state.status === 'ready' ? state.analysis : null;

  let body;
  if (state.status === 'unavailable' && current) {
    body = <Note severity="warning">RDKit could not be started in this browser, so there is no cross-check or identifier. {state.problem}</Note>;
  } else if (state.status === 'too-large' && current) {
    body = (
      <Note severity="info">
        Not cross-checked automatically: the structure has {formatCount(scene.atoms.size)} atoms and the limit for checking while editing is {formatCount(CHEM_ATOM_LIMIT)}.
      </Note>
    );
  } else if (!analysis) {
    body = (
      <p className="ml-empty" data-testid="identity-pending">
        Checking with RDKit…
      </p>
    );
  } else if (!analysis.ok) {
    body = (
      <Note severity="warning">
        <span data-testid="rdkit-verdict">RDKit {analysis.rdkitVersion} does not accept this structure.</span>
        {analysis.errors.map((message, i) => (
          <span key={i} style={{ display: 'block', marginTop: 3 }}>
            {translateAtomNumbers(message, scene)}
          </span>
        ))}
      </Note>
    );
  } else {
    const radicals = [...analysis.radicalAtomIds.keys()];
    body = (
      <>
        <dl className="ml-id">
          {analysis.smiles && <CopyRow label="SMILES" value={analysis.smiles} testId="smiles" />}
          {analysis.inchiKey && <CopyRow label="InChIKey" value={analysis.inchiKey} testId="inchikey" />}
          {analysis.inchi && <CopyRow label="InChI" value={analysis.inchi} testId="inchi" />}
        </dl>
        <p className="ml-check" data-testid="rdkit-verdict">
          <Check /> Accepted by RDKit {analysis.rdkitVersion}
          {analysis.aromaticAtomIds.size > 0 ? ` · ${analysis.aromaticAtomIds.size} aromatic atoms` : ''}
        </p>
        {radicals.length > 0 && (
          <Note severity="info">
            RDKit reads {radicals.length === 1 ? `atom ${radicals[0]}` : `atoms ${radicals.join(', ')}`} as {radicals.length === 1 ? 'a radical centre' : 'radical centres'} (unpaired electrons), because {radicals.length === 1 ? 'its valence is' : 'their valences are'} not filled.
          </Note>
        )}
        {analysis.warnings.length > 0 && (
          <Note severity="info">
            <span data-testid="rdkit-warnings">RDKit accepted the structure with {analysis.warnings.length === 1 ? 'a remark' : 'remarks'}:</span>
            {analysis.warnings.map((message, i) => (
              <span key={i} style={{ display: 'block', marginTop: 3 }}>
                {translateAtomNumbers(message, scene)}
              </span>
            ))}
          </Note>
        )}
        <Descriptors analysis={analysis} />
      </>
    );
  }

  return (
    <Section title="Identity" right={<EvidenceBadge level="computed" />}>
      {body}
    </Section>
  );
}
