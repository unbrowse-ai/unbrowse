//! Picking out the bits of a page's code a producer needs: the write site, the functions it calls, the module that
//! defines them, and the code that initializes them. A page's bundle runs to megabytes; a producer is a few functions.
//!
//! Nothing here knows a site. The slice starts at the place the walk found the value being written, takes the
//! enclosing function or statement, reads the names it uses, and follows each one to the code that defines it — in
//! this script or another the page loaded. The result is what an agent (or a call) reads: the code that makes the
//! value, and as little of the rest as the walk can tell.

use std::collections::HashSet;

use crate::signing::Producer;

/// The parser helper and its vendored parser, written to a temp dir and run by the node runtime the signing bridge
/// uses. Acorn gives exact ranges and scope; the scanner below is the fallback when no runtime is on the machine.
const AST_HELPER: &str = include_str!("slice_ast.js");
const ACORN: &str = include_str!("acorn.js");
/// The helper that lists a script's string literals for the digest search (`literals`).
const LITERALS_HELPER: &str = include_str!("slice_literals.js");

/// The longest string literal the digest search is offered as a constant. A salt or key a page ships is short; a
/// literal past this is a template, a URL or minified data, not a thing a signature is hashed over. Said here so the
/// bound is one number: 64, which also covers a hex key the width of the hash itself.
pub const LITERAL_MAX: usize = 64;

/// The string literals of one script, read with the engine's own parser (the vendored acorn, tokenized through the
/// node runtime the signing bridge uses): distinct values of 1 to [`LITERAL_MAX`] characters, in first-seen order.
/// Empty when no runtime that can be held is on the machine or the script does not tokenize — the caller then offers
/// no constant, and the search is as it was. A template literal is not a string here: a hashed constant is a plain
/// string.
pub fn literals(body: &str) -> Vec<String> {
    // The script is a site's, so the helper runs where page code runs: confined, bounded, in a private run folder
    // made fresh for it (`sandbox::run_helper`).
    let spec = serde_json::json!({ "body": body, "max": LITERAL_MAX }).to_string();
    let files: [(&str, &[u8]); 3] = [("acorn.js", ACORN.as_bytes()), ("slice_literals.js", LITERALS_HELPER.as_bytes()), ("spec.json", spec.as_bytes())];
    let said = crate::sandbox::run_helper("literals", &files, "slice_literals.js", &["spec.json"], HELPER_WALL).and_then(|out| serde_json::from_slice::<serde_json::Value>(&out).ok());
    said.and_then(|s| Some(s.get("literals")?.as_array()?.iter().filter_map(|v| v.as_str().map(String::from)).collect())).unwrap_or_default()
}

/// How much code a slice may carry. A producer is a few functions; a route's evidence stays an exchange, not a walk.
const CAP: usize = 192 * 1024;
/// A script under this is carried whole when it defines a name: a module is a unit, and a slice of minified code is
/// not a statement.
const WHOLE: usize = 128 * 1024;

/// One piece of a page's code: where it is, why it is here, and its source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Piece {
    pub script: String,
    pub from: usize,
    pub to: usize,
    /// The write site, or the name whose definition this piece is.
    pub name: String,
    pub src: String,
}

/// How the write site's function is called: the variable that holds the request, where it comes from (`this`, a
/// parameter, or a local alias), and the function's parameters in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Call {
    pub request: String,
    pub source: String,
    pub params: Vec<String>,
}

/// The code a producer needs, in the order it was found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Slice {
    pub pieces: Vec<Piece>,
    pub bytes: usize,
    /// Set by the parser when it can read the write site's call; the assembler uses it to pass the request where the
    /// function expects it.
    pub call: Option<Call>,
}

impl Slice {
    /// The slice as an agent reads it: each piece under a line saying where it is and why.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for p in &self.pieces {
            out.push_str(&format!("// {} @ {}..{} ({})\n{}\n", p.script, p.from, p.to, p.name, p.src));
        }
        out
    }

    fn push(&mut self, script: &str, (from, to): (usize, usize), src: String, name: &str) {
        if src.trim().is_empty() || self.bytes + src.len() > CAP {
            return;
        }
        // The same script, again: a range already held is not carried twice.
        if self.pieces.iter().any(|p| p.script == script && from >= p.from && to <= p.to) {
            return;
        }
        self.bytes += src.len();
        self.pieces.push(Piece { script: script.to_string(), from, to, name: name.to_string(), src });
    }
}

/// Where a stack frame sits in its script, as the offset a slice starts from. The browser counts a frame by line and
/// column, both from zero, and the column in UTF-16 units; a script is sliced by bytes. A minified bundle is one
/// line a megabyte long, so the column does the work. None when the script has no such place: the frame is of
/// another version of the script than the one the walk kept.
pub fn offset_at(body: &str, line: u32, column: u32) -> Option<usize> {
    let mut start = 0;
    for _ in 0..line {
        start += body[start..].find('\n')? + 1;
    }
    let text = body[start..].split('\n').next().unwrap_or_default();
    let mut units = 0u32;
    for (at, c) in text.char_indices() {
        if units >= column {
            return Some(start + at);
        }
        units += c.len_utf16() as u32;
    }
    (units == column).then_some(start + text.len())
}

/// The code the write site at `producer` needs, followed from the names it uses.
pub fn of(scripts: &[(&str, &str)], producer: &Producer) -> Slice {
    if let Some(slice) = parsed(scripts, producer) {
        return slice;
    }
    let mut slice = Slice::default();
    let Some((url, body)) = scripts.iter().find(|(u, _)| *u == producer.script) else { return slice };
    let Some(site) = around(body, producer.at, false) else { return slice };
    slice.push(url, (site.0, site.1), site.2.clone(), "write site");
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: Vec<(String, usize)> = Vec::new();
    names(&site.2, &mut queue);
    // A definition may itself call something: follow two steps out. That covers a write site's encoder and the helper
    // the encoder hashes with; a deeper chain is the page's framework, not the producer.
    while let Some((name, depth)) = queue.pop() {
        if depth > 2 || slice.bytes >= CAP {
            break;
        }
        if !seen.insert(name.clone()) {
            continue;
        }
        // The smallest script that defines the name: a module's own file is usually the smallest, and including it
        // whole keeps a UMD wrapper and its exports together — a fragment of minified code is not a statement.
        let mut order: Vec<usize> = (0..scripts.len()).collect();
        order.sort_by_key(|&i| scripts[i].1.len());
        for i in order {
            let (script, src) = scripts[i];
            let Some(at) = defines(src, &name) else { continue };
            let (span, text) = if src.len() <= WHOLE {
                ((0, src.len()), src.to_string())
            } else {
                let Some(piece) = around(src, at, true) else { continue };
                ((piece.0, piece.1), piece.2)
            };
            // A fragment of a big bundle is carried only if it is a statement: an object property (`cSign:l`) or an
            // anonymous function is not one, and words of it at the top level are a syntax error, not a producer.
            if src.len() > WHOLE && !plausible(&text) {
                continue;
            }
            let mut more = Vec::new();
            names(&text, &mut more);
            slice.push(script, span, text, &name);
            for (n, _) in more {
                queue.push((n, depth + 1));
            }
            break;
        }
    }
    slice
}

/// The slice from the parser helper: acorn parses the scripts, finds the write site, and reads its free names to their
/// definitions. None when no runtime is on the machine or the helper can't answer, and the scanner below carries on.
fn parsed(scripts: &[(&str, &str)], producer: &Producer) -> Option<Slice> {
    // The scripts are the page's, so the parser runs where page code runs: confined, bounded, in a private run folder
    // made fresh for it (`sandbox::run_helper`), never in a shared folder by a name someone could plant first.
    let spec = serde_json::json!({
        "scripts": scripts.iter().map(|(url, body)| serde_json::json!({ "url": url, "body": body })).collect::<Vec<_>>(),
        "script": producer.script,
        "at": producer.at,
        "frame": producer.frame,
    })
    .to_string();
    let files: [(&str, &[u8]); 3] = [("acorn.js", ACORN.as_bytes()), ("helper.js", AST_HELPER.as_bytes()), ("spec.json", spec.as_bytes())];
    let out = crate::sandbox::run_helper("slice", &files, "helper.js", &["spec.json"], HELPER_WALL)?;
    let said: serde_json::Value = serde_json::from_slice(&out).ok()?;
    let mut slice = Slice::default();
    for p in said.get("pieces")?.as_array()? {
        let url = p.get("url")?.as_str()?;
        let from = p.get("from")?.as_u64()? as usize;
        let to = p.get("to")?.as_u64()? as usize;
        let name = p.get("name").and_then(|n| n.as_str()).unwrap_or_default();
        let Some((_, body)) = scripts.iter().find(|(u, _)| *u == url) else { continue };
        if from <= to && to <= body.len() && body.is_char_boundary(from) && body.is_char_boundary(to) {
            slice.push(url, (from, to), body[from..to].to_string(), name);
        }
    }
    slice.call = said.get("call").and_then(|c| {
        let request = c.get("request")?.as_str()?.to_string();
        let source = c.get("source").and_then(|s| s.as_str()).unwrap_or(&request).to_string();
        let params = c.get("params")?.as_array()?.iter().filter_map(|p| p.as_str().map(String::from)).collect();
        Some(Call { request, source, params })
    });
    (!slice.pieces.is_empty()).then_some(slice)
}

/// How long the parser helper may take over one producer's scripts before it is killed and the scanner carries on.
const HELPER_WALL: std::time::Duration = std::time::Duration::from_secs(30);

/// The function or statement `at` sits in, as (from, to, source). A function whose braces enclose `at` is the unit;
/// without one, the statement between `;`/`,` at the same depth; failing that, the line.
fn around(src: &str, at: usize, definition: bool) -> Option<(usize, usize, String)> {
    let at = at.min(src.len());
    // A definition is the statement that binds the name: `function f(){…}`, `var f=function(){…}`, so its whole body
    // is carried, not the first line of it.
    if definition {
        let head = src[at..].trim_start();
        let starts = head.starts_with("function") || head.starts_with("async function") || head.starts_with("var ") || head.starts_with("let ") || head.starts_with("const ") || head.starts_with("class ");
        if starts {
            if let Some(span) = statement_span(src, at) {
                return Some((span.0, span.1, src[span.0..span.1].to_string()));
            }
        }
    }
    if let Some(span) = enclosing_function(src, at) {
        return Some((span.0, span.1, src[span.0..span.1].to_string()));
    }
    if let Some(span) = enclosing_brace(src, at) {
        return Some((span.0, span.1, src[span.0..span.1].to_string()));
    }
    let start = src[..at].rfind([';', '\n']).map(|i| i + 1).unwrap_or(0);
    let end = src[at..].find([';', '\n']).map(|i| at + i + 1).unwrap_or(src.len());
    Some((start, end, src[start..end].to_string()))
}

