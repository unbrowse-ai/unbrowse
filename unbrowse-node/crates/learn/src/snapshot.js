// Independent indexed-DOM implementation inspired by Jev Ultrafast's documented pattern.
// This trusted program is fixed application code; page/model text is never executable.
(() => {
  const cap = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < innerHeight && r.left < innerWidth && s.display !== 'none' &&
      s.visibility !== 'hidden' && s.opacity !== '0' && !el.closest('[hidden],[aria-hidden="true"]');
  };
  const role = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName] || 'control');
  const name = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    return cap(el.getAttribute('aria-label') || labelled ||
      (el.labels ? Array.from(el.labels).map(l => l.textContent).join(' ') : '') ||
      el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '', 160);
  };
  const signature = (el) => JSON.stringify([role(el),name(el),el.value || '',el.getAttribute('href'),
    el.getAttribute('aria-expanded'),el.getAttribute('aria-checked'),el.disabled || false]);
  const unsafe = (el) => /\b(buy|pay|purchase|checkout|delete|remove|destroy|send|submit|log\s*in|sign\s*in|log\s*out|sign\s*out)\b/i.test(name(el)) ||
    /\/(login|logout|signin|signout|delete|checkout|payment|admin)(\/|\?|$)/i.test(el.getAttribute('href') || '') ||
    (el.tagName === 'BUTTON' && el.type === 'submit' && !!el.closest('form'));
  const refs = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="link"],[role="textbox"]'))
    .filter(el => visible(el) && !['password','hidden','file'].includes((el.type || '').toLowerCase())).slice(0,80);
  const elements = refs.map((el,i) => ({index:i+1,role:role(el),name:name(el),value:null,
    can_click:!el.disabled && el.getAttribute('aria-disabled') !== 'true' && !unsafe(el),
    can_type:!el.disabled && !el.readOnly && (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && ['text','search','url'].includes(el.type)))}));
  const text = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  let length = 0;
  while ((node = walker.nextNode()) && length < 8000) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    const part = cap(node.textContent,8000-length);
    if (part) {text.push(part); length += part.length + 1;}
  }
  const epoch = String(Date.now()) + ':' + String(Math.random());
  const state = {epoch,url:location.href,refs,signatures:refs.map(signature)};
  window.__unbrowseSnapshot = state;
  window.__unbrowseAct = (action) => {
    const fail = reason => ({ok:false,reason});
    if (!action || !window.__unbrowseSnapshot || action.epoch !== state.epoch ||
        window.__unbrowseSnapshot !== state || location.href !== state.url) return fail('stale observation');
    if (!Number.isInteger(action.index) || action.index < 1 || action.index > state.refs.length) return fail('unknown observed index');
    const el = state.refs[action.index-1];
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return fail('target not visible/enabled');
    if (signature(el) !== state.signatures[action.index-1]) return fail('target changed');
    if (unsafe(el)) return fail('unsafe action');
    if (action.kind !== 'click' || !elements[action.index-1].can_click) return fail('unsupported operation');
    const r = el.getBoundingClientRect();
    const x = Math.max(0,Math.min(innerWidth-1,r.left+r.width/2));
    const y = Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
    const hit = document.elementFromPoint(x,y);
    if (!hit || (hit !== el && !el.contains(hit))) return fail('target occluded');
    return {ok:true,x,y};
  };
  return {epoch,url:location.href,title:cap(document.title,300),text:cap(text.join(' '),8000),
    elements,ready_state:document.readyState};
})()