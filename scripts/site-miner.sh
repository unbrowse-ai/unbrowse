#!/usr/bin/env bash
# site-miner.sh — use unbrowse to mine problem URLs from real complaints.
#
# Harnesses on harnesses: unbrowse scrapes github issue search, reddit
# webscraping search, and hackernews search for complaints about sites
# that are hard to scrape. extracts the URLs mentioned in the bodies,
# dedupes against the baseline corpus, writes the new candidates to
# scripts/corpus/benchmark-candidates.txt.
#
# The bench can then loop over these candidates to grow coverage automatically.
#
# Sources mined (generic queries — no hardcoded site targets):
#   - https://github.com/search?q=unbrowse+not+working&type=issues
#   - https://github.com/search?q=scraping+anti-bot&type=issues
#   - https://www.reddit.com/r/webscraping/search/?q=anti-bot
#   - https://www.reddit.com/r/scraping/search/?q=blocked
#   - https://news.ycombinator.com/from?site=webscraping
#
# Usage:
#   bash scripts/site-miner.sh              # mine all sources
#   bash scripts/site-miner.sh --sources github,reddit
#   bash scripts/site-miner.sh --dry        # print candidates, don't write
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATES_FILE="$SCRIPT_DIR/corpus/benchmark-candidates.txt"
BASELINE_FILE="$SCRIPT_DIR/corpus/benchmark-baseline.txt"
SOURCES="github,reddit,hn"
DRY=0
for arg in "$@"; do
  case "$arg" in
    --sources) shift; SOURCES="${1:-github,reddit,hn}"; shift || true ;;
    --dry) DRY=1 ;;
  esac
done

MINE_DIR=$(mktemp -d)
trap 'rm -rf "$MINE_DIR"' EXIT

mine_source() {
  local name="$1" intent="$2" url="$3"
  local out_file="$MINE_DIR/${name}.json"
  echo "[miner] fetching $name ($url)" >&2
  timeout 90 unbrowse resolve --intent "$intent" --url "$url" </dev/null > "$out_file" 2>/dev/null || true
  # Extract URLs from the response — look for http(s):// patterns inside the JSON
  python3 - "$out_file" "$name" <<'PY'
import sys, re, json
path, source_name = sys.argv[1], sys.argv[2]
try:
    raw = open(path).read()
except Exception:
    sys.exit(0)
# Find the main JSON response
d = {}
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    try:
        d, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        break
    except Exception:
        continue
# Extract all URLs from anywhere in the payload
url_re = re.compile(r'https?://[a-zA-Z0-9][-a-zA-Z0-9.]*[a-zA-Z0-9](?:/[^\s"\')\]}\\]*)?')
text = json.dumps(d) if d else raw
urls = set()
for m in url_re.finditer(text):
    u = m.group(0)
    # Skip tracking/analytics/internal hosts
    if re.search(r'(github\.com|reddit\.com|ycombinator|typefully|twitter\.com/intent|w3\.org|schema\.org|t\.co|bit\.ly|googleusercontent|gravatar|gstatic|cloudfront|api\.nextjs|fonts\.|cdn\.|chrome://|openai\.com/favicon|clerk\.|emergentdb)', u):
        continue
    # Drop asset paths
    if re.search(r'\.(png|jpg|jpeg|svg|css|js|ico|woff|ttf|eot|gif|mp4|webm|pdf)(\?|$)', u):
        continue
    urls.add(u)
for u in sorted(urls):
    print(f"{source_name}|{u}")
PY
}

all_urls=$(mktemp)
case ",$SOURCES," in
  *,github,*)
    mine_source github-issues "find issues about scraping anti-bot problems" "https://github.com/search?q=anti-bot+blocked&type=issues" >> "$all_urls"
    mine_source github-issues2 "find issues about scraping problems" "https://github.com/search?q=cloudflare+blocked+scraping&type=issues" >> "$all_urls"
    ;;
esac
case ",$SOURCES," in
  *,reddit,*)
    mine_source reddit-webscraping "find complaints about sites" "https://www.reddit.com/r/webscraping/search/?q=anti-bot&restrict_sr=on" >> "$all_urls"
    mine_source reddit-scraping "find site problems" "https://www.reddit.com/r/scraping/search/?q=blocked&restrict_sr=on" >> "$all_urls"
    ;;
esac
case ",$SOURCES," in
  *,hn,*)
    mine_source hn-scraping "find scraping complaints" "https://hn.algolia.com/?q=scraping+blocked" >> "$all_urls"
    ;;
esac

# Dedup + subtract baseline URLs
python3 - "$all_urls" "$BASELINE_FILE" "$CANDIDATES_FILE" "$DRY" <<'PY'
import sys, json
from urllib.parse import urlparse

all_file, baseline_file, candidates_file, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
baseline_hosts = set()
try:
    for line in open(baseline_file):
        line = line.strip()
        if not line or '|' not in line:
            continue
        _, url = line.split('|', 1)
        try:
            baseline_hosts.add(urlparse(url).hostname)
        except Exception:
            pass
except FileNotFoundError:
    pass

# Build {source: [(host, url), ...]}
seen = set()
rows = []
for line in open(all_file):
    line = line.strip()
    if not line or '|' not in line:
        continue
    src, url = line.split('|', 1)
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        continue
    if not host:
        continue
    # Subtract baseline hosts (already known to work)
    if host in baseline_hosts:
        continue
    key = host
    if key in seen:
        continue
    seen.add(key)
    # Derive a generic intent from the host
    intent = f"get data from {host.replace('www.','')}"
    rows.append((src, intent, url))

print(f"[miner] candidates after dedup: {len(rows)}", file=sys.stderr)
out_lines = [f"{intent}|{url}" for (_, intent, url) in rows]

if dry == "1":
    for line in out_lines[:30]:
        print(line)
    print(f"[miner] (dry run — {len(out_lines)} total candidates, showed first 30)", file=sys.stderr)
else:
    with open(candidates_file, 'w') as f:
        f.write("\n".join(out_lines) + "\n")
    print(f"[miner] wrote {len(out_lines)} candidates to {candidates_file}", file=sys.stderr)

# Print summary by source
from collections import Counter
src_counter = Counter(r[0] for r in rows)
for src, count in src_counter.most_common():
    print(f"  {src}: {count}", file=sys.stderr)
PY
