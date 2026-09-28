import { z } from '@hono/zod-openapi';
export const modeSchema = z.enum(['EASY', 'MEDIUM', 'COMPETITIVE']);
export const categorySchema = z.enum(['TECHNICAL', 'INTERPERSONAL']);
export const difficultySchema = z.enum(['FOUNDATIONAL', 'INTERMEDIATE', 'ADVANCED']);
export const qualitySchema = z.enum(['BEST', 'STRONG', 'ACCEPTABLE', 'WEAK']);
const option = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  text: z.string().trim().min(1).max(4000),
});
const common = {
  questionKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,100}$/),
  version: z.number().int().min(1),
  topicSlug: z.string().regex(/^[a-z0-9-]{2,80}$/),
  category: categorySchema,
  difficulty: difficultySchema,
  prompt: z.string().trim().min(5).max(8000),
  context: z.string().max(12000).optional(),
  code: z.string().max(20000).optional(),
  language: z.string().max(40).optional(),
  explanation: z.string().min(1).max(12000),
  tags: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  estimatedTimeSeconds: z.number().int().min(5).max(1800),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
};
export const questionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...common,
      type: z.literal('SINGLE_CHOICE'),
      options: z
        .array(option.extend({ isCorrect: z.boolean() }))
        .min(2)
        .max(8),
    }),
    z.strictObject({
      ...common,
      type: z.literal('MULTIPLE_CHOICE'),
      options: z
        .array(option.extend({ isCorrect: z.boolean() }))
        .min(2)
        .max(8),
    }),
    z.strictObject({
      ...common,
      type: z.literal('WEIGHTED_CHOICE'),
      options: z
        .array(option.extend({ quality: qualitySchema }))
        .min(2)
        .max(8),
    }),
  ])
  .superRefine((q, c) => {
    if (new Set(q.options.map((o) => o.id)).size !== q.options.length)
      c.addIssue({ code: 'custom', path: ['options'], message: 'Option IDs must be unique.' });
    if (q.type === 'SINGLE_CHOICE' && q.options.filter((o) => o.isCorrect).length !== 1)
      c.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Exactly one correct option is required.',
      });
    if (
      q.type === 'MULTIPLE_CHOICE' &&
      (!q.options.some((o) => o.isCorrect) || q.options.every((o) => o.isCorrect))
    )
      c.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Include at least one correct option and one distractor.',
      });
    if (q.type === 'WEIGHTED_CHOICE' && !q.options.some((o) => o.quality === 'BEST'))
      c.addIssue({ code: 'custom', path: ['options'], message: 'Include a BEST response.' });
    if (q.language && !q.code)
      c.addIssue({
        code: 'custom',
        path: ['language'],
        message: 'Language requires a code snippet.',
      });
  });
export const importSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    questions: z.array(questionSchema).min(1).max(1000),
  })
  .superRefine((v, c) => {
    const seen = new Set<string>();
    v.questions.forEach((q, i) => {
      const key = `${q.questionKey}:${q.version}`;
      if (seen.has(key))
        c.addIssue({
          code: 'custom',
          path: ['questions', i, 'questionKey'],
          message: 'Duplicate questionKey/version.',
        });
      seen.add(key);
    });
  });
export type Question = z.infer<typeof questionSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type Category = z.infer<typeof categorySchema>;
export const publicQuestionSchema = z.object({
  id: z.uuid(),
  type: z.enum(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'WEIGHTED_CHOICE']),
  prompt: z.string(),
  context: z.string().optional(),
  code: z.string().optional(),
  language: z.string().optional(),
  options: z.array(option),
  tags: z.array(z.string()),
  difficulty: difficultySchema,
});
export function publicQuestion(id: string, q: Question) {
  return publicQuestionSchema.parse({
    id,
    type: q.type,
    prompt: q.prompt,
    context: q.context,
    code: q.code,
    language: q.language,
    options: q.options.map(({ id, text }) => ({ id, text })),
    tags: q.tags,
    difficulty: q.difficulty,
  });
}
