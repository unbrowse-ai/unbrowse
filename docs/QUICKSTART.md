# Quickstart Guide

Get started with Unbrowse in under 5 minutes.

## Installation

```bash
# Clone the repo
git clone https://github.com/lekt9/unbrowse-v3.git
cd unbrowse-v3

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium
```

## Basic Usage

### 1. Capture APIs from a Website

The simplest way to start—just provide a URL:

```
unbrowse_capture urls=["https://api.example.com/docs"]
```

This will:
- Launch a browser
- Visit the URL and crawl up to 15 pages
- Capture all API traffic
- Generate a skill in `~/.clawdbot/skills/example/`

### 2. View Your Skills

```
unbrowse_skills
```

Output:
```
Local skills:
  example (12 endpoints, auth: Bearer Token)
  another-api (5 endpoints, auth: Session)
```

### 3. Replay APIs

Execute captured APIs without a browser:

```
unbrowse_replay service="example"
```

Or call a specific endpoint:

```
unbrowse_replay service="example" endpoint="GET /api/users"
```

With a request body:

```
unbrowse_replay service="example" endpoint="POST /api/users" body='{"name":"John"}'
```

---

## Authentication

### For Public APIs

Just use `unbrowse_capture`—no auth needed.

### For Logged-In Sites

**Option 1: Login with credentials**

```
unbrowse_login loginUrl="https://example.com/login" formFields={"#email":"user@example.com","#password":"secret"}
```

**Option 2: Auto-fill from credential provider**

First, configure a credential source in your config:

```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "config": {
          "credentialSource": "keychain"
        }
      }
    }
  }
}
```

Then just provide the login URL:

```
unbrowse_login loginUrl="https://example.com/login"
```

Credentials are looked up automatically by domain.

---

## Interactive Browsing

For complex flows (multi-step forms, dynamic content):

```
unbrowse_interact url="https://example.com/booking" actions=[{"action":"click_element","index":3}]
```

The tool returns indexed elements:

```
[1] <button> Search
[2] <input placeholder="Destination">
[3] <select name="guests"> options=[1, 2, 3, 4]
```

Use indices to interact:

```
actions=[
  {"action":"input_text","index":2,"text":"Paris"},
  {"action":"select_option","index":3,"text":"2"},
  {"action":"click_element","index":1}
]
```

---

## Stealth Mode

For sites with anti-bot protection:

```
unbrowse_stealth action="start" proxyCountry="US"
```

Returns a session ID and live view URL. Then capture:

```
unbrowse_stealth action="capture" sessionId="abc123" url="https://protected-site.com"
```

Or use stealth in replay:

```
unbrowse_replay service="protected-site" useStealth=true proxyCountry="GB"
```

---

## Marketplace

### Search for Skills

```
unbrowse_search query="twitter api"
```

### Install a Skill

```
unbrowse_search install="skill-id-here"
```

Costs $0.01 USDC per skill. Set up wallet first:

```
unbrowse_wallet action="setup"
```

### Publish Your Skills

```
unbrowse_publish service="my-api"
```

You earn USDC when others download your skills.

---

## Example Workflows

### Capture an E-commerce Site

```bash
# 1. Login first
unbrowse_login loginUrl="https://shop.example.com/login" \
  formFields={"#email":"me@example.com","#password":"secret"}

# 2. Capture product pages
unbrowse_capture urls=["https://shop.example.com/products"]

# 3. Use the APIs
unbrowse_replay service="shop-example" endpoint="GET /api/products"
```

### Automate a Booking Flow

```bash
# 1. Start interactive session
unbrowse_interact url="https://booking.example.com" actions=[
  {"action":"input_text","index":2,"text":"New York"},
  {"action":"input_text","index":3,"text":"2024-03-15"},
  {"action":"click_element","index":5}
]

# 2. Continue with results
unbrowse_interact url="https://booking.example.com/results" actions=[
  {"action":"click_element","index":12}  # Select first result
]

# 3. APIs are captured automatically—replay later
unbrowse_replay service="booking-example"
```

### Handle Protected APIs

```bash
# Try normal capture first
unbrowse_capture urls=["https://protected-api.com"]

# If blocked (403), use stealth
unbrowse_stealth action="capture" url="https://protected-api.com" proxyCountry="US"

# Future calls use stealth automatically on 403
unbrowse_replay service="protected-api" useStealth=true
```

---

## Troubleshooting

### "No API requests captured"

- The page may not make API calls
- Try increasing `waitMs`: `unbrowse_capture urls=[...] waitMs=10000`
- Try crawling more pages: `unbrowse_capture urls=[...] maxPages=30`

### "Auth expired" / 401 errors

- Re-run `unbrowse_login` to refresh credentials
- Check if the site uses short-lived tokens (may need frequent re-login)

### "Chrome cookies inaccessible"

Chrome 127+ blocks third-party cookie access. Use `unbrowse_login` instead.

---

## Next Steps

- Read the [Architecture Guide](./ARCHITECTURE.md) for detailed internals
- See [Contributing](../CONTRIBUTING.md) for development setup
- Check [Configuration](./ARCHITECTURE.md#configuration) for all options
