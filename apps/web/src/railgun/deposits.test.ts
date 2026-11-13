/** Deposit helpers: who funded a deposit address (withdraw warning), and per-account record slots. */
import { describe, expect, it } from 'vitest';
import { LEGACY_RECORDS_SLOT, loadSealedRecords, recordsSlot, sendersFromLogs, sendersOfTxs } from './deposits.ts';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const RABBY = '0x6fFE000000000000000000000000000000d4c55A';
const DEPOSIT = '0x1111111111111111111111111111111111111111';

describe('sendersFromLogs', () => {
  it('takes the sender (topic 1) of Transfer logs, lowercase', () => {
    expect(sendersFromLogs([{ topics: [TRANSFER, pad(RABBY), pad(DEPOSIT)] }])).toEqual([RABBY.toLowerCase()]);
  });
  it('ignores other events and malformed logs', () => {
    expect(sendersFromLogs([{ topics: ['0xabc', pad(RABBY), pad(DEPOSIT)] }, { topics: [TRANSFER] }])).toEqual([]);
  });
});

describe('sendersOfTxs', () => {
  it('finds who sent ETH to the deposit address, whatever the address case', () => {
    const txs = [
      { from: RABBY, to: DEPOSIT.toUpperCase().replace('0X', '0x'), value: 3n },
      { from: '0x2222222222222222222222222222222222222222', to: '0x3333333333333333333333333333333333333333', value: 5n },
      { from: '0x4444444444444444444444444444444444444444', to: null, value: 1n }, // contract creation
      { from: '0x5555555555555555555555555555555555555555', to: DEPOSIT, value: 0n }, // a call, no ETH
    ];
    expect(sendersOfTxs(txs, DEPOSIT)).toEqual([RABBY.toLowerCase()]);
  });
});

describe('records slots (several accounts in one browser)', () => {
  const store = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return {
      m,
      get: async (k: string) => m.get(k),
      put: async (k: string, v: string) => void m.set(k, v),
      remove: async (k: string) => void m.delete(k),
    };
  };
  // "Sealed" as owner:data; opening with the wrong owner fails, like a wrong key.
  const openAs = (owner: string) => async (sealed: string) => {
    const [o, data] = sealed.split(':');
    if (o !== owner) throw new Error('decrypt-failed');
    return data;
  };

  it('opens this account’s own slot', async () => {
    const s = store({ [recordsSlot('a')]: 'a:A', [LEGACY_RECORDS_SLOT]: 'b:B' });
    expect(await loadSealedRecords(s, recordsSlot('a'), openAs('a'))).toBe('A');
  });

  it('a new account starts empty and leaves another account’s old records alone', async () => {
    const s = store({ [LEGACY_RECORDS_SLOT]: 'a:A' });
    expect(await loadSealedRecords(s, recordsSlot('b'), openAs('b'))).toBeNull();
    expect(s.m.get(LEGACY_RECORDS_SLOT)).toBe('a:A');
  });

  it('moves the owner’s old records into its own slot', async () => {
    const s = store({ [LEGACY_RECORDS_SLOT]: 'a:A' });
    expect(await loadSealedRecords(s, recordsSlot('a'), openAs('a'))).toBe('A');
    expect(s.m.get(recordsSlot('a'))).toBe('a:A');
    expect(s.m.has(LEGACY_RECORDS_SLOT)).toBe(false);
  });

  it('nothing stored: empty', async () => {
    expect(await loadSealedRecords(store({}), recordsSlot('a'), openAs('a'))).toBeNull();
  });
});
