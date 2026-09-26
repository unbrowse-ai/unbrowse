# CLI
Owns: commands, OAuth configuration, output and exit codes. Uses SDK for REST.
Invariant: no local website automation; skill and its references ship together in the tarball.
Verify: `bun test packages/cli && bun run build` from root, then `scripts/smoke-packed.sh` with both packed tarballs.
