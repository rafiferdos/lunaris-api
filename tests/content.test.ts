import { describe, it, expect } from 'vitest';
import { importSchema } from '../src/modules/questions/schema.js';
import { seedDocument } from '../src/db/seed.js';
import content from '../src/db/content/launch-v1.json' with { type: 'json' };
import seed from '../src/db/seed-data.json' with { type: 'json' };
import { policies } from '../src/modules/assessments/policy.js';
import { selectQuestions } from '../src/modules/assessments/selection.js';
describe('launch content coverage', () => {
  const bank = importSchema.parse({
    schemaVersion: 1,
    questions: [...seedDocument.questions, ...content.questions],
  }).questions;
  it('validates 285 immutable versioned questions and distinct scenarios', () => {
    expect(bank).toHaveLength(285);
    expect(new Set(bank.map((q) => `${q.topicSlug}:${q.prompt}:${q.context ?? ''}`)).size).toBe(
      bank.length,
    );
  });
  it('provides enough difficulty coverage and unique question IDs for every topic and mode', () => {
    for (const topic of seed.topics) {
      const pool = bank
        .filter((q) => q.topicSlug === topic.slug)
        .map((q) => ({ id: q.questionKey, content: q }));
      for (const policy of Object.values(policies)) {
        const chosen = selectQuestions(pool, policy, new Set());
        expect(chosen).toHaveLength(policy.questionCount);
        expect(new Set(chosen.map((q) => q.id)).size).toBe(policy.questionCount);
        for (const [difficulty, count] of Object.entries(policy.distribution)) {
          expect(
            pool.filter((q) => q.content.difficulty === difficulty).length,
          ).toBeGreaterThanOrEqual(count);
        }
      }
    }
  });
});
