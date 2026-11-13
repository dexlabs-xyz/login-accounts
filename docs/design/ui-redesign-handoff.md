# UI redesign: handoff (11 Nov 2026)

For whoever implements the Figma screens (a separate Claude session working
alongside the main one). The feature freeze started 11 Nov: the redesign
changes **how things look and move**, not what they do or say about safety.

## Where the UI lives

- `apps/web/src/App.tsx`: sign-up/sign-in (Welcome, email code), the signed-in pages, private balance.
- `apps/web/src/home/`: the signed-in frame (sidebar, divider, pages in the URL hash: `#notifications`,
  `#verification`, `#settings`; Home has none), the Balance History chart, the Copy address button.
- `apps/web/src/ui/`: `toast.tsx` (Sonner), `Modal.tsx` (the Send/Receive pop-ups, a `<dialog>`), `motion.ts`.
- `apps/web/src/deposits/AddMoney.tsx`: "Add money" (Ethereum wallet, Solana).
- `apps/web/src/send/SendPrivately.tsx`: "Send privately" and "Withdraw".
- `apps/web/src/TestFunds.tsx`, `Kyc.tsx` (Verification, KYC team's), `ConnectedApps.tsx`,
  `History.tsx` (added 11 Nov: deposits, sends and withdrawals, from Railgun's own history).
- `apps/web/src/styles.css`: all styling. Colour tokens and dark mode live here.
- The consent screen for other apps is server-rendered HTML in
  `apps/server/src/oidc/provider.ts` (the `page(...)` calls).
  Restyled 13 Nov (Gold): `PAGE_CSS` (inline, Geist from /fonts, follows the device's dark/light), a
  heart-handshake icon, "<App> would like you to sign in with Login", a box of what the app sees. CSP adds
  `font-src 'self'` only. The page must never contain the email or a KYC level (routes.test.ts).

## Don't touch

- Anything under `apps/web/src/railgun/` (the wallet worker, sends, deposit
  records) and `apps/web/src/deposits/flow.ts`, `tidepool.ts`, `plan.ts`.
  They hold keys and money logic and were tested live.
- `apps/server/` beyond styling the consent page, `AGENTS.md`, `.internal/`.
- New dependencies: ask Gold first. Approved 12 Nov and pinned: `motion` 14.7.1 (motion.dev, MIT, the free
  version only: no paid Motion+ code in this public repo), `sonner` 2.0.8 (toasts, MIT) and `uqr` 0.1.3 (QR
  codes, MIT, no dependencies). Approved 13 Nov: `skullet` 0.0.3 (loading skeletons, MIT, no dependencies;
  used without `id`, so it stores nothing). Never add crypto or auth packages.
- The Sumsub SDK must keep loading only after the user presses Continue (Kyc.tsx).

## Keep (tests and trust depend on them)

The browser tests (`e2e/`) find things by **role + name, label, test id and
text**. Restyle and move things freely, but keep these exactly, or update the
test in the same change and say so:

- **Test ids:** `private-empty`, `balance-Spendable-usdt` (pattern
  `balance-<Bucket>-<token>`), `fee-reserve-ready` / `fee-reserve-pending` /
  `fee-reserve-empty` (`private-empty` and `fee-reserve-empty` are screen-reader-only text now: Gold removed
  them from view), `testfunds-status` and `testfunds-privacy` (on the Test USDT toasts), `tidepool-deposit-address`,
  `active-deposit-status`, `mainnet-price`, `unshield-status`,
  `withdraw-receives`, `withdraw-swap-receives`, `withdraw-receive-as`,
  `withdraw-linked-warning`, `human-status`, `connected-apps`, `history`.
- **Regions (a `section` with an `h2` via `aria-labelledby`):** Private balance (Home),
  Notifications (Home's card and the Notifications page; was History), Verification (Verification page).
  Pop-ups are `role="dialog"` named **Send** / **Receive** (no × button: Esc or the backdrop closes them).
  Receive: Solana / Ethereum Sepolia rows; Select token, Enter amount, Refund address, Get Deposit Address.
  Send: Privately via Railgun / To an Ethereum address / To a Solana address; fields 0zk address or Address,
  Select token (`withdraw-receive-as`), Enter amount; Review → Confirm with passkey; Sent → Withdraw/Send again.
  Each Send form stays mounted while you step around: scope to `[data-send-mode="private|evm|sol"]`.
  Errors are Sonner toasts (`[data-sonner-toast][data-type="error"]`), plus `aria-invalid` on the field.
  Gold, 12 Nov: **all** feedback, warnings, errors and status are toasts, never lines on the page (they moved the
  layout). That includes "You could lose access to your money" (sticky while it's true), the sign-in-only passkey choice
  (a toast with Keep for signing in / Remove it), a stalled sync (toast with Retry sync), sign-up errors and KYC errors.
  Use `useToastWhile(text, options)` from `ui/toast.tsx`. e2e helpers: `errorToast`, `toastWith(page, text)`.
- **Marks on coloured fills** (text on the blue buttons, the email field's green tick and red cross): black in dark
  mode, white in light, via `--on-accent` (Gold, 13 Nov). The tick and cross are inline SVG (`StatusIcon` in App.tsx) for this.
  Content that belongs to a screen stays on it: Syncing % next to the balance, Send/Receive steps and their review
  warnings, the verification stages, the broken sign-in link page.
  Unfinished deposits sit at the top of Notifications (`li[data-kind="pending"]`, Resume / Finish). Since 13 Nov:
  sends and withdrawals running in this tab are listed there too ("Sending … / Withdrawing …", **View** reopens the
  Send pop-up on its processing screen; `send/jobs.ts`, memory only), deposits being processed get **View** (reopens
  Receive), and anything finished shows "Successful" (`data-done`) until the history row with the same tx appears.
  Locked wallet (Gold, 13 Nov): every page keeps its layout; a pop-up `role="dialog"` named **Your wallet is locked**
  opens by itself, with one **Unlock** button (spinner while waiting, then a ring and a check that draw themselves).
  It can be closed (Esc); Home's buttons and Settings › Status › **Unlock** open it again. e2e: `unlockWallet`,
  `dismissUnlock`. "Unlock with passkey" is gone; "Set up wallet on this device" stays for a device with no wallet.
  Theme follows the device until Settings › Theme (radios **Light** / **Dark**) is used.
  Test USDT is a button on Home. e2e helpers: `goTo`, `openSheet`, `closeSheet`, `chooseSend`, `errorToast`,
  `spendableUsdt`.
- **Headings:** "Welcome" (was "Sign up or sign in"), "Home" (screen-reader only; was "Your account"),
  "Check your email" (code step), "Notifications", "Verification", "Settings" (Gold's Figma 451:7683: rows Profile
  picture, Email, each passkey, Backup your passkey, Account; then Wallet, Apps you’ve signed into, About), "Confirm it’s you",
  "Sign in to continue", "This sign-in link doesn’t work", "Sign-in did not complete".
- **Buttons/links (exact names):** Continue, Sign in with passkey, Go back, Resend code, Test USDT, Send, Receive,
  Copy address (the email code is sent on the sixth digit: there's no Verify button any more),
  Unlock with passkey, Sign out, Copy private address, Github,
  (Gold, 12 Nov: Settings has no Lock, Other options or Confirm a test send any more; the tests lock by reloading the page,
  and "Wallet check" is screen-reader-only text), Add your phone, Add a security key,
  Connect, Remove, Remove it, Keep for signing in, Retry sync,
  Review, Back, Confirm with passkey, Withdraw again, Get deposit address,
  From an Ethereum wallet, From Solana, Verify (a row per level on Verification, 13 Nov; was "Verify you’re human…";
  it opens a pop-up "Verify you’re human" / "Verify your identity" with Not now / Continue, then Sumsub inside it),
  Allow and continue, Cancel and go back to the app, View on Sepolia Etherscan.
- **Labels:** Email, 6-digit code, Amount (USDT), Amount, Send from,
  "To (private 0zk address)", "To (public 0x address on Ethereum Sepolia)",
  "To (…" for withdraw, "Your Solana address…".
- **Status text the tests read:** "Sent …", "Done. …", "Withdrew …",
  "Done: about …", "Not verified", "Waiting for privacy check" and the other
  balance labels, the error messages in `SendPrivately.tsx` and `AddMoney.tsx`.
- **Trust labels that must stay visible:** "Testnet" (on the Send/Receive forms), "Sandbox (test mode)",
  "Unaudited", the public-address warnings on Withdraw and Add money,
  the Test USDT privacy toast,
  (Gold, 12 Nov: disclosures are well timed, not repeated; "Testnet build. Never use real funds." and the
  claim note under each History row and History's "Only you see this…" note were removed on purpose)
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
