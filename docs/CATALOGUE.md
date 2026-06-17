# Unbrowse Catalogue — every doc and every code subsystem of value

> The single navigable index for the repo. Part A maps the documentation tree;
> Part B maps the code (`src/`, `backend/`, `frontend/`, `packages/`) to a
> one-line responsibility and an entry path. Use it to find the right doc, or the
> right module, in one hop.

> Generated 2026-06-17 against build v9.4.12 (`src/build-info.generated.ts`,
> git `ae37bf4a`). Every path here is real; the four architecture deep-dives it
> points to cite their own anchors. For prose start at [README.md](./README.md);
> for the system map start at [architecture/OVERVIEW.md](./architecture/OVERVIEW.md).

---

## Part A — Documentation map

### Read-by-audience (the published spine — see [SUMMARY.md](./SUMMARY.md))
| Path | For whom | Subject |
|---|---|---|
| `start-here/` (4) | newcomers | What Unbrowse is, the browser-discovery tax, the shared route graph, plain English |
| `for-agents/` (6) | agent builders | How an agent fills the hole, resolve/execute, MCP, when it browses, search, wallets |
| `for-developers/` (6) | integrators | Integration surfaces, route lifecycle, SDK quickstart, drop-in/python/agent-SDK adapters |
| `concepts/` (7) | everyone | Shadow APIs, route-graph-as-asset, trust, evaluation, verification, fare splits, claiming |
| `for-investors/` (2) | investors | The wedge, market framing |
| `sdk/` (5) | builders | Build archetypes, recipes, onboarding users/validators, rewards & economics |
| `whitepaper/` (14) | research | Companion text to the published paper trilogy |
| `built-on-unbrowse/` (2) | builders | Reference consumers (Aiko) |
| `guides/quickstart.md` | new users | Install + first run |

### Architecture (`architecture/` — code-grounded, cite real paths)
| Path | Subject |
|---|---|
| [architecture/OVERVIEW.md](./architecture/OVERVIEW.md) | Whole-system map: three surfaces, identity, four money rails, deploy topology |
| [architecture/CLI.md](./architecture/CLI.md) | Local engine + command/tool inventory |
| [architecture/BACKEND.md](./architecture/BACKEND.md) | Cloudflare Worker routes, auth/keys, billing, marketplace, data model |
| [architecture/FRONTEND.md](./architecture/FRONTEND.md) | Next.js pages, session handling, billing & wallet UI |
| [architecture/SECURITY.md](./architecture/SECURITY.md) | **(new)** Anti-tamper, anti-bot handling, trust graph, proof layer, x402 gate |
| [architecture/PRIVACY.md](./architecture/PRIVACY.md) | **(new)** Thin client, obfuscation + audit gate, commitments, sealed storage |
| [architecture/AUTH.md](./architecture/AUTH.md) | **(new)** Identity, key model, auth gates, token resolution, wallet precedence |
| [architecture/PERFORMANCE.md](./architecture/PERFORMANCE.md) | **(new)** Replay-over-re-drive, pointer cache, egress tiering, fast paths, honest numbers |
| [architecture/ACCEPTANCE-CRITERIA.md](./architecture/ACCEPTANCE-CRITERIA.md) | Given/When/Then per subsystem |
| [architecture/TEST-SPECS.md](./architecture/TEST-SPECS.md) | Required unit tests + coverage |

### Operations, economics & integration (root + folders)
| Path | Subject |
|---|---|
| [SECURITY.md](./SECURITY.md) | Honest threat model (package binding, anti-tamper) |
| [caching.md](./caching.md) | Pointer-reactive cache design |
| [benchmarks.md](./benchmarks.md), [benchmarks-history.md](./benchmarks-history.md) | Coverage methodology + append-only log |
| [HOW_UNBROWSE_PAYS.md](./HOW_UNBROWSE_PAYS.md), [THE_FDRY_ECONOMY.md](./THE_FDRY_ECONOMY.md) | Money model + token economy |
| [CLAIM_YOUR_DOMAIN.md](./CLAIM_YOUR_DOMAIN.md), [EARN_AS_INDEXER.md](./EARN_AS_INDEXER.md) | Domain claim + indexer economics |
| [wallets.md](./wallets.md), `ows.md`, `pay-sh-integration.md`, [public/lobster-cash-integration.md](./public/lobster-cash-integration.md) | Wallet & payment integrations |
| `mcp-workflow-guide.md` | MCP workflow reference |
| [public/primitives/README.md](./public/primitives/README.md) (15) | Auditable transparency primitives |
| [OPEN-SOURCE-NOTICE.md](./OPEN-SOURCE-NOTICE.md) | Open-source scope / moat boundary of record |
| `design/` (4) | Design explorations (per-contract VM, runpod-bound VM, openai tools, windows) |
| `decisions/faremeter-evaluation.md` | ADOPT decision record |

