"""`unbrowse`: the one command the package installs. It opens the window and runs the node and its programs, which a
release wheel carries: on a Mac as `unbrowse/Unbrowse.app`, the window with the node and `unb` beside it in
Contents/MacOS; elsewhere the same programs in `unbrowse/bin`. They are kept together because each looks for the next
beside itself. The browser is an add-on the node fetches when a goal first needs it, or `unbrowse browser install`
fetches now: no install downloads it.

  unbrowse app                    open the window (it starts the node when none is running)
  unbrowse start                  run the node without the window
  unbrowse agent|vault|wallet|share|sign-in|max-fetch|coin|bounty ...  the node's own commands
  unbrowse browser install|status|remove|fetch on|off  the browser add-on: get it, see it, take it away, or let the node fetch it
  unbrowse update [channel ...] | unbrowse restart  check for a newer release now, or restart the running node
  unbrowse skill [dir]            put the agent skill in dir (default ~/.claude/skills/unbrowse); anything there that
                                  isn't a copy we wrote, unchanged, is moved aside first, never deleted
  unbrowse where                  where the programs are
  unbrowse <anything else>        unb: do, browse, search, call, logins, whoami, connect
"""

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from unbrowse._old_skills import OLD_SKILL_FILES

HERE = Path(__file__).resolve().parent
PROGRAMS = ("unbrowse-node", "unb", "agent-browser")
NODE_COMMANDS = {
    "agent", "browser", "chain", "bounty", "coin", "domain", "earnings", "max-fetch", "money", "network", "nodes", "passkey", "reports", "restart", "session", "share", "sign-in", "telemetry", "terms", "update",
    "vault", "wallet",
}
WINDOWS = sys.platform == "win32"

USAGE = """usage: unbrowse app | unbrowse start | unbrowse do <goal> [--url <page>] | unbrowse browse <command...> | unbrowse search [words]
       unbrowse call <id> [name=value ...] | unbrowse logins | unbrowse whoami | unbrowse connect
       unbrowse agent new | unbrowse vault ... | unbrowse session ... | unbrowse passkey ... | unbrowse wallet ... | unbrowse max-fetch [usdc] | unbrowse coin ... | unbrowse bounty post|confirm|settle|release|refund|list|show|auto ... | unbrowse nodes [grant]
       unbrowse share used|all|off|status | unbrowse share route <id> on|off | unbrowse sign-in [--wallet <address>]
       unbrowse browser [status] | unbrowse browser install [--from <path>] | unbrowse browser remove [--chromium] | unbrowse browser fetch on|off
       unbrowse skill [dir] | unbrowse where
The node runs without a browser: search, call and whoami need none. Learning a page or browsing one needs it, and the
node fetches it then (unless `unbrowse browser fetch off`), or `unbrowse browser install` gets it now."""


def exe(program: str) -> str:
    """A program's file name here: Windows' end in .exe."""
    return program + ".exe" if WINDOWS else program


def app_version(app: Path) -> list:
    """An app's version from its Info.plist (`CFBundleShortVersionString`), as numbers; empty when it has none."""
    try:
        m = re.search(r"<key>CFBundleShortVersionString</key>\s*<string>([^<]*)</string>",
                      (app / "Contents" / "Info.plist").read_text())
    except OSError:
        return []
    return [int(x) for x in re.findall(r"\d+", m.group(1))[:3]] if m else []


def newest_app(places: list) -> Optional[Path]:
    """Of the apps that exist, the newest by version; the earlier one on a tie. An app this package carries can be
    older than one the owner installed or updated in Applications, and running the older one's programs against the
    newer running node fails (its node tries to start a second node on the same port)."""
    def key(v: list) -> list:
        return v + [0] * (3 - len(v))
    best = None
    for a in places:
        if (a / "Contents" / "MacOS" / "unbrowse-window").exists():
            if best is None or key(app_version(a)) > key(app_version(best)):
                best = a
    return best


