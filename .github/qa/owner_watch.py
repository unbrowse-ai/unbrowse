"""Wait for a pending request in the scratch node's signed owner API."""

import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit


def wait_for_owner_ask():
    node = urlsplit(os.environ.get("UNBROWSE_NODE", ""))
    home = os.environ.get("UNBROWSE_HOME")
    if node.scheme != "http" or node.hostname != "127.0.0.1" or node.port is None or not home:
        return "no loopback scratch node to watch"

    kit = Path(__file__).resolve().parent
    # CI copies the SDK into the QA kit. A standalone checkout uses the same SDK from source.
    sdk = kit if (kit / "unbrowse/__init__.py").is_file() else kit.parents[1] / "unbrowse-sdk/python/src"
    if not (sdk / "unbrowse/__init__.py").is_file():
        return "the scratch owner SDK is missing"
    sys.path.insert(0, str(sdk))
    from unbrowse import UnbrowseError, UnbrowseOwner

    token_file = Path(home) / "owner.token"

    def token():
        value = token_file.read_text().strip()
        if not value:
            raise OSError("empty owner token")
        return value

    owner = UnbrowseOwner(token=token, base_url=f"http://127.0.0.1:{node.port}", timeout=2)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            if owner.hands().get("asks"):
                return None
        except OSError:
            return "the scratch node's owner token is missing"
        except UnbrowseError as error:
            if error.status:
                return f"the scratch node refused the owner ask watch (HTTP {error.status})"
        time.sleep(0.5)
    return "no owner ask became pending within 120 seconds"


if __name__ == "__main__":
    failure = wait_for_owner_ask()
    if failure:
        print(failure)
    sys.exit(bool(failure))
