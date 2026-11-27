"""The TLS patch script runs with a Python that runs, not one that is only on the path by name: Windows puts a Store stub
called python3 there, which prints how to install Python and exits 9009 (Windows 11, 22 Nov 2026)."""
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "unbrowse-node" / "scripts" / "apply-tls-patch.sh"


def program(dir, name, body):
    path = pathlib.Path(dir) / name
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@unittest.skipIf(shutil.which("sh") is None, "needs a POSIX shell")
class TlsPatchPython(unittest.TestCase):
    def setUp(self):
        # The shell's own tools, and no python: a folder of links to them alone.
        self.tools = tempfile.TemporaryDirectory()
        for t in ("sh", "dirname"):
            os.symlink(shutil.which(t), pathlib.Path(self.tools.name) / t)

    def tearDown(self):
        self.tools.cleanup()

    def which(self, path):
        return subprocess.run(["sh", str(SCRIPT), "--which-python"], env={**os.environ, "PATH": path}, capture_output=True, text=True)

    def test_a_store_stub_named_python3_is_passed_over_for_a_python_that_runs(self):
        with tempfile.TemporaryDirectory() as stub, tempfile.TemporaryDirectory() as real:
            program(stub, "python3", 'echo "Python was not found; run without arguments to install from the Microsoft Store" >&2; exit 9009')
            program(real, "python", 'exec "%s" "$@"' % shutil.which("python3"))
            out = self.which(os.pathsep.join([stub, real, self.tools.name]))
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(out.stdout.strip(), str(pathlib.Path(real) / "python"))

    def test_no_python_that_runs_is_said_plainly(self):
        with tempfile.TemporaryDirectory() as stub:
            program(stub, "python3", "exit 9009")
            out = self.which(os.pathsep.join([stub, self.tools.name]))
            self.assertNotEqual(out.returncode, 0)
            self.assertIn("no Python 3.8 or later that runs", out.stderr)


if __name__ == "__main__":
    unittest.main()
