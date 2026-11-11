import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { codeEmail } from './code-email.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { devOutboxMailer, type OutboxEmail } from './mail.ts';

describe('sign-in code email', () => {
  const m = codeEmail('482913');

  it('keeps the code in the subject, the design and the plain text', () => {
    expect(m.subject).toBe('482913 is your Login code');
    expect(m.html).toContain('>482913</td>');
    expect(m.text).toContain('Your Login code is 482913. It expires in 10 minutes.');
  });

  it('has the approved wording', () => {
    for (const part of [
      'Your Login code',
      'It expires in 10 minutes.',
      'If you didn’t ask for it, ignore this email.',
      'Login will never ask you for this code by phone, chat or email.',
      'Team Login.',
    ]) {
      expect(m.html).toContain(part);
    }
  });

  it('shows the code in Geist Mono', () => {
    expect(m.html).toMatch(/font-family:'Geist Mono'[^"]*">482913</);
  });

  it('has no links, buttons, images or web fonts, so opening it contacts no one', () => {
    expect(m.html).not.toMatch(/<a\s|<img\s|<svg|<link|@import|https?:\/\//i);
  });

  it('accepts only a 6-digit code', () => {
    for (const bad of ['12345', '1234567', '12345a', '<b>123</b>', '']) {
      expect(() => codeEmail(bad)).toThrow();
    }
  });
});

describe('POST /api/email/start', () => {
  it('sends the designed email with a plain-text copy', async () => {
    const outbox: OutboxEmail[] = [];
    const { app } = createApp({
      config: loadConfig({ DEV_OUTBOX: '1' } as NodeJS.ProcessEnv),
      db: openDb(':memory:'),
      mailer: devOutboxMailer(outbox),
      outbox,
    });
    const res = await app.request('/api/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com' }),
    });
    expect(res.status).toBe(200);
    const code = /^(\d{6}) is your Login code$/.exec(outbox[0]!.subject)![1]!;
    expect(outbox[0]!.body).toContain(code);
    expect(outbox[0]!.html).toContain(`>${code}</td>`);
  });
});
