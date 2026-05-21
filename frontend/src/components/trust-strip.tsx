import Image from "next/image";
import Link from "next/link";

/**
 * TrustStrip — credibility bar that lives directly under the hero CTAs.
 * Surfaces the four cited credibility signals that the CRO audit (Apr 2026)
 * called out as missing from above-the-fold:
 *   - arXiv 2604.00694 (peer-reviewed, NUS co-authored)
 *   - NVIDIA Inception member badge
 *   - Open bench (n=94 domains) — links to /benchmark-deep-dive
 *   - AGPL-3.0 + free, runs locally
 *
 * Live npm + GitHub counters are fetched client-side by <LiveCounts /> so
 * the strip itself stays a server component and renders during the
 * Suspense fallback. Numbers come from public APIs, no auth needed.
 */
async function fetchGithubStars(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/unbrowse-ai/unbrowse",
      { next: { revalidate: 3600 } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

async function fetchNpmMonthly(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.npmjs.org/downloads/point/last-month/unbrowse",
      { next: { revalidate: 3600 } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { downloads?: number };
    return typeof data.downloads === "number" ? data.downloads : null;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export async function TrustStrip() {
  const [stars, npmDl] = await Promise.all([
    fetchGithubStars(),
    fetchNpmMonthly(),
  ]);

  return (
    <div
      className="animate-fade-up stagger-3 mt-8 w-full max-w-3xl"
      aria-label="Trust signals"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 px-4 py-3 rounded-sm border border-[rgba(255,122,32,0.18)] bg-[rgba(6,4,2,0.7)] backdrop-blur-sm">
        <a
          href="https://arxiv.org/abs/2604.00694"
          target="_blank"
          rel="noopener"
          className="group inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[rgba(255,176,96,0.85)] hover:text-orange-400 transition-colors"
        >
          <span className="text-[rgba(255,122,32,0.5)]">arXiv</span>
          <span>2604.00694</span>
          <span className="text-text-muted normal-case tracking-normal opacity-70 group-hover:opacity-100">
            peer reviewed
          </span>
        </a>

        <span className="text-[rgba(255,122,32,0.25)]" aria-hidden>
          ·
        </span>

        <Link
          href="/benchmark-deep-dive"
          className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[rgba(255,176,96,0.85)] hover:text-orange-400 transition-colors"
        >
          <span className="text-orange-500">n=94</span>
          <span className="text-text-muted normal-case tracking-normal">
            open bench
          </span>
        </Link>

        <span className="text-[rgba(255,122,32,0.25)]" aria-hidden>
          ·
        </span>

        {stars !== null && (
          <>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[rgba(255,176,96,0.85)] hover:text-orange-400 transition-colors"
            >
              <span className="text-orange-500">{fmt(stars)}</span>
              <span className="text-text-muted normal-case tracking-normal">
                GitHub stars
              </span>
            </a>
            <span className="text-[rgba(255,122,32,0.25)]" aria-hidden>
              ·
            </span>
          </>
        )}

        {npmDl !== null && (
          <>
            <a
              href="https://www.npmjs.com/package/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[rgba(255,176,96,0.85)] hover:text-orange-400 transition-colors"
            >
              <span className="text-orange-500">{fmt(npmDl)}</span>
              <span className="text-text-muted normal-case tracking-normal">
                npm/mo
              </span>
            </a>
            <span className="text-[rgba(255,122,32,0.25)]" aria-hidden>
              ·
            </span>
          </>
        )}

        <a
          href="https://www.nvidia.com/en-us/startups/"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 opacity-80 hover:opacity-100 transition-opacity"
          aria-label="NVIDIA Inception member"
          title="NVIDIA Inception member"
        >
          <Image
            src="/nvidia-inception.svg"
            alt="NVIDIA Inception"
            width={92}
            height={20}
            className="h-5 w-auto"
          />
        </a>
      </div>
    </div>
  );
}
