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
  userId: string;          // stable internal ID (users.id). Never send to apps; derive a per-app ID.
  authenticatedAt: number; // ms since epoch of the last successful passkey check
  method: 'passkey';
  userVerified: true;      // every passkey check requires Face ID / fingerprint / PIN
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

| Step | URL |
|---|---|
| OIDC sends the user to sign in | `/signin?interaction=<id>` |
| …and demands a fresh passkey check | `/signin?interaction=<id>&fresh=1` |
| Success (signed in or signed up) | `/oidc/interaction/<id>/complete` |
| User cancels | `/oidc/interaction/<id>/abort?reason=cancelled` |

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
