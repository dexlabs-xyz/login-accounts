/** Who funded a deposit address, from public chain data (for the withdraw warning). */
import { describe, expect, it } from 'vitest';
import { sendersFromLogs, sendersOfTxs } from './deposits.ts';

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
