#!/usr/bin/env python3
"""farformula_witness.py — crossing the FAR-generalization ceiling (the open frontier
from finding #30: diverse distillation reaches NEAR held-out families ~90% but
genuinely NOVEL formulas stay 0%). You cannot distill a formula the model has never
seen and could not infer — but you can RETRIEVE it and EXECUTE it. This is the
project's own thesis (the right local primitive crosses the from-scratch-impossible
wall) applied to the generalization ceiling: a formula-reference tool + the code tool.

To make the wall UNAMBIGUOUS we use MADE-UP formulas the 1.5B provably cannot know
(no amount of training would teach these specific definitions). Without the reference
the model must guess -> ~0%. With the retrieved formula in context it writes a tiny
program and the sandbox computes it -> high. The gain is retrieval+execution, not
memorisation.

Gate (exit 0 iff): with-retrieval >= 0.80 AND without-retrieval <= 0.20 AND
with >> without by >= 0.5 (the wall is real and retrieval crosses it).
Run:  ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 farformula_witness.py
"""
import os
import random
import re
import signal
import sys

M = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
rng = random.Random(31)

# ---- the code-execution sandbox (reused from code_tool_witness) ----
# Accept the base model's natural markdown fences (```py / ```python) as well as <py> tags.
PY = re.compile(r"<py>(.*?)</py>|```(?:py|python)?\s*(.*?)```", re.S)
SAFE_BUILTINS = {"range": range, "len": len, "sum": sum, "abs": abs, "min": min,
                 "max": max, "int": int, "pow": pow}
BANNED = re.compile(r"__|import|open|eval|exec|compile|globals|locals|getattr|setattr|"
                    r"input|\bos\b|\bsys\b|subprocess|socket|file|read|write")


def run_code(code):
    if not code or BANNED.search(code):
        return None
    ns = {"__builtins__": {}, **SAFE_BUILTINS}
    try:
        def _to(s, f):
            raise TimeoutError()
        old = signal.signal(signal.SIGALRM, _to)
        signal.setitimer(signal.ITIMER_REAL, 2.0)
        try:
            exec(code, ns)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)
        r = ns.get("result")
        return str(r) if isinstance(r, int) else None
    except Exception:
        return None


def code_answer(out):
    m = PY.search(out)
    if not m:
        return None
    code = (m.group(1) or m.group(2) or "").strip()
    return run_code(code)


# ---- FAR-novel (made-up) formula families: name -> (reference text, truth-fn) ----
# These definitions exist nowhere in the model's training; only retrieval supplies them.
FORMULAS = {
    "florbnac": ("florbnac(n) = 3*n**2 - 2*n + 7", lambda n: 3 * n ** 2 - 2 * n + 7),
    "zibble":   ("zibble(n) = n**3 - 4*n + 11", lambda n: n ** 3 - 4 * n + 11),
    "quordle":  ("quordle(n) = (n*(n+1))//2 + 5*n", lambda n: (n * (n + 1)) // 2 + 5 * n),
    "snarf":    ("snarf(n) = 2**(n % 6) + 3*n - 1", lambda n: 2 ** (n % 6) + 3 * n - 1),
}


def build_tests(k=5):
    tests = []
    for name, (ref, fn) in FORMULAS.items():
        for _ in range(k):
            n = rng.randint(3, 20)
            tests.append({"name": name, "ref": ref, "n": n, "a": str(fn(n))})
    return tests


def main():
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    tests = build_tests(5)
    m, tok = load(M)
    s = make_sampler(temp=0.0)

    def ask(prompt):
        pr = tok.apply_chat_template([{"role": "user", "content": prompt}],
                                     add_generation_prompt=True)
        return generate(m, tok, prompt=pr, max_tokens=200, sampler=s, verbose=False)

    instr = ("Emit exactly one <py> ... result=... </py> code block computing the value, "
             "then 'Answer: <number>'.")
    without_ok = with_ok = 0
    for it in tests:
        nm, n, ref = it["name"], it["n"], it["ref"]
        # WITHOUT retrieval: the model must already 'know' the novel formula (it cannot)
        p0 = f"Compute {nm}({n}). {instr}"
        # WITH retrieval: the formula-reference tool supplies the definition
        p1 = f"Reference (retrieved): {ref}\nUsing that exact formula, compute {nm}({n}). {instr}"
        without_ok += (code_answer(ask(p0)) == it["a"])
        with_ok += (code_answer(ask(p1)) == it["a"])

    n = len(tests)
    a0, a1 = without_ok / n, with_ok / n
    print(f"far-novel formulas (made-up, unknowable): {n} items across {len(FORMULAS)} families")
    print(f"  WITHOUT retrieval (model must know it) : {without_ok}/{n} = {a0*100:.1f}%")
    print(f"  WITH retrieval + code execution        : {with_ok}/{n} = {a1*100:.1f}%")

    ok = (a1 >= 0.80 and a0 <= 0.20 and a1 > a0 + 0.5)
    print(f"\nFARFORMULA {'PASS' if ok else 'FAIL'} — the far-generalization ceiling "
          f"({'is crossed by RETRIEVAL+EXECUTION' if ok else 'was not crossed'}: a formula the "
          f"model cannot know ({a0*100:.0f}%) becomes solvable ({a1*100:.0f}%) when the formula is "
          f"retrieved and run as code. You cannot distill the unknowable; you can retrieve and execute it.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
