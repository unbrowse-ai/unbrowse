# Unbrowse Benchmarks

Measures the speed and token savings of marketplace skill execution vs live browser capture across representative web tasks.

## Quick start

```bash
# Run all benchmarks (2 passes each)
npx tsx benchmarks/run.ts

# Filter by category or keyword
npx tsx benchmarks/run.ts --filter finance
npx tsx benchmarks/run.ts --filter news

# More passes for stable numbers
npx tsx benchmarks/run.ts --passes 5

# Custom output path
npx tsx benchmarks/run.ts --out benchmarks/results/my-run.json
```

## What it measures

Each task gets N passes (default 2):

- **Pass 1** — may trigger live capture (Kuri + headless Chrome) or hit the marketplace if a skill already exists
- **Pass 2+** — should hit the marketplace or route cache (the fast path)

Metrics per pass:
- `source` — where the result came from (`live-capture`, `marketplace`, `route-cache`, `dom-fallback`)
- `resolve_ms` — total time from request to response
- `tokens_saved` — estimated agent tokens saved vs browser-based interaction
- `speedup` — ratio of pass 1 to last pass resolve time

## Results

Results are written as JSON to `benchmarks/results/` with timestamps. Each file contains the full task list, per-pass timings, and summary statistics.

## Prerequisites

- Unbrowse server running locally (`unbrowse setup` or `UNBROWSE_URL` env var)
- Node.js 18+ with tsx available
