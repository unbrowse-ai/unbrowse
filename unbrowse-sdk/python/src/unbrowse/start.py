"""The node on this machine, started for a client when none is running (``Unbrowse.start``, ``auto_start``). The same as
the TypeScript package's ``start``. The node needs no browser for this: it serves search, calls and whoami without one,
and fetches its browser only when a goal needs it (or never, when its owner says so)."""

from __future__ import annotations

import atexit
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Mapping, Optional, Tuple, Union

from .cli import bin_dir, exe
from .client import error_for
from .local import node_home, node_port


def node_program(program: Union[str, Path, None] = None) -> Optional[Path]:
    """The ``unbrowse-node`` program on this machine: ``program``, else ``UNBROWSE_BIN``'s, else this package's."""
    d = bin_dir()
    for p in (Path(program) if program else None, d / exe("unbrowse-node") if d else None):
        if p is not None and p.exists():
            return p
    return None


def _answers(base_url: str) -> bool:
    """Whether anything answers HTTP at ``base_url``."""
    try:
        with urllib.request.urlopen(f"{base_url}/v1/node/proof?challenge={'00' * 32}", timeout=2):
            return True
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, OSError):
        return False


class Started:
    """A node this started, which ``stop`` ends."""

    def __init__(self, proc: subprocess.Popen, said: Deque[str]):
        self._proc = proc
        self._said = said
        atexit.register(self._at_exit)

    @property
    def exited(self) -> bool:
        return self._proc.poll() is not None

    def said(self) -> str:
        return "\n".join(list(self._said)[-8:])

    def _at_exit(self) -> None:
        # A script that ends without close() doesn't leave the node it started running.
        if not self.exited:
            self._proc.kill()

    def stop(self) -> None:
        atexit.unregister(self._at_exit)
        if not self.exited:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        if self._proc.stdout is not None:
            self._proc.stdout.close()


def _launch(program: Path, env: Mapping[str, str], output: str) -> Started:
    said: Deque[str] = deque(maxlen=20)
    if output == "inherit":
        proc = subprocess.Popen([str(program)], env=dict(env), stdin=subprocess.DEVNULL)
        return Started(proc, said)
    proc = subprocess.Popen([str(program)], env=dict(env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def keep() -> None:
        assert proc.stdout is not None
        for line in iter(proc.stdout.readline, b""):
            text = line.decode("utf-8", "replace").strip()
            if text:
                said.append(text)

    threading.Thread(target=keep, daemon=True).start()
    return Started(proc, said)


def _agent_token(program: Path, env: Mapping[str, str], deadline: float) -> str:
    """Runs ``unbrowse-node agent token`` until the node has made its first agent key, and answers its token."""
    while True:
        r = subprocess.run([str(program), "agent", "token"], env=dict(env), capture_output=True, text=True)
        token = r.stdout.strip()
        if r.returncode == 0 and token:
            return token
        # 3: no agent key yet; the node makes its first once its key is open.
        if r.returncode != 3 or time.monotonic() > deadline:
            raise error_for(f"couldn't get an agent token from the node: {r.stderr.strip() or f'unbrowse-node agent token exited {r.returncode}'}", 401, "unauthorized")
        time.sleep(0.5)


def bring(
    home: Union[str, Path, None] = None,
    port: Optional[int] = None,
    program: Union[str, Path, None] = None,
    token: Optional[str] = None,
    base_url: Optional[str] = None,
    ready_timeout: float = 60.0,
    env: Optional[Mapping[str, Optional[str]]] = None,
    output: str = "ignore",
) -> Tuple[str, Optional[str], Optional[Started]]:
    """Finds the node a client talks to, starting one when none answers: its address, a token for it, and the process
    to stop when this started it."""
    node_dir = Path(home) if home else node_home()
    p = port or node_port(node_dir)
    url = (base_url or (f"http://127.0.0.1:{p}" if home or port else os.environ.get("UNBROWSE_NODE") or f"http://127.0.0.1:{p}")).rstrip("/")
    deadline = time.monotonic() + ready_timeout
    found = node_program(program)
    node_env: Dict[str, str] = {**os.environ, "UNBROWSE_HOME": str(node_dir), **({"UNBROWSE_PORT": str(port)} if port else {})}
    for k, v in (env or {}).items():
        if v is None:
            node_env.pop(k, None)
        else:
            node_env[k] = v
    started: Optional[Started] = None
    if not _answers(url):
        if found is None:
            raise error_for(
                f"no node answers at {url}, and there's no unbrowse-node here to start: install Unbrowse (pip install unbrowse on a "
                "supported machine, or npm install -g unbrowse), or set UNBROWSE_BIN to the folder that holds unbrowse-node",
                0,
                "unreachable",
            )
        started = _launch(found, node_env, output)
        while not _answers(url):
            gone = started.exited
            if gone and _answers(url):
                break
            if gone or time.monotonic() > deadline:
                started.stop()
                why = started.said()
                raise error_for(f"the node at {found} didn't come up at {url}" + (f":\n{why}" if why else ""), 0, "unreachable")
            time.sleep(0.25)
        # Two starters: this one's node lost the port and exited, and what answers is the other's, not this one's to stop.
        if started.exited:
            started.stop()
            started = None
    # A token the caller named is the one used: ``token``, else UNBROWSE_AGENT_TOKEN. Only a node this process started
    # gives its own (its first key), and only when none was named: nothing else in the environment, a home included,
    # stands in for the caller's choice.
    tok: Optional[str] = token or os.environ.get("UNBROWSE_AGENT_TOKEN")
    if not tok and started is not None and found is not None:
        try:
            tok = _agent_token(found, node_env, deadline)
        except Exception:
            started.stop()
            raise
    if not tok:
        ran = "" if started is not None else f" A node was running at {url} already, and only a node this process starts gives its own key: name one (`unbrowse agent token` prints the node's first key)."
        raise error_for(f"no agent token: pass token= or set UNBROWSE_AGENT_TOKEN (Unbrowse app, Wallet, New agent key).{ran}", 401, "unauthorized")
    return url, tok, started


__all__ = ["bring", "node_program", "Started"]
