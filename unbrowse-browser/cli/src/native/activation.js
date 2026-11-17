// Unbrowse fork: what activating an element could navigate to or submit, following the platform's own forwarding, and
// which addresses run script. The one description of both: the agent's isolated world reads it before the script's own `click()`, `dispatchEvent` and form
// submission (`agent_world.js`), and the browser's commands before a click, a key or a newline typed
// (`agent_world.rs`). Each answer is every address the activation could reach; a caller refuses if any of them runs
// script. Where the platform's forwarding can't be followed with certainty, every candidate it could reach is named.
//
// HTML's activation behaviours, and how each is read (an element's own, and those of every element its click passes
// on the way up, since a click activates the nearest of them on its path):
// - `a` and `area` (HTML or SVG): their `href`, and an SVG link's `xlink:href`;
// - a submit button (`button` of type submit or no type, `input` of type `submit` or `image`): its `formaction` and its
//   form owner's `action`, the owner found as the platform finds it (an ancestor `form`, or the one its `form`
//   attribute names from anywhere in the document);
// - `label`: its labelled control (by `for`, or the first labelable element inside it), read as clicked itself;
// - `img` with `usemap`: every `area` in the image's tree (which map and which area the point falls on isn't certain);
// - `form` (submitted): its `action` and every submit control's `formaction`;
// - implicit submission (Enter in a field, `asInput`): the field's form owner, read as submitted;
// - `summary` (opens its `details`), `input` of type checkbox, radio, reset, file, color and the rest, `button` of type
//   reset or button, `details`, `dialog` and popover or command buttons: no navigation, nothing to read.
// The path up crosses a slot to where the element is shown (`assignedSlot`) and a shadow root to its host.
({
  // The built-ins read with, taken when called: the agent's world takes them before any agent code runs.
  natives(g) {
    const d = Object.getOwnPropertyDescriptor;
    const get = (C, name) => { const p = g[C] && g[C].prototype; const x = p && d(p, name); return x && x.get; };
    const forms = [];
    for (const C of ['HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLObjectElement', 'HTMLOutputElement', 'HTMLFieldSetElement', 'HTMLImageElement']) {
      const f = get(C, 'form');
      if (f) forms.push(f);
    }
    return {
      apply: Reflect.apply,
      push: Array.prototype.push,
      lower: String.prototype.toLowerCase,
      indexOf: String.prototype.indexOf,
      getAttr: g.Element.prototype.getAttribute,
      getAttrNS: g.Element.prototype.getAttributeNS,
      localName: get('Element', 'localName'),
      nodeType: get('Node', 'nodeType'),
      parentElement: get('Node', 'parentElement'),
      parentNode: get('Node', 'parentNode'),
      rootNode: g.Node.prototype.getRootNode,
      host: get('ShadowRoot', 'host'),
      slotOfElement: get('Element', 'assignedSlot'),
      labelControl: get('HTMLLabelElement', 'control'),
      forms,
      formElements: get('HTMLFormElement', 'elements'),
      collectionLength: get('HTMLCollection', 'length'),
      collectionItem: g.HTMLCollection.prototype.item,
      docQuery: g.Document.prototype.querySelectorAll,
      fragmentQuery: g.DocumentFragment.prototype.querySelectorAll,
      listLength: get('NodeList', 'length'),
      listItem: g.NodeList.prototype.item,
      decode: g.decodeURIComponent,
    };
  },

  // `text` as the browser reads an address, read with `o`: every space, control character, tab and newline dropped
  // (a superset of what the browser drops: it trims the ends and drops a tab or newline anywhere), in lower case. Read
  // a character at a time, with no built-in a script could have replaced (a pattern's replace is looked up on the
  // pattern when it is used).
  bare(text, o) {
    const s = '' + text;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c <= ' ' || (c >= '\u007f' && c <= '\u00a0')) continue;
      out += c;
    }
    return o.apply(o.lower, out, []);
  },

  // Whether `text` holds a script address anywhere (`javascript:` or `vbscript:`, read as [`bare`]): an address is
  // written into many places that are not only an address (a refresh's content, an animation's list of values).
  holdsScriptAddress(text, o) {
    const b = this.bare(text, o);
    return o.apply(o.indexOf, b, ['javascript:']) >= 0 || o.apply(o.indexOf, b, ['vbscript:']) >= 0;
  },

  // Whether navigating to `address` runs script: a `javascript:` or `vbscript:` address (read as [`bare`]) unless its
  // code is a literal no-op (`javascript:void(0)`, `javascript:;`, `javascript:`), which runs nothing and leaves the
  // page's own handlers to act. Code that can't be decoded runs.
  runsScript(address, o) {
    if (address === null || address === undefined) return false;
    const b = this.bare(address, o);
    if (o.apply(o.indexOf, b, ['vbscript:']) === 0) return true;
    if (o.apply(o.indexOf, b, ['javascript:']) !== 0) return false;
    let rest = '';
    for (let i = 11; i < b.length; i++) rest += b[i];
    let code;
    try { code = o.apply(o.decode, undefined, [rest]); } catch (_) { return true; }
    let c = '';
    for (let i = 0; i < code.length; i++) if (code[i] > ' ' && code[i] !== '\u00a0') c += code[i];
    return !(c === '' || c === ';' || c === 'void(0)' || c === 'void(0);' || c === 'void0' || c === 'void0;' || c === 'undefined' || c === 'undefined;');
  },

  // Every address activating `el` could reach (`asInput`: Enter in it too), read with `o` (`natives`).
  addresses(el, asInput, o) {
    const A = o.apply;
    const out = [];
    const say = (v) => { if (v !== null && v !== undefined) A(o.push, out, ['' + v]); };
    const safe = (f) => { try { return f(); } catch (_) { return null; } };
    const isElement = (n) => n !== null && n !== undefined && safe(() => A(o.nodeType, n, [])) === 1;
    const name = (n) => safe(() => A(o.localName, n, [])) || '';
    const attr = (n, a) => safe(() => A(o.getAttr, n, [a]));
    const type = (n) => { const t = attr(n, 'type'); return t === null ? '' : A(o.lower, '' + t, []); };
    const formOf = (n) => {
      for (let i = 0; i < o.forms.length; i++) {
        const f = safe(() => A(o.forms[i], n, []));
        if (f) return f;
      }
      return null;
    };
    const isSubmit = (n) => {
      const ln = name(n);
      if (ln === 'button') { const t = type(n); return t === '' || t === 'submit' || (t !== 'reset' && t !== 'button'); }
      return ln === 'input' && (type(n) === 'submit' || type(n) === 'image');
    };
    const submitted = (form) => {
      say(attr(form, 'action'));
      const all = safe(() => A(o.formElements, form, []));
      const n = all ? safe(() => A(o.collectionLength, all, [])) || 0 : 0;
      for (let i = 0; i < n; i++) {
        const c = safe(() => A(o.collectionItem, all, [i]));
        if (c && isSubmit(c)) say(attr(c, 'formaction'));
      }
    };
    const areas = (img) => {
      const root = safe(() => A(o.rootNode, img, []));
      if (!root) return;
      const list = safe(() => A(o.docQuery, root, ['area'])) || safe(() => A(o.fragmentQuery, root, ['area']));
      const n = list ? safe(() => A(o.listLength, list, [])) || 0 : 0;
      for (let i = 0; i < n; i++) {
        const a = safe(() => A(o.listItem, list, [i]));
        say(attr(a, 'href'));
      }
    };
    const seen = [];
    const visit = (start, depth) => {
      // The click's path up: each element, then where it is shown (its slot) and its parent, through a shadow root to its
      // host. Every element on the way is read.
      // Read by index, never through an array's own methods: in the agent's world its script may have replaced them.
      const queue = [start];
      for (let q = 0; q < queue.length && seen.length < 4096; q++) {
        const n = queue[q];
        let met = false;
        for (let i = 0; i < seen.length; i++) if (seen[i] === n) met = true;
        if (!isElement(n) || met) continue;
        A(o.push, seen, [n]);
        const ln = name(n);
        if (ln === 'a' || ln === 'area') {
          say(attr(n, 'href'));
          say(safe(() => A(o.getAttrNS, n, ['http://www.w3.org/1999/xlink', 'href'])));
        }
        if (isSubmit(n)) {
          say(attr(n, 'formaction'));
          const f = formOf(n);
          if (f) say(attr(f, 'action'));
        }
        if (ln === 'form') submitted(n);
        if (ln === 'img' && attr(n, 'usemap') !== null) areas(n);
        if (ln === 'label' && depth < 4) {
          const c = safe(() => A(o.labelControl, n, []));
          if (c) visit(c, depth + 1);
        }
        const slot = safe(() => A(o.slotOfElement, n, []));
        if (slot) A(o.push, queue, [slot]);
        const up = safe(() => A(o.parentElement, n, []));
        if (up) A(o.push, queue, [up]);
        else {
          const p = safe(() => A(o.parentNode, n, []));
          const h = p && safe(() => A(o.host, p, []));
          if (h) A(o.push, queue, [h]);
        }
      }
    };
    visit(el, 0);
    if (asInput && isElement(el)) {
      const f = name(el) === 'form' ? el : formOf(el);
      if (f) submitted(f);
    }
    return out;
  },
})
