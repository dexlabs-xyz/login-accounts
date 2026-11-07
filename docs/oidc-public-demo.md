# Hosted OIDC demo handoff

**Testnet / Sumsub sandbox only. Unaudited; not approved for production use.**
The shared API runs passkeys, KYC and OIDC in one process. Its only allowed public
OIDC issuer is `https://demo.withlogin.com/oidc`; localhost HTTP `/oidc` remains
available for development. No production provider or dynamic client registration
is enabled by this change.

## Login API on Railway

Use Node 22.13+ and the repository root. Install with `npm ci --omit=dev` and start
with `npm -w @login/server start` (tsx is a runtime dependency). Set:

| Variable                        | Value / action                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| `HOST`                          | `0.0.0.0`                                                                 |
| `PORT`                          | Railway supplies this                                                     |
| `OIDC_ENABLED`                  | `1`                                                                       |
| `OIDC_ISSUER`                   | `https://demo.withlogin.com/oidc`                                         |
| `WEBAUTHN_RP_ID`                | `withlogin.com` — permanent passkey RP                                    |
| `WEBAUTHN_ORIGINS`              | `https://demo.withlogin.com`                                              |
| `DB_PATH`                       | `/data/login.sqlite`, with a Railway persistent volume mounted at `/data` |
| `DEV_OUTBOX`                    | unset; never expose development email codes publicly                      |
| `RESEND_API_KEY`, `MAIL_FROM`   | existing approved email configuration, entered privately                  |
| `OIDC_JWKS`, `OIDC_COOKIE_KEYS` | private generated values, as described below                              |
| `OIDC_CLIENTS`                  | exact client list below                                                   |

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
    "redirect_uris": ["https://chess-demo.withlogin.com/api/login/callback"]
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

Use `apps/web/vercel.json`, replacing its Railway-host placeholder with Gold's
actual API service hostname. Forward `/api/*`, `/oidc`, `/oidc/*` and
`/.well-known/*` before the SPA fallback. Preserve the path and query string.
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

- Install `npm ci --include=dev` for this separate demo service: `openid-client`
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

1. Create the Railway services and persistent volumes, enter secrets privately,
   and record their provider-assigned domain targets.
2. Add `demo.withlogin.com` to the Login Vercel project, and
   `chess-demo.withlogin.com` (optionally `second-demo.withlogin.com`) as custom
   domains on their Railway services.
3. At the DNS provider, use the **exact CNAME/verification records shown by
   Vercel/Railway** for each subdomain. Do not guess target names. Wait for DNS
   validation and TLS provisioning before registering the corresponding client.
4. Replace Vercel's API rewrite destination and verify email/KYC sandbox settings.
5. Test public discovery, passkey sign-up/sign-in, consent/cancel/fresh sign-in,
   chess multiplayer over WSS, and sandbox KYC. Leave no OTP/token-bearing
   screenshots or request logs enabled.
6. Restart the Login API and verify a previously signed-in browser can continue,
   a previously issued token remains verifiable, and the app ID stays the same.

A hosted site has not been published as part of the code change. DNS and the
public smoke test require Gold's hosting access and supplied domain targets.

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
