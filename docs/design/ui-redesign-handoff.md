# UI redesign: handoff (11 Nov 2026)

For whoever implements the Figma screens (a separate Claude session working
alongside the main one). The feature freeze started 11 Nov: the redesign
changes **how things look and move**, not what they do or say about safety.

## Where the UI lives

- `apps/web/src/App.tsx`: shell, sign-up/sign-in, account page, private balance card.
- `apps/web/src/deposits/AddMoney.tsx`: "Add money" (Ethereum wallet, Solana).
- `apps/web/src/send/SendPrivately.tsx`: "Send privately" and "Withdraw".
- `apps/web/src/TestFunds.tsx`, `Kyc.tsx` (Verification, KYC team's), `ConnectedApps.tsx`,
  `History.tsx` (added 11 Nov: deposits, sends and withdrawals, from Railgun's own history).
- `apps/web/src/styles.css`: all styling. Colour tokens and dark mode live here.
- The consent screen for other apps is server-rendered HTML in
  `apps/server/src/oidc/provider.ts` (the `page(...)` calls).

## Don't touch

- Anything under `apps/web/src/railgun/` (the wallet worker, sends, deposit
  records) and `apps/web/src/deposits/flow.ts`, `tidepool.ts`, `plan.ts`.
  They hold keys and money logic and were tested live.
- `apps/server/` beyond styling the consent page, `AGENTS.md`, `.internal/`.
- New dependencies: ask Gold first (animation libraries included; CSS
  transitions and the Web Animations API need none). Never add crypto or auth packages.
- The Sumsub SDK must keep loading only after the user presses Continue (Kyc.tsx).

## Keep (tests and trust depend on them)

The browser tests (`e2e/`) find things by **role + name, label, test id and
text**. Restyle and move things freely, but keep these exactly, or update the
test in the same change and say so:

- **Test ids:** `private-empty`, `balance-Spendable-usdt` (pattern
  `balance-<Bucket>-<token>`), `fee-reserve-ready` / `fee-reserve-pending` /
  `fee-reserve-empty`, `testfunds-status`, `tidepool-deposit-address`,
  `active-deposit-status`, `mainnet-price`, `unshield-status`,
  `withdraw-receives`, `withdraw-swap-receives`, `withdraw-receive-as`,
  `withdraw-linked-warning`, `human-status`, `connected-apps`, `history`.
- **Regions (a `section` with an `h2` via `aria-labelledby`):** Private balance,
  Add money, Test funds, Send privately, Withdraw, Verification, History.
- **Headings:** "Sign up or sign in", "Your account", "Confirm it’s you",
  "Sign in to continue", "This sign-in link doesn’t work", "Sign-in did not complete".
- **Buttons/links (exact names):** Continue, Verify, Sign in with passkey,
  Unlock with passkey, Lock, Sign out, Add your phone, Add a security key,
  Other options, Connect, Remove, Remove it, Keep for signing in, Retry sync,
  Review, Back, Confirm with passkey, Withdraw again, Get deposit address,
  From an Ethereum wallet, From Solana, "Get 250 test USDT…", "Verify you’re human…",
  Allow and continue, Cancel and go back to the app, View on Sepolia Etherscan.
- **Labels:** Email, 6-digit code, Amount (USDT), Amount, Send from,
  "To (private 0zk address)", "To (public 0x address on Ethereum Sepolia)",
  "To (…" for withdraw, "Your Solana address…".
- **Status text the tests read:** "Sent …", "Done. …", "Withdrew …",
  "Done: about …", "Not verified", "Waiting for privacy check" and the other
  balance labels, the error messages in `SendPrivately.tsx` and `AddMoney.tsx`.
- **Trust labels that must stay visible:** "Testnet", "Sandbox (test mode)",
  "Unaudited", the public-address warnings on Withdraw and Add money,
  History's "Only you see this…" note,
  "Tidepool sees the address…", "No app sees your email…". These are honesty
  commitments, not decoration.
- Accessibility: keep `role="status"` / `role="alert"` on live messages, real
  `<button>`s and `<label>`s, visible focus, and `prefers-reduced-motion`
  (turn animations off when it's set).

## Check your work

- `npm run typecheck` and `npm test` (unit tests, ~1 minute).
- Browser tests without real money (a few minutes):
  `npx playwright test e2e/passkeys.spec.ts e2e/oidc.spec.ts e2e/kyc-leak.spec.ts e2e/two-accounts.spec.ts e2e/railgun.spec.ts`.
- The live Sepolia tests (`deposit`, `send`, `withdraw`, `withdraw-swap`,
  `testfunds`) take hours and spend testnet funds: leave them to the main session.
- Playwright starts its own servers on ports 5180/5190 and can't run twice at
  once: check with the main session before running it.

## Known limits (don't "fix" these in the UI)

- After a send or withdrawal, the leftover stays "Waiting for privacy check"
  on Sepolia (bug-change-stuck, parked). Each deposit pays for one transaction.
- Swaps go through Tidepool, a NEAR Intents **testnet**. ETH is capped at 0.006 per swap.
