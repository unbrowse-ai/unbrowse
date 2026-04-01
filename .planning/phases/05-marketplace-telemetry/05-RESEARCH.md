# Phase 5 Research: Marketplace Wiring and Telemetry

## Key Questions and Findings

### 1. Does the background indexer already publish to marketplace?

**YES.** The background indexer (`src/indexer/index.ts`) already:
1. Builds the operation graph (`buildSkillOperationGraph`)
2. Generates local descriptions for BM25 ranking
3. Validates the manifest via `validateManifest`
4. Publishes to marketplace via `publishSkill` (client API call to backend)
5. Updates local caches (domain cache, skill snapshots)

**Timing:** capture -> local cache (~1ms) -> background index -> graph (~20ms) -> validate (~500ms) -> publish (~1.5s) -> EmergentDB indexes. Total ~2-3s to publish, plus EmergentDB indexing latency. Likely within 60s already.

**Gap:** `operation_graph` is stripped before publish in both indexer and passive-publish paths. Graphs stay local only.

### 2. Does marketplace search already work cross-agent?

**YES.** Full search infra exists: backend routes, client functions, EmergentDB vector search, orchestrator resolve flow at ~L2900.

**Gaps:** No graph data in marketplace skills. No publish-to-searchable latency test. No cross-agent e2e test.

### 3. What is the current error handling path?

The `finalize()` function emits `RouteTraceArtifact` locally and `OrchestrationTiming` to backend. Traces include error context. But no client-side auto-file function exists.

### 4. Is there a GitHub API integration?

**NO** GitHub API integration anywhere. But backend has complete issue system:
- `POST /v1/issues/auto-file` endpoint exists with threshold gating
- `buildReproBundle` and `buildIssueTemplate` exist
- Issues stored in KV
- No client-side caller for auto-file endpoint
- No GitHub API call to actually create GitHub issues from templates

### 5. Architecture Assessment

**MARKETPLACE-01:** Publish + search pipelines complete. Missing: graph publish, latency verification, cross-agent test.

**TELEMETRY-01:** Backend auto-file endpoint exists. Missing: client-side error accumulator + caller, kuri version in templates, GitHub API integration, GITHUB_TOKEN in backend Env.
