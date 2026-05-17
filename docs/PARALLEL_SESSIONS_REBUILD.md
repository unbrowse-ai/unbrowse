# Parallel Browse Sessions: Rebuild Spec

Status: PHASE 1 COLLAPSED UNDER EVIDENCE (see the Phase 1 section).
Authored 2026-05-17 from in-thread design + three read-only code maps;
then empirically tested with real concurrent app.inject. Finding:
current code already isolates concurrent browse sessions at N<=6 with
zero crosstalk; the parallel rebuild is smaller than first specced
(Phase 2 determinism + collector + skill amendment; Phase 1 is a
non-bug). No code changed by this document.

## Goal

Make N concurrent `unbrowse` browse sessions correct against ONE shared
Chrome, then run the 58-probe MCP release gate with a bounded non-LLM
parallel collector, without weakening the gate's load-bearing contract
(agent judges in-thread vs `GATE_JUDGE.md`; no second LLM renders a
verdict; no script derives PASS/FAIL).

## Non-goals

- Not a mid-gate code pivot. The current serial run finishes to a valid
  `stamp.mcp.json` first; that stamp is the baseline the parallel build
  must reproduce.
- Not multi-Chrome process isolation (deferred; Phase 4). Phases 1+2 are
  sufficient for the public gate corpus.
- Not sub-agent collection. The collector is a deterministic process,
  never a second LLM. Rejecting Explore-agent-3's amendment framing;
  memory `feedback_agent_is_the_harness`, `feedback_harness_is_for_main_agent`.

## Diagnosis: what actually forces serialization

Three independent shared resources, pinned to real file:line.

### D1. Session to tab identity is URL-inferred, not bound

The session layer never owns a tab; it re-derives "my tab" by URL match,
silently adopting the wrong one when URLs are indistinguishable. Same
disease as the three kuri bugs just shipped.

- `src/api/browse-session.ts:313-448` `isBrowseSessionLive`, the
  adoption ladder.
- `src/api/browse-session.ts:360-372` "adopt lone tab after id drift"
  (most dangerous: silent `session.tabId = lone.id` rebind).
- `src/api/browse-session.ts:397-420` "fallback to meaningful url /
  currentUrl" (returns live on all-placeholder).
- `src/api/browse-session.ts:269-301` `adoptExistingBrowseTab` (creation
  path adopts any idle tab matching preferred URL).
- `src/api/browse-session.ts:121-127` `matchesPreferredBrowseTab`
  (host+path heuristic; dead once adoption dies).
- `src/api/browse-session.ts:496-526` `getOrCreateBrowseSession`
  (L503-524 re-adopt-by-URL dispatch).

Broker reality (good news): the Zig bridge already supports N isolated
targets in one Chrome.
- `submodules/kuri/src/bridge/bridge.zig:49-72` Bridge with
  `tabs`/`current_tabs`/`cdp_clients` + `mu` RwLock.
- `submodules/kuri/src/bridge/bridge.zig:254-271`
  `setCurrentTab(session_id, tab_id)`, explicit binding primitive ALREADY
  EXISTS, just not called on tab creation.
- `submodules/kuri/src/server/router.zig:4281-4335` `handleTabNew`
  creates the target, returns `targetId`, does NOT record a binding.
- `src/kuri/client.ts:1294-1335` `newTab(url?)`, no `sessionId` param.
- `src/kuri/client.ts:1140-1164` `resolveCdpDebuggerUrlForTab`, already
  exact-id lookup (the inference is purely the session layer).

### D2. resolve reads a process-global index that publish mutates mid-run

- Cross-probe bleed source: `src/client/index.ts:40`
  `const recentLocalSkills = new Map<string, SkillManifest>()`, process
  global, never cleared between probes.
- Write site: `src/indexer/index.ts:298-299` -> `cachePublishedSkill` ->
  `src/client/index.ts:1088-1091` `recentLocalSkills.set(...)`.
- Disk write: `src/orchestrator/index.ts:305-315` `writeSkillSnapshot`.
- Domain cache: `src/indexer/index.ts:306-314` + `persistDomainCache`.
- Resolve read seam: `src/orchestrator/index.ts:359-365`
  `readSkillSnapshot` (single point where index state becomes visible to
  resolve); resolve entry ~`src/orchestrator/index.ts:1976-2000`.

Real product behavior (the shared graph IS the product). For the GATE it
makes per-probe `resolve.shortlist` order-dependent and racy.

### D3. The session map and auth profiles are unlocked global state

- `src/api/routes.ts:247` `const browseSessions = new Map(...)`, global,
  mutated by concurrent route handlers with no mutex.
