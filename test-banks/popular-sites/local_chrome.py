#!/usr/bin/env python3
"""Bounded route checks in local Chrome through the DevTools protocol.

Only explicit public routes and test-account login/logout are implemented.
Action scenarios have no execution path in this harness.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import urlopen

try:
    import websocket  # websocket-client; never logs protocol frames or secrets
except ImportError:
    websocket = None

HERE = Path(__file__).resolve().parent
DEFAULT_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
TIMEOUT = 20
IDENT = re.compile(r"^[A-Z][A-Z0-9_]*$")
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def report_url(url):
    """Never emit query strings or fragments that might contain auth codes."""
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def url_fingerprint(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def scope_allows(url, scopes):
    actual = urlparse(url)
    if actual.scheme != "https" or not actual.hostname or actual.username or actual.password:
        return False
    for prefix in scopes:
        allowed = urlparse(prefix)
        if actual.scheme != allowed.scheme or actual.netloc.lower() != allowed.netloc.lower():
            continue
        base = allowed.path or "/"
        if base.endswith("/") or actual.path == base or actual.path.startswith(base + "/"):
            if actual.path.startswith(base):
                return True
    return False


def secret_ref_valid(ref):
    if not isinstance(ref, dict):
        return False
    if ref.get("provider") == "env":
        return set(ref) == {"provider", "name"} and bool(IDENT.fullmatch(ref.get("name", "")))
    if ref.get("provider") == "macos_keychain":
        return set(ref) == {"provider", "service", "account"} and all(isinstance(ref.get(k), str) and ref[k] for k in ("service", "account"))
    return False


def read_secret(ref):
    if not secret_ref_valid(ref):
        raise ValueError("invalid secret reference")
    if ref["provider"] == "env":
        value = os.environ.get(ref["name"])
    else:
        completed = subprocess.run(
            ["security", "find-generic-password", "-s", ref["service"], "-a", ref["account"], "-w"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        value = completed.stdout.rstrip("\n") if completed.returncode == 0 else None
    if not value:
        raise ValueError("required credential reference is unavailable")
    return value


def validate_fixture(fixture, known_domains):
    errors = []
    if set(fixture) - {"schema_version", "domain", "site_scope", "public", "auth"}:
        errors.append("unknown top-level fixture fields")
    domain = fixture.get("domain")
    scopes = fixture.get("site_scope", [])
    if fixture.get("schema_version") != 1 or domain not in known_domains:
        errors.append("fixture must name an inventoried domain with schema_version 1")
    if not isinstance(scopes, list) or not scopes or any(not isinstance(s, str) or not s.startswith("https://") or not urlparse(s).hostname or urlparse(s).username or urlparse(s).password or urlparse(s).query or urlparse(s).fragment for s in scopes):
        errors.append("site_scope must be nonempty HTTPS URL prefixes")
        scopes = []
    elif not any(urlparse(s).hostname == domain for s in scopes):
        errors.append("site_scope must include the inventoried domain")
    public = fixture.get("public", {})
    if not isinstance(public, dict) or not public.get("entrypoint"):
        errors.append("public.entrypoint is required")
        public = {}
    if set(public) - {"entrypoint", "nav_link_selector", "search_url_template", "search_queries", "listing_url", "next_link_selector"}:
        errors.append("unknown public fixture fields")
    for field in ("entrypoint", "listing_url"):
        if public.get(field) and not scope_allows(public[field], scopes):
            errors.append(f"public.{field} outside site_scope")
    if public.get("search_url_template"):
        template = public["search_url_template"]
        if not isinstance(template, str) or template.count("{query}") != 1 or not scope_allows(template.replace("{query}", "test"), scopes):
            errors.append("search_url_template must contain one {query} within site_scope")
        if not isinstance(public.get("search_queries"), list) or len(public["search_queries"]) != 2 or any(not isinstance(q, str) or not q or len(q) > 80 for q in public["search_queries"]):
            errors.append("search_queries must contain exactly two short benign strings")
    if public.get("listing_url") and not public.get("next_link_selector"):
        errors.append("listing_url requires next_link_selector")
    if public.get("next_link_selector") and not public.get("listing_url"):
        errors.append("next_link_selector requires listing_url")
    if any(k in fixture for k in ("approved_action", "action", "write", "checkout", "message")):
        errors.append("action configuration is not supported by local_chrome.py")
    if any(k in fixture for k in ("password", "username", "mfa_code", "cookie", "token")):
        errors.append("inline credentials are forbidden")
    auth = fixture.get("auth")
    if auth is not None:
        if not isinstance(auth, dict) or auth.get("disposable_test_account") is not True or not auth.get("account_label"):
            errors.append("auth requires a labeled disposable test account")
            auth = {}
        if set(auth) - {"disposable_test_account", "account_label", "protected_url", "login_url", "auth_write_scope", "username_selector", "password_selector", "submit_selector", "authenticated_marker", "logout_selector", "guest_expectation", "username_ref", "password_ref", "mfa", "post_login_selector"}:
            errors.append("unknown auth fixture fields")
        for field in ("protected_url", "login_url"):
            if not auth.get(field) or not scope_allows(auth[field], scopes):
                errors.append(f"auth.{field} is required within site_scope")
        write_scopes = auth.get("auth_write_scope")
        if not isinstance(write_scopes, list) or not write_scopes or any(not isinstance(prefix, str) or not scope_allows(prefix, scopes) or urlparse(prefix).query or urlparse(prefix).fragment for prefix in write_scopes):
            errors.append("auth.auth_write_scope must list observed login/logout request prefixes within site_scope")
        for field in ("username_selector", "password_selector", "submit_selector", "post_login_selector", "authenticated_marker", "logout_selector"):
            if not isinstance(auth.get(field), str) or not auth[field]:
                errors.append(f"auth.{field} is required")
        for field in ("username_ref", "password_ref"):
            if not secret_ref_valid(auth.get(field)):
                errors.append(f"auth.{field} must be an env or macOS Keychain reference")
        if any(k in auth for k in ("username", "password", "mfa_code", "cookie", "token")):
            errors.append("inline auth secrets are forbidden")
        expectation = auth.get("guest_expectation", {})
        if not isinstance(expectation, dict) or expectation.get("type") not in ("url_prefix", "status", "selector") or not expectation.get("value"):
            errors.append("auth.guest_expectation must define URL prefix, status, or selector")
        elif expectation["type"] == "url_prefix" and not scope_allows(expectation["value"], scopes):
            errors.append("guest URL expectation outside site_scope")
        elif expectation["type"] == "status" and (not isinstance(expectation["value"], int) or not 100 <= expectation["value"] <= 599):
            errors.append("guest status expectation must be an HTTP status")
        mfa = auth.get("mfa")
        if mfa is not None and (not isinstance(mfa, dict) or set(mfa) != {"code_ref", "code_selector", "submit_selector"} or not secret_ref_valid(mfa.get("code_ref")) or not mfa.get("code_selector") or not mfa.get("submit_selector")):
            errors.append("MFA requires code_ref, code_selector, and submit_selector")
    return errors


class ChromeCDP:
    def __init__(self, chrome_path, scopes, headed=False, timeout=TIMEOUT, auth_write_scope=None):
        if websocket is None:
            raise RuntimeError("Install websocket-client to run local Chrome checks")
        self.chrome_path = chrome_path
        self.scopes = scopes
        self.auth_write_scope = auth_write_scope or []
        self.headed = headed
        self.timeout = timeout
        self.profile = None
        self.process = None
        self.ws = None
        self.next_id = 0
        self.events = []
        self.responses = []
        self.redirects = []
        self.blocked = Counter()
        self.auth_writes = False
        self.main_frame = None

    def __enter__(self):
        try:
            self.profile = tempfile.TemporaryDirectory(prefix="unbrowse-local-chrome-")
            args = [str(self.chrome_path), "--disable-extensions", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", f"--user-data-dir={self.profile.name}", "about:blank"]
            if not self.headed:
                args.append("--headless=new")
            self.process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            active = Path(self.profile.name) / "DevToolsActivePort"
            deadline = time.monotonic() + 10
            while not active.exists() and time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("local Chrome exited before DevTools was ready")
                time.sleep(0.1)
            if not active.exists():
                raise TimeoutError("local Chrome DevTools startup timed out")
            port = active.read_text().splitlines()[0]
            tabs = json.load(urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3))
            page = next((tab for tab in tabs if tab.get("type") == "page" and tab.get("url") == "about:blank"), None)
            if page is None:
                raise RuntimeError("local Chrome did not expose the isolated blank tab")
            self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=3, suppress_origin=True)
            self.call("Page.enable")
            self.call("Runtime.enable")
            self.call("Network.enable")
            tree = self.call("Page.getFrameTree")
            self.main_frame = tree["frameTree"]["frame"]["id"]
            self.call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, exc_type, exc, tb):
        if self.ws:
            self.ws.close()
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=4)
        if self.profile:
            self.profile.cleanup()

    def send(self, method, params=None):
        self.next_id += 1
        ident = self.next_id
        self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        return ident

    def receive(self, timeout):
        self.ws.settimeout(max(0.1, timeout))
        message = json.loads(self.ws.recv())
        method = message.get("method")
        if method == "Fetch.requestPaused":
            params = message["params"]
            request = params["request"]
            url = request["url"]
            verb = request["method"].upper()
            document = params.get("resourceType") == "Document"
            allowed = (not document or scope_allows(url, self.scopes)) and (verb not in WRITE_METHODS or (self.auth_writes and scope_allows(url, self.auth_write_scope)))
            if allowed:
                self.send("Fetch.continueRequest", {"requestId": params["requestId"]})
            else:
                self.blocked["out_of_scope_document" if document and not scope_allows(url, self.scopes) else "unapproved_write"] += 1
                self.send("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "BlockedByClient"})
        elif method == "Network.responseReceived":
            params = message["params"]
            if params.get("type") == "Document" and params.get("frameId") == self.main_frame:
                self.responses.append({"status": int(params["response"]["status"]), "url": params["response"]["url"]})
        elif method == "Network.requestWillBeSent":
            params = message["params"]
            if params.get("frameId") == self.main_frame and params.get("redirectResponse"):
                self.redirects.append(int(params["redirectResponse"]["status"]))
        elif method:
            self.events.append(method)
        return message

    def call(self, method, params=None):
        ident = self.send(method, params)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            message = self.receive(deadline - time.monotonic())
            if message.get("id") == ident:
                if "error" in message:
                    raise RuntimeError(f"Chrome CDP {method} failed")
                return message.get("result", {})
        raise TimeoutError(f"Chrome CDP {method} timed out")

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": False})
        if result.get("exceptionDetails"):
            raise RuntimeError("page evaluation failed")
        return result.get("result", {}).get("value")

    def wait_for(self, predicate, seconds=TIMEOUT):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return True
            except RuntimeError:
                pass
            time.sleep(0.25)
        return False

    def pump(self, seconds):
        """Keep request interception responsive while an auth form settles."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                self.receive(min(0.5, deadline - time.monotonic()))
            except websocket.WebSocketTimeoutException:
                pass

    def navigate(self, url, name):
        if not scope_allows(url, self.scopes):
            raise ValueError("navigation outside site_scope")
        self.responses.clear()
        self.redirects.clear()
        blocked_before = self.blocked.copy()
        event_start = len(self.events)
        nav = self.call("Page.navigate", {"url": url})
        if nav.get("errorText"):
            raise RuntimeError("Chrome navigation failed")
        deadline = time.monotonic() + self.timeout
        while "Page.loadEventFired" not in self.events[event_start:] and time.monotonic() < deadline:
            try:
                self.receive(min(1.0, deadline - time.monotonic()))
            except websocket.WebSocketTimeoutException:
                pass
        info = self.evaluate("({url: location.href, title: document.title, ready: document.readyState, body: (document.body && document.body.innerText || '').slice(0, 1200)})")
        status = self.responses[-1]["status"] if self.responses else None
        title = (info.get("title") or "").lower()
        if status in (403, 429, 503):
            classification = "challenge_or_denial"
        elif "just a moment" in title or "verify you are human" in title or "checking your browser" in title:
            classification = "possible_challenge"
        elif status == 200:
            classification = "public_content"
        elif status and 200 < status < 300:
            classification = "nonstandard_2xx"
        elif status and status >= 400:
            classification = "http_error"
        else:
            classification = "unclassified"
        blocked_this_route = {key: count - blocked_before[key] for key, count in self.blocked.items() if count > blocked_before[key]}
        return {"scenario": name, "requested_url": report_url(url), "requested_url_fingerprint": url_fingerprint(url), "final_url": report_url(info["url"]), "final_url_fingerprint": url_fingerprint(info["url"]), "status": status, "classification": classification, "redirect_count": len(self.redirects), "blocked_requests": blocked_this_route}

    def link(self, selector):
        expression = f"(() => {{ const e = document.querySelector({json.dumps(selector)}); return e && e.href || null; }})()"
        href = self.evaluate(expression)
        if not href or not scope_allows(href, self.scopes):
            raise RuntimeError("configured link missing or outside site_scope")
        return href

    def has_selector(self, selector):
        return bool(self.evaluate(f"!!document.querySelector({json.dumps(selector)})"))

    def fill(self, selector, value):
        expression = f"(() => {{ const e=document.querySelector({json.dumps(selector)}); if (!e) return false; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(e,{json.dumps(value)}); e.dispatchEvent(new Event('input',{{bubbles:true}})); e.dispatchEvent(new Event('change',{{bubbles:true}})); return true; }})()"
        if not self.evaluate(expression):
            raise RuntimeError("configured input selector missing")

    def click(self, selector):
        expression = f"(() => {{ const e=document.querySelector({json.dumps(selector)}); if (!e) return false; e.click(); return true; }})()"
        if not self.evaluate(expression):
            raise RuntimeError("configured click selector missing")


