import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { user } from '../../db/schema/auth.js';
import {
  notificationJobs as jobs,
  notificationSubscriptions as subscriptions,
} from '../../db/schema/domain.js';
import { passwordRecoveryEnabled, sendMail, MailDeliveryError, type Mail } from './mail.js';
import { assert, DomainError } from '../../core/errors.js';
const signedPayload = z.object({
  userId: z.uuid(),
  kind: z.enum(['summary', 'reminder']),
  expires: z.number().int(),
});
export function unsubscribeToken(
  config: Config,
  userId: string,
  kind: 'summary' | 'reminder',
  now: Date,
) {
  const payload = Buffer.from(
    JSON.stringify({ userId, kind, expires: now.getTime() + 90 * 86400000 }),
  ).toString('base64url');
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET)
    .update(`notifications:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}
export function readUnsubscribeToken(config: Config, token: string, now: Date) {
  assert(token.length < 2048, 400, 'INVALID_TOKEN', 'This unsubscribe link is invalid.');
  const [payload = '', signature = '', extra] = token.split('.');
  const expected = createHmac('sha256', config.BETTER_AUTH_SECRET)
    .update(`notifications:${payload}`)
    .digest();
  const received = Buffer.from(signature, 'base64url');
  assert(
    !extra && expected.length === received.length && timingSafeEqual(expected, received),
    400,
    'INVALID_TOKEN',
    'This unsubscribe link is invalid.',
  );
  let parsed: z.infer<typeof signedPayload>;
  try {
    parsed = signedPayload.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  } catch {
    throw new DomainError(400, 'INVALID_TOKEN', 'This unsubscribe link is invalid.');
  }
  assert(
    parsed.expires > now.getTime(),
    400,
    'EXPIRED_TOKEN',
    'This unsubscribe link expired. Update your preferences in Settings.',
  );
  return parsed;
}
export function notificationDeliveryEnabled(config: Config) {
  // Vercel runs the authenticated daily job; Node also runs its own worker.
  return passwordRecoveryEnabled(config) && !!config.CRON_SECRET;
}
export function createNotificationService(
  db: Database,
  config: Config,
  clock: () => Date = () => new Date(),
  deliver: (mail: Mail) => Promise<void> = (mail) => sendMail(config, mail),
) {
  async function enqueue() {
    const now = clock();
    const week = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
    const start = new Date(week.getTime() - 7 * 86400000);
    const cutoff = new Date(now.getTime() - 3 * 86400000);
    // Bounded batches allow future worker invocations to catch up without loading every account.
    const candidates = await db.execute<{
      user_id: string;
      email: string;
      summaries_at: Date | null;
      reminders_at: Date | null;
      completed: string;
      latest: Date | null;
    }>(sql`
      select s.user_id, u.email, s.summaries_at, s.reminders_at,
        (select count(*) from attempts a where a.user_id=u.id and a.submitted_at >= ${start} and a.submitted_at < ${week} and a.status in ('SUBMITTED','AUTO_SUBMITTED'))::text as completed,
        (select max(a.submitted_at) from attempts a where a.user_id=u.id and a.status in ('SUBMITTED','AUTO_SUBMITTED')) as latest
      from notification_subscriptions s join "user" u on u.id=s.user_id
      where u.email_verified = true and (
        (s.summaries_at <= ${week} and not exists (select 1 from notification_jobs j where j.user_id=u.id and j.kind='summary' and j.period=${week.toISOString()})) or
        (s.reminders_at <= ${cutoff} and u.created_at <= ${cutoff} and not exists (select 1 from attempts a where a.user_id=u.id and a.status in ('SUBMITTED','AUTO_SUBMITTED') and a.submitted_at > ${cutoff}) and not exists (select 1 from notification_jobs j where j.user_id=u.id and j.kind='reminder' and j.period=${week.toISOString()}))
      ) order by s.user_id limit 100`);
    for (const candidate of candidates.rows) {
      for (const kind of ['summary', 'reminder'] as const) {
        const consent = kind === 'summary' ? candidate.summaries_at : candidate.reminders_at;
        if (!consent || new Date(consent) > (kind === 'summary' ? week : cutoff)) continue;
        if (kind === 'reminder' && candidate.latest && new Date(candidate.latest) > cutoff)
          continue;
        const token = unsubscribeToken(config, candidate.user_id, kind, now);
        const optOut = new URL('/unsubscribe', config.FRONTEND_ORIGIN);
        optOut.searchParams.set('token', token);
        const text =
          kind === 'summary'
            ? `Your Lunaris week (${start.toISOString().slice(0, 10)} to ${new Date(week.getTime() - 86400000).toISOString().slice(0, 10)}):\n\nYou completed ${Number(candidate.completed)} assessment${Number(candidate.completed) === 1 ? '' : 's'}. See your scores and progress: ${config.FRONTEND_ORIGIN}/stats`
            : `A little practice, at your pace. It has been at least three days since your last completed assessment. Choose a topic whenever you are ready: ${config.FRONTEND_ORIGIN}/assessments`;
        await db
          .insert(jobs)
          .values({
            userId: candidate.user_id,
            kind,
            period: week.toISOString(),
            createdAt: now,
            nextAt: now,
            payload: {
              email: candidate.email,
              subject:
                kind === 'summary'
                  ? 'Your weekly Lunaris progress'
                  : 'Make a little time for practice',
              text: `${text}\n\nYou opted in through Lunaris Settings. Unsubscribe: ${optOut.href}`,
            },
          })
          .onConflictDoNothing();
      }
    }
  }
  async function drain(limit: number) {
    let sent = 0,
      failed = 0,
      cancelled = 0;
    for (let i = 0; i < limit; i++) {
      const now = clock(),
        lease = randomUUID();
      const claimed = await db.execute<{ id: string }>(sql`
        update notification_jobs set status='processing', lease=${lease}::uuid, lease_until=${new Date(now.getTime() + 60000)}, tries=tries+1
        where id=(select id from notification_jobs where
          (status='pending' and next_at <= ${now}) or (status='processing' and lease_until < ${now})
          order by next_at, id for update skip locked limit 1)
        returning id`);
      const id = claimed.rows[0]?.id;
      if (!id) break;
      const [job] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.lease, lease)));
      if (!job) continue;
      const [recipient] = await db.select().from(user).where(eq(user.id, job.userId));
      const [consent] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, job.userId));
      const optedAt = job.kind === 'summary' ? consent?.summariesAt : consent?.remindersAt;
      // Never retry beyond the provider's 24-hour idempotency window.
      const expired = now.getTime() - job.createdAt.getTime() >= 23 * 3600000;
      const uncertainSmtpRetry = !!config.SMTP_HOST && job.tries > 1;
      const staleConsent =
        !optedAt ||
        optedAt > job.createdAt ||
        !recipient?.emailVerified ||
        recipient.email !== job.payload.email;
      if (staleConsent || expired || uncertainSmtpRetry || job.tries > 5) {
        await db
          .update(jobs)
          .set({ status: staleConsent ? 'cancelled' : 'failed', lease: null, leaseUntil: null })
          .where(and(eq(jobs.id, id), eq(jobs.lease, lease)));
        if (staleConsent) cancelled++;
        else failed++;
        continue;
      }
      const token = unsubscribeToken(config, job.userId, job.kind, job.createdAt);
      const oneClick = new URL('/api/notifications/unsubscribe', config.FRONTEND_ORIGIN);
      oneClick.searchParams.set('token', token);
      try {
        await deliver({
          to: job.payload.email,
          subject: job.payload.subject,
          text: job.payload.text,
          key: `notification-${id}`,
          headers: {
            'List-Unsubscribe': `<${oneClick.href}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        await db
          .update(jobs)
          .set({ status: 'sent', sentAt: clock(), lease: null, leaseUntil: null })
          .where(and(eq(jobs.id, id), eq(jobs.lease, lease)));
        sent++;
      } catch (error) {
        // SMTP cannot promise idempotent retries after an ambiguous send; retain a failed job for review.
        const terminal = job.tries >= 5 || (error instanceof MailDeliveryError && error.uncertain);
        await db
          .update(jobs)
          .set({
            status: terminal ? 'failed' : 'pending',
            nextAt: new Date(clock().getTime() + Math.min(60, 2 ** job.tries) * 60000),
            lease: null,
            leaseUntil: null,
          })
          .where(and(eq(jobs.id, id), eq(jobs.lease, lease)));
        failed++;
      }
    }
    return { sent, failed, cancelled };
  }
  return {
    async run(limit = 20) {
      if (!notificationDeliveryEnabled(config))
        return { enabled: false, sent: 0, failed: 0, cancelled: 0 };
      await enqueue();
      // Purge delivery addresses/body after retention; consent and prefs stay intact.
      await db.delete(jobs).where(lt(jobs.createdAt, new Date(clock().getTime() - 90 * 86400000)));
      return { enabled: true, ...(await drain(Math.max(1, Math.min(20, limit)))) };
    },
    async unsubscribe(token: string) {
      const payload = readUnsubscribeToken(config, token, clock());
      await db
        .update(subscriptions)
        .set(payload.kind === 'summary' ? { summariesAt: null } : { remindersAt: null })
        .where(eq(subscriptions.userId, payload.userId));
      // Pending jobs are checked again before delivery, including concurrently claimed jobs.
    },
  };
}
