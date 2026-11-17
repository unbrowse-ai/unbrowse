// Reads the tables one script ships, with the vendored acorn parser: an array of records whose fields are all fixed
// values (`[{name: 'Lisbon', code: 'LIS'}, ...]`), or a map of fixed values (`{Lisbon: 'LIS', ...}`, read as records
// of `key` and `value`). The site's data shipped to everyone, which a page's code may turn a caller's word into a code
// by, with no call made. Parsing, not running: nothing of the script executes.
//
//   node slice_tables.js spec.json   ->   {"tables": [[{...}, ...], ...]}
//
// spec.json: { "body": "<script source>", "rows": <most records a table may have> }. A table has two records at least,
// and every record a fixed value in each field; nested records are read as they nest.
const fs = require('fs');
const acorn = require('./acorn.js');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const src = String(spec.body || '');
const most = Number(spec.rows) || 5000;

let ast = null;
for (const sourceType of ['module', 'script']) {
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true });
    break;
  } catch (e) {
    ast = null;
  }
}

const NONE = Symbol('none');

// The fixed value a node is, or NONE.
function fixed(node) {
  if (!node) return NONE;
  switch (node.type) {
    case 'Literal':
      return node.regex ? NONE : node.value;
    case 'TemplateLiteral':
      return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked).join('') : NONE;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
      return NONE;
    case 'ObjectExpression': {
      const out = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.computed || p.kind !== 'init') return NONE;
        const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
        if (key === null) return NONE;
        const v = fixed(p.value);
        if (v === NONE) return NONE;
        out[key] = v;
      }
      return out;
    }
    case 'ArrayExpression': {
      const out = [];
      for (const e of node.elements) {
        const v = fixed(e);
        if (v === NONE) return NONE;
        out.push(v);
      }
      return out;
    }
    default:
      return NONE;
  }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const tables = [];
const seen = new Set();
const keep = (rows) => {
  if (rows.length < 2 || rows.length > most) return;
  const said = JSON.stringify(rows);
  if (!seen.has(said)) {
    seen.add(said);
    tables.push(rows);
  }
};

function walk(node) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'ArrayExpression') {
    const v = fixed(node);
    if (v !== NONE && v.length >= 2 && v.every(isRecord)) {
      keep(v);
      return;
    }
  }
  if (node.type === 'ObjectExpression') {
    const v = fixed(node);
    if (v !== NONE) {
      const entries = Object.entries(v);
      if (entries.length >= 2 && entries.every(([, x]) => isScalar(x))) {
        keep(entries.map(([key, value]) => ({ key, value })));
        return;
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(walk);
    else if (child && typeof child === 'object') walk(child);
  }
}

if (ast) walk(ast);
process.stdout.write(JSON.stringify({ tables }));
