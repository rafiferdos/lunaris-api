import { z } from 'zod';
import { DomainError } from './errors.js';
export const cursorSchema = z.string().max(2048).optional();
export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor<T>(value: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!value) return;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new DomainError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
  }
}
