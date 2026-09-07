/**
 * github-raw — for a github code-FILE URL, the authoritative content is the raw
 * file, not the chrome-heavy rendered blob page.
 *
 * `unbrowse fetch https://github.com/<o>/<r>/blob/<ref>/<path>` scrapes the
 * rendered React page: the file content survives but ~50% page chrome rides
 * along (the exa micro-benchmark measured this — small code files scored as low
 * as 0.53 ROUGE-L vs the clean source). The clean source is one URL away:
 * raw.githubusercontent.com serves the exact bytes. Detecting a blob URL and
 * fetching the raw equivalent yields complete, chrome-free extraction.
 *
 * Only /blob/ file views map (PRs, issues, tree/dir views, commits, releases
 * have no single raw file → return null and the normal fetch path handles them).
 */
export function githubBlobToRaw(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
	// /<owner>/<repo>/blob/<ref>/<path...>  → raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
	const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
	if (!m) return null;
	const [, owner, repo, refAndPath] = m;
	if (!owner || !repo || !refAndPath) return null;
	return `https://raw.githubusercontent.com/${owner}/${repo}/${refAndPath}`;
}

/** True iff the URL is a github code-file blob view (has a clean raw source). */
export function isGithubBlob(url: string): boolean {
	return githubBlobToRaw(url) !== null;
}
