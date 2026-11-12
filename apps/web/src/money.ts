/**
 * Money on screen in dollars (Gold, 11 Nov): balances with 2 decimals, review
 * screens exact. USDT/USDC are dollar stablecoins; other tokens keep their own
 * symbol. Rounds down, so a balance is never shown higher than it is.
 */
export function usd(units: bigint | string, decimals: number, opts: { exact?: boolean; sign?: boolean } = {}): string {
  let v = BigInt(units);
  const negative = v < 0n;
  if (negative) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString('en-US');
  let frac = (v % base).toString().padStart(decimals, '0');
  frac = opts.exact ? frac.replace(/0+$/, '').padEnd(2, '0') : frac.slice(0, 2).padEnd(2, '0');
  const sign = negative ? '-' : opts.sign ? '+' : '';
  return `${sign}$${whole}.${frac}`;
}
