#!/usr/bin/env python3
"""Check that unbrowse-core's code constants equal the papers' protocol numbers.

    python3 -I papers/params_check.py            # exit 0 and PARAMS_CHECK_PASSED <n> keys, else PARAMS_CHECK_FAILED (<n>)
    python3 -I papers/params_check.py --report   # table key | params | code | status | site; always exits 0

papers/params.toml is a byte copy of the papers' protocol/params.toml (the source of truth). papers/params-map.json
says where core states each value:

  mapped           [{key, sites: [{file, pattern, scale, nth?, implied?, note?}]}]
                   `pattern` is a Python regex with one capture group for the number, matched against the whole file;
                   it must match exactly once. code value = params v * scale. A text v (e.g. "burst 32, then 1 a second")
                   is compared through `nth`: the nth number written in it. A pattern with no capture group states no
                   literal; its code value is `implied`.
  retired_in_code  [{key, was, why, sites}]  parameters papers retired that code still defines: every site fails.
  stale_in_code    [{key, why, sites}]  parameters papers still define, but differently from how code hard-codes them
                   (another base, unit or meaning): every site fails until code follows the papers.
  open_in_code     {key: sites}  open/text keys (listed in `unmapped`) whose value core already fixes: reported only.
  unmapped         {key: reason}  every params key core does not state.

Every params key must be in exactly one of `mapped` and `unmapped`. Stdlib only.
"""
from __future__ import annotations

import json
import re
import sys
import tomllib
from decimal import Decimal, InvalidOperation
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PARAMS = HERE / "params.toml"
MAP = HERE / "params-map.json"
# Folders unbrowse-core holds and the public unbrowse-ai/unbrowse does not (the contracts' sources). In a checkout
# without one, its sites are reported as PRIVATE and checked in unbrowse-core's own CI instead.
_EXCLUDE = ROOT / ".github" / "public-tree-exclude"
PRIVATE = [l.strip() for l in (_EXCLUDE.read_text(encoding="utf-8").splitlines() if _EXCLUDE.is_file() else [])
           if l.strip() and not l.startswith("#")]

# Solidity units a literal may carry, as multipliers.
UNITS = {
    "wei": Decimal(1), "gwei": Decimal(10) ** 9, "ether": Decimal(10) ** 18,
    "seconds": Decimal(1), "minutes": Decimal(60), "hours": Decimal(3600), "days": Decimal(86400),
    "weeks": Decimal(604800),
}
LITERAL = re.compile(r"^\s*([0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)\s*(?:(" + "|".join(UNITS) + r"))?\s*$")
TEXT_NUMBER = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")


def flatten(params: dict) -> dict[str, dict]:
    out = {}
    for table, keys in params.items():
        for name, entry in keys.items():
            out[f"{table}.{name}"] = entry
    return out


def code_number(text: str) -> Decimal:
    m = LITERAL.match(text)
    if not m:
        raise ValueError(f"not a number literal: {text!r}")
    value = Decimal(m.group(1).replace("_", ""))
    if m.group(2):
        value *= UNITS[m.group(2)]
    return value


def is_float_literal(text: str) -> bool:
    return "." in text.split("e")[0].split("E")[0]


def params_number(v, nth) -> Decimal:
    if isinstance(v, bool):
        raise ValueError("boolean value")
    if isinstance(v, (int, float)):
        if nth is not None:
            raise ValueError("nth given for a numeric value")
        return Decimal(str(v))
    if isinstance(v, str):
        if nth is None:
            raise ValueError(f"text value {v!r} needs `nth`")
        found = TEXT_NUMBER.findall(v)
        if nth >= len(found):
            raise ValueError(f"text value {v!r} has no number #{nth}")
        return Decimal(found[nth].replace(",", ""))
    raise ValueError(f"unsupported value {v!r}")


def equal(code: Decimal, expected: Decimal, float_literal: bool) -> bool:
    if not float_literal and code == code.to_integral_value() and expected == expected.to_integral_value():
        return code == expected
    if expected == 0:
        return abs(code) <= Decimal("1e-12")
    return abs(code - expected) <= Decimal("1e-12") * abs(expected)


_files: dict[str, str | None] = {}


def read(file: str) -> str | None:
    if file not in _files:
        p = ROOT / file
        _files[file] = p.read_text(encoding="utf-8") if p.is_file() else None
    return _files[file]


