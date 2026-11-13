import { describe, expect, it } from 'vitest';
import { pickBroadcaster } from './broadcasters.ts';

const b = (name: string, fee: string, reliability: number) => ({ name, tokenFee: { feePerUnitGas: fee, reliability } });

describe('pickBroadcaster', () => {
  it('picks the most reliable, not the cheapest (Sepolia, 13 Nov: the cheapest refused almost everything)', () => {
    const live = [b('cheap', '0xbfd8b6c1df00000', 0.34), b('mid', '0xcc47f20295c0000', 0.86), b('steady', '0xe92596fd6290000', 0.99)];
    expect(pickBroadcaster(live)?.name).toBe('steady');
  });
  it('picks the cheaper of equally reliable broadcasters', () => {
    expect(pickBroadcaster([b('dear', '0x20', 0.9), b('cheap', '0x10', 0.9)])?.name).toBe('cheap');
  });
  it('returns nothing when there is no broadcaster', () => {
    expect(pickBroadcaster([])).toBeUndefined();
    expect(pickBroadcaster(undefined)).toBeUndefined();
  });
});
