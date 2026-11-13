# Passkeys and smart accounts — design

Status: agreed for the first round of physical testing (2026-11-04).
Owners: Gold + Claude. Related parts: privacy (Railgun), universal UX (NEAR Intents).

## The core idea

The passkey never signs anything on a blockchain. It does two jobs:

1. **Proves it's you** — sign in to withlogin.com, and through OpenID Connect to any app.
2. **Unlocks your one root secret** — via the WebAuthn PRF extension, which gives a
   stable secret only that passkey can produce.

```
passkey (Face ID / fingerprint, synced by iCloud or Google)
  └─ PRF("withlogin.com/prf/wallet/v1") → HKDF-SHA256 → wrapping key   [one per passkey]
       └─ unwraps → data key                                           [one per account]
            └─ decrypts → root secret (32 random bytes, made on device, never shown)
                 ├─ Railgun wallet: spending + viewing keys   (private balance)      — next
                 └─ Ethereum addresses at standard paths        (deposit/withdraw edges) — next
```

The root secret is the entropy of a BIP-39 recovery phrase. Turning it into the
phrase and the Railgun wallet happens when the Railgun SDK is added.

## Decisions

| | Decision | Why |
|---|---|---|
| D1 | Data key wrapped once per passkey (envelope encryption). WebCrypto HKDF + AES-GCM only. AAD binds each ciphertext to its user and passkey. | Adding/removing a device never touches the secret. Swapped blobs fail. No homemade crypto. |
| D2 | Email first, verified by a 6-digit code, then a passkey. Passkey autofill on the email field. A "Sign in with passkey" button. | Users expect it, and we need a way to reach them. **The email code never signs anyone in**, so an email takeover isn't an account takeover. |
| D3 | Sign-up is finished only after a round trip works: encrypt → decrypt locally → upload → download → decrypt. If PRF isn't returned at creation, ask once more on sign-in. | Some authenticators only return PRF on `get()`. Catch broken setups before money arrives. |
| D4 | Read the backup flags. If every passkey that can open the wallet is device-only, show a clear warning to add one on another device. | Synced passkeys are already a backup. Device-only ones aren't. |
| D5 | Root secret lives in memory only. Locks on tab close or 15 min idle. Every send/withdraw asks for the passkey again after showing a summary. | One prompt both confirms and authorizes. |
| D6 | Server sees only: user ID, email, passkey public keys and flags, ciphertext. Never the PRF output, root secret, Railgun address or balances. | The server can't open wallets, even if breached. Enforced by tests. |
| D7 | Devices without PRF can still sign in everywhere. Only the Login wallet needs PRF; the UI says "open Login on your phone". No password fallback. | A password-encrypted backup could be brute-forced offline by whoever holds it. |
| D8 | Recovery, round 1: synced passkeys + "add a second passkey" (D4). Losing every passkey **and** the Apple/Google account means losing the funds; the UI says so. | Simple, no phrases. **Round 2 (next, before the hackathon ends): split-key recovery** — no single party, Login included, can decrypt. |
| D9 | RP ID `withlogin.com` in production; `localhost` only in development. Config refuses anything else. | Browsers treat localhost as secure, so passkeys work locally without certificates. |

### Adding a backup passkey

"Add your phone" and "Add a security key" send a WebAuthn hint (`hybrid` /
`security-key`, followed by Chrome) plus `authenticatorAttachment:
cross-platform` (honoured by Safari), so the browser goes straight to the right
device instead of defaulting to this computer's password manager. "Other
options" leaves the choice to the browser.

A passkey whose storage can't produce PRF (e.g. Brave's own passkey storage) is
added as **sign-in only**, labelled with the reason, and the user can keep or
remove it. A passkey added while the wallet was locked gets a **Connect**
button. Unlock only offers passkeys that can open the wallet.

After any change, the app calls `PublicKeyCredential.signalAllAcceptedCredentials`
with the server's full list, so removed passkeys stop being offered by the
password manager. It is only ever called with the complete list from the server,
never an empty one, because the password manager hides anything left out.

### Railgun wallet (first milestone)

- **Recovery phrase:** the 32-byte root secret is the BIP-39 entropy of a
  24-word phrase (`ethers` `Mnemonic.fromEntropy`). Never shown by default.
