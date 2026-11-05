/** Messages between the page and the Railgun worker. Nothing here is sent over the network. */

/** Tidepool's test USDT on Ethereum Sepolia (checked 2026-11-04, see docs/design/passkeys.md). TESTNET ONLY. */
export const SEPOLIA_USDT = '0x650F12bA31777DE8Ded47287a8CC86bE737646fe';
export const USDT_DECIMALS = 6;

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
}

export interface DepositRecord {
  index: number;
  /** The fresh Sepolia address (m/44'/60'/0'/0/index) that receives the USDT. */
  address: string;
  status: DepositStatus;
  quote?: DepositQuote;
  approveTx?: string;
  shieldTx?: string;
  createdAt: number;
  updatedAt: number;
}

export type DepositMethod =
  | 'deposit.next'
  | 'deposit.list'
  | 'deposit.update'
  | 'deposit.balances'
  | 'deposit.shield'
  | 'deposit.rescan'
  | 'fees';

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
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string; detail?: string }
  | { type: 'error'; message: string; /** development builds only */ detail?: string };
