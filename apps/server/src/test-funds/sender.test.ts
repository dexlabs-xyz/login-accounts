/** TESTNET-ONLY test funds: the shield-fee gross-up and the "can the pool pay?" rule. */
import { describe, expect, it } from 'vitest';
import { grossForPieces, grossForShield, piecesFrom, splitIntoPieces } from './pool.ts';
import { canPayClaim, CLAIM_FEE_RESERVE_WEI, CLAIM_PIECES, CLAIM_USDT, CLAIM_USDT_PIECES, CLAIM_WETH_PIECES } from './sender.ts';

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
  it('250 USDT at 0.25% costs 250.626567 USDT', () => {
    expect(grossForShield(CLAIM_USDT, 25n)).toBe(250_626_567n);
  });
});

describe('canPayClaim', () => {
  const ok = { usdt: 50_000n * 1_000_000n, weth: 0n, eth: ETH / 20n }; // what the pool holds after the top-up
  it('pays with enough USDT and ETH (wrapping a 0.01 batch and keeping gas)', () => {
    expect(canPayClaim(ok, 25n)).toBe(true);
  });
  it('refuses when USDT is short of 250 plus the fee', () => {
    expect(canPayClaim({ ...ok, usdt: CLAIM_USDT }, 25n)).toBe(false);
    const gross = grossForPieces(CLAIM_USDT_PIECES, 25n); // each piece pays its own fee, rounded up
    expect(canPayClaim({ ...ok, usdt: gross - 1n }, 25n)).toBe(false);
    expect(canPayClaim({ ...ok, usdt: gross }, 25n)).toBe(true);
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

describe('claim pieces (one transaction each on Sepolia)', () => {
  it('250 USDT is 25 different pieces, none below 10, so a 10 USDT send uses exactly one', () => {
    expect(CLAIM_USDT_PIECES).toHaveLength(25);
    expect(new Set(CLAIM_USDT_PIECES).size).toBe(25);
    expect(CLAIM_USDT_PIECES.every((p) => p >= 10_000_000n && p < 10_000_100n)).toBe(true);
    const total = CLAIM_USDT_PIECES.reduce((a, b) => a + b, 0n);
    expect(total - CLAIM_USDT).toBe(300n); // 250.0003 USDT, shown as $250
  });
  it('piecesFrom counts up from the base', () => {
    expect(piecesFrom(10n, 3, 1n)).toEqual([10n, 11n, 12n]);
  });
  it('the fee reserve is 5 different pieces that add up to 0.001 ETH', () => {
    expect(CLAIM_WETH_PIECES).toHaveLength(CLAIM_PIECES);
    expect(new Set(CLAIM_WETH_PIECES).size).toBe(CLAIM_PIECES);
    expect(CLAIM_WETH_PIECES.reduce((a, b) => a + b, 0n)).toBe(CLAIM_FEE_RESERVE_WEI);
  });
  it('splitIntoPieces keeps the total when it does not divide evenly, with no two pieces equal', () => {
    for (const [total, count] of [[1_000_003n, 5], [101n, 4], [10n ** 18n + 7n, 3]] as const) {
      const pieces = splitIntoPieces(total, count, 1n);
      expect(pieces.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(new Set(pieces).size).toBe(count);
    }
  });
  it('each piece arrives exactly after its own shield fee', () => {
    for (const p of CLAIM_USDT_PIECES) {
      const gross = grossForShield(p, 25n);
      expect(gross - (gross * 25n) / 10_000n >= p).toBe(true);
    }
  });
});
