import { EXPERIMENT_PRESETS, parseFormula, suggestReactions } from '@matterlab/reactions';
import type {
  CataloguedReaction,
  ExperimentConcentrationUnit,
  ExperimentEnvironment,
  ExperimentMethod,
  ExperimentSpecies,
  Phase,
  SpeciesRole,
} from '@matterlab/reactions';
import { ChevronLeft, FilePlus2, Play, Plus, Square, X } from 'lucide-react';
import { useMemo } from 'react';
import { lab } from '../state/store';
import { EquationText } from '../ui/chem';
import { Button, IconButton, Section, Segmented } from '../ui/kit';
import { Labelled, Select, TextField, ValueField } from './fields';
import { addSpecies, cancelRun, loadPreset, newExperiment, removeSpecies, runDraft, setCondition, setMethod, setTitle, updateSpecies, useReaction } from './store';

const ROLE_OPTIONS: ReadonlyArray<{ value: SpeciesRole; label: string }> = [
  { value: 'reactant', label: 'Reactant' },
  { value: 'product', label: 'Product' },
  { value: 'catalyst', label: 'Catalyst' },
  { value: 'solvent', label: 'Solvent' },
];

const PHASE_OPTIONS: ReadonlyArray<{ value: Phase | ''; label: string }> = [
  { value: '', label: 'phase —' },
  { value: 'g', label: '(g) gas' },
  { value: 'l', label: '(l) liquid' },
  { value: 's', label: '(s) solid' },
  { value: 'aq', label: '(aq) aqueous' },
];

const ENVIRONMENT_OPTIONS: ReadonlyArray<{ value: ExperimentEnvironment; label: string }> = [
  { value: 'gas-phase', label: 'Gas phase' },
  { value: 'aqueous-solution', label: 'Aqueous solution' },
  { value: 'unspecified', label: 'Not specified' },
];

const UNIT_OPTIONS: ReadonlyArray<{ value: ExperimentConcentrationUnit; label: string }> = [
  { value: 'molecule/cm3', label: 'molecule cm⁻³' },
  { value: 'mol/L', label: 'mol L⁻¹' },
];

const METHOD_TIPS: Readonly<Record<ExperimentMethod, string>> = {
  auto: 'Everything the reference data support: balance, thermodynamics and, where a sourced rate law exists, kinetics',
  stoichiometry: 'Balance the equation and check conservation only',
  thermodynamics: 'Reaction enthalpy, entropy, Gibbs energy and equilibrium constant from reference tables',
  kinetics: 'Concentration against time from a sourced rate law',
};

function formulaProblem(formula: string): string | null {
  if (!formula.trim()) return null;
  try {
    parseFormula(formula);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Not a formula';
  }
}