/// The statement that starts at `at`, through its matching braces: a function declaration to its closing brace, an
/// assignment to its `;`, and a value that ends without one to its last brace.
fn statement_span(src: &str, at: usize) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut close = None;
    let mut i = at;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                if depth == 0 {
                    return Some((at, i + 1));
                }
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                }
            }
            b';' if depth == 0 => return Some((at, i + 1)),
            b'\'' | b'"' | b'`' => {
                let quote = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == quote {
                        break;
                    }
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                i = src[i..].find('\n').map(|n| i + n).unwrap_or(bytes.len());
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = src[i..].find("*/").map(|n| i + n + 1).unwrap_or(bytes.len());
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    close.map(|c| (at, c + 1))
}

/// The nearest `function` whose body encloses `at`: its `(from, to)`, from the keyword to the matching brace.
fn enclosing_function(src: &str, at: usize) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let mut search = at;
    loop {
        let head = src[..search].rfind("function")?;
        // The keyword must be a word: not `myfunction`.
        let before = head.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        if before.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$') {
            search = head;
            continue;
        }
        // From `function`, the first `{` opens the body; `at` must be inside its match.
        let open = src[head..].find('{').map(|i| head + i)?;
        if open > at {
            search = head;
            continue;
        }
        let Some(close) = matching_brace(src, open) else { search = head; continue };
        if close >= at {
            return Some((head, close + 1));
        }
        search = head;
    }
}

/// The nearest `{` whose matching `}` encloses `at`.
fn enclosing_brace(src: &str, at: usize) -> Option<(usize, usize)> {
    let mut search = at;
    while let Some(open) = src[..search].rfind('{') {
        if let Some(close) = matching_brace(src, open) {
            if close >= at {
                return Some((open, close + 1));
            }
        }
        if open == 0 {
            break;
        }
        search = open;
    }
    None
}

/// The `}` matching the `{` at `open`, skipping string literals and comments.
fn matching_brace(src: &str, open: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'\'' | b'"' | b'`' => {
                let quote = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == quote {
                        break;
                    }
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                i = src[i..].find('\n').map(|n| i + n).unwrap_or(bytes.len());
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = src[i..].find("*/").map(|n| i + n + 1).unwrap_or(bytes.len());
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The names a piece of code uses: identifiers long enough to mean something, without the language's words and the
/// browser's globals (which are never a producer's definition in a bundle).
fn names(code: &str, out: &mut Vec<(String, usize)>) {
    let mut word = String::new();
    for ch in code.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            word.push(ch);
        } else {
            push_name(std::mem::take(&mut word), out);
        }
    }
    push_name(word, out);
}

fn push_name(w: String, out: &mut Vec<(String, usize)>) {
    if w.len() >= 3 && !COMMON.iter().any(|c| c.eq_ignore_ascii_case(&w)) && !out.iter().any(|(n, _)| *n == w) {
        out.push((w, 0));
    }
}

const COMMON: &[&str] = &[
    "function", "return", "window", "document", "this", "true", "false", "null", "undefined", "var", "let", "const",
    "new", "typeof", "async", "await", "else", "for", "while", "catch", "try", "throw", "from", "require", "default",
    "toString", "prototype", "length", "string", "number", "object", "value", "type", "then", "push", "shift", "charAt",
    "slice", "substr", "substring", "replace", "split", "join", "parse", "stringify", "encode", "decode", "getItem",
    "setItem", "addEventListener", "removeEventListener", "setTimeout", "clearTimeout", "console", "Math", "Date", "JSON",
    "URL", "Error", "Array", "Object", "String", "Number", "Boolean", "Promise", "document", "location", "navigator",
];

/// Whether a piece is a statement, not a fragment: a declaration, an assignment, a call, a block. An object property
/// (`cSign:l`) and an anonymous function are fragments.
fn plausible(text: &str) -> bool {
    let t = text.trim_start();
    for head in ["function ", "async function ", "var ", "let ", "const ", "class ", "!", "(", "{", "[", "if ", "for ", "while ", "return ", "try ", "switch ", "setTimeout", "window."] {
        if t.starts_with(head) {
            return true;
        }
    }
    // `name = …`, `name.prop = …`: an assignment, not a key.
    t.find('=').is_some_and(|eq| {
        let lhs = t[..eq].trim();
        !lhs.is_empty() && !lhs.contains(':') && lhs.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.')
    })
}

/// Where a script defines `name`, by the forms a definition takes in a bundle: a function, an assignment, a
/// `var`/`let`/`const`, a quoted key, a property, or a `window.<name>` assignment. A name is read with its case and
/// underscores folded, so a module's `cSign` is found for a write site's `c_sign`.
pub(crate) fn defines(src: &str, name: &str) -> Option<usize> {
    let groups: [Vec<String>; 5] = [
        vec![format!("function {name}"), format!("{name}=function"), format!("{name} = function"), format!("{name}:function"), format!("{name}: function")],
        vec![format!("var {name}"), format!("let {name}"), format!("const {name}")],
        vec![format!("\"{name}\""), format!("'{name}'")],
        vec![format!(".{name}="), format!(".{name} ="), format!("window.{name}="), format!("window.{name} ="), format!("self.{name}="), format!("self.{name} =")],
        vec![format!("{name}="), format!("{name} =")],
    ];
    for group in groups {
        if let Some(at) = group.iter().filter_map(|p| src.find(p)).min() {
            return Some(at);
        }
    }
    let folded: String = name.chars().filter(|c| *c != '_' && *c != '$').collect::<String>().to_ascii_lowercase();
    if folded.len() >= 3 && folded != name.to_ascii_lowercase() {
        if let Some(at) = find_ci(src, &folded) {
            return Some(at);
        }
    }
    None
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let n = needle.as_bytes();
    (!n.is_empty()).then(|| hay.as_bytes().windows(n.len()).position(|w| w.eq_ignore_ascii_case(n))).flatten()
}

/// A program built from the slice: the definitions it found, a bridge for a module's export under the name the write
/// site calls, and the write site itself, called with a request and a context. No model is in this: the page's own
/// code is lifted and run. The verifier (or a call) still decides whether the value it makes is the right one.
///
/// The write site is the function around it; it is called with the request as both `this` and its first argument, and
/// a context as the second, as the page calls it (`i(t, e)`). The header it sets on the request is the answer.
pub fn assemble(scripts: &[(&str, &str)], producer: &Producer, header: &str) -> Option<String> {
    let slice = of(scripts, producer);
    let site = slice.pieces.first()?;
    let src = site.src.trim();
    if src.is_empty() || !src.contains(header) {
        return None;
    }
    // The write site's function: the slice's first piece is the function around it, or a statement to wrap.
    let producer_fn = if src.starts_with("function") || src.starts_with("async function") || (src.contains("=>") && !src.starts_with('{')) {
        format!("var __unbrowse_producer = {src};")
    } else {
        format!("var __unbrowse_producer = function(__unbrowse_req, __unbrowse_ctx) {{ {src} }};")
    };
    // The names the write site calls on `window` (c_sign, say): a module's export is put there under the folded name.
    let wants: Vec<String> = window_names(src);
    let wanted = serde_json::to_string(&wants).ok()?;
    // A global the definitions bind under another spelling (`function cSign`) is bridged to the write site's name
    // (`window.c_sign`): the page's loader did that, and the lifted code needs it too.
    let defs_text: String = slice.pieces.iter().skip(1).rev().map(|p| p.src.as_str()).collect::<Vec<_>>().join("\n");
    let mut globals: Vec<(String, String)> = Vec::new();
    for key in ["function ", "var ", "let ", "const "] {
        let mut rest = defs_text.as_str();
        while let Some(at) = rest.find(key) {
            let after = &rest[at + key.len()..];
            let name: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
            if name.len() >= 3 && !globals.iter().any(|(n, _)| *n == name) {
                globals.push((name, key.trim().to_string()));
            }
            rest = after;
        }
    }
    let mut bridge = String::new();
    for want in &wants {
        let f = want.replace('_', "").to_ascii_lowercase();
        for (name, _) in &globals {
            if name.replace('_', "").to_ascii_lowercase() == f {
                bridge.push_str(&format!("if (typeof window !== 'undefined' && window[{}] === undefined && typeof {} !== 'undefined') window[{}] = {};\n", serde_json::to_string(want).ok()?, name, serde_json::to_string(want).ok()?, name));
            }
        }
    }
    // The write site's request is passed where its function expects it: the parameter the assignment reads (or
    // `this` when the assignment reads a local alias of it). A context takes the first other parameter.
    let (this_arg, args) = match &slice.call {
        Some(c) if !c.params.is_empty() => {
            let mut args = Vec::new();
            let mut ctx = false;
            for p in &c.params {
                if *p == c.request || *p == c.source {
                    args.push("__unbrowse_req");
                } else if !ctx {
                    args.push("__unbrowse_ctx");
                    ctx = true;
                } else {
                    args.push("undefined");
                }
            }
            (if c.source == "this" { "__unbrowse_req" } else { "null" }, args.join(", "))
        }
        Some(c) if c.source == "this" => ("__unbrowse_req", String::new()),
        _ => ("__unbrowse_req", "__unbrowse_req, __unbrowse_ctx".to_string()),
    };
    // Definitions come before the write site; a definition that calls another goes after it, so reverse the discovery
    // order (the slice found the write site's callee first, then its callee's callee).
    let defs: String = slice.pieces.iter().skip(1).rev().map(|p| format!("{}\n", p.src)).collect();
    Some(alias_primitives(&format!(
        r#"{defs}
{bridge}
if (typeof module !== 'undefined' && module.exports && typeof module.exports === 'object') {{
  var __unbrowse_want = {wanted};
  for (var __unbrowse_k in module.exports) {{
    var __unbrowse_f = String(__unbrowse_k).replace(/_/g, '').toLowerCase();
    for (var __unbrowse_i = 0; __unbrowse_i < __unbrowse_want.length; __unbrowse_i++) {{
      var __unbrowse_w = __unbrowse_want[__unbrowse_i];
      if (String(__unbrowse_w).replace(/_/g, '').toLowerCase() === __unbrowse_f && typeof window !== 'undefined' && window[__unbrowse_w] === undefined) {{
        window[__unbrowse_w] = module.exports[__unbrowse_k];
      }}
    }}
  }}
}}
{producer_fn}
function sign(ctx) {{
  var __unbrowse_req = {{ body: ctx.body, headers: {{}}, url: ctx.url, method: ctx.method, path: ctx.path, search: ctx.search, cookies: ctx.cookies || {{}}, headersIn: ctx.headers || {{}} }};
  var __unbrowse_ctx = {{ headers: {{}}, body: ctx.body, url: ctx.url, set: function () {{}}, get: function () {{ return undefined; }}, force: false }};
  try {{ __unbrowse_producer.apply({this_arg}, [{args}]); }} catch (e) {{}}
  var __unbrowse_v = __unbrowse_req.headers[{header_j}] !== undefined ? __unbrowse_req.headers[{header_j}]
    : (__unbrowse_req[{header_j}] !== undefined ? __unbrowse_req[{header_j}] : __unbrowse_ctx.headers[{header_j}]);
  if (__unbrowse_v === undefined) throw new Error('the page code set no {header}');
  return String(__unbrowse_v);
}}
"#,
        header_j = serde_json::to_string(header).ok()?,
    )))
}

