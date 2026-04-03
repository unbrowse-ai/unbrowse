import { NextResponse } from "next/server";
import {
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_MCP,
  INSTALL_CMD_SKILL,
  MCP_CONFIG_JSON,
  MCP_CONFIG_PATH,
  UPGRADE_CMD_GENERIC,
  UPGRADE_CMD_MCP,
} from "@/lib/install-command";

const SKILL_MD = `---
name: unbrowse
description: Analyze any website's network traffic and turn it into reusable API skills backed by a shared marketplace. Skills discovered by any agent are published, scored, and reusable by all agents.
install: ${INSTALL_CMD_GENERIC}
homepage: https://www.unbrowse.ai
repository: https://github.com/unbrowse-ai/unbrowse
---

# Unbrowse

Public companion docs: https://docs.unbrowse.ai

Repo docs:
- README and SKILL.md in: https://github.com/unbrowse-ai/unbrowse

## What ships today

Unbrowse is a local-first CLI and server for turning websites into reusable API skills.

Current product path:

1. local CLI talks to the local server on \`http://localhost:6969\`
2. resolve checks route cache, domain cache, local snapshots, and marketplace-backed search
3. if needed, it falls through to first-pass browser action or live capture
4. discovered routes become reusable skills for later runs

## Install

\`\`\`bash
${INSTALL_CMD_GENERIC}
\`\`\`

This path handles the full first-use flow: ToS acceptance, agent registration + API key caching, and wallet detection when present. If a wallet is configured, that address becomes the contributor/payment truth: it is synced onto your agent profile, used for contributor payouts when your routes earn, and used as the spending wallet for paid marketplace routes.

Optional after install, if your host supports skills:

\`\`\`bash
${INSTALL_CMD_SKILL}
\`\`\`

For generic MCP hosts:

\`\`\`bash
${INSTALL_CMD_MCP}
\`\`\`

That path writes a ready-to-import config to \`${MCP_CONFIG_PATH}\`.

Generic MCP template:

\`\`\`json
${MCP_CONFIG_JSON}
\`\`\`

Upgrade an existing install in place:

\`\`\`bash
${UPGRADE_CMD_GENERIC}
${UPGRADE_CMD_MCP}
\`\`\`

## First-run behavior

- \`setup\` verifies the bundled Kuri runtime
- installs or updates the Open Code \`/unbrowse\` command when Open Code is detected
- starts the local server unless \`--no-start\` is passed
- first registration prompts for ToS acceptance
- interactive runs also offer an email-style agent identity

Headless runs can preseed:

\`\`\`bash
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/unbrowse
cd ~/unbrowse && ./setup --host off --accept-tos --agent-email agent@example.com --skip-wallet-setup --non-interactive
\`\`\`

## Core commands

\`\`\`bash
unbrowse health --pretty
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse search --intent "get stock prices" --domain "finance.yahoo.com" --pretty
unbrowse login --url "https://calendar.google.com"
unbrowse skills --pretty
\`\`\`

When you already know the target endpoint:

\`\`\`bash
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --pretty
\`\`\`

Useful execute helpers:

- \`--schema\`
- \`--path "data.items[]"\`
- \`--extract "name,url,alias:deep.path"\`
- \`--limit N\`

## Publish/review loop

Current CLI also supports the review/publish flow:

\`\`\`bash
unbrowse review --skill <skill_id> --endpoints '[{"endpoint_id":"...","description":"..."}]'
unbrowse publish --skill <skill_id> --pretty
\`\`\`

## Auth and mutations

- use \`unbrowse login --url "..."\` for interactive auth
- use \`--dry-run\` before unsafe endpoints
- only pass mutation confirmation after explicit user approval

\`\`\`bash
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --dry-run
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --confirm-unsafe
\`\`\`

## Primary HTTP routes

| Method | Route | Purpose |
| --- | --- | --- |
| \`GET\` | \`/health\` | Local server health |
| \`POST\` | \`/v1/intent/resolve\` | Canonical resolve/search/capture entrypoint |
| \`POST\` | \`/v1/skills/:id/execute\` | Execute one endpoint |
| \`GET\` | \`/v1/skills\` | List skills |
| \`POST\` | \`/v1/auth/login\` | Interactive login |
| \`POST\` | \`/v1/auth/steal\` | Import cookies from browser/Electron storage |
| \`POST\` | \`/v1/search\` | Global marketplace search |
| \`POST\` | \`/v1/search/domain\` | Domain-scoped search |
| \`POST\` | \`/v1/feedback\` | Submit outcome/rating |
| \`GET\` | \`/v1/stats/summary\` | Marketplace summary |

## Rules

1. Prefer the CLI over raw \`curl\`.
2. Start with \`resolve\` unless you already know the exact endpoint.
3. If a result looks wrong, inspect \`available_endpoints\` and retry with a specific endpoint id.
4. Use \`--schema\`, \`--path\`, and \`--extract\` instead of piping into \`jq\`.
5. If a site returns \`auth_required\`, run \`login\` and retry.
6. Use https://docs.unbrowse.ai for the public companion docs. Treat this file and the repo as the agent/product-truth contract.
`;

export async function GET() {
  return new NextResponse(SKILL_MD, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Robots-Tag": "noindex",
    },
  });
}
