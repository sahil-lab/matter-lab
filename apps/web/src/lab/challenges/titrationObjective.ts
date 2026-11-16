/**
 * The shared first vertical slice (00_SHARED_INTEGRATION_CONTRACT.md section 6): assemble
 * stand → clamp → burette → flask, prepare a 25.00 mL 0.100 mol/L HCl aliquot and a 0.100 mol/L
 * NaOH titrant, operate the stopcock, find the endpoint and read the graph. One ordered step list
 * is reused across Guided (stepwise hints), Challenge (flat success criteria, no overlay) and
 * Precision (same criteria plus repeat trials) so the three modes never drift apart.
 *
 * FLAGGED ASSUMPTION: `HCL_SPECIES_ID`/`NAOH_SPECIES_ID` stand in for whatever resolved chemical
 * species identifiers Agent 06 actually publishes (the shared contract requires "resolved chemical
 * species", but does not fix a naming scheme). Reconcile these constants once Agent 06's species
 * registry exists.
 */

import type { Objective } from './goals';
import { apparatusPlaced, buretteMounted, containerHasSpecies, deliveredVolumeWithin, endpointCaptured, flaskLocatedBelow, hasConnection, observationRecorded } from './goals';

export const HCL_SPECIES_ID = 'HCl(aq)';
export const NAOH_SPECIES_ID = 'NaOH(aq)';

/** The benchmark case from Agent 06's brief: 25.00 mL of 0.100 mol/L HCl titrated by 0.100 mol/L NaOH. */
export const TITRATION_BENCHMARK = {
  aliquotVolumeL: 0.025,
  aliquotMolarity: 0.1,
  titrantMolarity: 0.1,
  theoreticalEquivalenceVolumeL: 0.025,
} as const;

