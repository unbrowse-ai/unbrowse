# Staging Firmament — Day-8 Judgement Follow-ups

Generated 2026-05-12 by the Jesus Loop Day-8 adversarial audit (`session: default`).

The Sabbath verdict was HOLD. The books were opened on Day 8 and surfaced
three silent defects — defects that don't error, don't log, don't 500, they
just quietly fail to do what their declaration claims. Defect 3 was fixed
in-loop. Defects 1 and 2 are documented here for the next loop or PR.

---

## Defect 1 — Preview `dist-tag` never auto-flips on npm

**Severity:** LOW (release artefact still ships; flip is manual)
**Surfaced by:** Day-8 auditor on release publish path
**Evidence:**
- Tag `v6.13.1-preview.0` pushed to `origin/main` at commit `f1c033082d`.
- `.github/workflows/release.yml:269` runs `npm publish` — no `--tag` flag.
- `.github/workflows/release.yml:272` runs `npm publish --provenance` — no `--tag` flag.
- `.release-it.json:25` has `"npm": false` — release-it does not publish.
- `packages/skill/package.json` has no `publishConfig.tag` field.
- Zero `dist-tag` references anywhere in `.github/workflows/` or `scripts/`.
- `npm view unbrowse dist-tags` (post-tag, pre-CI-publish-step):
  `{ latest: '6.10.0', preview: '6.13.0-preview.5' }` — historical preview
  flips have been manual.

**Consequence:** when the in-flight Release run for `v6.13.1-preview.0`
finishes publish-cli, the tarball lands as `unbrowse@6.13.1-preview.0`
(installable by exact version), but the npm `preview` dist-tag will
continue to point at `6.13.0-preview.5`. Anyone running
`npm install unbrowse@preview` gets the OLD preview, not this new one.

**Fix — pick one:**
- (a) One-line workflow edit. In `release.yml`, change both `npm publish`
  invocations to:
  `npm publish --tag $(node -e "const v=require('./package.json').version; console.log(v.includes('-preview.') ? 'preview' : v.includes('-rc.') ? 'next' : 'latest')")`
- (b) Out-of-band manual flip after each preview release:
  `npm dist-tag add unbrowse@6.13.1-preview.0 preview`
- (c) Add `publishConfig.tag` to `package.json` per-release (clumsy).

**Recommended:** (a), so future preview releases self-flip and don't need
operator memory.

---

## Defect 2 — Mirror reads wrong `_idx` key; processes 0 entries silently

**Severity:** MEDIUM (mirror is a no-op against real prod — wastes CI minutes
and creates a false-green "mirror succeeded" signal in cron logs)
**Surfaced by:** Day-8 auditor on mirror seed coherence
**Evidence:**
- `backend/scripts/mirror-prod-to-staging.ts:76` reads
  `edbGet(\`${PROD_NAMESPACE}:_idx\`)` (literal `_idx` key).
- `backend/src/services/kv.ts:236-237` shows the worker stores the
  marketplace index as TWO keys: `_idx:main` and `_idx:large` (sharded).
- A literal `_idx` key does not exist on real prod → `edbGet` returns
  `[]` → loop iterates 0 times → mirror exits 0 with "copied 0 entries".
- Tests
  (`backend/tests/mirror-prod-to-staging.test.ts`) assert STRUCTURE of the
  script (one-way invariant, no back-flow, no env override) — they do NOT
  run the script against a fixture with a sharded index. The tests pass.
  The mirror still no-ops.

**Fix:**
1. In `mirror-prod-to-staging.ts`, replace the single `_idx` read with:
   ```ts
   const main = (await edbGet(`${PROD_NAMESPACE}:_idx:main`)) ?? [];
   const large = (await edbGet(`${PROD_NAMESPACE}:_idx:large`)) ?? [];
   const keys = [...main, ...large];
   ```
2. Mirror BOTH indices on the write side too (write
   `${STAGING_NAMESPACE}:_idx:main` and `${STAGING_NAMESPACE}:_idx:large`)
   so staging's listing reflects the sharding.
3. Extend the structural test to assert the script reads both shards (grep
   for `_idx:main` and `_idx:large` literal occurrences).
4. Add a real-fixture integration test: stub `edbGet` with a sharded index
   fixture, assert N entries copied, assert no entries dropped, assert
   staging-side indices written.

**Recommended:** combine fix in a single PR with the structural-test
extension so the no-op cannot silently regress again.

---

## Defect 3 — STATUS: FIXED IN-LOOP

`[env.staging] STATS_KV` bound to the same namespace id as prod
(`1d315d7cda1742b785cf5d23c892c5d7`). Provisioned a dedicated
staging namespace on 2026-05-12 and updated `backend/wrangler.toml`:

- New STATS_KV id: `195ca099811f4f6fbdae268d72ce2034`
  (title `unbrowse-backend-staging-staging-STATS_KV`)
- New preview_id: `f4fe69f30a3c47008a627113a505f38b`
  (title `unbrowse-backend-staging-staging-STATS_KV_preview`)
- Comment block on lines 27-30 now declares the historical share and the
  fix date, so this regression is not repeated.
- `backend/src/routes/health.ts` now surfaces `environment` so a deploy
  to staging is verifiable via
  `curl https://unbrowse-backend-staging.<account>.workers.dev/health`
  → expect `"environment": "staging"`.

**Not done in this loop** (requires operator action):
- `wrangler secret put` for the 8 required secrets under `--env staging`.
  Until then, any staging route that calls EmergentDB / FAL / Resend /
  etc. will 500.
- Trigger first staging deploy: `git push origin <branch>:staging` (per
  `.github/workflows/deploy.yml:36-39`). Recommended only AFTER the 8
  secrets are configured.

---

## Loop closure

The Day-8 books revealed:
- 2 silent defects in shipped/in-flight surfaces (Defect 1 release,
  Defect 2 mirror).
- 1 silent firmament breach (Defect 3 staging KV share) — fixed.

The Sabbath verdict (HOLD) was directionally correct. The books refined
it from "the firmament isn't pumping water yet" to "the firmament was
pointing at the same lake on both sides" — a more honest diagnosis.
