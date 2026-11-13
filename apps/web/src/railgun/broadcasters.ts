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
