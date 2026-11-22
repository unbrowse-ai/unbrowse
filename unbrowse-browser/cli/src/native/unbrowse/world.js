// Unbrowse fork: the world an agent's script runs in (`world.rs`). An isolated world shares the page's DOM and
// none of its script, so what is installed here is seen only by code that runs here: the page's own code keeps the
// real `document.cookie` and storage, and the site works as it did. Installed before any agent code runs in the world
// (by `Page.addScriptToEvaluateOnNewDocument` for every frame's copy of the world, and again before each script), it:
// - answers `document.cookie` with every value said as `{session}`, names kept, and refuses writes to it;
// - answers `localStorage` and `sessionStorage` with every value said as `{session}`, keys kept, and refuses writes;
// - takes away what can't be answered that way: IndexedDB, the Cache API, the Cookie Store API, the origin's file
//   system, workers and service workers (a worker could read IndexedDB or the caches), and opening a window;
// - refuses every way a script here could hand code to the page's own world, where the real values are: a `script`
//   element, an `on…` handler attribute, a script address in any text written to any property or attribute, HTML parsed from
//   a string (`innerHTML` and its kin, `document.write`, `createContextualFragment`, `DOMParser`, `srcdoc`), XSLT,
//   `execCommand` and a `blob:` address of its own making;
// - and hands out a frame's window or document only when that frame's copy of this world has all of the above.
// Every built-in it uses is taken before any agent code can change one, and called through `Reflect.apply` as taken, so
// replacing a prototype's method later reaches nothing here. Nothing is configurable once set.
((activation) => {
  'use strict';
  const g = globalThis;
  // The built-ins `activation.js` reads with, taken before anything here or any agent code changes one.
  const act = activation.natives(g);
  const MARK = 'unbrowseSessionCookie';
  const O = Object, R = Reflect;
  const desc = O.getOwnPropertyDescriptor, define = O.defineProperty, getProto = O.getPrototypeOf;
  const apply = R.apply, ownKeys = R.ownKeys;
  const TE = g.TypeError, Px = g.Proxy;
  const split = g.String.prototype.split, indexOf = g.String.prototype.indexOf, slice = g.String.prototype.slice;
  const toLower = g.String.prototype.toLowerCase, replace = g.String.prototype.replace, startsWith = g.String.prototype.startsWith;
  const join = g.Array.prototype.join, push = g.Array.prototype.push;
  const SAID = '{session}';
  const refuse = (what) => { throw new TE(what + " isn't open to an agent's script: the site's session stays in the page"); };

  const Doc = g.Document && g.Document.prototype;
  if (!Doc) return false;
  const already = desc(Doc, 'cookie');
  if (already && already.get && already.get.name === MARK && already.configurable === false) return true;

  // Each property is made non-configurable, so nothing after this can put the original back.
  const lock = (on, name, d) => { if (on) define(on, name, { ...d, configurable: false }); };
  const getter = (on, name, get) => {
    const was = on && desc(on, name);
    if (!on || !was) return;
    lock(on, name, { get, set: was.set ? function () { refuse(name); } : undefined, enumerable: was.enumerable });
  };
  const method = (on, name, fn) => { if (on && desc(on, name)) lock(on, name, { value: fn, writable: false, enumerable: false }); };
  const none = (on, name) => { if (on && desc(on, name)) lock(on, name, { get: function () { refuse(name); }, set: undefined, enumerable: false }); };

  // document.cookie: names kept, every value said as the session.
  const realCookie = already.get;
  const cookie = {
    [MARK]() {
      const all = apply(split, apply(realCookie, this, []), ['; ']);
      const out = [];
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        if (p === '') continue;
        const at = apply(indexOf, p, ['=']);
        apply(push, out, [at < 0 ? SAID : apply(slice, p, [0, at]) + '=' + SAID]);
      }
      return apply(join, out, ['; ']);
    },
  }[MARK];
  lock(Doc, 'cookie', { get: cookie, set: function () { refuse('setting document.cookie'); }, enumerable: true });

  // Storage: a stand-in that says every value as the session, keys kept, writes refused.
  const St = g.Storage && g.Storage.prototype;
  const realKey = St && St.key, realLength = St && desc(St, 'length').get, realGetItem = St && St.getItem;
  const keysOf = (s) => {
    const n = apply(realLength, s, []);
    const out = [];
    for (let i = 0; i < n; i++) apply(push, out, [apply(realKey, s, [i])]);
    return out;
  };
  const has = (s, k) => apply(realGetItem, s, [k]) !== null;
  if (St) {
    method(St, 'getItem', function getItem(k) { return has(this, '' + k) ? SAID : null; });
    method(St, 'setItem', function setItem() { refuse('writing storage'); });
    method(St, 'removeItem', function removeItem() { refuse('writing storage'); });
    method(St, 'clear', function clear() { refuse('writing storage'); });
  }
  const standIn = (real) => new Px({}, {
    get(_, k) {
      if (k === 'length') return apply(realLength, real, []);
      if (k === 'getItem') return function getItem(key) { return has(real, '' + key) ? SAID : null; };
      if (k === 'key') return function key(i) { return apply(realKey, real, [i]); };
      if (k === 'setItem' || k === 'removeItem' || k === 'clear') return function () { refuse('writing storage'); };
      return typeof k === 'string' && has(real, k) ? SAID : undefined;
    },
    set() { refuse('writing storage'); },
    defineProperty() { refuse('writing storage'); },
    deleteProperty() { refuse('writing storage'); },
    has(_, k) { return typeof k === 'string' && has(real, k); },
    ownKeys() { return keysOf(real); },
    getOwnPropertyDescriptor(_, k) { return typeof k === 'string' && has(real, k) ? { value: SAID, writable: false, enumerable: true, configurable: true } : undefined; },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    preventExtensions() { return false; },
  });
  for (const name of ['localStorage', 'sessionStorage']) {
    const at = desc(g, name) ? g : desc(getProto(g), name) ? getProto(g) : null;
    const real = at && desc(at, name).get;
    if (real) lock(g, name, { get: function () { return standIn(apply(real, g, [])); }, set: undefined, enumerable: true });
  }
  const SE = g.StorageEvent && g.StorageEvent.prototype;
  getter(SE, 'newValue', function () { return SAID; });
  getter(SE, 'oldValue', function () { return SAID; });
  getter(SE, 'storageArea', function () { return null; });

  // What can't be answered as a stand-in is taken away.
  for (const name of ['indexedDB', 'caches', 'cookieStore', 'Worker', 'SharedWorker', 'open', 'opener']) {
    const at = desc(g, name) ? g : desc(getProto(g), name) ? getProto(g) : null;
    if (at) lock(g, name, { get: function () { refuse(name); }, set: undefined, enumerable: false });
  }
  const N = g.Navigator && g.Navigator.prototype;
  none(N, 'serviceWorker');
  none(N, 'storage');
  none(N, 'storageBuckets');

  // No code handed to the page's own world.
  const lower = (s) => apply(toLower, '' + s, []);
  const bare = (s) => activation.bare(s, act);
  // A script address, read as the browser reads one (spaces, tabs, newlines and control characters dropped, any case),
  // anywhere in the text: an address is written into many places that are not only an address (a refresh's content,
  // an SVG animation's list of values).
  const scriptAddress = (value) => activation.holdsScriptAddress(value, act);
  // Where an activation goes, beyond its addresses: which form a control belongs to (`form`), which control a label
  // forwards to (`for`), which map an image's areas come from (`usemap`), and whether a button or an input submits
  // (`type`). The agent's script may not change any of them: a change between the guard's read and the click could send
  // the activation somewhere the guard never read.
  const forwardingName = (name, el) => {
    const n = lower(name);
    const local = apply(indexOf, n, [':']) >= 0 ? apply(slice, n, [apply(indexOf, n, [':']) + 1]) : n;
    if (local === 'form' || local === 'for' || local === 'usemap') return true;
    if (local !== 'type' || el === null || el === undefined) return false;
    let ln = '';
    try { ln = apply(act.localName, el, []); } catch (_) { ln = ''; }
    return ln === 'button' || ln === 'input';
  };
  const runsCode = (name, value) => {
    const n = lower(name);
    const local = apply(indexOf, n, [':']) >= 0 ? apply(slice, n, [apply(indexOf, n, [':']) + 1]) : n;
    return apply(startsWith, local, ['on']) || local === 'srcdoc' || scriptAddress(value);
  };
  const E = g.Element && g.Element.prototype;
  if (E) {
    const realSet = E.setAttribute, realSetNS = E.setAttributeNS, realToggle = E.toggleAttribute;
    // The value is made text once, and the text checked is the text written: an object whose text changes between
    // reads gets no second read.
    method(E, 'setAttribute', function setAttribute(name, value) {
      const n = '' + name, v = '' + value;
      if (apply(act.localName, this, []) === 'script') refuse('changing a script');
      if (runsCode(n, v)) refuse('an attribute that runs code');
      if (forwardingName(n, this)) refuse('changing where an activation goes');
      return apply(realSet, this, [n, v]);
    });
    method(E, 'setAttributeNS', function setAttributeNS(ns, name, value) {
      const n = '' + name, v = '' + value;
      if (apply(act.localName, this, []) === 'script') refuse('changing a script');
      if (runsCode(n, v)) refuse('an attribute that runs code');
      if (forwardingName(n, this)) refuse('changing where an activation goes');
      return apply(realSetNS, this, [ns, n, v]);
    });
    method(E, 'toggleAttribute', function toggleAttribute(name, force) {
      const n = '' + name;
      if (runsCode(n, '')) refuse('an attribute that runs code');
      if (forwardingName(n, this)) refuse('changing where an activation goes');
      return apply(realToggle, this, force === undefined ? [n] : [n, force]);
    });
    const realRemove = E.removeAttribute, realRemoveNS = E.removeAttributeNS;
    method(E, 'removeAttribute', function removeAttribute(name) {
      const n = '' + name;
      if (forwardingName(n, this)) refuse('changing where an activation goes');
      return apply(realRemove, this, [n]);
    });
    method(E, 'removeAttributeNS', function removeAttributeNS(ns, name) {
      const n = '' + name;
      if (forwardingName(n, this)) refuse('changing where an activation goes');
      return apply(realRemoveNS, this, [ns, n]);
    });
    method(E, 'removeAttributeNode', function removeAttributeNode() { refuse('removing an attribute node'); });
    method(E, 'setAttributeNode', function setAttributeNode() { refuse('setting an attribute node'); });
    method(E, 'setAttributeNodeNS', function setAttributeNodeNS() { refuse('setting an attribute node'); });
  }
  // HTML from a string, by whatever name the browser gives it: every method and every setter of every interface, and
  // every method on an interface itself, whose name holds `HTML` takes markup and parses it (`innerHTML`, `outerHTML`,
  // `insertAdjacentHTML`, `setHTMLUnsafe`, `Document.parseHTMLUnsafe`, the sanitizing `setHTML` and `Document.parseHTML`,
  // and what Chrome 157 added on elements, shadow roots and text: `append…`, `prepend…`, `before…`, `after…` and
  // `replaceWith…HTML` and `…HTMLUnsafe`, and every `stream…HTML…`). They are found here, not listed: a fixed list of
  // seven left 46 of the 59 Chrome 157 has open. Left open are the names that only read or make nothing from markup:
  // `get…` (`getHTML`), `is…` (`isHTML`) and `createHTMLDocument` (its title is text).
  const parsesHTML = (name) => typeof name === 'string' && apply(indexOf, name, ['HTML']) >= 0
    && !apply(startsWith, name, ['get']) && !apply(startsWith, name, ['is']) && name !== 'createHTMLDocument';
  const refuseHTML = (on) => {
    const keys = ownKeys(on);
    for (let j = 0; j < keys.length; j++) {
      const name = keys[j];
      if (!parsesHTML(name)) continue;
      const was = desc(on, name);
      if (!was || !was.configurable) continue;
      try {
        if (typeof was.value === 'function') lock(on, name, { value: function () { refuse('HTML from a string'); }, writable: false, enumerable: false });
        else if (was.set) lock(on, name, { get: was.get, set: function () { refuse('HTML from a string'); }, enumerable: was.enumerable });
      } catch (_) { /* a member the platform won't let be redefined */ }
    }
  };
  {
    const globals = ownKeys(g);
    for (let i = 0; i < globals.length; i++) {
      let C;
      try { C = g[globals[i]]; } catch (_) { continue; }
      if (typeof C !== 'function') continue;
      refuseHTML(C);
      const p = C.prototype;
      if (p && typeof p === 'object') refuseHTML(p);
    }
  }
  const A = g.Attr && g.Attr.prototype;
  if (A) {
    const realName = desc(A, 'name').get;
    for (const name of ['value']) {
      const was = desc(A, name);
      const owner = desc(A, 'ownerElement').get;
      if (was) lock(A, name, { get: was.get, set: function (v) { const n = apply(realName, this, []); if (runsCode(n, v)) refuse('an attribute that runs code'); if (forwardingName(n, apply(owner, this, []))) refuse('changing where an activation goes'); apply(was.set, this, [v]); }, enumerable: was.enumerable });
    }
  }
  const Nd = g.Node && g.Node.prototype;
  if (Nd && A) {
    const realName = desc(A, 'name').get, realType = desc(Nd, 'nodeType').get;
    for (const name of ['nodeValue', 'textContent']) {
      const was = desc(Nd, name);
      const owner = desc(A, 'ownerElement').get;
      if (was) lock(Nd, name, { get: was.get, set: function (v) { if (isScriptNode(this)) refuse('changing a script'); if (apply(realType, this, []) === 2) { const n = apply(realName, this, []); if (runsCode(n, v)) refuse('an attribute that runs code'); if (forwardingName(n, apply(owner, this, []))) refuse('changing where an activation goes'); } apply(was.set, this, [v]); }, enumerable: was.enumerable });
    }
  }
  const NNM = g.NamedNodeMap && g.NamedNodeMap.prototype;
  method(NNM, 'setNamedItem', function setNamedItem() { refuse('setting an attribute node'); });
  method(NNM, 'setNamedItemNS', function setNamedItemNS() { refuse('setting an attribute node'); });
  method(NNM, 'removeNamedItem', function removeNamedItem() { refuse('removing an attribute node'); });
  method(NNM, 'removeNamedItemNS', function removeNamedItemNS() { refuse('removing an attribute node'); });
  // A script element is code the page's world runs: the agent's script may not change one (its type, text, source or
  // address, or the text inside it) nor put one anywhere (insert it, move it, clone it, import or adopt it, or a node
  // holding one). A page's inert or empty script, or one in its template, given new code and put back, would run that
  // code in the page's own world.
  const docQuery = g.Document && g.Document.prototype.querySelector, elQuery = E && E.querySelector;
  const fragQuery = g.DocumentFragment && g.DocumentFragment.prototype.querySelector;
  const parentOf = Nd && desc(Nd, 'parentNode').get;
  const isScriptNode = (n) => {
    let t;
    try { t = apply(act.nodeType, n, []); } catch (_) { return false; }
    if (t === 1) { try { return apply(act.localName, n, []) === 'script'; } catch (_) { return false; } }
    if (t === 3 || t === 4) { const up = apply(parentOf, n, []); return !!up && isScriptNode(up); }
    return false;
  };
  const holdsScript = (n) => {
    if (n === null || n === undefined || typeof n !== 'object') return false;
    let t;
    try { t = apply(act.nodeType, n, []); } catch (_) { return false; }
    if (isScriptNode(n)) return true;
    try {
      if (t === 1) return apply(elQuery, n, ['script']) !== null;
      if (t === 11) return apply(fragQuery, n, ['script']) !== null;
      if (t === 9) return apply(docQuery, n, ['script']) !== null;
    } catch (_) { return true; }
    return false;
  };
  const noScripts = (self, args) => {
    if (isScriptNode(self)) refuse('changing a script');
    for (let i = 0; i < args.length; i++) if (holdsScript(args[i])) refuse('putting a script anywhere');
  };
  const guardNodes = (P, names) => {
    if (!P) return;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const was = desc(P, name);
      if (!was || typeof was.value !== 'function' || !was.configurable) continue;
      const real = was.value;
      lock(P, name, { value: function (...args) { noScripts(this, args); return apply(real, this, args); }, writable: false, enumerable: false });
    }
  };
  guardNodes(Nd, ['appendChild', 'insertBefore', 'replaceChild', 'cloneNode']);
  guardNodes(E, ['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith', 'insertAdjacentElement', 'insertAdjacentText']);
  guardNodes(g.DocumentFragment && g.DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']);
  guardNodes(g.Document && g.Document.prototype, ['append', 'prepend', 'replaceChildren', 'importNode', 'adoptNode']);
  guardNodes(g.CharacterData && g.CharacterData.prototype, ['appendData', 'insertData', 'replaceData', 'deleteData', 'before', 'after', 'replaceWith']);
  guardNodes(g.Text && g.Text.prototype, ['splitText']);
  guardNodes(g.Range && g.Range.prototype, ['insertNode', 'surroundContents']);
  // `document.open` with three arguments opens a window at an address it doesn't check; with fewer it clears the page
  // for a `write` that is refused anyway.
  method(g.Document && g.Document.prototype, 'open', function open() { refuse('document.open'); });
  // A worklet runs code of its own: none from the agent's script.
  method(g.Worklet && g.Worklet.prototype, 'addModule', function addModule() { refuse('a worklet'); });
  // An event the agent's script stops never reaches the guard's own check at the moment of activation (`world.rs`):
  // the script may cancel an event's default, never hide the event.
  const EV = g.Event && g.Event.prototype;
  method(EV, 'stopPropagation', function stopPropagation() { refuse('stopping an event'); });
  method(EV, 'stopImmediatePropagation', function stopImmediatePropagation() { refuse('stopping an event'); });
  if (EV && desc(EV, 'cancelBubble')) {
    const was = desc(EV, 'cancelBubble');
    lock(EV, 'cancelBubble', { get: was.get, set: function () { refuse('stopping an event'); }, enumerable: was.enumerable });
  }
  const realCreate = Doc.createElement, realCreateNS = Doc.createElementNS;
  const isScript = (name) => { const n = lower(name); const at = apply(indexOf, n, [':']); return (at >= 0 ? apply(slice, n, [at + 1]) : n) === 'script'; };
  method(Doc, 'createElement', function createElement(name, options) {
    if (isScript(name)) refuse('a script element');
    return apply(realCreate, this, options === undefined ? [name] : [name, options]);
  });
  method(Doc, 'createElementNS', function createElementNS(ns, name, options) {
    if (isScript(name)) refuse('a script element');
    return apply(realCreateNS, this, options === undefined ? [ns, name] : [ns, name, options]);
  });
  method(Doc, 'write', function write() { refuse('document.write'); });
  method(Doc, 'writeln', function writeln() { refuse('document.write'); });
  method(Doc, 'execCommand', function execCommand() { refuse('execCommand'); });
  method(g.Range && g.Range.prototype, 'createContextualFragment', function createContextualFragment() { refuse('HTML from a string'); });
  method(g.DOMParser && g.DOMParser.prototype, 'parseFromString', function parseFromString() { refuse('HTML from a string'); });
  // A `blob:` address the script makes has the page's own origin: a page made of it would run the script's markup in
  // the page's own world.
  if (g.URL && desc(g.URL, 'createObjectURL')) lock(g.URL, 'createObjectURL', { value: function createObjectURL() { refuse('URL.createObjectURL'); }, writable: false, enumerable: false });
  for (const name of ['XSLTProcessor']) {
    if (desc(g, name)) lock(g, name, { get: function () { refuse(name); }, set: undefined, enumerable: false });
  }
  // No script address written anywhere: every property of every interface this world has that takes a value, an
  // address or not (an HTML or SVG link's, an animated string's `baseVal`, a form's `action`, a refresh's content), is
  // read for one before the value is written. A value that isn't text is made text once where the property holds text,
  // and that text is what is written.
  const names = ownKeys(g);
  for (let i = 0; i < names.length; i++) {
    let C;
    try { C = g[names[i]]; } catch (_) { continue; }
    const p = typeof C === 'function' && C.prototype;
    if (!p || typeof p !== 'object') continue;
    const props = ownKeys(p);
    for (let j = 0; j < props.length; j++) {
      const name = props[j];
      const was = desc(p, name);
      if (!was || !was.set || !was.configurable) continue;
      // The properties that say where an activation goes (`htmlFor`, `useMap`, a button's or an input's `type`).
      const forwards = name === 'htmlFor' || name === 'useMap' || (name === 'type' && (p === (g.HTMLButtonElement && g.HTMLButtonElement.prototype) || p === (g.HTMLInputElement && g.HTMLInputElement.prototype)));
      // Markup a frame parses into a document of the page's own origin.
      const markup = name === 'srcdoc';
      try {
        lock(p, name, {
          get: was.get,
          set: function (v) {
            if (forwards) refuse('changing where an activation goes');
            if (markup) refuse('markup for a frame');
            if (isScriptNode(this)) refuse('changing a script');
            let pass = v;
            if (typeof v === 'string') {
              if (scriptAddress(v)) refuse('a script address');
            } else if (v !== null && (typeof v === 'object' || typeof v === 'function') && was.get) {
              let now;
              try { now = apply(was.get, this, []); } catch (_) { now = undefined; }
              if (typeof now === 'string') {
                pass = '' + v;
                if (scriptAddress(pass)) refuse('a script address');
              }
            }
            apply(was.set, this, [pass]);
          },
          enumerable: was.enumerable,
        });
      } catch (_) { /* a property the platform won't let be redefined keeps its own setter */ }
    }
  }
  none(g, 'navigation');

  // What the script activates itself (an element's `click()`, an event it dispatches, a form it submits) never runs a
  // script address the page holds, unless it is a literal no-op (`javascript:void(0)`): the same rule the browser's own
  // commands keep (`world.rs`, `runs_script_address`).
  // What activating it could reach, followed as the platform forwards it (`activation.js`: a label to its control, a
  // control to its form owner wherever that is, an image map to its areas, Enter in a field to its form).
  const isElement = (el) => { try { return el !== null && el !== undefined && apply(act.nodeType, el, []) === 1; } catch (_) { return false; } };
  const guard = (el, asInput) => {
    const t = activation.addresses(el, asInput, act);
    for (let i = 0; i < t.length; i++) if (activation.runsScript(t[i], act)) refuse('activating a script address');
  };
  const HE = g.HTMLElement && g.HTMLElement.prototype, SE2 = g.SVGElement && g.SVGElement.prototype;
  for (const P of [HE, SE2, E]) {
    if (!P || !desc(P, 'click')) continue;
    const real = P.click;
    method(P, 'click', function click() { guard(this, false); return apply(real, this, []); });
  }
  const ET = g.EventTarget && g.EventTarget.prototype;
  if (ET) {
    const real = ET.dispatchEvent;
    method(ET, 'dispatchEvent', function dispatchEvent(ev) { if (isElement(this)) guard(this, true); return apply(real, this, [ev]); });
  }
  const FE = g.HTMLFormElement && g.HTMLFormElement.prototype;
  if (FE) {
    const realSubmit = FE.submit, realRequest = FE.requestSubmit;
    method(FE, 'submit', function submit() { guard(this, false); return apply(realSubmit, this, []); });
    if (realRequest) method(FE, 'requestSubmit', function requestSubmit(by) { if (by !== undefined && by !== null) guard(by, false); guard(this, false); return apply(realRequest, this, by === undefined ? [] : [by]); });
  }

  // A frame's window or document only when that frame's copy of this world has all of the above.
  const ready = (w) => {
    try {
      const d = w && w.Document && desc(w.Document.prototype, 'cookie');
      return !!(d && d.get && d.get.name === MARK && d.configurable === false);
    } catch (_) {
      return false;
    }
  };
  for (const type of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement']) {
    const p = g[type] && g[type].prototype;
    if (!p) continue;
    for (const name of ['contentWindow', 'contentDocument']) {
      const was = desc(p, name);
      if (!was || !was.get) continue;
      lock(p, name, {
        get: function () {
          const got = apply(was.get, this, []);
          if (got === null) return null;
          const w = name === 'contentWindow' ? got : got.defaultView;
          return w === null || ready(w) ? got : null;
        },
        set: undefined,
        enumerable: was.enumerable,
      });
    }
    if (desc(p, 'getSVGDocument')) method(p, 'getSVGDocument', function getSVGDocument() { return null; });
  }
  return true;
})
