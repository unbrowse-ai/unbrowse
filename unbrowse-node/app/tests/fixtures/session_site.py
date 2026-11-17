"""A signed-in site for the live test of what an agent's script reads (`a_signed_in_page_never_hands_its_cookies_to_an_agent_through_the_browser`).

Run it on another machine the node's browser can reach (the node's browser never browses this one, its own addresses
included): `python3 session_site.py <port>`, then `UNBROWSE_LIVE_SITE=http://<that machine>:<port>`.

- `/?sid=..&pref=..&kept=..` sets `sid` HttpOnly and `pref` readable by the page's script, and serves a page whose own
  code keeps `kept` in localStorage and sessionStorage and says in its title whether it sees its own cookie;
- `/me` says back every cookie it was sent.
"""
import html
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Site(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        headers = []
        if url.path == "/me":
            body = f"<html><head><title>me</title></head><body><p id=me>You sent: {html.escape(self.headers.get('Cookie', ''))}</p></body></html>"
        else:
            sid, pref, kept = q.get("sid", ""), q.get("pref", ""), q.get("kept", "")
            if sid:
                headers.append(("Set-Cookie", f"sid={sid}; Path=/; HttpOnly"))
            if pref:
                headers.append(("Set-Cookie", f"pref={pref}; Path=/"))
            body = (
                "<html><head><title>app</title><script>"
                f"localStorage.setItem('authState', {kept!r}); sessionStorage.setItem('tab', {kept!r});"
                "window.appState = 'visible-to-the-page';"
                f"document.title = 'app ' + (document.cookie.indexOf({pref!r}) >= 0 ? 'sees its cookie' : 'blind');"
                "</script></head><body><p id=p>app</p></body></html>"
            )
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Site).serve_forever()
