// Deeper seams: the hand-rolled serializer builds byte strings without
// JSON.stringify or TextEncoder. These are the four classic seams it uses.
(() => {
  if (window.__hooks2) return;
  window.__hooks2 = true;
  window.__hooklog = window.__hooklog || [];
  const log = window.__hooklog;
  const push = (kind, data) => { try { log.push({ t: Math.round(performance.now()), kind, data }); } catch (e) {} };

  // 1. Typed-array construction: char codes -> bytes.
  try {
    const OrigU8 = window.Uint8Array;
    const src = [];
    const capture = (a) => {
      try {
        if (a && a.length && a.length > 200 && typeof a[0] === 'number') {
          push('u8.from', { len: a.length, head: Array.from(a.slice(0, 24)) });
        }
      } catch (e) {}
    };
    const NewU8 = function (...args) {
      if (args.length === 1) capture(args[0]);
      return new OrigU8(...args);
    };
    NewU8.prototype = OrigU8.prototype;
    Object.setPrototypeOf(NewU8, OrigU8);
    window.Uint8Array = NewU8;
  } catch (e) {}

  // 2. charCodeAt / fromCharCode at scale: the encoding alphabet's entry and exit.
  try {
    const origFrom = String.fromCharCode;
    String.fromCharCode = function (...codes) {
      if (codes.length > 120) push('fromCharCode', { n: codes.length, head: codes.slice(0, 24) });
      return origFrom.apply(this, codes);
    };
  } catch (e) {}

  // 3. Array joins: fields assembled with delimiters ("$" in the wire format!).
  try {
    const origJoin = Array.prototype.join;
    Array.prototype.join = function (sep) {
      const out = origJoin.call(this, sep);
      if (sep && sep.length <= 2 && this.length > 40 && out.length > 400) {
        push('join', { sep: sep, n: this.length, head: out.slice(0, 260) });
      }
      return out;
    };
  } catch (e) {}

  // 4. atob/btoa and the unescape escape: encoding escapes.
  try {
    const origAtob = window.atob;
    window.atob = function (s) {
      if (s && s.length > 200) push('atob', { n: s.length, head: s.slice(0, 120) });
      return origAtob.call(this, s);
    };
    const origBtoa = window.btoa;
    window.btoa = function (s) {
      if (s && s.length > 200) push('btoa', { n: s.length, head: s.slice(0, 120) });
      return origBtoa.call(this, s);
    };
  } catch (e) {}

  push('hooks2-installed', { href: location.href.slice(0, 60) });
})();
