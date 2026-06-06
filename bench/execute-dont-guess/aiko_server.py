#!/usr/bin/env python3
"""aiko_server.py — an OpenAI-compatible /v1/chat/completions server for a tiny tool-routing local model.

A 1.5B model (Qwen2.5-1.5B-Instruct-4bit) + a LoRA adapter that emits tool calls; THIS server executes the
tool and returns the exact answer. Any agent framework that speaks the OpenAI API can call it. The model
reasons about which tool a task needs; the server's real local primitives do the precise step:
  <calc>EXPR</calc>          -> sandboxed arithmetic (unbounded precision)
  <join>w1,w2,..</join>      -> exact last-letter concatenation
  <lookup>file:key</lookup>  -> read a real file on disk (live state)
  <py>...; print(...)</py>   -> a sandboxed Python interpreter (universal computation)

Run:  ADAPTER=unified_adapters PORT=8080 ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 aiko_server.py
Test: curl -s localhost:8080/v1/chat/completions -d '{"messages":[{"role":"user","content":"..."}]}'
"""
import json, os, re, signal, subprocess, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
ADAPTER = os.environ.get("ADAPTER", "unified_adapters")
PORT = int(os.environ.get("PORT", "8080"))
BASE = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
STATE = os.environ.get("LOOKUP_DIR", os.path.join(HERE, "realstate"))
MODEL_ID = f"aiko-tinytools-1.5b+{ADAPTER}"

# ---- the real local tool primitives (server-side execution) ----
CALC = re.compile(r"<calc>\s*([0-9\+\-\*\(\)\s]+?)\s*</calc>")
JOIN = re.compile(r"<join>\s*([A-Za-z, ]+?)\s*</join>")
LOOKUP = re.compile(r"<lookup>\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z]+)\s*</lookup>")
PYB = re.compile(r"<py>(.*?)</py>|```(?:python)?\s*(.*?)```", re.S)
BANNED = re.compile(r"\bimport\s+(os|sys|subprocess|socket|shutil|requests|urllib)\b|__import__|\bopen\s*\(|\beval\(|\bexec\(|\.system\(|rmtree|unlink|\.write\(")
def t_calc(e):
    if not re.fullmatch(r"[0-9\+\-\*\(\)\s]+", e or ""): return None
    try: return str(eval(e, {"__builtins__": {}}, {}))
    except Exception: return None
def t_join(s):
    ws = [w for w in re.split(r"[,\s]+", s) if w]; return "".join(w[-1] for w in ws).lower()
def t_lookup(f, k):
    p = os.path.join(STATE, f + ".txt")
    if not os.path.exists(p): return None
    for line in open(p):
        if line.startswith(k + "="): return line.split("=", 1)[1].strip()
    return None
# The code sandbox needs a REAL Python interpreter. sys.executable is correct when run normally, but in
# a frozen (PyInstaller) binary it is the app itself, not python — so resolve a real python3 there.
import shutil
PYEXEC = (os.environ.get("AIKO_PYEXEC")
          or (shutil.which("python3") or shutil.which("python") or "python3"
              if getattr(sys, "frozen", False) else sys.executable))
def t_py(code):
    if not code or BANNED.search(code): return None
    # The model often writes CORRECT code that assigns `result` but never prints it — then stdout is
    # empty and we'd discard the real computation. If so, print the result so the executed value wins
    # over the model's (frequently wrong) memorized "Answer:" line.
    run = code
    if "print(" not in code and re.search(r"\bresult\s*=", code):
        run = code + "\nprint(result)"
    try:
        r = subprocess.run([PYEXEC, "-I", "-c", run], capture_output=True, text=True, timeout=5)
        nums = re.findall(r"-?\d+", r.stdout); return (r.stdout.strip() or (nums[-1] if nums else None))
    except Exception: return None
# map an executed internal tool to an OpenAI `tool_calls` entry (for callers that pass `tools=`)
_FN = {"py": "python", "calc": "calc", "join": "join", "lookup": "lookup"}
def to_tool_call(tool, call):
    """Build a standard OpenAI tool_call dict describing what the server executed (it still ran it)."""
    if not tool: return None
    if tool == "py":      args = {"code": call}
    elif tool == "calc":  args = {"expression": call}
    elif tool == "join":  args = {"words": call}
    elif tool == "lookup":
        f, _, k = (call or "").partition(":"); args = {"file": f, "key": k}
    else:                 args = {"input": call}
    return {"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
            "function": {"name": _FN.get(tool, tool), "arguments": json.dumps(args)}}

