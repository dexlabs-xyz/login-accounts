#!/bin/bash
# Default-deny outbound firewall for the Login accounts sandbox.
# Based on Anthropic's reference script (github.com/anthropics/claude-code/.devcontainer).
#
# Everything is blocked except GitHub and the domains listed below.
# To allow a new service: add its domain to the right list, then rebuild the
# container (VS Code: "Dev Containers: Rebuild Container").
set -euo pipefail
IFS=$'\n\t'

# --- Domains the sandbox may reach -----------------------------------------
# Required: the container fails to start if any of these can't be resolved.
REQUIRED_DOMAINS=(
  "registry.npmjs.org"            # npm packages
  "api.anthropic.com"             # Claude Code
  "api.openai.com"                # Codex
  "marketplace.visualstudio.com"  # VS Code extensions
  "vscode.blob.core.windows.net"
  "update.code.visualstudio.com"
)

# Optional: logins, telemetry, and Login's own services. A domain that doesn't
# resolve only prints a warning. Check these against each provider's docs and
# add any other domain your code calls.
OPTIONAL_DOMAINS=(
  "claude.ai"                     # Claude Code sign-in
  "console.anthropic.com"
  "statsig.anthropic.com"
  "sentry.io"
  "statsig.com"
  "auth.openai.com"               # Codex "Sign in with ChatGPT"
  "chatgpt.com"
  "rpc.testnet.near.org"          # NEAR testnet RPC
  "rpc.testnet.fastnear.com"
  "1click.chaindefuser.com"       # NEAR Intents
  "solver-relay-v2.chaindefuser.com"
  "bridge.chaindefuser.com"
  "api.sumsub.com"                # Sumsub KYC (use sandbox mode only)
)
# ----------------------------------------------------------------------------

# Keep Docker's internal DNS working.
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
iptables -t mangle -F; iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

if [ -n "$DOCKER_DNS_RULES" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# DNS and localhost.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

ipset create allowed-domains hash:net

# GitHub publishes its IP ranges; allow all of them.
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -fsS https://api.github.com/meta)
echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null \
  || { echo "ERROR: unexpected GitHub meta response"; exit 1; }
while read -r cidr; do
  [[ "$cidr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] \
    || { echo "ERROR: bad CIDR from GitHub: $cidr"; exit 1; }
  ipset add allowed-domains "$cidr" -exist
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

add_domain() {
  local domain="$1" required="$2" ips
  ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
  if [ -z "$ips" ]; then
    if [ "$required" = "yes" ]; then
      echo "ERROR: could not resolve required domain $domain"; exit 1
    fi
    echo "WARNING: could not resolve $domain (skipped)"; return 0
  fi
  while read -r ip; do
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || continue
    ipset add allowed-domains "$ip" -exist
  done <<< "$ips"
  echo "Allowed $domain"
}

for d in "${REQUIRED_DOMAINS[@]}"; do add_domain "$d" yes; done
for d in "${OPTIONAL_DOMAINS[@]}"; do add_domain "$d" no; done

# Allow the host network (VS Code talks to the container through it).
HOST_IP=$(ip route | awk '/default/ {print $3; exit}')
[ -n "$HOST_IP" ] || { echo "ERROR: could not detect host IP"; exit 1; }
HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
iptables -A INPUT  -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Default deny; allow replies and the allowlist only.
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Self-test: a random site must be blocked, GitHub must work.
if curl --connect-timeout 5 -s https://example.com >/dev/null 2>&1; then
  echo "ERROR: firewall check failed, example.com is reachable"; exit 1
fi
curl --connect-timeout 5 -s https://api.github.com/zen >/dev/null \
  || { echo "ERROR: firewall check failed, GitHub unreachable"; exit 1; }
echo "Firewall active: only allowlisted services are reachable."