### Not published (kept for reference)
| Path | Why |
|---|---|
| `internal/` (3) | Internal bench / acceptance / week-review — **never published** |
| `archive/` (6) | Frozen historical snapshots & post-mortems |
| `issues-to-rach/` | Partner-facing bug logs — internal |

---

## Part B — Code map

### `src/` — local engine, CLI & MCP (Bun single binary)

**Entry points & dispatch**
| Module | Responsibility | Entry |
|---|---|---|
| CLI | Command entry, dispatch, local-server lifecycle | `src/cli.ts` |
| MCP | stdio JSON-RPC server, in-process API, ~45 tools | `src/mcp.ts` |
| v7 dispatch | build/act/eval op routing | `src/cli-v7/` |
| Server / router | HTTP app + route composition (compat facade) | `src/server.ts`, `src/router.ts`, `src/index.ts` |
| Intent match | Form detection + API-type inference | `src/intent-match.ts` |

**Capture → infer → publish (the product loop)**
| Module | Responsibility | Entry |
|---|---|---|
| capture/ | Record real interactions; obfuscate; server-first reverse-engineering; fast paths | `src/capture/index.ts` |
| extraction/ | HTML/JSON structure extraction, SPA detection, readability | `src/extraction/index.ts` |
| transform/ | Schema transform + drift detection/recovery | `src/transform/index.ts` |
| lib/graph-core | Operation graph: schema inference, endpoint planner, hole bindings | `src/lib/graph-core/index.ts` |
| lib/indexer-core | Background indexing, capture spool, queue | `src/lib/indexer-core/index.ts` |
| publish/, foundry/ | Manifest validation, sanitization, publish bundle | `src/publish/sanitize.ts`, `src/foundry/publish-bundle.ts` |
| publish-admission | Publish admission gates | `src/publish-admission.ts` |

**Resolve & execute**
| Module | Responsibility | Entry |
|---|---|---|
| orchestrator/ | DAG planning, execution flow, hole-producer selection | `src/orchestrator/index.ts` |
| execution/ | Endpoint execution (GraphQL/JSON-RPC/gRPC/form/page), retry, proxy, **anti-bot handlers**, **egress chain** | `src/execution/index.ts` |
| ranking/, lib/ranking-core | Endpoint ranking signals | `src/ranking/`, `src/lib/ranking-core/` |
| site-policy, ratelimit/ | Session-bound-param detection, per-route limits | `src/site-policy.ts`, `src/ratelimit/index.ts` |

**Browser layer**
| Module | Responsibility | Entry |
|---|---|---|
| browser/, cdp/ | Chrome tabs, network proxy, spoof; Chrome DevTools Protocol | `src/browser/index.ts`, `src/cdp/chrome.ts` |
| kuri/ | Stateless browser spawn/FFI wrapper | `src/kuri/client.ts` |
| sandbox/ | Bundle-replay client | `src/sandbox/bundle-replay-client.ts` |

**Identity, security, money** *(deep-dives: [SECURITY](./architecture/SECURITY.md) · [PRIVACY](./architecture/PRIVACY.md) · [AUTH](./architecture/AUTH.md))*
| Module | Responsibility | Entry |
|---|---|---|
| auth/ | Pre-resolve gate, runtime auth, stale-endpoint feedback, browser cookies/history | `src/auth/index.ts` |
| verification/ | Auth-gate, candidate selection, integration matrix | `src/verification/index.ts` |
| payments/ | x402 fetch, EVM/Base signer, wallet resolution, OWS, lobster/privy/pay.sh adapters | `src/payments/index.ts` |
| vault/, values/ | Credential storage, wallet sealing, keychain, signer, storage holes | `src/vault/index.ts`, `src/values/index.ts` |
| proof/ | Response commitment, input censoring, notary client | `src/proof/index.ts` |
| trust/ | Proof-of-indexing, bond-challenge, ledger checkpoint, sealed cache, refresh job | `src/trust/mount.ts` |

