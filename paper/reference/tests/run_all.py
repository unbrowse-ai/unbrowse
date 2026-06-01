#!/usr/bin/env python3
"""Run every reference test in this directory. Each test = one whitepaper sentence.

Discovers `test_*.py` siblings, imports each, runs every `test_*` function, and
reports PASS/FAIL/ERROR per function. Exit 0 only when every function in every
module passes. This is the runnable core of "the papers are done as code": each
primitive the trilogy claims is exercised here against real code, not asserted.
"""
import importlib.util
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REF_ROOT = os.path.join(HERE, "..")
sys.path.insert(0, REF_ROOT)


def _load(path):
    name = "ref_" + os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    modules = sorted(
        os.path.join(HERE, f)
        for f in os.listdir(HERE)
        if f.startswith("test_") and f.endswith(".py")
    )
    total = passed = 0
    failures = []
    for path in modules:
        rel = os.path.relpath(path, REF_ROOT)
        try:
            mod = _load(path)
        except Exception as e:  # import-time failure is a real failure
            print(f"ERROR import {rel}: {type(e).__name__}: {e}")
            failures.append(rel)
            continue
        fns = [v for k, v in sorted(vars(mod).items())
               if k.startswith("test_") and callable(v)]
        if not fns:
            print(f"WARN  {rel}: no test_* functions")
        for fn in fns:
            total += 1
            try:
                fn()
                print(f"PASS  {rel}::{fn.__name__}")
                passed += 1
            except AssertionError as e:
                print(f"FAIL  {rel}::{fn.__name__}: {e}")
                failures.append(f"{rel}::{fn.__name__}")
            except Exception as e:
                print(f"ERROR {rel}::{fn.__name__}: {type(e).__name__}: {e}")
                traceback.print_exc()
                failures.append(f"{rel}::{fn.__name__}")
    print(f"\n{passed}/{total} green across {len(modules)} module(s)")
    if failures:
        print("FAILURES:\n  " + "\n  ".join(failures))
    sys.exit(0 if failures == [] and total > 0 else 1)


if __name__ == "__main__":
    main()
