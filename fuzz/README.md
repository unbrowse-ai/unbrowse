# Coverage-guided fuzzing

These Jazzer.js targets exercise Unbrowse's narrow, untrusted parser boundaries:

- `protobuf-wire`: arbitrary response bytes through the protobuf decoder and structural-admission oracle.
- `obscura-capture`: arbitrary NDJSON emitted by the native capture sidecar.
- `rsc`: arbitrary React Server Components wire responses and embedded URL extraction.

Targets are deterministic, perform no I/O, cap inputs at 64 KiB, and assert semantic invariants rather than swallowing failures. Generated bundles and discovered corpus entries are local artifacts; stable regression seeds live under `fuzz/seeds/`.

```bash
bun install
bun run fuzz:protobuf       # continuous campaign; Ctrl-C to stop
bun run fuzz:obscura
bun run fuzz:rsc
bun run fuzz:smoke          # bounded CI/developer witness (1,000 runs each)
```

Pass libFuzzer options after the target through `scripts/run-fuzz.sh`, for example:

```bash
bash scripts/run-fuzz.sh protobuf-wire -max_total_time=60 -rss_limit_mb=2048
```

Crashes are written by libFuzzer in the repository root. Reproduce one with:

```bash
bash scripts/run-fuzz.sh protobuf-wire -runs=1 path/to/crash-input
```
