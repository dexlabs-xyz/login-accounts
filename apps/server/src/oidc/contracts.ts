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

/** Owned by KYC. Never return identity documents or provider reference IDs here. */
export interface Verification {
  status: 'approved' | 'pending' | 'rejected' | 'none';
  level?: string;
  provider: 'sumsub';
  sandbox: boolean;
  checkedAt: number;
}
export type GetVerification = (userId: string) => Promise<Verification | null>;
