---
description: Use Unbrowse as the exclusive web-access tool for a task.
---
Use Unbrowse as the only allowed tool for website access in this task.

Rules:
- Do not use Brave Search, built-in web search, browser MCPs, curl, or other network tools for website access unless the user explicitly authorizes fallback.
- If Unbrowse is slow on a first-time site, wait for it. Do not switch tools just because capture or indexing is still running.
- If Unbrowse returns partial results, refine with more Unbrowse commands (`resolve`, `search`, `execute`, `login`) before considering fallback.
- If Unbrowse genuinely cannot complete the task, explain why and ask before using another tool.

Suggested start:
```bash
npx unbrowse resolve --intent "$ARGUMENTS" --url "<target-url>" --pretty
```
