# KYC architecture (draft)

> **Status: proposal for team review.** Nothing here is final. Items marked
> **Decide** are open questions for the team. Nothing in this document has been
> built yet. It builds on the passkey design (`docs/design/passkeys.md`, draft
> PR #2). Decision numbers like D6 refer to that document.

This document covers how Login accounts verify that a user is a human and,
optionally, who they are, and how that verification reaches apps that use
"Sign in with Login".

## Goals

- **Optional.** Holding money, sending money and logging in never require KYC.
- **Done once, used everywhere.** A level a user reaches on Login carries to
  every app. If an app needs a higher level, the user completes only the extra
  step, once.
- **Login doesn't see identity documents.** Documents and selfies go from the
  user's device straight to Sumsub. Login stores only the verification result,
  the level and Sumsub's reference ID.
- **Nothing is shared by default.** An app receives a different user ID per
  app, plus a "verified human" claim when the user has earned it. Anything else
  needs the user's consent for that specific app.
- **Testnet and Sumsub sandbox only.** No real identity documents are ever
  uploaded, including the team's own.

## Levels

Each level builds on the one before, so a user only ever does the extra step.

| Level | What the user does | Sumsub products | What an app can receive |
|---|---|---|---|
| **L0** (default) | Creates a passkey account and verifies their email with a one-time code (D2) | — | A per-app user ID |
| **L1 verified human** | Records a 30-second selfie video | Liveness, duplicate detection. Optional: Device Intelligence, Fraud Network Detection | `verified_human: true` (by default) |
| **L2 verified identity** | Scans an ID document | ID Verification with face match to the L1 selfie, AML Screening. Non-Doc Verification where available | `kyc_level: "L2"` (with consent) |
| **L3 verified address** | Uploads proof of address | Proof of Address (PoA) | `kyc_level: "L3"` (with consent) |

### What "verified human" means

A passkey alone doesn't prove a human: software can create unlimited passkeys.
We propose that **`verified_human` means the user passed L1**: Sumsub
confirmed a live person in front of the camera, and that this person doesn't
already have another Login account.

- Users who skip L1 still use everything in Login. Apps simply receive no
  `verified_human` claim for them.
- The duplicate check gives apps **one human, one account**. Because each app
  gets a different user ID, this resists bots without letting apps track users
  across sites.
- Login never sees the face. It only learns pass, or fail with a reason (for
  example, duplicate).

**Known limits:**
- Liveness is an arms race against deepfakes and injected camera feeds.
  `verified_human` is only as strong as Sumsub's detection.
- A face is biometric data. It is stored by Sumsub, not Login, and the UI must
  say so before the check starts.
- A pass from long ago doesn't prove the same person still controls the
  account. High-assurance apps could request a fresh liveness check (step-up).

**Decide:**
- Confirm in the sandbox that duplicate detection works on a liveness-only level.
- Agree that `verified_human` is sent only after L1, not for every user.

### Products we deliberately don't use

- **AML Transaction Monitoring.** This would send users' transactions to
  Sumsub, which defeats private balances. Funds are already screened against
  sanctions lists by Railgun's Proofs of Innocence.
- **Email & Phone Verification.** Sign-up already verifies email with Login's
  own one-time code (D2). Using Sumsub here would give Sumsub every user's
  email linked to an applicant, including users who never do KYC.
- **Bank Account Verification, Payment Ownership, QES, Video Ident, AllDocs,
  KYB.** Not needed for Login accounts.
- **Travel Rule.** This may become a regulatory question for private sends
  later. It is out of scope for the hackathon.

## Verification flow

```
User's device                 Login KYC service              Sumsub
─────────────                 ─────────────────              ──────
Tap "Verify"  ───────────────▶ create applicant
                               (random opaque ID)  ─────────▶ applicant created
                               request widget token ────────▶ short-lived token
              ◀─────────────── token
Sumsub widget: selfie / ID / PoA ──────────────────────────▶ (documents go
                                                               straight here)
                               ◀──────────────────────────── signed webhook:
                                                               result + level
                               verify signature, store
                               {level, result, applicant ID, time}
See result    ◀─────────────── status
```

- **The applicant ID is random and opaque.** It is never the wallet address,
  the email or anything linkable.
- **The Sumsub client only exposes status and level calls.** The KYC service's
  wrapper around the Sumsub API deliberately has no method that returns
  personal data. That way "Login doesn't look" is enforced in code, not just
  promised.
- **Webhook signatures are checked** before any result is stored. In local
  development, Sumsub can't reach `localhost`, so the service polls Sumsub's
  status API instead, unless a tunnel domain is approved.
- **Where the record lives.** The account stores only `{level, result,
  updated_at}`. On its own this doesn't identify anyone, so the server can read
  it at every sign-in. This matters because sign-in doesn't need PRF (D7): if
  the level were locked behind the wallet key, users on devices without PRF
  would silently lose `verified_human`.
- **The account ↔ Sumsub applicant link** is what ties an account to a real
  person, so only that link goes under controlled access:
  - **Escrow copy:** encrypted on the device for the key holders.
  - **Everyday copy:** in the user's passkey vault.
  - **On the server:** the link exists only for the length of one
    verification session, so the result can be attached to the account. It is
    never persisted or logged.

**Decide:** Sumsub can change a result later (re-review, or a level being
revoked). With no stored link, the server can't match a later webhook to an
account. Option: the device re-checks status the next time the user opens the
KYC screen.
- Rejection reasons are mapped to two user-facing outcomes:
  - **Try again:** bad lighting, face not visible, blurry document.
  - **Final:** duplicate account, suspected spoofing.

### UX states

The verify flow must let the user find their way back or forward from any
state:

1. **Before:** what the check involves, how long it takes, and that the selfie
   and documents go to Sumsub, not Login.
2. **Camera permission:** what happens if the user says no, with a clear way
   back.
3. **Desktop without a camera:** hand off to a phone with a QR code, which the
   Sumsub widget supports.
4. **In review:** progress and an estimate of how long it will take.
5. **Passed / try again / final:** a clear message and next step for each.
6. **Slow or expensive connections:** measure how heavy the widget is on a
   slow connection and on low-end phones.

## How apps receive data (OpenID Connect)

| Scope the app requests | Claims returned | When |
|---|---|---|
| `openid` (always) | Per-app user ID (`sub`), plus `verified_human` if L1 passed | By default |
| `profile` | `name` | Only if the user approves for this app |
| `email` | `email`, `email_verified` | Only if the user approves for this app |
| `kyc_level` (custom) | `L1` / `L2` / `L3` | Only if the user approves for this app |

- **Consent screen:** lists what the app requests, with every item unticked.
  The choice is remembered per app.
- **Connected apps page:** the user can see what each app receives and revoke
  it at any time.
- **Marketing emails** are a separate opt-in from sharing the email itself.
- **Sharing email** lets two apps link the same user, which undoes the per-app
  user IDs. The consent screen should make that clear. Per-app relay addresses
  (like Apple's Hide My Email) are a possible future option. They would need a
  mail-forwarding server, which would see forwarded mail.

### Delivering a KYC level

- **Hackathon:** a Login-signed `kyc_level` claim in the ID token. It works
  with any app, including the demo app.
- **Upgrade path for regulated apps:** an app that must legally rely on the
  check itself can receive the verification directly from Sumsub through
  Reusable KYC / Sumsub ID, with the user's consent. Login never sees the
  data. This only works if the app is also a Sumsub client.

**Decide:** the exact claim names and the consent screen, together with
whoever builds the OIDC provider.

## Name and email

The current proposal:

- **The email** is collected and verified at sign-up with Login's own
  one-time code, sent through Resend (D2, already built). The account service
  stores it. It is unencrypted today, and encryption at rest will be added once
  the approach is agreed.
- **The name** is typed by the user and shared as unverified. A verified name
  from the ID document would reach regulated apps through Sumsub's Reusable
  KYC, not through Login.
- **Both** get standard protection: encrypted at rest, strict access, and
  never in logs or analytics.
- **Login's server never sees wallet or deposit addresses, not even to encrypt
  them (D6).** Every address is derived on the device from the root secret in
  the passkey vault. The server only ever holds ciphertext.

### Why the address must stay unlinked

Railgun hides balances and transfers inside the pool, but deposits and
withdrawals are public on Ethereum: address, token, amount and time. If a
database row ever links a named person to a deposit address, anyone who reads
it (an attacker, an insider, a court order) can look up that person's deposits
and withdrawals on a block explorer.

D6 keeps addresses out of storage, but the server can still see them live. If
Login's server calls NEAR Intents for a user's deposit, it sees the address and
the timing, and timing alone ("Ada requested a deposit at 10:02", "49.8 USDT
deposited at 10:05") can re-link them. The design only holds if **deposits and
withdrawals run from the user's device**. Both teams agree on this.

There's a catch for the deposit-route design. If NEAR Intents' 1Click API
needs an API key, that key can't live in the browser, and a Login server that
passes requests through would see addresses and timing again.

**Decide:**
- How deposits run from the device if 1Click needs an API key. This belongs
  to the deposit-route design.
- Typed name vs. verified name.
- The approach for encrypting emails at rest.

### Risk of storing emails in the clear

A list of everyone who uses a crypto money app is valuable to criminals even
without addresses: for phishing, and for targeting people physically for their
crypto. Standard protection reduces this risk but doesn't remove it.

## Controlled access (escrow)

Some data must only be readable with legal authority: the identity-to-wallet
mapping, and the account ↔ Sumsub applicant link. The level and result alone
are not escrowed (see the verification flow).

**Proposal:** the data is encrypted so it can only be decrypted when three key
holders cooperate (a legal professional and two others), and only under a
valid legal order.

Design requirements:

1. **Escrow is encrypted on the device.**
   - **The everyday copy already exists:** it's the passkey vault (D1). No
     second copy is needed.
   - **The escrow copy is encrypted on the device** for the key holders, so the
     server only ever receives ciphertext.
   - **What gets escrowed must be agreed.** Every deposit uses a fresh address,
     so escrowing addresses one by one won't scale. One option is to escrow the
     Railgun address plus the key that the deposit addresses are derived from.
     That key must be able to derive addresses but never spend. Escrowing a
     Railgun viewing key would reveal the user's entire history, past and
     future, and it can't be revoked.
2. **No master key.**
   - **Each user has their own key**, wrapped for the key holders, so one order
     opens one user, not everyone.
   - **Threshold decryption**, where each holder decrypts their share and the
     full key is never assembled on one machine. This has to use an audited
     library, never homemade cryptography.
3. **The threshold must always need someone outside the team.** With 2-of-3,
   two team members must not be able to decrypt without the outside party.
   With 3-of-3, losing one share loses the data permanently.
4. **Every access is logged and the user is notified,** unless legally barred.
   A public transparency report (requests received and granted) builds trust.
5. **"Legal order" is defined in advance:** which jurisdictions, and what
   documents count. Holders in different jurisdictions make it harder for one
   government to pressure all of them.

**For the hackathon this is simulated, not built.** The demo shows the request
→ approvals → decrypt one user → notify the user flow, and both the code and
the UI label it clearly as a simulation.

**Decide:**
- What exactly is escrowed: the Railgun address, the deposit-derivation key,
  and the applicant link. Agree this with the passkey team.
- Who the two other key holders are, and whether they are inside or outside
  the team.
- 2-of-3 or 3-of-3.
- The legal-order policy.

## Duplicate detection vs. recovery

"One human, one account" has a sharp edge. Someone who loses every passkey
(D8) and creates a new account would hit "Final: duplicate account" at L1 and
be locked out of `verified_human` for good. Their funds are a separate matter:
under D8 round 1 they are lost, and split-key recovery is next.

Options:

- **"This face matches an existing account → recover it."** This ties into
  split-key recovery. A face match must never be enough on its own to open a
  wallet: liveness can be spoofed. At most it can be one factor alongside the
  split-key pieces.
- **"Move my verification to this account."** The old account loses
  `verified_human` and the new one gets it. The stakes are lower: a spoofed
  face could move a claim, not money.

Either way, finding the old account needs the applicant link, which is under
controlled access. That's part of the joint design.

**Decide:** with the passkey team, as part of split-key recovery.

## What each component can see

| Component | Sees | Never sees |
|---|---|---|
| User's device + Sumsub widget | Everything the user enters or uploads | — |
| Sumsub | Documents, name, date of birth, face, the random applicant ID | Wallet, balances, which apps the user logs into |
| Login KYC service | Level and result (stored). The applicant link and request IP addresses (only during a verification session) | Documents, date of birth, face, wallet or deposit addresses |
| Login account service (passkey design, D6) | User ID, email, passkey public keys and flags, ciphertext | PRF output, root secret, Railgun address, balances |
| Login OIDC provider | Level, plus name and email at the moment of a consented login | Documents, wallet |
| An app | Per-app user ID, `verified_human`, and anything the user approved for it | Everything else |

**Known gap:** anyone with access to Sumsub's dashboard, or anyone holding
Login's Sumsub API secret, can view documents. "Login doesn't see your
details" therefore also depends on locking down dashboard roles and
protecting the secret, not only on our code.

## Testing

- Sumsub sandbox only.
- **No real faces or documents.** Drive outcomes with the sandbox's simulated
  review results. A real face is used only for the recorded demo, with that
  person's agreement.

## Build order (after team sign-off)

1. **Sumsub sandbox:** create the L1–L3 levels in the dashboard (a team
   member does this).
2. **KYC service:**
   - start a verification (applicant + widget token)
   - receive webhooks and verify their signatures
   - store level, result and applicant ID
3. **Verify screens:** the Sumsub widget plus every UX state above.
4. **Login integration:** pass the level to the OIDC provider, using the
   interface agreed with whoever builds it.

These steps need team approval before any code is written:
- adding the Sumsub WebSDK
- writing the signed Sumsub API client
- sending users to Sumsub, a third party
- storing identity data on Login's servers
- any key storage or cryptography for escrow or profile data
- the extra Sumsub domains the WebSDK loads from. Only `api.sumsub.com` is
  allowed in the sandbox firewall today, and each new domain must be listed
  and approved
- a tunnel domain for webhooks, if we don't poll in local development

**Stack:** TypeScript and Node, matching the passkey work.
