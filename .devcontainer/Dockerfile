# Login accounts — shared dev sandbox for Claude Code (Gold) and Codex (teammates).
# Based on Anthropic's reference dev container, trimmed and extended for Codex.
FROM node:22

ARG TZ=Africa/Lagos
ENV TZ="$TZ"

# Basic tools plus what the firewall needs (iptables, ipset, dig, aggregate).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git less procps sudo jq nano unzip gnupg2 \
    iptables ipset iproute2 dnsutils aggregate curl ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI (used to log in to GitHub with a repo-limited token).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install both AI agents as root at build time, so they can't modify
# their own installation while running.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Chromium for the passkey browser tests (Chrome's virtual authenticator),
# downloaded at build time so the runtime firewall needs no extra domains.
# Keep the version in step with @playwright/test in package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.64.1 install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/*

# Folders for each agent's login/config, owned by the normal user.
# Docker volumes mounted here keep logins across rebuilds.
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R node:node /workspace /home/node/.claude /home/node/.codex /commandhistory

# Firewall script. The normal user may run THIS script with sudo and nothing else.
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh \
  && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall \
  && chmod 0440 /etc/sudoers.d/node-firewall

ENV DEVCONTAINER=true
WORKDIR /workspace
USER node
