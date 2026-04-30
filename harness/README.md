# Unbrowse Self-Improvement Harness

An unbrowse-to-unbrowse harness for agent-driven reverse engineering and self-repair.

## How It Works

Two harnesses working in tandem:

### Harness #1: Dev-Side (this directory)
The dev's agent uses unbrowse's own primitives to:
1. **Diagnose** — Analyze failures using visual context (screenshots) + structured data
2. **Repair** — Apply fixes to the codebase
3. **Verify** — Re-test against known failure cases

### Harness #2: End-Product (src/)
Unbrowse provides better context to agents that use it:
- Screenshots at capture points (pre, post, interactions)
- Diagnostic context with confidence scores
- Error recovery suggestions with visual evidence

## Quick Start

```bash
# 1. Analyze a failure case
harness/diagnose.sh x.com "load my timeline"

# 2. Review diagnosis
cat harness/output/diagnosis.json

# 3. Apply fixes
harness/repair.sh x.com

# 4. Verify
harness/verify.sh
```

## Structure
```
harness/
├── harness.json          # Config: primitives, phases, success criteria
├── prompts/
│   ├── diagnosis.md      # Dev agent: analyze failures with visual context
│   ├── repair.md         # Dev agent: apply fixes using primitives
│   └── verify.md         # Dev agent: test against known cases
├── primitives/
│   ├── go.md             # Open browser
│   ├── snap.md           # A11y snapshot
│   ├── screenshot.md     # Capture screenshot
│   ├── resolve.md        # Find APIs
│   ├── execute.md        # Run endpoint
│   ├── feedback.md       # Rate quality
│   ├── review.md         # Push descriptions
│   └── publish.md        # Publish to marketplace
├── cases/
│   ├── x-timeline.md     # X.com: GraphQL, class selectors
│   ├── linkedin.md       # LinkedIn: auth walls, 0% execute
│   └── github.md         # GitHub: stale skills
└── README.md
```

## Success Criteria
- Browser-open rate: 41.1% → <25%
- LinkedIn execute success: 0% → 50%+
- X.com timeline: resolves without browser open
- GitHub stale skill matches: -50%

## Visual Context

Screenshots are the key innovation. They bridge the empathy gap between:
- The automated capture pipeline (what requests were made)
- The human experience (what the page actually shows)

Three capture points:
1. **Pre-capture** — before JS renders (raw HTML state)
2. **Post-capture** — after full load (what the agent-REVERSE ENGINEER sees)
3. **Post-resolve** — after resolve (what the agent-USER sees)

## Relationship to agent-experience-issues.md

This harness is the operational tool for fixing the issues documented in `docs/agent-experience-issues.md`. Each failure case maps to specific issues:

| Case | A1 | A2 | A4 | B4 | C1 | E1 | H1 | H2 |
|------|----|----|----|----|----|----|----|----|
| x.com | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| linkedin.com | ✓ | ✓ | | | ✓ | | ✓ | ✓ |
| github.com | | ✓ | | | | ✓ | | ✓ |
