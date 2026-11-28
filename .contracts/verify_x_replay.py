#!/usr/bin/env python3
"""Execution witness for x.com SearchTimeline sandbox replay blockers.

Starts an isolated unbrowse-node from the current repo, replays x.com route
91fd4777a28522cd with UNBROWSE_SIGN_DEBUG=1, and verifies:
  1. Lazy CDN chunks from abs.twimg.com (present in the route's carried bundle)
     are NOT refused with `abs.twimg.com is not the page's own site`.
  2. Inline <script> boot does NOT fail with `reading 'remove'` or
     `reading 'previousElementSibling'` (document.currentScript missing).
  3. The sandbox boots and returns output.
"""

import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NODE_MANIFEST = REPO / "unbrowse-node" / "Cargo.toml"
ROUTE_SRC = Path.home() / ".unbrowse" / "routes" / "91fd4777a28522cd.json"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def target_dir() -> Path:
    env_td = os.environ.get("CARGO_TARGET_DIR")
    if env_td:
        return Path(env_td)
    return REPO / "unbrowse-node" / "target"


def run_source() -> int:
    tests = [
        "a_lazy_chunk_on_a_carried_script_host_is_allowed_for_plain_get_only",
        "an_inline_script_sees_document_current_script_and_its_previous_sibling",
        "a_per_call_header_relayed_by_a_service_worker_is_not_minted",
        "a_page_may_ask_only_its_own_site_over_https",
        "a_session_header_token_is_minted",
        "one_sighting_of_a_csrf_header_is_minted",
    ]
    cmd = [
        "cargo", "test", "--manifest-path", str(NODE_MANIFEST),
        "-p", "unbrowse-learn", "--lib", "--", *tests, "--nocapture",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    out = res.stdout + "\n" + res.stderr
    missing = [t for t in tests if f"{t} ... ok" not in out]
    print(f"SOURCE_TESTS rc={res.returncode} passed={len(tests) - len(missing)}/{len(tests)} missing={missing}")
    if res.returncode != 0 or missing:
        print(out[-2500:], file=sys.stderr)
        print("VERDICT=FAIL")
        return 1
    clippy = subprocess.run(
        ["cargo", "clippy", "--manifest-path", str(NODE_MANIFEST), "-p", "unbrowse-learn", "--all-targets", "--", "-D", "warnings"],
        capture_output=True, text=True,
    )
    if clippy.returncode != 0:
        print("CLIPPY_FAILED:", clippy.stderr[-2500:], file=sys.stderr)
        print("VERDICT=FAIL")
        return 1
    print("CLIPPY=OK")
    print("VERDICT=PASS")
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "execution"
    if mode == "source":
        return run_source()
    if not ROUTE_SRC.is_file():
        print(f"MISSING_ROUTE: {ROUTE_SRC} not found on this machine", file=sys.stderr)
        return 2

    # Ensure binaries are built for the current checkout.
    build = subprocess.run(
        ["cargo", "build", "--manifest-path", str(NODE_MANIFEST), "--bin", "unbrowse-node", "--bin", "unb"],
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        print("BUILD_FAILED:", build.stderr[-2000:], file=sys.stderr)
        return 1

    td = target_dir() / "debug"
    node_bin = td / "unbrowse-node"
    unb_bin = td / "unb"
    if not node_bin.is_file() or not unb_bin.is_file():
        print(f"BINARIES_MISSING: {node_bin} / {unb_bin}", file=sys.stderr)
        return 1

    port = free_port()
    with tempfile.TemporaryDirectory(prefix="verify-x-replay-") as tmp:
        home_dir = Path(tmp) / "home"
        (home_dir / "routes").mkdir(parents=True)
        shutil.copy2(ROUTE_SRC, home_dir / "routes" / ROUTE_SRC.name)
        log_path = Path(tmp) / "node.log"

        node_env = os.environ.copy()
        node_env.update({
            "UNBROWSE_HOME": str(home_dir),
            "UNBROWSE_ROOT_KEY_FILE": "1",
            "UNBROWSE_PORT": str(port),
            "UNBROWSE_SIGN_DEBUG": "1",
        })
        # Pick the newest Node runtime available (sandbox confinement needs Node 25+ on macOS/Linux;
        # independent of PR #1025's automatic discovery).
        if not node_env.get("SIGNING_PROGRAM"):
            nvm_nodes = sorted(
                (Path.home() / ".nvm" / "versions" / "node").glob("v*/bin/node"),
                key=lambda p: tuple(int(x) for x in p.parent.parent.name.lstrip("v").split(".")[:3] if x.isdigit()),
                reverse=True,
            )
            picked = str(nvm_nodes[0]) if nvm_nodes else shutil.which("node")
            if picked:
                node_env["SIGNING_PROGRAM"] = picked

        with open(log_path, "w") as log_fp:
            proc = subprocess.Popen(
                [str(node_bin)],
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                env=node_env,
            )

        try:
            tok = ""
            deadline = time.time() + 20.0
            while time.time() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        res = subprocess.run(
                            [str(node_bin), "agent", "token", "0"],
                            env=node_env,
                            capture_output=True,
                            text=True,
                            timeout=5,
                        )
                        if res.returncode == 0 and res.stdout.strip():
                            tok = res.stdout.strip()
                            break
                except OSError:
                    pass
                time.sleep(0.25)

            if not tok:
                print("NODE_STARTUP_FAILED: could not mint agent token 0", file=sys.stderr)
                print(log_path.read_text()[-2000:], file=sys.stderr)
                return 1

            call_env = os.environ.copy()
            call_env.update({
                "UNBROWSE_NODE": f"http://127.0.0.1:{port}",
                "UNBROWSE_AGENT_TOKEN": tok,
            })
            call = subprocess.run(
                [str(unb_bin), "call", "91fd4777a28522cd", "q=AI video since:2026-11-19", "src=typed_query", "f=top"],
                env=call_env,
                capture_output=True,
                text=True,
                timeout=60,
            )
        finally:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

        log = log_path.read_text(errors="replace")
        cdn_refusals = [l.strip() for l in log.splitlines() if "refused (abs.twimg.com is not the page's own site)" in l]
        cdn_allowed = [l.strip() for l in log.splitlines() if "abs.twimg.com" in l and "page call GET" in l]
        remove_errs = [l.strip() for l in log.splitlines() if "reading 'remove'" in l]
        sibling_errs = [l.strip() for l in log.splitlines() if "reading 'previousElementSibling'" in l]
        boot_lines = [l.strip() for l in log.splitlines() if "[sign] boot " in l or "[sign] sandbox child output:" in l or "[sign] sandbox:" in l]

        print(f"X_REPLAY_CHECK port={port} cdn_refusals={len(cdn_refusals)} cdn_allowed={len(cdn_allowed)} remove_errs={len(remove_errs)} sibling_errs={len(sibling_errs)}")
        for line in boot_lines[:6]:
            print("  LOG:", line[:240])
        for line in cdn_allowed[:4]:
            print("  CDN_OK:", line[:200])
        for line in cdn_refusals[:4]:
            print("  CDN_REFUSED:", line[:200])
        for line in remove_errs[:2]:
            print("  REMOVE_ERR:", line[:200])
        for line in sibling_errs[:2]:
            print("  SIBLING_ERR:", line[:200])

        ok = bool(boot_lines) and len(cdn_refusals) == 0 and len(remove_errs) == 0 and len(sibling_errs) == 0
        if not ok:
            print("  NODE_LOG_TAIL:", log[-1500:])
            print("VERDICT=FAIL")
            return 1
        print("VERDICT=PASS")
        return 0


if __name__ == "__main__":
    sys.exit(main())
