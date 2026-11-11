import { describe, expect, it } from 'vitest';
import { resendMailer } from './mail.ts';
import { welcomeEmail } from './welcome-email.ts';

describe('welcome email', () => {
  const w = welcomeEmail('https://demo.withlogin.com/');

  it('has the approved subject and content', () => {
    expect(w.subject).toBe('Welcome to Login');
    for (const part of [
      'Welcome to Login.',
      'Hi there,',
      'Before anything else',
      'Here’s what you can do next on Login.',
      'Add test money',
      'Send privately',
      'Sign in with one click',
      'One important note:',
      'Login will never ask for your password, recovery phrase or ID by email.',
      'Team Login.',
    ]) {
      expect(w.html).toContain(part);
    }
  });

  it('links and icons point at the app’s own address', () => {
    expect(w.html).toContain('href="https://demo.withlogin.com"');
    for (const name of ['plus', 'send', 'fingerprint']) {
      expect(w.html).toContain(`src="https://demo.withlogin.com/email/icon-${name}.png"`);
    }
    expect(w.html).not.toContain('//email'); // trailing slash handled
    expect(welcomeEmail('http://localhost:5180').html).toContain('src="http://localhost:5180/email/icon-plus.png"');
  });

  it('loads no web fonts, so opening it contacts no one but our own site', () => {
    expect(w.html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import|<link/i);
    const hosts = new Set([...w.html.matchAll(/(?:src|href)="https?:\/\/([^/"]+)/g)].map((m) => m[1]));
    expect([...hosts]).toEqual(['demo.withlogin.com']);
  });

  it('uses images, not inline SVG (Gmail and Outlook drop SVG)', () => {
    expect(w.html).not.toMatch(/<svg/i);
  });

  it('never squashes icons: no padding on the image itself', () => {
    for (const img of w.html.match(/<img [^>]*>/g) ?? []) expect(img).not.toMatch(/padding/);
  });

  it('has a plain-text copy with the same message', () => {
    expect(w.text).toContain('Welcome to Login.');
    expect(w.text).toContain('Get started: https://demo.withlogin.com');
    expect(w.text).not.toMatch(/</);
  });
});

describe('Resend mailer', () => {
  const capture = () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    return { bodies, mailer: resendMailer({ apiKey: 'k', from: 'Login <hello@withlogin.com>', fetch }) };
  };

  it('sends the design and the plain-text copy together', async () => {
    const { bodies, mailer } = capture();
    await mailer.send({ to: 'ada@example.com', subject: 'Hi', body: 'plain', html: '<p>designed</p>' });
    expect(bodies[0]).toMatchObject({ to: ['ada@example.com'], subject: 'Hi', text: 'plain', html: '<p>designed</p>' });
  });

  it('still sends plain text alone (sign-in codes)', async () => {
    const { bodies, mailer } = capture();
    await mailer.send({ to: 'ada@example.com', subject: '123456 is your Login code', body: 'code' });
    expect(bodies[0]).not.toHaveProperty('html');
  });

  it('gives up on a provider that never answers', async () => {
    const mailer = resendMailer({
      apiKey: 'k',
      from: 'x',
      timeoutMs: 50,
      // Never answers: only the abort signal can end this request.
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof globalThis.fetch,
    });
    await expect(mailer.send({ to: 'ada@example.com', subject: 's', body: 'b' })).rejects.toThrow(/timeout|abort/i);
  });

  it('reports a refusal without echoing the address', async () => {
    const mailer = resendMailer({
      apiKey: 'k',
      from: 'x',
      fetch: (async () => new Response('bad ada@example.com', { status: 422 })) as typeof globalThis.fetch,
    });
    await expect(mailer.send({ to: 'ada@example.com', subject: 's', body: 'b' })).rejects.toThrow(/^Email provider refused the message \(422\)\.$/);
  });
});
