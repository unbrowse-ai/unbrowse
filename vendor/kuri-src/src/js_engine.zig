const std = @import("std");
const quickjs = @import("quickjs");

/// Minimal JS engine wrapper around QuickJS for evaluating scripts in fetched HTML.
pub const JsEngine = struct {
    rt: *quickjs.Runtime,
    ctx: *quickjs.Context,

    pub fn init() !JsEngine {
        const rt = try quickjs.Runtime.init();
        const ctx = quickjs.Context.init(rt) catch {
            rt.deinit();
            return error.JsContextInit;
        };
        return .{ .rt = rt, .ctx = ctx };
    }

    pub fn deinit(self: *JsEngine) void {
        self.ctx.deinit();
        self.rt.deinit();
    }

    /// Evaluate a JavaScript string, discarding the result. Returns null on exception.
    pub fn exec(self: *JsEngine, code: []const u8) bool {
        const result = self.ctx.eval(code, "<eval>", .{});
        const ok = !result.isException();
        result.deinit(self.ctx);
        return ok;
    }

    /// Evaluate a JS string, return the result as a Zig-owned copy (safe across calls).
    /// Returns null on exception or if result is not convertible to string.
    pub fn evalAlloc(self: *JsEngine, allocator: std.mem.Allocator, code: []const u8) ?[]const u8 {
        const result = self.ctx.eval(code, "<eval>", .{});
        if (result.isException()) {
            result.deinit(self.ctx);
            return null;
        }
        const str = result.toCString(self.ctx) orelse {
            result.deinit(self.ctx);
            return null;
        };
        // Dupe BEFORE freeing the JS value, since toCString points into JS heap
        const duped = allocator.dupe(u8, std.mem.span(str)) catch null;
        result.deinit(self.ctx);
        return duped;
    }
};

/// Extract inline <script> tag contents from HTML.
/// Returns a slice of script body strings.
pub fn extractInlineScripts(html: []const u8, allocator: std.mem.Allocator) ![]const []const u8 {
    var scripts: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;

    while (i < html.len) {
        // Find <script> or <script ...>
        const tag_pos = findScriptOpen(html, i) orelse break;
        const tag_end = std.mem.indexOfScalarPos(u8, html, tag_pos, '>') orelse break;

        // Check if it has a src= attribute (skip external scripts)
        const tag_content = html[tag_pos..tag_end];
        if (std.mem.indexOf(u8, tag_content, "src=") != null or
            std.mem.indexOf(u8, tag_content, "src =") != null)
        {
            i = tag_end + 1;
            continue;
        }

        const body_start = tag_end + 1;
        const close = std.mem.indexOfPos(u8, html, body_start, "</script>") orelse
            std.mem.indexOfPos(u8, html, body_start, "</SCRIPT>") orelse break;

        const body = std.mem.trim(u8, html[body_start..close], " \t\n\r");
        if (body.len > 0) {
            try scripts.append(allocator, body);
        }
        i = close + 9; // len("</script>")
    }

    return scripts.toOwnedSlice(allocator);
}

fn findScriptOpen(html: []const u8, start: usize) ?usize {
    const patterns = [_][]const u8{ "<script>", "<script ", "<SCRIPT>", "<SCRIPT " };
    var best: ?usize = null;
    for (patterns) |pat| {
        if (std.mem.indexOfPos(u8, html, start, pat)) |pos| {
            if (best == null or pos < best.?) best = pos;
        }
    }
    return best;
}

/// Run all inline scripts through QuickJS and return combined output.
/// Scripts that call document.write() or similar will have their output captured.
pub fn evalHtmlScripts(html: []const u8, allocator: std.mem.Allocator) !?[]const u8 {
    return evalHtmlScriptsWithUrl(html, null, allocator);
}

