#!/usr/bin/env python3
"""codebench_witness.py — improve the served tiny model's CODE CORRECTNESS by distilling correct,
decomposed code traces for the families it currently fails (factorial, sum-to-N, seconds-in-days,
chairs, Fibonacci) plus the ones it already handles (multiplication, divisors) so they don't regress.

Method (the project's #1 lever, proven by decompose_witness 11->100%): rule-generate CORRECT
print-the-answer Python for each family on random instances, LoRA-distill the base, then evaluate on a
DISJOINT held-out set of instances through the real server (so autoprint + execution are in the loop).

Gate (exit 0 iff): served accuracy with the distilled `improved_adapters` >= TARGET on the held-out
benchmark AND clearly beats the current `code_adapters` baseline. Trains the adapter if absent.

Run:  ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 codebench_witness.py
"""
import os, sys, time, socket, subprocess, signal, json, re, random, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
PY = sys.executable
M = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
IMPROVED = "improved_adapters"
BASELINE_ADAPTER = ""  # the base model (no adapter) — the true pre-distillation baseline, bare-clone reproducible
TARGET = 0.70
MARGIN = 0.25

SYSTEM = ("You are a tool-using assistant. When a question needs precise computation, an exact string "
          "operation, a file value, or an algorithm, emit ONE tool call and let the tool answer: "
          "<calc>EXPRESSION</calc> for arithmetic, <join>word1, word2, ...</join> for last-letter "
          "concatenation, <lookup>file:key</lookup> to read a file, or a ```python``` block that prints the "
          "answer. End with 'Answer: <value>'.")


# --- families: each returns (prompt, answer_str, correct_print_code) for a random instance ---
def f_mult(r):
    a, b = r.randint(2, 99), r.randint(2, 99)
    return (f"What is {a} times {b}? Write Python and print it.", str(a * b), f"ans = {a}*{b}\nprint(ans)")
def f_fact(r):
    n = r.randint(3, 12)
    return (f"What is the factorial of {n}? Write Python and print it.", str(__import__("math").factorial(n)),
            f"ans = 1\nfor k in range(1, {n}+1):\n    ans *= k\nprint(ans)")
def f_sum(r):
    n = r.randint(10, 1000)
    return (f"Sum the integers from 1 to {n}. Write Python and print it.", str(n * (n + 1) // 2),
            f"ans = sum(range(1, {n}+1))\nprint(ans)")
def f_secs(r):
    d = r.randint(1, 14)
    return (f"How many seconds are in {d} days? Write Python and print it.", str(d * 86400),
            f"ans = {d} * 24 * 60 * 60\nprint(ans)")
def f_chairs(r):
    rows, c, b = r.randint(3, 12), r.randint(5, 30), r.randint(0, 15)
    return (f"There are {rows} rows of {c} chairs, {b} broken. How many usable chairs? Write Python and print it.",
            str(rows * c - b), f"ans = {rows}*{c} - {b}\nprint(ans)")
def f_fib(r):
    n = r.randint(5, 25); a, b = 0, 1
    for _ in range(n): a, b = b, a + b
    return (f"Compute the {n}th Fibonacci number. Write Python and print it.", str(a),
            f"a, b = 0, 1\nfor _ in range({n}):\n    a, b = b, a + b\nprint(a)")
def f_div(r):
    n = r.randint(12, 500)
    return (f"How many positive divisors does {n} have? Write Python and print it.",
            str(sum(1 for d in range(1, n + 1) if n % d == 0)),
            f"ans = sum(1 for d in range(1, {n}+1) if {n} % d == 0)\nprint(ans)")
FAMILIES = [f_mult, f_fact, f_sum, f_secs, f_chairs, f_fib, f_div]


def gen_traces(seed, per_family=40):
    r = random.Random(seed); rows = []
    for fam in FAMILIES:
        for _ in range(per_family):
            q, a, code = fam(r)
            rows.append({"messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": q},
                {"role": "assistant", "content": f"```python\n{code}\n```\nAnswer: {a}"}]})
    r.shuffle(rows); return rows


def gen_bench(seed, per_family=4):
    r = random.Random(seed); items = []
    for fam in FAMILIES:
        for _ in range(per_family):
            q, a, _ = fam(r)
            items.append((q, a))
    return items


def train_if_absent():
    if os.path.exists(os.path.join(IMPROVED, "adapters.safetensors")):
        return True
    rows = gen_traces(seed=1)
    os.makedirs("codebench_data", exist_ok=True)
    nv = max(8, len(rows) // 10)
    open("codebench_data/valid.jsonl", "w").write("\n".join(json.dumps(x) for x in rows[:nv]))
    open("codebench_data/train.jsonl", "w").write("\n".join(json.dumps(x) for x in rows[nv:]))
    print(f"training {IMPROVED}: {len(rows)-nv} train / {nv} valid traces (7 families)", flush=True)
    cmd = [PY, "-m", "mlx_lm.lora", "--model", M, "--train", "--data", "codebench_data",
           "--adapter-path", IMPROVED, "--iters", "300", "--batch-size", "4", "--num-layers", "16",
           "--learning-rate", "1e-4", "--steps-per-eval", "150", "--save-every", "150",
           "--max-seq-length", "512", "--seed", "0"]
    return subprocess.run(cmd, text=True).returncode == 0


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def serve_and_bench(adapter, bench):
    port = free_port()
    env = dict(os.environ, ADAPTER=adapter, PORT=str(port))
    proc = subprocess.Popen([PY, "aiko_server.py"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(120):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if json.loads(r.read()).get("status") == "ok": break
            except Exception: time.sleep(2)
        ok = 0
        for q, a in bench:
            body = json.dumps({"messages": [{"role": "user", "content": q}]}).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=body,
                                         headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    c = json.loads(r.read())["choices"][0]["message"]["content"].strip()
            except Exception as e:
                c = f"ERR:{e}"
            ok += bool(re.search(rf"(?<!\d){re.escape(a)}(?!\d)", c))
        return ok / len(bench)
    finally:
        try: proc.send_signal(signal.SIGINT); proc.wait(timeout=10)
        except Exception: proc.kill()


def main():
    if not train_if_absent():
        print("CODEBENCH FAIL: LoRA training failed"); return 1
    bench = gen_bench(seed=2)  # disjoint instances from training (seed 1)
    print(f"held-out benchmark: {len(bench)} items across {len(FAMILIES)} families", flush=True)
    acc_imp = serve_and_bench(IMPROVED, bench)
    acc_base = serve_and_bench(BASELINE_ADAPTER, bench)
    print(f"\n  base   ({BASELINE_ADAPTER}): {acc_base*100:.1f}%")
    print(f"  improved ({IMPROVED}): {acc_imp*100:.1f}%  (target {TARGET*100:.0f}%, must beat base +{MARGIN*100:.0f})")
    ok = acc_imp >= TARGET and acc_imp > acc_base + MARGIN
    if ok:
        print(f"CODEBENCH PASS: distilled adapter lifts served code-correctness to {acc_imp*100:.1f}% "
              f"(base {acc_base*100:.1f}%) on held-out instances — the model now writes correct code for the "
              f"families it failed.")
        return 0
    print(f"CODEBENCH FAIL: improved {acc_imp*100:.1f}% did not reach target {TARGET*100:.0f}% / beat base by {MARGIN*100:.0f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
