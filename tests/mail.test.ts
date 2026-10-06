import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config/env.js';
import {
  sendMail,
  MailDeliveryError,
  sendEmailVerification,
} from '../src/modules/notifications/mail.js';
const base = {
  DATABASE_URL: 'postgresql://test:test@localhost/lunaris_test',
  BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
  BETTER_AUTH_URL: 'https://lunaris.example',
  FRONTEND_ORIGIN: 'https://lunaris.example',
};
const smtpEnv = {
  ...base,
  EMAIL_FROM: 'sender@gmail.com',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'sender@gmail.com',
  SMTP_PASSWORD: 'test-app-password',
};
const config = loadConfig(smtpEnv);
afterEach(() => vi.restoreAllMocks());
describe('SMTP delivery boundary', () => {
  it('rejects incomplete, mixed-provider and mismatched Gmail configurations', () => {
    expect(() => loadConfig({ ...base, SMTP_PASSWORD: 'partial' })).toThrow();
    expect(() => loadConfig({ ...smtpEnv, EMAIL_FROM: 'other@gmail.com' })).toThrow();
    expect(() => loadConfig({ ...smtpEnv, RESEND_API_KEY: 'test' })).toThrow();
    expect(() => loadConfig({ ...base, EMAIL_FROM: 'sender@gmail.com' })).toThrow();
  });
  it('uses TLS, bounded timeouts and stable message IDs, and closes the transport', async () => {
    const deliver = vi.fn().mockResolvedValue({});
    const close = vi.fn();
    const factory = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail: deliver, close } as unknown as ReturnType<
        typeof nodemailer.createTransport
      >);
    const mail = {
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'Safe text',
      key: 'stable-job-key',
    };
    await sendMail(config, mail);
    await sendMail(config, mail);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: true,
        port: 465,
        disableFileAccess: true,
        disableUrlAccess: true,
        socketTimeout: 10000,
      }),
    );
    expect(deliver.mock.calls[0]![0].messageId).toBe(deliver.mock.calls[1]![0].messageId);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('redacts provider failures and marks ambiguous SMTP delivery for manual review', async () => {
    const close = vi.fn();
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('sensitive-provider-detail')),
      close,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await expect(
      sendMail(config, { to: 'recipient@example.com', subject: 'Test', text: 'Test', key: 'job' }),
    ).rejects.toMatchObject({ message: 'Email delivery failed.', uncertain: true });
    expect(close).toHaveBeenCalledOnce();
    expect(new MailDeliveryError(true).message).not.toContain('sensitive');
  });
  it('keeps verification tokens on the public app host and forces a safe callback', async () => {
    const deliver = vi.fn().mockResolvedValue({});
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: deliver,
      close: vi.fn(),
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await sendEmailVerification(
      config,
      'recipient@example.com',
      'https://api.example/api/auth/verify-email?token=test-token&callbackURL=https://untrusted.example',
    );
    const text = deliver.mock.calls[0]![0].text as string;
    expect(text).toContain('https://lunaris.example/api/auth/verify-email?token=test-token');
    expect(text).not.toContain('https://untrusted.example');
    expect(text).toContain(
      'callbackURL=https%3A%2F%2Flunaris.example%2Flogin%3Fverified%3Dsuccess',
    );
  });
});
