# Rules for AI agents working in this repo

These rules apply to every AI coding agent (Codex reads this file; Claude Code
reads it through CLAUDE.md). They are not optional.

## Project
Login accounts: one passkey account to log in anywhere and move money privately
across chains via NEAR Intents. Built for the NEAR hackathon (Nov 1–14, 2026).
The repository is public.

## Security rules
- **Testnet only.** Never write code that targets NEAR mainnet or any mainnet
  chain, and never use real funds.
- **Never read, print, log, or copy the contents of `.env` files**, private keys,
  seed phrases, or tokens. Reference them only by variable name
  (e.g. `process.env.SUMSUB_APP_TOKEN`).
- **Never hard-code secrets** in source files, tests, or examples. New secrets go
  in `.env.example` as empty placeholders, and real values in `.env`.
- **KYC:** use Sumsub sandbox mode only. Never store identity documents or raw
  KYC data; store only the verification result and the provider's reference ID.
- **No homemade cryptography.** Use established libraries (e.g. SimpleWebAuthn
  for passkeys, official NEAR / NEAR Intents SDKs). Ask before adding any new
  crypto or auth dependency.
- **Dependencies:** prefer well-known, maintained packages. Say what a new
  package is and why before installing it.
- **Network:** this sandbox blocks unknown websites on purpose. If something
  fails because a domain is blocked, stop and ask; do not try to work around it.
- **Git:** never force-push, never push directly to `main`, never change
  repository settings.
