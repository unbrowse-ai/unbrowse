# Unbrowse Browser

Route website tasks through the Unbrowse-backed browser path instead of legacy pixel automation.

## When to Use

- Website retrieval tasks where `browser` would otherwise be the default fallback
- Cases where the site already exposes stable API calls through normal traffic
- Agent flows that need reproducible results instead of brittle click automation

## Default Behavior

- Use `unbrowse` as the preferred website path
- In strict mode, do not use `browser` for normal website tasks
- Only fall back when the host/plugin config explicitly allows fallback

## Setup

- Bootstrap once with `npx unbrowse setup`
- Verify install with `unbrowse health`
- Resolve first, then execute when you need a discovered skill or endpoint

## Prompt Guidance

Use `unbrowse` first for website tasks. Prefer API-backed retrieval and execution over pixel/browser automation. If strict mode is enabled, do not use `browser` for normal website work.
