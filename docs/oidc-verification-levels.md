# Verification-level sharing through the existing Continue action

Apps may request `openid kyc_level`. The existing Login Continue page then says
that continuing shares the verification status and level when available, while
identity documents remain private and verification remains optional. The same
Allow and continue button grants the requested level scope. There is no extra
screen or checkbox; Cancel still ends sign-in. Existing openid-only grants must
approve the new scope before it can be released, as verified by prompt=none and
normal-interaction tests.

Only approved L1/L2/L3 outcomes can produce a kyc_level claim, and only alongside
verified_human=true and under the granted scope. The sandbox marker is retained.
Unverified sign-ins still succeed and omit the claims. Openid-only apps receive
no exact level, even if the KYC adapter accidentally returns one. Per-app IDs,
PKCE, issuer validation, shared-session checks, cookie policy and existing consent
origin/cancellation protections are unchanged. Connected apps identify grants
that permit level sharing.

Deploy this Login API and frontend change before the companion Chess change. Existing players
can then use Chess's Refresh verification action to obtain a current assertion;
old stored Chess sessions are not upgraded to a guessed level. No environment
variables, dependency versions, signing keys or passkey settings change. All
validation uses synthetic accounts and sandbox or injected KYC outcomes.

Validation:

```
npm run typecheck
npm -w @login/web run build
npm test -- apps/server/src/oidc apps/server/src/kyc/kyc.test.ts
```

The companion Chess repository adds a real in-memory Login-to-Chess integration
test covering unverified, L1/L2, stable IDs, one existing Continue screen, sandbox
labeling and clearing stale verification data. The two PRs require normal team
review. Neither live service is deployed by preparing these source changes.
