/**
 * TESTNET ONLY. Sends one claim from the pool: a private transfer of 1,000
 * test USDT plus 0.001 private ETH (the claimer's hidden network-fee reserve)
 * to the claimer's 0zk address. The pool pays the gas from its own public
 * address, so no broadcaster is involved. Afterwards the pool publishes the
 * Proof of Innocence data for the transfer, so the claimer's funds clear.
 */
import {
  gasEstimateForUnprovenTransfer,
  generatePOIsForWallet,
  generateTransferProof,
  populateProvedTransfer,
  refreshSpentPOIsForWallet,
  validateRailgunAddress,
} from '@railgun-community/wallet';
import { EVMGasType, RailgunWalletBalanceBucket, type TransactionGasDetails } from '@railgun-community/shared-models';
import { balanceOf, NETWORK, openPool, SEPOLIA_USDT, SEPOLIA_WETH, V2, type Pool } from './pool.ts';

export const CLAIM_USDT = 1_000n * 1_000_000n; // 1,000 test USDT (team decision, 6 Nov)
export const CLAIM_FEE_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH, as private WETH
const UPKEEP_MS = 60_000;

/** What the claim routes need from the pool. Real implementation below; tests use a fake. */
export interface TestFundsSender {
  /** False while Railgun is starting or syncing on this server. */
  ready(): boolean;
  /** Enough spendable USDT and WETH in the pool for one more claim. */
  canPay(): boolean;
  isValidAddress(railgunAddress: string): boolean;
  /** Sends one claim; resolves with the pool's public transaction hash. */
  send(railgunAddress: string): Promise<string>;
}

export function railgunTestFundsSender(opts: { mnemonic: string; rpcUrl: string; artifactDir: string }): TestFundsSender {
  let pool: Pool | null = null;
  const upkeep = async () => {
    if (!pool) return;
    try {
      await pool.refresh();
      // Publish privacy-check data for anything the pool sent, so recipients' funds clear.
      await generatePOIsForWallet(NETWORK, pool.walletId);
      await refreshSpentPOIsForWallet(V2, NETWORK, pool.walletId);
    } catch {
      // Third-party services may be slow; try again next round.
    }
  };
  openPool(opts).then(
    (p) => {
      pool = p;
      setInterval(() => void upkeep(), UPKEEP_MS);
      console.log('Test-funds pool ready (TESTNET).');
    },
    (e: unknown) => console.error('Test-funds pool failed to start:', e instanceof Error ? e.message : 'unknown'),
  );

  const recipients = (to: string) => [
    { tokenAddress: SEPOLIA_USDT, amount: CLAIM_USDT, recipientAddress: to },
    { tokenAddress: SEPOLIA_WETH, amount: CLAIM_FEE_RESERVE_WEI, recipientAddress: to },
  ];

  return {
    ready: () => pool !== null,
    canPay: () =>
      pool !== null &&
      balanceOf(pool, RailgunWalletBalanceBucket.Spendable, SEPOLIA_USDT) >= CLAIM_USDT &&
      balanceOf(pool, RailgunWalletBalanceBucket.Spendable, SEPOLIA_WETH) >= CLAIM_FEE_RESERVE_WEI,
    isValidAddress: (a) => typeof a === 'string' && validateRailgunAddress(a),
    async send(to) {
      const p = pool;
      if (!p) throw new Error('pool-starting');
      const fees = await p.provider.getFeeData();
      const original: TransactionGasDetails = {
        evmGasType: EVMGasType.Type2,
        gasEstimate: 0n,
        maxFeePerGas: fees.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      };
      // sendWithPublicWallet = true: the pool pays gas itself; no broadcaster fee.
      const { gasEstimate } = await gasEstimateForUnprovenTransfer(V2, NETWORK, p.walletId, p.encryptionKey, undefined, recipients(to), [], original, undefined, true);
      await generateTransferProof(V2, NETWORK, p.walletId, p.encryptionKey, false, undefined, recipients(to), [], undefined, true, undefined, () => {});
      const { transaction } = await populateProvedTransfer(V2, NETWORK, p.walletId, false, undefined, recipients(to), [], undefined, true, undefined, {
        ...original,
        gasEstimate,
      });
      const sent = await p.publicWallet.sendTransaction(transaction);
      await sent.wait(1);
      void upkeep();
      return sent.hash;
    },
  };
}
