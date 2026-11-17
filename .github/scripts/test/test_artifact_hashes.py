import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / "artifact-hashes.py"
spec = importlib.util.spec_from_file_location("artifact_hashes", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishedArtifactsTest(unittest.TestCase):
    def test_published_sdk_bytes_match_build_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            built = root / "built"
            published = root / "published"
            built.mkdir()
            published.mkdir()
            files = {
                "unbrowse-13.20.0.tgz": b"top-level npm package",
                "unbrowse-linux-x64-13.20.0.tgz": b"platform package",
                "unbrowse-13.20.0-py3-none-any.whl": b"portable wheel",
            }
            for name, contents in files.items():
                (built / name).write_bytes(contents)
                (published / name).write_bytes(contents)
            expected = module.artifact_hashes(built)
            module.verify(published, __import__("json").dumps(expected))
            (published / "unbrowse-linux-x64-13.20.0.tgz").write_bytes(b"changed after the build")
            with self.assertRaisesRegex(ValueError, "changed"):
                module.verify(published, __import__("json").dumps(expected))

    def test_platform_build_hashes_match_after_sdk_packaging(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            build = root / "platform-build"
            packages = root / "sdk-packages"
            build.mkdir()
            packages.mkdir()
            platform_name = "unbrowse-linux-x64-13.20.0.tgz"
            (build / platform_name).write_bytes(b"platform package from build job")
            (packages / platform_name).write_bytes(b"platform package from build job")
            (packages / "unbrowse-13.20.0.tgz").write_bytes(b"sdk package")
            module.verify(packages, __import__("json").dumps(module.artifact_hashes(build)), allow_extra=True)
            (packages / platform_name).write_bytes(b"repacked platform package")
            with self.assertRaisesRegex(ValueError, "changed"):
                module.verify(packages, __import__("json").dumps(module.artifact_hashes(build)), allow_extra=True)

    def test_untrusted_build_tools_cannot_change_signed_targets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            built = root / "signed-build"
            built.mkdir()
            package = built / "unbrowse-linux-x64-13.20.0.tgz"
            package.write_bytes(b"package whose integrity is named by signed targets")
            expected = module.artifact_hashes(built)
            package.write_bytes(b"modified by an untrusted packaging tool")
            with self.assertRaisesRegex(ValueError, "changed"):
                module.verify(built, __import__("json").dumps(expected))

    def test_published_artifact_set_must_match_build_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            root.mkdir(exist_ok=True)
            (root / "unbrowse-13.20.0.tgz").write_bytes(b"built")
            expected = module.artifact_hashes(root)
            (root / "unbrowse-extra-13.20.0.whl").write_bytes(b"unlisted")
            with self.assertRaisesRegex(ValueError, "extra"):
                module.verify(root, __import__("json").dumps(expected))

    def test_every_file_a_release_publishes_is_one_a_job_recorded(self):
        # The GitHub release publishes disk images, archives, browser programs and the sdist beside the packages. Each
        # must be byte for byte what the job that made it recorded, and nothing unrecorded may ride along.
        import json

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            programs, sdks, published = root / "programs", root / "sdks", root / "published"
            for folder in (programs, sdks, published):
                folder.mkdir()
            made = {
                programs: {"Unbrowse-13.20.0-macos-arm64.dmg": b"signed disk image", "agent-browser-linux-x64": b"browser"},
                sdks: {"unbrowse-13.20.0.tgz": b"npm package", "unbrowse-13.20.0.tar.gz": b"sdist", "manifest.json": b"{}"},
            }
            for folder, files in made.items():
                for name, contents in files.items():
                    (folder / name).write_bytes(contents)
                    (published / name).write_bytes(contents)
            recorded = [json.dumps(module.file_hashes([programs])), json.dumps(module.file_hashes([sdks]))]
            module.verify_files(published, recorded)

            # A disk image swapped after the job that made it, though it is no package the inventory names.
            (published / "Unbrowse-13.20.0-macos-arm64.dmg").write_bytes(b"replaced by a later job")
            with self.assertRaisesRegex(ValueError, "changed"):
                module.verify_files(published, recorded)
            (published / "Unbrowse-13.20.0-macos-arm64.dmg").write_bytes(b"signed disk image")

            # A file no job recorded.
            (published / "agent-browser-darwin-arm64").write_bytes(b"unrecorded")
            with self.assertRaisesRegex(ValueError, "extra"):
                module.verify_files(published, recorded)
            (published / "agent-browser-darwin-arm64").unlink()

            # A file recorded twice with different bytes, or a map that is empty (a job that never ran), proves nothing.
            with self.assertRaisesRegex(ValueError, "two different hashes"):
                module.verify_files(published, [*recorded, json.dumps({"manifest.json": "0" * 64})])
            with self.assertRaisesRegex(ValueError, "empty"):
                module.verify_files(published, [*recorded, "{}"])
            with self.assertRaises(json.JSONDecodeError):
                module.verify_files(published, [*recorded, ""])

            # A link is not a recorded file.
            (published / "link").symlink_to(published / "manifest.json")
            with self.assertRaisesRegex(ValueError, "not a regular file"):
                module.verify_files(published, recorded)


if __name__ == "__main__":
    unittest.main()
