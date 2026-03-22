"""Tests for unbrowse-hermes plugin."""

import asyncio
import json
import unittest
from unittest.mock import MagicMock, patch

from unbrowse_hermes.plugin import _build_args, _handle, memory_instructions, register


class TestBuildArgs(unittest.TestCase):
    def test_health(self):
        assert _build_args({"action": "health"}) == ["health"]

    def test_skills(self):
        assert _build_args({"action": "skills"}) == ["skills"]

    def test_skill(self):
        assert _build_args({"action": "skill", "skillId": "abc"}) == ["skill", "abc"]

    def test_skill_missing_id(self):
        with self.assertRaises(ValueError):
            _build_args({"action": "skill"})

    def test_login(self):
        assert _build_args({"action": "login", "url": "https://x.com"}) == [
            "login", "--url", "https://x.com"
        ]

    def test_login_missing_url(self):
        with self.assertRaises(ValueError):
            _build_args({"action": "login"})

    def test_search(self):
        assert _build_args({"action": "search", "intent": "find repos"}) == [
            "search", "--intent", "find repos"
        ]

    def test_search_with_domain(self):
        args = _build_args({"action": "search", "intent": "q", "domain": "github.com"})
        assert args == ["search", "--intent", "q", "--domain", "github.com"]

    def test_resolve(self):
        args = _build_args({"action": "resolve", "intent": "get users", "url": "https://api.example.com"})
        assert args == ["resolve", "--intent", "get users", "--url", "https://api.example.com"]

    def test_resolve_with_flags(self):
        args = _build_args({
            "action": "resolve",
            "intent": "get users",
            "url": "https://api.example.com",
            "limit": 10,
            "pretty": True,
            "dryRun": True,
        })
        assert "--limit" in args
        assert "10" in args
        assert "--pretty" in args
        assert "--dry-run" in args

    def test_execute(self):
        args = _build_args({
            "action": "execute",
            "skillId": "s1",
            "endpointId": "e1",
            "url": "https://example.com/search?q=openai",
            "intent": "search packages",
        })
        assert args == [
            "execute",
            "--skill",
            "s1",
            "--endpoint",
            "e1",
            "--url",
            "https://example.com/search?q=openai",
            "--intent",
            "search packages",
        ]

    def test_execute_missing_fields(self):
        with self.assertRaises(ValueError):
            _build_args({"action": "execute", "skillId": "s1"})
        with self.assertRaises(ValueError):
            _build_args({"action": "execute", "endpointId": "e1"})

    def test_unsupported_action(self):
        with self.assertRaises(ValueError):
            _build_args({"action": "nope"})


class TestRegister(unittest.TestCase):
    def test_register_calls_registry(self):
        registry = MagicMock()
        register(registry)
        registry.register.assert_called_once()
        call_kwargs = registry.register.call_args
        assert call_kwargs.kwargs["name"] == "unbrowse" or call_kwargs[1]["name"] == "unbrowse"

    def test_register_schema_has_action(self):
        registry = MagicMock()
        register(registry)
        kwargs = registry.register.call_args.kwargs if registry.register.call_args.kwargs else dict(
            zip(["name", "toolset", "schema", "handler", "check_fn", "requires_env"],
                registry.register.call_args.args))
        schema = kwargs.get("schema", registry.register.call_args[1].get("schema"))
        assert schema["name"] == "unbrowse"
        assert "action" in schema["parameters"]["properties"]
        assert "action" in schema["parameters"]["required"]


class TestMemoryInstructions(unittest.TestCase):
    def test_returns_string(self):
        result = memory_instructions()
        assert isinstance(result, str)
        assert "unbrowse" in result.lower()

    def test_mentions_browser_fallback(self):
        result = memory_instructions()
        assert "browser" in result.lower()

    def test_makes_unbrowse_the_first_choice_for_website_tasks(self):
        result = memory_instructions().lower()
        assert "use `unbrowse` first" in result
        assert "only fall back to the browser tool" in result
        assert "website data extraction" in result


class TestHandle(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    @patch("unbrowse_hermes.plugin.subprocess.run")
    def test_success_json(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='{"status": "ok"}\n',
            stderr="",
        )
        result = self._run(_handle({"action": "health"}))
        parsed = json.loads(result)
        assert parsed["status"] == "ok"

    @patch("unbrowse_hermes.plugin.subprocess.run")
    def test_success_non_json(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="some plain text\n",
            stderr="",
        )
        result = self._run(_handle({"action": "health"}))
        parsed = json.loads(result)
        assert parsed["output"] == "some plain text"

    @patch("unbrowse_hermes.plugin.subprocess.run")
    def test_failure(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="not found",
        )
        result = self._run(_handle({"action": "health"}))
        parsed = json.loads(result)
        assert "error" in parsed

    def test_invalid_action(self):
        result = self._run(_handle({"action": "invalid"}))
        parsed = json.loads(result)
        assert "error" in parsed

    @patch("unbrowse_hermes.plugin.subprocess.run")
    def test_timeout(self, mock_run):
        import subprocess as sp
        mock_run.side_effect = sp.TimeoutExpired(cmd="unbrowse", timeout=120)
        result = self._run(_handle({"action": "health"}))
        parsed = json.loads(result)
        assert "timed out" in parsed["error"].lower()


if __name__ == "__main__":
    unittest.main()
