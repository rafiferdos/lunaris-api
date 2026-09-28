import type { Mode } from '../questions/schema.js';
import { clamp } from '../scoring/v1.js';
export const ratingPolicy = {
  initial: 1000,
  min: 0,
  max: 3000,
  references: { EASY: 850, MEDIUM: 1000, COMPETITIVE: 1150 },
  multipliers: { EASY: 0.8, MEDIUM: 1, COMPETITIVE: 1.2 },
};
export function rate(
  current: number,
  ratedAttempts: number,
  normalized: number,
  mode: Mode,
  eligible: boolean,
) {
  if (!eligible) return { before: current, after: current, delta: 0 };
  const k = ratedAttempts < 10 ? 48 : ratedAttempts < 30 ? 32 : 24;
  const expected = 1 / (1 + 10 ** ((ratingPolicy.references[mode] - current) / 400));
  const delta = Math.round(
    k * ratingPolicy.multipliers[mode] * (clamp(normalized) / 100 - expected),
  );
  const after = clamp(current + delta, ratingPolicy.min, ratingPolicy.max);
  return { before: current, after, delta: after - current };
}
