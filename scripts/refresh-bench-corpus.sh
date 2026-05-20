#!/usr/bin/env bash
# refresh-bench-corpus.sh — mine real-world "hard to scrape" reports
# from r/webscraping, r/programming, HN, and GitHub issues, write
# candidate sites to .bench-gate/refresh/<run-id>/candidates.json.
#
# The agent running this script then reviews candidates, classifies by
# lane, dedupes against the existing corpus, and opens a PR adding any
# new probes. This script NEVER mutates corpus-gate.txt directly.
#
# See docs/bench-corpus-refresh.md for the full design.
#
# Env:
#   UNBROWSE              CLI command (default: unbrowse)
#   OUT_DIR               output root (default: .bench-gate/refresh)
#   TIMEOUT               per-source capture timeout seconds (default 60)
#
# Sources (every entry is a `lane|intent|url` row consumed in turn):
#   r/webscraping new                      reddit
#   r/webscraping top of week              reddit
#   r/programming hot                      reddit
#   HN: "Show HN" scraper / playwright     hn search
#   GitHub: playwright issues open         github search
#   GitHub: puppeteer issues open          github search
#   GitHub: scrapy issues open             github search

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLI_CMD="${UNBROWSE:-unbrowse}"
read -r -a CLI_ARGS <<< "$CLI_CMD"
OUT_ROOT="${OUT_DIR:-.bench-gate/refresh}"
TIMEOUT="${TIMEOUT:-60}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"

err() { echo "[refresh-corpus] $*" >&2; }

SOURCES=(
  "reddit-webscraping-new|catalog recent scraping pain reports|https://www.reddit.com/r/webscraping/new/"
  "reddit-webscraping-top|catalog top scraping pain reports of the week|https://www.reddit.com/r/webscraping/top/?t=week"
  "reddit-programming|catalog hot programming reverse-engineering discussions|https://www.reddit.com/r/programming/"
  "hn-show-scraper|find Show HN scraper / extractor posts|https://hn.algolia.com/?q=show+hn+scraper&dateRange=pastMonth"
  "hn-playwright|find HN posts mentioning playwright pain|https://hn.algolia.com/?q=playwright+blocked&dateRange=pastMonth"
  "gh-playwright-issues|find open playwright issues mentioning blocked sites|https://github.com/microsoft/playwright/issues?q=is%3Aopen+is%3Aissue+blocked+OR+captcha"
  "gh-puppeteer-issues|find open puppeteer issues mentioning blocked sites|https://github.com/puppeteer/puppeteer/issues?q=is%3Aopen+is%3Aissue+blocked+OR+captcha"
  "gh-scrapy-issues|find open scrapy issues mentioning blocked sites|https://github.com/scrapy/scrapy/issues?q=is%3Aopen+is%3Aissue+blocked+OR+captcha"
)

err "refresh run_id=$RUN_ID out=$RUN_DIR sources=${#SOURCES[@]}"

i=0
sources_json="["
first=1
for entry in "${SOURCES[@]}"; do
  i=$((i+1))
  IFS='|' read -r tag intent url <<< "$entry"
  src_dir="$RUN_DIR/$(printf '%02d_%s' "$i" "$tag")"
  mkdir -p "$src_dir"
  err "[$i/${#SOURCES[@]}] $tag — $url"

  timeout "$TIMEOUT" "${CLI_ARGS[@]}" capture --url "$url" --intent "$intent" \
    </dev/null > "$src_dir/capture.out" 2> "$src_dir/capture.stderr.log" || true

  timeout "$TIMEOUT" "${CLI_ARGS[@]}" resolve --intent "$intent" --url "$url" --no-execute \
    </dev/null > "$src_dir/resolve.out" 2> "$src_dir/resolve.stderr.log" || true

  cap_path="$(jq -r '.capture_path // empty' < "$src_dir/capture.out" 2>/dev/null || true)"
  if [ -n "$cap_path" ] && [ -f "$cap_path" ]; then
    # Keep up to 200KB of source content so the agent has room to extract
    # candidate URLs + difficulty signals from the rendered page.
    head -c 204800 "$cap_path" > "$src_dir/page.excerpt" 2>/dev/null || true
  else
    : > "$src_dir/page.excerpt"
  fi

  if [ $first -eq 0 ]; then sources_json+=","; fi
  first=0
  sources_json+="$(jq -nc \
    --arg id "$(basename "$src_dir")" --arg tag "$tag" --arg intent "$intent" --arg url "$url" \
    '{source_id:$id, tag:$tag, intent:$intent, url:$url}')"
done
sources_json+="]"

# candidates.template.json — agent fills it in after reading each page excerpt.
# We deliberately do NOT auto-extract URLs with regex; the agent is the only
# thing that judges "this URL is worth adding as a probe".
jq -nc \
  --arg run_id "$RUN_ID" \
  --argjson sources "$sources_json" \
  '{
    run_id: $run_id,
    sources: $sources,
    _instructions: "Agent: read each source_id directory'\''s page.excerpt + capture.out, extract candidate site URLs the source is reporting as hard to scrape, tag with difficulty signals + proposed lane, and write the array below. Do NOT include sites already in harness/probes/corpus-gate.txt. Then open a PR adding the survivors to the corpus.",
    candidates: []
  }' > "$RUN_DIR/candidates.template.json"

err ""
err "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
err "AGENT REVIEW STEP — corpus refresh"
err "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
err "Run dir:   $RUN_DIR"
err "Sources:   ${#SOURCES[@]}"
err ""
err "Steps for the agent:"
err "  1. Read each $RUN_DIR/<source_id>/page.excerpt"
err "  2. Extract candidate site URLs being reported as hard to scrape"
err "  3. Write $RUN_DIR/candidates.json (shape per candidates.template.json):"
err "       [{ url, lane, intent, difficulty_signals[], provenance: { source_id, quote } }]"
err "  4. Dedupe against existing harness/probes/corpus-gate.txt"
err "  5. For each survivor, append \`lane | intent | url\` to corpus-gate.txt"
err "  6. Open a PR: 'corpus: add N field-reported probes from $(date -u +%Y-%m-%d) refresh'"
err "  7. After PR merges, re-run the bench-gate against the new corpus and re-stamp"
err ""

printf '%s\n' "$RUN_DIR"
