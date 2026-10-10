import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('docs/public-surface.json','utf8'));
const allowed = ['skill/SKILL.md','packages/sdk/src/mcp-install.ts','skill/references/tools.json'];
assert.deepEqual(Object.keys(manifest.files).sort(),allowed.sort());
for (const path of allowed) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),manifest.files[path], `Upstream-owned file changed: ${path}`);
const skill = readFileSync('skill/SKILL.md','utf8');
assert.match(skill,/^---\nname: unbrowse\ndescription: .+\n---/);
for (const file of ['README.md','skill/SKILL.md','docs/README.md','docs/install.md','docs/troubleshooting.md','docs/public-sync.md']) {
 const text = readFileSync(file,'utf8');
 for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
  const href = match[1].split('#')[0];
  if (!href || /^[a-z]+:/i.test(href)) continue;
  assert.ok(existsSync(resolve(dirname(file),href)), `${file}: broken link ${href}`);
 }
}
const {tools} = JSON.parse(readFileSync('skill/references/tools.json','utf8'));
assert.ok(tools.length > 0);
assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
for (const t of tools) assert.ok(/^(unbrowse_[a-z_]+|search|fetch)$/.test(t.name) && t.inputSchema.type === 'object');
assert.equal(readFileSync('AGENTS.md','utf8'),readFileSync('CLAUDE.md','utf8'));
console.log('PUBLIC_SURFACE_OK');
