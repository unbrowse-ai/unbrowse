#!/usr/bin/env python3
"""
contree-runner — spawn a Nebius contree microVM that registers as a GitHub
Actions self-hosted runner with label `contree`, runs ONE job in --ephemeral
mode, then exits. Designed to be invoked when a `runs-on: contree` job is
already queued (e.g. right after `gh workflow run`).

Env:
  NEBIUS_CONTREE_TOKEN  Nebius IAM static key (required)
  GH_TOKEN              GitHub token with repo:read (required, for registration-token)
  REPO                  Full repo slug (default: unbrowse-ai/unbrowse-dev)
  LABEL                 Runner label to register with (default: contree)
  TIMEOUT               microVM max runtime seconds (default: 3600)
"""
import json
import os
import sys
import time
import urllib.request

from contree_sdk import ContreeSync

REPO = os.environ.get("REPO", "unbrowse-ai/unbrowse-dev")
LABEL = os.environ.get("LABEL", "contree")
TIMEOUT = int(os.environ.get("TIMEOUT", "3600"))
RUNNER_VERSION = "2.335.1"
RUNNER_TGZ = f"https://github.com/actions/runner/releases/download/v{RUNNER_VERSION}/actions-runner-linux-x64-{RUNNER_VERSION}.tar.gz"


def get_registration_token():
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/runners/registration-token",
        method="POST",
        headers={
            "Authorization": f"token {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["token"]


def main():
    for var in ("NEBIUS_CONTREE_TOKEN", "GH_TOKEN"):
        if not os.environ.get(var):
            print(f"::error::missing env {var}", file=sys.stderr)
            return 2

    print(f"[1/4] fetch GH runner registration token for {REPO}...")
    reg_token = get_registration_token()
    print(f"      token acquired (len={len(reg_token)})")

    print("[2/4] contree client init...")
    client = ContreeSync(token=os.environ["NEBIUS_CONTREE_TOKEN"])
    info = client.get_token_info()
    running = info.limits.get("operations_stat", {}).get("running_instances", "?") if hasattr(info, "limits") else "?"
    print(f"      client ok; concurrent capacity available")

    print("[3/4] spawn microVM, install runner, register, run --ephemeral...")
    image = client.images.use("python:3.12-slim")
    boot_script = f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl tar gzip jq git python3 python3-pip sudo > /dev/null
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
cd /home/runner
curl -sL {RUNNER_TGZ} | tar xz
chown -R runner:runner /home/runner
./bin/installdependencies.sh
sudo -u runner ./config.sh \\
    --url https://github.com/{REPO} \\
    --token {reg_token} \\
    --labels {LABEL} \\
    --ephemeral \\
    --unattended \\
    --name contree-$(hostname)
sudo -u runner ./run.sh
"""
    op = image.run(shell=boot_script, disposable=True, timeout=TIMEOUT)
    print(f"      microVM spawned; runner registering; will block until job completes or timeout")
    final = op.wait()

    print("[4/4] result:")
    print(f"      exit_code: {final.exit_code}")
    stdout = final.stdout
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")
    stderr = final.stderr
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    if stdout:
        print("--- stdout (tail) ---")
        print("\n".join(stdout.splitlines()[-40:]))
    if stderr:
        print("--- stderr (tail) ---")
        print("\n".join(stderr.splitlines()[-20:]))
    return final.exit_code or 0


if __name__ == "__main__":
    sys.exit(main())
