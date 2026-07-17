#!/usr/bin/env python3
"""make_mask.py — aggregate visual-llm recordings into a reap mask.

Sums router gate weight per (layer, expert) across every recording given —
this is the same router-weighted saliency signal REAP-style pruning uses (we
have gate weights, not activation norms, so it's the routing half of that
score). Within each layer, the coldest experts are masked.

usage:
  python make_mask.py runs/*.jsonl -o reap-mask.txt
  python make_mask.py runs/*.jsonl --frac 0.25 --guard 0.6

  --frac   fraction of each layer's experts to mask (default 0.25)
  --guard  only mask experts whose mass is below this fraction of the layer
           mean — protects layers where usage is genuinely uniform (default 0.6)

Feed the result to:  visual-llm-capture --mask reap-mask.txt ...
"""
import argparse
import glob
import json
import sys
from collections import defaultdict

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="recording .jsonl files (globs ok)")
    ap.add_argument("--frac", type=float, default=0.25)
    ap.add_argument("--guard", type=float, default=0.6)
    ap.add_argument("--exact", action="store_true",
                    help="mask exactly floor(frac*n) experts in EVERY layer, ignoring "
                         "the guard (required for physical GGUF pruning, which needs a "
                         "uniform expert count across layers)")
    ap.add_argument("-o", "--out", default="reap-mask.txt")
    args = ap.parse_args()

    paths = []
    for pat in args.files:
        hits = sorted(glob.glob(pat))
        paths.extend(hits if hits else [pat])
    if not paths:
        sys.exit("no input files")

    usage = defaultdict(float)  # (layer, expert) -> summed gate weight
    n_layers = n_experts = n_tokens = 0
    model_name = "?"
    pre_removed = set()  # experts already pruned in the inputs (don't re-mask)

    for path in paths:
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError as e:
            sys.exit(f"cannot open {path}: {e}")
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = ev.get("type")
                if t == "meta":
                    m = ev.get("model", {})
                    n_layers = max(n_layers, int(m.get("n_layers", 0)))
                    n_experts = max(n_experts, int(m.get("n_experts", 0)))
                    model_name = m.get("name", model_name)
                    for pair in ev.get("removed_experts", []) or []:
                        pre_removed.add((int(pair[0]), int(pair[1])))
                elif t == "token":
                    n_tokens += 1
                elif t == "moe":
                    l = int(ev["layer"])
                    for e, w in zip(ev["experts"], ev["weights"]):
                        usage[(l, int(e))] += float(w)

    if not usage:
        sys.exit("no moe events found in the inputs")
    if not n_layers:
        n_layers = max(l for l, _ in usage) + 1
    if not n_experts:
        n_experts = max(e for _, e in usage) + 1

    total_mass = sum(usage.values())
    masked = []
    masked_mass = 0.0
    for l in range(n_layers):
        live = [e for e in range(n_experts) if (l, e) not in pre_removed]
        if not live:
            continue
        mass = {e: usage.get((l, e), 0.0) for e in live}
        mean = sum(mass.values()) / len(live)
        ranked = sorted(live, key=lambda e: mass[e])
        k = max(1, int(len(live) * args.frac))
        for e in ranked[:k]:
            if not args.exact and mean > 0 and mass[e] > mean * args.guard:
                break  # rest of this layer is too warm to call cold
            masked.append((l, e))
            masked_mass += mass[e]

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(f"# visual-llm reap mask — {model_name}\n")
        f.write(f"# aggregated from {len(paths)} recording(s), {n_tokens} tokens\n")
        f.write(f"# frac={args.frac} guard={args.guard} -> {len(masked)} of "
                f"{n_layers * n_experts} experts masked\n")
        f.write(f"# masked share of total routed weight mass: "
                f"{100.0 * masked_mass / total_mass:.2f}%\n")
        f.write("# layer expert\n")
        for l, e in masked:
            f.write(f"{l} {e}\n")

    per_layer = defaultdict(int)
    for l, _ in masked:
        per_layer[l] += 1
    lo = min(per_layer.values()) if per_layer else 0
    hi = max(per_layer.values()) if per_layer else 0
    print(f"{args.out}: {len(masked)} experts masked "
          f"({lo}-{hi} per layer across {len(per_layer)} layers)")
    print(f"masked experts carried {100.0 * masked_mass / total_mass:.2f}% "
          f"of the total routed weight mass — lower is safer to reap")

if __name__ == "__main__":
    main()
