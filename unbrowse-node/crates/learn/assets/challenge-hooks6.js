// The assembly seam, installed before the orchestrate runs: the wire payload
// is '$'-joined (or '$'-concatenated) segments. Whatever the encoder does,
// the assembly touches these.
(() => {
  if (window.__hooks6) return;
  window.__hooks6 = true;
  window.__joins = window.__joins || [];
  const say = (o) => {
    try { window.__joins.push(o); } catch (e) {}
    try { if (window.top !== window) window.top.postMessage({ j6: o }, '*'); } catch (e) {}
  };
  if (window.top === window) {
    window.addEventListener('message', (e) => {
      try { if (e.data && e.data.j6) window.__joins.push(Object.assign({ frame: (e.origin || '').slice(0, 20) }, e.data.j6)); } catch (err) {}
    });
  }
  try {
    const origJoin = Array.prototype.join;
    Array.prototype.join = function (sep) {
      try {
        const s = sep === undefined ? ',' : String(sep);
        if ((s === '$' || (this.length > 1 && String(this[0]).indexOf('$') >= 0)) && this.length > 1) {
          if (window.__joins.length < 200) say({ k: 'join', sep: s, parts: this.map((x) => String(x).slice(0, 100)) });
        }
      } catch (e) {}
      return origJoin.apply(this, arguments);
    };
    const origConcat = String.prototype.concat;
    String.prototype.concat = function () {
      try {
        for (let i = 0; i < arguments.length; i++) {
          if (String(arguments[i]) === '$' && window.__joins.length < 200) {
            say({ k: 'concat', head: String(this).slice(0, 100) });
            break;
          }
        }
      } catch (e) {}
      return origConcat.apply(this, arguments);
    };
  } catch (e) {}
  say({ k: 'installed6', href: (location.href || '').slice(0, 60) });
})();
