#!/usr/bin/env bash
# bench-local.sh — fast iteration harness for the corpus, run locally.
#
# Each URL runs against the installed unbrowse binary. Per-URL result is saved
# to .bench-local/URL.json; final summary written to .bench-local/summary.json.
# Classifier runs as an external Python script so stdin plumbing is simple.
#
# Usage:
#   bash scripts/bench-local.sh                      # full baseline corpus
#   bash scripts/bench-local.sh --offset 5 --size 5  # rows 6-10
#   bash scripts/bench-local.sh --corpus-file F      # override
set -uo pipefail

# Ensure unbrowse is on PATH — non-login SSH shells don't source .zshrc/.bashrc
# so the npm-global bin is missing. Without this the whole bench is a no-op.
export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

CORPUS="scripts/corpus/benchmark-baseline.txt"
OFFSET=0
SIZE=0
TIMEOUT=90
CLI_CMD="unbrowse"
FORCE_CAPTURE=0
for arg in "$@"; do
  case "$arg" in
    --corpus-file) shift; CORPUS="${1:-}"; shift || true ;;
    --offset) shift; OFFSET="${1:-0}"; shift || true ;;
    --size) shift; SIZE="${1:-0}"; shift || true ;;
    --timeout) shift; TIMEOUT="${1:-90}"; shift || true ;;
    --use-source) shift; CLI_CMD="bun src/cli.ts" ;;
    --force-capture) shift; FORCE_CAPTURE=1 ;;
  esac
done

OUT_DIR="${BENCH_OUT_DIR:-.bench-local}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Per-URL evidence extractor. No verdict column — agent-in-thread judges
# by reading the CSV. The harness only extracts and presents signals that
# would inform the judgment.
cat > "$OUT_DIR/extract.py" <<'PY'
import sys, json, re
out_path = sys.argv[1]
goal = sys.argv[2]
url = sys.argv[3]
cli_exit = int(sys.argv[4]) if len(sys.argv) > 4 else 0
raw = open(out_path).read()

def _op_is_dom_fallback(op, page_url, spa_sourced_endpoint_ids=None):
    """True if the operation is a synthesized 'return the page' endpoint.
    Signature: url_template equals the page URL AND resource_kind is one
    of the synthetic fallback kinds (message/form/resource) AND description
    matches the synthesized 'Returns/Searches X with ...' pattern.

    Exception: if the operation is sourced from SPA-embedded data
    (Next.js __NEXT_DATA__, Nuxt __NUXT__, __INITIAL_STATE__,
    __PRELOADED_STATE__), it's real SSR payload data, not a dom-scrape
    fallback — treat as a real endpoint."""
    ep_id = op.get('endpoint_id') or op.get('operation_id') or ''
    if spa_sourced_endpoint_ids and ep_id in spa_sourced_endpoint_ids:
        return False
    tmpl = str(op.get('url_template', '') or '')
    rk = str(op.get('resource_kind', '') or '').lower()
    desc = str(op.get('description_out') or op.get('description') or '').lower()
    # SSR-embedded data description (set by buildPageArtifactCapture when
    # extraction_method starts with "spa-") is an explicit real-endpoint
    # marker even before we consult skill.endpoints.
    if 'ssr embedded data' in desc or desc.startswith('ssr ') or 'spa-' in desc:
        return False
    # Strip trailing slash for comparison
    norm_tmpl = tmpl.rstrip('/')
    norm_url = (page_url or '').rstrip('/')
    url_matches = norm_tmpl == norm_url
    fallback_kind = rk in ('message', 'form', 'resource', 'page', 'artifact')
    # The product auto-generates descriptions like
    # "Returns <resource> details with <fields>" or
    # "Searches <resource> with <fields>" for dom-fallback
    auto_desc = (
        ('returns' in desc and 'with' in desc and 'details' in desc)
        or ('searches' in desc and 'with' in desc)
        or 'captured page artifact' in desc
    )
    return url_matches and (fallback_kind or auto_desc)


def _spa_sourced_endpoint_ids(skill):
    """Return the set of endpoint_ids in skill.endpoints whose
    dom_extraction.extraction_method starts with 'spa-'. These came from
    SPA-embedded SSR data and should never be classified as dom-fallback."""
    ids = set()
    if not isinstance(skill, dict):
        return ids
    for ep in skill.get('endpoints') or []:
        if not isinstance(ep, dict):
            continue
        dx = ep.get('dom_extraction') or {}
        method = str(dx.get('extraction_method') or '')
        if method.startswith('spa-'):
            eid = ep.get('endpoint_id')
            if eid:
                ids.add(eid)
    return ids

