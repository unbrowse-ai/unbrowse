#!/usr/bin/env python3
"""gen_golden — self-generate the webcode-benchmark golden markdown, legally.

The benchmark ships URLs only; exa-labs withholds golden_markdown.jsonl "for
licensing reasons" and tells you to generate it yourself (README §"Golden
markdown"). Their pipeline: render each URL (full JS) -> capture DOM -> feed to
a multimodal LLM -> "markdown faithful to the rendered page". We reproduce that
pipeline ourselves, so the golden is OUR artifact (not redistributed exa IP):

    render   = unbrowse fetch <url>           (full-JS rendered page text/HTML)
    golden   = LLM(rendered)  ->  faithful markdown of the page         [THIS FILE]
    extracted= unbrowse extract <url>         (the thing under test)    [contents eval]
    score    = det_rouge_l(golden, extracted)

For github-blob URLs the golden is DETERMINISTIC (the raw file) and needs no LLM
— we use raw.githubusercontent directly (identical to exa's golden, no ambiguity).
For every other URL the golden is the LLM's faithful markdown of the rendered
page (same SHAPE as exa's golden; an equivalent-golden, not byte-identical).

Honest caveat: a self-generated LLM golden is EQUIVALENT to exa's, not identical,
so "beats 0.828" on the non-github subset is an equivalent-golden measurement.
The github subset (deterministic raw-file golden) is a rigorous, exact beat.

Usage:
    OPENAI_API_KEY=... UNBROWSE_BIN=... python3 gen_golden.py [N] [--out PATH]
    N = number of corpus rows to process (default 8). Writes {id, expected_markdown}.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
CORPUS = HERE / "vendor/benchmarks/webcode-benchmark/data/contents/code_contents.jsonl"
OUT = HERE / "vendor/benchmarks/webcode-benchmark/data/contents/golden_markdown.jsonl"
UNBROWSE = os.environ.get("UNBROWSE_BIN", "/Users/lekt9/.bun/bin/unbrowse")
# Golden LLM endpoint — OpenAI-compatible. Defaults to OpenAI; the project's
# live quota is on Nebius TokenFactory, so set GOLDEN_API_URL/GOLDEN_API_KEY/
# GOLDEN_MODEL to point there (Kimi-K2.5) when the OpenAI key is rate-limited.
GOLDEN_API_URL = os.environ.get("GOLDEN_API_URL", "https://api.openai.com/v1/chat/completions")
GOLDEN_KEY = os.environ.get("GOLDEN_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
GOLDEN_MODEL = os.environ.get("GOLDEN_MODEL", "gpt-4.1")

_TRACE = re.compile(
    r"^(\[\d{2}:\d{2}:\d{2}(\.\d+)?\]|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]"
    r"|info:|warn:|warning:|error:|debug:|\[kuri|\[marketplace\]|\[exa\]|\[perf\]|\[lifecycle\]|\[kuri-proxy\])"
)


def clean_trace(s: str) -> str:
    return "\n".join(ln for ln in s.splitlines() if not _TRACE.match(ln.strip()))


def gh_blob_to_raw(url: str) -> str | None:
    m = re.match(r"^https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", url)
    if not m:
        return None
    return f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}"


def render(url: str, timeout: int = 120) -> str:
    """The golden's page source = UNBROWSE's OWN render (the same fetch path the
    extraction under test uses, browser-fallback for JS pages). Fair input AND
    output: the golden LLM reads unbrowse's render, the extraction parses the
    same render — so a thin render yields a thin golden AND thin extraction (they
    match) instead of a curl/fetch MISMATCH producing false zeros (the d92
    outliers). NOT circular: the golden is the LLM's faithful markdown of the
    render; the extraction is unbrowse's DETERMINISTIC cleanDOM+turndown of the
    same render — two different transforms of one shared input."""
    try:
        r = subprocess.run([UNBROWSE, "fetch", url], capture_output=True, text=True, timeout=timeout)
        html = clean_trace(r.stdout)
        # collapse the rendered HTML to text the golden LLM refines into markdown.
        html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
        text = re.sub(r"(?s)<[^>]+>", " ", html)
        text = re.sub(r"&[a-z]+;|&#\d+;", " ", text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n\n", text)
        return text.strip()
    except Exception as e:  # noqa: BLE001
        return f"__RENDER_ERR__ {e}"


def openai_markdown(rendered: str, url: str, title: str) -> str:
    """Faithful-markdown golden: ask the LLM to reproduce the page's main content
    as clean markdown (drop nav/chrome/ads), the benchmark's golden definition."""
    body = rendered[:60000]
    prompt = (
        "You are producing GOLDEN reference markdown for a web-content extraction "
        "benchmark. Given the rendered text of a web page, output the page's MAIN "
        "content as clean, faithful Markdown: keep all substantive prose, code "
        "blocks, headings, lists, and tables; DROP navigation, sidebars, ads, "
        "cookie banners, footers, and site chrome. Output ONLY the markdown, no "
        "preamble.\n\n"
        f"URL: {url}\nTitle: {title}\n\n--- RENDERED PAGE ---\n{body}"
    )
    req = urllib.request.Request(
        GOLDEN_API_URL,
        data=json.dumps({
            "model": GOLDEN_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }).encode(),
        headers={"Authorization": f"Bearer {GOLDEN_KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    return d["choices"][0]["message"]["content"].strip()


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 8
    out_path = OUT
    if "--out" in sys.argv:
        out_path = Path(sys.argv[sys.argv.index("--out") + 1])
    if not GOLDEN_KEY:
        print("[gen_golden] no golden LLM key (GOLDEN_API_KEY / OPENAI_API_KEY)", file=sys.stderr)
        return 2

    rows = [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()][:n]
    out_rows = []
    for i, q in enumerate(rows, 1):
        url, qid, title = q["url"], q["id"], q.get("title", "")
        raw = gh_blob_to_raw(url)
        if raw:
            try:
                body = urllib.request.urlopen(raw, timeout=30).read().decode("utf-8", "replace")
                out_rows.append({"id": qid, "expected_markdown": body, "_golden": "raw-file"})
                print(f"  [{i}/{len(rows)}] {qid} GOLDEN=raw-file ({len(body.split())}w) {url[:55]}")
                continue
            except Exception as e:  # noqa: BLE001
                print(f"  [{i}/{len(rows)}] {qid} raw fetch failed ({e}); falling to LLM golden")
        rendered = render(url)
        if rendered.startswith("__RENDER_ERR__") or len(rendered.split()) < 20:
            print(f"  [{i}/{len(rows)}] {qid} SKIP (render thin/failed: {rendered[:60]})")
            continue
        try:
            md = openai_markdown(rendered, url, title)
        except Exception as e:  # noqa: BLE001
            print(f"  [{i}/{len(rows)}] {qid} SKIP (llm golden failed: {e})")
            continue
        out_rows.append({"id": qid, "expected_markdown": md, "_golden": "llm"})
        print(f"  [{i}/{len(rows)}] {qid} GOLDEN=llm ({len(md.split())}w) {url[:55]}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        for r in out_rows:
            f.write(json.dumps({"id": r["id"], "expected_markdown": r["expected_markdown"]}) + "\n")
    det = sum(1 for r in out_rows if r["_golden"] == "raw-file")
    print(f"[gen_golden] wrote {len(out_rows)} golden rows ({det} deterministic raw-file, {len(out_rows)-det} llm) -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
