import { NextResponse } from "next/server";
import {
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_MCP,
  INSTALL_CMD_NPM,
  INSTALL_CMD_OPENCLAW,
} from "@/lib/install-command";
import { makeAttribution, injectAttribution } from "@/lib/llms-attribution";

export async function GET() {
  const requestId = crypto.randomUUID();
  const b64 = makeAttribution(requestId, "llms-txt");

  const installOpenClaw = injectAttribution(INSTALL_CMD_OPENCLAW, b64);
  const installGeneric = injectAttribution(INSTALL_CMD_GENERIC, b64);
  const installMcp = injectAttribution(INSTALL_CMD_MCP, b64);
  const installNpm = injectAttribution(INSTALL_CMD_NPM, b64);

  const body = `# Unbrowse

> Unbrowse gives AI agents reusable API routes for websites. A first explicit browsing session can teach a route; later agents resolve and execute that route directly with local credentials, cutting repeated browser work from seconds to sub-second responses.

## Getting Started

- [Native Browser Install (Recommended)](https://www.unbrowse.ai/install): Run \`${installOpenClaw}\` to make Unbrowse the default browser — every page.goto() routes through Unbrowse automatically, no code changes needed
- [CLI Install](https://www.unbrowse.ai/install): Install with \`${installGeneric}\`, resolve your first intent, and set up Crossmint lobster.cash during bootstrap if you want mined-route payouts
- [MCP Install](https://www.unbrowse.ai/mcp.json): For generic MCP hosts, run \`${installMcp}\`, then import the generated config or use this template
- [Public Docs](https://docs.unbrowse.ai): Public explainer and whitepaper companion docs
- [npm Package](https://www.npmjs.com/package/unbrowse): Install globally with \`${installNpm}\`
- [Discord Community](https://discord.gg/VWugEeFNsG): Support, release updates, and discussion

## Documentation

- [SDK Quickstart](https://www.unbrowse.ai/docs): Three-step quickstart — install \`@unbrowse/client\`, mint an API key on /login, resolve and execute against the live worker
- [Skill Registry / Marketplace](https://www.unbrowse.ai/search): Search discovered API skills by intent or domain
- [Dashboard](https://www.unbrowse.ai/dashboard): View signed-in CLI/account economics, or public contributor earnings, spending, savings, and rank by wallet address
- [Contribution Leaderboard](https://www.unbrowse.ai/leaderboard): Public all-time ranking by earnings, executions, and discovered skills
- [Privacy Policy](https://www.unbrowse.ai/privacy): What data is shared to the marketplace vs kept local
- [Terms of Service](https://www.unbrowse.ai/terms): Usage terms for Unbrowse and the skill registry

## Paper

- [Internal APIs Are All You Need (arXiv:2604.00694)](https://arxiv.org/abs/2604.00694): Whitepaper by Tham, Garcia & Hahn (2026) -- describes the three-path execution architecture, shared route graph, x402 micropayment protocol, and benchmark methodology

## API Reference

- [SDK / Local API](https://www.unbrowse.ai/docs): \`@unbrowse/client\` calls \`beta-api.unbrowse.ai\` directly -- resolve intents, execute endpoints, manage auth, search marketplace
- [Marketplace API](https://beta-api.unbrowse.ai): Cloudflare Worker backend -- skill storage, semantic vector search, agent registration, endpoint graph, transaction ledger
- POST \`/v1/intent/resolve\`: Natural-language intent resolution -- searches cache, marketplace, and live capture
- GET \`/v1/skills\`: List all marketplace skills with metadata and scoring
- POST \`/v1/search\`: Semantic search for skills by intent
- POST \`/v1/search/domain\`: Search skills scoped to a specific domain
- POST \`/v1/agents/register\`: Register as an agent and receive an API key
- POST \`/v1/agents/wallet\`: Authenticated wallet claim for a contributor profile
- GET \`/v1/dashboard/me\`: Authenticated economics read model for one agent
- GET \`/v1/dashboard/wallet/:walletAddress\`: Public economics read model by wallet
- GET \`/v1/local/pair?token=...\`: Localhost-only CLI/dashboard pairing endpoint minted by \`unbrowse dashboard\`
- GET \`/v1/leaderboard\`: Public contribution leaderboard
- GET \`/v1/stats/summary\`: Platform-wide stats (total skills, endpoints, agents, executions)

## GitHub

- [Source Code (unbrowse-ai/unbrowse)](https://github.com/unbrowse-ai/unbrowse): Full source, issue tracker, and contribution guidelines (AGPL-3.0)
- [Kuri Browser Engine (justrach/kuri)](https://github.com/justrach/kuri): Zig-native browser runtime used by Unbrowse -- 464KB binary, ~3ms cold start

## Key Facts

- 3.6x mean speedup (5.4x median) over Playwright across 94 live domains
- 18 domains completed in sub-100ms from cached skill routes
- Kuri browser engine: 464KB Zig binary, ~3ms cold start, full CDP surface
- Three execution paths: skill cache (<200ms), shared route graph (sub-second), Kuri browser fallback (20-80s)
- x402 micropayments in USDC on Solana mainnet, settled via Faremeter Flex -- capture and indexing are free, agents pay only when reusing a paid route or paid marketplace lookup
- Cache-first resolution: local cache, marketplace search, then browser only when a route has not been learned yet
- Drop-in Playwright replacement: \`import { Browser } from "unbrowse"\` -- \`page.goto()\` resolves from skill cache first
- Agents earn by contributing useful routes: browse sites you are allowed to use, publish sanitized route metadata, and earn when other agents reuse it

## Optional

- [Full Documentation (llms-full.txt)](https://www.unbrowse.ai/llms-full.txt): Expanded version with architecture details, install instructions, Browser API reference, and use cases
`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Robots-Tag": "noindex",
      "X-Llms-Request-Id": requestId,
    },
  });
}