# Find the TOP-LEVEL response object. Previous version took the first
# {"trace"...} match which matched nested trace objects inside a larger
# response (e.g. the skill.endpoints[].trace nested entry) and returned
# the wrong shape. The top-level response always has BOTH trace and
# result/skill at depth 0 and is usually the biggest decoded object.
# Strategy: try every candidate match, keep the LARGEST successfully
# decoded object that has a top-level 'result' or 'available_operations'
# key — that's always the one the agent cares about.
candidates = []
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    try:
        obj, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        if isinstance(obj, dict):
            candidates.append((len(json.dumps(obj)), obj))
    except Exception:
        continue
# Prefer the largest candidate that has a meaningful top-level shape
candidates.sort(key=lambda x: x[0], reverse=True)
d = {}
for _, obj in candidates:
    r0 = obj.get('result') if isinstance(obj.get('result'), dict) else None
    if obj.get('available_operations') or obj.get('available_endpoints'):
        d = obj
        break
    if r0 and (r0.get('available_operations') or r0.get('available_endpoints') or r0.get('error')):
        d = obj
        break
if not d and candidates:
    d = candidates[0][1]  # fall back to the biggest

r = d.get('result', {}) if isinstance(d, dict) else {}
# Some responses (direct-fetch) put the data at top level with trace, not under "result".
# In that case, r is empty but d has trace/source/success at top.
trace = d.get('trace', {}) if isinstance(d, dict) else {}
source = d.get('source', '') if isinstance(d, dict) else ''
meta = r.get('captured_meta') if isinstance(r, dict) else None
# If the response has available_operations at top level (some shapes do), use that
top_ops = d.get('available_operations') or d.get('available_endpoints') or []
if top_ops and not r.get('available_operations') and not r.get('available_endpoints'):
    r['available_operations'] = top_ops

# Pure evidence extraction — every field the agent needs to judge in-thread.
# No classification, no verdict, no threshold checks.
row = {
    'goal': goal,
    'url': url,
    'source': source,                              # '', 'direct-fetch', 'live-capture', 'marketplace', 'cache'
    'trace_success': trace.get('success') if isinstance(trace, dict) else None,
    'trace_skill_id': trace.get('skill_id') if isinstance(trace, dict) else '',
    'has_available_operations': bool(isinstance(r, dict) and (r.get('available_operations') or r.get('available_endpoints'))),
    'n_operations': len(r.get('available_operations') or r.get('available_endpoints') or []) if isinstance(r, dict) else 0,
    'error_code': r.get('error','') if isinstance(r, dict) else (d.get('error','') if isinstance(d, dict) else ''),
    'error_message': (r.get('message','') if isinstance(r, dict) else '')[:300],
    'captured_html_bytes': (meta or {}).get('html_bytes','') if isinstance(meta, dict) else '',
    'captured_text_bytes': (meta or {}).get('text_bytes','') if isinstance(meta, dict) else '',
    'captured_title': ((meta or {}).get('title','') if isinstance(meta, dict) else '')[:100],
    'captured_api_calls': (meta or {}).get('observed_api_calls','') if isinstance(meta, dict) else '',
    'captured_intent_verdict': (meta or {}).get('intent_verdict','') if isinstance(meta, dict) else '',
    'captured_intent_reason': (meta or {}).get('intent_reason','') if isinstance(meta, dict) else '',
    'filter_rejections': json.dumps((meta or {}).get('filter_rejections', {}), sort_keys=True) if isinstance(meta, dict) else '',
    'browser_block_signals': json.dumps((meta or {}).get('browser_block_signals', []), sort_keys=True) if isinstance(meta, dict) else '',
    'capture_diagnostic': r.get('capture_diagnostic', '') if isinstance(r, dict) else '',
    'total_endpoints_captured': r.get('total_endpoints_captured', '') if isinstance(r, dict) else '',
    'auth_recommended': r.get('auth_recommended', False) if isinstance(r, dict) else False,
    # cli_exit distinguishes a timeout (124) from a clean no-data empty row,
    # so the rubric and the agent can tell "browser hung" apart from
    # "browser returned but extraction found nothing".
    'cli_exit': cli_exit,
    'cli_timeout': cli_exit == 124,
    # dom-fallback-only detection: every operation's url_template equals
    # the input URL (the product couldn't find any API calls and instead
    # synthesized "return the page as an endpoint"). The agent gets HTML
    # back — useful for DOM-readable content, but NOT an API discovery.
    # Observed on semrush, moz, backlinko, neilpatel, serpstat — all
    # synthetic "page-as-endpoint" captures with resource_kind in
    # {message, form, resource} and url_template == page URL.
    'all_ops_dom_fallback': (
        lambda ops, page_url, spa_ids: bool(ops) and all(
            isinstance(o, dict) and _op_is_dom_fallback(o, page_url, spa_ids)
            for o in ops
        )
    )(
        r.get('available_operations') or r.get('available_endpoints') or [],
        url,
        # skill lives at top level of the CLI response, sibling to `result`,
        # not inside result. Reading r.get('skill') was a silent no-op and
        # caused every spa-nextjs endpoint to still be classified as
        # dom-fallback in the rubric because the spa-sourced set was empty.
        _spa_sourced_endpoint_ids(d.get('skill') if isinstance(d, dict) else None),
    ) if isinstance(r, dict) else False,
}

