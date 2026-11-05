/** Tidepool is untrusted: these checks are what stop a bad response from redirecting a deposit. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEPOLIA_USDT } from '../railgun/protocol.ts';
import { formatUnits, getQuote, getStatus, isValidAddress, loadTokens, toUnits, type Token } from './tidepool.ts';

const usdt: Token = { assetId: 'nep141:eth-usdt', blockchain: 'eth', symbol: 'USDT', decimals: 6, contractAddress: SEPOLIA_USDT };
const usdc: Token = { assetId: 'nep141:base-usdc', blockchain: 'base', symbol: 'USDC', decimals: 6, contractAddress: '0x38d81431B9f76d9699AF7517040D5221D9dEA252' };
const ME = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}
const goodQuote = (over: Record<string, unknown> = {}, echo: Record<string, unknown> = {}) => ({
  quote: { depositAddress: DEPOSIT, amountIn: '5000000', amountInFormatted: '5', amountOut: '4988546', minAmountOut: '4938660', deadline: '2026-11-05T12:00:00Z', timeEstimate: 60, ...over },
  quoteRequest: { recipient: ME, destinationAsset: usdt.assetId, refundTo: ME, ...echo },
});
const ask = () => getQuote({ origin: usdc, usdt, amount: '5000000', recipient: ME, refundTo: ME });

afterEach(() => vi.unstubAllGlobals());

describe('tokens', () => {
  it('accepts the verified Sepolia USDT', async () => {
    mockFetch([usdt, usdc, { ...usdc, blockchain: 'polygon' }]);
    const r = await loadTokens();
    expect(r.usdt.contractAddress).toBe(SEPOLIA_USDT);
    expect(r.origins.map((t) => t.blockchain)).toEqual(['eth', 'base']); // unsupported chains filtered out
  });
  it('refuses if Tidepool’s USDT is a different contract than the one we checked', async () => {
    mockFetch([{ ...usdt, contractAddress: '0x9999999999999999999999999999999999999999' }]);
    await expect(loadTokens()).rejects.toThrow('not the token we verified');
  });
});

describe('quotes', () => {
  it('accepts a quote that matches the request', async () => {
    mockFetch(goodQuote());
    expect((await ask()).depositAddress).toBe(DEPOSIT);
  });
  it('rejects a quote for a different recipient (someone else would get the USDT)', async () => {
    mockFetch(goodQuote({}, { recipient: '0x3333333333333333333333333333333333333333' }));
    await expect(ask()).rejects.toThrow('doesn’t match');
  });
  it('rejects a different destination token or refund address', async () => {
    mockFetch(goodQuote({}, { destinationAsset: 'nep141:other' }));
    await expect(ask()).rejects.toThrow('doesn’t match');
    mockFetch(goodQuote({}, { refundTo: '0x3333333333333333333333333333333333333333' }));
    await expect(ask()).rejects.toThrow('doesn’t match');
  });
  it('rejects nonsense amounts and addresses', async () => {
    for (const bad of [
      { amountIn: '9999999' }, // not what we asked to send
      { amountOut: '0' },
      { minAmountOut: '5000000' }, // minimum above expected
      { amountOut: '1e9' },
      { depositAddress: 'not-an-address' },
      { depositAddress: 'So1anaAddressOnAnEvmChain1111111111111111' },
    ]) {
      mockFetch(goodQuote(bad));
      await expect(ask(), JSON.stringify(bad)).rejects.toThrow('invalid quote');
    }
  });
  it('surfaces Tidepool errors', async () => {
    mockFetch({ message: 'Amount too low' }, 400);
    await expect(ask()).rejects.toThrow('Amount too low');
  });
});

describe('status', () => {
  it('accepts known statuses and rejects anything else', async () => {
    mockFetch({ status: 'PROCESSING' });
    expect(await getStatus(DEPOSIT)).toBe('PROCESSING');
    mockFetch({ status: 'SUCCESS_TRUST_ME' });
    await expect(getStatus(DEPOSIT)).rejects.toThrow('Unknown');
  });
});

describe('amounts and addresses', () => {
  it('parses user amounts exactly, rejecting too many decimals', () => {
    expect(toUnits('5', 6)).toBe('5000000');
    expect(toUnits('0.000001', 6)).toBe('1');
    expect(toUnits('1.2345678', 6)).toBeNull();
    expect(toUnits('0', 6)).toBeNull();
    expect(toUnits('abc', 6)).toBeNull();
    expect(toUnits('-1', 6)).toBeNull();
  });
  it('formats units', () => {
    expect(formatUnits('4988546', 6)).toBe('4.98');
    expect(formatUnits('5000000', 6)).toBe('5');
  });
  it('validates addresses per chain', () => {
    expect(isValidAddress('base', ME)).toBe(true);
    expect(isValidAddress('sol', ME)).toBe(false);
    expect(isValidAddress('sol', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe(true);
  });
});
