"""The QA jobs run on someone's own Mac as well as on a hosted one (UNB-235).

On lewis-macbook-pro (run 44870008228) the hosted image's gifts were missing and the owner's things were in the way:
the runner service has no npm on its PATH ("npm: command not found" in Gate bank's CLI install), and the owner's own
node holds 127.0.0.1:7788 ("port 7788: Address already in use" when MCP check and Claude QA started theirs). So in
every job that runs on the Mac runner, nothing calls npm, npx or node before setup-node, no job and no QA script
talks to 7788, and a node left running by an earlier job (17810 held, run 44884521521) is stopped before one starts.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ["qa.yml", "pr-agent-checks.yml", "gate-bank.yml", "bank.yml"]
# A job reaches the Mac through the workflow's `place` job (UNB-166): `place_jobs.py qa=mac ...` names it, and its
# runs-on reads `needs.place.outputs.qa`.
PLACED_ON = re.compile(r"place_jobs\.py((?: [\w]+=(?:mac|linux))+)")
NODE_CALL = re.compile(r"(^|[\s;&|(])(npm|npx|node)\s")


def jobs(text):
    """{job id: [step text, ...]} for the jobs block, each step its lines joined."""
    found, job, step = {}, None, None
    body = text.split("\njobs:\n", 1)[1]
    for line in body.splitlines():
        if re.match(r"^  [A-Za-z_][\w-]*:\s*$", line):
            job, step = line.strip()[:-1], None
            found[job] = {"runs_on": "", "steps": []}
        elif job is None:
            continue
        elif line.startswith("    runs-on:"):
            found[job]["runs_on"] = line
        elif re.match(r"^      - ", line):
            step = [line]
            found[job]["steps"].append(step)
        elif step is not None and line.startswith("        "):
            step.append(line)
    return {name: {"runs_on": j["runs_on"], "steps": ["\n".join(s) for s in j["steps"]]} for name, j in found.items()}


def may_run_on_the_mac(text):
    """Job ids of a workflow that can land on a Mac runner of Lewis's: placed there, or reading MAC_RUNNER."""
    placed = set()
    for match in PLACED_ON.finditer(text):
        placed |= {arg.split("=")[0] for arg in match.group(1).split() if arg.endswith("=mac")}
    found = set()
    for job, j in jobs(text).items():
        out = re.search(r"needs\.place\.outputs\.(\w+)", j["runs_on"])
        # A matrix of shards reads `outputs[format('qa{0}', matrix.shard)]`: any qa<n> placed on the Mac (UNB-235).
        shard = re.search(r"needs\.place\.outputs\[format\('(\w+)\{0\}'", j["runs_on"])
        if "MAC_RUNNER" in j["runs_on"] or (out and out.group(1) in placed) or (
                shard and any(re.fullmatch(re.escape(shard.group(1)) + r"\d+", name) for name in placed)):
            found.add(job)
    return found


def code(step):
    """A step's lines with comments and its name dropped."""
    return "\n".join(line for line in step.splitlines() if not re.match(r"^\s*(- )?(#|name:)", line))


def node_before_setup(steps):
    """Steps that call npm, npx or node before the job's first setup-node."""
    early = []
    for step in steps:
        if "actions/setup-node@" in step:
            return early
        if NODE_CALL.search(code(step)):
            early.append(step.splitlines()[0].strip())
    return early


class MacRunner(unittest.TestCase):
    def test_no_npm_before_setup_node_on_the_mac(self):
        checked = 0
        for name in WORKFLOWS:
            text = (ROOT / ".github/workflows" / name).read_text()
            for job, j in jobs(text).items():
                if job not in may_run_on_the_mac(text):
                    continue
                checked += 1
                with self.subTest(workflow=name, job=job):
                    self.assertEqual(node_before_setup(j["steps"]), [])
        # Six since pr-agent-checks.yml's copy of the MCP check went (22 Nov 2026).
        self.assertGreaterEqual(checked, 6, "the jobs that can run on the Mac were found")

    def test_no_qa_job_or_script_talks_to_the_owners_port(self):
        for path in [ROOT / ".github/workflows" / n for n in WORKFLOWS] + [ROOT / ".github/qa/start-node.sh"]:
            with self.subTest(path=path.name):
                lines = [line for line in path.read_text().splitlines() if not line.strip().startswith("#")]
                self.assertEqual([line.strip() for line in lines if "127.0.0.1:7788" in line], [])

    def test_a_mac_job_stops_what_an_earlier_job_left_before_starting_a_node(self):
        for name in WORKFLOWS:
            text = (ROOT / ".github/workflows" / name).read_text()
            for job, j in jobs(text).items():
                if job not in may_run_on_the_mac(text):
                    continue
                starts = [i for i, step in enumerate(j["steps"]) if re.search(r"(start|scratch)-node\.sh", code(step))]
                if not starts:
                    continue
                with self.subTest(workflow=name, job=job):
                    stops = [i for i, step in enumerate(j["steps"]) if "stop-left-nodes.sh" in code(step)]
                    self.assertTrue(stops and stops[0] < starts[0], "no stop-left-nodes.sh step before the first node starts")

    def test_a_cli_install_before_setup_node_is_caught(self):
        workflow = (
            "on: push\njobs:\n"
            "  bank:\n"
            "    runs-on: ${{ fromJSON(vars.MAC_RUNNER) }}\n"
            "    steps:\n"
            "      - name: Install the pinned Claude CLI\n"
            "        run: |\n"
            "          npm ci --prefix .github/tools/claude-cli\n"
            "      - uses: actions/setup-node@x\n"
        )
        self.assertEqual(node_before_setup(jobs(workflow)["bank"]["steps"]), ["- name: Install the pinned Claude CLI"])

    def test_a_job_placed_on_the_mac_is_found_and_one_placed_on_linux_is_not(self):
        workflow = (
            "on: push\njobs:\n"
            "  place:\n"
            "    runs-on: blacksmith-2vcpu-ubuntu-2404\n"
            "    steps:\n"
            "      - run: python3 -I .github/scripts/place_jobs.py qa=mac skills=linux\n"
            "  qa:\n"
            "    runs-on: ${{ fromJSON(needs.place.outputs.qa) }}\n"
            "  skills:\n"
            "    runs-on: ${{ fromJSON(needs.place.outputs.skills) }}\n"
            "  node:\n"
            "    runs-on: blacksmith-6vcpu-macos-latest\n"
        )
        self.assertEqual(may_run_on_the_mac(workflow), {"qa"})

    def test_a_node_pid_is_not_a_node_call(self):
        self.assertIsNone(NODE_CALL.search('kill "$(cat "$UNBROWSE_HOME/node.pid")" ; sh start-node.sh unbrowse-node x'))


if __name__ == "__main__":
    unittest.main()
