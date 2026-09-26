# Test standard

`bun test packages` checks SDK routing and CLI behavior against controlled transports. `scripts/smoke-packed.sh SDK.tgz CLI.tgz` installs real packages into a new directory and runs plain Node. `SMOKE_LIVE=1` adds a public registry read; it does not prove authenticated writes.

`node scripts/check-public-surface.mjs` verifies exported hashes, skill references, docs links and root instruction parity. Source exporter tests include rejection controls for symlinks, credentials and executable declarations. Keep these failures meaningful; do not weaken checks to release.
