import { z } from 'zod';
import type { Mode } from '../questions/schema.js';
export const policySchema = z.strictObject({
  questionCount: z.number().int().min(1).max(100),
  durationSeconds: z.number().int().min(30).max(7200),
  distribution: z
    .strictObject({
      FOUNDATIONAL: z.number().min(0),
      INTERMEDIATE: z.number().min(0),
      ADVANCED: z.number().min(0),
    })
    .refine((v) => Object.values(v).reduce((a, b) => a + b, 0) > 0),
  editable: z.boolean(),
  backNavigation: z.boolean(),
  ranked: z.boolean(),
  enabled: z.boolean(),
  scoringVersion: z.literal('scoring/v1'),
  xpVersion: z.literal('xp/v1'),
  ratingVersion: z.literal('rating/v1'),
  integrityVersion: z.literal('integrity/v1'),
});
export type Policy = z.infer<typeof policySchema>;
export const policies: Record<Mode, Policy> = Object.fromEntries(
  (['EASY', 'MEDIUM', 'COMPETITIVE'] as const).map((mode) => [
    mode,
    {
      questionCount: mode === 'EASY' ? 10 : 15,
      durationSeconds: mode === 'EASY' ? 1200 : mode === 'MEDIUM' ? 1800 : 1500,
      distribution:
        mode === 'EASY'
          ? { FOUNDATIONAL: 8, INTERMEDIATE: 2, ADVANCED: 0 }
          : mode === 'MEDIUM'
            ? { FOUNDATIONAL: 3, INTERMEDIATE: 9, ADVANCED: 3 }
            : { FOUNDATIONAL: 0, INTERMEDIATE: 6, ADVANCED: 9 },
      editable: mode !== 'COMPETITIVE',
      backNavigation: mode !== 'COMPETITIVE',
      ranked: true,
      enabled: true,
      scoringVersion: 'scoring/v1',
      xpVersion: 'xp/v1',
      ratingVersion: 'rating/v1',
      integrityVersion: 'integrity/v1',
    },
  ]),
) as Record<Mode, Policy>;
export const quotaPolicy = { daily: 1, weekly: 7 };