/// Like evalHtmlScripts but also sets window.location from the given URL.
pub fn evalHtmlScriptsWithUrl(html: []const u8, url: ?[]const u8, allocator: std.mem.Allocator) !?[]const u8 {
    const scripts = try extractInlineScripts(html, allocator);
    defer allocator.free(scripts);
    if (scripts.len == 0) return null;

    var engine = JsEngine.init() catch return null;
    defer engine.deinit();

    // Use a temporary arena for DOM stub string building (freed after injection)
    var stub_arena = std.heap.ArenaAllocator.init(allocator);
    defer stub_arena.deinit();

    // Inject DOM stubs (Layer 3) — must come before user scripts
    injectDomStubs(&engine, html, url, stub_arena.allocator());

    for (scripts) |script| {
        // QuickJS requires null-terminated input; dupe with sentinel
        const duped = allocator.dupeZ(u8, script) catch continue;
        defer allocator.free(duped);
        _ = engine.exec(duped);
    }

    return engine.evalAlloc(allocator, "globalThis.__browdie_output");
}

/// Inject Layer 3 DOM stubs into a JsEngine context.
/// Provides: document.querySelector/All, getElementById, title, body,
///           window.location, console.log, document.write/writeln.
fn injectDomStubs(engine: *JsEngine, html: []const u8, url: ?[]const u8, allocator: std.mem.Allocator) void {
    // 1. Output capture + basic document/window objects
    _ = engine.exec("globalThis.__browdie_output = '';");

    // 2. Inject HTML source as a JS string for DOM query shims to search
    //    Escape backslashes, quotes, and newlines for safe embedding.
    //    Must null-terminate dynamic strings (QuickJS requires it).
    const escaped_html = escapeForJs(html, allocator) orelse "";
    const html_inject = std.fmt.allocPrint(allocator,
        "globalThis.__browdie_html = \"{s}\";", .{escaped_html}) catch return;
    const html_inject_z = allocator.dupeZ(u8, html_inject) catch return;
    _ = engine.exec(html_inject_z);

    // 3. Build window.location from URL
    if (url) |u| {
        const escaped_url = escapeForJs(u, allocator) orelse "";
        const loc_js = std.fmt.allocPrint(allocator, dom_location_template, .{
            escaped_url, escaped_url, escaped_url,
        }) catch return;
        const loc_js_z = allocator.dupeZ(u8, loc_js) catch return;
        _ = engine.exec(loc_js_z);
    } else {
        _ = engine.exec("globalThis.window = { location: { href: '', protocol: '', host: '', pathname: '/', search: '', hash: '', hostname: '', port: '', origin: '', toString: function() { return ''; } } };");
    }

    // 4. Inject the full DOM shim (pure JS)
    _ = engine.exec(dom_shim_js);
}

/// Escape a string for embedding inside a double-quoted string literal (JS/JSON).
pub fn escapeForJs(input: []const u8, allocator: std.mem.Allocator) ?[]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    const writer = buf.writer(allocator);
    for (input) |c| {
        switch (c) {
            '\\' => writer.writeAll("\\\\") catch return null,
            '"' => writer.writeAll("\\\"") catch return null,
            '\n' => writer.writeAll("\\n") catch return null,
            '\r' => writer.writeAll("\\r") catch return null,
            '\t' => writer.writeAll("\\t") catch return null,
            else => writer.writeByte(c) catch return null,
        }
    }
    return buf.toOwnedSlice(allocator) catch null;
}

