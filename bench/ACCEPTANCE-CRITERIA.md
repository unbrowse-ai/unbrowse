# Unbrowse — Acceptance Criteria, Tests & Benchmarks

What unbrowse stands for, made falsifiable. Every row maps a **claim** (from a paper or a
stated goal) → **acceptance criteria** (the bar that counts as true) → **the test/witness**
(a runnable proof in this repo) → **the external benchmark** to measure against (no fabricated
green; honest negatives stay honest).

Sources of truth: `paper/*.tex` (the theses), `bench/CAPABILITY-BENCH-PLAN.md` (the four axes),
`bench/north-star-gate.sh` + `bench/capability/gate_*.sh` (the gates), the `tests/` suite, and
`CLAUDE.md` (the standing goals). Status legend: ✅ witnessed green · 🟡 partial / reader-bound ·
⬜ named-open (no fabricated green).

---

## Part 1 — Paper theses (the goals unbrowse stands for)

### P1. Internal APIs Are All You Need — `paper/internal-apis-are-all-you-need.tex`
**Claim.** The front-end's own API calls are learnable once and replayable by anyone; resolve an
intent to a ranked shortlist of real endpoints (HTML page == internal API == one parameterized-GET
hole shape).

| AC | Bar | Test / witness | Benchmark |
|---|---|---|---|
| AC1.1 resolve coverage | `eval resolve <intent>` returns a ranked shortlist whose top-k endpoints are relevant; **abstains** when none exist | `bench/capability/gate_axisA.sh`; `tests/orchestrator-autowalk.test.ts` | **ToolRet** (retrieval), **Exa** clone `bench/exa/` |
| AC1.2 replay | a captured route replays the same value cross-session via the resolution ledger | `tests/cached-resolution.test.ts` ✅ | — |
| AC1.3 HTML==API parity | HTML pages and internal APIs resolve through the **same** hole shape (`extractHtmlHoles`) | `tests/*hole*`, `src/values/cardinality.ts` | — |
| AC1.4 generalize, never hard-filter | adding a new site/shape needs **zero** new allowlist entries (structural recognition) | cardinality gate `cardinalityMatches` | corpus `/unbrowse-corpus-bench` |

### P2. Execute, Don't Guess — `paper/execute-dont-guess.tex`
**Claim.** Don't hallucinate an answer — execute the real call and ground the result in returned bytes.

| AC | Bar | Test / witness | Benchmark |
|---|---|---|---|
| AC2.1 no fabrication | resolve's web-fallback never returns off-domain/generic data for an unrelated site (domain-anchored) | `anchorHitsToDomain` (orchestrator), `tests/orchestrator-autowalk.test.ts` ✅ | corpus per-site report |
| AC2.2 groundedness | answers are grounded in executed bytes, scored vs Exa published | `bench/exa/score_extraction.py` + `bench/exa/unbrowse_searcher.py` | **Exa** `github:exa-labs/benchmarks` (ROUGE-L / groundedness) 🟡 reader-bound |
| AC2.3 abstain over guess | empty/auth-required results are NOT cached as success | `cachedResolution.cacheable` gate ✅ | **AssistantBench** |

### P3. Energy-Based Route Ranking — `paper/energy-route-ranking.tex`
**Claim.** Rank candidate routes by an energy/relevance score (low energy = most relevant), beat naive ordering.

| AC | Bar | Test / witness | Benchmark |
|---|---|---|---|
| AC3.1 ranking quality | the chosen route's top endpoint is the one that returns the intent's data more often than FIFO/keyword | `bench/capability/gate_axisA.sh` (ranked top-k) | **ToolRet**, **BFCL** (function-call selection) |
| AC3.2 latency beat | warm cached resolve beats Exa head-to-head on latency | memory `project-beat-exa-latency` (996ms vs 2441ms) ✅ | Exa live A/B |

### P4. Crypto Was All You Needed — `paper/crypto-was-all-you-needed.tex`  *(the just-wired layer)*
**Claim.** Every resolution persists wallet-signed, append-only, on the right on-chain ledger primitive (IQLabs), with values sealed (zk) and pointers public; credential sovereignty + x402 settlement.

| AC | Bar | Test / witness | Benchmark |
|---|---|---|---|
| AC4.1 signed ledger | each resolution row is ed25519-signed + hash-chained; tamper → verify fails | `tests/iq-ledger.test.ts` ✅ (signed rows + chain verify) | — |
| AC4.2 on the IQ primitive | resolve persists through `AsyncResolutionLedger` → IQLabs on-chain (mainnet round-trip) | `tests/iq-mirror-resolution.test.ts` ✅; opt-in `IQ_E2E=1` live | Solana mainnet |
| AC4.3 resolve→IQ wired | both resolve seams (cli `storeResolution`, orchestrator `cachedResolution`) mirror to IQ, fail-open | `tests/cached-resolution.test.ts` + `iq-mirror-resolution.test.ts` ✅ **22 pass** | — |
| AC4.4 zk values sealed | payload sealed per-row (XChaCha20-Poly1305), pointers stay public; cold-hydrate recovers | `tests/iq-sealed-value.test.ts` + `iq-cold-hydrate.test.ts` ✅ **9 pass** | — |
| AC4.5 credential sovereignty | secrets → wallet-bound commitments; server sees only commitments | `docs/whitepaper/credential-sovereignty.md`; hole-descent spine | — |
| AC4.6 x402 settlement | owner-credit settles on a real chain round-trip | `scripts/flex-devnet-settle.mjs` (devnet) 🟡 mainnet-escrow open | — |

