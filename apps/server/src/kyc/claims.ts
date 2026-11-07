/**
 * What KYC gives the OIDC provider: the claims for one user and one app.
 *
 * The OIDC provider calls this with the scopes the user approved for that app
 * and puts the result in the ID token as is. It never sees Sumsub IDs, names
 * or documents, only the claims below (see kycClaims in outcome.ts).
 */
import type { DB } from '../db.ts';
import type { Level } from './config.ts';
import { kycClaims } from './outcome.ts';

export interface KycClaims {
  verified_human?: true;
  kyc_level?: Level;
  /**
   * Set whenever a claim is sent: every result so far comes from Sumsub's
   * sandbox (config.ts refuses non-sandbox tokens), so apps must not treat it
   * as a real check.
   */
  verification_sandbox?: true;
}

export type GetKycClaims = (userId: string, approvedScopes: readonly string[]) => Promise<KycClaims>;

export function createGetKycClaims(db: DB): GetKycClaims {
  const levelOf = db.prepare('SELECT level FROM kyc_status WHERE user_id = ?');
  return async (userId, approvedScopes) => {
    const row = levelOf.get(userId) as { level: Level | null } | undefined;
    const claims = kycClaims(row?.level ?? null, approvedScopes);
    return claims.verified_human ? { ...claims, verification_sandbox: true } : claims;
  };
}