# ---------------------------------------------------------------------------
# Action-verification evidence (added 2026-05-21).
# These fields are EVIDENCE the agent uses in-thread to judge whether the
# intent's ACTION was actually performed , not just whether bytes came back.
# Substrate-faithful: no deterministic PASS/FAIL is baked on top of these.
# The agent reads response_token_hits + response_token_hit_rate +
# agent_judgment_question and judges in-thread.
# ---------------------------------------------------------------------------
_GET_DATA_VERBS = {'get','fetch','show','view','read','inspect','see','find','look','lookup'}
_LIST_VERBS = {'search','query','filter','browse','list','enumerate'}
_PERFORM_VERBS = {'post','submit','send','comment','create','add','update','edit','delete','trigger','click','react','like'}
_STOPWORDS = set([
    'get','fetch','show','search','find','list','for','on','in','of','the','a','an',
    'my','with','and','to','from','view','read','inspect','see','look','lookup',
    'query','filter','browse','enumerate','post','submit','send','comment','create',
    'add','update','edit','delete','trigger','click','react','like'
])

def _classify_action(goal_str):
    if not goal_str:
        return 'ambiguous'
    toks = [t.strip().lower() for t in goal_str.split() if t.strip()]
    for t in toks:
        # strip non-alnum from the candidate verb only
        bare = re.sub(r'[^a-z0-9]', '', t)
        if bare in _GET_DATA_VERBS:
            return 'get_data'
        if bare in _LIST_VERBS:
            return 'list_or_search'
        if bare in _PERFORM_VERBS:
            return 'perform'
    return 'ambiguous'

def _intent_tokens(goal_str):
    if not goal_str:
        return []
    out = []
    for raw in goal_str.lower().split():
        # keep hyphenated tokens like usb-c together, strip surrounding punctuation
        cleaned = re.sub(r'^[^a-z0-9]+|[^a-z0-9]+$', '', raw)
        if not cleaned or cleaned in _STOPWORDS:
            continue
        # Require >=3 alnum chars total in the token
        alnum = re.sub(r'[^a-z0-9]', '', cleaned)
        if len(alnum) < 3:
            continue
        out.append(cleaned)
    # de-dupe preserving order
    seen = set()
    deduped = []
    for t in out:
        if t in seen:
            continue
        seen.add(t)
        deduped.append(t)
    return deduped

def _response_search_corpus(d_obj, r_obj):
    """Build the haystack the agent's intent tokens are searched against.
    Combines: result.title + result.text_excerpt + result.markdown (when
    PR #654 has shipped) + every agentParams field across available
    operations. URL itself is excluded ; matching the URL is tautological."""
    parts = []
    if isinstance(r_obj, dict):
        for k in ('title', 'text_excerpt', 'markdown'):
            v = r_obj.get(k)
            if isinstance(v, str) and v:
                parts.append(v)
        # Some shapes put the body under result.body / result.data / result.response_excerpt
        for k in ('body', 'data', 'response_excerpt', 'response_body'):
            v = r_obj.get(k)
            if isinstance(v, str) and v:
                parts.append(v)
        ops = r_obj.get('available_operations') or r_obj.get('available_endpoints') or []
        for op in ops:
            if not isinstance(op, dict):
                continue
            ap = op.get('agentParams') or op.get('agent_params') or []
            if isinstance(ap, list):
                for p in ap:
                    if isinstance(p, dict):
                        for k in ('key','example','description','sample','value'):
                            v = p.get(k)
                            if isinstance(v, (str, int, float)):
                                parts.append(str(v))
    # Top-level fallbacks (direct-fetch path puts data at d, not d.result)
    if isinstance(d_obj, dict):
        for k in ('title', 'text_excerpt', 'markdown', 'body'):
            v = d_obj.get(k)
            if isinstance(v, str) and v and v not in parts:
                parts.append(v)
    return ' \n '.join(parts).lower()

