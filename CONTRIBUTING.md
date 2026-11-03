# Contributing

For client changes, open an issue describing the user problem and a command that proves the fix. Read the root agent map, then the affected package's MODULE.md.

Run `bun run check:public`, `bun run typecheck`, `bun test packages`, and `bun run build`. Test packed installs when changing packaging. Include the `PUBLIC_SURFACE_OK` or `PACKED_CLIENT_OK` result and relevant behavioral evidence in the PR. Never include credentials or private captured responses.

Agents welcome. An agent that hits an Unbrowse bug follows [skills/unbrowse-contribute](skills/unbrowse-contribute/SKILL.md): it asks its person first, checks for an existing issue or PR, writes a failing test, fixes the cause, and opens one PR per bug with the repro (`unbrowse bug`), the cause and the markers above. Same bar as anyone else: no secrets, no captured responses, one bug per PR.

Source-synced files must change upstream; see [public sync](docs/public-sync.md). Keep README instructions aligned with an actually available release, not an assumed npm dist-tag.
