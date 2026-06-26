#!/usr/bin/env python3
"""test_llm_client_invariants.py — falsifiable signs over the LLMClient seed (Step 3).

The luminaries (Gen 1:14): signals you steer the grader-seam swap by, installed
BEFORE the exa bench storm. Each invariant is falsifiable and fails loud (exit != 0).
Run:  python3 bench/exa/test_llm_client_invariants.py

These invariants cover the Step-3 seed (bench/exa/vendor/benchmarks/shared/shared/
graders/llm_client.py + the base.py/simple_rag.py grafts). They are read-only source
checks + runtime construction checks. No network calls (the probe chain is tested
with stubbed env, not live API probes — those are the bench's job, not the luminary's).

INVARIANTS
  L1 (factory-exists): llm_client.py exists and exports build_llm_client + build_grader_client.
  L2 (four-probe-chain): the probe chain has exactly 4 providers in cost/quality order:
      openai → nebius → openrouter → ollama. Adding/removing one without updating this
      test is a visible change the luminary catches.
  L3 (backward-compat): build_grader_client(api_key=...) returns provider="custom" — the
      old call shape (explicit key) still works and does NOT trigger auto-probe.
  L4 (fallback-fires): when OPENAI_API_KEY is unset/empty, the factory returns a non-openai
      provider (nebius/openrouter/ollama) — the 429 escape hatch is real.
  L5 (grader-constructs): BaseLLMGrader() with no args constructs without raising; the
      .client and .model attributes are populated (not None).
  L6 (agent-constructs): SimpleRAGAgent() with no args constructs without raising; the
      ._client and .model attributes are populated.
  L7 (no-hardcoded-openai-in-graders): base.py and simple_rag.py do NOT construct
      AsyncOpenAI(api_key=...) directly in __init__ — the old hardcoded skin is gone,
      replaced by build_grader_client. This is the regression guard against reversion.
"""
from __future__ import annotations

import os
import re
import sys
import importlib

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor", "benchmarks")
SHARED = os.path.join(VENDOR, "shared")  # the inner shared/ package root
failures: list[str] = []

# Prefer the vendored venv python (has tiktoken etc.); fall back to sys.executable
_VENV_PY = os.path.join(VENDOR, ".venv", "bin", "python")
if os.path.exists(_VENV_PY) and os.path.realpath(_VENV_PY) != os.path.realpath(sys.executable):
    os.execv(_VENV_PY, [_VENV_PY, os.path.abspath(__file__)])

# Add vendor shared to path so we can import the shared package
sys.path.insert(0, SHARED)


def _read(path: str) -> str:
    with open(path) as f:
        return f.read()


# ---- L1: factory exists and exports -----------------------------------------
def check_factory_exists() -> None:
    llm_path = os.path.join(VENDOR, "shared", "shared", "graders", "llm_client.py")
    if not os.path.exists(llm_path):
        failures.append(f"L1: {llm_path} missing — the seed was never planted")
        return
    src = _read(llm_path)
    if "def build_llm_client" not in src:
        failures.append("L1: build_llm_client not defined in llm_client.py")
    if "def build_grader_client" not in src:
        failures.append("L1: build_grader_client not defined in llm_client.py")
    if "class LLMConfig" not in src:
        failures.append("L1: LLMConfig dataclass not defined in llm_client.py")


# ---- L2: four-probe chain ----------------------------------------------------
def check_probe_chain() -> None:
    llm_path = os.path.join(VENDOR, "shared", "shared", "graders", "llm_client.py")
    if not os.path.exists(llm_path):
        return  # L1 already failed
    src = _read(llm_path)
    probes = re.findall(r'"(\w+)",\s*_probe_(\w+)', src)
    names = [n for n, _ in probes]
    expected = ["openai", "nebius", "openrouter", "ollama"]
    if names != expected:
        failures.append(
            f"L2: probe chain is {names}, expected {expected} — "
            f"order matters (cost/quality fallback)"
        )


# ---- L3: backward-compat with explicit api_key ------------------------------
def check_backward_compat() -> None:
    try:
        from shared.graders.llm_client import build_grader_client
        client, model, provider = build_grader_client(api_key="test-key-123")
        if provider != "custom":
            failures.append(f"L3: explicit api_key returned provider='{provider}', expected 'custom'")
        if client is None:
            failures.append("L3: explicit api_key returned client=None")
    except Exception as e:
        failures.append(f"L3: build_grader_client(api_key=...) raised: {e}")


