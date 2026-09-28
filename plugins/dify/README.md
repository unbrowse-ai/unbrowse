# Unbrowse for Dify

**Author:** unbrowse
**Version:** 0.1.0
**Type:** tool
**Source repository:** https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/dify
**Contact:** hello@unbrowse.ai

Unbrowse turns websites into APIs that agents call. This plugin gives Dify agents, chatflows and workflows three tools backed by the hosted Unbrowse service:

| Tool | What it does |
|---|---|
| **Scrape Page** | Reads any URL and returns clean markdown, plus title, metadata and links (JSON). Plain HTTP first; a cloud browser only when the page needs one. |
| **Discover** | Searches the site APIs Unbrowse has already learned for a goal, e.g. `hacker news top stories`. Returns capability ids, sites and descriptions. |
| **Run Task** | Does a website task in one call and returns structured JSON, e.g. `get the top stories on hacker news`. Give a plain-language task or a capability id from Discover, plus an optional JSON input. |

## Setup

1. Create a free Unbrowse API key at https://unbrowse.ai/app (it starts with `ub_live_`).
2. In Dify, install **Unbrowse** from the Marketplace (Plugins → Marketplace → search "Unbrowse").
3. Open **Tools → Unbrowse → Authorize** and paste the key into **Unbrowse API key**. Dify checks the key against the Unbrowse API before saving it.

## Usage

- **Agent / chatflow**: add the Unbrowse tools to an Agent node or an agent app. The model calls Scrape Page to read a URL, Discover to find a site API, and Run Task to get structured data.
- **Workflow**: add a Tool node → Unbrowse → Scrape Page, and map `url` from an earlier variable. The node's `text` output is the page's markdown; `json` holds the full result (`url`, `finalUrl`, `metadata`, `markdown`, `links`).
- **Run Task statuses**: `succeeded` (data in `result`), `input_required` (the response says which inputs are missing; call again with `input`, e.g. `{"query": "laptops"}`), or `no_capability` (no site API matched; try Scrape Page on a URL instead).

Example Run Task input:

```json
{"task": "get the top stories on hacker news"}
```

## Credentials and connection requirements

- **Credential**: one Unbrowse API key (`UNBROWSE_API_KEY`), entered once per workspace as a provider credential.
- **Network connection**: the plugin makes HTTPS requests to one endpoint only, `https://unbrowse.ai/api/mcp` (JSON-RPC 2.0, one POST per call). A self-hosted Dify needs outbound HTTPS access to `unbrowse.ai`. No proxy or base URL setting is needed.
- **Security boundary**: Scrape Page fetches the URL you or the model supply, from Unbrowse's servers, not from your Dify host, so it cannot reach your private network. Only `http://` and `https://` URLs are accepted. The API key is never included in tool output or error messages.

## Privacy

See [PRIVACY.md](PRIVACY.md) and https://unbrowse.ai/privacy.

## Support

Issues: https://github.com/unbrowse-ai/unbrowse/issues · Email: hello@unbrowse.ai
