/**
 * Pure decisions for EVM deposits (no network): easy to test. TESTNET ONLY.
 *
 * Everything a user deposits ends as private USDT, except what the deposit
 * address needs: gas for its own transactions, and a small hidden ETH reserve
 * in the private balance that pays broadcaster fees (Sepolia broadcasters
 * only take ETH; the screen shows fees in USDT). On mainnet broadcasters take
 * USDT, so the reserve isn't needed there.
 */
import { DEPOSIT_ETH_GAS_KEEP_WEI } from '../railgun/protocol.ts';

/** The hidden private ETH reserve we top up to. Sepolia sends cost ~0.000000002 ETH, so this lasts. */
export const FEE_RESERVE_TARGET_WEI = 1_000_000_000_000_000n; // 0.001 ETH
/** Don't swap less ETH than this; it stays as gas and joins the reserve instead. */
export const MIN_ETH_SWAP_WEI = 500_000_000_000_000n; // 0.0005 ETH

/**
 * How much of the ETH at a deposit address to swap into USDT.
 * Only ETH the user sent is ever swapped (never testnet-faucet gas), and the
 * address always keeps enough for gas plus whatever the reserve is missing.
 */
export function ethToSwap(p: { balanceWei: bigint; userEthWei: bigint; reserveWei: bigint }): bigint {
  const missingReserve = p.reserveWei >= FEE_RESERVE_TARGET_WEI ? 0n : FEE_RESERVE_TARGET_WEI - p.reserveWei;
  const keep = DEPOSIT_ETH_GAS_KEEP_WEI + missingReserve;
  if (p.balanceWei <= keep) return 0n;
  const available = p.balanceWei - keep;
  const swap = available < p.userEthWei ? available : p.userEthWei;
  return swap >= MIN_ETH_SWAP_WEI ? swap : 0n;
}
