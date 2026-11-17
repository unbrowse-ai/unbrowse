#!/usr/bin/env python3
"""Fails when the antithesis harness reads a contract the way its ABI no longer allows.

The harness reads the ABIs the node embeds (unbrowse-node/app/contracts, copied into the image), and a read that no
longer matches them fails only inside an Antithesis run. This checks every `.call("fn", ...)` in antithesis/test:
the function exists, a named result (`.call(...).name`) is one of its outputs, an index (`.call(...)[i]`) is in
range, and a tuple unpacked from it has as many names as it has outputs. Standard library only.
"""

import ast
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "unbrowse-node/app/contracts"
HARNESS = ROOT / "antithesis/test"


def outputs():
    """Each function name to the output lists it has across the embedded ABIs (one name can be in several)."""
    out = {}
    for f in sorted(CONTRACTS.glob("*.json")):
        # Only artifacts carry an ABI; runtime.json (the deployed code each contract must hold) is no contract.
        for item in json.loads(f.read_text()).get("abi", []):
            if item.get("type") == "function":
                out.setdefault(item["name"], []).append((f.stem, [o.get("name", "") for o in item["outputs"]]))
    return out


def called(node):
    """The function name when `node` is `<x>.call("<fn>", ...)`."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "call" and node.args:
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            return first.value
    return None


def problems(path, fns):
    tree = ast.parse(path.read_text(), str(path))
    found = []

    def where(node):
        return f"{path.relative_to(ROOT)}:{node.lineno}"

    def fits(fn, node, ok, what):
        lists = fns.get(fn)
        if lists is None:
            found.append(f"{where(node)}: no contract has a function {fn!r}")
        elif not any(ok(names) for _c, names in lists):
            found.append(f"{where(node)}: {fn}() {what}; its outputs are " + "; ".join(f"{c}: {names}" for c, names in lists))

    for node in ast.walk(tree):
        fn = called(node)
        if fn:
            fits(fn, node, lambda names: True, "")
        if isinstance(node, ast.Attribute) and (fn := called(node.value)):
            fits(fn, node, lambda names, a=node.attr: a in names, f"has no result named {node.attr!r}")
        if isinstance(node, ast.Subscript) and (fn := called(node.value)) and isinstance(node.slice, ast.Constant):
            i = node.slice.value
            fits(fn, node, lambda names, i=i: isinstance(i, int) and -len(names) <= i < len(names), f"has no result [{i}]")
        if isinstance(node, ast.Assign) and (fn := called(node.value)):
            for target in node.targets:
                if isinstance(target, ast.Tuple):
                    n = len(target.elts)
                    fits(fn, node, lambda names, n=n: len(names) == n, f"is unpacked into {n} names")
    return found


def main():
    fns = outputs()
    found = [p for f in sorted(HARNESS.rglob("*.py")) if f.name != pathlib.Path(__file__).name for p in problems(f, fns)]
    for p in found:
        print(p)
    if found:
        sys.exit(1)
    print("antithesis contract reads match the embedded ABIs")


if __name__ == "__main__":
    main()
