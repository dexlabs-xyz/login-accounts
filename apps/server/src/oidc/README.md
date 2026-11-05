# OIDC provider

**Owner: Login infra (OIDC) team.** The passkeys team doesn't edit this folder.

The OpenID Connect provider runs inside the shared Login API server
(`../app.ts`), under `/oidc/*` and `/.well-known/*`. Library: `oidc-provider`
(approved by the team on 2026-11-04).

## What the passkeys component gives you

### `getSignedInUser(cookieHeader)` — `../passkeys/session.ts`

Pass the request's raw `Cookie` header. Returns `null` if signed out, otherwise:

```ts
{
  userId: string; // stable internal ID (users.id). Never send to apps; derive a per-app ID.
  authenticatedAt: number; // ms since epoch of the last successful passkey check
  method: 'passkey';
  userVerified: true; // every passkey check requires Face ID / fingerprint / PIN
}
```

- `authenticatedAt` only moves when a passkey check succeeds (sign-in, unlock,
  confirming a send, adding a passkey). Verifying an email code never counts.
- Use it for `max_age` / `prompt=login`: if it's too old, send the user to
  `/signin` with `fresh=1`.
- Any passkey works for signing in to apps, including ones that can't open the
  wallet. Don't require the wallet to be unlocked.
- Don't read the `sessions` table or the `login_session` cookie directly.
- The session cookie is `SameSite=Lax`, so it arrives when an app redirects the
  user to `/oidc/auth`.

It's created in `../app.ts` as `sessions.getSignedInUser`; pass it into your routes.

### Sign-in handoff — the `/signin` page

| Step                               | URL                                             |
| ---------------------------------- | ----------------------------------------------- |
| OIDC sends the user to sign in     | `/signin?interaction=<id>`                      |
| …and demands a fresh passkey check | `/signin?interaction=<id>&fresh=1`              |
| Success (signed in or signed up)   | `/oidc/interaction/<id>/complete`               |
| User cancels                       | `/oidc/interaction/<id>/abort?reason=cancelled` |

- `<id>` must match `^[A-Za-z0-9_-]{1,128}$`, or the page refuses to redirect.
- The page never accepts a return URL; it only builds these two fixed paths.
- You own validating the interaction ID and its lifetime. Unknown or expired IDs
  should be handled on your side (e.g. `reason=expired` is yours to emit).
- Without `fresh=1`, a user who already has a session goes straight to
  `complete` with no prompt.

## Database

Add migrations as `../migrations/NNNN_oidc_<what>.ts` and list them in
`../migrations/index.ts`. Prefix tables with `oidc_`. Never edit merged migrations.

## Local development

- API server: `127.0.0.1:8787`. Login web app: `http://localhost:5180` (Vite
  forwards `/api`, `/oidc` and `/.well-known` to the API).
- Demo app: `http://localhost:5190`.
- Environment variables: prefix with `OIDC_` (e.g. `OIDC_ISSUER=http://localhost:5180`).
  Development signing keys are generated locally and never committed.
- Bind dev servers to `127.0.0.1`: inside the container `localhost` is IPv6-only,
  and VS Code's port forwarding connects over IPv4.

## Integrated local iteration (OIDC team)

The provider is now mounted at the marked location in `app.ts`, through
`oidc/routes.ts`. The Node/Hono bridge lets `oidc-provider` handle its native
request and response without another API server. It passes the Cookie header to
`sessions.getSignedInUser` and converts the returned milliseconds to OIDC seconds,
retaining millisecond precision to enforce a genuinely newer check for fresh sign-in.
The OIDC module never reads passkey session tables or cookie values directly.

From the repository root, on Node 22.13+:

```sh
npm ci
npm run dev:oidc
```

This starts the shared API on 127.0.0.1:8787, Vite on localhost:5180 and the demo
client on localhost:5190. Stop other dev servers using these ports first. Forward
5180 and 5190 to the same local port numbers if using a remote container. Open
http://localhost:5190 and choose **Continue with Login**. This iteration now uses
**the real passkey routes**, not the old simulated sign-in button.

For a new account, use a test email; the code appears at
http://localhost:5180/dev/outbox (development only). Create a passkey when asked,
then allow consent. Returning users can sign in with a passkey. A passkey that
cannot open the wallet still works for OIDC. KYC is not connected, so
`verified_human` is omitted when no passed KYC level is supplied. Do not use real identity documents or funds.

`npm run dev` remains the passkey-only workflow unless `OIDC_ENABLED=1` is set.
The integration explicitly opts in with that variable. `OIDC_ISSUER` defaults to
`http://localhost:5180/oidc`; the `/oidc` suffix is required. Discovery is at
`/oidc/.well-known/openid-configuration`; the root discovery path redirects there.
Endpoint URLs use the configured public issuer, even when Vite rewrites Host to
the internal API address. Forwarded headers are not trusted as issuer settings.

