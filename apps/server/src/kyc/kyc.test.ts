/**
 * KYC tests. Sumsub is replaced by a fake, so nothing leaves this machine
 * and no real (or sandbox) identity data is involved.
 */
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, devOutboxMailer } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDb, type DB } from '../db.ts';
import { loadKycConfig, type KycConfig } from './config.ts';
import { kycClaims, outcomeOf } from './outcome.ts';
import { createSumsubClient, pickStatus, signRequest, verifyWebhook, type ReviewStatus, type SimulatedReview, type SumsubClient } from './sumsub.ts';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const status = (o: Partial<ReviewStatus>): ReviewStatus => ({
  reviewStatus: 'completed',
  levelName: 'login-l1-liveness',
  answer: 'GREEN',
  rejectType: null,
  rejectLabels: [],
  ...o,
});

describe('KYC config', () => {
  it('is off when no Sumsub credentials are set', () => {
    expect(loadKycConfig(env({}), 'localhost')).toBeNull();
  });
  it('refuses anything that is not a sandbox token', () => {
    expect(() => loadKycConfig(env({ SUMSUB_APP_TOKEN: 'prd:abc', SUMSUB_SECRET_KEY: 's' }), 'localhost')).toThrow(/sandbox/);
  });
  it('never puts the token in its error messages', () => {
    try {
      loadKycConfig(env({ SUMSUB_APP_TOKEN: 'prd:SECRET123', SUMSUB_SECRET_KEY: 's' }), 'localhost');
    } catch (e) {
      expect(String(e)).not.toContain('SECRET123');
    }
  });
  it('needs both the token and the secret', () => {
    expect(() => loadKycConfig(env({ SUMSUB_APP_TOKEN: 'sbx:abc' }), 'localhost')).toThrow();
  });
  it('requires a webhook secret outside localhost', () => {
    expect(() => loadKycConfig(env({ SUMSUB_APP_TOKEN: 'sbx:a', SUMSUB_SECRET_KEY: 's' }), 'withlogin.com')).toThrow(/WEBHOOK/);
  });
});

describe('Sumsub client', () => {
  it('signs ts + METHOD + path + body with HMAC-SHA256 hex', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createSumsubClient({
      appToken: 'sbx:token',
      secretKey: 'secret',
      now: () => 1_607_551_635_000,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ token: 'sdk-token', userId: 'u' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await client.sdkToken('login-x', 'login-l1-liveness')).toBe('sdk-token');
    const { url, init } = seen[0]!;
    const h = init.headers as Record<string, string>;
    expect(url).toBe('https://api.sumsub.com/resources/accessTokens/sdk');
    expect(h['X-App-Access-Ts']).toBe('1607551635');
    const expected = createHmac('sha256', 'secret')
      .update('1607551635POST/resources/accessTokens/sdk' + (init.body as string))
      .digest('hex');
    expect(h['X-App-Access-Sig']).toBe(expected);
    expect(signRequest('secret', '1607551635', 'post', '/resources/accessTokens/sdk', init.body as string)).toBe(expected);
  });

  it('keeps only status fields, dropping review comments that could hold personal data', () => {
    const s = pickStatus({
      reviewStatus: 'completed',
      levelName: 'login-l2-identity',
      info: { firstName: 'Ada', dob: '1990-01-01' },
      reviewResult: {
        reviewAnswer: 'RED',
        reviewRejectType: 'RETRY',
        rejectLabels: ['BAD_SELFIE', 'not a label <script>'],
        clientComment: 'Name Ada Obi does not match',
        moderationComment: 'Ada, please retake',
      },
    });
    expect(s).toEqual({ reviewStatus: 'completed', levelName: 'login-l2-identity', answer: 'RED', rejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] });
    expect(JSON.stringify(s)).not.toContain('Ada');
  });

  it('never returns Sumsub error bodies', async () => {
    const client = createSumsubClient({
      appToken: 'sbx:t',
      secretKey: 's',
      fetch: (async () => new Response('{"description":"applicant Ada Obi"}', { status: 400 })) as unknown as typeof fetch,
    });
    await expect(client.reviewStatus('abc123')).rejects.toThrow(/^Sumsub request failed \(400\)$/);
  });
});

