"""A fake node's owner door, answering as app/src/commands.rs does: POST /owner/{cmd}, GET /owner/events, GET
/owner/frame. The answers are in the shapes agent-api.json gives each command."""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from proof_fixture import proof_answer  # noqa: E402
from signed_fixture import Signing  # noqa: E402

from unbrowse import AuthenticationError, NotFoundError, OwnerCommands, UnbrowseError, UnbrowseOwner  # noqa: E402
from unbrowse.local import node_address, node_port, owner_token  # noqa: E402

TOKEN = "owner-token"
# The token the running node holds: a restart makes a fresh one (api.rs, ``owner_token``).
NODE = {"token": TOKEN}
SEEN = []
MANIFEST = Path(__file__).resolve().parents[3] / "unbrowse-node" / "agent-api.json"

SETTINGS = {"map_while_browsing": True, "hold_routes": False, "signed_in_calls": True, "paused": False, "api_port": 7788, "storage_gb": 4, "excluded": [], "share_routes": "used", "coin_dev_buy_bps": 100, "coin_complete_others": False}
ENTRY = "0x" + "ab" * 32


def _coin_done(a):
    """A CoinDone, as the node answers each coin write: no chain behind it."""
    return {"tx": "0xcoin", "coin": "0xC", "entry": a["entry"], "amount": a.get("unb", a.get("coins"))}


COMMANDS = {
    "node_info": lambda a: {"name": "lewis-mac", "version": "0.1.0", "api_port": 7788, "dev": True},
    "identity": lambda a: {"address": "0x1234567890AbcdEF1234567890aBcdef12345678", "created": False},
    "settings": lambda a: SETTINGS,
    "save_settings": lambda a: a["settings"],
    "activity": lambda a: [{"at": 1, "who": "claude", "site": "hn.algolia.com", "what": f"limit {a.get('limit', 'none')}", "kind": "call", "result": "passed", "ms": 212, "unb": None, "tx": None, "note": None}],
    "agent_create": lambda a: {"agent": {"index": 3, "name": a["name"], "address": "0xabc", "cap_usdc": a["cap_usdc"], "cap_unb": a["cap_usdc"], "expires": 9, "created": 1, "revoked": False, "tx": None}, "setup": "UNBROWSE_AGENT_TOKEN=…"},
    "vault_add": lambda a: {"site": a["site"], "account": a["account"], "kind": a["kind"], "counter": 0, "created": 1, "code": False},
    "vault_reveal": lambda a: "hunter2",
    "delete_route": lambda a: None,
    "claim_now": lambda a: 2,
    "hands_input": lambda a: {"site": a["site"], "url": "https://www.linkedin.com/login", "walk": f"hands:{a['site']}", "width": 1280, "height": 720, "held": True},
    "hands_give_back": lambda a: {"site": a["site"], "answered": 1},
    "passkey_never": lambda a: a["site"],
    "set_pricing": lambda a: {"auto": a["auto"], "floor": a["floor"], "ceiling": a["ceiling"], "epoch": 3, "block": 120, "lines": 0},
    "money": lambda a: {"balance": "12.50", "available_to_spend": "11.75", "needed_to_start": "0.00", "add_funds_url": "https://unbrowse.ai/fund/#node=0xabc&chain=5042002&min=0.00&nonce=n1", "payments": "open", "parts": {"at_address": "0.75", "kept_for_fees": "0.25", "deposit": "11.75", "account_deposit": None, "signed": "0.00"}, "agents": [{"index": 0, "name": "Your agents", "daily_limit": "5.00", "spent_today": "0.03", "pays_from": "node"}], "earnings": {"available": "1.10"}},
    "wallet": lambda a: (_ for _ in ()).throw(Refused(400, "the chain isn't up")),
    # Bounties, as the node answers them (a BountyDone, a BountyView): no chain behind them.
    "bounty_post": lambda a: {"tx": "0xpost", "id": 7},
    "bounty_confirm": lambda a: {"tx": "0xconfirm", "id": a["id"]},
    "bounty_settle": lambda a: {"tx": "0xsettle", "id": a["id"]},
    "bounty_release": lambda a: {"tx": "0xrelease", "id": a["id"]},
    "bounty_refund": lambda a: {"tx": "0xrefund", "id": a["id"]},
    "bounty_show": lambda a: _bounty_view(a["id"]),
    "bounty_list": lambda a: [_bounty_view(7)] if a.get("mine") else [_bounty_view(8), _bounty_view(7)],
    "bounty_auto": lambda a: {"on": True if a.get("on") is None else a["on"]},
    # Route coins, as the node answers them (a CoinDone, Holdings, an earnings record).
    "coin_holdings": lambda a: {
        "wallet": "0xW", "owed_as_contributor_usdc": 0.25, "fetch_delay": 86400,
        "coins": [{"coin": "0xC", "entry": ENTRY, "state": "trading", "held": 40.0, "lots": [{"delay": 86400, "earning": 60.0, "pending": 0.0, "unstaking": 0.0, "ready_at": 0}],
                   "owed_usdc": 0.12, "parked_usdc": 0.0, "checked": True, "latest_passed": True, "price": 0.5, "value_unb": 50.0}],
    },
    "coin_launch": _coin_done,
    "coin_buy": _coin_done,
    "coin_sell": _coin_done,
    "coin_stake": _coin_done,
    "coin_unstake": _coin_done,
    "coin_withdraw": _coin_done,
    "coin_claim": _coin_done,
    "coin_fetch_delay": lambda a: {"delay": a.get("delay") or 86400, "tx": "0xdelay" if a.get("delay") else None},
    "coin_dev_buy": lambda a: {"bps": 100 if a.get("bps") is None else a["bps"]},
    "coin_rank": lambda a: {e: {"rank": 12.5, "staked": 60.0, "collateral": 30.0, "market_cap": 5.2, "price": 0.5} for e in a["entries"]},
    "earnings": lambda a: {
        "staking": {"earned": 1.5, "claimed": 1.0, "to_claim": 0.5}, "contributor": {"earned": 0.4, "claimed": 0.0, "to_claim": 0.4},
        "routes_paid": 2.2, "to_claim": 0.9,
    },
    "collect_earnings": lambda a: ["0xclaim1", "0xclaim2"],
}


