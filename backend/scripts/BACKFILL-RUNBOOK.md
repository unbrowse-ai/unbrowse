# Backfill runbook — one-way prod → staging marketplace mirror

Operator runbook for `backend/scripts/mirror-prod-to-staging.ts`. Runs from
your local machine, never inside the staging worker. The script mirrors
skills from prod EmergentDB namespace `skills-v2` to staging namespace
`staging-skills-v3`. Idempotent; staging-side edits with a newer
`updated_at` are preserved.

## Prerequisites

You need two EmergentDB API keys, both already provisioned on Cloudflare
as worker secrets (see `wrangler secret list --env staging` for staging,
and main env for prod):

| Variable | Scope | Where to get it |
|---|---|---|
| `EMERGENTDB_PROD_API_KEY` | read on `skills-v2` (write not required) | the same key that's set as `EMERGENTDB_API_KEY` on the production worker |
| `EMERGENTDB_STAGING_API_KEY` | write on `staging-skills-v3` | the same key that's set as `EMERGENTDB_API_KEY` on the staging worker |

These are *operator-side* env vars for this script only. Do NOT commit
them. The worker never sees them.

## Step 1 — dry-run

Confirms shape, counts, and that the script can read prod skills.

```bash
export EMERGENTDB_PROD_API_KEY="..."     # prod read scope
export EMERGENTDB_STAGING_API_KEY="..."  # staging write scope (used in dry-run idempotency check)

cd /path/to/unbrowse
bun backend/scripts/mirror-prod-to-staging.ts --dry-run
```

Expected output:
- One line per skill: `skill_id | domain | version`
- Final tally: `would mirror N skills` (no writes performed)
- Exit code 0

If you see `EMERGENTDB_*_API_KEY is not set` and exit code 1, you forgot
to export the env var. The script refuses to run without both keys —
this is intentional.

## Step 2 — apply

After the dry-run looks right, drop `--dry-run`:

```bash
bun backend/scripts/mirror-prod-to-staging.ts
```

Expected output:
- One line per skill: `mirrored skill_id | domain | version` or `skipped (staging newer)`
- Final tally: `mirrored N | skipped M | errors K`
- Exit code 0 on full success, 2 on any errors

## Step 3 — verify on staging

```bash
curl https://unbrowse-backend-staging.<your-subdomain>.workers.dev/v1/skills?view=card | jq '.skills | length'
```

The count should be ≈ `mirrored + already_in_staging`. Some additional
skills may exist if staging was already accepting independent publishes.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--dry-run` | off | Read + print; perform no writes |
| `--limit N` | unlimited | Cap items processed (smoke / progressive rollout) |
| `--prefix STR` | `skill:` | Key prefix to walk (advanced; rarely needed) |

## One-way invariant — verified

The script is structurally one-way. Asserted by
`backend/tests/mirror-prod-to-staging.test.ts`:

- Namespace constants are read-only literals; no env override.
- Production never appears as a write destination (`edbSet(PROD_*)` is
  banned by test).
- No `--direction`, `--reverse`, `--source`, `--dest` flags.
- Subprocess exits cleanly without both keys (no stack trace, no
  silent fallback).

If a future edit tries to add reverse-direction or env-driven swap, the
test fails red.

## Rollback

There's no rollback because there's nothing to roll back to — staging is
the only side that changes. If a mirror produced bad data:

- Delete the affected staging keys directly via EmergentDB admin.
- Re-run the mirror; it will repopulate from prod.

Staging-side publishes (a developer testing a publish flow) are
preserved by the `updated_at` check — the mirror won't clobber them
unless prod's record is newer.

## Why not a worker cron?

A scheduled worker route could automate this, but it would need a single
EmergentDB key with both prod-read AND staging-write scope. That's a
bigger blast-radius credential than the current model (two scoped keys,
operator runs once when needed). The runbook keeps the boundary clean.

If you want a cron later, the smallest viable shape is:
- Provision a third EmergentDB key with prod-read + staging-write.
- Set it as `EMERGENTDB_MIRROR_KEY` on the staging worker.
- Add a cron route in `backend/src/routes/admin/mirror.ts` that calls
  the same logic.
- Gate the route on env `ENVIRONMENT === "staging"` so it cannot fire
  on prod by accident.

Day-9 scope of this loop is the operator runbook; the cron is deferred.
