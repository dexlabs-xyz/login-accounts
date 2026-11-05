/**
 * KYC API (docs/kyc-architecture.md).
 *
 * What this part of the server can see:
 *   - per account: the highest level passed and the state of the current
 *     attempt (stored in `kyc_status`, readable at every sign-in so devices
 *     without PRF keep `verified_human`);
 *   - the link between an account and its Sumsub applicant (`kyc_links`, see
 *     below);
 *   - never documents, selfies, names, dates of birth, or wallet addresses.
 *
 * SIMULATED CONTROLLED ACCESS: `kyc_links` is what ties an account to a real
 * person at Sumsub. In the full design it lives only in threshold escrow
 * (encrypted on the device for the key holders) and in the user's passkey
 * vault. For the hackathon it is a plain server table, never returned by any
 * API and never logged. This is a simulation, not the real protection.
 */
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { DB } from '../db.ts';
import { LEVELS, type KycConfig, type Level } from './config.ts';
import { higher, outcomeOf, rank, type AttemptState, type Reason } from './outcome.ts';
import { isApplicantId, verifyWebhook, type ReviewStatus, type SimulatedReview, type SumsubClient } from './sumsub.ts';

/**
 * SIMULATED REVIEW RESULTS (sandbox + localhost only). The sandbox liveness
 * check needs a real face, and nobody's real face goes into the sandbox. So in
 * local development a test panel asks Sumsub's sandbox to record a result for
 * the test applicant. Login then reads it back through the normal status API.
 */
export const SIMULATED_REVIEWS: Record<string, SimulatedReview> = {
  pass: { answer: 'GREEN' },
  'retry-selfie': { answer: 'RED', rejectType: 'RETRY', rejectLabels: ['BAD_SELFIE'] },
  'retry-document': { answer: 'RED', rejectType: 'RETRY', rejectLabels: ['UNSATISFACTORY_PHOTOS'] },
  duplicate: { answer: 'RED', rejectType: 'FINAL', rejectLabels: ['DUPLICATE'] },
  fraud: { answer: 'RED', rejectType: 'FINAL', rejectLabels: ['FRAUDULENT_LIVENESS'] },
};

export interface KycDeps {
  config: KycConfig;
  sumsub: SumsubClient;
}

type StatusRow = {
  user_id: string;
  level: Level | null;
  attempt_level: Level | null;
  attempt_state: AttemptState | null;
  attempt_reason: Reason | null;
  updated_at: number;
};
type LinkRow = { user_id: string; external_user_id: string; applicant_id: string | null };

const fail = (c: Context, status: 400 | 403 | 404 | 409 | 502 | 503, error: string) => c.json({ error }, status);

