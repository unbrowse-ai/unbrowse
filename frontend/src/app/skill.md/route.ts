import { NextResponse } from "next/server";

const BODY = `# Unbrowse skill — retired

The Anthropic skill path for Unbrowse retired in v6.15.0. Two replacements:

## MCP server

\`\`\`json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"]
    }
  }
}
\`\`\`

## SDK

\`\`\`bash
npm install @unbrowse/sdk
\`\`\`

\`\`\`ts
import { Unbrowse } from "@unbrowse/sdk";
const u = await Unbrowse.local();
const r = await u.resolve({ intent: "...", url: "..." });
\`\`\`

Docs: https://unbrowse.ai
Repo: https://github.com/unbrowse-ai/unbrowse-dev
`;

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return new NextResponse(BODY, {
    status: 410,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Replaced-By": "@unbrowse/sdk + MCP",
    },
  });
}
