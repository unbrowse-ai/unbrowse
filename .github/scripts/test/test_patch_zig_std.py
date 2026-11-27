"""patch_zig_std.py patches Zig 0.17's posixConnect so a connect a signal interrupted settles instead of aborting."""
import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("patch_zig_std", HERE.parent / "patch_zig_std.py")
patch_zig_std = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch_zig_std)
FIXTURE = (HERE / "fixtures" / "zig-0.17-posix-connect.zig").read_text()


class APatchedConnectSettles(unittest.TestCase):
    def test_an_interrupted_connect_reads_its_outcome_and_never_calls_already_connected_a_bug(self):
        patched = patch_zig_std.patch(FIXTURE)
        start, end = patch_zig_std.function_of(patched)
        body = patched[start:end]
        self.assertIn(patch_zig_std.MARK, body)
        self.assertIn("interrupted = true;", body)
        self.assertIn("posix.SO.ERROR", body)
        self.assertIn(".ALREADY, .ISCONN => |err| {", body)
        self.assertNotIn(".ISCONN => |err| return syscall.errnoBug(err),", body)
        # A connect no signal interrupted answers as before.
        self.assertIn("if (!interrupted) return if (err == .ISCONN) syscall.errnoBug(err) else syscall.fail(error.ConnectionPending);", body)
        # Nothing outside the function changes.
        self.assertEqual(patched[:start], FIXTURE[:start])
        self.assertTrue(patched.endswith("fn posixConnectUnix() void {}\n"))

    def test_a_patched_library_is_left_as_it_is(self):
        once = patch_zig_std.patch(FIXTURE)
        self.assertEqual(patch_zig_std.patch(once), once)

    def test_a_function_it_was_not_written_for_is_refused_by_name(self):
        changed = FIXTURE.replace(".ALREADY => return syscall.fail(error.ConnectionPending),", ".ALREADY => return error.Other,")
        with self.assertRaises(SystemExit) as refused:
            patch_zig_std.patch(changed)
        self.assertIn("posixConnect", str(refused.exception))

    def test_the_library_folder_is_patched_in_place_and_said(self):
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d) / "std" / "Io" / "Threaded.zig"
            target.parent.mkdir(parents=True)
            target.write_text(FIXTURE)
            self.assertEqual(patch_zig_std.main(["patch_zig_std.py", d]), 0)
            self.assertIn(patch_zig_std.MARK, target.read_text())
            self.assertEqual(patch_zig_std.main(["patch_zig_std.py", d]), 0)


if __name__ == "__main__":
    unittest.main()
