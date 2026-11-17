"""Where the node on this machine keeps what its owner reads: its directory, the owner's token and its port. The same
as the TypeScript package's ``unbrowse/local``."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, Union

from ._generated import DEFAULT_PORT


def node_home() -> Path:
    """The node's own directory: ``UNBROWSE_HOME``, else ``~/.unbrowse``."""
    return Path(os.environ.get("UNBROWSE_HOME") or Path.home() / ".unbrowse")


def owner_token(home: Union[str, Path, None] = None) -> Optional[str]:
    """The owner's token, read fresh: the node writes a new one (mode 0600) every time it starts, so a token read once
    goes stale on the next restart. None when the node has never run here."""
    try:
        return (Path(home or node_home()) / "owner.token").read_text().strip() or None
    except OSError:
        return None


def node_port(home: Union[str, Path, None] = None) -> int:
    """The node's port: ``UNBROWSE_PORT``, else ``api_port`` in its settings, else ``DEFAULT_PORT``."""
    named = os.environ.get("UNBROWSE_PORT", "")
    if named.isdigit() and 0 < int(named) < 65536:
        return int(named)
    try:
        port = json.loads((Path(home or node_home()) / "settings.json").read_text()).get("api_port")
    except (OSError, ValueError, AttributeError):
        return DEFAULT_PORT
    return port if isinstance(port, int) and not isinstance(port, bool) and port > 0 else DEFAULT_PORT


def node_address(home: Union[str, Path, None] = None) -> str:
    """The node's address on this machine: ``UNBROWSE_NODE``, else 127.0.0.1 on its port."""
    return os.environ.get("UNBROWSE_NODE") or f"http://127.0.0.1:{node_port(home)}"
