# Login accounts sandbox

Everyone codes inside this container: Gold with Claude Code, teammates with Codex.
Only this repo folder is visible inside it, and a firewall blocks every website
except GitHub, npm, the two AI providers, VS Code, NEAR testnet, NEAR Intents
and Sumsub.

## One-time setup (each person)

1. Install **Docker Desktop** and the VS Code **Dev Containers** extension.
2. In your **own** VS Code settings (Cmd/Ctrl+Shift+P → "Preferences: Open User
   Settings (JSON)"), add this line so VS Code doesn't hand your personal GitHub
   login to the container:

   ```json
   "dev.containers.gitCredentialHelperConfigLocation": "none"
   ```

3. Create a GitHub **fine-grained personal access token**
   (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Resource owner: **dexlabs-xyz**
   - Repository access: **only login-accounts**
   - Permissions: Contents → Read and write; Pull requests → Read and write
   - Expiration: 90 days
4. Open the repo in VS Code and click **Reopen in Container**. The first build
   takes a few minutes. Wait until the terminal says
   "Firewall active: only allowlisted services are reachable."

## Inside the container (first time)

Connect GitHub:

```bash
gh auth login --with-token     # paste your token, press Enter, then Ctrl+D
gh auth setup-git
```

Then sign in to your agent:

- **Claude Code (Gold):** open the Claude Code panel in VS Code, or run `claude`
  in the terminal, and follow the sign-in steps.
- **Codex (teammates):** open the Codex panel in VS Code, or run `codex` in the
  terminal, and choose "Sign in with ChatGPT".

Logins are remembered across restarts and rebuilds.

## Agent settings

- **Claude Code:** keep the default mode, where it asks before running commands
  and editing files. Don't use `--dangerously-skip-permissions`.
- **Codex:** keep approvals on (`on-request`). Codex's own extra sandbox may not
  work inside Docker; if it errors, it's acceptable here to start Codex with
  `codex --sandbox danger-full-access --ask-for-approval on-request`, because
  this container is the sandbox. **Never** use that mode outside this container.

## When something is blocked

If an install or API call fails with a connection error, the domain probably
isn't on the allowlist. Add it to `init-firewall.sh` (in `OPTIONAL_DOMAINS`),
commit the change so everyone gets it, and run
"Dev Containers: Rebuild Container". Only add domains you recognise.

## Rules

See `AGENTS.md`. In short: testnet only, no real keys or seed phrases anywhere
near this container, secrets only in `.env`, Sumsub sandbox only, and a teammate
reviews every pull request before it merges.
