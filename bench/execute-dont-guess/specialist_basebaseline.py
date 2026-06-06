"""specialist_basebaseline.py — resolve the open 50->92 flag with a REAL number.

The hard-reasoning row reports r1 (a TRAINED specialist) 50% -> unified_v2 92%. The open
question (flagged ‡ in the paper): does the RAW BASE model beat r1's 50% on the hard
families? If raw base < 50%, the r1 baseline is conservative and 50->92 does NOT overclaim
(unlike codebench, where the trained baseline was weaker than raw base). We measure, not assume.

Single eval pass: load the base model (no adapter), run the hard families (nck, lcm) held-out,
score by executing the model's code (the real verifier). No training, in-process — no orphans.
"""
import sys, random
import r1_witness as r1
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

M = r1.M
SYSTEM = r1.SYSTEM
fams = r1.families()
HARD = ["nck", "lcm"]  # the specialist 50->92 hard families (HARD_RULES in specialist_witness)


def gen(model, tok, q):
    pr = tok.apply_chat_template(
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
        add_generation_prompt=True)
    return generate(model, tok, prompt=pr, max_tokens=200, sampler=make_sampler(temp=0.0), verbose=False)


def main():
    n_per = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    held = [(name, fams[name](random.Random(1300 + i))) for name in HARD for i in range(n_per)]
    print(f"loading RAW BASE {M} (no adapter) ...", flush=True)
    model, tok = load(M)
    correct, by = 0, {}
    for name, (q, truth) in held:
        ok = (r1.code_answer(gen(model, tok, q)) == str(truth))
        correct += ok
        by.setdefault(name, [0, 0]); by[name][0] += ok; by[name][1] += 1
    acc = correct / len(held)
    print(f"\nRAW BASE on hard families (nck,lcm): {correct}/{len(held)} = {acc*100:.1f}%")
    for k, (c, t) in by.items():
        print(f"  {k}: {c}/{t}")
    print("\nr1 (trained specialist) baseline on these = 50%; unified_v2 = 92%.")
    if acc < 0.5:
        print(f"VERDICT: raw base {acc*100:.1f}% < 50% -> the r1 baseline is CONSERVATIVE; "
              f"the raw-base -> unified lift is LARGER than 50->92, so 50->92 does NOT overclaim. ✅")
    else:
        print(f"VERDICT: raw base {acc*100:.1f}% >= 50% -> INFLATED-RISK; raw base already matches/beats "
              f"the r1 baseline, so 50->92 overstates the raw-base capability gain (like codebench). ⚠")


main()
