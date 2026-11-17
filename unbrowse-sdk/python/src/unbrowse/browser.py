from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional, Union

from .models import BrowseReply, LearnedRoute

if TYPE_CHECKING:
    from .client import UnbrowseNode


class Browser:
    """One site's browser on the node, driven by hand.

    A target is a ref from ``snapshot()`` (``@e3``) or a CSS selector. Every method returns the node's reply: what
    the browser printed, and the routes this browsing has learned. Once a route does what you're clicking through,
    call it instead (``node.call(route.route_id, inputs)``).

    Pages are the site's own, in the site's own profile on the node, so logins hold between steps and between runs.
    A check only a person can pass goes to the owner with ``ask_owner``.
    """

    def __init__(self, node: "UnbrowseNode", goal: str = "", site: str = "", session: Optional[str] = None):
        self._node = node
        self.session = session or node.session
        """The browsing session this browser drives: its own tab in the site's browser."""
        self.goal = goal
        """What you're doing, e.g. "post a listing": the node names what it learns from this browsing after it."""
        self.site = site
        """The site this browser is on, once a page is open."""
        self.learned: List[LearnedRoute] = []
        """Every route this browsing has learned, oldest first."""
        self.route_for_goal: Optional[LearnedRoute] = None
        """The latest ``open``'s route for the goal, if it found one."""

    def __enter__(self) -> "Browser":
        return self

    def __exit__(self, *exc: object) -> None:
        # Closing lets the node learn the flow while the browser still holds its session.
        if self.site:
            self.close()

    def run(self, *args: str) -> BrowseReply:
        """Any command the node's browser takes, word by word: ``run("get", "attr", "@e2", "href")``."""
        return self._run(list(args))

    def _run(self, args: List[str], timeout: Optional[float] = None) -> BrowseReply:
        reply = self._node.browse(args, site=self.site, goal=self.goal, timeout=timeout, session=self.session)
        if reply.site:
            self.site = reply.site
        for r in reply.learned:
            if not any(l.route_id == r.route_id for l in self.learned):
                self.learned.append(r)
        if reply.route_for_goal or (args and args[0] == "open"):
            self.route_for_goal = reply.route_for_goal
        return reply

    def open(self, url: str, goal: Optional[str] = None) -> BrowseReply:
        """Open a page (a full http(s) URL). With a goal a route already does, ``route_for_goal`` names it."""
        if goal is not None:
            self.goal = goal
        return self.run("open", url)

    def snapshot(self, interactive: bool = False, compact: bool = False, depth: Optional[int] = None, selector: Optional[str] = None) -> BrowseReply:
        """The page as an accessibility tree, each element with a ref (``@e3``) to act on.

        ``interactive`` keeps only what can be clicked or filled: the usual choice before acting.
        """
        args = ["snapshot"]
        if interactive:
            args.append("-i")
        if compact:
            args.append("-c")
        if depth is not None:
            args += ["-d", str(depth)]
        if selector:
            args += ["-s", selector]
        return self.run(*args)

    def click(self, target: str) -> BrowseReply:
        return self.run("click", target)

    def dblclick(self, target: str) -> BrowseReply:
        return self.run("dblclick", target)

    def fill(self, target: str, text: str) -> BrowseReply:
        """Clear the field and fill it. What you fill becomes a route input when the page sends it."""
        return self.run("fill", target, text)

    def type(self, target: str, text: str) -> BrowseReply:
        """Type into the field, keeping what's there."""
        return self.run("type", target, text)

    def press(self, key: str) -> BrowseReply:
        """Press a key: ``Enter``, ``Tab``, ``Control+a``."""
        return self.run("press", key)

    def select(self, target: str, value: str) -> BrowseReply:
        """Pick an option by value or visible label."""
        return self.run("select", target, value)

    def check(self, target: str) -> BrowseReply:
        return self.run("check", target)

    def uncheck(self, target: str) -> BrowseReply:
        return self.run("uncheck", target)

    def hover(self, target: str) -> BrowseReply:
        return self.run("hover", target)

    def focus(self, target: str) -> BrowseReply:
        return self.run("focus", target)

    def scroll(self, direction: str, px: Optional[int] = None, selector: Optional[str] = None) -> BrowseReply:
        """Scroll ``up``, ``down``, ``left`` or ``right``, the page or the element at ``selector``."""
        args = ["scroll", direction]
        if px is not None:
            args.append(str(px))
        if selector:
            args += ["--selector", selector]
        return self.run(*args)

    def scroll_into_view(self, target: str) -> BrowseReply:
        return self.run("scrollintoview", target)

    def upload(self, target: str, *files: str) -> BrowseReply:
        """Upload files (paths on the node's machine) into a file input."""
        return self.run("upload", target, *files)

    def get(self, what: str, target: Optional[str] = None) -> BrowseReply:
        """Read something off the page: ``get("text", "@e1")``, ``get("title")``, ``get("url")``.

        ``what`` is one of text, html, value, title, url, count, box, styles.
        """
        return self.run("get", what, *([target] if target else []))

    def attr(self, target: str, name: str) -> BrowseReply:
        """An element's attribute."""
        return self.run("get", "attr", target, name)

    def is_(self, state: str, target: str) -> BrowseReply:
        """Whether an element is ``visible``, ``enabled`` or ``checked``."""
        return self.run("is", state, target)

    def find(
        self,
        by: str,
        value: str,
        action: str,
        action_value: Optional[str] = None,
        *,
        name: Optional[str] = None,
        exact: bool = False,
    ) -> BrowseReply:
        """Find an element by what a person sees and act on it.

        ``by`` is role, text, label, placeholder, alt, title, testid, first or last; ``action`` is click, fill,
        check, hover or text. ``name`` narrows a role by its accessible name; ``exact`` matches case and whole text.

            b.find("label", "Email", "fill", "me@example.com")
            b.find("role", "button", "click", name="Submit")
        """
        args = ["find", by, value, action]
        if action_value is not None:
            args.append(action_value)
        if name is not None:
            args += ["--name", name]
        if exact:
            args.append("--exact")
        return self.run(*args)

    def wait(
        self,
        target: Optional[Union[str, int]] = None,
        *,
        text: Optional[str] = None,
        url: Optional[str] = None,
        load: Optional[str] = None,
        fn: Optional[str] = None,
        timeout_ms: Optional[int] = None,
    ) -> BrowseReply:
        """Wait for an element (selector or ref), a time in ms, text, a URL pattern, a load state or a JS condition.

            b.wait(500)
            b.wait("#results")
            b.wait(text="Sent", timeout_ms=5000)
            b.wait(load="networkidle")
        """
        args = ["wait"]
        if target is not None:
            args.append(str(target))
        if text is not None:
            args += ["--text", text]
        if url is not None:
            args += ["--url", url]
        if load is not None:
            args += ["--load", load]
        if fn is not None:
            args += ["--fn", fn]
        if timeout_ms is not None:
            args += ["--timeout", str(timeout_ms)]
        return self.run(*args)

    def back(self) -> BrowseReply:
        return self.run("back")

    def forward(self) -> BrowseReply:
        return self.run("forward")

    def reload(self) -> BrowseReply:
        return self.run("reload")

    def eval(self, js: str, timeout_ms: Optional[int] = None) -> BrowseReply:
        """Run JavaScript in the page; the reply's ``output`` is its result. A script has 30 s; ``timeout_ms`` gives it
        longer, up to 300000."""
        if timeout_ms is None:
            return self.run("eval", js)
        return self._run(["eval", "--timeout", str(timeout_ms), js], timeout=timeout_ms / 1000 + 60)

    def screenshot(self, path: Optional[str] = None, full: bool = False, annotate: bool = False) -> BrowseReply:
        """A screenshot, saved on the node's machine; the reply's ``output`` says where."""
        args = ["screenshot"]
        if path:
            args.append(path)
        if full:
            args.append("--full")
        if annotate:
            args.append("--annotate")
        return self.run(*args)

    def ask_owner(self, why: str, timeout_s: Optional[int] = None) -> BrowseReply:
        """Ask the owner to do something on this page only a person can: sign in when the vault has no login, enter
        a code, pass a check.

        The page shows in the Unbrowse app, where the owner clicks and types on it; this waits until they give it
        back (5 minutes, or ``timeout_s`` up to 1800) and the reply's ``owner`` says how it went: ``done``,
        ``declined`` or ``no_answer``. What they type never reaches you; the session they earn stays in the site's
        profile, so your next step is signed in.
        """
        args = ["ask_owner", why]
        if timeout_s is not None:
            args += ["--timeout", str(timeout_s)]
        # The node answers once the owner does: the request waits a little longer than the ask.
        return self._run(args, timeout=min(timeout_s or 300, 1800) + 30)

    def close(self) -> BrowseReply:
        """Close the site's browser. The node learns the flow first, while the browser still holds its session."""
        return self.run("close")
