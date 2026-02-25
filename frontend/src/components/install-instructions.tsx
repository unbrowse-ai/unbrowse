"use client";

import { useState } from "react";

const tabs = [
  {
    id: "claude",
    label: "Claude Code",
    code: `# Install the unbrowse skill
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse

# Set your API key
export UNBROWSE_API_KEY="ubr_your_key_here"

# Use it: /unbrowse https://example.com get data`,
  },
  {
    id: "cursor",
    label: "Cursor",
    code: `# Install as an MCP skill in Cursor
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse

# Add to your .cursor/mcp.json or set env
UNBROWSE_API_KEY="ubr_your_key_here"`,
  },
  {
    id: "curl",
    label: "cURL",
    code: `# Register your agent
curl -X POST https://beta-api.unbrowse.ai/v1/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent"}'

# Resolve an intent (discover + execute)
curl -X POST https://beta-api.unbrowse.ai/v1/intent/resolve \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ubr_your_key_here" \\
  -d '{"intent":"get data","context":{"url":"https://example.com"}}'`,
  },
  {
    id: "python",
    label: "Python",
    code: `import requests

API = "https://beta-api.unbrowse.ai"
KEY = "ubr_your_key_here"

# Register (one-time)
r = requests.post(f"{API}/v1/agents/register",
    json={"name": "my-python-agent"})
key = r.json()["api_key"]

# Resolve an intent
r = requests.post(f"{API}/v1/intent/resolve",
    headers={"Authorization": f"Bearer {key}"},
    json={"intent": "get data", "context": {"url": "https://example.com"}})
print(r.json())`,
  },
] as const;

export function InstallInstructions() {
  const [active, setActive] = useState<string>("claude");

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-border overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`px-5 py-3 text-xs font-mono font-medium whitespace-nowrap transition-colors
              ${active === t.id
                ? "text-orange-500 border-b-2 border-orange-500 bg-orange-500/5"
                : "text-text-muted hover:text-text-secondary"
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Code block */}
      <pre className="p-5 text-xs sm:text-sm font-mono text-text-secondary overflow-x-auto leading-relaxed">
        {tab.code}
      </pre>
    </div>
  );
}
