from __future__ import annotations

import json
import subprocess
from argparse import ArgumentParser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CLAIM_IDS = (
    "install_setup",
    "first_task_success",
    "auth_path",
    "browser_ops",
    "hostile_site_boundary",
    "agent_guidance",
)
STATUS_RANK = {"pass": 0, "partial": 1, "unproved": 2, "fail": 3}
IMPORTANT_DOC_PATHS = (
    "AGENTS.md",
    "docs/codex-eval-harness.md",
    "docs/workflow-harness.md",
    "docs/2026-03-31-orchestrator-analysis.md",
)
RUNTIME_PATHS = (
    "src/cli.ts",
    "src/orchestrator/index.ts",
    "evals/codex-autonomous-harness-lib.ts",
    "scripts/agent-experience-test.sh",
    "scripts/drop-in-onboarding-test.sh",
    "scripts/agent-xp-view.ts",
)
TEST_PATHS = (
    "tests/cli-agent-experience.test.ts",
    "tests/browser-block-signals.test.ts",
    "tests/codex-product-success-cases.test.ts",
    "tests/test_unbrowse_capability_harness.py",
)
ARTIFACT_PATHS = (
    "evals/codex-cases.product-success.json",
    "evals/codex-cases.public-expansion.json",
    "evals/history/autonomous.jsonl",
    "evals/codex-autonomous-last-run.json",
    "evals/codex-auth-eval-last-run.json",
)
GIT_HISTORY_PATHS = (
    "scripts/agent-experience-test.sh",
    "scripts/drop-in-onboarding-test.sh",
    "tests/cli-agent-experience.test.ts",
    "tests/browser-block-signals.test.ts",
    "evals/codex-cases.product-success.json",
)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _load_jsonl_last(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return {}
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return {}


def _relative_existing_paths(repo_root: Path, rel_paths: tuple[str, ...]) -> list[str]:
    return [rel_path for rel_path in rel_paths if (repo_root / rel_path).exists()]


def _contains_all(text: str, needles: tuple[str, ...]) -> bool:
    return all(needle in text for needle in needles)


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    normalized = ts.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _git_history(repo_root: Path) -> list[str]:
    if not (repo_root / ".git").exists():
        return []
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "-n", "8", "--", *GIT_HISTORY_PATHS],
            cwd=repo_root,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def _check(
    check_id: str,
    ok: bool,
    detail: str,
    *,
    domain: str,
    evidence_refs: list[str] | tuple[str, ...] = (),
    problem_code: str | None = None,
    repair_hint: str | None = None,
    severity: str = "error",
    blocking: bool = True,
) -> dict[str, Any]:
    return {
        "schema_version": "unbrowse_capability_harness_check_v1",
        "check_id": check_id,
        "domain": domain,
        "ok": ok,
        "severity": severity,
        "blocking": blocking,
        "problem_code": problem_code,
        "detail": detail,
        "repair_hint": repair_hint,
        "evidence_refs": list(evidence_refs),
    }


def _advisory(
    advisory_id: str,
    *,
    domain: str,
    problem_code: str,
    detail: str,
    repair_hint: str,
    evidence_refs: list[str] | tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "schema_version": "unbrowse_capability_harness_advisory_v1",
        "advisory_id": advisory_id,
        "domain": domain,
        "problem_code": problem_code,
        "detail": detail,
        "repair_hint": repair_hint,
        "evidence_refs": list(evidence_refs),
    }


def _problem_from_check(check: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "unbrowse_capability_harness_problem_v1",
        "source_check_id": check["check_id"],
        "domain": check["domain"],
        "problem_code": check["problem_code"] or check["check_id"],
        "severity": check["severity"],
        "blocking": check["blocking"],
        "detail": check["detail"],
        "repair_hint": check["repair_hint"] or "inspect the failing boundary and retry",
        "evidence_refs": list(check.get("evidence_refs", [])),
    }


def _phase_record(
    phase: int,
    name: str,
    status: str,
    *,
    evidence: list[str] | tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "phase": phase,
        "name": name,
        "status": status,
        "evidence": list(evidence),
    }


def _claim(
    claim_id: str,
    *,
    status: str,
    detail: str,
    evidence_refs: list[str] | tuple[str, ...],
    blocking: bool,
) -> dict[str, Any]:
    return {
        "claim_id": claim_id,
        "status": status,
        "detail": detail,
        "blocking": blocking,
        "evidence_refs": list(evidence_refs),
    }


