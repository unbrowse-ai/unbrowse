"""Requirements that are absences, held by reading the source (UNB-208, ledger rows W01, W04, W05, W08 and C05).

Each test reads files from the checkout and fails naming the file and line that breaks its rule. Standard library
only; nothing is built, started or fetched. Run: python3 -I -m unittest discover -s scripts/rules -p 'test_*.py' -v
"""
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE = ROOT / "unbrowse-node"
WINDOW = NODE / "window" / "src"
API = NODE / "agent-api.json"

# A Rust file's tests start at its `#[cfg(test)] mod ... {`: what comes after it never ships.
RUST_TESTS = re.compile(r"#\[cfg\(test\)\]\s*(?:pub(?:\(crate\))?\s+)?mod\s+\w+\s*\{")
# A Zig test block: `test "..." {` or `test {`.
ZIG_TESTS = re.compile(r"^test\b[^{\n]*\{", re.M)


def close_of(text, i):
    """The index just past the `}` that closes the `{` at text[i], skipping strings, chars and line comments;
    None when the file ends first."""
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i) or text.startswith("\\\\", i):  # a comment, or a Zig multiline string line
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        raw = re.match(r'r(#*)"', text[i : i + 12]) if c == "r" and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")) else None
        if raw:
            j = text.find('"' + raw.group(1), i + len(raw.group(0)))
            i = n if j < 0 else j + 1 + len(raw.group(1))
            continue
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if c == "'":
            m = re.match(r"'(?:\\.|\\u\{[0-9a-fA-F]+\}|\\x..|[^\\'])'", text[i : i + 12])
            if m:
                i += len(m.group(0))
                continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def without(text, blocks):
    """`text` with every block `blocks` matches (from its start to its closing brace) blanked, its newlines kept so
    line numbers still point at the file. A block that never closes runs to the end."""
    out, at = [], 0
    for m in blocks.finditer(text):
        if m.start() < at:
            continue
        end = close_of(text, m.end() - 1) or len(text)
        out.append(text[at : m.start()])
        out.append("\n" * text.count("\n", m.start(), end))
        at = end
    out.append(text[at:])
    return "".join(out)


def shipped_rust():
    """(path, line number, line) for every line of the node's Rust that ships: app/src and crates/*/src, without
    test modules, test-only files or integration tests."""
    for p in sorted(list((NODE / "app" / "src").rglob("*.rs")) + list(NODE.glob("crates/*/src/**/*.rs"))):
        if p.name in ("tests.rs", "test_alloc.rs", "testchain.rs") or "tests" in p.relative_to(NODE).parts:
            continue
        text = without(p.read_text(encoding="utf-8", errors="replace"), RUST_TESTS)
        for n, line in enumerate(text.splitlines(), 1):
            yield p, n, line


def shipped_zig():
    """(path, line number, line) for every line of the window that ships: src/*.zig without tests.zig and without
    each file's test blocks."""
    for p in sorted(WINDOW.rglob("*.zig")):
        if p.name == "tests.zig":
            continue
        text = without(p.read_text(encoding="utf-8", errors="replace"), ZIG_TESTS)
        for n, line in enumerate(text.splitlines(), 1):
            yield p, n, line


class TheScan(unittest.TestCase):
    """The rules below read only what ships; this holds the reading itself."""

    def test_a_test_module_is_left_out_and_the_code_after_it_is_read_at_its_own_line(self):
        rust = 'fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() { let s = "}"; let c = \'}\'; let r = r#"}"#; } // }\n}\nfn after() {}\n'
        kept = without(rust, RUST_TESTS).splitlines()
        self.assertEqual(kept[0], "fn a() {}")
        self.assertEqual(kept[5], "fn after() {}")
        self.assertNotIn("fn t()", "".join(kept))
        zig = 'const a = 1;\ntest "x" {\n    const s = "}";\n    const m =\n        \\\\ }\n    ;\n}\nconst after = 2;\n'
        kept = without(zig, ZIG_TESTS).splitlines()
        self.assertEqual((kept[0], kept[7]), ("const a = 1;", "const after = 2;"))
        self.assertNotIn('"}"', "".join(kept))