def private_absent(file: str) -> bool:
    """A site in a folder the public tree leaves out (`.github/public-tree-exclude`), checked out without it."""
    return any(file.startswith(d) and not (ROOT / d).is_dir() for d in PRIVATE)


def read_site(site: dict) -> tuple[Decimal | None, str, str | None]:
    """(code value, shown text, error)."""
    text = read(site["file"])
    if text is None:
        return None, "-", f"file missing: {site['file']}"
    try:
        rx = re.compile(site["pattern"])
    except re.error as e:
        return None, "-", f"bad regex: {e}"
    matches = list(rx.finditer(text))
    if len(matches) != 1:
        return None, "-", f"regex matched {len(matches)} times, not once"
    m = matches[0]
    if rx.groups == 0:
        if "implied" not in site:
            return None, "-", "pattern has no capture group and no `implied`"
        return Decimal(str(site["implied"])), f"(implied {site['implied']})", None
    if rx.groups != 1:
        return None, "-", f"pattern has {rx.groups} capture groups, not one"
    raw = m.group(1)
    try:
        return code_number(raw), raw, None
    except (ValueError, InvalidOperation) as e:
        return None, raw, str(e)


def where(site: dict) -> str:
    text = read(site["file"]) or ""
    m = re.search(site["pattern"], text) if text else None
    line = text.count("\n", 0, m.start() + (len(m.group(0)) - len(m.group(0).lstrip("\n")))) + 1 if m else 0
    return f"{site['file']}:{line}" if line else site["file"]


def short(s: str, n: int = 32) -> str:
    return s if len(s) <= n else s[: n - 3] + "..."


def fmt(d: Decimal) -> str:
    s = format(d.normalize(), "f") if abs(d) < Decimal("1e15") else format(d.normalize(), "e")
    return s


