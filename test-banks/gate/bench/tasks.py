"""Load benchmark tasks and resolve run-time date tokens."""
import json, re
from datetime import date, datetime, timedelta, timezone

SGT = timezone(timedelta(hours=8))
TOKEN = re.compile(r"\{(\+\d+d|next_business_day|second_business_day|year|prev_year|today)\}")


def today_sgt():
    return datetime.now(SGT).date()


def business_day(start, n):
    d, left = start, n
    while left:
        d += timedelta(days=1)
        if d.weekday() < 5:
            left -= 1
    return d


def fill_dates(text, today=None):
    today = today or today_sgt()

    def sub(m):
        tok = m.group(1)
        if tok.startswith("+"):
            return (today + timedelta(days=int(tok[1:-1]))).isoformat()
        return {"next_business_day": business_day(today, 1).isoformat(),
                "second_business_day": business_day(today, 2).isoformat(),
                "year": str(today.year), "prev_year": str(today.year - 1),
                "today": today.isoformat()}[tok]
    return TOKEN.sub(sub, text)


def read_bank(path):
    """Return (tasks, suites) from either a plain task list or a bank dict {"tasks": [...], "suites": {...}}."""
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, list):
        return data, {}
    if isinstance(data, dict) and isinstance(data.get("tasks"), list):
        return data["tasks"], data.get("suites") or {}
    raise ValueError(f"{path}: expected a task list or a dict with a 'tasks' list")


def suite_ids(suites, suite):
    if suite not in suites:
        raise ValueError(f"unknown suite {suite!r}; available: {', '.join(sorted(suites)) or 'none'}")
    return set(suites[suite])


def load(path, ids=None, personas=None, dims=None, include_deferred=False, limit=None, suite=None):
    tasks, suites = read_bank(path)
    allowed = suite_ids(suites, suite) if suite else None
    out = []
    for t in tasks:
        if t.get("deferred") and not include_deferred:
            continue
        if allowed is not None and t["id"] not in allowed:
            continue
        if ids and t["id"] not in ids:
            continue
        if personas and t["persona"] not in personas:
            continue
        if dims and not set(dims) & set(t["dims"]):
            continue
        out.append(t)
    return out[:limit] if limit else out
