import json, re, subprocess, sys, time
import websocket

def port():
    pid = subprocess.check_output(["pgrep","-f","Google Chrome for Testing"]).split()[0].decode()
    out = subprocess.check_output(["lsof","-nP","-iTCP","-sTCP:LISTEN","-a","-p",pid]).decode()
    m = re.search(r"127\.0\.0\.1:(\d+)", out)
    return m.group(1)

p = port()
targets = json.loads(subprocess.check_output(["curl","-s",f"http://127.0.0.1:{p}/json/list"]).decode())
page = next((t for t in targets if t.get("type")=="page" and "queue.sistic" in t.get("url","")), None)
if not page:
    page = next((t for t in targets if t.get("type")=="page"), None)
print("target:", page["url"][:70], flush=True)
ws = websocket.create_connection(page["webSocketDebuggerUrl"], max_size=200*1024*1024, suppress_origin=True)
mid = [0]
def send(method, params=None):
    mid[0] += 1
    ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid[0]:
            return msg.get("result", {})
def wait_event(method, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        ws.settimeout(max(1, end - time.time()))
        try: msg = json.loads(ws.recv())
        except Exception: return None
        if msg.get("method") == method: return msg.get("params", {})
    return None

send("Debugger.enable")
send("Runtime.enable")
bp = send("Debugger.setBreakpointByUrl", {
    "lineNumber": 1,
    "urlRegex": ".*orchestrate/chl_page.*",
    "columnNumber": 166424,
})
print("breakpoint:", bp, flush=True)
send("Page.enable")
# Re-enter through the site's front door until the challenge runs again: the
# orchestrate's first request (the fo upload) hits the breakpoint.
paused = None
urls = [
    page["url"],
    "https://ticketing.sistic.com.sg/sistic/booking/ke0327",
    page["url"] + "&r=" + str(int(time.time())),
    "https://ticketing.sistic.com.sg/sistic/booking/ke0327?r=" + str(int(time.time())),
    page["url"],
    "https://ticketing.sistic.com.sg/sistic/booking/ke0327",
]
for attempt, url in enumerate(urls):
    send("Page.navigate", {"url": url})
    print(f"attempt {attempt+1}: navigated", flush=True)
    paused = wait_event("Debugger.paused", timeout=35)
    if paused:
        break
if not paused:
    print("no pause"); sys.exit(1)
frames = paused.get("callFrames", [])[:4]
print("paused at:", frames[0].get("functionName"), frames[0].get("location"), flush=True)
for fi, f in enumerate(frames):
    print(f"--- frame {fi}: {f.get('functionName')} @ {f.get('location',{}).get('lineNumber')}:{f.get('location',{}).get('columnNumber')}")
    # The code at the pause: the send call's argument expression.
    try:
        loc = f.get("location", {})
        src = send("Debugger.getScriptSource", {"scriptId": loc.get("scriptId")})
        source = src.get("scriptSource", "")
        col = loc.get("columnNumber", 0)
        window = source[max(0, col - 500):col + 300]
        print(f"    SOURCE@{col}: ...{window!r}...")
    except Exception:
        pass

    # The sender's own arguments: the payload handed to it.
    for expr in [
        "arguments.length",
        "typeof arguments[0]==='string' ? arguments[0].slice(0,300) : typeof arguments[0]",
        "typeof arguments[1]==='string' ? arguments[1].slice(0,300) : typeof arguments[1]",
    ]:
        try:
            r = send("Debugger.evaluateOnCallFrame", {
                "callFrameId": f["callFrameId"],
                "expression": expr,
                "returnByValue": True,
            })
            v = r.get("result", {}).get("value")
            exc = r.get("exceptionDetails", {}).get("text", "")
            print(f"    ARG[{expr[:24]}]: {str(v)[:300]!r} {exc}")
        except Exception:
            pass

    # Long strings anywhere in scope: the payload before it is encoded.
    for scope in f.get("scopeChain", []):
        obj = scope.get("object", {})
        oid = obj.get("objectId")
        if not oid:
            continue
        props = send("Runtime.getProperties", {"objectId": oid, "ownProperties": True})
        for pr in props.get("result", []):
            if not pr.get("enumerable"):
                continue
            v = pr.get("value", {})
            if v.get("type") == "string":
                val = v.get("value") or ""
                if len(val) > 80:
                    print(f"    LONG {pr.get('name')} len={len(val)}: {val[:180]!r}")

    # Object-typed scope values: the payload under construction, field by field.
    for scope in f.get("scopeChain", []):
        obj = scope.get("object", {})
        oid = obj.get("objectId")
        if not oid:
            continue
        props = send("Runtime.getProperties", {"objectId": oid, "ownProperties": True})
        for pr in props.get("result", []):
            if not pr.get("enumerable"):
                continue
            v = pr.get("value", {})
            if v.get("type") != "object" or v.get("description") != "Object":
                continue
            inner = send("Runtime.getProperties", {"objectId": v["objectId"], "ownProperties": True})
            fields = []
            for ip in inner.get("result", []):
                if not ip.get("enumerable"):
                    continue
                nm = ip.get("name", "")
                iv = ip.get("value", {})
                t = iv.get("type")
                if t == "string":
                    fields.append(f"{nm}={str(iv.get('value'))[:60]!r}")
                elif t in ("number", "boolean"):
                    fields.append(f"{nm}={iv.get('value')}")
                elif t == "object":
                    fields.append(f"{nm}=<{iv.get('description','')[:30]}>")
            if len(fields) >= 3:
                print(f"    OBJECT {pr.get('name')} ({len(fields)}): " + "; ".join(fields[:20]))
    for scope in f.get("scopeChain", []):
        obj = scope.get("object", {})
        oid = obj.get("objectId")
        if not oid: continue
        props = send("Runtime.getProperties", {"objectId": oid, "ownProperties": True})
        names = [(pr.get("name"), pr.get("value", {}).get("value")) for pr in props.get("result", []) if pr.get("enumerable")]
        keep = []
        for pr in props.get("result", []):
            if not pr.get("enumerable"):
                continue
            n = pr.get("name")
            v = pr.get("value", {})
            t = v.get("type")
            if t == "string":
                keep.append(f"{n}={str(v.get('value'))[:80]!r}")
            elif t in ("number", "boolean"):
                keep.append(f"{n}={v.get('value')}")
            elif t in ("object", "function"):
                desc = v.get("description", "")[:40]
                keep.append(f"{n}=<{t} {desc}>")
        if keep:
            print(f"    scope {scope.get('type')} ({len(keep)}): " + "; ".join(keep[:24]))
    # the frame's own arguments: the payload being sent
    # Shape-driven: find arrays in scope by their description, then read
    # their elements through Runtime.getProperties. Names rotate per build.
    for scope in f.get("scopeChain", []):
        obj = scope.get("object", {})
        oid = obj.get("objectId")
        if not oid:
            continue
        props = send("Runtime.getProperties", {"objectId": oid, "ownProperties": True})
        for pr in props.get("result", []):
            if not pr.get("enumerable"):
                continue
            v = pr.get("value", {})
            if v.get("type") != "object":
                continue
            desc = v.get("description", "")
            if not (desc.startswith("Array(") or desc.startswith("Uint8Array(")):
                continue
            try:
                n = int(desc.split("(")[1].rstrip(")"))
            except Exception:
                continue
            if n > 6000:
                continue
            # Dump the whole table: these are the build's vocabulary.
            inner = send("Runtime.getProperties", {"objectId": v["objectId"], "ownProperties": True, "generatePreview": True})
            elems = {}
            for ip in inner.get("result", []):
                nm = ip.get("name", "")
                if not nm.isdigit():
                    continue
                iv = ip.get("value", {})
                if iv.get("type") == "string":
                    elems[int(nm)] = iv.get("value")
            if elems and n < 20:
                shown = "; ".join(f"{i}:{str(t)[:70]!r}" for i, t in sorted(elems.items())[:12])
                print(f"    SMALL {pr.get('name')} len={n}: {shown}")
            if elems:
                out = f"/tmp/table_{pr.get('name')}_{n}.json"
                with open(out, "w") as fh:
                    json.dump(elems, fh)
                print(f"    TABLE {pr.get('name')} len={n} -> {out} ({len(elems)} read)")
# At the pause, install the send hook with the frame's own evaluate: the code
# continues and its next send lands in window.__sent.
hook = r"""(function(){
  if (window.__sent) return 'already';
  window.__sent = [];
  var orig = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(b){
    try {
      var t = (typeof b === 'string') ? b : (b ? ('<' + (b.constructor && b.constructor.name) + ' ' + (b.byteLength || b.length || 0) + '>') : 'null');
      window.__sent.push({ url: (this.__u || (this._url || '')).slice(0, 90), body: t.slice(0, 1500) });
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){ this.__u = String(u); return origOpen.apply(this, arguments); };
  // The pre-encode seam: a $-join or a $-concat is the payload assembly.
  var origJoin = Array.prototype.join;
  Array.prototype.join = function(sep){
    if ((sep === '$' || (this.length > 1 && String(this[0]).indexOf('$') >= 0)) && this.length > 1) {
      try { window.__joins = window.__joins || []; window.__joins.push(this.map(function(x){ return String(x).slice(0, 120); })); } catch (e) {}
    }
    return origJoin.apply(this, arguments);
  };
  var origConcat = String.prototype.concat;
  String.prototype.concat = function(){
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] === '$') {
        try { window.__joins = window.__joins || []; window.__joins.push(['CONCAT', String(this).slice(0, 120)]); } catch (e) {}
        break;
      }
    }
    return origConcat.apply(this, arguments);
  };
  return 'hooked';
})()"""
r = send("Debugger.evaluateOnCallFrame", {"callFrameId": frames[0]["callFrameId"], "expression": hook, "returnByValue": True})
print("hook:", r.get("result", {}).get("value"), flush=True)
send("Debugger.resume")
time.sleep(8)
got = send("Runtime.evaluate", {"expression": "JSON.stringify(window.__sent || [])", "returnByValue": True})
print("SENT:", str(got.get("result", {}).get("value"))[:1200])
joins = send("Runtime.evaluate", {"expression": "JSON.stringify((window.__joins||[]).slice(0,12))", "returnByValue": True})
print("JOINS:", str(joins.get("result", {}).get("value"))[:1400])
ws.close()
