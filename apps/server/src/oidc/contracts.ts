import type { IncomingMessage } from 'node:http';

/** Owned by passkeys. Unix seconds, updated only by a successful passkey check. */
export interface SignedInUser {
  userId: string;
  authenticatedAt: number;
  /** Original millisecond precision from the shared session, for strict reauthentication checks. */
  authenticatedAtMs?: number;
  method: 'passkey';
  userVerified: true;
}
export type GetSignedInUser = (request: IncomingMessage) => Promise<SignedInUser | null>;

/** Matches KYC's kycClaims(level, approvedScopes) output. Never include PII or provider IDs. */
export interface KycClaims {
  verified_human?: true;
  kyc_level?: 'L1' | 'L2' | 'L3';
  /** The adapter adds this when an approved result came from the sandbox. */
  verification_sandbox?: true;
}
/** KYC owns the level lookup and kycClaims call. OIDC supplies only granted scopes. */
export type GetKycClaims = (
  userId: string,
  approvedScopes: readonly string[],
) => Promise<KycClaims>;
