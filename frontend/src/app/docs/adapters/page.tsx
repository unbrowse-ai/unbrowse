import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Drop-in adapters — Unbrowse Docs",
  description:
    "Swap one import and your existing code routes through Unbrowse. Drop-ins for HTTP clients, browser automation, search, the popular agent SDKs, MCP, and Python.",
  alternates: { canonical: "https://www.unbrowse.ai/docs/adapters" },
};

export default function DocsAdaptersPage() {
  return (
    <>
      <h1>Drop-in adapters</h1>
      <p>
        Already using another library? You do not need to rewrite anything. Swap one
        import for the matching Unbrowse adapter — every safe <code>GET</code>,
        search, or scrape first routes through Unbrowse&apos;s resolved-route cache
        (free on a hit), and anything that misses falls back to native{" "}
        <code>fetch</code> or the upstream library, so behaviour is preserved and only
        cost drops. Each adapter ships a parity test proving it provides the
        upstream&apos;s public surface.
      </p>
      <p>
        Configure once (optional): <code>UNBROWSE_API_URL</code>,{" "}
        <code>UNBROWSE_API_KEY</code>, <code>UNBROWSE_X_PAYMENT</code>. Set{" "}
        <code>UNBROWSE_DRYRUN=1</code> for offline, deterministic calls.
      </p>

      <h2>HTTP clients (JavaScript / TypeScript)</h2>
      <p>
        Same client surface; a safe <code>GET</code> routes through Unbrowse, else
        native <code>fetch</code>.
      </p>
      <pre><code>{`- import got from 'got';
+ import got from '@unbrowse/got-shim';

  const data = await got('https://api.site.com/items').json(); // unchanged`}</code></pre>
      <ul>
        <li><code>fetch</code> → <code>@unbrowse/client</code></li>
        <li><code>axios</code> → <code>@unbrowse/axios-shim</code></li>
        <li><code>got</code> → <code>@unbrowse/got-shim</code></li>
        <li><code>ky</code> → <code>@unbrowse/ky-shim</code></li>
        <li><code>node-fetch</code> → <code>@unbrowse/node-fetch-shim</code></li>
        <li><code>cross-fetch</code> → <code>@unbrowse/cross-fetch-shim</code></li>
        <li><code>undici</code> → <code>@unbrowse/undici-shim</code></li>
        <li><code>superagent</code> → <code>@unbrowse/superagent-shim</code></li>
        <li><code>wretch</code> → <code>@unbrowse/wretch-shim</code></li>
      </ul>

      <h2>Browser automation</h2>
      <ul>
        <li><code>playwright</code> → <code>@unbrowse/playwright-shim</code></li>
        <li><code>puppeteer</code> → <code>@unbrowse/puppeteer-shim</code></li>
        <li><code>selenium-webdriver</code> → <code>@unbrowse/selenium-shim</code></li>
        <li><code>@browserbasehq/stagehand</code> → <code>@unbrowse/stagehand-shim</code></li>
      </ul>

      <h2>Search &amp; retrieval</h2>
      <ul>
        <li><code>@mendable/firecrawl-js</code> → <code>@unbrowse/firecrawl-shim</code></li>
        <li><code>exa-js</code> → <code>@unbrowse/exa-shim</code></li>
        <li><code>@tavily/core</code> → <code>@unbrowse/tavily-shim</code></li>
      </ul>

      <h2>Agent SDKs (native tool)</h2>
      <p>
        Register Unbrowse&apos;s <code>resolve</code> / <code>execute</code> /{" "}
        <code>search</code> as your framework&apos;s own tool type with one import.
      </p>
      <pre><code>{`import { generateText } from 'ai';
import { unbrowseTools } from '@unbrowse/ai-sdk';

await generateText({ model, tools: unbrowseTools, prompt: '...' });`}</code></pre>
      <ul>
        <li>Vercel AI SDK (<code>ai</code>) → <code>@unbrowse/ai-sdk</code></li>
        <li>LangChain JS (<code>@langchain/core</code>) → <code>@unbrowse/langchain-js</code></li>
        <li>Mastra (<code>@mastra/core</code>) → <code>@unbrowse/mastra</code></li>
        <li>LlamaIndex TS (<code>llamaindex</code>) → <code>@unbrowse/llamaindex</code></li>
        <li>OpenAI Agents SDK (<code>@openai/agents</code>) → <code>@unbrowse/openai-agents</code></li>
      </ul>

      <h2>Python</h2>
      <p>
        The same drop-in story for the Python runtime — pure stdlib, no upstream
        install needed for the fallback.
      </p>
      <pre><code>{`# before:  import requests
import unbrowse_requests as requests

r = requests.get("https://api.site.com/items")   # unchanged`}</code></pre>
      <ul>
        <li><code>requests</code> → <code>unbrowse-requests</code></li>
        <li><code>httpx</code> → <code>unbrowse-httpx</code></li>
        <li><code>aiohttp</code> → <code>unbrowse-aiohttp</code></li>
        <li><code>urllib3</code> → <code>unbrowse-urllib3</code></li>
        <li><code>crewai</code> → <code>unbrowse-crewai</code> (native tool)</li>
        <li><code>pydantic-ai</code> → <code>unbrowse-pydantic-ai</code> (native tool)</li>
      </ul>

      <h2>MCP — the native protocol surface</h2>
      <p>
        Unbrowse is itself an MCP server, so any MCP-capable host gets the full tool
        set with no adapter package at all:
      </p>
      <pre><code>{`npx unbrowse mcp`}</code></pre>
      <p>
        It is still available for hosts that need a stdio server, but setup no
        longer writes MCP host configs. The Agent Skill + CLI are the default
        surface; the framework adapters above are for building an agent in code
        with one of the SDKs.
      </p>
    </>
  );
}
