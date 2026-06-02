#!/usr/bin/env python3
"""check-python-publishable.py — the publish-readiness gate for the Python adapters.

For every package in scripts/python-adapter-manifest.tsv: parse its pyproject
metadata, build a REAL wheel via the PEP-517 setuptools backend (no pip frontend,
no network, no build isolation), and assert the wheel actually ships the module
(`<pkg>/__init__.py`) plus dist-info METADATA, and is not bloated. Exits 0 only when
every Python package is publish-ready. Sibling of scripts/check-dropins-publishable.sh
for the JS packages; same no-fabricated-green discipline (a real wheel is built).
"""
import os
import shutil
import sys
import tempfile
import tomllib
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "scripts", "python-adapter-manifest.tsv")
MAX_KB = 256  # a pure-python adapter wheel over this is bloated / mispackaged


def rows():
    with open(MANIFEST) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 3:
                yield parts[0], parts[1], parts[2]  # upstream, pkg, pkg_dir


def build_wheel(pkg_dir, out_dir):
    """Build a wheel for pkg_dir into out_dir via setuptools' PEP-517 backend."""
    import setuptools.build_meta as backend
    cwd = os.getcwd()
    # silence the verbose build chatter
    devnull = open(os.devnull, "w")
    old_out, old_err = sys.stdout, sys.stderr
    try:
        os.chdir(pkg_dir)
        sys.stdout = sys.stderr = devnull
        name = backend.build_wheel(out_dir)
    finally:
        sys.stdout, sys.stderr = old_out, old_err
        devnull.close()
        os.chdir(cwd)
        # clean the build artifacts setuptools drops in the package dir
        for junk in ("build",):
            p = os.path.join(pkg_dir, junk)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
        for f in os.listdir(pkg_dir):
            if f.endswith(".egg-info"):
                shutil.rmtree(os.path.join(pkg_dir, f), ignore_errors=True)
        sp = os.path.join(pkg_dir, "src")
        if os.path.isdir(sp):
            for f in os.listdir(sp):
                if f.endswith(".egg-info"):
                    shutil.rmtree(os.path.join(sp, f), ignore_errors=True)
    return os.path.join(out_dir, name)


def main():
    fail = 0
    total = 0
    print(f'{"UPSTREAM":<14} {"PACKAGE":<24} {"META":<6} {"WHEEL":<7} {"MODULE":<8} SIZE')
    print("-" * 72)
    for upstream, pkg, pkg_dir in rows():
        total += 1
        abs_dir = os.path.join(ROOT, pkg_dir)
        meta = whl = mod = "FAIL"
        size = "-"
        # 1. metadata
        name = None
        try:
            with open(os.path.join(abs_dir, "pyproject.toml"), "rb") as f:
                py = tomllib.load(f)
            name = py["project"]["name"]
            assert py["project"]["version"] and py["build-system"]["build-backend"]
            assert name == pkg, f"name {name} != {pkg}"
            meta = "ok"
        except Exception as e:
            print(f"{upstream:<14} {pkg:<24} META-FAIL: {e}")
            fail += 1
            continue
        # 2. real wheel + 3. module present
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wheel = build_wheel(abs_dir, tmp)
                whl = "ok"
                kb = round(os.path.getsize(wheel) / 1024, 1)
                size = f"{kb}KB"
                with zipfile.ZipFile(wheel) as z:
                    names = z.namelist()
                module = name.replace("-", "_")
                has_init = any(n.endswith("__init__.py") and n.startswith(module + "/") for n in names)
                has_meta = any(n.endswith("dist-info/METADATA") for n in names)
                mod = "ok" if (has_init and has_meta) else "NO-MODULE"
                if not has_init or not has_meta:
                    fail += 1
                if kb > MAX_KB:
                    size = f"{kb}KB!BLOAT"
                    fail += 1
        except Exception as e:
            print(f"{upstream:<14} {pkg:<24} WHEEL-FAIL: {e}")
            fail += 1
            continue
        row_ok = meta == "ok" and whl == "ok" and mod == "ok" and "!BLOAT" not in size
        if not row_ok:
            fail += 1
        print(f"{upstream:<14} {pkg:<24} {meta:<6} {whl:<7} {mod:<8} {size}")
    print("-" * 72)
    green = total - (1 if fail else 0) if fail else total
    print(f"python publishable: {total - fail if fail <= total else 0}/{total} packages produced a clean wheel")
    if fail:
        print("NOT publish-ready — fix the rows above.")
        sys.exit(1)
    print(f"ALL {total} Python adapters build a clean wheel that ships the module. Publish path: scripts/publish-python.sh")
    sys.exit(0)


if __name__ == "__main__":
    main()