const dom_location_template =
    \\globalThis.window = (function() {{
    \\  var href = "{s}";
    \\  var a = href.indexOf("://");
    \\  var protocol = a > 0 ? href.substring(0, a + 1) : "";
    \\  var rest = a > 0 ? href.substring(a + 3) : href;
    \\  var pathStart = rest.indexOf("/");
    \\  var host = pathStart >= 0 ? rest.substring(0, pathStart) : rest;
    \\  var afterHost = pathStart >= 0 ? rest.substring(pathStart) : "/";
    \\  var hashIdx = afterHost.indexOf("#");
    \\  var hash = hashIdx >= 0 ? afterHost.substring(hashIdx) : "";
    \\  var beforeHash = hashIdx >= 0 ? afterHost.substring(0, hashIdx) : afterHost;
    \\  var searchIdx = beforeHash.indexOf("?");
    \\  var search = searchIdx >= 0 ? beforeHash.substring(searchIdx) : "";
    \\  var pathname = searchIdx >= 0 ? beforeHash.substring(0, searchIdx) : beforeHash;
    \\  var colonIdx = host.indexOf(":");
    \\  var hostname = colonIdx >= 0 ? host.substring(0, colonIdx) : host;
    \\  var port = colonIdx >= 0 ? host.substring(colonIdx + 1) : "";
    \\  var origin = protocol + "//" + host;
    \\  return {{
    \\    location: {{
    \\      href: "{s}", protocol: protocol, host: host, hostname: hostname,
    \\      port: port, pathname: pathname, search: search, hash: hash,
    \\      origin: origin,
    \\      toString: function() {{ return "{s}"; }},
    \\      assign: function() {{}},
    \\      replace: function() {{}},
    \\      reload: function() {{}}
    \\    }},
    \\    innerWidth: 1280, innerHeight: 720,
    \\    setTimeout: function(fn, ms) {{ if (typeof fn === 'function') fn(); return 0; }},
    \\    setInterval: function() {{ return 0; }},
    \\    clearTimeout: function() {{}},
    \\    clearInterval: function() {{}},
    \\    addEventListener: function() {{}},
    \\    removeEventListener: function() {{}},
    \\    dispatchEvent: function() {{ return true; }},
    \\    getComputedStyle: function() {{ return {{}}; }},
    \\    requestAnimationFrame: function(fn) {{ if (typeof fn === 'function') fn(0); return 0; }},
    \\    cancelAnimationFrame: function() {{}}
    \\  }};
    \\}})();
    \\globalThis.location = globalThis.window.location;
;

