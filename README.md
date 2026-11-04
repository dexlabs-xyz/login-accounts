# login-accounts
One passkey account to log in / sign up anywhere and move money privately across chains, built on NEAR Intents.

**Testnet only. Never use real funds.**

## Run it locally

```bash
npm install
npm run dev
```

- App: http://localhost:5180
- Email codes (development only): http://localhost:5180/dev/outbox

Passkeys work on `localhost` without HTTPS. Use Chrome, Safari or Firefox on the
same machine.

### Testnet gas faucet (simulation)

Sepolia only. Sends a little test ETH to a fresh deposit address so it can pay
to shield its test USDT, because Tidepool can't deliver Sepolia ETH. It
**contradicts our privacy design (D6)** and must never reach mainnet: see
[Testnet-only exceptions](docs/design/passkeys.md#testnet-only-exceptions-must-not-reach-mainnet).
Off by default; set `TESTNET_GAS_FAUCET_KEY` in `.env` to a fresh, testnet-only
key funded with Sepolia ETH (optionally `SEPOLIA_RPC_URL`).

## Tests

```bash
npm test               # unit tests (vault crypto, API)
npm run test:e2e       # passkey edge cases with Chrome's virtual authenticator
npm run typecheck
```

## Layout

- `packages/vault` — encrypts the wallet secret so only the user's passkeys can open it
- `apps/server` — the one Login API server
  - `src/passkeys/` — email codes, passkey sign-up/sign-in, sessions, encrypted vault storage (passkeys team)
  - `src/oidc/` — OpenID Connect provider (Login infra team). Contract: [`src/oidc/README.md`](apps/server/src/oidc/README.md)
  - `src/migrations/` — numbered database migrations; each team owns its tables
  - `src/testnet-gas/` — **testnet-only** gas faucet (simulation; contradicts D6, never on mainnet)
  - `src/app.ts`, `main.ts`, `config.ts`, `db.ts`, `http.ts`, `mail.ts` — shared; changes need both teams' review
- `apps/web` — the withlogin.com app
- `e2e` — browser tests
- `docs/design` — design decisions ([passkeys](docs/design/passkeys.md))
