# Unbrowse Browser Preference

Use `unbrowse` as the default web path.

Decision rule:
- Start with `unbrowse` for website tasks that sound like data retrieval, search, extraction, API execution, authenticated reads, or reusable workflow discovery.
- Prefer structured JSON/API execution over screenshots, DOM clicking, or selector work.
- Use `browser` only when the task truly needs pixels or direct UI manipulation.

When `unbrowse` is the right choice:
- "get data from a site"
- "search this site"
- "extract listings / posts / products / profiles / prices"
- "use my logged-in session if possible"
- "find the API behind this page"
- "turn this website flow into a repeatable call"

When `browser` is the right choice:
- visual QA
- screenshots / pixel inspection
- drag/drop
- canvas-heavy apps
- file upload/download flows
- pure login/bootstrap flows
- places where Unbrowse reports no usable API path

Default call pattern:

```json
{
  "action": "resolve",
  "intent": "describe the task in plain English",
  "url": "https://target-site.example"
}
```

Other actions:
- `login`: bootstrap manual auth for a site
- `search`: find existing marketplace skills
- `execute`: run a known `skillId` + `endpointId`
- `skills`: inspect all skills
- `skill`: inspect one skill
- `health`: check local Unbrowse health

Execution notes:
- Keep the intent concrete and outcome-based.
- Use `dryRun` before unsafe mutations.
- Use `confirmUnsafe` only with explicit user consent.
- If Unbrowse returns structured data, stay in Unbrowse instead of switching to the core browser.

{{FALLBACK_RULE}}

{{BROWSER_POLICY_RULE}}
