# unbrowse-recompute-tiers criteria

Built from 19 evidence records (code, grep, memory, decision), distilled from
the codebase + the dag-recompute north-star memory. Zero Reddit: the criteria
for these tiers are already declared in the north-star gap table, the
freshness four-layer template, and docs/deep-reveng.md. Source dump:
`.evidence-build/unbrowse-recompute-tiers/evidence-*.jsonl`.

North star: every captured token is a typed node in the operation DAG with
requires/yields edges; resolve+execute walks the chain and recomputes at
runtime. Not flat curl caching. The three tiers close the three recompute
classes the north star tracks: shipped (T1), open (T2), corrected-override
(T3).

## Pass criteria

- **tier2-storage-binding-source**: Capture reads `localStorage` and
  `sessionStorage` at session end and declares each captured value as a
  `yields` entry on an `OperationBinding`, populated via the four-layer
  freshness template (type field, pure helper, capture-side population in
  the reverse-engineer layer, execute-side consumption). After a capture of
  a site that holds its auth/csrf token in web storage,
  `buildSkillOperationGraph` contains a producer node for that binding key,
  and `executeEndpointWithChain` recomputes it on a later session by
  re-deriving the value, not replaying a dead one. Falsifier: a probe site
  whose token lives only in `localStorage` resolves to a chain that the
  walk can refetch; before the fix the chain has no producer for it.
  Sources: [grep:localStorage-sessionStorage-src-zero, memory:project-dag-recompute-north-star#L34-localstorage-OPEN, code:src/reverse-engineer/index.ts#storage-not-read, grep:cookies-vault-only, memory:feedback-freshness-binding-pattern#four-layer]

- **tier3-sandbox-replay-yields-binding**: `runBundleReplay` output (the
  recomputed bundle token: `_px3`, `msToken`, signed-url param, HMAC) is
  registered as a declared `semantic` `yields` `OperationBinding`, wired
  into `buildSkillOperationGraph` as a producer node, so the chain walk
  recomputes it every call via `runBundleReplay` instead of only inside a
  one-shot challenge-retry arm. Falsifier: after the fix, a captured skill
  for a PerimeterX-gated endpoint carries a bundle-replay producer binding;
  re-executing it on a fresh session triggers a `chain_walk_refetched_*`
  step that calls `runBundleReplay`, not a stale cookie replay. Symbolic
  execution is explicitly NOT the mechanism.
  Sources: [code:src/sandbox/bundle-replay-client.ts#runBundleReplay, code:src/execution/px-challenge.ts#solvePxAndRetry, code:src/execution/px-challenge.ts#cookies-not-yields, decision:askuserquestion-2026-05-17-tier3-finish-deepreveng, code:docs/deep-reveng.md#symbolic-loses]

- **tier3-step-dominion-arms**: `solveAkamaiAndRetry`
  (`src/execution/akamai-challenge.ts`) and the Kasada solver
  (`src/execution/kasada-challenge.ts`) invoke `runBundleReplay` and return
  solved cookies, mirroring the working PerimeterX `solvePxAndRetry` shape,
  rather than the pinned STUB that returns null. Falsifier: the
  Step 6 Dominion grep markers no longer guard a null-returning stub; the
  challenge dispatch in `src/execution/index.ts` has live Akamai and Kasada
  arms siblings to the PX arm at 3601.
  Sources: [grep:step-dominion-stubs, code:src/execution/px-challenge.ts#solvePxAndRetry, decision:askuserquestion-2026-05-17-tier3-finish-deepreveng]

- **tier1-chain-walk-regression-proof**: The shipped freshness binding
  recompute path (`ttl_ms`/`single_use` on the binding,
  `isBindingStale` pure predicate, `executeEndpointWithChain` walk,
  `augmentBindingsWithFreshness` capture population) is covered by a
  mutation-tested regression suite plus a bench probe so a future change
  cannot silently drop CSRF recompute. Falsifier: deliberately breaking
  `isBindingStale` (return false always) or removing the
  `chain_walk_refetched_success` emit makes the suite fail; today no test
  pins that end to end across the four layers.
  Sources: [code:src/types/skill.ts#L98-99-freshness-fields, code:src/execution/index.ts#executeEndpointWithChain-L4084, code:src/orchestrator/dag-feedback.ts#isBindingStale-L154, code:src/reverse-engineer/index.ts#augmentBindingsWithFreshness, memory:project-dag-recompute-north-star#L32-33-shipped, memory:feedback-freshness-binding-pattern#four-layer]

- **tier-cross-vendored-mirror-parity**: Every capture/graph-layer change
  made for T2 or T3 keeps `packages/skill/runtime-src/graph/index.ts`
  byte-identical to its `src/` origin (ADR-001 Site 5), so the shipped npm
  CLI binary does not diverge from source. Falsifier: a T2/T3 commit
  touching the graph layer without the matching vendored-mirror update is
  caught by the parity check before the wave closes.
  Sources: [memory:feedback-freshness-binding-pattern#L18-vendored-mirror]

## Out of scope

- Symbolic execution / source-map to AST static-algorithm derivation of
  anti-bot bundles. Rejected by `docs/deep-reveng.md` ("Per-vendor research
  project. Bundle rotates daily. Loses.") and the north-star L40 do-not-solve
  row. Encoded below as the adversarial guardrail `adv-no-symbolic-execution`,
  not as a build lane.
- Captcha / proof-of-work tokens with no observable network producer, and
  TLS/canvas fingerprint-bound tokens. Unchanged north-star non-goals.

## Rubric (machine-readable)

```yaml
lanes:
  - id: tier2-storage-binding-source
    description: Capture reads localStorage and sessionStorage and declares each as a yields OperationBinding via the four-layer freshness template so the chain walk recomputes a storage-held token.
    source_ids: [grep:localStorage-sessionStorage-src-zero, memory:project-dag-recompute-north-star#L34-localstorage-OPEN, code:src/reverse-engineer/index.ts#storage-not-read, grep:cookies-vault-only, memory:feedback-freshness-binding-pattern#four-layer]
    bench_signal: |
      echo "== storage reads in src (excluding the bundle-replay doc comment) =="
      grep -rn -E "localStorage|sessionStorage" src --include=*.ts | grep -v "bundle-replay-client.ts" || echo "NO_STORAGE_READS"
      echo "== capture-side binding population site =="
      grep -rn -E "augmentBindingsWithFreshness|inferProvidesFromFields|semantic.*provides|yields" src/reverse-engineer --include=*.ts | head -20
      echo "== does any binding source declare a storage origin =="
      grep -rn -E "storage|localStorage|sessionStorage" src/graph src/reverse-engineer --include=*.ts | head -20 || echo "NONE"
    pass_when: src contains a capture-side read of localStorage/sessionStorage at session end (beyond the bundle-replay-client.ts doc comment) that constructs an OperationBinding whose yields carries the storage-held key, and the four-layer template (type, pure helper, capture population, execute consumption) is present. Before the fix this output shows only the doc comment and no storage-origin binding.
  - id: tier3-sandbox-replay-yields-binding
    description: runBundleReplay output is registered as a declared semantic yields OperationBinding and wired into buildSkillOperationGraph so the chain walk recomputes the bundle token every call, not only in a challenge-retry arm.
    source_ids: [code:src/sandbox/bundle-replay-client.ts#runBundleReplay, code:src/execution/px-challenge.ts#solvePxAndRetry, code:src/execution/px-challenge.ts#cookies-not-yields, decision:askuserquestion-2026-05-17-tier3-finish-deepreveng, code:docs/deep-reveng.md#symbolic-loses]
    bench_signal: |
      echo "== runBundleReplay call sites =="
      grep -rn -E "runBundleReplay" src/execution --include=*.ts | head -20
      echo "== is bundle replay output a yields/provides binding =="
      grep -rn -E "yields|provides|semantic" src/execution/px-challenge.ts src/sandbox/bundle-replay-client.ts | grep -iE "bundle|replay|px|binding" || echo "NO_BUNDLE_YIELDS_BINDING"
      echo "== buildSkillOperationGraph producer for a bundle token =="
      grep -rn -E "bundle|replay|px3|msToken|hmac" src/graph/index.ts || echo "NO_GRAPH_NODE_FOR_BUNDLE_TOKEN"
    pass_when: solvePxAndRetry (or a shared helper) emits the recomputed token as a semantic yields OperationBinding that buildSkillOperationGraph turns into a producer node, and executeEndpointWithChain can refetch it via runBundleReplay on a later session. Before the fix the output shows runBundleReplay only in challenge-retry arms and NO_BUNDLE_YIELDS_BINDING.
  - id: tier3-step-dominion-arms
    description: Akamai and Kasada solvers invoke runBundleReplay and return solved cookies mirroring the working PerimeterX shape, replacing the pinned Step 6 Dominion null STUB.
    source_ids: [grep:step-dominion-stubs, code:src/execution/px-challenge.ts#solvePxAndRetry, decision:askuserquestion-2026-05-17-tier3-finish-deepreveng]
    bench_signal: |
      echo "== akamai solver =="
      grep -n -E "STUB|return null|Step 6 Dominion|runBundleReplay|solveAkamaiAndRetry" src/execution/akamai-challenge.ts
      echo "== kasada solver =="
      grep -n -E "STUB|return null|Step 6 Dominion|runBundleReplay|solveKasada" src/execution/kasada-challenge.ts
      echo "== challenge dispatch arms =="
      grep -n -E "solvePxAndRetry|solveAkamaiAndRetry|solveKasada|solveCfAndRetry" src/execution/index.ts
    pass_when: akamai-challenge.ts and kasada-challenge.ts call runBundleReplay and return solved cookies (not the null STUB), and src/execution/index.ts dispatches live Akamai and Kasada arms as siblings of the PX arm. Before the fix both files show STUB / return null pinned until Step 6 Dominion.
  - id: tier1-chain-walk-regression-proof
    description: The shipped four-layer freshness recompute path gains a mutation-tested regression suite plus a bench probe so CSRF recompute cannot silently regress.
    source_ids: [code:src/types/skill.ts#L98-99-freshness-fields, code:src/execution/index.ts#executeEndpointWithChain-L4084, code:src/orchestrator/dag-feedback.ts#isBindingStale-L154, code:src/reverse-engineer/index.ts#augmentBindingsWithFreshness, memory:project-dag-recompute-north-star#L32-33-shipped, memory:feedback-freshness-binding-pattern#four-layer]
    bench_signal: |
      echo "== freshness binding test files =="
      ls -la tests/binding-staleness.test.ts tests/*chain*walk*.test.ts 2>&1 || echo "NO_CHAIN_WALK_TESTS"
      echo "== run staleness + chain-walk suite =="
      bun test tests/binding-staleness.test.ts 2>&1 | tail -25 || echo "SUITE_MISSING_OR_FAILING"
      echo "== chain_walk decision-trace emit count =="
      grep -c "chain_walk_" src/execution/index.ts
    pass_when: a regression suite exists that pins all four layers end to end (type field present, isBindingStale monotonic, executeEndpointWithChain emits chain_walk_refetched_success on a stale producer, augmentBindingsWithFreshness populates ttl/single_use) and passes, such that mutating isBindingStale or removing the refetch emit fails it. Before the fix there is no end-to-end pin across the four layers.
  - id: tier-cross-vendored-mirror-parity
    description: T2/T3 capture or graph-layer changes keep packages/skill/runtime-src/graph/index.ts byte-identical to its src origin so the shipped CLI binary does not diverge.
    source_ids: [memory:feedback-freshness-binding-pattern#L18-vendored-mirror]
    bench_signal: |
      echo "== vendored mirror presence =="
      ls -la src/graph/index.ts packages/skill/runtime-src/graph/index.ts 2>&1
      echo "== byte diff src vs vendored mirror =="
      diff -q src/graph/index.ts packages/skill/runtime-src/graph/index.ts && echo "MIRROR_IN_SYNC" || echo "MIRROR_DRIFT"
      echo "== uncommitted graph-layer changes =="
      git status --porcelain -- src/graph src/reverse-engineer packages/skill/runtime-src 2>/dev/null | head
    pass_when: after the T2/T3 commits, src/graph/index.ts and packages/skill/runtime-src/graph/index.ts are byte-identical (MIRROR_IN_SYNC), or any drift is intentional and explained in the commit. A T2/T3 change to the graph layer without the matching mirror update is a fail.
  - id: adv-no-symbolic-execution
    description: GUARDRAIL. No source-map / AST / symbolic-execution bundle analyzer is introduced; the rejected approach must stay absent.
    source_ids: [code:docs/deep-reveng.md#symbolic-loses, memory:project-dag-recompute-north-star#L40-js-computed-declined]
    bench_signal: |
      echo "== symbolic-exec / parser deps that would signal the rejected approach =="
      grep -rn -E "symbolic|sourcemap|source-map|astexplorer|@babel/parser|acorn|esprima|@babel/traverse" src --include=*.ts | grep -viE "\.test\.|comment|//|/\*" || echo "CLEAN_NO_SYMBOLIC"
      echo "== package.json new parser deps =="
      grep -nE "acorn|esprima|@babel/parser|@babel/traverse|source-map" package.json || echo "NO_PARSER_DEPS"
    pass_when: output is CLEAN_NO_SYMBOLIC and NO_PARSER_DEPS. Any introduced source-map/AST/symbolic-execution machinery to derive bundle token math statically is a fail; the substrate solves this by running the bundle in the sandbox, not by reversing it.
  - id: adv-no-per-domain-token-registry
    description: GUARDRAIL. No per-domain token recipe / host=== registry is introduced for bundle or storage tokens; the recompute must be substrate-generic.
    source_ids: [decision:askuserquestion-2026-05-17-tier3-finish-deepreveng, memory:project-dag-recompute-north-star#L40-js-computed-declined]
    bench_signal: |
      echo "== CLAUDE.md per-domain audit grep =="
      grep -rnE 'host === "[a-z]' src/ | grep -v 'auto"\|unknown"\|codex"\|claude"' || echo "CLEAN_NO_HOST_REGISTRY"
      echo "== skill.domain === registries =="
      grep -rnE 'skill\.domain === "|domain === "[a-z]' src/ --include=*.ts | grep -viE "\.test\." || echo "CLEAN_NO_DOMAIN_REGISTRY"
    pass_when: output is CLEAN_NO_HOST_REGISTRY and CLEAN_NO_DOMAIN_REGISTRY (modulo pre-existing audited entries). A new `if host === "<domain>"` token-recipe registry for T2 storage or T3 bundle tokens is a fail; sandbox replay and the binding template are domain-agnostic by construction.
out_of_scope: []
adversarial: [adv-no-symbolic-execution, adv-no-per-domain-token-registry]
```
