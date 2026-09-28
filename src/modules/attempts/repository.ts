import { and,eq,sql,asc } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { attempts,attemptQuestions,answers,integrityEvents } from '../../db/schema/domain.js';
import { assert } from '../../core/errors.js';
export async function lockUser(tx:Transaction,userId:string){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId},0))`);}
export async function ownedAttempt(tx:Transaction,userId:string,id:string){const [attempt]=await tx.select().from(attempts).where(and(eq(attempts.id,id),eq(attempts.userId,userId))).for('update');assert(attempt,404,'ATTEMPT_NOT_FOUND','Attempt not found.');return attempt;}
export async function attemptContent(tx:Transaction,id:string){const rows=await tx.select({question:attemptQuestions,answer:answers}).from(attemptQuestions).leftJoin(answers,eq(answers.attemptQuestionId,attemptQuestions.id)).where(eq(attemptQuestions.attemptId,id)).orderBy(asc(attemptQuestions.position));const events=await tx.select().from(integrityEvents).where(eq(integrityEvents.attemptId,id));return {rows,events:events.map(e=>e.event)};}
