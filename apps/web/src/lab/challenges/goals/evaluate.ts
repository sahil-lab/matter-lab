/**
 * Pure evaluator for `GoalPredicate` trees. Deterministic: the same context and bindings always
 * produce the same result, which is what lets scoring be reproduced exactly from a saved event log.
 */

import { DEFAULT_APPARATUS_LABEL_LOOKUP } from '../contracts';
import type { ApparatusLabelLookup } from '../contracts';
import { areConnected, apparatusById, countValveOpenings, equivalenceVolumeFromFills, findUnboundApparatusByKind, firstFilledMolarityOfSpecies, observationsOfType, relationHolds, sumTransferredVolumeL } from './context';
import type { EvaluationContext, GoalPredicate, GoalRoleBindings, PredicateResult } from './types';

function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function waitingFor(role: string, bindings: GoalRoleBindings): PredicateResult {
  return { met: false, detail: `Waiting for "${role}" to be placed first.`, bindings };
}

export function evaluatePredicate(predicate: GoalPredicate, ctx: EvaluationContext, bindings: GoalRoleBindings, labels: ApparatusLabelLookup = DEFAULT_APPARATUS_LABEL_LOOKUP): PredicateResult {
  switch (predicate.kind) {
    case 'apparatusPlaced': {
      const boundId = bindings[predicate.role];
      const label = labels.labelFor(predicate.apparatusKind);
      if (boundId && apparatusById(ctx.scene, boundId)) return { met: true, detail: `${capitalize(label)} placed.`, bindings };
      const found = findUnboundApparatusByKind(ctx.scene, predicate.apparatusKind, bindings);
      if (!found) return { met: false, detail: `Place a ${label} in the scene.`, bindings };
      return { met: true, detail: `${capitalize(label)} placed.`, bindings: { ...bindings, [predicate.role]: found.id } };
    }
    case 'hasConnection': {
      const fromId = bindings[predicate.fromRole];
      const toId = bindings[predicate.toRole];
      if (!fromId) return waitingFor(predicate.fromRole, bindings);
      if (!toId) return waitingFor(predicate.toRole, bindings);
      const met = areConnected(ctx.scene, fromId, toId, predicate.connectionKind);
      return { met, detail: met ? 'Connected.' : `Connect ${predicate.fromRole} to ${predicate.toRole}.`, bindings };
    }
    case 'capabilityPresent': {
      const id = bindings[predicate.role];
      if (!id) return waitingFor(predicate.role, bindings);
      const instance = apparatusById(ctx.scene, id);
      const met = instance !== undefined && instance.capabilities.includes(predicate.capability);
      return { met, detail: met ? 'Required capability present.' : `${predicate.role} needs ${predicate.capability} capability.`, bindings };
    }
    case 'relativePosition': {
      const aId = bindings[predicate.role];
      const bId = bindings[predicate.relativeToRole];
      if (!aId) return waitingFor(predicate.role, bindings);
      if (!bId) return waitingFor(predicate.relativeToRole, bindings);
      const a = apparatusById(ctx.scene, aId);
      const b = apparatusById(ctx.scene, bId);
      if (!a || !b) return { met: false, detail: 'One of the parts is no longer in the scene.', bindings };
      const met = relationHolds(a, b, predicate.relation, predicate.toleranceM);
      const verb = predicate.relation === 'below' ? 'underneath' : predicate.relation === 'above' ? 'above' : predicate.relation === 'leftOf' ? 'to the left of' : 'to the right of';
      return { met, detail: met ? 'Positioned correctly.' : `Move ${predicate.role} ${verb} ${predicate.relativeToRole}.`, bindings };
    }
    case 'containerSpecies': {
      const id = bindings[predicate.role];
      if (!id) return waitingFor(predicate.role, bindings);
      const molarity = firstFilledMolarityOfSpecies(ctx.events, id, predicate.speciesId);
      const min = predicate.minMolarity ?? Number.EPSILON;
      const max = predicate.maxMolarity ?? Infinity;
      const met = molarity >= min && molarity <= max;
      return {
        met,
        detail: met ? `${predicate.speciesId} concentration confirmed (${molarity.toFixed(3)} mol/L).` : `Prepare ${predicate.speciesId} in ${predicate.role} (currently ${molarity.toFixed(3)} mol/L).`,
        bindings,
      };
    }
    case 'valveOperated': {
      const id = bindings[predicate.role];
      if (!id) return waitingFor(predicate.role, bindings);
      const count = countValveOpenings(ctx.events, id);
      const need = predicate.minOpenings ?? 1;
      const met = count >= need;
      return { met, detail: met ? `Stopcock operated ${count} time(s).` : `Open the stopcock on ${predicate.role}.`, bindings };
    }
    case 'deliveredVolumeWithin': {
      const sourceId = bindings[predicate.sourceRole];
      if (!sourceId) return waitingFor(predicate.sourceRole, bindings);
      const receiverId = predicate.receiverRole ? bindings[predicate.receiverRole] : undefined;
      const delivered = sumTransferredVolumeL(ctx.events, { sourceId, receiverId });
      const met = delivered >= predicate.minL && delivered <= predicate.maxL;
      return {
        met,
        detail: `${(delivered * 1000).toFixed(2)} mL delivered so far (target ${(predicate.minL * 1000).toFixed(2)}\u2013${(predicate.maxL * 1000).toFixed(2)} mL).`,
        bindings,
      };
    }
    case 'observationRecorded': {
      const count = observationsOfType(ctx.observations, predicate.type).length;
      const need = predicate.count ?? 1;
      const met = count >= need;
      return { met, detail: met ? `${count} ${predicate.type} observation(s) recorded.` : `Take a ${predicate.type} reading.`, bindings };
    }
    case 'endpointCaptured': {
      const lastTrial = ctx.trials[ctx.trials.length - 1];
      const mark = lastTrial?.endpoint;
      if (!mark) return { met: false, detail: 'Mark the endpoint once the indicator changes colour.', bindings };
      const analyteId = bindings[predicate.analyteRole ?? 'flask'];
      const titrantId = bindings[predicate.titrantRole ?? 'burette'];
      const equivalence = analyteId && titrantId ? equivalenceVolumeFromFills(ctx.events, analyteId, titrantId) : undefined;
      if (equivalence === undefined) return { met: false, detail: 'Endpoint marked, but the equivalence point is not yet known (both vessels must be filled first).', bindings };
      const floor = predicate.absoluteFloorL ?? 0.0005;
      const tolerance = Math.max(floor, ((predicate.tolerancePctOfEquivalence ?? 4) / 100) * equivalence);
      const deviation = Math.abs(mark.deliveredVolumeL - equivalence);
      const met = deviation <= tolerance;
      return {
        met,
        detail: met
          ? `Endpoint at ${(mark.deliveredVolumeL * 1000).toFixed(2)} mL is within ${(tolerance * 1000).toFixed(2)} mL of the computed equivalence point (${(equivalence * 1000).toFixed(2)} mL).`
          : `Endpoint at ${(mark.deliveredVolumeL * 1000).toFixed(2)} mL is ${(deviation * 1000).toFixed(2)} mL from the computed equivalence point (${(equivalence * 1000).toFixed(2)} mL).`,
        bindings,
      };
    }
    case 'repeatTrialsAtLeast': {
      const completed = ctx.trials.filter((t) => t.endpoint !== null).length;
      const met = completed >= predicate.count;
      return { met, detail: `${completed} of ${predicate.count} required trial(s) completed.`, bindings };
    }
    case 'runSucceeded': {
      const matching = predicate.type ? ctx.observations.filter((o) => o.type === predicate.type) : ctx.observations;
      const last = matching[matching.length - 1];
      const met = last !== undefined && last.evidence !== 'UNSUPPORTED';
      return { met, detail: met ? 'The solver produced a real result.' : last ? `Latest observation is ${last.evidence}, not yet a supported result.` : 'No observation yet.', bindings };
    }
    case 'all': {
      let current = bindings;
      let met = true;
      const details: string[] = [];
      for (const child of predicate.of) {
        const result = evaluatePredicate(child, ctx, current, labels);
        current = result.bindings;
        details.push(result.detail);
        if (!result.met) met = false;
      }
      return { met, detail: details.join(' '), bindings: current };
    }
    case 'any': {
      let current = bindings;
      let met = false;
      const details: string[] = [];
      for (const child of predicate.of) {
        const result = evaluatePredicate(child, ctx, current, labels);
        details.push(result.detail);
        if (result.met) {
          met = true;
          current = result.bindings;
        }
      }
      return { met, detail: details.join(' / '), bindings: current };
    }
    case 'not': {
      const result = evaluatePredicate(predicate.of, ctx, bindings, labels);
      return { met: !result.met, detail: result.detail, bindings: result.bindings };
    }
    default: {
      const exhaustive: never = predicate;
      throw new Error(`Unknown goal predicate: ${JSON.stringify(exhaustive)}`);
    }
  }
}
