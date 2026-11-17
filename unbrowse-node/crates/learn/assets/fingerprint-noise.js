// Fingerprint surface, shaped before any page script runs: the browser's
// script-visible APIs answer the way a person's browser does. The seed is
// fixed for the page (noise is deterministic per pixel/call), so repeated
// reads agree — a fingerprint that changes every call is itself a signal.
(() => {
  'use strict';
  if (navigator.webdriver !== undefined) {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  }
  // Languages and platform: a stable, ordinary shape.
  try {
    Object.defineProperty(navigator, 'languages', { get: () => Object.freeze(['en-US', 'en']) });
  } catch (e) {}
  // Plugins: a non-empty frozen set, as a real Chrome reports.
  if (!navigator.plugins || navigator.plugins.length === 0) {
    const mk = (name, desc) => {
      const p = { name, description: desc, filename: 'internal-' + name.toLowerCase(), length: 1 };
      return Object.freeze(p);
    };
    const pdf = mk('PDF Viewer', 'Portable Document Format');
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => Object.freeze({ length: 3, 0: pdf, 1: mk('Chrome PDF Viewer', ''), 2: mk('Chromium PDF Viewer', ''), item: (i) => pdf, namedItem: () => pdf }),
      });
    } catch (e) {}
  }
  // The chrome runtime stub: present in real Chrome, absent in some automation.
  if (!window.chrome) {
    window.chrome = { runtime: { id: undefined, connect: () => {}, sendMessage: () => {} } };
  }
  // Canvas noise: a fixed per-page seed makes every read of the same pixels
  // agree while the rendering diverges from any other browser's.
  const seed = (Math.random() * 2147483647) | 0 || 1234567;
  const jitter = (i) => {
    const x = Math.sin(i * 127.1 + seed) * 43758.5453;
    return x - Math.floor(x);
  };
  const noise2d = (ctx) => {
    const orig = ctx.getImageData.bind(ctx);
    ctx.getImageData = function (x, y, w, h) {
      const img = orig(x, y, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (img.data[i] + (jitter(i) * 2 - 1) * 3 + 256) % 256;
      }
      return img;
    };
  };
  try {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = origGetContext.call(this, type, ...rest);
      if (ctx && (type === '2d')) noise2d(ctx);
      return ctx;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try {
        const ctx = origGetContext.call(this, '2d');
        if (ctx) {
          const one = ctx.getImageData(0, 0, 1, 1);
          one.data[0] = (one.data[0] + 1) % 256;
          ctx.putImageData(one, 0, 0);
        }
      } catch (e) {}
      return origToDataURL.apply(this, args);
    };
  } catch (e) {}
  // WebGL: masked strings look like headless; real browsers expose vendors.
  try {
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === UNMASKED_VENDOR) return 'Google Inc. (Apple)';
      if (p === UNMASKED_RENDERER) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)';
      return origGetParameter.call(this, p);
    };
  } catch (e) {}
  // Permissions: a real browser answers consistently with Notification.
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) =>
      desc && desc.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, status: Notification.permission, onchange: null })
        : origQuery(desc);
  } catch (e) {}
})();
