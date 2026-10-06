// Explicit operator import. The external document is never part of the runtime bundle.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { loadConfig } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { topics, questions, configs, auditLogs } from '../src/db/schema/domain.js';
import { createAdminService, contentHash } from '../src/modules/admin/service.js';
import { importSchema, type Question } from '../src/modules/questions/schema.js';
import { policies } from '../src/modules/assessments/policy.js';
import {
  difficultyTargets,
  hasCoverage,
  selectQuestions,
} from '../src/modules/assessments/selection.js';
import { score, evaluate } from '../src/modules/scoring/v1.js';
import assert from 'node:assert/strict';
const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL);
const filepath = process.env.QUESTION_IMPORT_FILE ?? process.argv[2];
const id = process.env.QUESTION_COLLECTION_ID;
try {
  if (filepath) {
    if (config.NODE_ENV === 'production')
      assert.equal(
        process.env.VERCEL_ENV,
        'production',
        'Production imports require an explicit production operator deployment.',
      );
    const path = resolve(filepath);
    assert.ok(
      !path.split('/').includes('public'),
      'Do not put private question documents in public assets.',
    );
    const bytes = await readFile(path);
    assert.ok(bytes.length <= 8 * 1024 * 1024, 'Import document is too large.');
    const envelope = z
      .strictObject({
        collectionId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,100}$/),
        expectedPerDifficulty: z.number().int().min(10).max(100),
        legacyQuestionKeys: z.array(z.string()).max(1000),
        document: importSchema,
      })
      .parse(JSON.parse(bytes.toString('utf8')));
    const bank = envelope.document.questions;
    const catalog = await db.select().from(topics).where(eq(topics.active, true));
    assert.equal(
      new Set(bank.map((q) => q.topicSlug)).size,
      catalog.length,
      'Every active topic needs coverage.',
    );
    assert.equal(
      new Set(bank.map((q) => q.prompt.trim().toLowerCase())).size,
      bank.length,
      'Duplicate prompts are not allowed.',
    );
    assert.ok(
      bank.every((q) => !envelope.legacyQuestionKeys.includes(q.questionKey)),
      'Legacy and new keys must be disjoint.',
    );
    for (const topic of catalog) {
      const group = bank.filter((q) => q.topicSlug === topic.slug);
      for (const difficulty of ['FOUNDATIONAL', 'INTERMEDIATE', 'ADVANCED'] as const)
        assert.equal(
          group.filter((q) => q.difficulty === difficulty).length,
          envelope.expectedPerDifficulty,
          `${topic.slug}: incomplete ${difficulty} coverage.`,
        );
      for (const q of group) {
        assert.equal(q.category, topic.category);
        assert.equal(
          q.provenance?.collectionId,
          envelope.collectionId,
          'Source provenance is required.',
        );
        assert.ok(q.explanation.trim().length >= 30, 'A useful explanation is required.');
        if (q.type === 'WEIGHTED_CHOICE')
          assert.equal(
            new Set(q.options.map((o) => o.quality)).size,
            4,
            'Scenario rubrics need all four quality bands.',
          );
        for (const mode of ['EASY', 'MEDIUM', 'COMPETITIVE'] as const) {
          const best = q.options
            .filter(
              (o) => ('isCorrect' in o && o.isCorrect) || ('quality' in o && o.quality === 'BEST'),
            )
            .map((o) => o.id);
          assert.equal(score([q], [best], mode).normalizedScore, 100);
          assert.equal(score([q], [[]], mode).normalizedScore, 0);
          for (const option of q.options) {
            const result = evaluate(q, [option.id], mode);
            assert.ok(result.points >= result.minimum && result.points <= result.maximum);
          }
        }
      }
      for (const policy of Object.values(policies)) {
        const selected = selectQuestions(
          group.map((content) => ({ id: content.questionKey, content })),
          policy,
          new Set(),
        );
        assert.equal(new Set(selected.map((q) => q.id)).size, policy.questionCount);
        for (const [difficulty, count] of Object.entries(difficultyTargets(policy)))
          assert.equal(selected.filter((q) => q.content.difficulty === difficulty).length, count);
      }
    }
    // Stage privately, then publish + retire legacy content + upgrade unmodified old defaults atomically.
    const staged = {
      schemaVersion: 1 as const,
      questions: bank.map((q) => ({ ...q, status: 'DRAFT' as const })),
    };
    const imported = await createAdminService(db).import(null, staged);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('question-import',0))`);
      await tx
        .update(questions)
        .set({ status: 'PUBLISHED' })
        .where(inArray(questions.contentHash, staged.questions.map(contentHash)));
      if (envelope.legacyQuestionKeys.length)
        await tx
          .update(questions)
          .set({ status: 'ARCHIVED' })
          .where(
            and(
              inArray(questions.questionKey, envelope.legacyQuestionKeys),
              eq(questions.status, 'PUBLISHED'),
              eq(questions.version, 1),
            ),
          );
      const configRows = await tx.select().from(configs).for('update');
      let upgraded = 0;
      for (const row of configRows) {
        const previous = row.policy;
        const duration = row.mode === 'EASY' ? 600 : row.mode === 'MEDIUM' ? 480 : 360;
        const distribution =
          row.mode === 'EASY'
            ? { FOUNDATIONAL: 4, INTERMEDIATE: 1, ADVANCED: 0 }
            : row.mode === 'MEDIUM'
              ? { FOUNDATIONAL: 1, INTERMEDIATE: 3, ADVANCED: 1 }
              : { FOUNDATIONAL: 0, INTERMEDIATE: 2, ADVANCED: 3 };
        if (
          previous.questionCount === 5 &&
          previous.durationSeconds === duration &&
          contentHash(previous.distribution) === contentHash(distribution)
        ) {
          const policy = {
            ...previous,
            questionCount: policies[row.mode].questionCount,
            durationSeconds: policies[row.mode].durationSeconds,
            distribution: policies[row.mode].distribution,
          };
          await tx
            .update(configs)
            .set({ policy, updatedAt: new Date() })
            .where(eq(configs.id, row.id));
          await tx.insert(auditLogs).values({
            adminId: null,
            action: 'CONFIG_UPDATE',
            target: row.id,
            metadata: {
              reason: 'Expanded source-based content coverage',
              previousPolicy: previous,
              policy,
            },
          });
          upgraded++;
        }
      }
      await tx.insert(auditLogs).values({
        adminId: null,
        action: 'CONTENT_COLLECTION_PUBLISH',
        target: envelope.collectionId,
        metadata: {
          collectionId: envelope.collectionId,
          hash: contentHash(envelope.document),
          questions: bank.length,
          topics: catalog.length,
          perDifficulty: envelope.expectedPerDifficulty,
          retiredKeys: envelope.legacyQuestionKeys.length,
          upgradedConfigs: upgraded,
          originalWording: true,
          schemaVersion: 1,
        },
      });
    });
    console.log(
      JSON.stringify({
        collectionId: envelope.collectionId,
        imported,
        questionCount: bank.length,
        source: 'database',
        legacy: 'archived; historical snapshots preserved',
      }),
    );
  }
  const rows = await db.execute<{
    topic_slug: string;
    question_key: string;
    content: Question;
  }>(sql`
    select t.slug as topic_slug, q.question_key, q.content from (
      select distinct on (question_key) * from questions where status = 'PUBLISHED' order by question_key, version desc
    ) q join topics t on t.id=q.topic_id
    ${id ? sql`where q.content->'provenance'->>'collectionId'=${id}` : sql``}
  `);
  const catalog = await db.select().from(topics).where(eq(topics.active, true));
  const configuration = await db.select().from(configs);
  const coverage = catalog.map((topic) => {
    const bank = rows.rows.filter((q) => q.topic_slug === topic.slug);
    const counts = Object.fromEntries(
      ['FOUNDATIONAL', 'INTERMEDIATE', 'ADVANCED'].map((d) => [
        d,
        bank.filter((q) => q.content.difficulty === d).length,
      ]),
    );
    const modes = configuration
      .filter((c) => c.topicId === topic.id)
      .map((c) => ({
        mode: c.mode,
        count: c.policy.questionCount,
        available: hasCoverage(counts, c.policy),
      }));
    for (const q of bank) importSchema.parse({ schemaVersion: 1, questions: [q.content] });
    return {
      topic: topic.slug,
      ...counts,
      total: bank.length,
      sourced: bank.filter((q) => q.content.provenance).length,
      modes,
    };
  });
  console.log(JSON.stringify({ questionCount: rows.rows.length, coverage }));
} finally {
  await pool.end();
}
