import type { Mode } from '../questions/schema.js';
import { clamp } from '../scoring/v1.js';
export const xpPolicy = {
  perQuestion: 5,
  participation: 0.15,
  performance: 0.85,
  exponent: 1.35,
  multipliers: { EASY: 1, MEDIUM: 1.25, COMPETITIVE: 1.5 },
};
export const integrityMultiplier = (integrity: number) =>
  integrity >= 90 ? 1 : integrity >= 75 ? 0.9 : integrity >= 60 ? 0.7 : 0;
export function awardXp(
  count: number,
  normalized: number,
  mode: Mode,
  integrity: number,
  eligible: boolean,
) {
  return eligible
    ? Math.round(
        count *
          xpPolicy.perQuestion *
          (xpPolicy.participation +
            xpPolicy.performance * (clamp(normalized) / 100) ** xpPolicy.exponent) *
          xpPolicy.multipliers[mode] *
          integrityMultiplier(integrity),
      )
    : 0;
}
