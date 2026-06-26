# four-dim-gate — 2026-06-25T12:26:09Z

**Candidate:** http://localhost:3300/
**Baseline:** https://www.unbrowse.ai/

## 1. Core Web Vitals

| Metric | Candidate | Baseline | Delta | Verdict |
|---|---|---|---|---|
| LCP | 1752ms | 3976ms | -2224ms | IMPROVED |
| FCP | 1752ms | 2960ms | -1208ms | IMPROVED |
| CLS | 0.001 | 0.000 | +0.001 | NEUTRAL |
| TBT | 173ms | 103ms | +70ms | NEUTRAL |
| total_bytes | 1131KB | 1131KB | -0KB | NEUTRAL |

**Verdict:** PASS
**Improved-any:** True

## 2. Visual taste

Screenshots written to:
- candidate: `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.bench-four-dim/candidate-screens/`
- baseline:  `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.bench-four-dim/baseline-screens/`

Counts:
- candidate: 2 png(s)
- baseline:  2 png(s)

**Verdict:** NEEDS-AGENT-JUDGMENT (agent reads .bench-four-dim/candidate-screens/ vs baseline-screens/ in-thread)

## 3. Accessibility

| Impact | Candidate | Baseline | Delta | Verdict |
|---|---|---|---|---|
| critical | 0 | 0 | +0 | NEUTRAL |
| serious | 0 | 0 | +0 | NEUTRAL |
| moderate | 1 | 1 | +0 | NEUTRAL |
| minor | 1 | 1 | +0 | NEUTRAL |
| total violations | 2 | 2 | +0 | - |

**Verdict:** PASS

## 4. Copy + GEO/SEO integrity

- required strings present: 7/7
- JSON-LD blocks: 4 valid, 0 invalid; FAQPage present: True

| meta | candidate | baseline | match |
|---|---|---|---|
| title | `Unbrowse — Turn any website into API skills for AI agents` | `Unbrowse — Turn any website into API skills for AI agents` | = |
| description | `Unbrowse learns first-party website routes so AI agents can ` | `Unbrowse learns first-party website routes so AI agents can ` | = |
| canonical | `https://www.unbrowse.ai` | `https://www.unbrowse.ai` | = |
| og:title | `Unbrowse — Turn any website into API skills for AI agents` | `Unbrowse — Turn any website into API skills for AI agents` | = |
| og:description | `Unbrowse learns first-party website routes so AI agents can ` | `Unbrowse learns first-party website routes so AI agents can ` | = |
| og:image | `https://www.unbrowse.ai/nvidia-inception.png` | `https://www.unbrowse.ai/nvidia-inception.png` | = |
| twitter:title | `Unbrowse — Turn any website into API skills for AI agents` | `Unbrowse — Turn any website into API skills for AI agents` | = |
| twitter:description | `Unbrowse learns first-party website routes so AI agents can ` | `Unbrowse learns first-party website routes so AI agents can ` | = |
| twitter:image | `https://www.unbrowse.ai/og-image.png` | `https://www.unbrowse.ai/og-image.png` | = |

- sitemap.xml status=200 valid_xml=True has_locs=True
- /llms.txt: 200, 5434 bytes

**Verdict:** PASS

---

## Summary

| Dimension | Verdict |
|---|---|
| 1. Core Web Vitals | NON-REGRESSING |
| 2. Visual taste    | NEEDS-AGENT-JUDGMENT |
| 3. Accessibility   | NON-REGRESSING |
| 4. Copy + GEO/SEO  | NON-REGRESSING |

**Auto-gate verdict: PROMOTE-READY — agent must still judge visual taste.**

Next step: agent reads `.bench-four-dim/candidate-screens/` vs
`.bench-four-dim/baseline-screens/` in-thread. If taste is
non-regressing and at least one dim strictly improves, deploy:

```bash
cd frontend && bun run deploy
```