def detect_tool(out):
    """Return (tool_name, tool_call_text) for the first tool the model emitted — WITHOUT executing it."""
    m = CALC.search(out)
    if m: return "calc", m.group(1)
    m = JOIN.search(out)
    if m: return "join", m.group(1)
    m = LOOKUP.search(out)
    if m: return "lookup", f"{m.group(1)}:{m.group(2)}"
    m = PYB.search(out)
    if m: return "py", (m.group(1) or m.group(2) or "").strip()
    return None, None

def exec_tool(tool, call):
    """Execute a detected internal tool server-side and return its exact result (or None)."""
    if tool == "calc":   return t_calc(call)
    if tool == "join":   return t_join(call)
    if tool == "lookup": f, _, k = (call or "").partition(":"); return t_lookup(f, k)
    if tool == "py":     return t_py(call)
    return None

def run_tools(out):  # legacy convenience: detect + execute in one step
    tool, call = detect_tool(out)
    return tool, call, (exec_tool(tool, call) if tool else None)

# canonical OpenAI function name + STRUCTURED args for a detected internal tool
def tool_to_function(tool, call):
    if tool == "py":     return "python", {"code": call}
    if tool == "calc":   return "calc", {"expression": call}
    if tool == "join":   return "join", {"words": call}
    if tool == "lookup":
        f, _, k = (call or "").partition(":"); return "lookup", {"file": f, "key": k}
    return tool, {"input": call}

# match our internal tool to the function name the CLIENT actually declared in tools=[...]
def match_declared(name, tools):
    decl = [t.get("function", {}).get("name") for t in (tools or [])
            if isinstance(t, dict) and t.get("type") == "function"]
    decl = [d for d in decl if d]
    if name in decl: return name
    ALIAS = {"python": ("python", "code", "exec", "execute", "run", "py", "interpreter"),
             "calc": ("calc", "calculate", "calculator", "math", "arithmetic", "eval"),
             "join": ("join", "concat", "concatenate", "letters"),
             "lookup": ("lookup", "read", "get", "file", "fetch", "retrieve")}
    for d in decl:
        dl = d.lower()
        if any(a in dl or dl in a for a in ALIAS.get(name, (name,))): return d
    return decl[0] if decl else name

SYSTEM = ("You are a tool-using assistant. When a question needs precise computation, an exact string "
          "operation, a file value, or an algorithm, emit ONE tool call and let the tool answer: "
          "<calc>EXPRESSION</calc> for arithmetic, <join>word1, word2, ...</join> for last-letter "
          "concatenation, <lookup>file:key</lookup> to read a file, or a ```python``` block that prints the "
          "answer. End with 'Answer: <value>'.")

print(f"loading {BASE} + {ADAPTER} ...", flush=True)
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler
_model, _tok = load(BASE, adapter_path=ADAPTER)
_sampler = make_sampler(temp=0.0)
# MLX generation on a shared model is NOT thread-safe: two concurrent generate() calls (e.g. an agent
# that pipelines requests) race on Metal and crash the process. Serialize generation behind one lock —
# connections are still handled concurrently; only the model forward pass is one-at-a-time.
_gen_lock = threading.Lock()
print(f"ready: {MODEL_ID} on :{PORT}", flush=True)

def _gen(msgs, max_tokens):
    prompt = _tok.apply_chat_template(msgs, add_generation_prompt=True)
    with _gen_lock:
        return generate(_model, _tok, prompt=prompt, max_tokens=max_tokens, sampler=_sampler, verbose=False)

def chat(messages, max_tokens=400, execute=True):
    """Run the model on the current turn. execute=True runs the tool server-side (legacy/plain mode);
    execute=False only DETECTS the tool the model wants (native tool-calling Action step)."""
    msgs = [{"role": "system", "content": SYSTEM}] + [m for m in messages if m.get("role") != "system"]
    raw = _gen(msgs, max_tokens)
    tool, call = detect_tool(raw)
    result = exec_tool(tool, call) if (execute and tool) else None
    if tool and result is not None:
        content = str(result)
    else:
        a = re.search(r"[Aa]nswer:\s*\"?([A-Za-z0-9\-\.]+)", raw)
        content = a.group(1) if a else raw.strip()
    return content, {"tool": tool, "tool_call": call, "result": result, "raw": raw}

# Native tool-calling Observation->Answer step (ReAct, arxiv:2210.03629): the client executed the tool
# and sent back a role:"tool" result; compose the final natural-language answer from that real result.
OBSERVE_SYS = ("You are given the result of a tool that was run to answer the user's question. Reply with "
               "one short sentence stating the final answer, and include the exact result value verbatim.")
