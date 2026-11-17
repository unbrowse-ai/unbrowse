#!/usr/bin/env node
// The control for every cargo gate: a test nobody wrote must fail the runner, with no marker printed.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(here, 'check.mjs'), 'cargo-test', join(here, 'fixtures', 'crate'), 'harness-fixture', 'a_test_nobody_wrote'], { encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`;
if (r.status === 0 || out.includes('HARNESS_GREEN')) {
  process.stderr.write(`a test nobody wrote was called green (exit ${r.status})\n`);
  process.exit(1);
}
if (!out.includes('did not run and pass')) {
  process.stderr.write(`the runner failed for another reason:\n${out}\n`);
  process.exit(1);
}
process.stdout.write('HARNESS_GREEN missing-test-refused\n');