export const TITRATION_STEPS = [
  {
    id: 'place-stand',
    title: 'Set up the retort stand',
    instructions: 'Drag a retort stand onto the workbench.',
    predicate: apparatusPlaced('stand', 'STAND'),
    highlightRoles: ['stand'],
    accessibleHint: 'From the apparatus library, add one retort stand to the workbench.',
  },
  {
    id: 'place-clamp',
    title: 'Add a burette clamp',
    instructions: 'Drag a burette clamp onto the workbench.',
    predicate: apparatusPlaced('clamp', 'CLAMP'),
    highlightRoles: ['clamp'],
    accessibleHint: 'From the apparatus library, add one burette clamp.',
  },
  {
    id: 'attach-clamp-to-stand',
    title: 'Attach the clamp to the stand',
    instructions: "Drag the clamp onto the stand's socket until it snaps into place.",
    predicate: hasConnection('clamp', 'stand', 'MECHANICAL'),
    highlightRoles: ['clamp', 'stand'],
    accessibleHint: 'Select the clamp, then choose "attach to stand" to connect it mechanically.',
  },
  {
    id: 'mount-burette',
    title: 'Mount the burette',
    instructions: 'Place a burette and attach it to the clamp.',
    predicate: buretteMounted('burette', 'clamp'),
    highlightRoles: ['burette', 'clamp'],
    accessibleHint: 'Add one burette, then attach it to the clamp you placed earlier.',
  },
  {
    id: 'place-flask',
    title: 'Place the receiving flask',
    instructions: 'Drag a conical flask onto the workbench.',
    predicate: apparatusPlaced('flask', 'FLASK'),
    highlightRoles: ['flask'],
    accessibleHint: 'From the apparatus library, add one conical flask.',
  },
  {
    id: 'position-flask',
    title: 'Position the flask under the burette',
    instructions: "Slide the flask so it sits directly beneath the burette's tip.",
    predicate: flaskLocatedBelow('flask', 'burette'),
    highlightRoles: ['flask', 'burette'],
    accessibleHint: 'Move the flask until it is centred underneath the burette.',
  },
  {
    id: 'prepare-aliquot',
    title: 'Prepare the HCl aliquot',
    instructions: `Fill the flask with ${(TITRATION_BENCHMARK.aliquotVolumeL * 1000).toFixed(2)} mL of ${TITRATION_BENCHMARK.aliquotMolarity.toFixed(3)} mol/L HCl.`,
    predicate: containerHasSpecies('flask', HCL_SPECIES_ID, TITRATION_BENCHMARK.aliquotMolarity * 0.8, TITRATION_BENCHMARK.aliquotMolarity * 1.2),
    highlightRoles: ['flask'],
    accessibleHint: 'Use the reagent bottle to fill the flask with the specified hydrochloric acid solution.',
  },
  {
    id: 'prepare-titrant',
    title: 'Prepare the NaOH titrant',
    instructions: `Fill the burette with ${TITRATION_BENCHMARK.titrantMolarity.toFixed(3)} mol/L NaOH.`,
    predicate: containerHasSpecies('burette', NAOH_SPECIES_ID, TITRATION_BENCHMARK.titrantMolarity * 0.8, TITRATION_BENCHMARK.titrantMolarity * 1.2),
    highlightRoles: ['burette'],
    accessibleHint: 'Use the reagent bottle to fill the burette with the specified sodium hydroxide solution.',
  },
  {
    id: 'open-stopcock',
    title: 'Open the stopcock',
    instructions: 'Operate the burette stopcock to begin delivering titrant.',
    predicate: deliveredVolumeWithin('burette', 0.0005, 1, 'flask'),
    highlightRoles: ['burette'],
    accessibleHint: 'Select the burette and operate its valve control to start the titration.',
  },
  {
    id: 'record-ph',
    title: 'Track the pH as you titrate',
    instructions: 'Take at least three pH readings while delivering titrant.',
    predicate: observationRecorded('PH', 3),
    highlightRoles: ['flask'],
    accessibleHint: 'Watch the pH readout update and let the titration curve build as you add titrant.',
  },
  {
    id: 'capture-endpoint',
    title: 'Identify the endpoint',
    instructions: 'Mark the endpoint once the indicator changes colour, then compare it with the computed equivalence point.',
    predicate: endpointCaptured(4),
    highlightRoles: ['flask'],
    accessibleHint: 'When the indicator changes colour, mark the endpoint. The app compares your reading with the computed equivalence point.',
  },
] as const;

export const GUIDED_TITRATION_OBJECTIVE: Objective = {
  id: 'titration-strong-acid-strong-base-guided',
  title: 'Guided titration: 0.100 mol/L HCl vs 0.100 mol/L NaOH',
  summary: 'Assemble the apparatus, prepare the solutions and titrate to the endpoint, step by step.',
  mode: 'guided',
  steps: TITRATION_STEPS,
  requiredTrials: 1,
};

export const CHALLENGE_TITRATION_OBJECTIVE: Objective = {
  id: 'titration-strong-acid-strong-base-challenge',
  title: 'Challenge: titrate HCl with NaOH to the endpoint',
  summary: 'You are given a stand, clamp, burette, flask and reagents. Reach a correctly identified endpoint with no step-by-step overlay.',
  mode: 'challenge',
  steps: TITRATION_STEPS,
  requiredTrials: 1,
};

export const PRECISION_TITRATION_OBJECTIVE: Objective = {
  id: 'titration-strong-acid-strong-base-precision',
  title: 'Precision trials: repeatability of the endpoint',
  summary: 'Repeat the titration at least three times and report the mean and spread of your measured endpoint volume.',
  mode: 'precision',
  steps: TITRATION_STEPS,
  requiredTrials: 3,
};

/** Free Experiment has no forced objective: zero gated steps, any number of independent setups. */
export const FREE_EXPLORATION_OBJECTIVE: Objective = {
  id: 'free-exploration',
  title: 'Free experiment',
  summary: 'Build any setup you like. Nothing here is graded; unsupported scientific models are still labelled honestly.',
  mode: 'free',
  steps: [],
  requiredTrials: 0,
};