def guest_matches(browser, result, expectation):
    kind = expectation["type"]
    value = expectation["value"]
    if kind == "status":
        return result["status"] == value
    if kind == "url_prefix":
        return scope_allows(result["final_url"], [value])
    return browser.has_selector(value)


def run_public(browser, fixture):
    public = fixture["public"]
    results = []
    homepage = browser.navigate(public["entrypoint"], "public.home")
    homepage["assertion_passed"] = homepage["classification"] == "public_content"
    results.append(homepage)
    if public.get("nav_link_selector") and homepage["classification"] == "public_content":
        navigated = browser.navigate(browser.link(public["nav_link_selector"]), "public.navigation")
        navigated["assertion_passed"] = navigated["classification"] == "public_content" and navigated["final_url_fingerprint"] != homepage["final_url_fingerprint"]
        results.append(navigated)
    if public.get("search_url_template"):
        searches = []
        for query in public["search_queries"]:
            url = public["search_url_template"].replace("{query}", quote(query, safe=""))
            searches.append(browser.navigate(url, "public.search"))
        distinct = searches[0]["final_url_fingerprint"] != searches[1]["final_url_fingerprint"]
        for search in searches:
            search["assertion_passed"] = search["classification"] == "public_content" and distinct
        results.extend(searches)
    if public.get("listing_url"):
        first = browser.navigate(public["listing_url"], "public.listing")
        first["assertion_passed"] = first["classification"] == "public_content"
        results.append(first)
        if first["classification"] == "public_content":
            next_url = browser.link(public["next_link_selector"])
            next_page = browser.navigate(next_url, "public.pagination")
            next_page["assertion_passed"] = next_page["classification"] == "public_content" and next_page["final_url_fingerprint"] != first["final_url_fingerprint"]
            results.append(next_page)
    return results


