/**
 * Private send, inside the Railgun worker. TESTNET ONLY (Sepolia).
 *
 * A private transfer is proved here (zero-knowledge proof, in the browser) and
 * submitted by a Railgun broadcaster, who pays the gas and is paid a fee from
 * the sender's private balance. No public address ever pays for a send, so
 * nothing on-chain links the sender to it.
 *
 * Fees are paid in private WETH ("ETH for network fees"): Sepolia broadcasters
 * don't accept Tidepool's test USDT. On mainnet they accept USDT.
 */
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenTransfer,
  generateTransferProof,
  populateProvedTransfer,
  validateRailgunAddress,
} from '@railgun-community/wallet';
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
  type SelectedBroadcaster,
  type TransactionGasDetails,
} from '@railgun-community/shared-models';
import { BroadcasterTransaction, WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web';
import { JsonRpcProvider } from 'ethers';
import { SEPOLIA_USDT, SEPOLIA_WETH } from './protocol.ts';

const NETWORK = NetworkName.EthereumSepolia;
const CHAIN = NETWORK_CONFIG[NETWORK].chain;
const V2 = TXIDVersion.V2_PoseidonMerkle;
/** Refuse any broadcaster fee above this (0.002 ETH), whatever it claims. */
const MAX_FEE_WEI = 2_000_000_000_000_000n;
const FIND_BROADCASTER_MS = 60_000;

export interface SendContext {
  walletId: string;
  /** The Railgun wallet's encryption key (derived from the root secret). Worker memory only. */
  encryptionKey: string;
  rpcUrl: string;
  /** Spendable private balances by token address (lowercase). */
  spendable: () => Map<string, bigint>;
  onProgress: (progress: number) => void;
}

interface PendingQuote {
  to: string;
  amount: bigint;
  broadcaster: SelectedBroadcaster;
  gasDetails: TransactionGasDetails;
  fee: bigint;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SendError extends Error {
  constructor(readonly code: 'invalid-address' | 'insufficient-usdt' | 'insufficient-fee-balance' | 'no-broadcaster' | 'fee-too-high' | 'quote-expired') {
    super(code);
    this.name = code; // the page only ever sees error names
  }
}

export function createSender(ctx: SendContext) {
  const provider = new JsonRpcProvider(ctx.rpcUrl);
  const quotes = new Map<string, PendingQuote>();
  let started: Promise<void> | null = null;

  async function bestBroadcaster(): Promise<SelectedBroadcaster> {
    // No trusted fee signer (see docs): every broadcaster's fee is shown to the
    // user before they confirm, and anything above MAX_FEE_WEI is refused.
    started ??= WakuBroadcasterClient.start(CHAIN, { trustedFeeSigner: '' }, () => {});
    await started;
    const t0 = Date.now();
    for (;;) {
      const b = WakuBroadcasterClient.findBestBroadcaster(CHAIN, SEPOLIA_WETH, false);
      if (b) return b;
      if (Date.now() - t0 > FIND_BROADCASTER_MS) throw new SendError('no-broadcaster');
      await sleep(3_000);
    }
  }

  const recipients = (q: { to: string; amount: bigint }) => [
    { tokenAddress: SEPOLIA_USDT, amount: q.amount, recipientAddress: q.to },
  ];

  return {
    /** Price a send: check the address and balances, pick a broadcaster, estimate its fee. */
    async quote(params: unknown) {
      const { to, amount: amountText } = params as { to: string; amount: string };
      if (typeof to !== 'string' || !validateRailgunAddress(to)) throw new SendError('invalid-address');
      const amount = BigInt(amountText);
      const spendable = ctx.spendable();
      if (amount <= 0n || (spendable.get(SEPOLIA_USDT.toLowerCase()) ?? 0n) < amount) throw new SendError('insufficient-usdt');

      const broadcaster = await bestBroadcaster();
      const feeTokenDetails = { tokenAddress: SEPOLIA_WETH, feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas) };
      // Broadcaster transactions on Ethereum must be Type 1 (a single gas price): the
      // broadcaster batches them with a minimum gas price. The SDK picks the type.
      const fd = await provider.getFeeData();
      const evmGasType = getEVMGasTypeForTransaction(NETWORK, false);
      if (evmGasType !== EVMGasType.Type0 && evmGasType !== EVMGasType.Type1) throw new Error(`Unexpected gas type ${evmGasType}`);
      const original: TransactionGasDetails = { evmGasType, gasEstimate: 0n, gasPrice: fd.gasPrice ?? fd.maxFeePerGas ?? 0n };
      if (calculateGasPrice(original) <= 0n) throw new SendError('no-broadcaster');
      const { gasEstimate } = await gasEstimateForUnprovenTransfer(
        V2,
        NETWORK,
        ctx.walletId,
        ctx.encryptionKey,
        undefined,
        recipients({ to, amount }),
        [],
        original,
        feeTokenDetails,
        false,
      );
      const gasDetails = { ...original, gasEstimate } as TransactionGasDetails;
      const fee = calculateBroadcasterFeeERC20Amount(feeTokenDetails, gasDetails).amount;
      if (fee <= 0n) throw new SendError('no-broadcaster'); // a zero fee would just be refused
      if (fee > MAX_FEE_WEI) throw new SendError('fee-too-high');
      if ((spendable.get(SEPOLIA_WETH.toLowerCase()) ?? 0n) < fee) throw new SendError('insufficient-fee-balance');

      const quoteId = crypto.randomUUID();
      const expiresAt = Math.min(broadcaster.tokenFee.expiration, Date.now() + 5 * 60_000);
      quotes.set(quoteId, { to, amount, broadcaster, gasDetails, fee, expiresAt });
      return { quoteId, feeWei: fee.toString(), expiresAt };
    },

    /** Prove and submit a priced send. The page asks for the passkey before calling this (D5). */
    async execute(params: unknown) {
      const { quoteId } = params as { quoteId: string };
      const q = quotes.get(quoteId);
      quotes.delete(quoteId);
      if (!q || Date.now() > q.expiresAt) throw new SendError('quote-expired');

      const feeRecipient = { tokenAddress: SEPOLIA_WETH, amount: q.fee, recipientAddress: q.broadcaster.railgunAddress };
      const minGasPrice = calculateGasPrice(q.gasDetails);
      await generateTransferProof(
        V2,
        NETWORK,
        ctx.walletId,
        ctx.encryptionKey,
        false, // don't reveal the sender's address to the recipient
        undefined,
        recipients(q),
        [],
        feeRecipient,
        false,
        minGasPrice,
        (progress) => ctx.onProgress(progress),
      );
      const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } = await populateProvedTransfer(
        V2,
        NETWORK,
        ctx.walletId,
        false,
        undefined,
        recipients(q),
        [],
        feeRecipient,
        false,
        minGasPrice,
        q.gasDetails,
      );
      const tx = await BroadcasterTransaction.create(
        V2,
        transaction.to,
        transaction.data,
        q.broadcaster.railgunAddress,
        q.broadcaster.tokenFee.feesID,
        CHAIN,
        nullifiers ?? [],
        minGasPrice,
        false,
        preTransactionPOIsPerTxidLeafPerList,
      );
      const txHash = await tx.send();
      return { txHash };
    },
  };
}
