"""best_of_n.py — parallel best-of-N / confidence-weighted aggregation over the
DeepResearchAgent.

Cited foundation (bench/browsecomp/FOUNDATION-PAPERS.md): the BrowseComp paper
itself (arXiv:2504.12516) measures +15–25% accuracy from running N parallel
rollouts and aggregating by majority / confidence-weighted vote / best-of-N — the
single highest-evidence, model-agnostic lever, needing NO retraining. This is the
route-graph thesis's `witness . eval` node (cross-document corroboration) made
operational over the agent loop: run the loop K times, let the answers corroborate
each other, and commit only the answer that recurs.

Aggregation (no gold access, so we cannot peek): extract each rollout's
"Exact Answer:" + "Confidence:", normalise the answer string, and sum confidence
per distinct answer. The answer with the greatest summed confidence wins
(confidence-weighted majority vote — the paper's middle strategy). We RETURN the
Conversation of a rollout that produced the winning answer, so the grader sees a
real, coherent transcript whose last_text() carries the corroborated answer.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re

from search_evals.agents.deep_research import DeepResearchAgent
from search_evals.agents.llms import Conversation
from search_evals.agents.types import AsyncBaseAgent
from search_evals.search_engines import ContaminationFilter

logger = logging.getLogger(__name__)

_EXACT = re.compile(r"Exact Answer:\s*(.+?)(?:\n|$)", re.IGNORECASE | re.DOTALL)
_CONF = re.compile(r"Confidence:\s*(\d{1,3})", re.IGNORECASE)


def _extract_answer(text: str) -> str:
    m = _EXACT.search(text or "")
    if not m:
        return ""
    # First line of the exact-answer span (avoid swallowing a trailing Confidence:)
    ans = m.group(1).split("\n")[0].strip()
    return ans


def _extract_conf(text: str) -> float:
    m = _CONF.search(text or "")
    if not m:
        return 50.0  # neutral prior when the model omits a confidence
    try:
        return max(0.0, min(100.0, float(m.group(1))))
    except ValueError:
        return 50.0


def _normalise(ans: str) -> str:
    a = ans.lower().strip()
    a = re.sub(r"^(the|a|an)\s+", "", a)
    a = re.sub(r"[\"'`.,;:!?()\[\]]", "", a)
    a = re.sub(r"\s+", " ", a).strip()
    return a


class BestOfNAgent(AsyncBaseAgent):
    def __init__(
        self,
        search_engine: str,
        model: str,
        n: int = 4,
        max_steps: int = 10,
        contamination_filter: ContaminationFilter | None = None,
    ) -> None:
        self.n = max(1, int(n))
        # One inner agent; DeepResearchAgent.__call__ copies its toolset locally,
        # so concurrent __call__ on a single instance is race-safe.
        self.inner = DeepResearchAgent(
            search_engine, model, max_steps=max_steps, contamination_filter=contamination_filter
        )

    async def __call__(self, prompt: str) -> Conversation:
        if self.n == 1:
            return await self.inner(prompt)

        async def _one(i: int) -> Conversation | None:
            try:
                return await self.inner(prompt)
            except Exception as e:  # one rollout failing must not sink the vote
                logger.warning(f"best-of-{self.n} rollout {i} failed: {e}")
                return None

        convos = [c for c in await asyncio.gather(*[_one(i) for i in range(self.n)]) if c is not None]
        if not convos:
            raise RuntimeError("all best-of-N rollouts failed")

        # Confidence-weighted vote over normalised Exact Answers.
        weight: dict[str, float] = {}
        rep: dict[str, Conversation] = {}  # a representative convo per answer key
        best_conf: dict[str, float] = {}
        answered: list[tuple[Conversation, float]] = []
        for c in convos:
            text = c.last_text()
            ans = _extract_answer(text)
            conf = _extract_conf(text)
            if not ans or _normalise(ans) in ("", "i dont know", "i don't know", "unknown", "none"):
                continue
            key = _normalise(ans)
            answered.append((c, conf))
            weight[key] = weight.get(key, 0.0) + conf
            if conf >= best_conf.get(key, -1.0):
                best_conf[key] = conf
                rep[key] = c  # keep the highest-confidence transcript for this answer

        if not weight:
            # No rollout produced a usable answer — return the highest-confidence convo.
            return max(answered, key=lambda t: t[1])[0] if answered else convos[0]

        winner = max(weight.items(), key=lambda kv: (kv[1], best_conf[kv[0]]))[0]
        votes = sum(1 for c in convos if _normalise(_extract_answer(c.last_text())) == winner)
        logger.info(
            f"best-of-{self.n}: winner='{winner}' weight={weight[winner]:.0f} "
            f"votes={votes}/{len(convos)} distinct={len(weight)}"
        )
        return rep[winner]
