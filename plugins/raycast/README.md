# Unbrowse

Read any web page as clean markdown, or describe a task on a website in plain words and get the structured result, from Raycast.

[Unbrowse](https://unbrowse.ai) is a hosted service that turns websites into APIs. Pages are fetched over HTTP, or in Unbrowse's cloud browser when a page needs one, and site tasks run as API calls against routes Unbrowse has learned.

## Commands

- **Read Page**: enter a URL (`example.com` works) and read the page as markdown. Copy or paste the markdown, or open the page.
- **Run Site Task**: enter a task such as `top 3 stories on Hacker News` and, optionally, the site it is about. The result shows as JSON you can copy. Tasks that need a sign-in or more input point you to unbrowse.ai.

## Setup

1. Sign in at [unbrowse.ai/app](https://unbrowse.ai/app). The free tier needs no card.
2. Create an API key. It starts with `ub_live_`.
3. Paste it into the extension's **API Key** preference.

The key is sent only to `https://unbrowse.ai/api/mcp`, as a bearer token.

## Develop

```sh
npm ci
npm run dev      # Raycast development mode
npm run build    # distribution build
npm run lint
npm test         # UNBROWSE_LIVE=1 UNBROWSE_API_KEY=ub_live_... npm test for live calls
```
