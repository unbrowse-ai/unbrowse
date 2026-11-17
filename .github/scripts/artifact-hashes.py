#!/usr/bin/env python3
"""Record and verify immutable hashes for package files crossing release jobs.

`record`/`verify` cover the packages (`*.tgz`, `*.whl`) the signed inventory names. `record-files`/`verify-files` cover
every file a release publishes: the job that made a file records its hash as a job output (which no later job can
change), and a publishing job takes a folder only when its files are exactly the recorded ones, byte for byte. An
artifact replaced between the job that made it and the job that publishes it, or a file nobody recorded, stops the
release.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys


def artifact_hashes(directory: Path) -> dict[str, str]:
    files = sorted([*directory.glob("*.tgz"), *directory.glob("*.whl")])
    if not files:
        raise ValueError(f"{directory} has no package tarballs or wheels")
    if len({file.name for file in files}) != len(files):
        raise ValueError("artifact filenames must be unique")
    return {
        file.name: hashlib.sha256(file.read_bytes()).hexdigest()
        for file in files
    }


def file_hashes(paths: list[Path]) -> dict[str, str]:
    """The SHA-256 of every regular file named, or directly inside a folder named, by name. Names are unique."""
    hashes: dict[str, str] = {}
    for path in paths:
        entries = sorted(path.iterdir()) if path.is_dir() and not path.is_symlink() else [path]
        for file in entries:
            if file.is_symlink() or not file.is_file():
                raise ValueError(f"{file} is not a regular file")
            if file.name in hashes:
                raise ValueError(f"two files named {file.name}")
            hashes[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
    if not hashes:
        raise ValueError("no files to record")
    return hashes


def verify_files(directory: Path, expected_jsons: list[str]) -> None:
    """`directory` holds exactly the files the recorded maps name, each with its recorded bytes."""
    expected: dict[str, str] = {}
    for text in expected_jsons:
        recorded = json.loads(text)
        if not isinstance(recorded, dict) or not recorded:
            raise ValueError("a recorded hash map is empty")
        for name, digest in recorded.items():
            if expected.setdefault(name, digest) != digest:
                raise ValueError(f"{name} was recorded with two different hashes")
    actual = file_hashes([directory])
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    changed = sorted(name for name in set(expected) & set(actual) if expected[name] != actual[name])
    if missing or extra or changed:
        raise ValueError(f"published files differ from the recorded ones: missing={missing}, extra={extra}, changed={changed}")


def write_output(github_output: Path, key: str, hashes: dict[str, str]) -> None:
    with github_output.open("a", encoding="utf-8") as output:
        output.write(f"{key}={json.dumps(hashes, sort_keys=True, separators=(',', ':'))}\n")


def record(directory: Path, github_output: Path) -> dict[str, str]:
    hashes = artifact_hashes(directory)
    with github_output.open("a", encoding="utf-8") as output:
        output.write(f"hashes={json.dumps(hashes, sort_keys=True, separators=(',', ':'))}\n")
    return hashes


def verify(directory: Path, expected_json: str, allow_extra: bool = False) -> None:
    expected = json.loads(expected_json)
    actual = artifact_hashes(directory)
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    changed = sorted(name for name in set(expected) & set(actual) if expected[name] != actual[name])
    if missing or changed or (extra and not allow_extra):
        raise ValueError(f"artifact set/hash mismatch: missing={missing}, extra={extra}, changed={changed}")


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    recorder = sub.add_parser("record")
    recorder.add_argument("directory", type=Path)
    recorder.add_argument("--github-output", type=Path, required=True)
    checker = sub.add_parser("verify")
    checker.add_argument("directory", type=Path)
    checker.add_argument("--expected", required=True)
    subset = sub.add_parser("verify-subset")
    subset.add_argument("directory", type=Path)
    subset.add_argument("--expected", required=True)
    files = sub.add_parser("record-files")
    files.add_argument("paths", type=Path, nargs="+")
    files.add_argument("--key", required=True)
    files.add_argument("--github-output", type=Path, required=True)
    published = sub.add_parser("verify-files")
    published.add_argument("directory", type=Path)
    published.add_argument("--expected", action="append", required=True)
    args = parser.parse_args()
    try:
        if args.command == "record":
            record(args.directory, args.github_output)
        elif args.command == "record-files":
            write_output(args.github_output, args.key, file_hashes(args.paths))
        elif args.command == "verify-files":
            verify_files(args.directory, args.expected)
        else:
            verify(args.directory, args.expected, allow_extra=args.command == "verify-subset")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"artifact hash check: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
