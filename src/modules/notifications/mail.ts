import nodemailer from 'nodemailer';
import type { Config } from '../../config/env.js';
import { createHash } from 'node:crypto';
export function passwordRecoveryEnabled(config: Config) {
  return !!(
    config.EMAIL_FROM &&
    (config.RESEND_API_KEY || (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD))
  );
}
export type Mail = {
  to: string;
  subject: string;
  text: string;
  key: string;
  headers?: Record<string, string>;
};
export class MailDeliveryError extends Error {
  constructor(readonly uncertain: boolean) {
    super('Email delivery failed.');
  }
}
export async function sendMail(config: Config, mail: Mail) {
  if (!passwordRecoveryEnabled(config)) throw new Error('Email delivery is not configured.');
  if (config.SMTP_HOST) {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: 465,
      secure: true,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      await transport.sendMail({
        from: config.EMAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        headers: mail.headers,
        messageId: `<${createHash('sha256').update(mail.key).digest('hex')}@${new URL(config.FRONTEND_ORIGIN).hostname}>`,
      });
    } catch {
      throw new MailDeliveryError(true);
    } finally {
      transport.close();
    }
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': mail.key,
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.headers ? { headers: mail.headers } : {}),
    }),
  });
  if (!response.ok) throw new Error('Email delivery failed.');
}
export async function sendPasswordReset(config: Config, email: string, token: string) {
  const url = new URL('/reset-password', config.FRONTEND_ORIGIN);
  url.searchParams.set('token', token);
  await sendMail(config, {
    to: email,
    key: `password-reset-${createHash('sha256').update(token).digest('hex')}`,
    subject: 'Reset your Lunaris password',
    text: `Reset your password using this one-time link, valid for one hour:\n\n${url.href}\n\nIf you did not request this, you can ignore this message.`,
  });
}
export async function sendEmailVerification(
  config: Config,
  email: string,
  verificationUrl: string,
) {
  const url = new URL(verificationUrl);
  // The browser uses the frontend API proxy so cookies always stay on the app host.
  const publicUrl = new URL(url.pathname + url.search, config.FRONTEND_ORIGIN);
  publicUrl.searchParams.set(
    'callbackURL',
    new URL('/login?verified=success', config.FRONTEND_ORIGIN).href,
  );
  await sendMail(config, {
    to: email,
    key: `verify-email-${createHash('sha256')
      .update(url.searchParams.get('token') ?? '')
      .digest('hex')}`,
    subject: 'Verify your Lunaris email',
    text: `Verify your email address to finish setting up your Lunaris account:\n\n${publicUrl.href}\n\nIf you did not sign up, you can ignore this message.`,
  });
}
