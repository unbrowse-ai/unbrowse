# Governance

Unbrowse is an open protocol maintained by the community. This document describes how to contribute and how decisions are made.

## Contributing Skills

Anyone can contribute captured API skills to the marketplace:

1. **Capture** — Use `unbrowse_capture` or `unbrowse_learn` to reverse-engineer a site's internal API
2. **Test** — Verify endpoints work with `unbrowse_replay`
3. **Publish** — Submit to the marketplace with `unbrowse_publish`

### Quality Standards

Published skills must meet these criteria:

- **≥1 working endpoint** that returns valid data
- **No hardcoded auth** — auth.json is stripped on publish; consumers authenticate independently
- **Accurate documentation** — SKILL.md must describe endpoints correctly
- **No malicious payloads** — skills that inject, exfiltrate, or abuse are removed

### Trust Tiers

Skills earn trust through community validation:

| Tier | Requirements | Benefits |
|------|-------------|----------|
| New | Just published | Listed with "unverified" badge |
| Verified | ≥10 successful executions | Shown in search results |
| Trusted | ≥100 executions, <5% failure rate | Featured in recommendations |
| Core | Maintained by protocol team | Guaranteed uptime, versioned |

## Contributing Code

### Protocol Changes

Changes to the core protocol (skill format, auth schema, marketplace API) follow an RFC process:

1. Open a GitHub issue with `[RFC]` prefix describing the proposed change
2. Community discussion period (minimum 7 days)
3. Maintainer review and decision
4. Implementation + backwards compatibility period if breaking

### Plugin Changes

Bug fixes, new features, and improvements to the capture/replay engine:

1. Fork the repo
2. Create a feature branch
3. Submit a PR with tests
4. Maintainer review

## Decision Making

- **Day-to-day**: Maintainers merge PRs and manage releases
- **Protocol changes**: RFC process with community input
- **Disputes**: Maintainers have final say; community can fork

## Code of Conduct

Be constructive. Build things. Help others build things. Don't be a jerk.

## Contact

- GitHub: github.com/lekt9/unbrowse-openclaw
- Twitter: @getFoundry
