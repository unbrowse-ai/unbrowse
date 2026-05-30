# Whitepaper trilogy — handoff

> Revelation 21:1 — *"And I saw a new heaven and a new earth."* The build is
> finished and judged; what remains is the one outward-facing act reserved for the
> author. This note is the manifestation: where everything lives and what is left.

## What was asked

Plan the whitepapers as a `CLAUDE.md` for this project, tie $FDRY in, and explain
why it must be hidden from money-motive and distributed first to people with no
money intention — so it can grow with a root of good (trustful security).

## What was delivered (all committed on `jl/natural-selection`)

| Artifact | What it is | Status |
|---|---|---|
| `paper/CLAUDE.md` | The superpattern plan for the 3-paper program + the **Grain-of-Wheat token doctrine** (the deliverable the user asked for). | ✅ committed, leak-clean |
| `paper/maintenance-network.tex` + `.pdf` | **Paper 3** — *Unbrowse Maintenance Network* — the previously-unwritten ref [3]. 10 sections, 11 bibitems, token doctrine in §8. Compiles to a 9-page PDF. | ✅ committed, paper-gate + leak-guard exit 0 |
| `paper/maintenance-network.OUTLINE.md` | The seed/outline (kept as the design record). | ✅ committed |
| `paper/internal-apis.tex` + `.pdf` | **Paper 2** — *Internal APIs Were Not All You Needed*. Finalized: 2 prose-corruption seams repaired verbatim from the canonical PDF; recompiles clean (12 pages). | ✅ committed, gates exit 0 |
| `paper/scripts/outline-gate.sh` | Falsifiable gate: no fabricated-green, citation-key closure, no moat leak. | ✅ committed |
| `docs/THE_FDRY_ECONOMY.md` | Guard-rail note added (FDRY is collateral for trust, not an investment; money was never the point) to bring the one investment-framed FDRY doc in line with the doctrine. | ✅ committed |

**Paper 1** (*Internal APIs Are All You Need*, arXiv:2604.00694v1) was already published; it is the wedge and needs no token.

## The token doctrine, in one line

USDC settles usage; **FDRY only bonds** (one master, Matt 6:24). The token dies to
its money-self — collateral for trust, not a currency (John 12:24) — and is fair-
launched with no issuer advantage, because a money-first root inverts trust. The
"what" is disclosed in full (the CA is printed on purpose); only the money-as-motive
framing is denied, because that framing is what poisons the soil. This is stated as
a **security property**, consistent with Paper 2's "Why money could not be the point."

## What is held for the author (the one outward-facing act)

The **arXiv / Overleaf push of Paper 3** is intentionally NOT done — it is
irreversible and public, and you chose to perform it yourself. Everything is
committed locally; nothing has been pushed to any public destination.

To publish when ready:
- **Overleaf:** upload `paper/maintenance-network.tex` (preamble + bibitems are
  self-contained; no external `.bib`).
- **arXiv:** the `.tex` compiles standalone with `tectonic` (0 undefined refs);
  assign the real arXiv ID and update the placeholder `arXiv:2604.00694` self-id +
  Paper 2's reciprocal `\bibitem{fdry}` to match.

## Verification posture (no fabricated green)

Every `[shipped]`/`\impl{}` claim is anchored in `paper/anchors.tsv`; every quoted
fragment grep-verifies verbatim against its real source (WEB bible / Paper 2 `.tex`);
both papers recompile with 0 undefined citations; all four gates (paper-gate ×2,
leak-guard, outline-gate) exit 0. Three fabricated quotes were caught and repented
during the build — the discipline is the point.
