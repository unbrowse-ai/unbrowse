# Privacy Policy: Unbrowse plugin for Dify

This plugin is published by Unbrowse AI Pte. Ltd. It connects Dify to the hosted Unbrowse service.

## What the plugin sends, and where

The plugin sends every request to one external service: the Unbrowse API at `https://unbrowse.ai/api/mcp`, over HTTPS. For each tool call it sends:

- **Scrape Page**: the URL you give and the scrape options (main content only, render mode).
- **Discover**: the query text you give.
- **Run Task**: the task text, the optional capability id and the optional JSON input you give.
- Your Unbrowse API key, as an `Authorization: Bearer` header, to authenticate every request.

The plugin itself does not collect, store or log any user data. It keeps no files, no database and no cache, and it does not write the API key or tool inputs to logs. Dify stores the API key you enter as an encrypted provider credential, as it does for every plugin.

## What Unbrowse does with it

Unbrowse processes the requests above to provide the service: it fetches the pages you ask for (the websites you name see those requests), runs or learns site APIs for your tasks, and meters usage for your account. Pages Unbrowse learns in its cloud browser are recorded to your private workspace; recordings are deleted after 30 days. By default, a learned tool that reads only public pages and needs no login is shared to the public registry after cookies, tokens, your inputs and your task text are removed; you can turn sharing off in your Unbrowse workspace under Connections. Unbrowse shares data with its sub-processors (Cloudflare for hosting; Codegraff and TypeSafe for AI inference) as described in its policy.

The full Unbrowse privacy policy, including retention and every third party: https://unbrowse.ai/privacy

## Your choices

- Do not send personal or sensitive data in URLs, queries, tasks or inputs unless you intend Unbrowse to process it.
- To delete your Unbrowse account or data, email hello@unbrowse.ai from the address on the account.
- Remove the API key from Dify at any time to stop the plugin sending requests.

## Contact

hello@unbrowse.ai
