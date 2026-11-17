"""A wheel that carries the programs runs only where they were built, so it says so in its tag: the release names it
in UNBROWSE_WHEEL_TAG (`py3-none-macosx_11_0_arm64`, `py3-none-manylinux_2_35_x86_64`, `py3-none-win_amd64`, ...).
Without them the wheel is the client alone, for any Python 3."""

import os
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            return
        here = Path(self.root) / "src" / "unbrowse"
        programs = [here / "Unbrowse.app" / "Contents" / "MacOS", here / "bin"]
        if not any((d / n).exists() for d in programs for n in ("unbrowse-node", "unbrowse-node.exe")):
            return
        tag = os.environ.get("UNBROWSE_WHEEL_TAG")
        if not tag:
            raise RuntimeError("a wheel with the programs needs UNBROWSE_WHEEL_TAG: the machine they were built for")
        build_data["pure_python"] = False
        build_data["tag"] = tag
