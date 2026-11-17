// Challenge-protocol instrumentation: what the orchestrate collects, before
// its crypto hides it. Nothing is modified — only observed at the seams the
// page itself uses: serialization, encoding, encryption, and WASM loading.
(() => {
  if (window.__hooksInstalled) return;
  window.__hooksInstalled = true;
  const log = [];
  window.__hooklog = log;
  const push = (kind, data) => {
    try { log.push({ t: Math.round(performance.now()), kind, data }); } catch (e) {}
  };
  // 1. Serialization: fingerprint objects become JSON here.
  const origStringify = JSON.stringify;
  JSON.stringify = function (v, ...rest) {
    const out = origStringify.call(this, v, ...rest);
    if (out && out.length > 150) push('stringify', out.slice(0, 4000));
    return out;
  };
  // 2. Encoding: strings become bytes here (often right before encryption).
  const origEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (s) {
    if (typeof s === 'string' && s.length > 150) push('encode', s.slice(0, 4000));
    return origEncode.call(this, s);
  };
  // 3. Web Crypto: the keys and ciphers themselves.
  if (window.crypto && crypto.subtle) {
    const enc = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async function (alg, key, data) {
      try {
        const raw = await crypto.subtle.exportKey('raw', key);
        push('crypto.encrypt', {
          alg: origStringify(alg),
          key: btoa(String.fromCharCode(...new Uint8Array(raw))),
          ptLen: data.byteLength || data.length || 0,
        });
      } catch (e) { push('crypto.encrypt', { err: '' + e }); }
      return enc(alg, key, data);
    };
  }
  // 4. WebAssembly: capture the challenge's own computation module.
  const b64 = (buf) => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const origInst = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (mod, imports) {
    try {
      let bytes = null;
      if (mod instanceof ArrayBuffer) bytes = mod;
      else if (ArrayBuffer.isView(mod)) bytes = mod.buffer;
      else if (mod instanceof WebAssembly.Module) bytes = null;
      if (bytes && bytes.byteLength > 1000) push('wasm.module', { len: bytes.byteLength, b64: b64(bytes).slice(0, 200000) });
      const imports0 = imports ? origStringify(Object.keys(imports)) : '[]';
      push('wasm.instantiate', { imports: imports0 });
    } catch (e) { push('wasm.instantiate', { err: '' + e }); }
    return origInst.call(this, mod, imports);
  };
  // 5. Transport: the ciphertext, sizes, and endpoints.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__u = u; this.__m = m; return origOpen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (body) {
    const size = body ? (body.byteLength || body.length || 0) : 0;
    if (this.__u && (this.__u.includes('challenge-platform') || size > 500)) {
      push('xhr', { m: this.__m, u: String(this.__u).slice(0, 120), size, body: typeof body === 'string' ? body.slice(0, 500) : '(binary)' });
    }
    return origSend.call(this, body);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = String(input && input.url ? input.url : input);
      const b = init && init.body;
      if (u.includes('challenge-platform')) push('fetch', { u: u.slice(0, 120), size: b ? (b.byteLength || b.length || 0) : 0 });
    } catch (e) {}
    return origFetch.call(this, input, init);
  };
  push('installed', { href: location.href.slice(0, 80) });
})();
