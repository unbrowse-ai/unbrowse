# Changelog

## [6.5.0-preview.12](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.11...v6.5.0-preview.12) (2026-05-03)

### Bug Fixes

* **marketplace:** recover stale endpoint execution ([a5cd61d](https://github.com/unbrowse-ai/unbrowse-dev/commit/a5cd61d0e71267dd36bc1d52b97e43c690794b96))

## [6.5.0-preview.11](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.10...v6.5.0-preview.11) (2026-05-03)

### Bug Fixes

* **account:** recover reset with stale env keys ([4036611](https://github.com/unbrowse-ai/unbrowse-dev/commit/4036611f16de13e3bd65950cc1d4100b8eca5279))

## Unreleased

### Bug Fixes

* **marketplace:** retry refreshed credentials once and return browser fallback guidance for stale endpoints
* **account:** keep reset recovery working when stale environment keys and claimed wallets are present

## [6.5.0-preview.10](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.9...v6.5.0-preview.10) (2026-05-03)

### Features

* **account:** force reset broken api keys ([f8f057f](https://github.com/unbrowse-ai/unbrowse-dev/commit/f8f057fdd8d255a97470a6202195308b13ee61d1))

## Unreleased

### Features

* **account:** add forced local API key reset for broken registrations

## [6.5.0-preview.9](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.8...v6.5.0-preview.9) (2026-05-03)

### Bug Fixes

* **setup:** write codex hook table correctly ([9b7a6f6](https://github.com/unbrowse-ai/unbrowse-dev/commit/9b7a6f6d702e37e40793c048cf55502e9acfcfc0))
* **vault:** restore random key generation, add auth extraction traces ([e22083c](https://github.com/unbrowse-ai/unbrowse-dev/commit/e22083c24bc72eb0eb8047c14c970faea0ec2152))

## Unreleased

### Bug Fixes

* **setup:** write and repair Codex update hooks as the single `[hooks]` table

## [6.5.0-preview.8](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.7...v6.5.0-preview.8) (2026-05-03)

### Features

* pair cli dashboard login ([fec94e9](https://github.com/unbrowse-ai/unbrowse-dev/commit/fec94e95cf9e3e2e16ed35ea6d328243bad3da4d))

### Bug Fixes

* keep preview dist-tag on current release ([adc2d59](https://github.com/unbrowse-ai/unbrowse-dev/commit/adc2d599c504e15f6707824793f038d9672b07ae))

### Performance

* **vault:** cache key + file reads, deterministic key derivation ([77874fc](https://github.com/unbrowse-ai/unbrowse-dev/commit/77874fc92ff0a5920926585629088dd94dc19285))

## [6.5.0-preview.7](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.6...v6.5.0-preview.7) (2026-05-03)

### Bug Fixes

* **release:** keep npm preview dist-tag on just-published previews
* **accounts:** return key-backed agent ids from magic-link login
* **accounts:** keep CLI magic-link verification separate from web dashboard sign-in
* **accounts:** pair the website dashboard to local CLI installs through a short-lived localhost token
* **dashboard:** use the economics dashboard read model for signed-in users
* **setup:** make fresh non-interactive onboarding quieter and honest about misses
* repair codex update hook setup ([f977a27](https://github.com/unbrowse-ai/unbrowse-dev/commit/f977a278d0baa3798eab6a981d436432bf164460))

## [6.5.0-preview.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.5...v6.5.0-preview.6) (2026-05-03)

### Bug Fixes

* **setup:** repair malformed Codex update-hint hook tables
* **release:** bake Kuri 0.16 vendor binaries ([83f6cbd](https://github.com/unbrowse-ai/unbrowse-dev/commit/83f6cbd3cc34ef6bc43c282f28a83a9401b1a313))

## [6.5.0-preview.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.4...v6.5.0-preview.5) (2026-05-03)

## [6.5.0-preview.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.3...v6.5.0-preview.4) (2026-05-03)

### Bug Fixes

* **release:** restore generated build-info before clean-tree check ([db981f0](https://github.com/unbrowse-ai/unbrowse-dev/commit/db981f0c91ea8d651de5d6535137f5483097f3c5))

## [6.5.0-preview.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.1...v6.5.0-preview.2) (2026-05-03)

## [6.5.0-preview.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.0...v6.5.0-preview.1) (2026-05-03)

### Features

* **accounts:** magic-link email accounts skeleton (Slice 1, step 3 — baptism) ([ec8095a](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec8095a9244e2d279ebdc9d77911c1a5935a2a3d))
* **accounts:** server-side share_pointers preference + dashboard toggle (Slice 1.6) ([9ea2070](https://github.com/unbrowse-ai/unbrowse-dev/commit/9ea207068c605bb9707f934c831659b6e9141472))
* **accounts:** web sign-in flow + dashboard mix (Slice 1.5) ([1620d3a](https://github.com/unbrowse-ai/unbrowse-dev/commit/1620d3a4fcc7fe8fabcd319cd7681142eadb724a))
* **accounts:** wire CLI register --email + e2e tests + integration fixes (Slice 1, step 6 — great-commission) ([2ea43c0](https://github.com/unbrowse-ai/unbrowse-dev/commit/2ea43c0346457524813232a2e30c7da9bf45b5e4))
* **auth:** fall through to Dia/Arc/Brave when Chrome has no cookies ([fcafc02](https://github.com/unbrowse-ai/unbrowse-dev/commit/fcafc028751b9aa41b48f8a68a7f5c5e71146ede))
* **auth:** rank browsers by liveness (recent visits + bookmarks) before cookie extract ([20f05ec](https://github.com/unbrowse-ai/unbrowse-dev/commit/20f05ecf66b33c5d096218adb881080181d39171))
* **capture:** auto-fallback to visible browser on anti-bot wall ([4451a4c](https://github.com/unbrowse-ai/unbrowse-dev/commit/4451a4cec1af0f0d9f53ea1f5f5975916e300d42))
* **capture:** hint agent when capture is doc-only (lazy-loading SPA) ([23e6b74](https://github.com/unbrowse-ai/unbrowse-dev/commit/23e6b7435fd42a820bb866d1e2ef382b654b07aa))
* **capture:** surface captured_meta + capture_path on success path ([1248d1a](https://github.com/unbrowse-ai/unbrowse-dev/commit/1248d1a181cc2e8329256b3cefcd1cdb690247fd))
* **cli:** preview-tagged binaries auto-bind to staging profile ([1326201](https://github.com/unbrowse-ai/unbrowse-dev/commit/1326201c6ecd1f276157df2b831653e6783c086c))
* **extraction:** generic array-branch primitive + per-domain LLM notes (Slice 2 — browser-harness inspired) ([eedaabe](https://github.com/unbrowse-ai/unbrowse-dev/commit/eedaabe684d0ac70451b7ddb82cc6cd32401a40e))
* **frontend:** parchment palette for install terminal ([0ba5880](https://github.com/unbrowse-ai/unbrowse-dev/commit/0ba58806fa50e95c680ff19fc07d2723d9e9d021)), closes [#060402](https://github.com/unbrowse-ai/unbrowse-dev/issues/060402) [#ede0c2](https://github.com/unbrowse-ai/unbrowse-dev/issues/ede0c2) [#e8d8b0](https://github.com/unbrowse-ai/unbrowse-dev/issues/e8d8b0) [#FF7A20](https://github.com/unbrowse-ai/unbrowse-dev/issues/FF7A20) [#8B3800](https://github.com/unbrowse-ai/unbrowse-dev/issues/8B3800) [#FFB060](https://github.com/unbrowse-ai/unbrowse-dev/issues/FFB060) [#5C1E00](https://github.com/unbrowse-ai/unbrowse-dev/issues/5C1E00) [#FF7A20](https://github.com/unbrowse-ai/unbrowse-dev/issues/FF7A20)

### Bug Fixes

* **accounts:** default sender to auth@unbrowse.ai (verified domain) ([fb41bb1](https://github.com/unbrowse-ai/unbrowse-dev/commit/fb41bb17e1fc90b914c50da65fea5c9794eb67d7))
* **capture:** observation, not prescription — agent decides what to drive ([ab8dfc7](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab8dfc7d5c292df2b6f6f469c3da144dbca6d206))
* **cli:** surface prior_domain_note + note_evidence in capture envelope ([77b426b](https://github.com/unbrowse-ai/unbrowse-dev/commit/77b426b5e6d0638d1207519aab8fc2bd4fc14cd5))
* **detector:** classify Fastly Bot Management as browser-block ([cb3df82](https://github.com/unbrowse-ai/unbrowse-dev/commit/cb3df824fe1574fd1ed42bbac22f2de133f7a95a))
* **executor:** server-fetch + dom_extraction recipe path works on Node 25 ([d07ff25](https://github.com/unbrowse-ai/unbrowse-dev/commit/d07ff2558f2edc4ae419a6bedbd4106021ea8195)), closes [#76](https://github.com/unbrowse-ai/unbrowse-dev/issues/76)
* **extraction:** admit parameterized nested-path SSR widget endpoints ([6af9e11](https://github.com/unbrowse-ai/unbrowse-dev/commit/6af9e11551ed4451dc42098b3ce217f216d8e622))
* **extraction:** pick story link over upvote/login link in aggregator cards ([b6663ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/b6663acf948e4a9dc36627cf6e6df73a7302b181))
* kill all client-side caches — only the backend marketplace stores skills ([f6016ce](https://github.com/unbrowse-ai/unbrowse-dev/commit/f6016ce52f388386c3e1b0d92aff3a9af63e5319))

### Refactoring

* **notes:** expose to harness; rip silent-LLM summarizer (Slice 2.1) ([fe3b622](https://github.com/unbrowse-ai/unbrowse-dev/commit/fe3b6225110421adbdc65a807078766318990650))

## [6.5.0-preview.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.5.0-preview.0...v6.5.0-preview.1) (2026-05-03)

### Features

* **accounts:** magic-link email accounts skeleton (Slice 1, step 3 — baptism) ([ec8095a](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec8095a9244e2d279ebdc9d77911c1a5935a2a3d))
* **accounts:** server-side share_pointers preference + dashboard toggle (Slice 1.6) ([9ea2070](https://github.com/unbrowse-ai/unbrowse-dev/commit/9ea207068c605bb9707f934c831659b6e9141472))
* **accounts:** web sign-in flow + dashboard mix (Slice 1.5) ([1620d3a](https://github.com/unbrowse-ai/unbrowse-dev/commit/1620d3a4fcc7fe8fabcd319cd7681142eadb724a))
* **accounts:** wire CLI register --email + e2e tests + integration fixes (Slice 1, step 6 — great-commission) ([2ea43c0](https://github.com/unbrowse-ai/unbrowse-dev/commit/2ea43c0346457524813232a2e30c7da9bf45b5e4))
* **auth:** fall through to Dia/Arc/Brave when Chrome has no cookies ([fcafc02](https://github.com/unbrowse-ai/unbrowse-dev/commit/fcafc028751b9aa41b48f8a68a7f5c5e71146ede))
* **auth:** rank browsers by liveness (recent visits + bookmarks) before cookie extract ([20f05ec](https://github.com/unbrowse-ai/unbrowse-dev/commit/20f05ecf66b33c5d096218adb881080181d39171))
* **capture:** auto-fallback to visible browser on anti-bot wall ([4451a4c](https://github.com/unbrowse-ai/unbrowse-dev/commit/4451a4cec1af0f0d9f53ea1f5f5975916e300d42))
* **capture:** hint agent when capture is doc-only (lazy-loading SPA) ([23e6b74](https://github.com/unbrowse-ai/unbrowse-dev/commit/23e6b7435fd42a820bb866d1e2ef382b654b07aa))
* **capture:** surface captured_meta + capture_path on success path ([1248d1a](https://github.com/unbrowse-ai/unbrowse-dev/commit/1248d1a181cc2e8329256b3cefcd1cdb690247fd))
* **cli:** preview-tagged binaries auto-bind to staging profile ([1326201](https://github.com/unbrowse-ai/unbrowse-dev/commit/1326201c6ecd1f276157df2b831653e6783c086c))
* **extraction:** generic array-branch primitive + per-domain LLM notes (Slice 2 — browser-harness inspired) ([eedaabe](https://github.com/unbrowse-ai/unbrowse-dev/commit/eedaabe684d0ac70451b7ddb82cc6cd32401a40e))
* **frontend:** parchment palette for install terminal ([0ba5880](https://github.com/unbrowse-ai/unbrowse-dev/commit/0ba58806fa50e95c680ff19fc07d2723d9e9d021)), closes [#060402](https://github.com/unbrowse-ai/unbrowse-dev/issues/060402) [#ede0c2](https://github.com/unbrowse-ai/unbrowse-dev/issues/ede0c2) [#e8d8b0](https://github.com/unbrowse-ai/unbrowse-dev/issues/e8d8b0) [#FF7A20](https://github.com/unbrowse-ai/unbrowse-dev/issues/FF7A20) [#8B3800](https://github.com/unbrowse-ai/unbrowse-dev/issues/8B3800) [#FFB060](https://github.com/unbrowse-ai/unbrowse-dev/issues/FFB060) [#5C1E00](https://github.com/unbrowse-ai/unbrowse-dev/issues/5C1E00) [#FF7A20](https://github.com/unbrowse-ai/unbrowse-dev/issues/FF7A20)

### Bug Fixes

* **accounts:** default sender to auth@unbrowse.ai (verified domain) ([fb41bb1](https://github.com/unbrowse-ai/unbrowse-dev/commit/fb41bb17e1fc90b914c50da65fea5c9794eb67d7))
* **capture:** observation, not prescription — agent decides what to drive ([ab8dfc7](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab8dfc7d5c292df2b6f6f469c3da144dbca6d206))
* **cli:** surface prior_domain_note + note_evidence in capture envelope ([77b426b](https://github.com/unbrowse-ai/unbrowse-dev/commit/77b426b5e6d0638d1207519aab8fc2bd4fc14cd5))
* **detector:** classify Fastly Bot Management as browser-block ([cb3df82](https://github.com/unbrowse-ai/unbrowse-dev/commit/cb3df824fe1574fd1ed42bbac22f2de133f7a95a))
* **executor:** server-fetch + dom_extraction recipe path works on Node 25 ([d07ff25](https://github.com/unbrowse-ai/unbrowse-dev/commit/d07ff2558f2edc4ae419a6bedbd4106021ea8195)), closes [#76](https://github.com/unbrowse-ai/unbrowse-dev/issues/76)
* **extraction:** admit parameterized nested-path SSR widget endpoints ([6af9e11](https://github.com/unbrowse-ai/unbrowse-dev/commit/6af9e11551ed4451dc42098b3ce217f216d8e622))
* **extraction:** pick story link over upvote/login link in aggregator cards ([b6663ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/b6663acf948e4a9dc36627cf6e6df73a7302b181))
* kill all client-side caches — only the backend marketplace stores skills ([f6016ce](https://github.com/unbrowse-ai/unbrowse-dev/commit/f6016ce52f388386c3e1b0d92aff3a9af63e5319))

### Refactoring

* **notes:** expose to harness; rip silent-LLM summarizer (Slice 2.1) ([fe3b622](https://github.com/unbrowse-ai/unbrowse-dev/commit/fe3b6225110421adbdc65a807078766318990650))

## Slice 1 — Email Accounts (Magic Link) (2026-05-02)

Optional account-bound API keys via passwordless email signup. `unbrowse register --email lewis@example.com` issues a magic link, the click verifies and binds an `ubr_…` key to a user id. Anonymous keys (the existing 819) keep working unchanged; `bearerAuth` now resolves `c.set("user_id", uid)` only for account-bound keys, so account-aware features gain identity without breaking the rest.

* Routes: `POST /v1/auth/email/start`, `GET /v1/auth/email/verify`, `GET /v1/auth/email/poll`
* Backend services: `services/email.ts` (Resend send), `services/accounts.ts` (KV-backed account model)
* KV namespaces: `acct:`, `uid:`, `magic:` (10-min TTL), `key2user:`, `userkeys:`
* Adversarial pass fixed 4 silent bugs: email length DoS, header injection via control chars, orphan `magic:` row when Resend send fails, `EdbKV.put` swallowing non-2xx responses from qdkv
* Pre-req: verify a sender domain (e.g. `auth.unbrowse.ai`) in Resend, set `RESEND_API_KEY` as a wrangler secret. Until both, `/v1/auth/email/start` returns `503 email_not_configured` cleanly. Without `EMERGENTDB_API_KEY` / `DATABASE_URL`, returns `503 storage_unavailable`.
* Known follow-up: `.issues/auth-verify-no-rollback.md` — verify path lacks a compensating delete on partial KV failure (surfaces as 5xx, not silent corruption, but leaves an orphan `acct:` row). Out of slice scope.
## [6.5.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.4.0...v6.5.0-preview.0) (2026-05-02)

### Features

* **cli:** cmdSearch emits search_started/completed funnel telemetry ([50a41d5](https://github.com/unbrowse-ai/unbrowse-dev/commit/50a41d510c504ae3f49fdc104d95823915a6dcd3))
* **frontend:** live stats + popular grid, restored Crossmint copy, route handlers ([33b684f](https://github.com/unbrowse-ai/unbrowse-dev/commit/33b684f13972581e7935d5ddfa2bc42537e97cfa))
* **harness:** per-test isolation + triage scripts for failing-test fix loop ([f357104](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3571044b5dc251371cfaac95936c7a84ee4e11c))

### Bug Fixes

* **auth:** UNBROWSE_DISABLE_AUTH_FALLBACK bypass + test isolation ([73fa367](https://github.com/unbrowse-ai/unbrowse-dev/commit/73fa367cf542c311727284daa89298a97f652972)), closes [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230)
* **cli:** auto-execute respects third-party terms policy gate ([3a3a024](https://github.com/unbrowse-ai/unbrowse-dev/commit/3a3a02441913ddeab0edd041d943925f1b0c1e02))
* **cli:** parseArgs treats --endpoint -p as boolean flag, not value=-p ([d620082](https://github.com/unbrowse-ai/unbrowse-dev/commit/d620082872fd29ed88a9a6155021ec5e302ae0a3))
* **executor:** SSRF bypass for tests + needs_review honors explicit semantic flag ([6809940](https://github.com/unbrowse-ai/unbrowse-dev/commit/6809940e283bf2da162677ae7f1e1e2c042c94c6))
* **executor:** third-party terms gate fires before any HTTP call ([1c988fc](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c988fc1d258fe9004d86ddc5920c4e0c8115cb6))
* **frontend:** unbreak homepage registry section ([58f864a](https://github.com/unbrowse-ai/unbrowse-dev/commit/58f864a17aeaf071e29dca085bd1b8af3ad6c053))
* **graph:** needs_review honors explicit flag only on real API endpoints ([ff9fc1b](https://github.com/unbrowse-ai/unbrowse-dev/commit/ff9fc1b32d68f7aa35cfe4d9f0f0bd793e328a8d))
* **ranker:** BM25 floor + schema cross-check on param NAME (not value) ([6815333](https://github.com/unbrowse-ai/unbrowse-dev/commit/6815333e5f4f3c74d07f59f2f866b1043ac7532a))
* **ranker:** bury captured-page-artifact when real API sibling exists in corpus ([9241836](https://github.com/unbrowse-ai/unbrowse-dev/commit/92418362bd4c783513d66734decf5cb7e060e0a5))
* **ranker:** URL-encoded template slots, session-bound URLs, whitepaper paths ([22300ea](https://github.com/unbrowse-ai/unbrowse-dev/commit/22300eab2d6281c23100ccec5d146a2e923ea06d))
* **resolve:** local-skill fast path + structured timeouts on every hang ([8070892](https://github.com/unbrowse-ai/unbrowse-dev/commit/8070892a9f8e1b2793cf83ec52e9c9c317f167bd))
* **runtime:** add missing getBrowserConfig + BrowserPathConfig exports ([fb83c8d](https://github.com/unbrowse-ai/unbrowse-dev/commit/fb83c8d5be632d3b06427852edd848d6fe4adf95))
* **tests:** unstale 3 fixtures (version, installer parity, llms.txt path) ([ba806ca](https://github.com/unbrowse-ai/unbrowse-dev/commit/ba806cac8ec183cdee1206ae6657cf9c2db69648))
* **tests:** unstale MCP stdio assertions on tool descriptions ([3565dfe](https://github.com/unbrowse-ai/unbrowse-dev/commit/3565dfe6e64bfd3f929355213db728e515adc7b5))
* **tests:** update payment messaging assertions to match Apr 2026 reframe ([c043451](https://github.com/unbrowse-ai/unbrowse-dev/commit/c043451a5d250bab9a8e308973c57bb92ed008c3))
* tighten 2 self-introduced regressions (wallet bypass, headless literal) ([e3ecafd](https://github.com/unbrowse-ai/unbrowse-dev/commit/e3ecafd0daeedaef657de7a515761f9ad3959038))
* **wallet:** skip local lobster config probe under bun:test ([ecb3521](https://github.com/unbrowse-ai/unbrowse-dev/commit/ecb352198ef0541bde756001d5be0b54ae295302))

## [6.4.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.3.0...v6.4.0) (2026-05-01)

### Features

* **08-01:** 5-min in-process TTL cache for marketplace lookups ([bcb7995](https://github.com/unbrowse-ai/unbrowse-dev/commit/bcb7995b19ff996a28c0971b5ddc9c21d3a41d33))
* **08-01:** cli --budget <ms> flag for unbrowse resolve ([3e80a80](https://github.com/unbrowse-ai/unbrowse-dev/commit/3e80a80a9e48652b17112be04c07d12429326773))
* **08-01:** race primitive with deadline + per-racer abort ([8400288](https://github.com/unbrowse-ai/unbrowse-dev/commit/84002883a88f15c63089d42d71466f38ea36858a))
* **08-01:** wire race + budget into resolveAndExecute ([24b4990](https://github.com/unbrowse-ai/unbrowse-dev/commit/24b4990d1d852f6d4fc6056f8e8fb7d16a9121fe))
* **08-02:** contribution config module with private-by-default ([0a3055d](https://github.com/unbrowse-ai/unbrowse-dev/commit/0a3055dcb766c0d06e38e17a2d05ee43047386fd))
* **08-02:** gate marketplace publish on contribution.share_pointers ([e19f8c1](https://github.com/unbrowse-ai/unbrowse-dev/commit/e19f8c1b6d415f68641cc3f7fdc0681e4e8468a6))
* **08-02:** unbrowse capture verb + POST /v1/capture endpoint ([15723ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/15723ac581f51102816b668f2552acf6aa97f105))
* **08-02:** unbrowse setup contribution prompt + unbrowse mode command ([ce3cb22](https://github.com/unbrowse-ai/unbrowse-dev/commit/ce3cb2280399b87f5781c363215462059bf9a0e9))

### Refactoring

* **08-03:** delete deriveStructuredDataReplay registry + canonical-replay surface ([8285387](https://github.com/unbrowse-ai/unbrowse-dev/commit/828538729defbd6c3b7daef144cec545b6f0550f))
* **08-03:** delete EndpointDescriptor.exec_strategy field + carry-forward ([f1d850f](https://github.com/unbrowse-ai/unbrowse-dev/commit/f1d850f8c8c9d94a9e5d6e015da23ebbb28d9e9f))

## [6.3.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.6...v6.3.0) (2026-05-01)

### Features

* **07-01:** add probeUrl + decideFromProbe primitive ([6cfc3e8](https://github.com/unbrowse-ai/unbrowse-dev/commit/6cfc3e8d19ea1e521c06ec81ba95f61150975dcc))
* **07-02:** add ProvenRecipe types + EndpointDescriptor.proven_recipe ([021be5f](https://github.com/unbrowse-ai/unbrowse-dev/commit/021be5fc3d7a2d62c6a52811a7c63566cf072530))
* **07-02:** recipe replay step runs before probe ladder in executeEndpoint ([3a53afa](https://github.com/unbrowse-ai/unbrowse-dev/commit/3a53afab313b60eff1baec6ba3d7db63ce4bdc8b))
* **07-02:** stamp proven_recipe on admitted endpoints from captured req/res ([f17a769](https://github.com/unbrowse-ai/unbrowse-dev/commit/f17a76957e72f53dcf451d0d7111a0010192a7b5))
* **07-02:** surface decision_trace at top level of ExecutionResult + CLI ([7ebc83b](https://github.com/unbrowse-ai/unbrowse-dev/commit/7ebc83b7e6b6bd205fdeec5b4e2087cbb451d31b))

### Refactoring

* **07-01:** wire probe-first ladder into executeEndpoint ([b7543e9](https://github.com/unbrowse-ai/unbrowse-dev/commit/b7543e9f3357f545464843a6bfd8dba32cdb94b8))

## [6.2.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.5...v6.2.6) (2026-05-01)

### Bug Fixes

* skip trigger-intercept on self-fetchable URLs in no-strategy branch ([9ed8fd0](https://github.com/unbrowse-ai/unbrowse-dev/commit/9ed8fd0ae2399124720d7eea3a529622ff9ca405))

## [6.2.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.4...v6.2.5) (2026-05-01)

### Bug Fixes

* trigger-intercept falls back to serverFetch on self-fetchable URLs ([891f2e4](https://github.com/unbrowse-ai/unbrowse-dev/commit/891f2e454684ee8329d88956ffd00b584d6f86ef))

## [6.2.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.3...v6.2.4) (2026-05-01)

### Bug Fixes

* A8 multi-segment substitution + anti-pattern audit in CLAUDE.md ([4508f2c](https://github.com/unbrowse-ai/unbrowse-dev/commit/4508f2ccf17f96414c3cb769808f964d7f97e50f))

## [6.2.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.2...v6.2.3) (2026-05-01)

### Bug Fixes

* article extraction confidence — was falling to 0.3 default ([ef38024](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef3802437406decb602835de59cef598248318bb))

## [6.2.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.1...v6.2.2) (2026-05-01)

### Bug Fixes

* article extractor reads full html + wins on article intent unconditionally ([df4c658](https://github.com/unbrowse-ai/unbrowse-dev/commit/df4c65824d96ca8b2f5e495bed466041def64cc6))

## [6.2.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.2.0...v6.2.1) (2026-05-01)

### Bug Fixes

* prefer article-body over JSON-LD when intent is article-shaped ([3bebc65](https://github.com/unbrowse-ai/unbrowse-dev/commit/3bebc65eba470e138aeef53d205b474ead6f62b9))

## [6.2.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.4...v6.2.0) (2026-05-01)

### Features

* article-body extractor + tighter handoff + result.error mirror ([58aaa6f](https://github.com/unbrowse-ai/unbrowse-dev/commit/58aaa6f366cbe0a4f3830b6e6f2091dc027342b6))

## [6.1.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.3...v6.1.4) (2026-05-01)

### Bug Fixes

* D8b — write cleaned graphql vars/features into body, not just mergedParams ([1909bb3](https://github.com/unbrowse-ai/unbrowse-dev/commit/1909bb3def6782d4901a7841a4a0cf1fa85475b6))

## [6.1.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.2...v6.1.3) (2026-05-01)

### Bug Fixes

* D8 also borrows sibling's body template — variables had nowhere to go ([75847fb](https://github.com/unbrowse-ai/unbrowse-dev/commit/75847fb430ddcf3dcf5ff591c786c4853bf1fc5d))

## [6.1.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.1...v6.1.2) (2026-05-01)

### Bug Fixes

* CLI parser handles --prefixed nanoid IDs + GraphQL borrows sibling vars ([aa9f9b8](https://github.com/unbrowse-ai/unbrowse-dev/commit/aa9f9b834fff75248898086398d60374cc5c9180))

## [6.1.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.0...v6.1.1) (2026-05-01)

### Bug Fixes

* 3 post-v6.1.0 UX bugs caught by harness against live binary ([2fb62c3](https://github.com/unbrowse-ai/unbrowse-dev/commit/2fb62c3e1c3b184e0130188fc60c6fdfa08eb622))

## [6.1.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.1.0-preview.0...v6.1.0) (2026-05-01)

## [6.1.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v6.0.0...v6.1.0-preview.0) (2026-04-30)

### Features

* harness/recursive/ + 7 agent-UX fixes driven through it ([5b85f77](https://github.com/unbrowse-ai/unbrowse-dev/commit/5b85f77b8b26ea918f05b0eb53a68f027a71a882))
* one-shot CLI/MCP `run` + default URL inference (UX-2/UX-3/UX-4) ([810a970](https://github.com/unbrowse-ai/unbrowse-dev/commit/810a9708e26f8288170e2e35d5b0792677fce7f2))

### Bug Fixes

* A8-display — rewrite resolve url_template to caller's contextUrl ([f5fb93e](https://github.com/unbrowse-ai/unbrowse-dev/commit/f5fb93ebab1062764b021755bc78dfcb4b7580c3))
* broader telemetry filter (A11) + actionable low_quality_dom error (F2.1) ([629e566](https://github.com/unbrowse-ai/unbrowse-dev/commit/629e5668a7a47225da9d56f778ff951eff33cca2)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)
* bump auto-extraction_hints threshold from 2KB to 64KB (UX-1) ([f152d9a](https://github.com/unbrowse-ai/unbrowse-dev/commit/f152d9ad062e0a121b4158f8f43b53bd55e02385))
* cross-brand demotion (A12) + contextUrl path-overlap bonus (A1.2) ([ff0e37c](https://github.com/unbrowse-ai/unbrowse-dev/commit/ff0e37cfd689a8491b273c963923bdb061cec211)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)
* dedupe duplicate GraphQL ops in shortlist (D4) + entity-substitute captured URLs at execute (A8) ([093e2dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/093e2ddd23aab4200e58090a2a25b8de3d9259c7))
* deeper leak penalty (A1.1) + cross-subdomain demotion (A10) ([f1da9df](https://github.com/unbrowse-ai/unbrowse-dev/commit/f1da9dfee24b4906d050b428d892535e977677b7))
* defensive aliases read in graphql agentParams projection ([c2f22cd](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2f22cd090a338d037da3460ea2fbcaedb74d891))
* filter telemetry-event endpoints with _ separator (A9) ([dd1e316](https://github.com/unbrowse-ai/unbrowse-dev/commit/dd1e316d193c2b6550dd7b519af8e3943d19f53b))
* read-intent demotes write-flavored endpoints (A13) ([867754b](https://github.com/unbrowse-ai/unbrowse-dev/commit/867754b46048ff8ca6950327856ac5aeffe49910)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)
* SSRF protocol regex never matched, blocking every execute ([f41c872](https://github.com/unbrowse-ai/unbrowse-dev/commit/f41c872d1c4330390c58c88440e4b174fa431c1f))
* surface runnable:true on directly-callable URLs (C7) + ranker shortlist alignment ([a3a28f1](https://github.com/unbrowse-ai/unbrowse-dev/commit/a3a28f120c62245a5b186c079c5b52de0e534d00)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)

## Unreleased

### Agent UX

* `unbrowse execute` now accepts `-p key=val` (and `--param key=val`) repeated flags for replay parameters. Previously these were silently dropped as positional args, causing `invalid_replay_params` with no path forward. Existing `--params '{json}'` still works; `-p` takes precedence on key collisions. Help text updated.
* `browser-capture` `no_endpoints` failures now return an actionable `next_step` (`open_browse_session` or `abandon_or_authenticate`) with concrete `suggested_commands` instead of a one-word error.
* Resolve shortlists no longer surface phantom DOM-extracted homepages as fabricated "search" operations (G1), captured error envelopes (`{status:fail, errors[].severity:CRITICAL}`) presented as data endpoints (C5), or wrong-template literal leaks (e.g., r/programming returned for r/singularity intent — A1).
* GraphQL POST endpoints at non-`/graphql/` URLs (Facebook persisted queries, LinkedIn `/voyager/api/...`, Apollo `extensions{persistedQuery}`) are now detected by request-body shape and admitted (A4).
* SSR payloads past 300KB (Next.js `__NEXT_DATA__`, JSON-LD blocks at document end) are no longer silently truncated before extraction (B4).
* Stale endpoints organically deprecate: `recordDagSessionAction` now decays `reliability_score` per failure (-0.10) and per success (+0.05), so endpoints that consistently fail drift below `MIN_PUBLISH_RELIABILITY` and stop appearing in shortlists (E1).
* DOM-extracted operations with fully-resolved URLs and no required params now report `runnable: true` (C7). Walmart's homepage SSR payload — verified directly executable via `unbrowse execute --raw` — was previously reported as `runnable: false`, misleading agents into not even trying.

### Internal

* Added `harness/recursive/` — a transparent observation layer that wraps real `unbrowse` calls so the calling agent's friction becomes corpus rows + patch hints. Six layers (Observation → Persistence → Reflection → Cognition → Replay → Cold-seed) with a strict no-grep-verdicts contract enforced by 6 architectural-contract tests + 7 behavior tests. `harness/recursive/mine-sessions.sh` seeded the corpus from 11,317 historical jsonl session files; second mining sweep added walmart.com which immediately surfaced C7 via direct execute.
* Two new issue classes named in `harness/recursive/judge.md`: **G1** phantom-endpoint hallucination (lawnet.sg homepage marketed as search), **C5** captured-error-response (instagram.com `useragent mismatch` shortlist noise), **C7** runnable-false-on-directly-callable-URL (walmart.com SSR endpoint).
* Added `docs/architecture-capture-and-dag.md` documenting capture sources, replay precision, generalisation guarantee, and the operation DAG.

## [6.0.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v5.0.0...v6.0.0) (2026-04-25)

## [5.0.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v4.0.3...v5.0.0) (2026-04-25)

### ⚠ BREAKING CHANGES

* All previously issued Unkey-backed API keys are revoked.
Users must run `unbrowse register` to get new locally-managed keys.

### Refactoring

* replace Unkey with local API key system ([ca7d2dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/ca7d2dd5f671cc00c94e90f7aef9d4c96bd2876c))

## [5.0.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v4.0.3...v5.0.0) (2026-04-25)

### ⚠ BREAKING CHANGES

* All previously issued Unkey-backed API keys are revoked.
Users must run `unbrowse register` to get new locally-managed keys.

### Refactoring

* replace Unkey with local API key system ([ca7d2dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/ca7d2dd5f671cc00c94e90f7aef9d4c96bd2876c))

## [4.0.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v4.0.2...v4.0.3) (2026-04-25)

### Bug Fixes

* **kuri:** bump to 117b7f4 — fixes EventBuffer use-after-free SIGSEGV ([b2907c9](https://github.com/unbrowse-ai/unbrowse-dev/commit/b2907c9da8fe483a6542a05a21b10a9fbaec5ea1))

## [4.0.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v4.0.1...v4.0.2) (2026-04-25)

### Bug Fixes

* **backend:** allow anonymous stats writes ([5a6e32f](https://github.com/unbrowse-ai/unbrowse-dev/commit/5a6e32fa49248a9437d98f84771c59a6415c1300))

## [4.0.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v4.0.0...v4.0.1) (2026-04-25)

### Refactoring

* make API key optional ([d71820b](https://github.com/unbrowse-ai/unbrowse-dev/commit/d71820b3838bf0a29185bf155272ad709dd45e74))

## [4.0.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0...v4.0.0) (2026-04-25)

### ⚠ BREAKING CHANGES

* AGENTMAIL_API_KEY, `unbrowse login-auto`, and all autonomous email-auth paths are gone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Refactoring

* remove AgentMail integration ([31e0f96](https://github.com/unbrowse-ai/unbrowse-dev/commit/31e0f967b06a11795640c2e280585f0599748826))

## Unreleased

### BREAKING CHANGES

* **auth:** remove AgentMail integration entirely — `unbrowse login-auto` command, `/v1/auth/agent-mail`, `/v1/auth/autonomous`, `/v1/email/*` routes, the `agentmail` npm dependency, and the auto-bootstrap at `setup` time. Autonomous email-based registration is gone; use browser cookie extraction or interactive login instead.

## [3.8.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0-preview.4...v3.8.0) (2026-04-25)

## [3.8.0-preview.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0-preview.3...v3.8.0-preview.4) (2026-04-25)

### Bug Fixes

* **mcp:** rename annotate tool's parameters to inputSchema ([f2cec9f](https://github.com/unbrowse-ai/unbrowse-dev/commit/f2cec9f1a815aa6e9565bfd6a1ec17bc837b0838))
* **runtime:** wrap js entrypoint as file:// URL and teach isMainModule to unwrap it ([1f2363b](https://github.com/unbrowse-ai/unbrowse-dev/commit/1f2363b9d7c1f6c6dc65e83944f148799e3c22a7))

## [3.8.0-preview.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0-preview.2...v3.8.0-preview.3) (2026-04-11)

### Features

* **bench-local:** auto-retry-on-empty absorbs transient process flakes ([c4603ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/c4603acb7b7fd610bc9612989ed2289aee9f19b7))
* **bench-local:** extract capture_diagnostic + total_endpoints_captured ([1ca1d15](https://github.com/unbrowse-ai/unbrowse-dev/commit/1ca1d153f3a5a48585758231bf7c669d037f5a2a))
* **bench-local:** promote PASS rows into baseline corpus automatically ([267718c](https://github.com/unbrowse-ai/unbrowse-dev/commit/267718cc7559d1d6663b020aefe90b47038bef8c))
* **bench-local:** retry once with 2x timeout on no_html_many_apis ([923a575](https://github.com/unbrowse-ai/unbrowse-dev/commit/923a57512f53736be85eecd4254eba862e8c53ad))
* **bench-local:** rubric tally + codified agent-judgment criteria ([19328e3](https://github.com/unbrowse-ai/unbrowse-dev/commit/19328e3e77b62c22d0e0f6e2ac38dd9a4f7245ad))
* **bench-local:** triage script re-judges past runs without re-running ([91c8717](https://github.com/unbrowse-ai/unbrowse-dev/commit/91c87173a2559a449dc7096eeaa295f18b6584dd))
* **bench:** explicit cli_timeout signal in rows + rubric/delta buckets ([a5149c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/a5149c6ef63f9b8169e417ef097f9e6de61150eb))
* **bench:** verdict as first-class row column ([d646caa](https://github.com/unbrowse-ai/unbrowse-dev/commit/d646caa59692ff66dc5eac69e9e34aea8fea5778))
* **capture-meta:** add no_html_many_apis signal + route to BROWSER_BLOCK ([5c95eca](https://github.com/unbrowse-ai/unbrowse-dev/commit/5c95ecaec905c1a38bec68669e0f2502f0491545))
* **capture-meta:** browser_block_signals + surface meta on quality-note path ([85ad2c3](https://github.com/unbrowse-ai/unbrowse-dev/commit/85ad2c3eb39431423178bc3238ad6f854ef3ad84))
* **capture-meta:** detect Akamai Bot Manager vendor signal ([7f448ff](https://github.com/unbrowse-ai/unbrowse-dev/commit/7f448ff909b46b231f036550bdaecc336db3a519))
* **capture-meta:** detect first-party PerimeterX + widen vendor regexes ([dd745c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/dd745c6004ac38468dee624d54c7267c068dac8c))
* **capture-meta:** expand challenge_title regex + v8 baseline promotion ([73aad00](https://github.com/unbrowse-ai/unbrowse-dev/commit/73aad0036d971dfcfcbcb114f693579b35ded4e9))
* **capture-meta:** low_capture signal + 404 challenge + tiny-capture rubric ([94c53df](https://github.com/unbrowse-ai/unbrowse-dev/commit/94c53dfe189cc1f0f6f18fe7ac70431ea892aa6d))
* **capture-meta:** widen challenge_title regex for CloudFront/403/unusual-traffic ([38c1f19](https://github.com/unbrowse-ai/unbrowse-dev/commit/38c1f1912584931aa7e549c1b307d9cf699f393d))
* **cell-build:** self-verifying build harness with docs-hunter as first cell ([2959f15](https://github.com/unbrowse-ai/unbrowse-dev/commit/2959f1535e68514d80dd80758613a57257de98e4))
* **corpus:** baseline 113→129 (v5 passes) ([d82db49](https://github.com/unbrowse-ai/unbrowse-dev/commit/d82db497d36f1d7434c130c9b2e7438195d82098))
* **corpus:** baseline 139→153 (v7 passes) ([c00e69f](https://github.com/unbrowse-ai/unbrowse-dev/commit/c00e69f1872ad7ba81692da4f0d6d89d5ee61327))
* **corpus:** baseline 170→187 (v9 passes) — 100% product-reachable ([bd711c7](https://github.com/unbrowse-ai/unbrowse-dev/commit/bd711c77ef4953d9f510bdf6ccf522fa6cd620d5))
* **corpus:** baseline 199→213 (v11 passes) — 100% product-reachable ([18ce81a](https://github.com/unbrowse-ai/unbrowse-dev/commit/18ce81aef38a39f3cc7908f0707c25145ca41be4))
* **corpus:** baseline 213→229 (v12 passes) — 100% product-reachable ([996517f](https://github.com/unbrowse-ai/unbrowse-dev/commit/996517f299722a22b64438e68bcf9baf711bb7ee))
* **corpus:** baseline 229→244 (v13 passes) — 4th consecutive 100% run ([e022360](https://github.com/unbrowse-ai/unbrowse-dev/commit/e022360720c030ebefd52b2a18728b9ce0643b35))
* **corpus:** baseline 244→262 (v14 passes) + fix maven intent ([4d8f39b](https://github.com/unbrowse-ai/unbrowse-dev/commit/4d8f39bd6c688770cf9b19e26b0c8ab3561c308f))
* **corpus:** baseline 275→288 (v16 passes) ([0ac92fa](https://github.com/unbrowse-ai/unbrowse-dev/commit/0ac92fac86be8120246a61e3543e464884cbf5dc))
* **corpus:** baseline 306→323 (v18 passes) — 100% first-run ([727b027](https://github.com/unbrowse-ai/unbrowse-dev/commit/727b027eda8d7d6071083fb8d78af17702cfeea6))
* **corpus:** baseline 67→80 (v2 passes) + queue 20 v3 candidates ([ec5342f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec5342f9f7d7c8fa7fe1651f1d1e05f1d0b66196))
* **corpus:** baseline 80→98 (v3 passes) ([a58f499](https://github.com/unbrowse-ai/unbrowse-dev/commit/a58f499579b7df2a354705af60fed5b5a0550169))
* **corpus:** baseline 98→113 (v4 passes) ([02a8b22](https://github.com/unbrowse-ai/unbrowse-dev/commit/02a8b2255020ac1f28ab9e332e11011af513e194))
* **corpus:** promote 21 URLs mined from reddit+smithery → baseline ([8f50941](https://github.com/unbrowse-ai/unbrowse-dev/commit/8f50941615909b9db4df7a24fe9c0d6b5b455395))
* **corpus:** queue 20 v10 candidates — design, fitness, food, real estate ([beae27d](https://github.com/unbrowse-ai/unbrowse-dev/commit/beae27d2f6d22f690a85eb96e9a4ad07327170eb))
* **corpus:** queue 20 v11 candidates — universities, art, fonts, recipes ([9d9521d](https://github.com/unbrowse-ai/unbrowse-dev/commit/9d9521dd9772c6ca440df71794445b97d63e7982))
* **corpus:** queue 20 v12 candidates — tech news, defi, productivity ([13a6bd0](https://github.com/unbrowse-ai/unbrowse-dev/commit/13a6bd0224d81f224d4037ab2d55203d6c5688a5))
* **corpus:** queue 20 v13 candidates — math, science, AI, tools ([c3b683b](https://github.com/unbrowse-ai/unbrowse-dev/commit/c3b683bbeaee53c2a0f51947fc1e135697b6a0c2))
* **corpus:** queue 20 v14 candidates — language docs + package registries ([881b10d](https://github.com/unbrowse-ai/unbrowse-dev/commit/881b10df40b4a90463919b1716b15e9d4efaf19e))
* **corpus:** queue 20 v15 candidates — archives, decentralized, alt-social ([256f7d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/256f7d74f6f2cc176eda68aa45deef5ddaec3e39))
* **corpus:** queue 20 v16 candidates — retail, finance, travel, museums ([4d662ce](https://github.com/unbrowse-ai/unbrowse-dev/commit/4d662ce2b8f818dabdda3170cea406414e2035b9))
* **corpus:** queue 20 v17 candidates — anime, tickets, finance, personal ([34dbd25](https://github.com/unbrowse-ai/unbrowse-dev/commit/34dbd254bf1b5d83504124e2e4a6f9c565e86449))
* **corpus:** queue 20 v18 candidates — SEO, research, databases ([7522b48](https://github.com/unbrowse-ai/unbrowse-dev/commit/7522b4848847d69a1d3fc6164127e47e4e40949b))
* **corpus:** queue 20 v19 candidates — data/devops tools + web framework docs ([4bbf4e8](https://github.com/unbrowse-ai/unbrowse-dev/commit/4bbf4e8eb30e7b8f0ff6b98f2ade7917b90d2843))
* **corpus:** queue 20 v4 candidates — social, e-commerce, finance, saas ([dada2da](https://github.com/unbrowse-ai/unbrowse-dev/commit/dada2dac4ce972538c1631ea1f0b8b0d5b4455a8))
* **corpus:** queue 20 v5 candidates — music, learning, travel, gaming, etc. ([4ad5730](https://github.com/unbrowse-ai/unbrowse-dev/commit/4ad5730b8f00faf0bbb906dacce323c3ca3cdf6f))
* **corpus:** queue 20 v6 candidates — retail, fashion, events, gaming-extra ([bf363a1](https://github.com/unbrowse-ai/unbrowse-dev/commit/bf363a197b70cc3204c9daeb89768040bb5dcf75))
* **corpus:** queue 20 v7 candidates — dictionaries, reviews, alt search ([204dc87](https://github.com/unbrowse-ai/unbrowse-dev/commit/204dc87d8d970daba55484849820d3a2ae5f58ec))
* **corpus:** queue 20 v8 candidates — research, gov, standards, SaaS APIs ([84945be](https://github.com/unbrowse-ai/unbrowse-dev/commit/84945be6fc664a7889381bfdd93bbf66e25807be))
* **corpus:** queue 20 v9 candidates — devtools, reviews, music, utilities ([ce82129](https://github.com/unbrowse-ai/unbrowse-dev/commit/ce82129a00f65f8e2b3c06cfbe8471013a812dc0))
* **extract:** brace-balanced SPA payload parser + Apollo support ([3c412ca](https://github.com/unbrowse-ai/unbrowse-dev/commit/3c412caf53f72011c88851fb7a10646f1f33009f))
* **extract:** flatten React Infinite Query pagination wrapper ([16d3c31](https://github.com/unbrowse-ai/unbrowse-dev/commit/16d3c315801c25597c910f807d9513994cb859a2))
* **extract:** Next.js 13+ App Router self.__next_f.push() support ([cd81534](https://github.com/unbrowse-ai/unbrowse-dev/commit/cd81534dd821b121497d97acf8ca7143cfa30553))
* **extract:** surface filter rejections + unblock graphql/sibling-domain/spa-state ([688c79a](https://github.com/unbrowse-ai/unbrowse-dev/commit/688c79add8801917ce2c4268c40b35a5e74d759d))
* **extract:** surface SPA __NEXT_DATA__ as real SSR endpoint ([0e52914](https://github.com/unbrowse-ai/unbrowse-dev/commit/0e5291438d0487cb27c309e7eeaf03978728f052))
* **extract:** unwrap React Query dehydratedState.queries[*].state.data ([e48984e](https://github.com/unbrowse-ai/unbrowse-dev/commit/e48984eac615728d3145d227e9b3fc3538d5bcc9))
* harness awareness harness + LLM judges for agent-xp + bench ([84a546a](https://github.com/unbrowse-ai/unbrowse-dev/commit/84a546a9dde06bb149a6c2a61e511730c2baa4e5))
* **harness:** bench-vs-inspect.py — ground-truth delta primitive ([f55de20](https://github.com/unbrowse-ai/unbrowse-dev/commit/f55de20d691b3445bca87b8f927b2cd916993c5f))
* **harness:** scripts/audit-coverage.sh — one-command harness-harness loop ([af208d9](https://github.com/unbrowse-ai/unbrowse-dev/commit/af208d91dd486da1bfbba814d0601bbcd542bf49))
* **harness:** scripts/gap-analyzer.py — suggest next primitive from observed gaps ([9d040fe](https://github.com/unbrowse-ai/unbrowse-dev/commit/9d040fe9342f1edec71248d2360c8eb761cc00ee))
* **harness:** scripts/inspect-page-signals.py — pre-capture diagnostic ([390bf21](https://github.com/unbrowse-ai/unbrowse-dev/commit/390bf2135cc690a831cdb1e45aa3c15cb675670e))
* **harness:** scripts/reset-unbrowse-cache.sh — local cache purge primitive ([a370750](https://github.com/unbrowse-ai/unbrowse-dev/commit/a370750392dc2670b490a106bfa30ce3fec45855))
* **inspect:** detect json_direct_api verdict + --corpus and --summary modes ([c2c5de4](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2c5de426d315f5f4566fe284f24d7fd31791ecb))
* **inspect:** incremental saves + resume for --summary mode ([cdbe3ec](https://github.com/unbrowse-ai/unbrowse-dev/commit/cdbe3ec08956b3d474573c712886023e513359a4))
* mine candidate sites from r/webscraping + smithery registry ([e1d701e](https://github.com/unbrowse-ai/unbrowse-dev/commit/e1d701e49dc351299e4685b33914853431ab2507))
* **orchestrator:** capture_diagnostic field on 'no relevant endpoint' rejection ([892760b](https://github.com/unbrowse-ai/unbrowse-dev/commit/892760bdc98cc575353e0a40d2961f4326f6514d))
* **rubric+corpus:** browse-session → PASS + baseline 262→275 (v15) ([0290191](https://github.com/unbrowse-ai/unbrowse-dev/commit/029019141d17b889c2a65fcd9517c3cbf20cb4b5))
* **rubric+corpus:** captcha_vendor as SOFT signal + baseline 288→306 (v17) ([f247173](https://github.com/unbrowse-ai/unbrowse-dev/commit/f247173eb32d0c9a8d505b67b283c3c5c56957e7))
* **rubric+corpus:** refine dom_content_available + baseline 187→199 (v10) ([120b30c](https://github.com/unbrowse-ai/unbrowse-dev/commit/120b30c33cdf3c94bd8b3918600901643899cc84))
* **rubric:** 502/503/504 challenge + dom_content_available PASS ([b92aaab](https://github.com/unbrowse-ai/unbrowse-dev/commit/b92aaabf2f86e1435e50d21f08bdd51bf10a0e86))
* **rubric:** count direct-fetch with successful trace as PASS ([53ebe2a](https://github.com/unbrowse-ai/unbrowse-dev/commit/53ebe2aa047a7ec7f17f4efdb8ac2a7819aa4637))
* **rubric:** empty-row → BROWSER_BLOCK, auth_recommended → AUTH_GATED, v6 passes ([97d3382](https://github.com/unbrowse-ai/unbrowse-dev/commit/97d33828015acde75eb5f1552d4b90e355822240))
* **rubric:** route capture_diagnostic failures to BROWSER_BLOCK ([84d858e](https://github.com/unbrowse-ai/unbrowse-dev/commit/84d858eb0d2ce9bbb88cb3b5996d07e933e5000a))
* **triage:** --json flag for CI-assertable rubric summary ([fbed2bc](https://github.com/unbrowse-ai/unbrowse-dev/commit/fbed2bc9a82d712bf549aaa58a7b17bcfbcdf875))

### Bug Fixes

* **bench:** classify degraded pages by text_bytes alone ([7817202](https://github.com/unbrowse-ai/unbrowse-dev/commit/7817202257fe1f659caaf0808dd854a83510c9f2))
* **bench:** extract.py picks top-level response, log extractor-strict finding ([5080330](https://github.com/unbrowse-ai/unbrowse-dev/commit/50803305f10929781cbcc5d557591b061a8c22ca))
* **bench:** read skill from top-level response, not d.result.skill ([dbd93da](https://github.com/unbrowse-ai/unbrowse-dev/commit/dbd93da5f4ee407f7c88ee985e09c79573a97e11))
* **corpus:** replace invalid etherscan tx hash with real one ([4c85a1d](https://github.com/unbrowse-ai/unbrowse-dev/commit/4c85a1da691138309609251776322ba80a94bf3a))
* **delta:** classify dom-fallback source as bench data path, not empty ([f686066](https://github.com/unbrowse-ai/unbrowse-dev/commit/f68606640a226787957f6f9ed9239e51bc398691))
* **extract:** add 'metadata' to graphql noise-op regex ([5ca28ec](https://github.com/unbrowse-ai/unbrowse-dev/commit/5ca28ec96e3aeb85c9db78e5443097da36c5f862))
* **extract:** reject CSS/JS body-shapes even when URL matches /api/ ([0f4ef6c](https://github.com/unbrowse-ai/unbrowse-dev/commit/0f4ef6c0ca49c100764c716256d4c6b407b9cb22))
* **extract:** reject framework-plumbing graphql ops from bypass ([802a5ff](https://github.com/unbrowse-ai/unbrowse-dev/commit/802a5ff421fc1b107bf36a48fea7133e1de90c5e))
* **inspect:** decode gzip/deflate responses + CSR mount-point detection ([dbedc36](https://github.com/unbrowse-ai/unbrowse-dev/commit/dbedc3651e934aac10b24dea0cccb59f33d46c6e))
* **publish:** gate the 3 direct publishSkill paths in execution ([a2338be](https://github.com/unbrowse-ai/unbrowse-dev/commit/a2338be0c69ae32a08df111b81bec52716621f39))
* **publish:** reject dom-fallback-only skills from marketplace ([9436261](https://github.com/unbrowse-ai/unbrowse-dev/commit/9436261a0c294fd6f635e53c406852a9a6d362ec))
* **rank:** split camelCase in descriptions before tokenizing ([1ceff95](https://github.com/unbrowse-ai/unbrowse-dev/commit/1ceff956c6f5085e2494fa436122a746994814ae))
* **resolve:** weak-relevance on-domain fallback for capture path ([be3bad0](https://github.com/unbrowse-ai/unbrowse-dev/commit/be3bad0f6a9b72bb199a6c5894c4211c3ce45e55))
* **rubric:** split PASS into REAL_API vs DOM_FALLBACK_ONLY — stop lying ([7a3d9f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/7a3d9f4907f6826f8c45ef7bbc23ce8d18606267))

### Performance

* **bench-local:** skip empty-output retry when first attempt timed out ([2ff61b6](https://github.com/unbrowse-ai/unbrowse-dev/commit/2ff61b65f22e11a88c69c76ad1c528fc72028353))

### Refactoring

* harness presents evidence; agent-in-thread judges ([61edd7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/61edd7edd2e2c04d1986e282b18398b9fbd39207))
* **harness:** use aiko web-inspect when on PATH ([94bdfca](https://github.com/unbrowse-ai/unbrowse-dev/commit/94bdfcaa3fe888cd054122c3fd9c970436176fb2))

## [3.8.0-preview.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0-preview.1...v3.8.0-preview.2) (2026-04-11)

### Refactors

* drop hardcoded anti-bot blocklist, emit captured_meta instead ([1523c78](https://github.com/unbrowse-ai/unbrowse-dev/commit/1523c785))

## [3.8.0-preview.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.8.0-preview.0...v3.8.0-preview.1) (2026-04-11)

### Fixes

* smoke cleanup SIGKILLs orphan bun server with timeout ([5ee2310](https://github.com/unbrowse-ai/unbrowse-dev/commit/5ee231047bca48008fa4bf721f76ceefbb9d91d0))
* backend: restore typecheck after cooked merge ([0b4e8a9](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b4e8a9559f93a8ec1fa6a164538d71c1778b292))

### Features

* coverage delta auto-appended to release notes ([728d98a](https://github.com/unbrowse-ai/unbrowse-dev/commit/728d98a9ba3e0d79d9fa3368d7d0712110e11ccd))

## [3.8.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.1...v3.8.0-preview.0) (2026-04-10)

### Features

* 100% agent coverage on 46-site corpus via body-sniff + anti-bot detection ([2fb26d0](https://github.com/unbrowse-ai/unbrowse-dev/commit/2fb26d04eb8067dad974ea7fde30fedd665d135a))
* auto-deprecate bad npm versions from benchmark history ([74daeb9](https://github.com/unbrowse-ai/unbrowse-dev/commit/74daeb9d0919fc31618487cbe7672cd3db2b9193))
* benchmark-historical — retroactive benchmark across npm version history ([fff4531](https://github.com/unbrowse-ai/unbrowse-dev/commit/fff45317e23789f7d4226020616cc61a269d3948))
* benchmark-over-time primitive tracks performance across releases ([493b8e9](https://github.com/unbrowse-ai/unbrowse-dev/commit/493b8e989133822dedc4d9dab84901b190063b52))
* cold-start-bench as harness + agent primitive ([754b6a7](https://github.com/unbrowse-ai/unbrowse-dev/commit/754b6a76bc3121b2305e582cb9695a19b846e95d))
* peek + job-state primitives for long-running job visibility ([532cc3f](https://github.com/unbrowse-ai/unbrowse-dev/commit/532cc3f1b97f5c6f58db3b3931e770bde5229191))
* stable baseline corpus + 502 retry for multi-version benchmark ([d3eb963](https://github.com/unbrowse-ai/unbrowse-dev/commit/d3eb963612f67285f448bb61706e4a1545289ed4))

### Bug Fixes

* bootstrap-agentmail now stops kuri after bootstrap attempt ([c998aa7](https://github.com/unbrowse-ai/unbrowse-dev/commit/c998aa7b1f1159c017b81a6e69267e5c79fd0e0c))
* classify capture_failed / kuri_crash as browser-block not fail ([337a702](https://github.com/unbrowse-ai/unbrowse-dev/commit/337a702b9f3bff04418d8b258760be955dc1654b))
* cold-start harness — file-fetch, env-var verdicts, longer box ttl ([907ff13](https://github.com/unbrowse-ai/unbrowse-dev/commit/907ff13aa03af867856f6fdc5f4a94964bc13274))
* cold-start-bench setup check looks for config.json not agent.json ([3e53bd8](https://github.com/unbrowse-ai/unbrowse-dev/commit/3e53bd83ff3da9057737a35b80a346361c12ea71))
* dogfood-loop detects Cloudflare challenge pages as BROWSER_BLOCK not PASS ([b650852](https://github.com/unbrowse-ai/unbrowse-dev/commit/b65085296271cf0ecbc38a45432508617776c265))
* pin LLM augmenter to deterministic sampling ([c1b3aa1](https://github.com/unbrowse-ai/unbrowse-dev/commit/c1b3aa1b3f13c8bfd0cf7e533e30a4df8e7cdbed))

## [3.7.0-preview.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.0-preview.1...v3.7.0-preview.2) (2026-04-10)

### Features

* auto-retry live-capture once after connection_failed ([eeee998](https://github.com/unbrowse-ai/unbrowse-dev/commit/eeee998643ad7ff069d069336898dffe5471259f)), closes [#105](https://github.com/unbrowse-ai/unbrowse-dev/issues/105)
* capture system state (processes, ports, memory) in agent-xp harness ([c2ec027](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2ec027948d30f2a4f418df5e17fdcedaa8eb020))
* coverage harness + fuzzy query param derivation ([2f925d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/2f925d714eb5d66a011b538fb44f51e8c89c5ca2))
* dogfood-loop primitive samples real intents from trace history ([9b07ffc](https://github.com/unbrowse-ai/unbrowse-dev/commit/9b07ffcdb1eac7a770c01f2e72652c64e8895ab9))

### Bug Fixes

* avoid cheerio .not() chainable — use each() with manual filter ([089aabe](https://github.com/unbrowse-ai/unbrowse-dev/commit/089aabee98bc2fd417783a16957497779bf8a70d))
* bump direct-fetch timeout to 15s, log failures instead of swallowing ([83f6e3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/83f6e3e1ecc8aef9296b25553e3d8036af2c0699))
* direct-fetch always tries JSON, works for plain JSON API URLs ([34a9434](https://github.com/unbrowse-ai/unbrowse-dev/commit/34a9434a8ee0ea6b97baac296af722f73971019e))
* record() writes raw to tempfile to avoid bash quote escaping ([f4e6fbd](https://github.com/unbrowse-ai/unbrowse-dev/commit/f4e6fbdc6b4d1ea51e79f65efec8570a607cb212))
* strip_logs helper — CLI mixes logs into stdout, filter to JSON only ([5d92466](https://github.com/unbrowse-ai/unbrowse-dev/commit/5d92466d55dcd9aa4eca3a4c32083f1ff8004717))
* strip_logs uses raw_decode for multi-line JSON ([3eb4208](https://github.com/unbrowse-ai/unbrowse-dev/commit/3eb4208756738107fd6f7698d00899a2de5b992a))

### Refactoring

* coverage harness reads live traces, no curated test cases ([95b455c](https://github.com/unbrowse-ai/unbrowse-dev/commit/95b455ccb7bf058dc9c1fda9a1f1b988491e995b))

## [3.7.0-preview.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.0-preview.1...v3.7.0-preview.2) (2026-04-10)

### Features

* capture system state (processes, ports, memory) in agent-xp harness ([c2ec027](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2ec027948d30f2a4f418df5e17fdcedaa8eb020))
* coverage harness + fuzzy query param derivation ([2f925d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/2f925d714eb5d66a011b538fb44f51e8c89c5ca2))

### Bug Fixes

* record() writes raw to tempfile to avoid bash quote escaping ([f4e6fbd](https://github.com/unbrowse-ai/unbrowse-dev/commit/f4e6fbdc6b4d1ea51e79f65efec8570a607cb212))
* strip_logs helper — CLI mixes logs into stdout, filter to JSON only ([5d92466](https://github.com/unbrowse-ai/unbrowse-dev/commit/5d92466d55dcd9aa4eca3a4c32083f1ff8004717))
* strip_logs uses raw_decode for multi-line JSON ([3eb4208](https://github.com/unbrowse-ai/unbrowse-dev/commit/3eb4208756738107fd6f7698d00899a2de5b992a))

## [3.7.0-preview.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.0-preview.0...v3.7.0-preview.1) (2026-04-10)

### Features

* agent experience test primitive — verify full agent workflow on blank slate ([ab99b2f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab99b2f3bd6c35dba540656c52a7946e660e21a5))
* agent-judged experience test — artifacts not assertions ([3a89e71](https://github.com/unbrowse-ai/unbrowse-dev/commit/3a89e71519533e9836ec63a390ef2fdc3dfd099e))

### Bug Fixes

* add npm global bin to PATH in remote verify script ([ff61cc0](https://github.com/unbrowse-ai/unbrowse-dev/commit/ff61cc0ac8b3f5b6cae9c4e02fcf424561f65766))
* auto-recover stale skill cache on endpoint_not_found ([ee90727](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee90727ca7f0a1eae309565dd4ba5e2112ce0341))
* pass --url to execute in agent-xp harness for canonical recovery ([7f03560](https://github.com/unbrowse-ai/unbrowse-dev/commit/7f035600cc8188a5cb57f72065a3f0e1c9f41ca1))
* stable endpoint IDs + canonical recovery for resolve→execute gap ([af1e3e0](https://github.com/unbrowse-ai/unbrowse-dev/commit/af1e3e0a32f2774208e6b219e97c22275b4117b3))

## [3.7.0-preview.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.0-preview.0...v3.7.0-preview.1) (2026-04-10)

### Features

* agent experience test primitive — verify full agent workflow on blank slate ([ab99b2f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab99b2f3bd6c35dba540656c52a7946e660e21a5))
* agent-judged experience test — artifacts not assertions ([3a89e71](https://github.com/unbrowse-ai/unbrowse-dev/commit/3a89e71519533e9836ec63a390ef2fdc3dfd099e))

### Bug Fixes

* add npm global bin to PATH in remote verify script ([ff61cc0](https://github.com/unbrowse-ai/unbrowse-dev/commit/ff61cc0ac8b3f5b6cae9c4e02fcf424561f65766))
* auto-recover stale skill cache on endpoint_not_found ([ee90727](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee90727ca7f0a1eae309565dd4ba5e2112ce0341))
* stable endpoint IDs + canonical recovery for resolve→execute gap ([af1e3e0](https://github.com/unbrowse-ai/unbrowse-dev/commit/af1e3e0a32f2774208e6b219e97c22275b4117b3))

## [3.7.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.7.0-preview.0...v3.7.0) (2026-04-10)

## [3.7.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.6.0...v3.7.0-preview.0) (2026-04-10)

### Features

* release-and-verify primitive — cut preview + remote blank-slate smoke ([f8ebf7f](https://github.com/unbrowse-ai/unbrowse-dev/commit/f8ebf7fa2685e42d3c370a432f7ea9a376553551))

### Bug Fixes

* add agentmail and @x402/fetch to skill package dependencies ([30bb279](https://github.com/unbrowse-ai/unbrowse-dev/commit/30bb279f32104ddf49bdf00cd66024de71a5edd3))
* disable multi-broker default — single Kuri broker prevents stale tab registry ([700c4b7](https://github.com/unbrowse-ai/unbrowse-dev/commit/700c4b7a2bab573743a84501458bd6a7ed10595e))
* recover stale vecdb endpoint IDs instead of dropping them ([#422](https://github.com/unbrowse-ai/unbrowse-dev/issues/422)) ([1a5b909](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a5b9094c6756980e89a1f7d12de11ef17bd7be9))
* revert release-it hook to fast unit tests only ([631d4ab](https://github.com/unbrowse-ai/unbrowse-dev/commit/631d4abb61be19a692e28115c71fcde9353f623a))

## [3.7.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.6.0...v3.7.0-preview.0) (2026-04-10)

### Features

* release-and-verify primitive — cut preview + remote blank-slate smoke ([f8ebf7f](https://github.com/unbrowse-ai/unbrowse-dev/commit/f8ebf7fa2685e42d3c370a432f7ea9a376553551))

### Bug Fixes

* disable multi-broker default — single Kuri broker prevents stale tab registry ([700c4b7](https://github.com/unbrowse-ai/unbrowse-dev/commit/700c4b7a2bab573743a84501458bd6a7ed10595e))

## [3.6.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.6.0-preview.0...v3.6.0) (2026-04-09)

### Bug Fixes

* don't force HEADLESS=false in auth flows — Kuri works headless ([77e6eec](https://github.com/unbrowse-ai/unbrowse-dev/commit/77e6eec7f9b3cbddb6f711452210399b9f40e0a4))
* resolve returns phantom endpoints that can't be executed ([9136d89](https://github.com/unbrowse-ai/unbrowse-dev/commit/9136d89e76b47bb5694855ca5bfc2c711693c940))

## [3.6.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.6.0-preview.0...v3.6.0) (2026-04-09)

### Bug Fixes

* don't force HEADLESS=false in auth flows — Kuri works headless ([77e6eec](https://github.com/unbrowse-ai/unbrowse-dev/commit/77e6eec7f9b3cbddb6f711452210399b9f40e0a4))
* resolve returns phantom endpoints that can't be executed ([9136d89](https://github.com/unbrowse-ai/unbrowse-dev/commit/9136d89e76b47bb5694855ca5bfc2c711693c940))

## [3.6.0-preview.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.5.4...v3.6.0-preview.0) (2026-04-09)

### Features

* autonomous email login via AgentMail — zero-config agent auth ([7955536](https://github.com/unbrowse-ai/unbrowse-dev/commit/79555360dcc129f71b015ddc7a2d4d984f2314cb))
* restore Alethea v2 frontend (School of Athens, dark mode, spacing) ([70ec96f](https://github.com/unbrowse-ai/unbrowse-dev/commit/70ec96fecfce5d8c39d709ea7a0582ea6303c253))

### Bug Fixes

* pass positional args to login-auto CLI command ([b5026ca](https://github.com/unbrowse-ai/unbrowse-dev/commit/b5026caa18c685fca80811091b826c0f1381b5a3))

### Refactoring

* reframe payment messaging from mining/indexing to per-use earning ([444d91f](https://github.com/unbrowse-ai/unbrowse-dev/commit/444d91f131f290f0cc816c0f16bca56cc916a46a))

## Unreleased

### Features

* **auth**: autonomous email login via AgentMail SDK — agents can register/login on sites without human intervention
* **cli**: `unbrowse login-auto <domain>` with `--wait-otp`, `--wait-link`, `--send-to` flags
* **mcp**: `unbrowse_login` now tries agent email first, `unbrowse_login_wait` polls for OTP/magic link
* **api**: `POST /v1/auth/agent-mail` endpoint for programmatic agent mail auth
* **frontend**: restored Alethea v2 design (School of Athens, dark mode, spacing)

## [3.5.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.5.3...v3.5.4) (2026-04-09)

### Bug Fixes

* remove robots.txt blocking and third-party terms gates ([4cff101](https://github.com/unbrowse-ai/unbrowse-dev/commit/4cff1018b0c5c01d074fd56242c5e60ffa4c9d1b))

## [3.5.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.5.2...v3.5.3) (2026-04-09)

### Bug Fixes

* remove phantom dependency-runtime.js import, add robots.txt tests ([33a8151](https://github.com/unbrowse-ai/unbrowse-dev/commit/33a815104cec3d1aebfd228d613b536bdded4d55)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)

## [3.5.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.5.1...v3.5.2) (2026-04-09)

### Bug Fixes

* route cache never persisted after deferral, interceptor late injection, extension GraphQL body ([df448e2](https://github.com/unbrowse-ai/unbrowse-dev/commit/df448e26521a87ee87db64af0977b1f09b96edd0))

## [3.5.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.5.0...v3.5.1) (2026-04-09)

### Bug Fixes

* use DEFAULT_BACKEND_URL import for earnings command ([9595537](https://github.com/unbrowse-ai/unbrowse-dev/commit/95955374d2ef3f67b0f51c8b5ad67e61892d22a3))

## [3.5.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.4.1...v3.5.0) (2026-04-09)

### Features

* deep indexing + agent payments (credit subsidy, USDC payouts, hard corpus) ([17d67c0](https://github.com/unbrowse-ai/unbrowse-dev/commit/17d67c0b1f2aa8a04824aaab2fd356ae9fd811a3)), closes [#402](https://github.com/unbrowse-ai/unbrowse-dev/issues/402) [#401](https://github.com/unbrowse-ai/unbrowse-dev/issues/401) [#403](https://github.com/unbrowse-ai/unbrowse-dev/issues/403) [#404](https://github.com/unbrowse-ai/unbrowse-dev/issues/404) [#410](https://github.com/unbrowse-ai/unbrowse-dev/issues/410) [#408](https://github.com/unbrowse-ai/unbrowse-dev/issues/408) [#408](https://github.com/unbrowse-ai/unbrowse-dev/issues/408) [#413](https://github.com/unbrowse-ai/unbrowse-dev/issues/413) [#418](https://github.com/unbrowse-ai/unbrowse-dev/issues/418)
* webhook handler dispatches pr-agent for new bug issues ([#400](https://github.com/unbrowse-ai/unbrowse-dev/issues/400)) ([d3fe4cf](https://github.com/unbrowse-ai/unbrowse-dev/commit/d3fe4cf44a510f3474911142970541cfcecc4641))

### Bug Fixes

* add missing addInitScript method to Kuri client ([cbe289c](https://github.com/unbrowse-ai/unbrowse-dev/commit/cbe289ca588c77aa9a766e872efc1d2a200d4163))
* recover from navigate timeout when page actually loaded ([4c32832](https://github.com/unbrowse-ai/unbrowse-dev/commit/4c328321bc1b0335b81e035bc943666d652e068d))

## Unreleased

### Features

* **credits**: agent onboarding subsidy system — $2 welcome credits per agent from a capped pool, balance-aware payment gate (credits → earned → x402 wallet fallback), auto-grant on registration, earnings from attribution
* **credits**: `CREDITS_ENABLED` env flag to toggle the entire credit system on/off
* **credits**: backend routes — `/v1/credits/balance`, `/v1/credits/debit`, `/v1/credits/pool`, `/v1/credits/init-pool`, `/v1/credits/grant`, `/v1/credits/self-sustaining`
* **cli**: `unbrowse earnings` command — show credit balance, granted/earned/spent, self-sustaining progress
* **cli**: `unbrowse flywheel` command — full funnel pulse dashboard (funnel, credits, index, economics, conversions)
* **frontend**: My Credits section on `/dashboard` for authenticated agents — balance, breakdown, progress toward self-sustaining
* **analytics**: `/v1/analytics/flywheel` endpoint — aggregates funnel + credits + index + economics in one call

## [3.4.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.4.0...v3.4.1) (2026-04-09)

### Bug Fixes

* remove --curl flag and request-preview endpoint ([#399](https://github.com/unbrowse-ai/unbrowse-dev/issues/399)) ([2ee90fb](https://github.com/unbrowse-ai/unbrowse-dev/commit/2ee90fbaf979a1102fcba116c9546ccd969ac147))

## [3.4.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.3.4...v3.4.0) (2026-04-09)

### Features

* --curl flag to expose captured requests ([#389](https://github.com/unbrowse-ai/unbrowse-dev/issues/389)) ([d16b6d6](https://github.com/unbrowse-ai/unbrowse-dev/commit/d16b6d630b96225009ce0b7a674c75a908557ef5)), closes [#390](https://github.com/unbrowse-ai/unbrowse-dev/issues/390) [#386](https://github.com/unbrowse-ai/unbrowse-dev/issues/386) [#391](https://github.com/unbrowse-ai/unbrowse-dev/issues/391) [#392](https://github.com/unbrowse-ai/unbrowse-dev/issues/392) [#393](https://github.com/unbrowse-ai/unbrowse-dev/issues/393)
* churn-curve analytics endpoint ([#381](https://github.com/unbrowse-ai/unbrowse-dev/issues/381)) ([71f08b0](https://github.com/unbrowse-ai/unbrowse-dev/commit/71f08b05517c506ba57262d9dabea2fd62216109))
* guided first resolve after setup to fix 82% registration drop-off ([#383](https://github.com/unbrowse-ai/unbrowse-dev/issues/383)) ([f3e14b5](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3e14b5436cccd487b59e96dcd8cafdceaf304f9))
* version-segmented churn curve with drop-off stage tracking ([#382](https://github.com/unbrowse-ai/unbrowse-dev/issues/382)) ([6d6907c](https://github.com/unbrowse-ai/unbrowse-dev/commit/6d6907c712a9d5dcf858d07741b9b454320b7a7f))

### Bug Fixes

* ensure-submodules checks superproject pin, not live remote tip ([#398](https://github.com/unbrowse-ai/unbrowse-dev/issues/398)) ([1fbc05f](https://github.com/unbrowse-ai/unbrowse-dev/commit/1fbc05f4ef3b9b2b1e142c713d6f18ac8cd1012d)), closes [unbrowse-ai/unbrowse#100](https://github.com/unbrowse-ai/unbrowse/issues/100)
* prevent dead session reuse and zombie tab recycling ([#387](https://github.com/unbrowse-ai/unbrowse-dev/issues/387)) ([d52a999](https://github.com/unbrowse-ai/unbrowse-dev/commit/d52a999cc97df966bf2baa695f91e7839e993125)), closes [#386](https://github.com/unbrowse-ai/unbrowse-dev/issues/386)

## [3.3.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.3.3...v3.3.4) (2026-04-07)

### Bug Fixes

* skip postinstall binary download in CI build environments ([3236580](https://github.com/unbrowse-ai/unbrowse-dev/commit/323658010b8914bc47e0dbe6db4a01e374887e21))

## [3.3.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.3.2...v3.3.3) (2026-04-07)

### Bug Fixes

* postinstall binary download retry + smoke test guards ([d5df390](https://github.com/unbrowse-ai/unbrowse-dev/commit/d5df390482dab010096f867a9fb7cfbf2c1061d2))

## [3.3.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.3.1...v3.3.2) (2026-04-07)

### Features

* fix attribution chain + add attribution analytics endpoint ([#380](https://github.com/unbrowse-ai/unbrowse-dev/issues/380)) ([408d6d4](https://github.com/unbrowse-ai/unbrowse-dev/commit/408d6d48a9177e381ee98b606bc2119601b2a15c))

### Bug Fixes

* add auth header to skills-card-route test after [#378](https://github.com/unbrowse-ai/unbrowse-dev/issues/378) ([62b8ecc](https://github.com/unbrowse-ai/unbrowse-dev/commit/62b8ecc435151f1c86ccb00fefc3a33449312e0e))
* bump npm resolve+execute e2e timeout from 120s to 180s ([70c0204](https://github.com/unbrowse-ai/unbrowse-dev/commit/70c0204f868ab09ee1095ab40b4359564678ba8d))
* gitignore build-info.generated.ts to prevent stale signing ([f3e3b67](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3e3b671973046e3247425a1a974694c62e165fb))
* replace build-info.generated.ts with empty stub ([9dc543c](https://github.com/unbrowse-ai/unbrowse-dev/commit/9dc543cab005df250dce472fb8fff7ed58cd101a))

## [3.3.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.3.1...v3.3.2) (2026-04-07)

### Features

* fix attribution chain + add attribution analytics endpoint ([#380](https://github.com/unbrowse-ai/unbrowse-dev/issues/380)) ([408d6d4](https://github.com/unbrowse-ai/unbrowse-dev/commit/408d6d48a9177e381ee98b606bc2119601b2a15c))

### Bug Fixes

* gitignore build-info.generated.ts to prevent stale signing ([f3e3b67](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3e3b671973046e3247425a1a974694c62e165fb))
* replace build-info.generated.ts with empty stub ([9dc543c](https://github.com/unbrowse-ai/unbrowse-dev/commit/9dc543cab005df250dce472fb8fff7ed58cd101a))

## [3.3.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.2.0...v3.3.0) (2026-04-06)

### Features

* CDP capture, SSR extraction, scoring fixes ([#377](https://github.com/unbrowse-ai/unbrowse-dev/issues/377)) ([fa22f88](https://github.com/unbrowse-ai/unbrowse-dev/commit/fa22f8817286398d276c933e7342519135624fb9))

### Bug Fixes

* **policy:** skip third-party gate for read-only POSTs, wire skip_robots ([#379](https://github.com/unbrowse-ai/unbrowse-dev/issues/379)) ([249ad47](https://github.com/unbrowse-ai/unbrowse-dev/commit/249ad4717bc14882bea501b1a69109083240210a))
* skip harStop hang + Unkey auth on skills list ([#378](https://github.com/unbrowse-ai/unbrowse-dev/issues/378)) ([95c3c98](https://github.com/unbrowse-ai/unbrowse-dev/commit/95c3c9895eaed5974df540bba53b03d3c367ac8b))

## [3.2.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.1.0...v3.2.0) (2026-04-06)

### Features

* auth DAG, community verification, constraint learning ([#376](https://github.com/unbrowse-ai/unbrowse-dev/issues/376)) ([6d6014d](https://github.com/unbrowse-ai/unbrowse-dev/commit/6d6014d7c1dd93358b3affd5e35941e381f29b43))
* **auth-dag:** add auth_required inference, token resolver, and JS bundle scanning ([9825490](https://github.com/unbrowse-ai/unbrowse-dev/commit/98254902261f1e2185b3c49df6161f3302a587f4))
* **auth-dag:** wire auth token DAG for dynamic CSRF + bearer resolution ([a2cf008](https://github.com/unbrowse-ai/unbrowse-dev/commit/a2cf008142ff7feb68cb6d5d18fedec4195d843d))
* **capture:** CDP-level network header capture for auth tokens ([bc152be](https://github.com/unbrowse-ai/unbrowse-dev/commit/bc152be0b4a8a73bc707122d0978925a74fc38fb))
* **ci:** add npm preview publish for lewis/experiments ([d31addb](https://github.com/unbrowse-ai/unbrowse-dev/commit/d31addb27d08f095977d31ba7acf11edc23f60c3))
* **marketplace:** public coverage API with version-keyed verification history ([186be38](https://github.com/unbrowse-ai/unbrowse-dev/commit/186be383bb59740d96a51bead7b9a8633489a630))
* **marketplace:** verified/unverified endpoint status + auth DAG fixes ([3653a91](https://github.com/unbrowse-ai/unbrowse-dev/commit/3653a91e109b450dfc9985488a82b26d697a92b3))
* **stats:** expose lifetime savings and earnings to agents ([c377b8c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c377b8c71d8dce32aa2821753108b82ba01031db))
* **telemetry:** enrich funnel events with CLI version + device context ([d14abcd](https://github.com/unbrowse-ai/unbrowse-dev/commit/d14abcd4d156849b03e2e76e2286580c8bc40c3e))
* **token-dag:** add token source scanner, resolver, and warm-tab pool ([921837c](https://github.com/unbrowse-ai/unbrowse-dev/commit/921837c6532a45dcaf149be4098c59b4a4a9b1ae))
* **token-dag:** wire auth_tokens resolver and warm-tab into execute path ([81bcd47](https://github.com/unbrowse-ai/unbrowse-dev/commit/81bcd47ba96b2316482af172095b2a8fa0712362))

### Bug Fixes

* **auth-dag:** capture full script src URLs for bearer token resolution ([995f8bb](https://github.com/unbrowse-ai/unbrowse-dev/commit/995f8bbf54acc3a5121040af15e1a930167ba136))
* **auth-dag:** resolve bearer from JS bundles via Performance API scan ([856fef4](https://github.com/unbrowse-ai/unbrowse-dev/commit/856fef4d43492e6590f347cbf0403c74e1cdde6e))
* **auth:** preserve auth headers in merge, fix vault key alignment, add token source scanning ([5c26877](https://github.com/unbrowse-ai/unbrowse-dev/commit/5c2687779ceb6e136a5de434b3ca26673693dec1))
* **capture:** add health check fallback for HAR cold start reliability ([93cfad2](https://github.com/unbrowse-ai/unbrowse-dev/commit/93cfad23737e1c7ccd2281f34d9ab0a9bb966fab))
* **capture:** always start HAR regardless of page load timeout ([5e7a7bb](https://github.com/unbrowse-ai/unbrowse-dev/commit/5e7a7bb949c1986ade1d567a75a5a657766fb246))
* **capture:** remove CDP WebSocket interference with Kuri HAR ([e16f194](https://github.com/unbrowse-ai/unbrowse-dev/commit/e16f194a388c8470da4b095a0572a3c812d55591))
* **capture:** retry waitForLoad before HAR start to survive cold starts ([ef43417](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef434171bbc8dc16bfaf8635f4d1347aa9eeef83))
* **ci:** add Zig 0.15.2 setup for Kuri build in npm preview publish ([6352fce](https://github.com/unbrowse-ai/unbrowse-dev/commit/6352fcefe857cb4bc24aea7d0062e526c1973c07))
* **ci:** add Zig setup + Kuri build to release workflow ([b7266c2](https://github.com/unbrowse-ai/unbrowse-dev/commit/b7266c2c684c2ec55035570fcc96aa58afb4d30e))
* **ci:** clean checkout for npm publish (stale runtime-src) ([acc0c3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/acc0c3e1f8c52f0d74d257c6c4c46d4bd8a8902c))
* **ci:** disable Windows cross-compile for Kuri (getenv incompatibility) ([548e04c](https://github.com/unbrowse-ai/unbrowse-dev/commit/548e04c0d98852e39fdaa41d33737c3b4b57f49b))
* **ci:** download pre-built darwin-arm64 Kuri from GitHub release ([e503b7d](https://github.com/unbrowse-ai/unbrowse-dev/commit/e503b7d2167b6cdc6d1c2920246b4f046086a044))
* **frontend:** use static assets cache for experiments env (skip R2) ([e42a4a7](https://github.com/unbrowse-ai/unbrowse-dev/commit/e42a4a759589e135565b9c265a4d28d9c3aeacf1))
* **runtime:** always prefer dist/server.js over index.js tsx wrapper ([9f13080](https://github.com/unbrowse-ai/unbrowse-dev/commit/9f130809f7f0ef15b35d9b7369277309ef7a98de))
* **windows:** correct installer asset URL and restore build script exec bit ([6f3f946](https://github.com/unbrowse-ai/unbrowse-dev/commit/6f3f9463587bd4802bc2fe9c02bb7e68ca8ca7e8)), closes [#360](https://github.com/unbrowse-ai/unbrowse-dev/issues/360)

### Performance

* **package:** bun-build server instead of tsx runtime interpretation ([92b9fb5](https://github.com/unbrowse-ai/unbrowse-dev/commit/92b9fb58eddd81e718a57bb2d8ba2da766bb0b02))

## [3.2.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.1.0...v3.2.0) (2026-04-06)

### Features

* auth DAG, community verification, constraint learning ([#376](https://github.com/unbrowse-ai/unbrowse-dev/issues/376)) ([6d6014d](https://github.com/unbrowse-ai/unbrowse-dev/commit/6d6014d7c1dd93358b3affd5e35941e381f29b43))
* **auth-dag:** add auth_required inference, token resolver, and JS bundle scanning ([9825490](https://github.com/unbrowse-ai/unbrowse-dev/commit/98254902261f1e2185b3c49df6161f3302a587f4))
* **auth-dag:** wire auth token DAG for dynamic CSRF + bearer resolution ([a2cf008](https://github.com/unbrowse-ai/unbrowse-dev/commit/a2cf008142ff7feb68cb6d5d18fedec4195d843d))
* **capture:** CDP-level network header capture for auth tokens ([bc152be](https://github.com/unbrowse-ai/unbrowse-dev/commit/bc152be0b4a8a73bc707122d0978925a74fc38fb))
* **ci:** add npm preview publish for lewis/experiments ([d31addb](https://github.com/unbrowse-ai/unbrowse-dev/commit/d31addb27d08f095977d31ba7acf11edc23f60c3))
* **marketplace:** public coverage API with version-keyed verification history ([186be38](https://github.com/unbrowse-ai/unbrowse-dev/commit/186be383bb59740d96a51bead7b9a8633489a630))
* **marketplace:** verified/unverified endpoint status + auth DAG fixes ([3653a91](https://github.com/unbrowse-ai/unbrowse-dev/commit/3653a91e109b450dfc9985488a82b26d697a92b3))
* **stats:** expose lifetime savings and earnings to agents ([c377b8c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c377b8c71d8dce32aa2821753108b82ba01031db))
* **telemetry:** enrich funnel events with CLI version + device context ([d14abcd](https://github.com/unbrowse-ai/unbrowse-dev/commit/d14abcd4d156849b03e2e76e2286580c8bc40c3e))
* **token-dag:** add token source scanner, resolver, and warm-tab pool ([921837c](https://github.com/unbrowse-ai/unbrowse-dev/commit/921837c6532a45dcaf149be4098c59b4a4a9b1ae))
* **token-dag:** wire auth_tokens resolver and warm-tab into execute path ([81bcd47](https://github.com/unbrowse-ai/unbrowse-dev/commit/81bcd47ba96b2316482af172095b2a8fa0712362))

### Bug Fixes

* **auth-dag:** capture full script src URLs for bearer token resolution ([995f8bb](https://github.com/unbrowse-ai/unbrowse-dev/commit/995f8bbf54acc3a5121040af15e1a930167ba136))
* **auth-dag:** resolve bearer from JS bundles via Performance API scan ([856fef4](https://github.com/unbrowse-ai/unbrowse-dev/commit/856fef4d43492e6590f347cbf0403c74e1cdde6e))
* **auth:** preserve auth headers in merge, fix vault key alignment, add token source scanning ([5c26877](https://github.com/unbrowse-ai/unbrowse-dev/commit/5c2687779ceb6e136a5de434b3ca26673693dec1))
* **capture:** add health check fallback for HAR cold start reliability ([93cfad2](https://github.com/unbrowse-ai/unbrowse-dev/commit/93cfad23737e1c7ccd2281f34d9ab0a9bb966fab))
* **capture:** always start HAR regardless of page load timeout ([5e7a7bb](https://github.com/unbrowse-ai/unbrowse-dev/commit/5e7a7bb949c1986ade1d567a75a5a657766fb246))
* **capture:** remove CDP WebSocket interference with Kuri HAR ([e16f194](https://github.com/unbrowse-ai/unbrowse-dev/commit/e16f194a388c8470da4b095a0572a3c812d55591))
* **capture:** retry waitForLoad before HAR start to survive cold starts ([ef43417](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef434171bbc8dc16bfaf8635f4d1347aa9eeef83))
* **ci:** add Zig 0.15.2 setup for Kuri build in npm preview publish ([6352fce](https://github.com/unbrowse-ai/unbrowse-dev/commit/6352fcefe857cb4bc24aea7d0062e526c1973c07))
* **ci:** clean checkout for npm publish (stale runtime-src) ([acc0c3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/acc0c3e1f8c52f0d74d257c6c4c46d4bd8a8902c))
* **ci:** disable Windows cross-compile for Kuri (getenv incompatibility) ([548e04c](https://github.com/unbrowse-ai/unbrowse-dev/commit/548e04c0d98852e39fdaa41d33737c3b4b57f49b))
* **ci:** download pre-built darwin-arm64 Kuri from GitHub release ([e503b7d](https://github.com/unbrowse-ai/unbrowse-dev/commit/e503b7d2167b6cdc6d1c2920246b4f046086a044))
* **frontend:** use static assets cache for experiments env (skip R2) ([e42a4a7](https://github.com/unbrowse-ai/unbrowse-dev/commit/e42a4a759589e135565b9c265a4d28d9c3aeacf1))
* **runtime:** always prefer dist/server.js over index.js tsx wrapper ([9f13080](https://github.com/unbrowse-ai/unbrowse-dev/commit/9f130809f7f0ef15b35d9b7369277309ef7a98de))
* **windows:** correct installer asset URL and restore build script exec bit ([6f3f946](https://github.com/unbrowse-ai/unbrowse-dev/commit/6f3f9463587bd4802bc2fe9c02bb7e68ca8ca7e8)), closes [#360](https://github.com/unbrowse-ai/unbrowse-dev/issues/360)

### Performance

* **package:** bun-build server instead of tsx runtime interpretation ([92b9fb5](https://github.com/unbrowse-ai/unbrowse-dev/commit/92b9fb58eddd81e718a57bb2d8ba2da766bb0b02))

## [3.1.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.0.4...v3.1.0) (2026-04-05)

### Features

* close x402 payment loop — auto-pay via lobster, ledger, wallet nudge ([3140a25](https://github.com/unbrowse-ai/unbrowse-dev/commit/3140a2574f131f8fb68833b376b76bfd31399955))
* make OpenClaw the primary install method across all touchpoints ([47296b4](https://github.com/unbrowse-ai/unbrowse-dev/commit/47296b47ea3545c66b44c38a6325542a6dc9b5eb))
* redesign hero CTA with tabbed install paths, OpenClaw primary ([27394c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/27394c6041a8d4a6f0372226d20114120a8c828d))
* Windows support — installer, binary, website, vendored kuri.exe ([df83f5c](https://github.com/unbrowse-ai/unbrowse-dev/commit/df83f5c52eef5c8a2c6d145afd54eb26921e1414))

### Bug Fixes

* auto-detect headless mode on Linux when no $DISPLAY is set ([47795eb](https://github.com/unbrowse-ai/unbrowse-dev/commit/47795eb611da9fe0494f4b73a2e537350ce23326)), closes [justrach/kuri#128](https://github.com/justrach/kuri/issues/128)
* enable x402 payments — set default base_price and use dynamic pricing ([4666da7](https://github.com/unbrowse-ai/unbrowse-dev/commit/4666da7b76eff1a9eb3f0fcfb1dff59e6d910725))
* pass signing secret to package-cli job and harden PyPI e2e test ([450bb52](https://github.com/unbrowse-ai/unbrowse-dev/commit/450bb52ad7e3597667a2aa156586ee49cf91559b))
* point kuri submodule at lekt9 fork for CI access ([6ab51ef](https://github.com/unbrowse-ai/unbrowse-dev/commit/6ab51ef3bf4beff9e999ef570e966ac17ec1628a))
* remove duplicate installNpm declaration and stale hero-cta tail ([8cdaa13](https://github.com/unbrowse-ai/unbrowse-dev/commit/8cdaa13b995d11508cfaec5cf292d96c05f059a7))
* restore missing imports and constants in page.tsx ([a89b76f](https://github.com/unbrowse-ai/unbrowse-dev/commit/a89b76fe590a018ee8aa8951f3c07463d3e04579))
* restore try/catch in x402 payment gate ([a5d2832](https://github.com/unbrowse-ai/unbrowse-dev/commit/a5d2832ab49be66aa48077c73d1f63e90cb72f1c))
* update landing page default path callout and FAQ to lead with OpenClaw ([e766808](https://github.com/unbrowse-ai/unbrowse-dev/commit/e7668081b006a527c0ec1449255f5866ce0946d2))
* use per-target binary names for Windows kuri.exe vendor support ([15dabfa](https://github.com/unbrowse-ai/unbrowse-dev/commit/15dabfaf705ffd0bb2f855037e0bf6314e7434ff))

## [3.0.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v3.0.1...v3.0.2) (2026-04-04)

### Features

* wire install attribution from landing page to agent registration ([f2c7e66](https://github.com/unbrowse-ai/unbrowse-dev/commit/f2c7e6682de2c54b2c3f75f3859f164f6fc8be8f))

## [3.0.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-04)

### Features

* add foundry bundle publish workflow ([d892e41](https://github.com/unbrowse-ai/unbrowse-dev/commit/d892e41ea432cb20bb9fa401b894f05903c9bc03))
* add routing analytics summaries ([1c22fc7](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c22fc733ce34f0fa5e653c1e71a460ae85c6d0d))
* add routing telemetry and harden cli flows ([973b62e](https://github.com/unbrowse-ai/unbrowse-dev/commit/973b62edd5acab3907ded95845e4d043401a7e17))
* add routing telemetry prep ([#330](https://github.com/unbrowse-ai/unbrowse-dev/issues/330)) ([ad05e6f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ad05e6f12daf27dbd2cf4027406aac8c0f8334a4))
* add X campaign feedback operator bundle ([b65530e](https://github.com/unbrowse-ai/unbrowse-dev/commit/b65530eef987b4fae9bc91367f9ff9e5671050b1))
* gate policy-sensitive site mutations ([#328](https://github.com/unbrowse-ai/unbrowse-dev/issues/328)) ([8e0c7b1](https://github.com/unbrowse-ai/unbrowse-dev/commit/8e0c7b1de95fe6513de73ea2a5ccbc8b9d6885c9))
* sharpen landing page positioning for OpenClaw miners ([36270e0](https://github.com/unbrowse-ai/unbrowse-dev/commit/36270e090040fcf9f9cc769114b5dbd07de9775a))
* verify release manifests and gate endpoints by corroboration ([15eccd1](https://github.com/unbrowse-ai/unbrowse-dev/commit/15eccd14123131bf111a8c000d1663b207032aec))

### Bug Fixes

* bound frontend build api fetches ([f74bf7c](https://github.com/unbrowse-ai/unbrowse-dev/commit/f74bf7c3fe97c7f0444b8878f34d7282b8809d92))
* bound stale endpoint verification batches ([e98d95c](https://github.com/unbrowse-ai/unbrowse-dev/commit/e98d95c4fc75d581c78bcbc0427cb146ee4a6dd9))
* disable local npm release handling ([6dd2ce1](https://github.com/unbrowse-ai/unbrowse-dev/commit/6dd2ce19b24dfff96cbe724b0e9ed57f0ef1319a))
* gate skills.sh registration on successful setup ([eae71a8](https://github.com/unbrowse-ai/unbrowse-dev/commit/eae71a8f8612849a04e7cee43e004a1a64e74adc))
* harden global install fallback and server version guards ([#323](https://github.com/unbrowse-ai/unbrowse-dev/issues/323)) ([ee91923](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee9192312766d8756b0691c5e45a2beec639085f))
* harden packaged kuri recovery ([16e89b5](https://github.com/unbrowse-ai/unbrowse-dev/commit/16e89b52c6eced2010327e7d2d2bae96aa5ff0d5))
* install unbrowse shim in stable user bins ([#326](https://github.com/unbrowse-ai/unbrowse-dev/issues/326)) ([6a69c66](https://github.com/unbrowse-ai/unbrowse-dev/commit/6a69c665659bfd67b72f64b9d807e19f11877d97))
* isolate browse sessions under parallel load ([3194c8e](https://github.com/unbrowse-ai/unbrowse-dev/commit/3194c8e79536e0cac53dcad4328d507f3bd7efae))
* isolate main CI local server and KV cache ([#325](https://github.com/unbrowse-ai/unbrowse-dev/issues/325)) ([c58711b](https://github.com/unbrowse-ai/unbrowse-dev/commit/c58711b72c428a7d9ceb518f6027cf222ebc7e37))
* make marketplace search free before paid skill detail ([#327](https://github.com/unbrowse-ai/unbrowse-dev/issues/327)) ([e9e1e7f](https://github.com/unbrowse-ai/unbrowse-dev/commit/e9e1e7f9287ad13c56dbf494c468a5072db334cc))
* publish release assets to public repo ([f69e97a](https://github.com/unbrowse-ai/unbrowse-dev/commit/f69e97a01a3ce3f18014bb1bc684ac65d4c5a7e5))
* restore auth fallback and harden indexing ([1a30053](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a3005306f892e785c53efc760207b06ae78939e))
* restore gh in release workflow ([d1861f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/d1861f40af17d613abffb859c5a34797b0c526f7))
* restore packaged cli staging path ([bec02dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/bec02dde63b91d15a8e5cd37718025e5142d551c))
* stabilize browse submit recovery ([c586d5e](https://github.com/unbrowse-ai/unbrowse-dev/commit/c586d5e53ee34e7c3b6b051f38f9722f5ee7dadf))
* stabilize kuri proxy and add experiments deploy env ([255eb57](https://github.com/unbrowse-ai/unbrowse-dev/commit/255eb57da753d79e0066ff9e03b715bd26918c88))
* unblock cli bootstrap and e2e smoke ([9cf533b](https://github.com/unbrowse-ai/unbrowse-dev/commit/9cf533bfe632c555b9abad87ffb063a53d61bb1e))
* unblock cli wallet setup and auth e2e ([c92f39f](https://github.com/unbrowse-ai/unbrowse-dev/commit/c92f39f679966507686306dca57510ded95f0c55))
* unblock main ci checks ([72f7cd9](https://github.com/unbrowse-ai/unbrowse-dev/commit/72f7cd9e4b640453b20cc96db421b6ac799a16de))
* use wrangler for preview frontend deploys ([8543152](https://github.com/unbrowse-ai/unbrowse-dev/commit/8543152a0820bd2991d687d179e427e077ce2e40))

## [2.12.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-03)

### Features

* run Codex PR agent from GitHub webhooks ([#312](https://github.com/unbrowse-ai/unbrowse-dev/issues/312)) ([2a546b7](https://github.com/unbrowse-ai/unbrowse-dev/commit/2a546b71e424d898022d4db9aabaae867fe99798))

### Bug Fixes

* auto-queue browse submit publish and document public repo ([9905005](https://github.com/unbrowse-ai/unbrowse-dev/commit/9905005afa86402ac75d521381e6ca2eec1ab184))
* auto-queue browse submit publish and document public repo ([#314](https://github.com/unbrowse-ai/unbrowse-dev/issues/314)) ([7c726ad](https://github.com/unbrowse-ai/unbrowse-dev/commit/7c726adcb2f6a7ebeaf76405da4ab722b839d5d1))
* harden packaged install fallback and add publish smoke ([#324](https://github.com/unbrowse-ai/unbrowse-dev/issues/324)) ([1c4aa79](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c4aa7953327b4056b87f50080d6b7d0830b1249))
* install gh and checks scope for PR agent runner ([#318](https://github.com/unbrowse-ai/unbrowse-dev/issues/318)) ([f7ff6b4](https://github.com/unbrowse-ai/unbrowse-dev/commit/f7ff6b418a02e8cf7621eaa926b6c75409a6174d))
* install gh for PR agent runner ([#315](https://github.com/unbrowse-ai/unbrowse-dev/issues/315)) ([2415a26](https://github.com/unbrowse-ai/unbrowse-dev/commit/2415a2604b5f7acf615dde4b5aed5f0a9ba3e1f5))
* preserve backend kv binding during CI release deploys ([#282](https://github.com/unbrowse-ai/unbrowse-dev/issues/282)) ([47e0c72](https://github.com/unbrowse-ai/unbrowse-dev/commit/47e0c7223a24f68e84f8ebec4b4892acb635f217))
* restore skills.sh discovery gate ([#285](https://github.com/unbrowse-ai/unbrowse-dev/issues/285)) ([e5299f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/e5299f480ec2b19ca85981f6706d0edf155aaed2))
* ship standalone repo setup and main-base docs ([#281](https://github.com/unbrowse-ai/unbrowse-dev/issues/281)) ([2c66398](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c663989fd7b31aa3a87b5fed29b71c22c088f8e))
* simplify install setup path ([3c31214](https://github.com/unbrowse-ai/unbrowse-dev/commit/3c3121463836421b68187985dc5f29d761350911))
* simplify install setup path ([#294](https://github.com/unbrowse-ai/unbrowse-dev/issues/294)) ([98d97d3](https://github.com/unbrowse-ai/unbrowse-dev/commit/98d97d30beaa737511f02926e5c43f3f648600b5))
* simplify install setup path ([#295](https://github.com/unbrowse-ai/unbrowse-dev/issues/295)) ([a4c7fa9](https://github.com/unbrowse-ai/unbrowse-dev/commit/a4c7fa94d90a412042eda4184fd66c83705aa676))

## [2.11.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Features

* **#100:** implement robots.txt directive checking before route execution ([d920e7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/d920e7e87058a3ea645e24b0f4441b44d8442867)), closes [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100) [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100)

### Bug Fixes

* harden browse submit recovery ([652f03b](https://github.com/unbrowse-ai/unbrowse-dev/commit/652f03b8146744fbfac4f0e70faee3798754db71))
* harden main release workflow reruns ([f80cd5d](https://github.com/unbrowse-ai/unbrowse-dev/commit/f80cd5d3a5ada81fa285ca59e302c26aa47bb02d))
* publish runtime deps in npm package ([9659770](https://github.com/unbrowse-ai/unbrowse-dev/commit/96597707c161a2de9f1424bbb622e0be203e7fbf))
* retarget docs and PR helpers to main ([0c4c5d1](https://github.com/unbrowse-ai/unbrowse-dev/commit/0c4c5d1874066b93968de7aa72e803717562a8e0))
* seed canonical replay after x402 detail search ([6524063](https://github.com/unbrowse-ai/unbrowse-dev/commit/6524063b3ee9f77f7fb8a1e187291bb7ec72066b))
* unblock worker deployment ([ef8a5ba](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef8a5badb2868c20fde988ebb98b123201e8da36))

## [2.10.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Bug Fixes

* unblock self-hosted releases ([5dd2139](https://github.com/unbrowse-ai/unbrowse-dev/commit/5dd2139f49068cb2eb24a15489833b7a4c187638))

## [2.10.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Features

* publish openclaw npm install flow ([ab1257f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab1257f1ff2c180d7bb07a390a7270555ffe896e))
* publish openclaw npm install flow ([#260](https://github.com/unbrowse-ai/unbrowse-dev/issues/260)) ([2e6a252](https://github.com/unbrowse-ai/unbrowse-dev/commit/2e6a2520393a5f2bf9e0ed5e9a5e1c34b14973a8))
* restore canonical analytics surface ([#262](https://github.com/unbrowse-ai/unbrowse-dev/issues/262)) ([78f83c8](https://github.com/unbrowse-ai/unbrowse-dev/commit/78f83c827b3d9292da16b5eaebf98cc6b63b8b2d))
* ship wallet-first dashboard on restart-base ([#265](https://github.com/unbrowse-ai/unbrowse-dev/issues/265)) ([a673969](https://github.com/unbrowse-ai/unbrowse-dev/commit/a67396913f90b87acf705e60b9042c94cfe34610))
* track analytics sessions by trace version ([5954238](https://github.com/unbrowse-ai/unbrowse-dev/commit/595423886b426a3032fb683e83b4e4bd102d3931))

### Bug Fixes

* ship worker payments and lobster x402 e2e ([#263](https://github.com/unbrowse-ai/unbrowse-dev/issues/263)) ([d3ec78f](https://github.com/unbrowse-ai/unbrowse-dev/commit/d3ec78fa049378bb9066f55f707ed608dc560daf))
* unblock openclaw install PR ([422096b](https://github.com/unbrowse-ai/unbrowse-dev/commit/422096b734ebd926a136286a221be2c4a0be71c2))

## [2.9.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Features

* add /unbrowse-eval skill + eval:agent script for agent-driven site testing ([42790c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/42790c68760126f9ee790360e20715cbdf4a6127))

### Bug Fixes

* cookie injection via raw CDP for full secure/httpOnly/sameSite support ([0a7903d](https://github.com/unbrowse-ai/unbrowse-dev/commit/0a7903d0dc762ba2f9b67c054d749d8066e87459))

## [2.9.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Features

* add `unbrowse publish` command — two-phase agent-driven skill publish ([0846b7a](https://github.com/unbrowse-ai/unbrowse-dev/commit/0846b7aca82e92896a84a6fef9d233bdecd39e67))
* add popular-sites eval set (5 cases) with first run results ([8d579be](https://github.com/unbrowse-ai/unbrowse-dev/commit/8d579bef2c64e8c686a129e5f3bae25bdd46d1b3))
* DOM extraction fallback for server-rendered sites ([c515259](https://github.com/unbrowse-ai/unbrowse-dev/commit/c51525952ee55fa1c4d470dd1c02afddc3a6cfbb))
* execute response includes _review_hint for agent description ([d9c2e94](https://github.com/unbrowse-ai/unbrowse-dev/commit/d9c2e94eac4fac174acea074851938704b83e25c))

### Bug Fixes

* check intercepted API responses before DOM extraction ([28f3344](https://github.com/unbrowse-ai/unbrowse-dev/commit/28f3344335f6bdd98dd91654bacd93113d313cbe))
* endpoint routing bugs + resolve pipeline analysis ([7cfb99c](https://github.com/unbrowse-ai/unbrowse-dev/commit/7cfb99c7dd50750e99dcaf517e026b5786b8d24e))
* increase interceptor body limit 512KB→2MB, broaden content-type match ([5f2deb0](https://github.com/unbrowse-ai/unbrowse-dev/commit/5f2deb065b2e99cf822ee3cf8f3d01bdbd52227c))
* marketplace publish timeout 8s → 30s ([735d523](https://github.com/unbrowse-ai/unbrowse-dev/commit/735d523b6f612d8b2ed81795a1be177c1e9b5c96))
* re-cache skill after publishSkill to prevent backend overwriting local descriptions ([d7df66c](https://github.com/unbrowse-ai/unbrowse-dev/commit/d7df66c8cd16c3e446eb8db53be6ce3d6a62d9da))
* split interceptor into <1KB chunks for kuri evaluate limit ([7f60bfb](https://github.com/unbrowse-ai/unbrowse-dev/commit/7f60bfbe52553e78aa5e2ae0554d06953c8e4f72))
* syntax errors in DOM fallback and captured var duplicate ([5ad51ba](https://github.com/unbrowse-ai/unbrowse-dev/commit/5ad51ba374088167ee805358a7fcf6a20933d542))

### Refactoring

* remove external LLM calls from resolve/execute pipeline ([83b8647](https://github.com/unbrowse-ai/unbrowse-dev/commit/83b864761b717200a6263d08030e42af50b518ae))

## [2.8.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-02)

### Features

* **#100:** implement robots.txt directive checking before route execution ([b319f75](https://github.com/unbrowse-ai/unbrowse-dev/commit/b319f750ee1737c1c958af3350e1e0d78f7383ce)), closes [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100) [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100)
* **#103:** add composite search scoring to backend ([#196](https://github.com/unbrowse-ai/unbrowse-dev/issues/196)) ([202af76](https://github.com/unbrowse-ai/unbrowse-dev/commit/202af768f8c9d8cf1e1c6e888ad3cf6bbad607eb)), closes [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103)
* **#115:** add DAG advisory execution planner ([0923565](https://github.com/unbrowse-ai/unbrowse-dev/commit/09235655d934e24ce05882b87b0e3b1eda28e487)), closes [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115) [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115)
* **#115:** add DAG advisory execution planner ([ec40df7](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec40df75a308aebe48d85cd7c7ee09c72e75c80a)), closes [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115) [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115)
* **#116:** add auth dependency runtime with LocalAuthRuntime ([#186](https://github.com/unbrowse-ai/unbrowse-dev/issues/186)) ([e9aa3ad](https://github.com/unbrowse-ai/unbrowse-dev/commit/e9aa3add4600250fe1b8be645933a9e6fb730c84)), closes [#116](https://github.com/unbrowse-ai/unbrowse-dev/issues/116)
* **#116:** add auth dependency runtime with LocalAuthRuntime ([#186](https://github.com/unbrowse-ai/unbrowse-dev/issues/186)) ([c2e9158](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2e9158ea353bea353fad9eabdfc61ceecd13522)), closes [#116](https://github.com/unbrowse-ai/unbrowse-dev/issues/116)
* **#117:** add telemetry-driven issue filing with repro bundles ([#187](https://github.com/unbrowse-ai/unbrowse-dev/issues/187)) ([43dad34](https://github.com/unbrowse-ai/unbrowse-dev/commit/43dad34601c34be7ca8b227f2102d614da7f3a8e)), closes [#117](https://github.com/unbrowse-ai/unbrowse-dev/issues/117)
* **#117:** add telemetry-driven issue filing with repro bundles ([#187](https://github.com/unbrowse-ai/unbrowse-dev/issues/187)) ([f237060](https://github.com/unbrowse-ai/unbrowse-dev/commit/f2370608aa1daa9b257f5a579ab3dfd721cb1f1a)), closes [#117](https://github.com/unbrowse-ai/unbrowse-dev/issues/117)
* **#117:** add telemetry-driven issue filing with repro bundles ([#197](https://github.com/unbrowse-ai/unbrowse-dev/issues/197)) ([0b5c641](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b5c6417d2753af374491f30b098ed74af42492c)), closes [#117](https://github.com/unbrowse-ai/unbrowse-dev/issues/117)
* **#121:** browser host path for OpenAI/native ([#191](https://github.com/unbrowse-ai/unbrowse-dev/issues/191)) ([ba78c13](https://github.com/unbrowse-ai/unbrowse-dev/commit/ba78c1319d942f02cfaab31e4fac82f637189fd9)), closes [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#91](https://github.com/unbrowse-ai/unbrowse-dev/issues/91) [#112](https://github.com/unbrowse-ai/unbrowse-dev/issues/112) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#121:** browser host path for OpenAI/native ([#191](https://github.com/unbrowse-ai/unbrowse-dev/issues/191)) ([69c18d5](https://github.com/unbrowse-ai/unbrowse-dev/commit/69c18d5c33e87a5eaff4529d9e90563cb963fff8)), closes [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#91](https://github.com/unbrowse-ai/unbrowse-dev/issues/91) [#112](https://github.com/unbrowse-ai/unbrowse-dev/issues/112) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#123:** analytics bottleneck metrics ([#198](https://github.com/unbrowse-ai/unbrowse-dev/issues/198)) ([99c848e](https://github.com/unbrowse-ai/unbrowse-dev/commit/99c848e8e9e1360331c8812946210662a63506b8)), closes [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#125](https://github.com/unbrowse-ai/unbrowse-dev/issues/125) [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123)
* **#123:** analytics bottleneck metrics ([#198](https://github.com/unbrowse-ai/unbrowse-dev/issues/198)) ([185a0aa](https://github.com/unbrowse-ai/unbrowse-dev/commit/185a0aa66cccf30870c1087360ead4cce9b42553)), closes [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#125](https://github.com/unbrowse-ai/unbrowse-dev/issues/125) [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123)
* **#144:** add batch path template mining for passive captures ([9c30cd7](https://github.com/unbrowse-ai/unbrowse-dev/commit/9c30cd722665c54fb7e18d54bef4b0288c09b3e4)), closes [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144) [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144)
* **#144:** batch path template mining for captures without context URLs ([#204](https://github.com/unbrowse-ai/unbrowse-dev/issues/204)) ([07d3461](https://github.com/unbrowse-ai/unbrowse-dev/commit/07d3461f5f46217991fa52cd78dccca600d78171)), closes [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144)
* **#144:** batch path template mining for captures without context URLs ([#204](https://github.com/unbrowse-ai/unbrowse-dev/issues/204)) ([9469115](https://github.com/unbrowse-ai/unbrowse-dev/commit/9469115887b4b623f34e045caa16d6cf0e7a0f0c)), closes [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144)
* **#155:** add BM25 lexical search with RRF fusion ([fc0ce39](https://github.com/unbrowse-ai/unbrowse-dev/commit/fc0ce39a4707bb414f9c075dd39f06061697aa89)), closes [#155](https://github.com/unbrowse-ai/unbrowse-dev/issues/155)
* **#155:** add BM25 lexical search with RRF fusion ([#202](https://github.com/unbrowse-ai/unbrowse-dev/issues/202)) ([a68b84a](https://github.com/unbrowse-ai/unbrowse-dev/commit/a68b84a711d6def5fadbeed31de2381db9a5b309)), closes [#155](https://github.com/unbrowse-ai/unbrowse-dev/issues/155)
* **#155:** add BM25 lexical search with RRF fusion ([#202](https://github.com/unbrowse-ai/unbrowse-dev/issues/202)) ([711db93](https://github.com/unbrowse-ai/unbrowse-dev/commit/711db93da9e6b50ebd6a11b59b14f9d47dfdc537)), closes [#155](https://github.com/unbrowse-ai/unbrowse-dev/issues/155)
* **#165:** ground LLM descriptions in params and responses ([#189](https://github.com/unbrowse-ai/unbrowse-dev/issues/189)) ([c2c85dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2c85dd58244ef468ed353e2606bcf6fee26dec1)), closes [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103)
* **#165:** ground LLM descriptions in params and responses ([#189](https://github.com/unbrowse-ai/unbrowse-dev/issues/189)) ([0558c6c](https://github.com/unbrowse-ai/unbrowse-dev/commit/0558c6cfb12df655f6be922d284548b27443bfeb)), closes [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103)
* **#175:** RSC wire format support in capture ([#188](https://github.com/unbrowse-ai/unbrowse-dev/issues/188)) ([55c9e22](https://github.com/unbrowse-ai/unbrowse-dev/commit/55c9e2222a1b3db954738adeb1c07de7fe5d0e51)), closes [#175](https://github.com/unbrowse-ai/unbrowse-dev/issues/175) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165)
* **#175:** RSC wire format support in capture ([#188](https://github.com/unbrowse-ai/unbrowse-dev/issues/188)) ([0956633](https://github.com/unbrowse-ai/unbrowse-dev/commit/0956633ac7a344fa53d6d7cf5c329dfe3fe5b898)), closes [#175](https://github.com/unbrowse-ai/unbrowse-dev/issues/175) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165)
* **#213,#90,#214:** domain/task CLI, server supervisor, action provenance ([#215](https://github.com/unbrowse-ai/unbrowse-dev/issues/215)) ([a9bec5c](https://github.com/unbrowse-ai/unbrowse-dev/commit/a9bec5c83030fc006b5ca23e2b3d41a20a04fa5b)), closes [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90) [#214](https://github.com/unbrowse-ai/unbrowse-dev/issues/214) [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#213,#90,#214:** domain/task CLI, server supervisor, action provenance ([#215](https://github.com/unbrowse-ai/unbrowse-dev/issues/215)) ([0a7c130](https://github.com/unbrowse-ai/unbrowse-dev/commit/0a7c130e3af7b3a77ebfa6f9d7cd22a6dcdf8214)), closes [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90) [#214](https://github.com/unbrowse-ai/unbrowse-dev/issues/214) [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#218:** wire DAG planner to backend EmergentDB graph ([#255](https://github.com/unbrowse-ai/unbrowse-dev/issues/255)) ([5122cbf](https://github.com/unbrowse-ai/unbrowse-dev/commit/5122cbf72d78228b2711cef63b5fb70329d1ea76)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218) [#222](https://github.com/unbrowse-ai/unbrowse-dev/issues/222) [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230) [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#218:** wire runtime DAG to backend EmergentDB graph ([5035a82](https://github.com/unbrowse-ai/unbrowse-dev/commit/5035a8209fca45e1eed3d35d4bbb69f31564c93f)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#218:** wire runtime DAG to backend EmergentDB graph ([66614d6](https://github.com/unbrowse-ai/unbrowse-dev/commit/66614d67a9b3177b5a6f67780ba820a505bb966e)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#220:** wire computeBottleneckMetrics into backend analytics route ([c0e037a](https://github.com/unbrowse-ai/unbrowse-dev/commit/c0e037acffe6ca6df19f0b08a251fe11268e2737)), closes [#220](https://github.com/unbrowse-ai/unbrowse-dev/issues/220)
* **#28:** anonymized route trace telemetry pipeline ([#206](https://github.com/unbrowse-ai/unbrowse-dev/issues/206)) ([624ec47](https://github.com/unbrowse-ai/unbrowse-dev/commit/624ec4793ff2f40753efd982ca19b8f946308698)), closes [#28](https://github.com/unbrowse-ai/unbrowse-dev/issues/28)
* **#28:** anonymized route trace telemetry pipeline ([#206](https://github.com/unbrowse-ai/unbrowse-dev/issues/206)) ([c65387e](https://github.com/unbrowse-ai/unbrowse-dev/commit/c65387e535a0ad14056f6df2f848b18e60eb61c3)), closes [#28](https://github.com/unbrowse-ai/unbrowse-dev/issues/28)
* **#32,#33:** lobster.cash-compatible payment integration ([#216](https://github.com/unbrowse-ai/unbrowse-dev/issues/216)) ([b38deba](https://github.com/unbrowse-ai/unbrowse-dev/commit/b38deba9df342906b6ad209d6efbc01e7417ff98)), closes [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#32,#33:** lobster.cash-compatible payment integration ([#216](https://github.com/unbrowse-ai/unbrowse-dev/issues/216)) ([02e607a](https://github.com/unbrowse-ai/unbrowse-dev/commit/02e607a16a678f8b290013e727fb975c393963ac)), closes [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** add x402 payment lane stub with PaymentGate interface ([#184](https://github.com/unbrowse-ai/unbrowse-dev/issues/184)) ([49a7546](https://github.com/unbrowse-ai/unbrowse-dev/commit/49a75463afed6329bd35aa0076b0cf513919f37f)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** add x402 payment lane stub with PaymentGate interface ([#184](https://github.com/unbrowse-ai/unbrowse-dev/issues/184)) ([c50e973](https://github.com/unbrowse-ai/unbrowse-dev/commit/c50e973204b4475a26676f7752404d676a854459)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire payment gate into runtime orchestrator ([08a3bf7](https://github.com/unbrowse-ai/unbrowse-dev/commit/08a3bf7674f8dc9929a57de89f4028a368332a90)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire payment gate into runtime orchestrator ([e21ac09](https://github.com/unbrowse-ai/unbrowse-dev/commit/e21ac0961c584ef1916f6e71dabc71dcd95aa952)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire x402 payment gating and fee recording into backend routes ([3bce394](https://github.com/unbrowse-ai/unbrowse-dev/commit/3bce3941c1295799807ba4aa3a8bc1f3f38f6b15)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire x402 payment gating and fee recording into backend routes ([56a9d2c](https://github.com/unbrowse-ai/unbrowse-dev/commit/56a9d2cb0ace2fe08f2af690adad4bd43fe69bba)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#40:** dynamic route pricing and site-owner opt-in compensation ([#210](https://github.com/unbrowse-ai/unbrowse-dev/issues/210)) ([1a50d5f](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a50d5f8145ea2fa8d360779f637451cf47708a3)), closes [#40](https://github.com/unbrowse-ai/unbrowse-dev/issues/40)
* **#40:** dynamic route pricing and site-owner opt-in compensation ([#210](https://github.com/unbrowse-ai/unbrowse-dev/issues/210)) ([0588257](https://github.com/unbrowse-ai/unbrowse-dev/commit/05882574832e8e2d633a084139de2e0919143121)), closes [#40](https://github.com/unbrowse-ai/unbrowse-dev/issues/40)
* **#87:** wire unsafe action score gate into auto-execution ([#199](https://github.com/unbrowse-ai/unbrowse-dev/issues/199)) ([30885dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/30885dd54ee1ebd16cd72e20bd6ccf9019814061)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#87:** wire unsafe action score gate into auto-execution ([#199](https://github.com/unbrowse-ai/unbrowse-dev/issues/199)) ([12019da](https://github.com/unbrowse-ai/unbrowse-dev/commit/12019da546f3514aa97857f5cb07c4255c02259a)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#87:** wire unsafe action score gate into canAutoExecuteEndpoint ([#182](https://github.com/unbrowse-ai/unbrowse-dev/issues/182)) ([10cf5cd](https://github.com/unbrowse-ai/unbrowse-dev/commit/10cf5cd0240cd039e570da7d4a13d2b709200f10)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#87:** wire unsafe action score gate into canAutoExecuteEndpoint ([#182](https://github.com/unbrowse-ai/unbrowse-dev/issues/182)) ([d5bbf64](https://github.com/unbrowse-ai/unbrowse-dev/commit/d5bbf647c6ace8b5af79337e3ba1c55bb229b64e)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#91,#112,#90:** add host integrations, login UX config, runtime supervisor ([#195](https://github.com/unbrowse-ai/unbrowse-dev/issues/195)) ([966ec32](https://github.com/unbrowse-ai/unbrowse-dev/commit/966ec3249b81ef8b03e62e67ccde843d8c81ac61)), closes [#91](https://github.com/unbrowse-ai/unbrowse-dev/issues/91) [#112](https://github.com/unbrowse-ai/unbrowse-dev/issues/112) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#92,#93,#95,#96:** search forms, eval types, lifecycle attribution ([#194](https://github.com/unbrowse-ai/unbrowse-dev/issues/194)) ([b394ea2](https://github.com/unbrowse-ai/unbrowse-dev/commit/b394ea240a178ff0236dfad227323743c01c91ab)), closes [#92](https://github.com/unbrowse-ai/unbrowse-dev/issues/92) [#93](https://github.com/unbrowse-ai/unbrowse-dev/issues/93) [#95](https://github.com/unbrowse-ai/unbrowse-dev/issues/95) [#96](https://github.com/unbrowse-ai/unbrowse-dev/issues/96) [#92](https://github.com/unbrowse-ai/unbrowse-dev/issues/92) [#93](https://github.com/unbrowse-ai/unbrowse-dev/issues/93) [#95](https://github.com/unbrowse-ai/unbrowse-dev/issues/95)
* **#98:** delta-based contribution attribution for Tier 1 fee splits ([#209](https://github.com/unbrowse-ai/unbrowse-dev/issues/209)) ([92aa403](https://github.com/unbrowse-ai/unbrowse-dev/commit/92aa4032c28964d0f0f19589364f7ba7ea9cb597)), closes [#98](https://github.com/unbrowse-ai/unbrowse-dev/issues/98)
* **#98:** delta-based contribution attribution for Tier 1 fee splits ([#209](https://github.com/unbrowse-ai/unbrowse-dev/issues/209)) ([be76f05](https://github.com/unbrowse-ai/unbrowse-dev/commit/be76f05d49ea40a9bb4d3b074626d5c2f0a057b4)), closes [#98](https://github.com/unbrowse-ai/unbrowse-dev/issues/98)
* **#99,#101:** wire consecutive failures and schema drift to auto-deprecation ([#192](https://github.com/unbrowse-ai/unbrowse-dev/issues/192)) ([09fec9d](https://github.com/unbrowse-ai/unbrowse-dev/commit/09fec9d5ab78ee5c4d53806c20018c5385b7a006)), closes [#99](https://github.com/unbrowse-ai/unbrowse-dev/issues/99) [#101](https://github.com/unbrowse-ai/unbrowse-dev/issues/101)
* **#99,#101:** wire consecutive failures and schema drift to auto-deprecation ([#192](https://github.com/unbrowse-ai/unbrowse-dev/issues/192)) ([129e8e4](https://github.com/unbrowse-ai/unbrowse-dev/commit/129e8e47b0901645b0c6ad1168d16e2861063140)), closes [#99](https://github.com/unbrowse-ai/unbrowse-dev/issues/99) [#101](https://github.com/unbrowse-ai/unbrowse-dev/issues/101)
* **01-01:** wire scriptInject before navigation, remove polling loop ([324b41d](https://github.com/unbrowse-ai/unbrowse-dev/commit/324b41dec6e297edc73b5139ec8daf93cb02326e))
* **01-02:** add collectExtensionRequests function ([1d8bcc1](https://github.com/unbrowse-ai/unbrowse-dev/commit/1d8bcc10b0ce510416a6feff4c2710d12ea420d5))
* **01-02:** add mergePassiveCaptureData and wire merge pipeline ([2d4e431](https://github.com/unbrowse-ai/unbrowse-dev/commit/2d4e431e49138b66f19efc26bc12dd3168962864))
* **02-01:** add background indexing queue and export cache helpers ([a65cb91](https://github.com/unbrowse-ai/unbrowse-dev/commit/a65cb91323a1ac98dd5932380ed72a44c14704fd))
* **02-02:** wire background indexer into capture, enable cache-first resolution ([ddcd882](https://github.com/unbrowse-ai/unbrowse-dev/commit/ddcd88246a58c2d2c5c618319dacaea52398b027))
* **03-01:** add Browser/Page API surface with skill-first navigation ([1b66c08](https://github.com/unbrowse-ai/unbrowse-dev/commit/1b66c08b98a78184b504c411f4bc7b53bd4765ae))
* **03-02:** wire live capture fallback and verify UI action degradation ([7303f91](https://github.com/unbrowse-ai/unbrowse-dev/commit/7303f91dc7dec50494728a0e510c604ddd93c513))
* **04-01:** add typed graph edges (parent_child, pagination, auth) and fix persistence ([cf63387](https://github.com/unbrowse-ai/unbrowse-dev/commit/cf63387534e20352b6571556bed64b34f032390d))
* **04-02:** rewrite prefetch module with graph-based edge traversal ([d8627e4](https://github.com/unbrowse-ai/unbrowse-dev/commit/d8627e4a2b4358f6d9770732e3af0cbf03024798))
* **04-02:** wire prefetch into resolve and add reachability filtering ([fd1db42](https://github.com/unbrowse-ai/unbrowse-dev/commit/fd1db4266d88b48729a515438cc767871d0a612d))
* **05-01:** publish graph edges alongside skills in both publish paths ([1a4be09](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a4be099a5296b25c4449c088c16dcf4b9d2f9d5))
* **05-02:** auto-file GitHub issues from agent errors with repro context ([db1c6db](https://github.com/unbrowse-ai/unbrowse-dev/commit/db1c6db972b5625be84b1c9ba887944e677b0b1b))
* **06-01:** wire payment gate into execution pipeline ([830e554](https://github.com/unbrowse-ai/unbrowse-dev/commit/830e554de48b4d49231120f33b318b6a18047446))
* **06-02:** add client-side getTransactionHistory, getCreatorEarnings, setSkillPrice ([719a62f](https://github.com/unbrowse-ai/unbrowse-dev/commit/719a62fdc6ee4c083b0367b7ed093440588f692e))
* **06-02:** add transaction/attribution routes and PATCH skills price ([c60c829](https://github.com/unbrowse-ai/unbrowse-dev/commit/c60c8298440f9638df1e1f42712d0bc0e9bcc104))
* **06-02:** create KV-based transaction ledger service ([8bb4e3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/8bb4e3efc6e9c3058fc34a66911fd83686aeb714))
* add curl-based install script served from unbrowse.ai ([adbc3f1](https://github.com/unbrowse-ai/unbrowse-dev/commit/adbc3f13d6671f08940118a95ee93cf893121e78))
* add GitBook docs embed widget + rename shadow APIs to internal APIs ([348759f](https://github.com/unbrowse-ai/unbrowse-dev/commit/348759fc350a070cbdaebaca290e9e0ef571b336))
* add GraphSession for passive request indexing against operation graph ([20bd110](https://github.com/unbrowse-ai/unbrowse-dev/commit/20bd110186507016de4c286965759b02fe3a1d54))
* add GraphSession for passive request indexing against operation graph ([189ec74](https://github.com/unbrowse-ai/unbrowse-dev/commit/189ec7467a26a4b984d88ed90f601b4a798488c4))
* add gstack-style ./setup script for one-liner installation ([8223b8b](https://github.com/unbrowse-ai/unbrowse-dev/commit/8223b8b769e521ee4946aaa6f7fd339d89b92926))
* add lobster.cash install hint to setup when no wallet configured ([aca7d67](https://github.com/unbrowse-ai/unbrowse-dev/commit/aca7d67b9ae522c94cea793895e5efd07aa45b7b))
* add P0/P1 automated regression testing framework ([2993299](https://github.com/unbrowse-ai/unbrowse-dev/commit/299329931f6688baca7ef29c9da543e12ae7c6eb))
* add wallet precheck to setup (lobster.cash compatible) ([07e9557](https://github.com/unbrowse-ai/unbrowse-dev/commit/07e9557827b4c1e2ab5df2ba2dae96d54e806ed7))
* **auth:** add Comet browser support for cookie extraction and login ([cda5bc8](https://github.com/unbrowse-ai/unbrowse-dev/commit/cda5bc83085808cf098f81cc54ddf7ad9ace6850))
* auto-run lobster.cash wallet setup during unbrowse setup ([c8d64b2](https://github.com/unbrowse-ai/unbrowse-dev/commit/c8d64b2769fafd904acfbb403fc6fc78a68e0a56))
* delta decay — contributors lose share when routes become stale ([90c77c0](https://github.com/unbrowse-ai/unbrowse-dev/commit/90c77c0116ed1ab462ac2f760243fbfc06c63367))
* embed kuri in single binary, extract on first run ([8a1b967](https://github.com/unbrowse-ai/unbrowse-dev/commit/8a1b967053b77e9707ab9ed03cda2fb28351ace0))
* enrich resolve with deep schema, sample values, and CLI extraction ([c29ca9f](https://github.com/unbrowse-ai/unbrowse-dev/commit/c29ca9f98b1c8cdc93097f5d1425993f0595aa24))
* extend CaptureResult with optional graph_session field ([a88dd27](https://github.com/unbrowse-ai/unbrowse-dev/commit/a88dd27ce42a80f473337fd06fbb5e639a3a8a83))
* extend CaptureResult with optional graph_session field ([022360c](https://github.com/unbrowse-ai/unbrowse-dev/commit/022360c20af75c84ac10c7ee631f41286292f210))
* feature flag out extra plugins, keep skill + one-shot + manual ([01e411a](https://github.com/unbrowse-ai/unbrowse-dev/commit/01e411a682be30392c4b8ba819740b72aa0c53df))
* **frontend:** enable Cloudflare image optimization and fix build ([30acdf4](https://github.com/unbrowse-ai/unbrowse-dev/commit/30acdf469634bd21ce7450c84f884b456051f7cb))
* **frontend:** enable Cloudflare image optimization and fix build ([b1de15f](https://github.com/unbrowse-ai/unbrowse-dev/commit/b1de15fafe815383c009ecee04b93ab5ac7cb4fd))
* handle x402 payment responses in API client ([fa763c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/fa763c6768f5a4d3f67e56100f8fb69e33586471))
* **kuri:** add browser action primitive wrappers ([57ecc46](https://github.com/unbrowse-ai/unbrowse-dev/commit/57ecc4650a94bb2f8cc8cc2ee7c473bd9e5eabdf))
* multi-chain x402 payment gate (Solana + Base USDC) ([3dbaded](https://github.com/unbrowse-ai/unbrowse-dev/commit/3dbadeddebd9ea23a6be3e573c1ed786f92de991))
* multi-contributor revenue splits via Cascade protocol ([c45f5ec](https://github.com/unbrowse-ai/unbrowse-dev/commit/c45f5ec34ad943a5878ac4da5b6b0be876a127ab))
* pass original intents to agent sanitizer for intent-aware descriptions ([f784873](https://github.com/unbrowse-ai/unbrowse-dev/commit/f7848730c7fda383483aca8c868ad5cdc3c4a4c5))
* PII sanitization + agent review before marketplace publish ([371b02a](https://github.com/unbrowse-ai/unbrowse-dev/commit/371b02a1f5b3067b5c8f3e06176bfe264a02915a))
* restore paper landing page as "Internal APIs Are All You Need" ([ccdbbb9](https://github.com/unbrowse-ai/unbrowse-dev/commit/ccdbbb95a599307a156ba69a50bb7f5ec9990d33))
* single-binary support via bun --compile ([7d5434c](https://github.com/unbrowse-ai/unbrowse-dev/commit/7d5434c14e28b76124668d7246ce8001b8aeb6e0))
* standardise packaging — single binary via npm postinstall ([70b3e83](https://github.com/unbrowse-ai/unbrowse-dev/commit/70b3e835fddedcb230e3a7adc2dffa150fa83cc2))
* wire full payment flow — transaction recording + contributor ID ([09dcb80](https://github.com/unbrowse-ai/unbrowse-dev/commit/09dcb809a09b76bc50921ae46035dd0953af1b18))
* wire Kuri v0.3 action primitives into browser-action floor ([e8e9fe8](https://github.com/unbrowse-ai/unbrowse-dev/commit/e8e9fe87ac694171565e9a6533d6fabb8831d289)), closes [#86](https://github.com/unbrowse-ai/unbrowse-dev/issues/86) [#75](https://github.com/unbrowse-ai/unbrowse-dev/issues/75) [#3](https://github.com/unbrowse-ai/unbrowse-dev/issues/3) [#88](https://github.com/unbrowse-ai/unbrowse-dev/issues/88) [#85](https://github.com/unbrowse-ai/unbrowse-dev/issues/85)
* wire x402 payment gate + contributor attribution ([67384da](https://github.com/unbrowse-ai/unbrowse-dev/commit/67384da0e3c0b2e30f12382baf778585239ef142))

### Bug Fixes

* **#104:** call recordExecution after skill execute to report stats to backend ([d445343](https://github.com/unbrowse-ai/unbrowse-dev/commit/d4453432e6c908cb9b7f9ffe0be76d60aa4a79b0)), closes [#104](https://github.com/unbrowse-ai/unbrowse-dev/issues/104)
* **#104:** call recordExecution after skill execute to report stats to backend ([ec09a5f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec09a5f32e5a27874da9e60b2fad2ed066b76a56)), closes [#104](https://github.com/unbrowse-ai/unbrowse-dev/issues/104)
* **#108:** wire first-pass browser action fallback into no-route resolve path ([#179](https://github.com/unbrowse-ai/unbrowse-dev/issues/179)) ([1550f11](https://github.com/unbrowse-ai/unbrowse-dev/commit/1550f11f60b659edeec45bb06c5fed70700da4f5))
* **#108:** wire first-pass browser action fallback into no-route resolve path ([#179](https://github.com/unbrowse-ai/unbrowse-dev/issues/179)) ([30f5737](https://github.com/unbrowse-ai/unbrowse-dev/commit/30f57372eda9442ae3dd150e2a2f432f546e2cfc))
* **#109:** spawn failure on LinkedIn — add retry logic to kuri start ([211c961](https://github.com/unbrowse-ai/unbrowse-dev/commit/211c9619582e0ce55909091c49253aa80c6e261b)), closes [#109](https://github.com/unbrowse-ai/unbrowse-dev/issues/109)
* **#109:** spawn failure on LinkedIn — add retry logic to kuri start ([c8ef8e1](https://github.com/unbrowse-ai/unbrowse-dev/commit/c8ef8e13d5f5a1e7ce1055bb066bfc8621e89199)), closes [#109](https://github.com/unbrowse-ai/unbrowse-dev/issues/109)
* **#113:** abort hanging CDP phases via AbortSignal when capture timeout fires ([7ac93a0](https://github.com/unbrowse-ai/unbrowse-dev/commit/7ac93a03dd8c690ac34ed75831e8c008355ac3aa)), closes [#113](https://github.com/unbrowse-ai/unbrowse-dev/issues/113)
* **#113:** abort hanging CDP phases via AbortSignal when capture timeout fires ([e5e64c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/e5e64c65c2feb7b7543ff3fb369ddb0c0434244f)), closes [#113](https://github.com/unbrowse-ai/unbrowse-dev/issues/113)
* **#114:** add query hook bridge for UI event → network provenance ([#200](https://github.com/unbrowse-ai/unbrowse-dev/issues/200)) ([1afd13e](https://github.com/unbrowse-ai/unbrowse-dev/commit/1afd13eec520a9123b0ba126b9f7913023c4de4c)), closes [#114](https://github.com/unbrowse-ai/unbrowse-dev/issues/114)
* **#114:** add query hook bridge for UI event → network provenance ([#200](https://github.com/unbrowse-ai/unbrowse-dev/issues/200)) ([95d67a0](https://github.com/unbrowse-ai/unbrowse-dev/commit/95d67a00306e6d08f2dba512630ba030b17ddbdc)), closes [#114](https://github.com/unbrowse-ai/unbrowse-dev/issues/114)
* **#118:** wire passive reverse-engineered artifacts into graph growth and marketplace ([#177](https://github.com/unbrowse-ai/unbrowse-dev/issues/177)) ([17725db](https://github.com/unbrowse-ai/unbrowse-dev/commit/17725db911b386cab68bcd793cdef4dc00d93ba8)), closes [#118](https://github.com/unbrowse-ai/unbrowse-dev/issues/118)
* **#118:** wire passive reverse-engineered artifacts into graph growth and marketplace ([#177](https://github.com/unbrowse-ai/unbrowse-dev/issues/177)) ([626462b](https://github.com/unbrowse-ai/unbrowse-dev/commit/626462bd1ab2b31863f61062598ab53ab960e08c)), closes [#118](https://github.com/unbrowse-ai/unbrowse-dev/issues/118)
* **#152:** prefer richer endpoint when merging duplicates ([1b9b07f](https://github.com/unbrowse-ai/unbrowse-dev/commit/1b9b07f74a2f231b29f6cd37f3519d3aedd98e4a)), closes [#152](https://github.com/unbrowse-ai/unbrowse-dev/issues/152)
* **#152:** prefer richer endpoint when merging duplicates ([#203](https://github.com/unbrowse-ai/unbrowse-dev/issues/203)) ([0b37423](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b37423641b4f0bd34af73aebd92f5bee8ff30a1)), closes [#152](https://github.com/unbrowse-ai/unbrowse-dev/issues/152)
* **#152:** prefer richer endpoint when merging duplicates ([#203](https://github.com/unbrowse-ai/unbrowse-dev/issues/203)) ([0b1e512](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b1e5120e0a0991f2f8f39fd02dd8540ce464b45)), closes [#152](https://github.com/unbrowse-ai/unbrowse-dev/issues/152)
* **#218:** rewrite tests to hit real backend, never mock fetch ([cc09d11](https://github.com/unbrowse-ai/unbrowse-dev/commit/cc09d1174e906df3907742a8d4b38613ccaca75c)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#218:** rewrite tests to hit real backend, never mock fetch ([fb65b31](https://github.com/unbrowse-ai/unbrowse-dev/commit/fb65b3107885d955e8a26dd1105e9b94c7fdc5e9)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#220:** wire computeBottleneckMetrics into backend analytics route ([e97d675](https://github.com/unbrowse-ai/unbrowse-dev/commit/e97d67581745fe4297a0c7a1489ce0f69e8de94a)), closes [#220](https://github.com/unbrowse-ai/unbrowse-dev/issues/220)
* **#221:** wire computeCompositeSearchScore into search/resolve path ([4812ef0](https://github.com/unbrowse-ai/unbrowse-dev/commit/4812ef0509e9285ab64d50a1970f0f2d8356510d))
* **#221:** wire computeCompositeSearchScore into search/resolve path ([23c1634](https://github.com/unbrowse-ai/unbrowse-dev/commit/23c1634046747f7fba1ddd7b666992edfbdfbb84))
* **#221:** wire computeCompositeSearchScore into search/resolve path ([040cd8b](https://github.com/unbrowse-ai/unbrowse-dev/commit/040cd8bc3fccbea3286dd98655ed932a78245a8d))
* **#222:** wire host integrations and runtime supervisor ([4ae42db](https://github.com/unbrowse-ai/unbrowse-dev/commit/4ae42db7f3def3c4cec1e7d6966aba0205215c63)), closes [#222](https://github.com/unbrowse-ai/unbrowse-dev/issues/222)
* **#222:** wire SUPPORTED_HOSTS, LocalSupervisor, getDefaultLoginConfig to production ([2c120c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c120c66ca33177db04217e252a6fa6a3367a535)), closes [#222](https://github.com/unbrowse-ai/unbrowse-dev/issues/222)
* **#223:** import search forms and lifecycle into orchestrator ([f368114](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3681147a22b70f06c363af5606d3a3d7336247a)), closes [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223)
* **#223:** wire isStructuredSearchForm and attributeLifecycle into execution paths ([2352b9e](https://github.com/unbrowse-ai/unbrowse-dev/commit/2352b9edc921508abfa50c7e476ab4578f553aad)), closes [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223)
* **#223:** wire isStructuredSearchForm and attributeLifecycle into production paths ([e40c38c](https://github.com/unbrowse-ai/unbrowse-dev/commit/e40c38c8c6b25ee00eb3bb31dc4942a6cefe4104)), closes [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223)
* **#223:** wire search forms, eval stack, and lifecycle into production ([#257](https://github.com/unbrowse-ai/unbrowse-dev/issues/257)) ([7cb4834](https://github.com/unbrowse-ai/unbrowse-dev/commit/7cb4834c0b3bb52dad1aa2ef6bc6163f3855eb0a)), closes [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223) [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230) [#241](https://github.com/unbrowse-ai/unbrowse-dev/issues/241) [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223)
* **#224:** wire BrowserAccessConfig and computeVerificationCoverage ([ec39a24](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec39a24fad4d3bfada6770bffb10aaa251f8b629)), closes [#224](https://github.com/unbrowse-ai/unbrowse-dev/issues/224)
* **#224:** wire BrowserAccessConfig and computeVerificationCoverage to production ([54548f0](https://github.com/unbrowse-ai/unbrowse-dev/commit/54548f03be051229e39e8190060fbb044c5191e2)), closes [#224](https://github.com/unbrowse-ai/unbrowse-dev/issues/224)
* **#225:** wire detectHostEnvironment and getBrowserConfig into kuri launch ([5362e5c](https://github.com/unbrowse-ai/unbrowse-dev/commit/5362e5c6781340e6b081f0c82d026fb5f6e2e0a1)), closes [#225](https://github.com/unbrowse-ai/unbrowse-dev/issues/225)
* **#225:** wire detectHostEnvironment and getBrowserConfig into runtime ([f3f6378](https://github.com/unbrowse-ai/unbrowse-dev/commit/f3f6378246a1bb87e641cba9bf3553ecd78b7bc8)), closes [#225](https://github.com/unbrowse-ai/unbrowse-dev/issues/225)
* **#226:** wire buildDescriptionPrompt into reverse-engineer pipeline ([4d41e5b](https://github.com/unbrowse-ai/unbrowse-dev/commit/4d41e5b575992188054a062033d810ba4bdc630a)), closes [#226](https://github.com/unbrowse-ai/unbrowse-dev/issues/226)
* **#226:** wire buildDescriptionPrompt into reverse-engineer pipeline ([a80273a](https://github.com/unbrowse-ai/unbrowse-dev/commit/a80273a4c8ead1c9ecbea25ab87f6c082e5202b4)), closes [#226](https://github.com/unbrowse-ai/unbrowse-dev/issues/226)
* **#227:** wire RSC parser into reverse-engineer pipeline ([b9dcc7d](https://github.com/unbrowse-ai/unbrowse-dev/commit/b9dcc7d40be5359ba13ba93a64dbdd924687d26d)), closes [#227](https://github.com/unbrowse-ai/unbrowse-dev/issues/227)
* **#227:** wire RSC wire format parser into capture pipeline ([988c6ab](https://github.com/unbrowse-ai/unbrowse-dev/commit/988c6ab8a34604166d9c616e47ca63c529c8a2d1)), closes [#227](https://github.com/unbrowse-ai/unbrowse-dev/issues/227)
* **#228:** wire telemetry-driven auto issue filing pipeline ([4e4e660](https://github.com/unbrowse-ai/unbrowse-dev/commit/4e4e660c008baca7476880558e792712373357dc)), closes [#228](https://github.com/unbrowse-ai/unbrowse-dev/issues/228)
* **#228:** wire telemetry-driven auto issue filing route ([e58bc25](https://github.com/unbrowse-ai/unbrowse-dev/commit/e58bc25965cfef9bdbc7eeb680ceb65763c904f5)), closes [#228](https://github.com/unbrowse-ai/unbrowse-dev/issues/228)
* **#229:** implement tryFirstPassBrowserAction with HAR-based interception ([09f5118](https://github.com/unbrowse-ai/unbrowse-dev/commit/09f5118148494bfc9644bd39a7f7cbb91a8eb0fd)), closes [#229](https://github.com/unbrowse-ai/unbrowse-dev/issues/229)
* **#229:** implement tryFirstPassBrowserAction with HAR-based interception ([e2522d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/e2522d76f3f3312239058a371d7ff756be84d1b3)), closes [#229](https://github.com/unbrowse-ai/unbrowse-dev/issues/229)
* **#229:** implement tryFirstPassBrowserAction with HAR-based interception ([30d3170](https://github.com/unbrowse-ai/unbrowse-dev/commit/30d3170334d07ae2e43aa6cf6d95203f1c800381)), closes [#229](https://github.com/unbrowse-ai/unbrowse-dev/issues/229)
* **#230:** wire auth dependency runtime into execution 401/403 recovery ([27212b3](https://github.com/unbrowse-ai/unbrowse-dev/commit/27212b3a0e2e542d88175e9b232a97c91d633405)), closes [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230)
* **#230:** wire auth dependency runtime into login flow ([1329188](https://github.com/unbrowse-ai/unbrowse-dev/commit/1329188a6ec84c1f3630e05afb3277e530ee5d1a)), closes [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230) [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230)
* **#230:** wire authRuntime into orchestrator login flow ([#256](https://github.com/unbrowse-ai/unbrowse-dev/issues/256)) ([89c776c](https://github.com/unbrowse-ai/unbrowse-dev/commit/89c776ca6b706823ea44682106efb68b4a9499c6)), closes [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230)
* **#231:** wire fetchDynamicPrice into payment gate ([d7d0f6c](https://github.com/unbrowse-ai/unbrowse-dev/commit/d7d0f6c98a1d7cea8e2f018161c49c05e43e3514)), closes [#231](https://github.com/unbrowse-ai/unbrowse-dev/issues/231)
* **#231:** wire route pricing endpoint into payment flow ([da39ab0](https://github.com/unbrowse-ai/unbrowse-dev/commit/da39ab081337e6a65cdfa382abd8944651aa19f9)), closes [#231](https://github.com/unbrowse-ai/unbrowse-dev/issues/231)
* **#232:** wire delta attribution client-side so indexer_id is sent ([f072750](https://github.com/unbrowse-ai/unbrowse-dev/commit/f0727502ee532ca77db8845eb7749ccffb8c32de)), closes [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232)
* **#232:** wire indexer_id into attribution calls ([#254](https://github.com/unbrowse-ai/unbrowse-dev/issues/254)) ([0dc6191](https://github.com/unbrowse-ai/unbrowse-dev/commit/0dc619193a555037f942d3598ce5812a835b1956)), closes [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232) [#225](https://github.com/unbrowse-ai/unbrowse-dev/issues/225) [#227](https://github.com/unbrowse-ai/unbrowse-dev/issues/227) [#231](https://github.com/unbrowse-ai/unbrowse-dev/issues/231) [#224](https://github.com/unbrowse-ai/unbrowse-dev/issues/224) [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232)
* **#232:** wire indexer_id into execution attribution calls ([d4395fd](https://github.com/unbrowse-ai/unbrowse-dev/commit/d4395fdfbb8251bb4e2b3e0eec89690437afdbd4)), closes [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232)
* **#233:** wire queuePassiveSkillPublish to actually publish skills ([bb720ed](https://github.com/unbrowse-ai/unbrowse-dev/commit/bb720ed2d779cd2ecec9aa8e1789b10d077b2efa)), closes [#233](https://github.com/unbrowse-ai/unbrowse-dev/issues/233)
* **#233:** wire queuePassiveSkillPublish to actually publish skills ([392b07c](https://github.com/unbrowse-ai/unbrowse-dev/commit/392b07c4db718dad0695c38c5cd9d3c01b9e8faf)), closes [#233](https://github.com/unbrowse-ai/unbrowse-dev/issues/233)
* **#233:** wire queuePassiveSkillPublish to actually publish skills ([f6b9b53](https://github.com/unbrowse-ai/unbrowse-dev/commit/f6b9b53d4e912afa0bb167ac9d81faa239646643)), closes [#233](https://github.com/unbrowse-ai/unbrowse-dev/issues/233)
* **#48:** use pathToFileURL for tsx loader path to support Windows ([30b6358](https://github.com/unbrowse-ai/unbrowse-dev/commit/30b635867075d024e07d573eb735a0fa82d80828)), closes [#48](https://github.com/unbrowse-ai/unbrowse-dev/issues/48)
* **#48:** use pathToFileURL for tsx loader path to support Windows ([d95bab9](https://github.com/unbrowse-ai/unbrowse-dev/commit/d95bab91c9b6b9574966a5a482d70289be816a45)), closes [#48](https://github.com/unbrowse-ai/unbrowse-dev/issues/48)
* **#51:** export DEPRECATION_THRESHOLD and add auto_deprecated_at to EndpointStats ([ce5629e](https://github.com/unbrowse-ai/unbrowse-dev/commit/ce5629ef994524b8d5109b5e40e6e32e22ec35c0)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51)
* **#51:** export DEPRECATION_THRESHOLD and add auto_deprecated_at to EndpointStats ([8033996](https://github.com/unbrowse-ai/unbrowse-dev/commit/8033996141f1345481636a563c44d4673bdd040b)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([c396e5b](https://github.com/unbrowse-ai/unbrowse-dev/commit/c396e5b3afc8bf83f219f05e29f8df8adea39189)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([b75d396](https://github.com/unbrowse-ai/unbrowse-dev/commit/b75d3963cd51f88b09123edc0832d50760adcc5a)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([#193](https://github.com/unbrowse-ai/unbrowse-dev/issues/193)) ([6388e6c](https://github.com/unbrowse-ai/unbrowse-dev/commit/6388e6c390036a011ff1459a5b59186cfe48f525)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([#193](https://github.com/unbrowse-ai/unbrowse-dev/issues/193)) ([e0a6a75](https://github.com/unbrowse-ai/unbrowse-dev/commit/e0a6a7545974db4de35c7948e89cb4914fb623df)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#89:** promote deferred skills to cache, guard mutable DOM auto-exec, restore resolvedParams IIFE ([cd8f9da](https://github.com/unbrowse-ai/unbrowse-dev/commit/cd8f9da6f05748ec3969835e58a651ed4c75a846)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)
* **#89:** promote deferred skills to cache, guard mutable DOM auto-exec, restore resolvedParams IIFE ([#201](https://github.com/unbrowse-ai/unbrowse-dev/issues/201)) ([894f89c](https://github.com/unbrowse-ai/unbrowse-dev/commit/894f89c1bc8d8ede2a77423147c8de6f04a45e9a)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)
* **#89:** promote deferred skills to cache, guard mutable DOM auto-exec, restore resolvedParams IIFE ([#201](https://github.com/unbrowse-ai/unbrowse-dev/issues/201)) ([99c8b97](https://github.com/unbrowse-ai/unbrowse-dev/commit/99c8b976da03ae538a51ec1a9b7e5a711ed8753d)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)
* agent generates domain-appropriate synthetic examples ([94c9f9f](https://github.com/unbrowse-ai/unbrowse-dev/commit/94c9f9f99d5d603d42d05f87ccdad4fca7ca3313))
* auto-extract browser cookies for gated sites, guard HAR entry iteration ([955564d](https://github.com/unbrowse-ai/unbrowse-dev/commit/955564debad2150f04a087da5aa1a2eb0a4486b0))
* auto-extract browser cookies for gated sites, guard HAR entry iteration ([6013029](https://github.com/unbrowse-ai/unbrowse-dev/commit/601302931e29d1459ce7ec870779eed980249d69))
* auto-login on auth_required — resolve handles full lifecycle ([adf68ef](https://github.com/unbrowse-ai/unbrowse-dev/commit/adf68ef83da464facbc0efaad1c54974daffe702))
* bind STATS_KV + allSettled search — marketplace now discoverable ([6695580](https://github.com/unbrowse-ai/unbrowse-dev/commit/66955809f1fba21fb7cd739f1db6642fc1240414))
* bundle vendored kuri and enforce package checks ([c165046](https://github.com/unbrowse-ai/unbrowse-dev/commit/c165046a89e5eecb24182c04fb67443120b3f850))
* bundle vendored kuri and enforce package checks ([ce02d81](https://github.com/unbrowse-ai/unbrowse-dev/commit/ce02d81fcd236e67f0d948ccf2d68e0a87c43a05))
* capture API bodies via Performance API + sync XHR replay ([b88f98d](https://github.com/unbrowse-ai/unbrowse-dev/commit/b88f98dfb32f32f635e7cc031cd96dc3150c4811))
* capture API bodies via Performance API + sync XHR replay ([d5fa694](https://github.com/unbrowse-ai/unbrowse-dev/commit/d5fa6947891e8443071991583480a1d63581f028))
* **capture:** add live DOM extraction and improve interactive stimulus ([253112c](https://github.com/unbrowse-ai/unbrowse-dev/commit/253112c9471a44a7f0f9afe630198868a3b43a0b))
* **capture:** improve interceptor timing and add Performance API replay ([5f0d503](https://github.com/unbrowse-ai/unbrowse-dev/commit/5f0d503361fd3eb8f2d64ca9600fa69f5644c242))
* **capture:** wire live DOM extraction data through orchestrator to user ([664a637](https://github.com/unbrowse-ai/unbrowse-dev/commit/664a6371e783e389cc1217c2315cea7ff8991a04))
* **ci:** pass UNBROWSE_API_KEY to backend tests as GRAPH_TEST_API_KEY ([e389879](https://github.com/unbrowse-ai/unbrowse-dev/commit/e389879939e8231de8221b825bdc5e2caa805f24))
* DAG entry points, stale graph rebuild, capture HAR replay ([9f91da4](https://github.com/unbrowse-ai/unbrowse-dev/commit/9f91da45e4fdd3d7a248b5b76457748933643c8d))
* disable auto-exec — always defer endpoint selection to the agent ([5c09866](https://github.com/unbrowse-ai/unbrowse-dev/commit/5c098660f3a0e33ae67dc96b885797f9bc84d124))
* endpoint accumulation across captures + fix mangled graph builder ([12b355e](https://github.com/unbrowse-ai/unbrowse-dev/commit/12b355eea512053b990a2aa15c68ea38969ec2dd))
* increase graph-api test timeout to 60s for rate-limit retries ([991d13a](https://github.com/unbrowse-ai/unbrowse-dev/commit/991d13a6da42671e4274254f3f3a0baf66c6f252))
* increase graph-api test timeout to 60s for rate-limit retries ([25bfea8](https://github.com/unbrowse-ai/unbrowse-dev/commit/25bfea8a5f6cf590c75aa8cba9f3f4c562237780))
* install.sh falls back to health if setup not available yet ([2c28268](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c28268527b3dd6b4a4ecb77bbde54b54b77d3bd))
* install.sh use --yes flag and drop setup command ([c293572](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2935726646fe928fe1c4782d2043055f0ab1cb8))
* install.sh uses npm install instead of git clone ([6a13bf5](https://github.com/unbrowse-ai/unbrowse-dev/commit/6a13bf56ff53f9d01c81ba786244dced8d76351b))
* **kuri:** correct press() and scroll() signatures to require ref param ([40cbcb8](https://github.com/unbrowse-ai/unbrowse-dev/commit/40cbcb893745bad61795cadb29c91b24d257036c))
* link homepage whitepaper button to paper landing page ([68b84f2](https://github.com/unbrowse-ai/unbrowse-dev/commit/68b84f2b8f3db6689ffaa78baf544874ee763119))
* **openclaw:** surface endpoint details in deferred resolve responses ([e964725](https://github.com/unbrowse-ai/unbrowse-dev/commit/e964725fb3241b93c4dcd935c4b3d637fadca532))
* remove all mocking from 13 test files ([78437e1](https://github.com/unbrowse-ai/unbrowse-dev/commit/78437e1e88714455182d3a6bfb6a76237995942e))
* remove autoExtractOrWrap, always return raw data ([559bff8](https://github.com/unbrowse-ai/unbrowse-dev/commit/559bff838274b64e5afc785010ea03faadf0850a))
* remove git rev-parse call that spams "not a git repository" on npm installs ([a95ba36](https://github.com/unbrowse-ai/unbrowse-dev/commit/a95ba3659d7ecc126f76b0a80acb5cfdbce964ca))
* repair broken merge in client/index.ts that failed CI ([0db25b2](https://github.com/unbrowse-ai/unbrowse-dev/commit/0db25b2d571cef429e6842530f31990c5b2eec93)), closes [#254](https://github.com/unbrowse-ai/unbrowse-dev/issues/254) [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232)
* resolve all 21 backend test failures (19 fail + 2 errors) ([8074d14](https://github.com/unbrowse-ai/unbrowse-dev/commit/8074d14ed3c27cfb96a5bdae649a7a6e269fc669))
* resolve all 21 backend test failures (19 fail + 2 errors) ([4cad372](https://github.com/unbrowse-ai/unbrowse-dev/commit/4cad3727672d64399ee506591cb019a9825ca7f2))
* restore fee routes and x402 CORS headers after merge conflict ([a634f25](https://github.com/unbrowse-ai/unbrowse-dev/commit/a634f2506b313cfcda8677960936f5c89ec98281))
* restore fee routes and x402 CORS headers after merge conflict ([474acad](https://github.com/unbrowse-ai/unbrowse-dev/commit/474acad91929e0f7022916b85adedc7d258d8f1e))
* revert to unoptimized images, fix package.json and next.config syntax ([a5610d1](https://github.com/unbrowse-ai/unbrowse-dev/commit/a5610d16a222c66a073305b1d49aea4412b02c60))
* revert to unoptimized images, fix package.json and next.config syntax ([2352069](https://github.com/unbrowse-ai/unbrowse-dev/commit/2352069c2f7642604add1bc75928f0f08ae90195))
* skip pre-push P0/P1 suite when no analyses exist ([427c58d](https://github.com/unbrowse-ai/unbrowse-dev/commit/427c58de07cc18a9e5f6d47591d14c01e2608591))
* skip pre-push P0/P1 suite when no analyses exist ([9363dd9](https://github.com/unbrowse-ai/unbrowse-dev/commit/9363dd9d99c14b8927117f459eebceb5f2aac9ca))
* strip extraction_hints from output when --path/--extract is used ([491f124](https://github.com/unbrowse-ai/unbrowse-dev/commit/491f1247e5186a94e403a6d0515166a019771e91))
* synthesize similar examples instead of deleting them ([1664cdf](https://github.com/unbrowse-ai/unbrowse-dev/commit/1664cdfa32e8cbb3754caaadd83cebab19a4e0dc))
* update kuri submodule — CDP async network event capture for HAR ([5a13e66](https://github.com/unbrowse-ai/unbrowse-dev/commit/5a13e66d37657c92f3be37b70090431fe0288333))
* update kuri submodule — HAR recorder now returns entries correctly ([9cf4ce2](https://github.com/unbrowse-ai/unbrowse-dev/commit/9cf4ce2544e443311bd4f994d72477b7627d4a90))
* use ENVIRONMENT env var to toggle devnet/mainnet in x402 gate ([89e0239](https://github.com/unbrowse-ai/unbrowse-dev/commit/89e0239077cf5b022172e5fe8c8906e4b7a5e998))
* use Promise.allSettled so BM25 search works when EmergentDB is down ([c2df4a6](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2df4a69a370170cd04dc03c5ca2833b70e1480c))
* use unbrowse health instead of setup in install.sh ([557911c](https://github.com/unbrowse-ai/unbrowse-dev/commit/557911ce5aa6049efa8510d14843252b058aee85))
* wire indexing fallback for unpaid users in payment gate ([7906e27](https://github.com/unbrowse-ai/unbrowse-dev/commit/7906e2773bee486b6bc5c0bfcfaad0e58e208d7b))

### Refactoring

* remove broken path extraction, add resolve --execute, deduplicate DOM results ([6e9ca71](https://github.com/unbrowse-ai/unbrowse-dev/commit/6e9ca7184c53af6032efb97f5c50c0241e3bca78))
* remove dead extraction_hints/response_schema plumbing ([2b7cff6](https://github.com/unbrowse-ai/unbrowse-dev/commit/2b7cff6146c2561e6f285f7705367539b25e9af0))
* remove hardcoded LLM call — expose /review route for agents ([db73a4c](https://github.com/unbrowse-ai/unbrowse-dev/commit/db73a4c5f639ee749bb3e525afa876975f45be72))
* simplify install.sh — use npx skills add for registration ([78f280b](https://github.com/unbrowse-ai/unbrowse-dev/commit/78f280bfcbe683746335432c462fa6f2eea96c26))
* simplify setup script — delegate to CLI for runtime bootstrap ([8848b52](https://github.com/unbrowse-ai/unbrowse-dev/commit/8848b52103760d6fbe544787fb4590e1ee734c74))

## [2.1.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-24)

### Bug Fixes

* keep structured search skills on the resolve path ([1de509d](https://github.com/unbrowse-ai/unbrowse-dev/commit/1de509dda5746f8074fcec555e0e4a7c3f1e2f10))
* rebuild canonical retrieval hydration from domain index ([#72](https://github.com/unbrowse-ai/unbrowse-dev/issues/72)) ([35e6de9](https://github.com/unbrowse-ai/unbrowse-dev/commit/35e6de9d732a84f553bdf0f2d574b97fab846485))
* recover LawNet search form execution ([25a4e17](https://github.com/unbrowse-ai/unbrowse-dev/commit/25a4e172da849e57ad68cc6c41044c552785f7d8))

## [2.1.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-24)

## [2.1.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* harden LawNet search execution ([c42852c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c42852c7c08664d54d1eff342b060f30da04b711))

## [2.1.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* stabilize warm retrieval cache ([ee3a2ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee3a2ac43ccc87004c25e061c3acb497e3831e3a))

## [2.1.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* harden LawNet search recovery ([8eb5d04](https://github.com/unbrowse-ai/unbrowse-dev/commit/8eb5d048fda6da402a31d241088dc7285ec9f6da))

## [2.1.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* restore packaged cli self-healing ([5b6b921](https://github.com/unbrowse-ai/unbrowse-dev/commit/5b6b92111c0f24636e5c79c516134c1891321722))

## [2.1.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Features

* improve capture resilience and align kuri upstream ([4607822](https://github.com/unbrowse-ai/unbrowse-dev/commit/46078224f8fafda4de7b9a2a9df04f37fd9a5b71))

## [2.0.23](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* sharpen mcp routing defaults ([3e1b355](https://github.com/unbrowse-ai/unbrowse-dev/commit/3e1b35591c7ba7231061bcea5bfd927133013f99))

## [2.0.22](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* stabilize installed linkedin force-capture ([f381f48](https://github.com/unbrowse-ai/unbrowse-dev/commit/f381f48dbf5d344f37b9a69141fd219579f7cdff))

## [2.0.21](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* harden auth capture and Hermes install docs ([8ecd63e](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ecd63ebf2cc2fd52ea9a77e1b74200b84cb5eeb))

## [2.0.16](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-23)

### Bug Fixes

* disable release-it npm bump step ([6dbda71](https://github.com/unbrowse-ai/unbrowse-dev/commit/6dbda71e368c84e8f3962f572e99a06a772f7d66))
* disable release-it npm bump step ([#69](https://github.com/unbrowse-ai/unbrowse-dev/issues/69)) ([bff1753](https://github.com/unbrowse-ai/unbrowse-dev/commit/bff1753d4b8ad98256e70230ac0b2cca7bd5dab5))
* restore retrieval gate coverage ([781e660](https://github.com/unbrowse-ai/unbrowse-dev/commit/781e660dc8f49949e6026b71581c0730911c175b))
* stabilize webarena adapted evals ([8afd22d](https://github.com/unbrowse-ai/unbrowse-dev/commit/8afd22de3ffece143b2ae63d26f1a6a1f9263347))

## [2.0.15](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* align frontend deploy path and install docs ([#25](https://github.com/unbrowse-ai/unbrowse-dev/issues/25)) ([1f20a33](https://github.com/unbrowse-ai/unbrowse-dev/commit/1f20a33c485676124044854f1325085dbe5bab88))
* pin deploys to maintained kuri fork ([3055bcf](https://github.com/unbrowse-ai/unbrowse-dev/commit/3055bcfc57151d032c55cd93e0a43d59a1a2c012))

## [2.0.14](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* seed staging browser eval auth ([#24](https://github.com/unbrowse-ai/unbrowse-dev/issues/24)) ([9caa74d](https://github.com/unbrowse-ai/unbrowse-dev/commit/9caa74d769aca1a61b17d962753bb17ae629578d))

## [2.0.13](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

## [2.0.12](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* bypass staging eval search cache ([b1b2038](https://github.com/unbrowse-ai/unbrowse-dev/commit/b1b2038291e2536599ff0cf3fb3b51487e1654e6))

## [2.0.11](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* exempt staging eval token from search throttles ([1c29770](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c29770752cea8143eb9f4f654bd84bac3f53096))

## [2.0.10](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* stop staging live eval from assuming seeded search ([#20](https://github.com/unbrowse-ai/unbrowse-dev/issues/20)) ([e6b4c2b](https://github.com/unbrowse-ai/unbrowse-dev/commit/e6b4c2b2740e852a744a489e5e77e2d860717729))

## [2.0.9](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* separate public search rate limits for authed evals ([#19](https://github.com/unbrowse-ai/unbrowse-dev/issues/19)) ([8ea11ce](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ea11ce4b4b4c40e1a45f3c539b7a13edcd1665d))

## [2.0.8](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* normalize skill sync newlines on windows ([#15](https://github.com/unbrowse-ai/unbrowse-dev/issues/15)) ([f511e7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/f511e7e32c9539214b5b18ddda04db4225c0f8ce))
* publish npm packages on self-hosted runners ([#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)) ([7d6f81d](https://github.com/unbrowse-ai/unbrowse-dev/commit/7d6f81df521d74cd3be8e425e848c19e1de77f5e))
* restore mcp package build ([#17](https://github.com/unbrowse-ai/unbrowse-dev/issues/17)) ([442922f](https://github.com/unbrowse-ai/unbrowse-dev/commit/442922f46f11595308f6fa8688fa91fbdfc61220))
* skip live graph api tests by default ([#14](https://github.com/unbrowse-ai/unbrowse-dev/issues/14)) ([a4d69d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/a4d69d72eb562b248e8d51770e8143e5cb37c5c3))
* unblock release packaging gates ([#18](https://github.com/unbrowse-ai/unbrowse-dev/issues/18)) ([d142996](https://github.com/unbrowse-ai/unbrowse-dev/commit/d142996cbd6487289c062ad63c34d4598d0cdb4c))

## [2.0.7](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-22)

### Bug Fixes

* simplify api key auto-registration ([#9](https://github.com/unbrowse-ai/unbrowse-dev/issues/9)) ([198a6d2](https://github.com/unbrowse-ai/unbrowse-dev/commit/198a6d299bc5e4f0a8529901dbdc757b3432746b))
* simplify one-command install flow ([#11](https://github.com/unbrowse-ai/unbrowse-dev/issues/11)) ([2d4bbe5](https://github.com/unbrowse-ai/unbrowse-dev/commit/2d4bbe52299ac82e039568969317fa124efa616f))
* track windows kuri binary for npm pack ([#10](https://github.com/unbrowse-ai/unbrowse-dev/issues/10)) ([bc6b39a](https://github.com/unbrowse-ai/unbrowse-dev/commit/bc6b39afa6973c8fbe5b261ea61646228c2cf6fe))

## [2.0.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-03-21)

### Features

* add ElizaOS plugin for unbrowse integration ([5134ac5](https://github.com/unbrowse-ai/unbrowse-dev/commit/5134ac56828bd077d2e44d31c99d2c0192dcc9ea))
* add full-pipeline retrieval tests to eval harness ([e2b6ee0](https://github.com/unbrowse-ai/unbrowse-dev/commit/e2b6ee07881ab80c8ec42f048791d1c4fbf45819))
* add LangChain integration (unbrowse-langchain) ([c064902](https://github.com/unbrowse-ai/unbrowse-dev/commit/c064902e091d01393d43388d70f06e0f7dbb7019))
* add MCP server integration for universal AI client support ([baa460c](https://github.com/unbrowse-ai/unbrowse-dev/commit/baa460c35d18ad297a1c544918be57081dbe9f24))
* add pre-commit perf eval harness + 10x faster skill execution ([25edc8c](https://github.com/unbrowse-ai/unbrowse-dev/commit/25edc8c02f87cabc9454db216a81f99c4bbb74df))
* add unbrowse-hermes plugin for Hermes Agent framework ([c010d88](https://github.com/unbrowse-ai/unbrowse-dev/commit/c010d88e075d01aa6291d9fc873bdcd247b22e65))
* append leftover params as query string on GET requests ([c778957](https://github.com/unbrowse-ai/unbrowse-dev/commit/c7789570687a2f8eaa74c4f800e16c8d59654ee4))
* auto-execute + SSR fast-path (15s → 3.6s) ([4fe714a](https://github.com/unbrowse-ai/unbrowse-dev/commit/4fe714af2802163a0ab0596d4543ae11b3456f11))
* auto-execute DOM extraction endpoints with LLM param inference ([603c2b6](https://github.com/unbrowse-ai/unbrowse-dev/commit/603c2b653640db269c82115b6a144a68cc957e84))
* auto-execute, SSR fast-path, route/domain caching, evals, backend improvements ([2d19353](https://github.com/unbrowse-ai/unbrowse-dev/commit/2d193533e4c0eff4b4ce57053f71e5d473fee049))
* browser cookies, agent-first selection, URN params, discovery cost (no KV migration) ([#27](https://github.com/unbrowse-ai/unbrowse-dev/issues/27)) ([9715f73](https://github.com/unbrowse-ai/unbrowse-dev/commit/9715f739ccc9b3d2a98f36c202a79c4eeebbdf4b))
* domain-level skill cache for cross-intent reuse ([72c59e9](https://github.com/unbrowse-ai/unbrowse-dev/commit/72c59e9abae2b48e518670e4a5dcfab62cb694ad))
* expand eval suite to 6 endpoints across 3 code paths ([6365927](https://github.com/unbrowse-ai/unbrowse-dev/commit/63659272a92077ed72b8993b80b378bc08a532b4))
* expand eval suite to 9 endpoints across 5 domains ([dd2128c](https://github.com/unbrowse-ai/unbrowse-dev/commit/dd2128ce8a8127572657782a9adcaf81a9d1e9d7))
* expand public eval corpus and prep v2.0.0 ([6fce49e](https://github.com/unbrowse-ai/unbrowse-dev/commit/6fce49e094030ff9be14ad783a801e66aab34b73))
* migrate backend to EmergentDB Graph API ([#85](https://github.com/unbrowse-ai/unbrowse-dev/issues/85)) ([e87a33e](https://github.com/unbrowse-ai/unbrowse-dev/commit/e87a33e24ece9334f878196629a3c2c057f3b0b4))
* persist route cache to disk (survives restarts) ([0d77e73](https://github.com/unbrowse-ai/unbrowse-dev/commit/0d77e734660142d2a4cf4a29a3563982805474ea))
* release pipeline + auto-suggest extraction ([#41](https://github.com/unbrowse-ai/unbrowse-dev/issues/41)) ([dd12d96](https://github.com/unbrowse-ai/unbrowse-dev/commit/dd12d9632e906d0bbb20af526cb7780e2054ab5f))
* replace agent-browser with Kuri — CLI-first Zig-native browser automation ([47f4aa4](https://github.com/unbrowse-ai/unbrowse-dev/commit/47f4aa43cddc6e357c63b8b1ac24a8071d777b0f)), closes [#71](https://github.com/unbrowse-ai/unbrowse-dev/issues/71) [#71](https://github.com/unbrowse-ai/unbrowse-dev/issues/71)
* replace Cloudflare KV with EmergentDB qdkv ([#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)) ([aae4db7](https://github.com/unbrowse-ai/unbrowse-dev/commit/aae4db7aee4eb31bb3618c961a67c6fdba04d687))
* require ToS acceptance for agent signup, block unauthenticated access ([6201483](https://github.com/unbrowse-ai/unbrowse-dev/commit/6201483dd10d75b047d0154c653960005e7e9580))
* sharpen landing hero value prop ([ead13b9](https://github.com/unbrowse-ai/unbrowse-dev/commit/ead13b95b40daac778ab83b34c006f8e7787a25d))
* surface auth_recommended hint when capture returns no data endpoints ([75ed399](https://github.com/unbrowse-ai/unbrowse-dev/commit/75ed3994bc8d3429349d27e66a4699f51a021495))
* tighten agent evals and public replay resolution ([#50](https://github.com/unbrowse-ai/unbrowse-dev/issues/50)) ([7e7045f](https://github.com/unbrowse-ai/unbrowse-dev/commit/7e7045fa707b21d0678e23615b2595ee184d8cf5))
* zero-config setup with agent-mediated ToS consent ([#6](https://github.com/unbrowse-ai/unbrowse-dev/issues/6)) ([6885aec](https://github.com/unbrowse-ai/unbrowse-dev/commit/6885aecc519a1ce898dfb46980c5d19de804f8c8))

### Bug Fixes

* 2-step endpoint selection + 14x faster execution ([d4787b6](https://github.com/unbrowse-ai/unbrowse-dev/commit/d4787b664810cadc6e83cc167930b4d81d98a6f1))
* 3 eval data quality issues found by harness ([838fe6a](https://github.com/unbrowse-ai/unbrowse-dev/commit/838fe6a77cd4f0dbb7898171b4b4d90e2698969e))
* add apex domain route for unbrowse.ai ([#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32)) ([ee11f21](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee11f218b4c980e86699c6962b59b3b8a9878c3e))
* add stealth patches + restore origin pre-navigation for authed captures ([14e5c56](https://github.com/unbrowse-ai/unbrowse-dev/commit/14e5c5618cf736737313a289b0ced64738fb01f5))
* always send auth header when API key exists ([#8](https://github.com/unbrowse-ai/unbrowse-dev/issues/8)) ([3219e3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/3219e3e9df31bfee92ace7d8974fb068db999612))
* auto-install browser engine + auto-recover stale 404 endpoints ([04b1c5b](https://github.com/unbrowse-ai/unbrowse-dev/commit/04b1c5b21c2ee2b8508ef4e8569f18e8d5d97c06))
* BUG-001 too many subrequests + BUG-002 intent/resolve parse error ([064ddfb](https://github.com/unbrowse-ai/unbrowse-dev/commit/064ddfbb84b865457ef3cf190001da5e370b738f))
* **BUG-006:** parameterize dynamic path segments instead of hardcoding ([#20](https://github.com/unbrowse-ai/unbrowse-dev/issues/20)) ([de11083](https://github.com/unbrowse-ai/unbrowse-dev/commit/de1108308f9bd94eb198a62107bc835cfbbd1f84))
* bun/CF Brotli hang + sync working tree ([#42](https://github.com/unbrowse-ai/unbrowse-dev/issues/42)) ([b84f413](https://github.com/unbrowse-ai/unbrowse-dev/commit/b84f413c814a1e6389b1aba7c5126786863873ca))
* bundle kuri runtime in cli releases ([a54b4f7](https://github.com/unbrowse-ai/unbrowse-dev/commit/a54b4f7aba2570c6ac96dc1257e661627eab2667))
* cache skills locally before remote publish to prevent post-resolve 404s ([bb64bb9](https://github.com/unbrowse-ai/unbrowse-dev/commit/bb64bb9a20ad1e6b991f6b94ba39130d23dcdf8b)), closes [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34)
* catch 'setPassword is not a function' keytar errors and fall back to encrypted file vault ([521d6f0](https://github.com/unbrowse-ai/unbrowse-dev/commit/521d6f01076de1f5a4ae64a0cc12c63a91973e2a))
* check vendor binaries first, skip zig build when present ([5f25866](https://github.com/unbrowse-ai/unbrowse-dev/commit/5f2586651ff9582b4ee834e0d3192c1b343e1e49))
* CSRF detection via DAG-based value matching + JSESSIONID/csrf-token support ([c91894c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c91894c96966e5b907b2b7467b421587527163f4))
* eliminate read-after-write race in skill publishing ([#10](https://github.com/unbrowse-ai/unbrowse-dev/issues/10)) ([f2d4655](https://github.com/unbrowse-ai/unbrowse-dev/commit/f2d4655730972c8d3cbc243c2567a1cb5c701a34)), closes [#9](https://github.com/unbrowse-ai/unbrowse-dev/issues/9)
* graceful browser shutdown + orphan cleanup (fixes [#4](https://github.com/unbrowse-ai/unbrowse-dev/issues/4)) ([#28](https://github.com/unbrowse-ai/unbrowse-dev/issues/28)) ([7f875c5](https://github.com/unbrowse-ai/unbrowse-dev/commit/7f875c5bb5fb147a0dd1ce381fdff53259398104))
* guard against empty/malformed index values ([ff72936](https://github.com/unbrowse-ai/unbrowse-dev/commit/ff72936471b6da3b77929ffe4dfe0a924690b70f))
* harden search pipeline — error handling, batched reindex, await indexing ([#7](https://github.com/unbrowse-ai/unbrowse-dev/issues/7)) ([737e083](https://github.com/unbrowse-ai/unbrowse-dev/commit/737e083b91d8efe012739c51ce048d42bd07cea9))
* improve endpoint ranking with noise filtering and data-relevance scoring ([#17](https://github.com/unbrowse-ai/unbrowse-dev/issues/17)) ([798aa8c](https://github.com/unbrowse-ai/unbrowse-dev/commit/798aa8ca5d26d0c005ad4656e5703b8d3fec9257))
* **issue-15:** wrong endpoint, broken params, repeated captures ([#19](https://github.com/unbrowse-ai/unbrowse-dev/issues/19)) ([1373f1e](https://github.com/unbrowse-ai/unbrowse-dev/commit/1373f1e712dac59748d98b1079186cccbb51fbf6)), closes [#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)
* KV _idx exceeds EmergentDB size limit — store keys only ([f7bc929](https://github.com/unbrowse-ai/unbrowse-dev/commit/f7bc9293615a7cb73d2a34c958b6a60749334b6a))
* login opens user's default browser + auto-discover all Chromium/Firefox browsers ([680d877](https://github.com/unbrowse-ai/unbrowse-dev/commit/680d87759d368a44fe9a76ce80886553279bcc3c))
* make frontend mobile responsive ([#31](https://github.com/unbrowse-ai/unbrowse-dev/issues/31)) ([156c6e5](https://github.com/unbrowse-ai/unbrowse-dev/commit/156c6e5b7215327a5d61f971e470d18b2249aa59))
* marketplace recall, BM25 ranking, route cache, perf telemetry ([#18](https://github.com/unbrowse-ai/unbrowse-dev/issues/18)) ([ae6f219](https://github.com/unbrowse-ai/unbrowse-dev/commit/ae6f219d0b607a06fbf8623e764daeb1a3947883))
* migrate old string[] index format to {k,v}[] on first read ([055ee7d](https://github.com/unbrowse-ai/unbrowse-dev/commit/055ee7d97ce8b2e7f0e67de9f093423ed38d6d2a))
* missing closing brace and duplicate return in skills route ([#21](https://github.com/unbrowse-ai/unbrowse-dev/issues/21)) ([b3873e3](https://github.com/unbrowse-ai/unbrowse-dev/commit/b3873e3a1b0f250da42f799af081b59ecdf39433))
* prevent garbage DOM extractions from polluting marketplace ([778ac7f](https://github.com/unbrowse-ai/unbrowse-dev/commit/778ac7f8344ee26d19ac04f5d09e72769bd2f160))
* query params execution, intent threading, publish race, kv cache ([#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)) ([19c223c](https://github.com/unbrowse-ai/unbrowse-dev/commit/19c223c725b0b2049657825473cb5bb1c918fe92))
* refresh lockfile and spa extraction fallback ([67e4800](https://github.com/unbrowse-ai/unbrowse-dev/commit/67e48006dc7c4002d3ca1cec33b55f8f99d48502))
* remove duplicate function bodies from squash merge artifact ([be05a5e](https://github.com/unbrowse-ai/unbrowse-dev/commit/be05a5e9455f439f0f0f4f9473de0169a7043ea7)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)
* remove duplicate old kvFallbackSearch body (squash artifact) ([f5efe9e](https://github.com/unbrowse-ai/unbrowse-dev/commit/f5efe9e8f37df53682f178e7221d4d7a94fb548b))
* repair search index — filter null metadata, log index failures, add reindex endpoint ([a5da1c4](https://github.com/unbrowse-ai/unbrowse-dev/commit/a5da1c4c588a5d3795180f14f2c5dab3b8764ddf))
* replace broken SKILLS_KV fallback search with qdkv cache ([f889901](https://github.com/unbrowse-ai/unbrowse-dev/commit/f889901fea3373bf9517c27b0435518e23713920))
* resolve Invalid URL crashes and capture failures on heavy SPAs (v2.0.2) ([b581fa7](https://github.com/unbrowse-ai/unbrowse-dev/commit/b581fa781aa960db062ca6dce0a731202223badf))
* resolve URN references when inline fields are null ([#62](https://github.com/unbrowse-ai/unbrowse-dev/issues/62)) ([67e9815](https://github.com/unbrowse-ai/unbrowse-dev/commit/67e9815d6fa9daa72b8658cab4239d5a6cd191ef))
* restore vector namespace to unbrowse--global ([8bf6fa9](https://github.com/unbrowse-ai/unbrowse-dev/commit/8bf6fa96983747e1ce45776f2fe34e2b90ce4939))
* restore vector search namespace, remove kv fallback ([#3](https://github.com/unbrowse-ai/unbrowse-dev/issues/3)) ([0788ac2](https://github.com/unbrowse-ai/unbrowse-dev/commit/0788ac22f8425e467d73f641a25ab23ffa777442))
* search 20x faster, auth reliability, CI tests ([#36](https://github.com/unbrowse-ai/unbrowse-dev/issues/36)) ([53f0240](https://github.com/unbrowse-ai/unbrowse-dev/commit/53f02406133f69cacc98148dfc316d82cd500523))
* sec-ch-ua headless leak + token savings baseline ([#29](https://github.com/unbrowse-ai/unbrowse-dev/issues/29)) ([d543469](https://github.com/unbrowse-ai/unbrowse-dev/commit/d5434693f9b2fed046ac295107625e3c998f61d6))
* security hardening — leaked keys, injection, auth gaps, timing attacks ([95aa7b0](https://github.com/unbrowse-ai/unbrowse-dev/commit/95aa7b03981ab423467a6e78cd5cb14ee02ae44e)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51) [#52](https://github.com/unbrowse-ai/unbrowse-dev/issues/52) [#53](https://github.com/unbrowse-ai/unbrowse-dev/issues/53) [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54) [#55](https://github.com/unbrowse-ai/unbrowse-dev/issues/55) [#56](https://github.com/unbrowse-ai/unbrowse-dev/issues/56)
* shell injection in sqliteQuery + sanitize auth_hint endpoint leak ([531ce57](https://github.com/unbrowse-ai/unbrowse-dev/commit/531ce57aca842e2210d7696b0868ca0845c942c2))
* skip kuri zig cache during skill sync ([3c34225](https://github.com/unbrowse-ai/unbrowse-dev/commit/3c342253ca7b1e1b696411f6f77774904d57deb1))
* SSR fallback for bot-detected sites + relax quality gate for DOM extraction ([df89a34](https://github.com/unbrowse-ai/unbrowse-dev/commit/df89a342771419758355da3199bcd4862c03374b))
* stabilize frontend deploy fonts ([74ff712](https://github.com/unbrowse-ai/unbrowse-dev/commit/74ff712747e3f5b4e1b2e16b879d8a86f043dbc2))
* stale route cache + domain cache persistence ([9d6e187](https://github.com/unbrowse-ai/unbrowse-dev/commit/9d6e187d5179f04b11e07b9370f91caf723e8f13))
* stealth patches, origin pre-nav, discover after newTab, kuri evaluate double-escape ([cde0d93](https://github.com/unbrowse-ai/unbrowse-dev/commit/cde0d93db0a6c3e8d83613f0e83b9e031666754c))
* store KV index values inline to eliminate subrequest explosion ([#22](https://github.com/unbrowse-ai/unbrowse-dev/issues/22)) ([4c01abb](https://github.com/unbrowse-ai/unbrowse-dev/commit/4c01abb1bec4f3f216f09dd400d1bdbdb90a8987))
* update vendored Kuri binaries with 5-bug capture fix (v2.0.5) ([ca9b641](https://github.com/unbrowse-ai/unbrowse-dev/commit/ca9b641616d908b5ad34c5390b5e6a9e6d5261a9))

### Performance

* add per-query result cache for search via qdkv ([54b9f87](https://github.com/unbrowse-ai/unbrowse-dev/commit/54b9f87f7f13e486fc3cd99eb1bb1729a3743423))
* combine 3 ops requests into single /v1/ops endpoint ([ab45af2](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab45af21bc3d068b2a5e9c4ba2d445a8def0ee56))
* eliminate N+1 EmergentDB fetches with listWithValues + index cache ([#2](https://github.com/unbrowse-ai/unbrowse-dev/issues/2)) ([fdcdc96](https://github.com/unbrowse-ai/unbrowse-dev/commit/fdcdc9614155faf06356bc297e5003100f59412a))
* fetch-first for all safe GETs including DOM + cookie support ([8ede9b7](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ede9b7c4f4a488c5ac3a664cbbf56becb475252))
* parallelize kv.put writes and fire-and-forget indexSkill on publish ([eacadca](https://github.com/unbrowse-ai/unbrowse-dev/commit/eacadca3f59796d9a2df8832623c56c545ed602d))
* replace EmergentDB-backed rate limiter with in-memory store ([7b25652](https://github.com/unbrowse-ai/unbrowse-dev/commit/7b2565252de1667a8dc6abb83487e02bfcc99ab2))

### Refactoring

* replace brittle assertions with data snapshots for LLM review ([2368e0e](https://github.com/unbrowse-ai/unbrowse-dev/commit/2368e0e0b558ca59e8e29bf3b608e338e9880d1c))

## [2.12.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-04)

## [2.12.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.4...v3.0.1) (2026-04-04)

### Bug Fixes

* restore frontend landing build on restored main ([62228a6](https://github.com/unbrowse-ai/unbrowse-dev/commit/62228a6cf92166701a3e575822c66c4e483e187e))

## Unreleased

- drop partial release-attestation headers from local/source API calls; send manifest + signature together or neither, so dev/runtime publish no longer trips `release_manifest_incomplete` on strict backends
- align the MCP tool surface with `SKILL.md`: make `resolve` explicitly cache-only, expose `review` + `publish` tools, and steer fresh captures through `go -> sync/close -> skill/publish -> review -> publish` instead of fake discovery via resolve
- make the skill/docs explicit that `npx skills add ... --skill unbrowse` is instruction-only; agents should tell users to install the `unbrowse` runtime separately instead of assuming the binary exists
- add browser-first MCP miss guidance on `unbrowse_resolve` cache misses, so agents are told to switch into `go -> snap -> ... -> review -> publish` instead of stalling on uncached sites
- expand `unbrowse_resolve` MCP miss guidance to return relevant option sets too (`browse_only`, `capture_for_reuse`, `auth_then_retry`), so agents can choose the right live path instead of only seeing one generic next step
- add `bun run publish:cli:preview` to build a prerelease npm package + GitHub binary assets against an explicit preview backend, so packaged preview installs and compiled preview binaries hit the same non-prod API by default
- make DAG hint inference value-aware too: recover unix-string `observed_at` ordering and lift likely edges when observed response values overlap downstream request values, so weak key matches stop dropping real workflow links
- widen passive browse capture harvest to include replayable API-style Performance API preloads and synthesize request stubs for them, so NusMods-style `api.*/*.json` resources survive checkpointing even when page-slug hints do not match
- keep raw path-binding evidence from reverse-engineering and defer semantic naming until the graph/review layer, so compound values like `2025-2026`, `semesters/2`, and `modules/ABM5001.json` stop collapsing into junk `{id}` templates while still surfacing reviewable candidate metadata
- add `x-brand-banter` skill bundle for Wendy's/Ryanair/MoonPie-style X brand voice, replies, and quote-tweet banter
- add archetype and routing references for choosing the right funny brand-account voice without drifting into generic social copy
- add `x-account-operator` foundry bundle to route winner analysis, voice selection, queue cuts, rewrites, and Typefully scheduling into one X account workflow
- add local `publish-bundle` CLI/API flow so one foundry preset writes bundle artifacts, host snippets, and the public share manifest in one step
- replace the repo-local `skills/foundry` symlink with a real `unbrowse-ai/foundry` git submodule

### Features

* **publish/dag**: publish admitted root endpoints together with DAG-linked callable workflow steps so future agents can invoke individual readable or mutable steps from the same skill
* **deploy/experiments**: add a dedicated Cloudflare `experiments` env for backend/frontend and wire `lewis/experiments` branch pushes to that isolated workers.dev sandbox with its own API URL secret
* **runtime/experiments**: add an `experiments` runtime preset with its own local profile, remote publish enabled, and beta backend wiring so branch-side publish tests do not reuse `prod`

### Bug Fixes

* **browser/kuri**: lazily allocate Kuri tabs in the browser wrapper so cache-hit `goto()` calls stop spawning stray blank tabs before a real browser fallback is needed
* **browser/kuri-proxy**: reconnect stale broker-side CDP sockets before retrying read commands, rebuild the vendored Kuri binary from the patched source, and unwrap broker `Runtime.evaluate` envelopes for `text`/`markdown`, so LinkedIn messaging `go`/`snap`/`text`/`eval` work through Unbrowse instead of only through raw `kuri-agent`
* **browse/proxy**: make `go` open a fresh Kuri-backed session unless `session_id` is explicitly provided, stop auto-resetting `snap`/`text`/`markdown`/`cookies`/`eval` reads behind the user's back, and remove replacement-tab rebinding so browse mode behaves like a thin Kuri proxy
* **browse/go**: treat Kuri warmup and transient connectivity aborts as recoverable browse-session failures so explicit `go` flows like LinkedIn messaging can recover instead of dying during startup/rebind
* **deploy/frontend-preview**: deploy staging and experiments frontends through Wrangler after the OpenNext build, so preview branches skip the CI-hostile R2 cache pre-upload path that was failing with `403 Forbidden`
* **install/runtime**: resolve packaged versions from the nearest `package.json` when present and fall back to the embedded release manifest in compiled binaries, so `health` reports the real release version instead of `unknown`
* **resolve/search**: reject cached marketplace skills for exact-URL search tasks when they do not expose the active search binding, and reject generic feed skills for messaging intents, so obvious misses stop pretending to be good cached hits
* **resolve/descriptions**: stop giving huge rank wins to generic auto descriptions like captured page artifacts, mark auto-vs-agent description provenance in resolve/publish output, and surface review warnings so agents stop trusting unreviewed DOM fallbacks as if they were reviewed API contracts
* **resolve/descriptions**: classify fresh local DOM fallback labels like `Search form for <domain>` and `Page content from <domain>` as auto-generated too, so clean-state browse/index runs stop mislabeling them as reviewed agent descriptions
* **publish/review**: make `publish --pretty` return per-endpoint review context from the operation graph, including deps, unlocks, provenance, trigger-page siblings, and current binding summaries, and stamp reviewed descriptions as agent-authored when the review step writes them back
* **publish/review**: block remote publish, including background auto-publish after `sync`/`close`, whenever any selected endpoint still has an auto/missing description, and return a review-required next step instead of silently sharing unreviewed contracts
* **publish/review**: surface safe request schema, response field schema, prerequisites, token bindings, and replay next-state in review context, and let `/review` persist agent-authored request/response schema annotations back into workflow artifacts
* **graph/linkage**: teach DAG inference to add low-confidence hint edges for alias-linked binding families across DOM/HTML/API surfaces (for example profile/member/public-identifier style links), so publish review can reason over likely dependencies even when names do not match exactly
 
## [2.12.7](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.6...v2.12.7) (2026-04-04)

## [2.12.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.5...v2.12.6) (2026-04-04)

## [2.12.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.0.1...v2.12.5) (2026-04-04)

### Features

* wire Kuri v0.3 action primitives into browser-action floor ([c0e43a6](https://github.com/unbrowse-ai/unbrowse-dev/commit/c0e43a60a75af9630d44d71324721a99db95ad8f)), closes [#86](https://github.com/unbrowse-ai/unbrowse-dev/issues/86) [#75](https://github.com/unbrowse-ai/unbrowse-dev/issues/75) [#3](https://github.com/unbrowse-ai/unbrowse-dev/issues/3) [#88](https://github.com/unbrowse-ai/unbrowse-dev/issues/88) [#85](https://github.com/unbrowse-ai/unbrowse-dev/issues/85)

### Bug Fixes

* refresh lockfile and spa extraction fallback ([4054a8a](https://github.com/unbrowse-ai/unbrowse-dev/commit/4054a8a99cbcba80ad648128e46c60573cfc2396))
* resolve Invalid URL crashes and capture failures on heavy SPAs (v2.0.2) ([7a4344d](https://github.com/unbrowse-ai/unbrowse-dev/commit/7a4344d89504ff611fb269a8ee4d01f2d80a2706))
* restore frontend landing build on restored main ([62228a6](https://github.com/unbrowse-ai/unbrowse-dev/commit/62228a6cf92166701a3e575822c66c4e483e187e))
* security hardening — leaked keys, injection, auth gaps, timing attacks ([9d5e468](https://github.com/unbrowse-ai/unbrowse-dev/commit/9d5e4680d18c1e04816919fca1ef124dfd62ccd9)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51) [#52](https://github.com/unbrowse-ai/unbrowse-dev/issues/52) [#53](https://github.com/unbrowse-ai/unbrowse-dev/issues/53) [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54) [#55](https://github.com/unbrowse-ai/unbrowse-dev/issues/55) [#56](https://github.com/unbrowse-ai/unbrowse-dev/issues/56)
* skip kuri zig cache during skill sync ([eb1d883](https://github.com/unbrowse-ai/unbrowse-dev/commit/eb1d88354fb6181339846a964a77d93714eec9e2))
* update kuri submodule — CDP async network event capture for HAR ([0976d55](https://github.com/unbrowse-ai/unbrowse-dev/commit/0976d550f446306ef3389801c6224d9db7a329a4))
* update kuri submodule — HAR recorder now returns entries correctly ([1f8d194](https://github.com/unbrowse-ai/unbrowse-dev/commit/1f8d194efbca0cd0502071529ece96344f07eded))
* **browse/capture**: make browse checkpointing reuse the richer passive-capture recovery path (Performance API replay plus HAR replay) and defer zero-evidence DOM form artifacts, so empty LinkedIn-style feed sessions stop poisoning the cache with fake DOM skills
* **resolve/runtime**: make `resolve` read-only again by returning a fast `no_cached_match` on misses, shortening search timeout, and keeping browser/login/capture flows explicit instead of side effects of resolve
* **resolve/dag**: return the full relevant workflow DAG slice from `resolve`, attach safe dependent GET prefetch hints to DAG operations and endpoint candidates, and fix endpoint-vs-operation graph filtering during auto-exec

## [2.12.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.3...v2.12.4) (2026-04-03)

### Bug Fixes

* publish release assets to public repo ([f69e97a](https://github.com/unbrowse-ai/unbrowse-dev/commit/f69e97a01a3ce3f18014bb1bc684ac65d4c5a7e5))

## [2.12.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.3...v2.12.4) (2026-04-03)

### Bug Fixes

* publish release assets to public repo ([f69e97a](https://github.com/unbrowse-ai/unbrowse-dev/commit/f69e97a01a3ce3f18014bb1bc684ac65d4c5a7e5))

## [2.12.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-04-03)

### Features

* **#100:** implement robots.txt directive checking before route execution ([b319f75](https://github.com/unbrowse-ai/unbrowse-dev/commit/b319f750ee1737c1c958af3350e1e0d78f7383ce)), closes [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100) [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100)
* **#103:** add composite search scoring to backend ([#196](https://github.com/unbrowse-ai/unbrowse-dev/issues/196)) ([202af76](https://github.com/unbrowse-ai/unbrowse-dev/commit/202af768f8c9d8cf1e1c6e888ad3cf6bbad607eb)), closes [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103)
* **#115:** add DAG advisory execution planner ([0923565](https://github.com/unbrowse-ai/unbrowse-dev/commit/09235655d934e24ce05882b87b0e3b1eda28e487)), closes [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115) [#115](https://github.com/unbrowse-ai/unbrowse-dev/issues/115)
* **#116:** add auth dependency runtime with LocalAuthRuntime ([#186](https://github.com/unbrowse-ai/unbrowse-dev/issues/186)) ([c2e9158](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2e9158ea353bea353fad9eabdfc61ceecd13522)), closes [#116](https://github.com/unbrowse-ai/unbrowse-dev/issues/116)
* **#117:** add telemetry-driven issue filing with repro bundles ([#187](https://github.com/unbrowse-ai/unbrowse-dev/issues/187)) ([f237060](https://github.com/unbrowse-ai/unbrowse-dev/commit/f2370608aa1daa9b257f5a579ab3dfd721cb1f1a)), closes [#117](https://github.com/unbrowse-ai/unbrowse-dev/issues/117)
* **#117:** add telemetry-driven issue filing with repro bundles ([#197](https://github.com/unbrowse-ai/unbrowse-dev/issues/197)) ([0b5c641](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b5c6417d2753af374491f30b098ed74af42492c)), closes [#117](https://github.com/unbrowse-ai/unbrowse-dev/issues/117)
* **#121:** browser host path for OpenAI/native ([#191](https://github.com/unbrowse-ai/unbrowse-dev/issues/191)) ([69c18d5](https://github.com/unbrowse-ai/unbrowse-dev/commit/69c18d5c33e87a5eaff4529d9e90563cb963fff8)), closes [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#121](https://github.com/unbrowse-ai/unbrowse-dev/issues/121) [#91](https://github.com/unbrowse-ai/unbrowse-dev/issues/91) [#112](https://github.com/unbrowse-ai/unbrowse-dev/issues/112) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#123:** analytics bottleneck metrics ([#198](https://github.com/unbrowse-ai/unbrowse-dev/issues/198)) ([99c848e](https://github.com/unbrowse-ai/unbrowse-dev/commit/99c848e8e9e1360331c8812946210662a63506b8)), closes [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34) [#70](https://github.com/unbrowse-ai/unbrowse-dev/issues/70) [#125](https://github.com/unbrowse-ai/unbrowse-dev/issues/125) [#123](https://github.com/unbrowse-ai/unbrowse-dev/issues/123)
* **#144:** add batch path template mining for passive captures ([9c30cd7](https://github.com/unbrowse-ai/unbrowse-dev/commit/9c30cd722665c54fb7e18d54bef4b0288c09b3e4)), closes [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144) [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144)
* **#144:** batch path template mining for captures without context URLs ([#204](https://github.com/unbrowse-ai/unbrowse-dev/issues/204)) ([07d3461](https://github.com/unbrowse-ai/unbrowse-dev/commit/07d3461f5f46217991fa52cd78dccca600d78171)), closes [#144](https://github.com/unbrowse-ai/unbrowse-dev/issues/144)
* **#155:** add BM25 lexical search with RRF fusion ([fc0ce39](https://github.com/unbrowse-ai/unbrowse-dev/commit/fc0ce39a4707bb414f9c075dd39f06061697aa89)), closes [#155](https://github.com/unbrowse-ai/unbrowse-dev/issues/155)
* **#155:** add BM25 lexical search with RRF fusion ([#202](https://github.com/unbrowse-ai/unbrowse-dev/issues/202)) ([a68b84a](https://github.com/unbrowse-ai/unbrowse-dev/commit/a68b84a711d6def5fadbeed31de2381db9a5b309)), closes [#155](https://github.com/unbrowse-ai/unbrowse-dev/issues/155)
* **#165:** ground LLM descriptions in params and responses ([#189](https://github.com/unbrowse-ai/unbrowse-dev/issues/189)) ([0558c6c](https://github.com/unbrowse-ai/unbrowse-dev/commit/0558c6cfb12df655f6be922d284548b27443bfeb)), closes [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103)
* **#175:** RSC wire format support in capture ([#188](https://github.com/unbrowse-ai/unbrowse-dev/issues/188)) ([0956633](https://github.com/unbrowse-ai/unbrowse-dev/commit/0956633ac7a344fa53d6d7cf5c329dfe3fe5b898)), closes [#175](https://github.com/unbrowse-ai/unbrowse-dev/issues/175) [#103](https://github.com/unbrowse-ai/unbrowse-dev/issues/103) [#165](https://github.com/unbrowse-ai/unbrowse-dev/issues/165)
* **#213,#90,#214:** domain/task CLI, server supervisor, action provenance ([#215](https://github.com/unbrowse-ai/unbrowse-dev/issues/215)) ([a9bec5c](https://github.com/unbrowse-ai/unbrowse-dev/commit/a9bec5c83030fc006b5ca23e2b3d41a20a04fa5b)), closes [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90) [#214](https://github.com/unbrowse-ai/unbrowse-dev/issues/214) [#213](https://github.com/unbrowse-ai/unbrowse-dev/issues/213) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#218:** wire runtime DAG to backend EmergentDB graph ([5035a82](https://github.com/unbrowse-ai/unbrowse-dev/commit/5035a8209fca45e1eed3d35d4bbb69f31564c93f)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#28:** anonymized route trace telemetry pipeline ([#206](https://github.com/unbrowse-ai/unbrowse-dev/issues/206)) ([624ec47](https://github.com/unbrowse-ai/unbrowse-dev/commit/624ec4793ff2f40753efd982ca19b8f946308698)), closes [#28](https://github.com/unbrowse-ai/unbrowse-dev/issues/28)
* **#32,#33:** lobster.cash-compatible payment integration ([#216](https://github.com/unbrowse-ai/unbrowse-dev/issues/216)) ([b38deba](https://github.com/unbrowse-ai/unbrowse-dev/commit/b38deba9df342906b6ad209d6efbc01e7417ff98)), closes [#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32) [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** add x402 payment lane stub with PaymentGate interface ([#184](https://github.com/unbrowse-ai/unbrowse-dev/issues/184)) ([c50e973](https://github.com/unbrowse-ai/unbrowse-dev/commit/c50e973204b4475a26676f7752404d676a854459)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire payment gate into runtime orchestrator ([08a3bf7](https://github.com/unbrowse-ai/unbrowse-dev/commit/08a3bf7674f8dc9929a57de89f4028a368332a90)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#33:** wire x402 payment gating and fee recording into backend routes ([3bce394](https://github.com/unbrowse-ai/unbrowse-dev/commit/3bce3941c1295799807ba4aa3a8bc1f3f38f6b15)), closes [#33](https://github.com/unbrowse-ai/unbrowse-dev/issues/33)
* **#40:** dynamic route pricing and site-owner opt-in compensation ([#210](https://github.com/unbrowse-ai/unbrowse-dev/issues/210)) ([1a50d5f](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a50d5f8145ea2fa8d360779f637451cf47708a3)), closes [#40](https://github.com/unbrowse-ai/unbrowse-dev/issues/40)
* **#87:** wire unsafe action score gate into auto-execution ([#199](https://github.com/unbrowse-ai/unbrowse-dev/issues/199)) ([30885dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/30885dd54ee1ebd16cd72e20bd6ccf9019814061)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#87:** wire unsafe action score gate into canAutoExecuteEndpoint ([#182](https://github.com/unbrowse-ai/unbrowse-dev/issues/182)) ([d5bbf64](https://github.com/unbrowse-ai/unbrowse-dev/commit/d5bbf647c6ace8b5af79337e3ba1c55bb229b64e)), closes [#87](https://github.com/unbrowse-ai/unbrowse-dev/issues/87)
* **#91,#112,#90:** add host integrations, login UX config, runtime supervisor ([#195](https://github.com/unbrowse-ai/unbrowse-dev/issues/195)) ([966ec32](https://github.com/unbrowse-ai/unbrowse-dev/commit/966ec3249b81ef8b03e62e67ccde843d8c81ac61)), closes [#91](https://github.com/unbrowse-ai/unbrowse-dev/issues/91) [#112](https://github.com/unbrowse-ai/unbrowse-dev/issues/112) [#90](https://github.com/unbrowse-ai/unbrowse-dev/issues/90)
* **#92,#93,#95,#96:** search forms, eval types, lifecycle attribution ([#194](https://github.com/unbrowse-ai/unbrowse-dev/issues/194)) ([b394ea2](https://github.com/unbrowse-ai/unbrowse-dev/commit/b394ea240a178ff0236dfad227323743c01c91ab)), closes [#92](https://github.com/unbrowse-ai/unbrowse-dev/issues/92) [#93](https://github.com/unbrowse-ai/unbrowse-dev/issues/93) [#95](https://github.com/unbrowse-ai/unbrowse-dev/issues/95) [#96](https://github.com/unbrowse-ai/unbrowse-dev/issues/96) [#92](https://github.com/unbrowse-ai/unbrowse-dev/issues/92) [#93](https://github.com/unbrowse-ai/unbrowse-dev/issues/93) [#95](https://github.com/unbrowse-ai/unbrowse-dev/issues/95)
* **#98:** delta-based contribution attribution for Tier 1 fee splits ([#209](https://github.com/unbrowse-ai/unbrowse-dev/issues/209)) ([92aa403](https://github.com/unbrowse-ai/unbrowse-dev/commit/92aa4032c28964d0f0f19589364f7ba7ea9cb597)), closes [#98](https://github.com/unbrowse-ai/unbrowse-dev/issues/98)
* **#99,#101:** wire consecutive failures and schema drift to auto-deprecation ([#192](https://github.com/unbrowse-ai/unbrowse-dev/issues/192)) ([129e8e4](https://github.com/unbrowse-ai/unbrowse-dev/commit/129e8e47b0901645b0c6ad1168d16e2861063140)), closes [#99](https://github.com/unbrowse-ai/unbrowse-dev/issues/99) [#101](https://github.com/unbrowse-ai/unbrowse-dev/issues/101)
* add curl-based install script served from unbrowse.ai ([adbc3f1](https://github.com/unbrowse-ai/unbrowse-dev/commit/adbc3f13d6671f08940118a95ee93cf893121e78))
* add GraphSession for passive request indexing against operation graph ([20bd110](https://github.com/unbrowse-ai/unbrowse-dev/commit/20bd110186507016de4c286965759b02fe3a1d54))
* add gstack-style ./setup script for one-liner installation ([8223b8b](https://github.com/unbrowse-ai/unbrowse-dev/commit/8223b8b769e521ee4946aaa6f7fd339d89b92926))
* add P0/P1 automated regression testing framework ([2993299](https://github.com/unbrowse-ai/unbrowse-dev/commit/299329931f6688baca7ef29c9da543e12ae7c6eb))
* add routing analytics summaries ([1c22fc7](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c22fc733ce34f0fa5e653c1e71a460ae85c6d0d))
* add routing telemetry and harden cli flows ([973b62e](https://github.com/unbrowse-ai/unbrowse-dev/commit/973b62edd5acab3907ded95845e4d043401a7e17))
* add routing telemetry prep ([#330](https://github.com/unbrowse-ai/unbrowse-dev/issues/330)) ([ad05e6f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ad05e6f12daf27dbd2cf4027406aac8c0f8334a4))
* add X campaign feedback operator bundle ([b65530e](https://github.com/unbrowse-ai/unbrowse-dev/commit/b65530eef987b4fae9bc91367f9ff9e5671050b1))
* **auth:** add Comet browser support for cookie extraction and login ([cda5bc8](https://github.com/unbrowse-ai/unbrowse-dev/commit/cda5bc83085808cf098f81cc54ddf7ad9ace6850))
* extend CaptureResult with optional graph_session field ([a88dd27](https://github.com/unbrowse-ai/unbrowse-dev/commit/a88dd27ce42a80f473337fd06fbb5e639a3a8a83))
* feature flag out extra plugins, keep skill + one-shot + manual ([01e411a](https://github.com/unbrowse-ai/unbrowse-dev/commit/01e411a682be30392c4b8ba819740b72aa0c53df))
* **frontend:** enable Cloudflare image optimization and fix build ([b1de15f](https://github.com/unbrowse-ai/unbrowse-dev/commit/b1de15fafe815383c009ecee04b93ab5ac7cb4fd))
* gate policy-sensitive site mutations ([#328](https://github.com/unbrowse-ai/unbrowse-dev/issues/328)) ([8e0c7b1](https://github.com/unbrowse-ai/unbrowse-dev/commit/8e0c7b1de95fe6513de73ea2a5ccbc8b9d6885c9))
* **kuri:** add browser action primitive wrappers ([57ecc46](https://github.com/unbrowse-ai/unbrowse-dev/commit/57ecc4650a94bb2f8cc8cc2ee7c473bd9e5eabdf))
* restore paper landing page as "Internal APIs Are All You Need" ([ccdbbb9](https://github.com/unbrowse-ai/unbrowse-dev/commit/ccdbbb95a599307a156ba69a50bb7f5ec9990d33))
* verify release manifests and gate endpoints by corroboration ([15eccd1](https://github.com/unbrowse-ai/unbrowse-dev/commit/15eccd14123131bf111a8c000d1663b207032aec))
* wire Kuri v0.3 action primitives into browser-action floor ([c0e43a6](https://github.com/unbrowse-ai/unbrowse-dev/commit/c0e43a60a75af9630d44d71324721a99db95ad8f)), closes [#86](https://github.com/unbrowse-ai/unbrowse-dev/issues/86) [#75](https://github.com/unbrowse-ai/unbrowse-dev/issues/75) [#3](https://github.com/unbrowse-ai/unbrowse-dev/issues/3) [#88](https://github.com/unbrowse-ai/unbrowse-dev/issues/88) [#85](https://github.com/unbrowse-ai/unbrowse-dev/issues/85)

### Bug Fixes

* **#104:** call recordExecution after skill execute to report stats to backend ([ec09a5f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec09a5f32e5a27874da9e60b2fad2ed066b76a56)), closes [#104](https://github.com/unbrowse-ai/unbrowse-dev/issues/104)
* **#108:** wire first-pass browser action fallback into no-route resolve path ([#179](https://github.com/unbrowse-ai/unbrowse-dev/issues/179)) ([30f5737](https://github.com/unbrowse-ai/unbrowse-dev/commit/30f57372eda9442ae3dd150e2a2f432f546e2cfc))
* **#109:** spawn failure on LinkedIn — add retry logic to kuri start ([c8ef8e1](https://github.com/unbrowse-ai/unbrowse-dev/commit/c8ef8e13d5f5a1e7ce1055bb066bfc8621e89199)), closes [#109](https://github.com/unbrowse-ai/unbrowse-dev/issues/109)
* **#113:** abort hanging CDP phases via AbortSignal when capture timeout fires ([e5e64c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/e5e64c65c2feb7b7543ff3fb369ddb0c0434244f)), closes [#113](https://github.com/unbrowse-ai/unbrowse-dev/issues/113)
* **#114:** add query hook bridge for UI event → network provenance ([#200](https://github.com/unbrowse-ai/unbrowse-dev/issues/200)) ([1afd13e](https://github.com/unbrowse-ai/unbrowse-dev/commit/1afd13eec520a9123b0ba126b9f7913023c4de4c)), closes [#114](https://github.com/unbrowse-ai/unbrowse-dev/issues/114)
* **#118:** wire passive reverse-engineered artifacts into graph growth and marketplace ([#177](https://github.com/unbrowse-ai/unbrowse-dev/issues/177)) ([626462b](https://github.com/unbrowse-ai/unbrowse-dev/commit/626462bd1ab2b31863f61062598ab53ab960e08c)), closes [#118](https://github.com/unbrowse-ai/unbrowse-dev/issues/118)
* **#152:** prefer richer endpoint when merging duplicates ([1b9b07f](https://github.com/unbrowse-ai/unbrowse-dev/commit/1b9b07f74a2f231b29f6cd37f3519d3aedd98e4a)), closes [#152](https://github.com/unbrowse-ai/unbrowse-dev/issues/152)
* **#152:** prefer richer endpoint when merging duplicates ([#203](https://github.com/unbrowse-ai/unbrowse-dev/issues/203)) ([0b37423](https://github.com/unbrowse-ai/unbrowse-dev/commit/0b37423641b4f0bd34af73aebd92f5bee8ff30a1)), closes [#152](https://github.com/unbrowse-ai/unbrowse-dev/issues/152)
* **#218:** rewrite tests to hit real backend, never mock fetch ([cc09d11](https://github.com/unbrowse-ai/unbrowse-dev/commit/cc09d1174e906df3907742a8d4b38613ccaca75c)), closes [#218](https://github.com/unbrowse-ai/unbrowse-dev/issues/218)
* **#220:** wire computeBottleneckMetrics into backend analytics route ([e97d675](https://github.com/unbrowse-ai/unbrowse-dev/commit/e97d67581745fe4297a0c7a1489ce0f69e8de94a)), closes [#220](https://github.com/unbrowse-ai/unbrowse-dev/issues/220)
* **#221:** wire computeCompositeSearchScore into search/resolve path ([4812ef0](https://github.com/unbrowse-ai/unbrowse-dev/commit/4812ef0509e9285ab64d50a1970f0f2d8356510d))
* **#221:** wire computeCompositeSearchScore into search/resolve path ([040cd8b](https://github.com/unbrowse-ai/unbrowse-dev/commit/040cd8bc3fccbea3286dd98655ed932a78245a8d))
* **#222:** wire SUPPORTED_HOSTS, LocalSupervisor, getDefaultLoginConfig to production ([2c120c6](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c120c66ca33177db04217e252a6fa6a3367a535)), closes [#222](https://github.com/unbrowse-ai/unbrowse-dev/issues/222)
* **#223:** wire isStructuredSearchForm and attributeLifecycle into execution paths ([2352b9e](https://github.com/unbrowse-ai/unbrowse-dev/commit/2352b9edc921508abfa50c7e476ab4578f553aad)), closes [#223](https://github.com/unbrowse-ai/unbrowse-dev/issues/223)
* **#224:** wire BrowserAccessConfig and computeVerificationCoverage to production ([54548f0](https://github.com/unbrowse-ai/unbrowse-dev/commit/54548f03be051229e39e8190060fbb044c5191e2)), closes [#224](https://github.com/unbrowse-ai/unbrowse-dev/issues/224)
* **#225:** wire detectHostEnvironment and getBrowserConfig into kuri launch ([5362e5c](https://github.com/unbrowse-ai/unbrowse-dev/commit/5362e5c6781340e6b081f0c82d026fb5f6e2e0a1)), closes [#225](https://github.com/unbrowse-ai/unbrowse-dev/issues/225)
* **#226:** wire buildDescriptionPrompt into reverse-engineer pipeline ([a80273a](https://github.com/unbrowse-ai/unbrowse-dev/commit/a80273a4c8ead1c9ecbea25ab87f6c082e5202b4)), closes [#226](https://github.com/unbrowse-ai/unbrowse-dev/issues/226)
* **#227:** wire RSC wire format parser into capture pipeline ([988c6ab](https://github.com/unbrowse-ai/unbrowse-dev/commit/988c6ab8a34604166d9c616e47ca63c529c8a2d1)), closes [#227](https://github.com/unbrowse-ai/unbrowse-dev/issues/227)
* **#228:** wire telemetry-driven auto issue filing pipeline ([4e4e660](https://github.com/unbrowse-ai/unbrowse-dev/commit/4e4e660c008baca7476880558e792712373357dc)), closes [#228](https://github.com/unbrowse-ai/unbrowse-dev/issues/228)
* **#229:** implement tryFirstPassBrowserAction with HAR-based interception ([09f5118](https://github.com/unbrowse-ai/unbrowse-dev/commit/09f5118148494bfc9644bd39a7f7cbb91a8eb0fd)), closes [#229](https://github.com/unbrowse-ai/unbrowse-dev/issues/229)
* **#229:** implement tryFirstPassBrowserAction with HAR-based interception ([30d3170](https://github.com/unbrowse-ai/unbrowse-dev/commit/30d3170334d07ae2e43aa6cf6d95203f1c800381)), closes [#229](https://github.com/unbrowse-ai/unbrowse-dev/issues/229)
* **#230:** wire auth dependency runtime into login flow ([1329188](https://github.com/unbrowse-ai/unbrowse-dev/commit/1329188a6ec84c1f3630e05afb3277e530ee5d1a)), closes [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230) [#230](https://github.com/unbrowse-ai/unbrowse-dev/issues/230)
* **#231:** wire route pricing endpoint into payment flow ([da39ab0](https://github.com/unbrowse-ai/unbrowse-dev/commit/da39ab081337e6a65cdfa382abd8944651aa19f9)), closes [#231](https://github.com/unbrowse-ai/unbrowse-dev/issues/231)
* **#232:** wire delta attribution client-side so indexer_id is sent ([f072750](https://github.com/unbrowse-ai/unbrowse-dev/commit/f0727502ee532ca77db8845eb7749ccffb8c32de)), closes [#232](https://github.com/unbrowse-ai/unbrowse-dev/issues/232)
* **#233:** wire queuePassiveSkillPublish to actually publish skills ([bb720ed](https://github.com/unbrowse-ai/unbrowse-dev/commit/bb720ed2d779cd2ecec9aa8e1789b10d077b2efa)), closes [#233](https://github.com/unbrowse-ai/unbrowse-dev/issues/233)
* **#233:** wire queuePassiveSkillPublish to actually publish skills ([f6b9b53](https://github.com/unbrowse-ai/unbrowse-dev/commit/f6b9b53d4e912afa0bb167ac9d81faa239646643)), closes [#233](https://github.com/unbrowse-ai/unbrowse-dev/issues/233)
* **#48:** use pathToFileURL for tsx loader path to support Windows ([d95bab9](https://github.com/unbrowse-ai/unbrowse-dev/commit/d95bab91c9b6b9574966a5a482d70289be816a45)), closes [#48](https://github.com/unbrowse-ai/unbrowse-dev/issues/48)
* **#51:** export DEPRECATION_THRESHOLD and add auto_deprecated_at to EndpointStats ([8033996](https://github.com/unbrowse-ai/unbrowse-dev/commit/8033996141f1345481636a563c44d4673bdd040b)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([b75d396](https://github.com/unbrowse-ai/unbrowse-dev/commit/b75d3963cd51f88b09123edc0832d50760adcc5a)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#54:** add install warning audit smoke tests for OpenClaw plugin ([#180](https://github.com/unbrowse-ai/unbrowse-dev/issues/180)) ([#193](https://github.com/unbrowse-ai/unbrowse-dev/issues/193)) ([e0a6a75](https://github.com/unbrowse-ai/unbrowse-dev/commit/e0a6a7545974db4de35c7948e89cb4914fb623df)), closes [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54)
* **#89:** promote deferred skills to cache, guard mutable DOM auto-exec, restore resolvedParams IIFE ([cd8f9da](https://github.com/unbrowse-ai/unbrowse-dev/commit/cd8f9da6f05748ec3969835e58a651ed4c75a846)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)
* **#89:** promote deferred skills to cache, guard mutable DOM auto-exec, restore resolvedParams IIFE ([#201](https://github.com/unbrowse-ai/unbrowse-dev/issues/201)) ([894f89c](https://github.com/unbrowse-ai/unbrowse-dev/commit/894f89c1bc8d8ede2a77423147c8de6f04a45e9a)), closes [#89](https://github.com/unbrowse-ai/unbrowse-dev/issues/89)
* auto-extract browser cookies for gated sites, guard HAR entry iteration ([955564d](https://github.com/unbrowse-ai/unbrowse-dev/commit/955564debad2150f04a087da5aa1a2eb0a4486b0))
* auto-queue browse submit publish and document public repo ([9905005](https://github.com/unbrowse-ai/unbrowse-dev/commit/9905005afa86402ac75d521381e6ca2eec1ab184))
* bound frontend build api fetches ([f74bf7c](https://github.com/unbrowse-ai/unbrowse-dev/commit/f74bf7c3fe97c7f0444b8878f34d7282b8809d92))
* bound stale endpoint verification batches ([e98d95c](https://github.com/unbrowse-ai/unbrowse-dev/commit/e98d95c4fc75d581c78bcbc0427cb146ee4a6dd9))
* bundle vendored kuri and enforce package checks ([c165046](https://github.com/unbrowse-ai/unbrowse-dev/commit/c165046a89e5eecb24182c04fb67443120b3f850))
* capture API bodies via Performance API + sync XHR replay ([b88f98d](https://github.com/unbrowse-ai/unbrowse-dev/commit/b88f98dfb32f32f635e7cc031cd96dc3150c4811))
* **capture:** add live DOM extraction and improve interactive stimulus ([253112c](https://github.com/unbrowse-ai/unbrowse-dev/commit/253112c9471a44a7f0f9afe630198868a3b43a0b))
* **capture:** improve interceptor timing and add Performance API replay ([5f0d503](https://github.com/unbrowse-ai/unbrowse-dev/commit/5f0d503361fd3eb8f2d64ca9600fa69f5644c242))
* **capture:** wire live DOM extraction data through orchestrator to user ([664a637](https://github.com/unbrowse-ai/unbrowse-dev/commit/664a6371e783e389cc1217c2315cea7ff8991a04))
* disable local npm release handling ([6dd2ce1](https://github.com/unbrowse-ai/unbrowse-dev/commit/6dd2ce19b24dfff96cbe724b0e9ed57f0ef1319a))
* harden global install fallback and server version guards ([#323](https://github.com/unbrowse-ai/unbrowse-dev/issues/323)) ([ee91923](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee9192312766d8756b0691c5e45a2beec639085f))
* harden packaged kuri recovery ([16e89b5](https://github.com/unbrowse-ai/unbrowse-dev/commit/16e89b52c6eced2010327e7d2d2bae96aa5ff0d5))
* increase graph-api test timeout to 60s for rate-limit retries ([991d13a](https://github.com/unbrowse-ai/unbrowse-dev/commit/991d13a6da42671e4274254f3f3a0baf66c6f252))
* install unbrowse shim in stable user bins ([#326](https://github.com/unbrowse-ai/unbrowse-dev/issues/326)) ([6a69c66](https://github.com/unbrowse-ai/unbrowse-dev/commit/6a69c665659bfd67b72f64b9d807e19f11877d97))
* install.sh falls back to health if setup not available yet ([2c28268](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c28268527b3dd6b4a4ecb77bbde54b54b77d3bd))
* install.sh use --yes flag and drop setup command ([c293572](https://github.com/unbrowse-ai/unbrowse-dev/commit/c2935726646fe928fe1c4782d2043055f0ab1cb8))
* install.sh uses npm install instead of git clone ([6a13bf5](https://github.com/unbrowse-ai/unbrowse-dev/commit/6a13bf56ff53f9d01c81ba786244dced8d76351b))
* isolate browse sessions under parallel load ([3194c8e](https://github.com/unbrowse-ai/unbrowse-dev/commit/3194c8e79536e0cac53dcad4328d507f3bd7efae))
* isolate main CI local server and KV cache ([#325](https://github.com/unbrowse-ai/unbrowse-dev/issues/325)) ([c58711b](https://github.com/unbrowse-ai/unbrowse-dev/commit/c58711b72c428a7d9ceb518f6027cf222ebc7e37))
* **kuri:** correct press() and scroll() signatures to require ref param ([40cbcb8](https://github.com/unbrowse-ai/unbrowse-dev/commit/40cbcb893745bad61795cadb29c91b24d257036c))
* link homepage whitepaper button to paper landing page ([68b84f2](https://github.com/unbrowse-ai/unbrowse-dev/commit/68b84f2b8f3db6689ffaa78baf544874ee763119))
* make marketplace search free before paid skill detail ([#327](https://github.com/unbrowse-ai/unbrowse-dev/issues/327)) ([e9e1e7f](https://github.com/unbrowse-ai/unbrowse-dev/commit/e9e1e7f9287ad13c56dbf494c468a5072db334cc))
* **openclaw:** surface endpoint details in deferred resolve responses ([e964725](https://github.com/unbrowse-ai/unbrowse-dev/commit/e964725fb3241b93c4dcd935c4b3d637fadca532))
* resolve all 21 backend test failures (19 fail + 2 errors) ([8074d14](https://github.com/unbrowse-ai/unbrowse-dev/commit/8074d14ed3c27cfb96a5bdae649a7a6e269fc669))
* restore auth fallback and harden indexing ([1a30053](https://github.com/unbrowse-ai/unbrowse-dev/commit/1a3005306f892e785c53efc760207b06ae78939e))
* restore fee routes and x402 CORS headers after merge conflict ([a634f25](https://github.com/unbrowse-ai/unbrowse-dev/commit/a634f2506b313cfcda8677960936f5c89ec98281))
* restore gh in release workflow ([d1861f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/d1861f40af17d613abffb859c5a34797b0c526f7))
* restore packaged cli staging path ([bec02dd](https://github.com/unbrowse-ai/unbrowse-dev/commit/bec02dde63b91d15a8e5cd37718025e5142d551c))
* retarget docs and PR helpers to main ([0c4c5d1](https://github.com/unbrowse-ai/unbrowse-dev/commit/0c4c5d1874066b93968de7aa72e803717562a8e0))
* revert to unoptimized images, fix package.json and next.config syntax ([2352069](https://github.com/unbrowse-ai/unbrowse-dev/commit/2352069c2f7642604add1bc75928f0f08ae90195))
* simplify install setup path ([3c31214](https://github.com/unbrowse-ai/unbrowse-dev/commit/3c3121463836421b68187985dc5f29d761350911))
* skip pre-push P0/P1 suite when no analyses exist ([427c58d](https://github.com/unbrowse-ai/unbrowse-dev/commit/427c58de07cc18a9e5f6d47591d14c01e2608591))
* stabilize browse submit recovery ([c586d5e](https://github.com/unbrowse-ai/unbrowse-dev/commit/c586d5e53ee34e7c3b6b051f38f9722f5ee7dadf))
* unblock cli bootstrap and e2e smoke ([9cf533b](https://github.com/unbrowse-ai/unbrowse-dev/commit/9cf533bfe632c555b9abad87ffb063a53d61bb1e))
* unblock cli wallet setup and auth e2e ([c92f39f](https://github.com/unbrowse-ai/unbrowse-dev/commit/c92f39f679966507686306dca57510ded95f0c55))
* unblock main ci checks ([72f7cd9](https://github.com/unbrowse-ai/unbrowse-dev/commit/72f7cd9e4b640453b20cc96db421b6ac799a16de))
* update kuri submodule — CDP async network event capture for HAR ([0976d55](https://github.com/unbrowse-ai/unbrowse-dev/commit/0976d550f446306ef3389801c6224d9db7a329a4))
* update kuri submodule — HAR recorder now returns entries correctly ([1f8d194](https://github.com/unbrowse-ai/unbrowse-dev/commit/1f8d194efbca0cd0502071529ece96344f07eded))
* use unbrowse health instead of setup in install.sh ([557911c](https://github.com/unbrowse-ai/unbrowse-dev/commit/557911ce5aa6049efa8510d14843252b058aee85))

### Refactoring

* simplify install.sh — use npx skills add for registration ([78f280b](https://github.com/unbrowse-ai/unbrowse-dev/commit/78f280bfcbe683746335432c462fa6f2eea96c26))
* simplify setup script — delegate to CLI for runtime bootstrap ([8848b52](https://github.com/unbrowse-ai/unbrowse-dev/commit/8848b52103760d6fbe544787fb4590e1ee734c74))

## [2.1.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-24)

### Bug Fixes

* keep structured search skills on the resolve path ([1de509d](https://github.com/unbrowse-ai/unbrowse-dev/commit/1de509dda5746f8074fcec555e0e4a7c3f1e2f10))
* rebuild canonical retrieval hydration from domain index ([#72](https://github.com/unbrowse-ai/unbrowse-dev/issues/72)) ([35e6de9](https://github.com/unbrowse-ai/unbrowse-dev/commit/35e6de9d732a84f553bdf0f2d574b97fab846485))
* recover LawNet search form execution ([25a4e17](https://github.com/unbrowse-ai/unbrowse-dev/commit/25a4e172da849e57ad68cc6c41044c552785f7d8))

## [2.1.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-24)

## [2.1.4](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* harden LawNet search execution ([c42852c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c42852c7c08664d54d1eff342b060f30da04b711))

## [2.1.3](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* stabilize warm retrieval cache ([ee3a2ac](https://github.com/unbrowse-ai/unbrowse-dev/commit/ee3a2ac43ccc87004c25e061c3acb497e3831e3a))

## [2.1.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* harden LawNet search recovery ([8eb5d04](https://github.com/unbrowse-ai/unbrowse-dev/commit/8eb5d048fda6da402a31d241088dc7285ec9f6da))

## [2.1.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* restore packaged cli self-healing ([5b6b921](https://github.com/unbrowse-ai/unbrowse-dev/commit/5b6b92111c0f24636e5c79c516134c1891321722))

## [2.1.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Features

* improve capture resilience and align kuri upstream ([4607822](https://github.com/unbrowse-ai/unbrowse-dev/commit/46078224f8fafda4de7b9a2a9df04f37fd9a5b71))

## [2.0.23](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* sharpen mcp routing defaults ([3e1b355](https://github.com/unbrowse-ai/unbrowse-dev/commit/3e1b35591c7ba7231061bcea5bfd927133013f99))

## [2.0.22](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* stabilize installed linkedin force-capture ([f381f48](https://github.com/unbrowse-ai/unbrowse-dev/commit/f381f48dbf5d344f37b9a69141fd219579f7cdff))

## [2.0.21](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* harden auth capture and Hermes install docs ([8ecd63e](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ecd63ebf2cc2fd52ea9a77e1b74200b84cb5eeb))

## [2.0.16](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-23)

### Bug Fixes

* disable release-it npm bump step ([6dbda71](https://github.com/unbrowse-ai/unbrowse-dev/commit/6dbda71e368c84e8f3962f572e99a06a772f7d66))
* disable release-it npm bump step ([#69](https://github.com/unbrowse-ai/unbrowse-dev/issues/69)) ([bff1753](https://github.com/unbrowse-ai/unbrowse-dev/commit/bff1753d4b8ad98256e70230ac0b2cca7bd5dab5))
* restore retrieval gate coverage ([781e660](https://github.com/unbrowse-ai/unbrowse-dev/commit/781e660dc8f49949e6026b71581c0730911c175b))
* stabilize webarena adapted evals ([8afd22d](https://github.com/unbrowse-ai/unbrowse-dev/commit/8afd22de3ffece143b2ae63d26f1a6a1f9263347))

## [2.0.15](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* align frontend deploy path and install docs ([#25](https://github.com/unbrowse-ai/unbrowse-dev/issues/25)) ([1f20a33](https://github.com/unbrowse-ai/unbrowse-dev/commit/1f20a33c485676124044854f1325085dbe5bab88))
* pin deploys to maintained kuri fork ([3055bcf](https://github.com/unbrowse-ai/unbrowse-dev/commit/3055bcfc57151d032c55cd93e0a43d59a1a2c012))

## [2.0.14](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* seed staging browser eval auth ([#24](https://github.com/unbrowse-ai/unbrowse-dev/issues/24)) ([9caa74d](https://github.com/unbrowse-ai/unbrowse-dev/commit/9caa74d769aca1a61b17d962753bb17ae629578d))

## [2.0.13](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

## [2.0.12](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* bypass staging eval search cache ([b1b2038](https://github.com/unbrowse-ai/unbrowse-dev/commit/b1b2038291e2536599ff0cf3fb3b51487e1654e6))

## [2.0.11](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* exempt staging eval token from search throttles ([1c29770](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c29770752cea8143eb9f4f654bd84bac3f53096))

## [2.0.10](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* stop staging live eval from assuming seeded search ([#20](https://github.com/unbrowse-ai/unbrowse-dev/issues/20)) ([e6b4c2b](https://github.com/unbrowse-ai/unbrowse-dev/commit/e6b4c2b2740e852a744a489e5e77e2d860717729))

## [2.0.9](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* separate public search rate limits for authed evals ([#19](https://github.com/unbrowse-ai/unbrowse-dev/issues/19)) ([8ea11ce](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ea11ce4b4b4c40e1a45f3c539b7a13edcd1665d))

## [2.0.8](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* normalize skill sync newlines on windows ([#15](https://github.com/unbrowse-ai/unbrowse-dev/issues/15)) ([f511e7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/f511e7e32c9539214b5b18ddda04db4225c0f8ce))
* publish npm packages on self-hosted runners ([#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)) ([7d6f81d](https://github.com/unbrowse-ai/unbrowse-dev/commit/7d6f81df521d74cd3be8e425e848c19e1de77f5e))
* restore mcp package build ([#17](https://github.com/unbrowse-ai/unbrowse-dev/issues/17)) ([442922f](https://github.com/unbrowse-ai/unbrowse-dev/commit/442922f46f11595308f6fa8688fa91fbdfc61220))
* skip live graph api tests by default ([#14](https://github.com/unbrowse-ai/unbrowse-dev/issues/14)) ([a4d69d7](https://github.com/unbrowse-ai/unbrowse-dev/commit/a4d69d72eb562b248e8d51770e8143e5cb37c5c3))
* unblock release packaging gates ([#18](https://github.com/unbrowse-ai/unbrowse-dev/issues/18)) ([d142996](https://github.com/unbrowse-ai/unbrowse-dev/commit/d142996cbd6487289c062ad63c34d4598d0cdb4c))

## [2.0.7](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-22)

### Bug Fixes

* simplify api key auto-registration ([#9](https://github.com/unbrowse-ai/unbrowse-dev/issues/9)) ([198a6d2](https://github.com/unbrowse-ai/unbrowse-dev/commit/198a6d299bc5e4f0a8529901dbdc757b3432746b))
* simplify one-command install flow ([#11](https://github.com/unbrowse-ai/unbrowse-dev/issues/11)) ([2d4bbe5](https://github.com/unbrowse-ai/unbrowse-dev/commit/2d4bbe52299ac82e039568969317fa124efa616f))
* track windows kuri binary for npm pack ([#10](https://github.com/unbrowse-ai/unbrowse-dev/issues/10)) ([bc6b39a](https://github.com/unbrowse-ai/unbrowse-dev/commit/bc6b39afa6973c8fbe5b261ea61646228c2cf6fe))

## [2.0.6](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-21)

### Features

* add ElizaOS plugin for unbrowse integration ([5134ac5](https://github.com/unbrowse-ai/unbrowse-dev/commit/5134ac56828bd077d2e44d31c99d2c0192dcc9ea))
* add LangChain integration (unbrowse-langchain) ([c064902](https://github.com/unbrowse-ai/unbrowse-dev/commit/c064902e091d01393d43388d70f06e0f7dbb7019))
* add MCP server integration for universal AI client support ([baa460c](https://github.com/unbrowse-ai/unbrowse-dev/commit/baa460c35d18ad297a1c544918be57081dbe9f24))
* add unbrowse-hermes plugin for Hermes Agent framework ([c010d88](https://github.com/unbrowse-ai/unbrowse-dev/commit/c010d88e075d01aa6291d9fc873bdcd247b22e65))

### Bug Fixes

* add stealth patches + restore origin pre-navigation for authed captures ([14e5c56](https://github.com/unbrowse-ai/unbrowse-dev/commit/14e5c5618cf736737313a289b0ced64738fb01f5))
* check vendor binaries first, skip zig build when present ([5f25866](https://github.com/unbrowse-ai/unbrowse-dev/commit/5f2586651ff9582b4ee834e0d3192c1b343e1e49))
* CSRF detection via DAG-based value matching + JSESSIONID/csrf-token support ([c91894c](https://github.com/unbrowse-ai/unbrowse-dev/commit/c91894c96966e5b907b2b7467b421587527163f4))
* login opens user's default browser + auto-discover all Chromium/Firefox browsers ([680d877](https://github.com/unbrowse-ai/unbrowse-dev/commit/680d87759d368a44fe9a76ce80886553279bcc3c))
* refresh lockfile and spa extraction fallback ([4054a8a](https://github.com/unbrowse-ai/unbrowse-dev/commit/4054a8a99cbcba80ad648128e46c60573cfc2396))
* resolve Invalid URL crashes and capture failures on heavy SPAs (v2.0.2) ([7a4344d](https://github.com/unbrowse-ai/unbrowse-dev/commit/7a4344d89504ff611fb269a8ee4d01f2d80a2706))
* security hardening — leaked keys, injection, auth gaps, timing attacks ([9d5e468](https://github.com/unbrowse-ai/unbrowse-dev/commit/9d5e4680d18c1e04816919fca1ef124dfd62ccd9)), closes [#51](https://github.com/unbrowse-ai/unbrowse-dev/issues/51) [#52](https://github.com/unbrowse-ai/unbrowse-dev/issues/52) [#53](https://github.com/unbrowse-ai/unbrowse-dev/issues/53) [#54](https://github.com/unbrowse-ai/unbrowse-dev/issues/54) [#55](https://github.com/unbrowse-ai/unbrowse-dev/issues/55) [#56](https://github.com/unbrowse-ai/unbrowse-dev/issues/56)
* skip kuri zig cache during skill sync ([eb1d883](https://github.com/unbrowse-ai/unbrowse-dev/commit/eb1d88354fb6181339846a964a77d93714eec9e2))
* SSR fallback for bot-detected sites + relax quality gate for DOM extraction ([df89a34](https://github.com/unbrowse-ai/unbrowse-dev/commit/df89a342771419758355da3199bcd4862c03374b))
* stealth patches, origin pre-nav, discover after newTab, kuri evaluate double-escape ([cde0d93](https://github.com/unbrowse-ai/unbrowse-dev/commit/cde0d93db0a6c3e8d83613f0e83b9e031666754c))
* update vendored Kuri binaries with 5-bug capture fix (v2.0.5) ([ca9b641](https://github.com/unbrowse-ai/unbrowse-dev/commit/ca9b641616d908b5ad34c5390b5e6a9e6d5261a9))

## [2.0.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-15)

### Features

* migrate backend to EmergentDB Graph API ([#85](https://github.com/unbrowse-ai/unbrowse-dev/issues/85)) ([fabfe87](https://github.com/unbrowse-ai/unbrowse-dev/commit/fabfe87ce21d4b66cfc918ea383a90ff772e6f32))
* sharpen landing hero value prop ([56b6035](https://github.com/unbrowse-ai/unbrowse-dev/commit/56b60356a24984e1f785ae3dc2f160979576b6ee))

### Bug Fixes

* bundle kuri runtime in cli releases ([4353f3e](https://github.com/unbrowse-ai/unbrowse-dev/commit/4353f3ecb574aa9c8dc67855318d29624d3d87d3))
* stabilize frontend deploy fonts ([a51c4e2](https://github.com/unbrowse-ai/unbrowse-dev/commit/a51c4e29a75f233c62147a48029ece978b8af281))

## [2.0.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-14)

### Features

* auto-execute + SSR fast-path (15s → 3.6s) ([318c10f](https://github.com/unbrowse-ai/unbrowse-dev/commit/318c10f243543857a945b34488ce0214780094c8))
* auto-execute DOM extraction endpoints with LLM param inference ([b03b0d2](https://github.com/unbrowse-ai/unbrowse-dev/commit/b03b0d25e403b86f930f49575b2f182fbfeb0859))
* auto-execute, SSR fast-path, route/domain caching, evals, backend improvements ([0fd9346](https://github.com/unbrowse-ai/unbrowse-dev/commit/0fd93468102e62364e1a31697cf8e6ea9e3b1a12))
* domain-level skill cache for cross-intent reuse ([1aa8361](https://github.com/unbrowse-ai/unbrowse-dev/commit/1aa8361f671bf91f3f31e1320e3caa9c6df965e1))
* expand public eval corpus and prep v2.0.0 ([b75f8d2](https://github.com/unbrowse-ai/unbrowse-dev/commit/b75f8d2f73e49bc9b96e38feadf3c2a0135c88a4))
* persist route cache to disk (survives restarts) ([a6a5eae](https://github.com/unbrowse-ai/unbrowse-dev/commit/a6a5eaeac33a264bfe099e07465e02e4f71f26d6))
* replace agent-browser with Kuri — CLI-first Zig-native browser automation ([6053014](https://github.com/unbrowse-ai/unbrowse-dev/commit/6053014c7c05411cac5988dd62ec2fa5ff417169)), closes [#71](https://github.com/unbrowse-ai/unbrowse-dev/issues/71) [#71](https://github.com/unbrowse-ai/unbrowse-dev/issues/71)

### Bug Fixes

* catch 'setPassword is not a function' keytar errors and fall back to encrypted file vault ([71a53af](https://github.com/unbrowse-ai/unbrowse-dev/commit/71a53af4ff20e01e570cd7b51e3c2c21a63497e4))
* stale route cache + domain cache persistence ([55bc5a4](https://github.com/unbrowse-ai/unbrowse-dev/commit/55bc5a4a272972b20e24446ad3e2c8e5b860c59a))

## [1.1.5](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.1...v2.12.3) (2026-03-11)

### Features

* add full-pipeline retrieval tests to eval harness ([6405d83](https://github.com/unbrowse-ai/unbrowse-dev/commit/6405d83cda446a98be77c1259fee1c99f1657142))
* add pre-commit perf eval harness + 10x faster skill execution ([bcf30bb](https://github.com/unbrowse-ai/unbrowse-dev/commit/bcf30bb18b9ea68d575610a67224cf31e3000acf))
* append leftover params as query string on GET requests ([6ad6b42](https://github.com/unbrowse-ai/unbrowse-dev/commit/6ad6b425451a7623374c0a8d2209fcd108f8c56e))
* browser cookies, agent-first selection, URN params, discovery cost (no KV migration) ([#27](https://github.com/unbrowse-ai/unbrowse-dev/issues/27)) ([4c945f7](https://github.com/unbrowse-ai/unbrowse-dev/commit/4c945f7d420b4dc7674aee38b65e4251c58394f8))
* expand eval suite to 6 endpoints across 3 code paths ([fec1b4a](https://github.com/unbrowse-ai/unbrowse-dev/commit/fec1b4a8f6f4f0645284d2226bbff45676423a7a))
* expand eval suite to 9 endpoints across 5 domains ([59b2171](https://github.com/unbrowse-ai/unbrowse-dev/commit/59b217163497b928a601c51cdbddef8b6af35a5f))
* release pipeline + auto-suggest extraction ([#41](https://github.com/unbrowse-ai/unbrowse-dev/issues/41)) ([2b17422](https://github.com/unbrowse-ai/unbrowse-dev/commit/2b17422bb2554f4cf7f742cc01a3630752de11c0))
* replace Cloudflare KV with EmergentDB qdkv ([#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)) ([48cd8f2](https://github.com/unbrowse-ai/unbrowse-dev/commit/48cd8f2daaf1f07b9ce24a734103ad891b003160))
* require ToS acceptance for agent signup, block unauthenticated access ([cd4bb4e](https://github.com/unbrowse-ai/unbrowse-dev/commit/cd4bb4ef686a23034e0e97c4f91864f651ff4ba2))
* surface auth_recommended hint when capture returns no data endpoints ([3d72726](https://github.com/unbrowse-ai/unbrowse-dev/commit/3d72726a701f0d7cb9b818b497c869a1ebe599e9))
* tighten agent evals and public replay resolution ([#50](https://github.com/unbrowse-ai/unbrowse-dev/issues/50)) ([5dabe10](https://github.com/unbrowse-ai/unbrowse-dev/commit/5dabe1096c7e1e1abd346b606acd2a9a9e83a681))
* zero-config setup with agent-mediated ToS consent ([#6](https://github.com/unbrowse-ai/unbrowse-dev/issues/6)) ([62fb5fd](https://github.com/unbrowse-ai/unbrowse-dev/commit/62fb5fd07064488738a53285c764ddf3fcef77ec))

### Bug Fixes

* 2-step endpoint selection + 14x faster execution ([0fa6f98](https://github.com/unbrowse-ai/unbrowse-dev/commit/0fa6f980d8d3eea9a8d595690908dfc8a5e17154))
* 3 eval data quality issues found by harness ([b382709](https://github.com/unbrowse-ai/unbrowse-dev/commit/b382709e7bf995729e8de4d2cd212ee60c815c8c))
* add apex domain route for unbrowse.ai ([#32](https://github.com/unbrowse-ai/unbrowse-dev/issues/32)) ([373f95b](https://github.com/unbrowse-ai/unbrowse-dev/commit/373f95b22a5b1ea2c433114d6ed6ff7eab3ca8c3))
* always send auth header when API key exists ([#8](https://github.com/unbrowse-ai/unbrowse-dev/issues/8)) ([4700858](https://github.com/unbrowse-ai/unbrowse-dev/commit/47008589f41211b891b54febbdb800a521a7157c))
* auto-install browser engine + auto-recover stale 404 endpoints ([4323ce9](https://github.com/unbrowse-ai/unbrowse-dev/commit/4323ce9e151ea2b0bd6dd1662eaba44a3f67fc43))
* BUG-001 too many subrequests + BUG-002 intent/resolve parse error ([6d9b4f6](https://github.com/unbrowse-ai/unbrowse-dev/commit/6d9b4f6d4f9d36754d06049890c4181e87a3a047))
* **BUG-006:** parameterize dynamic path segments instead of hardcoding ([#20](https://github.com/unbrowse-ai/unbrowse-dev/issues/20)) ([f93684a](https://github.com/unbrowse-ai/unbrowse-dev/commit/f93684a16ba5e3fd5741b981c1e242784e1d93d0))
* bun/CF Brotli hang + sync working tree ([#42](https://github.com/unbrowse-ai/unbrowse-dev/issues/42)) ([88897cc](https://github.com/unbrowse-ai/unbrowse-dev/commit/88897cc47381f6e6b19612cde4c1898f3e31ec8d))
* cache skills locally before remote publish to prevent post-resolve 404s ([4f7d4ad](https://github.com/unbrowse-ai/unbrowse-dev/commit/4f7d4ad828095527aa52658a0a05c090d9926d43)), closes [#34](https://github.com/unbrowse-ai/unbrowse-dev/issues/34)
* eliminate read-after-write race in skill publishing ([#10](https://github.com/unbrowse-ai/unbrowse-dev/issues/10)) ([1c7054e](https://github.com/unbrowse-ai/unbrowse-dev/commit/1c7054ee4e3b7d950fc10c2be894653282da53e5)), closes [#9](https://github.com/unbrowse-ai/unbrowse-dev/issues/9)
* graceful browser shutdown + orphan cleanup (fixes [#4](https://github.com/unbrowse-ai/unbrowse-dev/issues/4)) ([#28](https://github.com/unbrowse-ai/unbrowse-dev/issues/28)) ([59013ed](https://github.com/unbrowse-ai/unbrowse-dev/commit/59013edfc8e02e403251e947e00518c86e28209c))
* guard against empty/malformed index values ([e99c7b6](https://github.com/unbrowse-ai/unbrowse-dev/commit/e99c7b68e99e897373ea15dd3551688d7c216d16))
* harden search pipeline — error handling, batched reindex, await indexing ([#7](https://github.com/unbrowse-ai/unbrowse-dev/issues/7)) ([cd4d09d](https://github.com/unbrowse-ai/unbrowse-dev/commit/cd4d09dd587c38ec50d9d6d060d08cee5ca97049))
* improve endpoint ranking with noise filtering and data-relevance scoring ([#17](https://github.com/unbrowse-ai/unbrowse-dev/issues/17)) ([7c38f8f](https://github.com/unbrowse-ai/unbrowse-dev/commit/7c38f8fd87e07656e2e102f37207626f239c9af2))
* **issue-15:** wrong endpoint, broken params, repeated captures ([#19](https://github.com/unbrowse-ai/unbrowse-dev/issues/19)) ([c7d13d0](https://github.com/unbrowse-ai/unbrowse-dev/commit/c7d13d0a0b8a67fb152d029063393cf1586b8bf7)), closes [#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)
* KV _idx exceeds EmergentDB size limit — store keys only ([15daacb](https://github.com/unbrowse-ai/unbrowse-dev/commit/15daacb2823662b4ae3010aafe5461fd70ef5388))
* make frontend mobile responsive ([#31](https://github.com/unbrowse-ai/unbrowse-dev/issues/31)) ([0e031f9](https://github.com/unbrowse-ai/unbrowse-dev/commit/0e031f92952ec661c1cde116e46f763e1e7b5a46))
* marketplace recall, BM25 ranking, route cache, perf telemetry ([#18](https://github.com/unbrowse-ai/unbrowse-dev/issues/18)) ([152715c](https://github.com/unbrowse-ai/unbrowse-dev/commit/152715ce1d92ad3c9b6ee3d0c23d51cf1e1994bf))
* migrate old string[] index format to {k,v}[] on first read ([37b8f91](https://github.com/unbrowse-ai/unbrowse-dev/commit/37b8f9130a6b386dcb1186a50804f2183f1076a4))
* missing closing brace and duplicate return in skills route ([#21](https://github.com/unbrowse-ai/unbrowse-dev/issues/21)) ([3744068](https://github.com/unbrowse-ai/unbrowse-dev/commit/3744068cfd0701be995a7ad96a338fcb35a136bf))
* prevent garbage DOM extractions from polluting marketplace ([df0545a](https://github.com/unbrowse-ai/unbrowse-dev/commit/df0545a5bf21497051657783460163ccc6b4a1ae))
* query params execution, intent threading, publish race, kv cache ([#16](https://github.com/unbrowse-ai/unbrowse-dev/issues/16)) ([8ed7026](https://github.com/unbrowse-ai/unbrowse-dev/commit/8ed70262beffaa42f34dd4ed2f2a07ca0b4dba89))
* remove duplicate function bodies from squash merge artifact ([37cfffc](https://github.com/unbrowse-ai/unbrowse-dev/commit/37cfffc2a7611b147a45b40224910f0f16a75ebb)), closes [#1](https://github.com/unbrowse-ai/unbrowse-dev/issues/1)
* remove duplicate old kvFallbackSearch body (squash artifact) ([ac24ceb](https://github.com/unbrowse-ai/unbrowse-dev/commit/ac24ceb062b2e72bf6c738cbdc1e6533f9b25845))
* repair search index — filter null metadata, log index failures, add reindex endpoint ([04aeef2](https://github.com/unbrowse-ai/unbrowse-dev/commit/04aeef2762c4e67a939aed6ff58e9ac7208062df))
* replace broken SKILLS_KV fallback search with qdkv cache ([dfc4ff0](https://github.com/unbrowse-ai/unbrowse-dev/commit/dfc4ff0475a7199eebb35ed6210c26f4b1e42635))
* resolve URN references when inline fields are null ([#62](https://github.com/unbrowse-ai/unbrowse-dev/issues/62)) ([3500164](https://github.com/unbrowse-ai/unbrowse-dev/commit/3500164ac804b3783350b49b57da5cafede6860e))
* restore vector namespace to unbrowse--global ([07e38a9](https://github.com/unbrowse-ai/unbrowse-dev/commit/07e38a9a9b5f778b7e036c1a051710fcea983992))
* restore vector search namespace, remove kv fallback ([#3](https://github.com/unbrowse-ai/unbrowse-dev/issues/3)) ([15cb8a3](https://github.com/unbrowse-ai/unbrowse-dev/commit/15cb8a3fd01fcb6357c6767ce704f4f3e8b79d32))
* search 20x faster, auth reliability, CI tests ([#36](https://github.com/unbrowse-ai/unbrowse-dev/issues/36)) ([02a47f5](https://github.com/unbrowse-ai/unbrowse-dev/commit/02a47f5ddfa10b7ed5a6c71a2607b2fc3e81c31b))
* sec-ch-ua headless leak + token savings baseline ([#29](https://github.com/unbrowse-ai/unbrowse-dev/issues/29)) ([6ae0f76](https://github.com/unbrowse-ai/unbrowse-dev/commit/6ae0f7617a81f948ca417b3a3bdf93c1b3d64f87))
* shell injection in sqliteQuery + sanitize auth_hint endpoint leak ([8bea854](https://github.com/unbrowse-ai/unbrowse-dev/commit/8bea8544c07023ddef2f128834a5211e96ff0405))
* store KV index values inline to eliminate subrequest explosion ([#22](https://github.com/unbrowse-ai/unbrowse-dev/issues/22)) ([85607f6](https://github.com/unbrowse-ai/unbrowse-dev/commit/85607f6d0da3496182bd3b961bb5a0305dc1b68b))

### Performance

* add per-query result cache for search via qdkv ([219cd46](https://github.com/unbrowse-ai/unbrowse-dev/commit/219cd46843d3847a91cf93194e88061d32663576))
* combine 3 ops requests into single /v1/ops endpoint ([485beca](https://github.com/unbrowse-ai/unbrowse-dev/commit/485beca10f13c8a13563d4b8882726907b94b5b4))
* eliminate N+1 EmergentDB fetches with listWithValues + index cache ([#2](https://github.com/unbrowse-ai/unbrowse-dev/issues/2)) ([0585512](https://github.com/unbrowse-ai/unbrowse-dev/commit/0585512ed837dc55d1f7995b86461334f5bd3adb))
* fetch-first for all safe GETs including DOM + cookie support ([ec7bfab](https://github.com/unbrowse-ai/unbrowse-dev/commit/ec7bfabdc9e900a99a21d50a8e0f7187548aaf1e))
* parallelize kv.put writes and fire-and-forget indexSkill on publish ([7aad29a](https://github.com/unbrowse-ai/unbrowse-dev/commit/7aad29a064794827df1ce2ca5d7110ed392911d5))
* replace EmergentDB-backed rate limiter with in-memory store ([062b14d](https://github.com/unbrowse-ai/unbrowse-dev/commit/062b14d05fd74453aeb86968c9fe91f4b8d04497))

### Refactoring

* replace brittle assertions with data snapshots for LLM review ([269ae4f](https://github.com/unbrowse-ai/unbrowse-dev/commit/269ae4ff5ac6a04a639d540d95218f7f8af839f4))

## [2.12.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.0...v2.12.1) (2026-04-03)

### Features

* detect install-specific upgrade and repair commands during setup so global npm installs get the right guidance
* smoke-test the packaged global CLI in CI and tag releases before publish

### Bug Fixes

* **ci/deploy**: let `staging` pushes run the repo sanity/unit/backend/CLI gates, deploy the backend to the Wrangler `staging` environment, and only deploy the `frontend-staging` worker when `PREVIEW_API_URL` is configured so integration testing does not accidentally point at the wrong backend
* harden the npm wrapper so stale fallback installs fail with a precise reinstall command instead of silent runtime crashes
* return the installed version from `unbrowse --version`
* repair packaged wrapper execute bits during postinstall and fail fast on stale local-server version mismatches


## [2.12.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.11.0...v2.12.0) (2026-04-03)

### Bug Fixes

* auto-queue browse submit publish and document public repo ([9905005](https://github.com/unbrowse-ai/unbrowse-dev/commit/9905005afa86402ac75d521381e6ca2eec1ab184))
* preserve backend kv binding during CI release deploys ([#282](https://github.com/unbrowse-ai/unbrowse-dev/issues/282)) ([47e0c72](https://github.com/unbrowse-ai/unbrowse-dev/commit/47e0c7223a24f68e84f8ebec4b4892acb635f217))
* restore skills.sh discovery gate ([#285](https://github.com/unbrowse-ai/unbrowse-dev/issues/285)) ([e5299f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/e5299f480ec2b19ca85981f6706d0edf155aaed2))
* ship standalone repo setup and main-base docs ([#281](https://github.com/unbrowse-ai/unbrowse-dev/issues/281)) ([2c66398](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c663989fd7b31aa3a87b5fed29b71c22c088f8e))
* simplify install setup path ([#294](https://github.com/unbrowse-ai/unbrowse-dev/issues/294)) ([98d97d3](https://github.com/unbrowse-ai/unbrowse-dev/commit/98d97d30beaa737511f02926e5c43f3f648600b5))
* simplify install setup path ([#295](https://github.com/unbrowse-ai/unbrowse-dev/issues/295)) ([a4c7fa9](https://github.com/unbrowse-ai/unbrowse-dev/commit/a4c7fa94d90a412042eda4184fd66c83705aa676))

## Unreleased

### Features

- add tracked `docs/agent-memory.md` and require agents to read/write durable Lewis preferences there
* **docs/skill**: rewrite the public `SKILL.md` around the real Kuri-first model, including browser-native traversal rules, Kuri-to-Unbrowse command mapping, publish-time contract compilation, and a direct-Kuri debug escape hatch for session drift
* **docs/mcp**: document dependency-walk rules for JS-heavy multi-step sites so future agents treat successful browse submits as the prerequisite edge for downstream pages instead of guessing deep links
* **workflow/publish**: export sanitized workflow assets beside raw workflow artifacts so mined routes now persist as publishable, documented, token-censored inventory with `captured`/`published` status
* add a real `unbrowse mcp` stdio server with `initialize`, `tools/list`, `tools/call`, and core Unbrowse resolve/execute/browse tools
* add a deterministic `./setup --host mcp` bootstrap that writes a ready MCP config file, plus a frontend MCP install option and downloadable `/mcp.json` template
* **install**: switch the curl installer and npm postinstall flow to Kuri-style platform detection + GitHub release tarballs, while keeping `unbrowse setup` as the first-run bootstrap
* **install**: after successful curl-installer setup, best-effort call `npx skills add unbrowse-ai/unbrowse --yes` when `npx` is available so skills.sh registry counters still increment without making install success depend on Node
* **install**: detect piped/headless installer runs, pass `--non-interactive --skip-wallet-setup` automatically, thread through `UNBROWSE_TOS_ACCEPTED` / `UNBROWSE_AGENT_EMAIL`, and skip first-run setup cleanly when ToS consent was not preseeded
* **setup/upgrade**: add `unbrowse upgrade`, persist install metadata so clone installs get the right upgrade command, and register GSD-style session-start update hints for Codex and Claude during setup
* **backend/github**: add a real GitHub webhook receiver for opt-in PR maintenance, with `X-Hub-Signature-256` verification, branch update/auto-merge actions, conflict comments, and 6-hour Telegram digests from the backend worker cron
* **backend/github**: add a real GitHub webhook receiver for opt-in PR agent runs, with `X-Hub-Signature-256` verification, workflow dispatch on PR/check-suite events, a self-hosted `pr-agent.yml` Codex repair runner, and 6-hour Telegram digesting for failed dispatches
* add root `glama.json` metadata so Glama can discover and attribute the Unbrowse MCP server to `@lekt9`
* add a root `smithery.yaml` registry manifest so Smithery can classify and install Unbrowse as a stdio MCP server
* **ci/frontend**: add GitHub Actions PR previews for the Cloudflare/OpenNext frontend with stable `pr-<number>` preview aliases, sticky PR comments, and staging-API wiring via `PREVIEW_API_URL`
* **skills**: add a history-skill miner that reads local Codex chat archives, generates first-principles workflow skills, and keeps `AGENTS.md` synced with the emitted skill inventory
* **skills**: add a Cloudflare-relayed `p2p-skill-share` flow that exports the mined skill bundle, writes a fetch manifest, and serves it over quick or named tunnel modes
* **cli/analytics**: surface machine-readable per-run impact (`time_saved`, `tokens_saved`, `browser_avoided`) plus likely next actions in resolve/execute responses, and persist richer session telemetry so the canonical funnel can reason over success and savings instead of only coarse counters
* **routing telemetry**: add a sanitized `POST /v1/telemetry/routing` ingest path, shared routing event types, orchestrator-side session/step/candidate/outcome emission, and a derived `/v1/analytics/routing` summary for future long-running agent router training
* **routing analytics**: enrich `/v1/analytics/routing` with source-level speed/success stats plus top intents/domains so we can see what agents use most and which routing paths are actually fastest
* **frontend/miners**: replace the hardcoded miners bounty board and weekly quests with demand-driven backend data aggregated from recent CLI search/resolve telemetry, so the board now tracks what agents are actually asking for
* **setup/wallets**: encourage Crossmint `lobster.cash` during new-install bootstrap, surface it in setup status/docs, and point walletless installs at `npx @crossmint/lobster-cli setup`
* **growth/landing**: add sticky SSR homepage experiments, landing-token install attribution, variant-level landing funnel analytics, an ops landing-funnel panel, and a daily optimizer workflow that rebalances live weights while only generating shadow variants inside approved messaging slots
* **frontend/funnel**: re-center the homepage on first success after install with a copyable verification + resolve path, and extend acquisition analytics to measure install-copy to first-task-copy conversion
* **landing/api**: add a landing-copy variant API with publish/list/resolve/summary routes, plus a `landing:publish` helper script, so homepage copy can be updated over API and measured by ICP/variant instead of staying hardcoded
* **analytics/acquisition**: add section-depth checkpoints and ICP-path click tracking on the homepage, plus filtered acquisition summaries by `variant_id` / `icp` / `experiment_id` so landing copy resonance can be compared before tightening the funnel
* **skills/acquisition**: add a repo-local `unbrowse-acquisition-operator` skill that owns the `traffic -> ICP -> variant -> activation` loop, routes to existing funnel/positioning/ads/measurement skills, and keeps X research/ads scoped under one measurable acquisition experiment
* **frontend/acquisition**: persist first-touch UTM/click-id context plus sticky landing assignment cookies, resolve homepage variants from those signals server-side, and expose acquisition-dimension rollups in analytics so landing winners can be compared by source/campaign/term instead of only raw referrer
* **analytics/campaign-feedback**: carry attribution from landing copy into copied install commands, persist it through CLI install/funnel/session telemetry, track content-page views, and add `/v1/analytics/campaigns` so X posts, articles, ads, landing variants, installs, and first-success can be compared in one loop
* **skills/foundry**: add a repo-local `x-campaign-feedback-operator` skill plus a Foundry preset and fabricated bundle artifacts so the X/articles/ads/landing feedback loop can be installed, routed, and shared as one operator bundle
* **skills/foundry**: add a repo-local `unbrowse-funnel-command-center` skill plus a Foundry preset and fabricated bundle artifacts so the full funnel can route from traffic and landing leaks through activation, retention, monetization, and referral under one operator entrypoint
* **visualizers/merjs**: add a standalone `visualizers/funnel-merjs` app plus a local `/api/snapshot` proxy, session-backed `POST /api/viz` -> `/viz?id=...` flow for arbitrary analytics payloads, and a native desktop wrapper that can target any route or open a transparent always-on-top `--overlay <session-id>` view instead of relying on a plain browser tab
* **visualizers/json-render**: expand the merjs `/json-render` route into an arbitrary-data visualization lab with file import, shareable hash-state URLs, and prompt-driven spec generation, so funnel snapshots or any other analytics JSON can be explored inside the same merjs shell and desktop wrapper

### Tests

* add MCP stdio smoke coverage for initialize, tool listing, and health tool calls
* add routing telemetry sanitizer, idempotent backend ingest, and routing analytics regression coverage
* add a real CLI-to-backend routing telemetry E2E that runs the live orchestrator path, verifies sanitized `routing-event:*` writes, and asserts `/v1/analytics/routing` updates from the emitted session
* add live landing-funnel end-to-end coverage for signed token attribution, CLI telemetry propagation, analytics rollup, and daily optimizer reweighting

### Bug Fixes

- **release**: disable local `release-it` npm handling again so `@release-it/bumper` can own version bumps while the tag-triggered workflow owns the actual npm publish
- **frontend/build**: cap homepage and blog API fetches with fast server-side timeouts so Cloudflare/Next static builds fall back instead of hanging until the export worker kills `/` and `/blog`
- **release**: install `gh` inside self-hosted release jobs so asset uploads and skill-repo GitHub releases no longer fail after npm publish/deploy succeed
* **browse/kuri**: disable ambient CDP attach during explicit clean-room runs like `UNBROWSE_IMPORT_BROWSER_COOKIES=0` or local-only staging loops, so packaged and staging Mandai repros use isolated managed Chrome instead of crashing on stray local browser sessions
* **browse/sessions**: stop strict browse sessions from dying after successful submits or transient post-navigation CDP churn by retrying liveness checks, only expiring sessions when the tab is truly gone, and surfacing recoverable follow-up browser errors as retryable failures instead of fake `session_expired` drops
* **browse/sessions**: rebind successful submit flows onto replacement tabs that already reached the hinted next-step pathname, so packaged staging runs keep the same session alive when Mandai swaps the underlying browser target between steps
* **browse/submit**: resolve filename-style wait hints like `/tickets-selection.html` and `/add-ons-selection.html` relative to the current ticketing workflow directory instead of the site root, so packaged Mandai submit recovery keeps the session pinned to the real next step
* **browse/submit**: compile hidden page prerequisites before clicking submit by filling Mandai-style hidden date fields, refusing visually disabled next-step buttons, and returning structured `prereq_state_incomplete` metadata instead of blindly falling through to same-origin submit fallback
* **browse/kuri**: keep large `/evaluate` expressions in the request query string even on POST, matching the shipped Kuri broker contract so long submit scripts stop failing live with `Missing expression parameter`
* **browse/kuri**: encode `+` in Kuri eval query strings and disable ambient CDP attach during explicit clean-room runs, so staging Mandai repros stop corrupting compiled browser scripts or latching onto stray local Chrome state
* **browse/session**: rank same-path real tabs above exact `about:blank` placeholders during liveness checks while still treating freshly created owned blank tabs as live before first navigation
* **browse/submit**: add Mandai-specific park, resident-ticket, date, and add-on submit compilers that patch hidden prerequisite state, detect document-level NEXT buttons outside the form, and fall back to native form submit when Mandai keeps a valid step visually disabled
* **browse/kuri**: when a managed Kuri broker dies after submit but its headless Chrome instance is still alive, restart Kuri onto that surviving managed CDP port instead of launching a fresh browser and orphaning the live workflow tab
* **packaged/kuri**: stop the skill pack/build path from silently shipping stale vendored Kuri binaries by failing fast on broken `submodules/kuri` checkouts, rebuilding when the vendored manifest source SHA drifts from `justrach/kuri` `adding-extensions`, stamping packaged Kuri artifacts with source/hash metadata, and wiring a dedicated baked-Kuri guard into `prepack`, root pack/publish scripts, and CI/release so stale vendor drift fails before tarball or npm publish
* **landing/packaging**: forward signed landing tokens on CLI install and funnel telemetry so homepage attribution reaches analytics, and check in the baked Kuri vendor manifest so the new packaging guard passes in CI
* **packaged/runtime**: make packaged local servers report a stable `package_version` + `code_hash` by hashing bundled `runtime-src` sources when `dist/` has no `.ts` files, stamp the pid file with the same version metadata, add an opt-out for real-browser cookie import during `browse/go`, and make browse-session recovery fail fast when the Kuri broker cannot restart instead of collapsing into opaque `fetch failed` errors, with coverage for the packaged-health contract plus duplicate-export install regression so staging-pointed CLI runs stop self-restarting into `about:blank` or inheriting stale browser carts
* **package/runtime**: remove a duplicate `recordAnalyticsSession` export so packaged local-server autostart no longer crashes under the Node/tsx runtime path, make Kuri re-probe health instead of trusting stale in-memory ready state after port `7700` dies, fall back to raw Chrome CDP tab creation when Kuri’s `/tab/new` path flakes, retry capture on fresh Kuri tabs after mid-run transport loss instead of bailing out as generic `fetch failed`, and stop browse-session handoff from reusing first-pass tabs after Kuri has already dropped them
* **browse/indexing**: stop `unbrowse submit` from queueing intermediate background publishes, coalesce later same-domain index jobs instead of dropping them, and keep final publish on `unbrowse close` so richer end-of-flow captures win
* **auth/linkedin**: restore keychain/browser-cookie fallback for explicit login flows before interactive auth, prefer live browser-cookie import before saved auth-profile restore during browse navigation, use the discovered CDP port for secure cookie injection, tighten interactive-login success detection around real auth cookies like LinkedIn `li_at`, and skip periodic cold verification for auth-gated endpoints
* **frontend/miners**: remove the fake bounty/quest game layer from the contributors page, replace it with honest demand targets, and add a coverage-globe view driven by real graph stats
* **frontend/perf**: stop homepage and search from fetching the full 30MB+ skill registry payload, add a compact cacheable skill-card list for registry surfaces, and enable sane revalidation for blog API fetches
* **frontend/cache**: move landing-copy selection off the homepage request path, serve the active growth variant from cached backend config, hard-cache popular/card registry APIs, short-TTL cache search responses in Worker edge + KV, and make `/` plus `/search` ship as static revalidated HTML instead of `no-store` server renders
* **ci/frontend**: make Cloudflare frontend CI deploys ship via direct Wrangler deploy after the OpenNext build, so `main` and release deploys no longer die on the pre-populate R2 incremental-cache upload step
* **cli/cache**: add a `cleanup-stale` sweep that re-verifies active skills, evicts stale local cache entries, and now rotates through periodic server-side batches so dead marketplace endpoints stop getting replayed
* **browse/sessions**: isolate browse state behind per-session `session_id`s, serialize same-session browse actions, require explicit session selection when multiple sessions are live, and stop first-pass/capture flows from reusing Kuri's implicit default tab under parallel load
* **browse/kuri**: add per-port Kuri broker clients, bind browse sessions to their originating broker, and spread browse-session traffic across a small local multi-broker pool so different sessions can issue tool calls in parallel without collapsing onto one singleton broker
* **kuri/tests**: stop the Kuri live e2e suite from hijacking a visible Chrome session by honoring headless launch flags and running the fixture-browser tests in headless managed mode
* **github/pr-agent**: split webhook dispatch into `repair` vs `merge` operations, ignore agent-self-failure loops, isolate runner `CODEX_HOME`, and let Codex make the merge recommendation before a final non-vibes safety gate executes the merge
* **ci/tests**: isolate CLI end-to-end runs on a per-suite local-server port and clear backend KV index caches in popularity tests so self-hosted runners stop leaking state across jobs
* **ci/backend-tests**: keep live beta-api backend smoke suites opt-in so required CI stops failing on external network and deployment flakiness
* **ci/package-cli**: run the packaged CLI smoke on a per-run port and pre-accept ToS in non-interactive mode so self-hosted runners stop talking to stale local servers
* **policy/execute**: add per-endpoint third-party-terms policy flags for sensitive domains like X, block autonomous mutation execution until callers pass explicit `confirm_third_party_terms`, and surface the policy requirement through resolve/CLI/MCP/SDK
* **legal/terms**: clarify that users bear responsibility for third-party website and API terms, disclaim liability for third-party ToS violations to the maximum extent permitted by law, expand indemnity coverage for third-party claims, and fix the company name in ToS copy
* **backend/payments**: split discovery from paid manifest access with `X402_SEARCH_ENABLED`, so `/v1/search*` can stay free while paid `/v1/skills/:id` detail remains x402-gated
* **docs/whitepaper**: sync the companion docs with the shipped x402 and Crossmint wallet flow so payment gates, wallet-linked payout routing, and current settlement behavior stop reading as “coming soon”
* **docs/mcp**: make the public README surfaces explicitly describe Unbrowse as a stdio MCP server, document `initialize` / `tools/list` / `tools/call`, enumerate the shipped MCP tool groups, and clarify that `localhost:6969` is the runtime behind the MCP surface rather than a custom host protocol
* **browse/registry**: auto-flush and queue background publish after successful `unbrowse submit` steps, return explicit next-step hints for browser-submit flows, and document `unbrowse-ai/unbrowse` as the canonical public repo for external registry submissions
* **cli/release**: make the binary-only npm installer fail fast when the matching release asset is missing, gate npm publish on a live GitHub release-asset reachability check, and fix compiled `unbrowse setup` autostart so packaged installs exit cleanly after bootstrapping the local server
* **frontend/homepage**: sharpen homepage positioning around AI agent builders, clarify the browser-automation replacement story, and reduce copy clutter across the hero, install, and registry sections
* **frontend/homepage**: add explicit ICP paths for agent builders, OpenClaw users, and MCP hosts so each buyer can pattern-match to the right value prop and install path faster
* **frontend/copy**: normalize the public role name to `contributor` across leaderboard and economics pages while keeping mining as the campaign verb
* **frontend/registry**: stop stale search-index hits from linking to dead registry skill detail pages, and label them as index-only until the live registry has a backing skill page
* **frontend/registry**: swap the homepage registry showcase from recent linked cards to list-only popular skills backed by observed execution counts
* fix packaged MCP autostart by removing a duplicate `recordAnalyticsSession` export that broke the packaged local-server bootstrap path behind the installer-generated MCP command
* **frontend/install**: simplify the landing-page install path around one clear command, reduce CTA clutter, trim install tabs, and make the copy action grab the primary command instead of the full block
* **analytics**: stop labeling cached execute paths as manual browser usage, and derive canonical funnel activation/aha/repeat from successful session telemetry
* **cli/install**: bake global-install diagnostics into the npm wrapper, add a real `unbrowse --version`, repair wrapper/launcher execute bits during postinstall, and fail loudly when a stale local server on `:6969` is serving a different package version than the installed CLI
* **linkedin/replay**: keep unrelated infrastructure path prefixes like LinkedIn `litms` literal during capture, and bypass robots gating for authenticated session-backed execution so captured private feed endpoints can replay through the user session
* **cli/install**: remove the duplicate `recordAnalyticsSession` export that broke fresh npm-installed runtime startup under Node/tsx, and cover the packaged client build path with a regression test

* **cli/package**: restore the baked-Kuri npm package layout, keep the release-asset installer plus source fallback in sync, and re-ship the packaged launcher/runtime files so local tarball installs and npm publish smoke pass again
* **frontend/staging**: remove a duplicated homepage section wrapper that broke the Next.js build, and add the missing staging `images` + `NEXT_INC_CACHE_R2_BUCKET` bindings so `frontend-staging` deploys cleanly
* **browse/session**: harden packaged Kuri tab recovery by accepting `/tab/new` ids across response shapes, falling back to reusable idle tabs when Kuri cannot create a fresh target, and preferring blank/new-tab recovery over hijacking unrelated tabs
* **browse/session**: enforce one-tab-per-session recovery by only reattaching to same-domain tabs and reusing idle tabs before opening raw CDP fallbacks, so browse sessions stop leaking or hijacking stray tabs
* **browse/session**: keep explicit read-only session recovery pinned to the original route by only reattaching dead tabs when the last known URL pathname matches, and otherwise forcing a fresh owned tab instead of silently rewinding onto another same-domain page
* **browse/session**: when the live tab swaps off-route, prefer the single meaningful same-domain replacement over a stale owned placeholder tab, close that stale blank tab after rebinding, and refresh click responses so multi-step sites like Mandai stop drifting onto `about:blank`
* **browse/submit**: stop hammering Kuri with repeated post-submit HTML probes on URL-transition steps by preferring lighter URL-only settle checks until the tab stabilizes
* **browse/submit**: make `browse submit` a thin proxy by default again, and require explicit `assist_site_state` / `--assist-site-state` opt-in before site-specific browser-state helpers run
* **browse/submit**: keep regular traversal browser-native by default, make same-origin fetch fallback explicit opt-in only, and update CLI/MCP guidance so passive API analysis no longer silently turns into live fetch replay during submit flows
* **kuri/browse**: stop reusing a “healthy” Kuri broker when its Chrome/CDP is gone; browser startup now requires a live CDP/tab path before `go` reuses an existing broker
* **workflow/publish**: compile publish-safe replay contracts from passive traversal evidence, including typed params, enums, derived auth/token hints, prerequisites, next-state validators, and usage notes for explicit replay after publish
* **mcp/workflow**: expose published workflow artifacts as read-only MCP resources (`workflow_publish://`, `workflow_contract://`, `workflow_dag://`) plus a `plan_workflow_execution` prompt so hosts can inspect dependency walks, typed restrictions, and x402/payment requirements before choosing traversal vs replay
* **capture/pipeline**: split checkpoint, local index, and remote publish semantics so `sync`/`close` queue an explicit background `index -> publish` pipeline, add local-only `index`, add local `settings` for auto-publish + blacklist/prompt-list domain policy, surface `publish_policy` / `next_step` hints in tool output, mark workflow exports as `indexed` before remote share, and align CLI/MCP/skill docs around the new capture lifecycle
* **orchestrator/publish**: enrich local endpoint descriptions and review prompts with audience, eligibility, pricing, and validity constraints so captured skills keep caveats like resident vs non-resident bundle rules before publish
* **cli/tests**: stop local server bootstrap from blocking `/health` on remote auto-registration, make API routes wait briefly for background registration instead of failing fast, isolate snapshot-heavy e2e fixtures from the user’s real `~/.unbrowse` cache, and skip wallet bootstrap in the packaged setup smoke
* preserve the production backend KV binding during CI deploys so release runs stop re-requesting KV write scope
* clean checked-in merge markers, restore the curl install script, and add a repo blog-publish helper so the stale frontend-history branch can be absorbed without dragging its generated junk forward
* **wallet/setup**: detect paired lobster.cash agents from local `~/.lobster/agents.json` state so `setup --no-start` and payout sync reuse an existing local wallet instead of re-entering interactive wallet setup
* **publish/admission**: tighten marketplace publish admission so background indexing and passive publish stop shipping stale, noisy, hash-heavy endpoint variants by default
* **backend/storage**: make Neon-backed worker KV writes transactional, clear poisoned init-cache entries after transient Neon bootstrap failures, and add regression coverage for both paths
* split `main` deploys from tag releases so ordinary `main` pushes stop surfacing a no-op npm publish path when the current CLI version is already on npm
* simplify the homepage install story around `curl -fsSL https://unbrowse.ai/install.sh | bash`, add `npx skills add unbrowse-ai/unbrowse` as the skills-host shortcut, and demote repo-clone setup to fallback copy
* **cli/browser-capture**: preserve top-level resolve errors in slim CLI output, return structured browser-capture failures instead of raw 500s, and isolate CLI E2E runs onto their own local server so live auth paths stop binding to stale ambient state
* **cli/auth**: surface blocked auth-gated captures as structured auth prompts instead of opaque empty resolve output, stabilize the X CLI auth smoke on a real search URL, and restore clean backend typecheck on the miner-demand board

## [2.11.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.2...v2.11.0) (2026-04-02)

### Features

* **#100:** implement robots.txt directive checking before route execution ([d920e7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/d920e7e87058a3ea645e24b0f4441b44d8442867)), closes [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100) [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100)

### Bug Fixes

* harden browse submit recovery ([652f03b](https://github.com/unbrowse-ai/unbrowse-dev/commit/652f03b8146744fbfac4f0e70faee3798754db71))
* harden main release workflow reruns ([f80cd5d](https://github.com/unbrowse-ai/unbrowse-dev/commit/f80cd5d3a5ada81fa285ca59e302c26aa47bb02d))
* publish runtime deps in npm package ([9659770](https://github.com/unbrowse-ai/unbrowse-dev/commit/96597707c161a2de9f1424bbb622e0be203e7fbf))
* seed canonical replay after x402 detail search ([6524063](https://github.com/unbrowse-ai/unbrowse-dev/commit/6524063b3ee9f77f7fb8a1e187291bb7ec72066b))

## [2.10.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.1...v2.10.2) (2026-04-02)

### Bug Fixes

* unblock worker deployment ([ef8a5ba](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef8a5badb2868c20fde988ebb98b123201e8da36))

## [2.10.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.0...v2.10.1) (2026-04-02)

### Bug Fixes

* unblock self-hosted releases ([5dd2139](https://github.com/unbrowse-ai/unbrowse-dev/commit/5dd2139f49068cb2eb24a15489833b7a4c187638))

## [2.10.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.9.1...v2.10.0) (2026-04-02)

### Features

* publish openclaw npm install flow ([ab1257f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab1257f1ff2c180d7bb07a390a7270555ffe896e))
* publish openclaw npm install flow ([#260](https://github.com/unbrowse-ai/unbrowse-dev/issues/260)) ([2e6a252](https://github.com/unbrowse-ai/unbrowse-dev/commit/2e6a2520393a5f2bf9e0ed5e9a5e1c34b14973a8))
* restore canonical analytics surface ([#262](https://github.com/unbrowse-ai/unbrowse-dev/issues/262)) ([78f83c8](https://github.com/unbrowse-ai/unbrowse-dev/commit/78f83c827b3d9292da16b5eaebf98cc6b63b8b2d))
* ship wallet-first dashboard on restart-base ([#265](https://github.com/unbrowse-ai/unbrowse-dev/issues/265)) ([a673969](https://github.com/unbrowse-ai/unbrowse-dev/commit/a67396913f90b87acf705e60b9042c94cfe34610))
* track analytics sessions by trace version ([5954238](https://github.com/unbrowse-ai/unbrowse-dev/commit/595423886b426a3032fb683e83b4e4bd102d3931))

### Bug Fixes

* ship worker payments and lobster x402 e2e ([#263](https://github.com/unbrowse-ai/unbrowse-dev/issues/263)) ([d3ec78f](https://github.com/unbrowse-ai/unbrowse-dev/commit/d3ec78fa049378bb9066f55f707ed608dc560daf))
* unblock openclaw install PR ([422096b](https://github.com/unbrowse-ai/unbrowse-dev/commit/422096b734ebd926a136286a221be2c4a0be71c2))

## [Unreleased]

### Bug Fixes

* telemetry/dashboard: derive per-run baseline vs actual speed/cost from real or fallback orchestrator economics, surface those totals on contributor dashboards, and cover the math with savings sims plus dashboard contract tests

### Features

* **sdk**: add a first-party `@unbrowse/sdk` TypeScript client for the canonical local server routes, with typed `resolve`/`execute`/auth helpers, SDK tests, and first-party API/quickstart docs instead of forcing app developers through raw fetch or CLI wrappers
* **analytics**: restore the canonical investor analytics surface (`growth`, `usage`, `funnel`, `network`, `economics`, `dashboard`), add explicit `POST /v1/analytics/sessions` runtime ingestion, split the legacy setup funnel onto `/v1/analytics/install-funnel`, make the canonical funnel monotonic with recovered profiles excluded and surfaced separately, and unbreak manual execute auth warmup so end-to-end session ingestion actually reaches the analytics backend
* **backend/storage**: add Neon-backed canonical state storage for the Worker via a Postgres-backed KV adapter, ship a Cloudflare-KV-to-Neon backfill script, and wire `DATABASE_URL` as the production worker secret so agent profiles, skills, ledgers, and analytics state can cut over from EmergentDB/legacy KV drift to Neon
* **frontend/economics**: switch the web dashboard to wallet-first public lookup on `rach/restart-base`, with public `/dashboard` wallet search, public `/dashboard/:wallet` contributor ledgers, wallet-linked leaderboard rows, and backend wallet lookup routing
* **frontend/blog**: canonicalize legacy article slugs back to their static routes, dedupe those slugs from the `/blog` feed and sitemap, and add FAQ schema/content for the proof-of-indexing economics page
* **orchestrator/economics**: centralize timing economics math, persist baseline vs actual time/cost totals through telemetry, and surface browser-baseline plus speedup metrics in the public contributor dashboard
* **cli/auth**: retry `resolve` through browser-cookie import before forcing interactive login, detect blocked interactive login states more explicitly, and auto-fall back from paid marketplace search to free exact-URL live capture when indexing fallback is available
* **resolve**: enrich `available_endpoints` with depth-limited `schema_summary` (3-level recursive tree), `input_params` (key/type/required/example), `description_in`, and `example_fields` — agents can now pick endpoints and build extraction paths from the resolve response alone without needing separate schema calls
* **cli**: implement `--path`, `--extract`, `--limit`, `--schema` post-processing in `execute` — flags were documented but never wired; now support nested array drilling (`data.items[].nested[].field`), field aliasing (`alias:deep.path`), null-row filtering, and item limiting
* **cli**: auto-wrap large responses (>2KB) with `extraction_hints` including schema tree and byte count when no extraction flags are given

### Bug Fixes

* **packaging/release**: pin Kuri submodule validation to `justrach/kuri#adding-extensions`, build and upload `dist/unbrowse-*` GitHub release assets in CI/CD, smoke-test the compiled single-binary packaging path, and select the embedded Kuri payload by runtime target instead of hardcoding `darwin-arm64`
* **skills/install**: quote all `SKILL.md` descriptions as valid YAML block scalars so `npx skills add unbrowse-ai/unbrowse` discovers the published Unbrowse skill again instead of bailing out with "No valid skills found", and add a dedicated CI/release gate that runs `tests/skill-docs-sync.test.ts` before packaging/publish
* **github/docs**: update PR helpers and validation docs to treat `main` as the canonical base branch after the branch rename, so release/merge instructions stop pointing at the dead `rach/restart-base` branch
* **analytics/security**: stop advertising authenticated analytics responses as publicly cacheable, add `Vary: Authorization`, remove user-facing analytics docs links, and pin the private header contract in end-to-end coverage
* **install**: add a deterministic repo-native `./setup` bootstrap, switch the npm wrapper fallback to the stable Node launcher, and keep the standalone CLI package manifest pinned to the runtime payment deps (`bs58`, `@solana/kit`, `@cascade-fyi/splits-sdk`) so the public install path no longer depends on a healthy GitHub release asset plus a lucky npm fallback
* **payments/wallets**: treat the configured wallet address as the single contributor/payment truth across setup, agent wallet sync, 402 error payloads, and transaction proof wiring, including generic agent-wallet providers instead of hardcoding lobster-only labels
* **skills**: add a repo-local `internal-analytics` skill with a deterministic fetch helper so agents can pull private analytics without treating the surface as public docs
## fix: mirror Claude skills into Codex installs

- `scripts/sync-skill.sh` now routes local skill linking through a shared helper so the active Claude/Codex `unbrowse` links resolve to the current monorepo checkout instead of drifting to stale worktrees or copied skill dirs.
- New `scripts/sync-skill-links.ts` also mirrors Claude skill directories into `~/.codex/skills` without overwriting Codex-specific entries, so the same global skill set is available in both hosts.

* **cli**: add `unbrowse review` command — agents can push reviewed descriptions, action/resource kinds, and examples back to endpoint metadata via `POST /v1/skills/:id/review`
* **cli**: add `unbrowse publish` command — two-phase agent-driven publish: Phase 1 returns endpoints with `schema_summary`, `sample_values`, `input_params` and `_fill_description` placeholder; Phase 2 merges agent descriptions, updates local caches, and publishes to marketplace
* **skill/worktree**: add a repo-local worktree capability loop plus `issue:worktree:*` / `capability:worktree:*` helpers so an agent can fix GitHub issues or capability asks, mine public URLs from those asks into temporary eval cases, rerun the repo's regression loop, and always run a Codex cold/warm regression suite for phase 0 browse plus phase 1 replay
* **skill/worktree**: add a read-first Codex harness doc for the worktree capability loop so the primary contract is instructions the agent performs manually, with helper scripts kept as optional convenience only
* **skill/worktree**: make the worktree harness subagent-first for product proof, so real case judgment and cold/warm benchmark evidence outrank Vitest-style repo tests when deciding whether a capability actually works
* **eval**: add `/unbrowse-eval` skill and `eval:agent` script — agent-driven end-to-end site testing (browse → index → resolve → execute → verify) with growing case set
* **frontend/economics**: add explicit `/login`, `/dashboard`, and `/leaderboard` surfaces for agent-key auth, economics visibility, and public contribution ranking
* add investor-facing analytics coverage: `/v1/analytics/growth`, `/v1/analytics/usage`, `/v1/analytics/network`, `/v1/analytics/economics`, plus session/adoption/pricing ingestion so cohort retention, new-user growth, skill reuse, external adoption, and path-to-$100k math are API-trackable
### Bug Fixes

* **openclaw/plugin**: resolve the bundled Unbrowse CLI from the installed package `bin` entry instead of guessing `bin/unbrowse.js`, bump the plugin dependency to `unbrowse@^2.10.2`, and add execution-path regression coverage so the OpenClaw plugin can actually launch the packaged runtime again
* **openclaw/plugin**: add tarball-level packaging coverage for `unbrowse-openclaw` so published npm releases keep the installer `bin/` + `scripts/` entrypoints and the README `npx unbrowse-openclaw install --restart` flow stays real
* **openclaw/plugin**: switch the installer off `openclaw plugins install` and onto a managed extension-dir write plus `plugins.load.paths` rewrite, so current OpenClaw builds stop blocking the plugin's legitimate `child_process` usage during npm/npx installs
* **ci/release**: fix main-branch release metadata parsing so npm package name/version resolve correctly in GitHub Actions, fail fast if those outputs are empty, and treat duplicate-version npm publishes as idempotent no-ops instead of blocking deploy + skill sync
* **tests/graph-api**: bound live graph API requests with explicit fetch timeouts, remove the extra retry fallthrough, and make fixture publishing best-effort so the backend integration suite stops timing out in `beforeAll` during CI reruns
* **tests/search-live**: treat fast `429 Rate limit exceeded` replies as acceptable bounded outcomes in the live search perf/composite smoke tests, so shared CI load no longer fails the backend suite when beta search is responsive but throttled
* **telemetry/funnel**: wire the landing-page acquisition tracker into the homepage, track install-command copy events, and emit real CLI install/funnel telemetry (`cli-first-seen`, `cli_invoked`, `setup_completed`, `registration_succeeded`, `resolve_started`, `resolve_completed`) from the canonical setup/resolve/execute paths so install and activation analytics stop reading as zero
* **docs/frontend**: ground quickstart/API/deployment docs against the current repo and point public docs links at `docs.unbrowse.ai`
* **ci/backend**: force Wrangler v3 backend deploys with KV bindings onto the legacy worker upload path so canonical release jobs stop failing on Cloudflare `/versions` permission checks
* **frontend/openclaw**: clarify the public OpenClaw install flow around `npx unbrowse-openclaw install --restart`, note that the plugin package pulls in the local Unbrowse runtime automatically, and call out the one-time trust prompt older OpenClaw builds may show
* **github/default-branch**: rename `rach/restart-base` to `main`, make `main` the repo default branch, and retarget PR/release docs plus helper scripts
* **frontend/blog**: keep legacy article slugs canonical by redirecting `/blog/<slug>` to the live static article route, dedupe legacy-vs-dynamic blog listings, and emit legacy article URLs into `sitemap.xml` so published pages are actually discoverable by crawlers
* **auth/replay**: persist LinkedIn replay-critical headers (`accept`, `csrf-token`, `x-li-*`, `x-restli-protocol-version`) alongside sensitive auth headers, infer `csrf-token` refresh from `JSESSIONID`, and drop blank publish-sanitized header values at execute time so sanitized skills still replay authenticated Voyager requests correctly
* **ci/regressions**: add GitHub issue regression coverage for #69/#70/#71 plus Codex eval-contract tests to the default test path and CI unit job so HAR ownership/header regressions stop slipping past automation
* **eval/flags**: fix Codex harness boolean flag parsing so `--benchmark`, `--force-capture`, `--restart-server`, and `--require-dag` actually take effect instead of silently no-oping
* **browse/session**: validate stored Kuri tabs before reuse, recreate the browse session once on recoverable CDP/transport failures or empty snapshots, and fall forward to a fresh Kuri port when the default listener is wedged, so `unbrowse go/snap/eval` no longer stay pinned to dead tabs or a poisoned `127.0.0.1:7700`
* **browse/submit**: add `POST /v1/browse/submit` plus `unbrowse submit`, with generic DOM submit first, same-origin HTML rehydrate fallback, best-effort `data-load-plugins` / `WRS.require` recovery, and capture restart so JS-heavy multi-step checkouts can advance without site-specific JS indexing
* **github/ci**: remove stale `main` base-branch assumptions from workflows and PR helper scripts so repo automation targets `rach/restart-base` only
* **ci/backend**: restore the shared telemetry type exports used by analytics routes, make the x402 gate Worker-safe without Node `Buffer`, mark the live graph-edge test truly opt-in again, and stop npm `prepack` from deleting tracked Kuri binaries before CI package validation
* **docs/skill sync**: restore the full public `docs/whitepaper/` set from git history, make `scripts/sync-skill.sh` copy the monorepo `docs/` directory into the public skill repo so long-form docs stop disappearing on downstream syncs, and keep public entrypoints free of internal-only framing
* **docs/messaging**: align the public README and skill entrypoints around the buyer-facing category line "drop-in browser for agents" while keeping the explanation grounded in route learning, reuse, and browser fallback
* **docs/messaging**: sharpen the public category line to a drop-in replacement for OpenClaw / `agent-browser` browser flows, with explicit ~30x faster / ~90% cheaper framing for the API-native path and stronger "browser work becomes a reusable asset" language
* **review**: fix skill lookup in review route to check domain cache (same as GET route) — previously returned 404 for skills only in domain snapshots
* **review**: fix review route to update all local caches (domain snapshot + domain cache + published skill cache) so reviewed metadata is visible on next resolve without requiring marketplace round-trip
* **execute**: return `endpoint_not_found` error with available endpoints list when agent-specified endpoint_id doesn't exist in skill — previously silently fell through to `selectBestEndpoint` and executed the wrong endpoint
* **execute**: apply agent's params to trigger URL during trigger-and-intercept execution — previously replayed the original captured URL ignoring new search terms, causing search endpoints to return stale/unfiltered results
* **skill sync**: restore standalone skill repo docs during `scripts/sync-skill.sh` by copying the monorepo `docs/` tree after the package rsync, so quickstart/API/release docs stop disappearing on the next sync
* **resolve**: skip the first-pass browser fast-path for canonical replay pages like npm/PyPI package search and package detail URLs, so deterministic structured fetches run before flaky browser handoff
* **payments/search**: make production cloud search routes return x402 `402 PAYMENT-REQUIRED` terms for Tier 3 graph lookups, and propagate those payment-required errors through the runtime instead of silently downgrading to empty marketplace results
* **resolve/canonical replay**: when paid marketplace search blocks a canonical detail page like PyPI package records, seed a local structured replay skill instead of dead-ending at `payment_required`, so agents still get a runnable endpoint for free deterministic detail fetches
* **payments/tests**: add backend route coverage for the x402 skill gate so paid skill reads now prove the real `402` header handshake and proof-accepted retry path
* **payments**: align the backend x402 gate with lobster.cash and Corbits by emitting `PAYMENT-REQUIRED` v2 terms, settling `PAYMENT-SIGNATURE` retries through the facilitator, and preserving the older `X-Payment-Proof` fallback for legacy clients
* **payments/splits**: sync creator payout wallets onto agent profiles, route single-contributor paid skills directly to that wallet, add an authenticated wallet-sync endpoint for existing agents, fan transaction ledgers out across contributor payouts from skill attribution shares, and teach publish-time split provisioning to accept either a fixed Cascade `split_config` override or auto-create/update one through `@cascade-fyi/splits-sdk`
* **payments/auth**: enforce auth on protected skill/stats write routes again, carry the current wallet through publish to avoid wallet-sync/read-after-write races, and clear stale single-wallet `split_config` values when a skill becomes multi-contributor
* **payments/policy**: disable Cascade-based multi-contributor routing for now and send paid skill proceeds to the current majority contributor wallet only, with creator ledgers following the same single-recipient policy
* **payments/e2e**: verify real Lobster x402 settlement against staging end-to-end, document `X402_NETWORK_MODE=mainnet` for staging workers, and note that winning contributor wallets must already have a mainnet USDC token account for Corbits settlement to succeed
* **payments/flags**: add Worker-level `PAYMENTS_ENABLED` kill switch so x402 gates and Tier 3 search fees can be disabled entirely without changing skill pricing metadata or redeploying code paths
* **packaging**: publish the runtime payment deps (`bs58`, `@solana/kit`, `@cascade-fyi/splits-sdk`) in the npm CLI package so global installs no longer crash before `unbrowse help` / `unbrowse health`
* **cli/auth**: improve agent UX on gated sites by auto-falling back from paid marketplace search to free `--force-capture`, trying browser cookie import before interactive login, and refusing to treat Cloudflare challenge pages as successful login
* **telemetry/economics**: add per-agent savings ledgers from `POST /v1/stats/perf`, expose `GET /v1/dashboard/me` and `GET /v1/leaderboard`, and propagate billed Tier 3 search cost through the client/runtime for dashboard truth
* **auth**: cookie injection via raw CDP for full `secure`/`httpOnly`/`sameSite`/`expires` support — Kuri's `/cookies` endpoint was dropping these flags, causing HTTP 400 on LinkedIn and other sites requiring secure cookies
* **auth**: strip wrapping quotes from cookie values — Chrome stores JSESSIONID as `"ajax:..."` with literal quotes that broke LinkedIn's CSRF validation
* **publish**: re-cache skill locally after marketplace publish to prevent `publishSkill`'s backend merge from overwriting agent-updated descriptions

### Features
* **#218**: wire DAG planner to backend EmergentDB graph — dag-advisor now queries the backend graph (fetchChain) first for cross-session intelligence with local planner fallback; publishEdgesToBackend fixed to use correct URL (beta-api.unbrowse.ai) and send Authorization headers; planner.ts stub replaced with real delegation to dag-feedback
* **#155**: add BM25 lexical channel with RRF fusion — `indexEndpoints` stores docs in KV; `searchIntentInDomain` runs BM25 + graph in parallel and fuses with RRF (k=60), falling back to graph-only when no index exists
* **#221**: wire `computeCompositeSearchScore` into search/resolve path — search results are now rescored with the Section 3.3 composite formula (40% embedding, 30% reliability, 15% freshness, 15% verification) instead of pure vector similarity; orchestrator scoring aligned to use continuous verified ratio
* **#220**: wire `computeBottleneckMetrics` into backend — new `GET /v1/analytics/bottleneck` route returns latency percentiles (p50/p95 for capture, resolve, execute), cache/marketplace/live-capture hit rates, failure rate, and skills-per-domain capacity metric, all loaded from KV perf stats and skill data

### Bug Fixes

* **publish-pipeline**: `wrong_entity_type` verdict downgraded from `fail` to `skip` — captures with non-standard field names (e.g. `body` instead of `text`, `entityUrn` instead of `id`) no longer block marketplace publishing; post classifier expanded to accept real-world API field names (`message`, `_id`, `entityUrn`, `from.name`, `created_time`, etc.)
* **tests**: rewrote stale release-flow, CLI, and payments coverage so reruns match the current product contract; unit runs no longer depend on repo version drift or live pricing/backend state, CLI JSON stdout stays machine-safe, and slow integration suites use hermetic/sequential setup instead of host-coupled timeouts
* **tests**: removed mock-only incomplete backend spec fossils and promoted the local CLI payload contract suite into always-on coverage, so the remaining incomplete tests are opt-in live/integration paths instead of stub-server TODOs
* **kuri/tests**: fixed live-browser tab registration and text snapshots in the Kuri client, replaced placeholder wrapper/action TODOs with real end-to-end browser coverage, promoted the P0/P1 and graph-edge live suites into always-on tests, and moved marketplace latency diagnostics out of the `*.test.ts` suite
* **#223**: wire `isStructuredSearchForm`, `attributeLifecycle`, and `isRepeatableEval` into production code — search forms are detected from captured HTML and attached to endpoints, lifecycle phases are attributed for observability in the orchestrator and publish flows, and eval repeatability checking flags flaky cases in the harness
* **#229**: implement `tryFirstPassBrowserAction` — navigates to the URL, records HAR, performs intent-driven actions (search/click/navigate), collects intercepted JSON API responses, and synthesizes a mini-skill for passive indexing ([#229](https://github.com/justrach/unbrowse34/issues/229))
* **capture**: thread AbortSignal through CDP phases so 90s timeout aborts hanging kuri calls immediately instead of waiting for each call's own 30s timeout to stack ([#113](https://github.com/justrach/unbrowse34/issues/113))
* **#152**: `mergeEndpoints` now promotes richer endpoint rediscoveries instead of silently dropping them
* **#152**: `mergeEndpoints` now promotes richer endpoint rediscoveries instead of silently dropping them
## [2.0.1](https://github.com/justrach/unbrowse34/compare/v2.0.0...v2.0.1) (2026-03-15)

### Features

* migrate backend to EmergentDB Graph API ([#85](https://github.com/justrach/unbrowse34/issues/85)) ([fabfe87](https://github.com/justrach/unbrowse34/commit/fabfe87ce21d4b66cfc918ea383a90ff772e6f32))
* sharpen landing hero value prop ([56b6035](https://github.com/justrach/unbrowse34/commit/56b60356a24984e1f785ae3dc2f160979576b6ee))

### Bug Fixes

* bundle kuri runtime in cli releases ([4353f3e](https://github.com/justrach/unbrowse34/commit/4353f3ecb574aa9c8dc67855318d29624d3d87d3))
* stabilize frontend deploy fonts ([a51c4e2](https://github.com/justrach/unbrowse34/commit/a51c4e29a75f233c62147a48029ece978b8af281))

## [2.0.0](https://github.com/justrach/unbrowse34/compare/v1.1.5...v2.0.0) (2026-03-14)

### Features

* auto-execute + SSR fast-path (15s → 3.6s) ([318c10f](https://github.com/justrach/unbrowse34/commit/318c10f243543857a945b34488ce0214780094c8))
* auto-execute DOM extraction endpoints with LLM param inference ([b03b0d2](https://github.com/justrach/unbrowse34/commit/b03b0d25e403b86f930f49575b2f182fbfeb0859))
* auto-execute, SSR fast-path, route/domain caching, evals, backend improvements ([0fd9346](https://github.com/justrach/unbrowse34/commit/0fd93468102e62364e1a31697cf8e6ea9e3b1a12))
* domain-level skill cache for cross-intent reuse ([1aa8361](https://github.com/justrach/unbrowse34/commit/1aa8361f671bf91f3f31e1320e3caa9c6df965e1))
* expand public eval corpus and prep v2.0.0 ([b75f8d2](https://github.com/justrach/unbrowse34/commit/b75f8d2f73e49bc9b96e38feadf3c2a0135c88a4))
* persist route cache to disk (survives restarts) ([a6a5eae](https://github.com/justrach/unbrowse34/commit/a6a5eaeac33a264bfe099e07465e02e4f71f26d6))
* replace agent-browser with Kuri — CLI-first Zig-native browser automation ([6053014](https://github.com/justrach/unbrowse34/commit/6053014c7c05411cac5988dd62ec2fa5ff417169)), closes [#71](https://github.com/justrach/unbrowse34/issues/71) [#71](https://github.com/justrach/unbrowse34/issues/71)

### Bug Fixes

* catch 'setPassword is not a function' keytar errors and fall back to encrypted file vault ([71a53af](https://github.com/justrach/unbrowse34/commit/71a53af4ff20e01e570cd7b51e3c2c21a63497e4))
* stale route cache + domain cache persistence ([55bc5a4](https://github.com/justrach/unbrowse34/commit/55bc5a4a272972b20e24446ad3e2c8e5b860c59a))

## 1.1.5 (2026-03-11)

### Bug Fixes

- **resolvePath**: changed URN fallback condition from `val === undefined` to `val == null` so references resolve when normalized APIs set inline fields to explicit `null` (LinkedIn Voyager, Facebook Graph, REST-li)
- **detectEntityIndex**: replaced hardcoded `obj.included` / `obj.data.included` lookups with generic scan of all top-level and one-level-nested arrays, picking the largest `entityUrn`-keyed array

## 1.2.0 (2026-03-13)

### Auto-Execute — Intent-Driven Parameterization

Skills with URL template parameters (e.g. `?k={k}`) now auto-execute by filling params from the user's intent instead of deferring with "pick an endpoint." This eliminates the manual execute step for search-style queries across any website.

- **`buildDeferralWithAutoExec()`** — every deferral path now attempts auto-execution first. Single entry point, catches all code paths.
- **`inferParamsFromIntent()`** — LLM-based (gpt-4.1-mini) param inference maps natural language intent to URL template params. Generalizes to any site: Amazon's `k`, Yelp's `find_desc`/`find_loc`, Booking's `ss`, etc.
- **Fast-path for single params** — simple search intents (e.g. "find wireless headphones") extract terms directly without LLM, saving ~2s per request.
- **DOM extraction endpoints trusted** — skip LLM judge for `dom_extraction` endpoints since cheerio-extracted data uses heading-based schemas that confuse the judge.

### SSR Fast-Path — HTTP Fetch Instead of Browser

Server-side rendered sites (Amazon, etc.) no longer launch a browser for cached skills. Plain HTTP fetch + cheerio extraction replaces Playwright navigation.

- **`tryHttpFetch()`** — plain `fetch()` with realistic browser headers and cookie injection, 10s timeout, fails fast on non-200/non-HTML/small responses (<1KB).
- **Silent browser fallback** — if HTTP fetch fails (bot detection, JS-rendered content), falls back to full browser capture automatically.
- **Result**: cached SSR queries dropped from **15s → 3.6s** (4x faster). No browser launched, no GPU/memory overhead.

### Skill Promotion

- Auto-executed skills from live-capture are now promoted to marketplace cache via `promoteLearnedSkill()`, so subsequent requests hit the fast marketplace path instead of re-capturing.

---

## Unreleased

### Packaging

- Added the upstream `justrach/kuri` repo as a tracked git submodule and restored `.gitmodules` metadata for the existing OpenClaw plugin submodule, so repo checkouts can initialize both dependencies cleanly.
- The npm CLI package now bundles platform-specific Kuri binaries during `prepack`, resolves them before falling back to repo-local builds, and `unbrowse setup` now verifies or builds Kuri instead of trying to install stale `agent-browser` / Playwright assets.
- Skill repo sync now carries a vendored Kuri source snapshot into the standalone publish repo so package rebuilds do not depend on a sibling `~/kuri` clone.

### Evals

- Added an autonomous Codex eval harness that runs auth-aware resolve/execute loops, checks DAG reachability, escalates through force-capture plus deeper `trigger_url` retries, and stops with explicit `pass`/`fail`/`skip`/`blocked` outcomes instead of a manual-only shortlist.
- Expanded eval case schema/product-truth judging with auth persona metadata plus `entity_type`, `min_rows`, `side_effect`, `echo_params`, and `terminal_ok` validation so site coverage can assert discovery, DAG selection, and real execution outcomes in one artifact.
- Added autonomous benchmark mode for explicit cold-vs-warm comparisons, surfacing per-round source/latency/token telemetry plus per-case speedup and token deltas between first capture and second reuse runs.
- Added a dedicated auth eval runner plus a popularity-backed auth corpus. It bootstraps vault auth via browser-cookie reuse or scripted demo logins, then runs each case through the autonomous harness with a top-level auth artifact and per-site child artifacts.
- Workflow auth evals now score latency budgets against warm-path timings while still recording raw cold timings, so discovery-first passes stop failing purely because the first capture was expensive.
- Scripted auth bootstrap now supports profile-only success pages that do not persist reusable cookies, and the auth runner hands those cases to the harness without forcing a cookie-based auth skip.
- Autonomous harness now trusts a passing direct resolve payload before it burns time on replay candidates, which prevents learned endpoint detours from regressing already-correct DOM captures during suite runs.
- Autonomous public evals now follow `learned_skill_id` placeholders into the real learned skill, synthesize endpoint shortlists from that manifest, and accept common URL aliases like `link` / `mdn_url` / `html_url` when the product-truth case expects `url`, fixing npm/MDN/Stack Overflow bulk-site regressions.
- Added a shard/resume Codex campaign runner for large eval sweeps. It slices case corpora into resumable shard files, runs the autonomous harness sequentially per shard, and writes merged campaign artifacts so larger runs can scale toward hundreds or thousands of cases without one giant fragile foreground process.
- Added a generated bulk-seed corpus and builder script that merge the shipped public/product/auth suites into one deduped campaign file for larger-site smoke sweeps.

### Reverse Engineering

- Reverse-engineered mutation endpoints now templatize replayable request-body inputs into `body` placeholders plus `body_params` defaults, infer cookie-backed CSRF plans from captured traffic, and feed request-body semantics into endpoint admission so authenticated action flows are more likely to replay cleanly instead of being stored as one-off captured payloads.
- DOM extraction now promotes single-record detail pages and auth success/flash messages into stable `title`/`message`/`flash` records instead of low-confidence multi-candidate blobs, improving durable replay for logged-in demo flows like Practice Test Automation and The Internet.

### Authentication

- Added custom Chromium-family cookie import for `/v1/auth/steal`, including explicit browser selection plus optional user-data dir, cookie DB path, and macOS Safe Storage service overrides so Electron-style app sessions can be reused without re-login when their cookie store is local.
- Broken `keytar` native-binding shims from the Bun-built npm bundle now demote cleanly to the encrypted file vault at runtime, so `resolve`/auth reads no longer crash under Node 25 when the optional native module is present but unusable.
- Missing local `kuri` binaries now fail with a normal startup warning instead of crashing the CLI/runtime during bootstrap.
- CLI startup now validates the active API key against `/v1/agents/me`, ignores stale env/config keys that no longer have agent profiles, and re-registers instead of silently dropping agent activity/execution telemetry.
- Backend auth now recreates missing `agent:*` profiles on first valid key use, so orphaned keys stop disappearing from lifecycle/activity analytics.
- Local `wrangler dev` registration now falls back to the built-in `local-test` admin key when Unkey secrets are stubbed, so backend smoke tests can bootstrap without live Unkey credentials.
- Fixed EmergentDB KV `listWithValues()` so prefixes with more than 30 trimmed/overflowed entries no longer silently undercount after the first backfill batch.

### Setup & onboarding

- Added a publish guard around `packages/skill` so direct folder-level npm publishes now fail closed with instructions to use the repo-root release flow, plus explicit root scripts for `bun run pack:cli` and `bun run publish:cli` when a synced local publish is intentional.
- Release config now sets `npm.ignoreVersion=true` so `release-it` does not re-run `npm version` after `@release-it/bumper` has already synced the root package, skill package, and `version.json`.
- Added a skill README callout asking users to post sites/APIs they could not get working in GitHub Discussion #53 so those failures can become explicit requirements in the next eval cycle.
- Added `unbrowse setup` as the one-command bootstrap for npm/npx installs. It checks prerequisites, installs browser assets, registers Open Code's `/unbrowse` command, and can skip server start with `--no-start`.
- `unbrowse setup` now asks for an email-style agent identity up front and `UNBROWSE_AGENT_EMAIL` can preseed the same display identity in headless setups, while opaque backend agent ids stay unchanged.
- Added the repository's Star History chart to the synced skill README so marketplace installs keep the same social proof/docs surface as the main repo.
- Switched public onboarding to the npm-backed `unbrowse` CLI, with `npx unbrowse` for zero-install trials and `npm install -g unbrowse` for repeat use.
- Removed runtime skill self-update. npm/npx is now the code update path, while `SKILL.md` stays repo-managed and is checked during pack/release flows.
- Docs now explicitly tell existing users to rerun `npm install -g unbrowse`, `unbrowse setup`, and host-side skill update commands after releases so local installs do not stay stale.
- Every CLI command now auto-starts the local server using package-relative bootstrap paths, pid tracking, and local log files.
- Shrunk the npm tarball to the runnable CLI/runtime only, dropping skill metadata and other non-runtime publish clutter while keeping the local server boot path intact.
- Browser installation now runs through the bundled `agent-browser` dependency instead of shelling out through `npx`, making fresh installs more reliable.
- Added skill-level installer metadata plus a standalone OpenClaw plugin for hosts that want a native Unbrowse-first integration.
- Release CI now validates the npm tarball on every main/PR build, publishes `packages/skill` to npm on release tags, and refuses canonical releases when npm or skill-sync secrets are missing.

### Agent behavior & demo UX

- Tightened the skill and Open Code command prompts so agents stay on Unbrowse instead of drifting into Brave Search, ad hoc `curl`, or other fallback web tools unless the user explicitly allows it.
- Cut the pre-commit hook down to fast staged-file checks only; the old server boot plus eval sweep now lives behind `bun run precommit:full` instead of blocking every commit.
- Added CLI progress notices during slow first-time capture/indexing so demos read as "working" instead of "hung."
- Preserve structured LinkedIn feed results in the CLI instead of wrapping them with stale raw extraction hints from the pre-projection payload.
- Added `bun run release:announce` to turn release notes or the unreleased changelog into a short announcement summary and X-ready post draft.
- Release hooks now also write `.release-announcement.md` and `.release-announcement.json` during `bun run release`.
- Added generator/resolve debug traces in `traces/` for testing mode so capture admission, ranking, and auto-exec failures are easier to inspect.

### Retrieval accuracy & reliability

- Added generic single-record detail-page DOM extraction plus broader `*desc*` class handling, so product/detail/profile-style pages can be judged as structured key-value records instead of falling through as empty captures.
- Resolver marketplace hydration now rejects mismatched page-artifact-only skills for concrete detail URLs, and endpoint ranking more aggressively demotes wrong page artifacts when the requested detail page is a different path on the same domain.
- Prefer same-trigger structured timeline/search APIs over captured page artifacts for post-search intents, so X search resolves to `SearchTimeline`-style endpoints before page-shell artifacts.
- Added more public structured replay rewrites for DEV tag pages, pub.dev package pages, RubyGems gem pages, Stack Overflow tag pages, and Jmail search pages, so those routes resolve through stable APIs instead of slow browser capture.
- Added a public document-fetch fast path before browser capture, letting server-rendered public pages seed reusable page-artifact skills without paying browser startup cost when plain HTML extraction already passes intent/quality checks.
- Normalized bracketed/indexed HTML query params like `filters[0][value]` into stable agent bindings (for example `filters_0_value`) across capture, page-artifact templating, DAG bindings, and execution-time param merging.
- Stopped public resolve/execute paths from auto-scraping browser cookies on vault misses; public replayable sites now stay on fast unauthenticated fetch paths, while browser auth refresh remains reserved for explicitly auth-backed endpoints.
- Added canonical public replay rewrites for GitHub repository search and MDN docs search so those task URLs can resolve through fast server fetch instead of falling through to slow browser capture in the product-success eval lane.
- Tightened the generic support gate so bundle-inferred ghost routes no longer count as a successful site capture by themselves, public no-data captures stop defaulting to misleading auth hints, and generic intent judging now rejects weak DOM junk for questions/definitions/posts while recognizing docs/recipes/courses.
- Fixed canonical structured replay learning to keep the public API URL as the learned endpoint instead of collapsing back onto the source page URL, so Hacker News / Hugging Face style public sites stop reusing stale DOM artifacts when a replayable JSON endpoint exists.
- Stopped canonical replay endpoints from inheriting duplicate source-page query params during execution, and ranked replay endpoints above sibling DOM artifacts, so public API-backed searches auto-execute the real JSON route instead of 400ing on extra params or reporting stale page-artifact metadata.
- Canonical structured replay learning now keeps generic query templates for public search pages and materializes blank search roots into replayable API templates, so the agent path can populate `--params` inputs instead of depending on whatever query happened to be in the original page URL.
- Graph planning now treats DOM/HTML form pages as first-class provider nodes by inferring dropdown/filter bindings from extracted option fields, so dependency walks can model page -> selected form value -> downstream API chains instead of assuming every dependency comes from JSON endpoints.
- Normalized Hacker News DOM rows and Jmail public email search rows into judged story/email records so niche public canaries no longer fail just because the page fallback used site-shaped field names.
- Replaced generic reverse-engineered endpoint descriptions with semantic descriptions derived from the actual route/schema, added Discord guild probes for server intents, and demoted referral/promotion/billing/page-shell noise so server/channel intents stop ranking meta endpoints above real guild APIs.
- Hardened Reddit retrieval with canonical `.json` normalization, browser-like replay headers, queue bypass for known structured routes, and `old.reddit.com` fallback candidates.
- Improved concrete entity-detail retrieval so LinkedIn, profile, and company URLs prefer observed APIs over page-shell artifacts, sidebar noise, and stale browser routes.
- Materialize more public eval roots into concrete public pages for GitLab, npm, PyPI, Docker Hub, and Pinterest so auth-free captures start from real search/detail surfaces instead of barren homepages.
- Added canonical public replay rewrites and intent normalization for Mastodon, GitLab, npm, PyPI, and Docker Hub so public package/image/project pages resolve against real JSON APIs and package/tag payloads judge correctly.
- Drop PyPI search and Mastodon timeline/search from the public no-auth eval materialization when the live site now serves a client challenge, auth wall, or empty public post results instead of real public data.
- Eject stale warm-cache and captured-cache entries when endpoint ids 404, degrade semantically, or fail auto-exec, allowing resolve to recover through fresh ranking and capture.
- Drop empty or unreplayable learned skills before publish/reuse and skip empty endpoint drafts centrally so dead capture branches stop polluting the marketplace.
- Ignore bundle-inferred settings/login/webauthn routes during public root captures and stop crashing when a live capture only learns unusable endpoints.
- Preserve `{placeholder}` query templates when merging captured/default query params so context-derived and CLI-provided inputs actually interpolate into GET executions.
- Added regression coverage for captured request-body learning plus CLI `--params` payload ingress on both resolve and execute paths.
- Prefer more specific DOM replay selectors for generic people-card captures, and keep non-API same-page replays from inheriting the new browser-like structured replay headers.
- Retry browser capture once with a fresh ephemeral profile when a persistent profile collapses its page/context, reducing public CLI flake on GitHub-style captures.
- Prefer structured document replay or server fetch when a canonical data URL or observed API exists, instead of getting trapped on stale browser strategies.
- Scope route-cache reuse to the concrete task URL and client id so warm retrieval replays the same good path instead of drifting across tasks or callers.
- Tightened skill-generation gates so only parsed JSON/HTML responses with intent-matching semantics become reusable endpoints.
- Improved route ranking and auto-exec by preferring immediately executable endpoints, inferring templated params from the request URL, and demoting page-shell routes when a real internal API exists.
- Improved GitHub, Mastodon, X, and other high-traffic domains by ranking repo/search/trending endpoints higher when the page context and query params match.
- Replay DOM extraction from a rendered browser page when needed and unwrap extracted payloads before intent projection.
- Restored LinkedIn feed support after the CLI/server wrap by splitting camelCase query ids during semantic admission and ranking, so `voyagerFeedDashMainFeed` beats profile/news noise again; also restored local `unbrowse sessions` output instead of proxying that debug command to the backend.

### Evals, testing, and infra

- Removed the old overlapping eval entrypoints and consolidated interactive agent validation around the Codex harness so local debugging and `precommit:full` have one canonical product-path eval flow.
- Eval harness now shuts down its locally booted server on exit, reducing sticky long-tail runs between repeated stress passes.
- Added a Codex-facing CLI harness for one-off or file-backed cases. It runs the real `resolve`/`execute` path, records local verdicts plus execution evidence, and writes a local artifact for Codex to inspect during interactive debugging.
- Added a canonical public no-auth Codex suite covering popular, replay-friendly targets (GitHub, npm, PyPI, GitLab, Docker Hub) so there is always a stable baseline to run without local browser auth.
- Added param-seeded public cases plus graph/DAG selection and dependency-walk summaries directly into the canonical Codex harness artifact, so the single eval path now covers query population and multi-step pipeline traversal in the same run.
- Added fixture-backed HTML form DAG coverage and deduped repeated dependency edges, so graph artifacts stay readable when the same binding appears in both query and template form.
- Expanded the stable public suite with Reddit and added a broader benchmark-inspired agent-target suite covering popular public sites agents hit in WebVoyager/WebArena-style tasks, plus niche public targets like Hacker News search and Jmail search.
- Expanded the broader agent-target suite again with long-tail public sites agents commonly touch for docs, Q&A, package lookup, and dev communities: Stack Overflow, MDN, DEV, crates.io, RubyGems, pub.dev, and Lobsters.
- Removed the external model ordering/judging path from the Codex harness. It is now collector-only, and the canonical eval flow is agent-in-thread review of the recorded artifact.
- Serialized judge requests and same-domain live captures to reduce timeout noise and self-conflicts in strict real-world benchmarks.
- Made judged evals stricter and closer to the real CLI path: execute deferred endpoints after resolve, retry on HTML/empty/wrong-entity payloads, normalize judge outputs, and score raw CLI payloads directly.
- Preserved `NEBIUS_API_KEY` across runtime preset switches and added file-backed `prod` / isolated `testing` presets to avoid env drift.
- Expanded CLI/e2e and graph-v2 coverage with auth-aware runs, dependency-aware endpoint fixtures, and local harnesses for endpoint selection testing.
- Queue agent telemetry writes so execution and feedback stats stop dropping under concurrent load.
- Fixed release version bumping so the root `package.json` stays in sync with `packages/skill/package.json` and `version.json`.

## [1.0.0] — 2025-01-01

## fix: bundle-inferred endpoints now capture query param names from JS source

The bundle scanner regex patterns matched query strings (e.g. `/api/search?q=`) but
discarded them in a non-capturing group. Bundle-inferred endpoints had no `query`
field and no `{param}` template vars, forcing users to guess parameter names.

Now the scanner captures query string portions as regex group 2, extracts param
names, and merges them across multiple occurrences of the same path. The endpoint
creation code builds templatized `url_template` (e.g. `/api/search?q={q}`) and
populates `endpoint.query` for bundle-inferred endpoints, matching the behavior
of network-captured endpoints.

## feat: staging environment — isolated namespaces for safe migration testing

Vector namespaces, KV namespaces, and search caches are now derived from
`env.ENVIRONMENT`. Staging uses completely isolated data stores (`unbrowse-staging--`
vectors, `staging-skills` / `staging-stats` KV) so migrations and schema changes
can be tested without touching production data.

- **`backend/src/services/discovery.ts`**: `NS_PREFIX`, `domainNamespace()`, `globalNs()`
  now take `env` and return staging-prefixed namespaces when `ENVIRONMENT=staging`
- **`backend/src/services/kv.ts`**: `skillsKV()` and `statsKV()` return staging-prefixed
  KV namespaces when `ENVIRONMENT=staging`
- **`backend/wrangler.toml`**: Added `[env.staging]` with `ENVIRONMENT=staging`.
  Deploy with `wrangler deploy --env staging`, set secrets with `--env staging`

## refactor: domain-convergent skills — one skill per domain with endpoint-level search

Skills were being created per-intent per-domain, fragmenting the API surface and
limiting search to whatever intent string happened to be captured first. "get bookmarks
from x.com" and "get feed from x.com" produced two separate skills with separate
vector embeddings, making cross-intent discovery impossible.

Now each domain converges to a single skill. Captures accumulate endpoints via
`mergeEndpoints()` instead of replacing them. Search operates at the endpoint
level — each endpoint's description gets its own vector embedding, so "get
notifications" finds the notifications endpoint even if the domain was first
captured for "get events."

- **Backend `publishSkill()`**: dedup changed from `intent-idx:{domain}:{hash(intent)}`
  to `domain-idx:{domain}`. `mergeEndpoints()` (previously dead code) is now wired in
  to accumulate endpoints across captures
- **Per-endpoint vector indexing**: `indexEndpoints()` replaces `indexSkill()` —
  embeds each endpoint's description as `"{description} [{method} {path}]"` with
  batch Nebius API calls. Search results now include `endpoint_id` in metadata
- **Orchestrator**: extracts `endpoint_id` from search results and executes directly,
  skipping BM25 `rankEndpoints()` when vector search already found the right endpoint.
  Removed `hasTriggerMatch` filter on local cache (too restrictive for consolidated skills)
- **Capture**: `executeBrowserCapture()` merges new endpoints into existing domain skill
  instead of replacing. Skill `name` and `intent_signature` set to domain name
- **Migration**: lazy — old `intent-idx:*` entries are scanned as fallback. Old
  skill-level vectors are cleaned up on next `ops/reindex`. New `POST /v1/ops/consolidate`
  endpoint merges all skills for a domain on demand

## fix: cross-domain redirect sites (lu.ma → luma.com) and skill cache persistence

Sites that redirect to a different domain (e.g. lu.ma → luma.com) had three
compounding issues preventing API discovery and execution:

- **Domain affinity filter in extractEndpoints** now uses both the page URL and
  final URL domains. Previously, XHR calls to `api2.luma.com` were filtered out
  because the base domain was `lu.ma` (different registrable domain).
- **Server-side fetch with cookies** — the `serverFetch` path in the skill
  directory now includes auth cookies via the Cookie header and detects API
  subdomains (`api2.*`, `api.*`), routing them to server-fetch instead of
  browser-based execution.
- **Skill cache persistence** — `getSkill()` no longer overwrites a freshly
  published local skill with a stale backend copy (eventual consistency).
  `publishSkill()` pre-caches locally and only merges backend identity fields.
- **Persistent browser profiles for capture** — `captureSession` now uses
  headless persistent profiles (from prior `interactiveLogin`) to preserve
  localStorage/sessionStorage auth. Previously always ephemeral.
- **Client Hints header override** — prevents Chromium 145+ from leaking
  `sec-ch-ua: "HeadlessChrome"` during capture, which triggered bot detection.

## feat: auto-update — skill silently updates itself in the background

End users no longer need to run `npx skills update` manually. On every CLI
invocation the skill checks if it's time for an update (every 4 hours). If so,
a detached background worker fetches the latest commit from GitHub, downloads
the tarball, and copies new files over the skill directory. Dev installs
(symlinks) are automatically skipped.

- **`src/auto-update.ts`**: Orchestrator — reads `~/.unbrowse/config.json` for
  `last_update_check`, spawns worker as detached process, never blocks CLI
- **`src/auto-update-worker.ts`**: Standalone worker — checks GitHub API for
  latest SHA, downloads + extracts tarball, runs `bun install`, stores SHA
- **`src/cli.ts`**: Calls `maybeAutoUpdate()` at the top of `main()`

## feat: extraction hints — agents get structured data on first try

Large API responses (>2KB) were causing agents to flail through 5-7 execute calls
guessing `--path` values. Now the engine analyzes the `response_schema` at inference
time and returns `extraction_hints` with the exact `--path`, `--extract`, and ready-to-paste
`cli_args`. The CLI auto-wraps large responses with hints instead of dumping raw JSON.

- **`src/transform/schema-hints.ts`**: New module — walks `ResponseSchema` to find best data
  array, ranks fields by name semantics (identity > content > metrics > tracking), produces
  `ExtractionHint` with `path`, `fields`, `cli_args`, and `schema_tree`
- **`src/execution/index.ts`**: Attaches `extraction_hints` to all execute responses alongside
  `response_schema` — computed from schema at inference time, zero extra network calls
- **`src/orchestrator/index.ts`**: Passes `response_schema` and `extraction_hints` through all
  execution paths (auto-exec, race, cache hit, post-capture)
- **`src/cli.ts`**: Auto-wraps large responses with hints (replaces 300+ line JSON dumps with
  compact hint output). New `--schema` flag returns only schema + hints without data.
- **`SKILL.md`**: Updated workflow — agents read `extraction_hints.cli_args` and paste directly
  into next execute call. Rule 3 now explicitly forbids guessing paths by trial-and-error.

## feat: JS bundle scanning for API route discovery

During capture, Unbrowse now scans same-domain JavaScript bundles for API route
patterns that were never triggered by network traffic. Previously, endpoints like
`/api/emails/search` on jmail.world were invisible because the capture only
observed passive page-load requests — the search API required typing in a search
box to trigger. Now these routes are discovered via regex scanning of JS bundles.

- **`src/capture/index.ts`**: Collects same-domain JS bundle content during capture (2MB/bundle cap, 20 bundles max)
- **`src/reverse-engineer/bundle-scanner.ts`**: New module — scans bundles for `/api/...`, `fetch("/...")`, and `/v1/...` patterns with deny-list filtering
- **`src/execution/index.ts`**: Merges bundle-discovered routes as low-confidence (`reliability_score: 0.2`) inferred endpoints, deduped against network-observed endpoints
- Zero perf cost: bundles are already downloaded by the browser, no extra requests
- Handles query strings in string literals (e.g., `"/api/search?q="` → `/api/search`)

## refactor: remove extraction recipes, surface response schema

Extraction recipes were brittle hardcoded field mappings that broke when APIs changed
their response shape. Replaced with a schema-first approach: the `response_schema`
(already inferred during capture) is now returned in execute responses so agents can
craft their own `--path`/`--extract` dynamically.

- **Deleted** `src/transform/recipe.ts` and `src/transform/suggest.ts` (~660 lines)
- **Removed** recipe CRUD routes (`POST`/`DELETE /v1/skills/:id/endpoints/:eid/recipe`)
- **Removed** `cmdRecipe` CLI command and `suggested_extraction` auto-apply logic
- **Added** `response_schema` to execute responses — agents see the full inferred schema
- **Added** `schema_summary` in resolve deferral — top-level property names + types replace the old `has_schema` boolean
- **Kept** `--path`/`--extract`/`--limit`/`--raw` projection system unchanged

## feat: URN reference resolution for normalized APIs

APIs like LinkedIn Voyager and Facebook Graph return normalized data in `included[]`
arrays where objects reference each other via `*`-prefixed URN fields (e.g.
`*socialDetail` → SocialDetail → `*totalSocialActivityCounts` → counts). The
extraction pipeline now transparently follows these multi-hop references.

- **`buildEntityIndex()`** / **`detectEntityIndex()`**: auto-detect `entityUrn`-keyed arrays and build a lookup map
- **`resolvePath()` upgrade**: when a field lookup fails, checks for `*field` URN reference and resolves through the entity index
- **Works everywhere**: CLI `--extract` and server-side projection all follow URN references
- **Zero config**: entity index is detected and built automatically; no new flags needed
- **Backward compatible**: non-normalized APIs are unaffected — the `*` resolution only activates when `entityUrn`-keyed arrays are present

## feat: CLI SDK — shell-safe wrapper, no more curl + jq

Agents no longer need curl + jq to interact with unbrowse. The CLI handles all
JSON construction and parsing in TypeScript, eliminating shell escaping issues
(e.g. `!=` being escaped to `\!=` in zsh, breaking jq filters).

- **`unbrowse resolve`**: intent resolution with `--url`, `--endpoint-id`, `--force-capture`
- **`unbrowse execute`**: skill execution with `--skill`, `--endpoint`, `--params`
- **`unbrowse feedback`**: mandatory post-call feedback
- **`unbrowse recipe`**: submit extraction recipes via flags instead of JSON blobs
- **`--extract`**: ad-hoc field extraction from result (e.g. `--extract "user,text,likes"`)
- **`--pretty`**: indented JSON output on any command
- **`--raw`**: bypass extraction recipes for unprocessed data
- **Auto-start**: server spawns automatically if not running
- **bin entry**: `"bin": { "unbrowse": "src/cli.ts" }` in unbrowse-skill package

## feat: extraction recipes — persist parsing knowledge on endpoints

When an agent figures out how to parse a complex API response (e.g. LinkedIn's 500KB
Voyager blob), that knowledge now persists as an extraction recipe on the endpoint.
Future executions auto-return clean, structured output — for all users via the marketplace.

- **ExtractionRecipe type**: filter + field-mapping rules stored on EndpointDescriptor
- **Auto-apply**: recipes applied during execution when no explicit projection is given
- **API**: POST/DELETE `/v1/skills/:id/endpoints/:eid/recipe` to submit/remove recipes
- **Marketplace**: recipes travel with the skill — all agents benefit
- **Escape hatch**: `"projection": {"raw": true}` bypasses recipe for raw data
- **Graceful fallback**: if recipe can't apply (source path missing), returns raw data

## fix: speed, coverage, and accuracy overhaul (bird-style parity)

### Speed: 20s→2s (trigger-intercept), 120s→100ms (server-fetch)

- **trigger-intercept: domcontentloaded not networkidle**: The page.goto was waiting
  for ALL network activity to settle (networkidle). SPAs like LinkedIn never fully
  idle. Now uses domcontentloaded — the intercept promise resolves as soon as the
  specific API call fires, typically 1-3s after navigation starts.
- **Local disk cache before marketplace search**: Marketplace API takes 40-80s
  (search + getSkill). Now checks disk cache first — if a skill exists locally for
  the domain, execute it immediately. Eliminates remote API latency entirely.
- **Cookie quote stripping**: Chrome SQLite stores some values with embedded quotes
  (e.g. JSESSIONID="ajax:..."). RFC 6265 requires unquoted values in Cookie headers.
  LinkedIn's CSRF check was failing because the quoted cookie didn't match the
  unquoted csrf-token header.
- **Accept header preservation**: server-fetch was overwriting endpoint's accept header
  with "application/json". LinkedIn requires "application/vnd.linkedin.normalized+json+2.1".
  Now only sets accept as default when the endpoint doesn't have one.
- **Stored auth headers in vault**: During capture, extract all sensitive headers
  (authorization, x-csrf-token, api-keys) that reverse-engineer strips from skill
  manifests. Store them encrypted in the vault. Server-fetch now works without
  launching a browser — direct HTTP with full auth headers.
- **Route cache on live-capture**: Route cache was only set on marketplace success.
  Now also caches after live-capture so the 2nd identical request skips search.
- **Domain cache TTL 60s→5min**: Prevents re-capture when marketplace hasn't indexed yet.
- **Domain strategy cache**: Once we learn x.com needs trigger-intercept (or server),
  apply that as default for all new endpoints on that domain.
- **Preserve exec_strategy on backend refresh**: `getSkill()` async-refresh from
  backend was overwriting locally-learned exec_strategy. Now merges them.
- **Parallel marketplace race**: Top 3 marketplace candidates execute via Promise.any
  instead of serial loop.

### Coverage: SPA intent-aware API wait

- **Phase 4 in waitForContentReady**: After networkidle, extract a route hint from
  the capture URL (e.g., "bookmark" from /i/bookmarks) and wait up to 5s for a
  matching API response. Catches SPA lazy-loaded APIs like Twitter's Bookmarks
  GraphQL query that fire after initial page load.
- **Synthesized requests**: Response bodies captured by the listener but missed by
  request tracking are now synthesized as RawRequests so they reach extractEndpoints.

### Accuracy: Better endpoint ranking

- **CamelCase tokenization**: GraphQL operation names like `BookmarkFoldersSlice` are
  now split into `["Bookmark", "Folders", "Slice"]` for BM25 matching. Previously the
  entire name was one token, never matching intent words.
- **Stemmer fix**: Added `-ed` and `-ing` suffix stripping. "bookmarked" now stems to
  "bookmark", matching `BookmarkFoldersSlice`. "trending" stems to "trend".
- **Bookmark synonyms**: Added bookmark ↔ saved/favorite synonym expansion.
- **trigger_url tokenization**: Endpoint trigger_url path segments are now included
  in BM25 document tokens.
- **Context URL match bonus**: +20 score when endpoint trigger_url matches the user's
  context URL path.
- **Session plumbing filter**: Filter account/settings, badge_count, DataSaverMode,
  live_pipeline, and other session plumbing from ranking candidates.
- **extractAuthHeaders()**: New export from reverse-engineer that extracts the inverse
  of sanitizeHeaders — all headers that would be stripped from the skill manifest.

### Stale skill prevention

- **Reuse existing skill_id**: Re-captures find the existing cached skill for
  the same domain and reuse its skill_id. Preserves learned exec_strategy across
  re-captures and server restarts.
- **Carry forward exec_strategy**: Learned strategies from old endpoints transfer
  to matching new endpoints by URL template on re-capture.

### Execution strategy fixes

- **Removed domain strategy cache**: One 400 on LinkedIn was locking ALL endpoints
  into trigger-intercept. Strategy is now per-endpoint only.
- **Always try server-fetch first** for new endpoints before falling back.
- **Marketplace race timeout 15s→30s**: Trigger-intercept takes 20s on authed sites.

### Bug fix: Remove persistent profile from captureSession

- captureSession no longer tries to launch headed Playwright with a persistent
  profile directory. Eliminates SingletonLock crashes. Always uses ephemeral
  headless browsers with bird-style cookie injection.

## fix: endpoint ranking + auto-execute after capture

After capturing a site, unbrowse would return "Discovered N endpoints, pick one"
instead of executing the best match. Three root causes fixed:

### `src/reverse-engineer/index.ts` — smarter endpoint collapsing

`collapseEndpoints` was too aggressive — it merged distinct API actions
(e.g. `/relationships/connectionsSummary` + `/invitationsSummary`) into
`/relationships/{relationship}`. Added `looksLikeEntityId()` guard that only
allows collapsing when leaf segments look like entity IDs (UUIDs, numbers,
tickers), not camelCase action names or REST resource words.

### `src/execution/index.ts` — expanded BM25 synonyms + camelCase tokenization + stemmer fix

- Added synonym groups for social/content domains: feed, post, comment, message,
  notification, connection, profile, recommend, news, dashboard.
- `endpointToTokens` now splits long query param values on camelCase boundaries,
  so `voyagerFeedDashMainFeed` tokenizes as `[voyager, Feed, Dash, Main, Feed]`.
- Fixed stemmer: `messages` now stems to `message` (not `messag`), enabling
  synonym expansion for words ending in -ses, -ges, -ces, -zes.

### `src/orchestrator/index.ts` — auto-execute on confident ranking

Instead of always deferring, the orchestrator now auto-executes when:

- Top endpoint scores >= 30 (strong BM25 match)
- Top endpoint has a response_schema (confirmed JSON data)
- Score gap >= 5 over runner-up (clear winner)

### `src/capture/index.ts` — queryId-aware trigger-and-intercept

For graphql endpoints, the intercept now matches on the queryId name prefix
(e.g. `voyagerFeedDashMainFeed`) instead of just the base path (`/graphql`),
preventing it from intercepting the wrong graphql response.

## fix: auth reliability overhaul (bird-style cookie resolution)

Auth was unreliable due to multiple bugs: bidirectional domain matching, expired
cookies never filtered, stale vault cookies never refreshed from browser, missing
CSRF header replay, and inconsistent vault key naming.

Inspired by [bird](https://github.com/jawond/bird) which reads cookies fresh
from browser SQLite every time for zero-staleness auth.

### `src/domain.ts` — fix bidirectional domain matching

`isDomainMatch` had `c.endsWith("." + t)` which allowed `notgoogle.com` to match
`google.com`. Removed — now only matches when target equals or is a subdomain of
cookie domain.

### `src/auth/index.ts` — bird-style cookie resolution

- **`getAuthCookies(domain)`**: new unified resolver with fallback chain:
  vault cookies (fast) → auto-extract from Chrome/Firefox SQLite (fresh).
  No more manual `/v1/auth/steal` calls needed.
- **`filterExpired()`**: cookies with past `expires` are now filtered out on
  retrieval. Session cookies (expires <= 0) are kept.
- **`refreshAuthFromBrowser(domain)`**: on 401/403, auto-extracts fresh cookies
  from browser instead of just deleting stale ones.
- Vault keys normalized to registrable domain (`auth:example.com` not
  `auth:api.example.com`) with backward-compat fallback.

### `src/execution/index.ts` — CSRF replay + auto-refresh

- CSRF token auto-detection: scans cookies for `ct0`, `csrf_token`, `_csrf`,
  `XSRF-TOKEN`, `csrftoken` and sends as `x-csrf-token` header automatically.
- On 401/403: tries `refreshAuthFromBrowser()` before deleting credentials.
  Next retry will use fresh cookies.
- `executeBrowserCapture` and `executeEndpoint` now use `getAuthCookies()`
  (bird-style auto-extract) instead of manual vault lookups.

### `src/auth/browser-cookies.ts` — subdomain cookie extraction

`buildDomainWhereClause` only matched exact domain variants (`.linkedin.com`)
but missed subdomain-scoped cookies (`.www.linkedin.com` where `li_at` lives).
Added LIKE clause to match all subdomains, fixing LinkedIn/similar sites.

### `src/capture/index.ts` — trigger-and-intercept execution

New `triggerAndIntercept()` function: navigate to the page that originally
triggered an API call, let the site's own JS make the request (passing CSRF,
TLS fingerprinting, session validation), and intercept the response. This is
the generalized bird pattern — instead of replaying API calls ourselves, we
let the site's code handle auth and just capture the result.

Also: cookie injection logging, CSRF auto-detection in browser execution.

### `src/execution/index.ts` — 3-tier authed execution fallback

1. Server fetch (bird pattern — fast, works for Twitter/simple APIs)
2. Trigger-and-intercept (navigate page, intercept API call — works for LinkedIn)
3. Browser in-page fetch (last resort)

### `src/reverse-engineer/index.ts` — record trigger_url

Each endpoint now stores `trigger_url` — the page URL that triggered the API
call during capture. Used by trigger-and-intercept execution.

### `src/types/skill.ts` — trigger_url field

Added `trigger_url` to `EndpointDescriptor`.

## fix: skill not found after intent/resolve (cache-first publish)

After `POST /v1/intent/resolve` discovers endpoints, the returned `skill_id` was
immediately unusable — `GET /v1/skills/{id}` returned 404 because the local disk
cache was only written after a successful remote publish to `beta-api.unbrowse.ai`,
and EmergentDB's eventual consistency meant the backend hadn't indexed it yet.

### `src/marketplace/index.ts` — cache-first publish

`publishSkill()` now writes to `~/.unbrowse/skill-cache/` **before** calling the
remote backend. If the remote publish fails, the skill is still locally available
and the function returns the pre-cached version instead of throwing.

### `src/api/routes.ts` — add local `GET /v1/skills/:skill_id` route

Previously this fell through to the catch-all proxy which forwarded to the remote
backend. Now there's a dedicated local route that checks the disk cache first via
`getSkill()`, so recently published skills resolve immediately.

### `src/orchestrator/index.ts` — log publish errors

Fire-and-forget `.catch(() => {})` calls now log the error message instead of
silently swallowing failures.

## fix: stale skill auto-recovery + playwright auto-install

### `src/index.ts` + `scripts/setup.sh` — auto-install browser engine

`agent-browser` depends on `playwright-core` for browser automation, but browser binaries
are NOT bundled — users had to manually run `npx agent-browser install` after
`bun install`, which was undocumented and broke first-run experience.

Fix: the server now checks for Chromium on startup via `playwright-core`'s `executablePath()`
and auto-runs `npx agent-browser install` if missing. `setup.sh` also runs the install step
after dependency installation. Both fall back gracefully with a warning if the install fails.

### `src/api/routes.ts` — auto-recovery on stale 404

When executing a marketplace skill via `POST /v1/skills/:id/execute`, if the remote endpoint
returns HTTP 404 (stale/changed API), the handler now automatically falls through to
`resolveAndExecute()` to re-capture the site and get fresh endpoints. The response includes
a `_recovery` field explaining what happened.

Previously, agents received the raw 404 from the remote API with no context or recovery path.

### `src/execution/index.ts` — improved 404 error messages

When an endpoint returns 404, the error message now explains that the endpoint may be stale
and suggests re-running via `/v1/intent/resolve` to get fresh endpoints. Previously, the error
was just `"HTTP 404"` with the raw remote response body forwarded verbatim.

### `SKILL.md` — browser setup documentation

Added playwright chromium install step to the server startup section so users know the
browser engine needs to be installed on first run.

## fix: sec-ch-ua headless leak + token savings baseline

### `src/capture/index.ts` — sec-ch-ua override

Chromium 145+ auto-sets `sec-ch-ua: "HeadlessChrome";v="145"` independently of the spoofed `user-agent` string. LinkedIn, Google, and Cloudflare all read this header to detect headless browsers, causing them to return reduced/blocked responses.

Fix: always call `browser.setExtraHeaders()` with the correct Client Hints headers for Chrome 131 before navigation, regardless of whether `authHeaders` are provided. Auth headers are merged on top so they still take precedence.

```
sec-ch-ua: "Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
```

### `src/orchestrator/index.ts` — token savings baseline

`discovery_cost.capture_tokens` was being stamped with `ceil(deferralMessage.length / 4) ≈ 18 tokens` (the size of the tiny agent-first deferral JSON) instead of `DEFAULT_CAPTURE_TOKENS = 30_000`. This caused every subsequent marketplace cache hit to compute `tokens_saved = max(0, 18 - responseTokens) = 0`, making `total_tokens_saved` and `avg_tokens_saved_pct` always 0 in the platform stats.

Fix: always use `DEFAULT_CAPTURE_TOKENS` as the `capture_tokens` baseline, which correctly represents the LLM-browsing cost a downstream agent would incur doing this manually.

## fix: graceful browser shutdown + orphan cleanup (fixes #4)

### `src/capture/index.ts`

- **Browser registry**: `activeBrowserRegistry: Set<BrowserManager>` tracks every live browser instance. Registered on creation, removed in `releaseBrowserSlot()`.
- **`shutdownAllBrowsers()`** exported — calls `browser.close()` on all active instances in parallel via `Promise.allSettled`. Used by shutdown handlers in `src/index.ts`.
- **Per-capture hard timeout** (`CAPTURE_TIMEOUT_MS = 90_000`): each `captureSession()` race includes a 90-second wall-clock kill. If triggered, `browser.close()` is called before throwing a timeout error, freeing the slot and the process.
- `releaseBrowserSlot(browser?)` now accepts the browser instance and removes it from the registry on release.
- `executeInBrowser()` updated with the same registry pattern.

### `src/index.ts`

- **Startup orphan cleanup**: `pkill -f chrome-headless-shell` runs before `app.listen()` to kill leftover browser processes from previous crashed sessions.
- **`SIGTERM` / `SIGINT` handlers**: call `shutdownAllBrowsers()` then `app.close()` before exiting — ensures in-flight captures close cleanly on Ctrl-C or container stop.

## URN path segment parameterization

### `normalizeUrl()` now detects URN identifiers (`src/reverse-engineer/index.ts`)

- **URN pattern**: Path segments like `urn:li:fsd_profile:ACoAAB3fei4B...` are now replaced with `/{urn}` during URL normalization, just like UUIDs and numeric IDs.
- **`templatizePathSegments()`** handles the new `{urn}` placeholder — captures the original URN as a default value and renames the param based on the preceding path segment.
- Fixes skills for LinkedIn (and other URN-based APIs) hardcoding specific profile/entity URNs instead of parameterizing them.

## Real discovery cost tracking + token savings in traces

### Discovery cost on skills (`src/types/skill.ts`, `backend/src/types.ts`)

- **`DiscoveryCost` interface**: New optional `discovery_cost` field on `SkillManifest` records `capture_ms`, `capture_tokens`, `response_bytes`, and `captured_at` from the original live capture.
- **Stamped during live capture** (`src/orchestrator/index.ts`): After a browser capture discovers a skill, the actual capture time and token cost are measured and attached to the skill before publishing. Future marketplace cache hits use these real baselines instead of hardcoded estimates (22s / 30K tokens).

### Token fields in ExecutionTrace (`src/types/skill.ts`, `backend/src/types.ts`)

- **`tokens_used`**: Estimated tokens consumed by the response.
- **`tokens_saved`**: Tokens saved vs original capture cost (0 for live captures).
- **`tokens_saved_pct`**: Percentage tokens saved vs original capture cost.
- These fields are stamped by the orchestrator and persist in trace files (`traces/*.json`) and backend reporting.

### Real baselines in finalize (`src/orchestrator/index.ts`)

- **`finalize()` reads `skill.discovery_cost`** when computing token/time savings. Falls back to the old hardcoded estimates (30K tokens, 22s) only for legacy skills without `discovery_cost`.
- **Console log indicates baseline source**: `[real baseline]` vs `[estimated]` so you can tell at a glance which skills have been re-measured.

## Agent-first endpoint selection + ad schema filtering

### Always defer to agent on fresh captures (`src/orchestrator/index.ts`)

- **Removed BM25 ambiguity heuristic**: The old logic auto-executed when the top endpoint had a score lead, which often picked wrong (ad endpoints, tracking, config blobs). Now fresh captures always return the endpoint list and let the calling LLM agent choose.
- **Agent-specified endpoint_id still auto-executes**: When the agent has already picked an endpoint, it executes directly without deferral.

### Schema-based ad endpoint filtering (`src/reverse-engineer/index.ts`)

- **`looksLikeAdResponse()`**: Detects ad/tracking endpoints by response body vocabulary (campaignId, creativeId, creativeContent, etc.) regardless of hostname. Prevents junk skills from being published.
- **`facet-futures.` added to AD_HOSTS**: Blocks the betting/odds ad network that Dotabuff uses.

### Always surface available_endpoints (`src/api/routes.ts`)

- **Removed `length > 1` gate**: `available_endpoints` is now returned even when only 1 endpoint exists, so the agent always sees what was discovered.

## LLM-driven endpoint selection — expose endpoints to the agent

### Endpoint labeling (`src/execution/index.ts`)

- **`deriveEndpointLabel()` generates human-readable labels**: Extracts meaningful names from endpoint URLs. GraphQL queryIds like `voyagerFeedDashMainFeed.abc123` become "Feed Main Feed". REST paths like `/voyager/api/relationships/dash/connections` become "Relationships: Connections". Labels are derived by splitting camelCase, dropping common prefixes (voyager, dash, com), and capitalizing meaningful words.
- **Exported for use by routes**: Both `rankEndpoints` and `deriveEndpointLabel` are exported so the API layer can build rich endpoint metadata.

### Enriched `available_endpoints` in API responses (`src/api/routes.ts`)

- **Labels added**: Each endpoint in `available_endpoints` now includes a `label` field with the human-readable name.
- **Response hints**: When an endpoint has a response schema, `response_hint` lists the top-level property keys (e.g. `["data", "included"]`).
- **Limit increased from 5 to 15**: Complex sites (LinkedIn, Facebook) can have 40+ endpoints — surfacing only 5 was insufficient for the agent to find the right one.
- **Execute route also surfaces endpoints**: `POST /v1/skills/:id/execute` now includes `available_endpoints` so the agent can pick a different endpoint without going back to intent/resolve.

### Ambiguous score deferral (`src/orchestrator/index.ts`)

- **BM25 ambiguity detection**: When a newly captured skill has 5+ endpoints and the top two scores are within 5 points, the orchestrator does NOT auto-execute. Instead it returns the skill + ranked endpoints with a message telling the agent to pick.
- **Clear winner auto-executes**: When the top endpoint has a significant score lead, it auto-executes as before.

## Fix: SPA capture rewrite — direct request/response pair capture

### Capture rewrite (`src/capture/index.ts`)

- **Direct request/response pair capture**: Replaced the broken two-source approach with a single `page.on("response")` handler that captures the full request+response pair. Now captures 40+ endpoints from LinkedIn vs 3 before.
- **Network idle detection replaces fixed 5s wait**: Polls until no new responses arrive for 2s (max 8s).
- **Scroll simulation triggers lazy-loaded content**: 3 scroll steps with network idle waits between.

### Endpoint collapse fix (`src/reverse-engineer/index.ts`)

- **GraphQL endpoints exempt from collapse**: Endpoints with `queryId` or `query` params, or paths containing `graphql`, are never collapsed.
- **API sub-resource endpoints exempt from collapse**: Paths matching `/api/` with 3+ segments are kept separate.
- **Vendor JSON types scored correctly**: `scoreRequest()` now awards the +4 content-type bonus for `+json` types.

### Orchestrator quality gate (`src/orchestrator/index.ts`)

- **HTML-postprocessed results rejected**: When a marketplace skill returns HTML that gets DOM-extracted, the orchestrator rejects it and falls through to the next candidate or live capture.

### DOM skill publishing gate (`src/execution/index.ts`)

- **Low-confidence DOM skills not published**: DOM-extracted skills below 0.4 confidence are no longer published.
- **CamelCase tokenization in BM25 endpoint selection**: `endpointToTokens()` now splits camelCase identifiers.

## BUG-006: Path segments now parameterized instead of hardcoded

### Bug fix

- **Dynamic path segments are now templatized**: When a live capture discovers API endpoints like `/api/v3/quote/SPY,QQQ`, the reverse-engineer now detects dynamic segments and replaces them with named template variables (e.g. `{quote}`), storing the original values as defaults in `endpoint.path_params`. Previously, these values were hardcoded, making skills unusable for different inputs (e.g. requesting TSLA data would always return SPY/QQQ).
- **Two detection strategies**: (1) Comma-separated path segments are always parameterized — a strong signal for lists of identifiers. (2) Context-aware matching — path segments that appear in the captured page URL are detected as entities and parameterized (e.g. capturing `/en/coins/bitcoin` parameterizes `bitcoin` in API paths like `/price_charts/bitcoin/usd/24_hours.json`).
- **Execution merges path_params as defaults**: `executeEndpoint()` now merges `endpoint.path_params` into the params object before URL interpolation. User-provided params override defaults, so `{quote: "TSLA"}` replaces the captured `SPY,QQQ`.
- **Improved dedup**: `normalizeUrl()` now collapses comma-separated path segments for deduplication, preventing multiple endpoints from being created for the same API path with different identifier lists.

## Fix: Endpoint ranking noise filter and data-relevance scoring

### Bug fix

- **Comprehensive noise host filtering in rankEndpoints**: The endpoint auto-selector was choosing ad trackers, consent managers, and analytics endpoints (id5-sync, btloader, onetrust, adsrvr, googlesyndication, etc.) over actual data endpoints. Added a NOISE_HOSTS blocklist matching 30+ known noise domains, aligned with the reverse-engineer's existing `SKIP_HOSTS` filter.
- **Off-domain penalty (-20)**: Endpoints hosted on third-party domains now receive a -20 score penalty instead of just missing the +15 on-domain bonus. This prevents ad/tracking endpoints from outranking on-domain data.
- **Auth/config path penalty (-15)**: On-domain noise like `/csrf_meta`, `/logged_in_user`, `/analytics_user_data`, `/onboarding` paths are now penalized.
- **Meta/support path penalty (-10)**: Supplementary endpoints like `/insight_annotations`, `/sentiment_votes`, `/portfolio/summary_card` are demoted in favor of actual data endpoints.
- **Currency/time path bonus (+12)**: Paths containing currency codes (`/usd`, `/eur`, `/btc`) or time ranges (`/24_hours`, `/7_days`, `/daily`) get a relevance boost for price/financial intents.
- **Data format bonus (+5)**: Endpoints with `.json`/`.xml`/`.csv` extensions or `/api/` paths get a small lift.

## BUG-005: Captured query params not applied during skill execution

### Bug fix

- **Query params now merged into URL during execution**: When an endpoint was captured with query parameters (e.g. `?query=FDRY`), the reverse-engineer correctly stored them in `endpoint.query`, but `executeEndpoint()` never applied them to the outbound request URL. This caused 400 errors for any endpoint that required query parameters. Now merges `endpoint.query` into the URL via `URL.searchParams`, with user params overriding captured defaults.

## Fix: Skill Publishing Race Condition

- **Backend returns full manifest on publish**: `POST /v1/skills` now returns the complete skill manifest instead of just `{ skill_id, version }`, eliminating the read-after-write round-trip that failed due to EmergentDB eventual consistency.
- **KV write errors surfaced**: `putBatch()` now checks `qdkv/set` response status and throws on failure instead of silently ignoring write errors.
- **Client uses returned manifest**: Local `publishSkill()` no longer re-fetches from backend after publishing, fixing "Published skill not found in backend after retries".

### Breaking changes

- **Registration now requires ToS acceptance**: `POST /v1/agents/register` requires a `tos_version` field matching the current version. Requests without it receive a 400 error with instructions.
- **All local routes gated behind API key**: The local Fastify server now returns 401 on all routes (except `/health`) when no API key is configured.
- **Existing agents must re-accept ToS**: Agents registered before this change will receive a 403 `tos_update_required` error on authenticated requests until they accept the current ToS.

### New features

- **ToS version tracking**: Agent profiles now store `tos_accepted_version` and `tos_accepted_at`. When ToS is updated, agents must re-accept before their key works.
- **CLI ToS prompt**: On first startup (or when ToS is updated), the CLI displays a ToS summary and prompts for explicit acceptance before proceeding.
- **`GET /v1/tos/current`**: New public endpoint returning the current ToS version, summary, and URL.
- **`POST /v1/agents/accept-tos`**: New authenticated endpoint for re-accepting updated ToS.
- **Frontend ToS checkbox**: The API key generator now requires checking a ToS agreement checkbox before registration.

## Legal Entity & Terms of Service

- Added Terms of Service page (`/terms`) establishing Unreel AI Pte Ltd as the legal entity operating unbrowse
- Updated Privacy & Data Sharing page to reference Unreel AI Pte Ltd
- Added copyright notice and entity attribution to site footer
- Added Terms link to footer navigation

## Security & Legal Hardening

### Marketing language

- Removed "bypass the need for official API documentation" and "discover hidden APIs" from all docs
- Replaced with neutral language: "discover API endpoints", "work without official API documentation"

### Data privacy

- `recordExecution()` no longer sends `trace.result` (actual API response data) to the backend — only metadata (success, status_code, latency, drift) is transmitted for scoring

### Network security

- Default bind address changed from `0.0.0.0` to `127.0.0.1` — server is localhost-only by default

### Credential sanitization

- Added `x-api-key`, `api-key`, `x-auth-token`, `x-app-key`, `x-app-secret` to header strip list
- Added prefix stripping for `x-auth-*`, `x-amz-security-*`, `x-stripe-*`, `x-firebase-*`
- Added catch-all: any header containing `token`, `key`, `secret`, `credential`, or `password` is stripped (unless on the safe-header allowlist)
- New: query parameters with sensitive names (`api_key`, `access_token`, `secret`, etc.) are stripped from URL templates before publishing

### Licensing

- Expanded LICENSE to full MIT text with copyright notice
- Added LICENSE file to packages/skill/ for the published repo

---

## Documentation: Surface Marketplace & Community Features

SKILL.md, README.md, and packages/skill/README.md previously described unbrowse as a local-only tool. Updated all docs to surface the shared marketplace architecture.

### SKILL.md

- Rewrote overview to describe marketplace-first architecture
- Added "How Intent Resolution Works" section (orchestrator priority chain, composite scoring)
- Added "Reporting Issues" section with API example and category list
- Added "Endpoint Selection" section (merged from packages/skill variant)
- Added `/v1/search/domain` and issue routes to API reference table
- Removed "(proxied to beta API)" noise from route table
- Expanded feedback section to explain auto-deprecation consequences
- Added rule about issue reporting

### README.md

- Added "How it works" section explaining local + marketplace hybrid architecture
- Added "Architecture" section covering backend components (KV, EmergentDB, Gemini, Unkey, scoring)
- Added "Marketplace" section covering discovery, lifecycle, reliability scoring, issues, agents
- Added `~/.unbrowse/config.json` to data directories
- Added `UNBROWSE_API_KEY` to environment variables

### packages/skill/

- Updated README.md opening description and "How it works" to mention shared marketplace
- Added "Marketplace" section with auto-registration details
- Converted SKILL.md to symlink pointing to root SKILL.md (single source of truth)

---

## DOM Fallback Extraction

When no API endpoints are discovered (SSR sites, static pages, JS-rendered content with no XHR), unbrowse now automatically falls back to extracting structured data from the rendered DOM.

### New `src/extraction/` Module

- **`cleanDOM(html)`:** Strips scripts, styles, nav/footer chrome, ads, hidden elements. Prefers content inside `<main>`, `<article>`, `[role="main"]`
- **`parseStructured(html)`:** Heuristic extraction of tables, lists, repeated card patterns, definition lists, JSON-LD, and Open Graph meta tags
- **`extractFromDOM(html, intent)`:** Scores extracted structures by relevance to user intent, returns best match with confidence score

### Capture Layer

- `captureSession()` now returns rendered HTML (`html` field on `CaptureResult`) via `page.content()` before closing the browser

### Execution Layer

- When `extractEndpoints()` finds 0 API endpoints, the execution layer now tries DOM extraction, **publishes a DOM skill** with the mapping, and returns structured data
- **HTML post-processing:** when any endpoint returns HTML instead of JSON, it's automatically piped through `extractFromDOM()` to produce structured data (source: `html-postprocess`)
- DOM extraction results include `_extraction` metadata (method, confidence, source)
- Orchestrator tracks `"dom-fallback"` as a distinct result source alongside `"marketplace"` and `"live-capture"`
- **Agent-driven endpoint selection:** responses now include `available_endpoints` listing all discovered endpoints so the calling agent can pick the right one and retry with `endpoint_id` if the auto-selected one is wrong
- Static asset URLs (`.woff`, `.css`, `.js`, `.png`, etc.) are now filtered from endpoint candidates
- Endpoints with `dom_extraction` metadata are preferred by the auto-selector (+25 score)

---

## Chrome Cookie Extraction, Direct HTTP Execution & CSRF Support

### Chrome Cookie Extraction (macOS)

- **`extractChromeCookies(domain)`:** Reads cookies directly from Chrome's SQLite database at `~/Library/Application Support/Google/Chrome/Default/Cookies`, decrypts using the Chrome Safe Storage key from macOS Keychain (PBKDF2 + AES-128-CBC)
- **`yoloExtract(domain)`:** One-call auth — extracts and stores cookies in the vault with yolo flag. No browser launch, no profile locks, instant
- **Clean filtering:** Only extracts exact domain matches (`.x.com`, `x.com`), rejects cookies with non-printable characters from incomplete decryption
- **Wired into `/v1/auth/login`:** When `yolo: true` on macOS, uses cookie extraction first before falling back to browser-based login

### Direct HTTP Execution

- **Skip browser for API calls:** When auth cookies exist and the endpoint URL contains `/api/`, uses `fetch()` directly instead of launching a browser. Eliminates headless detection issues (HeadlessChrome in sec-ch-ua)
- **Cookie header construction:** Builds cookie header from vault cookies for direct HTTP requests

### CSRF Auto-Injection

- **`csrf_plan` support:** If an endpoint has a `csrf_plan`, extracts the named cookie and sets it as `x-csrf-token` header
- **x.com heuristic:** Automatically injects `ct0` cookie as `x-csrf-token` when endpoint uses `x-twitter-auth-type`

### Other Improvements

- **Fixed vault location:** Changed from `process.cwd()/.vault/` to `~/.unbrowse/vault/` so vault works regardless of server CWD
- **Endpoint targeting:** Added `endpoint_id` param to `executeSkill` to bypass auto-endpoint selection
- **URL-safe interpolation:** Query string params are now `encodeURIComponent`-encoded during URL template interpolation
- **Exported Chrome helpers:** `getMainChromeProfilePath`, `getChromeUserDataDir`, `getChromeExecutablePath` now exported for use by capture module
- **Yolo flag in vault:** Stored alongside cookies so capture module can detect yolo-authenticated domains
- **`isYoloAuth(domain)`:** Checks if a domain was authenticated via yolo mode

---

## Yolo Mode: Use Main Chrome Profile for Login

- **Yolo login:** `POST /v1/auth/login` now accepts `"yolo": true` to open the user's real Chrome browser with their existing sessions — no re-login needed for sites they're already authenticated on
- **Chrome detection helpers:** Cross-platform (macOS/Windows/Linux) helpers to find Chrome's profile path, executable, and check if Chrome is running via `SingletonLock`
- **Safety checks:** Returns clear errors if Chrome isn't installed or is currently running (Playwright can't share the profile lock)
- **Skill docs updated:** All three SKILL.md files updated with yolo login instructions and the required user consent prompt

---

## WebSocket Capture, Endpoint Filtering & Validator Fixes

### WebSocket Support

- **CDP-based WebSocket capture:** Hook `Network.webSocketCreated`, `webSocketFrameReceived`, `webSocketFrameSent` via Chrome DevTools Protocol to capture real-time WS traffic during browser sessions
- **WS endpoint extraction:** Group captured messages by URL, infer response schemas from received JSON frames, create `method: "WS"` endpoints with `ws_messages` array
- **WS execution:** Connect to WebSocket endpoints, collect messages for 7s, parse JSON, apply projection
- **Type updates:** Added `"WS"` to `EndpointDescriptor.method` union and `WsMessage` interface in both `src/types/skill.ts` and `backend/src/types.ts`

### Backend Validator Fixes

- **Accept WS method:** Added `"WS"` to `VALID_METHODS` in `backend/src/services/validator.ts`
- **Accept wss:// URLs:** Changed `URL_RE` from `/^https?:\/\//` to `/^(https?|wss?):\/\//`
- **Local workaround:** Strip WS endpoints before publishing to remote backend (pending deployment) — keeps WS endpoints for local execution

### Endpoint Filtering Improvements

- **Fixed SKIP_EXTENSIONS regex:** Changed `$` anchor to `([?#]|$)` so URLs with query strings are properly filtered (`.js?v=hash`, `.css?t=123`)
- **Added SKIP_PATHS:** Filter `/_next/static/`, `/static/chunks/`, `/static/media/`, `/cdn-cgi/` paths
- **Added CDN image path filter:** Skip `/coin-image/`, `/avatar/`, `/profile-image/` paths
- **Expanded SKIP_HOSTS:** Added 16 new infrastructure/telemetry domains: datadoghq, fullstory, launchdarkly, intercom, privy, mypinata, sentry, segment, amplitude, mixpanel, hotjar, clarity, googletagmanager, walletconnect, imagedelivery, cloudflareinsights

### Endpoint Selection Improvements

- **Domain affinity scoring:** `selectBestEndpoint` now takes `skillDomain` param and adds +15 score for endpoints on the skill's own domain (prevents selecting third-party CDN/analytics endpoints)
- **WS schema bonus:** WS endpoints with response schemas get +3 score

---

# Previous Changes

**Base commit:** `f1bd8e3` — "fix: resolve GC-001 through GC-008 and GC-012"
**Current:** `334bf51` + uncommitted changes
**Files changed:** 32 files, +987 / -205 lines (committed) + ~113 lines uncommitted

---

## Agent Identity, Issue Reporting & Agent-First Frontend

### Backend: Agent Identity via Unkey

- **Unkey integration:** API key management via Unkey REST API (v2). Keys prefixed `ubr_`, verified on every request. Agent profiles stored in `STATS_KV`.
- **Auth middleware rewrite:** Dual-check legacy admin key OR Unkey-verified agent keys, sets `agent_id` in Hono context. Added `optionalAuth` for public-but-identity-aware routes.
- **Agent service:** `registerAgent()` creates Unkey key + KV profile. `incrementAgentExecutions()`, `incrementAgentFeedback()`, `addSkillDiscovered()` track contributions.
- **Agent routes:** `POST /v1/agents/register` (public), `GET /v1/agents/me` (auth), `GET /v1/agents/:id` (public), `GET /v1/agents` (public)
- **Stats summary:** `GET /v1/stats/summary` now includes `agents` count
- Backward-compatible: existing `UNBROWSE_API_KEY` env continues to work

### Backend: Issue Reporting

- **Issue service:** Agents can report problems with skills for repair. Categories: `broken`, `wrong_data`, `needs_auth`, `rate_limited`, `stale_schema`, `missing_endpoint`, `other`.
- **Issue routes:** `POST /v1/skills/:id/issues` (auth), `GET /v1/skills/:id/issues` (public), `PATCH /v1/skills/:id/issues/:issue_id` (admin)
- Issues stored in `STATS_KV` with per-skill index (capped at 100)

### Frontend: Agent-First Onboarding

- **Auth context:** `auth-context.tsx` — localStorage-backed API key management
- **Landing page:** Added "Get Your API Key" onboarding section with registration API docs, interactive key generator, tabbed install instructions (Claude Code, Cursor, cURL, Python)
- **New components:** `ApiKeyGenerator`, `InstallInstructions`
- **New pages:** `/dashboard` (agent profile + stats), `/skills/[id]` (skill detail + endpoints), `/agents/[id]` (public agent profile)
- **Updated:** Navbar (Dashboard link), StatsStrip (agents count), Footer (Dashboard link)

### CLI Client

- Added `registerAgent()`, `getAgent()`, `getMyProfile()` in `src/client/index.ts`

---

## Committed Changes (8 commits)

### 1. Frontend: Full Landing Page Revamp (`e2f4711`)

- Replaced the entire landing page with a new design
- **Constellation background** — animated particle system with mouse interaction
- **Interactive chat demo** — shows an Airbnb API discovery flow step-by-step
- Streamlined from many sections down to 5: hero, demo, how-it-works, architecture, CTA
- Removed bloated sections (stats strip, endpoint cards, flywheel, example output)
- Added **privacy & data sharing page** (`/privacy`)
- Replaced text logos with anvil logo + full favicon set
- Defaulted to dark theme
- Updated install command to `npx skills add https://github.com/getfoundry/unbrowse --skill unbrowse`
- Darkened the CSS color palette (surface, border, glow values)

### 2. Live Stats Strip & Value Prop Cards (`f27c9d8`)

- **New public endpoint:** `GET /v1/stats/summary` — returns skills, endpoints, domains, executions counts
- Split stats routes into public (summary) and protected (execution/feedback)
- Added 3 value prop cards: save money (40x fewer tokens), save time (100x faster), make money (any site = API)
- Added **StatsStrip** component fetching real counts from the backend
- Added **NVIDIA Inception badge** in footer
- Fixed GitHub URLs: `anthropics/unbrowse` → `getfoundry/unbrowse`

### 3. Backend CORS & Public Routes (`7baae52`, `8ca2989`)

- Added global CORS middleware (`origin: *`, all methods)
- Made search routes public (no auth required)
- Added explicit `Access-Control-Allow-Origin` header on stats summary
- Reduced stats cache from default to 60s

### 4. Headed Capture & GraphQL Dedup (`9d4647a`)

**Capture improvements:**

- Always use persistent browser profile in **headed mode** (not headless) for auth-gated sites like LinkedIn
- Hook `page.on('response')` BEFORE navigation to catch all XHR/fetch during initial load
- Broadened response body capture: now includes `text/plain`, protobuf, `batchexecute`, `/api/` paths
- Increased settle wait from 2.5s to 5s for SPAs like Google Trends

**Reverse-engineer improvements:**

- Preserve `queryId` param in GraphQL URL normalization so different queries aren't deduped
- Strip Google-style JSON prefixes (`)]}'`) before parsing response bodies
- Added `batchexecute` and `/api/` to RPC hint patterns
- Skip endpoints with invalid (non-http) URL templates

**Other:**

- Hardcoded backend API URL to `https://beta-api.unbrowse.ai`
- Generate `skill_id` with `nanoid()` in draft to fix backend validation
- Raised confidence threshold from 0.25 to 0.5

### 5. Remove DELETE Skills Route (`334bf51`)

- Removed `DELETE /v1/skills/:id` — skills should not be deletable via API
- Cleaned up unused `deprecateSkill` import

### 6. Bug Fixes (`baf28f6`, `0af0908`)

- Added `POST /v1/feedback` route (proxies to backend, accepts both `skill_id` and `target_id`)
- Fixed logger import paths (`./logger.js` to `../logger.js`) in auth and capture modules
- Removed duplicate `har_lineage_id` declaration
- Removed extra closing brace in `interactiveLogin()`
- Added `beta.unbrowse.ai` route to wrangler config
- Fixed `tsconfig.json`

---

## Uncommitted Changes (working tree)

### 7. Make Read Routes Public, Keep Writes Protected

- **Skills routes split:** `GET /skills`, `GET /skills/:id`, `GET /skills/:id/endpoints/:eid/schema` are now public (no auth)
- Only `POST /skills` and `PATCH /skills/:id/endpoints/:eid` still require auth
- **Validate route made public:** `POST /v1/validate` moved out of auth-protected group

### 8. API Client Auth Flag

- Added `auth` parameter to the `api()` helper in `src/client/index.ts`
- Read-only calls (GET) no longer send `Authorization` header
- Write calls (`POST`, `PATCH`, `DELETE`) explicitly pass `auth = true`

### 9. KV Fallback Search in Discovery

- Vector search (`searchIntent`, `searchIntentInDomain`) now catches errors and falls back to **keyword search over KV**
- New `kvFallbackSearch()` does term matching against skill name, intent_signature, description, and domain
- Changed global namespace from `unbrowse--global` to `unbrowse-skill`

### 10. Confidence Threshold Tuned Down

- Lowered confidence threshold from 0.5 to 0.3 (was originally 0.25 before previous commits)

### 11. Local Graph Harness Expanded

- Added local cache case generation so graph-v2 retrieval can be evaluated against real cached skills without the remote server
- Added dependency-walk simulation using example bindings to validate that graph edges unlock the right downstream operation
- Added local timing metrics for selection speed and time-to-correct-operation, plus wrong-selection counts before the right operation

### 12. Remote Truth, Local Debug Only

- Removed disk-snapshot skill reads from the default resolver path so runtime selection no longer prefers stale local cache over shared remote skills
- Changed `getSkill()` to fetch remote first; local disk snapshots now remain explicit harness/debug artifacts instead of runtime truth

### 13. Better Local Semantic Authoring

- Reverse-engineering now writes richer local endpoint descriptions from captured request/response context before publish
- Semantic examples now flatten request inputs and compact response examples so future skills carry clearer action/resource hints and dependency inputs
- Auth-backed captures now mark learned endpoints as `auth_required` so graph retrieval and local evals can keep public/auth-gated coverage separate
- Graph inference now derives stronger `provides` bindings from fields like `full_name`, `public_identifier`, `owner`, `username`, and `slug` so real captured skills form better dependency edges
- Graph selection now uses a hybrid filter path: hard-drop near-certain junk (`telemetry`, `experiments`, `ads`, wrong-status/auth/config endpoints) and soft-penalize ambiguous helper/settings/recommendation endpoints before semantic ranking
- Product-truth CLI coverage now includes explicit public and auth-gated resolve/execute flows, and `AGENTS.md` now requires product-behavior tests to go through the CLI/orchestrator path instead of raw capture primitives
- Local API routes now reopen freshly learned in-memory skills before remote publish/index catch-up, so a deferred CLI `resolve` can immediately follow with `execute` on the same server process
- Added a dedicated CLI judged eval runner that grades actual CLI/orchestrator output with the Nebius judge model across public and auth-gated cases, instead of relying on plumbing heuristics alone
- Root-cause quality gates now reject low-quality DOM fallback output before returning success, learned skills retain the actual capture intent instead of only the domain, extraction hints rank arrays by intent semantics, and CLI auto-extract only fires on high-confidence hints
- Browser-capture execute now falls back to trigger URLs from the learned skill when the caller has no explicit `params.url`, and merged endpoints are normalized to valid manifest verification states before republish
- The judged CLI eval now preserves original `url` and `intent` when it follows a deferred `resolve` with `execute`, so browser-capture and dynamic skills are graded through the real end-user context
- DOM extraction now has stronger GitHub/LinkedIn HTML parsers, and auto-exec now synthesizes safe defaults for common missing query params (`limit`, `page`, `resolve`, some `type` values) instead of deferring immediately
- Runtime is API-first again: HTML from non-DOM endpoints now fails clean instead of being treated as content, internal API candidates get a stronger preference over DOM during auto-exec, and multi-entity API payloads are projected to the intent-matching entity set before return/judging
- GitHub search fallback now reads the embedded JSON result payload directly, and Mastodon-style search endpoints now infer public-safe defaults like `type=statuses` with `resolve=false` for post intents
- Browser capture now learns a replayable page-artifact endpoint alongside discovered APIs when the captured page already contains structured data, so the orchestrator can try API replay first and then fall back to the captured page artifact on the next attempt

---

## Summary by Area

| Area                 | What changed                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Frontend**         | Complete landing page redesign with constellation bg, chat demo, privacy page, NVIDIA badge |
| **Backend API**      | Global CORS, public stats/search/skills/validate routes, removed DELETE skills              |
| **Capture**          | Headed mode for auth sites, pre-nav response hooking, broader body capture, longer settle   |
| **Reverse-engineer** | GraphQL dedup fix, JSON prefix stripping, batchexecute support                              |
| **Discovery**        | KV fallback search when vector search fails, new namespace                                  |
| **Client**           | Hardcoded prod API URL, auth flag on write-only calls                                       |
| **Orchestrator**     | Confidence threshold tuning (0.25 → 0.5 → 0.3)                                              |

- fix: reject auto-exec results unless they semantically satisfy the intent; judge skips no longer count as success
- fix: add generic DOM extraction for social post rows and trending topic rows so page-artifact fallback rescues empty API captures
- fix: CLI judged eval now falls back to local semantic grading when the remote judge returns skip
- fix: make browser capture actively stimulate dynamic search/explore pages after navigation so SPA-only APIs have a chance to fire before skill generation

- fix: normalize nested trend payloads into topic rows so runtime/evals can accept valid trending results
- fix: DOM replay now rejects stale selector hits that no longer match the requested entity type and falls back to fresh page extraction
- feat: add local agent-phase eval harness over the 100-site project dataset with separate index and retrieve phases plus concurrent client support
- fix: agent-phase eval now groups by target id for exact 100-site coverage and auto-restarts the local server if it dies mid-run
- feat: agent-phase eval now uses an LLM judge on returned data, with local semantic fallback when the judge skips or times out
- fix: route-cache reuse now applies to normal resolve calls, and capture-cache reuse is marked as a real cache hit for phase evals

# Unreleased

- feat: add server-owned skill provenance and staged graph promotion so first unverified publishes stay shadow-only until independently corroborated or verified
- feat: verify signed release manifests on publish, stamp release-attestation provenance server-side, and require endpoint-level corroboration before brand-new endpoints on public skills enter the shared graph
- build: make the npm CLI package binary-only, sync only `SKILL.md` to the standalone skill repo, and publish release assets before npm so installs can fetch the tagged native binary immediately
- fix: materialize under-specified root eval cases into real-world intent URLs before strict judged agent-phase runs
- fix: reuse learned skills by domain plus compatible intent instead of merging unrelated captures into one polluted skill
- fix: strip self-referential page URL params before minting replayable page-artifact endpoints
- fix: thread original context URL and intent through execute so page-artifact skills replay against the real page, not generic domain fallbacks
- fix: rank endpoints with semantic action/resource intent matching so wrong-entity auth-page APIs stop outranking the correct search surface
- fix: queue concurrent live captures per client/domain instead of failing fast when multiple agent requests hit the same site at once
- fix: serialize live captures per domain across clients so shared browser profiles do not corrupt concurrent auth-site captures
- fix: fall through from wrong-entity marketplace candidates to real live capture instead of deferring same-domain junk skills

# Unreleased

- docs: correct the agent-facing workflow split so fresh `sync` / `close` captures are treated as publish-review material (`skill` / `publish --pretty` / `review` / `publish`), while `resolve` stays the reuse surface for already indexed/published contracts
- fix: retry browser capture without persistent profile only for sparse blocked-shell captures; keep rich API captures and bound browser close time so x profile/trending resolves no longer hang
- test: add focused graph dependency-inference unit coverage so DAG edge generation is asserted directly, not only through higher-level walk tests
- feat: agent-facing chunk responses now show only runnable operations in a readable format with a suggested next step, while raw graph/dependency data stays internal
- fix: agent-phase eval now kills hung CLI subprocesses, times out stalled phases, and rewrites artifacts after every completed case so benchmark runs stay observable
- fix: agent-phase eval now records which stage timed out (`auth`, `resolve`, `execute`, `judge`) so benchmark failures point to the real bottleneck
- fix: agent-phase eval now kills leaked `src/cli.ts --no-auto-start` clients before and after runs, and force-kills timed-out CLI subprocesses so stale benchmark traffic no longer poisons the local server
- fix: stale eval cleanup now matches both relative and absolute `src/cli.ts` / `evals/agent-phases.ts` process paths, which were the real leaked-process source on local benchmark runs
- fix: stale eval cleanup now excludes the currently running harness process instead of killing its own benchmark run on startup
- fix: orchestrator live-capture queue now has a hard timeout around both in-flight waits and browser-capture execution, so one hung capture cannot poison all later requests for that domain
- fix: normal-mode skill reopen now falls back to recent in-memory skills when remote read-after-write lags, so same-process route-cache retrieve stops recapturing freshly learned domains
- fix: same-process skill lookups now prefer the fresh in-memory learned skill over remote merged copies, preventing retrieve from reopening polluted domain-wide skills during strict evals
- fix: freshly generated live-capture skills are now promoted into broad route/domain reuse only after they actually answer the originating intent, instead of caching bad deferrals for later retrieves
- fix: generation-time semantic admission now understands company/org and stricter post/comment entities, blocking metadata/subreddit-shell captures from becoming reusable skills

# Unreleased

- fix: strict browse-session liveness now retries through transient empty tab discovery after submit/navigation churn instead of expiring the session immediately
- fix: strict browse-session checks now prefer the freshly selected broker client for the session port, avoiding stale cached client objects after broker churn
- fix: URL-targeted browse submits no longer treat same-page HTML/filter churn as success, so parks-selection style flows fall back to the real same-origin transition path instead of fabricating the next step URL
- debug: Kuri broker exit logs now include child pid, signal, broker port, and CDP port to make real crash-vs-kill diagnosis observable in staging/package repros
- fix: dead Kuri broker clients are now evicted from the per-port cache on stop/exit so later requests can build a fresh restartable client state
- fix: Kuri startup/tab creation now waits for CDP readiness and retries raw Chrome tab creation instead of failing immediately during broker churn
- fix: browse routes now preserve per-session broker client affinity so restart paths can keep the session-owned browser state instead of drifting to a different broker client
- fix: successful submit no longer flushes/restarts capture mid-step; capture stays live until explicit `sync` or `close`, reducing session churn from step transitions
- docs: sync the canonical repo whitepaper to the April 1 arXiv draft and refresh the paper landing page metadata, authors, subtitle, and abstract
- fix: replace placeholder Kuri/capture TODO suites with real live-browser end-to-end coverage and promote deterministic CLI/P0-P1 regression checks into the default test lane
- fix: repair backend live route/test wiring and add bounded rate-limit retries so `bun run test:all` completes green against the current live graph backend
- docs: add canonical `test:e2e:truth` and `test:claims` lanes so user-visible behavior has an explicit live/e2e gate separate from unit coverage
- fix: planner now treats captured query/path/example defaults as satisfiable bindings, so replayable APIs stop losing readiness to page artifacts on warm resolve
- fix: semantic ranking now demotes linkedin sharebox/mailbox ui payloads for people/company intents and boosts real search/detail surfaces
- feat: merjs visual lab now boots a real standalone `@json-render/react` surface from `/api/viz-spec`, so arbitrary prompt + payload sessions stream into spec-driven analytics UI inside the native desktop shell
- fix: semantic intent scoring now distrusts mislabeled ui-scaffold endpoints, so generated sharebox/mailbox/notification skills stop stealing people/company search intents
- fix: scoped warm-result cache now reuses recently validated results on the same route/intent, preventing slow recapture on immediate retrieve
- pre-commit now runs DAG/replay regressions plus strict real-world `agent-phases` smoke instead of `evals/perf.ts`.
- fix: codex harness deferred cases now stop at resolve and emit agent-review execute commands instead of auto-running fallback endpoint attempts inside the harness
- fix: orchestrator `resolve` no longer auto-executes based on marketplace/ranking confidence; execution now happens only after the agent explicitly chooses `endpoint_id`
- fix: codex harness artifacts now store collector status (`ready_for_review` / `fail` / `skip`) instead of auto-grading `needs_review`, so pass/fail/skip comes from the in-thread agent review rather than the harness itself
- fix: codex harness now writes a compact review-queue sidecar with top candidates, signal tags, and execute commands so batch shortlist judging can happen in-thread without reopening the full artifact
- fix: codex harness now shells out to the CLI through explicit child-process buffering instead of Bun pipe readers, avoiding stuck batch evals after CLI timeouts/kill paths
- fix: review-queue fallback ordering now prefers replay/API candidates over schema-bearing page artifacts, so GitHub/MDN-style shortlist review stops surfacing the document shell above the real data endpoint
- fix: review-queue fallback ordering now demotes third-party negative-score adtech/tracking endpoints below strong page artifacts, so recipe search shortlist review stops preferring DoubleVerify-style junk over real extracted results
- fix: browser-capture session persistence now keeps only first-party cookies for the captured site, reducing replay pollution from third-party adtech cookies
- fix: restore Food Network and Epicurious public recipe-search cases to the Codex stress/agent-targets site lists after they were overwritten
- fix: repair `/v1/stats` npm range fetch helper so Bun can parse `src/api/routes.ts` and the Codex stress harness boots again
- feat: live skill writing can now call the core agent to refine endpoint descriptions plus typed `requires` / `provides` metadata before building the operation graph, with safe heuristic fallback if the model is unavailable
- fix: live semantic skill augmentation now runs on a bounded, relevance-filtered endpoint subset with a hard timeout, so noisy captures stop stalling skill writing on giant adtech payloads
- fix: operation-graph edge building now refuses generic `id` / `identifier` matches, so noisy captures stop chaining unrelated endpoints purely on placeholder bindings
- fix: execute-time truth gating now checks every successful endpoint response against the effective intent, so news blobs, affinity tables, and other wrong-entity payloads stop masquerading as product success
- fix: intent normalization/classification now understands product search rows, stock quotes, and channel/server lists, improving both direct execute projection and false-positive rejection on fresh domains
- fix: browser capture now navigates with `domcontentloaded` + a 20s cap before intent-aware waits, avoiding 60s+ ad-heavy page loads during fresh skill baking
- fix: marketplace resolve now hydrates only a small, domain-prioritized skill subset with per-skill timeouts, so remote-first repeat resolves stop stalling behind slow `getSkill` fanout
- fix: marketplace resolve now uses a shared-embedding remote search pass with conditional global fallback, so remote-first repeat resolves stop paying duplicate domain/global search cost on strong domain hits
- fix: backend search embeddings now clamp/pad to the indexed vector dimensions, preventing marketplace resolve failures when the embedding provider drifts from the requested size
- fix: CLI marketplace resolve now falls back to legacy `/v1/search` + `/v1/search/domain` when the new shared search route is not deployed yet, preventing repeat resolves from regressing to forced live capture during rollout
- docs: split Codex eval lanes into task-shaped `product-success` and broader `stress`, with `public` / `agent-targets` kept as aliases so product claims stop leaning on hostile homepage sweeps
- fix: codex eval review now scores normalized projected payloads and fills common aliases for fields like description, score, rating, sender, and term
- fix: package/model projection now normalizes crates.io search rows and Hugging Face `modelId` rows into stable eval-friendly fields
- fix: template param hydration now infers dev.to-style `tag` bindings from route context for query-based replay endpoints
- fix: post projection now derives dev.to authors from article paths and recovers Lobsters scores from text-heavy list rows
- docs: curated public expansion corpus now includes validated non-dev science/reference/news cases for arXiv, Wiktionary, and NPR, with exact blocked terminals where needed
- x402 workers can now force `mainnet` payment terms outside production via `X402_NETWORK_MODE`, which unblocks Lobster wallet e2e against staging.
- Fix browse submit so Mandai's resident gate is compiled into prerequisite state before `NEXT`, instead of falling through into a broken same-origin replay.
- Treat Kuri broker `ECONNRESET` / socket-close failures as recoverable browse errors and return structured submit failures instead of raw 500s.
- Fix browse recovery after live navigation: `go` now retries if it hands back a dead tab, empty `text` / `markdown` reads trigger session recovery, and `eval` recovers like `snap` instead of failing on stale tab bindings.
- Fix Kuri broker reuse so stale `/tabs` registry entries no longer keep a dead broker alive after Chrome/CDP disappears.
- Fix `browse sync` so it queues the same background publish/index path as `close`, instead of stopping at local cache flush only.
