# cell-build — a self-verifying harness for building out the cell architecture

Every piece of work in the cell architecture (from `docs/endpoint-as-cell.md`)
is itself a cell inside this harness. Each cell has:

- `cell.json` — the Cell record (intent, capabilities, verification.history, phase, contributors)
- `impl.*` — the primitive implementation
- `verify.sh` — runs the cell and appends a VerdictRow to cell.json

`check.sh` walks all cells, runs each cell's `verify.sh`, aggregates
verdicts, and reports green/yellow/red. The request "build out the cell
architecture" is itself a cell (`cells/build-goal/cell.json`) whose
verification is green only when every child cell is green.

**Do not ship anything to prod if `check.sh` reports yellow or red.**
The harness IS the pre-prod gate.

## Layout

```
scripts/cell-build/
  README.md           ← this file
  check.sh            ← run every cell's verify.sh, aggregate
  state.json          ← generated: current state of all cells
  cells/
    build-goal/       ← meta-cell: the request itself
      cell.json
      verify.sh
    docs-hunter/      ← first concrete child cell
      cell.json
      impl.sh         ← fetches llms.txt, openapi, ai-plugin, robots
      verify.sh       ← runs impl against a known-good domain
    ...
```

## Dogfooding

Each cell that fetches URLs should eventually route through
`unbrowse resolve` itself (the "unbrowse grabs its own docs" loop
Lewis pointed at). For v0 the impls use curl directly so we can
ship without depending on the full product being up; the v1
upgrade path is each impl.sh swapping curl → `unbrowse resolve`
once the router is ready.
