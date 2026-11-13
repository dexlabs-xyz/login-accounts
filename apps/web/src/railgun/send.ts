/**
 * Private send, inside the Railgun worker. TESTNET ONLY (Sepolia).
 *
 * A private transfer is proved here (zero-knowledge proof, in the browser) and
 * submitted by a Railgun broadcaster, who pays the gas and is paid a fee from
 * the sender's private balance. No public address ever pays for a send, so
 * nothing on-chain links the sender to it.
 *
 * Withdraw ("unshield") uses the same path: the proof moves USDT out of the
 * private balance to a public address, and the broadcaster submits it. The
 * amount and recipient are public on-chain; the sender stays hidden.
 * Railgun keeps its unshield fee (0.25% today, read from the contract).
 *
 * Fees are paid in private WETH ("ETH for network fees"): Sepolia broadcasters
 * don't accept Tidepool's test USDT. On mainnet they accept USDT.
 */
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenTransfer,
  gasEstimateForUnprovenUnshield,
  generateTransferProof,
  generateUnshieldProof,
  populateProvedTransfer,
  populateProvedUnshield,
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
import { getAddress, isAddress, JsonRpcProvider, ZeroAddress } from 'ethers';
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
  /** Railgun's unshield fee in basis points, as read from the contract (null until loaded). */
  unshieldFeeBasisPoints: () => bigint | null;
  /** The user's own Login deposit addresses (lowercase): withdrawing to one links them publicly. */
  ownDepositAddresses: () => Promise<Set<string>>;
  /** Public addresses that funded the user's deposits (lowercase): withdrawing to one links them publicly. */
  depositFunders: () => Promise<Set<string>>;
  onProgress: (progress: number) => void;
}

/** 'transfer': to another private 0zk address. 'unshield': out to a public address (withdraw). */
export type SendKind = 'transfer' | 'unshield';

interface PendingQuote {
  kind: SendKind;
  to: string;
  amount: bigint;
  broadcaster: SelectedBroadcaster;
  gasDetails: TransactionGasDetails;
  fee: bigint;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SendError extends Error {
  constructor(
    readonly code:
      | 'invalid-address'
      | 'own-deposit-address'
      | 'insufficient-usdt'
      | 'insufficient-fee-balance'
      | 'no-broadcaster'
      | 'fee-too-high'
      | 'quote-expired'
      | 'broadcaster-refused'
      | 'still-confirming',
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = code; // the page only ever sees error names
  }
}

export function createSender(ctx: SendContext) {
  const provider = new JsonRpcProvider(ctx.rpcUrl);
  const quotes = new Map<string, PendingQuote>();
  /** Broadcasters that refused one of our transactions: not picked again this session. */
  const refused = new Set<string>();
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
      const {
        kind = 'transfer',
        to: toText,
        amount: amountText,
        finalTo,
      } = params as {
        kind?: SendKind;
        to: string;
        amount: string;
        /**
         * Swapped withdrawals: `to` is Tidepool's one-time swap address, and this
         * is the user's address where the swapped token arrives. EVM addresses
         * get the same checks as a direct withdrawal (the same address on any
         * EVM chain is publicly the same owner). Solana addresses: none apply.
         */
        finalTo?: string;
      };
      if (kind !== 'transfer' && kind !== 'unshield') throw new Error('Unknown send kind.');
      if (typeof toText !== 'string') throw new SendError('invalid-address');
      let to = toText;
      if (kind === 'transfer') {
        if (!validateRailgunAddress(to)) throw new SendError('invalid-address');
      } else {
        if (!isAddress(to) || getAddress(to) === ZeroAddress) throw new SendError('invalid-address');
        to = getAddress(to);
      }
      if (finalTo !== undefined && (kind !== 'unshield' || typeof finalTo !== 'string')) throw new SendError('invalid-address');
      // The address whose owner becomes public: the user's own for a swap, else the recipient.
      const linked = kind !== 'unshield' ? null : finalTo === undefined ? to : isAddress(finalTo) ? getAddress(finalTo) : null;
      // A deposit address is publicly tied to this user's shields; sending there undoes the privacy.
      const own = kind === 'unshield' ? await ctx.ownDepositAddresses() : new Set<string>();
      if (own.has(to.toLowerCase()) || (linked && own.has(linked.toLowerCase()))) throw new SendError('own-deposit-address');
      // Allowed, but flagged on review: this address sent money into one of the user's deposits.
      const fundedDeposits = linked !== null && (await ctx.depositFunders()).has(linked.toLowerCase());
      const amount = BigInt(amountText);
      const spendable = ctx.spendable();
      if (amount <= 0n || (spendable.get(SEPOLIA_USDT.toLowerCase()) ?? 0n) < amount) throw new SendError('insufficient-usdt');

      // No private ETH at all: the broadcaster can't be paid, so say so before pricing anything.
      if ((spendable.get(SEPOLIA_WETH.toLowerCase()) ?? 0n) === 0n) throw new SendError('insufficient-fee-balance');

      const broadcaster = await bestBroadcaster();
      const feeTokenDetails = { tokenAddress: SEPOLIA_WETH, feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas) };
      // Broadcaster transactions on Ethereum must be Type 1 (a single gas price): the
      // broadcaster batches them with a minimum gas price. The SDK picks the type.
      const fd = await provider.getFeeData();
      const evmGasType = getEVMGasTypeForTransaction(NETWORK, false);
      if (evmGasType !== EVMGasType.Type0 && evmGasType !== EVMGasType.Type1) throw new Error(`Unexpected gas type ${evmGasType}`);
      const original: TransactionGasDetails = { evmGasType, gasEstimate: 0n, gasPrice: fd.gasPrice ?? fd.maxFeePerGas ?? 0n };
      if (calculateGasPrice(original) <= 0n) throw new SendError('no-broadcaster');
      const { gasEstimate } = await estimate().catch((e: unknown) => {
        // The SDK checks the fee balance itself during the estimate; give the page our error code.
        if (e instanceof Error && /too low to pay broadcaster fee/i.test(e.message)) throw new SendError('insufficient-fee-balance');
        // Right after a send, the wallet may not have seen it confirm yet and picks a note that
        // the send already spent; the chain refuses it (nothing is sent). Seen live 11 Nov 2026.
        if (e instanceof Error && /note already spent/i.test(e.message)) throw new SendError('still-confirming', e);
        // Same family: the wallet's view of Railgun's merkle tree is behind the chain (e.g. right after a
        // deposit lands). The SDK says "Invalid Merkle Root. Please sync your balances"; the worker rescans on
        // still-confirming, so pressing Review again works. Seen live 12 Nov 2026.
        if (e instanceof Error && /invalid merkle root/i.test(e.message)) throw new SendError('still-confirming', e);
        throw e;
      });
      async function estimate() {
        return kind === 'transfer'
          ? await gasEstimateForUnprovenTransfer(
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
            )
          : await gasEstimateForUnprovenUnshield(
              V2,
              NETWORK,
              ctx.walletId,
              ctx.encryptionKey,
              recipients({ to, amount }),
              [],
              original,
              feeTokenDetails,
              false,
            );
      }
      const gasDetails = { ...original, gasEstimate } as TransactionGasDetails;
      const fee = calculateBroadcasterFeeERC20Amount(feeTokenDetails, gasDetails).amount;
      if (fee <= 0n) throw new SendError('no-broadcaster'); // a zero fee would just be refused
      if (fee > MAX_FEE_WEI) throw new SendError('fee-too-high');
      if ((spendable.get(SEPOLIA_WETH.toLowerCase()) ?? 0n) < fee) throw new SendError('insufficient-fee-balance');

