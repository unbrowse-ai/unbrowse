# Unbrowse MCP Audit — Payload Size Measurements

## Summary

Measured 5 of 5 cited tool_result payloads. All within 0.07% of cited values. **Audit is 5/5 accurate.**

(Original Day-3 pass marked 3 sessions `not_located` because it searched only `~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/`. Day-8 Audit 8 widened the search across all Claude project hash dirs and found them.)

## Measurements

| Session | Tool | Intent | Cited (chars) | Measured (chars) | Δ% | Verdict |
|---|---|---|---|---|---|---|
| d66b5b54 | unbrowse_resolve | google maps | 79,865 | 79,917 | +0.065% | ✓ |
| d66b5b54 | unbrowse_execute | carousell | 83,163 | 83,165 | +0.002% | ✓ |
| 458c6517 | unbrowse_run | shopee.sg | 116,718 | 116,718 | 0.000% | ✓ |
| 34e23bcd | unbrowse_resolve | eatigo | 64,416 | 64,434 | +0.028% | ✓ |
| 99d5e0a4 | unbrowse_run | eatigo --debug | 55,422 | 55,442 | +0.036% | ✓ |

## File locations

| Session | Project hash dir | Tool-result file |
|---|---|---|
| d66b5b54 | `-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse` | `mcp-unbrowse-unbrowse_resolve-1778554065254.txt`, `mcp-unbrowse-unbrowse_execute-1778553854727.txt` |
| 458c6517 | `-Users-lekt9-Projects` | `mcp-unbrowse-unbrowse_run-1778590308746.txt` |
| 34e23bcd | `-Users-lekt9-Projects-unbrowse-ecosystem` | `mcp-unbrowse-unbrowse_resolve-1778525076608.txt` |
| 99d5e0a4 | `-Users-lekt9` | `mcp-unbrowse-unbrowse_run-1778580835480.txt` |

## Conclusion

Audit's P0 oversize claim (79K-117K chars per call) is fully validated. The diet's 25 KB cap brings each of these calls under budget by roughly 2.5× to 4.7×.

## Method

1. Found tool-results files via `find ~/.claude/projects -name "<UUID>*" -type d`, then `ls */tool-results/`.
2. Measured each `mcp-unbrowse-<tool>-*.txt` with `wc -c`.
3. Verified content structure via `jq`: each file contains the full JSON response body matching the MCP tool_result schema.

## Notes

- The audit cites these as "session JSONL → tool_result" but the actual tool response bodies are stored separately in per-session `tool-results/` directories as formatted JSON. Both the JSONL (transcript record) and the .txt (full response body) match.
- All five measured deltas are well within ±0.1% — likely formatting/whitespace, not real content drift.
