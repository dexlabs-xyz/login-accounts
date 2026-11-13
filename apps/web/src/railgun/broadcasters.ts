/**
 * Which Railgun broadcaster submits a send or withdrawal.
 *
 * The broadcaster client's own pick (findBestBroadcaster) is simply the cheapest. On Sepolia, 13 Nov 2026, three
 * broadcasters took our fee token (WETH), and the cheapest had a reliability score of 0.34: it refused almost every
 * transaction ("Broadcaster cannot process this transaction"), so every first send failed and only "Review" again,
 * which skips a broadcaster that refused, went through. The others scored 0.86 and 0.99 for about 7% and 21% more
 * (a fraction of a cent on testnet, still capped by MAX_FEE_WEI and shown on Review).
 *
 * So pick the most reliable one, and the cheaper of equally reliable ones. Reliability is the broadcaster's own
 * published score: a signal to choose by, not a guarantee, so a refusal still skips that broadcaster next time.
 */
export interface BroadcasterChoice {
  tokenFee: { feePerUnitGas: string; reliability: number };
}

export function pickBroadcaster<T extends BroadcasterChoice>(candidates: readonly T[] | undefined): T | undefined {
  if (!candidates?.length) return undefined;
  return [...candidates].sort((a, b) => {
    const r = (b.tokenFee.reliability ?? 0) - (a.tokenFee.reliability ?? 0);
    if (r !== 0) return r;
    const fa = BigInt(a.tokenFee.feePerUnitGas);
    const fb = BigInt(b.tokenFee.feePerUnitGas);
    return fa === fb ? 0 : fa < fb ? -1 : 1;
  })[0];
}

/**
 * The broadcaster's own short reason for refusing, safe to show: it's the broadcaster's text, not wallet data, and
 * anything address- or hash-like is cut out anyway. So the next refusal says why instead of leaving us guessing.
 */
export function refusalReason(e: unknown): string | undefined {
  const cause = e instanceof Error ? e.cause : undefined;
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const clean = text
    .replace(/0x[0-9a-fA-F]{8,}/g, '…')
    .replace(/0zk[0-9a-z]{10,}/g, '…')
    .replace(/[^\x20-\x7E\u00A0-\u024F’“”…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}
