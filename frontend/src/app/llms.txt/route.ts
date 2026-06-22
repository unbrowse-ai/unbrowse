import { NextResponse } from "next/server";
import {
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_NPM,
  INSTALL_CMD_OPENCLAW,
} from "@/lib/install-command";
import { makeAttribution, injectAttribution } from "@/lib/llms-attribution";

export async function GET() {
  const requestId = crypto.randomUUID();
  const b64 = makeAttribution(requestId, "llms-txt");

  const installOpenClaw = injectAttribution(INSTALL_CMD_OPENCLAW, b64);
  const installGeneric = injectAttribution(INSTALL_CMD_GENERIC, b64);
  const installNpm = injectAttribution(INSTALL_CMD_NPM, b64);

  const body = `# Unbrowse

> Unbrowse is an open-source tool that learns first-party routes behind websites from real browsing, then lets AI agents reuse those routes when they are still valid. The browser remains the fallback path on misses, auth flows, and sites that cannot be safely routed directly.

## Getting Started

- [Native Browser Install (Recommended)](https://www.unbrowse.ai/skill.md): Run \`${installOpenClaw}\` to route supported page actions through Unbrowse while keeping browser fallback available
- [CLI Install](https://www.unbrowse.ai/skill.md): Install with \`${installGeneric}\`, resolve your first intent, and set up pay.sh during bootstrap if you want mined-route payouts
- [Public Docs](https://docs.unbrowse.ai): Public explainer and whitepaper companion docs
- [npm Package](https://www.npmjs.com/package/unbrowse): Install globally with \`${installNpm}\`
- [Discord Community](https://discord.gg/VWugEeFNsG): Support, release updates, and discussion

## Documentation

- [Skill Reference (SKILL.md)](https://www.unbrowse.ai/skill.md): Complete agent-facing documentation -- all CLI commands, Browser API, auth flows, payment tiers, and rules
- [Skill Registry / Marketplace](https://www.unbrowse.ai/search): Search discovered and maintained route skills by intent or domain
- [Dashboard](https://www.unbrowse.ai/dashboard): View signed-in CLI/account economics, or public contributor earnings, spending, savings, and rank by wallet address
- [Privacy Policy](https://www.unbrowse.ai/privacy): What data is shared to the marketplace vs kept local
- [Terms of Service](https://www.unbrowse.ai/terms): Usage terms for Unbrowse and the skill registry

## Papers

- [Internal APIs Are All You Need (arXiv:2604.00694)](https://arxiv.org/abs/2604.00694): Whitepaper by Tham, Garcia & Hahn (2026) -- describes the three-path execution architecture, shared route graph, x402 micropayment protocol, and benchmark methodology
- [Crypto Was All You Needed](https://www.unbrowse.ai/crypto-was-all-you-needed.pdf): Security companion -- one signing discipline across every layer an agent touches
- [Unbrowse Maintenance Network](https://www.unbrowse.ai/unbrowse-maintenance-network.pdf): Maintenance companion -- proof of indexing, freshness, challenges, and accountability for a shared route graph

## API Reference

- [Local REST API](https://www.unbrowse.ai/skill.md): Local server at \`http://localhost:6969\` -- resolve intents, execute endpoints, manage auth, search marketplace
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
- GET \`/v1/stats/summary\`: Platform-wide stats (total skills, endpoints, agents, executions)

## GitHub

- [Source Code (unbrowse-ai/unbrowse)](https://github.com/unbrowse-ai/unbrowse): Full source, issue tracker, and contribution guidelines (MIT)
- [Kuri Browser Engine (justrach/kuri)](https://github.com/justrach/kuri): Zig-native CDP broker powering Unbrowse -- 464KB binary, ~3ms cold start, 80+ HTTP endpoints

## Key Facts

- 3.6x mean speedup (5.4x median) over Playwright across 94 live domains in the first paper's warmed-cache benchmark
- 18 domains completed in sub-100ms from cached skill routes in that paper benchmark
- Kuri browser engine: 464KB Zig binary, ~3ms cold start, full CDP surface
- Three execution paths: local cache, shared route graph, and browser fallback
- HTTP-native micropayments in USDC on Solana mainnet, settled via Faremeter Flex -- capture and indexing are free, agents pay only when reusing a paid route or paid marketplace lookup
- Seven-layer cache resolution: in-memory, route cache, domain skill cache, local snapshots, marketplace search, first-pass browser, live capture
- Drop-in browser adapters can resolve from a known route first and fall back to the original browser path on misses
- Contributors can earn when maintained routes they indexed are reused

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