/// A program that reproduces a request header a page's own sending function set, when the function sets it inside the
/// request it sends (a `fetch(url, { headers })` option, not a `req.headers[k] = …` assignment the write-site
/// [`assemble`] reads): the sending function and what it calls are defined from `slice`, its network is captured, and
/// the function is run with the caller's word in parameter `arg`, the rest left as no-ops; the header it set on the
/// request it sent is the answer.
///
/// The sending function is reached two ways, so its own helpers are in hand whether the script exports it or keeps it
/// private: a function the script newly put on `window` when it ran (an IIFE's `window.searchSigned = …`, where the
/// helper it calls is a closure of the same scope), and failing that the function the slice cut whole (a top-level
/// definition, whose helpers are top-level too). Each is tried until one sets the header.
///
/// `word` is JavaScript that reads the caller's value from `ctx` (the call as it stands), so the function is run with
/// the word this call carries, and a call for another word is signed for that word. `header` is the value's own name,
/// lowercased to match. None when the slice has no sending function to run.
///
/// Nothing here is a model or a site's name: the page's own function is lifted ([`of`]) and run; the verifier (or a
/// call) decides whether what it makes is the value the site accepts.
pub fn assemble_sender(slice: &Slice, header: &str, word: &str, arg: usize) -> Option<String> {
    let site = slice.pieces.first()?;
    let src = site.src.trim();
    // The sending function the slice cut whole: the frame piece is the function expression (`function (q, done) {…}`),
    // or a named declaration, either bound to `__unbrowse_fallback`. A statement that is no function is no sender.
    let is_fn = src.starts_with("function") || src.starts_with("async function") || (src.contains("=>") && !src.starts_with('{'));
    if !is_fn {
        return None;
    }
    let fallback = format!("var __unbrowse_fallback = {src};");
    // What it calls (the hash, the mixer) and the script that defines it, in discovery order reversed so a definition
    // that calls another comes after it, as [`assemble`] does. The script may be the whole IIFE that also sets the
    // sender on `window`; running it is how a private helper comes into the sender's closure.
    let defs: String = slice.pieces.iter().skip(1).rev().map(|p| format!("{}\n", p.src)).collect();
    let header_j = serde_json::to_string(&header.to_ascii_lowercase()).ok()?;
    Some(alias_primitives(&format!(
        r#"var __unbrowse_before = (typeof window !== 'undefined') ? Object.keys(window).slice() : [];
{defs}
{fallback}
function sign(ctx) {{
  var __unbrowse_captured = {{}};
  var __unbrowse_grab = function (opts) {{
    if (!opts || !opts.headers) return;
    var h = opts.headers;
    if (typeof h.forEach === 'function') {{ h.forEach(function (v, k) {{ __unbrowse_captured[String(k).toLowerCase()] = String(v); }}); }}
    else {{ for (var __k in h) __unbrowse_captured[String(__k).toLowerCase()] = String(h[__k]); }}
  }};
  var __unbrowse_stub = {{ then: function () {{ return __unbrowse_stub; }}, catch: function () {{ return __unbrowse_stub; }}, finally: function () {{ return __unbrowse_stub; }}, json: function () {{ return __unbrowse_stub; }}, text: function () {{ return __unbrowse_stub; }} }};
  var __unbrowse_fetch = function (u, o) {{ __unbrowse_grab(o); return __unbrowse_stub; }};
  fetch = __unbrowse_fetch;
  if (typeof globalThis !== 'undefined') globalThis.fetch = __unbrowse_fetch;
  var __unbrowse_word = (function () {{ try {{ return {word}; }} catch (e) {{ return undefined; }} }})();
  var __unbrowse_args = [];
  __unbrowse_args[{arg}] = __unbrowse_word;
  for (var __i = 0; __i < __unbrowse_args.length; __i++) {{ if (__unbrowse_args[__i] === undefined) __unbrowse_args[__i] = function () {{}}; }}
  // The functions the script newly set on `window` (keeping their own helpers in scope), then the one cut whole.
  var __unbrowse_fns = [];
  if (typeof window !== 'undefined') {{
    var __unbrowse_now = Object.keys(window);
    for (var __j = 0; __j < __unbrowse_now.length; __j++) {{
      var __unbrowse_k = __unbrowse_now[__j];
      if (__unbrowse_before.indexOf(__unbrowse_k) < 0 && typeof window[__unbrowse_k] === 'function') __unbrowse_fns.push(window[__unbrowse_k]);
    }}
  }}
  __unbrowse_fns.push(__unbrowse_fallback);
  for (var __f = 0; __f < __unbrowse_fns.length; __f++) {{
    __unbrowse_captured = {{}};
    try {{ __unbrowse_fns[__f].apply(null, __unbrowse_args); }} catch (e) {{}}
    if (__unbrowse_captured[{header_j}] !== undefined) break;
  }}
  var __unbrowse_v = __unbrowse_captured[{header_j}];
  if (__unbrowse_v === undefined) throw new Error('the sending function set no ' + {header_j});
  return String(__unbrowse_v);
}}
"#,
    )))
}

/// A program that makes a header's value by calling the page's own function for it, where the write site is the
/// awaited answer of a module's export (`h["x-sig"] = await a(t.host, t.path, t.method)`). The page's scripts run first
/// (the page-shaped sandbox boots them), and the program reaches the page's module registry the way a chunk the page
/// loads does: through the bundle's chunk array, the global array whose `push` the page's runtime replaced, which hands
/// its `require` to a chunk it is pushed. The module, the export and the arguments are read from the write site: the
/// module is the one whose body holds it, the export the name that module gives the function it calls, and each
/// argument a field of the request the write site was handed (its host, path, method, address, body), filled from the
/// call. Nothing names a site, a module or a bundler. None where the write site calls no export of its own module, or
/// hands it something that is not the request's own.
///
/// The value may be made after a chunk loads (`await` on first use): the program answers a promise, and the runner
/// waits for it. The site's answer judges the value, as for every program.
pub fn module_call(scripts: &[(&str, &str)], producer: &Producer, header: &str) -> Option<String> {
    page_function(scripts, producer, header).map(|f| render(&f))
}

/// The page function at a value's write site, as data (`module_call` says what it reads): None where the write site
/// calls no export of its own module, or hands it something that is not the request's own.
pub fn page_function(scripts: &[(&str, &str)], producer: &Producer, header: &str) -> Option<crate::graph::PageFunction> {
    let (_, body) = scripts.iter().find(|(u, _)| *u == producer.script)?;
    let at = producer.at;
    // `["header"] =`, then the called function and its arguments.
    let rest = body.get(at + header.len()..)?.get(1..)?.trim_start().strip_prefix(']')?.trim_start().strip_prefix('=')?;
    if rest.starts_with('=') || rest.starts_with('>') {
        return None;
    }
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("await").map(str::trim_start).unwrap_or(rest);
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))?;
    let func = &rest[..end];
    if func.is_empty() || func.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let args_at = rest[end..].trim_start().strip_prefix('(')?;
    let args_src = &args_at[..closing_paren(args_at)?];
    let args: Vec<crate::graph::Arg> = top_level_args(args_src).iter().map(|a| request_field(a.trim())).collect::<Option<_>>()?;
    let (id, start, close) = enclosing_module(body, at)?;
    let export = exported_as(&body[start..close], func)?;
    Some(crate::graph::PageFunction { module: id.trim_matches('"').to_string(), export, args })
}

/// The program that calls a page function on the booted page with a call's own fields (`sign(ctx)`): the registry is
/// the global array whose `push` the page's runtime replaced, which hands its `require` to a chunk it is pushed, once.
/// The program is the engine's, written from the route's data; the route carries none (R2.7).
/// The value a function of the page's own script makes, run on the page `env` holds (its address, markup, answers,
/// scripts, browser and storage), handed `ctx` as the call's fields: the one runner of a page's function, for the
/// graph's caller and the body's alike. None when no page code runs here, or the page's code made nothing.
pub fn call(f: &crate::graph::PageFunction, ctx: &serde_json::Value, env: &crate::generated::Environment) -> Option<String> {
    use crate::graph::{Arg, CallField};
    // Each argument as the text it comes to for this call, so the graph's caller and the body's run one program, on one
    // page kept booted (`call_given`). The headers, which a page hands as an object, are no text: that call is
    // rendered with the call's fields instead.
    let field = |name: &str| ctx.get(name).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let given: Option<Vec<String>> = f
        .args
        .iter()
        .map(|a| match a {
            Arg::Literal { value } => Some(value.clone()),
            Arg::Call { field: CallField::Origin } => Some(field("origin")),
            Arg::Call { field: CallField::Host } => Some(field("host")),
            Arg::Call { field: CallField::Path } => Some(field("path")),
            Arg::Call { field: CallField::Method } => Some(field("method")),
            Arg::Call { field: CallField::Url } => Some(field("url")),
            Arg::Call { field: CallField::Search } => Some(field("search")),
            Arg::Call { field: CallField::Body } => Some(field("body")),
            Arg::Call { field: CallField::Headers } => None,
        })
        .collect();
    match given {
        Some(args) => call_given(&f.module, &f.export, &args, env),
        None => run(&render(f), ctx, env),
    }
}

