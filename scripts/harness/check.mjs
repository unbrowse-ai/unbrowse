#!/usr/bin/env node
// One command per kind of proof. A mode prints `HARNESS_GREEN <mode>` only after every assertion passed, and exits
// non-zero otherwise, so a reviewer can confirm a change without reading it.
//
//   cargo-test [--ignored] <dir> <package> <test>...   each named test ran and passed
//   cargo-workspace <dir>                              the workspace's tests: none failed, at least one passed
//   py-test <dir> <module>...                          python unittest modules: all passed, at least one ran
//   census-valid <file>                                a census holds calls and its rung counts add up
//   census-improved <before> <after>                   coverage without a browser rose
//   census-explained <file>                            every call that needed a browser says what binds it
//   graph-nodes <doc>                                  every node id the doc's table names is in the design graph
//   doc-rows <doc> <key>...                            the doc has a table row for each key
//   self-test                                          every mode passes its passing fixture and fails its failing one
//
// HARNESS_CARGO names the cargo command (default `cargo`): a host that cannot build the node runs it in a container.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TAIL = 60;
const BOUND_BY = ['person', 'entropy', 'door', 'unplaced'];

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

function run(command, args, cwd, env) {
  const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) refuse(`could not start ${command}: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

const tail = (text) => text.trimEnd().split('\n').slice(-TAIL).join('\n');

function cargo() {
  const words = (process.env.HARNESS_CARGO || 'cargo').trim().split(/\s+/);
  return { command: words[0], lead: words.slice(1) };
}

// The lines libtest prints for one test: `test path::to::name ... ok`.
function verdicts(out) {
  const seen = new Map();
  for (const line of out.split('\n')) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line.trim());
    if (m) seen.set(m[1], m[2]);
  }
  return seen;
}

function passedByName(seen, name) {
  let ok = 0;
  for (const [path, verdict] of seen) {
    if (path !== name && !path.endsWith(`::${name}`)) continue;
    if (verdict !== 'ok') return 0;
    ok += 1;
  }
  return ok;
}

function cargoTest(args) {
  const ignored = args[0] === '--ignored';
  if (ignored) args = args.slice(1);
  const [dir, pkg, ...names] = args;
  if (!dir || !pkg || names.length === 0) refuse('usage: cargo-test [--ignored] <dir> <package> <test>...');
  const { command, lead } = cargo();
  // A test that needs a browser runs alone in its process; the rest share one build and one run.
  const groups = ignored ? names.map((n) => [n]) : [names];
  for (const group of groups) {
    const tail_args = ignored ? ['--ignored', '--test-threads=1'] : [];
    const r = run(command, [...lead, 'test', '-p', pkg, '--locked', '--', ...group, ...tail_args], dir);
    const seen = verdicts(r.out);
    for (const name of group) {
      if (passedByName(seen, name) === 0) refuse(`test ${name} did not run and pass in ${pkg}\n${tail(r.out)}`);
    }
    if (r.status !== 0) refuse(`cargo test exited ${r.status}\n${tail(r.out)}`);
  }
  return `${names.length} named test(s) passed in ${pkg}`;
}

function cargoWorkspace([dir]) {
  if (!dir) refuse('usage: cargo-workspace <dir>');
  const { command, lead } = cargo();
  const r = run(command, [...lead, 'test', '--workspace', '--locked'], dir);
  let passed = 0;
  let failed = 0;
  for (const m of r.out.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  if (r.status !== 0 || failed > 0) refuse(`workspace tests failed (${failed} failed, exit ${r.status})\n${tail(r.out)}`);
  if (passed === 0) refuse('no test ran');
  return `${passed} test(s) passed in ${dir}`;
}

function pyTest([dir, ...modules]) {
  if (!dir || modules.length === 0) refuse('usage: py-test <dir> <module>...');
  const r = run('python3', ['-m', 'unittest', '-v', ...modules], dir);
  const ran = /^Ran (\d+) tests? in/m.exec(r.out);
  if (r.status !== 0 || !ran || Number(ran[1]) === 0 || !/^OK\b/m.test(r.out)) refuse(`python tests did not all pass\n${tail(r.out)}`);
  return `${ran[1]} python test(s) passed`;
}

function census(file) {
  if (!file || !existsSync(file)) refuse(`no census at ${file}`);
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { refuse(`${file} is not JSON: ${e.message}`); }
  const whole = (v) => Number.isInteger(v) && v >= 0;
  if (!whole(c.calls) || c.calls === 0) refuse(`${file}: no calls`);
  if (typeof c.by_rung !== 'object' || c.by_rung === null) refuse(`${file}: no by_rung`);
  let sum = 0;
  let browserless = 0;
  for (const rung of ['0', '1', '2', '3', '4', '5']) {
    const n = c.by_rung[rung] ?? 0;
    if (!whole(n)) refuse(`${file}: by_rung.${rung} is not a count`);
    sum += n;
    if (Number(rung) <= 3) browserless += n;
  }
  if (Object.keys(c.by_rung).some((k) => !/^[0-5]$/.test(k))) refuse(`${file}: by_rung has a rung outside 0..5`);
  if (sum !== c.calls) refuse(`${file}: rung counts add up to ${sum}, calls is ${c.calls}`);
  if (!whole(c.browserless_answered) || c.browserless_answered > browserless) {
    refuse(`${file}: browserless_answered must be a count no higher than the ${browserless} calls at rung 3 or lower`);
  }
  if (!Array.isArray(c.browser_calls) || c.browser_calls.length !== c.calls - browserless) {
    refuse(`${file}: browser_calls must list each of the ${c.calls - browserless} calls at rung 4 or 5`);
  }
  return c;
}

const coverage = (c) => c.browserless_answered / c.calls;

function censusValid([file]) {
  const c = census(file);
  return `${c.calls} calls, coverage without a browser ${(coverage(c) * 100).toFixed(1)}%`;
}

function censusImproved([before, after]) {
  const a = census(before);
  const b = census(after);
  if (!(coverage(b) > coverage(a))) refuse(`coverage did not rise: ${(coverage(a) * 100).toFixed(1)}% before, ${(coverage(b) * 100).toFixed(1)}% after`);
  return `coverage without a browser ${(coverage(a) * 100).toFixed(1)}% -> ${(coverage(b) * 100).toFixed(1)}%`;
}

function censusExplained([file]) {
  const c = census(file);
  const counts = Object.fromEntries(BOUND_BY.map((b) => [b, 0]));
  for (const call of c.browser_calls) {
    if (!call || !BOUND_BY.includes(call.bound_by)) refuse(`${file}: a browser call does not say what binds it: ${JSON.stringify(call)}`);
    counts[call.bound_by] += 1;
  }
  return BOUND_BY.map((b) => `${b}=${counts[b]}`).join(' ');
}

// The cells of every table row in a markdown file, without the header's rule line.
function tableRows(doc) {
  if (!doc || !existsSync(doc)) refuse(`no doc at ${doc}`);
  const rows = [];
  for (const line of readFileSync(doc, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|[\s:|-]+\|$/.test(t)) continue;
    rows.push(t.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  }
  return rows;
}

const plain = (cell) => cell.replace(/[`*]/g, '').trim().toLowerCase();

