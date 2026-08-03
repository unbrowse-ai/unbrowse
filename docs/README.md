# Unbrowse

Unbrowse is an open-source action layer for AI agents. The public surface is a single contract-shaped hole: the agent supplies intent, optional URL/params/approval, and Unbrowse chooses the cheapest capable layer behind it.

Most web agents still pay the browser tax by default: open the page, wait for it to load, inspect the UI, click, and re-read state. Unbrowse learns the structured request path behind a site once, then reuses it, so the agent can act through the site's real APIs when that route exists. When a site genuinely needs a real browser session (cookies, sign-in, redirect handling), Unbrowse keeps that browser context in the loop.

It is also a **fair-compensation engine**: routes are a shared, maintained asset, and the people who index and keep them fresh are fairly compensated when those routes run. Unbrowse is open source, runs locally, and is a member of the [NVIDIA Inception program](https://www.nvidia.com/en-us/startups/).

This documentation is organised by who is reading it.

* **Start Here** explains what Unbrowse is in plain language, no background assumed.
* **For Agents** is the operating model for an AI agent filling the Unbrowse hole.
* **For Developers** is how to integrate it in code.
* **Concepts** is the conceptual model behind the system, drawn from the published papers.
* **For Investors** is the wedge, the moat, and where to read the research.

## Research

Unbrowse is built on a published research trilogy. They are the canonical source for the concepts in these docs:

* **[Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694)** — the first-party routes already powering modern websites are the machine-native interface agents should try before they drive a browser. This is the route-discovery layer, not the whole current product surface.
* **Crypto Was All You Needed** — one signing discipline across every layer an agent touches (screen, browser, CLI, OS), with credentials bound to the agent's key and results sealed.
* **Unbrowse Maintenance Network** — a shared route graph only stays useful if freshness is maintained, witnessed, and economically accountable.

The full index and PDFs live at [unbrowse.ai/papers](https://www.unbrowse.ai/papers).

Source and licensing scope is described in the [Open Source Notice](OPEN-SOURCE-NOTICE.md).
