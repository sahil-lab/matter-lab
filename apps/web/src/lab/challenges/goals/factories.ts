/**
 * Named convenience constructors matching the examples named in Agent 08's brief
 * (`hasConnection(stand,clamp)`, `buretteMounted`, `flaskLocatedBelow`, `deliveredVolumeWithin`,
 * `endpointCaptured`, `repeatTrials>=3`). Each simply builds a plain `GoalPredicate` object — there
 * is no hidden control flow, so objectives stay data, not scene-specific condition spaghetti.
 */

import type { ApparatusKind, ConnectionKind, ObservationType } from '../contracts';
import type { GoalPredicate } from './types';

export function apparatusPlaced(role: string, apparatusKind: ApparatusKind): GoalPredicate {
  return { kind: 'apparatusPlaced', role, apparatusKind };
}

export function hasConnection(fromRole: string, toRole: string, connectionKind?: ConnectionKind): GoalPredicate {
  return { kind: 'hasConnection', fromRole, toRole, connectionKind };
}

export function buretteMounted(buretteRole = 'burette', clampRole = 'clamp'): GoalPredicate {
  return { kind: 'all', of: [apparatusPlaced(buretteRole, 'BURETTE'), hasConnection(buretteRole, clampRole, 'MECHANICAL')] };
}

export function flaskLocatedBelow(flaskRole = 'flask', buretteRole = 'burette', toleranceM?: number): GoalPredicate {
  return { kind: 'relativePosition', role: flaskRole, relativeToRole: buretteRole, relation: 'below', toleranceM };
}

export function containerHasSpecies(role: string, speciesId: string, minMolarity?: number, maxMolarity?: number): GoalPredicate {
  return { kind: 'containerSpecies', role, speciesId, minMolarity, maxMolarity };
}

export function deliveredVolumeWithin(sourceRole: string, minL: number, maxL: number, receiverRole?: string): GoalPredicate {
  return { kind: 'deliveredVolumeWithin', sourceRole, receiverRole, minL, maxL };
}

export function endpointCaptured(options?: { readonly analyteRole?: string; readonly titrantRole?: string; readonly tolerancePctOfEquivalence?: number; readonly absoluteFloorL?: number }): GoalPredicate {
  return { kind: 'endpointCaptured', ...options };
}

export function repeatTrials(count: number): GoalPredicate {
  return { kind: 'repeatTrialsAtLeast', count };
}

export function runSucceeded(type?: ObservationType): GoalPredicate {
  return { kind: 'runSucceeded', type };
}

export function observationRecorded(type: ObservationType, count?: number): GoalPredicate {
  return { kind: 'observationRecorded', type, count };
}

export function allOf(...of: readonly GoalPredicate[]): GoalPredicate {
  return { kind: 'all', of };
}

export function anyOf(...of: readonly GoalPredicate[]): GoalPredicate {
  return { kind: 'any', of };
}

export function not(of: GoalPredicate): GoalPredicate {
  return { kind: 'not', of };
}
