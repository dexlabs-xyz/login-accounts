# OIDC provider

**Owner: Login infra team. Unaudited hackathon implementation, testnet only.**
The approved `oidc-provider` library runs inside the shared Login API process,
under `/oidc/*`. Root discovery redirects to
`/oidc/.well-known/openid-configuration`. Passkeys and KYC run in that same API.

For the Vercel/Railway public demo, see the complete
[deployment and Gold DNS handoff](../../../../docs/oidc-public-demo.md).
The only public issuer allowed is `https://demo.withlogin.com/oidc`. All other
non-local issuers are refused. `OIDC_ENABLED=1` opts in; otherwise OIDC is off.
Local default: `http://localhost:5180/oidc`. The `/oidc` suffix is required.

## Shared contracts

`routes.ts` calls `sessions.getSignedInUser(cookieHeader)`, never the passkey
session tables. Its result contains `userId`, `authenticatedAt` in milliseconds,
`method: 'passkey'` and `userVerified: true`. OIDC converts the timestamp to Unix
seconds while retaining milliseconds to require a newer check for fresh sign-in.
An email-code check alone cannot authenticate an OIDC interaction. A passkey
that cannot unlock the wallet can still sign in to apps.

| Event                  | URL                                             |
| ---------------------- | ----------------------------------------------- |
| Sign in                | `/signin?interaction=<id>`                      |
| Fresh passkey required | `/signin?interaction=<id>&fresh=1`              |
| Completed passkey      | `/oidc/interaction/<id>/complete`               |
| Cancelled              | `/oidc/interaction/<id>/abort?reason=cancelled` |

Interactions require their browser-bound cookie and expire after ten minutes.
Consent POSTs require the configured Login Origin. Only authorization code with
PKCE is allowed. Public clients get a different persisted random subject per
app; no email, name, wallet address or identity documents. Consent is required.

`app.ts` now wires KYC's merged `createGetKycClaims(db)` adapter through
`oidcRoutes`. A passed L1/L2/L3 yields `verified_human: true` and
`verification_sandbox: true`; missing/unverified results omit both, never `false`.
KYC is optional. Only `openid` is supported: `kyc_level` is not disclosed even if
an adapter returns it. A future level scope needs its own explicit consent UI.

## Local development

On Node 22.13+, from the repository root:

```sh
npm ci
npm run dev:oidc
```

This starts the shared API on `127.0.0.1:8787`, Login web on
`http://localhost:5180`, and a small claims demo on `http://localhost:5190`.
Stop other servers using those ports first. Vite forwards `/api`, `/oidc` and
`/.well-known`. In a remote dev container, forward 5180 and 5190 to those same
local port numbers. The demo uses real passkey routes. For a new test account,
read its email code at `http://localhost:5180/dev/outbox` (local development only).
Never use real identity documents or funds.

The playable chess app is in `IyamGold/chess-ui`. `chess-app-local` is registered
for `http://localhost:5190/api/login/callback`; `chess-local` and `second-local`
are registered for the claims demo's `/callback`. Run only one of these clients
on port 5190 at a time. Hosted registrations use explicit `OIDC_CLIENTS` instead.

Local keys are ephemeral unless **both** `OIDC_JWKS` and `OIDC_COOKIE_KEYS` are
provided. Hosted mode requires both. `npm run oidc:generate-keys -- <private-file>`
generates them once without printing them. Do not commit or share that file.

## Storage and boundaries

Migration `0004_oidc_initial` follows KYC's `0003`. Only the logged migration
runner creates schema. SQLite stores protocol state in `oidc_records` and
per-app IDs in `oidc_subjects`. Keep it private on a persistent volume; reusing
keys without retaining SQLite is insufficient. See the deployment guide for
restart and rotation requirements. The shared API uses no separate OIDC server.

`openid-client` is used only by `dev-client.ts`, a separate optional relying-party
process, and remains a **devDependency**. It verifies state, nonce, PKCE, issuer,
audience, expiry, ID-token signature and UserInfo subject, then discards tokens.
Its memory-only result expires in ten minutes. Public second-app mode is opt-in
and uses Secure cookies and HTTPS validation; the shared API's production install
does not include this demo client or its library.

Labels remain “Unaudited” and “Testnet”. Dynamic registration, production issuer
support, grant revocation UI and broader abuse controls remain future work.

## Validation

```sh
npm run typecheck
npm test
npm run test:oidc:browser
```

Set `OIDC_CHROMIUM_EXECUTABLE` for a system Chromium if needed. The browser spec
in `e2e/oidc.spec.ts` uses virtual passkeys and tests consent, freshness,
pairwise IDs, logout and cancellation. It disables token-bearing traces,
screenshots and videos. Protocol/config tests cover hosted HTTPS/proxy behavior,
Secure cookies, restart continuity, PKCE failure, replay, expiry, browser binding,
Origin checks, and the real sandbox KYC handoff. Public DNS/TLS still needs a
post-deployment smoke test by the deployment owner.
