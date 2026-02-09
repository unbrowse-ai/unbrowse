"""OpenClaw gateway log trace parser.

Vendored for completeness; not currently used by this repo's suite.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        print(obj)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

