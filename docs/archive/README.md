# docs/archive

Historical snapshots, frozen on the dates in their filenames or headers. **Not current product truth.**

Use only for context: incident post-mortems, prior audits, abandoned roadmaps. If you find a live document referencing one of these, the live document needs updating, not the archive.

## Files

| File | Frozen as of | Topic |
|---|---|---|
| `2026-03-31-orchestrator-analysis.md` | 2026-03-31 | Why live DOM data wasn't reaching the user (since fixed). |
| `2026-03-31-yq-contributions.md` | 2026-03-31 | QA contribution log for the OpenClaw deployment sprint. |
| `2026-04-04-backend-regression-issues.md` | 2026-04-04 | Indexing + LinkedIn auth regressions during April 3-4 sprint. |
| `agent-experience-issues.md` | 2026-04-29 | Issue inventory of session traces; superseded by the agent-experience harness. |
| `agent-memory.md` | 2026-05 (self-deprecated) | Old durable-memory doc. Memory now lives in `AGENTS.md`. |
| `windows-port-plan.md` | 2026-05 (planning, never started) | Estimated effort for Kuri POSIX shims on Windows. |

## Policy

- Don't modify archived files — their value is being a stable historical reference.
- If new analysis on the same topic is needed, write a new doc under `docs/`, not back into archive.
- If a current doc still depends on something here, lift the load-bearing material into the current doc and link to the archive for full context.
