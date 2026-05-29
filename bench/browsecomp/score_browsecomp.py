#!/usr/bin/env python3
"""score_browsecomp.py -- the WALK + SEAL atoms for the BrowseComp track.

BrowseComp is question -> short-answer MULTI-HOP retrieval (OpenAI's browsing
benchmark), NOT url -> facts like the WebCode extraction track. So it gets its
own vessel rather than overloading score_extract.py.

This scores the CONTRACT on a 2-row seed corpus: it proves the harness reads the
corpus, scores predictions by normalized answer containment, prints the report
shape, and gates on a target via the exit code. It does NOT yet prove a
benchmark number -- a real number needs live unbrowse predictions over the full
published BrowseComp set, and the TARGET below must be pinned from the BrowseComp
paper before this is allowed to gate CI (right now it is an honest placeholder).

This is the substrate (it emits evidence); the AGENT judges whether the score
truly beats the target -- never a status-code stand-in (CLAUDE.md Judge step).

corpus format (bench/browsecomp/corpus.seed.jsonl), one JSON per line:
    {"id": "...", "question": "...", "answer": "<canonical short answer>"}

predictions format (optional argv[2], one JSON per line):
    {"id": "...", "prediction": "<model's free-text answer>"}
If absent, the inline DEMO_PREDICTIONS are used so the scorer runs standalone.

metric: normalized exact-match / containment -- the canonical answer (lowercased,
punctuation-stripped) must appear in the (same-normalized) prediction; averaged
over items, reported as percent.

usage: python3 score_browsecomp.py [corpus.seed.jsonl] [predictions.jsonl]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CORPUS = os.path.join(HERE, "corpus.seed.jsonl")

# PLACEHOLDER target -- the real BrowseComp SOTA target MUST be pinned from the
# published paper before this gates CI. Until then this is a seed, not a win.
TARGET = 30.0  # browsecomp_accuracy percent to beat (placeholder)

# Inline demo predictions so the scorer RUNS standalone and demonstrates the
# contract. These stand in for real unbrowse multi-hop predictions.
DEMO_PREDICTIONS = {
    "switch-maker-clamshell":
        "Nintendo's first clamshell handheld was the Nintendo DS, released in 2004.",
    "moon-landing-cmd-pilot":
        "Apollo 11's Command Module Pilot was Michael Collins.",
}


def norm(s):
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.split())


def hit(answer, prediction):
    return norm(answer) in norm(prediction or "")


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def main(corpus, preds_path):
    cases = load_jsonl(corpus)
    if preds_path:
        preds = {r["id"]: r.get("prediction", "") for r in load_jsonl(preds_path)}
    else:
        preds = dict(DEMO_PREDICTIONS)
    per_item = []
    hits = 0
    for c in cases:
        h = hit(c["answer"], preds.get(c["id"], ""))
        hits += 1 if h else 0
        per_item.append({"id": c["id"], "hit": h})
    score = round(100 * hits / len(cases), 1) if cases else 0.0
    report = {"metric": "browsecomp_accuracy",
              "target": TARGET,
              "unbrowse": score,
              "beats": score > TARGET,
              "n": len(cases),
              "per_item": per_item}
    print(json.dumps(report, indent=2))
    # honest exit: non-zero if we did NOT beat the target, so CI can gate.
    return 0 if report["beats"] else 1


if __name__ == "__main__":
    corpus = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CORPUS
    preds_path = sys.argv[2] if len(sys.argv) > 2 else None
    sys.exit(main(corpus, preds_path))