def strings(o):
    """Every key and string value in a JSON document."""
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def where(p, n, line):
    return f"{p.relative_to(ROOT)}:{n}: {line.strip()[:160]}"


# The delegation the node once had (spec §73-§75, removed in Nov 2026): delegating UNB to a bonded wallet, its
# delegators, collect_delegation, undelegate, bond_delegated. Any of these words in what ships brings it back.
DELEGATION = re.compile(r"(?i)\b(?:un)?delegat(?:e|es|ed|ing|ion|ions|or|ors)\b|\bbond_delegated\b|collect_?delegation")
# Other senses of the word that are not the feature, each kept to the one place it is said.
DELEGATION_ELSEWHERE = [
    ("app/src/applinks.rs", "delegate_permission/"),  # Android's Digital Asset Links relation name
    ("app/src/arc.rs", "account delegate"),  # EIP-7702: an account's code delegate
    ("app/src/arc.rs", "EIP-7702 delegate"),
    ("app/src/chain.rs", "EIP-7702 delegation"),
    ("app/src/chain/coins.rs", "delegating to `implementation`"),  # a minimal proxy clone
    ("app/src/chain/conform.rs", "every coin delegates to"),
    ("window/src/links.zig", "app.delegate"),  # NSApplication's delegate object
]


class Delegation(unittest.TestCase):
    """W04: the node and the window have no delegation commands, fields or text."""

    def test_no_owner_command_type_field_or_text_in_the_node_api_is_about_delegation(self):
        api = json.loads(API.read_text(encoding="utf-8"))
        found = sorted({s[:120] for s in strings(api) if DELEGATION.search(s)})
        self.assertEqual(found, [], "agent-api.json speaks of delegation")

    def test_no_line_the_node_or_the_window_ships_is_about_delegation(self):
        found = []
        lines = list(shipped_rust()) + list(shipped_zig())
        for p, n, line in lines:
            if not DELEGATION.search(line):
                continue
            rel = str(p.relative_to(NODE))
            if any(rel == f and s in line for f, s in DELEGATION_ELSEWHERE):
                continue
            found.append(where(p, n, line))
        self.assertGreater(len(lines), 50_000, "the node's and the window's source were read")
        self.assertEqual(found, [], "delegation in what ships")


class BridgeDialog(unittest.TestCase):
    """W05: there is no bridge dialog. The web window's bridge once asked the owner natively before six commands and
    the node asked again (removed 4 Nov 2026, 5cba6b49): the node's dialog is the only question."""

    def test_no_owner_command_carries_a_question_of_its_own_for_a_bridge_to_ask(self):
        api = json.loads(API.read_text(encoding="utf-8"))
        self.assertGreater(len(api["owner"]), 50, "the owner commands were read")
        asked = sorted(c["command"] for c in api["owner"] if "ask" in c or "web" in c)
        self.assertEqual(asked, [], "owner commands with a question of their own (the bridge's `ask` / `web: asked`)")

    def test_the_window_has_no_bridge_door_or_webview_and_raises_no_native_dialog(self):
        files = sorted(p.name for p in WINDOW.rglob("*") if re.search(r"(?i)door_commands|^door\.zig$|bridge|webview", p.name))
        self.assertEqual(files, [], "a bridge's files in the window")
        native = re.compile(r"NSAlert|runModal|MessageBox[AW]?\b|gtk_alert_dialog|GtkAlertDialog|gtk_message_dialog|AlertDialog|(?i:\bbridge\b|webview)")
        found = [where(p, n, line) for p, n, line in shipped_zig() if native.search(line)]
        self.assertEqual(found, [], "a dialog or bridge of the window's own")


