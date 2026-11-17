// The encode chain, unwindowed: the wire's `$`-separated segments are 24-char
// base64, so the final stage is btoa over 16-byte blocks. Log both sides.
(() => {
  if (window.__hooks5) return;
  window.__hooks5 = true;
  window.__enc = window.__enc || [];
  const say = (o) => {
    try { window.__enc.push(o); } catch (e) {}
    try { if (window.top !== window) window.top.postMessage({ enc: o }, '*'); } catch (e) {}
  };
  if (window.top === window) {
    window.addEventListener('message', (ev) => {
      try { if (ev.data && ev.data.enc) window.__enc.push(Object.assign({ frame: (ev.origin || '').slice(0, 24) }, ev.data.enc)); } catch (e) {}
    });
  }
  const b64 = (s) => {
    try {
      let out = '';
      for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(2, '0');
      return out;
    } catch (e) { return ''; }
  };
  try {
    const origBtoa = window.btoa;
    window.btoa = function (s) {
      const r = origBtoa.call(this, s);
      if (s && s.length >= 4 && window.__enc.length < 400) {
        say({ kind: 'btoa', inLen: s.length, inHex: b64(s).slice(0, 128), out: r.slice(0, 64) });
      }
      return r;
    };
    const origAtob = window.atob;
    window.atob = function (s) {
      const r = origAtob.call(this, s);
      if (s && s.length >= 8 && window.__enc.length < 400) {
        say({ kind: 'atob', in: s.slice(0, 48), outHex: b64(r).slice(0, 128) });
      }
      return r;
    };
    const origFrom = String.fromCharCode;
    String.fromCharCode = function (...codes) {
      if (codes.length >= 4 && window.__enc.length < 400) {
        say({ kind: 'fromCharCode', n: codes.length, head: codes.slice(0, 12).map((c) => (c & 0xff).toString(16).padStart(2, '0')).join('') });
      }
      return origFrom.apply(this, codes);
    };
  } catch (e) {}
  say({ kind: 'installed5', href: (location.href || '').slice(0, 60) });
})();
