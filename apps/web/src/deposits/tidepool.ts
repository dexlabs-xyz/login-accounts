/**
 * Tidepool: a community-run, testnet-only API compatible with NEAR Intents'
 * 1Click API (https://www.usetidepool.tech). Called directly from the browser,
 * never through Login's server. TESTNET ONLY.
 *
 * Tidepool is a third party: every response is treated as untrusted input and
 * checked before we act on it (team rule). The API base is one setting, so the
 * same calls can point at official 1Click later.
 */
import { SEPOLIA_USDC, SEPOLIA_USDT } from '../railgun/protocol.ts';

export const TIDEPOOL_API = 'https://www.usetidepool.tech';
/** Chains we accept deposits from for the hackathon. */
export const ORIGIN_CHAINS = ['eth', 'base', 'arb', 'sol'] as const;
export type OriginChain = (typeof ORIGIN_CHAINS)[number];
export const CHAIN_NAMES: Record<OriginChain, string> = {
  eth: 'Ethereum Sepolia',
  base: 'Base Sepolia',
  arb: 'Arbitrum Sepolia',
  sol: 'Solana devnet',
};

export interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string;
  /** USD price Tidepool reports. Untrusted; only used to show fees in USDT. */
  price?: number;
}

/** Tokens an EVM deposit address can swap into USDT on Ethereum Sepolia. */
export interface SepoliaSwapTokens {
  usdc: Token;
  eth: Token;
}

export type SwapStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';
const STATUSES: SwapStatus[] = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'];

export class TidepoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TidepoolError';
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIGITS = /^\d+$/;

export function isValidAddress(chain: string, address: string): boolean {
  return chain === 'sol' ? SOL_ADDRESS.test(address) : EVM_ADDRESS.test(address);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(TIDEPOOL_API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as T | { message?: string } | null;
  if (!res.ok || !data) throw new TidepoolError((data as { message?: string } | null)?.message ?? `Tidepool error ${res.status}`);
  return data as T;
}

/**
 * What a withdrawal can arrive as, besides USDT on Ethereum Sepolia (team
 * decision, 9 Nov 2026). SOL is left out: Tidepool caps it at 0.005 SOL per swap.
 */
export const WITHDRAW_TOKENS = [
  { blockchain: 'eth', symbol: 'ETH' },
  { blockchain: 'eth', symbol: 'USDC' },
  { blockchain: 'sol', symbol: 'USDC' },
  { blockchain: 'base', symbol: 'USDC' },
  { blockchain: 'arb', symbol: 'ETH' },
] as const;

/** Tidepool's withdrawal tokens, checked: the Sepolia ones against our verified contracts. */
export function withdrawTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const w of WITHDRAW_TOKENS) {
    const t = tokens.find((x) => x.blockchain === w.blockchain && x.symbol === w.symbol);
    if (!t || typeof t.assetId !== 'string' || !Number.isInteger(t.decimals)) continue;
    if (w.symbol === 'ETH' && (t.decimals !== 18 || t.contractAddress)) continue; // native ETH only
    if (w.blockchain === 'eth' && w.symbol === 'USDC' && (t.contractAddress?.toLowerCase() !== SEPOLIA_USDC.toLowerCase() || t.decimals !== 6)) continue;
    out.push(t);
  }
  return out;
}

