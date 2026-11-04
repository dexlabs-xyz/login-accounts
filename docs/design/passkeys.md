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
Gas for shielding from them gets designed together with the deposit route.

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
