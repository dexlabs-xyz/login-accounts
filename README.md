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

## Tests

```bash
npm test               # unit tests (vault crypto, API)
npm run test:e2e       # passkey edge cases with Chrome's virtual authenticator
npm run typecheck
```

## Layout

- `packages/vault` — encrypts the wallet secret so only the user's passkeys can open it
- `apps/server` — API: email codes, passkey sign-up/sign-in, encrypted vault storage
- `apps/web` — the withlogin.com app
- `e2e` — browser tests
- `docs/design` — design decisions ([passkeys](docs/design/passkeys.md))
