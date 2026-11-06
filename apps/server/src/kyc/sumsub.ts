/**
 * Status-only Sumsub client (docs/kyc-architecture.md, "Verification flow").
 *
 * This client can do exactly two things:
 *   1. get a short-lived token for the Sumsub widget, which runs in the
 *      user's browser and uploads straight to Sumsub;
 *   2. read an applicant's review status (level, pass/fail, rejection labels).
 *
 * It deliberately has no method that returns personal data (name, date of
 * birth, documents, images). Responses are copied field by field into small
 * types, and everything else is dropped, including Sumsub's free-text review
 * comments, which could mention personal details.
 *
 * Request signing and webhook checks follow Sumsub's documented HMAC scheme,
 * using Node's built-in crypto. No homemade cryptography.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Fixed on purpose: the secret key only ever signs requests to Sumsub. */
const BASE_URL = 'https://api.sumsub.com';
const SDK_TOKEN_TTL_SECONDS = 600;

export interface ReviewStatus {
  /** init | pending | prechecked | queued | completed | onHold | awaitingService | awaitingUser */
  reviewStatus: string;
  levelName: string | null;
  answer: 'GREEN' | 'RED' | null;
  rejectType: 'FINAL' | 'RETRY' | null;
  rejectLabels: string[];
}

export interface SumsubClient {
  /** Token for the Sumsub widget. Sumsub creates the applicant on first use. */
  sdkToken(externalUserId: string, levelName: string): Promise<string>;
  reviewStatus(applicantId: string): Promise<ReviewStatus>;
  /**
   * SANDBOX ONLY, local development only: sets a test applicant's review
   * result without a camera or documents (Sumsub's "Simulate review response
   * in Sandbox"). Sumsub refuses it outside the sandbox.
   */
  simulateReview(applicantId: string, result: SimulatedReview): Promise<void>;
}

/** What a simulated review can say. Labels must be Sumsub rejection labels. */
export type SimulatedReview =
  | { answer: 'GREEN' }
  | { answer: 'RED'; rejectType: 'RETRY' | 'FINAL'; rejectLabels: string[] };

/** Sumsub answered with an error. The body is never kept: it could echo request data. */
export class SumsubError extends Error {
  constructor(readonly status: number) {
    super(`Sumsub request failed (${status})`);
    this.name = 'SumsubError';
  }
}

/** HMAC-SHA256 hex over ts + METHOD + path-with-query + body, as Sumsub documents. */
export function signRequest(secretKey: string, ts: string, method: string, pathWithQuery: string, body: string): string {
  return createHmac('sha256', secretKey).update(ts + method.toUpperCase() + pathWithQuery + body).digest('hex');
}

const WEBHOOK_ALGS: Record<string, string> = { HMAC_SHA256_HEX: 'sha256', HMAC_SHA512_HEX: 'sha512' };

/**
 * Checks Sumsub's webhook signature over the raw body bytes. Refuses the
 * deprecated SHA-1 variant and any unknown algorithm.
 */
export function verifyWebhook(secret: string, rawBody: Uint8Array, digest: string | undefined, alg: string | undefined): boolean {
  const algo = alg ? WEBHOOK_ALGS[alg] : undefined;
  if (!algo || !digest || !/^[0-9a-f]+$/i.test(digest)) return false;
  const expected = createHmac(algo, secret).update(rawBody).digest();
  const got = Buffer.from(digest, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const APPLICANT_ID = /^[A-Za-z0-9]{1,64}$/;
export const isApplicantId = (s: unknown): s is string => typeof s === 'string' && APPLICANT_ID.test(s);

/** Copies only the status fields Login is allowed to keep. */
export function pickStatus(raw: unknown): ReviewStatus {
  const o = (raw ?? {}) as Record<string, unknown>;
  const r = (o.reviewResult ?? {}) as Record<string, unknown>;
  const answer = r.reviewAnswer === 'GREEN' || r.reviewAnswer === 'RED' ? r.reviewAnswer : null;
  const rejectType = r.reviewRejectType === 'FINAL' || r.reviewRejectType === 'RETRY' ? r.reviewRejectType : null;
  const labels = Array.isArray(r.rejectLabels) ? r.rejectLabels.filter((l): l is string => typeof l === 'string' && /^[A-Z0-9_]{1,64}$/.test(l)) : [];
  return {
    reviewStatus: typeof o.reviewStatus === 'string' ? o.reviewStatus : 'init',
    levelName: typeof o.levelName === 'string' ? o.levelName : null,
    answer,
    rejectType,
    rejectLabels: labels,
  };
}

export function createSumsubClient(opts: {
  appToken: string;
  secretKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}): SumsubClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    const ts = String(Math.floor(now() / 1000));
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Token': opts.appToken,
      'X-App-Access-Ts': ts,
      'X-App-Access-Sig': signRequest(opts.secretKey, ts, method, path, text),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await doFetch(BASE_URL + path, { method, headers, body: body === undefined ? undefined : text });
    if (!res.ok) throw new SumsubError(res.status);
    return res.json();
  };

  return {
    async sdkToken(externalUserId, levelName) {
      const r = (await call('POST', '/resources/accessTokens/sdk', {
        userId: externalUserId,
        levelName,
        ttlInSecs: SDK_TOKEN_TTL_SECONDS,
      })) as { token?: unknown };
      if (typeof r?.token !== 'string') throw new SumsubError(502);
      return r.token;
    },
    async reviewStatus(applicantId) {
      if (!isApplicantId(applicantId)) throw new SumsubError(400);
      return pickStatus(await call('GET', `/resources/applicants/${applicantId}/status`));
    },
    async simulateReview(applicantId, result) {
      if (!isApplicantId(applicantId)) throw new SumsubError(400);
      await call(
        'POST',
        `/resources/applicants/${applicantId}/status/testCompleted`,
        result.answer === 'GREEN'
          ? { reviewAnswer: 'GREEN', rejectLabels: [] }
          : { reviewAnswer: 'RED', reviewRejectType: result.rejectType, rejectLabels: result.rejectLabels },
      );
    },
  };
}
