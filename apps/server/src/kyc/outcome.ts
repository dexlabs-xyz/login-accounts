/**
 * Turns a Sumsub review status into what the user sees, and turns a level
 * into what apps receive (docs/kyc-architecture.md).
 */
import type { Level } from './config.ts';
import type { ReviewStatus } from './sumsub.ts';

export type AttemptState = 'in-progress' | 'in-review' | 'passed' | 'retry' | 'final';
export type Reason = 'duplicate' | 'suspected-fraud' | 'selfie' | 'document' | 'other';

/**
 * Sumsub rejection labels grouped into the few reasons the UI explains.
 * Unknown labels fall back to "other". Confirm the label names in the
 * sandbox. They come from Sumsub's docs and may grow.
 */
const REASON_LABELS: [Reason, string[]][] = [
  ['duplicate', ['DUPLICATE']],
  ['suspected-fraud', ['FRAUDULENT_LIVENESS', 'FRAUDULENT_PATTERNS', 'FORGERY', 'BLACKLIST', 'SPAM', 'THIRD_PARTY_INVOLVED']],
  ['selfie', ['BAD_SELFIE', 'BAD_VIDEO_SELFIE', 'BAD_FACE_MATCHING', 'SELFIE_MISMATCH']],
  [
    'document',
    [
      'UNSATISFACTORY_PHOTOS',
      'DOCUMENT_PAGE_MISSING',
      'INCOMPLETE_DOCUMENT',
      'DOCUMENT_DAMAGED',
      'EXPIRATION_DATE',
      'ID_INVALID',
      'SCREENSHOTS',
      'GRAPHIC_EDITOR',
      'BLACK_AND_WHITE',
      'NOT_DOCUMENT',
      'WRONG_ADDRESS',
    ],
  ],
];

export function reasonOf(labels: string[]): Reason {
  for (const [reason, known] of REASON_LABELS) if (labels.some((l) => known.includes(l))) return reason;
  return 'other';
}

export function outcomeOf(s: ReviewStatus): { state: AttemptState; reason: Reason | null } {
  if (s.reviewStatus === 'init' || s.reviewStatus === 'awaitingUser') return { state: 'in-progress', reason: null };
  if (s.reviewStatus !== 'completed') return { state: 'in-review', reason: null };
  if (s.answer === 'GREEN') return { state: 'passed', reason: null };
  if (s.answer !== 'RED') return { state: 'in-review', reason: null };
  const reason = reasonOf(s.rejectLabels);
  // A duplicate or suspected fraud is never "just try again", whatever the flag says.
  const final = s.rejectType !== 'RETRY' || reason === 'duplicate' || reason === 'suspected-fraud';
  return { state: final ? 'final' : 'retry', reason };
}

export const rank = (l: Level | null) => (l === null ? 0 : Number(l[1]));
export const higher = (a: Level | null, b: Level | null) => (rank(a) >= rank(b) ? a : b);

/**
 * OIDC claims from KYC, for the Login infrastructure to put in ID tokens.
 *
 * - `verified_human` is sent by default, and only when the user has passed L1
 *   (every higher level includes L1). Otherwise it is absent, never `false`.
 * - `kyc_level` is sent only when the user approved the `kyc_level` scope for
 *   this app.
 */
export function kycClaims(level: Level | null, approvedScopes: readonly string[]): { verified_human?: true; kyc_level?: Level } {
  if (!level) return {};
  return approvedScopes.includes('kyc_level') ? { verified_human: true, kyc_level: level } : { verified_human: true };
}