- **Local database key:** `deriveKeyMaterial(rootSecret, "withlogin.com/derive/railgun-db-key/v1")`
  (HKDF-SHA256). Encrypts the Railgun SDK's IndexedDB data on this device.
  Every derived key has its own label; labels are never reused or edited.
- **Isolation:** the SDK runs only in a Web Worker (`apps/web/src/railgun/`).
  It can't read the page, the session or passkey ceremonies. Locking
  terminates the worker. The main app bundle doesn't include the SDK.
- **Network, directly from the browser (never via Login's server):** Sepolia
  RPC (publicnode), quick sync (rail-squid), artifacts and POI list
  (ipfs-lb.com), and a POI node. They all see the user's IP address; the RPC
  provider also sees which public addresses are queried.
- **Proof of Innocence is required on Sepolia even to read balances.** Until a
  POI node URL is configured (`POI_NODE_URLS` in `railgun/client.ts`), the app
  shows the Railgun address but not the balance.
- `web3` 1.x (pulled in by Railgun's proof library) is **not** in the browser
  bundle; it is install-time only. Install scripts are disabled (`.npmrc`).

### Deposit flow, revised 2026-11-06: "EVM or Solana", always private USDT

Decided by the team lead after real testing showed the token picker was too
easy to get wrong (USDC sent to a USDT address sat unnoticed overnight).

- **Add money → "From an Ethereum wallet" or "From Solana".** No token picker.
- **EVM:** one fresh address of ours (same derivation as below) on Ethereum
  Sepolia. The user sends **USDT, USDC or ETH, any amount**. The deposit
  address then: shields USDT as is; swaps USDC to USDT through Tidepool (the
  USDT comes back to the same address, refunds too), then shields; swaps the
  ETH the user sent to USDT, keeping 0.001 ETH for its own gas and topping up
  a 0.001 ETH hidden fee reserve (rule in `apps/web/src/deposits/plan.ts`,
  unit-tested). Testnet-faucet gas is never swapped. Every swap step is saved
  in the deposit record before the next, so a reload never sends twice. A
  refunded USDC swap is shielded as private USDC rather than lost.
- **One currency on screen.** The private balance never lists ETH: a line says
  network fees are covered. Fees on Send and Withdraw are shown in USDT at
  Tidepool's ETH price. (Testnet only: Sepolia broadcasters take ETH. On
  mainnet they take USDT, so no reserve is needed.)
- **Solana:** unchanged, through Tidepool's own deposit address (no Solana
  keys of our own: that would need new crypto libraries).
- **Dropped:** Base and Arbitrum Sepolia. Our address only operates on
  Ethereum Sepolia.
- **Privacy trade-off (accepted):** the sending wallet is now visibly the
  funder of the deposit address for every EVM deposit. Before, a USDC deposit
  went to Tidepool's address and Tidepool delivered to ours. Small in
  practice: the shield into Railgun is public anyway, and matching amounts
  could already link the two.
- **Late or mistaken money:** finished or timed-out deposit addresses are
  re-checked on unlock; anything new gets a "Finish deposit" button.

### Deposit flow ("Add money"), agreed 2026-11-05 (superseded above for EVM)

