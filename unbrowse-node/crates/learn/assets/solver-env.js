// The challenge sandbox's environment: every probe answers with our identity.
// Loaded in Node/V8 before the orchestrate; the network layer captures
// instead of sending.
//
// Verifier: run the orchestrate against this and check the produced blob's
// shape — `$`-separated pairs of 24/22-char base64 segments (the captured
// wire format).
'use strict';

const identity = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  languages: ['en-US', 'en'],
  hardwareConcurrency: 10,
  deviceMemory: 16,
  screen: { width: 2400, height: 1374, availWidth: 2400, availHeight: 1332, colorDepth: 30, pixelDepth: 30 },
  timezoneOffset: 480, // UTC+8 (Singapore), fixed per identity
};

// Globals the host may define as getter-only (Node's navigator) get replaced
// through defineProperty.
function defGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
  } catch (e) {
    try { globalThis[name] = value; } catch (e2) {}
  }
}

const sent = [];
defGlobal('__sent', sent);

// --- the capture layer: the encoder's requests become data, not traffic.
function FakeXHR() {
  this.readyState = 0;
  this.status = 0;
  this.responseText = '';
}
FakeXHR.prototype.open = function (m, u) { this.__m = m; this.__u = String(u); };
FakeXHR.prototype.setRequestHeader = function () {};
FakeXHR.prototype.send = function (body) {
  sent.push({ method: this.__m, url: this.__u, body: typeof body === 'string' ? body : String(body) });
  this.readyState = 4;
  this.status = 200;
  this.responseText = '{}';
  if (this.onreadystatechange) this.onreadystatechange();
  if (this.onload) this.onload();
};
defGlobal('XMLHttpRequest', FakeXHR);

// --- the identity layer.
// Chrome's plugin surface: 5 PDF-viewer plugins and 2 mime types, indexable
// like the real PluginArray/MimeTypeArray (plugins[i] must be a Plugin).
function makeMimeType(type, suffixes, description) {
  const t = { type, suffixes, description, enabledPlugin: null };
  return t;
}
function makePlugin(name, filename, description, mimes) {
  const p = { name, filename, description, length: mimes.length, version: '' };
  mimes.forEach((mt, i) => { p[i] = mt; mt.enabledPlugin = p; });
  p.item = (i) => (i == null ? undefined : p[i] || null);
  p.namedItem = (n) => mimes.find((mt) => mt.type === n) || null;
  return p;
}
function makePluginArray() {
  const pdf = () => makeMimeType('application/pdf', 'pdf', 'Portable Document Format');
  const textPdf = () => makeMimeType('text/pdf', 'pdf', 'Portable Document Format');
  const list = [
    makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [pdf(), textPdf()]),
    makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [pdf(), textPdf()]),
    makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [pdf(), textPdf()]),
    makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [pdf(), textPdf()]),
    makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format', [pdf(), textPdf()]),
  ];
  const arr = { length: list.length, item: (i) => (i == null ? undefined : list[i] || null), namedItem: (n) => list.find((p) => p.name === n) || null, refresh: () => {} };
  list.forEach((p, i) => { arr[i] = p; });
  return arr;
}
function makeMimeTypeArray() {
  const plugins = makePluginArray();
  const list = [makeMimeType('application/pdf', 'pdf', 'Portable Document Format'), makeMimeType('text/pdf', 'pdf', 'Portable Document Format')];
  list.forEach((mt, i) => { mt.enabledPlugin = plugins[i % plugins.length]; });
  const arr = { length: list.length, item: (i) => (i == null ? undefined : list[i] || null), namedItem: (n) => list.find((m) => m.type === n) || null };
  list.forEach((m, i) => { arr[i] = m; });
  return arr;
}
const nav = {
  userAgent: identity.userAgent,
  appVersion: identity.userAgent.slice(8),
  platform: identity.platform,
  languages: Object.freeze(identity.languages.slice()),
  language: identity.languages[0],
  cookieEnabled: true,
  hardwareConcurrency: identity.hardwareConcurrency,
  deviceMemory: identity.deviceMemory,
  maxTouchPoints: 0,
  webdriver: undefined,
  getBattery: () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 }),
  permissions: { query: (d) => Promise.resolve({ state: d && d.name === 'notifications' ? 'default' : 'granted', status: d && d.name === 'notifications' ? 'default' : 'granted' }) },
  // PluginArray/MimeTypeArray must be indexable: the encoder reads
  // navigator.plugins[i].toString(). A bare { length } stub yields undefined
  // there, the VM falls back to the bare name, and the type cast throws.
  plugins: makePluginArray(),
  mimeTypes: makeMimeTypeArray(),
  getGamepads: () => [],
  connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
};
defGlobal('navigator', track(nav, 'navigator'));

