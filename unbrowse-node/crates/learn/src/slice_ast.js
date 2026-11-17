// The slicer's parser helper: acorn (vendored beside it) parses the page's scripts, finds the write site, and reads
// the names it uses to the code that defines them. Run by the node runtime the signing bridge uses; the Rust side
// falls back to its own scanner when this can't run.
const fs = require('fs');
const acorn = require('./acorn.js');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const scripts = spec.scripts || [];
const at = spec.at || 0;
const scriptUrl = spec.script || '';
const WHOLE = 128 * 1024;

const done = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
// A script is read as the page's document would run it, and the document's word for it is not kept with its source:
// as a classic script first, then as a module. `import` and `export` are errors in a classic script, so a module
// read as one does not parse at all, and its code was left to the text scanner.
const parse = (src) => {
  for (const sourceType of ['script', 'module']) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: sourceType === 'script' });
    } catch (e) {
      // the next reading
    }
  }
  return null;
};

function walk(node, cb, ancestors) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, cb, ancestors);
    return;
  }
  if (typeof node.type !== 'string') return;
  cb(node, ancestors);
  const next = ancestors.concat([node]);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'type') continue;
    walk(node[key], cb, next);
  }
}

const fold = (s) => String(s || '').replace(/[_$]/g, '').toLowerCase();
const isFn = (n) => n && /Function(Declaration|Expression)$/.test(n.type) || (n && n.type === 'ArrowFunctionExpression');

// A member write: `t.headers["x"] = …`, `t["x"] = …`, `headers.x = …`. The write site is the one nearest the offset.
function isWrite(node) {
  if (!node || node.type !== 'AssignmentExpression' || !node.left || node.left.type !== 'MemberExpression') return false;
  const p = node.left.property;
  if (node.left.computed) return p && p.type === 'Literal' && typeof p.value === 'string' && p.value.length >= 4;
  return p && p.type === 'Identifier' && p.name.length >= 4;
}

const target = scripts.find((s) => s.url === scriptUrl);
if (!target) done({ error: 'no script' });
const ast = parse(target.body);
if (!ast) done({ error: 'the write site does not parse' });

// Acorn measures in UTF-16 code units; Rust slices UTF-8 bytes. Convert one to the other, both ways: `at` comes from
// Rust as a byte offset, and every range goes back as bytes.
const toBytes = (src, i) => Buffer.byteLength(src.slice(0, i), 'utf8');
const toUnits = (src, byte) => {
  let bytes = 0;
  let i = 0;
  while (i < src.length && bytes < byte) {
    const cp = src.codePointAt(i);
    bytes += Buffer.byteLength(String.fromCodePoint(cp), 'utf8');
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
};
const at16 = toUnits(target.body, at);

// The slice starts at a write of the value's key (the one nearest the offset), or, when the offset is a frame of the
// stack that sent the call, at the function that frame is in: the innermost one around it.
let best = null;
let fn = null;
let write = null;
if (spec.frame) {
  walk(ast, (node) => {
    if (isFn(node) && node.start <= at16 && at16 < node.end && (!fn || node.end - node.start <= fn.end - fn.start)) fn = node;
  }, []);
  write = fn || (ast.body || []).find((s) => s.start <= at16 && at16 < s.end);
  if (!write) done({ error: 'no code at the frame' });
} else {
  walk(ast, (node, ancestors) => {
    if (!isWrite(node)) return;
    const d = Math.abs(node.start - at16);
    if (!best || d < best.d) best = { node, ancestors: ancestors.concat([node]), d };
  }, []);
  if (!best) done({ error: 'no write site near the offset' });
  fn = best.ancestors.slice().reverse().find(isFn);
  write = fn || best.node;
}

// The names a function uses that it does not declare: the code it calls, from elsewhere.
function freeNames(root) {
  const declared = new Set();
  const refs = [];
  const globals = new Set(('window,document,this,true,false,null,undefined,var,let,const,new,typeof,async,await,else,for,while,catch,try,throw,from,require,default,toString,prototype,length,string,number,object,value,type,then,push,shift,charAt,slice,substr,substring,replace,split,join,parse,stringify,encode,decode,getItem,setItem,addEventListener,removeEventListener,setTimeout,clearTimeout,console,Math,Date,JSON,URL,Error,Array,Object,String,Number,Boolean,Promise,location,navigator,module,exports,globalThis,self,arguments').split(','));
  const addPattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') declared.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => addPattern(q.value || q.argument));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  walk(root, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      (node.params || []).forEach(addPattern);
      if (node.id && node.id.name) declared.add(node.id.name);
    }
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') if (node.id) declared.add(node.id.name);
    if (node.type === 'CatchClause') addPattern(node.param);
    if (node.type === 'Identifier') {
      const key = parent && parent.type === 'Property' && parent.key === node && !parent.computed;
      const onGlobal = parent && parent.type === 'MemberExpression' && parent.object && parent.object.type === 'Identifier' && /^(window|self|globalThis|module|exports)$/.test(parent.object.name);
      const member = parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed && !onGlobal;
      const label = parent && (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement');
      const declId = parent && ((parent.type === 'VariableDeclarator' && parent.id === node) || ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && parent.id === node));
      if (!key && !member && !label && !declId) refs.push(node.name);
    }
  }, []);
  return refs.filter((n) => n.length >= 3 && !declared.has(n) && !globals.has(n) && !globals.has(n.toLowerCase()));
}

