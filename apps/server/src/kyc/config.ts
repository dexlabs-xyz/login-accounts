/**
 * KYC configuration (docs/kyc-architecture.md).
 *
 * Login uses the Sumsub **sandbox only**: no real identity checks, no real
 * documents. Sandbox app tokens start with "sbx:", and this config refuses
 * anything else, so production credentials can't be plugged in by mistake.
 *
 * Secrets are read from the environment only and never logged or echoed in
 * error messages.
 */
export type Level = 'L1' | 'L2' | 'L3';
export const LEVELS: readonly Level[] = ['L1', 'L2', 'L3'];

export interface KycConfig {
  appToken: string;
  secretKey: string;
  /**
   * Secret Sumsub signs webhooks with. When missing (local development only),
   * the server polls Sumsub's status API instead, because Sumsub can't reach
   * localhost.
   */
  webhookSecret: string | null;
  /** The level names configured in the Sumsub sandbox dashboard. */
  levelNames: Record<Level, string>;
  /**
   * The levels that exist in the Sumsub dashboard (SUMSUB_LEVELS, e.g.
   * "L1,L2"). Default: all. Levels build in order, so this is always a prefix.
   */
  enabledLevels: Level[];
}

/** Returns null when KYC isn't configured, so the rest of Login still runs without it. */
export function loadKycConfig(env: NodeJS.ProcessEnv, rpId: string): KycConfig | null {
  const appToken = env.SUMSUB_APP_TOKEN?.trim() ?? '';
  const secretKey = env.SUMSUB_SECRET_KEY?.trim() ?? '';
  if (!appToken && !secretKey) return null;
  if (!appToken || !secretKey) {
    throw new Error('Set both SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY, or neither.');
  }
  if (!appToken.startsWith('sbx:')) {
    throw new Error('SUMSUB_APP_TOKEN is not a Sumsub sandbox token (sandbox tokens start with "sbx:"). Login uses the Sumsub sandbox only.');
  }
  const webhookSecret = env.SUMSUB_WEBHOOK_SECRET?.trim() || null;
  if (!webhookSecret && rpId !== 'localhost') {
    throw new Error('SUMSUB_WEBHOOK_SECRET is required outside local development.');
  }
  const enabledLevels = (env.SUMSUB_LEVELS?.trim() || LEVELS.join(','))
    .split(',')
    .map((l) => l.trim().toUpperCase());
  if (!enabledLevels.every((l, i) => l === LEVELS[i])) {
    throw new Error('SUMSUB_LEVELS must list levels in order from L1, for example "L1" or "L1,L2".');
  }
  return {
    enabledLevels: enabledLevels as Level[],
    appToken,
    secretKey,
    webhookSecret,
    levelNames: {
      L1: env.SUMSUB_LEVEL_L1?.trim() || 'login-l1-liveness',
      L2: env.SUMSUB_LEVEL_L2?.trim() || 'login-l2-identity',
      L3: env.SUMSUB_LEVEL_L3?.trim() || 'login-l3-address',
    },
  };
}
