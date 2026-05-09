#!/usr/bin/env python3
"""Falsifiable signals for bench-two-phase-triage.route().

Run: python3 scripts/test_bench_two_phase_triage.py
"""
import importlib.util, os, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "bench_two_phase_triage", os.path.join(HERE, "bench-two-phase-triage.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def row(**overrides):
    base = {
        "url": "https://example.com/",
        "goal": "test",
        "combined_verdict": "UNKNOWN",
        "phase1_status": "indexed",
        "phase2_status": "ok",
        "phase1_skill_id": "skill_X",
        "phase1_endpoint_id": "endpoint_Y",
        "phase1_text_bytes": "5000",
        "phase1_browser_block_signals": "[]",
        "phase1_filter_rejections": "{}",
        "phase2_status_code": "",
        "phase2_error": "",
    }
    base.update(overrides)
    return base


class TestRoute(unittest.TestCase):
    def test_re_ok_call_ok_returns_none(self):
        self.assertIsNone(mod.route(row(combined_verdict="RE_OK_CALL_OK", phase2_status="ok")))

    def test_vendor_blocked_accepts(self):
        label, _, ev = mod.route(row(
            combined_verdict="VENDOR_BLOCKED",
            phase1_browser_block_signals='["vendor:cloudflare"]',
        ))
        self.assertEqual(label, "ACCEPT_BLOCK")
        self.assertIn("cloudflare", ev)

    def test_soft_blocked_accepts(self):
        label, _, _ = mod.route(row(
            combined_verdict="SOFT_BLOCKED",
            phase1_text_bytes="6",
        ))
        self.assertEqual(label, "ACCEPT_SOFT_BLOCK")

    def test_re_failed_no_endpoints_routes_extractor(self):
        label, _, _ = mod.route(row(
            combined_verdict="RE_FAILED",
            phase1_status="no_endpoints",
        ))
        self.assertEqual(label, "REPAIR_EXTRACTOR")

    def test_re_failed_capture_timeout_routes_capture(self):
        label, _, _ = mod.route(row(
            combined_verdict="RE_FAILED",
            phase1_status="capture_timeout",
        ))
        self.assertEqual(label, "REPAIR_CAPTURE")

    def test_re_ok_call_failed_invalid_replay_params_lost_sheep(self):
        """LOST SHEEP: phase2 is `replay_failed` (catch-all), but err contains
        `invalid_replay_params`. Must still route REPAIR_REPLAY_PARAMS — not
        UNKNOWN_NEEDS_HUMAN."""
        label, repair, ev = mod.route(row(
            combined_verdict="RE_OK_CALL_FAILED",
            phase2_status="replay_failed",
            phase2_error="invalid_replay_params",
        ))
        self.assertEqual(label, "REPAIR_REPLAY_PARAMS")
        self.assertIn("-p key=value", repair)
        self.assertIn("invalid_replay_params", ev)

    def test_re_ok_call_failed_http_4xx_without_replay_param_signal(self):
        label, _, _ = mod.route(row(
            combined_verdict="RE_OK_CALL_FAILED",
            phase2_status="http_4xx",
            phase2_status_code="403",
            phase2_error="forbidden",
        ))
        self.assertEqual(label, "REPAIR_REPLAY_4XX")

    def test_re_ok_call_failed_http_5xx_routes_5xx(self):
        label, _, _ = mod.route(row(
            combined_verdict="RE_OK_CALL_FAILED",
            phase2_status="http_5xx",
        ))
        self.assertEqual(label, "REPAIR_REPLAY_5XX")

    def test_re_ok_call_failed_silent_routes_unknown(self):
        """No err, no useful status — routing must NOT fabricate."""
        label, _, _ = mod.route(row(
            combined_verdict="RE_OK_CALL_FAILED",
            phase2_status="execute_parse_error",
            phase2_error="",
        ))
        self.assertEqual(label, "UNKNOWN_NEEDS_HUMAN")

    def test_unknown_combined_routes_unknown(self):
        label, _, _ = mod.route(row(combined_verdict="UNKNOWN"))
        self.assertEqual(label, "UNKNOWN_NEEDS_HUMAN")


class TestLatestTwoPhasePerUrl(unittest.TestCase):
    def test_only_two_phase_rows_kept(self):
        rows = [
            {"url": "a", "run_id": "r1"},                           # legacy: no combined_verdict
            {"url": "b", "run_id": "r1", "combined_verdict": "RE_OK_CALL_OK"},
        ]
        out = mod.latest_two_phase_per_url(rows)
        self.assertEqual([r["url"] for r in out], ["b"])

    def test_latest_overwrites(self):
        rows = [
            {"url": "a", "run_id": "r1", "combined_verdict": "RE_FAILED"},
            {"url": "a", "run_id": "r2", "combined_verdict": "RE_OK_CALL_OK"},
        ]
        out = mod.latest_two_phase_per_url(rows)
        self.assertEqual(out[0]["combined_verdict"], "RE_OK_CALL_OK")


if __name__ == "__main__":
    unittest.main(verbosity=2)
