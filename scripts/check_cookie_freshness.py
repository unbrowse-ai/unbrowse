#!/usr/bin/env python3
"""check_cookie_freshness.py: gate auth-required/auth-cookies probes on
local browser cookie freshness BEFORE firing a probe call.

Honest measurement principle (CLAUDE.md): bench probes that need real
auth cookies should only run when the local machine has fresh cookies
for the target domain. Without a cookie, the bench cannot honestly
measure whether Unbrowse's XHR + cookie-injection ladder would have
worked. Skipping is honest; running and 401-ing is noise.

This helper inspects metadata only, never decrypts cookie values.
Existence + non-expired expires_utc is the freshness signal.

Usage:
  python3 scripts/check_cookie_freshness.py <domain>
  python3 scripts/check_cookie_freshness.py mail.google.com

Output (JSON, single line, stdout):
  {"domain": "<d>", "fresh": true/false, "source": "chrome|firefox|none|locked",
   "reason": "...", "cookie_count": N, "max_expires_unix": ts_or_null,
   "last_access_within_30d": true/false/null}

Exit codes:
  0  -> emitted JSON (caller reads fresh boolean)
  1  -> internal error / bad input (caller treats as 'unknown -> attempt')

NB: SQLite lock (Chrome running) -> fresh=false, source=locked,
reason explains. Caller policy (per CLAUDE.md instruction) is to TREAT
LOCKED AS 'attempt the probe' (don't skip), so the bench script reads
the `source` field and only skips when source in (chrome, firefox, none)
AND fresh=false AND cookie_count==0.

The substrate (this script) only reports the cookie DB state. The
verdict on whether to skip is the bench-script's; the verdict on
whether the probe truly was auth-blocked vs product-failed remains the
agent's in-thread judgment over the artifact.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from glob import glob

CHROME_TIME_EPOCH_OFFSET_S = 11644473600  # seconds between 1601-01-01 and 1970-01-01
SECONDS_30_DAYS = 30 * 24 * 3600


def _chrome_now_us() -> int:
    return int((time.time() + CHROME_TIME_EPOCH_OFFSET_S) * 1_000_000)


def _unix_now_s() -> int:
    return int(time.time())


def _normalize_domain(d: str) -> str:
    d = (d or "").strip().lower()
    if d.startswith("www."):
        d = d[4:]
    return d


def _query_chrome(db_path: str, domain: str) -> dict | None:
    """Return {cookie_count, max_expires_unix, max_last_access_unix} or None
    if the db isn't readable. Raises sqlite3.OperationalError on lock."""
    if not os.path.exists(db_path):
        return None
    uri = f"file:{db_path}?mode=ro&immutable=1"
    # immutable=1 lets us read past a writer lock on macOS; safer than
    # busy-waiting on a live Chrome.
    conn = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        cur = conn.cursor()
        now_chrome = _chrome_now_us()
        # host_key in Chrome looks like ".example.com" or "example.com" or
        # "sub.example.com". Match any cookie whose host_key equals the
        # domain, equals .<domain>, ends with .<domain>, or ends with the
        # domain as a suffix beyond a leading dot (covers subdomain leak).
        like1 = domain
        like2 = "." + domain
        like3 = "%." + domain
        cur.execute(
            """
            SELECT COUNT(*),
                   COALESCE(MAX(expires_utc), 0),
                   COALESCE(MAX(last_access_utc), 0)
            FROM cookies
            WHERE (host_key = ?
                   OR host_key = ?
                   OR host_key LIKE ?)
              AND expires_utc > ?
            """,
            (like1, like2, like3, now_chrome),
        )
        row = cur.fetchone()
        count = int(row[0] or 0)
        max_exp_chrome = int(row[1] or 0)
        max_access_chrome = int(row[2] or 0)
        max_exp_unix = (
            (max_exp_chrome // 1_000_000) - CHROME_TIME_EPOCH_OFFSET_S
            if max_exp_chrome > 0
            else 0
        )
        max_access_unix = (
            (max_access_chrome // 1_000_000) - CHROME_TIME_EPOCH_OFFSET_S
            if max_access_chrome > 0
            else 0
        )
        return {
            "cookie_count": count,
            "max_expires_unix": max_exp_unix or None,
            "max_last_access_unix": max_access_unix or None,
        }
    finally:
        conn.close()


def _query_firefox(db_path: str, domain: str) -> dict | None:
    """Firefox cookies.sqlite (moz_cookies table); expiry column in
    Unix seconds (not microseconds)."""
    if not os.path.exists(db_path):
        return None
    uri = f"file:{db_path}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        cur = conn.cursor()
        now_s = _unix_now_s()
        like1 = domain
        like2 = "." + domain
        like3 = "%." + domain
        cur.execute(
            """
            SELECT COUNT(*),
                   COALESCE(MAX(expiry), 0),
                   COALESCE(MAX(lastAccessed), 0)
            FROM moz_cookies
            WHERE (host = ?
                   OR host = ?
                   OR host LIKE ?)
              AND expiry > ?
            """,
            (like1, like2, like3, now_s),
        )
        row = cur.fetchone()
        count = int(row[0] or 0)
        max_exp_s = int(row[1] or 0)
        # Firefox lastAccessed is microseconds-since-epoch in modern profiles
        max_access_us = int(row[2] or 0)
        max_access_unix = max_access_us // 1_000_000 if max_access_us > 1_000_000_000_000 else max_access_us
        return {
            "cookie_count": count,
            "max_expires_unix": max_exp_s or None,
            "max_last_access_unix": max_access_unix or None,
        }
    finally:
        conn.close()


def check(domain: str) -> dict:
    domain = _normalize_domain(domain)
    if not domain:
        return {
            "domain": domain,
            "fresh": False,
            "source": "none",
            "reason": "empty domain",
            "cookie_count": 0,
            "max_expires_unix": None,
            "last_access_within_30d": None,
        }

    home = os.path.expanduser("~")
    chrome_default = os.path.join(
        home, "Library/Application Support/Google/Chrome/Default/Cookies"
    )
    chrome_locked = False
    chrome_result: dict | None = None
    try:
        chrome_result = _query_chrome(chrome_default, domain)
    except sqlite3.OperationalError as e:
        chrome_locked = True
        chrome_err = str(e)
    except Exception as e:
        chrome_err = f"chrome unexpected: {e!r}"
        chrome_result = None

    if chrome_result and chrome_result["cookie_count"] > 0:
        last_access = chrome_result.get("max_last_access_unix")
        within_30d = (
            (last_access is not None)
            and (_unix_now_s() - int(last_access)) <= SECONDS_30_DAYS
        )
        return {
            "domain": domain,
            "fresh": True,
            "source": "chrome",
            "reason": (
                f"{chrome_result['cookie_count']} non-expired cookie(s) in "
                f"Chrome Default for {domain}"
            ),
            "cookie_count": chrome_result["cookie_count"],
            "max_expires_unix": chrome_result["max_expires_unix"],
            "last_access_within_30d": within_30d,
        }

    # Firefox fallback
    ff_glob = os.path.join(
        home, "Library/Application Support/Firefox/Profiles/*.default*/cookies.sqlite"
    )
    ff_locked = False
    firefox_result: dict | None = None
    for ff_path in glob(ff_glob):
        try:
            firefox_result = _query_firefox(ff_path, domain)
            if firefox_result and firefox_result["cookie_count"] > 0:
                last_access = firefox_result.get("max_last_access_unix")
                within_30d = (
                    (last_access is not None)
                    and (_unix_now_s() - int(last_access)) <= SECONDS_30_DAYS
                )
                return {
                    "domain": domain,
                    "fresh": True,
                    "source": "firefox",
                    "reason": (
                        f"{firefox_result['cookie_count']} non-expired cookie(s) "
                        f"in Firefox profile for {domain}"
                    ),
                    "cookie_count": firefox_result["cookie_count"],
                    "max_expires_unix": firefox_result["max_expires_unix"],
                    "last_access_within_30d": within_30d,
                }
        except sqlite3.OperationalError:
            ff_locked = True
            continue
        except Exception:
            continue

    # Nothing found
    if chrome_locked or ff_locked:
        # Per CLAUDE.md anti-pattern note: locked DB is "unknown", caller
        # should attempt the probe rather than skip.
        return {
            "domain": domain,
            "fresh": False,
            "source": "locked",
            "reason": (
                "browser cookie DB is locked (Chrome/Firefox is running with "
                "exclusive lock); freshness unknown, caller should attempt the probe"
            ),
            "cookie_count": 0,
            "max_expires_unix": None,
            "last_access_within_30d": None,
        }

    sources_checked = []
    if os.path.exists(chrome_default):
        sources_checked.append("Chrome")
    if glob(ff_glob):
        sources_checked.append("Firefox")
    where = " or ".join(sources_checked) if sources_checked else "Chrome or Firefox"
    return {
        "domain": domain,
        "fresh": False,
        "source": "none",
        "reason": f"no fresh cookie found for {domain} in {where}; precondition not met",
        "cookie_count": 0,
        "max_expires_unix": None,
        "last_access_within_30d": False,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: check_cookie_freshness.py <domain>", file=sys.stderr)
        return 1
    domain = argv[1]
    try:
        result = check(domain)
    except Exception as e:
        # Unknown failure -> let caller attempt; emit a locked-shaped row.
        result = {
            "domain": domain,
            "fresh": False,
            "source": "locked",
            "reason": f"freshness check raised {e!r}; caller should attempt the probe",
            "cookie_count": 0,
            "max_expires_unix": None,
            "last_access_within_30d": None,
        }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