The local demo uses approved `openid-client` to validate discovery, state, nonce,
PKCE, ID-token signature/issuer/audience/expiry and UserInfo subject. It discards
tokens after use and displays only the per-app ID and verification status. Its
result expires after ten minutes. It requires `OIDC_DEV_CLIENT=1` and a localhost
HTTP issuer; the npm script supplies the flag. No provider, cookie keys, request
bodies, tokens or private signing material are logged.

### Storage and limitations

Migration `0004_oidc_initial` is registered in the shared migration registry. It
creates only `oidc_records` and `oidc_subjects`; passkey migrations and tables are
unchanged. SQLite contains protocol sessions, grants, authorization codes and
access tokens; keep the development database private. Per-app IDs persist in the
shared database across restarts. OIDC signing and cookie keys are ephemeral in
this iteration, so restarting the API requires a new OIDC flow. Passkey sessions
and credentials follow the passkey component's existing storage behavior.

Local-only and unaudited: production issuers are refused. Production signing-key
management, client registration administration, grant revocation UI and abuse
controls remain future work. Only the `openid` scope is supported: email, name,
wallet data and identity documents are not sent to apps. Approved sandbox KYC,
when connected by its owner, must carry `verification_sandbox: true`.

### Validation

```sh
npm run typecheck
npm test
# With Playwright Chromium installed (starts its own servers; stop manual dev servers):
npm run test:oidc:browser
```

For a system Chromium set `OIDC_CHROMIUM_EXECUTABLE` to its executable path. The
browser test uses Chrome virtual passkeys without PRF wallet support. It checks
signup, token-validated OIDC sign-in, per-app IDs, consent reuse, a fresh real
WebAuthn verification, logout and cancellation. It does not create a wallet or
contact chain services. The spec lives in `e2e/oidc.spec.ts` and runs with the rest of the Playwright suite. Token-bearing traces, screenshots and videos are disabled for this spec. Protocol tests additionally cover PKCE failure, replay,
expiry, Origin checks, browser-bound interactions and verification claims.

Shared review surface: `app.ts`, migration registration and its expectation test,
workspace manifests and the root lockfile. `main.ts`, `config.ts`, `db.ts`, Vite
configuration, passkey code and the web application are unchanged by this work.

### KYC contract and merge order (PR #4 / PR #5)

OIDC follows KYC's `kycClaims(level, approvedScopes)` semantics: `verified_human`
is present as `true` only for a passed L1/L2/L3. Missing/pending/rejected KYC with
no previously passed level emits no humanity claim, rather than `false`. The
KYC owner determines the highest passed level; OIDC does not infer it from an
in-progress attempt or read KYC-owned tables.

`AppDeps.getKycClaims(userId, approvedScopes)` is threaded through `oidcRoutes`
to the provider. It returns KYC's claims shape with optional
`verification_sandbox: true` metadata for sandbox results. The callback defaults
to absent, which emits no KYC claims. The app therefore still supports login
without KYC. The demo displays “Not provided” instead of treating absence as a
failed verification.

**The real KYC adapter is not connected in this branch:** PR #4 is still a
separate, unmerged branch. Whichever PR lands second must wire this callback in
the shared application composition using a KYC-owned level lookup and the
existing helper, e.g.:

```ts
getKycClaims: async (userId, approvedScopes) => {
  const level = await getPassedKycLevel(userId); // exported by KYC, not an OIDC SQL query
  const claims = kycClaims(level, approvedScopes);
  return {
    ...claims,
    ...(claims.verified_human ? { verification_sandbox: true } : {}),
  };
},
```

`getPassedKycLevel` is a required KYC integration export, not an existing function
in PR #4. Alternatively KYC can export the complete callback. Do not merge the
combined feature as fully wired until this adapter is supplied and tested.

Only `openid` is currently supported and granted. No `kyc_level` value is emitted,
even if the callback returns one. Supporting that scope needs explicit consent UI
and tests in a follow-up. The provider supplies granted token scopes to the callback.

Migration number `0003` is reserved for KYC; our migration/export is now `0004`
/ `m0004`. Until KYC lands, the local registry intentionally contains 0001, 0002, 0004. When combined, add KYC's 0003 ahead of 0004 and update the migration test.
Existing local OIDC tables are preserved by the idempotent 0004 migration.
`createStorage` no longer creates schema: callers and standalone tests run the
logged migration runner before constructing storage.

`openid-client` is used only by `dev-client.ts` and is a server-workspace
**devDependency**. The shared API imports only `oidc-provider`; it does not load
the demo client. The user approved the demo dependency during local development,
and it is now isolated from the production dependency set as requested.
