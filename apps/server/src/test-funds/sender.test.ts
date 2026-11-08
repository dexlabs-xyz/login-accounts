/** TESTNET-ONLY test funds: the shield-fee gross-up and the "can the pool pay?" rule. */
import { describe, expect, it } from 'vitest';
import { grossForShield } from './pool.ts';
import { canPayClaim, CLAIM_FEE_RESERVE_WEI, CLAIM_USDT } from './sender.ts';

const ETH = 10n ** 18n;
const fee = (gross: bigint, bp: bigint) => (gross * bp) / 10_000n; // Railgun: rounded down

describe('grossForShield', () => {
  it('adds the fee on top so the claimer receives at least the amount, and at most 1 unit more', () => {
    for (const bp of [0n, 25n, 50n, 100n]) {
      for (const net of [1n, 999n, CLAIM_USDT, CLAIM_FEE_RESERVE_WEI, 123_456_789n]) {
        const gross = grossForShield(net, bp);
        const received = gross - fee(gross, bp);
        expect(received >= net).toBe(true);
        expect(received - net <= 1n).toBe(true);
      }
    }
  });
  it('1,000 USDT at 0.25% costs 1,002.506266 USDT', () => {
    expect(grossForShield(CLAIM_USDT, 25n)).toBe(1_002_506_266n);
  });
});

describe('canPayClaim', () => {
  const ok = { usdt: 50_000n * 1_000_000n, weth: 0n, eth: ETH / 20n }; // what the pool holds after the top-up
  it('pays with enough USDT and ETH (wrapping a 0.01 batch and keeping gas)', () => {
    expect(canPayClaim(ok, 25n)).toBe(true);
  });
  it('refuses when USDT is short of 1,000 plus the fee', () => {
    expect(canPayClaim({ ...ok, usdt: CLAIM_USDT }, 25n)).toBe(false);
    expect(canPayClaim({ ...ok, usdt: grossForShield(CLAIM_USDT, 25n) }, 25n)).toBe(true);
  });
  it('refuses when ETH would not cover the wrap plus gas', () => {
    expect(canPayClaim({ ...ok, eth: ETH / 100n }, 25n)).toBe(false); // 0.01: no room for gas
    expect(canPayClaim({ ...ok, eth: (13n * ETH) / 1000n }, 25n)).toBe(true); // 0.013
  });
  it('already-wrapped WETH only needs gas', () => {
    expect(canPayClaim({ ...ok, weth: ETH / 100n, eth: (3n * ETH) / 1000n }, 25n)).toBe(true);
    expect(canPayClaim({ ...ok, weth: ETH / 100n, eth: (2n * ETH) / 1000n }, 25n)).toBe(false);
  });
});
