from __future__ import annotations

import json
from pathlib import Path

from evals.unbrowse_capability_harness import run_unbrowse_capability_harness


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _seed_green_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()

    _write(
        repo / "package.json",
        json.dumps(
            {
                "scripts": {
                    "test:agent-xp": "bash scripts/agent-experience-test.sh",
                    "eval:codex:product-success": "bun evals/codex-autonomous-harness.ts --cases evals/codex-cases.product-success.json",
                }
            }
        ),
    )
    _write(repo / "AGENTS.md", "## Auth Primitives — Autonomous Login\nsessions-scan\ngo <url>\nsnap --filter interactive\n")
    _write(repo / "docs/codex-eval-harness.md", "Recommended Codex loop:\nbun run eval:codex:product-success\nterminal_ok\n")
    _write(repo / "docs/workflow-harness.md", "workflow artifact\n")
    _write(repo / "docs/2026-03-31-orchestrator-analysis.md", "## 21 Return Paths in resolveAndExecute\n")
    _write(
        repo / "src/cli.ts",
        """
import { runSetup } from "./runtime/setup.js";
async function cmdSessionsScan() { scanAllBrowserSessions(); }
function auth() { console.log("Authentication required."); console.log('unbrowse login --url "https://x.com/home"'); }
async function cmdGo() {}
async function cmdSnap() {}
async function cmdClick() {}
async function cmdFill() {}
async function cmdSubmit() {}
async function cmdClose() {}
"unbrowse setup"
"sessions-scan"
"scanAllBrowserSessions"
"unbrowse go https://example.com"
"unbrowse snap --filter interactive"
""",
    )
    _write(
        repo / "src/orchestrator/index.ts",
        """
status: "browse_session_open"
next_step: "unbrowse snap --filter interactive"
No cached API for this intent. Browser session open
""",
    )
    _write(
        repo / "scripts/drop-in-onboarding-test.sh",
        """
npm install -g unbrowse@preview
unbrowse setup --no-start
unbrowse resolve
unbrowse execute
""",
    )
    _write(
        repo / "scripts/agent-experience-test.sh",
        """
record "browse_go"
record "browse_eval"
record "browse_snap_head"
record "browse_close"
Always record browse_go
""",
    )
    _write(
        repo / "scripts/agent-xp-view.ts",
        """
const x = ["browse_go", "browse_close"];
const y = "missing_from_artifact";
const z = "agent should investigate";
""",
    )
    _write(repo / "scripts/inspect-page-signals.py", 'return "browser_block:cloudflare"\n')
    _write(repo / "tests/cli-agent-experience.test.ts", "surfaces auth_required without auto-login side effects\n")
    _write(repo / "tests/browser-block-signals.test.ts", "vendor:cloudflare\nchallenge_title\n")
    _write(repo / "tests/codex-product-success-cases.test.ts", "product success guard\n")
    _write(
        repo / "evals/codex-autonomous-harness-lib.ts",
        """
return { class: "blocked", terminal: true, reason: "cloudflare_blocked" };
""",
    )
    _write(
        repo / "evals/codex-cases.product-success.json",
        json.dumps(
            {
                "cases": [
                    {"id": "a", "intent": "search repositories", "url": "https://a", "expected_fields": ["x"]},
                    {"id": "b", "intent": "search projects", "url": "https://b", "expected_fields": ["x"]},
                    {"id": "c", "intent": "search packages", "url": "https://c", "expected_fields": ["x"]},
                    {"id": "d", "intent": "get package info", "url": "https://d", "expected_fields": ["x"]},
                    {"id": "e", "intent": "search docs", "url": "https://e", "expected_fields": ["x"]},
                    {"id": "f", "intent": "search hacker news", "url": "https://f", "params": {"q": "openai"}, "expected_fields": ["x"]},
                    {"id": "g", "intent": "get tag questions", "url": "https://g", "expected_fields": ["x"]},
                    {"id": "h", "intent": "search emails", "url": "https://h", "expected_fields": ["x"]},
                ]
            }
        ),
    )
    _write(
        repo / "evals/codex-cases.public-expansion.json",
        json.dumps(
            {
                "cases": [
                    {
                        "id": "blocked",
                        "intent": "get package info",
                        "url": "https://mvnrepository.com",
                        "expected_fields": ["x"],
                        "validate": {"terminal_ok": ["cloudflare_blocked"]},
                    }
                ]
            }
        ),
    )
    _write(
        repo / "evals/history/autonomous.jsonl",
        json.dumps(
            {
                "ts": "2026-04-18T00:00:00Z",
                "summary": {"total": 8, "pass": 8, "fail": 0, "skip": 0, "blocked": 0, "satisfied": 8},
            }
        ) + "\n",
    )
    return repo


