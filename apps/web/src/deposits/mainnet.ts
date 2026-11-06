/**
 * MAINNET price check, read-only. An approved exception to the testnet-only
 * rule (team lead, 5 Nov 2026): shows what official NEAR Intents (1Click,
 * mainnet) would give for the same kind of swap right now.
 *
 *   - `dry: true` only: no deposit address is created and nothing can be sent.
 *   - A fixed placeholder address, never a user's real address.
 *   - A fixed example amount, never the user's own.
 *   - Called from the browser, never through Login's server; untrusted input.
 *   - Never blocks anything: on any error the line simply isn't shown.
 *
 * See docs/design/passkeys.md, "Testnet-only exceptions".
 */
export const MAINNET_1CLICK = 'https://1click.chaindefuser.com';

/** Mainnet asset IDs (checked 6 Nov 2026: Circle's USDC and Tether's USDT contracts on Ethereum). */
const MAINNET_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const MAINNET_USDT = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
/** A well-known burn address: dry quotes need one, and it must never be a user's. */
const PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';
export const EXAMPLE_USDC = 100;

export interface MainnetPrice {
  usdcIn: number;
  usdtOut: string;
  seconds: number;
}

/** 100 USDC -> USDT on mainnet NEAR Intents, priced now. Rejects on anything unexpected. */
export async function mainnetPriceCheck(signal?: AbortSignal): Promise<MainnetPrice> {
  const res = await fetch(`${MAINNET_1CLICK}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: MAINNET_USDC,
      destinationAsset: MAINNET_USDT,
      amount: String(EXAMPLE_USDC * 1_000_000),
      depositType: 'ORIGIN_CHAIN',
      refundTo: PLACEHOLDER,
      refundType: 'ORIGIN_CHAIN',
      recipient: PLACEHOLDER,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`1Click ${res.status}`);
  const data = (await res.json()) as { quote?: { amountOut?: unknown; timeEstimate?: unknown; depositAddress?: unknown } };
  const q = data.quote ?? {};
  // A dry quote must not come with a deposit address; if it does, something is wrong: show nothing.
  if (q.depositAddress) throw new Error('Unexpected deposit address on a dry quote.');
  if (typeof q.amountOut !== 'string' || !/^\d+$/.test(q.amountOut) || BigInt(q.amountOut) === 0n) throw new Error('Bad quote.');
  const out = Number(BigInt(q.amountOut)) / 1e6;
  // Sanity: a stablecoin swap outside 90-110% is not something to show.
  if (out < EXAMPLE_USDC * 0.9 || out > EXAMPLE_USDC * 1.1) throw new Error('Implausible quote.');
  const seconds = typeof q.timeEstimate === 'number' && q.timeEstimate > 0 ? q.timeEstimate : 0;
  return { usdcIn: EXAMPLE_USDC, usdtOut: out.toFixed(2), seconds };
}
