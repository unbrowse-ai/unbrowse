"""Shape tests for unbrowse_crewai — plain python3, MUST pass OFFLINE.

Each test proves one claim about the CrewAI tool surface. Run:
    python3 packages/py-crewai/tests/test_shape.py
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_crewai as M


def test_three_tools_with_attributes():
    assert len(M.unbrowse_tools) == 3
    names = set()
    for t in M.unbrowse_tools:
        assert isinstance(t.name, str) and t.name
        assert isinstance(t.description, str) and t.description
        assert hasattr(t, "_run") and callable(t._run)
        assert hasattr(t, "run") and callable(t.run)
        names.add(t.name)
    assert names == {"unbrowse_resolve", "unbrowse_execute", "unbrowse_search"}


def test_dryrun_returns_str_with_dryrun():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        for t in M.unbrowse_tools:
            out = t._run(query="test", url="https://example.com", intent="test", endpoint_id="e1")
            assert isinstance(out, str)
            assert "dryrun" in out
            # also exercise the public run() shim
            out2 = t.run(query="test", url="https://example.com", intent="test", endpoint_id="e1")
            assert isinstance(out2, str) and "dryrun" in out2
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


def test_create_factory_with_fake_base():
    assert callable(M.create_unbrowse_tools)

    class FakeBaseTool:
        pass

    tools = M.create_unbrowse_tools(FakeBaseTool)
    assert len(tools) == 3
    for t in tools:
        assert isinstance(t, FakeBaseTool)
        assert isinstance(t.name, str) and t.name
        assert callable(t._run)


def test_factory_tools_run_offline():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        class FakeBaseTool:
            pass

        for t in M.create_unbrowse_tools(FakeBaseTool):
            out = t._run(query="test", url="https://example.com", intent="i", endpoint_id="e1")
            assert isinstance(out, str) and "dryrun" in out
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(fns)} green")
    sys.exit(0 if passed == len(fns) else 1)