describe('webhook signatures', () => {
  const body = new TextEncoder().encode('{"type":"applicantReviewed"}');
  const sig = (alg: string) => createHmac(alg, 'whsec').update(body).digest('hex');
  it('accepts SHA-256 and SHA-512', () => {
    expect(verifyWebhook('whsec', body, sig('sha256'), 'HMAC_SHA256_HEX')).toBe(true);
    expect(verifyWebhook('whsec', body, sig('sha512'), 'HMAC_SHA512_HEX')).toBe(true);
  });
  it('refuses SHA-1, a missing algorithm, and wrong signatures', () => {
    expect(verifyWebhook('whsec', body, sig('sha1'), 'HMAC_SHA1_HEX')).toBe(false);
    expect(verifyWebhook('whsec', body, sig('sha256'), undefined)).toBe(false);
    expect(verifyWebhook('other', body, sig('sha256'), 'HMAC_SHA256_HEX')).toBe(false);
  });
});

describe('outcomes and claims', () => {
  it('maps Sumsub statuses to what the user sees', () => {
    expect(outcomeOf(status({ reviewStatus: 'init', answer: null }))).toEqual({ state: 'in-progress', reason: null });
    expect(outcomeOf(status({ reviewStatus: 'pending', answer: null }))).toEqual({ state: 'in-review', reason: null });
    expect(outcomeOf(status({}))).toEqual({ state: 'passed', reason: null });
    expect(outcomeOf(status({ answer: 'RED', rejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] }))).toEqual({ state: 'retry', reason: 'selfie' });
  });
  it('treats duplicates and suspected fraud as final, even if Sumsub says retry', () => {
    expect(outcomeOf(status({ answer: 'RED', rejectType: 'RETRY', rejectLabels: ['DUPLICATE'] }))).toEqual({ state: 'final', reason: 'duplicate' });
    expect(outcomeOf(status({ answer: 'RED', rejectType: 'RETRY', rejectLabels: ['FRAUDULENT_LIVENESS'] })).state).toBe('final');
  });
  it('sends verified_human only after L1, and the level only with consent', () => {
    expect(kycClaims(null, ['kyc_level'])).toEqual({});
    expect(kycClaims('L1', [])).toEqual({ verified_human: true });
    expect(kycClaims('L2', ['kyc_level'])).toEqual({ verified_human: true, kyc_level: 'L2' });
  });
});

// ---------- API ----------

class FakeSumsub implements SumsubClient {
  tokens: { externalUserId: string; levelName: string }[] = [];
  statuses = new Map<string, ReviewStatus>();
  down = false;
  async sdkToken(externalUserId: string, levelName: string) {
    if (this.down) throw new Error('down');
    this.tokens.push({ externalUserId, levelName });
    return `sdk-${this.tokens.length}`;
  }
  async reviewStatus(applicantId: string) {
    if (this.down) throw new Error('down');
    return this.statuses.get(applicantId) ?? status({ reviewStatus: 'init', answer: null });
  }
  simulated: { applicantId: string; result: SimulatedReview }[] = [];
  async simulateReview(applicantId: string, result: SimulatedReview) {
    if (this.down) throw new Error('down');
    this.simulated.push({ applicantId, result });
    const levelName = this.tokens.at(-1)?.levelName ?? 'login-l1-liveness';
    this.statuses.set(
      applicantId,
      result.answer === 'GREEN'
        ? status({ levelName })
        : status({ levelName, answer: 'RED', rejectType: result.rejectType, rejectLabels: result.rejectLabels }),
    );
  }
}

let db: DB;
let fake: FakeSumsub;
let app: ReturnType<typeof createApp>;
let kycConfig: KycConfig;

function makeApp(webhookSecret: string | null, withKyc = true) {
  db = openDb(':memory:');
  fake = new FakeSumsub();
  kycConfig = loadKycConfig(
    env({ SUMSUB_APP_TOKEN: 'sbx:test', SUMSUB_SECRET_KEY: 'test', ...(webhookSecret ? { SUMSUB_WEBHOOK_SECRET: webhookSecret } : {}) }),
    'localhost',
  )!;
  app = createApp({
    config: loadConfig(env({ DEV_OUTBOX: '1' })),
    db,
    mailer: devOutboxMailer([]),
    kyc: withKyc ? { config: kycConfig, sumsub: fake } : null,
  });
}