const storage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] || null,
    get length() { return m.size; },
  };
})();
defGlobal('localStorage', track(storage, 'localStorage'));
defGlobal('sessionStorage', track(storage, 'sessionStorage'));

const doc = {
  readyState: 'complete',
  location: new URL('https://queue.sistic.com.sg/?c=sistic&e=sisticsafetynet2'),
  defaultView: null,
  currentScript: null,
  head: { appendChild: (c) => c, removeChild: () => {}, insertBefore: (c) => c, setAttribute: () => {}, firstChild: null },
  body: { appendChild: (c) => c, removeChild: () => {}, insertBefore: (c) => c, setAttribute: () => {}, firstChild: null, style: {} },
  compatMode: 'CSS1Compat',
  title: '',
  domain: 'queue.sistic.com.sg',
  hasFocus: () => true,
  elementFromPoint: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  cookie: '',
  referrer: 'https://queue.sistic.com.sg/',
  visibilityState: 'visible',
  hidden: false,
  documentElement: { style: {}, appendChild: (c) => c, removeChild: () => {}, setAttribute: () => {}, getAttribute: () => null, insertBefore: (c) => c, firstChild: null, childNodes: [] },
  createElement: (tag) => makeElement(String(tag)),
  createElementNS: (_ns, tag) => makeElement(String(tag)),
  querySelector: () => makeElement('div'),
  querySelectorAll: () => [makeElement('div')],
  addEventListener: () => {},
  removeEventListener: () => {},
};
const probeLog = [];
defGlobal('__probes', probeLog);
// Any unknown value: a callable proxy that answers every property and every
// call with another one. The orchestrate walks namespaces of arbitrary depth
// (`K[a][b][c]()`), so a one-level stub is not enough — and a plain function
// breaks at depth 2 because its properties are undefined.
function anyValue(label) {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive || k === 'valueOf' || k === 'toString') {
        return () => '';
      }
      if (typeof k === 'string') probeLog.push(label + '.' + k);
      return anyValue(label + '.' + String(k));
    },
    apply() { return anyValue(label + '()'); },
    construct() { return anyValue(label + '()'); },
    has() { return true; },
  });
}
function track(obj, label) {
  return new Proxy(obj, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (v === undefined && typeof k === 'string') {
        probeLog.push(label + '.' + k);
        return anyValue(label + '.' + k);
      }
      return v;
    },
    apply(t, thisArg, args) {
      return Reflect.apply(t, thisArg, args);
    },
  });
}
function makeElement(tag) {
  // contentWindow/contentDocument must be inherited accessors (a real
  // browser's are on the prototype); the integrity check is
  // getOwnPropertyDescriptor(...) === undefined.
  const proto = {
    style: {},
    setAttribute() {},
    getAttribute: () => null,
    appendChild: function (c) {
      try { if (c) { c.parentNode = this; c.parentElement = this; } } catch (e) {}
      return c;
    },
    removeChild: () => {},
    insertBefore: function (c) {
      try { if (c) { c.parentNode = this; c.parentElement = this; } } catch (e) {}
      return c;
    },
    remove: () => {},
    insertBefore: (c) => c,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1, top: 0, left: 0 }),
    firstChild: null,
    childNodes: [],
    querySelector: () => makeElement('div'),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    getElementById: () => null,
    firstElementChild: null,
    lastElementChild: null,
    nextElementSibling: null,
    previousElementSibling: null,
    parentNode: { insertBefore: (c) => c, appendChild: (c) => c, removeChild: () => {} },
    parentElement: { insertBefore: (c) => c, appendChild: (c) => c, removeChild: () => {} },
    nextSibling: null,
    previousSibling: null,
    childElementCount: 0,
    innerHTML: '',
    outerHTML: '',
    textContent: '',
    innerText: '',
    nodeType: 1,
    nodeName: 'DIV',
    isConnected: true,
    ownerDocument: null,
    attachShadow: () => makeElement('div'),
    shadowRoot: null,
    children: [],
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    className: '',
    id: '',
    dataset: {},
    value: '',
    checked: false,
    focus: () => {},
    blur: () => {},
    click: () => {},
    matches: () => false,
    closest: () => null,
    contains: () => false,
    cloneNode: () => makeElement('div'),
    sandbox: { add: () => {}, contains: () => false },
  };
  if (tag === 'iframe') {
    Object.defineProperty(proto, 'contentWindow', {
      get() { return this.__win; },
      configurable: true,
    });
    Object.defineProperty(proto, 'contentDocument', {
      get() { return this.__doc; },
      configurable: true,
    });
  }
  const el = Object.create(proto);
  el.tagName = tag.toUpperCase();
  // href/src must resolve like a browser's. The integrity check sets an
  // anchor's href to https://www.cloudflare.com/privacypolicy/ and reads
  // host/protocol/pathname back; an unresolving stub reads undefined and the
  // flow aborts before it ever sends anything.
  let resolved = null;
  const resolve = (v) => {
    try { return new URL(String(v), (globalThis.location && globalThis.location.href) || 'https://queue.sistic.com.sg/'); } catch (e) { return null; }
  };
  for (const prop of ['href', 'src', 'action']) {
    Object.defineProperty(el, prop, {
      get() { return resolved ? resolved.href : ''; },
      set(v) { resolved = resolve(v); },
      configurable: true,
    });
  }
  for (const p of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin', 'username', 'password']) {
    Object.defineProperty(el, p, { get() { return resolved ? resolved[p] : ''; }, configurable: true });
  }
  if (tag === 'img' || tag === 'image') {
    el.naturalWidth = 16; el.naturalHeight = 16; el.complete = true; el.width = 16; el.height = 16;
  }
  if (tag === 'iframe') {
    const win = { location: { href: 'about:blank' }, navigator: nav, top: null, parent: null };
    // The frame's realm: the code does `new frame.<Ctor>` and cross-realm
    // identity checks, so the frame window exposes the standard constructors.
    for (const k of [
      'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
      'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'JSON', 'Math', 'Date',
      'Reflect', 'Proxy', 'Error', 'TypeError', 'RangeError', 'RegExp',
      'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
      'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
      'Float32Array', 'Float64Array', 'BigInt', 'TextEncoder', 'TextDecoder',
      'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'Blob',
      'FileReader', 'FormData', 'AbortController', 'Event', 'EventTarget',
      'MessageChannel', 'MessagePort', 'structuredClone', 'atob', 'btoa',
    ]) {
      if (globalThis[k] !== undefined) win[k] = globalThis[k];
    }
    win.setTimeout = setTimeout;
    win.clearTimeout = clearTimeout;
    win.performance = globalThis.performance;
    win.crypto = cryptoShim;
    win.console = console;
    win.fetch = globalThis.fetch;
    win.XMLHttpRequest = FakeXHR;
    win.Worker = globalThis.Worker;
    const idoc = Object.create(doc);
    idoc.defaultView = win;
    win.document = idoc;
    win.frameElement = el;
    win.top = win;
    win.parent = win;
    el.__win = track(win, 'win');
    el.__doc = idoc;
    el.srcdoc = '';
  }
  el.getContext = () => track(fakeContext(tag), 'ctx');
  el.toDataURL = () => 'data:image/png;base64,OURSTABLECANVAS';
  const wrapped = track(el, 'el.' + tag);
  if (tag === 'iframe') {
    // The integrity check compares identity through the references: link the
    // window's frameElement to the same object the caller holds.
    el.__win.frameElement = wrapped;
    el.__win.document = el.__doc;
    el.__doc.defaultView = el.__win;
  }
  return wrapped;
}

