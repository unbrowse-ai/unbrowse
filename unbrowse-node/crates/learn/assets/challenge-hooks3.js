(() => {
  if (window.__hooks3) return;
  window.__hooks3 = true;
  window.__stacks = [];
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = String(u); this.__m = m; return origOpen.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__u && this.__u.includes('challenge-platform')) {
      window.__stacks.push({ u: this.__u.slice(0, 90), stack: new Error().stack.split('\n').slice(0, 14).join(' | ') });
    }
    return origSend.call(this, body);
  };
})();