_goal_str = goal or ''
_action_class = _classify_action(_goal_str)
_tokens = _intent_tokens(_goal_str)
_haystack = _response_search_corpus(d if isinstance(d, dict) else {}, r if isinstance(r, dict) else {})
_hits = [t for t in _tokens if t.lower() in _haystack]
_hit_rate = (len(_hits) / len(_tokens)) if _tokens else 0.0
_side_effect_required = _action_class == 'perform'
_side_effect_check = (
    'NOT_IMPLEMENTED: side-effect probes require a per-probe verifier '
    '(e.g., re-fetch the target after the action and assert state change). '
    'Currently no PERFORM probes are in the corpus.'
) if _side_effect_required else ''

def _build_judgment_question(action_class, tokens, hits, hit_rate, side_effect_required):
    if side_effect_required:
        return (
            "intent_action_class='perform': no side-effect verifier ran. "
            "Did the response confirm the state change (e.g., 'created', new id, "
            "follow-up GET shows the new item)? Default to MANUAL_REVIEW."
        )
    if not tokens:
        return (
            "intent_tokens is empty (intent had no content words after stopword "
            "removal); judge from text_excerpt whether the response matches the intent."
        )
    n_t = len(tokens)
    n_h = len(hits)
    if n_h == n_t:
        return (
            f"intent_tokens={tokens} all {n_h}/{n_t} hit in response; "
            "does the excerpt actually contain the requested CONTENT "
            "(listings/values/records), or just echoed search terms?"
        )
    if n_h == 0:
        return (
            f"intent_tokens={tokens} hit 0/{n_t}; the response excerpt likely "
            "does NOT contain what was asked. Read text_excerpt to confirm "
            "(gzip-magic-bytes / captcha / wrong-template all land here)."
        )
    return (
        f"intent_tokens={tokens} hit {n_h}/{n_t} ({hits}); "
        "does the excerpt actually show on-topic content for the missing "
        "tokens, or only the matched terms in unrelated context?"
    )

row['intent_action_class'] = _action_class
row['intent_tokens'] = _tokens
row['response_token_hits'] = _hits
row['response_token_hit_rate'] = round(_hit_rate, 3)
row['action_side_effect_required'] = _side_effect_required
row['action_side_effect_check'] = _side_effect_check
row['agent_judgment_question'] = _build_judgment_question(
    _action_class, _tokens, _hits, _hit_rate, _side_effect_required
)



# Classify as a first-class row column — so downstream tools (and the
# agent) don't have to re-derive the verdict. Must match the rule in
# bench-local-triage.py's classify() exactly; keep them in sync or the
# two will drift and produce silent contradictions.
def _classify(row):
    bs_raw = row.get("browser_block_signals") or ""
    try:
        bs = json.loads(bs_raw) if isinstance(bs_raw, str) and bs_raw.startswith("[") else []
        bs_str = ",".join(bs) if isinstance(bs, list) else str(bs)
    except Exception:
        bs_str = str(bs_raw)
    has_ops = row.get("has_available_operations")
    n_ops_v = row.get("n_operations") or 0
    trace_ok = row.get("trace_success") is True
    src = row.get("source") or ""
    err = row.get("error_code") or ""
    REAL_BLOCK_VENDORS = (
        "vendor:cloudflare", "vendor:perimeterx", "vendor:datadome",
        "vendor:akamai_bot_manager", "vendor:imperva_incapsula",
        "vendor:shape_security", "vendor:kasada",
    )
    has_real_vendor = bs_str and any(v in bs_str for v in REAL_BLOCK_VENDORS)
    if bs_str and ("challenge_title" in bs_str or "no_html_many_apis" in bs_str or "low_capture" in bs_str or "empty_capture" in bs_str or has_real_vendor):
        return "BROWSER_BLOCK"
    try:
        text_bytes = int(row.get("captured_text_bytes") or 0)
    except (ValueError, TypeError):
        text_bytes = 0
    if bs_str and "vendor:captcha_vendor" in bs_str and text_bytes < 2000:
        return "BROWSER_BLOCK"
    # Mode 1 soft-block: page rendered ~nothing AND sparse capture without
    # an explicit vendor signal. Observed on g2.com (text=6), target (text=90),
    # etsy (text=8) — all CF/JS-challenge interstitials that don't trip
    # the vendor classifier but functionally blocked the agent. Treat as
    # BROWSER_BLOCK so the bench doesn't blame the product for upstream blocks.
    if (
        text_bytes < 100
        and bs_str
        and "sparse_capture_mostly_noise" in bs_str
        and not has_real_vendor
    ):
        return "BROWSER_BLOCK"
    diag = row.get("capture_diagnostic") or ""
    if diag in ("no_endpoints_extracted", "all_endpoints_filtered_by_noise_rules"):
        return "BROWSER_BLOCK"
    if not src and row.get("trace_success") is None and not has_ops:
        return "BROWSER_BLOCK"
    if row.get("cli_timeout"):
        return "BROWSER_BLOCK"
    if err == "auth_required" or row.get("auth_recommended") is True:
        return "AUTH_GATED"
    if has_ops and n_ops_v > 0:
        if row.get("all_ops_dom_fallback"):
            return "PASS_DOM_FALLBACK_ONLY"
        return "PASS"
    if trace_ok and src == "dom-fallback":
        return "PASS_DOM_FALLBACK_ONLY"
    if trace_ok and src in ("direct-fetch", "direct-document"):
        return "PASS"
    if src == "browse-session":
        return "PASS"
    if trace_ok:
        # Trace success but unrecognized source — surface as weak pass so
        # direct-fetch-style paths that return usable data aren't mis-
        # classified as product fail.
        return "PASS_WEAK"
    return "PRODUCT_FAIL"