1. User picks what to send (token and chain from Tidepool's list).
2. The browser derives a fresh Sepolia address from the recovery phrase on the
   **standard Ethereum path `m/44'/60'/0'/0/i`** (not Railgun's ephemeral
   addresses), so any standard wallet can recover deposits from the phrase.
3. The browser asks Tidepool for a quote to that address (directly, never via
   Login), the user sends, and the browser polls the status.
4. Test USDT arrives; the testnet-only gas faucet adds gas (see exceptions).
5. The fresh address approves and shields into the private balance.
6. Interrupted deposits resume: "You have a deposit to finish".

- **Deposit records live on the device only**, encrypted with a key derived
  from the root secret; a new device rebuilds them by scanning derived addresses.
- **Refunds:** EVM origins refund to the user's own derived address on the
  sending chain; Solana refunds to the Solana wallet the user sends from.
- **Sending chains for the hackathon:** Ethereum, Base and Arbitrum Sepolia,
  plus Solana devnet. *(Superseded: deposits now come from Ethereum Sepolia
  and Solana devnet only; see above.)*
- **Built 2026-11-05** (`apps/web/src/deposits/`, `railgun/deposits.ts`). Details:
  - Approves exactly the deposit amount to Railgun, never an unlimited allowance.
  - Every Tidepool response is checked: the destination must be our verified
    USDT contract, the quote must echo our recipient, token and refund address,
    and amounts and addresses must be well-formed.
  - Quotes never paid expire 10 minutes after their deadline.
  - Verified end to end on live Sepolia + Tidepool (e2e/deposit.spec.ts):
    1 USDC on Ethereum Sepolia arrives as 0.99 private USDT in about 2.5 minutes,
    with the leak test covering deposit keys and all third-party traffic.
  - Direct deposits for USDT already on Sepolia (no swap; the user's wallet is
    visibly the funder on-chain, which the screen says).
  - Proof of Innocence results are fetched on unlock, on Retry and every minute
    while funds are pending (the SDK doesn't do it by itself). Confirmed
    manually 2026-11-05: a deposit from the team lead's own wallet went from
    "being checked" to **Spendable** (4.97 USDT from 5 USDC).
  - Measured clearing time for a fresh deposit on Sepolia: 52 and 74 minutes,
    and a third run still pending after 90 minutes (2026-11-05). The screen
    says "from a few minutes to about two hours".
    The wallet's 15-minute idle lock (D5) can fire while a user waits; the
    balance catches up on the next unlock.
  - Private send verified end to end 2026-11-05 (`e2e/send.spec.ts`): proof
    in the browser, submitted by a Railgun broadcaster that paid the gas
    (tx `0xaea9f7a3…b8738`, sent from the broadcaster's address, not the
    user's). Broadcaster transactions on Ethereum must be gas Type 1; the SDK's
    `getEVMGasTypeForTransaction` picks it. Railgun charges 0.25% to shield and
    0.25% to unshield (read from the Sepolia contract); private sends pay only
    the broadcaster's fee.
  - Withdraw (unshield) verified by the team lead on 2026-11-06: 0.73 USDT out,
    0.728175 arrived (0.25% Railgun fee), sent by a broadcaster
    (tx `0xb5de1b69…a3acb8`). One broadcaster refused with "Could not validate
    Proof of Innocence"; the app now skips a refusing broadcaster for the
    session and asks the user to review again, which picked one that worked.
  - A withdrawal needs private ETH for the broadcaster fee. Accounts funded
    before the fee balance existed had none; the screen now says so plainly.
  - **Linked-address warning (decided 2026-11-08, team lead).** Withdrawing to
    an address that funded one of your deposits links the two publicly. The
    review now warns about it (allowed, not blocked). The app notes each
    deposit's senders on this device only, inside the encrypted deposit
    records: token senders from public Transfer logs *into* the deposit
    address at shield time, ETH senders from the few blocks between two
    balance checks. The RPC is asked only about deposit addresses it already
    sees us watching, never about the withdraw address; Login's server learns
    nothing. Limits: the public RPC keeps logs for ~10,000 blocks (~1.4
    days), so deposits made before this change, or rebuilt on a new device,
    aren't covered; ETH that arrives while the app is closed isn't either. The
    general "use an address that isn't linked to you" advice stays.
  - **Withdraw as another token or chain (decided 2026-11-09, team lead).**
    "Receive as" offers ETH or USDC on Ethereum Sepolia, USDC on Solana
    devnet or Base Sepolia, and ETH on Arbitrum Sepolia.
    SOL is left out (Tidepool caps it at 0.005 SOL per swap); Tidepool also
    caps ETH at 0.006 ETH per swap (about 12 USDT), and the app says so.
    How it works, all in the browser:
    1. Reserve a fresh deposit address as the **refund address**.
    2. Ask Tidepool for an EXACT_INPUT quote: Sepolia USDT in (the amount
       after Railgun's 0.25% unshield fee, rounded down as the contract does),
       the chosen token out, to the user's address; refunds to step 1.
    3. Price the unshield to Tidepool's one-time swap address; check that what
       arrives there equals the quoted input exactly (else stop).
    4. Review: Railgun's fee, about/at least what arrives, the network fee,
       the public-part warning, and the linked-address warning (checked
       against the user's address, since the same EVM address on any chain is
       the same owner). Passkey, proof, broadcaster, as for any withdrawal.
    5. Follow Tidepool's status. On a refund (or failure), the refund address
       is treated as an EVM deposit: the existing deposit flow gets it testnet
       gas and shields the USDT back into the private balance.
    The withdrawal is saved (encrypted, on this device) before it's sent, so
    a reload keeps following it. Tidepool sees the destination address, as it
    does for any swap; on-chain, the unshield goes to Tidepool's address, not
    the user's. Verified live 9-10 Nov: ETH on Sepolia and USDC on Base
    Sepolia (twice each).
  - **Known limit: the leftover after a spend never clears (parked
    2026-11-11, team lead).** After any send or withdrawal, the change
    (USDT and the fee reserve's WETH) stays "Missing" on the required POI
    list (Chainalysis OFAC) for 2.5+ hours in every test. The POI node is
    synced and processes other Sepolia transactions, but ours never land.
    Asking it every minute didn't help (tried and reverted). Likely the same root cause as the test-funds pool's stuck
    change (Railgun's broken Sepolia TXID index, below). Workaround: each
    deposit pays for one transaction, so demo accounts get one deposit per
    planned transaction (`docs/demo-script.md`).

### Smart accounts

The private balance sits in Railgun and is controlled by Railgun keys, not a
smart-account contract. Private sends inside the pool need no ETH: Railgun's
broadcasters take their fee from the shielded balance.

Smart accounts belong at the **edges**: the public Ethereum addresses that
receive deposits and send withdrawals. A fresh deposit address has no ETH for
the gas to shield, so EIP-7702 delegation or a paymaster is the likely answer.

**Decided (2026-11-04): a fresh deposit address for every deposit**, so deposits
can't be linked to each other on-chain. They are numbered addresses derived from
the same root secret, so they need no extra backup and the user never sees them.
**Testnet balance: Tidepool's test USDT on Sepolia** (checked 2026-11-04 against
Tidepool's live `/v0/tokens`; an earlier reading of its examples wrongly
suggested only USDC). Matches the team rule (USDT), so no rule change needed.

**Decided (2026-11-04): gas for a fresh deposit address comes with the deposit.**
NEAR Intents delivers a small amount of native ETH to the same fresh address
alongside the token, so the address pays its own shielding gas. No Login-run
gas sponsor (it would see every deposit address and its timing). Cost: a second
swap fee per deposit. **Open for testnet:** Tidepool can't deliver native
Sepolia ETH (its ETH exists only on the NEAR side), so this works on mainnet
but not yet on Sepolia.

## Testnet-only exceptions (must NOT reach mainnet)

### Login testnet gas faucet: contradicts D6

**Decided 2026-11-05 (team lead).** Tidepool can't deliver native Sepolia ETH, so
on testnet a fresh deposit address has no gas to shield its USDT. For the
hackathon only, a small Login server endpoint sends a little Sepolia ETH to the
fresh address just before a deposit.

**Why it contradicts D6:** Login's server sees each deposit address and when it
was requested, by a signed-in user. That is exactly the identity-to-wallet link
D6 says the server must never have. On-chain, every Login deposit address is also
funded by the same faucet address, which marks it as a Login deposit.

**Limits while it exists:**
- Refuses to run on any chain except Sepolia (checks the RPC's chain ID on every send).
- Off unless its key is configured; the key is testnet-only and lives only in `.env`.
- Stores nothing: no database rows, no logs of addresses, no analytics. Rate
  limits are in memory and keyed by user ID only.
- Labelled as a testnet simulation in code, README and the demo.

**Mainnet design (unchanged):** NEAR Intents delivers a little native ETH to the
same fresh address alongside the token. No Login gas sponsor. Delete this
faucet before any mainnet work.

### Mainnet NEAR Intents price check: an exception to "testnet only"

**Approved 2026-11-05 (team lead), built 2026-11-06.** The hackathon rules
suggest showing mainnet NEAR Intents with `dry: true` quotes, and no NEAR
Intents testnet exists. So the Ethereum deposit screen shows one line: what
mainnet 1Click (`1click.chaindefuser.com`) would give for 100 USDC → USDT now.
Code: `apps/web/src/deposits/mainnet.ts`.

**Limits:**
- `dry: true` only: no deposit address is created, nothing can be sent. A
  "dry" answer that includes a deposit address is treated as an error.
- A fixed placeholder address (`0x…dEaD`) and a fixed example amount; never a
  user's address or amount.
- Called from the browser, never through Login's server; no API key (checked:
  none needed for dry quotes; CORS allows it). The browser's IP is visible to
  the mainnet service, as with any web request.
- Never blocks the deposit: on any error, timeout (10 s) or implausible price
  the line is simply not shown.

**Never** extend this to non-dry quotes, real deposit addresses or real funds.

### Test funds ("Get 250 test USDT"): contradicts D6

**Decided 2026-11-06 (team lead), built 2026-11-07.** Judges and testers get
test USDT in one click instead of hunting for faucets. Tidepool's creator
granted 200k test USDT; converted to 199,480 Sepolia USDT and shielded into
the pool's private Railgun balance (with 0.15 ETH as WETH for fee reserves).
Code: `apps/server/src/test-funds/`.

- A signed-in account (verified email + passkey) claims **once**: 250 test
  USDT plus 0.001 ETH as WETH (its hidden fee reserve). Global cap: 100
  claims a day.
- **Revised 2026-11-08: claims are shields.** Each claim is one shield from the
  pool's public address straight into the claimer's 0zk address (Railgun's
  0.25% shield fee added on top, so exactly the claim arrives). Public ETH is
  wrapped to WETH in 0.01 batches. On-chain this shows the pool moving the
  claim's USDT into Railgun, not who received it. Spendable after Railgun's usual
  shield check (about an hour). Tidepool topped the pool up with 50,000
  Sepolia USDT for this. Claim size cut from 1,000 to 250 USDT on 2026-11-08
  (team lead: enough to test anything; the 48k then covers ~190 claims).
- **Why not private transfers (the first version):** a self-signed private
  transfer needs the pool to publish its own Proof of Innocence data, which
  depends on Railgun's Sepolia transaction index (TXID tree). Railgun's public
  Sepolia indexer has a broken checksum chain at position 4188 (block
  11816741; a bug report is drafted, but we have no Railgun contact yet), so the engine's index stops at 4177 and the
  first claim's change (~198k USDT, 0.149 WETH) is stuck in "missing privacy
  check". The pool's private upkeep still runs: if Railgun repairs the index,
  that balance clears on its own (`src/scripts/pool-poi-status.ts` checks,
  `pool-poi-fix.ts` publishes the proofs by hand).
- **Why it contradicts D6:** to send a claim, the server is told the
  account's 0zk address. It keeps it in memory only until the shield is
  sent, stores only "this account claimed, when, and the pool's public
  transaction" (`test_fund_claims`), and logs nothing. The screen says so.
- The pool's recovery phrase is a host secret (`TESTNET_POOL_MNEMONIC`);
  Railgun runs in the server process (in-memory DB, circuit files on disk).
- Testnet tokens only. **Never on mainnet**: delete before any mainnet work.

## Verifying external contracts

Using established contracts doesn't mean trusting them blindly. Before Login
integrates any contract (Railgun, account delegates, token contracts, bridges),
check and record:

1. **Source:** the deployed bytecode matches published source at a known commit
   (explorer verification, or our own compile-and-compare).
2. **Audits:** which audits cover *this* contract and version.
3. **Control:** owner/admin roles, upgradeability (proxy slots), pause,
   `selfdestruct`, initializers that could be front-run.
4. **Authority:** exactly what it can do with user funds or a delegated account,
   and what must be signed for that (chain ID, nonce, expiry, malleability).
5. **Fit with our rules:** privacy (what it reveals, to whom), no Login master
   keys, no Login-run funds handling, testnet-only.

### Railgun RelayAdapt7702 (Sepolia `0x05ae73c5925d843864ae6F261f3175De2ebCd963`), checked 2026-11-04

- **Control:** not a proxy (EIP-1967 implementation/admin/beacon slots empty),
  ~11 KB of real code. No owner, no upgrade, no `selfdestruct`, no initializer.
- **Authority:** `execute`/`multicall` need a signature from the delegated
  account itself (OpenZeppelin ECDSA, EIP-712 domain with chain ID and account
  address) and a sequential nonce; every other function is self-only.
- **SDK side:** signs 7702 authorizations with the explicit chain ID (never 0)
  and the contract address pinned in Railgun's network config; a validator
  rejects mismatches.
- **Gaps:** source is only on an **unmerged feature branch**
  (`Railgun-Privacy/contract` `zy0n/7702-relay-adapt`, last commit 2026-05-07);
  **no audit found**; bytecode not yet compared to that source; signed actions
  have **no expiry**; nonce lives in storage slot 0 (fine for fresh accounts,
  can collide with a previous delegation).
- **Fit:** built for unshield / cross-contract calls run by broadcasters and
  shielding the base token (ETH). It does **not**, as shipped in the SDK, let a
  fresh address shield an ERC-20 without someone paying its gas.

### Tidepool test USDT (Sepolia `0x650F12bA31777DE8Ded47287a8CC86bE737646fe`), checked 2026-11-04

- "Tidepool Testnet USDT (no value)", 6 decimals, ~2.6 KB, not a proxy.
- Has an owner (`0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93`) and `mint`;
  minting by anyone else reverts ("not minter"). Tidepool controls supply via
  its faucet. No transfer fee, blacklist or pause functions found.
- Not yet compared against published source (explorers unreachable from our tools).
- Tidepool itself is community-run and testnet-only (not affiliated with
  NEAR); its responses are untrusted input.

### Tidepool test USDC (Sepolia `0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2`), checked 2026-11-06

- **Byte-for-byte the same contract code as the USDT above** (same code hash
  `0xd2722868c4732ee4…`, 2,635 bytes), same owner, EIP-1967 implementation
  slot empty (not upgradeable). Only name and symbol differ ("Tidepool Testnet
  USDC (no value)", 6 decimals), which are stored data. The USDT findings apply.
- Used only for mistakes: USDC sent to a direct-USDT deposit address is shown
  to the user ("You sent USDC instead of USDT") and shielded as private USDC
  in the same transaction as any USDT there. Found by the team lead's real
  test on 2026-11-05, where 5 USDC sat unnoticed at a deposit address overnight.

## Open flags (don't lose these)

- **Deposit route can break D6.** A Login relayer that shields for users, or any
  server that stores per-user deposit addresses, links a Login user to their
  Railgun wallet. Must be resolved before the deposit route is built.
- **Smart account at the edges: use an established contract** (e.g. Ithaca's
  EIP-7702 account), never one Login writes. Before building:
  (1) each fresh deposit address is controlled by its own key derived from the
  root secret, **not the passkey's public key**, which would be the same on every
  address and link all of a user's deposits;
  (2) whoever sponsors gas sees every address it handles: same linking risk as
  the deposit route above;
  (3) only ever sign a 7702 delegation to one pinned contract address on one
  chain ID (never chain ID 0, never an address from a server response);
  (4) confirm the contract is deployed on Sepolia and check its audit status.
- **Split-key recovery** (D8 round 2): pieces held by Login, an independent
  partner, and the user; any two rebuild the key; each holder checks the user
  separately. Needs a team decision before building (new key handling).
- **Real devices** need an HTTPS staging domain (e.g. `dev.withlogin.com`) with its
  own RP ID, so test passkeys don't mix with real `withlogin.com` ones.
- `node:sqlite` is experimental in Node 22. Fine for the hackathon.

## What is tested

- `packages/vault` unit tests: round trip, second passkey, wrong passkey, swapped
  user/passkey, tampering, unknown versions, bad PRF, no key material in errors.
- `apps/server` unit tests: email codes (expiry, single use, 5-try lockout, resend
  limit, no account probing), ticket expiry, single-use and expiring challenges,
  refusal of any response carrying a PRF output, sessions required, config guards.
- `e2e/` with Chrome's virtual authenticator: PRF / no PRF, synced / device-only,
  cancelled Face ID, existing email, wrong code, sign-out/sign-in, refresh-lock,
  passkey deleted from device, second passkey opens the same wallet alone, can't
  remove the last wallet passkey, and a **leak test** that records every PRF output
  and root secret and fails if any appears in a request or browser storage.
