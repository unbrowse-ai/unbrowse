# Architecture

These documents describe Unbrowse 11.1.1.

- [Overview](OVERVIEW.md) — system boundaries and the request lifecycle
- [CLI and local engine](CLI.md) — commands, capture, and replay
- [Backend](BACKEND.md) — route graph, accounts, credits, and API contracts
- [Frontend](FRONTEND.md) — public site and account UI
- [Identity and auth](AUTH.md) — API keys and site credentials
- [Privacy](PRIVACY.md) — what stays local and what may be published
- [Performance](PERFORMANCE.md) — cache, fallback, and measurement
- [Security](SECURITY.md) — trust boundaries and operational controls
- [Acceptance criteria](ACCEPTANCE-CRITERIA.md) — release behavior
- [Test specifications](TEST-SPECS.md) — required witnesses

The governing principle is simple: resolve a known route first, use a browser
when the route is missing, and report the real outcome of both paths.
