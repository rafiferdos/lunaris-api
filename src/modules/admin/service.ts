import { createHash } from 'node:crypto';
import { and, eq, inArray, desc, lt, or } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import { questions, topics, importBatches, auditLogs, configs } from '../../db/schema/domain.js';
import { importSchema, type Question } from '../questions/schema.js';
import { policySchema } from '../assessments/policy.js';
import { assert, DomainError } from '../../core/errors.js';
import { decodeCursor, encodeCursor } from '../../core/cursor.js';
import { z } from 'zod';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const contentHash = (q: unknown) => createHash('sha256').update(canonical(q)).digest('hex');
function questionKeyAt(document: unknown, index: number | null): string | null {
  if (
    index === null ||
    !document ||
    typeof document !== 'object' ||
    !('questions' in document) ||
    !Array.isArray(document.questions)
  )
    return null;
  const value: unknown = document.questions[index];
  return value &&
    typeof value === 'object' &&
    'questionKey' in value &&
    typeof value.questionKey === 'string'
    ? value.questionKey
    : null;
}
export function createAdminService(db: Database) {
  async function inspect(tx: Database | Transaction, document: unknown) {
    const parsed = importSchema.safeParse(document);
    if (!parsed.success)
      return {
        valid: false,
        created: 0,
        alreadyExists: 0,
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
          questionIndex: typeof i.path[1] === 'number' ? i.path[1] : null,
          questionKey: questionKeyAt(document, typeof i.path[1] === 'number' ? i.path[1] : null),
        })),
        records: [] as { question: Question; topicId: string; hash: string; exists: boolean }[],
      };
    const topicRows = await tx
      .select()
      .from(topics)
      .where(inArray(topics.slug, [...new Set(parsed.data.questions.map((q) => q.topicSlug))]));
    const existing = await tx
      .select()
      .from(questions)
      .where(
        inArray(questions.questionKey, [
          ...new Set(parsed.data.questions.map((q) => q.questionKey)),
        ]),
      );
    const errors: {
      path: string;
      code: string;
      message: string;
      questionKey: string | null;
      questionIndex: number | null;
    }[] = [];
    const records: { question: Question; topicId: string; hash: string; exists: boolean }[] = [];
    parsed.data.questions.forEach((q, i) => {
      const topic = topicRows.find((t) => t.slug === q.topicSlug),
        hash = contentHash(q);
      const old = existing.find(
        (row) => row.questionKey === q.questionKey && row.version === q.version,
      );
      if (!topic || topic.category !== q.category)
        errors.push({
          path: `questions.${i}.topicSlug`,
          questionIndex: i,
          questionKey: q.questionKey,
          code: 'UNKNOWN_TOPIC_OR_CATEGORY',
          message: `${q.questionKey}: topic/category mismatch.`,
        });
      if (old && old.contentHash !== hash)
        errors.push({
          path: `questions.${i}.version`,
          questionIndex: i,
          questionKey: q.questionKey,
          code: 'CONFLICTING_VERSION',
          message: `${q.questionKey}: existing version has different content. Create a new version.`,
        });
      if (topic) records.push({ question: q, topicId: topic.id, hash, exists: !!old });
    });
    return {
      valid: errors.length === 0,
      created: records.filter((r) => !r.exists).length,
      alreadyExists: records.filter((r) => r.exists).length,
      errors,
      records,
    };
  }
  return {
    async validate(document: unknown) {
      const report = await inspect(db, document);
      return {
        valid: report.valid,
        created: report.created,
        alreadyExists: report.alreadyExists,
        errors: report.errors,
      };
    },
    async import(adminId: string | null, document: unknown) {
      return db.transaction(async (tx) => {
        await tx.execute(
          (await import('drizzle-orm'))
            .sql`select pg_advisory_xact_lock(hashtextextended('question-import',0))`,
        );
        const report = await inspect(tx, document);
        if (!report.valid)
          throw new DomainError(
            422,
            'INVALID_IMPORT',
            'The entire batch was rejected.',
            report.errors,
          );
        const rows = report.records.filter((r) => !r.exists);
        if (rows.length)
          await tx.insert(questions).values(
            rows.map(({ question: q, topicId, hash }) => ({
              topicId,
              questionKey: q.questionKey,
              version: q.version,
              difficulty: q.difficulty,
              status: q.status,
              content: q,
              contentHash: hash,
            })),
          );
        const [batch] = await tx
          .insert(importBatches)
          .values({
            adminId,
            hash: contentHash(document),
            created: report.created,
            existing: report.alreadyExists,
          })
          .returning();
        await tx.insert(auditLogs).values({
          adminId,
          action: 'QUESTION_IMPORT',
          target: batch!.id,
          metadata: { created: report.created, alreadyExists: report.alreadyExists },
        });
        return { batchId: batch!.id, created: report.created, alreadyExists: report.alreadyExists };
      });
    },
    async publication(adminId: string, id: string, status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED') {
      return db.transaction(async (tx) => {
        const [old] = await tx.select().from(questions).where(eq(questions.id, id)).for('update');
        assert(old, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
        assert(
          status !== 'DRAFT' || old.status === 'DRAFT',
          409,
          'IMMUTABLE_VERSION',
          'Published versions cannot return to draft.',
        );
        const [updated] = await tx
          .update(questions)
          .set({ status })
          .where(eq(questions.id, id))
          .returning();
        await tx.insert(auditLogs).values({
          adminId,
          action: `QUESTION_${status}`,
          target: id,
          metadata: { previousStatus: old.status },
        });
        return { id: updated!.id, status: updated!.status };
      });
    },
    async configure(adminId: string, id: string, input: unknown) {
      const policy = policySchema.parse(input);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(configs)
          .set({ policy, updatedAt: new Date() })
          .where(eq(configs.id, id))
          .returning();
        assert(row, 404, 'CONFIG_NOT_FOUND', 'Assessment config not found.');
        await tx
          .insert(auditLogs)
          .values({ adminId, action: 'CONFIG_UPDATE', target: id, metadata: { policy } });
        return row;
      });
    },
    async list(limit: number, cursor?: string) {
      const c = decodeCursor(cursor, z.object({ at: z.iso.datetime(), id: z.uuid() }));
      const rows = await db
        .select()
        .from(questions)
        .where(
          c
            ? or(
                lt(questions.createdAt, new Date(c.at)),
                and(eq(questions.createdAt, new Date(c.at)), lt(questions.id, c.id)),
              )
            : undefined,
        )
        .orderBy(desc(questions.createdAt), desc(questions.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit),
        last = page.at(-1);
      return {
        data: page.map((q) => ({ id: q.id, question: q.content, status: q.status })),
        meta: {
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
              : null,
        },
      };
    },
    async audit(limit: number, cursor?: string) {
      const c = decodeCursor(cursor, z.object({ at: z.iso.datetime(), id: z.uuid() }));
      const rows = await db
        .select()
        .from(auditLogs)
        .where(
          c
            ? or(
                lt(auditLogs.createdAt, new Date(c.at)),
                and(eq(auditLogs.createdAt, new Date(c.at)), lt(auditLogs.id, c.id)),
              )
            : undefined,
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit + 1);
      const last = rows[Math.min(limit, rows.length) - 1];
      return {
        data: rows.slice(0, limit),
        meta: {
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
              : null,
        },
      };
    },
  };
}
