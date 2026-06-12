# Exa/BrowseComp Gate Manifest Handoff

Status: HOLD. This artifact is ready to use as a release-truth guard, not as a
benchmark-win claim.

Committed handoff: `d4ab18e8 Add Exa BrowseComp release-truth handoff`.
Outward entrypoint: `README.md` links here from the benchmark section so a user
can run the guard before treating any Exa/BrowseComp number as release evidence.

## What To Run

```bash
python3 bench/exa/validate_gate_manifest.py
bun test tests/exa-gate-manifest.test.ts
bash bench/exa/gate_manifest_e2e.sh
```

## What It Proves

- The old fast BrowseComp gate may pass on historical noisy logs, but it is
  classified as non-release evidence.
- The robust BrowseComp gate is the release-eligible witness for BrowseComp.
- A release-eligible BrowseComp witness must declare `minimum_n >= 25`.
- Missing gate paths, duplicate witness IDs, and injected evidence-class strings
  fail closed.

## What It Does Not Prove

- It does not prove Unbrowse beats Exa on every targeted Exa benchmark.
- It does not prove BrowseComp accuracy is above `0.336`.
- It does not authorize npm release, tags, or the completion promise.

## Current Blocking Evidence

`bash bench/exa/gate_manifest_e2e.sh` currently observes:

- `bench/browsecomp/beat-exa-gate.sh` can pass on a noisy historical `0.4` run.
- `bench/browsecomp/beat-exa-robust-gate.sh` remains red because there is no
  robust `N >= 25` BrowseComp result above `0.336`.

Next bounded task: produce or improve a real robust BrowseComp run, then rerun
`bash bench/browsecomp/beat-exa-robust-gate.sh` and the E2E manifest gate.
