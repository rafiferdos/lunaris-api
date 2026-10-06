import { describe, it, expect } from 'vitest';
import { importSchema, publicQuestion, type Question } from '../src/modules/questions/schema.js';
import { score, evaluate, multipleQuality } from '../src/modules/scoring/v1.js';
import { awardXp, integrityMultiplier } from '../src/modules/xp/v1.js';
import { rate } from '../src/modules/rating/v1.js';
import { assessIntegrity, type IntegrityEvent } from '../src/modules/integrity/v1.js';
import { streak, quotaBounds } from '../src/modules/stats/streak.js';
import { selectQuestions } from '../src/modules/assessments/selection.js';
import { policies } from '../src/modules/assessments/policy.js';
import { seedDocument } from './fixtures.js';
const seed = { document: seedDocument };
const bank = importSchema.parse(seed.document).questions;
const single = bank.find((q) => q.type === 'SINGLE_CHOICE')!;
const multi = bank.find((q) => q.type === 'MULTIPLE_CHOICE')!;
const weighted = bank.find((q) => q.type === 'WEIGHTED_CHOICE')!;
const correct = (q: Question) =>
  q.options.filter((o) => 'isCorrect' in o && o.isCorrect).map((o) => o.id);
describe('scoring/v1', () => {
  it('validates all seed questions', () =>
    expect(bank).toHaveLength(seedDocument.questions.length));
  it('scores a single answer and skipped negatives', () => {
    expect(evaluate(single, correct(single), 'MEDIUM').points).toBe(2);
    expect(evaluate(single, [], 'COMPETITIVE')).toMatchObject({ outcome: 'SKIPPED', points: -2 });
  });
  it('supports exact and partial multi answers', () => {
    expect(evaluate(multi, correct(multi), 'MEDIUM').outcome).toBe('CORRECT');
    expect(evaluate(multi, correct(multi).slice(0, 1), 'MEDIUM')).toMatchObject({
      outcome: 'PARTIAL',
      points: 1,
    });
  });
  it('penalizes distractors instead of rewarding select-all', () => {
    expect(multipleQuality(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(0);
    expect(multipleQuality(['a', 'b'], ['a'])).toBe(0.5);
    expect(multipleQuality(['a', 'b'], ['a', 'a'])).toBe(0.5);
  });
  it('scores weighted quality independent of mode', () => {
    const best = weighted.options.find((o) => 'quality' in o && o.quality === 'BEST')!;
    const strong = weighted.options.find((o) => 'quality' in o && o.quality === 'STRONG')!;
    expect(evaluate(weighted, [best.id], 'COMPETITIVE').points).toBe(7);
    expect(evaluate(weighted, [strong.id], 'MEDIUM')).toMatchObject({
      outcome: 'STRONG',
      points: 2,
    });
  });
  it('normalizes negative raw scores to zero and perfect to 100', () => {
    expect(score([single], [[]], 'COMPETITIVE')).toMatchObject({
      rawScore: -2,
      normalizedScore: 0,
    });
    expect(score([single], [correct(single)], 'COMPETITIVE').normalizedScore).toBe(100);
    expect(score([], [], 'EASY').normalizedScore).toBe(0);
  });
  it('does not invent accuracy for weighted-only attempts', () =>
    expect(score([weighted], [[]], 'MEDIUM').accuracyPercent).toBeNull());
  it('sanitizes every active question type', () => {
    for (const q of bank) {
      const text = JSON.stringify(publicQuestion('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', q));
      for (const key of ['isCorrect', 'quality', 'points', 'weight', 'explanation'])
        expect(text).not.toContain(`"${key}"`);
    }
  });
  it('rejects cross-type metadata and duplicate keys', () => {
    const malformed = structuredClone(seed.document);
    Object.assign(malformed.questions[0]!.options[0]!, { quality: 'BEST' });
    expect(importSchema.safeParse(malformed).success).toBe(false);
    expect(importSchema.safeParse({ schemaVersion: 1, questions: [single, single] }).success).toBe(
      false,
    );
  });
});
describe('XP and rating', () => {
  it('awards performance-weighted XP with caps and integrity', () => {
    expect(awardXp(10, 100, 'EASY', 100, true)).toBe(50);
    expect(awardXp(10, 100, 'COMPETITIVE', 100, true)).toBe(75);
    expect(awardXp(10, 100, 'COMPETITIVE', 100, false)).toBe(0);
    expect(awardXp(10, 0, 'EASY', 100, true)).toBeLessThan(10);
  });
  it.each([
    [90, 1],
    [89, 0.9],
    [75, 0.9],
    [74, 0.7],
    [60, 0.7],
    [59, 0],
  ])('integrity %s maps to %s', (integrity, multiplier) =>
    expect(integrityMultiplier(integrity!)).toBe(multiplier),
  );
  it('updates a new rating with strong competitive performance', () =>
    expect(rate(1000, 0, 100, 'COMPETITIVE', true).delta).toBeGreaterThan(30));
  it('high-rated easy users earn little; poor performance loses rating', () => {
    expect(rate(2500, 40, 100, 'EASY', true).delta).toBe(0);
    expect(rate(1000, 0, 0, 'MEDIUM', true).delta).toBe(-24);
    expect(rate(0, 0, 0, 'COMPETITIVE', true).after).toBeGreaterThanOrEqual(0);
    expect(rate(3000, 0, 100, 'COMPETITIVE', true).after).toBeLessThanOrEqual(3000);
    expect(rate(1000, 0, 100, 'EASY', false).delta).toBe(0);
  });
});
const event = (
  type: IntegrityEvent['type'],
  sequence: number,
  seconds = 0,
  durationMs?: number,
): IntegrityEvent => ({
  type,
  sequence,
  serverReceivedAt: new Date(Date.UTC(2026, 8, 28, 0, 0, seconds)).toISOString(),
  ...(durationMs === undefined ? {} : { durationMs }),
});
describe('integrity and UTC policies', () => {
  it('coalesces blur and tab signals while retaining critical auto-submit', () => {
    expect(assessIntegrity([event('WINDOW_BLUR', 1), event('TAB_HIDDEN', 2)], 'EASY').score).toBe(
      97,
    );
    expect(
      assessIntegrity([event('WINDOW_BLUR', 1), event('TAB_HIDDEN', 2)], 'COMPETITIVE'),
    ).toMatchObject({ autoSubmit: true, eligible: false });
  });
  it('ignores duplicate sequence and tiny speech; escalates sustained speech', () => {
    expect(assessIntegrity([event('SPEECH_ACTIVITY', 1, 0, 200)], 'COMPETITIVE').score).toBe(100);
    expect(
      assessIntegrity([event('WINDOW_BLUR', 1), event('WINDOW_BLUR', 1, 10)], 'EASY').score,
    ).toBe(97);
    expect(
      assessIntegrity(
        [0, 10, 20].map((s, i) => event('SPEECH_ACTIVITY', i, s, 4000)),
        'COMPETITIVE',
      ),
    ).toMatchObject({ autoSubmit: true, eligible: false });
  });
  it('computes consecutive days and UTC Monday quota boundaries', () => {
    expect(
      streak(['2026-09-26', '2026-09-27', '2026-09-27'], new Date('2026-09-28T12:00Z')),
    ).toEqual({ current: 2, longest: 2, activeDays: 2 });
    expect(quotaBounds(new Date('2026-09-27T23:59:59Z')).week.toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
  it('selects the configured count without duplicating selections', () => {
    const pool = bank
      .filter((q) => q.topicSlug === 'javascript')
      .map((content, i) => ({ id: String(i), content }));
    expect(
      new Set(selectQuestions(pool, policies.COMPETITIVE, new Set(['0', '1'])).map((q) => q.id))
        .size,
    ).toBe(policies.COMPETITIVE.questionCount);
  });
});
