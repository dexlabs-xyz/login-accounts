import { describe, expect, it } from 'vitest';
import { DEPOSIT_ETH_GAS_KEEP_WEI } from '../railgun/protocol.ts';
import { ethToSwap, FEE_RESERVE_TARGET_WEI, MIN_ETH_SWAP_WEI } from './plan.ts';

const ETH = 1_000_000_000_000_000_000n;
const milli = (n: number) => (BigInt(n) * ETH) / 1000n;

describe('ethToSwap (EVM deposits)', () => {
  it('swaps what the user sent, keeping gas and topping up an empty fee reserve', () => {
    // 0.01 ETH sent, no reserve yet: keep 0.001 gas + 0.001 reserve.
    expect(ethToSwap({ balanceWei: milli(10), userEthWei: milli(10), reserveWei: 0n })).toBe(milli(8));
  });

  it('keeps only gas when the reserve is already full', () => {
    expect(ethToSwap({ balanceWei: milli(10), userEthWei: milli(10), reserveWei: FEE_RESERVE_TARGET_WEI })).toBe(milli(9));
  });

  it('tops up a partly full reserve', () => {
    expect(ethToSwap({ balanceWei: milli(10), userEthWei: milli(10), reserveWei: milli(1) / 2n })).toBe(milli(10) - DEPOSIT_ETH_GAS_KEEP_WEI - milli(1) / 2n);
  });

  it('never swaps testnet-faucet gas: only ETH the user sent', () => {
    // USDT-only deposit: the faucet sent 0.004 ETH, the user sent none.
    expect(ethToSwap({ balanceWei: milli(4), userEthWei: 0n, reserveWei: 0n })).toBe(0n);
    // User sent 0.003, faucet added 0.004: at most the user's 0.003 is swapped.
    expect(ethToSwap({ balanceWei: milli(7), userEthWei: milli(3), reserveWei: FEE_RESERVE_TARGET_WEI })).toBe(milli(3));
  });

  it('skips tiny swaps; that ETH stays as gas and joins the reserve', () => {
    expect(ethToSwap({ balanceWei: milli(2) + MIN_ETH_SWAP_WEI - 1n, userEthWei: milli(5), reserveWei: 0n })).toBe(0n);
    expect(ethToSwap({ balanceWei: milli(1), userEthWei: milli(1), reserveWei: 0n })).toBe(0n);
  });
});