def test_run_unbrowse_capability_harness_green_path_promotes(tmp_path: Path) -> None:
    repo = _seed_green_repo(tmp_path)

    report = run_unbrowse_capability_harness(repo)

    assert report["schema_version"] == "unbrowse_capability_harness_v1"
    assert report["plan"]["schema_version"] == "unbrowse_capability_harness_plan_v1"
    assert report["plan"]["claims_under_test"] == [
        "install_setup",
        "first_task_success",
        "auth_path",
        "browser_ops",
        "hostile_site_boundary",
        "agent_guidance",
    ]
    assert report["fib_harness"]["active_arc"]["phases"][0]["name"] == "plan_from_repo_truth"
    assert report["fib_harness"]["active_arc"]["break_phase"]["phase"] == 7
    assert report["fib_harness"]["active_arc"]["promotion_phase"]["phase"] == 8
    assert len(report["fib_harness"]["children"]) == 6
    assert report["final"]["overall_status"] == "pass"
    assert report["final"]["next_action"] == "promote"
    assert report["final"]["pending_escalations"] == []


def test_run_unbrowse_capability_harness_blocks_when_core_boundaries_break(tmp_path: Path) -> None:
    repo = _seed_green_repo(tmp_path)
    (repo / "scripts/drop-in-onboarding-test.sh").unlink()
    _write(repo / "evals/codex-cases.public-expansion.json", json.dumps({"cases": []}))

    report = run_unbrowse_capability_harness(repo)

    assert report["final"]["overall_status"] == "fail"
    assert report["final"]["next_action"] == "repair"
    assert "install_setup" in report["final"]["blocking_claims"]
    assert "hostile_site_boundary" in report["final"]["blocking_claims"]
    assert "missing_drop_in_harness" in report["final"]["blocking_problem_codes"]
    assert "cf_boundary_not_encoded" in report["final"]["blocking_problem_codes"]


def test_run_unbrowse_capability_harness_escalates_when_runtime_proof_missing(tmp_path: Path) -> None:
    repo = _seed_green_repo(tmp_path)
    (repo / "evals/history/autonomous.jsonl").unlink()

    report = run_unbrowse_capability_harness(repo)

    assert report["final"]["overall_status"] == "unproved"
    assert report["final"]["next_action"] == "await_child_verdict"
    assert report["final"]["escalation_status"] == "requested"
    assert report["final"]["pending_escalations"][0]["harness_kind"] == "codex_public_runtime_harness"
    assert "first_task_success" in report["final"]["unproved_claims"]


def test_run_unbrowse_capability_harness_marks_guidance_partial_when_snap_help_is_missing(tmp_path: Path) -> None:
    repo = _seed_green_repo(tmp_path)
    cli_path = repo / "src/cli.ts"
    cli_path.write_text(cli_path.read_text(encoding="utf-8").replace('"unbrowse snap --filter interactive"\n', "").replace("'unbrowse snap --filter interactive',\n", ""), encoding="utf-8")

    report = run_unbrowse_capability_harness(repo)

    assert report["claim_judgements"]["agent_guidance"]["status"] == "partial"
    assert report["final"]["overall_status"] == "partial"
    assert report["final"]["next_action"] == "hold"
    assert report["final"]["promotion_readiness"] == "hold"
    assert report["final"]["stop_reason"] == "nonblocking_quality_gap_present"
    assert report["final"]["watch_claims"] == ["agent_guidance"]