def run_auth(browser, fixture, credentials=None):
    auth = fixture["auth"]
    # Resolve every required secret before starting an auth flow. Never print it.
    credentials = credentials or {
        "username": read_secret(auth["username_ref"]),
        "password": read_secret(auth["password_ref"]),
    }
    results = []
    guest = browser.navigate(auth["protected_url"], "auth.protected_guest")
    guest_ok = guest_matches(browser, guest, auth["guest_expectation"])
    guest["assertion_passed"] = guest_ok
    results.append(guest)
    if not guest_ok:
        return results
    browser.navigate(auth["login_url"], "auth.login_page")
    browser.fill(auth["username_selector"], credentials["username"])
    browser.fill(auth["password_selector"], credentials["password"])
    browser.auth_writes = True
    try:
        browser.click(auth["submit_selector"])
        if auth.get("mfa"):
            mfa = auth["mfa"]
            if not browser.wait_for(lambda: browser.has_selector(mfa["code_selector"])):
                raise RuntimeError("configured MFA prompt did not appear")
            # Read a one-time code only when the prompt appears.
            browser.fill(mfa["code_selector"], read_secret(mfa["code_ref"]))
            browser.click(mfa["submit_selector"])
        if not browser.wait_for(lambda: browser.has_selector(auth["post_login_selector"])):
            raise RuntimeError("configured post-login marker did not appear")
    finally:
        browser.auth_writes = False
    protected = browser.navigate(auth["protected_url"], "auth.login")
    protected["assertion_passed"] = browser.has_selector(auth["authenticated_marker"])
    results.append(protected)
    if not protected["assertion_passed"]:
        return results
    browser.auth_writes = True
    try:
        browser.click(auth["logout_selector"])
        browser.pump(1)
    finally:
        browser.auth_writes = False
    logged_out = browser.navigate(auth["protected_url"], "auth.logout")
    logged_out["assertion_passed"] = guest_matches(browser, logged_out, auth["guest_expectation"])
    results.append(logged_out)
    return results


