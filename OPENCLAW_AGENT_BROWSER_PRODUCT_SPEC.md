# OpenClaw as Agent-Browser Skill Stack — Product Spec (Agent-Browser Rebuild)

## 1) Vision
Build a local-first, browser-parity automation system where users can ask intent-level questions and the platform executes them via reusable, browser-authenticated skills.

The key shift is:
- discovery and learning happen through `agent-browser` (instead of OpenClaw plugin capture),
- endpoint execution is done through `execInBrowser` for faithful CSRF/auth behavior,
- marketplace is public and used as a shared reliability/verification/index layer,
- user credentials remain local and never leave the user machine.

## 2) Finalized constraints (answers captured)
- **Scope:** General-purpose from day one.
- **Auth model:** User provides their own credentials; platform stores only local browser/session material for replay.
- **Credentials storage:** Local-only, encrypted on the user machine (keychain/OS vault + encrypted local store). Never sent to marketplace/backend.
- **Index:** Discovery uses `emergentdb`.
- **Runtime target:** Execution stays local and never leaves the user runtime.
- **Deployment:** VM + Vercel infrastructure for hosted services.
- **Marketplace:** Public.
- **Mutable endpoints:** `POST/PUT/PATCH/DELETE` enabled, but not replayed for verification checks.
- **Feedback + subscriptions:** nice-to-have (non-blocking), not required for initial release.
- **UI:** Optional for integration; no dedicated UI required. Existing frontends plug into APIs.
- **Completion target:** Agent-focused experience that materially speeds data retrieval/actions (~100x vs manual flow where feasible).

## 3) Primary user flow
1. User asks: `help me check trends of tesla model y`.
2. Orchestrator resolves intent against marketplace using discovery index (EmergentDB).
3. If match found:
   - run selected skill endpoints locally through `agent-browser` browser context.
4. If no match:
   - perform live browse in `agent-browser`,
   - capture HAR,
   - reverse engineer endpoints,
   - test and validate candidates,
   - publish/merge skill metadata in marketplace,
   - execute locally.
5. Return normalized result + execution trace.
6. Optional: capture quality feedback; optional optional subscription prompt for updates (phase 2).

## 4) System components
- **Discovery Index (EmergentDB):** intent search + candidate ranking.
- **Capture + HAR Pipeline (`agent-browser`):** generates HAR and session artifacts.
- **Reverse Engineering Layer:** endpoint extraction, parameterization, auth/CSRF inference.
- **Schema + Transform Registry:** validates and normalizes manifests and endpoint behavior.
- **Execution Runtime:** local `execInBrowser` engine for replay with browser-like headers/cookies/CSRF behavior.
- **Verification Layer:** marks endpoint health, replay safety, idempotency assumptions.
- **Marketplace Public Index:** stores normalized, merged endpoint/skill artifacts.
- **Quality/Feedback Layer (optional):** feedback ingestion, rating decay, ranking signals.
- **Subscription Layer (optional):** user opt-in on `skill_version` changes / verification changes.

## 5) Data contracts

### 5.1 Skill manifest (versioned)
- `skill_id`
- `name`
- `intent_signature`
- `version` (semver)
- `schema_version`
- `domain`
- `subdomain`
- `description`
- `auth_profile_ref` (local-only execution reference)
- `endpoints[]`
- `transform_ref`
- `lifecycle` (`active|deprecated|disabled`)
- `changelog`
- `created_at / updated_at`

### 5.2 Endpoint descriptor
- `endpoint_id`
- `method`
- `url_template`
- `headers_template`
- `query/body schema`
- `csrf_plan`
- `oauth_plan`
- `transform_ref`
- `idempotency` (`safe|unsafe`, required for non-GET)
- `verification_status`
- `reliability_score`
- `last_verified_at`

### 5.3 Auth profile (local only)
- `oauth_type` and flow shape
- `csrf_sources` (header/cookie/form)
- `refresh_policy`
- `session_refresh_triggers`
- `rotation policy`
- `storage_hint` (local-keystore reference)

## 6) Versioning
- `major`: breaking skill interface/endpoint contract or auth model changes.
- `minor`: additive compatible capabilities (new endpoint, schema extension).
- `patch`: reliability/transform/test metadata updates.
- Each publish writes immutable history, `prev_version`, and `changelog`.
- Rollback via explicit target version with signed audit record.

## 7) Schema validation
- JSON schema validation at ingest + publish.
- Hard reject: missing required fields, malformed URL templates, invalid method/transform schema.
- Soft warnings for unknown optional fields (does not block publish initially).
- No endpoint enters marketplace if schema invalid.

## 8) Transform layer
- Canonicalizes request/response shapes and normalizes endpoint volatility.
- Includes:
  - request normalization (paths, headers, query ordering),
  - response normalization (schema shapes, date/number coercion),
  - error mapping,
  - pagination normalization.
- Transform artifacts are versioned and reviewed independently from endpoint signature.

## 9) Discovery index details
- Backend: `EmergentDB`.
- Index signals:
  - semantic intent similarity,
  - domain/subdomain overlap,
  - verified reliability,
  - freshness,
  - local feedback/relevance signal.
- Match ladder:
  1) direct intent match,
  2) semantic nearest neighbor,
  3) domain fallback,
  4) live on-the-fly capture.

## 10) Execution + verification policy
- Execution remains local and browser-context equivalent.
- Verification uses replay attempts for deterministic/non-destructive checks by default.
- `POST/PUT/PATCH/DELETE`:
  - supported,
  - excluded from replay-automation assumptions in verification,
  - surfaced with explicit mutability metadata and user confirmation policy as configurable policy in orchestrator.

## 11) Abuse prevention
- Rate limits by user + domain + skill + endpoint.
- Mutable endpoint anomaly detection.
- Session reuse and suspicious replay detection.
- Abuse telemetry to:
  - downgrade visibility,
  - temporary lockouts,
  - manual review queue escalation.
- Explicit anti-automation guardrails for bursty or bot-like behavior.

## 12) Feedback and subscription (phase 2)
- **Feedback tool:** optional `POST /api/feedback` for skill/endpoint/plugin execution quality.
- Effects:
  - quality score updates,
  - revalidation triggers on sustained low scores,
  - ranking de-prioritization where needed.
- **Subscribe prompt:** optional opt-in after execution:
  - “Do you want update alerts for this skill?”
  - channels: in-app / email / webhook,
  - events: version bump, verification failure, auth/CSRF changes.

## 13) Non-functional requirements
- Local credential isolation by design.
- No credentials in marketplace payloads or logs.
- Full lineage: capture → inferred skill → validation → publish/merge → execute.
- Observability:
  - per-run trace IDs,
  - HAR lineage IDs,
  - verification/abuse outcome metrics.

## 14) KPIs and acceptance
- General intent hit rate from marketplace grows over time.
- Median intent-to-result latency for matched skills remains low.
- >90% success on deterministic `GET` endpoints after verification.
- Mutable endpoint execution only when policy allows (never assumed replay-safe).
- 100x target in agent-relevant loops (target benchmark against baseline manual browse/replay).
- Feedback/subscription rollout may be deferred without blocking phase 1.

## 15) Open decisions
- How aggressive duplicate endpoint merge should be for fuzzy templates.
- Optional CSRF/credential vault implementation standard for local-only storage.
- Post-verification confidence thresholds for mutable actions per domain risk.
