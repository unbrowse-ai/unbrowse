/**
 * pickAnswerHit — choose the web hit to synthesize the resolve answer from.
 *
 * When the caller asked about a SPECIFIC site (domain present), PREFER an on-domain (or
 * brand-family) candidate over a richer-highlighted off-domain one — the user asked about THAT
 * site, so its own page is the on-target answer, even if a generic jargon-matching third-party
 * doc has a longer highlight (the lakeofficepros.com → github-azure-docs miss).
 *
 * A rich OFF-domain hit is NOT presented as THE answer when a specific site was requested — that
 * is the web-fallback fabrication the user flagged ("returned generic API-design articles for
 * unrelated sites" — bmo.com → docs.nex.ai). When a domain anchor was given but nothing on it was
 * found, return null so the caller emits `exa_answer:false` (honest: off-domain candidates only).
 * The rich fallback is kept ONLY for generic intents (no domain anchor), where any strong web hit
 * is a legitimate answer.
 */
export function pickAnswerHit<T extends { url: string; highlights?: string[] }>(
  hits: T[],
  domain: string | null | undefined,
): T | null {
  const norm = (h: string) => h.replace(/^www\./, "").toLowerCase();
  const rd = domain ? norm(domain) : "";
  const onDomain = rd
    ? hits.find((h) => {
        try {
          const hh = norm(new URL(h.url).hostname);
          if (hh === rd || hh.endsWith("." + rd)) return true;
          const a = rd.split(".")[0], b = hh.split(".")[0]; // brand-family prefix (chimebank↔chime)
          return a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a));
        } catch { return false; }
      })
    : undefined;
  const rich = hits.find((h) => (h.highlights ?? []).join(" ").length >= 150);
  return onDomain ?? (rd ? null : rich) ?? null;
}