### P5. Internal APIs Were NOT All You Needed — `paper/internal-apis-were-not-all-you-needed.tex` *(the honest sequel)*
**Claim.** Pure internal-API replay is insufficient for auth-walled, JS-rendered, anti-bot sites — the gaps unbrowse must close.

| AC | Bar | Test / witness | Benchmark |
|---|---|---|---|
| AC5.1 JS-render escalation | thin-fetch escalates to a real browser when the body needs JS | `bench/exa/unbrowse_searcher.py` extract escalation 🟡 | corpus SPA tier |
| AC5.2 anti-bot egress | throttled egress auto-escalates to clean IP / residential proxy | memory `bench-self-throttle` ✅ (OLD 0 → NEW 5); `src/execution/egress-chain.ts` | corpus anti-bot tier |
| AC5.3 auth-walled | authed READ/CREATE works behind a logged-in session | Axis C below | **WASP**, **ST-WebAgentBench** ⬜ |

---

## Part 2 — Capability axes (the four-axis bench, `bench/CAPABILITY-BENCH-PLAN.md`)

Run against the **npm-installed shipped CLI** via `UNBROWSE_BIN`; two-witness gate `bench/capability/gate_all.sh` + `history.jsonl`; OpenRouter judge key gitignored.

| Axis | Capability | Acceptance bar | Gate | External benchmark |
|---|---|---|---|---|
| **A** | Action-retrieval / indexing **coverage** | top endpoints relevant + abstain when none exist | `gate_axisA.sh` | **ToolRet**, Exa |
| **B** | Execution **without auth** (public) | chosen endpoint returns the real public data the intent asked for | `gate_real.sh` | **Exa**, **WebBench**, **AssistantBench** |
| **C** | Execution **with auth** (logged-in) | authed READ/CREATE/UPDATE/DELETE succeed against a logged-in session | (auth gate) | **WASP**, **ST-WebAgentBench** |
| **D** | **Security** auditing | leak-scan **100% clean** (hard gate); targeted-ASR ≤ AgentDojo defended baseline; CuP ≥ ST baseline | `bench/capability/audit_security.py` ✅ (deterministic leak-scan core, red+green witnessed — catches raw/url-enc/base64 secret values, zero-tolerance `--gate`); ASR/CuP ⬜ external harness | **AgentDojo**, **InjecAgent**, **ST-WebAgentBench** |

**Gate thresholds (honest-start, ratchet up):**
- A: coverage ≥ published ToolRet/Exa on the DNS-live corpus (raw coverage capped by ~27% DNS-dead corpus — see `bench-corpus-dns-dead-ceiling`; on-target "working well" ≈ 96.7% PASS).
- B: groundedness scored vs Exa (reader-bound at ~0.5 vs 0.79 — `capability-bench-groundedness-ceiling`, honest negative).
- C: authed CRUD success rate vs WASP sandbox.
- D: leak-scan **100%** is non-negotiable (the redaction invariant); ASR/CuP from published defended numbers.

**North-star named capabilities:** `bench/north-star-gate.sh` (14/14 = 100% on named capabilities).

---

## Part 3 — Standing invariants (CLAUDE.md goals, every release)

| Invariant | Bar | Gate |
|---|---|---|
| Paper reflects code | every `[shipped]` claim maps to a real repo anchor in `paper/anchors.tsv` | `scripts/paper-gate.sh` ✅ |
| No moat leak | no economic/engine-internal terms on public surfaces | `scripts/leak-guard.sh` ✅ |
| Two-witness, no fabricated green | every capability number reproduced across two independent witnesses + `history.jsonl` | `bench/capability/gate.sh` |
| Type-regression ratchet | tsc error count is monotone non-increasing | `scripts/tsc-ratchet.sh` (baseline 202) ✅ |
| Local runtime authority | CLI/MCP execute in-process; no auto-spawned Fastify daemon | `--no-auto-start` visible in debug notes |

---

## How to run

```bash
# capability four-axis (shipped CLI, two witnesses)
UNBROWSE_BIN=$(which unbrowse) bash bench/capability/gate_all.sh
# the real cloned Exa run
python3 bench/exa/score_extraction.py
# Axis-D security leak-scan (deterministic, zero-tolerance gate)
python3 bench/capability/test_audit_security.py   # red+green witness
python3 bench/capability/audit_security.py --artifacts <jsonl> --secrets <file> --gate
# crypto/IQ ledger layer (signed + zk + resolve→IQ wire)
bun test tests/iq-ledger.test.ts tests/iq-mirror-resolution.test.ts \
         tests/iq-sealed-value.test.ts tests/iq-cold-hydrate.test.ts \
         tests/cached-resolution.test.ts
# named-capability north star
bash bench/north-star-gate.sh
```

**The bar that matters:** a claim counts as true only when its witness exits 0 across two
independent runs and the number is real. Honest negatives (groundedness reader-bound; DNS-dead
corpus ceiling; mainnet x402 escrow open) are recorded as ⬜/🟡, never painted green.
