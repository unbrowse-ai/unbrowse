# Browser Benchmark

- Date: `2026-03-27`
- URL: `https://www.google.com/travel/flights?q=Flights%20to%20TPE%20from%20SIN%20on%202026-03-23&curr=SGD`
- Kuri branch: `feature/debug-mode-freeze-hud`
- Kuri commit: `9d05461`
- agent-browser: `agent-browser 0.9.1`
- lightpanda: `1.0.0-nightly`

## Snapshot Comparison

| Tool | Bytes | Tokens | vs kuri | Note |
|---|---:|---:|---:|---|
| kuri snap (compact) | 5,687 | 1,502 | baseline |  |
| kuri snap --interactive | 2,595 | 760 | 0.5x |  |
| kuri snap --json | 37,647 | 10,479 | 7.0x | Older verbose format |
| agent-browser snapshot | 9,619 | 2,617 | 1.7x |  |
| agent-browser snapshot -i | 3,351 | 951 | 0.6x |  |
| lightpanda semantic_tree | 25,720 | 9,367 | 6.2x | JS-capable standalone fetch |
| lightpanda semantic_tree_text | 19,248 | 12,279 | 8.2x | Text-only semantic dump |

## Action Responses

| Action | Bytes | Tokens |
|---|---:|---:|
| kuri go | 2,898 | 872 |
| kuri click | 2,911 | 856 |
| kuri back | 12 | 5 |
| kuri scroll | 2,791 | 827 |
| kuri eval | 65 | 14 |
| agent-browser go | 170 | 60 |
| agent-browser click | 9 | 4 |
| agent-browser back | 154 | 49 |
| agent-browser scroll | 9 | 4 |
| agent-browser eval | 67 | 15 |

## Workflow

### Raw Captured Output

| Workflow | Tokens |
|---|---:|
| kuri-agent `go→snap-i→click→snap-i→eval` | 3,262 |
| agent-browser `go→snap-i→click→snap-i→eval` | 1,981 |

agent-browser uses about **64.7% fewer tokens** per raw workflow capture in this run.

### Normalized Page-State Output

This strips tool-specific action acknowledgement noise and compares only the state payloads an agent would read back: `snap-i + snap-i + eval`.

| Workflow | Tokens |
|---|---:|
| kuri-agent normalized page-state | 1,534 |
| agent-browser normalized page-state | 1,917 |

Kuri uses about **20.0% fewer tokens** for normalized page-state output in this run.

## Artifacts

- Raw outputs: [`raw/`](./raw)
- Machine-readable summary: [`summary.json`](./summary.json)