def _build_plan(repo_root: Path, history_artifact: dict[str, Any] | None = None) -> dict[str, Any]:
    docs = _relative_existing_paths(repo_root, IMPORTANT_DOC_PATHS)
    runtime_paths = _relative_existing_paths(repo_root, RUNTIME_PATHS)
    test_paths = _relative_existing_paths(repo_root, TEST_PATHS)
    artifact_paths = _relative_existing_paths(repo_root, ARTIFACT_PATHS)
    persisted_codex_sources = []
    for rel_path in (
        ".codex",
        ".codex/ralph-audit/events.log",
        ".codex/ralph-audit/run.log",
        "evals/history/autonomous.jsonl",
        "evals/codex-autonomous-last-run.json",
        "evals/codex-auth-eval-last-run.json",
    ):
        if (repo_root / rel_path).exists():
            persisted_codex_sources.append(rel_path)
    git_history = _git_history(repo_root)
    latest_history_ts = (history_artifact or {}).get("ts")
    summary = (
        "Judge whether this repo currently enforces drop-in onboarding, first-task public success, "
        "auth/browser handoff, and explicit Cloudflare-browser-block boundaries for agents."
    )
    next_questions: list[str] = []
    if not (repo_root / "evals/history/autonomous.jsonl").exists():
        next_questions.append("No persisted public-run history; parent phase 7 should request a deeper runtime judge before promotion.")
    if not (repo_root / "evals/codex-cases.public-expansion.json").exists():
        next_questions.append("No public-expansion corpus found; hostile-site boundary is structurally under-specified.")
    if not git_history:
        next_questions.append("Recent git history unavailable from repo root; phase 1 used only file/artifact truth.")
    if not next_questions:
        next_questions.append("All planning surfaces present; phase 7 can promote unless runtime evidence is stale or contradicted.")
    return {
        "schema_version": "unbrowse_capability_harness_plan_v1",
        "summary": summary,
        "repo_inputs": {
            "docs": docs,
            "runtime_paths": runtime_paths,
            "test_paths": test_paths,
            "artifact_paths": artifact_paths,
            "git_history_checked": bool(git_history),
            "git_history_excerpt": git_history,
        },
        "codex_history_inputs": {
            "persisted_sources": persisted_codex_sources,
            "hidden_history_available": False,
            "latest_history_ts": latest_history_ts,
            "note": "Only persisted Codex traces or harness artifacts on disk count as available history.",
        },
        "claims_under_test": list(CLAIM_IDS),
        "next_questions": next_questions,
    }


def _child_fib_scope(
    *,
    claim_id: str,
    claim_status: str,
    problems: list[dict[str, Any]],
    advisories: list[dict[str, Any]],
    parent_arc_id: str,
) -> dict[str, Any]:
    scoped_problems = [item for item in problems if item["domain"] == claim_id]
    scoped_advisories = [item for item in advisories if item["domain"] == claim_id]
    if claim_status == "pass":
        next_action = "promote"
    elif claim_status == "fail":
        next_action = "repair"
    else:
        next_action = "hold"
    return {
        "schema_version": "unbrowse_capability_harness_fib_scope_v1",
        "arc_id": f"{parent_arc_id}:{claim_id}",
        "parent_arc_id": parent_arc_id,
        "scope_kind": "claim",
        "scope_name": claim_id,
        "parallel_children": [],
        "active_arc": {
            "phases": [
                _phase_record(1, "declare_claim_boundary", "pass", evidence=(claim_id,)),
                _phase_record(2, "observe_claim_inputs", "pass", evidence=(f"problems:{len(scoped_problems)}",)),
                _phase_record(3, "compress_claim_state", "pass", evidence=(f"advisories:{len(scoped_advisories)}",)),
                _phase_record(4, "score_claim_integrity", claim_status, evidence=(f"claim_status:{claim_status}",)),
                _phase_record(5, "spawn_claim_repairs", "pass" if scoped_problems else "hold", evidence=tuple(item["problem_code"] for item in scoped_problems)),
                _phase_record(6, "collect_claim_evidence", claim_status, evidence=tuple(item["advisory_id"] for item in scoped_advisories)),
            ],
            "break_phase": _phase_record(7, "break_to_claim_judgement", claim_status, evidence=(f"claim_status:{claim_status}",)),
            "promotion_phase": {
                **_phase_record(8, "claim_consequence", next_action, evidence=(f"claim_status:{claim_status}",)),
                "next_action": next_action,
            },
        },
        "problems": scoped_problems,
        "advisories": scoped_advisories,
    }


