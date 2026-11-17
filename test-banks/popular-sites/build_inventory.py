#!/usr/bin/env python3
"""Build a fixed 400-site inventory from a downloaded permanent Tranco CSV."""

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

from curation import CATEGORIES, market_for

HERE = Path(__file__).resolve().parent
LIST_ID = "GQ3LK"
SNAPSHOT_DATE = "2026-10-27"
MAX_RANK = 50000
TARGET = 400
PUBLIC_BASE = ["public.home", "public.navigation", "public.redirect", "public.error", "public.challenge"]
SEARCH_CATEGORIES = set(CATEGORIES) - {"consumer_technology", "government_health"}
PAGINATION_CATEGORIES = {"search_portals", "social_community", "news_media", "commerce_marketplace", "video_music", "gaming", "education_research", "reference_lifestyle"}
AUTH_CATEGORIES = set(CATEGORIES) - {"government_health", "education_research"}
ACTION_BY_CATEGORY = {
    "social_community": ["action.form_submit", "action.message_send", "action.account_change"],
    "commerce_marketplace": ["action.checkout", "action.account_change"],
    "travel_transport": ["action.checkout", "action.account_change"],
    "productivity_saas": ["action.form_submit", "action.account_change"],
}


def ranked_domains(path):
    data = path.read_bytes()
    ranks = {}
    for row in csv.reader(data.decode("utf-8-sig").splitlines()):
        if len(row) != 2 or not row[0].isdigit():
            raise ValueError(f"invalid Tranco row: {row}")
        ranks[row[1]] = int(row[0])
    return ranks, hashlib.sha256(data).hexdigest(), len(data)


def candidates(ranks):
    selected = {}
    for category, domains in CATEGORIES.items():
        for domain in domains:
            if domain not in selected and domain in ranks and ranks[domain] <= MAX_RANK:
                selected[domain] = {"category": category, "rank": ranks[domain], "market": market_for(domain)}
    if len(selected) < TARGET:
        raise ValueError(f"only {len(selected)} ranked candidates; need {TARGET}")
    counts = Counter(x["category"] for x in selected.values())
    regional = sum(x["market"] != "GLOBAL" for x in selected.values())
    # Keep at least 20 per category and 80 localized-market hosts while
    # dropping the least popular candidates. This is a sampling choice.
    for domain, row in sorted(list(selected.items()), key=lambda pair: pair[1]["rank"], reverse=True):
        if len(selected) == TARGET:
            break
        if counts[row["category"]] <= 20 or (row["market"] != "GLOBAL" and regional <= 80):
            continue
        del selected[domain]
        counts[row["category"]] -= 1
        if row["market"] != "GLOBAL":
            regional -= 1
    if len(selected) != TARGET:
        raise ValueError(f"selection constraints yielded {len(selected)}, expected {TARGET}")
    return selected


def scenario_candidates(category):
    ids = PUBLIC_BASE.copy()
    if category in SEARCH_CATEGORIES:
        ids.append("public.search")
    if category in PAGINATION_CATEGORIES:
        ids.append("public.pagination")
    if category in AUTH_CATEGORIES:
        ids.extend(["auth.protected_guest", "auth.login", "auth.session_expiry", "auth.mfa", "auth.logout"])
    ids.extend(ACTION_BY_CATEGORY.get(category, []))
    return ids


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tranco-csv", type=Path, required=True, help="CSV from https://tranco-list.eu/download/GQ3LK/1000000")
    args = parser.parse_args()
    ranks, digest, size = ranked_domains(args.tranco_csv)
    chosen = candidates(ranks)
    sites = []
    for domain, row in sorted(chosen.items(), key=lambda pair: pair[1]["rank"]):
        sites.append({
            "domain": domain,
            "entrypoint": "https://" + domain + "/",
            "tranco_rank": row["rank"],
            "category": row["category"],
            "market": row["market"],
            "scenario_candidates": scenario_candidates(row["category"]),
            "capability_status": "unverified",
            "site_fixture": None,
        })
    payload = {
        "schema_version": 1,
        "source": {
            "name": "Tranco standard daily list",
            "list_id": LIST_ID,
            "snapshot_date": SNAPSHOT_DATE,
            "list_url": f"https://tranco-list.eu/list/{LIST_ID}",
            "download_url": f"https://tranco-list.eu/download/{LIST_ID}/1000000",
            "sha256_full_csv": digest,
            "full_csv_bytes": size,
            "rank_ceiling": MAX_RANK,
            "selection": "Editorial web-facing candidates; deduplicated by first category; drop highest ranks while retaining >=20/category and >=80 localized-market sites.",
        },
        "sites": sites,
    }
    (HERE / "sites.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {len(sites)} sites; {len(set(s['category'] for s in sites))} categories; {sum(s['market'] != 'GLOBAL' for s in sites)} localized-market hosts")


if __name__ == "__main__":
    main()
