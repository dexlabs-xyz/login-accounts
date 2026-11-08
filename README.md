# Login accounts

One passkey account to sign in anywhere and move money privately across
chains, built on **NEAR Intents** and **Railgun**.

**Testnet only. Never use real funds. Hackathon build: not audited.**

- **Live demo:** https://demo.withlogin.com (Sepolia testnet)
- **Design decisions:** [docs/design/passkeys.md](docs/design/passkeys.md)

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
5. **Withdraw** to any Ethereum address. The review shows every fee, warns
   you that this part is public, and flags it if the address is one that sent
   money into your account (anyone could link the two).
6. **Verify you're human** (optional, Sumsub sandbox), and **continue with
   Login** on other apps: they learn only that you're a verified human, with a
   different ID per app.

Everything moves in one currency on screen: USDT. Every send and withdrawal is
confirmed with your passkey after a summary.

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

Also worth knowing: new deposits wait for Railgun's privacy check ("being
checked"), usually one to two hours, before they can be spent.

### Not built yet (next)

- **Smart accounts at the edges** (EIP-7702 + a paymaster): deposit addresses
  paying their own gas in USDT, replacing the testnet gas faucet. Planned
  (notes in the design doc), not built.
- **Split-key recovery** for losing every passkey.
- **Withdrawals to Solana** (today: Ethereum addresses only).
- **A mainnet version**, without the testnet-only exceptions above.

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