function fakeContext(tag) {
  if (tag === 'canvas') {
    return {
      measureText: (t) => ({ width: String(t).length * 7.2 }),
      getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      fillText: () => {}, fillRect: () => {}, toDataURL: () => 'data:image/png;base64,OURSTABLECANVAS',
    };
  }
  return { fillStyle: '', fillRect: () => {}, readPixels: () => {}, getParameter: (p) => (p === 0x9245 ? 'Google Inc. (Apple)' : p === 0x9246 ? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)' : 'stable'), getExtension: () => ({}) };
}
defGlobal('document', track(doc, 'document'));

// --- WebRTC: the SDP the live frame held.
defGlobal('RTCPeerConnection', function () {
  this.localDescription = null;
  this.onicecandidate = null;
  this.createDataChannel = () => ({});
  this.createOffer = () => Promise.resolve({ type: 'offer', sdp: 'v=0\r\no=- 4155595161875218876 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' });
  this.setLocalDescription = () => Promise.resolve();
  this.addEventListener = () => {};
  this.close = () => {};
});

// --- timing/crypto, stable per identity.
const t0 = Date.now();
defGlobal('performance', track({
  now: () => Date.now() - t0,
  timeOrigin: t0,
  getEntries: () => [],
  getEntriesByType: () => [],
  getEntriesByName: () => [],
  markResourceTiming: () => {},
  clearResourceTimings: () => {},
  setResourceTimingBufferSize: () => {},
  mark: () => {}, measure: () => {}, clearMarks: () => {},
}, 'performance'));
defGlobal('PerformanceObserver', class { observe() {} disconnect() {} });
const cryptoShim = globalThis.crypto || {
  getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 1103515245 + 12345) & 0xff; return a; },
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
};
defGlobal('crypto', cryptoShim);

