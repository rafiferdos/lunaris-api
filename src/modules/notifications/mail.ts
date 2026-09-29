import type { Config } from '../../config/env.js';
import { createHash } from 'node:crypto';
export function passwordRecoveryEnabled(config: Config) {
  return !!(config.RESEND_API_KEY && config.EMAIL_FROM);
}
export async function sendPasswordReset(config: Config, email: string, token: string) {
  const url = new URL('/reset-password', config.FRONTEND_ORIGIN);
  url.searchParams.set('token', token);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `password-reset-${createHash('sha256').update(token).digest('hex')}`,
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [email],
      subject: 'Reset your Lunaris password',
      text: `Reset your password using this one-time link, valid for one hour:\n\n${url.href}\n\nIf you did not request this, you can ignore this message.`,
    }),
  });
  if (!response.ok) throw new Error('Password recovery delivery failed.');
}