/** A signed-in user, created directly in the database. */
function signedIn(id = 'user-1'): string {
  db.prepare('INSERT INTO users (id, email, webauthn_user_id, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.com`, `wa-${id}`, Date.now());
  const t = `session-${id}`;
  db.prepare('INSERT INTO sessions (token_hash, user_id, auth_at, expires_at) VALUES (?, ?, ?, ?)').run(
    createHash('sha256').update(t).digest('hex'),
    id,
    Date.now(),
    Date.now() + 60 * 60_000,
  );
  return `login_session=${t}`;
}

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function webhook(payload: unknown, secret = 'whsec') {
  const raw = JSON.stringify(payload);
  return app.request('/api/kyc/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payload-digest': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-payload-digest-alg': 'HMAC_SHA256_HEX',
    },
    body: raw,
  });
}

describe('KYC API', () => {
  beforeEach(() => makeApp('whsec'));

  it('says verification is unavailable when Sumsub is not configured', async () => {
    makeApp(null, false);
    const res = await call('GET', '/api/kyc', signedIn());
    expect(await res.json()).toEqual({ available: false });
  });

  it('requires a session', async () => {
    expect((await call('GET', '/api/kyc', '')).status).toBe(401);
    expect((await call('POST', '/api/kyc/start', '', { level: 'L1' })).status).toBe(401);
  });

  it('starts L1 under a random Sumsub ID that is never shown to the browser', async () => {
    const cookie = signedIn();
    const res = await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe('sdk-1');
    expect(body.attempt).toEqual({ level: 'L1', state: 'in-progress', reason: null });
    const ext = fake.tokens[0]!.externalUserId;
    expect(ext).toMatch(/^login-[0-9a-f]{32}$/);
    expect(ext).not.toContain('user-1');
    expect(JSON.stringify(body)).not.toContain(ext);
    expect(fake.tokens[0]!.levelName).toBe('login-l1-liveness');
  });

  it('builds levels in order', async () => {
    const cookie = signedIn();
    expect((await call('POST', '/api/kyc/start', cookie, { level: 'L2' })).status).toBe(409);
    expect((await call('POST', '/api/kyc/start', cookie, { level: 'L9' })).status).toBe(400);
  });

  it('records a passed level from a signed webhook, re-reading the result from Sumsub', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    const ext = fake.tokens[0]!.externalUserId;
    fake.statuses.set('app111', status({}));

    // The payload claims RED, but the stored result comes from the status API.
    const res = await webhook({ type: 'applicantReviewed', applicantId: 'app111', externalUserId: ext, reviewResult: { reviewAnswer: 'RED' } });
    expect(res.status).toBe(200);

    const view = await (await call('GET', '/api/kyc', cookie)).json();
    expect(view).toMatchObject({ level: 'L1', verifiedHuman: true, attempt: { level: 'L1', state: 'passed' } });
    expect(JSON.stringify(view)).not.toContain('app111');

    // L2 is now allowed, and L1 can't be repeated.
    expect((await call('POST', '/api/kyc/start', cookie, { level: 'L1' })).status).toBe(409);
    expect((await call('POST', '/api/kyc/start', cookie, { level: 'L2' })).status).toBe(200);
  });

  it('keeps L1 when an L2 attempt fails', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    const ext = fake.tokens[0]!.externalUserId;
    fake.statuses.set('app111', status({}));
    await webhook({ applicantId: 'app111', externalUserId: ext });
    await call('POST', '/api/kyc/start', cookie, { level: 'L2' });
    fake.statuses.set('app111', status({ levelName: 'login-l2-identity', answer: 'RED', rejectType: 'RETRY', rejectLabels: ['UNSATISFACTORY_PHOTOS'] }));
    await webhook({ applicantId: 'app111', externalUserId: ext });
    const view = await (await call('GET', '/api/kyc', cookie)).json();
    expect(view).toMatchObject({ level: 'L1', verifiedHuman: true, attempt: { level: 'L2', state: 'retry', reason: 'document' } });
  });

  it('closes verification after a duplicate', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    fake.statuses.set('app111', status({ answer: 'RED', rejectType: 'FINAL', rejectLabels: ['DUPLICATE'] }));
    await webhook({ applicantId: 'app111', externalUserId: fake.tokens[0]!.externalUserId });
    const view = await (await call('GET', '/api/kyc', cookie)).json();
    expect(view).toMatchObject({ level: null, verifiedHuman: false, attempt: { state: 'final', reason: 'duplicate' } });
    expect((await call('POST', '/api/kyc/start', cookie, { level: 'L1' })).status).toBe(403);
  });

  it('rejects webhooks with a bad signature and changes nothing', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    fake.statuses.set('app111', status({}));
    const res = await webhook({ applicantId: 'app111', externalUserId: fake.tokens[0]!.externalUserId }, 'wrong-secret');
    expect(res.status).toBe(401);
    expect((await (await call('GET', '/api/kyc', cookie)).json()).level).toBeNull();
  });

  it('answers webhooks for unknown applicants the same way, without acting', async () => {
    const res = await webhook({ applicantId: 'app999', externalUserId: 'login-unknown' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not let a webhook move an account to a different applicant', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    const ext = fake.tokens[0]!.externalUserId;
    fake.statuses.set('app111', status({ answer: 'RED', rejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] }));
    await webhook({ applicantId: 'app111', externalUserId: ext });
    fake.statuses.set('app222', status({}));
    await webhook({ applicantId: 'app222', externalUserId: ext });
    expect((await (await call('GET', '/api/kyc', cookie)).json()).level).toBeNull();
  });

  it('refuses the browser-supplied applicant route when webhooks are on', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    expect((await call('POST', '/api/kyc/applicant', cookie, { applicantId: 'app111' })).status).toBe(404);
  });

  it('returns a plain error when Sumsub is down', async () => {
    const cookie = signedIn();
    fake.down = true;
    const res = await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'kyc-unavailable' });
  });
});

