import { importSchema } from '../src/modules/questions/schema.js';
export const seedDocument = importSchema.parse({
  schemaVersion: 1,
  questions: ['javascript', 'communication'].flatMap((topicSlug) =>
    ['FOUNDATIONAL', 'INTERMEDIATE', 'ADVANCED'].flatMap((difficulty) =>
      Array.from({ length: 12 }, (_, i) => ({
        questionKey: `fixture-${topicSlug}-${difficulty.toLowerCase()}-${i}`,
        version: 1,
        topicSlug,
        category: topicSlug === 'javascript' ? 'TECHNICAL' : 'INTERPERSONAL',
        difficulty,
        prompt: `Synthetic fixture ${topicSlug} ${difficulty} ${i}: pick the marked token.`,
        explanation: 'Synthetic grading fixture; not educational content.',
        tags: ['fixture'],
        estimatedTimeSeconds: 30,
        status: 'PUBLISHED',
        ...(topicSlug === 'communication'
          ? {
              type: 'WEIGHTED_CHOICE',
              options: [
                { id: 'a', text: 'Token A', quality: 'BEST' },
                { id: 'b', text: 'Token B', quality: 'STRONG' },
                { id: 'c', text: 'Token C', quality: 'ACCEPTABLE' },
                { id: 'd', text: 'Token D', quality: 'WEAK' },
              ],
            }
          : {
              type: i % 2 ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE',
              options: [
                { id: 'a', text: 'Token A', isCorrect: true },
                { id: 'b', text: 'Token B', isCorrect: Boolean(i % 2) },
                { id: 'c', text: 'Token C', isCorrect: false },
                { id: 'd', text: 'Token D', isCorrect: false },
              ],
            }),
      })),
    ),
  ),
});
