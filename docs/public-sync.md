# Public contract synchronization

This is the public client repository. It contains client code and consumer documentation, not the hosted server or customer data.

The server CI exports exactly:

- `skill/SKILL.md`: agent operating guidance.
- `skill/references/tools.json`: core MCP descriptions and input schemas, extracted as literals without executing server modules.
- `packages/sdk/src/mcp-install.ts`: OAuth-first installation helpers.
- `docs/public-surface.json`: content hashes for those three files.

Server CI validates the export and syncs only those files. It never mirrors private git history or copies runtime stores. New exported fields require review. Dynamic workspace tools remain on the authenticated server and are obtained through `tools/list`.

The public CI verifies hashes, skill references and documentation links, then tests, builds and installs the packed clients. Core schemas reflect the exported source snapshot; the connected server is authoritative and may be ahead during a rollout.

The SDK, CLI and remaining docs are maintained here. Changes to upstream-owned files must be made in the source and exported together, otherwise `node scripts/check-public-surface.mjs` fails. Consumer fixes should include a behavioral test and updated docs.

The release workflow builds installable GitHub assets. npm publication runs only when a publish token is configured; GitHub and npm availability are separate checks. See [release.md](release.md).