def team_of(app: Path) -> Optional[str]:
    """The Team ID `app` is signed by, once its whole signature checks (`codesign --verify --deep --strict`): `None`
    for an app unsigned, signed ad hoc, or whose signature doesn't check, and off a Mac. The system's own codesign."""
    if sys.platform != "darwin":
        return None
    try:
        if subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            return None
        said = subprocess.run(["/usr/bin/codesign", "-dv", str(app)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, text=True, errors="replace").stderr
    except OSError:
        return None
    m = re.search(r"^TeamIdentifier=(\S+)$", said, re.M)
    return m.group(1) if m and m.group(1) != "not" else None


def pinned_team(file: Optional[Path] = None) -> Optional[str]:
    """The Apple Team ID the release signed the Mac app with, as this package says: its `app-team` file, written when
    the release packs it from the signing job's own identity (pack-sdks.sh). `None` for a package with none (a build of
    one's own, or a release signed ad hoc) or with a value that isn't a Team ID."""
    try:
        team = (file or HERE / "app-team").read_text().strip()
    except (OSError, ValueError):
        return None
    return team if re.fullmatch(r"[A-Z0-9]{10}", team) else None


def trusted_app(own: Optional[Path], installed: list, pinned: Optional[str], team=team_of) -> Optional[Path]:
    """The app to run, of the one this package carries (`own`: trusted as the package is) and those installed
    elsewhere: the newest of `own` and each installed one whose signature checks and is the vendor's team. The
    vendor's team is the one this package pins, else `own`'s. One that isn't (unsigned, another team's, a signature
    that doesn't check) never runs in its place, whatever version it says: a folder like ~/Applications is any of this
    user's programs' to write, and any developer can sign an app called Unbrowse. With neither a pinned team nor a
    signed app in the package there is no team to hold them to, and none found elsewhere runs."""
    vendor = pinned or (team(own) if own is not None else None)
    signed = [] if vendor is None or newest_app(installed) is None else [a for a in installed if team(a) == vendor]
    return newest_app(([own] if own is not None else []) + signed)


def named_app(named: Path, own: Optional[Path], pinned: Optional[str], team=team_of) -> Optional[Path]:
    """The app `UNBROWSE_APP` names, held to the same rule as one installed elsewhere: it runs when it is the
    package's own app, or its signature checks and names the vendor's team. An environment variable is inherited by
    everything started from the shell that set it, so naming an app is not vouching for it."""
    app = newest_app([named])
    if app is None:
        return None
    if own is not None and app.resolve() == own.resolve():
        return app
    vendor = pinned or (team(own) if own is not None else None)
    return app if vendor is not None and team(app) == vendor else None


# The variable that runs an app with its signature unchecked: a build of one's own, which no team signed. Its value
# must be the app's absolute path, nothing else, and every run says on stderr that signature checks are off, so it
# can't be on without the owner seeing it.
UNCHECKED_APP = "UNBROWSE_UNCHECKED_APP"


def unchecked_app(env=None) -> Tuple[Optional[Path], str]:
    """The app `UNBROWSE_UNCHECKED_APP` names, run with no signature check, and what to say about it on every run; or,
    when the value isn't an app's absolute path, no app and why it was ignored. `(None, "")` when it isn't set."""
    named = (os.environ if env is None else env).get(UNCHECKED_APP)
    if not named:
        return None, ""
    app = newest_app([Path(named)]) if os.path.isabs(named) else None
    if app is None:
        return None, f'unbrowse: {UNCHECKED_APP} is set to "{named}", which isn\'t the absolute path of an Unbrowse app; ignoring it.'
    return app, (
        f"unbrowse: WARNING: signature checks are OFF. Running {app} because {UNCHECKED_APP} names it: nothing checked "
        f"who built or signed it. Unset {UNCHECKED_APP} unless you put it there for a build of your own."
    )


def installed_apps() -> list:
    """The places an installed Unbrowse app is looked for, beside this package's own."""
    return [Path("/Applications/Unbrowse.app"), Path.home() / "Applications" / "Unbrowse.app"]


def app_bundle() -> Optional[Path]:
    """The Unbrowse app, on a Mac: the one `UNBROWSE_UNCHECKED_APP` names, unchecked and said so; else the one
    `UNBROWSE_APP` names when it holds to the vendor's team (`named_app`), and none if it doesn't; else the one this
    package carries, or a newer one installed in Applications signed by the vendor's team (`trusted_app`). `None` when
    there is none."""
    unchecked = unchecked_app()[0]
    if unchecked is not None:
        return unchecked
    env = os.environ.get("UNBROWSE_APP")
    if not env and sys.platform != "darwin":
        return None
    own = newest_app([HERE / "Unbrowse.app"])
    if env:
        return named_app(Path(env), own, pinned_team())
    return trusted_app(own, installed_apps(), pinned_team())


def passed_over() -> str:
    """Why an app that is there wasn't run, when none is: this package names no team to hold it to, or it isn't that
    team's. Empty otherwise."""
    if app_bundle() is not None:
        return ""
    env = os.environ.get("UNBROWSE_APP")
    if not env and sys.platform != "darwin":
        return ""
    found = newest_app([Path(env)]) if env else newest_app(installed_apps())
    if found is None:
        return ""
    why = ("this package names no signing team to check it against" if pinned_team() is None
           else "it isn't signed by the team this package names")
    return (
        f" {found} is there, but {why}, so it isn't run. For a build of your own that no team signed, "
        f"{UNCHECKED_APP}=<its absolute path> runs it with signature checks off, and says so on every run."
    )


def bin_dir() -> Optional[Path]:
    """Where the programs are: `UNBROWSE_BIN`, else inside the Unbrowse app (this package's, else an installed one),
    else this package's `bin`. `None` when none has them, and the programs are then looked up on PATH."""
    env = os.environ.get("UNBROWSE_BIN")
    if env:
        return Path(env)
    app = app_bundle()
    dirs = [app / "Contents" / "MacOS"] if app else []
    return next((d for d in [*dirs, HERE / "bin"] if (d / exe("unbrowse-node")).exists()), None)


def missing(what: str) -> str:
    """What to say when the programs aren't here."""
    return (
        f"{what} comes in the wheel for this machine, and this one is the client alone. Install unbrowse on a "
        "supported machine (macOS, Linux or Windows as released), or set UNBROWSE_BIN."
    )


def skill_dir() -> Optional[Path]:
    """The skill the package carries, else the one in the repository this runs from."""
    repo = [HERE.parents[3] / "skills" / "unbrowse"] if len(HERE.parents) > 3 else []
    for d in [HERE / "skill", *repo]:
        if (d / "SKILL.md").exists():
            return d
    return None


def route(args: List[str]) -> Tuple[str, List[str]]:
    """Which program a command goes to, and with what."""
    if args and args[0] == "start":
        return "unbrowse-node", args[1:]
    if args and args[0] in NODE_COMMANDS:
        return "unbrowse-node", args
    return "unb", args


# What an install leaves beside the skill it wrote: each file's SHA-256, so a later install can tell its copy is untouched.
# The same record the npm package's install leaves (unbrowse-sdk/typescript/src/cli.ts).
WRITTEN = ".unbrowse-installed.json"


def _hashes(d: Path) -> Dict[str, str]:
    """Every file under `d` but `WRITTEN`, by its path there (with `/`), with its SHA-256."""
    out = {}
    for f in sorted(d.rglob("*")):
        if f.is_file() and f != d / WRITTEN:
            out[f.relative_to(d).as_posix()] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def only_ours_at(to: Path) -> bool:
    """Whether `to` holds nothing, or exactly the skill an install wrote there: a real folder with that install's record,
    every file it wrote unchanged and none added."""
    if not os.path.lexists(to):
        return True
    try:
        if to.is_symlink() or not to.is_dir():
            return False
        return json.loads((to / WRITTEN).read_text()) == _hashes(to)
    except (OSError, ValueError):
        return False


def old_copy_at(to: Path) -> bool:
    """Whether `to` is a real folder holding an older Unbrowse's skill as it was published: SKILL.md and only files whose
    SHA-256 is one of a published copy's. The 12.x client and `npx skills add` left no record, so this is how an install
    knows that copy was ours and isn't the owner's edit (R-I3)."""
    try:
        if to.is_symlink() or not to.is_dir():
            return False
        now = _hashes(to)
    except OSError:
        return False
    return "SKILL.md" in now and all(h in OLD_SKILL_FILES.get(n, ()) for n, h in now.items())


def kept_dir(to: Path) -> Path:
    """Where a skill folder that isn't ours is kept: `unbrowse-kept` beside the skills folder (`~/.claude/unbrowse-kept`
    for `~/.claude/skills/unbrowse`), not in it, so the agent doesn't load the old copy as a second skill."""
    return to.parent.parent / "unbrowse-kept"


def _move_aside(to: Path) -> Path:
    """Moves what is at `to` to `kept_dir(to)/<name>.before-unbrowse-<local time>` (`-<n>` added if that is taken). A
    link is kept as a link to the same place, its target made absolute so the move can't break it."""
    stamp = time.strftime("%Y%m%d%H%M%S")
    where = kept_dir(to)
    where.mkdir(parents=True, exist_ok=True)
    kept = where / f"{to.name}.before-unbrowse-{stamp}"
    n = 0
    while os.path.lexists(kept):
        n += 1
        kept = where / f"{to.name}.before-unbrowse-{stamp}-{n}"
    if to.is_symlink():
        os.symlink(os.path.join(os.path.dirname(to), os.readlink(to)), kept)
        os.unlink(to)
    else:
        os.rename(to, kept)
    return kept


def install_skill(to: Optional[str] = None) -> Tuple[Path, Optional[Path]]:
    """Puts the skill in `to` and leaves the record of what it wrote. A copy we wrote there that nobody changed since (an
    install's, by its record, or an older Unbrowse's, by its published hashes) is replaced whole, so no file an earlier
    skill left reads as part of this one. Anything else (instructions the owner edited, their own skill of this name, a
    link to their copy) is theirs: it is moved aside first, never deleted, and the second value says where."""
    source = skill_dir()
    if source is None:
        raise SystemExit("unbrowse: this package carries no skill")
    dest = Path(to).absolute() if to else Path.home() / ".claude" / "skills" / "unbrowse"
    kept = None if only_ours_at(dest) or old_copy_at(dest) else _move_aside(dest)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(source, dest)
    (dest / WRITTEN).write_text(json.dumps(_hashes(dest), indent=2))
    return dest, kept


def make_runnable(d: Path, programs) -> None:
    """A wheel may be unpacked without the programs' mode."""
    for p in programs:
        f = d / exe(p)
        try:
            if f.exists() and not os.access(f, os.X_OK):
                f.chmod(f.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        except OSError:
            pass


def open_app() -> int:
    """Opens the window, which starts the node itself when none is running."""
    app = app_bundle()
    if app is not None:
        make_runnable(app / "Contents" / "MacOS", (*PROGRAMS, "unbrowse-window"))
        try:
            return subprocess.call(["open", str(app)])
        except OSError as e:
            print(f"unbrowse: can't open {app} ({e.strerror})", file=sys.stderr)
            return 1
    d = bin_dir()
    window = d / exe("unbrowse-window") if d else None
    if window is None or not window.exists():
        print(f"unbrowse: there's no Unbrowse app here.{passed_over()} {missing('The window')}", file=sys.stderr)
        return 1
    make_runnable(d, (*PROGRAMS, "unbrowse-window"))
    # On its own: the window outlives this command, as an app opened from a launcher would.
    flags = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {"start_new_session": True}
    try:
        subprocess.Popen([str(window)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
    except OSError as e:
        print(f"unbrowse: can't open {window} ({e.strerror})", file=sys.stderr)
        return 1
    return 0


def run(program: str, args: List[str]) -> int:
    d = bin_dir()
    path = str(d / exe(program)) if d else (shutil.which(program) or program)
    if d:
        make_runnable(d, PROGRAMS)
    try:
        # Windows has no exec: the program runs as a child, and its exit code is this one's.
        if WINDOWS:
            return subprocess.call([path, *args])
        os.execv(path, [path, *args])
    except OSError as e:
        print(f"unbrowse: can't run {program} ({e.strerror}).{passed_over()} {missing(program)}", file=sys.stderr)
        return 127
    return 0  # not reached: execv replaced this process


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    unchecked = unchecked_app()[1]
    if unchecked:
        print(unchecked, file=sys.stderr)
    if not args or args[0] in ("help", "--help", "-h"):
        print(USAGE)
        return 0
    if args[0] == "where":
        d = bin_dir()
        print(d if d else "on PATH")
        return 0
    if args[0] == "app":
        return open_app()
    if args[0] == "skill":
        dest, kept = install_skill(args[1] if len(args) > 1 else None)
        print((f"kept what was at {dest} as {kept}, as it was; " if kept else "") + f"the unbrowse skill is in {dest}")
        return 0
    program, rest = route(args)
    return run(program, rest)


if __name__ == "__main__":
    sys.exit(main())
