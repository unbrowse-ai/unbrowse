// Reads the string literals of one script with the vendored acorn tokenizer, for the digest search: a constant the
// site's own code holds (a salt in a bundle) is a part a signature may be made over. Tokenizing, not parsing, so a
// minified or module bundle still yields what it can; a tokenizer error keeps the literals found before it.
//
//   node slice_literals.js spec.json   ->   {"literals": ["...", ...]}
//
// spec.json: { "body": "<script source>", "max": <longest literal kept> }. Template literals are not strings here and
// are left out: a hashed constant is a plain string. Distinct values, in first-seen order, each 1..=max characters.
const fs = require('fs');
const acorn = require('./acorn.js');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const src = String(spec.body || '');
const max = Number(spec.max) || 64;
const seen = new Set();
const out = [];
const keep = (v) => {
  if (typeof v === 'string' && v.length >= 1 && v.length <= max && !seen.has(v)) {
    seen.add(v);
    out.push(v);
  }
};

try {
  for (const tok of acorn.tokenizer(src, { ecmaVersion: 'latest' })) {
    if (tok.type === acorn.tokTypes.string) {
      keep(tok.value);
    }
  }
} catch (e) {
  // A tokenizer that met code it could not read keeps the literals it had already passed.
}

process.stdout.write(JSON.stringify({ literals: out }));
