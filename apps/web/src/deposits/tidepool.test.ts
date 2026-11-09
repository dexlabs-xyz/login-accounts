/** Tidepool is untrusted: these checks are what stop a bad response from redirecting a deposit. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEPOLIA_USDC, SEPOLIA_USDT } from '../railgun/protocol.ts';
import { formatUnits, getQuote, getStatus, isValidAddress, loadTokens, toUnits, withdrawTokens, type Token } from './tidepool.ts';

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
  const sepUsdc: Token = { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, contractAddress: SEPOLIA_USDC };
  const sepEth: Token = { assetId: 'nep141:eth', blockchain: 'eth', symbol: 'ETH', decimals: 18, price: 2240.26 };
  const solUsdc: Token = { assetId: 'nep141:sol-usdc', blockchain: 'sol', symbol: 'USDC', decimals: 6 };

  it('accepts the verified Sepolia USDT; only Solana goes through Tidepool’s own deposit address', async () => {
    mockFetch([usdt, usdc, sepUsdc, sepEth, solUsdc, { ...usdc, blockchain: 'polygon' }]);
    const r = await loadTokens();
    expect(r.usdt.contractAddress).toBe(SEPOLIA_USDT);
    expect(r.origins.map((t) => t.blockchain)).toEqual(['sol']); // EVM deposits use our own address
    expect(r.sepolia?.usdc.contractAddress).toBe(SEPOLIA_USDC);
    expect(r.sepolia?.eth.assetId).toBe('nep141:eth');
    expect(r.ethPrice).toBe(2240.26);
  });
  it('won’t swap from a Sepolia USDC that isn’t the contract we checked, or an ETH with a contract', async () => {
    mockFetch([usdt, { ...sepUsdc, contractAddress: '0x9999999999999999999999999999999999999999' }, sepEth]);
    expect((await loadTokens()).sepolia).toBeNull();
    mockFetch([usdt, sepUsdc, { ...sepEth, contractAddress: '0x9999999999999999999999999999999999999999' }]);
    expect((await loadTokens()).sepolia).toBeNull();
  });
  it('ignores a nonsense ETH price (it only labels fees)', async () => {
    mockFetch([usdt, sepUsdc, { ...sepEth, price: -1 }]);
    expect((await loadTokens()).ethPrice).toBeNull();
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

describe('withdrawals through a swap', () => {
  const sepUsdc: Token = { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, contractAddress: SEPOLIA_USDC };
  const sepEth: Token = { assetId: 'nep141:eth', blockchain: 'eth', symbol: 'ETH', decimals: 18 };
  const arbEth: Token = { assetId: 'nep141:arb', blockchain: 'arb', symbol: 'ETH', decimals: 18 };
  const solUsdc: Token = { assetId: 'nep141:sol-usdc', blockchain: 'sol', symbol: 'USDC', decimals: 6 };
  const sol: Token = { assetId: 'nep141:sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };

  it('offers exactly the agreed list, in order, and never SOL', () => {
    const list = withdrawTokens([sol, usdc, arbEth, solUsdc, sepUsdc, sepEth, usdt]);
    expect(list.map((t) => `${t.symbol}@${t.blockchain}`)).toEqual(['ETH@eth', 'USDC@eth', 'USDC@sol', 'USDC@base', 'ETH@arb']);
  });
  it('drops a Sepolia USDC that isn’t our verified contract, and an "ETH" with a contract', () => {
    const bad = withdrawTokens([{ ...sepUsdc, contractAddress: '0x9999999999999999999999999999999999999999' }, { ...sepEth, contractAddress: '0x99' }]);
    expect(bad).toEqual([]);
  });
  it('a quote must be for the token we asked for', async () => {
    const SOL_ME = '7pafEGXSmR35rLKNaD6inpfLYuEnRX9DyBc1c7M8r4Xr';
    const q = (echo: Record<string, unknown>) => ({
      quote: { depositAddress: DEPOSIT, amountIn: '9975000', amountOut: '9940000', minAmountOut: '9840000', deadline: '2026-11-09T12:00:00Z' },
      quoteRequest: { recipient: SOL_ME, destinationAsset: solUsdc.assetId, refundTo: ME, ...echo },
    });
    const askSwap = () => getQuote({ origin: usdt, usdt, destination: solUsdc, amount: '9975000', recipient: SOL_ME, refundTo: ME });
    mockFetch(q({}));
    expect((await askSwap()).depositAddress).toBe(DEPOSIT);
    mockFetch(q({ destinationAsset: usdt.assetId }));
    await expect(askSwap()).rejects.toThrow('doesn’t match');
  });
});
