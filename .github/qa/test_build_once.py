"""A run builds the node once, and every job that runs it checks the build before unpacking it (UNB-166).

Before this, a push to staging built the same commit in QA's MCP check, in Claude QA and in the gate bank's slice
(medians 78 s, 86 s and 79 s, 17 to 21 Nov 2026), and Bank built it in each of its ten shards (88 s each). Now one
`build` job per run packs the programs into one archive and gives its SHA-256 as an output; a job that runs the node
downloads the archive and checks that digest before `tar` touches it. The build job holds no secret, starts no node
and runs no agent, so the one cache a run saves holds only what the build made.

Read as text: the check's venv has no YAML library (test_qa_workflow.py).
"""
import re
import unittest
from pathlib import Path

from test_mac_runner import code, jobs

WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"
# workflow: (the artifact its build job keeps, the jobs that unpack it)
BUILT_ONCE = {
    "qa.yml": ("qa-node-build", {"check", "qa"}),
    "bank.yml": ("bank-node-build", {"hard-sites", "writes"}),
    "pr-agent-checks.yml": ("pr-node-build", {"check", "qa", "slice"}),
}


def read(name):
    return (WORKFLOWS / name).read_text()


def needs(text, job):
    """The jobs `job` names in its `needs:` (one line: a name or a [list])."""
    block = re.split(r"(?m)^  [A-Za-z_][\w-]*:\s*$", text.split(f"\n  {job}:\n", 1)[1], maxsplit=1)[0]
    line = re.search(r"(?m)^    needs: (.+)$", block)
    return [n.strip() for n in line.group(1).strip("[]").split(",")] if line else []


def unpacks_checked(steps, artifact, digest):
    """Why a job's use of the build archive is not safe, as sentences; none when every download of it is followed
    straight away by a step that checks `digest` and only then unpacks."""
    problems = []
    for i, step in enumerate(steps):
        if "actions/download-artifact@" not in step or f"name: {artifact}" not in step:
            continue
        after = steps[i + 1] if i + 1 < len(steps) else ""
        if f"DIGEST: {digest}" not in after:
            problems.append("the step after the download does not take the build job's digest")
        elif "shasum -a 256 -c" not in after or "tar -xf" not in after:
            problems.append("the step after the download does not check the digest and unpack")
        elif after.index("shasum -a 256 -c") > after.index("tar -xf"):
            problems.append("the archive is unpacked before its digest is checked")
        if any("node-build" in code(earlier) for earlier in steps[:i]):
            problems.append("a step touches the build before it is downloaded and checked")
    return problems


