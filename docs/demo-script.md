# Demo script (about 4 minutes)

**Before the demo (the day before):** Railgun's privacy check can take up to
about two hours before new funds can be spent. And on Sepolia, **each deposit
pays for one transaction** (the leftover after a send or withdrawal doesn't
clear; see the README's known limit). So prepare two accounts a day ahead:

- **Alice** (presenter) makes 3 transactions below (one send, two
  withdrawals), so she needs **3 separate deposits**: the test-funds claim
  plus **two** Ethereum deposits, each with about 0.003 ETH in it (the ETH
  refills the hidden fee reserve that every transaction needs). She's ready
  when Home shows only the balance: no "in privacy check" or "Network fees:
  being set up" line under it.
- **Bob** (second browser or phone): signed up; claimed test funds. He only
  receives, so one deposit is enough.
- **Don't rehearse with Alice's account**: every practice send or withdrawal
  uses up one of her deposits. Rehearse on a spare account.
- Have Rabby (or any wallet) on Sepolia with a little USDC and ETH.
- Open https://demo.withlogin.com in both, signed out.

## 1. Sign up with a passkey (45 s)

- New browser profile → demo.withlogin.com → email → 6-digit code → create
  passkey (Touch ID / Face ID).
- Say: *no password, no seed phrase. The passkey unlocks a wallet secret that
  only exists on this device; Login's server can't open it.*
- Show the private `0zk…` address appear.

## 2. One-click test funds (20 s)

- Press **Get 250 test USDT** → "Sending your test funds…" → Sent.
- Say: *no faucets. It arrives privately and clears Railgun's privacy check.*

## 3. Add money from any wallet (60 s), as Alice

- **Add money → From an Ethereum wallet** → one address.
- Point at the mainnet line: *"On mainnet today, NEAR Intents swaps 100 USDC
  into 99.80 USDT…": that's official NEAR Intents, live.*
- From Rabby, send 1 USDC and 0.003 ETH to the address. (This new money
  won't be spendable during the demo; sections 4 and 5 use the deposits
  prepared the day before.)
- Watch: "Swapping your USDC into USDT…" → "Swapping your ETH into USDT…" →
  "Moving it into your private balance…" → Done.
- Say: *any supported token, one currency on screen. The swaps run through NEAR
  Intents (Tidepool's testnet).*

## 4. Send privately (60 s), Alice → Bob

- Copy Bob's `0zk…` address → **Send privately** → 25 USDT → Review: the fee
  shows in USDT → **Confirm with passkey**.
- Proof progress → "Sent". Open the Etherscan link: *it shows only that a
  private transaction happened: no amount, no sender, no recipient.*
- On Bob's screen: 25 USDT arriving.

## 5. Withdraw (60 s), as Alice

- First wait until Alice's balance shows the send from section 4 (the
  numbers change). Going too fast shows "Your last transaction is still being
  confirmed…": just wait a minute and press Review again.
- **Withdraw** → a fresh Rabby address → 10 USDT → Review: Railgun's 0.25%
  fee, the exact amount arriving, and the "This part is public" warning →
  passkey → arrives in Rabby.
- Then, through NEAR Intents: **Receive as → USDC on Base Sepolia** (only
  use Solana devnet if its live test has passed) → 5 USDT → Review shows
  about how much USDC arrives →
  passkey → "Done". Say: *withdraw as any token, on any chain; if the swap
  fails, the money comes back to your private balance.* (ETH is capped at
  0.006 ETH per swap on Tidepool, about 12 USDT.)

## 6. Continue with Login (30 s)

- Open the demo app → **Continue with Login** → passkey → consent. It says
  exactly what this app will see: *"an ID that only this app gets, and that
  you're a verified human (test mode)"* (or that it won't see it, if you
  haven't verified) → signed in. Optional: show "Verified human: Yes" for an
  account that passed KYC (sandbox; "Skip the face check" works for demos).
- Back on Login's account page: **Apps you've signed in to** lists the app
  and what it sees. *No app ever gets your email.*

- Scroll to **History**: the deposits (the test-funds claim labelled as
  such), the private send and both withdrawals, each with its status. *Only
  Alice sees this: it's worked out in her browser from her own wallet.*

## Close (15 s)

*One passkey account: sign in anywhere, hold and move money privately across
chains, built on NEAR Intents. Everything shown is testnet; the testnet-only
shortcuts are labelled in the README.*
