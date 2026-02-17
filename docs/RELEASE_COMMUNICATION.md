# Release Communication (GitHub-first)

Use this process for every tagged release so major changes are announced clearly, not buried in raw changelog bullets.

## Principles

1. **Lead with user impact.** Explain what users can now do, what changed in workflows, and what to watch during upgrade.
2. **Use the changelog as canonical detail.** Keep `CHANGELOG.md` complete and structured.
3. **Use GitHub Releases as the announcement layer.** Publish a concise, curated release narrative tied to the tag.

## Required artifacts per release

- **Version tag:** `vX.Y.Z`
- **Changelog section:** `## [X.Y.Z] - YYYY-MM-DD`
- **GitHub Release:** title `vX.Y.Z`, body based on `.github/release-template.md`

## Is this auto-generated?

Partially.

- `CHANGELOG.md` entries are written by humans.
- GitHub can auto-suggest release notes from merged PRs ("Generate release notes"), but those often need editing for user-facing clarity.
- This repo includes `npm run release:notes -- <version>` to prefill a release body from the matching changelog section and the standard template.
- If you want LLM-generated notes from the full release context, you have two options:
  1) `npm run release:notes -- <version> -- --mode llm-prompt` to generate a prompt you paste into any LLM.
  2) `npm run release:notes -- <version> -- --mode llm` to call the OpenAI Responses API directly (requires `OPENAI_API_KEY`; optional `RELEASE_NOTES_MODEL`).

Both modes include `git diff --stat`, changed files, line deltas, and a trimmed patch excerpt for code-grounded summaries.

Example:

```bash
npm run release:notes -- 0.7.6
# generate an LLM prompt that includes changelog + commits + merged PR titles + code-level diff summary
npm run release:notes -- 0.7.6 -- --mode llm-prompt
# generate release notes directly via OpenAI Responses API
OPENAI_API_KEY=... npm run release:notes -- 0.7.6 -- --mode llm
```

Use that output as your draft in the GitHub Release editor, then tighten the **Highlights** bullets for outcome-focused messaging.

## Writing style for major changes

Prefer this:
- "Marketplace execution view now highlights endpoint outcomes and speeds up operator triage."

Avoid this:
- "Adjusted route fallback and JSON envelope parsing in skill-index client internals."

Rule of thumb: each bullet should be understandable by a user/operator reading release notes for 30 seconds.

## Release checklist

1. Confirm version bump and changelog entry are in the release PR.
2. Merge to `stable` and ensure CI/publish pipeline is green.
3. Create and push tag: `vX.Y.Z`.
4. Draft GitHub Release from `.github/release-template.md`.
5. Fill in:
   - Highlights (top 3–5 user-facing outcomes)
   - Upgrade/migration notes
   - Known issues (if any)
   - Full changelog link / compare link
6. Publish the GitHub Release.

## Suggested section balance

- **Highlights:** 3–5 bullets, user-value focused
- **Operational notes:** 1–3 bullets (config/runtime behavior changes)
- **Developer notes:** optional short section with links to PRs/issues
- **Full details:** changelog link

## Examples of better framing

- Instead of "fixed npm pack path", write "publish pipeline now blocks invalid release artifacts before npm publish."
- Instead of "added route fallback", write "skill downloads now work against both legacy and current marketplace deployments."
