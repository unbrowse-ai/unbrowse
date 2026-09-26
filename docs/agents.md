# Working on the client

Traverse root AGENTS.md → package MODULE.md → task-specific docs → tests. CLI behavior lives in packages/cli; REST wire conversions live in packages/sdk. Source-owned skill and MCP install helpers follow public-sync.md.

Use fixtures for mutating API tests. Live read-only tests verify installation and protocol compatibility. Do not claim a mock transport proves website execution.
