---
name: p2p-skill-share
description: >-
  Share repo-local skill bundles over a Cloudflare-relayed tunnel using a
  temporary no-account Quick Tunnel or an account-backed named tunnel. Use when
  Lewis wants to hand a useful skill bundle to another machine, repo, or agent
  host without publishing it first.
user-invocable: true
---

# P2P Skill Share

Core job:

- expose a signed-ish local skill bundle for another peer to fetch over a short-lived or stable tunnel

Use this skill when:

- Lewis wants to share a useful local skill bundle to another machine or repo
- the bundle should stay file-based instead of publishing to a registry first
- Cloudflare Tunnel is acceptable as the relay layer

Do not use this skill for:

- public package publishing
- long-term registry/distribution design
- remote execution of untrusted skill code over the tunnel

Workflow:

1. Read [cloudflare-modes.md](./references/cloudflare-modes.md).
2. Refresh the bundle with `bun skills/history-skill-miner/scripts/export-bundle.ts`.
3. Start the share helper with `bun skills/p2p-skill-share/scripts/share-bundle.ts --mode quick` for no-account temporary sharing, or `--mode named --named <tunnel-name>` for stable account-backed sharing.
4. Send the peer the printed URL plus the manifest path `/.well-known/skills/manifest.json`.
5. Rotate or stop the tunnel when the peer has fetched the bundle.

Load-bearing constraints:

- quick mode is temporary and anonymous; use it for demos or one-off transfers only
- named mode needs a Cloudflare account-backed tunnel
- share files and manifests, not arbitrary remote code execution
- treat tunnel tokens as secrets