/** KYC component, mounted by ../app.ts. Tables: migrations/0003_kyc_initial.ts. */
export function kycRoutes({
  db,
  kyc,
  session,
  now,
  localDev = false,
}: {
  db: DB;
  kyc: KycDeps | null;
  /** The signed-in account, or throws 401 (passkeys/session.ts). */
  session: (c: Context) => { user: { id: string } };
  now: () => number;
  /** True only when the RP ID is localhost. Turns on the simulated-review panel. */
  localDev?: boolean;
}): Hono {
  const app = new Hono();

  const statusOf = (userId: string) =>
    db.prepare('SELECT * FROM kyc_status WHERE user_id = ?').get(userId) as StatusRow | undefined;
  const linkOf = (userId: string) => db.prepare('SELECT * FROM kyc_links WHERE user_id = ?').get(userId) as LinkRow | undefined;

  const levelFromName = (name: string | null): Level | null =>
    kyc ? (LEVELS.find((l) => kyc.config.levelNames[l] === name) ?? null) : null;

  const saveStatus = (userId: string, patch: Partial<Omit<StatusRow, 'user_id' | 'updated_at'>>) => {
    const cur = statusOf(userId);
    const next = {
      level: patch.level !== undefined ? patch.level : (cur?.level ?? null),
      attempt_level: patch.attempt_level !== undefined ? patch.attempt_level : (cur?.attempt_level ?? null),
      attempt_state: patch.attempt_state !== undefined ? patch.attempt_state : (cur?.attempt_state ?? null),
      attempt_reason: patch.attempt_reason !== undefined ? patch.attempt_reason : (cur?.attempt_reason ?? null),
    };
    db.prepare(
      `INSERT INTO kyc_status (user_id, level, attempt_level, attempt_state, attempt_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET level = excluded.level, attempt_level = excluded.attempt_level,
         attempt_state = excluded.attempt_state, attempt_reason = excluded.attempt_reason, updated_at = excluded.updated_at`,
    ).run(userId, next.level, next.attempt_level, next.attempt_state, next.attempt_reason, now());
  };

  /** Applies a fresh review status from Sumsub to an account. */
  const apply = (userId: string, s: ReviewStatus) => {
    const attemptLevel = levelFromName(s.levelName);
    if (!attemptLevel) return; // a level we didn't configure: ignore rather than guess
    const { state, reason } = outcomeOf(s);
    const cur = statusOf(userId);
    saveStatus(userId, {
      level: state === 'passed' ? higher(cur?.level ?? null, attemptLevel) : (cur?.level ?? null),
      attempt_level: attemptLevel,
      attempt_state: state,
      attempt_reason: reason,
    });
  };

  const refreshFromSumsub = async (userId: string) => {
    const link = linkOf(userId);
    if (!kyc || !link?.applicant_id) return;
    apply(userId, await kyc.sumsub.reviewStatus(link.applicant_id));
  };

  /** What the account page shows. No Sumsub IDs, ever. */
  const view = (userId: string) => {
    const s = statusOf(userId);
    return {
      available: true,
      sandbox: true,
      mode: kyc!.config.webhookSecret ? 'webhook' : 'polling',
      level: s?.level ?? null,
      verifiedHuman: rank(s?.level ?? null) >= 1,
      simulate: localDev,
      levels: kyc!.config.enabledLevels,
      attempt: s?.attempt_level
        ? { level: s.attempt_level, state: s.attempt_state, reason: s.attempt_reason }
        : null,
    };
  };

  const sumsubDown = (c: Context, err: unknown) => {
    console.error('Sumsub request failed:', err instanceof Error ? err.message : 'unknown');
    return fail(c, 502, 'kyc-unavailable');
  };

  // ---------- account-facing ----------

  app.get('/api/kyc', (c) => {
    const s = session(c);
    if (!kyc) return c.json({ available: false });
    return c.json(view(s.user.id));
  });

  /** Starts (or resumes) a level and returns a token for the Sumsub widget. */
  app.post('/api/kyc/start', async (c) => {
    const s = session(c);
    if (!kyc) return fail(c, 503, 'kyc-off');
    const body = (await c.req.json().catch(() => ({}))) as { level?: unknown };
    const level = LEVELS.find((l) => l === body.level);
    if (!level) return fail(c, 400, 'invalid-level');
    if (!kyc.config.enabledLevels.includes(level)) return fail(c, 409, 'level-unavailable');

    const cur = statusOf(s.user.id);
    if (rank(cur?.level ?? null) >= rank(level)) return fail(c, 409, 'already-verified');
    if (rank(cur?.level ?? null) < rank(level) - 1) return fail(c, 409, 'needs-lower-level');
    if (cur?.attempt_level === level && cur.attempt_state === 'final') return fail(c, 403, 'verification-closed');

    let link = linkOf(s.user.id);
    if (!link) {
      const externalUserId = `login-${randomBytes(16).toString('hex')}`; // random, never derived from the account
      db.prepare('INSERT INTO kyc_links (user_id, external_user_id, applicant_id, created_at) VALUES (?, ?, NULL, ?)').run(
        s.user.id,
        externalUserId,
        now(),
      );
      link = { user_id: s.user.id, external_user_id: externalUserId, applicant_id: null };
    }

    let token: string;
    try {
      token = await kyc.sumsub.sdkToken(link.external_user_id, kyc.config.levelNames[level]);
    } catch (err) {
      return sumsubDown(c, err);
    }
    // Reopening the widget while Sumsub is reviewing doesn't reset "in review".
    if (!(cur?.attempt_level === level && cur.attempt_state === 'in-review')) {
      saveStatus(s.user.id, { attempt_level: level, attempt_state: 'in-progress', attempt_reason: null });
    }
    return c.json({ token, ...view(s.user.id) });
  });

  /** "Check again": reads the latest result from Sumsub. */
  app.post('/api/kyc/refresh', async (c) => {
    const s = session(c);
    if (!kyc) return fail(c, 503, 'kyc-off');
    try {
      await refreshFromSumsub(s.user.id);
    } catch (err) {
      return sumsubDown(c, err);
    }
    return c.json(view(s.user.id));
  });

  /**
   * Local development only (no webhook secret): the widget tells the browser
   * its applicant ID, and the browser passes it here so the server can poll.
   * With webhooks, the ID arrives in a signed webhook instead, and this route
   * is refused.
   */
  app.post('/api/kyc/applicant', async (c) => {
    const s = session(c);
    if (!kyc) return fail(c, 503, 'kyc-off');
    if (kyc.config.webhookSecret) return fail(c, 404, 'not-found');
    const body = (await c.req.json().catch(() => ({}))) as { applicantId?: unknown };
    if (!isApplicantId(body.applicantId)) return fail(c, 400, 'invalid-applicant');
    const link = linkOf(s.user.id);
    if (!link) return fail(c, 409, 'not-started');
    if (link.applicant_id && link.applicant_id !== body.applicantId) return fail(c, 409, 'applicant-mismatch');
    try {
      db.prepare('UPDATE kyc_links SET applicant_id = ? WHERE user_id = ?').run(body.applicantId, s.user.id);
    } catch {
      return fail(c, 409, 'applicant-mismatch'); // already linked to another account
    }
    try {
      await refreshFromSumsub(s.user.id);
    } catch (err) {
      return sumsubDown(c, err);
    }
    return c.json(view(s.user.id));
  });

  /** SIMULATED REVIEW RESULTS: see SIMULATED_REVIEWS above. Localhost only. */
  app.post('/api/kyc/simulate', async (c) => {
    const s = session(c);
    if (!kyc || !localDev) return fail(c, 404, 'not-found');
    const body = (await c.req.json().catch(() => ({}))) as { result?: unknown };
    const review = typeof body.result === 'string' && Object.hasOwn(SIMULATED_REVIEWS, body.result) ? SIMULATED_REVIEWS[body.result] : null;
    if (!review) return fail(c, 400, 'invalid-result');
    const link = linkOf(s.user.id);
    if (!link?.applicant_id) return fail(c, 409, 'not-started');
    try {
      await kyc.sumsub.simulateReview(link.applicant_id, review);
      await refreshFromSumsub(s.user.id);
    } catch (err) {
      return sumsubDown(c, err);
    }
    return c.json(view(s.user.id));
  });

  // ---------- Sumsub-facing ----------

  /**
   * Sumsub webhooks. The signature is checked over the raw body before
   * anything is parsed. The payload is used only to find the account. The
   * result itself is re-read from Sumsub's status API, so the stored result
   * never depends on the order webhooks arrive in.
   */
  app.post('/api/kyc/webhook', async (c) => {
    if (!kyc?.config.webhookSecret) return fail(c, 404, 'not-found');
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifyWebhook(kyc.config.webhookSecret, raw, c.req.header('x-payload-digest'), c.req.header('x-payload-digest-alg'))) {
      return c.json({ error: 'bad-signature' }, 401);
    }
    let payload: { externalUserId?: unknown; applicantId?: unknown; testMode?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return fail(c, 400, 'invalid-json');
    }
    if (payload.testMode === true) return c.json({ ok: true }); // dashboard "send test webhook"

    const link =
      typeof payload.externalUserId === 'string'
        ? (db.prepare('SELECT * FROM kyc_links WHERE external_user_id = ?').get(payload.externalUserId) as LinkRow | undefined)
        : undefined;
    // Unknown applicants get the same answer as known ones, so the webhook reveals nothing.
    if (!link || !isApplicantId(payload.applicantId)) return c.json({ ok: true });
    if (link.applicant_id && link.applicant_id !== payload.applicantId) return c.json({ ok: true });
    if (!link.applicant_id) {
      db.prepare('UPDATE kyc_links SET applicant_id = ? WHERE user_id = ?').run(payload.applicantId, link.user_id);
    }
    try {
      await refreshFromSumsub(link.user_id);
    } catch (err) {
      return sumsubDown(c, err); // a non-2xx makes Sumsub retry later
    }
    return c.json({ ok: true });
  });

  return app;
}