/// The value export `export` of the page's module `module` makes, handed `args` as they are (each already made for
/// this call), run on the page `env` holds: the body's way of calling a page's function (`Expr::Function`). The
/// program is the same for every call, its arguments ride in the call's fields, so the page booted for it is kept.
pub fn call_given(module: &str, export: &str, args: &[String], env: &crate::generated::Environment) -> Option<String> {
    let given: Vec<String> = (0..args.len()).map(|i| format!("ctx.args[{i}]")).collect();
    run(&render_with(module, export, &given), &serde_json::json!({ "args": args }), env)
}

/// A page function's program run for one call, on the page `env` holds, kept booted between calls
/// (`sandbox::run_program_on_page_warm`).
fn run(program: &str, ctx: &serde_json::Value, env: &crate::generated::Environment) -> Option<String> {
    let page = env.page_url.as_deref()?;
    if env.scripts.is_empty() {
        return None;
    }
    let html = env.html.clone().unwrap_or_default();
    crate::sandbox::run_program_on_page_warm(program, ctx, &env.fingerprint, &env.storage, page, &html, &env.answers, &env.scripts).ok().filter(|v| !v.is_empty() && v != "undefined")
}

pub fn render(f: &crate::graph::PageFunction) -> String {
    use crate::graph::{Arg, CallField};
    let args: Vec<String> = f
        .args
        .iter()
        .map(|a| match a {
            Arg::Literal { value } => serde_json::to_string(value).unwrap_or_default(),
            Arg::Call { field } => match field {
                CallField::Origin => "ctx.origin",
                CallField::Host => "ctx.host",
                CallField::Path => "ctx.path",
                CallField::Method => "ctx.method",
                CallField::Url => "ctx.url",
                CallField::Search => "ctx.search",
                CallField::Body => "ctx.body",
                CallField::Headers => "ctx.headers",
            }
            .to_string(),
        })
        .collect();
    render_with(&f.module, &f.export, &args)
}

/// The program that calls export `export` of the page's module `module` with `args`, each a JavaScript expression over
/// the call's fields (`ctx`).
fn render_with(module: &str, export: &str, args: &[String]) -> String {
    let module = if !module.is_empty() && module.chars().all(|c| c.is_ascii_digit()) { module.to_string() } else { serde_json::to_string(module).unwrap_or_default() };
    format!(
        "var __ub_f=null,__ub_n=0;function __ub_find(){{if(__ub_f)return __ub_f;var ns=Object.getOwnPropertyNames(globalThis);for(var i=0;i<ns.length;i++){{var reg;try{{reg=globalThis[ns[i]]}}catch(e){{continue}}if(!Array.isArray(reg)||typeof reg.push!=='function'||reg.push===Array.prototype.push)continue;var req=null;try{{reg.push([['__ub_call_'+i+'_'+(__ub_n++)],{{}},function(r){{req=r}}])}}catch(e){{continue}}if(typeof req!=='function')continue;var m;try{{m=req({module})}}catch(e){{continue}}var f=m&&m[{export}];if(typeof f==='function')return __ub_f=f}}return null}}function sign(ctx){{var f=__ub_find();if(!f)return '';return Promise.resolve(f({args})).then(function(v){{return v==null?'':String(v)}})}}",
        module = module,
        export = serde_json::to_string(export).unwrap_or_default(),
        args = args.join(","),
    )
}