/** The deposit destination: Tidepool's test USDT on Ethereum Sepolia. Must match our checked token. */
export async function loadTokens(): Promise<{
  usdt: Token;
  origins: Token[];
  sepolia: SepoliaSwapTokens | null;
  ethPrice: number | null;
  /** What a withdrawal can arrive as, through a swap. */
  withdraw: Token[];
}> {
  const tokens = await call<Token[]>('GET', '/v0/tokens');
  if (!Array.isArray(tokens)) throw new TidepoolError('Unexpected token list.');
  const usdt = tokens.find((t) => t.blockchain === 'eth' && t.symbol === 'USDT');
  if (!usdt || usdt.contractAddress?.toLowerCase() !== SEPOLIA_USDT.toLowerCase() || usdt.decimals !== 6) {
    // Never deliver to a token we haven't checked.
    throw new TidepoolError('Tidepool’s Sepolia USDT is not the token we verified.');
  }
  // Solana deposits go through Tidepool's own deposit address (team decision, 6 Nov).
  // EVM deposits use our own fresh address instead (see `sepolia` below).
  const origins = tokens.filter(
    (t) =>
      t.blockchain === 'sol' &&
      ['USDC', 'USDT', 'SOL'].includes(t.symbol) &&
      Number.isInteger(t.decimals) &&
      typeof t.assetId === 'string',
  );
  // Swap sources for EVM deposits: only the USDC we verified, and native ETH (no contract).
  const usdc = tokens.find((t) => t.blockchain === 'eth' && t.symbol === 'USDC');
  const eth = tokens.find((t) => t.blockchain === 'eth' && t.symbol === 'ETH');
  const sepolia =
    usdc &&
    usdc.contractAddress?.toLowerCase() === SEPOLIA_USDC.toLowerCase() &&
    usdc.decimals === 6 &&
    eth &&
    eth.decimals === 18 &&
    !eth.contractAddress &&
    typeof usdc.assetId === 'string' &&
    typeof eth.assetId === 'string'
      ? { usdc, eth }
      : null;
  const ethPrice = typeof eth?.price === 'number' && Number.isFinite(eth.price) && eth.price > 0 ? eth.price : null;
  return { usdt, origins, sepolia, ethPrice, withdraw: withdrawTokens(tokens) };
}

export interface Quote {
  depositAddress: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  minAmountOut: string;
  deadline: string;
  timeEstimate: number;
}

/**
 * Ask for a real quote: the user's tokens on the origin chain, delivered as
 * USDT to our fresh Sepolia address (deposits), or Sepolia USDT delivered as
 * `destination` to the user's address (withdrawals). Checks the answer matches
 * what we asked.
 */
export async function getQuote(p: {
  origin: Token;
  usdt: Token;
  /** Withdrawals: what arrives. Default: USDT on Sepolia. */
  destination?: Token;
  amount: string; // smallest units
  recipient: string; // deposits: fresh Sepolia address; withdrawals: the user's address
  refundTo: string; // on the origin chain
}): Promise<Quote> {
  const destination = p.destination ?? p.usdt;
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const res = await call<{ quote?: Partial<Quote>; quoteRequest?: Record<string, unknown> }>('POST', '/v0/quote', {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: p.origin.assetId,
    destinationAsset: destination.assetId,
    amount: p.amount,
    depositType: 'ORIGIN_CHAIN',
    refundTo: p.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: p.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline,
  });
  const q = res.quote ?? {};
  const echo = res.quoteRequest ?? {};
  // Untrusted input: the answer must be for exactly our request, to our address.
  if (echo.recipient !== p.recipient || echo.destinationAsset !== destination.assetId || echo.refundTo !== p.refundTo) {
    throw new TidepoolError('Tidepool’s quote doesn’t match the request.');
  }
  if (
    typeof q.depositAddress !== 'string' ||
    !isValidAddress(p.origin.blockchain, q.depositAddress) ||
    q.amountIn !== p.amount ||
    !DIGITS.test(q.amountOut ?? '') ||
    !DIGITS.test(q.minAmountOut ?? '') ||
    BigInt(q.minAmountOut!) > BigInt(q.amountOut!) ||
    BigInt(q.amountOut!) === 0n
  ) {
    throw new TidepoolError('Tidepool sent an invalid quote.');
  }
  return {
    depositAddress: q.depositAddress,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted ?? '',
    amountOut: q.amountOut!,
    minAmountOut: q.minAmountOut!,
    deadline: q.deadline ?? deadline,
    timeEstimate: typeof q.timeEstimate === 'number' ? q.timeEstimate : 60,
  };
}

export async function getStatus(depositAddress: string): Promise<SwapStatus> {
  const res = await call<{ status?: string }>('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (!STATUSES.includes(res.status as SwapStatus)) throw new TidepoolError('Unknown swap status.');
  return res.status as SwapStatus;
}

export const isFinal = (s: SwapStatus) => s === 'SUCCESS' || s === 'REFUNDED' || s === 'FAILED';

/** Parse a user-typed amount ("12.5") into smallest units, or null. */
export function toUnits(text: string, decimals: number): string | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const units = BigInt(m[1]! + frac.padEnd(decimals, '0'));
  return units > 0n ? units.toString() : null;
}

export function formatUnits(units: string, decimals: number, maxFraction = 2): string {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
