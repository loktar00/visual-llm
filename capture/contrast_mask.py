#!/usr/bin/env python3
"""contrast_mask.py — contrastive reap mask: cut experts that are HOT under an
anti-domain corpus AND COLD under the target corpus.

Rationale: an expert that is quiet in your domain but demonstrably busy
elsewhere is specialized elsewhere — strong evidence it is safe to remove for
a domain build. An expert quiet under BOTH corpora may be rare-but-critical
glue (recovery circuits, long-tail handling); pure cold-ranking cuts those,
this tool deliberately spares them.

usage:
  python3 contrast_mask.py 'target/run-*.jsonl' 'anti/run-*.jsonl' \
      --frac 0.375 --cold-pool 0.5 -o contrast-mask.txt
"""
import argparse, glob, json, sys
from collections import defaultdict

def aggregate(patterns):
    usage = defaultdict(float)
    n_layers = n_experts = 0
    files = []
    for pat in patterns.split(';'):
        files += sorted(glob.glob(pat))
    if not files:
        sys.exit(f'no files match {patterns}')
    for path in files:
        for line in open(path, encoding='utf-8', errors='replace'):
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get('type') == 'meta':
                m = ev.get('model', {})
                n_layers = max(n_layers, int(m.get('n_layers', 0)))
                n_experts = max(n_experts, int(m.get('n_experts', 0)))
            elif ev.get('type') == 'moe':
                l = int(ev['layer'])
                for e, w in zip(ev['experts'], ev['weights']):
                    usage[(l, int(e))] += float(w)
    return usage, n_layers, n_experts, len(files)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target')
    ap.add_argument('anti')
    ap.add_argument('--frac', type=float, default=0.25,
                    help='fraction of each layer to cut (uniform, exact)')
    ap.add_argument('--cold-pool', type=float, default=0.5,
                    help='candidates = this coldest fraction under the target')
    ap.add_argument('-o', '--out', default='contrast-mask.txt')
    args = ap.parse_args()

    ut, nl, ne, nft = aggregate(args.target)
    ua, nl2, ne2, nfa = aggregate(args.anti)
    nl, ne = max(nl, nl2), max(ne, ne2)
    print(f'target: {nft} recordings; anti: {nfa} recordings; {nl} layers x {ne} experts')

    tot_t = sum(ut.values()) or 1.0
    tot_a = sum(ua.values()) or 1.0

    k = int(ne * args.frac)
    pool_n = max(k, int(ne * args.cold_pool))
    masked, cold_ref = [], []
    cut_t_mass = cut_a_mass = 0.0
    for l in range(nl):
        by_cold = sorted(range(ne), key=lambda e: ut.get((l, e), 0.0))
        cold_ref += [(l, e) for e in by_cold[:k]]
        pool = by_cold[:pool_n]
        chosen = sorted(pool, key=lambda e: ua.get((l, e), 0.0), reverse=True)[:k]
        for e in chosen:
            masked.append((l, e))
            cut_t_mass += ut.get((l, e), 0.0)
            cut_a_mass += ua.get((l, e), 0.0)

    overlap = len(set(masked) & set(cold_ref))
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(f'# contrastive reap mask — frac={args.frac} cold_pool={args.cold_pool}\n')
        f.write(f'# cut target-mass {100*cut_t_mass/tot_t:.2f}% | cut anti-mass {100*cut_a_mass/tot_a:.2f}%\n')
        f.write('# layer expert\n')
        for l, e in sorted(masked):
            f.write(f'{l} {e}\n')

    print(f'{args.out}: {len(masked)} experts ({k}/layer x {nl} layers)')
    print(f'cut mass: {100*cut_t_mass/tot_t:.2f}% of TARGET, {100*cut_a_mass/tot_a:.2f}% of ANTI')
    print(f'overlap with pure-cold mask at same depth: {100*overlap/max(1,len(masked)):.1f}%')

    # corpus-level overlap diagnostics: hot-half sharing
    def hot_half(u):
        per = defaultdict(dict)
        for (l, e), w in u.items():
            per[l][e] = w
        s = set()
        for l, d in per.items():
            s.update((l, e) for e in sorted(d, key=d.get, reverse=True)[:ne // 2])
        return s
    ht, ha = hot_half(ut), hot_half(ua)
    print(f'hot-half overlap target vs anti: {100*len(ht & ha)/max(1,len(ht)):.1f}% '
          f'(shared infrastructure measure)')

if __name__ == '__main__':
    main()
