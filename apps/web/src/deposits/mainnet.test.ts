/** The mainnet price check is read-only and untrusted: these checks keep it that way. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mainnetPriceCheck } from './mainnet.ts';

let lastBody: Record<string, unknown> = {};
function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      lastBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body), { status });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('mainnet price check (approved read-only exception)', () => {
  it('asks for a dry quote with a placeholder address, never a real one', async () => {
    mockFetch({ quote: { amountOut: '99803189', timeEstimate: 52 } });
    expect(await mainnetPriceCheck()).toEqual({ usdcIn: 100, usdtOut: '99.80', seconds: 52 });
    expect(lastBody.dry).toBe(true);
    expect(lastBody.recipient).toBe('0x000000000000000000000000000000000000dEaD');
    expect(lastBody.refundTo).toBe('0x000000000000000000000000000000000000dEaD');
  });
  it('shows nothing if a "dry" quote comes back with a deposit address', async () => {
    mockFetch({ quote: { amountOut: '99803189', depositAddress: '0x1111111111111111111111111111111111111111' } });
    await expect(mainnetPriceCheck()).rejects.toThrow();
  });
  it('shows nothing for errors or implausible prices', async () => {
    mockFetch({ message: 'nope' }, 500);
    await expect(mainnetPriceCheck()).rejects.toThrow();
    mockFetch({ quote: { amountOut: '5000000' } }); // 100 USDC -> 5 USDT
    await expect(mainnetPriceCheck()).rejects.toThrow();
    mockFetch({ quote: { amountOut: 'lots' } });
    await expect(mainnetPriceCheck()).rejects.toThrow();
  });
});
