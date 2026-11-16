import { CLEAR_LIQUID_APPEARANCE } from './materials';
import type { LiquidAppearance } from './materials';
import { sameFluidScope } from './types';
import type { FluidScope } from './types';

export class LiquidAppearanceTransition {
  private scope?: FluidScope;
  private from: LiquidAppearance = CLEAR_LIQUID_APPEARANCE;
  private target: LiquidAppearance = CLEAR_LIQUID_APPEARANCE;
  private startedS = 0;
  private durationS = 0;

  set(scope: FluidScope, appearance: LiquidAppearance, nowS: number, reducedMotion: boolean): void {
    const changedScope = !this.scope || !sameFluidScope(this.scope, scope) ||
      scope.simulationTimeS < this.scope.simulationTimeS || scope.lastSequence < this.scope.lastSequence;
    const mustSnap = changedScope || reducedMotion || scope.status !== 'RUNNING' ||
      !appearance.indicatorRecordId || !this.target.indicatorRecordId;
    if (!changedScope && appearance.indicatorRecordId === this.target.indicatorRecordId && !mustSnap) {
      this.scope = scope;
      return;
    }
    this.from = mustSnap ? appearance : this.sample(nowS);
    this.target = appearance;
    this.scope = scope;
    this.startedS = Number.isFinite(nowS) ? nowS : 0;
    this.durationS = mustSnap ? 0 : 0.18;
  }

  sample(nowS: number): LiquidAppearance {
    const t = this.durationS > 0 ? Math.min(1, Math.max(0, (nowS - this.startedS) / this.durationS)) : 1;
    if (t >= 1 || !Number.isFinite(t)) return this.target;
    const smooth = t * t * (3 - 2 * t);
    return {
      ...this.target,
      colorSrgb: [
        this.from.colorSrgb[0] + (this.target.colorSrgb[0] - this.from.colorSrgb[0]) * smooth,
        this.from.colorSrgb[1] + (this.target.colorSrgb[1] - this.from.colorSrgb[1]) * smooth,
        this.from.colorSrgb[2] + (this.target.colorSrgb[2] - this.from.colorSrgb[2]) * smooth,
      ],
      opacity: this.from.opacity + (this.target.opacity - this.from.opacity) * smooth,
    };
  }

  isAnimating(nowS: number): boolean {
    return this.durationS > 0 && nowS >= this.startedS && nowS < this.startedS + this.durationS;
  }

  clear(): void {
    this.scope = undefined;
    this.from = CLEAR_LIQUID_APPEARANCE;
    this.target = CLEAR_LIQUID_APPEARANCE;
    this.durationS = 0;
  }
}