def _evaluate_install_setup(repo_root: Path, package_json: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    drop_in_path = repo_root / "scripts/drop-in-onboarding-test.sh"
    agent_xp_path = repo_root / "scripts/agent-experience-test.sh"
    cli_path = repo_root / "src/cli.ts"
    drop_in_text = _read_text(drop_in_path)
    cli_text = _read_text(cli_path)
    scripts = package_json.get("scripts", {}) if isinstance(package_json, dict) else {}

    checks.append(_check(
        "install_setup.drop_in_script_exists",
        drop_in_path.exists(),
        "Drop-in onboarding harness exists for blank-slate install/setup verification.",
        domain="install_setup",
        evidence_refs=("scripts/drop-in-onboarding-test.sh",),
        problem_code="missing_drop_in_harness",
        repair_hint="add or restore scripts/drop-in-onboarding-test.sh so onboarding can be proved from zero state",
    ))
    checks.append(_check(
        "install_setup.drop_in_script_covers_full_path",
        (
            "npm install -g unbrowse@preview" in drop_in_text
            and "setup --no-start" in drop_in_text
            and ("unbrowse resolve" in drop_in_text or '"first_resolve"' in drop_in_text)
            and ("unbrowse execute" in drop_in_text or '"first_execute"' in drop_in_text)
        ),
        "Drop-in harness covers install -> setup -> resolve -> execute.",
        domain="install_setup",
        evidence_refs=("scripts/drop-in-onboarding-test.sh",),
        problem_code="drop_in_path_incomplete",
        repair_hint="make the drop-in harness prove install, setup, resolve, and execute in one blank-slate run",
    ))
    checks.append(_check(
        "install_setup.agent_xp_script_wired",
        scripts.get("test:agent-xp") == "bash scripts/agent-experience-test.sh",
        "Package script exposes the agent experience collector with one command.",
        domain="install_setup",
        evidence_refs=("package.json", "scripts/agent-experience-test.sh"),
        problem_code="missing_agent_xp_entrypoint",
        repair_hint="wire package.json test:agent-xp to scripts/agent-experience-test.sh",
    ))
    checks.append(_check(
        "install_setup.cli_setup_surface_present",
        "runSetup" in cli_text and '"unbrowse setup"' in cli_text,
        "CLI carries setup surface and example usage.",
        domain="install_setup",
        evidence_refs=("src/cli.ts",),
        problem_code="cli_setup_surface_missing",
        repair_hint="restore setup command wiring and help examples in src/cli.ts",
    ))
    status = "pass" if all(item["ok"] for item in checks) else "fail"
    detail = (
        "Blank-slate onboarding path is runnable from repo scripts and CLI docs."
        if status == "pass"
        else "Blank-slate onboarding contract is broken or not fully wired."
    )
    return _claim(
        "install_setup",
        status=status,
        detail=detail,
        evidence_refs=["scripts/drop-in-onboarding-test.sh", "scripts/agent-experience-test.sh", "src/cli.ts", "package.json"],
        blocking=status != "pass",
    ), checks, advisories


def _evaluate_first_task_success(repo_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    cases_path = repo_root / "evals/codex-cases.product-success.json"
    cases_payload = _load_json(cases_path)
    cases = cases_payload.get("cases", []) if isinstance(cases_payload, dict) else []
    case_count = len(cases) if isinstance(cases, list) else 0
    seeded_params = sum(1 for case in cases if isinstance(case, dict) and case.get("params"))
    history_path = repo_root / "evals/history/autonomous.jsonl"
    latest_history = _load_jsonl_last(history_path)
    history_summary = latest_history.get("summary", {}) if isinstance(latest_history, dict) else {}
    history_total = history_summary.get("total", 0) if isinstance(history_summary, dict) else 0
    history_pass = history_summary.get("pass", 0) if isinstance(history_summary, dict) else 0
    history_ts = _parse_iso(latest_history.get("ts") if isinstance(latest_history, dict) else None)
    history_age_days = None
    if history_ts:
        history_age_days = max(0, int((datetime.now(timezone.utc) - history_ts).total_seconds() // 86400))

    checks.append(_check(
        "first_task_success.product_success_cases_present",
        case_count >= 8 and seeded_params >= 1,
        f"Product-success corpus is task-shaped (cases={case_count}, seeded={seeded_params}).",
        domain="first_task_success",
        evidence_refs=("evals/codex-cases.product-success.json",),
        problem_code="product_success_corpus_missing",
        repair_hint="restore a public task-shaped product-success corpus with at least one seeded-parameter case",
    ))
    checks.append(_check(
        "first_task_success.product_success_guard_test_present",
        (repo_root / "tests/codex-product-success-cases.test.ts").exists(),
        "Product-success corpus has a structural guard test.",
        domain="first_task_success",
        evidence_refs=("tests/codex-product-success-cases.test.ts",),
        problem_code="product_success_guard_missing",
        repair_hint="add or restore tests/codex-product-success-cases.test.ts to guard public task cases",
    ))
    history_ok = history_total >= case_count >= 8 and history_pass == history_total and history_total > 0
    checks.append(_check(
        "first_task_success.persisted_public_run_passes",
        history_ok,
        f"Latest persisted public run passes all cases (pass={history_pass}, total={history_total}).",
        domain="first_task_success",
        evidence_refs=("evals/history/autonomous.jsonl",),
        problem_code="missing_public_success_history",
        repair_hint="run the canonical product-success harness and persist a passing artifact before promoting this claim",
        severity="warning",
        blocking=False,
    ))
    if history_age_days is None:
        advisories.append(_advisory(
            "first_task_success.missing_history_timestamp",
            domain="first_task_success",
            problem_code="public_history_age_unknown",
            detail="Persisted public-run history is missing a usable timestamp.",
            repair_hint="write ISO timestamps into evals/history/autonomous.jsonl so freshness can be judged",
            evidence_refs=("evals/history/autonomous.jsonl",),
        ))
    elif history_age_days > 30:
        advisories.append(_advisory(
            "first_task_success.stale_public_history",
            domain="first_task_success",
            problem_code="public_history_stale",
            detail=f"Latest persisted public-run history is {history_age_days} days old.",
            repair_hint="rerun bun run eval:codex:product-success on this branch and persist the result before claiming broad support",
            evidence_refs=("evals/history/autonomous.jsonl",),
        ))

    structural_ok = all(item["ok"] for item in checks if item["blocking"])
    if not structural_ok:
        status = "fail"
        detail = "Public first-task success contract is missing required corpus or guard rails."
    elif not history_ok:
        status = "unproved"
        detail = "Public first-task success is structurally wired but lacks persisted all-pass proof."
    elif history_age_days is not None and history_age_days > 30:
        status = "partial"
        detail = "Public first-task success has historical proof, but it is stale for a broad current-branch claim."
    else:
        status = "pass"
        detail = "Public first-task success has task-shaped corpus, guard tests, and recent persisted all-pass evidence."
    return _claim(
        "first_task_success",
        status=status,
        detail=detail,
        evidence_refs=["evals/codex-cases.product-success.json", "tests/codex-product-success-cases.test.ts", "evals/history/autonomous.jsonl"],
        blocking=status in {"fail", "unproved"},
    ), checks, advisories


def _evaluate_auth_path(repo_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    cli_text = _read_text(repo_root / "src/cli.ts")
    cli_test_text = _read_text(repo_root / "tests/cli-agent-experience.test.ts")
    agents_text = _read_text(repo_root / "AGENTS.md")

    checks.append(_check(
        "auth_path.sessions_scan_surface_present",
        _contains_all(cli_text, ("cmdSessionsScan", "sessions-scan", "scanAllBrowserSessions")),
        "CLI exposes browser-session discovery for auth reuse.",
        domain="auth_path",
        evidence_refs=("src/cli.ts",),
        problem_code="sessions_scan_missing",
        repair_hint="restore sessions-scan command wiring in src/cli.ts",
    ))
    checks.append(_check(
        "auth_path.auth_required_guidance_present",
        "Authentication required." in cli_text and "unbrowse login --url" in cli_text,
        "CLI surfaces explicit auth_required guidance without silent side effects.",
        domain="auth_path",
        evidence_refs=("src/cli.ts",),
        problem_code="auth_guidance_missing",
        repair_hint="make resolve auth_required surface a concrete unbrowse login command",
    ))
    checks.append(_check(
        "auth_path.agent_xp_guard_test_present",
        "surfaces auth_required without auto-login side effects" in cli_test_text,
        "CLI auth_required behavior has a dedicated guard test.",
        domain="auth_path",
        evidence_refs=("tests/cli-agent-experience.test.ts",),
        problem_code="auth_guard_test_missing",
        repair_hint="restore CLI auth_required regression coverage",
    ))
    if "Auth Primitives — Autonomous Login" not in agents_text:
        advisories.append(_advisory(
            "auth_path.auth_doc_missing",
            domain="auth_path",
            problem_code="auth_protocol_doc_missing",
            detail="AGENTS.md no longer documents the repo auth primitive chain.",
            repair_hint="restore the Auth Primitives section in AGENTS.md so agents can onboard into the expected login flow quickly",
            evidence_refs=("AGENTS.md",),
        ))
    status = "pass" if all(item["ok"] for item in checks) else "fail"
    detail = (
        "Auth path has explicit session-reuse, auth_required guidance, and regression coverage."
        if status == "pass"
        else "Auth path is missing session reuse, clear guidance, or regression coverage."
    )
    return _claim(
        "auth_path",
        status=status,
        detail=detail,
        evidence_refs=["src/cli.ts", "tests/cli-agent-experience.test.ts", "AGENTS.md"],
        blocking=status != "pass",
    ), checks, advisories


def _evaluate_browser_ops(repo_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    cli_text = _read_text(repo_root / "src/cli.ts")
    orchestrator_text = _read_text(repo_root / "src/orchestrator/index.ts")
    xp_text = _read_text(repo_root / "scripts/agent-experience-test.sh")

    checks.append(_check(
        "browser_ops.cli_browse_verbs_present",
        all(token in cli_text for token in ("async function cmdGo", "async function cmdSnap", "async function cmdClick", "async function cmdFill", "async function cmdSubmit", "async function cmdClose")),
        "CLI exposes the browse primitives agents need for live fallback.",
        domain="browser_ops",
        evidence_refs=("src/cli.ts",),
        problem_code="browse_verbs_missing",
        repair_hint="restore go/snap/click/fill/submit/close browse verbs in src/cli.ts",
    ))
    checks.append(_check(
        "browser_ops.resolve_handoff_present",
        _contains_all(orchestrator_text, ('status: "browse_session_open"', 'next_step: "unbrowse snap --filter interactive"', "No cached API for this intent. Browser session open")),
        "Resolve path hands agents into a live browser session with explicit next steps.",
        domain="browser_ops",
        evidence_refs=("src/orchestrator/index.ts",),
        problem_code="browse_handoff_missing",
        repair_hint="restore browse-session handoff messaging in resolveAndExecute",
    ))
    checks.append(_check(
        "browser_ops.agent_xp_records_browse_failures",
        _contains_all(xp_text, ('record "browse_go"', 'record "browse_eval"', 'record "browse_snap_head"', 'record "browse_close"', "Always record browse_go")),
        "Agent-XP collector records browse evidence even when browser startup fails.",
        domain="browser_ops",
        evidence_refs=("scripts/agent-experience-test.sh",),
        problem_code="browse_evidence_drop",
        repair_hint="ensure agent experience artifact always records browse tasks, including failure paths",
    ))
    status = "pass" if all(item["ok"] for item in checks) else "fail"
    detail = (
        "Browser fallback path is explicit, command-complete, and observable in artifacts."
        if status == "pass"
        else "Browser fallback path is missing verbs, handoff guidance, or failure observability."
    )
    return _claim(
        "browser_ops",
        status=status,
        detail=detail,
        evidence_refs=["src/cli.ts", "src/orchestrator/index.ts", "scripts/agent-experience-test.sh"],
        blocking=status != "pass",
    ), checks, advisories


def _evaluate_hostile_site_boundary(repo_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    block_test_text = _read_text(repo_root / "tests/browser-block-signals.test.ts")
    autonomous_text = _read_text(repo_root / "evals/codex-autonomous-harness-lib.ts")
    public_expansion_payload = _load_json(repo_root / "evals/codex-cases.public-expansion.json")
    public_cases = public_expansion_payload.get("cases", []) if isinstance(public_expansion_payload, dict) else []
    cf_terminal_ok = any(
        isinstance(case, dict)
        and "cloudflare_blocked" in (((case.get("validate") or {}).get("terminal_ok")) or [])
        for case in public_cases
    )
    inspect_text = _read_text(repo_root / "scripts/inspect-page-signals.py")

    checks.append(_check(
        "hostile_site_boundary.cloudflare_signal_tests_present",
        "vendor:cloudflare" in block_test_text and "challenge_title" in block_test_text,
        "Browser-block detector explicitly covers Cloudflare challenge signals.",
        domain="hostile_site_boundary",
        evidence_refs=("tests/browser-block-signals.test.ts",),
        problem_code="cloudflare_signal_tests_missing",
        repair_hint="restore explicit Cloudflare/browser-block regression tests",
    ))
    checks.append(_check(
        "hostile_site_boundary.autonomous_harness_terminalizes_cf",
        "cloudflare_blocked" in autonomous_text and 'class: "blocked"' in autonomous_text,
        "Autonomous harness turns Cloudflare/browser challenges into an explicit blocked terminal.",
        domain="hostile_site_boundary",
        evidence_refs=("evals/codex-autonomous-harness-lib.ts",),
        problem_code="cloudflare_terminal_missing",
        repair_hint="restore cloudflare_blocked terminal classification in autonomous harness failure taxonomy",
    ))
    checks.append(_check(
        "hostile_site_boundary.public_cases_allow_cf_boundary",
        cf_terminal_ok,
        "Public expansion corpus encodes Cloudflare browser blocks as an allowed terminal boundary.",
        domain="hostile_site_boundary",
        evidence_refs=("evals/codex-cases.public-expansion.json",),
        problem_code="cf_boundary_not_encoded",
        repair_hint="add at least one public expansion case whose validate.terminal_ok includes cloudflare_blocked",
    ))
    if "browser_block:cloudflare" not in inspect_text:
        advisories.append(_advisory(
            "hostile_site_boundary.inspect_helper_missing_cf_verdict",
            domain="hostile_site_boundary",
            problem_code="inspect_helper_missing_cf_boundary",
            detail="Page-signal inspection helper no longer emits browser_block:cloudflare.",
            repair_hint="restore browser_block:cloudflare verdict in scripts/inspect-page-signals.py so offline triage matches runtime taxonomy",
            evidence_refs=("scripts/inspect-page-signals.py",),
        ))
    status = "pass" if all(item["ok"] for item in checks) else "fail"
    detail = (
        "Hostile-site boundary is explicit: Cloudflare/browser gates stop as blocked, not as fake product success."
        if status == "pass"
        else "Hostile-site boundary is underspecified or no longer encoded as an explicit blocked terminal."
    )
    return _claim(
        "hostile_site_boundary",
        status=status,
        detail=detail,
        evidence_refs=["tests/browser-block-signals.test.ts", "evals/codex-autonomous-harness-lib.ts", "evals/codex-cases.public-expansion.json"],
        blocking=status != "pass",
    ), checks, advisories


def _evaluate_agent_guidance(repo_root: Path, package_json: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    view_text = _read_text(repo_root / "scripts/agent-xp-view.ts")
    docs_text = _read_text(repo_root / "docs/codex-eval-harness.md")
    cli_text = _read_text(repo_root / "src/cli.ts")
    scripts = package_json.get("scripts", {}) if isinstance(package_json, dict) else {}

    checks.append(_check(
        "agent_guidance.agent_xp_view_detects_silent_drops",
        _contains_all(view_text, ('"browse_go"', '"browse_close"', "missing_from_artifact", "agent should investigate")),
        "Agent-XP view surfaces silent drops instead of hiding them.",
        domain="agent_guidance",
        evidence_refs=("scripts/agent-xp-view.ts",),
        problem_code="agent_xp_visibility_missing",
        repair_hint="restore missing-task visibility in scripts/agent-xp-view.ts",
    ))
    checks.append(_check(
        "agent_guidance.eval_loop_documented",
        _contains_all(docs_text, ("Recommended Codex loop:", "bun run eval:codex:product-success", "terminal_ok")),
        "Docs explain the judge loop and the blocked-terminal contract.",
        domain="agent_guidance",
        evidence_refs=("docs/codex-eval-harness.md",),
        problem_code="codex_eval_loop_doc_missing",
        repair_hint="restore the eval loop docs and blocked-terminal guidance in docs/codex-eval-harness.md",
    ))
    checks.append(_check(
        "agent_guidance.onboarding_entrypoints_exposed",
        scripts.get("test:agent-xp") == "bash scripts/agent-experience-test.sh"
        and scripts.get("eval:codex:product-success") == "bun evals/codex-autonomous-harness.ts --cases evals/codex-cases.product-success.json",
        "Package scripts expose the agent-XP collector and canonical product-success run.",
        domain="agent_guidance",
        evidence_refs=("package.json",),
        problem_code="agent_entrypoints_missing",
        repair_hint="expose both agent-XP and canonical product-success scripts in package.json",
    ))
    if "unbrowse snap --filter interactive" not in cli_text:
        advisories.append(_advisory(
            "agent_guidance.snap_help_example_missing",
            domain="agent_guidance",
            problem_code="browse_help_example_missing",
            detail="CLI help no longer advertises the snap interactive fallback example.",
            repair_hint="restore go/snap/sync examples in CLI help output",
            evidence_refs=("src/cli.ts",),
        ))
    if not all(item["ok"] for item in checks):
        status = "fail"
        detail = "Agent guidance is missing a discoverable command, judge loop doc, or artifact visibility surface."
    elif advisories:
        status = "partial"
        detail = "Agent guidance works, but onboarding/discoverability still has sharp edges that block a perfect drop-in claim."
    else:
        status = "pass"
        detail = "Agents get clear entrypoints, artifact visibility, and a documented judge loop."
    return _claim(
        "agent_guidance",
        status=status,
        detail=detail,
        evidence_refs=["scripts/agent-xp-view.ts", "docs/codex-eval-harness.md", "package.json"],
        blocking=status == "fail",
    ), checks, advisories


def build_unbrowse_capability_harness_checks(
    repo_root: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    package_json = _load_json(repo_root / "package.json")
    history_artifact = _load_jsonl_last(repo_root / "evals/history/autonomous.jsonl")
    plan = _build_plan(repo_root, history_artifact)

    claims: dict[str, dict[str, Any]] = {}
    checks: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []

    for evaluator in (
        _evaluate_install_setup,
        _evaluate_first_task_success,
        _evaluate_auth_path,
        _evaluate_browser_ops,
        _evaluate_hostile_site_boundary,
        _evaluate_agent_guidance,
    ):
        if evaluator in {_evaluate_install_setup, _evaluate_agent_guidance}:
            claim, claim_checks, claim_advisories = evaluator(repo_root, package_json)  # type: ignore[arg-type]
        else:
            claim, claim_checks, claim_advisories = evaluator(repo_root)  # type: ignore[misc]
        claims[claim["claim_id"]] = claim
        checks.extend(claim_checks)
        advisories.extend(claim_advisories)

    pending_escalations: list[dict[str, Any]] = []
    unresolved_claims = [claim_id for claim_id, claim in claims.items() if claim["status"] in {"partial", "unproved"}]
    failing_claims = [claim_id for claim_id, claim in claims.items() if claim["status"] == "fail"]
    empirical_escalation_claims = [claim_id for claim_id in unresolved_claims if claim_id in {"first_task_success"}]
    if empirical_escalation_claims and not failing_claims:
        pending_escalations.append({
            "escalation_id": "capability_claim_needs_fresh_runtime_judge",
            "harness_kind": "codex_public_runtime_harness",
            "reason": "Structural repo proof exists, but at least one capability claim still needs a bounded empirical judge before promotion.",
            "blocking_claims": empirical_escalation_claims,
            "requested_cases_path": "evals/codex-cases.public-expansion.json",
            "requested_command": "bun run eval:codex:product-success",
        })

    return plan, checks, claims, advisories, pending_escalations


def run_unbrowse_capability_harness(repo_root: str | Path, *, output_path: str | Path | None = None) -> dict[str, Any]:
    repo_root = Path(repo_root)
    if output_path is None:
        output_path = repo_root / "runs/fib-harness-report.json"
    output_path = Path(output_path)
    if not output_path.is_absolute():
        output_path = repo_root / output_path

    plan, checks, claims, advisories, pending_escalations = build_unbrowse_capability_harness_checks(repo_root)
    problems = [_problem_from_check(item) for item in checks if not item["ok"]]
    blocking_problem_codes = sorted(problem["problem_code"] for problem in problems if problem["blocking"])
    blocking_claims = sorted(claim_id for claim_id, claim in claims.items() if claim["status"] == "fail")
    unproved_claims = sorted(claim_id for claim_id, claim in claims.items() if claim["status"] == "unproved")
    watch_claims = sorted(claim_id for claim_id, claim in claims.items() if claim["status"] == "partial")

    if blocking_claims:
        overall_status = "fail"
        next_action = "repair"
        stop_reason = "blocking_claims_present"
        escalation_status = "not_requested"
    elif unproved_claims:
        overall_status = "unproved"
        next_action = "await_child_verdict" if pending_escalations else "repair"
        stop_reason = "fresh_runtime_proof_missing"
        escalation_status = "requested" if pending_escalations else "not_requested"
    elif watch_claims:
        overall_status = "partial"
        next_action = "await_child_verdict" if pending_escalations else "hold"
        stop_reason = "nonblocking_quality_gap_present" if not pending_escalations else "supporting_evidence_stale"
        escalation_status = "requested" if pending_escalations else "not_requested"
    else:
        overall_status = "pass"
        next_action = "promote"
        stop_reason = "capability_contract_supported"
        escalation_status = "clear"

    fib_arc_id = "unbrowse_capability_harness"
    break_status = "fail" if blocking_claims else overall_status
    fib_harness = {
        "schema_version": "unbrowse_capability_harness_fib_scope_v1",
        "arc_id": fib_arc_id,
        "parent_arc_id": None,
        "scope_kind": "harness",
        "scope_name": "unbrowse_capability_harness",
        "parallel_children": [f"{fib_arc_id}:{claim_id}" for claim_id in CLAIM_IDS],
        "active_arc": {
            "phases": [
                _phase_record(1, "plan_from_repo_truth", "pass", evidence=tuple(plan["repo_inputs"]["docs"][:4] + plan["codex_history_inputs"]["persisted_sources"][:4])),
                _phase_record(2, "observe_runtime_tests_artifacts", "pass", evidence=tuple(plan["repo_inputs"]["runtime_paths"][:4] + plan["repo_inputs"]["test_paths"][:2])),
                _phase_record(3, "compress_claim_packet", "pass", evidence=tuple(f"{claim_id}:{claims[claim_id]['status']}" for claim_id in CLAIM_IDS)),
                _phase_record(4, "score_integrity", overall_status, evidence=(f"blocking_problem_codes:{len(blocking_problem_codes)}", f"advisories:{len(advisories)}")),
                _phase_record(5, "spawn_child_claim_lanes", "pass", evidence=tuple(CLAIM_IDS)),
                _phase_record(6, "collect_child_claim_lanes", overall_status, evidence=(f"pending_escalations:{len(pending_escalations)}",)),
            ],
            "break_phase": {
                **_phase_record(7, "break_to_outer_judgement", break_status, evidence=tuple(blocking_claims or unproved_claims or watch_claims or ["all_claims_pass"])),
                "pending_escalations": pending_escalations,
            },
            "promotion_phase": {
                **_phase_record(8, "parent_consequence", next_action, evidence=(stop_reason,)),
                "next_action": next_action,
                "stop_reason": stop_reason,
                "escalation_status": escalation_status,
            },
        },
        "pending_escalations": pending_escalations,
        "children": [
            _child_fib_scope(
                claim_id=claim_id,
                claim_status=claims[claim_id]["status"],
                problems=problems,
                advisories=advisories,
                parent_arc_id=fib_arc_id,
            )
            for claim_id in CLAIM_IDS
        ],
    }
    report = {
        "schema_version": "unbrowse_capability_harness_v1",
        "plan": plan,
        "checks": checks,
        "problems": problems,
        "advisories": advisories,
        "claim_judgements": claims,
        "fib_harness": fib_harness,
        "final": {
            "overall_status": overall_status,
            "truth_status": overall_status,
            "promotion_readiness": (
                "ready"
                if next_action == "promote"
                else "blocked"
                if next_action == "repair"
                else "needs_outer_judge"
                if next_action == "await_child_verdict"
                else "hold"
            ),
            "blocking_claims": blocking_claims,
            "watch_claims": watch_claims,
            "unproved_claims": unproved_claims,
            "blocking_problem_codes": blocking_problem_codes,
            "problem_count": len(problems),
            "advisory_count": len(advisories),
            "next_action": next_action,
            "stop_reason": stop_reason,
            "pending_escalations": pending_escalations,
            "escalation_status": escalation_status,
            "fib_arc_id": fib_arc_id,
            "output_path": str(output_path),
        },
    }
    _write_json(output_path, report)
    return report


def main() -> None:
    parser = ArgumentParser(description="Run unbrowse_capability_harness.")
    parser.add_argument("repo_root", nargs="?", default=".")
    parser.add_argument("--output-path", default="runs/fib-harness-report.json")
    args = parser.parse_args()

    report = run_unbrowse_capability_harness(args.repo_root, output_path=args.output_path)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
