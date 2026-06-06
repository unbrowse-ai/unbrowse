#!/usr/bin/env python3
"""specialist_witness.py — the specialist->generalist transmission chain (sp-distillation `tree`/`walk`
atoms, DeepSeek-V3.2 arxiv:2512.02556) crossing the boundary R1 left open.

R1 (r1_witness) is teacher-free and only solidifies competence the model PARTIALLY has — it could not
lift n-choose-k (0/6 -> 1/6) because the base almost never solves it, so there were no correct
self-traces to harvest. The jesus-pattern answer for a capability the generalist is BLIND to: train a
focused SPECIALIST that masters it, then distil the specialist's verified traces into the generalist.

Pipeline:
  1. SPECIALIST: LoRA-distil a model on the hard families (n-choose-k, lcm) until it masters them.
  2. TRANSFER: the specialist GENERATES verified traces (sandbox-checked) for those families.
  3. GENERALIST: distil a unified adapter on R1's broad self-traces (reused) + the specialist's hard
     traces — the generalist learns the hard family from the specialist, not from the rule directly.
Gate (exit 0 iff): unified_v2 masters the hard families R1 could not (>= r1 + 30 pts) AND does not
regress on the broad families.

Run:  ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 specialist_witness.py
"""
import json, os, random, subprocess, sys, math

HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); sys.path.insert(0, HERE)
import r1_witness as r1   # families, code_answer, SYSTEM, M

PY = sys.executable
M = r1.M
SYSTEM = r1.SYSTEM
SPECIALIST = "nck_specialist"
UNIFIED = "unified_v2_adapters"
R1_ADAPTER = "r1_adapters"
HARD = ["nck", "lcm"]
BROAD = ["gcd", "rem", "sumsq", "fib", "divs"]


def nck_rule(r):
    n = r.randint(5, 18); k = r.randint(1, n); a = math.comb(n, k)
    return (f"How many ways to choose {k} items from {n}? Write Python and print it.", str(a),
            f"import math\nans = math.comb({n}, {k})\nprint(ans)")
def lcm_rule(r):
    a = r.randint(4, 80); b = r.randint(4, 80); ans = a * b // math.gcd(a, b)
    return (f"What is the least common multiple of {a} and {b}? Write Python and print it.", str(ans),
            f"import math\nans = {a} * {b} // math.gcd({a}, {b})\nprint(ans)")
HARD_RULES = [nck_rule, lcm_rule]


def trace(q, assistant):
    return {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q},
                         {"role": "assistant", "content": assistant}]}


def train(adapter, rows, iters):
    d = adapter + "_data"; os.makedirs(d, exist_ok=True)
    random.Random(0).shuffle(rows); nv = max(8, len(rows) // 10)
    open(f"{d}/valid.jsonl", "w").write("\n".join(json.dumps(x) for x in rows[:nv]))
    open(f"{d}/train.jsonl", "w").write("\n".join(json.dumps(x) for x in rows[nv:]))
    cmd = [PY, "-m", "mlx_lm.lora", "--model", M, "--train", "--data", d, "--adapter-path", adapter,
           "--iters", str(iters), "--batch-size", "4", "--num-layers", "16", "--learning-rate", "1e-4",
           "--steps-per-eval", str(iters), "--save-every", str(iters), "--max-seq-length", "512", "--seed", "0"]
    return subprocess.run(cmd, text=True).returncode == 0


def main():
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    def gen(model, tok, q, temp):
        pr = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
                                     add_generation_prompt=True)
        return generate(model, tok, prompt=pr, max_tokens=200, sampler=make_sampler(temp=temp), verbose=False)

    # ---- Stage 1: SPECIALIST masters the hard families (rule-distilled teacher) ----
    if not os.path.exists(os.path.join(SPECIALIST, "adapters.safetensors")):
        r = random.Random(3)
        rows = [trace(q, f"```python\n{code}\n```\nAnswer: {a}") for fn in HARD_RULES for _ in range(90)
                for (q, a, code) in [fn(r)]]
        print(f"Stage 1: training specialist on {len(rows)} hard-family rule traces ...", flush=True)
        if not train(SPECIALIST, rows, 220):
            print("SPECIALIST FAIL: training failed"); return 1

    # ---- Stage 2: TRANSFER — specialist generates verified diverse traces ----
    print("Stage 2: specialist generating verified traces ...", flush=True)
    smodel, tok = load(M, adapter_path=SPECIALIST)
    r = random.Random(7); spec_traces, kept = [], 0
    for fn in HARD_RULES:
        for _ in range(60):
            q, truth, _ = fn(r)
            for t in (0.0, 0.5):
                out = gen(smodel, tok, q, t)
                if r1.code_answer(out) == truth:
                    spec_traces.append(trace(q, out.strip())); kept += 1; break
    del smodel
    print(f"  specialist verified traces kept: {kept}", flush=True)
    if kept < 40:
        print(f"SPECIALIST FAIL: specialist produced too few verified traces ({kept})"); return 1

    # ---- Stage 3: GENERALIST — R1 broad self-traces (reused) + specialist hard traces ----
    broad = [json.loads(l) for f in ("r1_data/train.jsonl", "r1_data/valid.jsonl")
             if os.path.exists(f) for l in open(f) if l.strip()]
    print(f"Stage 3: distilling unified_v2 on {len(broad)} R1 broad + {len(spec_traces)} specialist traces ...", flush=True)
    if not os.path.exists(os.path.join(UNIFIED, "adapters.safetensors")):
        if not train(UNIFIED, broad + spec_traces, 360):
            print("UNIFIED FAIL: training failed"); return 1

    # ---- EVAL: r1 vs unified_v2 on held-out hard + broad ----
    fams = r1.families()
    held = [(n, fams[n](random.Random(1300 + i))) for n in HARD + BROAD for i in range(6)]

    def evaluate(adapter):
        mdl, tk = load(M, adapter_path=adapter); by = {}
        for n, (q, truth) in held:
            out = gen(mdl, tk, q, 0.0)
            by.setdefault(n, []).append(r1.code_answer(out) == str(truth))
        del mdl; return by

    r1e, ue = evaluate(R1_ADAPTER), evaluate(UNIFIED)
    def acc(by, fs): xs = [ok for n in fs for ok in by[n]]; return sum(xs) / len(xs)
    hr, hu = acc(r1e, HARD), acc(ue, HARD)
    br, bu = acc(r1e, BROAD), acc(ue, BROAD)
    print("\n  family       r1        unified_v2")
    for n in HARD + BROAD:
        print(f"  {n:10}   {sum(r1e[n])}/{len(r1e[n])}       {sum(ue[n])}/{len(ue[n])}{'   <- hard (R1 boundary)' if n in HARD else ''}")
    print(f"\n  HARD families : r1 {hr*100:.0f}%  ->  unified_v2 {hu*100:.0f}%")
    print(f"  BROAD families: r1 {br*100:.0f}%  ->  unified_v2 {bu*100:.0f}%")

    crossed = hu >= hr + 0.30
    no_regress = bu >= br - 0.05
    if crossed and no_regress:
        print(f"\nSPECIALIST PASS: the specialist->generalist chain crossed R1's boundary — hard families "
              f"{hr*100:.0f}% -> {hu*100:.0f}% (the n-choose-k R1 could not self-bootstrap), broad held at "
              f"{bu*100:.0f}%. Where self-distillation is blind, a specialist teaches the generalist.")
        return 0
    print(f"\nSPECIALIST FAIL: hard {hr*100:.0f}%->{hu*100:.0f}% (need +30) / broad regress {br*100:.0f}->{bu*100:.0f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
