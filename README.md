# Login accounts

One passkey account to sign in anywhere and move money privately across
chains, built on **NEAR Intents** and **Railgun**.

**Testnet only. Never use real funds. Hackathon build: not audited.**

- **Live demo:** https://demo.withlogin.com (Sepolia testnet)
- **Design decisions:** [docs/design/passkeys.md](docs/design/passkeys.md)

<!-- TODO(Gold): the one-paragraph concept explanation goes here, from Gold's write-up. -->

## Try it in 5 minutes

Use a desktop browser with a passkey option (Chrome, Safari or Edge; a phone
works as the passkey). Each step says what you should see.

1. **Open https://demo.withlogin.com, enter your email, then the 6-digit code.**
   → The code is checked as soon as you type the sixth digit. You're asked to
   create a passkey.
2. **Create the passkey** (Face ID, Touch ID, a phone or a security key).
   → You land on **Home** with a `0zk…` private address and a $0.00 private
   balance. The wallet syncs for up to a minute the first time.
3. **Press Test USDT.**
   → A message says *"Sent $250 to your private balance"*, and a second one
   says the server saw your private address for that claim only. The balance
   shows 250 USDT *being checked* (Railgun's privacy check: a few minutes to
   about two hours on Sepolia).
4. **Open Notifications.**
   → The claim is listed with its status and an Etherscan link. On Etherscan,
   the deposit is public, as deposits always are.
5. **In a second browser profile, sign up again and copy that account's
   address (Copy address).** In the first account, once the balance is
   spendable, press **Send** → *Send privately* → paste the address → 1 USDT →
   **Review** → **Confirm with passkey**.
   → *"Sent …"*. The second account's Notifications shows *"Received 1 USDT
   privately"*. On Etherscan, the transaction shows only that a Railgun
   transaction happened: no amount, sender or recipient.
6. **Send → Withdraw**, to any `0x` address, as USDT or as another token or
   chain (for example USDC on Solana devnet).
   → The review lists every fee and warns that a withdrawal is public. After
   confirming: *"Withdrew …"*.