/// The `)` that closes the call whose arguments start `src`, skipping strings and nested brackets.
fn closing_paren(src: &str) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    return (bytes[i] == b')').then_some(i);
                }
                depth -= 1;
            }
            b'\'' | b'"' | b'`' => {
                let q = bytes[i];
                i += 1;
                while i < bytes.len() && bytes[i] != q {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// A call's arguments, split at its own commas.
fn top_level_args(src: &str) -> Vec<&str> {
    let (mut out, mut depth, mut from) = (Vec::new(), 0i32, 0usize);
    let mut quote: Option<char> = None;
    for (i, c) in src.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&src[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    if !src[from..].trim().is_empty() {
        out.push(&src[from..]);
    }
    out
}

/// What one argument of the write site's call is, as the program fills it from the call: a field of the request it
/// was handed (`t.host`, `t.path`, `t.method`, its address, its body), or a literal. None for anything else.
fn request_field(arg: &str) -> Option<crate::graph::Arg> {
    use crate::graph::{Arg, CallField};
    if let Some(q) = arg.chars().next().filter(|c| *c == '"' || *c == '\'') {
        return arg.strip_prefix(q).and_then(|v| v.strip_suffix(q)).map(|v| Arg::Literal { value: v.to_string() });
    }
    if arg.parse::<f64>().is_ok() {
        return Some(Arg::Literal { value: arg.to_string() });
    }
    let (_, field) = arg.split_once('.')?;
    let field = match field {
        "host" | "origin" | "baseUrl" | "baseURL" => CallField::Origin,
        "hostname" => CallField::Host,
        "path" | "pathname" => CallField::Path,
        "method" => CallField::Method,
        "url" | "uri" | "href" => CallField::Url,
        "search" | "query" => CallField::Search,
        "body" | "data" => CallField::Body,
        "headers" => CallField::Headers,
        _ => return None,
    };
    Some(Arg::Call { field })
}

/// The module of a bundle whose body holds `at`: its id as the bundle keys it, and its body's span. A module is an
/// entry of the object a chunk pushes: `<id>(e,t,r){…}`, `<id>:function(e,t,r){…}` or `<id>:(e,t,r)=>{…}`.
fn enclosing_module(src: &str, at: usize) -> Option<(String, usize, usize)> {
    let head = regex::Regex::new(r#"(?:^|[{,])\s*(\d+|"[^"]+")\s*(?::\s*function\s*)?(?::\s*)?\(\s*[\w$]+\s*(?:,\s*[\w$]+\s*){0,2}\)\s*(?:=>\s*)?$"#).ok()?;
    let mut search = at;
    loop {
        let (open, close) = enclosing_brace(src, search)?;
        let lead = &src[open.saturating_sub(80)..open];
        if let Some(c) = head.captures(lead) {
            return Some((c.get(1)?.as_str().to_string(), open, close));
        }
        if open == 0 {
            return None;
        }
        search = open;
    }
}

/// The name a module gives `func` among its exports: `name:()=>func` in its export map, or `"name",0,func` in the
/// list form.
fn exported_as(module: &str, func: &str) -> Option<String> {
    let f = regex::escape(func);
    let map = regex::Regex::new(&format!(r#"(?:^|[{{,])\s*([\w$]+|"[^"]+")\s*:\s*\(\)\s*=>\s*{f}\b"#)).ok()?;
    let list = regex::Regex::new(&format!(r#""([^"]+)"\s*,\s*0\s*,\s*{f}\b"#)).ok()?;
    map.captures(module).or_else(|| list.captures(module)).and_then(|c| c.get(1)).map(|m| m.as_str().trim_matches('"').to_string())
}

/// A program that unpacks a reply as the page's own code does: the slice's script runs (its IIFE defines the page's
/// own decoder and exposes a search function), then that function is called with `fetch` stubbed to hand back the
/// reply and a capture in place of the callback it feeds the decoded answer to. What the callback receives is the
/// answer, read back as JSON text. The page's private decoder need not be named: it is reached through the function
/// the script exposes, exactly as the page reaches it. None when the slice carries no script. The primitives a
/// bundler hands out as module exports are aliased, as a sender's are.
pub fn assemble_decoder(scripts: &[(&str, &str)]) -> Option<String> {
    if scripts.is_empty() {
        return None;
    }
    // Each script the page loaded, run whole in load order: a bundle's IIFE exposes the search function and keeps its
    // own decoder in its closure, exactly as the page runs it. A fragment does not re-run on its own; the whole script
    // does.
    let defs: String = scripts.iter().map(|(_, body)| format!("{body}\n")).collect();
    if defs.trim().is_empty() {
        return None;
    }
    Some(alias_primitives(&format!(
        r#"var __unbrowse_before = (typeof window !== 'undefined') ? Object.keys(window).slice() : [];
{defs}
function sign(ctx) {{
  var __unbrowse_reply = String((ctx && ctx.body) || '');
  var __unbrowse_resolved = function (v) {{ return {{ then: function (f) {{ var r = f(v); return (r && typeof r.then === 'function') ? r : __unbrowse_resolved(r); }}, catch: function () {{ return this; }}, finally: function (f) {{ try {{ f(); }} catch (e) {{}} return this; }} }}; }};
  var __unbrowse_resp = {{ ok: true, status: 200, headers: {{ get: function () {{ return null; }} }}, text: function () {{ return __unbrowse_resolved(__unbrowse_reply); }}, json: function () {{ return __unbrowse_resolved(JSON.parse(__unbrowse_reply)); }}, arrayBuffer: function () {{ return __unbrowse_resolved(__unbrowse_reply); }} }};
  var __unbrowse_fetch = function () {{ return __unbrowse_resolved(__unbrowse_resp); }};
  fetch = __unbrowse_fetch;
  if (typeof globalThis !== 'undefined') globalThis.fetch = __unbrowse_fetch;
  var __unbrowse_got;
  var __unbrowse_have = false;
  var __unbrowse_capture = function (v) {{ if (!__unbrowse_have) {{ __unbrowse_got = v; __unbrowse_have = true; }} }};
  // The functions the script newly set on `window` (its search entry, keeping its own decoder in scope), each called
  // with the capture in each argument slot: the page hands the decoded answer to the callback it was given.
  var __unbrowse_fns = [];
  if (typeof window !== 'undefined') {{
    var __unbrowse_now = Object.keys(window);
    for (var __j = 0; __j < __unbrowse_now.length; __j++) {{
      var __k = __unbrowse_now[__j];
      if (__unbrowse_before.indexOf(__k) < 0 && typeof window[__k] === 'function') __unbrowse_fns.push(window[__k]);
    }}
  }}
  for (var __f = 0; __f < __unbrowse_fns.length && !__unbrowse_have; __f++) {{
    for (var __slot = 0; __slot < 4 && !__unbrowse_have; __slot++) {{
      var __args = [];
      for (var __a = 0; __a < 4; __a++) __args[__a] = (__a === __slot) ? __unbrowse_capture : 'x';
      try {{ __unbrowse_fns[__f].apply(null, __args); }} catch (e) {{}}
    }}
  }}
  if (!__unbrowse_have || __unbrowse_got === undefined || __unbrowse_got === null) throw new Error('the page unpacked nothing');
  return (typeof __unbrowse_got === 'string') ? __unbrowse_got : JSON.stringify(__unbrowse_got);
}}
"#,
    )))
}

/// A bundler hands the hash primitives out as module exports — `(0, n.md5)(body)`, `o.sha256(x)` — where the program's
/// runtime has them by name. The call is the same function; the module graph is not what the producer needs. Rewrite
/// the call and let the verifier decide: a name that was not the primitive fails to reproduce the walk's value.
fn alias_primitives(code: &str) -> String {
    const NAMES: [&str; 8] = ["md5", "sha1", "sha256", "sha512", "hmacSha256", "base64", "base64url", "hex"];
    let mut out = String::with_capacity(code.len());
    let mut i = 0usize;
    while i < code.len() {
        let c = code[i..].chars().next().unwrap();
        if c == '.' {
            let after = &code[i + 1..];
            if let Some(name) = NAMES.iter().find(|n| after.starts_with(**n)) {
                let tail = after[name.len()..].trim_start();
                // `o.md5(x)` is the call; `(0, n.md5)(x)` is the same call through the `(0, ...)` idiom, where the
                // property is the callee and the `)` closes the idiom.
                let called = tail.starts_with('(');
                let j = out.trim_end_matches(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$').len();
                let idiom = j >= 4 && out[..j].ends_with("(0,");
                let ident = &out[j..];
                if (called || idiom) && !ident.is_empty() && !ident.chars().next().unwrap().is_ascii_digit() {
                    out.truncate(j);
                    out.push_str(name);
                    i += 1 + name.len();
                    continue;
                }
            }
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// The `window.<name>` names a piece of code calls, as the write site spells them.
fn window_names(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(at) = rest.find("window.") {
        let after = &rest[at + "window.".len()..];
        let name: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
        if name.len() >= 3 && !out.contains(&name) {
            out.push(name);
        }
        rest = after;
    }
    out
}

#[cfg(test)]
pub(crate) mod module_call_tests {
    use super::*;

    /// A bundler's runtime as the page loads it: a module table, its `require`, a lazy chunk loader that appends a
    /// script, and a chunk array whose `push` the runtime replaced to register what each chunk brings.
    pub(crate) const RUNTIME: &str = r#"(function(){var modules={},cache={};function req(id){if(cache[id])return cache[id].exports;var m=cache[id]={exports:{}};modules[id](m,m.exports,req);return m.exports}req.d=function(ex,defs){for(var k in defs)Object.defineProperty(ex,k,{enumerable:true,get:defs[k]})};var files={7:"https://cdn.app.example/chunk7.js"},loading={};req.e=function(id){if(loading[id])return loading[id];return loading[id]=new Promise(function(done){var s=document.createElement("script");s.src=files[id];s.onload=function(){done()};document.head.appendChild(s)})};function cb(push,data){var more=data[1];for(var k in more)modules[k]=more[k];if(data[2])data[2](req);return push(data)}var reg=self.webpackChunk_app=self.webpackChunk_app||[];reg.forEach(function(d){cb(function(){},d)});reg.push=cb.bind(null,reg.push.bind(reg))})();"#;
    /// The page's client: a filter writes the header with the awaited value of an export of its own module, and that
    /// export loads the maker from a chunk on first use.
    pub(crate) const MAIN: &str = r#"(self.webpackChunk_app=self.webpackChunk_app||[]).push([[1],{100(e,t,r){r.d(t,{kc:()=>a,Ay:()=>c});let i;async function s(p,m){i=i||r.e(7).then(()=>r(200));let g=await i;return g.make(p,m)}async function a(h,p,m){try{return await s((p||"").split("?")[0],m)}catch(x){return "e:"+x}}function c(){return async(t,n)=>{let i={...t};i.headers["x-sig"]=await a(t.host,t.path,t.method);return n(i)}}}}]);"#;
    pub(crate) const CHUNK: &str = r#"(self.webpackChunk_app=self.webpackChunk_app||[]).push([[7],{200(e,t,r){r.d(t,{make:()=>function(p,m){return "sig:"+p+":"+m}})}}]);"#;

    /// A value written as the awaited answer of a module's own export (`h["x-sig"] = await a(t.host, t.path,
    /// t.method)`) is made by calling that export through the page's module registry with the call's own host, path
    /// and method, once the page's scripts have run: the page's UI never has to reach the call, and the export may load
    /// what it needs on first use. Nothing names a site, a module or a bundler: the registry is the global array whose
    /// `push` the page's runtime replaced, and the module, export and arguments are read from the write site.
    #[test]
    fn a_value_an_export_of_the_pages_module_makes_is_made_by_calling_that_export() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the module call is skipped");
            return;
        }
        let scripts = [("https://cdn.app.example/runtime.js", RUNTIME), ("https://cdn.app.example/main.js", MAIN), ("https://cdn.app.example/chunk7.js", CHUNK)];
        let at = MAIN.find("x-sig").unwrap();
        let producer = Producer { script: "https://cdn.app.example/main.js".into(), at, frame: false };
        let program = module_call(&scripts, &producer, "x-sig").expect("a call of the module's export");
        assert!(program.contains("100") && program.contains("kc"), "the module and its export, read from the write site: {program}");
        use crate::graph::{Arg, CallField};
        let data = page_function(&scripts, &producer, "x-sig").expect("the function as data");
        assert_eq!((data.module.as_str(), data.export.as_str()), ("100", "kc"));
        assert_eq!(data.args, vec![Arg::Call { field: CallField::Origin }, Arg::Call { field: CallField::Path }, Arg::Call { field: CallField::Method }], "its arguments are edges to the call's own fields");
        assert!(!serde_json::to_string(&data).unwrap().contains("function"), "the route carries data, never code (R2.7)");
        let ctx = crate::generated::context_of("GET", "https://app.example/api/search?q=kettle", None, &[], &[]);
        let owned: Vec<(String, String)> = scripts.iter().map(|(u, b)| (u.to_string(), b.to_string())).collect();
        let made = crate::sandbox::run_program_on_page_many(&program, std::slice::from_ref(&ctx), &serde_json::Value::Null, &Default::default(), "https://app.example/search", "<html><head></head><body></body></html>", &[], &owned).expect("the export answers");
        assert_eq!(made, vec!["sig:/api/search:GET".to_string()]);
        // A write site that calls no export of its module is no module call.
        let plain = r#"(self.webpackChunk_app=self.webpackChunk_app||[]).push([[1],{100(e,t,r){function c(){return async(t,n)=>{t.headers["x-sig"]=String(Date.now());return n(t)}}}}]);"#;
        let none = Producer { script: "https://cdn.app.example/plain.js".into(), at: plain.find("x-sig").unwrap(), frame: false };
        assert!(module_call(&[("https://cdn.app.example/plain.js", plain)], &none, "x-sig").is_none());
    }

    /// Parsing a page function's write site handles string and numeric literals, quoted commas/escapes, every request
    /// field, and rejects non-assignment operators, unclosed calls, and non-module blocks.
    #[test]
    fn page_function_parses_literals_and_all_fields_and_rejects_bad_sites() {
        use crate::graph::{Arg, CallField};
        let all_fields = r#"(self.webpackChunk_app=self.webpackChunk_app||[]).push([[1],{101(e,t,r){r.d(t,{mk:()=>a});function a(){return "ok"}function c(t){t.headers["x-sig"]=a("lit, \"q\"",42,t.hostname,t.url,t.search,t.body,t.headers)}}}]);"#;
        let prod = Producer { script: "https://cdn.app.example/all.js".into(), at: all_fields.find("x-sig").unwrap(), frame: false };
        let parsed = page_function(&[("https://cdn.app.example/all.js", all_fields)], &prod, "x-sig").expect("parsed");
        assert_eq!((parsed.module.as_str(), parsed.export.as_str()), ("101", "mk"));
        assert_eq!(
            parsed.args,
            vec![
                Arg::Literal { value: r#"lit, \"q\""#.into() },
                Arg::Literal { value: "42".into() },
                Arg::Call { field: CallField::Host },
                Arg::Call { field: CallField::Url },
                Arg::Call { field: CallField::Search },
                Arg::Call { field: CallField::Body },
                Arg::Call { field: CallField::Headers },
            ]
        );
        let js = render(&parsed);
        for needle in ["ctx.host", "ctx.url", "ctx.search", "ctx.body", "ctx.headers", "\"42\""] {
            assert!(js.contains(needle), "rendered program should include {needle}: {js}");
        }

        // Comparison `==` is not an assignment write site.
        let cmp = r#"(self.webpackChunk_app=[]).push([[1],{101(e,t,r){r.d(t,{mk:()=>a});function c(t){return t.headers["x-sig"]==a(t.path)}}}]);"#;
        let cmp_prod = Producer { script: "https://cdn.app.example/cmp.js".into(), at: cmp.find("x-sig").unwrap(), frame: false };
        assert!(page_function(&[("https://cdn.app.example/cmp.js", cmp)], &cmp_prod, "x-sig").is_none());

        // Unclosed paren and top-level block with no module header both return None.
        assert_eq!(closing_paren("a, 'x, \\'y\\'"), None);
        let bare = r#"{t.headers["x-sig"]=a(t.path)}"#;
        assert_eq!(enclosing_module(bare, bare.find("x-sig").unwrap()), None);
    }

    /// Calling a page function passes literals, every call field, and header-object calls through the warm sandbox,
    /// returning None when the environment carries no scripts.
    #[test]
    fn calling_a_page_function_handles_empty_scripts_all_fields_and_headers() {
        use crate::graph::{Arg, CallField, PageFunction};
        let empty_env = crate::generated::Environment { page_url: Some("https://app.example/search".into()), ..Default::default() };
        let f_all = PageFunction {
            module: "300".into(),
            export: "join".into(),
            args: vec![
                Arg::Literal { value: "tag".into() },
                Arg::Call { field: CallField::Origin },
                Arg::Call { field: CallField::Host },
                Arg::Call { field: CallField::Path },
                Arg::Call { field: CallField::Method },
                Arg::Call { field: CallField::Url },
                Arg::Call { field: CallField::Search },
                Arg::Call { field: CallField::Body },
            ],
        };
        let ctx = crate::generated::context_of("POST", "https://app.example/api/go?q=1", Some("payload"), &[], &[("x-in".into(), "hv".into())]);
        assert_eq!(call(&f_all, &ctx, &empty_env), None, "no scripts means no page function call");

        if !crate::sandbox::available() {
            return;
        }
        let mod_src = r#"(self.webpackChunk_app=self.webpackChunk_app||[]).push([[3],{300(e,t,r){r.d(t,{join:()=>function(){return Array.prototype.slice.call(arguments).join("|")},hdr:()=>function(h){return "h:"+(h&&h["x-in"]||"")}})}}]);"#;
        let env = crate::generated::Environment {
            page_url: Some("https://app.example/call-fields".into()),
            html: Some("<html><head></head><body></body></html>".into()),
            scripts: vec![("https://cdn.app.example/runtime.js".into(), RUNTIME.into()), ("https://cdn.app.example/mod3.js".into(), mod_src.into())],
            ..Default::default()
        };
        let out = call(&f_all, &ctx, &env).expect("call with all text fields");
        assert_eq!(out, "tag|https://app.example|app.example|/api/go|POST|https://app.example/api/go?q=1|?q=1|payload");

        let f_hdr = PageFunction { module: "300".into(), export: "hdr".into(), args: vec![Arg::Call { field: CallField::Headers }] };
        let hdr_out = call(&f_hdr, &ctx, &env).expect("call with headers object");
        assert_eq!(hdr_out, "h:hv");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_module_hash_call_is_the_runtimes_primitive() {
        let code = "var r=(0,n.md5)(t.body),o=(0,a.sha256)(x),b=o.md5(y);";
        assert_eq!(super::alias_primitives(code), "var r=(0,md5)(t.body),o=(0,sha256)(x),b=md5(y);");
    }

    use super::*;

    fn producer(url: &str, at: usize) -> Producer {
        Producer { script: url.into(), at, frame: false }
    }

    /// A frame is a line and a column, counted the browser's way: from zero, and a character outside the basic plane
    /// as two. The offset is the byte a slice starts from. A frame past the end of its line is of another script.
    #[test]
    fn a_stack_frame_is_found_in_its_script_by_line_and_column() {
        let body = "var a=1;\nvar s=\"caf\u{e9} \u{1F600}\";function send(){return fetch(u)}\nvar z=2;";
        let at = offset_at(body, 1, 16).expect("a place on the second line");
        assert!(body[at..].starts_with("function send"), "{:?}", &body[at..]);
        assert_eq!(offset_at(body, 0, 0), Some(0));
        assert!(body[offset_at(body, 2, 4).unwrap()..].starts_with("z=2"));
        assert_eq!(offset_at(body, 2, 400), None, "no such column");
        assert_eq!(offset_at(body, 9, 0), None, "no such line");
    }

    /// A module is parsed as a module: `import` and `export` are errors in a classic script, and a module read as one
    /// fell to the text scanner. Read by the parser, the write site's own function is the slice's first piece and the
    /// call it is made with is known.
    #[test]
    fn a_module_is_parsed_as_a_module() {
        // The parser helper runs only in a runtime that can be held (`sandbox::run_helper`).
        if !crate::sandbox::available() {
            return;
        }
        let module = r#"import { md5 } from "./hash.js";
export function tracker(n) { for (let i = 0; i < n; i++) { ping(i); } }
export const sign = (req, ctx) => { req.headers["x-sig"] = md5(req.body + ctx.salt); };
"#;
        let hash = r#"export function md5(s) { return String(s.length); }"#;
        let scripts = vec![("https://cdn.example/app.mjs", module), ("https://cdn.example/hash.js", hash)];
        let slice = parsed(&scripts, &producer("https://cdn.example/app.mjs", module.find("x-sig").unwrap())).expect("the parser reads a module");
        assert!(slice.pieces[0].src.starts_with("(req, ctx) =>"), "the write site's own function: {}", slice.pieces[0].src);
        assert_eq!(slice.call.as_ref().map(|c| (c.request.as_str(), c.params.len())), Some(("req", 2)));
        assert!(slice.text().contains("function md5"), "the hash it calls, from the other module: {}", slice.text());
    }

    /// A slice that starts at a frame of the stack is the function that frame is in, and what it reaches: the key is
    /// spelled nowhere, so there is no write site to find, and the nearest write of some other key is not it.
    #[test]
    fn a_slice_from_a_stack_frame_is_the_function_that_sent_the_call() {
        let app = r#"var names=["x","-s","ig"];function other(o){o.headers.accept="json"}function send(req){req.headers[names.join("")]=seal(req.body);return fetch(req.url,req)}"#;
        let seal = r#"function seal(body){return "v1:"+body.length}"#;
        let scripts = vec![("https://cdn.example/app.js", app), ("https://cdn.example/seal.js", seal)];
        let at = offset_at(app, 0, app.find("return fetch").unwrap() as u32 + 7).expect("the frame's place");
        let slice = of(&scripts, &Producer { script: "https://cdn.example/app.js".into(), at, frame: true });
        let first = &slice.pieces[0].src;
        assert!(first.starts_with("function send"), "{first}");
        assert!(!first.contains("accept"), "not the write of another key nearby: {first}");
        assert!(slice.text().contains("function seal"), "what the sender reaches: {}", slice.text());
    }

    /// The slice starts at the write site and follows the names it uses to their definitions, in this script or
    /// another: the encoder and the hash it calls. A function the value never touches is not carried.
    #[test]
    fn a_slice_is_the_write_site_and_the_code_it_calls() {
        let site = r#"(function(){var t=this;t.headers["w-payload-source"]=window.c_sign.toString(md5(t.body))})()"#;
        let module = r#"function cSign(t){return "1.0.9@102!"+t}"#;
        let md5 = r#"function md5(s){return s.length}"#;
        let noise = r#"function tracker(){for(var i=0;i<9;i++){send(i)}}"#;
        let scripts = vec![
            ("https://cdn.example/app.js", site),
            ("https://cdn.example/csign.js", module),
            ("https://cdn.example/hash.js", md5),
            ("https://cdn.example/noise.js", noise),
        ];
        let slice = of(&scripts, &producer("https://cdn.example/app.js", site.find("w-payload-source").unwrap()));
        let text = slice.text();
        assert!(text.contains("w-payload-source"), "{text}");
        assert!(text.contains("cSign"), "the encoder the write site calls: {text}");
        assert!(text.contains("function md5"), "the hash the encoder calls: {text}");
        assert!(!text.contains("tracker"), "a function the value never touches is not carried: {text}");
        assert!(slice.bytes > 0 && slice.bytes <= CAP);
    }

    /// The parser helper reads the page's scripts, so it never works in a folder someone else could make first. A
    /// local user who plants the names the helper once used (`<temp>/unbrowse-slice-<pid>-<n>`, a leaf linked to a file
    /// of the owner's) finds nothing written through them: the victim's bytes stay, and the helper still answers from
    /// its own private run folder when the machine can confine its runtime.
    #[test]
    fn slice_helper_never_follows_preplanted_paths() {
        let victim = std::env::temp_dir().join(format!("slice-victim-{}", std::process::id()));
        std::fs::write(&victim, b"the owner's own bytes").unwrap();
        let planted: Vec<std::path::PathBuf> = (0..64).map(|n| std::env::temp_dir().join(format!("unbrowse-slice-{}-{n}", std::process::id()))).collect();
        for dir in &planted {
            let _ = std::fs::create_dir_all(dir);
            #[cfg(unix)]
            for leaf in ["spec.json", "helper.js", "acorn.js"] {
                let _ = std::os::unix::fs::symlink(&victim, dir.join(leaf));
            }
        }
        let site = r#"(function(){var t=this;t.headers["w-sig"]=sign(t.body)})();function sign(b){return b.length}"#;
        let scripts = vec![("https://cdn.example/app.js", site)];
        let answered = parsed(&scripts, &producer("https://cdn.example/app.js", site.find("w-sig").unwrap()));
        assert_eq!(std::fs::read(&victim).unwrap(), b"the owner's own bytes", "nothing was written through a planted path");
        if crate::sandbox::available() {
            let slice = answered.expect("the confined helper answers");
            assert!(slice.text().contains("w-sig"), "{}", slice.text());
        }
        for dir in &planted {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_file(&victim);
    }

    /// Braces inside strings and comments are not the function's: the slice ends where the function does.
    #[test]
    fn a_braces_inside_a_string_do_not_end_the_function() {
        let code = "function f(){ var s = '} not the end {'; return s } function g(){return 1}";
        let at = code.find("return s").unwrap();
        let (from, to, src) = around(code, at, false).unwrap();
        assert!(from < at && to > at);
        assert!(src.contains("return s"));
        assert!(!src.contains("function g"), "{src}");
    }

    /// A definition is found wherever the bundle spells it, including a module's camel case for a write site's snake.
    #[test]
    fn a_name_is_found_with_its_case_and_underscores_folded() {
        let src = "var e=1;function cSign(t){return t}";
        assert!(defines(src, "c_sign").is_some());
        assert!(defines(src, "nothing").is_none());
    }

    /// A program is built from the slice: the helper and the write site, called with the request, and the header it
    /// sets is the answer. No model, no per-site knowledge.
    #[test]
    fn a_program_is_assembled_from_the_slice() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the assembler is skipped");
            return;
        }
        let site = r#"var i=function(t,e){var r=md5(t.body);t.headers["x-sig"]="sig-"+r}"#;
        let hash = r#"function md5(s){var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0}return h}"#;
        let scripts = vec![("https://cdn.example/app.js", site), ("https://cdn.example/hash.js", hash)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: site.find("x-sig").unwrap(), frame: false };
        let program = assemble(&scripts, &producer, "x-sig").expect("a program");
        let ctx = serde_json::json!({ "body": "ab", "url": "https://shop.example/api" });
        let value = crate::sandbox::run_program(&program, &ctx, &serde_json::Value::Null, &Default::default()).expect("it runs");
        // md5('ab') with the page's own arithmetic: (97*31 + 98) | 0 = 3105.
        assert_eq!(value, "sig-3105");
    }

    /// The request is passed where the write site reads it: the second parameter when the function is `(e, t)`, and
    /// `this` when it is a local alias of `this`.
    #[test]
    fn the_request_is_passed_where_the_write_site_reads_it() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the assembler is skipped");
            return;
        }
        let swapped = r#"var i=function(e,t){t.headers["x-sig"]="s"+t.body}"#;
        let scripts = vec![("https://cdn.example/app.js", swapped)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: swapped.find("x-sig").unwrap(), frame: false };
        let program = assemble(&scripts, &producer, "x-sig").expect("a program");
        let value = crate::sandbox::run_program(&program, &serde_json::json!({ "body": "ab" }), &serde_json::Value::Null, &Default::default()).expect("it runs");
        assert_eq!(value, "sab");

        let on_this = r#"var i=function(){var t=this;t.headers["x-sig"]="s"+t.body}"#;
        let scripts = vec![("https://cdn.example/app.js", on_this)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: on_this.find("x-sig").unwrap(), frame: false };
        let program = assemble(&scripts, &producer, "x-sig").expect("a program");
        let value = crate::sandbox::run_program(&program, &serde_json::json!({ "body": "ab" }), &serde_json::Value::Null, &Default::default()).expect("it runs");
        assert_eq!(value, "sab");
    }

    /// A module that exports its encoder is put on `window` under the name the write site calls, so a page's
    /// `window.c_sign.toString` finds the module's `cSign`.
    #[test]
    fn a_module_export_is_bridged_to_the_name_the_write_site_calls() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the assembler is skipped");
            return;
        }
        let site = r#"var i=function(t,e){t.headers["x-sig"]=window.c_sign(t.body)}"#;
        let module = r#"function cSign(s){return "E"+s}"#;
        let scripts = vec![("https://cdn.example/app.js", site), ("https://cdn.example/csign.js", module)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: site.find("x-sig").unwrap(), frame: false };
        let program = assemble(&scripts, &producer, "x-sig").expect("a program");
        let ctx = serde_json::json!({ "body": "ab" });
        let value = crate::sandbox::run_program(&program, &ctx, &serde_json::Value::Null, &Default::default()).expect("it runs");
        assert_eq!(value, "Eab");
    }

    /// A module is carried whole when it defines the name: a UMD wrapper and its exports stay together, and a write
    /// site that calls `window.c_sign.toString` gets the module's own encoder.
    #[test]
    fn a_module_is_carried_whole_and_assembled() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the whole-module test is skipped");
            return;
        }
        let site = r#"var i=function(t,e){t.headers["x-sig"]=window.c_sign.toString(t.body)}"#;
        let module = r#"!function(){window.c_sign={toString:function(s){return "E"+s}}}()"#;
        let scripts = vec![("https://cdn.example/app.js", site), ("https://cdn.example/csign.js", module)];
        let producer = Producer { script: "https://cdn.example/app.js".into(), at: site.find("x-sig").unwrap(), frame: false };
        let program = assemble(&scripts, &producer, "x-sig").expect("a program");
        let ctx = serde_json::json!({ "body": "ab" });
        let value = crate::sandbox::run_program(&program, &ctx, &serde_json::Value::Null, &Default::default()).expect("it runs");
        assert_eq!(value, "Eab");
    }

    /// A fragment of a big bundle is not carried: an object property or a half statement at the top level is a syntax
    /// error, not a producer. The name is left out and the caller falls back.
    #[test]
    fn a_fragment_of_a_big_bundle_is_not_a_statement() {
        let big = format!("var noise={{ {} cSign:l }};", "a:1,".repeat(WHOLE));
        let scripts = vec![("https://cdn.example/app.js", "window.c_sign.toString(body)"), ("https://cdn.example/big.js", big.as_str())];
        let slice = of(&scripts, &producer("https://cdn.example/app.js", 0));
        assert!(!slice.pieces.iter().any(|p| p.name == "c_sign"), "{:?}", slice.pieces.iter().map(|p| &p.name).collect::<Vec<_>>());
    }

    /// Acorn counts UTF-16 units and Rust slices UTF-8 bytes: a non-ASCII line before the write site must not move the
    /// slice off its code.
    #[test]
    fn a_non_ascii_page_keeps_the_slice_on_its_code() {
        let site = "var π=\"日本語\";var i=function(t,e){t.headers[\"x-sig\"]=\"é\"+t.body}";
        let scripts = vec![("https://cdn.example/app.js", site)];
        let at = site.find("x-sig").unwrap();
        let slice = of(&scripts, &producer("https://cdn.example/app.js", at));
        let text = slice.text();
        assert!(text.contains("x-sig"), "{text}");
        assert!(text.contains("\"é\""), "the write site's own bytes: {text}");
        assert!(text.contains("function(t,e)"), "{text}");
    }

    /// A slice is bounded: a chain of definitions stops at the cap, never carrying a bundle.
    #[test]
    fn a_slice_is_bounded() {
        let big = format!("function cSign(t){{return '{}'}}", "x".repeat(CAP * 2));
        let scripts = vec![("https://cdn.example/app.js", "window.c_sign.toString(md5(body))"), ("https://cdn.example/big.js", big.as_str())];
        let slice = of(&scripts, &producer("https://cdn.example/app.js", 0));
        assert!(slice.bytes <= CAP, "{}", slice.bytes);
    }

    /// RED-4 (variant of the run-folder race closed by `sandbox::run_helper`'s fresh private folder). The parser helper's
    /// folder is `$TMPDIR/unbrowse-slice-<pid>-<n>`: guessable, made with `create_dir_all` (an existing one is taken as
    /// is) and written into. On a machine whose temporary folder is shared (Linux `/tmp`), another user makes it first
    /// (here: a link to a folder they choose) and the node writes its helper there and then runs it, uncontained and
    /// with the node's whole environment.
    #[cfg(unix)]
    #[test]
    fn red_the_slice_helpers_folder_is_not_one_someone_else_made_first() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        let theirs = std::env::temp_dir().join(format!("red-slice-theirs-{}", std::process::id()));
        std::fs::create_dir_all(&theirs).unwrap();
        let planted: Vec<_> = (0..256).map(|n| std::env::temp_dir().join(format!("unbrowse-slice-{}-{n}", std::process::id()))).filter(|p| std::os::unix::fs::symlink(&theirs, p).is_ok()).collect();
        let body = "var t=function(){return 1};fetch('/x',{headers:{'x-sig':t()}});";
        let _ = parsed(&[("https://cdn.example/app.js", body)], &producer("https://cdn.example/app.js", body.find("x-sig").unwrap()));
        // A file the node wrote there, not a link: `slice_helper_never_follows_preplanted_paths`, run beside this test,
        // plants a link named helper.js through the same names, and a link it left is not the node's write.
        let wrote = std::fs::symlink_metadata(theirs.join("helper.js")).is_ok_and(|m| m.file_type().is_file());
        for p in &planted {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_dir_all(&theirs);
        assert!(!wrote, "the node wrote its helper into a folder another user made first");
    }

    /// The same race for the helper that lists a script's string literals (`literals`): its folder was
    /// `$TMPDIR/unbrowse-literals-<pid>-<n>`, guessable and taken as it was found, so another user who made it first
    /// (here: a link to a folder they choose) had the node write its helper there and then run it. The literals are
    /// still read where the runtime can be held.
    #[cfg(unix)]
    #[test]
    fn red_the_literals_helpers_folder_is_not_one_someone_else_made_first() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        let theirs = std::env::temp_dir().join(format!("red-literals-theirs-{}", std::process::id()));
        std::fs::create_dir_all(&theirs).unwrap();
        let planted: Vec<_> = (0..256).map(|n| std::env::temp_dir().join(format!("unbrowse-literals-{}-{n}", std::process::id()))).filter(|p| std::os::unix::fs::symlink(&theirs, p).is_ok()).collect();
        let found = literals("var salt = 'k-7f3a'; send(md5(body + salt));");
        let wrote = theirs.join("slice_literals.js").exists() || theirs.join("acorn.js").exists() || theirs.join("spec.json").exists();
        for p in &planted {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_dir_all(&theirs);
        assert!(!wrote, "the node wrote its helper into a folder another user made first");
        if crate::sandbox::available() {
            assert_eq!(found, vec!["k-7f3a".to_string()], "the script's literals are still read");
        }
    }
}

/// The helper that lists the tables a script ships (`tables`).
const TABLES_HELPER: &str = include_str!("slice_tables.js");

/// The most records a table a script ships is read with. A table a page turns a word into a code by (its cities, its
/// languages, its categories) is short next to this; anything longer is bulk data, not a lookup.
pub const TABLE_ROWS: usize = 5000;

/// The tables one script ships, read with the engine's own parser (the vendored acorn, through the node runtime, as
/// [`literals`] reads its strings): each array of two records or more whose fields are all fixed values, and each map
/// of fixed values, as records of `key` and `value`. The site's data, shipped to everyone: a page may turn the caller's
/// word into the site's code by one of them with no call made. Nothing of the script runs. Empty when no runtime is on
/// the machine, the script does not parse, or the ask this thread works for has stopped.
///
/// A script's tables are a property of its body alone, so each body is parsed once ([`shipped_tables`]): every
/// question asked of it after the first (each candidate value of each call a learn weighs, a second learn of the same
/// page) is answered from that one reading and starts no child process.
pub fn tables(body: &str) -> Vec<Vec<serde_json::Value>> {
    shipped_tables(body).as_ref().clone()
}

type Tables = std::sync::Arc<Vec<Vec<serde_json::Value>>>;

/// How many distinct script bodies' tables are kept. A walk's page runs a few hundred scripts at most; past this the
/// readings are let go and read again when asked.
const TABLES_KEPT: usize = 2048;

thread_local! {
    /// How many times this thread started the tables parser ([`tables_children`]).
    static TABLE_CHILDREN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread has started a child process to read a script's tables: one per script body read for the
/// first time, none for a body already read or once the ask has stopped.
pub fn tables_children() -> usize {
    TABLE_CHILDREN.with(|n| n.get())
}

/// The tables `body` ships, read once per body (by its SHA-256) and shared by every caller after that. A reading that
/// did not finish (no runtime, the ask stopped) is not kept, so a later ask reads the body again.
fn shipped_tables(body: &str) -> Tables {
    static READ: std::sync::Mutex<Option<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<Option<Tables>>>>>> = std::sync::Mutex::new(None);
    if crate::mint::asked_to_stop() {
        return Tables::default();
    }
    let key = crate::blobs::sha256_hex(body.as_bytes());
    let cell = {
        let mut read = READ.lock().unwrap_or_else(|e| e.into_inner());
        let read = read.get_or_insert_with(std::collections::HashMap::new);
        if read.len() >= TABLES_KEPT && !read.contains_key(&key) {
            read.clear();
        }
        read.entry(key).or_default().clone()
    };
    // One reading of a body at a time: a second caller asking for the same body waits for the first's answer.
    let mut held = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = held.as_ref() {
        return t.clone();
    }
    match read_tables(body) {
        Some(t) => {
            let t: Tables = std::sync::Arc::new(t);
            *held = Some(t.clone());
            t
        }
        None => Tables::default(),
    }
}

/// Parses `body` for its tables in a child of the node runtime. None where no runtime is on the machine or the ask
/// stopped before the child answered (it is killed then: a stopped ask holds no process); Some (maybe empty) where the
/// parser ran to its end, a script that does not parse included.
fn read_tables(body: &str) -> Option<Vec<Vec<serde_json::Value>>> {
    let runtime = crate::sandbox::runtime()?;
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("unbrowse-tables-{}-{n}", std::process::id()));
    if std::fs::create_dir_all(&dir).is_err() {
        return Some(Vec::new());
    }
    let out = (|| -> Result<Vec<Vec<serde_json::Value>>, bool> {
        std::fs::write(dir.join("acorn.js"), ACORN).map_err(|_| false)?;
        std::fs::write(dir.join("slice_tables.js"), TABLES_HELPER).map_err(|_| false)?;
        std::fs::write(dir.join("spec.json"), serde_json::json!({ "body": body, "rows": TABLE_ROWS }).to_string()).map_err(|_| false)?;
        let said = std::fs::File::create(dir.join("out.json")).map_err(|_| false)?;
        TABLE_CHILDREN.with(|c| c.set(c.get() + 1));
        let mut child = std::process::Command::new(&runtime)
            .arg(dir.join("slice_tables.js"))
            .arg(dir.join("spec.json"))
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(said))
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| false)?;
        // Waited on with the ask's stop flag in view: an ask that gave up ends the parse rather than wait it out.
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|_| false)? {
                break status;
            }
            if crate::mint::asked_to_stop() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(true);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        if !status.success() {
            return Ok(Vec::new());
        }
        let said: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("out.json")).map_err(|_| false)?).map_err(|_| false)?;
        Ok(said.get("tables").and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|t| t.as_array().cloned()).collect()).unwrap_or_default())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    match out {
        Ok(t) => Some(t),
        Err(stopped) => (!stopped).then(Vec::new),
    }
}

