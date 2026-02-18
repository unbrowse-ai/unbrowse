---
name: unbrowse
description: >-
  Standalone Unbrowse (no OpenClaw). Use agent-browser for deterministic browsing (refs/snapshots),
  capture internal API traffic, and generate reusable Unbrowse skills (SKILL.md + scripts/api.ts).
---

## Install

Dependency: `agent-browser` (required)

```bash
agent-browser --version
# if missing:
#   npm install -g agent-browser
#   agent-browser install
./scripts/ensure-agent-browser.sh --install # (if this helper exists in your checkout/skill install)
```

## Commands

This repo provides a standalone `unbrowse` CLI (no OpenClaw):

```bash
node packages/cli/unbrowse.js --help
```

## Default Algorithm (Use This)

1) **Search marketplace**

Standalone CLI:

```bash
node packages/cli/unbrowse.js search --index-url "https://index.unbrowse.ai" --q "<domain> <task>"
```

OpenClaw plugin:

```text
unbrowse_search { "query": "<domain> <task>" }
```

2) **If a skill exists: install + use it**

- Install:
  - CLI: `node packages/cli/unbrowse.js install --index-url "https://index.unbrowse.ai" --skill-id "<skillId>"`
  - Plugin: `unbrowse_search { "install": "<skillId>" }`
- Capture your auth: `unbrowse_login` (or `unbrowse_auth` if already logged in)
- Execute endpoints: `unbrowse_replay` (use `executionMode="backend"` for proxy-only skills)

3) **If no skill exists: reverse-engineer**

- Login/browse with traffic capture: `unbrowse_login` or `unbrowse_browse` (agent-browser)
- Learn and write a local skill dir: `unbrowse_browse` with learn-on-the-fly (or `unbrowse_capture` + `unbrowse_learn`)

4) **Publish + execute**

- Publish: `unbrowse_publish` (optional if you want it in marketplace)
- Execute: `unbrowse_replay` (local) and optionally `executionMode="backend"` to validate via marketplace executor.

Core workflows:

1) Login (captures cookies/storage, tries to generate a skill if there’s traffic)

```bash
node packages/cli/unbrowse.js login \
  --login-url "https://example.com/login" \
  --field "#email=me@example.com" \
  --field "#password=..." \
  --submit "text=Sign in"
```

2) Browse (do a task, then learn-on-the-fly from captured XHR/fetch)

Create `actions.json`:

```json
[
  { "action": "click_element", "index": 1 },
  { "action": "input_text", "index": 2, "text": "hello" },
  { "action": "click_element", "index": 3 }
]
```

Run:

```bash
node packages/cli/unbrowse.js browse \
  --url "https://example.com" \
  --actions-json ./actions.json \
  --learn-on-fly
```

3) Capture -> Learn (non-interactive; best for public pages)

```bash
node packages/cli/unbrowse.js capture --url "https://example.com" --out /tmp/example.har
node packages/cli/unbrowse.js learn --har /tmp/example.har --out ~/.openclaw/skills
```

## Notes

- `browse` prints an `interactive` list (indexed) based on `agent-browser snapshot -i` output.
- Indices are session-local. After navigation, resnapshot (the command does this automatically after actions).
