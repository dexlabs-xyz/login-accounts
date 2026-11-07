/** Resend mailer: the right request, and errors that never echo the address or key. */
import { describe, expect, it, vi } from 'vitest';
import { resendMailer } from './mail.ts';

describe('resendMailer', () => {
  it('sends a plain-text email through Resend with the API key', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    await resendMailer({ apiKey: 're_test_key', from: 'Login <login@withlogin.com>', fetch }).send({ to: 'a@example.com', subject: 'Your code', body: '123456' });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(init.body))).toEqual({ from: 'Login <login@withlogin.com>', to: ['a@example.com'], subject: 'Your code', text: '123456' });
  });
  it('fails with the status only (no address, no key)', async () => {
    const fetch = vi.fn(async () => new Response('{"message":"a@example.com is invalid"}', { status: 422 }));
    const err = await resendMailer({ apiKey: 're_test_key', from: 'x@withlogin.com', fetch }).send({ to: 'a@example.com', subject: 's', body: 'b' }).catch((e: Error) => e);
    expect(String(err)).toContain('422');
    expect(String(err)).not.toContain('a@example.com');
    expect(String(err)).not.toContain('re_test_key');
  });
});
