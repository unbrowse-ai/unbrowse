"""The signing keys sit in jobs of their own (release-check.yml runs this; external security review round 3,
2026-11-04).

- release.yml has no trigger a pull request can fire.
- Every job, in any workflow, that names a signing key runs in the `release` environment, except the targets quorum
  co-signer which runs in `targets-cosign`; signing jobs install nothing and build nothing (no action
  but checkout and the artifact actions; no `npm install`/`npm ci`/`pip install`/`setup-*`, no `cargo build`/`zig build`;
  no script but the signing scripts), and only release.yml and updates.yml have such jobs.
- A secret is named however it is written: GitHub reads `secrets.unbrowse_release_key` as `UNBROWSE_RELEASE_KEY`, so
  names are compared case-folded. The Mac signing and notary secrets are signing keys too.
- In release.yml and updates.yml, every secret a job reads makes it a signing job: a secret added there under a new
  name is held to the same rules without this list growing.

    python3 .github/scripts/test/check_signing_jobs.py [workflows folder]
"""

import pathlib
import re
import sys

import yaml

KEYS = ("UNBROWSE_RELEASE_KEY", "UNBROWSE_TARGETS_KEY", "UNBROWSE_TARGETS_KEY_2", "UNBROWSE_TIMESTAMP_KEY")
# The Developer ID certificate and the notary login: they sign and notarize what Macs run.
MAC_KEYS = ("MACOS_CERTIFICATE", "MACOS_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD")
SIGNING = frozenset(KEYS + MAC_KEYS)
# `secrets.NAME`, in any case: GitHub's secret names are case-insensitive.
SECRET_REF = re.compile(r"\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
# Building runs the build's dependencies' code (build scripts, macros, plugins): never beside a key.
BUILDS = re.compile(r"\b(cargo\s+(build|run|test|check|clippy)|zig\s+build|(npm|bun|pnpm|yarn)\s+run|go\s+(build|run|generate)|xcodebuild|swift\s+build|gradle|mvn)\b")
ALLOWED_ACTIONS = ("actions/checkout@", "actions/download-artifact@", "actions/upload-artifact@")
INSTALLS = re.compile(r"\b(npm\s+(install|ci|i|exec)\b|npx\b|bunx\b|bun\s+(install|x)\b|pnpm\s+(install|dlx)\b|yarn(\s+install)?\b|pip3?\s+install|pipx\b|uvx?\b|python3?\s+-m\s+pip|cargo\s+install|apt(-get)?\s+install|brew\s+install|make\b|curl\b|wget\b)")
SIGNERS = {"release.yml", "updates.yml"}
# A signing job runs the signing scripts, which use Node's built-in crypto and the system's tar, and nothing else from
# the repository: a packing script runs package managers.
# The interpreter is a word of its own: `unbrowse-node <path>` names a file, not `node` running one.
SCRIPTS = re.compile(r"(?<![\w./-])(sh|bash|zsh|python3?|node)\s+(?:-I\s+)?(\S+)")
# A program run by its path (`./x`, `scripts/x.sh`) is a script too: a path where a command starts (a line's start, after
# `;`, `&`, `|`, `(`, `then`, `do` or `exec`), not one handed to a command as an argument.
RUN_BY_PATH = re.compile(r"(?:^|[;&|(]|\b(?:then|do|exec)\b)[ \t]*(\.{0,2}/?[\w.-]+/[\w./-]+)", re.MULTILINE)
# Ways to hand a job every secret without naming one: no job, in any workflow, may use them.
ALL_SECRETS = re.compile(r"toJSON\(\s*secrets\s*\)|secrets\s*\[|secrets:\s*inherit")
SIGNING_SCRIPTS = (
    ".github/scripts/sign-manifest.mjs",
    ".github/scripts/sign-artifact-manifest.mjs",
    ".github/scripts/updates.mjs",
    ".github/scripts/verify-artifact-manifest.mjs",
    ".github/scripts/artifact-hashes.py",
    # Seals the Mac app with codesign, hdiutil and ditto: the system's tools only.
    ".github/scripts/package-macos.sh",
    # `python3 - <<'PY'`: code written in the workflow itself.
    "-",
)


def secrets_in(text: str) -> set[str]:
    """The secrets `text` reads, by their case-folded names (the token GitHub gives every job is not one)."""
    return {name.upper() for name in SECRET_REF.findall(text)} - {"GITHUB_TOKEN"}


def signing_secrets(text: str, workflow: str) -> set[str]:
    """The secrets in `text` held to the signing rules: the signing keys anywhere, and any secret in a signing workflow."""
    names = secrets_in(text)
    return names if workflow in SIGNERS else names & SIGNING


def names_a_key(text: str) -> bool:
    upper = text.upper()
    return any(k in upper for k in SIGNING)


def problems(folder: pathlib.Path) -> list[str]:
    bad = []
    release = yaml.safe_load((folder / "release.yml").read_text())
    on = release.get(True, release.get("on"))
    if any(t in ("pull_request", "pull_request_target") for t in on):
        bad.append("release.yml runs for a pull request: it holds the signing keys")
    for wf in sorted([*folder.glob("*.yml"), *folder.glob("*.yaml")]):
        raw = wf.read_text()
        if ALL_SECRETS.search(raw):
            bad.append(f"{wf.name} hands a job every secret ({ALL_SECRETS.search(raw).group(0)}): a signing key goes only where it is named")
        doc = yaml.safe_load(raw) or {}
        # A key in the workflow's own env reaches every job of it.
        workflow_env = yaml.safe_dump(doc.get("env") or {})
        if signing_secrets(workflow_env, wf.name) or names_a_key(workflow_env):
            bad.append(f"{wf.name} names a signing key in the workflow's env, which every job reads")
        for name, job in (doc.get("jobs") or {}).items():
            text = yaml.safe_dump(job)
            held = signing_secrets(text, wf.name)
            if not held and not names_a_key(text):
                continue
            where = f"{wf.name}: job {name}"
            if job.get("uses"):
                bad.append(f"{where} hands a signing key to another workflow ({job['uses']})")
            job_env = yaml.safe_dump(job.get("env") or {})
            if signing_secrets(job_env, wf.name) or names_a_key(job_env):
                bad.append(f"{where} names a signing key in the job's env, which every step reads: name it on the signing step")
            if wf.name not in SIGNERS:
                bad.append(f"{where} names a signing key: only the release and update metadata jobs may")
            contains_cosign_key = "UNBROWSE_TARGETS_KEY_2" in held
            expected_environment = "targets-cosign" if contains_cosign_key else "release"
            if job.get("environment") != expected_environment:
                bad.append(f"{where} reads a signing key outside the {expected_environment} environment")
            if contains_cosign_key and held & {"UNBROWSE_RELEASE_KEY", "UNBROWSE_TARGETS_KEY", *MAC_KEYS}:
                bad.append(f"{where} exposes a key 1, the release key or a Mac key in the co-signing environment")
            for step in job.get("steps", []):
                uses = step.get("uses")
                if uses and not uses.startswith(ALLOWED_ACTIONS):
                    bad.append(f"{where} uses {uses} beside a signing key")
                run = step.get("run", "")
                if run and INSTALLS.search(run):
                    bad.append(f"{where} installs something beside a signing key: {INSTALLS.search(run).group(0)}")
                if run and BUILDS.search(run):
                    bad.append(f"{where} builds beside a signing key: {BUILDS.search(run).group(0)}")
                for _, script in SCRIPTS.findall(run or ""):
                    if script not in SIGNING_SCRIPTS:
                        bad.append(f"{where} runs {script} beside a signing key")
                for script in RUN_BY_PATH.findall(run or ""):
                    if script not in SIGNING_SCRIPTS and not script.startswith(("dist/", "updates/", "built/", "$")) and not re.search(r"\.(tgz|json|sig|rs)$", script):
                        bad.append(f"{where} runs {script} beside a signing key")
    return bad


if __name__ == "__main__":
    folder = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows")
    found = problems(folder)
    for p in found:
        print(p, file=sys.stderr)
    if found:
        sys.exit(1)
    print("SIGNING_KEYS_IN_JOBS_OF_THEIR_OWN")