def observe(messages, max_tokens=200):
    user_q = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
    tool_res = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "tool"), "")
    msgs = [{"role": "system", "content": OBSERVE_SYS},
            {"role": "user", "content": f"Question: {user_q}\nTool result: {tool_res}\nFinal answer:"}]
    return _gen(msgs, max_tokens).strip()

REQLOG = os.environ.get("AIKO_REQLOG")  # if set, append one line per chat request (proves who called us)
def _reqlog(line):
    if not REQLOG: return
    try:
        with open(REQLOG, "a") as f: f.write(line + "\n")
    except Exception: pass

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "tinytools"}]})
        elif self.path.rstrip("/") in ("", "/health", "/healthz"):
            self._send(200, {"status": "ok", "model": MODEL_ID})
        else:
            self._send(404, {"error": "not found"})
    def _send_stream(self, cid, message, finish_reason="stop"):
        """Emit the completion as OpenAI SSE chunks (text/event-stream) — what agent CLIs consume."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "keep-alive")
        self.end_headers()
        base = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL_ID}
        def emit(delta, fr=None):
            chunk = dict(base, choices=[{"index": 0, "delta": delta, "finish_reason": fr}])
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush()
        emit({"role": "assistant"})                       # opening chunk
        if message.get("content"):
            emit({"content": message["content"]})         # the answer (single delta; it's already computed)
        if message.get("tool_calls"):
            emit({"tool_calls": message["tool_calls"]})   # native Action: the tool_call delta
        emit({}, finish_reason)                            # terminal chunk ("stop" or "tool_calls")
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            messages = body.get("messages", [])
            stream = bool(body.get("stream"))
            _reqlog(f"{int(time.time())} POST /v1/chat/completions model={body.get('model','')} "
                    f"msgs={len(messages)} tools={'tools' in body} stream={stream} ua={self.headers.get('User-Agent','')}")
            max_tokens = int(body.get("max_tokens", 400))
            tools = body.get("tools")
            # NATIVE tool calling (the OpenAI / LM Studio protocol): triggered by passing tools=[...].
            # The model emits an Action (tool_calls, finish_reason "tool_calls", no content) and does NOT
            # execute; the CLIENT runs the tool and sends back a role:"tool" result, then the model gives
            # the final Answer (ReAct, arxiv:2210.03629). Legacy server-side execution stays available via
            # `"return_tool_calls": true`, and a plain client (no tools=) is unaffected.
            native = bool(tools) and not body.get("return_tool_calls")
            last_io = next((m.get("role") for m in reversed(messages) if m.get("role") in ("user", "tool")), None)
            cid = "chatcmpl-" + uuid.uuid4().hex[:24]

            if native and last_io == "tool":              # Observation -> Answer
                answer = observe(messages, min(max_tokens, 200))
                message = {"role": "assistant", "content": answer}
                finish_reason = "stop"; dbg = {"mode": "native-observe"}
            elif native:                                  # Action: emit tool_call, do NOT execute
                _content, det = chat(messages, max_tokens, execute=False)
                if det.get("tool"):
                    fname, args = tool_to_function(det["tool"], det["tool_call"])
                    tc = {"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                          "function": {"name": match_declared(fname, tools), "arguments": json.dumps(args)}}
                    message = {"role": "assistant", "content": None, "tool_calls": [tc]}
                    finish_reason = "tool_calls"; dbg = {"mode": "native-action", "tool": det["tool"]}
                else:                                     # model answered directly, no tool wanted
                    message = {"role": "assistant", "content": _content}
                    finish_reason = "stop"; dbg = {"mode": "native-direct"}
            else:                                         # legacy / plain: server executed, clean terminating msg
                content, finish = chat(messages, max_tokens)
                message = {"role": "assistant", "content": content}
                finish_reason = "stop"; dbg = finish
                if body.get("return_tool_calls") and finish.get("tool"):
                    tc = to_tool_call(finish["tool"], finish["tool_call"])
                    if tc: message["tool_calls"] = [tc]

            if stream:
                return self._send_stream(cid, message, finish_reason)
            self._send(200, {
                "id": cid, "object": "chat.completion",
                "created": int(time.time()), "model": MODEL_ID,
                "choices": [{"index": 0, "finish_reason": finish_reason,
                             "message": message, "tinytools": dbg}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
        except Exception as e:
            self._send(500, {"error": str(e)})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