**Client, config, telemetry & misc**
| Module | Responsibility | Entry |
|---|---|---|
| client/ | Config/key load, telemetry, agent API, skill lookup | `src/client/index.ts` |
| config/, settings.ts, compat/ | Contribution mode, payment-provider, capture-pipeline settings | `src/config/`, `src/settings.ts` |
| telemetry/, telemetry.ts, routing-telemetry.ts | Session logging, route traces, routing events, issue reporting | `src/telemetry/index.ts` |
| sdk/ | Public TypeScript SDK + wallet adapters | `src/sdk/index.ts` |
| setup/, cli-setup.ts | MCP registration, contract resolver, skill installer, setup wizard | `src/setup/claude-mcp-register.ts` |
| runtime/, single-binary.ts | Local server, browser lifecycle, principal scope; binary packaging | `src/runtime/local-server.ts` |
| interop/, bridges/, contract-shape/, contract-*.ts | Agent primitives, MCP/CLI/impl contract transport | `src/interop/agent-primitives.ts`, `src/contract-shape/registry.ts` |
| types/ | Core shared TypeScript types (SkillManifest, EndpointDescriptor, ExecutionTrace, Proof) | `src/types/index.ts` (`skill.ts`, `proof.ts`) |
| protobuf/, domain.ts, template-params.ts, skillmd.ts, version.ts | Wire serialization + small shared utilities | `src/protobuf/wire.ts`, `src/version.ts` |
| stale-cleanup*.ts, session-logs.ts, impact-log.ts, agent-outcome.ts | Cleanup scheduler, session logs, impact/earnings log, outcome hints | `src/stale-cleanup.ts` |

> **Internal method surface (out of public scope).** A small set of internal
> planning / accountability-ledger modules under `src/` are part of the private
> build method, not the public product surface. They are intentionally omitted
> here and held out of published docs by the repo's public-artifact gate.

### `backend/` — Cloudflare Worker (Hono) at `beta-api.unbrowse.ai`
See [architecture/BACKEND.md](./architecture/BACKEND.md) for the full route map.
| Group | Notable members |
|---|---|
| routes/ | `skills`, `search`, `reveng`, `auth`, `account`, `billing`, `claim`, `credits`, `llm`, `proxy`, `solve`, `dashboard`, `webhooks`, `trace`, `audit`, … |
| services/ | `keys`, `marketplace`, `stripe`, `crypto-sub`, `flex`, `splits`, `sponsor-pool`, `economics`, `pricing`, `rank`, `scoring`, `settlement`, `domain-claim`, `kv`, … |
| middleware/ | `auth`, `sponsor`, `x402-gate`, `rate-limit`, `exec-token`, flex-onboarding gates |

### `frontend/` — Next.js on Cloudflare at `unbrowse.ai`
See [architecture/FRONTEND.md](./architecture/FRONTEND.md).
| Area | Notable |
|---|---|
| Pages | landing (per-domain), `dashboard`, `skill/[id]`, `search`, `login`, `account`, `billing`, `playground`, `agents`, `docs/*`, `pricing`, plus `mcp.json` / `llms.txt` / `skill.md` discovery endpoints |
| lib/ | `api.ts`, `auth-context.tsx`, `privy-provider.tsx`, `account-client.ts`, `claim-client.ts`, `web-telemetry.ts`, `landing-experiment.ts` |

### `packages/` — published npm
| Package | Name | Status |
|---|---|---|
| `packages/skill/` | `unbrowse` | Main CLI + single binary (v9.4.12) |
| `packages/sdk/` | `@unbrowse/sdk` | Legacy (binary-spawn) — deprecated |
| `packages/sdk-v2/` | `@unbrowse/client` | HTTP-first, zero-dep SDK |

---

## How to keep this honest

- Every `src/...`/`backend/...` path above is verifiable with the
  path-anchor check (`scripts/docs-anchor-check.sh`).
- Published docs must pass the repo's public-artifact gate (no economic
  constants, no server-side engine internals, no internal method vocabulary).
- When a subsystem is added or renamed, update its row here and in
  [SUMMARY.md](./SUMMARY.md).