- `src/api/browse-session.ts:68` `sessionQueues` Map + `:547-562`
  `withSessionQueue`, per-session FIFO EXISTS, but the Map ops around it
  and all cross-session reads are unprotected.
- `src/api/routes.ts:469-494` `resolveRequestedBrowseSession` +
  `:484-492` already throws `session_id_required` when >1 live session
  and no id given (existing parallel guard, keep and build on it).
- `src/api/routes.ts:321-335` `selectBrowseBrokerClient` iterates
  `browseSessions.values()` while other handlers mutate it.
- Auth collision: `src/auth/index.ts:106,125`
  `authProfileSave/Load(tabId, domain)` keyed by DOMAIN not session; two
  sessions on the same domain in parallel cross-contaminate the Keychain
  profile and the `auth:${domain}` vault entry.

## Plan (phased; ordered; target-binding FIRST)

Each phase ships with a real-kuri falsifier (no mocks, per CLAUDE.md) and
deletes the heuristic it replaces. Sequencing is load-bearing: parallel
collection on today's code reinstates exactly the contamination just
fixed.

### Phase 1 - COLLAPSED UNDER EVIDENCE (no reproducible bug)

EMPIRICAL FINDING (2026-05-17, real getInProcessApp + concurrent
app.inject, no mocks; harnesses `.bench-gate/parallel-go-falsifier.ts`
and `.bench-gate/parallel-crosstalk-observe.ts`, observe-mode, gitignored):

- Scenario A - 3 concurrent `POST /v1/browse/go`, SAME url, NO
  session_id: 3/3 distinct session_ids, 3/3 distinct tab_ids, every
  `snap.current_url` correct. Concurrent auto-id creation already
  isolates. The hypothesized `adoptExistingBrowseTab` cross-binding did
  NOT reproduce.
- Scenario B - 3 concurrent go with explicit caller-named session_ids:
  all `404 session_not_found`. `go` does not create caller-named
  sessions; it mints auto-ids. Contract fact, not a parallel-safety hole.
  Implication: a parallel collector MUST use the auto-id returned by go
  and thread it through snap/close (Scenario A/C prove that works).
- Scenario C - 6 concurrent go with 6 DISTINCT urls, snap each by its
  OWN returned session_id: 6/6 distinct session_ids, 6/6 distinct
  tab_ids, 6/6 `snap.current_url` host == intended host, ZERO crosstalk.

Conclusion: the three already-shipped kuri fixes (about:blank startup
tab, meaningful-url drift adopt, sibling-session closeTarget) were
SUFFICIENT to make concurrent browse sessions safe at N<=6. Phase 1 as
scoped (authoritative session->targetId binding to fix concurrent
contamination) has NO reproducible bug. D1 was wrong; tracing then
empirical observation corrected it. No fix is written, because inventing
a failing test for a non-bug is the inverse painted lamp (memory
`no_fake_momentum`, substrate principle).

Residual Phase-1-adjacent work that IS real (carried into the plan):

- The L360-372 lone-drift adopt and the unlocked `browseSessions` map
  (D3) were NOT individually stress-falsified; Scenario C exercised them
  in aggregate and they held. Keep as Phase 3 review items, not a
  blocking rewrite. Do NOT delete `adoptExistingBrowseTab` /
  `isBrowseSessionLive` heuristics on spec-authority alone - the
  evidence says they are not causing the contamination class.
- Higher-N (12+) and heavy-page concurrency remain unobserved; the
  collector itself (bounded K=6) is the natural place to observe that,
  with Scenario C's per-session current_url-host==intended invariant as
  the built-in self-check (NOT a separate pre-fix falsifier - there is
  no pre-fix bug to falsify).
### Phase 2, resolve snapshot isolation

- Freeze `recentLocalSkills` (`src/client/index.ts:40`) + the disk
  snapshot view at resolve entry (~`src/orchestrator/index.ts:1976`);
  every read for that resolve call goes through the frozen view, not the
  live map. Seam: wrap `readSkillSnapshot` (`:359-365`) +
  recentLocalSkills reads behind a per-call snapshot handle.
- Gate runs against a frozen index baseline: each probe's
  `resolve.shortlist` becomes a pure function of (baseline, this probe's
  own just-closed capture). Order-independent so parallel-safe AND more
  deterministic than today's serial run (probe-002-reads-probe-001 is
  current tolerated flakiness).
- Falsifier: two concurrent resolves while a publish is in flight; assert
  each resolve's shortlist == its single-probe serial shortlist.

### Phase 3, per-session locking + auth isolation