function docRows([doc, ...keys]) {
  if (keys.length === 0) refuse('usage: doc-rows <doc> <key>...');
  const first = new Set(tableRows(doc).map((cells) => plain(cells[0] || '')));
  const missing = keys.filter((k) => !first.has(k.toLowerCase()));
  if (missing.length) refuse(`${doc} has no row for: ${missing.join(', ')}`);
  return `${keys.length} row(s) found in ${doc}`;
}

function graphNodes([doc]) {
  const graph = process.env.UNBROWSE_GRAPH || join(homedir(), 'work', 'unbrowse-graph');
  const index = join(graph, 'INDEX.md');
  if (!existsSync(index)) refuse(`no design graph index at ${index}`);
  const known = new Set([...readFileSync(index, 'utf8').matchAll(/`([^`\s]+)`/g)].map((m) => m[1]));
  const named = new Set();
  for (const cells of tableRows(doc)) {
    for (const m of (cells[1] || '').matchAll(/`([^`\s]+)`/g)) named.add(m[1]);
  }
  if (named.size === 0) refuse(`${doc} names no node id in the second column of its table`);
  const missing = [...named].filter((id) => !known.has(id));
  if (missing.length) refuse(`not in ${index}: ${missing.join(', ')}`);
  return `${named.size} node id(s) found in the design graph`;
}

