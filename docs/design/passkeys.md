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

### Deposit flow ("Add money"), agreed 2026-11-05

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
  plus Solana devnet.

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