// --- events: a real registry, and the page lifecycle fires once the script
// has evaluated. The flow waits for DOMContentLoaded/load; a no-op
// addEventListener leaves it waiting forever and the sandbox reports silence.
const listeners = new Map();
function addL(name, fn) { if (typeof fn !== 'function') return; if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }
function remL(name, fn) { const a = listeners.get(name) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
function fireL(name, extra) {
  const ev = Object.assign({
    type: name, target: globalThis, currentTarget: globalThis, srcElement: globalThis,
    isTrusted: true, timeStamp: Date.now(), eventPhase: 2, bubbles: true, cancelable: true,
    button: 0, buttons: 1, clientX: 120, clientY: 300, screenX: 120, screenY: 300,
    pageX: 120, pageY: 300, detail: 1, which: 1, keyCode: 13, key: 'Enter', code: 'Enter',
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
  }, extra || {});
  for (const fn of [...(listeners.get(name) || [])]) { try { fn.call(globalThis, ev); } catch (e) {} }
}
defGlobal('__fire', fireL);
// The flow's trigger is a user gesture: the challenge waits for a click before
// it runs the encoder. Without one the sandbox evaluates the orchestrate and
// then sits silent.
function gesture() {
  for (const n of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keyup', 'input', 'change', 'touchstart', 'touchend', 'visibilitychange', 'focus', 'resize', 'scroll']) fireL(n);
}
defGlobal('__gesture', gesture);
if (doc) { doc.addEventListener = addL; doc.removeEventListener = remL; doc.dispatchEvent = (ev) => { fireL(ev && ev.type ? ev.type : String(ev)); return true; }; }
defGlobal('addEventListener', addL);
defGlobal('removeEventListener', remL);
defGlobal('dispatchEvent', (ev) => { fireL(ev && ev.type ? ev.type : String(ev)); return true; });
// The page lifecycle: after the evaluated script has had a chance to bind.
setTimeout(() => { fireL('DOMContentLoaded'); setTimeout(() => { fireL('load'); setTimeout(gesture, 20); }, 20); }, 10);
defGlobal('getComputedStyle', () => track({ getPropertyValue: () => '', setProperty: () => {} }, 'computedStyle'));
defGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 16));
defGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
defGlobal('requestIdleCallback', (cb) => setTimeout(cb, 1));
defGlobal('matchMedia', () => track({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {} }, 'matchMedia'));
defGlobal('setTimeout', globalThis.setTimeout);
defGlobal('clearTimeout', globalThis.clearTimeout);
defGlobal('setInterval', globalThis.setInterval);
defGlobal('clearInterval', globalThis.clearInterval);
defGlobal('queueMicrotask', globalThis.queueMicrotask || ((cb) => Promise.resolve().then(cb)));
defGlobal('Image', class { set src(v) {} addEventListener() {} });
defGlobal('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
defGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
defGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
defGlobal('location', new URL('https://queue.sistic.com.sg/?c=sistic&e=sisticsafetynet2'));
defGlobal('history', track({ pushState: () => {}, replaceState: () => {}, back: () => {} }, 'history'));
defGlobal('screen', track({ width: 2400, height: 1374, availWidth: 2400, availHeight: 1332, colorDepth: 30, pixelDepth: 30, orientation: { type: 'landscape-primary', angle: 0 } }, 'screen'));
defGlobal('innerWidth', 1200);
defGlobal('innerHeight', 687);
defGlobal('outerWidth', 1200);
defGlobal('outerHeight', 830);
defGlobal('devicePixelRatio', 2);
defGlobal('alert', () => {});
defGlobal('confirm', () => true);
defGlobal('prompt', () => '');
defGlobal('open', () => {});
defGlobal('close', () => {});
defGlobal('postMessage', () => {});
defGlobal('atob', (s) => Buffer.from(s, 'base64').toString('binary'));
defGlobal('btoa', (s) => Buffer.from(s, 'binary').toString('base64'));
// fetch and sendBeacon carry the encoder's payloads too — the same capture
// layer as XHR, or the sandbox would report silence while the browserless
// call has nothing to send.
defGlobal('fetch', (u, opts) => {
  const o = opts || {};
  sent.push({ method: String(o.method || 'GET'), url: String(u), body: o.body == null ? '' : (typeof o.body === 'string' ? o.body : String(o.body)) });
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } });
});
nav.sendBeacon = (u, body) => { sent.push({ method: 'POST', url: String(u), body: body == null ? '' : String(body) }); return true; };
// The browser surface a fingerprint walks: window.screen/history/visualViewport
// and the viewport fields. Any of these reading undefined hands the encoder a
// missing receiver and the type cast throws.
defGlobal('screen', track({
  width: 1728, height: 1117, availWidth: 1728, availHeight: 1085,
  colorDepth: 30, pixelDepth: 30, orientation: { type: 'landscape-primary', angle: 0 },
}, 'screen'));
defGlobal('history', track({
  length: 2, state: null, scrollRestoration: 'auto',
  pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {}, go: () => {},
}, 'history'));
defGlobal('visualViewport', track({
  width: 1728, height: 1033, scale: 1, offsetLeft: 0, offsetTop: 0,
  pageLeft: 0, pageTop: 0, resize: () => {}, scroll: () => {},
}, 'visualViewport'));
defGlobal('innerWidth', 1728);
defGlobal('innerHeight', 1033);
defGlobal('outerWidth', 1728);
defGlobal('outerHeight', 1117);
defGlobal('devicePixelRatio', 2);
defGlobal('screenX', 0);
defGlobal('screenY', 0);
defGlobal('pageXOffset', 0);
defGlobal('pageYOffset', 0);
defGlobal('scrollX', 0);
defGlobal('scrollY', 0);
defGlobal('isSecureContext', true);
defGlobal('crossOriginIsolated', false);
defGlobal('clientInformation', nav);
defGlobal('frameElement', null);
defGlobal('closed', false);
defGlobal('length', 0);
defGlobal('name', '');
defGlobal('status', '');
defGlobal('defaultStatus', '');
defGlobal('customElements', { define: () => {}, get: () => undefined, whenDefined: () => Promise.resolve() });
defGlobal('chrome', { app: { isInstalled: false, InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed', DISABLED: 'disabled' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }, runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {} } });

defGlobal('window', globalThis);
defGlobal('self', globalThis);
defGlobal('top', globalThis);
defGlobal('parent', globalThis);
defGlobal('origin', 'https://queue.sistic.com.sg');
defGlobal('isSecureContext', true);
defGlobal('Worker', class { postMessage() {} terminate() {} addEventListener() {} });

module.exports = { identity, sent };