def main(argv: list[str]) -> int:
    report = "--report" in argv
    params = flatten(tomllib.loads(PARAMS.read_text(encoding="utf-8")))
    spec = json.loads(MAP.read_text(encoding="utf-8"))
    mapped = spec.get("mapped", [])
    unmapped = spec.get("unmapped", {})
    retired = spec.get("retired_in_code", [])
    open_in_code = spec.get("open_in_code", {})
    stale = spec.get("stale_in_code", [])

    failures: list[str] = []
    rows: list[tuple[str, str, str, str, str]] = []
    mapped_keys = [e["key"] for e in mapped] + [e["key"] for e in stale]
    passed_keys = 0

    # Coverage.
    seen: dict[str, int] = {}
    for k in mapped_keys:
        seen[k] = seen.get(k, 0) + 1
    for k, n in seen.items():
        if n > 1:
            failures.append(f"{k}: mapped {n} times")
    for k in sorted(set(mapped_keys) & set(unmapped)):
        failures.append(f"{k}: in both mapped and unmapped")
    for k in params:
        if k not in seen and k not in unmapped:
            failures.append(f"{k}: in params.toml but in neither mapped nor unmapped")
    for k in list(seen) + list(unmapped):
        if k not in params:
            failures.append(f"{k}: in params-map.json but not in params.toml")
    for k in open_in_code:
        if k not in unmapped:
            failures.append(f"{k}: in open_in_code but not in unmapped")
    for e in retired:
        if e["key"] in params:
            failures.append(f"{e['key']}: listed as retired_in_code but still in params.toml")

    for e in stale:
        if e["key"] not in params:
            failures.append(f"{e['key']}: listed as stale_in_code but not in params.toml (move it to retired_in_code)")

    # Mapped sites.
    for e in mapped:
        key = e["key"]
        entry = params.get(key)
        if entry is None:
            continue
        sites = e.get("sites", [])
        if not sites:
            failures.append(f"{key}: mapped with no sites")
        ok_all = bool(sites)
        for s in sites:
            loc = where(s)
            if private_absent(s["file"]):
                rows.append((key, "-", "-", "PRIVATE", loc))
                continue
            try:
                expected_base = params_number(entry["v"], s.get("nth"))
            except (ValueError, InvalidOperation) as err:
                failures.append(f"{key} @ {loc}: params value: {err}")
                rows.append((key, short(repr(entry["v"])), "-", "BAD_PARAM", f"{loc} ({err})"))
                ok_all = False
                continue
            expected = expected_base * Decimal(str(s.get("scale", 1)))
            shown_params = fmt(expected_base) + (f" x{fmt(Decimal(str(s['scale'])))}" if s.get("scale", 1) != 1 else "")
            code, raw, err = read_site(s)
            if err:
                failures.append(f"{key} @ {loc}: {err}")
                rows.append((key, shown_params, raw, "NO_MATCH", f"{loc} ({err})"))
                ok_all = False
                continue
            if equal(code, expected, is_float_literal(raw)):
                rows.append((key, shown_params, raw, "OK", loc))
            else:
                failures.append(f"{key} @ {loc}: code {raw} != params {fmt(expected_base)} x {s.get('scale', 1)} = {fmt(expected)}")
                rows.append((key, shown_params, raw, "MISMATCH", f"{loc} (want {fmt(expected)})"))
                ok_all = False
        if ok_all:
            passed_keys += 1

    # Retired parameters still in code.
    for e in retired:
        for s in e.get("sites", []):
            loc = where(s)
            if private_absent(s["file"]):
                continue
            code, raw, err = read_site(s)
            if err:
                rows.append((e["key"], f"retired (was {e.get('was')})", raw, "RETIRED_SITE_GONE?", f"{loc} ({err})"))
                failures.append(f"{e['key']} @ {loc}: retired_in_code site no longer matches ({err}); drop it from the map")
                continue
            rows.append((e["key"], f"retired (was {e.get('was')})", raw, "RETIRED_IN_CODE", loc))
            failures.append(f"{e['key']} @ {loc}: retired in papers ({e.get('why', '')}) but code still defines {raw}")

    # Parameters the papers redefined that code still hard-codes the old way.
    for e in stale:
        v = params.get(e["key"], {}).get("v", "?")
        for s in e.get("sites", []):
            loc = where(s)
            if private_absent(s["file"]):
                continue
            code, raw, err = read_site(s)
            rows.append((e["key"], short(f"{v} (redefined)"), raw, "STALE_IN_CODE" if not err else "STALE_SITE_GONE?", loc))
            if err:
                failures.append(f"{e['key']} @ {loc}: stale_in_code site no longer matches ({err}); map it to the new rule")
            else:
                failures.append(f"{e['key']} @ {loc}: papers redefined it ({e.get('why', '')}) but code still defines {raw}")

    # Informational: open keys core already fixes.
    for k, sites in open_in_code.items():
        v = params.get(k, {}).get("v", "?")
        for s in sites:
            loc = where(s)
            if private_absent(s["file"]):
                continue
            code, raw, err = read_site(s)
            rows.append((k, short(f"{v} ({params.get(k, {}).get('status', '?')})"), raw,
                         "OPEN_IN_CODE" if not err else "OPEN_IN_CODE?", loc if not err else f"{loc} ({err})"))

    if report:
        for k in sorted(unmapped):
            if k in params and k not in open_in_code:
                v = params[k]["v"]
                rows.append((k, short(f"{v} ({params[k]['status']})"), "-", "UNMAPPED", unmapped[k]))
        widths = [max(len(r[i]) for r in rows + [("key", "params", "code", "status", "site")]) for i in range(4)]
        head = ("key", "params", "code", "status", "site")
        print(" | ".join(h.ljust(widths[i]) if i < 4 else h for i, h in enumerate(head)))
        print("-+-".join("-" * w for w in widths) + "-+-" + "-" * 4)
        for r in rows:
            print(" | ".join(c.ljust(widths[i]) if i < 4 else c for i, c in enumerate(r)))
        mism = sum(1 for r in rows if r[3].startswith(("MISMATCH", "NO_MATCH", "BAD_PARAM")))
        ret = sum(1 for r in rows if r[3] in ("RETIRED_IN_CODE", "STALE_IN_CODE"))
        print()
        print(f"params keys {len(params)}; mapped {len(seen)} ({passed_keys} all-OK); unmapped {len(unmapped)} "
              f"({len(open_in_code)} open_in_code); failing sites {mism}; retired or stale in code sites {ret}")

    if failures:
        if not report:
            for f in failures:
                print("FAIL", f)
        print(f"PARAMS_CHECK_FAILED ({len(failures)})")
        return 0 if report else 1
    print(f"PARAMS_CHECK_PASSED {passed_keys} keys")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
