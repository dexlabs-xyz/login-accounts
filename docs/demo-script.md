# Demo script (about 4 minutes)

**Before the demo (the day before):** Railgun's privacy check takes about an
hour, sometimes longer, before new funds can be spent. So prepare two accounts
a day ahead:

- **Alice** (presenter): claimed test funds; one Ethereum deposit done (some
  USDC and ETH); everything shows **Spendable**.
- **Bob** (second browser or phone): signed up; claimed test funds.
- Have Rabby (or any wallet) on Sepolia with a little USDC and ETH.
- Open https://demo.withlogin.com in both, signed out.

## 1. Sign up with a passkey (45 s)

- New browser profile → demo.withlogin.com → email → 6-digit code → create
  passkey (Touch ID / Face ID).
- Say: *no password, no seed phrase. The passkey unlocks a wallet secret that
  only exists on this device; Login's server can't open it.*
- Show the private `0zk…` address appear.

## 2. One-click test funds (20 s)

- Press **Get 1000 test USDT** → "Sending your test funds privately…" → Sent.
- Say: *no faucets. It arrives privately and clears Railgun's privacy check.*

## 3. Add money from any wallet (60 s), as Alice

- **Add money → From an Ethereum wallet** → one address.
- Point at the mainnet line: *"On mainnet today, NEAR Intents swaps 100 USDC
  into 99.80 USDT…": that's official NEAR Intents, live.*
- From Rabby, send 1 USDC and 0.003 ETH to the address.
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

## 5. Withdraw (30 s), as Alice

- **Withdraw** → a fresh Rabby address → 10 USDT → Review: Railgun's 0.25%
  fee, the exact amount arriving, and the "This part is public" warning →
  passkey → arrives in Rabby.

## 6. Continue with Login (30 s)

- Open the demo app → **Continue with Login** → passkey → consent ("this app
  receives an ID unique to it and your human-verification status") → signed
  in. Optional: show "Verified human: Yes" for an account that passed KYC
  (sandbox).

## Close (15 s)

*One passkey account: sign in anywhere, hold and move money privately across
chains, built on NEAR Intents. Everything shown is testnet; the testnet-only
shortcuts are labelled in the README.*