class OneOwnerWindow(unittest.TestCase):
    """W01 and W08: the window is the one owner UI (the web window went in ad3d9605), and what it shows of routes is
    only what the node sends: no canned node answers in what ships (they live in tests.zig)."""

    def test_the_node_ships_no_web_window(self):
        web = [p for p in (NODE / "app").rglob("*") if p.suffix in (".tsx", ".jsx", ".vue", ".svelte") and "fixtures" not in p.parts]
        web += [p for p in NODE.rglob("package.json") if "node_modules" not in p.parts and re.search(r'"(react|react-dom|vue|svelte)"', p.read_text(encoding="utf-8"))]
        self.assertEqual([str(p.relative_to(ROOT)) for p in web], [], "a second owner UI beside the window")

    def test_the_window_ships_no_canned_routes_sites_or_wallets(self):
        # A node answer written into the window: a JSON record with the node's own field names.
        canned = re.compile(r'\\"(?:what|site|path|address|earned|calls)\\"\s*:')
        found = [where(p, n, line) for p, n, line in shipped_zig() if canned.search(line)]
        self.assertEqual(found, [], "canned node answers in the window's shipped source")


# Every Internet host the node's shipped Rust names, and what it is for. None is on the network path: an agent's call
# goes from the node to the site (or a peer's node) and back, through nothing of Unbrowse's and nothing paid. A host
# not listed here fails the test until someone says what it is for; one on the call path never belongs here (C05).
OFF_THE_CALL_PATH = {
    "telemetry.unbrowse.ai": "usage counts and bug reports, after the call; off with UNBROWSE_TELEMETRY=0",
    "unbrowse.ai": "the website: sign-in, funding, the remote MCP relay the owner turns on (off by default)",
    "unbrowse.si": "the website on the test network",
    "rpc.unbrowse.ai": "chain RPC gateway for signed-in nodes (settlement, not calls); falls back to Arc's public RPC, off with UNBROWSE_GATEWAY=off",
    "rpc.mainnet.arc.io": "Arc's public chain RPC",
    "rpc.testnet.arc.io": "Arc's public chain RPC (testnet)",
    "faucet.circle.com": "a link shown to the owner for test USDC",
    "registry.npmjs.org": "the update check",
    "accounts.google.com": "a site a passkey sign-in names (a site, not a service of ours)",
    "play.google.com": "app links' store page (a site the owner's app names)",
    "eips.ethereum.org": "a link in the ERC-8004 registration text",
    "gateway.codegraff.com": "the learner's optional judge, only with the owner's own TYPESAFE_API_KEY; unset, nothing is sent",
    "github.com": "a link in the error that says another browser engine isn't installed (crates/browser/src/cdp); never asked",
    "lightpanda.io": "a link in the error that says another browser engine isn't installed (crates/browser/src/cdp); never asked",
}
LOCAL = re.compile(r"^(?:127\.0\.0\.1|localhost|host|[^.]+|.*\.(?:example|invalid|local|test)|example\.(?:com|org|net))$")


class NothingOnTheCallPath(unittest.TestCase):
    """C05: no hosted client and no paid endpoint sits on the network path."""

    def test_every_host_the_node_names_is_one_off_the_call_path(self):
        named = {}
        for p, n, line in shipped_rust():
            if line.strip().startswith("//"):
                continue
            for h in re.findall(r"https?://([A-Za-z0-9.-]+)", line):
                h = h.lower().rstrip(".")
                if not LOCAL.match(h):
                    named.setdefault(h, where(p, n, line))
        unknown = {h: w for h, w in named.items() if h not in OFF_THE_CALL_PATH}
        self.assertEqual(unknown, {}, "a host the node calls that isn't known to be off the call path")
        self.assertIn("telemetry.unbrowse.ai", named, "the node's hosts were read")

    def test_the_sdks_talk_to_the_owners_own_node_by_default(self):
        ts = (ROOT / "unbrowse-sdk/typescript/src/client.ts").read_text(encoding="utf-8")
        py = (ROOT / "unbrowse-sdk/python/src/unbrowse/client.py").read_text(encoding="utf-8")
        self.assertRegex(py, r'DEFAULT_NODE = f"http://127\.0\.0\.1:\{wire\.DEFAULT_PORT\}"')
        self.assertRegex(ts, r"http://127\.0\.0\.1:")
        for name, text in (("client.ts", ts), ("client.py", py)):
            hosts = {h for h in re.findall(r"https?://([A-Za-z0-9.-]+)", text) if not LOCAL.match(h.lower()) and h != "hn.algolia.com"}
            self.assertEqual(hosts, set(), f"{name} names a hosted endpoint")


if __name__ == "__main__":
    unittest.main()