def main():
    parser = argparse.ArgumentParser(description="Local Chrome route check; no VM and no action execution")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--auth", action="store_true", help="explicitly enable disposable test-account login/logout")
    parser.add_argument("--validate-only", action="store_true", help="validate fixture without starting Chrome or resolving secrets")
    parser.add_argument("--headed", action="store_true", help="show local Chrome window")
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--timeout", type=int, default=TIMEOUT)
    parser.add_argument("--output", type=Path, help="metadata-only JSON result path")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 120:
        parser.error("--timeout must be 1-120 seconds")
    fixture = json.loads(args.fixture.read_text())
    inventory = json.loads((HERE / "sites.json").read_text())
    known_domains = {site["domain"] for site in inventory["sites"]}
    if args.validate_only:
        known_domains.add("example.test")
    errors = validate_fixture(fixture, known_domains)
    if errors:
        parser.error("; ".join(errors))
    if args.validate_only:
        print(f"Fixture valid: {fixture['domain']}")
        return
    if not args.chrome.exists():
        parser.error("local Chrome executable missing; pass --chrome")
    if args.auth and not fixture.get("auth"):
        parser.error("--auth requires an auth fixture")
    credentials = None
    if args.auth:
        # Fail before browser launch if a reference is missing.
        auth = fixture["auth"]
        credentials = {
            "username": read_secret(auth["username_ref"]),
            "password": read_secret(auth["password_ref"]),
        }
    results = []
    write_scope = fixture["auth"]["auth_write_scope"] if args.auth else []
    with ChromeCDP(args.chrome, fixture["site_scope"], args.headed, args.timeout, write_scope) as browser:
        results.extend(run_public(browser, fixture))
        if args.auth:
            results.extend(run_auth(browser, fixture, credentials))
    payload = {"schema_version": 1, "runner": "local_chrome_cdp", "domain": fixture["domain"], "auth_requested": args.auth, "results": results}
    if args.output:
        args.output.write_text(json.dumps(payload, indent=2) + "\n")
    for result in results:
        assertion = result.get("assertion_passed")
        print(f"{result['scenario']:22} {str(result['status']):4} {result['classification']:22} assertion={assertion}")
    print(f"Local Chrome checks: {len(results)}; metadata output: {args.output or 'stdout summary only'}")
    if any(result.get("assertion_passed") is False for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
