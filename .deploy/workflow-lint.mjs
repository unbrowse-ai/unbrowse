#!/usr/bin/env node
// The workflows hold the deploy credentials, so they are checked like code. Each rule is one that has been used to
// take over a pipeline, or to let a change skip its own tests:
//
//   pinned      an action from outside GitHub's own (actions/*, github/*) is named by a full commit id, not a tag:
//               a tag can be moved to other code, which then runs with the deploy secrets
//   permissions every workflow says what its token may do, at the top, and never `write-all`
//   injection   no ${{ github.event… }}, ${{ github.head_ref }} or ${{ inputs… }} inside a `run:` script: a branch name
//               or a title is text from outside. It goes through `env:` and is used as "$NAME"
//   untrusted   a workflow started by pull_request_target, workflow_run or issue_comment that checks out the change's
//               own code must refuse changes from other repositories and must not leave its token in the checkout
//   timeout     every job has timeout-minutes: a hung job holds the deploy lock for six hours otherwise
//   pipefail    a step that pipes a command into `tee` (to keep its output) reports tee's success, not the command's,
//               unless the shell is named: `shell: bash` runs with pipefail. A failed deploy would show as green
//   yaml        a one-line `name:`, `run:` or `if:` whose text holds ": " and is not quoted is not the text it looks like:
//               YAML reads it as a mapping and the whole file is refused
//   no-skip     a workflow whose jobs are required checks has no `paths:` filter: a filtered-out check never reports,
//               and a check that never reports is a gate that silently passed
//
//   node workflow-lint.mjs [--dir .github/workflows] [--required ci.yml,main-source-guard.yml]
// Ends with a success-only marker:  WORKFLOWS_OK files=… actions=…        Else WORKFLOWS_FAIL, exit 1.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const indent = (l) => l.length - l.trimStart().length;

/** Every rule one workflow file breaks: [text]. Pure. `required`: is this a workflow whose jobs are required checks? */
export function lint(name, text, required = false) {
  const bad = [], lines = String(text).split("\n"), code = lines.map((l) => l.replace(/\s+#.*$/, ""));
  // pinned
  for (const [i, l] of code.entries()) {
    const m = /^\s*(?:-\s*)?uses:\s*["']?([^\s"']+)/.exec(l);
    if (!m || m[1].startsWith("./") || /^(actions|github)\//.test(m[1])) continue;
    if (!/@[0-9a-f]{40}$/.test(m[1])) bad.push(`${name}:${i + 1} pinned: ${m[1]} is named by a tag or a branch. Use its full commit id and keep the tag as a comment (uses: owner/action@<40 hex> # v2)`);
  }
  // permissions
  if (!code.some((l) => /^permissions:/.test(l))) bad.push(`${name} permissions: no top-level \`permissions:\`. Say what the token may do (\`permissions: {}\` and grants per job, or the least the workflow needs)`);
  for (const [i, l] of code.entries()) if (/^\s*permissions:\s*write-all/.test(l)) bad.push(`${name}:${i + 1} permissions: write-all gives every job every right`);
  // injection: the lines of each run script
  for (let i = 0; i < code.length; i++) {
    const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(code[i]);
    if (!m) continue;
    const block = /^[|>][+-]?\s*$/.test(m[2]), at = indent(lines[i]) + (/^\s*-\s/.test(lines[i]) ? 2 : 0), body = block ? [] : [[i, m[2]]];
    if (block) for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || indent(lines[j]) > at); j++) body.push([j, lines[j]]);
    for (const [j, row] of body) { const x = /\$\{\{\s*(github\.event\.[\w.]+|github\.head_ref|inputs\.[\w-]+)[^}]*\}\}/.exec(row); if (x) bad.push(`${name}:${j + 1} injection: ${x[1]} is pasted into a script. Put it in \`env:\` and use the variable`); }
  }
  // untrusted
  const trigger = /^\s{2}(pull_request_target|workflow_run|issue_comment):/m.exec(text)?.[1];
  if (trigger && /ref:\s*["']?\$\{\{[^}]*(head_sha|head\.sha|head_branch|head\.ref|head_ref)/.test(text)) {
    if (!/(head_repository\.full_name|head\.repo\.full_name)\s*==\s*github\.repository/.test(text)) bad.push(`${name} untrusted: it is started by ${trigger} and checks out the change's code, with this repository's token and secrets. Run only for changes from this repository (\`head_repository.full_name == github.repository\`)`);
    if (!/persist-credentials:\s*false/.test(text)) bad.push(`${name} untrusted: its checkout of the change's code keeps the token in the working copy. Add \`persist-credentials: false\``);
  }
  // timeout: each job (two-space keys under `jobs:`), unless it only calls another workflow
  const start = code.findIndex((l) => /^jobs:/.test(l));
  if (start >= 0) {
    const jobs = [];
    for (let i = start + 1; i < code.length && (code[i].trim() === "" || indent(lines[i]) > 0); i++) { const m = /^ {2}([\w-]+):\s*$/.exec(code[i]); if (m) jobs.push({ name: m[1], rows: [] }); else jobs.at(-1)?.rows.push(code[i]); }
    for (const j of jobs) if (!j.rows.some((r) => /^ {4}timeout-minutes:/.test(r)) && !j.rows.some((r) => /^ {4}uses:/.test(r))) bad.push(`${name} timeout: the job ${j.name} has no timeout-minutes`);
  }
  // yaml
  for (const [i, l] of lines.entries()) { const m = /^\s*(?:-\s*)?(name|run|if):\s+(?!["'|>])(.*?: .*)$/.exec(l); if (m && !/^\s*#/.test(l)) bad.push(`${name}:${i + 1} yaml: the ${m[1]} holds ": " and is not quoted, so the file does not parse. Reword it, quote it, or use a block (\`${m[1]}: |\`)`); }
  // pipefail
  const piped = code.findIndex((l) => /\|\s*tee\b/.test(l));
  if (piped >= 0 && !/^\s*shell:\s*bash\b/m.test(text)) bad.push(`${name}:${piped + 1} pipefail: a command is piped into tee and the shell is the default, which reports tee's exit and not the command's. Set \`defaults: { run: { shell: bash } }\``);
  // no-skip
  if (required && /^\s+paths(-ignore)?:/m.test(text)) bad.push(`${name} no-skip: a required check is filtered by paths, so some changes never run it and are never held by it`);
  return bad;
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const dir = resolve(arg("dir", ".github/workflows")), required = arg("required", "ci.yml,main-source-guard.yml").split(",");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!files.length) { console.log(`WORKFLOWS_FAIL there are no workflows in ${dir}`); process.exit(1); }
  const bad = files.flatMap((f) => lint(f, readFileSync(join(dir, f), "utf8"), required.includes(f)));
  const actions = new Set(files.flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'@]+)@/gm)].map((m) => m[1])));
  if (bad.length) { console.log(`WORKFLOWS_FAIL ${bad.length}:\n  ${bad.join("\n  ")}`); process.exit(1); }
  console.log(`WORKFLOWS_OK files=${files.length} actions=${actions.size}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
