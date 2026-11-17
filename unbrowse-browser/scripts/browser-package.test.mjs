import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(new URL('../..', import.meta.url).pathname);

test('release_pack_contains_the_browser_binary_in_the_signed_platform_package_without_postinstall_download', (t) => {
  const packageSource = JSON.parse(readFileSync(join(root, 'unbrowse-browser/package.json'), 'utf8'));
  assert.equal(packageSource.scripts?.postinstall, undefined);
  const postinstall = readFileSync(join(root, 'unbrowse-browser/scripts/postinstall.js'), 'utf8');
  assert.doesNotMatch(postinstall, /github\.com\/.+releases|https\.get|downloadFile/);

  const temp = mkdtempSync(join(tmpdir(), 'unbrowse-browser-pack-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const programs = join(temp, 'programs');
  const payload = join(temp, 'payload', 'unbrowse-1.2.3');
  const out = join(temp, 'out');
  mkdirSync(programs); mkdirSync(payload, { recursive: true }); mkdirSync(out);
  for (const name of ['unbrowse-window', 'unbrowse-node', 'unb', 'agent-browser']) {
    const path = join(payload, name);
    writeFileSync(path, `#!/bin/sh\necho ${name}\n`);
    chmodSync(path, 0o755);
  }
  const archive = join(programs, 'unbrowse-1.2.3-linux-x64.tar.gz');
  const made = spawnSync('tar', ['-czf', archive, '-C', join(temp, 'payload'), 'unbrowse-1.2.3'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const packed = spawnSync('sh', [join(root, '.github/scripts/pack-platforms.sh'), '1.2.3', programs, out], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);

  const pkg = join(out, 'unbrowse-browser-linux-x64-1.2.3.tgz');
  const names = spawnSync('tar', ['-tzf', pkg], { encoding: 'utf8' });
  assert.equal(names.status, 0, names.stderr);
  assert.match(names.stdout, /package\/bin\/agent-browser/);
  const browserMeta = spawnSync('tar', ['-xOzf', pkg, 'package/package.json'], { encoding: 'utf8' });
  const metadata = JSON.parse(browserMeta.stdout);
  assert.equal(metadata.name, '@unbrowse/browser-linux-x64');
  assert.match(metadata.unbrowseBrowserSha256, /^[0-9a-f]{64}$/);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browsers['linux-x64'].name, metadata.name);
  assert.equal(manifest.browsers['linux-x64'].integrity, `sha512-${createHash('sha512').update(readFileSync(pkg)).digest('base64')}`);
});
