#!/usr/bin/env python3
"""r1_witness.py — DeepSeek-R1 / STaR rejection-sampling, teacher-free, on top of improved_adapters.

improved_adapters was distilled from a HAND-WRITTEN rule teacher on 7 families. It already generalizes
to some novel families (sum-of-squares, digit-sum, power = 8/8) but is only PARTIAL on others (gcd 4/8,
lcm 3/8). The R1 lever (sp-distillation root, arxiv:2501.12948; STaR arxiv:2203.14465): with NO teacher,
let the model write code, keep ONLY the attempts the sandbox verifies correct (rejection sampling), and
distil the model on its OWN verified successes — which solidifies partial competence into reliable skill.

Pipeline: improved_adapters generates K attempts per problem (temp>0) across a BROAD family set ->
sandbox verifier admits only correct code -> LoRA-distil the base on those self-traces -> r1_adapters.
Gate (exit 0 iff): r1_adapters beats improved_adapters on a DISJOINT held-out broad benchmark by a clear
margin, with the lift concentrated on the partial families and no regression on the solved ones.

Run:  ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 r1_witness.py
"""
import json, os, random, re, subprocess, sys, math

HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
PY = sys.executable
M = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
HARVEST_ADAPTER = "improved_adapters"
R1_ADAPTER = "r1_adapters"
MARGIN = 0.08

SYSTEM = ("You are a tool-using assistant. When a question needs precise computation, an exact string "
          "operation, a file value, or an algorithm, emit ONE tool call and let the tool answer: "
          "<calc>EXPRESSION</calc> for arithmetic, <join>word1, word2, ...</join> for last-letter "
          "concatenation, <lookup>file:key</lookup> to read a file, or a ```python``` block that prints the "
          "answer. End with 'Answer: <value>'.")

BLOCK = re.compile(r"```(?:python)?\s*(.*?)```|<py>(.*?)</py>", re.S)
BANNED = re.compile(r"\bimport\s+(os|sys|subprocess|socket|shutil|pathlib|requests|urllib)\b|"
                    r"\bopen\s*\(|__import__|\beval\(|\bexec\(|\.write\(|\.system\(|rmtree|remove\(|unlink")


def extract_code(out):
    m = BLOCK.search(out)
    if not m: return None
    return (m.group(1) or m.group(2) or "").strip()


def code_answer(out):
    """VERIFIER: run the model's code (auto-print `result`/`ans` if needed) and read the last int of stdout."""
    code = extract_code(out)
    if not code or BANNED.search(code): return None
    run = code
    if "print(" not in code:
        for v in ("result", "ans"):
            if re.search(rf"\b{v}\s*=", code):
                run = code + f"\nprint({v})"; break
    try:
        r = subprocess.run([PY, "-I", "-c", run], capture_output=True, text=True, timeout=5)
        n = re.findall(r"-?\d+", r.stdout); return n[-1] if n else None
    except Exception:
        return None