describe('KYC API, local polling mode', () => {
  beforeEach(() => makeApp(null));

  it('polls Sumsub using the applicant ID from the widget', async () => {
    const cookie = signedIn();
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    fake.statuses.set('app111', status({ reviewStatus: 'pending', answer: null }));
    const bound = await (await call('POST', '/api/kyc/applicant', cookie, { applicantId: 'app111' })).json();
    expect(bound).toMatchObject({ mode: 'polling', attempt: { state: 'in-review' } });

    fake.statuses.set('app111', status({}));
    const after = await (await call('POST', '/api/kyc/refresh', cookie)).json();
    expect(after).toMatchObject({ level: 'L1', verifiedHuman: true });
  });

  it('will not bind a second applicant, or one already used by another account', async () => {
    const a = signedIn('user-a');
    const b = signedIn('user-b');
    await call('POST', '/api/kyc/start', a, { level: 'L1' });
    await call('POST', '/api/kyc/start', b, { level: 'L1' });
    expect((await call('POST', '/api/kyc/applicant', a, { applicantId: 'app111' })).status).toBe(200);
    expect((await call('POST', '/api/kyc/applicant', a, { applicantId: 'app222' })).status).toBe(409);
    expect((await call('POST', '/api/kyc/applicant', b, { applicantId: 'app111' })).status).toBe(409);
  });
});