/// The code of each script a walk's pages ran: each script it fetched, and each inline script of its documents.
fn scripts_of(trace: &crate::trace::Trace) -> Vec<String> {
    let mut out = Vec::new();
    for e in &trace.exchanges {
        let Some(body) = e.response_body.as_deref() else { continue };
        if e.is_static_code() {
            out.push(body.to_string());
        } else if e.is_main_document() {
            for piece in body.split("<script").skip(1) {
                let Some(open) = piece.find('>') else { continue };
                // A script with a source of its own, or that holds data (`application/json`), is no inline code.
                if piece[..open].contains("src=") || piece[..open].contains("json") {
                    continue;
                }
                if let Some(end) = piece[open + 1..].find("</script>") {
                    out.push(piece[open + 1..open + 1 + end].to_string());
                }
            }
        }
    }
    out
}

/// Whether the call `e` of `trace` sends the code that a table the walk's own scripts ship gives the asked `value`:
/// a record of the table says the value in one field (case aside) and, in another, what one place of the call sends
/// whole. What a call's pick counts as sending the value: the page turned the caller's word into the site's code with
/// no call made. Only scripts that hold both the value and a value the call sends are parsed.
pub fn sent_by_a_shipped_table(trace: &crate::trace::Trace, e: &crate::trace::Exchange, value: &str) -> bool {
    let value = value.trim();
    if value.chars().count() < 2 {
        return false;
    }
    let sent: Vec<String> = crate::slots::slots(e).into_iter().map(|s| s.value).filter(|v| v.chars().count() >= 2 && v != value).collect();
    if sent.is_empty() {
        return false;
    }
    let lower = value.to_lowercase();
    scripts_of(trace).into_iter().filter(|code| code.to_lowercase().contains(&lower) && sent.iter().any(|v| code.contains(v.as_str()))).any(|code| {
        shipped_tables(&code).iter().flatten().any(|row| {
            let leaves = crate::slots::json_leaves(row);
            leaves.iter().any(|(at, f)| f.to_lowercase() == lower && leaves.iter().any(|(other, g)| other != at && sent.contains(g)))
        })
    })
}

