# Browser Benchmark

- Date: `2026-03-27`
- URL: `https://vercel.com`
- Kuri branch: `feature/debug-mode-freeze-hud`
- Kuri commit: `9d05461`
- agent-browser: `agent-browser 0.9.1`
- lightpanda: `1.0.0-nightly`

## Snapshot Comparison

| Tool | Bytes | Tokens | vs kuri | Note |
|---|---:|---:|---:|---|
| kuri snap (compact) | 6,849 | 2,107 | baseline |  |
| kuri snap --interactive | 2,450 | 949 | 0.5x |  |
| kuri snap --json | 67,009 | 19,294 | 9.2x | Older verbose format |
| agent-browser snapshot | 16,191 | 4,694 | 2.2x |  |
| agent-browser snapshot -i | 3,316 | 1,209 | 0.6x |  |
| lightpanda semantic_tree | 727,189 | 262,682 | 124.7x | JS-capable standalone fetch |
| lightpanda semantic_tree_text | 11,868 | 3,660 | 1.7x | Text-only semantic dump |

## Action Responses

| Action | Bytes | Tokens |
|---|---:|---:|
| kuri go | 2,597 | 990 |
| kuri click | 2,690 | 1,011 |
| kuri back | 12 | 5 |
| kuri scroll | 2,570 | 982 |
| kuri eval | 68 | 16 |
| agent-browser go | 94 | 25 |
| agent-browser click | 125 | 29 |
| agent-browser back | 154 | 49 |
| agent-browser scroll | 9 | 4 |
| agent-browser eval | 70 | 17 |

## Workflow

### Raw Captured Output

| Workflow | Tokens |
|---|---:|
| kuri-agent `go→snap-i→click→snap-i→eval` | 3,915 |
| agent-browser `go→snap-i→click→snap-i→eval` | 2,489 |

agent-browser uses about **57.3% fewer tokens** per raw workflow capture in this run.

### Normalized Page-State Output

This strips tool-specific action acknowledgement noise and compares only the state payloads an agent would read back: `snap-i + snap-i + eval`.

| Workflow | Tokens |
|---|---:|
| kuri-agent normalized page-state | 1,914 |
| agent-browser normalized page-state | 2,435 |

Kuri uses about **21.4% fewer tokens** for normalized page-state output in this run.

## Artifacts

- Raw outputs: [`raw/`](./raw)
- Machine-readable summary: [`summary.json`](./summary.json)
