import { describe, it, expect } from 'vitest';
import { importSchema, publicQuestion } from '../src/modules/questions/schema.js';
import { seedDocument } from './fixtures.js';
import { policies } from '../src/modules/assessments/policy.js';
import {
  difficultyTargets,
  hasCoverage,
  selectQuestions,
} from '../src/modules/assessments/selection.js';
import { evaluate, score, scoring } from '../src/modules/scoring/v1.js';
describe('difficulty and grading invariants', () => {
  it('apportions fractional weights exactly and never includes a zero-weight level', () => {
    expect(
      difficultyTargets({
        ...policies.EASY,
        questionCount: 7,
        distribution: { FOUNDATIONAL: 1, INTERMEDIATE: 1, ADVANCED: 0 },
      }),
    ).toEqual({ FOUNDATIONAL: 4, INTERMEDIATE: 3, ADVANCED: 0 });
    expect(hasCoverage({ FOUNDATIONAL: 100 }, policies.MEDIUM)).toBe(false);
  });
  it('rejects difficulty shortages rather than substituting easier questions', () => {
    const pool = seedDocument.questions
      .filter((q) => q.topicSlug === 'javascript' && q.difficulty === 'FOUNDATIONAL')
      .map((content) => ({ id: content.questionKey, content }));
    expect(() => selectQuestions(pool, policies.COMPETITIVE, new Set())).toThrow(
      'required difficulty',
    );
  });
  it('keeps exact difficulty ratios and prefers unseen questions within each level', () => {
    const pool = seedDocument.questions
      .filter((q) => q.topicSlug === 'javascript')
      .map((content) => ({ id: content.questionKey, content }));
    for (const policy of Object.values(policies)) {
      const chosen = selectQuestions(pool, policy, new Set());
      expect(new Set(chosen.map((q) => q.id)).size).toBe(policy.questionCount);
      for (const [difficulty, count] of Object.entries(difficultyTargets(policy))) {
        expect(chosen.filter((q) => q.content.difficulty === difficulty)).toHaveLength(count);
      }
    }
    const chosen = selectQuestions(
      pool,
      policies.EASY,
      new Set(
        pool
          .filter((q) => q.content.difficulty === 'FOUNDATIONAL')
          .slice(0, 4)
          .map((q) => q.id),
      ),
    );
    expect(
      chosen
        .filter((q) => q.content.difficulty === 'FOUNDATIONAL')
        .some((q) => q.content.questionKey.endsWith('-0')),
    ).toBe(false);
  });
  it('covers every option, skip, full credit and minimum in every grading mode', () => {
    for (const q of seedDocument.questions)
      for (const mode of ['EASY', 'MEDIUM', 'COMPETITIVE'] as const) {
        const best = q.options
          .filter(
            (o) => ('isCorrect' in o && o.isCorrect) || ('quality' in o && o.quality === 'BEST'),
          )
          .map((o) => o.id);
        expect(score([q], [best], mode).normalizedScore).toBe(100);
        expect(score([q], [[]], mode).normalizedScore).toBe(0);
        for (const option of q.options) {
          const result = evaluate(q, [option.id], mode);
          expect(result.points).toBeGreaterThanOrEqual(result.minimum);
          expect(result.points).toBeLessThanOrEqual(result.maximum);
          if ('quality' in option) expect(result.points).toBe(scoring[mode][option.quality]);
        }
      }
  });
  it('validates provenance without leaking source explanations into active assessments', () => {
    const q = {
      ...seedDocument.questions[0]!,
      provenance: {
        collectionId: 'test-source',
        authorship: 'ORIGINAL_SOURCE_BASED',
        sources: [
          {
            url: 'https://developer.mozilla.org/',
            title: 'MDN reference',
            accessedOn: '2026-10-06',
          },
        ],
        learningObjective: 'Distinguish marked synthetic tokens.',
        difficultyRationale: 'Recognition of a single synthetic rule.',
      },
    };
    const document = importSchema.parse({ schemaVersion: 1, questions: [q] });
    expect(document.questions[0]!.provenance).toEqual(q.provenance);
    expect(
      publicQuestion('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', document.questions[0]!),
    ).not.toHaveProperty('provenance');
    q.provenance.sources[0]!.url = 'http://example.com';
    expect(importSchema.safeParse({ schemaVersion: 1, questions: [q] }).success).toBe(false);
  });
});
