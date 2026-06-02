"""Shape tests for unbrowse_pydantic_ai — plain python3, MUST pass OFFLINE.

Each test proves one claim about the Pydantic AI tool surface. Run:
    python3 packages/py-pydantic-ai/tests/test_shape.py
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_pydantic_ai as M


def test_three_tools_with_attributes():
    assert len(M.unbrowse_tools) == 3
    names = set()
    for t in M.unbrowse_tools:
        assert isinstance(t["name"], str) and t["name"]
        assert isinstance(t["description"], str) and t["description"]
        assert callable(t["function"])
        names.add(t["name"])
    assert names == {"unbrowse_resolve", "unbrowse_execute", "unbrowse_search"}


def test_functions_exported_and_callable():
    assert callable(M.unbrowse_resolve)
    assert callable(M.unbrowse_execute)
    assert callable(M.unbrowse_search)


def test_dryrun_returns_str_with_dryrun():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        out = M.unbrowse_search("test")
        assert isinstance(out, str) and "dryrun" in out
        assert isinstance(M.unbrowse_resolve("https://example.com", "test"), str)
        assert "dryrun" in M.unbrowse_resolve("https://example.com", "test")
        assert "dryrun" in M.unbrowse_execute("e1")
        # every registered tool function returns a dryrun string
        for t in M.unbrowse_tools:
            out = t["function"]("test") if t["name"] == "unbrowse_search" else (
                t["function"]("https://example.com", "test") if t["name"] == "unbrowse_resolve"
                else t["function"]("e1"))
            assert isinstance(out, str) and "dryrun" in out
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


def test_create_factory_with_fake_tool():
    assert callable(M.create_unbrowse_tools)

    class FakeTool:
        def __init__(self, fn, name=None, description=None):
            self.fn = fn
            self.name = name
            self.description = description

    tools = M.create_unbrowse_tools(FakeTool)
    assert len(tools) == 3
    for t in tools:
        assert isinstance(t, FakeTool)
        assert isinstance(t.name, str) and t.name
        assert callable(t.fn)


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