function selfTest() {
  const fx = join(here, 'fixtures');
  const me = fileURLToPath(import.meta.url);
  const crate = join(fx, 'crate');
  const cases = [
    ['cargo-test', [crate, 'harness-fixture', 'a_test_that_passes'], true],
    ['cargo-test', [crate, 'harness-fixture', 'a_test_that_fails'], false],
    ['cargo-test', [crate, 'harness-fixture', 'a_test_nobody_wrote'], false],
    ['cargo-test', [crate, 'harness-fixture', 'a_test_that_needs_asking_for'], false],
    ['cargo-test', ['--ignored', crate, 'harness-fixture', 'a_test_that_needs_asking_for'], true],
    ['cargo-workspace', [join(fx, 'crate-green')], true],
    ['cargo-workspace', [crate], false],
    ['py-test', [join(fx, 'py'), 'test_green'], true],
    ['py-test', [join(fx, 'py'), 'test_red'], false],
    ['py-test', [join(fx, 'py'), 'test_empty'], false],
    ['census-valid', [join(fx, 'census', 'before.json')], true],
    ['census-valid', [join(fx, 'census', 'miscounted.json')], false],
    ['census-improved', [join(fx, 'census', 'before.json'), join(fx, 'census', 'after.json')], true],
    ['census-improved', [join(fx, 'census', 'after.json'), join(fx, 'census', 'before.json')], false],
    ['census-improved', [join(fx, 'census', 'before.json'), join(fx, 'census', 'before.json')], false],
    ['census-explained', [join(fx, 'census', 'after.json')], true],
    ['census-explained', [join(fx, 'census', 'unexplained.json')], false],
    ['doc-rows', [join(fx, 'docs', 'table.md'), 'rung', 'lab'], true],
    ['doc-rows', [join(fx, 'docs', 'table.md'), 'rung', 'absent'], false],
    ['graph-nodes', [join(fx, 'docs', 'table.md')], true, { UNBROWSE_GRAPH: join(fx, 'graph') }],
    ['graph-nodes', [join(fx, 'docs', 'unknown-node.md')], false, { UNBROWSE_GRAPH: join(fx, 'graph') }],
    ['graph-nodes', [join(fx, 'docs', 'no-nodes.md')], false, { UNBROWSE_GRAPH: join(fx, 'graph') }],
  ];
  const wrong = [];
  for (const [mode, args, shouldPass, env] of cases) {
    const r = run(process.execPath, [me, mode, ...args], here, env || {});
    const green = r.status === 0 && r.out.includes(`HARNESS_GREEN ${mode}`);
    const marked = r.out.includes('HARNESS_GREEN');
    if (shouldPass ? !green : r.status === 0 || marked) wrong.push(`${mode} ${args.map((a) => a.replace(fx, 'fixtures')).join(' ')}: expected ${shouldPass ? 'green' : 'a refusal'}`);
  }
  if (wrong.length) refuse(`the runner misjudged ${wrong.length} of ${cases.length} cases:\n${wrong.join('\n')}`);
  return `${cases.length} cases judged right`;
}

const modes = {
  'cargo-test': cargoTest,
  'cargo-workspace': cargoWorkspace,
  'py-test': pyTest,
  'census-valid': censusValid,
  'census-improved': censusImproved,
  'census-explained': censusExplained,
  'graph-nodes': graphNodes,
  'doc-rows': docRows,
  'self-test': selfTest,
};

const [mode, ...args] = process.argv.slice(2);
if (!modes[mode]) {
  process.stderr.write(`usage: check.mjs <${Object.keys(modes).join('|')}> ...\n`);
  process.exit(2);
}
try {
  const said = modes[mode](args);
  process.stdout.write(`${said}\nHARNESS_GREEN ${mode}\n`);
} catch (e) {
  if (!(e instanceof Refused)) throw e;
  process.stderr.write(`REFUSED ${mode}: ${e.message}\n`);
  process.exit(1);
}
