// The `ci` channel: images loaded no-cors in the challenges frame, then read
// back in-frame. The seam where their bytes exist as pixels: drawImage +
// getImageData. We take the blob exactly there.
(() => {
  if (window.__hooks4) return;
  window.__hooks4 = true;
  window.__ci = window.__ci || [];
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    try { return btoa(s); } catch (e) { return '(b64fail)'; }
  };
  try {
    const origDraw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
      try {
        const src = img && (img.src || (img.currentSrc || ''));
        if (src && src.includes('/ci/')) (window.__say || window.__ci.push.bind(window.__ci))({ kind: 'draw', src: src.slice(-60), w: img.naturalWidth, h: img.naturalHeight });
      } catch (e) {}
      return origDraw.call(this, img, ...rest);
    };
    const origGet = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
      const img = origGet.call(this, x, y, w, h);
      try {
        if (img && img.data && img.data.length > 2000 && window.__ci.length) {
          const last = window.__ci[window.__ci.length - 1];
          if (last && !last.data) {
            last.data = b64(new Uint8Array(img.data.buffer.slice(0, 200000)));
            last.pw = w; last.ph = h;
          }
        }
      } catch (e) {}
      return img;
    };
    // HTML parsing sets `src` without the property setter or setAttribute.
    try {
      const say = window.__say || window.__ci.push.bind(window.__ci);
      const re = /ci\/[A-Za-z0-9_\/.-]{5,80}/g;
      const watch = (tag, sgmt) => {
        try {
          const f = sgmt.value;
          if (typeof f === 'string' && f.includes('/ci/')) {
            const hits = f.match(re) || [];
            say({ kind: tag, hits: hits.slice(0, 3).map((h) => h.slice(-30)) });
          }
        } catch (e) {}
      };
      for (const [proto, name] of [
        ['Element', 'innerHTML'],
        ['Element', 'outerHTML'],
        ['ShadowRoot', 'innerHTML'],
      ]) {
        const P = window[proto] && window[proto].prototype;
        if (!P) continue;
        const d = Object.getOwnPropertyDescriptor(P, name);
        if (d && d.set) {
          Object.defineProperty(P, name, {
            get: d.get,
            set(v) { watch(name, { value: v }); return d.set.call(this, v); },
          });
        }
      }
      const origIAH = Element.prototype.insertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function (pos, html) {
        watch('insertAdjacentHTML', { value: html });
        return origIAH.call(this, pos, html);
      };
      const origParse = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (data, type) {
        watch('domparser', { value: typeof data === 'string' ? data : '' });
        return origParse.call(this, data, type);
      };
    } catch (e) {}
    // `setAttribute` is the classic route around a property hook.
    try {
      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        try {
          const v = String(value);
          if (v.includes('/ci/')) {
            (window.__say || window.__ci.push.bind(window.__ci))({ kind: 'setattr', attr: String(name), src: v.slice(-60) });
          }
        } catch (e) {}
        return origSetAttr.call(this, name, value);
      };
      const origCIB = window.createImageBitmap;
      if (origCIB) {
        window.createImageBitmap = async function (...a) {
          try {
            const src = a && a[0] && a[0].src ? String(a[0].src) : '';
            if (src.includes('/ci/')) (window.__say || window.__ci.push.bind(window.__ci))({ kind: 'bitmap', src: src.slice(-60) });
          } catch (e) {}
          return origCIB.apply(this, a);
        };
      }
    } catch (e) {}
    // also watch the image requests themselves
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: desc.get,
        set(v) {
          try { if (String(v).includes('/ci/')) (window.__say || window.__ci.push.bind(window.__ci))({ kind: 'img', src: String(v).slice(-60) }); } catch (e) {}
          return desc.set.call(this, v);
        },
      });
    }
  } catch (e) {}
  // Cross-origin exfil: every frame's findings go to the top collector.
  const say = (obj) => {
    try { window.__ci.push(obj); } catch (e) {}
    try { if (window.top !== window) window.top.postMessage({ ci: obj }, '*'); } catch (e) {}
  };
  window.__say = say;
  if (window.top === window) {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.data && ev.data.ci) {
          window.__ci.push(Object.assign({ frame: (ev.origin || '').slice(0, 30) }, ev.data.ci));
        }
      } catch (e) {}
    });
  }
  say({ kind: 'installed', href: (location.href || '').slice(0, 60) });
})();
