#!/usr/bin/env python3
"""Dependency-free structural and safety validation of the test bank."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

from curation import CATEGORIES, market_for

HERE = Path(__file__).resolve().parent
DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$|^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")
SAFE_RISKS = {"read", "account_session"}
SIDE_EFFECT_RISKS = {"write", "message", "purchase", "account_change"}
REQUIRED_ACTION_INPUTS = {"site_scope", "test_account", "approved_action"}


def check(condition, message, errors):
    if not condition:
        errors.append(message)


def validate(sites_doc, scenarios_doc, rank_csv=None, example_fixture=None, public_reads=None, future_targets=None, browser_fixtures=None, browser_smokes=None, public_all=None):
    errors = []
    check(sites_doc.get("schema_version") == 1, "sites schema_version must be 1", errors)
    check(scenarios_doc.get("schema_version") == 1, "scenarios schema_version must be 1", errors)
    source = sites_doc.get("source", {})
    for key in ("name", "list_id", "snapshot_date", "list_url", "download_url", "sha256_full_csv", "rank_ceiling", "selection"):
        check(bool(source.get(key)), f"missing source.{key}", errors)
    check(source.get("list_id") == "GQ3LK", "unexpected permanent Tranco list ID", errors)
    check(source.get("snapshot_date") == "2026-10-27", "unexpected snapshot date", errors)
    check(bool(re.fullmatch(r"[a-f0-9]{64}", source.get("sha256_full_csv", ""))), "invalid full CSV SHA-256", errors)

    scenarios = scenarios_doc.get("scenarios", [])
    check(isinstance(scenarios, list) and len(scenarios) >= 12, "scenario catalog too small", errors)
    scenario_ids = set()
    for case in scenarios:
        if not isinstance(case, dict):
            errors.append("scenario is not an object")
            continue
        ident = case.get("id")
        check(isinstance(ident, str) and re.fullmatch(r"(public|auth|action)\.[a-z_]+", ident or "") is not None, f"invalid scenario ID {ident!r}", errors)
        check(ident not in scenario_ids, f"duplicate scenario ID {ident}", errors)
        scenario_ids.add(ident)
        for field in ("purpose", "phase", "risk", "steps", "assertions", "requires"):
            check(bool(case.get(field)), f"{ident}: missing {field}", errors)
        check(case.get("risk") in SAFE_RISKS | SIDE_EFFECT_RISKS, f"{ident}: unknown risk", errors)
        if case.get("risk") in SIDE_EFFECT_RISKS:
            check(case.get("opt_in") is True, f"{ident}: side-effect scenario must be opt-in", errors)
            check(REQUIRED_ACTION_INPUTS.issubset(set(case.get("requires", []))), f"{ident}: missing explicit action authorization inputs", errors)
        if case.get("phase") == "auth":
            check(case.get("risk") in SAFE_RISKS, f"{ident}: auth scenario has side-effect risk", errors)
        if ident and ident.startswith("auth.") and ident != "auth.protected_guest":
            check("test_account" in case.get("requires", []), f"{ident}: test account required", errors)

    sites = sites_doc.get("sites", [])
    check(isinstance(sites, list) and len(sites) == 400, f"expected 400 sites, got {len(sites) if isinstance(sites,list) else 'non-list'}", errors)
    domains = set()
    ranks = set()
    category_counts = Counter()
    market_counts = Counter()
    candidate_counts = Counter()
    previous_rank = 0
    category_members = {cat: set(values) for cat, values in CATEGORIES.items()}
    for i, site in enumerate(sites):
        if not isinstance(site, dict):
            errors.append(f"sites[{i}] is not an object")
            continue
        domain = site.get("domain")
        rank = site.get("tranco_rank")
        category = site.get("category")
        market = site.get("market")
        check(isinstance(domain, str) and bool(DOMAIN.fullmatch(domain)), f"sites[{i}]: invalid domain", errors)
        check(domain not in domains, f"duplicate domain {domain}", errors)
        domains.add(domain)
        check(isinstance(rank, int) and not isinstance(rank, bool) and 1 <= rank <= 50000, f"{domain}: invalid rank", errors)
        if isinstance(rank, int):
            check(rank not in ranks, f"duplicate Tranco rank {rank}", errors)
            ranks.add(rank)
            check(rank > previous_rank, f"{domain}: inventory not sorted by rank", errors)
            previous_rank = rank
        check(category in CATEGORIES and domain in category_members.get(category, set()), f"{domain}: category not in curation", errors)
        check(market == market_for(domain), f"{domain}: market differs from curation", errors)
        url = urlparse(site.get("entrypoint", ""))
        check(url.scheme == "https" and url.hostname == domain and url.path == "/" and not url.query and not url.fragment, f"{domain}: invalid entrypoint", errors)
        ids = site.get("scenario_candidates", [])
        check(isinstance(ids, list) and len(ids) == len(set(ids)), f"{domain}: duplicate/invalid scenario candidates", errors)
        check(set(ids).issubset(scenario_ids), f"{domain}: unknown scenario candidate", errors)
        check({"public.home", "public.redirect", "public.challenge"}.issubset(ids), f"{domain}: core public scenarios missing", errors)
        check(site.get("capability_status") == "unverified", f"{domain}: capability status overstated", errors)
        check(site.get("site_fixture") is None, f"{domain}: fixture must remain null until site-specific evidence is added", errors)
        category_counts[category] += 1
        market_counts[market] += 1
        candidate_counts.update(ids)

    check(len(category_counts) == 14 and all(n >= 20 for n in category_counts.values()), "category diversity constraint failed", errors)
    check(sum(n for market, n in market_counts.items() if market != "GLOBAL") >= 80, "market diversity constraint failed", errors)
    check(len(market_counts) >= 12, "too few market labels", errors)

    if rank_csv:
        from build_inventory import ranked_domains
        full_ranks, digest, size = ranked_domains(rank_csv)
        check(digest == source.get("sha256_full_csv"), "full Tranco CSV hash mismatch", errors)
        check(size == source.get("full_csv_bytes"), "full Tranco CSV byte count mismatch", errors)
        for site in sites:
            check(full_ranks.get(site["domain"]) == site["tranco_rank"], f"{site['domain']}: rank does not match permanent snapshot", errors)

    if example_fixture is not None:
        check(example_fixture.get("schema_version") == 1, "example fixture schema_version must be 1", errors)
        check(example_fixture.get("domain") == "example.test", "example fixture must use a reserved example domain", errors)
        check(example_fixture.get("site_scope") == ["https://example.test/"], "example fixture scope must stay illustrative", errors)
        for key in ("test_account", "credential_provider", "mfa_factor_provider", "approved_action", "test_recipient", "sandbox_checkout", "spend_limit"):
            check(example_fixture.get(key) is None, f"example fixture must not contain live {key}", errors)

    if public_reads is not None:
        check(public_reads.get("schema_version") == 1 and public_reads.get("probe_type") == "unauthenticated_homepage_get", "invalid public read fixture header", errors)
        results = public_reads.get("results", [])
        check(isinstance(results, list) and 1 <= len(results) <= 20, "invalid public read sample size", errors)
        checked = set()
        for result in results:
            domain = result.get("domain")
            check(domain in domains and domain not in checked, f"public read domain invalid or duplicated: {domain}", errors)
            checked.add(domain)
            check(bool(result.get("checked_at")), f"{domain}: missing check timestamp", errors)
            check(result.get("classification") in {"public_content", "possible_challenge", "challenge_or_denial", "nonstandard_2xx", "redirect_unresolved", "http_error", "network_error"}, f"{domain}: unknown read classification", errors)
            check(isinstance(result.get("redirect_chain"), list) and len(result["redirect_chain"]) <= 5, f"{domain}: invalid redirect chain", errors)
            status = result.get("status")
            check(status is None or (isinstance(status, int) and 100 <= status <= 599), f"{domain}: invalid status", errors)
            if result.get("classification") == "public_content":
                check(status == 200, f"{domain}: public content requires HTTP 200", errors)
            if result.get("classification") == "network_error":
                check(status is None, f"{domain}: network error cannot have status", errors)

    if future_targets is not None:
        check(future_targets.get("schema_version") == 1 and future_targets.get("source_list_id") == "GQ3LK", "invalid future-target header", errors)
        targets = future_targets.get("domains", [])
        check([row.get("domain") for row in targets] == ["x.com", "instagram.com", "linkedin.com", "carousell.sg"], "unexpected future targets", errors)
        for row in targets:
            domain = row.get("domain")
            check(row.get("in_400_site_inventory") == (domain in domains), f"{domain}: inventory membership mismatch", errors)
            if rank_csv:
                check(full_ranks.get(domain) == row.get("tranco_rank"), f"{domain}: future-target rank mismatch", errors)

    if browser_fixtures is not None:
        from local_chrome import validate_fixture
        for name, fixture in browser_fixtures.items():
            permitted = domains | {"example.test"} if name == "auth.example" else domains
            errors.extend(f"{name}: {error}" for error in validate_fixture(fixture, permitted))

    if browser_smokes is not None:
        expected_smokes = {"wikipedia": (4, 200, True), "govuk": (6, 200, True), "booking": (1, 202, False), "nytimes": (1, 403, False)}
        for name, smoke in browser_smokes.items():
            check(smoke.get("schema_version") == 1 and smoke.get("runner") == "local_chrome_cdp", f"{name}: invalid Chrome smoke header", errors)
            check(smoke.get("domain") in domains and smoke.get("auth_requested") is False, f"{name}: invalid smoke domain/auth flag", errors)
            expected = expected_smokes.get(name)
            check(expected is not None and len(smoke.get("results", [])) == expected[0], f"{name}: unexpected Chrome check count", errors)
            for result in smoke.get("results", []):
                if expected:
                    check(result.get("assertion_passed") is expected[2] and result.get("status") == expected[1], f"{name}: browser result changed", errors)
                check(result.get("scenario", "").startswith("public."), f"{name}: nonpublic smoke scenario", errors)
                check("?" not in result.get("requested_url", "") and "?" not in result.get("final_url", ""), f"{name}: query leaked in smoke metadata", errors)
                check(bool(re.fullmatch(r"[a-f0-9]{16}", result.get("final_url_fingerprint", ""))), f"{name}: missing route fingerprint", errors)

    if public_all is not None:
        from probe_all_public import BLOCKED_SEGMENTS, STATIC_EXTENSIONS, summarize
        check(public_all.get("schema_version") == 1 and public_all.get("runner") == "http_client_public_get" and public_all.get("source_list_id") == "GQ3LK" and public_all.get("complete") is True, "invalid all-site HTTP pass header", errors)
        parameters = public_all.get("parameters", {})
        check(parameters.get("max_initial_gets_per_site") == 2 and parameters.get("max_redirects_per_request") == 5 and parameters.get("max_response_bytes") == 262144, "unexpected HTTP pass request budget", errors)
        rows = public_all.get("results", [])
        check(isinstance(rows, list) and len(rows) == 400, "all-site HTTP pass must contain 400 results", errors)
        rank_by_domain = {site["domain"]: site["tranco_rank"] for site in sites}
        seen = set()
        classifications = {"public_html", "possible_challenge", "challenge_or_denial", "non_html", "nonstandard_2xx", "http_error", "network_error", "blocked_redirect", "other_status", "runner_exception"}
        for row in rows:
            domain = row.get("domain")
            check(domain in domains and domain not in seen and row.get("tranco_rank") == rank_by_domain.get(domain), f"{domain}: invalid or duplicate all-site result", errors)
            seen.add(domain)
            home = row.get("homepage") or {}
            check(home.get("classification") in classifications, f"{domain}: missing homepage classification", errors)
            check(home.get("requested_url") == f"https://{domain}/", f"{domain}: wrong homepage request", errors)
            check(isinstance(home.get("redirect_chain"), list) and len(home["redirect_chain"]) <= 6, f"{domain}: invalid homepage redirect chain", errors)
            check(home.get("latency_ms") is None or isinstance(home["latency_ms"], int), f"{domain}: invalid homepage latency", errors)
            route = row.get("route")
            reason = row.get("route_skip_reason")
            check((route is None) != (reason is None), f"{domain}: route outcome or skip reason required", errors)
            if route is not None:
                url = urlparse(route.get("requested_url", ""))
                final = urlparse(home.get("final_url") or "")
                segments = [segment.lower() for segment in url.path.split("/") if segment]
                check(url.scheme == "https" and url.hostname == final.hostname and not url.query and bool(segments), f"{domain}: route must be a same-host HTTPS path", errors)
                check(not any(segment in BLOCKED_SEGMENTS for segment in segments) and not any(url.path.lower().endswith(ext) for ext in STATIC_EXTENSIONS), f"{domain}: unsafe route candidate", errors)
                check(route.get("classification") in classifications and isinstance(route.get("redirect_chain"), list) and len(route["redirect_chain"]) <= 6, f"{domain}: invalid route result", errors)
        check(seen == domains, "all-site HTTP results do not cover the inventory", errors)
        check(public_all.get("summary") == summarize(rows), "all-site HTTP summary does not match rows", errors)

    metrics = {
        "site_count": len(sites),
        "scenario_count": len(scenarios),
        "category_counts": dict(sorted(category_counts.items())),
        "market_counts": dict(sorted(market_counts.items())),
        "candidate_counts": dict(sorted(candidate_counts.items())),
        "localized_market_sites": sum(n for market, n in market_counts.items() if market != "GLOBAL"),
        "rank_min": min(ranks) if ranks else None,
        "rank_max": max(ranks) if ranks else None,
        "full_rank_verified": bool(rank_csv),
        "public_read_fixture_count": len(public_reads.get("results", [])) if public_reads else 0,
        "local_chrome_check_count": sum(len(smoke.get("results", [])) for smoke in browser_smokes.values()) if browser_smokes else 0,
        "local_chrome_assertions_passed": sum(result.get("assertion_passed") is True for smoke in browser_smokes.values() for result in smoke.get("results", [])) if browser_smokes else 0,
        "all_site_http_count": len(public_all.get("results", [])) if public_all else 0,
    }
    return errors, metrics


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tranco-csv", type=Path, help="optional downloaded full CSV for rank/hash verification")
    args = parser.parse_args()
    sites_doc = json.loads((HERE / "sites.json").read_text())
    scenarios_doc = json.loads((HERE / "scenarios.json").read_text())
    example_fixture = json.loads((HERE / "site-fixture.example.json").read_text())
    public_reads = json.loads((HERE / "public-read-results.json").read_text())
    future_targets = json.loads((HERE / "future-targets.json").read_text())
    browser_fixtures = {path.stem: json.loads(path.read_text()) for path in (HERE / "browser-fixtures").glob("*.json")}
    browser_smokes = {name: json.loads((HERE / f"browser-smoke-{name}.json").read_text()) for name in ("wikipedia", "govuk", "booking", "nytimes")}
    public_all = json.loads((HERE / "public-all-results.json").read_text())
    errors, metrics = validate(sites_doc, scenarios_doc, args.tranco_csv, example_fixture, public_reads, future_targets, browser_fixtures, browser_smokes, public_all)
    if errors:
        print("VALIDATION FAILED")
        for error in errors:
            print("-", error)
        raise SystemExit(1)
    print("VALIDATION PASSED")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
