# n8n-nodes-unbrowse

This is an n8n community node. It lets you use [Unbrowse](https://unbrowse.ai) in your n8n workflows.

Unbrowse turns websites into APIs: it reads any page as clean markdown, keeps an index of site APIs it has learned, and runs website tasks in one call, returning structured JSON.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Usage](#usage) · [Resources](#resources) · [Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `n8n-nodes-unbrowse`.

## Operations

| Operation | What it does | Output |
|---|---|---|
| **Scrape Page** | Reads a URL. Plain HTTP first, a cloud browser only when the page needs one. Options: formats (markdown, html, text, links, raw), only main content, render (auto, always, never). | `url`, `finalUrl`, `metadata` (title, description, ...), `markdown` and any other format you asked for |
| **Discover** | Finds site APIs Unbrowse has already learned for a goal, e.g. `hacker news top stories`. | Matching capabilities with their `id`, site and description |
| **Run Task** | Does a website task in one call, e.g. `get the top stories on hacker news`. Give a plain-language task, or a capability ID from Discover, plus optional JSON input. | `status` and `result`. `status` is `succeeded`, `input_required` (the response lists the missing inputs; run again with them in **Input**) or `no_capability` (use Scrape Page on a URL instead) |

The node is marked usable as a tool, so you can attach it to an **AI Agent** node.

## Credentials

1. Sign up at [unbrowse.ai/app](https://unbrowse.ai/app) and create an API key (free tier; it starts with `ub_live_`).
2. In n8n, create an **Unbrowse API** credential and paste the key into **API Key**.
3. Save. n8n tests the key with one request to `https://unbrowse.ai/api/mcp`.

The key is sent as `Authorization: Bearer <key>`. Every call is one HTTPS POST (JSON-RPC 2.0) to `https://unbrowse.ai/api/mcp`; your n8n instance needs outbound HTTPS access to `unbrowse.ai`.

## Compatibility

Built with `@n8n/node-cli` 0.49 and tested against `n8n-workflow` 2.40 (n8n 2.x, nodes API version 1). No runtime dependencies.

## Usage

**Read a page into a workflow.** Manual Trigger → Unbrowse (Scrape Page, URL `https://example.com`) → use `{{ $json.markdown }}` downstream, e.g. in an AI summarisation node.

**Structured data from a site.** Unbrowse (Run Task, Task `get the top stories on hacker news`) returns `{{ $json.result }}`, e.g. `{ "stories": [{ "title", "points", "url", ... }] }`. If `status` is `input_required`, map the missing fields into **Additional Fields → Input** as a JSON object, e.g. `{"query": "laptops"}`.

**Pick a specific site API.** Unbrowse (Discover, Query `flight prices`) → choose a capability `id` → Unbrowse (Run Task, Additional Fields → Capability ID).

Errors from Unbrowse (invalid key, unreachable page) fail the node with the Unbrowse message; turn on **Continue On Fail** to get them as `{ "error": "..." }` items instead.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Unbrowse](https://unbrowse.ai) · [Source](https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/n8n) · [Issues](https://github.com/unbrowse-ai/unbrowse/issues)
- [Unbrowse privacy policy](https://unbrowse.ai/privacy)

## Development

```sh
npm ci
npm run lint        # n8n-node lint (n8n community node rules)
npm run build
npm test            # mocked; UNBROWSE_LIVE=1 UNBROWSE_API_KEY=... npm test for live calls
npm run dev         # run n8n locally with this node loaded
```

Releases are published to npm with provenance by the `n8n-publish` GitHub Actions workflow in this repository (tag `n8n-nodes-unbrowse@<version>`).

## Version history

- **0.1.0**: first release. Scrape Page, Discover, Run Task; Unbrowse API credential.
