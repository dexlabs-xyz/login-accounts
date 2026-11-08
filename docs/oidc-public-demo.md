# Hosted OIDC demo handoff

**Testnet / Sumsub sandbox only. Unaudited; not approved for production use.**
The shared API runs passkeys, KYC and OIDC in one process. Its only allowed public
OIDC issuer is `https://demo.withlogin.com/oidc`; localhost HTTP `/oidc` remains
available for development. No production provider or dynamic client registration
is enabled by this change.

## Login API on Railway

Use Node 22.13+ and the repository root. Keep Railway’s existing build command
**`npm install --no-audit --no-fund`**, and start with
`npm -w @login/server start` (tsx is a runtime dependency). Do not replace the
Railway command with `npm ci`: its mounted dependency cache can produce an
`EBUSY` error when npm tries to remove it. Local clean installs can still use
`npm ci`. Set:

| Variable                        | Value / action                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                      | `production`                                                              |
| `HOST`                          | `0.0.0.0`                                                                 |
| `PORT`                          | Railway supplies this                                                     |
| `OIDC_ENABLED`                  | `1`                                                                       |
| `OIDC_ISSUER`                   | `https://demo.withlogin.com/oidc`                                         |
| `WEBAUTHN_RP_ID`                | `demo.withlogin.com` — preserve the live demo’s existing passkeys         |
| `WEBAUTHN_ORIGINS`              | `https://demo.withlogin.com`                                              |
| `DB_PATH`                       | `/data/login.sqlite`, with a Railway persistent volume mounted at `/data` |
| `DEV_OUTBOX`                    | unset; never expose development email codes publicly                      |
| `RESEND_API_KEY`, `MAIL_FROM`   | existing approved email configuration, entered privately                  |
| `OIDC_JWKS`, `OIDC_COOKIE_KEYS` | private generated values, as described below                              |
| `OIDC_CLIENTS`                  | exact client list below                                                   |

The live demo already has passkeys bound to `demo.withlogin.com`. Keep that RP
ID during this OIDC rollout; changing it would make those credentials unavailable
under the new RP. Any future RP migration is separate work. OIDC accepts an RP
when the pinned issuer host equals it or is a subdomain of it, with a dot boundary
(`demo.withlogin.com` or its parent `withlogin.com`). Secure cookies and the exact
`https://demo.withlogin.com` passkey origin remain required. The issuer allowlist
is unchanged.

The API refuses the hosted OIDC issuer if the passkey RP/origin/cookie settings
conflict, or keys/clients are missing. The executable also refuses an absent or
in-memory `DB_PATH`. A disk path alone does not prove durability: Gold must attach
and verify the volume. Keep one API replica with this SQLite volume. Back it up
privately; it contains account/session and protocol data. Stable keys without a
stable database do not preserve sessions, grants, or per-app IDs.

Keep the merged KYC team's **sandbox** configuration and webhook settings. Their
`createGetKycClaims(db)` adapter remains connected. Passed L1–L3 emits
`verified_human: true` plus `verification_sandbox: true`; no passed level omits
both claims. `kyc_level`, email, wallet data and identity documents are not shared.
KYC remains optional. Use only sandbox test identities and testnet funds.

## Generate persistent secrets once, on Gold's computer

After a normal development install (`npm ci`), run from the repository root:

```sh
npm run oidc:generate-keys -- /private/directory/oidc-secrets.json
```

Windows PowerShell example (choose a private, non-synced directory):

```powershell
npm run oidc:generate-keys -- "$env:USERPROFILE\oidc-secrets.json"
```

The command uses Node's RSA-2048 key generator and cryptographically random cookie
secrets. It writes a **new** JSON file and never prints the keys. It refuses to
overwrite an existing file. POSIX permissions are `0600`; on Windows restrict the
file's ACL to its owner. Do not run it in Railway builds, CI, a recorded terminal,
or this chat. Never commit, upload, or paste the file into a PR or chat.

Open that file privately in an editor. Copy the complete object under `OIDC_JWKS` (including its braces) into that
Railway variable, and the complete array under `OIDC_COOKIE_KEYS` (including its
brackets) into that variable. Railway expects raw JSON objects/arrays, without
the outer property names or an extra layer of quoted/escaped JSON. Keep a secure backup under team-controlled secret storage; remove the
local transfer file when finished. The filename pattern is ignored as a second
line of defense. No generated secrets belong in this repository.

Reuse the same values across restarts; do not generate them at startup. For a
planned rotation, keep old RSA keys in `jwks.keys` after the new key and old cookie
keys after the new ones until affected tokens and sessions have expired. Never
remove the only active key during a rollout. Test the rotation on a sandbox
instance first. The public `/oidc/jwks` endpoint publishes public components only.

## Exact client registration

Set `OIDC_CLIENTS` to this non-secret JSON **only once both app URLs are controlled
by the team and have TLS**. Omit an app until its deployment is ready.