- Mutex around `browseSessions` lifecycle (`routes.ts:247` create/get/
  delete) and the `selectBrowseBrokerClient` iteration (`:321-335`);
  snapshot the map before iterating.
- Auth: key Keychain/vault by `sessionId:domain` OR a per-domain lock
  around `authProfileSave/Load` (`auth/index.ts:106,125`) and the
  `auth:${domain}` vault write. Public gate corpus is mostly anonymous so
  per-domain lock is enough; per-session keying is the stronger option if
  authed probes are added.
- Falsifier: 4 sessions, 2 on the same domain; assert no cross-session
  cookie/profile bleed; assert no lost session-map entries under
  concurrent create/drop.

### Phase 4 (DEFERRED), per-worker Chrome

Only if hard isolation is later required. ~150-300MB/Chrome; `src/kuri/
client.ts:204-214` already shards `BrokerState`/`brokerClients` by port,
so the seam exists; auth-profile Keychain would need per-worker
namespacing. Out of scope for the first parallel gate.

## Gate changes (preserving the contract)

The "no sub-agents / agent is the harness" rules are about WHO JUDGES,
not wall-clock. Legitimate split:

- Collection (go->snap->close->resolve->execute -> write 8 raw artifact
  files): pure mechanical I/O, zero verdicts. A bounded (4-8, not 30, the
  bound is CPU/GPU/CDP throughput physics) NON-LLM worker pool runs the
  deterministic sequence per probe against Phase-1 isolated sessions vs
  the Phase-2 frozen baseline. Artifacts per
  `~/.claude/skills/unbrowse-mcp-gate/references/artifact-contract.md:46-55`.
- Judgment: unchanged. The single in-thread agent reads all 58 probes'
  artifacts vs `harness/probes/GATE_JUDGE.md:68-130` (quote rule
  L120-130), writes `verdict.json`
  (`scripts/bench-gate-judge.ts:26-35` schema), `--validate`, then
  `scripts/bench-gate-compare.ts` (thresholds
  `harness/probes/bench-gate-baseline.json`: index>=0.8, retrieve>=0.65,
  anchor_must_pass, max_new_suspicious_hostile<=0) -> stamp. Comparator
  and stamp untouched.

New artifact: `scripts/mcp-gate-parallel-collect.ts` (non-LLM). Takes
manifest, runs a worker pool of size K (env, default 6), each worker
owns a distinct `session_id`, writes the 8 files per probe. Emits NO
verdict column. This is the only new gate code.

## SKILL.md amendment (NEEDS USER SIGN-OFF, load-bearing rule)

Do NOT rewrite unilaterally (substrate principle). The lines that
conflate two constraints, at `~/.claude/skills/unbrowse-mcp-gate/
SKILL.md` (the "Diagnose substrate" para and Hard rule 2):

- KEEP (load-bearing): the verdict is rendered in-thread by the calling
  agent vs `GATE_JUDGE.md`; no second LLM, no sub-agent, no `codex`/
  `claude` exec renders or derives a verdict; no script derives PASS/FAIL;
  MCP-only collection surface.
- AMEND (incidental): "the calling agent itself drives the MCP tools"
  currently reads as "the single agent must personally issue every tool
  call serially." Replace with: collection MAY be performed by a
  deterministic NON-LLM collector process against Phase-1-isolated
  sessions; the calling agent still reads every probe's raw artifacts and
  judges in-thread. Explicitly NOT sub-agents / NOT a second LLM
  (rejecting Explore-agent-3's "sub-agents may collect" wording).

Rationale for sign-off: the rule's intent ("no LLM-judged probes, no
heuristic verdict") is fully preserved; only the incidental "one agent,
serial, by hand" implementation constraint, which existed solely because
the substrate could not guarantee isolated collection, is lifted, now
that Phase 1+2 guarantee it.

## Sequencing + recommendation

1. Finish the current serial 58-probe run to a valid `stamp.mcp.json`.
   That stamp is the correctness oracle: the parallel build must
   reproduce the same per-probe verdicts.
2. Phase 1 (target binding), biggest leverage, extends shipped kuri
   fixes. Falsifier-gated.
3. Phase 2 (resolve snapshot), unblocks deterministic parallel resolve.
4. Phase 3 (locking + auth).
5. Build `mcp-gate-parallel-collect.ts`; get SKILL.md amendment signed
   off; run the parallel gate; assert verdict parity with the Phase-0
   serial stamp before trusting it.

Realistic scope: multi-week, ordered, falsifier-gated per phase, no
mocks, no `--no-verify`, PR-only. Phase 1 alone is the highest-value
slice and is independently shippable (it also further hardens the serial
gate).
