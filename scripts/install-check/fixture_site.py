#!/usr/bin/env python3
"""The install check's fixture site: a few pages on 127.0.0.1 that land the way the sites behind 17-18 Nov's bugs did.

    python3 -I fixture_site.py --port <port> --session <value> [--ready <file>] [--cert <pem> --key <pem>]

With --cert and --key it serves HTTPS, as the sites behind those bugs do: a cookie imported into the node's browser is set
for https (`import::Cookie::to_cdp`), and Chrome sends it to that scheme only.

Pages (the host is whatever the browser asked for; install-check.sh maps install-check.test and
install-check-captcha.test here):
  /account       signed out (no `session` cookie with the right value): 302 to /login?next=%2Faccount;
                 signed in: the account page, saying so
  /login         a sign-in form with a password box
  /members       signed out: 302 to /login-check?next=%2Fmembers, a sign-in whose first HTML is only a check's widget
                 and a shell its script draws the form into (#622's landing); signed in: the members' page
  /login-check   that sign-in
  /app           an app's shell: its first HTML is a check's widget and an empty root; its script draws the page,
                 with its own navigation, search, tabs and list (#625's landing)
  /files         a page whose Download button fetches /files/report.csv, sent as an attachment: the click saves a
                 file and leaves the page as it was (#624's landing)

Only stdlib. Serves until killed. Logs one line a request to stderr, without cookie values.
"""

import argparse
import http.server
import os
import ssl
import sys
import urllib.parse

# A check's widget as a page's first HTML carries one: a container with the widget's public key. Fixture data, read by
# the node's own classifier (`challenge::shows_a_widget`), never a real key.
WIDGET = '<div class="person-check" data-sitekey="install-check-fixture-key"></div>'


def page(title, body):
    return f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title></head><body>{body}</body></html>"


LOGIN = page(
    "Sign in",
    '<h1>Sign in</h1><form method=post action="/login">'
    '<label>Email <input name=email type=email autocomplete=username></label>'
    '<label>Password <input name=password type=password autocomplete=current-password></label>'
    '<button type=submit>Sign in</button></form>',
)

# The first HTML holds no field: its script draws the form, as an app's sign-in does.
LOGIN_CHECK = page(
    "Sign in",
    WIDGET + '<div id=root></div><script>'
    'document.getElementById("root").innerHTML = \'<h1>Sign in</h1><form method=post action="/login">'
    '<input name=email type=email aria-label=Email><input name=password type=password aria-label=Password>'
    '<button type=submit>Sign in</button></form>\';</script>',
)

# An app's shell: a check's widget (a help widget, a form further down) and an empty root; rendered, it is a working
# page with well over a dozen controls of its own.
APP = page(
    "Library",
    WIDGET + '<div id=app></div><script>'
    'var nav = ["Home", "Library", "Shared", "Settings", "Help"].map(function (n) { return "<a href=\\"/app#" + n + "\\">" + n + "</a>"; }).join(" ");'
    'var tabs = ["Videos", "Screenshots", "Archive"].map(function (n) { return "<button role=tab>" + n + "</button>"; }).join("");'
    'var rows = ["Quarterly review", "Onboarding walk-through", "Bug repro", "Design critique", "Release notes"].map(function (n) {'
    '  return "<li><a href=\\"/app#" + encodeURIComponent(n) + "\\">" + n + "</a> <button>Share</button></li>"; }).join("");'
    'document.getElementById("app").innerHTML = "<nav>" + nav + "</nav><input type=search aria-label=Search>"'
    '  + "<div role=tablist>" + tabs + "</div><button>New folder</button><ul>" + rows + "</ul>";'
    '</script>',
)


FILES = page(
    "Files",
    '<h1>Files</h1><p>Your report is ready.</p>'
    '<button id=download onclick="location.href=\'/files/report.csv\'">Download</button>',
)

REPORT = "name,count\ninstall-check,1\n"


def signed_in_page(title, who="install-check owner"):
    return page(
        title,
        f'<h1>{title}</h1><p id=who>Signed in as {who}</p>'
        '<nav><a href="/account">Account</a> <a href="/members">Members</a> <a href="/app">Library</a></nav>',
    )


class Handler(http.server.BaseHTTPRequestHandler):
    session = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("fixture: %s %s\n" % (self.command, self.path))

    def signed_in(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "session" and value == self.session:
                return True
        return False

    def send(self, status, body="", headers=(), kind="text/html; charset=utf-8"):
        data = body.encode()
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        if body:
            self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def to_sign_in(self, at, path):
        self.send(302, headers=[("Location", f"{at}?next={urllib.parse.quote(path, safe='')}")])

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/":
            return self.send(200, page("Install check", '<a href="/account">Account</a> <a href="/app">Library</a>'))
        if path == "/account":
            return self.send(200, signed_in_page("Account")) if self.signed_in() else self.to_sign_in("/login", "/account")
        if path == "/members":
            return self.send(200, signed_in_page("Members")) if self.signed_in() else self.to_sign_in("/login-check", "/members")
        if path == "/login":
            return self.send(200, LOGIN)
        if path == "/login-check":
            return self.send(200, LOGIN_CHECK)
        if path == "/app":
            return self.send(200, APP)
        if path == "/files":
            return self.send(200, FILES)
        if path == "/files/report.csv":
            return self.send(200, REPORT, [("Content-Disposition", 'attachment; filename="report.csv"')], "text/csv")
        return self.send(404, page("Not found", "<p>Not found</p>"))

    do_HEAD = do_GET

    def do_POST(self):
        self.send(303, headers=[("Location", "/login")])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=0, help="0 picks a free one")
    ap.add_argument("--session", required=True, help="the cookie value that signs in")
    ap.add_argument("--ready", help="a file the chosen port is written to once the server listens")
    ap.add_argument("--cert", help="a PEM certificate: serve HTTPS with it (needs --key)")
    ap.add_argument("--key", help="the certificate's PEM private key")
    a = ap.parse_args()
    if bool(a.cert) != bool(a.key):
        ap.error("--cert and --key go together")
    Handler.session = a.session
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    if a.cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(a.cert, a.key)
        # The handshake happens in the request's own thread, on its first read: a client that connects and says nothing
        # (a browser's preconnect) never holds up the others.
        server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    if a.ready:
        tmp = a.ready + ".tmp"
        with open(tmp, "w") as f:
            f.write(str(server.server_address[1]))
        os.replace(tmp, a.ready)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