function SpeciesRow({ species, index, showConcentration, unit }: { species: ExperimentSpecies; index: number; showConcentration: boolean; unit: string }) {
  const problem = formulaProblem(species.formula);
  const reacting = species.role === 'reactant' || species.role === 'product';
  return (
    <div className="ml-species" data-role={species.role} data-testid="species-row">
      <div className="ml-species__main">
        <Select<SpeciesRole> label="Role" className="ml-species__role" value={species.role} options={ROLE_OPTIONS} onChange={(role) => updateSpecies(index, { role })} />
        <TextField
          label="Formula"
          mono
          placeholder="formula"
          value={species.formula}
          invalid={problem !== null}
          onCommit={(formula) => updateSpecies(index, { formula })}
          testId="species-formula"
        />
        <Select<Phase | ''>
          label="Phase"
          className="ml-species__phase"
          value={species.phase ?? ''}
          options={PHASE_OPTIONS}
          onChange={(phase) => updateSpecies(index, { phase: phase === '' ? undefined : phase })}
        />
        <IconButton size="sm" variant="danger" aria-label={`Remove ${species.formula || 'species'}`} onClick={() => removeSpecies(index)}>
          <X />
        </IconButton>
      </div>
      {problem && <div className="ml-species__problem">{problem}</div>}
      {showConcentration && reacting && (
        <div className="ml-species__amount">
          <span>Initial concentration</span>
          <ValueField
            label={`Initial concentration of ${species.formula}`}
            value={species.initialConcentration}
            min={0}
            allowEmpty
            placeholder={species.role === 'product' ? '0' : 'not set'}
            onCommit={(initialConcentration) => updateSpecies(index, { initialConcentration })}
            testId="species-concentration"
          />
          <em>{unit}</em>
        </div>
      )}
      {!reacting && <div className="ml-species__note">Recorded with the experiment. No supported model describes {species.role === 'catalyst' ? 'catalysis' : 'solvation'}, so it does not change the results.</div>}
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: readonly CataloguedReaction[] }) {
  if (suggestions.length === 0) return null;
  return (
    <Section title="Catalogued reactions with these species">
      <div className="ml-list">
        {suggestions.slice(0, 5).map((reaction) => (
          <div key={reaction.id} className="ml-suggestion" title={reaction.note}>
            <div>
              <EquationText text={reaction.equation} />
            </div>
            <span>
              {reaction.title}
              {reaction.hasKinetics ? ' · rate law' : ''}
              {reaction.hasThermo ? ' · thermodynamics' : ''}
            </span>
          </div>
        ))}
      </div>
      <p className="ml-empty">A look-up of known reactions in the catalogue. It does not predict that a reaction happens under your conditions.</p>
    </Section>
  );
}

