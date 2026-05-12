# Unbrowse MCP Audit — Payload Size Measurements

## Summary

Measured 2 of 5 cited tool_result payloads. Both found in session `d66b5b54-efc5-42da-9eb1-608ba78d1022`. Three remaining sessions (`458c6517-...`, `34e23bcd-...`, `99d5e0a4-...`) not located in `~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/`.

## Measurements

| Session | Tool | Intent | Cited (chars) | Measured (chars) | Δ% | Verdict |
|---|---|---|---|---|---|---|
| d66b5b54 | unbrowse_resolve | google maps | 79,865 | 79,917 | +0.065% | ✓ |
| d66b5b54 | unbrowse_execute | carousell | 83,163 | 83,165 | +0.002% | ✓ |
| 458c6517 | unbrowse_run | shopee.sg | 116,718 | not_located | — | ? |
| 34e23bcd | unbrowse_resolve | eatigo | 64,416 | not_located | — | ? |
| 99d5e0a4 | unbrowse_run | eatigo --debug | 55,422 | not_located | — | ? |

## Results

- **Verdicts**: 2 ✓ (within ±5% tolerance), 0 ✗, 3 not_located
- **Conclusion**: Both measured payloads confirm the audit's cited character counts. The oversize claim (79K–116K per call) is validated for the two samples. Three sessions unavailable for verification.

## Method

1. Located session directory: `~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/d66b5b54-efc5-42da-9eb1-608ba78d1022/`
2. Found tool-results directory with two .txt files:
   - `mcp-unbrowse-unbrowse_resolve-1778554065254.txt`: measured with `wc -c` → 79,917 bytes
   - `mcp-unbrowse-unbrowse_execute-1778553854727.txt`: measured with `wc -c` → 83,165 bytes
3. Verified content structure via jq: both files contain full JSON response bodies matching the MCP tool_result schema (keys: result, timing, trace, source, impact).
4. Searched for other three session UUIDs (`458c6517-*`, `34e23bcd-*`, `99d5e0a4-*`) across the projects directory—no matches found.

## Notes

- The audit file cites these as "session JSONL → tool_result" but the actual tool response bodies are stored separately in per-session `tool-results/` directories as formatted JSON.
- No surrogates measured; all measurements are of actual .txt files containing the MCP tool_result response body.
- Within-tolerance results (✓) validate the audit's "oversize" P0 claim for the samples available.
