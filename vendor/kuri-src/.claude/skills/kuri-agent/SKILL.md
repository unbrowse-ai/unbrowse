---
name: kuri-agent
description: Use kuri-agent to automate Chrome — navigate pages, interact with elements via a11y refs, capture screenshots, run security audits, enumerate cookies/JWTs, probe for IDOR vulnerabilities, and make authenticated fetches. Use when the user wants to automate a browser, test a web app, scrape data, or run security trajectories against a live site.
argument-hint: "[command] [args...]"
allowed-tools: Bash
---

# kuri-agent — Agentic Chrome CLI

`kuri-agent` drives Chrome via CDP. It stores session state in `~/.kuri/session.json` so commands chain together naturally.

## Binary location

After building: `./zig-out/bin/kuri-agent`
After installing to PATH: `kuri-agent`

Build: `zig build agent -Doptimize=ReleaseFast`

## Workflow

Every session follows this pattern:

```bash
# 1. Find a Chrome tab
kuri-agent tabs
# → [{"id":"ABC...","url":"https://...","ws":"ws://127.0.0.1:9222/devtools/page/ABC..."}]

# 2. Attach to a tab
kuri-agent use ws://127.0.0.1:9222/devtools/page/ABC...

# 3. Navigate + interact
kuri-agent go https://example.com
kuri-agent snap --interactive    # get clickable elements as @eN refs
kuri-agent click e2
kuri-agent type e3 "hello world"
kuri-agent shot                  # screenshot → ~/.kuri/screenshots/<ts>.png
```

## All commands

### Discovery & session
```bash
kuri-agent tabs [--port N]       # list Chrome tabs (default port 9222)
kuri-agent use <ws_url>          # attach to tab, save session
kuri-agent status                # show current session
```

### Navigation
```bash
kuri-agent go <url>
kuri-agent back / forward / reload
```

### Page inspection
```bash
kuri-agent snap                          # full a11y snapshot (JSON with @eN refs)
kuri-agent snap --interactive            # only interactive elements
kuri-agent snap --text                   # plain text output
kuri-agent snap --depth 3                # limit tree depth
kuri-agent text                          # get all page text
kuri-agent text "css-selector"           # get text of a specific element
kuri-agent eval "document.title"         # run JavaScript
kuri-agent shot [--out path.png]         # take screenshot
```

### Actions (require a prior snap)
```bash
kuri-agent click <ref>           # ref is @e3 or e3
kuri-agent type <ref> <text>
kuri-agent fill <ref> <value>
kuri-agent select <ref> <value>
kuri-agent hover <ref>
kuri-agent focus <ref>
kuri-agent scroll
```

### Security testing
```bash
kuri-agent cookies               # list cookies with [Secure] [HttpOnly] [SameSite] flags
kuri-agent headers               # check security response headers (CSP, HSTS, X-Frame-Options)
kuri-agent audit                 # full audit: HTTPS + headers + JS-visible cookies, outputs score/issues
kuri-agent storage [local|session|all]   # dump localStorage / sessionStorage
kuri-agent jwt                   # scan storage+cookies for JWTs, decode and print payloads
kuri-agent fetch <METHOD> <url> [--data <json>]  # authenticated fetch using session cookies + headers
kuri-agent probe <url-template> <start> <end>    # IDOR probe: replaces {id} with start..end
```

### Auth headers (persisted across commands)
```bash
kuri-agent set-header Authorization "Bearer eyJ..."
kuri-agent set-header X-Custom-Auth "my-token"
kuri-agent show-headers          # print stored headers
kuri-agent clear-headers         # remove all stored headers
```

Headers set with set-header are automatically applied via Network.setExtraHTTPHeaders on every subsequent CDP connection.

## Security trajectory examples

### Enumerate cookies after login
```bash
kuri-agent go https://target.example.com
kuri-agent cookies
# cookies (2):
#   session_id  domain=.example.com  [Secure] [HttpOnly] [SameSite=Strict]
#   csrf_token  domain=.example.com  [Secure] [!HttpOnly]
```

### Full security audit
```bash
kuri-agent audit
# → {"protocol":"https:","score":4,"issues":["MISSING:content-security-policy","COOKIES_EXPOSED_TO_JS:2"]}
```

### Find and decode JWTs
```bash
kuri-agent jwt
# → {"found":1,"tokens":[{"source":"localStorage:token","payload":{"sub":"123","role":"student"}}]}
```

### IDOR probe — enumerate resource IDs
```bash
kuri-agent set-header Authorization "Bearer eyJ..."
kuri-agent probe "https://api.example.com/v2/courses/{id}/assessments" 30 40
# → [{"id":30,"status":403},{"id":34,"status":200},{"id":35,"status":403}]
```

### Authenticated fetch with different token
```bash
kuri-agent fetch GET "https://api.example.com/v2/user"
kuri-agent fetch POST "https://api.example.com/v2/submissions" --data '{"score":100}'
```

## Output tips

All commands output JSON. audit and headers return CDP wrapper — extract with:
```bash
kuri-agent audit | jq '.result.result.value | fromjson'
kuri-agent headers | jq '.result.result.value | fromjson | .headers'
```

## Tips

- Always run snap before using click/type/fill — it saves the @eN refs to session
- set-header is persistent — set auth token once, all fetch/probe/go commands use it
- Use eval for arbitrary JS: kuri-agent eval "localStorage.getItem('token')"
- probe reports status per ID — look for 200s on IDs you should not have access to
- Chain commands in shell scripts for automated security trajectories