const names = freeNames(write);

// Where a name is defined: a declaration, an assignment to it, a `window.<name> =`, or an export key.
function findDef(tree, name) {
  let found = null;
  const want = fold(name);
  walk(tree, (node) => {
    if (found) return;
    const id = (n) => n && n.type === 'Identifier' && (n.name === name || fold(n.name) === want);
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && id(node.id)) found = node;
    else if (node.type === 'VariableDeclarator' && id(node.id)) found = node;
    else if (node.type === 'AssignmentExpression') {
      const l = node.left;
      if (id(l)) found = node;
      else if (l && l.type === 'MemberExpression' && !l.computed && id(l.object) && /^(window|self|module|exports)$/.test(l.object.name)) found = node;
      else if (l && l.type === 'MemberExpression' && !l.computed && l.object && l.object.type === 'Identifier' && /^(window|self|module|exports)$/.test(l.object.name) && l.property && l.property.type === 'Identifier' && fold(l.property.name) === want) found = node;
    } else if (node.type === 'Property' && !node.computed) {
      const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'Literal' ? String(node.key.value) : '';
      if (key && fold(key) === want) found = node;
    }
  }, []);
  return found;
}

// The top-level statement a node sits in: the unit to carry from a big script.
function topStatement(tree, pos) {
  for (const s of tree.body || []) if (s.start <= pos && pos < s.end) return s;
  return null;
}

const pieces = [{ url: scriptUrl, from: toBytes(target.body, write.start), to: toBytes(target.body, write.end), name: spec.frame ? 'where the call was sent' : 'write site' }];
const parsed = new Map();
scripts.forEach((s) => parsed.set(s.url, parse(s.body)));
const order = scripts.slice().sort((a, b) => a.body.length - b.body.length);
const seen = new Set();
for (const name of names) {
  if (seen.has(name)) continue;
  seen.add(name);
  for (const s of order) {
    const tree = parsed.get(s.url);
    if (!tree) continue;
    const def = findDef(tree, name);
    if (!def) continue;
    if (s.body.length <= WHOLE) {
      pieces.push({ url: s.url, from: 0, to: Buffer.byteLength(s.body, 'utf8'), name });
    } else {
      const stmt = topStatement(tree, def.start) || def;
      if (!stmt) continue;
      pieces.push({ url: s.url, from: toBytes(s.body, stmt.start), to: toBytes(s.body, stmt.end), name });
    }
    break;
  }
}
// How the function is called: which variable holds the request (the object of `<x>.headers[...] = …`), where it
// comes from (`this`, a parameter, or a local alias), and the function's parameters in order.
// A frame has no write site: the sending function is run whole and the request it sends is read off its network, so
// the one thing a caller needs of it is its parameters, to know where the caller's value goes.
if (!best) done({ pieces, call: { request: '', source: '', params: (fn && fn.params || []).map((p) => (p.type === 'Identifier' ? p.name : '')) } });
let reqExpr = best.node.left.object;
while (reqExpr && reqExpr.type === 'MemberExpression') reqExpr = reqExpr.object;
let request = reqExpr && reqExpr.type === 'Identifier' ? reqExpr.name : reqExpr && reqExpr.type === 'ThisExpression' ? 'this' : '';
let source = request;
let params = [];
if (fn) {
  params = (fn.params || []).map((p) => (p.type === 'Identifier' ? p.name : ''));
  if (request && request !== 'this' && !params.includes(request)) {
    walk(fn, (n) => {
      if (n.type === 'VariableDeclarator' && n.id && n.id.name === request && n.init) {
        if (n.init.type === 'ThisExpression') source = 'this';
        else if (n.init.type === 'Identifier') source = n.init.name;
      }
    }, []);
  }
}
done({ pieces, call: { request, source, params } });