7. **Verification → Verify you're human** (Sumsub sandbox, test mode).
   → Status becomes *Verified human*. Then sign in to the demo app with
   **Continue with Login** at https://onchainchess.app (a chess app that
   uses Login): the consent screen says exactly what the app will see (an ID only that app
   gets, and whether you're a verified human), never your email.

Keep each send or withdrawal to **10 USDT or less**: the test funds arrive
as 25 pieces of 10 USDT, and on Sepolia each piece pays for one transaction
(see *Known limit on Sepolia* below).

## What you can do

1. **Sign up with a passkey.** Email + 6-digit code, then a passkey (Face ID,
   Touch ID, a phone or a security key). No passwords, no seed phrase to write
   down.
2. **Get test funds.** One click: 250 test USDT lands in your *private*
   balance, once per account. No faucets to hunt for.
3. **Add money from anywhere.** *From an Ethereum wallet*: send USDT, USDC or
   ETH (any amount) to a fresh address made just for you; it all becomes
   private USDT. *From Solana*: through NEAR Intents. You also see what the same
   swap pays on **mainnet NEAR Intents** right now (a read-only price check).
4. **Send privately** to another Login account (a `0zk…` address). Nobody
   on-chain can see the amount, the sender or the recipient.
5. **Withdraw** to any Ethereum address as USDT, or **as another token or
   chain** through NEAR Intents: ETH or USDC on Ethereum Sepolia, USDC on
   Solana devnet or Base Sepolia, ETH on Arbitrum Sepolia. The review shows
   every fee, warns you that this part is public, and flags it if the address
   is one that sent money into your account (anyone could link the two). If a
   swap can't be done, the USDT comes back to your private balance.
6. **Verify you're human** (optional, Sumsub sandbox), and **continue with
   Login** on other apps: they learn only that you're a verified human, with a
   different ID per app. Never your email. Login lists each app
   you've signed in to and what it sees. Two steps are offered: *verified
   human* (a selfie video) and *verified identity* (an ID document).

Everything moves in one currency on screen: USDT. Every send and withdrawal is
confirmed with your passkey after a summary.

## Why it's built this way

Each choice below solves a specific problem. The full reasoning, with
alternatives we rejected, is in [docs/design/passkeys.md](docs/design/passkeys.md)
(decisions D1–D9).

- **Passkeys, not passwords or seed phrases.** Most people lose seed phrases
  or reuse passwords. A passkey is phishing-resistant, and it's already backed
  up by iCloud or Google. *No password fallback* (D7): an encrypted backup
  protected by a password can be brute-forced offline by whoever holds it.
- **The passkey never signs on a blockchain; it unlocks one secret.** Through
  the WebAuthn PRF extension, each passkey produces a stable secret that only
  it can make. That secret unwraps the account's one root secret, from which
  the Railgun wallet and the deposit addresses are derived. *Why:* one login
  works for every chain, and adding or removing a device never touches the
  money (D1).
- **The server can't open wallets, even if breached (D6).** It stores only
  your email, passkey public keys and encrypted data. *Why:* a custodial
  database is the biggest prize for an attacker; here there's nothing to steal
  that opens funds. Browser tests check that no secret ever leaves the device.
- **The email code never signs anyone in (D2).** It only proves the address
  during sign-up. *Why:* taking over someone's email shouldn't take over their
  money.
- **Railgun for privacy.** Railgun keeps balances, senders and recipients
  private on Ethereum, with proofs made in the user's browser. *Why:* it's an
  established, audited protocol on the chain where stablecoins live; we don't
  invent our own cryptography.
- **Broadcasters submit private transactions.** *Why:* if the user paid gas
  from a public address, that address would link them to their private
  activity.
- **NEAR Intents for anything in, anything out.** Deposits in any supported
  token or chain become private USDT; withdrawals can leave as another token
  or chain. *Why:* the user shouldn't need to know about bridges, routes or
  which chain a friend uses. Intents let a solver handle it in one step, with
  a refund if it can't be done.
- **One currency on screen (USDT).** *Why:* people think in dollars, not in
  a mix of tokens and gas coins.
- **Every withdrawal warns that it's public**, and flags an address that sent
  money in. *Why:* a withdrawal to your own funding wallet would link the two
  in public; users should see that before they confirm.
- **"Continue with Login" gives each app a different ID and never your
  email.** *Why:* apps (or a data broker joining their databases) can't
  follow you across sites. Apps learn only what the consent screen says, such
  as "verified human".
- **KYC stores only the result, never documents.** *Why:* a breach can't leak
  ID scans, and apps get a yes/no instead of personal data.
- **Testnet, with every exception labelled.** NEAR Intents has no official
  testnet, so swaps use Tidepool (a community testnet with the same API), and
  mainnet is only asked for read-only prices. *Why:* this build never touches
  real money, and anything that bends the privacy rule for testing is listed
  below and must not reach mainnet.

## How it works

| Piece | What it does |
|---|---|
| **Passkeys + PRF** | Your passkey unlocks a wallet secret that only exists in your browser. Login's server stores it encrypted and can't open it, even if breached. |
| **Railgun** | Holds your balance privately on Ethereum Sepolia. Proofs are generated in your browser. |
| **NEAR Intents** | Swaps whatever you deposit into USDT. On testnet through [Tidepool](https://www.usetidepool.tech), a community-run NEAR Intents testnet (NEAR Intents has no official testnet); plus read-only `dry` quotes from mainnet 1Click. |
| **Railgun broadcasters** | Submit your private sends and withdrawals and pay the gas, so no public address of yours appears. |
| **OIDC provider** | "Continue with Login" for other apps: per-app IDs, consent, `verified_human` from KYC. |
| **Sumsub (sandbox)** | Optional KYC. Login stores only the result, never documents. |

**The privacy rule (D6):** Login's server sees your email, your passkeys'
public keys and encrypted blobs. Never your passkey's secret output, your
wallet secret, your private address or your balance. Browser tests record every
secret and check that none of them appears in any network request or storage,
including while the Sumsub SDK runs.

Your history (Notifications) is worked out on your device from your wallet's
own data and shown only while your wallet is unlocked; Login's server never
sees it.

### What's simulated or special on testnet (labelled)

These exist only because this is a testnet demo, and contradict the privacy
rule above. Each is documented in
[Testnet-only exceptions](docs/design/passkeys.md#testnet-only-exceptions-must-not-reach-mainnet)
and must never reach mainnet:

- **Gas faucet:** Login's server sends a little Sepolia ETH to your fresh
  deposit address so it can move your tokens. (On mainnet, NEAR Intents
  delivers gas with the deposit.)
- **Test funds:** to send your 250 test USDT, the server is told your private
  address for that one claim. It stores only that your account claimed.
- **Hidden fee reserve:** Sepolia broadcasters only accept ETH, so a little
  private ETH is kept for fees and shown as USDT. (On mainnet they accept USDT.)
- **Mainnet price check:** the only mainnet contact. `dry` quotes with a
  placeholder address; nothing can be sent.

Also worth knowing:

- New deposits wait for Railgun's privacy check ("being checked"), from a few
  minutes to about two hours, before they can be spent.
- **Known limit on Sepolia**: what's left over after a send stays locked
  (next section).

### Known limit on Sepolia: leftovers stay locked

**What you'll see:** after a send or withdrawal, what's left of the money it
used shows as "left over from your last send, locked on this test network"
and never becomes spendable. Money received in a private send from another
account most likely stays "waiting for privacy check" the same way.

**Why:** Railgun only lets money move once it has passed its privacy check
(Proof of Innocence). For money coming in from outside (test funds,
deposits), Railgun's own service runs that check, and it clears in minutes.
For the outputs of a private send (your leftover and the recipient's money),
the *sender's* wallet must produce the proof, and that needs Railgun's public
transaction index for Sepolia. That index is broken (its checksum chain stops
at position 4188, block 11816741; see the design doc), so the proof can't be
made. This is Railgun's testnet, not Login's code; on mainnet the index works
and leftovers clear normally. If Railgun repairs it, locked amounts should
clear on their own.

**What we did about it:** Railgun spends the smallest pieces of money that
cover a send, so the test funds arrive as **25 pieces of 10 USDT**. Each send
or withdrawal of 10 USDT or less uses one piece, so one claim pays for up to
25 transactions. Bigger amounts work too; they just use more pieces. Your own
deposits arrive as one piece each.

### Not built yet (next)

- **Smart accounts at the edges** (EIP-7702 + a paymaster): deposit addresses
  paying their own gas in USDT, replacing the testnet gas faucet. Planned
  (notes in the design doc), not built.
- **Split-key recovery** for losing every passkey.
- **A developer dashboard for "Continue with Login"**: today each app that
  can use Login is added by hand to the server's settings. Next, developers
  register their own apps (name, exact callback, proven domain) and get a
  client ID without a redeploy.
- **A mainnet version**, without the testnet-only exceptions above.
- **A forwarding email for each app** (like Apple's Hide My Email), so apps
  can reach you without being able to link you across sites.
- **Verified address** (proof of address), once dexlabs is verified at Sumsub.
- **Solana deposits of any amount** (today you pick the exact amount first).

## Hackathon notes

- **Why Tidepool, not NEAR Intents mainnet:** NEAR Intents has no official
  testnet, and this build never touches real funds. Swaps go through
  [Tidepool](https://www.usetidepool.tech), a community-run NEAR Intents
  testnet that speaks the same 1Click API. To show real prices, Add money also
  fetches read-only `dry` quotes from mainnet 1Click with a placeholder
  address: nothing can be sent.
- **Tidepool's limits:** 0.006 ETH and 0.005 SOL per swap. Larger ETH
  deposits are split into several swaps; larger SOL amounts are refused.
- **Testnet only:** Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and
  Solana devnet. Sumsub runs in sandbox mode.
- **Team:** Gold (lead, product and design) · Luke Dami (Login infrastructure,
  the demo app and the demo video) · DIOB (KYC infrastructure, email and product
  copy).
- **Other projects:** none. Login accounts was built from scratch for this
  hackathon, and we're continuing it afterwards.
- **License:** [Apache 2.0](LICENSE).

## Built with

| Library | Used for |
|---|---|
| [Railgun](https://github.com/Railgun-Community) (`@railgun-community/wallet`, `engine`, `shared-models`, `waku-broadcaster-client-web`) | Private balance, private sends and withdrawals, broadcasters |
| [snarkjs](https://github.com/iden3/snarkjs) | Railgun's zero-knowledge proofs, generated in the browser |
| [SimpleWebAuthn](https://simplewebauthn.dev) (`browser`, `server`) | Passkeys (WebAuthn, including the PRF extension) |
| [ethers](https://ethers.org) | Ethereum Sepolia reads and transactions |
| [oidc-provider](https://github.com/panva/node-oidc-provider), [openid-client](https://github.com/panva/openid-client) | "Continue with Login" (OpenID Connect) and its demo app |
| [Hono](https://hono.dev) | Login's API server |
| [Sumsub WebSDK](https://docs.sumsub.com) | KYC, sandbox mode |
| [React](https://react.dev), [Vite](https://vite.dev), [Motion](https://motion.dev), [Sonner](https://sonner.emilkowal.ski) | The app, animations, notifications |
| [level-js](https://github.com/Level/level-js), memdown | Railgun's local database |
| [Vitest](https://vitest.dev), [Playwright](https://playwright.dev) | Unit and browser tests |

The vault (`packages/vault`) uses only the browser's built-in Web Crypto: no
homemade cryptography. Swaps use NEAR Intents' 1Click API (through Tidepool on
testnet).

## AI-written code

All code, tests and docs were written by AI coding agents (Claude Code by
Anthropic, and Codex by OpenAI), directed and reviewed by the team. The team
made the product and privacy decisions, and turned them into explicit
constraints (recorded in [docs/design/passkeys.md](docs/design/passkeys.md)
and enforced by tests) that narrowed what the agents could build, so every
solution had to meet the outcome we wanted. We designed the interface in
Figma, and reviewed and merged every change.

## Run it locally

```bash
npm install
npm run dev
```

- App: http://localhost:5180
- Email codes (development only): http://localhost:5180/dev/outbox

Passkeys work on `localhost` without HTTPS. Optional settings in `.env`
(see `.env.example`): `TESTNET_GAS_FAUCET_KEY` (gas faucet),
`TESTNET_POOL_MNEMONIC` (test funds), Sumsub sandbox keys (KYC).

## Tests

```bash
npm test               # unit tests
npm run test:e2e       # browser tests (Chrome's virtual authenticator); some run live on Sepolia
npm run typecheck
```

## Layout

- `packages/vault`: encrypts the wallet secret so only the user's passkeys can open it
- `apps/web`: the app (React). `src/railgun/` runs the private wallet in a Web Worker
- `apps/server`: the Login API server
  - `src/passkeys/`: email codes, passkeys, sessions, encrypted vault storage
  - `src/oidc/`: OpenID Connect provider ([contract](apps/server/src/oidc/README.md))
  - `src/kyc/`: Sumsub sandbox verification (status only)
  - `src/testnet-gas/`, `src/test-funds/`: **testnet-only** (see above)
  - `src/scripts/`: one-off testnet scripts (the test-funds pool)
  - `src/migrations/`: numbered database migrations; each team owns its tables
- `e2e`: browser tests
- `docs/design`: design decisions