/// Pure-JS DOM shim injected into QuickJS before user scripts.
/// Provides querySelector/All, getElementById, title, body, console, etc.
const dom_shim_js =
    \\(function() {
    \\  var html = globalThis.__browdie_html || '';
    \\
    \\  // --- Minimal Element prototype ---
    \\  function Element(tag, attrs, inner) {
    \\    this.tagName = tag.toUpperCase();
    \\    this.nodeName = this.tagName;
    \\    this.nodeType = 1;
    \\    this._attrs = attrs || {};
    \\    this.innerHTML = inner || '';
    \\    this.textContent = inner ? inner.replace(/<[^>]*>/g, '') : '';
    \\    this.innerText = this.textContent;
    \\    this.children = [];
    \\    this.childNodes = [];
    \\    this.style = {};
    \\    this.classList = { add: function(){}, remove: function(){}, toggle: function(){}, contains: function(){ return false; } };
    \\    this.dataset = {};
    \\  }
    \\  Element.prototype.getAttribute = function(n) { return this._attrs[n] || null; };
    \\  Element.prototype.setAttribute = function(n, v) { this._attrs[n] = v; };
    \\  Element.prototype.removeAttribute = function(n) { delete this._attrs[n]; };
    \\  Element.prototype.hasAttribute = function(n) { return n in this._attrs; };
    \\  Element.prototype.querySelector = function() { return null; };
    \\  Element.prototype.querySelectorAll = function() { return []; };
    \\  Element.prototype.getElementsByTagName = function() { return []; };
    \\  Element.prototype.getElementsByClassName = function() { return []; };
    \\  Element.prototype.appendChild = function(c) { return c; };
    \\  Element.prototype.removeChild = function(c) { return c; };
    \\  Element.prototype.addEventListener = function() {};
    \\  Element.prototype.removeEventListener = function() {};
    \\  Element.prototype.dispatchEvent = function() { return true; };
    \\  Element.prototype.getBoundingClientRect = function() { return {top:0,left:0,right:0,bottom:0,width:0,height:0}; };
    \\  Element.prototype.cloneNode = function() { return new Element(this.tagName, this._attrs, this.innerHTML); };
    \\  Element.prototype.closest = function() { return null; };
    \\  Element.prototype.matches = function() { return false; };
    \\  Element.prototype.focus = function() {};
    \\  Element.prototype.blur = function() {};
    \\  Element.prototype.click = function() {};
    \\
    \\  // --- HTML parser: extract elements matching simple selectors ---
    \\  function findTags(src, tagName) {
    \\    var results = [];
    \\    var lower = tagName.toLowerCase();
    \\    var re = new RegExp('<' + lower + '(\\s[^>]*)?>([\\s\\S]*?)(<\\/' + lower + '>)', 'gi');
    \\    var m;
    \\    while ((m = re.exec(src)) !== null) {
    \\      var attrs = {};
    \\      if (m[1]) {
    \\        var ar = new RegExp('(\\w[\\w-]*)\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|(\\S+))', 'g');
    \\        var am;
    \\        while ((am = ar.exec(m[1])) !== null) {
    \\          attrs[am[1].toLowerCase()] = am[2] || am[3] || am[4] || '';
    \\        }
    \\      }
    \\      results.push(new Element(lower, attrs, m[2]));
    \\    }
    \\    return results;
    \\  }
    \\
    \\  function findById(src, id) {
    \\    var re = new RegExp('<(\\w+)([^>]*\\sid\\s*=\\s*["\']' + id + '["\'][^>]*)>([\\s\\S]*?)(<\\/\\1>)', 'i');
    \\    var m = re.exec(src);
    \\    if (!m) return null;
    \\    var attrs = { id: id };
    \\    var ar = new RegExp('(\\w[\\w-]*)\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'g');
    \\    var am;
    \\    while ((am = ar.exec(m[2])) !== null) {
    \\      attrs[am[1].toLowerCase()] = am[2] || am[3] || '';
    \\    }
    \\    return new Element(m[1], attrs, m[3]);
    \\  }
    \\
    \\  function simpleQuery(src, selector) {
    \\    if (!selector) return [];
    \\    selector = selector.trim();
    \\    // #id
    \\    if (selector.charAt(0) === '#') {
    \\      var el = findById(src, selector.substring(1));
    \\      return el ? [el] : [];
    \\    }
    \\    // .class
    \\    if (selector.charAt(0) === '.') {
    \\      var cls = selector.substring(1);
    \\      var all = [];
    \\      var re = /<(\w+)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;
    \\      var m;
    \\      while ((m = re.exec(src)) !== null) {
    \\        if (m[2] && m[2].indexOf(cls) >= 0) {
    \\          var attrs = {};
    \\          var ar = new RegExp('(\\w[\\w-]*)\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'g');
    \\          var am;
    \\          while ((am = ar.exec(m[2])) !== null) attrs[am[1].toLowerCase()] = am[2] || am[3] || '';
    \\          all.push(new Element(m[1], attrs, ''));
    \\        }
    \\      }
    \\      return all;
    \\    }
    \\    // tag name
    \\    return findTags(src, selector);
    \\  }
    \\
    \\  // --- Extract <title> ---
    \\  var titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    \\  var pageTitle = titleMatch ? titleMatch[1].replace(/^\s+|\s+$/g, '') : '';
    \\
    \\  // --- Extract body text ---
    \\  var bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    \\  var bodyHtml = bodyMatch ? bodyMatch[1] : html;
    \\  var bodyText = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    \\
    \\  // --- document object ---
    \\  var bodyEl = new Element('body', {}, bodyHtml);
    \\  bodyEl.innerText = bodyText;
    \\  bodyEl.textContent = bodyText;
    \\
    \\  var headEl = new Element('head', {}, '');
    \\  var docEl = new Element('html', {}, html);
    \\
    \\  globalThis.document = {
    \\    title: pageTitle,
    \\    body: bodyEl,
    \\    head: headEl,
    \\    documentElement: docEl,
    \\    readyState: 'complete',
    \\    nodeType: 9,
    \\    contentType: 'text/html',
    \\    characterSet: 'UTF-8',
    \\    charset: 'UTF-8',
    \\    URL: (globalThis.window && globalThis.window.location) ? globalThis.window.location.href : '',
    \\    domain: (globalThis.window && globalThis.window.location) ? globalThis.window.location.hostname : '',
    \\    referrer: '',
    \\    cookie: '',
    \\    write: function(s) { globalThis.__browdie_output += String(s); },
    \\    writeln: function(s) { globalThis.__browdie_output += String(s) + '\n'; },
    \\    getElementById: function(id) { return findById(html, id); },
    \\    querySelector: function(sel) { var r = simpleQuery(html, sel); return r.length > 0 ? r[0] : null; },
    \\    querySelectorAll: function(sel) { return simpleQuery(html, sel); },
    \\    getElementsByTagName: function(tag) { return findTags(html, tag); },
    \\    getElementsByClassName: function(cls) { return simpleQuery(html, '.' + cls); },
    \\    getElementsByName: function() { return []; },
    \\    createElement: function(tag) { return new Element(tag, {}, ''); },
    \\    createTextNode: function(t) { return { nodeType: 3, textContent: String(t), data: String(t) }; },
    \\    createDocumentFragment: function() { return new Element('fragment', {}, ''); },
    \\    createComment: function() { return { nodeType: 8 }; },
    \\    addEventListener: function() {},
    \\    removeEventListener: function() {},
    \\    dispatchEvent: function() { return true; },
    \\    createEvent: function() { return { initEvent: function(){} }; },
    \\    implementation: { hasFeature: function() { return false; } }
    \\  };
    \\
    \\  // --- console ---
    \\  globalThis.console = globalThis.console || {
    \\    log: function() {},
    \\    warn: function() {},
    \\    error: function() {},
    \\    info: function() {},
    \\    debug: function() {},
    \\    dir: function() {},
    \\    trace: function() {},
    \\    assert: function() {},
    \\    time: function() {},
    \\    timeEnd: function() {},
    \\    group: function() {},
    \\    groupEnd: function() {},
    \\    table: function() {}
    \\  };
    \\
    \\  // --- navigator ---
    \\  globalThis.navigator = {
    \\    userAgent: 'kuri-fetch/0.1',
    \\    language: 'en-US',
    \\    languages: ['en-US', 'en'],
    \\    platform: 'kuri',
    \\    cookieEnabled: false,
    \\    onLine: true,
    \\    hardwareConcurrency: 1,
    \\    maxTouchPoints: 0,
    \\    vendor: '',
    \\    appName: 'kuri',
    \\    appVersion: '0.1',
    \\    product: 'Gecko',
    \\    productSub: '20030107',
    \\    sendBeacon: function() { return false; }
    \\  };
    \\
    \\  // Timer stubs (execute synchronously for SSR)
    \\  if (!globalThis.setTimeout) globalThis.setTimeout = function(fn) { if (typeof fn === 'function') fn(); return 0; };
    \\  if (!globalThis.setInterval) globalThis.setInterval = function() { return 0; };
    \\  if (!globalThis.clearTimeout) globalThis.clearTimeout = function() {};
    \\  if (!globalThis.clearInterval) globalThis.clearInterval = function() {};
    \\  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = function(fn) { if (typeof fn === 'function') fn(0); return 0; };
    \\  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = function() {};
    \\
    \\  // Alias window properties to globalThis
    \\  globalThis.self = globalThis.window || globalThis;
    \\  if (globalThis.window) {
    \\    globalThis.window.document = globalThis.document;
    \\    globalThis.window.navigator = globalThis.navigator;
    \\    globalThis.window.console = globalThis.console;
    \\    globalThis.window.self = globalThis.window;
    \\    globalThis.window.setTimeout = globalThis.setTimeout;
    \\    globalThis.window.setInterval = globalThis.setInterval;
    \\    globalThis.window.clearTimeout = globalThis.clearTimeout;
    \\    globalThis.window.clearInterval = globalThis.clearInterval;
    \\  }
    \\})();
;

// --- Tests ---

test "extractInlineScripts finds script bodies" {
    const html = "<html><script>var x = 1;</script><p>text</p><script>var y = 2;</script></html>";
    const scripts = try extractInlineScripts(html, std.testing.allocator);
    defer std.testing.allocator.free(scripts);
    try std.testing.expectEqual(@as(usize, 2), scripts.len);
    try std.testing.expectEqualStrings("var x = 1;", scripts[0]);
    try std.testing.expectEqualStrings("var y = 2;", scripts[1]);
}

test "extractInlineScripts skips external scripts" {
    const html = "<script src=\"app.js\"></script><script>var x = 1;</script>";
    const scripts = try extractInlineScripts(html, std.testing.allocator);
    defer std.testing.allocator.free(scripts);
    try std.testing.expectEqual(@as(usize, 1), scripts.len);
    try std.testing.expectEqualStrings("var x = 1;", scripts[0]);
}

test "extractInlineScripts empty HTML" {
    const scripts = try extractInlineScripts("<p>no scripts</p>", std.testing.allocator);
    defer std.testing.allocator.free(scripts);
    try std.testing.expectEqual(@as(usize, 0), scripts.len);
}

test "JsEngine evalAlloc arithmetic" {
    var engine = try JsEngine.init();
    defer engine.deinit();

    const result = engine.evalAlloc(std.testing.allocator, "'hello ' + 'world'");
    defer if (result) |r| std.testing.allocator.free(r);
    try std.testing.expectEqualStrings("hello world", result.?);
}

test "JsEngine evalAlloc number to string" {
    var engine = try JsEngine.init();
    defer engine.deinit();

    const result = engine.evalAlloc(std.testing.allocator, "String(40 + 2)");
    defer if (result) |r| std.testing.allocator.free(r);
    try std.testing.expectEqualStrings("42", result.?);
}

test "JsEngine evalAlloc syntax error returns null" {
    var engine = try JsEngine.init();
    defer engine.deinit();

    const result = engine.evalAlloc(std.testing.allocator, "this is not valid js {{{{");
    try std.testing.expect(result == null);
}

test "JsEngine document.write capture" {
    var engine = try JsEngine.init();
    defer engine.deinit();

    _ = engine.exec("var __browdie_output = '';");
    _ = engine.exec("var document = {};");
    _ = engine.exec("document.write = function(s) { __browdie_output += String(s); };");
    _ = engine.exec("document.write('hello');");
    const result = engine.evalAlloc(std.testing.allocator, "__browdie_output");
    defer if (result) |r| std.testing.allocator.free(r);
    try std.testing.expectEqualStrings("hello", result.?);
}

test "evalHtmlScripts simple var" {
    // Test with simplest possible script — no document.write dependency
    const html = "<script>globalThis.__browdie_output = 'direct';</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("direct", output.?);
}

test "evalHtmlScripts runs inline scripts" {
    const html = "<html><script>document.write('hello');</script></html>";

    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    // QuickJS should execute document.write and capture output
    try std.testing.expect(output != null);
    try std.testing.expect(output.?.len > 0);
    try std.testing.expectEqualStrings("hello", output.?);
}

test "evalHtmlScripts arithmetic" {
    const html = "<script>document.write(String(40 + 2));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("42", output.?);
}

test "evalHtmlScripts no scripts returns null" {
    const output = try evalHtmlScripts("<p>plain</p>", std.testing.allocator);
    try std.testing.expect(output == null);
}

// --- Layer 3 DOM stub tests ---

test "DOM stubs: document.title" {
    const html = "<html><head><title>My Page</title></head><body><script>document.write(document.title);</script></body></html>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("My Page", output.?);
}

test "DOM stubs: document.getElementById" {
    const html = "<div id=\"main\">content</div><script>var el = document.getElementById('main'); document.write(el ? el.tagName : 'null');</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("DIV", output.?);
}

test "DOM stubs: document.getElementById returns null for missing" {
    const html = "<script>var el = document.getElementById('nope'); document.write(String(el));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("null", output.?);
}

test "DOM stubs: document.querySelector by tag" {
    const html = "<p>hello</p><p>world</p><script>var el = document.querySelector('p'); document.write(el ? el.textContent : 'null');</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("hello", output.?);
}

test "DOM stubs: document.querySelectorAll by tag" {
    const html = "<p>a</p><p>b</p><script>document.write(String(document.querySelectorAll('p').length));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("2", output.?);
}

test "DOM stubs: document.querySelector by id selector" {
    const html = "<span id=\"x\">found</span><script>var el = document.querySelector('#x'); document.write(el ? el.textContent : 'null');</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("found", output.?);
}

test "DOM stubs: document.getElementsByTagName" {
    const html = "<a href=\"/a\">A</a><a href=\"/b\">B</a><script>document.write(String(document.getElementsByTagName('a').length));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("2", output.?);
}

test "DOM stubs: Element.getAttribute" {
    const html = "<a href=\"https://example.com\" id=\"link\">Ex</a><script>var el = document.getElementById('link'); document.write(el.getAttribute('href'));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("https://example.com", output.?);
}

test "DOM stubs: document.body.innerText" {
    const html = "<html><body><p>Hello World</p><script>document.write(document.body.innerText);</script></body></html>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    // Body text should contain "Hello World" (stripped of tags)
    try std.testing.expect(std.mem.indexOf(u8, output.?, "Hello World") != null);
}

test "DOM stubs: window.location with URL" {
    const html = "<script>document.write(window.location.hostname);</script>";
    const output = try evalHtmlScriptsWithUrl(html, "https://example.com/path?q=1#frag", std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("example.com", output.?);
}

test "DOM stubs: window.location.pathname" {
    const html = "<script>document.write(window.location.pathname);</script>";
    const output = try evalHtmlScriptsWithUrl(html, "https://example.com/foo/bar", std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("/foo/bar", output.?);
}

test "DOM stubs: window.location.search and hash" {
    const html = "<script>document.write(window.location.search + '|' + window.location.hash);</script>";
    const output = try evalHtmlScriptsWithUrl(html, "https://example.com/p?q=1&r=2#sec", std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("?q=1&r=2|#sec", output.?);
}

test "DOM stubs: console.log does not crash" {
    const html = "<script>console.log('test'); console.warn('w'); console.error('e'); document.write('ok');</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("ok", output.?);
}

test "DOM stubs: navigator properties" {
    const html = "<script>document.write(navigator.userAgent);</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("kuri-fetch/0.1", output.?);
}

test "DOM stubs: document.createElement" {
    const html = "<script>var el = document.createElement('div'); el.setAttribute('id', 'new'); document.write(el.tagName + ':' + el.getAttribute('id'));</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("DIV:new", output.?);
}

test "DOM stubs: document.readyState" {
    const html = "<script>document.write(document.readyState);</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("complete", output.?);
}

test "DOM stubs: setTimeout executes synchronously" {
    const html = "<script>var x = ''; setTimeout(function() { x = 'fired'; }, 0); document.write(x);</script>";
    const output = try evalHtmlScripts(html, std.testing.allocator);
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expect(output != null);
    try std.testing.expectEqualStrings("fired", output.?);
}

test "DOM stubs: direct shim check" {
    var engine = try JsEngine.init();
    defer engine.deinit();

    _ = engine.exec("globalThis.__browdie_output = '';");
    _ = engine.exec("globalThis.__browdie_html = '<title>Hi</title>';");
    _ = engine.exec("globalThis.window = { location: { href: '', protocol: '', host: '', pathname: '/', search: '', hash: '', hostname: '', port: '', origin: '', toString: function() { return ''; } } };");

    const ok = engine.exec(dom_shim_js);
    try std.testing.expect(ok);

    const title = engine.evalAlloc(std.testing.allocator, "document.title");
    defer if (title) |t| std.testing.allocator.free(t);
    try std.testing.expectEqualStrings("Hi", title.?);

    // Now test document.write flow
    _ = engine.exec("document.write(document.title);");
    const output = engine.evalAlloc(std.testing.allocator, "globalThis.__browdie_output");
    defer if (output) |o| std.testing.allocator.free(o);
    try std.testing.expectEqualStrings("Hi", output.?);
}

test "escapeForJs handles special characters" {
    const result = escapeForJs("hello \"world\"\nnew\\line", std.testing.allocator);
    try std.testing.expect(result != null);
    defer std.testing.allocator.free(result.?);
    try std.testing.expectEqualStrings("hello \\\"world\\\"\\nnew\\\\line", result.?);
}
