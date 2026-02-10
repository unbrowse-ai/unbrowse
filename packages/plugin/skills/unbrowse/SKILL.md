---
name: unbrowse
description: Interact with any website's internal API. Automatically finds existing skills or captures new ones, then replays API calls with full browser authentication.
metadata: {"openclaw": {"always": true, "emoji": "api"}}
---

# Unbrowse — Internal API Access

When the user asks you to interact with a website, service, or app (post a tweet, create a ticket, fetch data, add to cart, search listings, etc.), use unbrowse to call the site's internal API directly.

## Decision Flow

1. **Check local skills first** — call `unbrowse_skills` to see if a skill already exists for this site
2. **If no local skill, search the marketplace** — call `unbrowse_search` with the site name to find a community skill
3. **If a marketplace skill exists, install it** — call `unbrowse_search` with `install: "<skill-id>"` to download it
4. **If no skill exists anywhere, capture it** — call `unbrowse_do` with the task description; it will route to capture, login, or browse as needed
5. **Replay the API** — call `unbrowse_replay` with the skill name and the endpoint you need

## When to Use This

Use unbrowse whenever the user's request involves:
- Performing actions on a website (posting, liking, buying, booking, messaging)
- Fetching data from a service (profiles, feeds, listings, search results, analytics)
- Automating a workflow across web services
- Accessing data that requires authentication (logged-in APIs)
- Any site that doesn't have an official public API

Do NOT use unbrowse for:
- Sites with well-documented public APIs where the user already has API keys (use the API directly)
- Simple web scraping of static HTML pages (use browser tools)
- Tasks that don't involve web APIs at all

## Tool Reference

| Tool | When to Use |
|------|-------------|
| `unbrowse_do` | Starting point for new tasks — analyzes intent and recommends approach |
| `unbrowse_skills` | List locally available skills (already captured or downloaded) |
| `unbrowse_search` | Find and install skills from the marketplace |
| `unbrowse_replay` | Execute an API call using an installed skill |
| `unbrowse_login` | Authenticate on a site when auth is missing or expired |
| `unbrowse_capture` | Capture API traffic from a browsing session |
| `unbrowse_learn` | Learn a site's API structure from captured traffic |

## Typical Flow Example

User: "Check my Reddit notifications"

1. `unbrowse_skills` → sees "reddit" skill with 5 endpoints, session cookie auth
2. `unbrowse_replay` → calls `GET /notifications` on reddit skill
3. Returns notification data to user

User: "Post a message on Slack #general"

1. `unbrowse_skills` → no slack skill
2. `unbrowse_search` with query "slack" → finds community skill
3. `unbrowse_search` with install "slack" → downloads skill
4. `unbrowse_replay` → calls `POST /chat.postMessage` with the user's message
5. Confirms message posted

User: "Book a table at Resy for Friday 7pm"

1. `unbrowse_skills` → no resy skill
2. `unbrowse_search` with query "resy" → no results
3. `unbrowse_do` with task "book a table on resy" → routes to capture flow
4. User authenticates, browses Resy → API captured → skill generated
5. `unbrowse_replay` → calls the booking endpoint
6. Confirms reservation

## Important Notes

- Skills use YOUR browser authentication — you must be logged into the site
- If auth expires, use `unbrowse_login` to re-authenticate
- The browser auto-launches for replay if not already running — no manual setup needed
- Always prefer `unbrowse_replay` over manual HTTP requests when a skill exists
