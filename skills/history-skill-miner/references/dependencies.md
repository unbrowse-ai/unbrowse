# History Skill Miner Dependencies

Share these with the miner when you want the bundle to work in another repo or agent host.

## Required

- `skills/history-skill-miner/SKILL.md`
- `skills/history-skill-miner/scripts/mine-history.ts`
- `skills/history-skill-miner/references/first-principles-skill-design.md`
- `skills/history-skill-miner/references/generated-skills.md`

## Runtime

- Bun runtime
- local Codex history sources, by default:
  - `~/.codex/history.jsonl`
  - `~/.codex/session_index.jsonl`
  - `~/.codex/archived_sessions/*.jsonl`

## Generated Skill Follow-On Dependencies

- `main-actions-triage` expects `gh`
- `skill-surface-ship` expects the repo's skill docs and sync scripts
- `docs-release-sync` expects the repo's user-facing docs and changelog files
- `p2p-skill-share` expects Bun plus `wrangler` when you actually open a Cloudflare tunnel

## Sharing Rule

- if the recipient should only use the useful generated skills, share those skill folders plus this file
- if the recipient should regenerate from their own history, share the miner too