def _bounty_view(i):
    return {
        "id": i, "poster": "0xP", "mine": i == 7, "site": "shop.example", "site_name": "Shop", "amount": 2000.0, "limit_price": 0.5,
        "posted_at": 1_700_000_000, "deadline": 1_702_592_000, "confirmed": False, "settled": False, "reserved": 0.0, "use_usdc": 0.0,
        "refundable": 0.0, "state": "open",
    }


class Refused(Exception):
    def __init__(self, status, error):
        super().__init__(error)
        self.status = status
        self.error = error


class Handler(Signing, BaseHTTPRequestHandler):
    TOKENS = staticmethod(lambda: [NODE["token"]])

    def _handle(self):
        proof = proof_answer(self.path, self.server.server_address[1], owner=NODE["token"])
        if proof is not None:
            return self._reply(200, proof)
        u = urlparse(self.path)
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        headers = {k.lower(): v for k, v in self.headers.items()}
        SEEN.append({"method": self.command, "url": self.path, "headers": headers, "body": body})
        auth = headers.get("authorization")
        # A request without a token stands for one a proxy in front of the node would have signed.
        if auth is not None and auth != f"Bearer {NODE['token']}":
            return self._reply(401, {"error": "the owner's token only"})
        if self.command == "GET" and u.path == "/owner/events":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b": keep-alive\n\nevent: activity\ndata: null\n\n")
            if NODE.get("forge"):
                # A process between the node and the window adds an event of its own.
                self.wfile.unsigned(b'event: activity\ndata: {"forged": true}\n\n')
                return
            self.wfile.write(b'event: call\ndata: {"phase":"start",\ndata: "route":"hn-search"}\n\n')
            self.wfile.write(b"event: eye\r\ndata: not json\r\n\r\n")
            return
        if self.command == "GET" and u.path == "/owner/frame":
            if parse_qs(u.query).get("walk") == ["none"]:
                return self._reply(404, {"error": "no picture of that walk"})
            self.send_response(200)
            self.send_header("content-type", "image/jpeg")
            self.send_header("content-length", "4")
            self.end_headers()
            self.wfile.write(bytes([0xFF, 0xD8, 0xFF, 0xD9]))
            return
        run = COMMANDS.get(u.path[len("/owner/"):])
        if run is None:
            return self._reply(404, {"error": f"no command {u.path[len('/owner/'):]}"})
        try:
            self._reply(200, run(body or {}))
        except Refused as e:
            self._reply(e.status, {"error": e.error})

    def _reply(self, status, out):
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _handle

    def log_message(self, *args):
        pass


def last():
    return SEEN[-1]


class OwnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def owner(self, token=TOKEN):
        return UnbrowseOwner(token=token, base_url=self.base + "/")

    def test_a_command_posts_its_arguments_to_owner_cmd_with_the_owners_token(self):
        info = self.owner().node_info()
        self.assertEqual(info["name"], "lewis-mac")
        self.assertEqual((last()["method"], last()["url"]), ("POST", "/owner/node_info"))
        self.assertEqual(last()["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(last()["body"], {})
        self.assertEqual(self.owner().command("claim_now"), 2)

    def test_each_bounty_method_posts_its_command_with_the_arguments_the_node_takes(self):
        o = self.owner()
        self.assertEqual(o.bounty_post("shop.example", 2000), {"tx": "0xpost", "id": 7})
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_post", {"site": "shop.example", "amount": 2000}), "a limit or days left out isn't sent")
        o.bounty_post("shop.example", 1500.5, limit=0.5, days=7)
        self.assertEqual(last()["body"], {"site": "shop.example", "amount": 1500.5, "limit": 0.5, "days": 7}, "any amount goes: the node is the judge of it")
        self.assertEqual(o.bounty_confirm(7, ENTRY)["tx"], "0xconfirm")
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_confirm", {"id": 7, "entry": ENTRY}))
        o.bounty_settle(7)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_settle", {"id": 7}))
        o.bounty_release(7, ENTRY)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_release", {"id": 7, "entry": ENTRY}))
        self.assertEqual(o.bounty_refund(7), {"tx": "0xrefund", "id": 7})
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_refund", {"id": 7}))
        one = o.bounty_show(7)
        self.assertEqual((one["site"], one["amount"], one["limit_price"], one["state"], one["refundable"]), ("shop.example", 2000.0, 0.5, "open", 0.0))
        self.assertEqual([d["id"] for d in o.bounty_list()], [8, 7])
        self.assertEqual([d["id"] for d in o.bounty_list(True)], [7])
        self.assertEqual(last()["body"], {"mine": True})
        self.assertEqual(o.bounty_auto(False)["on"], False)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/bounty_auto", {"on": False}))
        self.assertEqual(o.bounty_auto()["on"], True)

    def test_each_coin_method_posts_its_command_with_the_arguments_the_node_takes(self):
        o = self.owner()
        held = o.coin_holdings()
        self.assertEqual((held["fetch_delay"], held["coins"][0]["entry"], held["coins"][0]["lots"][0]["earning"]), (86400, ENTRY, 60.0))
        self.assertEqual(o.coin_launch(ENTRY, 500)["coin"], "0xC")
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_launch", {"entry": ENTRY, "unb": 500}))
        o.coin_buy(ENTRY, 100)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_buy", {"entry": ENTRY, "unb": 100}))
        o.coin_sell(ENTRY, 40)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_sell", {"entry": ENTRY, "coins": 40}))
        o.coin_stake(ENTRY, 60)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_stake", {"entry": ENTRY, "coins": 60}), "no delay sent: the node's 24 hours")
        o.coin_stake(ENTRY, 60, delay=604800)
        self.assertEqual(last()["body"], {"entry": ENTRY, "coins": 60, "delay": 604800})
        o.coin_unstake(ENTRY, 86400, 10)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_unstake", {"entry": ENTRY, "delay": 86400, "coins": 10}))
        o.coin_withdraw(ENTRY, 86400)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_withdraw", {"entry": ENTRY, "delay": 86400}))
        self.assertEqual(o.coin_claim(ENTRY)["tx"], "0xcoin")
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_claim", {"entry": ENTRY}))
        self.assertEqual(o.coin_fetch_delay(), {"delay": 86400, "tx": None})
        self.assertEqual(last()["body"], {}, "null only reads it")
        self.assertEqual(o.coin_fetch_delay(3600)["tx"], "0xdelay")
        self.assertEqual(last()["body"], {"delay": 3600})
        self.assertEqual(o.coin_dev_buy(), {"bps": 100}, "on at 1% by default")
        self.assertEqual(last()["body"], {})
        o.coin_dev_buy(0)
        self.assertEqual(last()["body"], {"bps": 0}, "0 turns it off, and is sent")
        self.assertEqual(o.coin_rank([ENTRY])[ENTRY]["rank"], 12.5)
        self.assertEqual((last()["url"], last()["body"]), ("/owner/coin_rank", {"entries": [ENTRY]}))

    def test_reads_the_token_and_address_from_the_environment(self):
        env = {"UNBROWSE_NODE": self.base, "UNBROWSE_OWNER_TOKEN": TOKEN}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            o = UnbrowseOwner()
            self.assertEqual(o.base_url, self.base)
            o.node_info()
            self.assertEqual(last()["headers"]["authorization"], f"Bearer {TOKEN}")
            self.assertNotIn(TOKEN, repr(o))
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_without_a_token_nothing_is_signed_for_a_proxy_that_signs_it(self):
        old = os.environ.pop("UNBROWSE_OWNER_TOKEN", None)
        try:
            UnbrowseOwner(base_url=self.base).node_info()
            self.assertNotIn("authorization", last()["headers"])
        finally:
            if old is not None:
                os.environ["UNBROWSE_OWNER_TOKEN"] = old

    def test_named_methods_send_the_nodes_own_argument_names(self):
        o = self.owner()
        o.agent_create("claude", 5, 30)
        self.assertEqual(last()["body"], {"name": "claude", "cap_usdc": 5, "cap_unb": 5, "days": 30})
        with self.assertWarns(DeprecationWarning):
            o.agent_create("claude", cap_unb=5, days=30)
        self.assertEqual(last()["body"], {"name": "claude", "cap_usdc": 5, "cap_unb": 5, "days": 30}, "the old keyword is the same cap")
        o.vault_add("example.com", "me", "derived")
        self.assertEqual(last()["body"], {"site": "example.com", "account": "me", "kind": "derived"}, "an argument left as None isn't sent")
        o.vault_add(site="example.com", account="me", kind="stored", password="pw")
        self.assertEqual(last()["body"], {"site": "example.com", "account": "me", "kind": "stored", "password": "pw"})
        self.assertEqual(o.vault_reveal("example.com", "me"), "hunter2")
        self.assertEqual(o.activity()[0]["what"], "limit none")
        o.activity(50)
        self.assertEqual(last()["body"], {"limit": 50})
        self.assertIsNone(o.delete_route("hn-search"))
        self.assertEqual(o.set_pricing(0.02, True, 0.001, 0.5)["auto"], True)
        self.assertEqual(last()["body"], {"fee": 0.02, "auto": True, "floor": 0.001, "ceiling": 0.5})
        self.assertEqual(o.passkey_never("github.com"), "github.com")
        self.assertEqual(last()["body"], {"site": "github.com"}, "the node reads a missing never as true")

    def test_the_owner_drives_a_sites_page_and_gives_it_back(self):
        o = self.owner()
        page = o.hands_input("linkedin.com", {"kind": "click", "x": 0.5, "y": 0.4})
        self.assertEqual(last()["body"], {"site": "linkedin.com", "kind": "click", "x": 0.5, "y": 0.4})
        self.assertTrue(page["held"])
        self.assertEqual(o.hands_give_back("linkedin.com", done=False), {"site": "linkedin.com", "answered": 1})
        self.assertEqual(last()["body"], {"site": "linkedin.com", "done": False})

    def test_settings_go_back_as_they_came_and_carry_the_per_fetch_maximum(self):
        o = self.owner()
        s = o.settings()
        self.assertEqual(o.save_settings(dict(s, paused=True))["paused"], True)
        self.assertEqual(last()["body"], {"settings": dict(s, paused=True)})
        self.assertEqual(o.set_max_fetch(0.2)["max_fetch_usdc"], 0.2)
        self.assertEqual(last()["body"], {"settings": dict(s, max_fetch_usdc=0.2)})

    def test_earnings_come_by_source_and_collecting_takes_them_all(self):
        o = self.owner()
        e = o.earnings()
        self.assertEqual((e["staking"]["to_claim"], e["contributor"]["to_claim"], e["to_claim"]), (0.5, 0.4, 0.9))
        self.assertEqual(o.collect_earnings(), ["0xclaim1", "0xclaim2"])
        self.assertEqual((last()["url"], last()["body"]), ("/owner/collect_earnings", {}))

    def test_money_reads_one_balance_in_dollars_with_each_agents_daily_limit(self):
        m = self.owner().money()
        self.assertEqual(last()["url"], "/owner/money")
        self.assertEqual((m["balance"], m["needed_to_start"]), ("12.50", "0.00"))
        self.assertEqual(m["agents"][0]["daily_limit"], "5.00")
        self.assertEqual(m["earnings"], {"available": "1.10"})
        self.assertIn("/fund/#node=0xabc&chain=5042002&min=0.00&nonce=", m["add_funds_url"])

    def test_the_nodes_address_reads_from_its_identity(self):
        self.assertEqual(self.owner().address(), "0x1234567890AbcdEF1234567890aBcdef12345678")
        self.assertEqual(last()["url"], "/owner/identity")

    def test_refusals_raise_with_the_nodes_reason(self):
        with self.assertRaises(UnbrowseError) as e:
            self.owner().wallet()
        self.assertEqual((e.exception.code, e.exception.message), ("bad_request", "the chain isn't up"))
        with self.assertRaises(NotFoundError):
            self.owner().command("nope")
        with self.assertRaises(UnbrowseError) as e:
            self.owner("wrong").node_info()
        self.assertEqual(e.exception.code, "unauthorized")

    def test_a_walks_picture_comes_back_as_a_jpeg(self):
        self.assertEqual(self.owner().frame("learn-1"), bytes([0xFF, 0xD8, 0xFF, 0xD9]))
        self.assertEqual(last()["url"], "/owner/frame?walk=learn-1")
        with self.assertRaises(NotFoundError):
            self.owner().frame("none")

    def test_events_arrive_by_name_whole(self):
        got = list(self.owner().events())
        self.assertEqual(SEEN[-1]["url"], "/owner/events")
        self.assertEqual(got, [("open", None), ("activity", None), ("call", {"phase": "start", "route": "hn-search"}), ("eye", "not json")])

    def test_an_event_the_node_didnt_sign_is_never_passed_on(self):
        from unbrowse import UnbrowseError

        NODE["forge"] = True
        self.addCleanup(NODE.pop, "forge")
        got = []
        with self.assertRaises(UnbrowseError) as e:
            for pair in self.owner().events():
                got.append(pair)
        self.assertEqual(got, [("open", None), ("activity", None)], "the added event never reached the caller")
        self.assertIn("isn't the node's", str(e.exception))

    def test_events_called_again_after_a_restart_reads_the_nodes_fresh_token(self):
        held = {"token": TOKEN}
        o = UnbrowseOwner(token=lambda: held["token"], base_url=self.base)
        self.assertEqual(next(o.events()), ("open", None))
        self.addCleanup(NODE.update, token=TOKEN)
        NODE["token"] = held["token"] = "the-next-start's-token"
        self.assertEqual(next(o.events()), ("open", None))
        self.assertEqual(last()["headers"]["authorization"], f"Bearer {NODE['token']}")
        o.node_info()
        self.assertEqual(last()["headers"]["authorization"], f"Bearer {NODE['token']}")

    def test_a_token_held_as_text_is_refused_after_a_restart(self):
        o = self.owner()
        self.addCleanup(NODE.update, token=TOKEN)
        NODE["token"] = "the-next-start's-token"
        with self.assertRaises(AuthenticationError):
            next(o.events())

    def test_every_command_the_node_answers_has_its_method(self):
        """The node writes agent-api.json from its one list of owner commands, and the client's methods are generated
        from it: each command's ``sdk.py`` is a method here, and one that takes no arguments goes out by its own name."""
        manifest = json.loads(MANIFEST.read_text())
        o = self.owner()
        self.assertIsInstance(o, OwnerCommands)
        for c in manifest["owner"]:
            self.assertTrue(callable(getattr(o, c["sdk"]["py"], None)), f"UnbrowseOwner has no {c['sdk']['py']}() for {c['command']}")
            if c["input"].get("required") or "allOf" in c["input"]:
                continue
            try:
                getattr(o, c["sdk"]["py"])()
            except UnbrowseError:
                pass
            self.assertEqual(urlparse(last()["url"]).path, f"/owner/{c['command']}")

    def test_local_reads_the_token_and_port_where_the_node_keeps_them(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertIsNone(owner_token(home), "a node that never ran here has no token")
            self.assertEqual(node_port(home), 7788)
            Path(home, "owner.token").write_text("abc123\n")
            Path(home, "settings.json").write_text(json.dumps({"api_port": 7790}))
            self.assertEqual(owner_token(home), "abc123")
            self.assertEqual(node_port(home), 7790)
            self.assertEqual(node_address(home), os.environ.get("UNBROWSE_NODE") or "http://127.0.0.1:7790")


if __name__ == "__main__":
    unittest.main()


class OwnerProofTest(unittest.TestCase):
    def test_the_owners_token_goes_to_no_listener_that_cannot_prove_the_node_holds_it(self):
        heard = []

        class Fake(BaseHTTPRequestHandler):
            def _handle(self):
                heard.append(self.headers.get("authorization"))
                n = int(self.headers.get("content-length") or 0)
                self.rfile.read(n)
                data = json.dumps({"agents": []} if self.path.startswith("/v1/node/proof") else {"name": "impostor"}).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        owner = UnbrowseOwner(token=TOKEN, base_url=f"http://127.0.0.1:{server.server_address[1]}")
        with self.assertRaises(UnbrowseError) as e:
            owner.command("node_info")
        self.assertEqual(e.exception.status, 401)
        self.assertTrue(heard and all(h is None for h in heard), heard)