#[cfg(test)]
mod table_tests {
    use super::*;

    /// A table the script ships is read as the script holds it, by parsing it: an array of fixed records, and a map
    /// read as records of `key` and `value`. A list that holds anything worked out (a call, a variable) is no table.
    #[test]
    fn the_tables_a_script_ships_are_read_by_parsing_it() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        let script = "const PLACES = [{ name: 'Lisbon', code: 'LIS', n: 1 }, { name: 'Oslo', code: 'OSL', n: 2 }];\n\
                      var units = { metre: 'm', litre: 'l' };\n\
                      var live = [{ name: here(), code: 'X' }, { name: 'b', code: 'Y' }];\n\
                      function go(q) { var p = PLACES.find(function (r) { return r.name === q; }); fetch('/s?c=' + p.code); }";
        let tables = tables(script);
        assert_eq!(tables[0][1], serde_json::json!({ "name": "Oslo", "code": "OSL", "n": 2 }), "{tables:?}");
        assert!(tables.contains(&vec![serde_json::json!({ "key": "metre", "value": "m" }), serde_json::json!({ "key": "litre", "value": "l" })]));
        assert!(!tables.iter().flatten().any(|r| r.get("code") == Some(&serde_json::json!("X"))), "a record with a value worked out is in no table");
        assert!(super::tables("this is { not a script").is_empty());
    }

    /// A made-up walk whose one script ships a table of fifty places, and a call that sends one place's code. Asked of
    /// each of the fifty names (the candidate values a learn weighs), the reader parses the script once: one child
    /// process, however many questions. A body never read before (`fresh`) keeps other tests' readings out of the count.
    fn a_walk_shipping_fifty_places(fresh: &str) -> (crate::trace::Trace, crate::trace::Exchange, Vec<String>) {
        let places: Vec<String> = (1..=50).map(|i| format!("{{ name: 'Place{i:02}', code: 'P{i:02}' }}")).collect();
        let script = format!("// {fresh}\nconst PLACES = [{}];\nfunction go(q) {{ var p = PLACES.find(function (r) {{ return r.name === q; }}); fetch('/s?c=' + p.code); }}", places.join(", "));
        let ex = |url: &str, kind: &str, mime: &str, body: &str| crate::trace::Exchange {
            method: "GET".into(), url: url.parse().unwrap(), request_headers: vec![], request_body: None, status: 200,
            response_headers: vec![], response_body: Some(body.into()), response_mime: mime.into(), resource_type: Some(kind.into()), main_frame: Some(true),
        };
        let call = ex("https://trip.example/s?c=P07", "Fetch", "application/json", r#"{"stays":[]}"#);
        let trace = crate::trace::Trace { exchanges: vec![ex("https://trip.example/s/places.js", "Script", "application/javascript", &script), call.clone()], inputs: vec![] };
        (trace, call, (1..=50).map(|i| format!("Place{i:02}")).collect())
    }

    fn fresh() -> String {
        format!("{:?} {:?}", std::thread::current().id(), std::time::SystemTime::now())
    }

    #[test]
    fn a_scripts_tables_are_read_once_however_many_values_are_asked_of_them() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        let (trace, call, values) = a_walk_shipping_fifty_places(&fresh());
        let before = tables_children();
        let sent: Vec<&String> = values.iter().filter(|v| sent_by_a_shipped_table(&trace, &call, v)).collect();
        assert_eq!(sent, vec!["Place07"], "the table turns the one name into the code the call sends");
        assert_eq!(tables_children() - before, 1, "one child read the script's tables for all fifty values");
        // Any other caller of the reader is answered from the same reading.
        assert_eq!(tables(trace.exchanges[0].response_body.as_deref().unwrap())[0].len(), 50);
        assert_eq!(tables_children() - before, 1);
    }

    /// An ask that gave up starts no child to read a script's tables, and its empty reading is not kept: the next ask
    /// reads the table as before.
    #[test]
    fn a_stopped_ask_starts_no_child_to_read_tables() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        let (trace, call, values) = a_walk_shipping_fifty_places(&fresh());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let before = tables_children();
        let sent = crate::mint::stops_with(stop, || values.iter().filter(|v| sent_by_a_shipped_table(&trace, &call, v)).count());
        assert_eq!((sent, tables_children() - before), (0, 0), "a stopped ask reads no table and starts no child");
        assert!(sent_by_a_shipped_table(&trace, &call, "Place07"), "the stopped ask's nothing was not kept as the reading");
        assert_eq!(tables_children() - before, 1);
    }
}

#[cfg(test)]
#[path = "slice_cov_tests.rs"]
mod slice_cov_tests;
