# Contributing

For client changes, open an issue describing the user problem and a command that proves the fix. Read the root agent map, then the affected package's MODULE.md.

Run `bun run check:public`, `bun run typecheck`, `bun test packages`, and `bun run build`. Test packed installs when changing packaging. Include the `PUBLIC_SURFACE_OK` or `PACKED_CLIENT_OK` result and relevant behavioral evidence in the PR. Never include credentials or private captured responses.

Source-synced files must change upstream; see [public sync](docs/public-sync.md). Keep README instructions aligned with an actually available release, not an assumed npm dist-tag.