# ---- L4: fallback fires when OpenAI is empty --------------------------------
def check_fallback() -> None:
    try:
        from shared.graders.llm_client import build_llm_client
        # Save and clear OPENAI_API_KEY to simulate the 429/unfunded state
        saved = os.environ.pop("OPENAI_API_KEY", None)
        try:
            cfg = build_llm_client()
            if cfg.provider == "openai":
                failures.append(
                    f"L4: OPENAI_API_KEY unset but factory still returned openai — "
                    f"the 429 escape hatch is broken"
                )
            else:
                print(f"  L4: fallback provider = {cfg.provider} (model={cfg.model})")
        finally:
            if saved is not None:
                os.environ["OPENAI_API_KEY"] = saved
    except RuntimeError as e:
        # If no other provider is available, that's an honest negative, not a test failure
        if "no LLM provider available" in str(e):
            failures.append(
                f"L4: no fallback provider available when OPENAI_API_KEY is unset — "
                f"the escape hatch needs at least one of NEBIUS/OPENROUTER/OLLAMA configured"
            )
        else:
            failures.append(f"L4: build_llm_client raised unexpected: {e}")
    except Exception as e:
        failures.append(f"L4: build_llm_client raised: {e}")


# ---- L5: BaseLLMGrader constructs -------------------------------------------
def check_grader_constructs() -> None:
    try:
        from shared.graders.base import BaseLLMGrader
        g = BaseLLMGrader()
        if g.client is None:
            failures.append("L5: BaseLLMGrader().client is None")
        if not g.model:
            failures.append("L5: BaseLLMGrader().model is empty")
        if not hasattr(g, "provider"):
            failures.append("L5: BaseLLMGrader has no .provider attribute (graft incomplete)")
        else:
            print(f"  L5: BaseLLMGrader model={g.model} provider={g.provider}")
    except Exception as e:
        failures.append(f"L5: BaseLLMGrader() raised: {e}")


# ---- L6: SimpleRAGAgent constructs ------------------------------------------
def check_agent_constructs() -> None:
    try:
        from shared.agents.simple_rag import SimpleRAGAgent
        a = SimpleRAGAgent()
        if a._client is None:
            failures.append("L6: SimpleRAGAgent()._client is None")
        if not a.model:
            failures.append("L6: SimpleRAGAgent().model is empty")
        if not hasattr(a, "provider"):
            failures.append("L6: SimpleRAGAgent has no .provider attribute (graft incomplete)")
        else:
            print(f"  L6: SimpleRAGAgent model={a.model} provider={a.provider}")
    except Exception as e:
        failures.append(f"L6: SimpleRAGAgent() raised: {e}")


# ---- L7: no hardcoded AsyncOpenAI in __init__ (regression guard) -------------
def check_no_hardcoded_openai() -> None:
    base_path = os.path.join(VENDOR, "shared", "shared", "graders", "base.py")
    rag_path = os.path.join(VENDOR, "shared", "shared", "agents", "simple_rag.py")
    for path, label in [(base_path, "base.py"), (rag_path, "simple_rag.py")]:
        if not os.path.exists(path):
            failures.append(f"L7: {label} missing")
            continue
        src = _read(path)
        # The old skin: AsyncOpenAI(api_key=...) directly in __init__, NOT via build_grader_client
        # Allow: import AsyncOpenAI (the import line is fine)
        # Forbid: self.client = AsyncOpenAI(api_key=...) or self._client = AsyncOpenAI(api_key=...)
        # WITHOUT going through build_grader_client
        init_match = re.search(r"def __init__\(.*?\):(.*?)(?=\n    def |\nclass |\Z)", src, re.DOTALL)
        if init_match:
            init_body = init_match.group(1)
            if "AsyncOpenAI(api_key=" in init_body and "build_grader_client" not in init_body:
                failures.append(
                    f"L7: {label} __init__ still constructs AsyncOpenAI(api_key=...) directly — "
                    f"the old hardcoded skin is back (regression)"
                )


def main() -> int:
    print("── LLMClient invariants (Step 3 seed) ──")
    check_factory_exists()
    check_probe_chain()
    check_backward_compat()
    check_fallback()
    check_grader_constructs()
    check_agent_constructs()
    check_no_hardcoded_openai()

    if failures:
        print()
        for f in failures:
            print(f"  FAIL  {f}")
        print(f"\n── {len(failures)} invariant(s) FAILED (exit 1) ──")
        return 1
    print("\n── ALL LLMClient INVARIANTS PASS (exit 0) ──")
    return 0


if __name__ == "__main__":
    sys.exit(main())
