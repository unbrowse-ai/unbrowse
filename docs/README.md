# Unbrowse

Unbrowse is the **action engine of the internet** — the open-source action layer for AI agents. The public surface is a single contract-shaped hole: the agent supplies intent, optional URL/params/approval, and Unbrowse chooses the cheapest capable layer behind it.

Most AI agents use the web the way a tired human would: open the page, wait for it to load, click through menus, fight popups, fill forms, wait again. Unbrowse learns the structured request path behind a site once, then reuses it — so the agent acts through the site's real APIs instead of pixel-clicking. When a site genuinely needs a real browser session (cookies, sign-in, redirect handling), Unbrowse keeps that browser context in the loop. Same permissions, less ceremony.

It is also a **fair-compensation engine**: routes are a shared, maintained asset, and the people who index and keep them fresh are fairly compensated when those routes run. Unbrowse is open source, runs locally, and is a member of the [NVIDIA Inception program](https://www.nvidia.com/en-us/startups/).

This documentation is organised by who is reading it.

* **Start Here** explains what Unbrowse is in plain language, no background assumed.
* **For Agents** is the operating model for an AI agent filling the Unbrowse hole.
* **For Developers** is how to integrate it in code.
* **Concepts** is the conceptual model behind the system, drawn from the published papers.
* **For Investors** is the wedge, the moat, and where to read the research.

## Research

Unbrowse is built on a published research trilogy. They are the canonical source for the concepts in these docs:

* **[Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694)** — why the internal APIs already powering modern websites are the machine-native interface for agents, and the case against browser-first architectures. The historical route-discovery layer, not the whole current product surface.
* **Crypto Was All You Needed** — one signing discipline across every layer an agent touches (screen, browser, CLI, OS), with credentials cryptographically bound to the agent's key and every result sealed.
* **The Unbrowse Maintenance Network** — trust, accountability, and optional bonding in a shared route graph: how freshness becomes a verifiable artifact and how maintainers are fairly compensated.

The full index and PDFs live at [unbrowse.ai/papers](https://www.unbrowse.ai/papers).

Source and licensing scope is described in the [Open Source Notice](OPEN-SOURCE-NOTICE.md).