class BuildOnce(unittest.TestCase):
    def test_one_job_builds_and_the_others_unpack_what_it_built(self):
        for name, (artifact, users) in BUILT_ONCE.items():
            text = read(name)
            found = jobs(text)
            builders = {job for job, j in found.items() if any("cargo build" in code(s) for s in j["steps"])}
            with self.subTest(workflow=name):
                self.assertEqual(builders, {"build"}, "one job builds the node")
                build = "\n".join(found["build"]["steps"])
                self.assertIn(f"name: {artifact}", build)
                self.assertIn('echo "digest=$digest" >> "$GITHUB_OUTPUT"', build)
                self.assertIn("shasum -a 256", build)
                unpackers = {job for job, j in found.items() if any(f"name: {artifact}" in s and "download-artifact@" in s for s in j["steps"])}
                self.assertEqual(unpackers, users)
                for job in sorted(users):
                    self.assertIn("build", needs(text, job), f"{job} needs the build job")
                    self.assertEqual(unpacks_checked(found[job]["steps"], artifact, "${{ needs.build.outputs.digest }}"), [], job)

    def test_the_build_job_holds_no_secret_and_runs_nothing_but_the_build(self):
        # Its cache is saved straight after the build; a node or an agent in the same job could have changed the tree.
        for name in BUILT_ONCE:
            build = jobs(read(name))["build"]["steps"]
            with self.subTest(workflow=name):
                body = "\n".join(code(s) for s in build)
                self.assertNotIn("secrets.", body)
                self.assertNotRegex(body, r"(start|scratch)-node\.sh|claude-cli|claude-code-action|mcp_check\.py|run_bank\.py")
                saves = [i for i, s in enumerate(build) if "actions/cache/save@" in s]
                for i in saves:
                    self.assertIn("cargo build", build[i - 1], "a cache is saved straight after the build")

    def test_no_job_that_starts_a_node_or_an_agent_saves_a_cache(self):
        for name in BUILT_ONCE:
            for job, j in jobs(read(name)).items():
                body = "\n".join(code(s) for s in j["steps"])
                if not re.search(r"(start|scratch)-node\.sh|claude-code-action@|claude\" -p|\"\$cli\" -p", body):
                    continue
                with self.subTest(workflow=name, job=job):
                    self.assertNotRegex(body, r"actions/cache/save@|actions/cache@|Swatinem/rust-cache@")

    def test_the_gate_bank_runs_the_callers_build_or_builds_for_itself(self):
        # qa.yml hands its build's digest to the slice; on its own (a release branch, nightly, by hand) gate-bank.yml
        # has no digest and builds. `inputs.build_digest` is null on every event but QA's call, and null is false.
        qa = read("qa.yml")
        self.assertIn("build", needs(qa, "bank"))
        self.assertIn("      build_digest: ${{ needs.build.outputs.digest }}\n", qa.split("\n  bank:\n", 1)[1].split("\n  report:\n", 1)[0])
        gate = read("gate-bank.yml")
        self.assertRegex(gate.split("\njobs:\n", 1)[0], r"(?m)^      build_digest:\n(?:        .*\n)*?        default: \"\"\n")
        steps = jobs(gate)["bank"]["steps"]
        self.assertEqual(unpacks_checked(steps, "qa-node-build", "${{ inputs.build_digest }}"), [])
        given, built = "if: ${{ inputs.build_digest }}", "if: ${{ !inputs.build_digest"
        for step in steps:
            body = code(step)
            if "qa-node-build" in body or "tar -xf" in body:
                self.assertIn(given, step, "the caller's build is used only when a digest came with it")
            if re.search(r"cargo build|rust-toolchain@|actions/cache/|apply-tls-patch", body):
                self.assertIn(built, step, "the job builds only when no digest came")
        self.assertTrue(any("cargo build" in code(s) for s in steps), "gate-bank.yml can still build for itself")

    def test_the_unpack_check_can_fail(self):
        download = "      - uses: actions/download-artifact@x\n        with:\n          name: qa-node-build"
        good = "      - name: Unpack\n        env:\n          DIGEST: ${{ needs.build.outputs.digest }}\n        run: |\n          echo \"$DIGEST  f\" | shasum -a 256 -c -\n          tar -xf f"
        digest = "${{ needs.build.outputs.digest }}"
        self.assertEqual(unpacks_checked([download, good], "qa-node-build", digest), [])
        self.assertTrue(unpacks_checked([download, "      - run: tar -xf f"], "qa-node-build", digest))
        swapped = good.replace('echo "$DIGEST  f" | shasum -a 256 -c -\n          tar -xf f', 'tar -xf f\n          echo "$DIGEST  f" | shasum -a 256 -c -')
        self.assertIn("the archive is unpacked before its digest is checked", unpacks_checked([download, swapped], "qa-node-build", digest))
        self.assertTrue(unpacks_checked(["      - run: ls $RUNNER_TEMP/node-build", download, good], "qa-node-build", digest))
        self.assertTrue(unpacks_checked([download, good.replace("needs.build.outputs.digest", "github.sha")], "qa-node-build", digest))

    def test_a_node_unpacked_on_another_runner_is_told_where_its_browser_is(self):
        # Built on Blacksmith (/Users/runner), unpacked on Lewis's Mac (/Users/lewistham/actions-runner): the debug
        # node's built-in browser path was the build machine's, so Claude QA's browser checks came back
        # "blocked: browser_missing" (9 of 27) with a passing verdict, staging QA 44917313753.
        for name in ("qa.yml", "pr-agent-checks.yml", "gate-bank.yml", "bank.yml"):
            text = read(name)
            unpacks = [m.start() for m in re.finditer(r'tar -xf "\$RUNNER_TEMP/node-build/node-build.tar"', text)]
            with self.subTest(workflow=name):
                self.assertTrue(unpacks)
                for at in unpacks:
                    after = text[at:].split("\n      - ", 1)[0]
                    self.assertIn('test -x "$browser"', after)
                    self.assertIn('echo "UNBROWSE_BROWSER=$browser" >> "$GITHUB_ENV"', after)
                    self.assertIn("unbrowse-browser/cli/target/debug/agent-browser", after)


if __name__ == "__main__":
    unittest.main()