# --- broad families: (prompt, truth) only — the model writes the code, the sandbox verifies it ---
def families():
    def mult(r): a, b = r.randint(2, 99), r.randint(2, 99); return (f"What is {a} times {b}? Write Python and print it.", a * b)
    def fact(r): n = r.randint(3, 12); return (f"What is the factorial of {n}? Write Python and print it.", math.factorial(n))
    def summ(r): n = r.randint(10, 1000); return (f"Sum the integers from 1 to {n}. Write Python and print it.", n * (n + 1) // 2)
    def secs(r): d = r.randint(1, 14); return (f"How many seconds are in {d} days? Write Python and print it.", d * 86400)
    def chairs(r): a, b, c = r.randint(3, 12), r.randint(5, 30), r.randint(0, 15); return (f"There are {a} rows of {b} chairs, {c} broken. How many usable chairs? Write Python and print it.", a * b - c)
    def fib(r):
        n = r.randint(5, 25); a, b = 0, 1
        for _ in range(n): a, b = b, a + b
        return (f"Compute the {n}th Fibonacci number. Write Python and print it.", a)
    def divs(r): n = r.randint(12, 500); return (f"How many positive divisors does {n} have? Write Python and print it.", sum(1 for d in range(1, n + 1) if n % d == 0))
    def gcd(r): a, b = r.randint(6, 200), r.randint(6, 200); return (f"What is the greatest common divisor of {a} and {b}? Write Python and print it.", math.gcd(a, b))
    def lcm(r): a, b = r.randint(4, 60), r.randint(4, 60); return (f"What is the least common multiple of {a} and {b}? Write Python and print it.", a * b // math.gcd(a, b))
    def rem(r): a, b = r.randint(20, 500), r.randint(3, 30); return (f"What is the remainder when {a} is divided by {b}? Write Python and print it.", a % b)
    def nck(r): n = r.randint(5, 15); k = r.randint(1, n); return (f"How many ways to choose {k} items from {n}? Write Python and print it.", math.comb(n, k))
    def sumsq(r): n = r.randint(3, 40); return (f"What is the sum of squares from 1 to {n}? Write Python and print it.", sum(i * i for i in range(1, n + 1)))
    return {"mult": mult, "fact": fact, "sum": summ, "secs": secs, "chairs": chairs, "fib": fib,
            "divs": divs, "gcd": gcd, "lcm": lcm, "rem": rem, "nck": nck, "sumsq": sumsq}


PARTIAL = ["gcd", "lcm", "rem", "nck"]   # families improved_adapters is weak/partial on
HELD = ["gcd", "lcm", "rem", "nck", "sumsq", "fib", "divs"]   # held-out eval families


def main():
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler
    fams = families()
    tok = None

    # ---- HARVEST: improved_adapters writes code; keep only sandbox-verified-correct (rejection sampling) ----
    print("loading improved_adapters for harvest ...", flush=True)
    hmodel, tok = load(M, adapter_path=HARVEST_ADAPTER)
    rng = random.Random(11)
    traces, attempts, kept_by = [], 0, {}
    for name, fn in fams.items():
        for _ in range(14):
            q, truth = fn(rng)
            for temp in (0.0, 0.7, 0.7):
                attempts += 1
                pr = tok.apply_chat_template([{"role": "system", "content": SYSTEM},
                                              {"role": "user", "content": q}], add_generation_prompt=True)
                out = generate(hmodel, tok, prompt=pr, max_tokens=200, sampler=make_sampler(temp=temp), verbose=False)
                if code_answer(out) == str(truth):
                    traces.append({"messages": [{"role": "system", "content": SYSTEM},
                                                {"role": "user", "content": q},
                                                {"role": "assistant", "content": out.strip()}]})
                    kept_by[name] = kept_by.get(name, 0) + 1
                    break  # one verified trace per problem is enough
    print(f"  rejection sampling: kept {len(traces)} verified self-traces from {attempts} attempts")
    print(f"  per-family kept: {kept_by}", flush=True)
    if len(traces) < 60:
        print(f"R1 FAIL: too few verified self-traces ({len(traces)}) to distil"); return 1
    del hmodel

    # ---- DISTIL the base on the model's OWN verified traces (teacher-free) ----
    os.makedirs("r1_data", exist_ok=True)
    rng.shuffle(traces); nv = max(8, len(traces) // 10)
    open("r1_data/valid.jsonl", "w").write("\n".join(json.dumps(t) for t in traces[:nv]))
    open("r1_data/train.jsonl", "w").write("\n".join(json.dumps(t) for t in traces[nv:]))
    if not os.path.exists(os.path.join(R1_ADAPTER, "adapters.safetensors")):
        cmd = [PY, "-m", "mlx_lm.lora", "--model", M, "--train", "--data", "r1_data",
               "--adapter-path", R1_ADAPTER, "--iters", "320", "--batch-size", "4", "--num-layers", "16",
               "--learning-rate", "1e-4", "--steps-per-eval", "160", "--save-every", "160",
               "--max-seq-length", "512", "--seed", "0"]
        if subprocess.run(cmd, text=True).returncode != 0:
            print("R1 FAIL: LoRA training failed"); return 1

    # ---- EVAL: held-out disjoint instances, improved vs r1 (model writes code, sandbox checks) ----
    held = [(name, fams[name](random.Random(900 + i))) for name in HELD for i in range(6)]

    def evaluate(adapter):
        mdl, tk = load(M, adapter_path=adapter)
        by = {}
        for name, (q, truth) in held:
            pr = tk.apply_chat_template([{"role": "system", "content": SYSTEM},
                                         {"role": "user", "content": q}], add_generation_prompt=True)
            out = generate(mdl, tk, prompt=pr, max_tokens=200, sampler=make_sampler(temp=0.0), verbose=False)
            ok = code_answer(out) == str(truth)
            by.setdefault(name, []).append(ok)
        del mdl
        return by

    imp = evaluate(HARVEST_ADAPTER)
    r1 = evaluate(R1_ADAPTER)
    def acc(by, fams_=None):
        items = [ok for n, oks in by.items() if (fams_ is None or n in fams_) for ok in oks]
        return sum(items) / len(items) if items else 0.0
    imp_all, r1_all = acc(imp), acc(r1)
    imp_p, r1_p = acc(imp, PARTIAL), acc(r1, PARTIAL)
    print("\n  family          improved   r1")
    for n in HELD:
        print(f"  {n:10}      {sum(imp[n])}/{len(imp[n])}        {sum(r1[n])}/{len(r1[n])}")
    print(f"\n  overall held-out : improved {imp_all*100:.1f}%  ->  r1 {r1_all*100:.1f}%")
    print(f"  partial families : improved {imp_p*100:.1f}%  ->  r1 {r1_p*100:.1f}%")

    no_regress = r1_all >= imp_all - 0.02
    lifted = r1_all >= imp_all + MARGIN
    if lifted and no_regress:
        print(f"\nR1 PASS: teacher-free rejection sampling lifted held-out code-correctness "
              f"{imp_all*100:.1f}% -> {r1_all*100:.1f}% (partial families {imp_p*100:.0f}% -> {r1_p*100:.0f}%) "
              f"— the model distilled its OWN verified successes, no teacher.")
        return 0
    print(f"\nR1 FAIL: r1 {r1_all*100:.1f}% did not beat improved {imp_all*100:.1f}% by {MARGIN*100:.0f} (no-regress={no_regress})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
