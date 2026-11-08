/**
 * TESTNET ONLY. Sends one claim from the pool: a single shield from the pool's
 * public address straight into the claimer's 0zk address, of 1,000 test USDT
 * plus 0.001 ETH as WETH (the claimer's hidden network-fee reserve). Railgun's
 * shield fee is added on top, so the claimer receives exactly these amounts.
 *
 * Why a shield and not a private transfer (team decision, 8 Nov 2026): a
 * self-signed private transfer needs the pool to publish its own privacy-check
 * data, which depends on Railgun's Sepolia transaction index. That index is
 * broken at position 4188 (block 11816741), which left the first private pool
 * stuck. Shields are checked by Railgun's privacy-check node itself, like any
 * deposit (about an hour), and don't touch that index.
 *
 * The pool's private wallet still runs, with its upkeep: if Railgun repairs the
 * index, the stuck private balance clears on its own.
 */
import {
  generatePOIsForWallet,
  generatePOIsForWalletAndRailgunTxid,
  getChainTxidsStillPendingSpentPOIs,
  syncRailgunTransactionsV2,
  refreshSpentPOIsForWallet,
  validateRailgunAddress,
} from '@railgun-community/wallet';
import { grossForShield, NETWORK, openPool, publicBalances, shieldClaim, V2, type Pool } from './pool.ts';

export const CLAIM_USDT = 1_000n * 1_000_000n; // 1,000 test USDT (team decision, 6 Nov)
export const CLAIM_FEE_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH, as private WETH
const WRAP_BATCH_WEI = 10_000_000_000_000_000n; // wrap 0.01 ETH at a time
const GAS_KEEP_WEI = 3_000_000_000_000_000n; // keep 0.003 ETH public for gas
const UPKEEP_MS = 60_000;

/** What the claim routes need from the pool. Real implementation below; tests use a fake. */
export interface TestFundsSender {
  /** False while Railgun is starting on this server. */
  ready(): boolean;
  /** Enough public USDT and ETH in the pool for one more claim (as of the last check). */
  canPay(): boolean;
  isValidAddress(railgunAddress: string): boolean;
  /** Sends one claim; resolves with the pool's public transaction hash. */
  send(railgunAddress: string): Promise<string>;
}

type Balances = Awaited<ReturnType<typeof publicBalances>>;

/** Pure, for tests: can these public balances pay one claim plus gas? */
export function canPayClaim(b: Balances, shieldFeeBasisPoints: bigint): boolean {
  const usdt = grossForShield(CLAIM_USDT, shieldFeeBasisPoints);
  const weth = grossForShield(CLAIM_FEE_RESERVE_WEI, shieldFeeBasisPoints);
  const wrapNeeded = b.weth >= weth ? 0n : weth - b.weth > WRAP_BATCH_WEI ? weth - b.weth : WRAP_BATCH_WEI;
  return b.usdt >= usdt && b.eth >= wrapNeeded + GAS_KEEP_WEI;
}

export function railgunTestFundsSender(opts: { mnemonic: string; rpcUrl: string; artifactDir: string }): TestFundsSender {
  let pool: Pool | null = null;
  let balances: Balances | null = null;
  const checkBalances = async (p: Pool) => {
    balances = await publicBalances(p).catch(() => balances); // keep the last reading if the RPC hiccups
  };

  let upkeepRunning = false;
  const upkeep = async () => {
    if (!pool || upkeepRunning) return; // one round at a time
    upkeepRunning = true;
    try {
      await checkBalances(pool);
      // Recovery of the earlier private pool (see top): harmless while Railgun's index is broken.
      await pool.refresh();
      await syncRailgunTransactionsV2(NETWORK);
      for (const txid of await getChainTxidsStillPendingSpentPOIs(V2, NETWORK, pool.walletId)) {
        await generatePOIsForWalletAndRailgunTxid(V2, NETWORK, pool.walletId, txid).catch(() => {});
      }
      await generatePOIsForWallet(NETWORK, pool.walletId);
      await refreshSpentPOIsForWallet(V2, NETWORK, pool.walletId);
    } catch (e) {
      // Third-party services may be slow; try again next round. Message only, no wallet details.
      console.error('Test-funds pool upkeep:', e instanceof Error ? e.message.slice(0, 120) : 'unknown');
    } finally {
      upkeepRunning = false;
    }
  };
  openPool(opts).then(
    async (p) => {
      await checkBalances(p);
      pool = p;
      void upkeep();
      setInterval(() => void upkeep(), UPKEEP_MS);
      console.log('Test-funds pool ready (TESTNET).');
    },
    (e: unknown) => console.error('Test-funds pool failed to start:', e instanceof Error ? e.message : 'unknown'),
  );

  return {
    ready: () => pool !== null && balances !== null,
    canPay: () => pool !== null && balances !== null && canPayClaim(balances, pool.shieldFeeBasisPoints),
    isValidAddress: (a) => typeof a === 'string' && validateRailgunAddress(a),
    // The routes send one claim at a time, so nonces and approvals never race.
    async send(to) {
      const p = pool;
      if (!p) throw new Error('pool-starting');
      try {
        return await shieldClaim(p, to, { usdt: CLAIM_USDT, weth: CLAIM_FEE_RESERVE_WEI }, WRAP_BATCH_WEI);
      } finally {
        await checkBalances(p);
      }
    },
  };
}
