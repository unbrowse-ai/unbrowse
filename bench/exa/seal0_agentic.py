#!/usr/bin/env python3
"""seal0_agentic.py — Unbrowse agentic retrieve-reflect loop on the PUBLIC SEAL-0 set.

Target (jesus-loop session=default, user pick B): beat Exa Research Pro's 59.1% on the
111 public SealQA SEAL-0 questions (HF vtllms/sealqa, config seal_0), reproducibly, with
an open LLM grader — never by reading the answer key.

Honesty contract (lewis-brain gate, bench/exa/SEAL-0-PLAN.lewis-brain.md):
  * The agent loop sees ONLY the `question`. The gold `answer`/`urls`/`search_results`
    columns are passed to the GRADER alone — never into the agent context. Enforced by
    build_agent_input() returning the question string and nothing else.
  * A per-question error is recorded as incorrect+errored (fail-loud), never skipped.
  * Every run writes a JSONL ledger; accuracy is computed only over graded rows.

Agent LLM : Nebius Kimi-K2.5 (OpenAI-compatible)         [SEAL0_AGENT_MODEL]
Grader    : OpenAI                                        [SEAL0_GRADER_MODEL]
Retrieval : UnbrowseSearcher (DDG SERP + full-page enrich via `unbrowse fetch`)

Usage:
  python3 bench/exa/seal0_agentic.py --limit 1            # smoke test, 1 question
  python3 bench/exa/seal0_agentic.py --limit 111 --workers 6
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field

# Point the shared searcher at the real binary before importing it.
os.environ.setdefault("UNBROWSE_BIN", "/opt/nanobrew/prefix/bin/unbrowse")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unbrowse_searcher import UnbrowseSearcher  # noqa: E402

from openai import OpenAI  # noqa: E402

NEBIUS_BASE = "https://api.tokenfactory.nebius.com/v1"

# Provider registry: name -> (base_url | None for OpenAI, key_env, default model).
PROVIDERS = {
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "google/gemini-2.5-flash"),
    "nebius":     (NEBIUS_BASE,                    "NEBIUS_API_KEY",     "moonshotai/Kimi-K2.5"),
    "openai":     (None,                           "OPENAI_API_KEY",     "gpt-4o"),
}
# Agent: OpenRouter (Kimi-K2.5 returned empty completions + echoed queries).
AGENT_PROVIDER = os.environ.get("SEAL0_AGENT_PROVIDER", "openrouter")
AGENT_MODEL = os.environ.get("SEAL0_AGENT_MODEL", PROVIDERS[AGENT_PROVIDER][2])
# Grader: independent frontier model on OpenRouter (≠ agent model = cleaner witness).
GRADER_PROVIDER = os.environ.get("SEAL0_GRADER_PROVIDER", "openrouter")
GRADER_MODEL = os.environ.get("SEAL0_GRADER_MODEL", "openai/gpt-4o-mini")
N_ANGLES = int(os.environ.get("SEAL0_N_ANGLES", "3"))
MAX_ROUNDS = int(os.environ.get("SEAL0_MAX_ROUNDS", "2"))   # adaptive follow-up rounds
MIN_SEARCHES = int(os.environ.get("SEAL0_MIN_SEARCHES", "2"))
RESULTS_PER_SEARCH = int(os.environ.get("SEAL0_RESULTS_PER_SEARCH", "5"))
RESULT_CHARS = int(os.environ.get("SEAL0_RESULT_CHARS", "1200"))   # per-snippet, in-context
CTX_SNIPPET_CHARS = int(os.environ.get("SEAL0_CTX_SNIPPET_CHARS", "320"))  # planner digest
EVIDENCE_KEEP = int(os.environ.get("SEAL0_EVIDENCE_KEEP", "8"))    # snippets into reconciler

# Phase A.1 — decompose: propose N DISTINCT search angles up front. Diversity is the
# lever: the single naive query returns only the popular (trap) answer.
DECOMPOSE_SYS = (
    "You research one hard fact-seeking question whose web results often CONFLICT, are "
    "stale, or hide a non-obvious correct answer behind the popular one. Propose {N} "
    "DISTINCT web search queries that attack the question from different angles and "
    "surface AUTHORITATIVE PRIMARY sources. At least one query MUST probe the exact, "
    "literal framing of the question (e.g. a record counting engineers/producers, not just "
    "artists; a count as of a specific date/season). Do NOT just restate the question.\n"
    'Reply with EXACTLY ONE JSON object: {\"queries\":[\"q1\",\"q2\",\"q3\"]} (no commentary).'
)

# Phase A.2 — follow-up: given a compact digest, request ONE more targeted query if the
# answer is not yet pinned, else stop. Keeps context small (no empty-completion bloat).
FOLLOWUP_SYS = (
    "You are gathering evidence for one hard question whose sources may CONFLICT. Given the "
    "evidence digest, if a single precise answer is NOT yet firmly supported by an "
    "authoritative source, request ONE more targeted query that would resolve the conflict. "
    "Otherwise stop.\n"
    'Reply with EXACTLY ONE JSON object: {\"action\":\"search\",\"query\":\"<q>\"} or {\"action\":\"ready\"}.'
)

# Phase B — reconciler: given the gathered evidence, name the candidate answers and their
# support, resolve the conflict, and emit ONE precise answer. Always returns an answer.
RECONCILER_SYS = (
    "You are given a hard question and EVIDENCE excerpts from live web pages that may "
    "CONFLICT. Do this: (1) list each candidate answer and which source supports it; "
    "(2) pick the one backed by the most AUTHORITATIVE, SPECIFIC, and RECENT source that "
    "matches the question's exact framing — distrust the merely popular answer; "
    "(3) output the final answer as short and exact as the question demands.\n"
    'Reply with EXACTLY ONE JSON object: {\"analysis\":\"<1-3 sentences>\",\"answer\":\"<precise answer>\"}.'
)

GRADER_SYS = (
    "You are a strict grader for short-answer factual questions. Given the QUESTION, the "
    "GOLD answer, and a PREDICTED answer, decide if the prediction is semantically correct "
    "(same entity/value as gold, ignoring phrasing, extra words, or formatting). "
    'Reply with EXACTLY ONE JSON object: {\"correct\": true} or {\"correct\": false}.'
)


def _client(base_url: str | None, key_env: str) -> OpenAI:
    key = os.environ.get(key_env)
    if not key:
        raise SystemExit(f"FAIL-LOUD: {key_env} not set — cannot run honestly.")
    return OpenAI(api_key=key, base_url=base_url) if base_url else OpenAI(api_key=key)


def _extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {}


def build_agent_input(row: dict) -> str:
    """The ONLY thing the agent ever sees. Gold key columns are intentionally excluded."""
    return row["question"]


@dataclass
class Trace:
    qid: int
    question: str
    gold: str
    pred: str = ""
    analysis: str = ""
    correct: bool = False
    rounds: int = 0
    searches: list = field(default_factory=list)
    n_evidence: int = 0
    errored: bool = False
    error: str = ""


async def _chat(agent: OpenAI, messages: list, max_tokens: int = 700) -> str:
    """One chat call; retry once on empty content (the empty-completion bug guard)."""
    for _ in range(2):
        resp = await asyncio.to_thread(
            agent.chat.completions.create,
            model=AGENT_MODEL, messages=messages, temperature=0.2, max_tokens=max_tokens,
        )
        content = (resp.choices[0].message.content or "").strip()
        if content:
            return content
    return ""


async def run_agent(searcher: UnbrowseSearcher, agent: OpenAI, tr: Trace) -> None:
    question = build_agent_input({"question": tr.question})
    evidence: list[dict] = []   # {query, rank, title, url, text}

    def digest() -> str:
        if not evidence:
            return "(no evidence yet)"
        return "\n".join(
            f"- [{e['query']}] {e['title']} :: {(e['text'] or '')[:CTX_SNIPPET_CHARS]}"
            for e in evidence[-EVIDENCE_KEEP:]
        )

    async def _gather(q: str) -> None:
        q = q[:300]
        if not q or q in tr.searches:
            return
        results = await searcher.search(q, num_results=RESULTS_PER_SEARCH)
        tr.searches.append(q)
        for i, r in enumerate(results):
            evidence.append({"query": q, "rank": i, "title": r.title or r.url,
                             "url": r.url, "text": (r.text or "")[:RESULT_CHARS]})

    # ---- Phase A.1: decompose into N distinct angles, run them concurrently ----
    dec = await _chat(agent, [
        {"role": "system", "content": DECOMPOSE_SYS.replace("{N}", str(N_ANGLES))},
        {"role": "user", "content": f"Question: {question}\n\nJSON:"},
    ], max_tokens=300)
    angles = [str(x) for x in _extract_json(dec).get("queries", []) if str(x).strip()]
    if not angles:
        angles = [question, f"{question} (exact record holder, including non-obvious)"]
    await asyncio.gather(*[_gather(a) for a in angles[:N_ANGLES]])

    # ---- Phase A.2: up to MAX_ROUNDS adaptive follow-ups to resolve a conflict ----
    for rnd in range(1, MAX_ROUNDS + 1):
        tr.rounds = rnd
        act = _extract_json(await _chat(agent, [
            {"role": "system", "content": FOLLOWUP_SYS},
            {"role": "user", "content": f"Question: {question}\n\nEvidence digest:\n{digest()}\n\nJSON:"},
        ], max_tokens=200))
        if act.get("action") == "ready" and len(tr.searches) >= MIN_SEARCHES:
            break
        if act.get("query"):
            await _gather(str(act["query"]))

    tr.n_evidence = len(evidence)

    # ---- Phase B: reconcile + answer (always produces an answer) ----
    ev_text = "\n\n".join(
        f"[{j+1}] {e['title']}\nURL: {e['url']}\n{e['text']}"
        for j, e in enumerate(evidence[:EVIDENCE_KEEP])
    ) or "(no evidence retrieved)"
    rec_msgs = [
        {"role": "system", "content": RECONCILER_SYS},
        {"role": "user", "content": f"QUESTION: {question}\n\nEVIDENCE:\n{ev_text}\n\nFinal JSON:"},
    ]
    content = await _chat(agent, rec_msgs, max_tokens=700)
    obj = _extract_json(content)
    tr.analysis = str(obj.get("analysis", ""))[:500]
    tr.pred = str(obj.get("answer", "")).strip() or content[:200]


def grade(grader: OpenAI, tr: Trace) -> None:
    resp = grader.chat.completions.create(
        model=GRADER_MODEL,
        messages=[
            {"role": "system", "content": GRADER_SYS},
            {"role": "user", "content": (
                f"QUESTION: {tr.question}\nGOLD: {tr.gold}\nPREDICTED: {tr.pred}"
            )},
        ],
        temperature=0,
    )
    tr.correct = bool(_extract_json(resp.choices[0].message.content or "").get("correct"))


async def process(searcher, agent, grader, qid, row) -> Trace:
    tr = Trace(qid=qid, question=row["question"], gold=str(row["answer"]))
    try:
        await run_agent(searcher, agent, tr)
        await asyncio.to_thread(grade, grader, tr)
    except Exception as e:  # noqa: BLE001 - fail loud, count as incorrect
        tr.errored, tr.error, tr.correct = True, f"{type(e).__name__}: {e}"[:300], False
    return tr


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--ledger", default=None)
    args = ap.parse_args()

    from datasets import load_dataset
    ds = load_dataset("vtllms/sealqa", "seal_0")["test"]
    n = min(args.limit, len(ds))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    ledger = args.ledger or f"bench/exa/seal0_run_{stamp}.jsonl"

    a_base, a_key_env, _ = PROVIDERS[AGENT_PROVIDER]
    agent = _client(a_base, a_key_env)
    g_base, g_key_env, _ = PROVIDERS[GRADER_PROVIDER]
    grader = _client(g_base, g_key_env)
    searcher = UnbrowseSearcher()

    print(f"SEAL-0 agentic run | n={n} agent={AGENT_MODEL}({AGENT_PROVIDER}) "
          f"grader={GRADER_MODEL}({GRADER_PROVIDER}) "
          f"angles={N_ANGLES} followups<={MAX_ROUNDS} workers={args.workers}\nledger={ledger}", flush=True)

    sem = asyncio.Semaphore(args.workers)

    async def _guard(qid, row):
        async with sem:
            tr = await process(searcher, agent, grader, qid, row)
            mark = "ERR " if tr.errored else ("✓" if tr.correct else "✗")
            print(f"  [{qid+1}/{n}] {mark} rounds={tr.rounds} searches={len(tr.searches)} "
                  f"| gold={tr.gold[:40]!r} pred={tr.pred[:50]!r}"
                  + (f" | {tr.error}" if tr.errored else ""), flush=True)
            return tr

    traces = await asyncio.gather(*[_guard(i, ds[i]) for i in range(n)])

    correct = sum(1 for t in traces if t.correct)
    errored = sum(1 for t in traces if t.errored)
    acc = correct / n if n else 0.0
    with open(ledger, "w") as f:
        for t in traces:
            f.write(json.dumps(t.__dict__) + "\n")
    print("\n=== SEAL-0 RESULT (public set, open grader) ===")
    print(f"accuracy = {correct}/{n} = {acc:.4f}  ({acc*100:.1f}%)")
    print(f"errored  = {errored}  (counted as incorrect — fail-loud)")
    print(f"Exa Research Pro published = 0.591 (59.1%) on SEAL-0 [Parallel, private harness]")
    verdict = "BEATS published Exa" if acc > 0.591 else "below Exa-published (not yet a win)"
    print(f"verdict (vs 59.1%): {verdict}")
    print(f"ledger written: {ledger}")


if __name__ == "__main__":
    asyncio.run(main())