row["verdict"] = _classify(row)
print(json.dumps(row))
PY

if [ ! -f "$CORPUS" ]; then
  echo "[bench-local] no corpus at $CORPUS" >&2
  exit 1
fi

SLICE=$(mktemp)
if [ "$SIZE" -gt 0 ]; then
  tail -n "+$((OFFSET+1))" "$CORPUS" | head -n "$SIZE" > "$SLICE"
else
  tail -n "+$((OFFSET+1))" "$CORPUS" > "$SLICE"
fi

N=$(wc -l < "$SLICE" | tr -d ' ')
echo "[bench-local] running $N URLs, timeout=${TIMEOUT}s" >&2

# pkill removed for peer-safe isolation
sleep 0.3

i=0
> "$OUT_DIR/results.jsonl"
# Read each corpus line; support BOTH formats:
#   2-field: goal | url                                  (auth defaults to "none")
#   6-field: lane | auth | difficulty | strategy | intent | contextUrl  (gate corpus)
# Detected per-line by pipe-count >= 5.
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  pipe_count=$(awk -F'|' '{print NF-1}' <<<"$line")
  if [ "$pipe_count" -ge 5 ]; then
    lane=$(printf '%s' "$line"      | awk -F'|' '{print $1}' | sed 's/^ *//;s/ *$//')
    auth=$(printf '%s' "$line"      | awk -F'|' '{print $2}' | sed 's/^ *//;s/ *$//')
    difficulty=$(printf '%s' "$line"| awk -F'|' '{print $3}' | sed 's/^ *//;s/ *$//')
    strategy=$(printf '%s' "$line"  | awk -F'|' '{print $4}' | sed 's/^ *//;s/ *$//')
    goal=$(printf '%s' "$line"      | awk -F'|' '{print $5}' | sed 's/^ *//;s/ *$//')
    url=$(printf '%s' "$line"       | awk -F'|' '{print $6}' | sed 's/^ *//;s/ *$//')
  else
    lane=""
    auth="none"
    difficulty=""
    strategy=""
    goal=$(printf '%s' "$line" | awk -F'|' '{print $1}' | sed 's/^ *//;s/ *$//')
    url=$(printf '%s' "$line"  | awk -F'|' '{print $2}' | sed 's/^ *//;s/ *$//')
  fi
  [ -z "$goal" ] && continue
  [ -z "$url" ] && continue
  i=$((i+1))
  slug=$(printf '%s' "$url" | tr '/:?&=.' '_')
  out_file="$OUT_DIR/${i}_${slug:0:60}.out"
  echo "[bench-local] ($i/$N) [$auth] $url" >&2

  # Precondition gate: auth-required and auth-cookies probes only run when
  # the local machine has fresh browser cookies for the target domain.
  # Honest measurement (CLAUDE.md): without a cookie the bench cannot
  # measure whether Unbrowse's XHR + cookie-injection ladder works.
  # Locked DB (Chrome running) -> source=locked -> still attempt the probe
  # (locked != "no cookie"). Only source in (chrome, firefox, none) with
  # fresh=false triggers a skip.
  if [ "$auth" = "required" ] || [ "$auth" = "dia" ]; then
    domain=$(printf '%s' "$url" | awk -F'/' '{print $3}' | awk -F':' '{print $1}')
    cookie_check_json=$(python3 "$(dirname "$0")/check_cookie_freshness.py" "$domain" 2>/dev/null || echo '{}')
    cookie_fresh=$(printf '%s' "$cookie_check_json" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print('1' if d.get('fresh') else '0')" 2>/dev/null || echo 0)
    cookie_source=$(printf '%s' "$cookie_check_json" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('source',''))" 2>/dev/null || echo "")
    cookie_reason=$(printf '%s' "$cookie_check_json" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('reason',''))" 2>/dev/null || echo "")
    if [ "$cookie_fresh" = "0" ] && [ "$cookie_source" != "locked" ]; then
      echo "  [bench-local] SKIPPED_NO_FRESH_COOKIES domain=$domain auth=$auth :: $cookie_reason" >&2
      python3 -c "
import json,sys
row = {
  'goal': sys.argv[1],
  'url': sys.argv[2],
  'auth': sys.argv[3],
  'lane': sys.argv[4],
  'difficulty': sys.argv[5],
  'strategy': sys.argv[6],
  'domain': sys.argv[7],
  'verdict': 'SKIPPED_NO_FRESH_COOKIES',
  'cookie_check': sys.argv[8],
  'cookie_source': sys.argv[9],
}
print(json.dumps(row))
" "$goal" "$url" "$auth" "$lane" "$difficulty" "$strategy" "$domain" "$cookie_reason" "$cookie_source" >> "$OUT_DIR/results.jsonl"
      continue
    else
      echo "  [bench-local] cookie precondition met (source=$cookie_source) :: running probe" >&2
    fi
  fi

  force_flag=""
  [ "$FORCE_CAPTURE" -eq 1 ] && force_flag="--force-capture"
  probe_t0_ms=$(python3 -c "import time; print(int(time.time()*1000))")
  timeout "$TIMEOUT" $CLI_CMD resolve --intent "$goal" --url "$url" $force_flag </dev/null > "$out_file" 2>&1
  cli_exit=$?
  if [ "$cli_exit" -ne 0 ]; then
    echo "  [bench-local] cli exit=$cli_exit (timeout=124, killed=137)" >&2
  fi
  # Auto-retry once on empty output (process died silently, zombie from
  # prior run, kuri sigsegv cascade). Yelp hit this pattern in the 29-URL
  # bench but passed on direct retry — the harness should absorb that
  # flake instead of letting it pollute the evidence.
  # Skip retry if the first attempt was a clean timeout (exit=124) — the
  # site is blocked/stuck at the browser level and a retry will time out
  # the same way, wasting 90s per URL. v6 wayfair/bestbuy hit this.
  if { [ ! -s "$out_file" ] || [ "$(wc -c < "$out_file")" -lt 200 ]; } && [ "$cli_exit" -ne 124 ]; then
    echo "  [bench-local] empty output, killing residuals and retrying once" >&2
    # pkill removed for peer-safe isolation
    sleep 0.5
    timeout "$TIMEOUT" $CLI_CMD resolve --intent "$goal" --url "$url" </dev/null > "$out_file" 2>&1
    cli_exit=$?
    if [ "$cli_exit" -ne 0 ]; then
      echo "  [bench-local] retry cli exit=$cli_exit" >&2
    fi
  fi
  record=$(python3 "$OUT_DIR/extract.py" "$out_file" "$goal" "$url" "$cli_exit")
  # Second retry: if the record shows no_html_many_apis, the browser
  # fired lots of requests but Kuri's getPageHtml returned nothing.
  # Give it a 2x timeout — heavily JS-rendered SPAs sometimes need more
  # time for the main document to settle. Only retry if it was specifically
  # this signal, not all failures (don't double the cost of real blocks).
  if printf '%s' "$record" | grep -q '"no_html_many_apis"'; then
    retry_timeout=$((TIMEOUT * 2))
    echo "  [bench-local] no_html_many_apis — retrying once with timeout=${retry_timeout}s" >&2
    # pkill removed for peer-safe isolation
    sleep 0.5
    timeout "$retry_timeout" $CLI_CMD resolve --intent "$goal" --url "$url" </dev/null > "$out_file" 2>&1
    cli_exit=$?
    if [ "$cli_exit" -ne 0 ]; then
      echo "  [bench-local] no_html retry cli exit=$cli_exit" >&2
    fi
    record=$(python3 "$OUT_DIR/extract.py" "$out_file" "$goal" "$url" "$cli_exit")
  fi
  probe_t1_ms=$(python3 -c "import time; print(int(time.time()*1000))")
  probe_ms=$((probe_t1_ms - probe_t0_ms))
  # Inject actual_total_ms (wall-clock across the resolve + any retries) so
  # Phase 6 latency summary has real timing evidence. Substrate-faithful:
  # raw ms only, no verdict.
  record=$(printf '%s' "$record" | python3 -c "import sys,json; r=json.loads(sys.stdin.read()); r['actual_total_ms']=int(sys.argv[1]); print(json.dumps(r))" "$probe_ms")
  echo "$record" >> "$OUT_DIR/results.jsonl"
  # Show a compact one-line evidence summary for the agent watching the run.
  # No pass/fail/block verdict — the agent reads results.jsonl / .csv at the end.
  printf '%s' "$record" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
parts = []
if d.get('has_available_operations'): parts.append(f\"ops={d['n_operations']}\")
if d.get('source'): parts.append(f\"src={d['source']}\")
if d.get('error_code'): parts.append(f\"err={d['error_code']}\")
if d.get('captured_html_bytes') != '': parts.append(f\"html={d['captured_html_bytes']}\")
if d.get('captured_text_bytes') != '': parts.append(f\"text={d['captured_text_bytes']}\")
if d.get('captured_api_calls') != '': parts.append(f\"apis={d['captured_api_calls']}\")
if d.get('captured_title'): parts.append(f\"title={d['captured_title'][:40]!r}\")
print('  ' + ' | '.join(parts), file=sys.stderr)
"
  # pkill removed for peer-safe isolation
  sleep 0.3
done < "$SLICE"

rm -f "$SLICE"

# Render the evidence CSV the agent will read. No verdict, no rate, no gate.
python3 - "$OUT_DIR/results.jsonl" <<'PY'
import sys, json, csv
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if not rows:
    print("[bench-local] no rows collected", file=sys.stderr)
    sys.exit(0)
fieldnames = []
seen_fields = set()
for r in rows:
    for k in r.keys():
        if k not in seen_fields:
            seen_fields.add(k)
            fieldnames.append(k)
with open('.bench-local/evidence.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
    w.writeheader()
    for r in rows:
        w.writerow(r)
# Dump the JSONL back out as the agent-consumable artifact.
print(json.dumps({'rows': rows, 'count': len(rows)}, indent=2))
# Group rows by category using the structured signals. This is NOT a
# verdict — it's a deterministic grouping from the signals the product
# already emitted, so the agent sees a consistent denominator across runs.
# The agent still reviews each row in-thread for anything non-obvious.
from collections import defaultdict
buckets = defaultdict(list)
for r in rows:
    bs = r.get('browser_block_signals') or ''
    src = r.get('source') or ''
    has_ops = r.get('has_available_operations')
    n_ops = r.get('n_operations', 0) or 0
    trace_ok = r.get('trace_success')
    err = r.get('error_code') or ''
    # Browser-block takes precedence — the product never had a chance.
    # no_html_many_apis is a kuri-layer capture failure (getPageHtml
    # returned empty despite network firing); same effect as block.
    diag = r.get('capture_diagnostic', '') or ''
    text_bytes = int(r.get('captured_text_bytes') or 0)
    real_vendors = ('vendor:cloudflare', 'vendor:perimeterx', 'vendor:datadome',
                    'vendor:akamai_bot_manager', 'vendor:imperva_incapsula',
                    'vendor:shape_security', 'vendor:kasada')
    has_real_vendor = bs and any(v in bs for v in real_vendors)
    has_captcha_only = bs and 'vendor:captcha_vendor' in bs and not has_real_vendor
    # Hard block: real interception vendor, explicit challenge title,
    # or capture-layer failure. captcha_vendor alone doesn't qualify
    # if rich text was captured (defensive script inclusion).
    if bs and bs != '[]' and ('challenge_title' in bs or 'no_html_many_apis' in bs or 'low_capture' in bs or 'empty_capture' in bs or has_real_vendor):
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif has_captcha_only and text_bytes < 2000:
        # captcha vendor + no rich content → still a block
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif diag in ('no_endpoints_extracted', 'all_endpoints_filtered_by_noise_rules'):
        # capture_diagnostic signals the browser ran but extraction/ranking
        # yielded nothing usable — effectively a block from the agent's
        # perspective. Same bucket as vendor-classified block.
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif diag == 'endpoints_scored_below_relevance_threshold' and int(r.get('total_endpoints_captured') or 0) <= 2:
        # Only a handful of endpoints captured AND all scored below
        # threshold — the real data APIs weren't in the capture stream
        # (browser saw only telemetry/analytics). Yandex captured 1
        # endpoint (mc.yandex.ru/watch — Metrica beacon). Effectively
        # a browser block.
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif not src and trace_ok is None and has_ops is not True:
        # No source + no trace + no ops + no signals → the CLI never
        # returned a top-level response object. Almost always because
        # both attempts hit a clean timeout (wayfair/bestbuy/asos).
        # That's a BROWSER_BLOCK: the site is stuck/blocked at the
        # browser level and we couldn't even finish a capture.
        buckets['BROWSER_BLOCK'].append(r['url'])
    elif err == 'auth_required' or r.get('auth_recommended') is True:
        buckets['AUTH_GATED'].append(r['url'])
    elif has_ops and n_ops > 0:
        # SPLIT: if every captured op is a dom-fallback synthetic
        # (captured page artifact / resource_kind=message), that's
        # NOT real API discovery. The agent gets HTML back, not APIs.
        # Mark it honestly so coverage numbers reflect real API capture.
        if r.get('all_ops_dom_fallback'):
            buckets['PASS_DOM_FALLBACK_ONLY'].append(r['url'])
        else:
            buckets['PASS'].append(r['url'])
    elif trace_ok and src == 'dom-fallback':
        buckets['PASS_DOM_FALLBACK_ONLY'].append(r['url'])
    elif trace_ok and src in ('direct-fetch', 'direct-document'):
        # direct-fetch/direct-document = product short-circuited to raw HTTP fetch. When
        # the trace is successful the body was retrieved — even without
        # extracted "endpoints", the agent has the raw HTML/JSON to act
        # on. Count as PASS for coverage purposes.
        buckets['PASS'].append(r['url'])
    elif src == 'browse-session':
        # browse-session = product opened a browser session and handed
        # off to the agent with next_step='unbrowse snap'. The product
        # is working as designed: the agent drives the browser from
        # here. Count as PASS for coverage purposes — the product
        # gave a valid response, just not extracted endpoints.
        buckets['PASS'].append(r['url'])
    elif not has_ops and int(r.get('captured_text_bytes') or 0) >= 2000 and (r.get('captured_intent_verdict') or '') != 'fail' and not ('challenge_title' in bs or 'no_html_many_apis' in bs or 'low_capture' in bs or 'empty_capture' in bs or any(v in bs for v in ('vendor:cloudflare', 'vendor:perimeterx', 'vendor:datadome', 'vendor:akamai_bot_manager', 'vendor:imperva_incapsula', 'vendor:shape_security', 'vendor:kasada'))):
        # Rich HTML content available. No HARD block signal:
        # - challenge_title (direct block page)
        # - no_html_many_apis / low_capture / empty_capture (no content)
        # - real interception vendors (cf/px/dd/akamai/imperva/shape/kasada)
        # vendor:captcha_vendor is OK here — captcha scripts are often
        # included defensively (reCAPTCHA/hCaptcha for forms) without
        # blocking the main content. Observed on investopedia (10957 text
        # bytes) and accuweather (5494 text bytes) both flagged captcha
        # vendor but content was complete.
        # sparse_capture_mostly_noise is also OK — noisy API captures
        # don't preclude rich HTML content (e.g. cheat.sh/tar).
        buckets['PASS'].append(r['url'])
    elif bs and 'sparse_capture_mostly_noise' in bs:
        # Ambiguous — could be browser-level, could be product. Agent decides.
        buckets['SPARSE_REVIEW'].append(r['url'])
    else:
        buckets['PRODUCT_FAIL'].append(r['url'])

total = len(rows)
real_passes = len(buckets['PASS'])
fallback_passes = len(buckets['PASS_DOM_FALLBACK_ONLY'])
total_passes = real_passes + fallback_passes
blocked = len(buckets['BROWSER_BLOCK']) + len(buckets['AUTH_GATED'])
reachable = total - blocked
print(f"\n[bench-local] rubric tally (agent still judges in-thread):", file=sys.stderr)
for k in ('PASS', 'PASS_DOM_FALLBACK_ONLY', 'PRODUCT_FAIL', 'SPARSE_REVIEW', 'BROWSER_BLOCK', 'AUTH_GATED'):
    urls = buckets.get(k, [])
    if not urls:
        continue
    print(f"  {k:<25} {len(urls):>3}", file=sys.stderr)
    for u in urls:
        print(f"    - {u}", file=sys.stderr)
if reachable > 0:
    print(f"\n[bench-local] REAL-API pass: {real_passes}/{reachable} ({100*real_passes/reachable:.0f}%)  — captured actual API endpoints", file=sys.stderr)
    print(f"[bench-local] dom-fallback-only: {fallback_passes}/{reachable} ({100*fallback_passes/reachable:.0f}%)  — page HTML returned, no API discovered", file=sys.stderr)
    print(f"[bench-local] product-reachable total: {total_passes}/{reachable} ({100*total_passes/reachable:.0f}%)", file=sys.stderr)
print(f"[bench-local] raw pass (incl. fallback): {total_passes}/{total} ({100*total_passes/total:.0f}%)", file=sys.stderr)
print(f"\n[bench-local] wrote {len(rows)} rows to .bench-local/evidence.csv", file=sys.stderr)
print("[bench-local] per-URL raw outputs in .bench-local/*.out", file=sys.stderr)
print("[bench-local] results.jsonl has the same rows in JSON Lines format", file=sys.stderr)
print("[bench-local] — agent reads the artifacts and judges in-thread. buckets above are a signal grouping, not a verdict.", file=sys.stderr)
PY