/** Left panel of the Reaction Laboratory: what goes into the chamber and under which conditions. */
export function SetupPanel() {
  const draft = useReaction((s) => s.draft);
  const presetId = useReaction((s) => s.presetId);
  const running = useReaction((s) => s.running);
  const progress = useReaction((s) => s.progress);
  const { conditions } = draft;
  const showConcentration = draft.method === 'auto' || draft.method === 'kinetics';
  const unitLabel = UNIT_OPTIONS.find((u) => u.value === conditions.concentrationUnit)!.label;

  const suggestions = useMemo(() => {
    const named = draft.species.filter((s) => s.role === 'reactant' && s.formula.trim() && formulaProblem(s.formula) === null);
    if (named.length === 0) return [];
    try {
      return suggestReactions(named.map((s) => ({ formula: s.formula, ...(s.phase ? { phase: s.phase } : {}) })));
    } catch {
      return [];
    }
  }, [draft.species]);

  return (
    <aside className="ml-panel ml-sidepanel" aria-label="Experiment set-up" data-testid="reaction-setup">
      <div className="ml-sidepanel__head">
        <span className="ml-hero__title" style={{ fontSize: 14 }}>
          Experiment
        </span>
        <IconButton size="sm" tip="New, empty experiment" tipPos="bottom" onClick={newExperiment}>
          <FilePlus2 />
        </IconButton>
        <IconButton size="sm" tip="Hide set-up" tipPos="bottom-end" onClick={() => lab.set({ sidePanelOpen: false })}>
          <ChevronLeft />
        </IconButton>
      </div>
      <div className="ml-sidepanel__body ml-scroll">
        <Labelled label="Example experiments">
          <select
            className="ml-select"
            aria-label="Example experiments"
            value={presetId ?? ''}
            data-testid="reaction-preset"
            onChange={(e) => {
              if (e.target.value) loadPreset(e.target.value);
            }}
          >
            {presetId === null && <option value="">Custom experiment</option>}
            {EXPERIMENT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.title}
              </option>
            ))}
          </select>
        </Labelled>
        {presetId && <p className="ml-empty">{EXPERIMENT_PRESETS.find((p) => p.id === presetId)?.description}</p>}

        <Labelled label="Title">
          <TextField label="Experiment title" value={draft.title ?? ''} placeholder="Untitled experiment" onCommit={setTitle} />
        </Labelled>

        <Section
          title="Species"
          right={
            <span style={{ display: 'flex', gap: 4 }}>
              <Button size="sm" variant="outline" onClick={() => addSpecies('reactant')} data-testid="add-reactant">
                <Plus /> Reactant
              </Button>
              <Button size="sm" variant="outline" onClick={() => addSpecies('product')} data-testid="add-product">
                <Plus /> Product
              </Button>
            </span>
          }
        >
          <div className="ml-list">
            {draft.species.map((species, index) => (
              <SpeciesRow key={index} species={species} index={index} showConcentration={showConcentration} unit={unitLabel} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Button size="sm" onClick={() => addSpecies('catalyst')}>
              <Plus /> Catalyst
            </Button>
            <Button size="sm" onClick={() => addSpecies('solvent')}>
              <Plus /> Solvent
            </Button>
          </div>
          <p className="ml-empty">Give the species; the coefficients are found by balancing. Products are never guessed: add the ones you expect.</p>
        </Section>

        <Section title="Conditions">
          <div className="ml-formgrid">
            <Labelled label="Temperature" unit="K">
              <ValueField label="Temperature in kelvin" value={conditions.temperatureK} min={0} exclusiveMin onCommit={(v) => v !== undefined && setCondition('temperatureK', v)} testId="temperature" />
            </Labelled>
            <Labelled label="Pressure" unit="bar">
              <ValueField label="Pressure in bar" value={conditions.pressureBar} min={0} exclusiveMin onCommit={(v) => v !== undefined && setCondition('pressureBar', v)} testId="pressure" />
            </Labelled>
            <Labelled label="Reaction time" unit="s">
              <ValueField label="Reaction time in seconds" value={conditions.durationSeconds} min={0} exclusiveMin onCommit={(v) => v !== undefined && setCondition('durationSeconds', v)} testId="duration" />
            </Labelled>
            <Labelled label="Concentrations in">
              <Select<ExperimentConcentrationUnit> label="Concentration unit" value={conditions.concentrationUnit} options={UNIT_OPTIONS} onChange={(v) => setCondition('concentrationUnit', v)} />
            </Labelled>
          </div>
          <Labelled label="Environment">
            <Select<ExperimentEnvironment> label="Reaction environment" value={conditions.environment} options={ENVIRONMENT_OPTIONS} onChange={(v) => setCondition('environment', v)} />
          </Labelled>
          <p className="ml-empty">{(conditions.temperatureK - 273.15).toFixed(1)} °C. Thermodynamic values are standard-state values at 1 bar; pressure is recorded, not modelled.</p>
        </Section>

        <Section title="Method">
          <Segmented<ExperimentMethod>
            label="Calculation method"
            fill
            tipPos="top"
            value={draft.method}
            onChange={setMethod}
            options={[
              { value: 'auto', label: 'Auto', tip: METHOD_TIPS.auto },
              { value: 'stoichiometry', label: 'Balance', tip: METHOD_TIPS.stoichiometry },
              { value: 'thermodynamics', label: 'Thermo', tip: METHOD_TIPS.thermodynamics },
              { value: 'kinetics', label: 'Kinetics', tip: METHOD_TIPS.kinetics },
            ]}
          />
          <p className="ml-empty">{METHOD_TIPS[draft.method]}.</p>
        </Section>

        <Suggestions suggestions={suggestions} />
      </div>
      <div className="ml-sidepanel__foot">
        {running ? (
          <>
            <div className="ml-progress" data-indeterminate={!progress} style={{ flex: 1, margin: 0 }}>
              <i style={progress ? { width: `${Math.round(progress.fraction * 100)}%` } : undefined} />
            </div>
            <Button variant="outline" onClick={cancelRun} data-testid="reaction-cancel">
              <Square /> Cancel
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void runDraft()} data-testid="reaction-run">
            <Play /> Run experiment
          </Button>
        )}
      </div>
    </aside>
  );
}
