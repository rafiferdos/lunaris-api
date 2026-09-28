import { z } from '@hono/zod-openapi';
import {
  questionSchema,
  publicQuestionSchema,
  categorySchema,
  modeSchema,
} from '../modules/questions/schema.js';
import { policySchema } from '../modules/assessments/policy.js';
export const problemSchema = z.object({
  type: z.string(),
  code: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  requestId: z.string(),
  errors: z.array(z.unknown()).optional(),
});
export const statusSchema = z.enum([
  'IN_PROGRESS',
  'SUBMITTED',
  'AUTO_SUBMITTED',
  'EXPIRED',
  'INVALIDATED',
]);
export const integrityStateSchema = z.object({
  version: z.string(),
  score: z.number(),
  eligible: z.boolean(),
  autoSubmit: z.boolean(),
  reason: z.string().nullable(),
  warning: z.boolean(),
});
export const integrityPolicySchema = z.object({
  version: z.string(),
  coalesceMs: z.number(),
  sustainedMs: z.number(),
  speechAutoSubmitCount: z.number(),
  penalties: z.object({
    WINDOW_BLUR: z.number(),
    TAB_HIDDEN: z.number(),
    FULLSCREEN_EXIT: z.number(),
    SPEECH_ACTIVITY: z.number(),
  }),
  competitiveTabAutoSubmit: z.boolean(),
});
const outcome = z.object({
  outcome: z.string(),
  points: z.number(),
  minimum: z.number(),
  maximum: z.number(),
  quality: z.number(),
  objective: z.boolean(),
});
export const resultSchema = z.object({
  engineVersion: z.string(),
  rawScore: z.number(),
  minimumPossibleScore: z.number(),
  maximumPossibleScore: z.number(),
  normalizedScore: z.number(),
  accuracyPercent: z.number().nullable(),
  answerQualityPercent: z.number().nullable(),
  correct: z.number(),
  partial: z.number(),
  skipped: z.number(),
  reviews: z.array(
    outcome.extend({
      questionId: z.uuid(),
      question: questionSchema,
      selected: z.array(z.string()),
      responseTimeMs: z.number().nullable(),
    }),
  ),
  xp: z.number(),
  ratingChange: z.number(),
  topicRatingChange: z.number(),
  integrity: z.number(),
  rankEligible: z.boolean(),
  durationSeconds: z.number(),
  xpVersion: z.string(),
  ratingVersion: z.string(),
  integrityVersion: z.string(),
});
const topicBrief = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  category: categorySchema,
});
export const attemptSchema = z.object({
  id: z.uuid(),
  status: statusSchema,
  topic: topicBrief,
  mode: modeSchema,
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  serverTime: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  questionCount: z.number(),
  policy: policySchema.extend({ integrity: integrityPolicySchema }),
  integrity: integrityStateSchema,
  currentPosition: z.number(),
  questions: z.array(
    publicQuestionSchema.extend({ position: z.number(), selected: z.array(z.string()) }),
  ),
  result: resultSchema.nullable(),
  reason: z.string().nullable(),
});
export const metricsSchema = z.object({
  totalXp: z.number(),
  rating: z.number(),
  assessmentCount: z.number(),
  ratedCount: z.number(),
  questionsAnswered: z.number(),
  averageNormalizedScore: z.number(),
  accuracyPercent: z.number().nullable(),
  answerQualityPercent: z.number().nullable(),
  averageIntegrity: z.number(),
  currentStreak: z.number(),
  longestStreak: z.number(),
  bestScore: z.number(),
  latestScore: z.number(),
  lastAssessmentAt: z.string().nullable(),
});
export const availabilitySchema = z.object({
  dailyUsed: z.number(),
  weeklyUsed: z.number(),
  dailyLimit: z.number(),
  weeklyLimit: z.number(),
  nextDailyReset: z.iso.datetime(),
  nextWeeklyReset: z.iso.datetime(),
  canStart: z.boolean(),
});
export const assessmentSchema = topicBrief.extend({
  description: z.string(),
  active: z.boolean(),
  modes: z.array(
    policySchema.extend({
      id: z.uuid(),
      mode: modeSchema,
      scoring: z.object({
        CORRECT: z.number(),
        PARTIAL: z.number(),
        WRONG: z.number(),
        BEST: z.number(),
        STRONG: z.number(),
        ACCEPTABLE: z.number(),
        WEAK: z.number(),
      }),
      available: z.boolean(),
    }),
  ),
  progress: metricsSchema.nullable(),
  availability: availabilitySchema,
});
export const historyRowSchema = z.object({
  id: z.uuid(),
  date: z.iso.datetime(),
  topic: z.string(),
  topicName: z.string(),
  category: categorySchema,
  mode: modeSchema,
  status: statusSchema,
  rawScore: z.number().nullable(),
  normalizedScore: z.number().nullable(),
  accuracyPercent: z.number().nullable(),
  xp: z.number().nullable(),
  ratingChange: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  integrity: z.number().nullable(),
});
export const profileSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.email(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['USER', 'ADMIN']),
  joinedAt: z.iso.datetime(),
  username: z.string().nullable(),
  bio: z.string(),
  country: z.string().nullable(),
  timezone: z.string(),
  preferredTopics: z.array(z.string()),
});
export const pageMeta = z.object({ nextCursor: z.string().nullable() });
export const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
export const list = <T extends z.ZodType>(schema: T) =>
  z.object({ data: z.array(schema), meta: pageMeta });
