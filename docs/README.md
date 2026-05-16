# Unbrowse

Unbrowse is an API-native browser for AI agents. It lets an agent reach the data and actions behind a website without driving the website's visible interface every time.

Most AI agents use the web the way a tired human would: open the page, wait for it to load, click through menus, fight popups, fill forms, wait again. Unbrowse learns the structured request path behind a site once, then reuses it. When a site genuinely needs a real browser session (cookies, sign-in, redirect handling), Unbrowse keeps that browser context in the loop. Same permissions, less ceremony.

This documentation is organised by who is reading it.

* **Start Here** explains what Unbrowse is in plain language, no background assumed.
* **For Agents** is the operating model for an AI agent calling Unbrowse.
* **For Developers** is how to integrate it in code.
* **Concepts** is the conceptual model behind the system, drawn from the published papers.
* **For Investors** is the wedge, the moat, and where to read the research.

The two papers this documentation draws from:

* [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694) on shared route discovery and the case against browser-first agent architectures.
* The Unbrowse Maintenance Network paper on trust, accountability, and optional bonding in a shared route graph.

Source and licensing scope is described in the [Open Source Notice](OPEN-SOURCE-NOTICE.md).
