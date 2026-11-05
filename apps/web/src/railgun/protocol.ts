/** Messages between the page and the Railgun worker. Nothing here is sent over the network. */

export type ToWorker =
  /** rootSecret is transferred (not copied): the page's copy is wiped by the transfer. */
  | { type: 'open'; rootSecret: ArrayBuffer; poiNodeURLs: string[] }
  | { type: 'refresh' };

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
  | { type: 'error'; message: string; /** development builds only */ detail?: string };
