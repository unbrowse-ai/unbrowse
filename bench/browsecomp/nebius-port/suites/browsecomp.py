import logging
from pathlib import Path

from search_evals.agents import DeepResearchAgent
from search_evals.datasets import BROWSECOMP, Dataset, Datum
from search_evals.search_engines import ContaminationFilter
from search_evals.suites.graders import DeepResearchGrader
from search_evals.suites.types import AsyncBaseSuite, TaskResult

logger = logging.getLogger(__name__)


BrowseCompContaminationFilter = ContaminationFilter(
    title_ban_re=r"browsecomp|benchmark|huggingface",
    doc_ban_re=r"browsecomp|ai agent",
    url_ban_re=r"browsecomp|linkedin|/x\.com|huggingface",
)


class BrowseCompSuite(AsyncBaseSuite):
    def __init__(self, search_engine: str, model: str, output_dir: Path, dry_run: bool, max_workers: int) -> None:
        super().__init__(search_engine, model, output_dir, dry_run, max_workers)
        import os as _os
        _env_limit = _os.environ.get("BROWSECOMP_LIMIT")
        _limit = int(_env_limit) if _env_limit else (20 if self.dry_run else None)
        self.dataset = Dataset(BROWSECOMP, encrypted=True, limit=_limit)
        # Best-of-N orchestration (cited: arXiv:2504.12516, +15-25% from parallel
        # rollout + confidence-weighted vote). BROWSECOMP_BEST_OF_N>1 wraps the
        # agent; =1 (default) is the original single-rollout DeepResearchAgent.
        _n = int(_os.environ.get("BROWSECOMP_BEST_OF_N", "1"))
        # Always wrap in BestOfNAgent: n=1 is single-shot WITH the give-up guard
        # (a fully-failed question yields score 0, never crashes the whole eval);
        # n>1 adds confidence-weighted parallel voting.
        from search_evals.agents.best_of_n import BestOfNAgent
        self.agent = BestOfNAgent(
            search_engine, model, n=_n, contamination_filter=BrowseCompContaminationFilter
        )
        logger.info(f"BrowseComp agent: best-of-{_n}" + (" (confidence-weighted vote)" if _n > 1 else " (single-shot, guarded)"))
        self.grader = DeepResearchGrader()

    async def _run_task(self, datum: Datum) -> TaskResult:
        # Guard end-to-end: a transient agent OR grader API error (e.g. an
        # OpenRouter 429 that exhausts tenacity retries) must score this question
        # 0, never crash the whole multi-hour eval via the suite's asyncio.gather.
        from search_evals.suites.types import GradeType, GraderResult
        try:
            convo = await self.agent(datum.problem)
        except Exception as e:
            logger.warning(f"agent failed on {datum.id}: {e} -> scoring 0")
            convo = self.agent._giveup(datum.problem)
        try:
            grader_result = await self.grader(datum, convo)
        except Exception as e:
            logger.warning(f"grader failed on {datum.id}: {e} -> scoring 0")
            grader_result = GraderResult(
                grade_type=GradeType.INCORRECT,
                problem=str(getattr(datum, "problem", "")),
                answer="",
                response=convo.last_text() if convo else "",
                grade_text=f"grader-error: {e}",
            )
        return TaskResult(datum=datum, convo=convo, grader_result=grader_result)