describe('simulated review results (sandbox, localhost only)', () => {
  beforeEach(() => makeApp(null));

  async function startedWithApplicant(cookie: string) {
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    await call('POST', '/api/kyc/applicant', cookie, { applicantId: 'app222' });
  }

  it('is offered on localhost and records a pass through the normal status API', async () => {
    const cookie = signedIn();
    expect(await (await call('GET', '/api/kyc', cookie)).json()).toMatchObject({ simulate: true });
    await startedWithApplicant(cookie);
    const r = await call('POST', '/api/kyc/simulate', cookie, { result: 'pass' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ level: 'L1', verifiedHuman: true });
    expect(fake.simulated).toEqual([{ applicantId: 'app222', result: { answer: 'GREEN' } }]);
  });

  it('simulates a duplicate as final', async () => {
    const cookie = signedIn();
    await startedWithApplicant(cookie);
    expect(await (await call('POST', '/api/kyc/simulate', cookie, { result: 'duplicate' })).json()).toMatchObject({
      level: null,
      attempt: { state: 'final', reason: 'duplicate' },
    });
  });

  it('needs a linked applicant and a known result', async () => {
    const cookie = signedIn();
    expect((await call('POST', '/api/kyc/simulate', cookie, { result: 'pass' })).status).toBe(409);
    await startedWithApplicant(cookie);
    expect((await call('POST', '/api/kyc/simulate', cookie, { result: 'toString' })).status).toBe(400);
  });

  it('does not exist outside localhost', async () => {
    db = openDb(':memory:');
    fake = new FakeSumsub();
    const config = loadConfig(env({ WEBAUTHN_RP_ID: 'withlogin.com', WEBAUTHN_ORIGINS: 'https://withlogin.com' }));
    const kycConfig = loadKycConfig(env({ SUMSUB_APP_TOKEN: 'sbx:t', SUMSUB_SECRET_KEY: 's', SUMSUB_WEBHOOK_SECRET: 'w' }), 'withlogin.com')!;
    app = createApp({ config, db, mailer: devOutboxMailer([]), kyc: { config: kycConfig, sumsub: fake } });
    const cookie = signedIn();
    expect(await (await call('GET', '/api/kyc', cookie)).json()).toMatchObject({ simulate: false });
    expect((await call('POST', '/api/kyc/simulate', cookie, { result: 'pass' })).status).toBe(404);
  });
});

describe('Sumsub client: simulated review', () => {
  it('calls the sandbox testCompleted endpoint, signed', async () => {
    const calls: { url: string; body: string }[] = [];
    const client = createSumsubClient({
      appToken: 'sbx:t',
      secretKey: 's',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return new Response('{"ok":1}', { status: 200 });
      }) as typeof fetch,
    });
    await client.simulateReview('abc123', { answer: 'RED', rejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] });
    expect(calls[0]!.url).toBe('https://api.sumsub.com/resources/applicants/abc123/status/testCompleted');
    expect(JSON.parse(calls[0]!.body)).toEqual({ reviewAnswer: 'RED', reviewRejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] });
  });
});

describe('enabled levels (SUMSUB_LEVELS)', () => {
  it('defaults to all levels and refuses gaps or wrong order', () => {
    const base = { SUMSUB_APP_TOKEN: 'sbx:t', SUMSUB_SECRET_KEY: 's' };
    expect(loadKycConfig(env(base), 'localhost')!.enabledLevels).toEqual(['L1', 'L2', 'L3']);
    expect(loadKycConfig(env({ ...base, SUMSUB_LEVELS: 'L1, l2' }), 'localhost')!.enabledLevels).toEqual(['L1', 'L2']);
    expect(() => loadKycConfig(env({ ...base, SUMSUB_LEVELS: 'L1,L3' }), 'localhost')).toThrow(/in order/);
    expect(() => loadKycConfig(env({ ...base, SUMSUB_LEVELS: 'L2' }), 'localhost')).toThrow(/in order/);
  });

  it('does not start a level that is not set up at Sumsub', async () => {
    db = openDb(':memory:');
    fake = new FakeSumsub();
    const kycConfig = loadKycConfig(env({ SUMSUB_APP_TOKEN: 'sbx:t', SUMSUB_SECRET_KEY: 's', SUMSUB_LEVELS: 'L1' }), 'localhost')!;
    app = createApp({ config: loadConfig(env({ DEV_OUTBOX: '1' })), db, mailer: devOutboxMailer([]), kyc: { config: kycConfig, sumsub: fake } });
    const cookie = signedIn();
    expect(await (await call('GET', '/api/kyc', cookie)).json()).toMatchObject({ levels: ['L1'] });
    await call('POST', '/api/kyc/start', cookie, { level: 'L1' });
    await call('POST', '/api/kyc/applicant', cookie, { applicantId: 'app333' });
    await call('POST', '/api/kyc/simulate', cookie, { result: 'pass' });
    const r = await call('POST', '/api/kyc/start', cookie, { level: 'L2' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'level-unavailable' });
    expect(fake.tokens).toHaveLength(1);
  });
});
