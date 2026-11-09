/** Messages between the page and the Railgun worker. Nothing here is sent over the network. */

/** Tidepool's test USDT on Ethereum Sepolia (checked 2026-11-04, see docs/design/passkeys.md). TESTNET ONLY. */
export const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
export const USDT_DECIMALS = 6;
/**
 * Tidepool's test USDC on Ethereum Sepolia. Same contract code as the USDT above
 * (identical code hash, same owner, not upgradeable; checked 2026-11-06). Only
 * accepted when it lands at a deposit address by mistake. TESTNET ONLY.
 */
export const SEPOLIA_USDC = '0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2';
export const USDC_DECIMALS = 6;
/** Railgun's wrapped ETH on Sepolia (from Railgun's network config): pays broadcaster fees. TESTNET ONLY. */
export const SEPOLIA_WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
/** ETH a deposit address always keeps for its own remaining transactions (swap transfers, approve, shield). */
export const DEPOSIT_ETH_GAS_KEEP_WEI = 1_000_000_000_000_000n; // 0.001 ETH

export type DepositStatus =
  | 'new' // fresh address reserved, no quote yet
  | 'awaiting-delivery' // quote taken; waiting for the user's payment and Tidepool's delivery
  | 'delivered' // USDT is at the fresh address; needs gas and shielding
  | 'shielding'
  | 'shielded'
  | 'refunded'
  | 'failed';

export interface DepositQuote {
  /** Where the user sends their tokens (Tidepool's address). */
  tidepoolDepositAddress: string;
  originChain: string;
  originSymbol: string;
  amountIn: string;
  amountInFormatted: string;
  expectedUsdt: string; // smallest units
  minUsdt: string;
  deadline: string; // ISO time
  refundTo: string;
  /** No swap: the user sends USDT on Sepolia straight to the fresh address. */
  direct?: boolean;
  /**
   * EVM deposit (Ethereum Sepolia): the user sends USDT, USDC or ETH, any amount,
   * to the fresh address. USDC and ETH are swapped to USDT through Tidepool,
   * back to the same address, then everything is shielded as USDT.
   */
  anyToken?: boolean;
}

/** One swap a deposit address makes through Tidepool (USDC or ETH into USDT). */
export interface DepositSwap {
  token: 'USDC' | 'ETH';
  /** Smallest units of the token sent to Tidepool. */
  amountIn: string;
  /** Tidepool's one-time deposit address for this swap. */
  tidepoolDepositAddress: string;
  minUsdt: string;
  /** Our transfer to Tidepool, once sent. */
  sendTx?: string;
  status: 'quoted' | 'sent' | 'success' | 'refunded' | 'failed';
}

/**
 * A withdrawal that arrives as another token or on another chain: the private
 * USDT is withdrawn straight to Tidepool's one-time swap address, and Tidepool
 * delivers the chosen token to the user's address. If the swap fails, Tidepool
 * refunds the USDT to this record's fresh deposit address, which then moves it
 * back into the private balance like any deposit.
 */
export interface WithdrawalSwap {
  tidepoolDepositAddress: string;
  /** Destination chain and token (Tidepool's names, e.g. 'sol', 'USDC'). */
  chain: string;
  symbol: string;
  decimals: number;
  /** The user's address on the destination chain. */
  to: string;
  /** USDT leaving the private balance, and arriving at Tidepool after Railgun's fee (smallest units). */
  amountUsdt: string;
  sentUsdt: string;
  /** What Tidepool quoted, in the destination token's smallest units. */
  expectedOut: string;
  minOut: string;
  deadline: string;
  txHash?: string;
  status: 'sending' | 'sent' | 'success' | 'refunded' | 'failed';
}

export interface DepositRecord {
  index: number;
  /** The fresh Sepolia address (m/44'/60'/0'/0/index) that receives the USDT. */
  address: string;
  status: DepositStatus;
  quote?: DepositQuote;
  approveTx?: string;
  shieldTx?: string;
  /** Leftover ETH shielded as WETH for broadcaster fees. */
  feeShieldTx?: string;
  /** What the shield moved in, per token (set by the worker). Can include USDC sent by mistake. */
  shieldedTokens?: { token: string; amount: string }[];
  /** EVM deposits: ETH the user sent (before any testnet gas), in wei. Only this is ever swapped. */
  userEthWei?: string;
  /** EVM deposits: swaps into USDT, in order. Kept so a reload never sends twice. */
  swaps?: DepositSwap[];
  /**
   * Public addresses that sent money to this deposit address (lowercase), so a
   * withdrawal back to one can be flagged: anyone can link the two on-chain.
   * Found on this device from public chain data; stored only here, encrypted.
   */
  funders?: string[];
  /** Last block already searched for token transfers in (so a rescan doesn't repeat work). */
  fundersCheckedBlock?: number;
  /** Set when this fresh address is the refund address of a swapped withdrawal. */
  withdrawal?: WithdrawalSwap;
  createdAt: number;
  updatedAt: number;
}

export type DepositMethod =
  | 'deposit.next'
  | 'deposit.list'
  | 'deposit.update'
  | 'deposit.balances'
  | 'deposit.shield'
  | 'deposit.transfer'
  | 'deposit.rescan'
  | 'fees'
  | 'send.quote'
  | 'send.execute';

export type ToWorker =
  /** rootSecret is transferred (not copied): the page's copy is wiped by the transfer. */
  | { type: 'open'; rootSecret: ArrayBuffer; poiNodeURLs: string[] }
  | { type: 'refresh' }
  | { type: 'call'; id: number; method: DepositMethod; params?: unknown };

export type BalanceBucket =
  | 'Spendable'
  | 'ShieldBlocked'
  | 'ShieldPending'
  | 'ProofSubmitted'
  | 'MissingInternalPOI'
  | 'MissingExternalPOI'
  | 'Spent';

export type FromWorker =
  | { type: 'opened'; railgunAddress: string }
  | { type: 'needs-poi' }
  | { type: 'scan'; status: 'Started' | 'Updated' | 'Complete' | 'Incomplete'; progress: number }
  | { type: 'balances'; bucket: BalanceBucket; erc20: { tokenAddress: string; amount: string }[] }
  | { type: 'deposits'; records: DepositRecord[] }
  /** Proof generation progress for a private send, 0..100. */
  | { type: 'send-progress'; progress: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string; detail?: string }
  | { type: 'error'; message: string; /** development builds only */ detail?: string };
