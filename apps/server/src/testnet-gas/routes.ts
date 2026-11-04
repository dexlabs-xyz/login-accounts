/**
 * TESTNET-ONLY SIMULATION. Do not port to mainnet. Delete before any mainnet work.
 *
 * Login testnet gas faucet: sends a little Sepolia ETH to a user's fresh deposit
 * address so it can pay the gas to shield its test USDT. Exists only because
 * Tidepool (the community testnet for NEAR Intents) can't deliver native
 * Sepolia ETH. On mainnet, NEAR Intents delivers ETH with the deposit instead.
 *
 * This knowingly CONTRADICTS decision D6: this server sees a signed-in user's
 * deposit address and when it was requested. To keep that exposure as small as
 * possible it stores nothing: no database rows, no logs of addresses, no
 * analytics. Rate limits live in memory, keyed by user ID only.
 * See docs/design/passkeys.md, "Testnet-only exceptions".
 */
import { Hono } from 'hono';
import { isAddress, getAddress, ZeroAddress } from 'ethers';
import { ApiError, readJson } from '../http.ts';
import type { Sessions } from '../passkeys/session.ts';

export const SEPOLIA_CHAIN_ID = 11155111n;

/** What the faucet needs from the chain. Real implementation: ./sender.ts. */
export interface GasSender {
  chainId(): Promise<bigint>;
  balanceOf(address: string): Promise<bigint>;
  /** Sends `amountWei` to `to`; returns the transaction hash. */
  send(to: string, amountWei: bigint): Promise<string>;
}

export interface GasLimits {
  /** Amount sent per request, in wei. */
  amountWei: bigint;
  perUserPerHour: number;
  globalPerHour: number;
}

export const DEFAULT_LIMITS: GasLimits = {
  amountWei: 2_000_000_000_000_000n, // 0.002 Sepolia ETH: enough for an approve + shield
  perUserPerHour: 5,
  globalPerHour: 60,
};

const HOUR = 60 * 60_000;

export function testnetGasRoutes({
  sessions,
  sender,
  limits = DEFAULT_LIMITS,
  now = Date.now,
}: {
  sessions: Sessions;
  sender: GasSender | null;
  limits?: GasLimits;
  now?: () => number;
}) {
  const app = new Hono();
  // In memory only: timestamps of recent sends, per user ID and overall. No addresses.
  const perUser = new Map<string, number[]>();
  let global: number[] = [];

  app.post('/api/testnet-gas', async (c) => {
    if (!sender) throw new ApiError(404, 'testnet-gas-disabled');
    const s = sessions.require(c); // only signed-in users, to limit abuse

    const { address } = await readJson<{ address?: unknown }>(c);
    if (typeof address !== 'string' || !isAddress(address) || getAddress(address) === ZeroAddress) {
      throw new ApiError(400, 'invalid-address');
    }
    const to = getAddress(address);

    // Hard stop: never send on anything but Sepolia, checked on every request.
    if ((await sender.chainId()) !== SEPOLIA_CHAIN_ID) throw new ApiError(403, 'not-testnet');

    const cutoff = now() - HOUR;
    global = global.filter((t) => t > cutoff);
    const mine = (perUser.get(s.user.id) ?? []).filter((t) => t > cutoff);
    if (mine.length >= limits.perUserPerHour || global.length >= limits.globalPerHour) {
      throw new ApiError(429, 'testnet-gas-rate-limited');
    }

    // Already has enough: don't send more.
    if ((await sender.balanceOf(to)) >= limits.amountWei) {
      return c.json({ status: 'already-funded' as const });
    }

    const txHash = await sender.send(to, limits.amountWei);
    mine.push(now());
    perUser.set(s.user.id, mine);
    global.push(now());
    return c.json({ status: 'sent' as const, txHash, amountWei: limits.amountWei.toString(), simulation: true });
  });

  return app;
}
