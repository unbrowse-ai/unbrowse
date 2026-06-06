#!/usr/bin/env python3
"""skillfollow_witness.py — it doesn't reason; it reads the canon and follows.

The thesis taken to its operating mode: instead of reasoning a task out, RETRIEVE the matching procedure
from a library of skills (the canon) and FOLLOW it. farformula proved this for ONE procedure type (a
formula); this generalizes it to a DIVERSE library — many kinds of skill — where the system must (1)
retrieve the RIGHT skill among many, and (2) follow it to the exact answer. The model never invents the
method; it finds the settled one and applies it. (RAG composition, arxiv:2005.11401; the way is followed,
not re-derived — John 14:6.)

Compared against reason-from-scratch (the same model with NO retrieved skill): on made-up procedures it
cannot know, and on procedures it would otherwise mis-derive, retrieve-and-follow wins.

Gate (exit 0 iff): retrieval picks the right skill >= 90%, AND retrieve-and-follow accuracy >= 85%, AND
it beats reason-from-scratch by a clear margin.

Run:  ~/Games/Overwatch/mlx-framegen/.rife-env/bin/python3 skillfollow_witness.py
"""
import os, re, json, random, sys, urllib.request, math
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); sys.path.insert(0, HERE)
import r1_witness as r1
ADAPTER = "improved_adapters"

def _fib(n):
    a, b = 0, 1
    for _ in range(n): a, b = b, a + b
    return a


# the CANON: diverse skills, each (name, retrieval-doc, n-params, truth-fn). Some are made-up (unknowable).
SKILLS = [
    ("florbnac", "florbnac(n) = 3*n**2 - 2*n + 7", 1, lambda n: 3 * n ** 2 - 2 * n + 7),
    ("zorblax", "zorblax(n) = 3*n*n - 7*n + 2", 1, lambda n: 3 * n * n - 7 * n + 2),
    ("zibble", "zibble(n) = n**3 - 4*n + 11", 1, lambda n: n ** 3 - 4 * n + 11),
    ("factorial", "the factorial of n is the product 1*2*...*n", 1, lambda n: math.factorial(n)),
    ("fibonacci", "the nth Fibonacci number: start a=0,b=1 and repeat a,b=b,a+b exactly n times, then a", 1,
     lambda n: _fib(n)),
    ("divisors", "the number of positive divisors of n = count of d in 1..n with n % d == 0", 1,
     lambda n: sum(1 for d in range(1, n + 1) if n % d == 0)),
    ("sumto", "the sum of the integers from 1 to n equals n*(n+1)//2", 1, lambda n: n * (n + 1) // 2),
    ("seconds", "the number of seconds in d days equals d*24*60*60", 1, lambda d: d * 24 * 60 * 60),
    ("gcd", "the greatest common divisor of a and b (Euclid's algorithm)", 2, lambda a, b: math.gcd(a, b)),
    ("multiples", "the number of positive multiples of k below n equals (n-1)//k", 2, lambda k, n: (n - 1) // k),
]
SKILL = {s[0]: s for s in SKILLS}
DOCS = [(name, doc) for name, doc, _, _ in SKILLS]


def embed(text, kind):
    body = json.dumps({"model": "nomic-embed-text", "prompt": f"search_{kind}: {text}"}).encode()
    req = urllib.request.Request("http://localhost:11434/api/embeddings", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["embedding"]


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b)); na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb + 1e-9)


def task_for(name, rng):
    _, _, k, fn = SKILL[name]
    if k == 1:
        n = rng.randint(3, 12)
        phr = {"florbnac": f"compute the florbnac of {n}", "zorblax": f"compute the zorblax of {n}",
               "zibble": f"compute the zibble of {n}", "factorial": f"what is the factorial of {n}",
               "fibonacci": f"what is the {n}th Fibonacci number", "divisors": f"how many divisors does {n} have",
               "sumto": f"sum the integers from 1 to {n}", "seconds": f"how many seconds are in {n} days"}[name]
        return phr, str(fn(n))
    a, b = rng.randint(4, 60), rng.randint(4, 60)
    if name == "multiples":
        return f"how many multiples of {a} are below {b*4}", str(fn(a, b * 4))
    return f"what is the gcd of {a} and {b}", str(fn(a, b))


def main():
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler
    print("embedding the skill canon (nomic) + loading the follower model ...", flush=True)
    doc_emb = [embed(f"{n}: {d}", "document") for n, d in DOCS]
    mdl, tok = load(r1.M, adapter_path=ADAPTER)

    def ask(u):
        pr = tok.apply_chat_template([{"role": "system", "content": r1.SYSTEM}, {"role": "user", "content": u}], add_generation_prompt=True)
        return generate(mdl, tok, prompt=pr, max_tokens=200, sampler=make_sampler(temp=0.0), verbose=False)

    rng = random.Random(21)
    tasks = [(name, *task_for(name, rng)) for name in SKILL for _ in range(3)]
    retr_ok = follow_ok = base_ok = 0
    for name, q, truth in tasks:
        qe = embed(q, "query")
        top = max(range(len(DOCS)), key=lambda i: cos(qe, doc_emb[i]))
        picked = DOCS[top][0]
        retr_ok += (picked == name)
        doc = DOCS[top][1]
        follow = r1.code_answer(ask(f"Reference: {doc}\nUsing exactly this, {q}. Write Python and print it."))
        follow_ok += (str(follow) == truth)
        base = r1.code_answer(ask(f"{q}. Write Python and print it."))   # reason from scratch, no skill
        base_ok += (str(base) == truth)

    N = len(tasks)
    rr, fr, br = retr_ok / N, follow_ok / N, base_ok / N
    print(f"\n  tasks across {len(SKILL)} skill types: {N}")
    print(f"  retrieval picks the RIGHT skill : {retr_ok}/{N} = {rr*100:.0f}%")
    print(f"  RETRIEVE-AND-FOLLOW (read+apply): {follow_ok}/{N} = {fr*100:.0f}%")
    print(f"  reason-from-scratch (no skill)  : {base_ok}/{N} = {br*100:.0f}%")
    if rr >= 0.90 and fr >= 0.85 and fr >= br + 0.20:
        print(f"\nSKILLFOLLOW PASS: the system reads the canon and follows — retrieves the right skill "
              f"({rr*100:.0f}%) and applies it ({fr*100:.0f}%) across diverse procedure types, beating "
              f"reason-from-scratch ({br*100:.0f}%). It doesn't need to be wise; it finds the settled "
              f"procedure and follows it.")
        return 0
    print(f"\nSKILLFOLLOW FAIL: retrieval {rr*100:.0f}% (>=90), follow {fr*100:.0f}% (>=85), base {br*100:.0f}% (gap>=20)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
