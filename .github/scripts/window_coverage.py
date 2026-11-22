"""One line for the coverage comment: the Zig window's line coverage, reported apart (never gating), from kcov's
coverage.json (coverage.yml's `window` job). A missing or unreadable report says UNMEASURED, never a number."""
import json
import sys


def line(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        covered, total = int(d["covered_lines"]), int(d["total_lines"])
    except (OSError, ValueError, KeyError, TypeError):
        return "Zig window (reported apart): UNMEASURED."
    if total <= 0:
        return "Zig window (reported apart): UNMEASURED (kcov read no lines)."
    return f"Zig window (reported apart): {100 * covered / total:.2f}% ({covered:,} / {total:,} lines)."


if __name__ == "__main__":
    print(line(sys.argv[1] if len(sys.argv) > 1 else ""))
