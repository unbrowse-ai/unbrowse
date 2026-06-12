#!/usr/bin/env python3
"""Validate the Exa/BrowseComp gate manifest.

This is the Day-3 seed: a small runnable shape check before any gate behavior
changes. It keeps historical/noisy witnesses out of release-eligible slots and
requires robust BrowseComp release witnesses to declare a meaningful N floor.
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "bench" / "exa" / "gate_manifest.json"

VALID_LANES = {"exa", "browsecomp", "paper", "release"}
VALID_EVIDENCE = {
    "artifact-gate",
    "historical-fast",
    "invariant",
    "live-comparison",
    "live-rerun",
    "robust-historical",
}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def validate_entry(entry: dict[str, Any], seen: set[str], errors: list[str]) -> None:
    required = {"id", "path", "lane", "evidence_class", "minimum_n", "release_eligible", "reason"}
    missing = sorted(required - set(entry))
    if missing:
        fail(errors, f"{entry.get('id', '<unknown>')}: missing {', '.join(missing)}")
        return

    entry_id = entry["id"]
    if not isinstance(entry_id, str) or not entry_id:
        fail(errors, "entry id must be a non-empty string")
    elif entry_id in seen:
        fail(errors, f"{entry_id}: duplicate id")
    else:
        seen.add(entry_id)

    path = ROOT / str(entry["path"])
    if not path.exists():
        fail(errors, f"{entry_id}: path does not exist: {entry['path']}")

    if entry["lane"] not in VALID_LANES:
        fail(errors, f"{entry_id}: invalid lane {entry['lane']}")

    evidence = entry["evidence_class"]
    if evidence not in VALID_EVIDENCE:
        fail(errors, f"{entry_id}: invalid evidence_class {evidence}")

    minimum_n = entry["minimum_n"]
    if minimum_n is not None and (not isinstance(minimum_n, int) or minimum_n < 1):
        fail(errors, f"{entry_id}: minimum_n must be null or positive integer")

    if not isinstance(entry["release_eligible"], bool):
        fail(errors, f"{entry_id}: release_eligible must be boolean")

    if not isinstance(entry["reason"], str) or len(entry["reason"].strip()) < 20:
        fail(errors, f"{entry_id}: reason must explain the classification")

    if evidence == "historical-fast" and entry["release_eligible"]:
        fail(errors, f"{entry_id}: historical-fast gates cannot be release_eligible")

    if entry["lane"] == "browsecomp" and entry["release_eligible"]:
        if evidence != "robust-historical":
            fail(errors, f"{entry_id}: release-eligible BrowseComp gates must be robust-historical for now")
        if not isinstance(minimum_n, int) or minimum_n < 25:
            fail(errors, f"{entry_id}: release-eligible BrowseComp gate needs minimum_n >= 25")

    replacement = entry.get("replacement")
    if replacement is not None and not (ROOT / str(replacement)).exists():
        fail(errors, f"{entry_id}: replacement path does not exist: {replacement}")


def main() -> int:
    data = json.loads(MANIFEST.read_text())
    errors: list[str] = []

    if data.get("version") != 1:
        fail(errors, "manifest version must be 1")
    target_source = ROOT / str(data.get("target_source", ""))
    if not target_source.exists():
        fail(errors, f"target_source does not exist: {data.get('target_source')}")

    entries = data.get("entries")
    if not isinstance(entries, list) or not entries:
        fail(errors, "entries must be a non-empty list")
    else:
        seen: set[str] = set()
        for raw in entries:
            if not isinstance(raw, dict):
                fail(errors, "each entry must be an object")
                continue
            validate_entry(raw, seen, errors)

    if errors:
        print("GATE-MANIFEST FAIL")
        for error in errors:
            print(f"  - {error}")
        return 1

    release = sum(1 for entry in entries if entry.get("release_eligible"))
    print(f"GATE-MANIFEST PASS — {len(entries)} gate(s), {release} release-eligible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