```json
[
  {
    "client_id": "chess-demo",
    "client_name": "Login Chess — unaudited testnet demo",
    "redirect_uris": ["https://onchainchess.app/api/login/callback"]
  },
  {
    "client_id": "second-demo",
    "client_name": "Second Login demo — unaudited",
    "redirect_uris": ["https://second-demo.withlogin.com/callback"]
  }
]
```

Names, IDs and exact callbacks are configurable. Hosted callbacks must use HTTPS;
HTTP localhost callbacks, credentials, fragments and wildcards are refused.
The provider fixes all clients to authorization code + required PKCE, public
client authentication, and pairwise subjects. Arbitrary JSON metadata cannot
relax those settings. Per-app consent and POST Origin checks are retained.
Changing a client ID changes that app's pairwise identity; keep IDs stable.

## Vercel and proxy routing

The Vercel rewrites in `apps/web/vercel.json` are already live and point to the
shared Railway API. Preserve those destinations and rule order. They forward
`/api/*`, `/oidc`, `/oidc/*` and `/.well-known/*` before the SPA fallback, keeping
the path and query string. No rewrite replacement is needed for this OIDC rollout.
Do not cache protocol endpoints or callbacks; preserve `Set-Cookie` and
`Cache-Control: no-store`. No key or cookie value belongs in Vite's `VITE_*` env.

The provider pins Host and proxy protocol to the validated issuer. It never uses
an incoming Host/Forwarded header to select the issuer. It sets Secure cookies for
HTTPS even when Railway's internal connection is plain HTTP. Discovery and
absolute redirects use `demo.withlogin.com`, not the internal Railway hostname.
The root discovery URL redirects to `/oidc/.well-known/openid-configuration`.

## Chess and the optional second app

The playable app lives in `IyamGold/chess-ui`, not this repository. Apply/review
the companion hosted-demo changes there after the existing Login integration.
Host its Express backend **and built Vite assets together on Railway**, with its
WebSocket endpoint on that same origin. This avoids trying to run a persistent
WebSocket server as a Vercel function. The companion deployment guide gives the
build/start commands, exact environment and durable database path.

The second app is the small claim-validation demo, not another chess game. It
runs as a **separate** Railway process from this checkout:

- Use `npm install --no-audit --no-fund --include=dev` for this separate Railway demo service: `openid-client`
  remains a devDependency and does not ship in the shared API's production install.
- Start `npm -w @login/server run start:oidc-demo`.
- Set `OIDC_DEMO_ENABLED=1`, `OIDC_DEMO_ORIGIN=https://second-demo.withlogin.com`,
  `OIDC_DEMO_CLIENT_ID=second-demo`, `OIDC_ISSUER=https://demo.withlogin.com/oidc`.
- Railway supplies `PORT`; this mode binds `0.0.0.0`. HTTPS mode never enables
  `allowInsecureRequests`. Its short-lived demo results/pending sign-ins are
  memory-only, so restarting this optional app asks the user to sign in again.
- It sees only app-specific ID, optional sandbox humanity claims, temporary
  protocol responses and its own browser session. Tokens are discarded after
  validation; no wallet mapping, documents or keys are stored. No request logging.

## Gold's DNS/deployment handoff

Code preparation does not create hosting services or DNS records. Gold should:

1. Keep the existing Login Railway service and persistent volume. Enter the
   OIDC secrets privately without changing its passkey RP or existing credentials.
2. Keep the live `demo.withlogin.com` Vercel domain and rewrites. For the Chess
   app’s `onchainchess.app` domain (optionally `second-demo.withlogin.com`), follow
   the companion app’s Railway custom-domain handoff.
3. At the DNS provider, use the **exact CNAME/verification records shown by
   Vercel/Railway** for each subdomain. Do not guess target names. Wait for DNS
   validation and TLS provisioning before registering the corresponding client.
4. Verify the existing Vercel routes and email/KYC sandbox settings without
   replacing the live rewrite destinations or Railway build command.
5. Test public discovery, passkey sign-up/sign-in, consent/cancel/fresh sign-in,
   chess multiplayer over WSS, and sandbox KYC. Leave no OTP/token-bearing
   screenshots or request logs enabled.
6. Restart the Login API and verify a previously signed-in browser can continue,
   a previously issued token remains verifiable, and the app ID stays the same.

This code change does not redeploy or reconfigure the existing live sites.
Additional app domains and the public smoke test require Gold’s hosting access.

## Validation

```sh
npm run typecheck
npm test
npm run test:oidc:browser
```

HTTPS configuration tests reject unapproved issuers, missing keys and insecure
callbacks. A shared-server test completes the hosted HTTPS flow through a local
plain-HTTP proxy fixture with a misleading Host/forwarded host, checks Secure
cookies and the real KYC adapter. A restart test checks code/token/session and
pairwise identity continuity with the same database and keys. The localhost
Playwright spec still exercises real virtual passkeys, consent, freshness and
cancellation. These checks do not replace the post-deployment DNS/TLS smoke test.