      // Withdrawals: Railgun keeps its unshield fee out of the amount; the recipient gets the rest.
      let railgunFee = 0n;
      if (kind === 'unshield') {
        const bp = ctx.unshieldFeeBasisPoints();
        if (bp === null || bp < 0n || bp > 10_000n) throw new SendError('no-broadcaster');
        railgunFee = (amount * bp) / 10_000n;
      }

      const quoteId = crypto.randomUUID();
      const expiresAt = Math.min(broadcaster.tokenFee.expiration, Date.now() + 5 * 60_000);
      quotes.set(quoteId, { kind, to, amount, broadcaster, gasDetails, fee, expiresAt });
      return {
        quoteId,
        to,
        feeWei: fee.toString(),
        railgunFee: railgunFee.toString(),
        receives: (amount - railgunFee).toString(),
        fundedDeposits,
        expiresAt,
      };
    },

    /** Prove and submit a priced send or withdrawal. The page asks for the passkey first (D5). */
    async execute(params: unknown) {
      const { quoteId } = params as { quoteId: string };
      const q = quotes.get(quoteId);
      quotes.delete(quoteId);
      if (!q || Date.now() > q.expiresAt) throw new SendError('quote-expired');

      const feeRecipient = { tokenAddress: SEPOLIA_WETH, amount: q.fee, recipientAddress: q.broadcaster.railgunAddress };
      const minGasPrice = calculateGasPrice(q.gasDetails);
      const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
        q.kind === 'transfer'
          ? await (async () => {
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
              return populateProvedTransfer(V2, NETWORK, ctx.walletId, false, undefined, recipients(q), [], feeRecipient, false, minGasPrice, q.gasDetails);
            })()
          : await (async () => {
              await generateUnshieldProof(
                V2,
                NETWORK,
                ctx.walletId,
                ctx.encryptionKey,
                recipients(q),
                [],
                feeRecipient,
                false,
                minGasPrice,
                (progress) => ctx.onProgress(progress),
              );
              return populateProvedUnshield(V2, NETWORK, ctx.walletId, recipients(q), [], feeRecipient, false, minGasPrice, q.gasDetails);
            })();
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
      let txHash: string;
      try {
        txHash = await tx.send();
      } catch (e) {
        // The broadcaster refused (e.g. its privacy-check node can't confirm our funds yet).
        // Nothing was sent. Skip this broadcaster next time, so "Review" again tries another.
        if (e instanceof Error && /response error from broadcaster/i.test(e.message)) {
          refused.add(q.broadcaster.railgunAddress);
          WakuBroadcasterClient.setAddressFilters(undefined, [...refused]);
          throw new SendError('broadcaster-refused', e);
        }
        throw e;
      }
      return { txHash };
    },
  };
}
