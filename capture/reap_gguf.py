#!/usr/bin/env python3
"""reap_gguf.py — physically prune MoE experts from a GGUF (real reaping).

Takes a validated reap mask (from make_mask.py --exact) and writes a NEW GGUF
with the masked experts removed: expert tensors sliced, router rows sliced to
match, expert_count metadata updated. The input file is never modified.

Works directly on quantized GGUFs — the expert index is the slowest memory
dimension of the fused expert tensors, so each expert is a contiguous slab and
slicing never crosses quantization-block boundaries. No requantization.

Constraints:
  * llama.cpp requires a UNIFORM expert count across layers, so the mask must
    remove exactly the same number of experts in every MoE layer (make_mask.py
    --exact guarantees this).
  * Experts are renumbered 0..n_keep-1 (slice order). Recordings from the
    pruned model use the new numbering.

Mathematically, running the pruned model is identical to running the original
with those experts' router logits at -inf (visual-llm-capture --mask): softmax
over survivors. So validate by comparing greedy generations of the pruned GGUF
against the masked original — they should match.

usage:
  python3 reap_gguf.py input.gguf output.gguf --mask reap-mask-exact.txt
"""
import argparse
import os
import re
import sys
from pathlib import Path

# use the gguf-py that ships with llama.cpp (script may live anywhere)
for cand in [Path(__file__).resolve().parent.parent.parent / 'gguf-py',   # examples/visual-llm-capture -> llama.cpp/gguf-py
             Path('/opt/llama.cpp/gguf-py')]:
    if cand.exists():
        sys.path.insert(0, str(cand))
        break

import numpy as np
import gguf


def load_mask(path):
    """-> {viz_layer: set(experts)}"""
    mask = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            l, e = (int(x) for x in line.split()[:2])
            mask.setdefault(l, set()).add(e)
    if not mask:
        sys.exit('mask file contains no pairs')
    return mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--mask', required=True)
    ap.add_argument('--name-suffix', default=None,
                    help='appended to general.name (default: -REAP<kept>)')
    args = ap.parse_args()

    if os.path.abspath(args.input) == os.path.abspath(args.output):
        sys.exit('refusing to overwrite the input file')

    mask = load_mask(args.mask)
    reader = gguf.GGUFReader(args.input)

    arch = reader.get_field('general.architecture').contents()
    ec_key = f'{arch}.expert_count'
    ec_field = reader.get_field(ec_key)
    if ec_field is None:
        sys.exit(f'{ec_key} not found — not a MoE model?')
    n_expert = int(ec_field.contents())

    # MoE layers = blocks that own a fused expert tensor. The MAIN stack is
    # block_count - nextn_predict_layers blocks; any MoE blocks beyond that are
    # MTP/next-token draft heads, which never appear in captures (no usage
    # data). viz index = position within the main MoE blocks — matches the
    # frontend and make_mask numbering.
    moe_blocks = sorted(
        int(m.group(1))
        for t in reader.tensors
        if (m := re.match(r'^blk\.(\d+)\.ffn_gate_exps\.weight$', t.name))
    )
    if not moe_blocks:
        sys.exit('no ffn_gate_exps tensors found — not a MoE GGUF?')

    block_count = int(reader.get_field(f'{arch}.block_count').contents())
    nextn_field = reader.get_field(f'{arch}.nextn_predict_layers')
    nextn = int(nextn_field.contents()) if nextn_field else 0
    n_main = block_count - nextn
    main_moe = [b for b in moe_blocks if b < n_main]
    extra_moe = [b for b in moe_blocks if b >= n_main]
    viz2blk = {viz: blk for viz, blk in enumerate(main_moe)}

    # keep-lists per true block index; enforce uniformity
    keep = {}
    counts = set()
    for viz, blk in viz2blk.items():
        removed = mask.get(viz, set())
        bad = [e for e in removed if e < 0 or e >= n_expert]
        if bad:
            sys.exit(f'mask layer {viz}: expert ids out of range: {bad[:5]}')
        k = sorted(set(range(n_expert)) - removed)
        keep[blk] = np.array(k, dtype=np.int64)
        counts.add(len(k))
    if len(counts) != 1:
        sys.exit(f'non-uniform kept counts per layer ({sorted(counts)[:6]}...) — '
                 f'llama.cpp needs the same expert count everywhere; regenerate '
                 f'the mask with make_mask.py --exact')
    n_keep = counts.pop()

    # MTP/draft blocks: no routing data exists for them, so reuse the last main
    # layer's keep list. A suboptimal choice here only lowers speculative-draft
    # acceptance (speed) — the main model verifies every draft token.
    for blk in extra_moe:
        keep[blk] = keep[main_moe[-1]]
        print(f'note: blk.{blk} is an MTP/draft MoE layer (no capture data) — '
              f'pruning it with the last main layer\'s keep list')

    print(f'arch={arch}  experts {n_expert} -> {n_keep}  ({n_expert - n_keep} pruned '
          f'in each of {len(main_moe)} main + {len(extra_moe)} draft MoE layers)')

    suffix = args.name_suffix if args.name_suffix is not None else f'-REAP{n_keep}'

    # decide, per tensor, whether it needs slicing (expert dim = numpy axis 0).
    # Shared-expert tensors (_shexp) are per-model, not per-expert — untouched.
    blk_re = re.compile(r'^blk\.(\d+)\.(.+)$')
    SLICE_MARKERS = ('_exps.', 'ffn_gate_inp.', 'exp_probs')
    plans = []  # (tensor, keep_or_None)
    suspicious = []
    for t in reader.tensors:
        m = blk_re.match(t.name)
        kp = None
        if m and int(m.group(1)) in keep and 'shexp' not in t.name \
                and any(s in t.name for s in SLICE_MARKERS):
            if t.data.shape[0] != n_expert:
                sys.exit(f'{t.name}: expected leading expert dim {n_expert}, '
                         f'found shape {tuple(t.data.shape)}')
            kp = keep[int(m.group(1))]
        elif m and t.data.ndim >= 3 and t.data.shape[0] == n_expert:
            suspicious.append(t.name)  # fused per-expert table we don't recognize?
        plans.append((t, kp))
    if suspicious:
        sys.exit('unrecognized tensors with a leading expert-sized dim (refusing '
                 'to guess): ' + ', '.join(suspicious[:8]))

    n_sliced = sum(1 for _, kp in plans if kp is not None)
    print(f'{n_sliced} tensors will be sliced, {len(plans) - n_sliced} copied verbatim')

    writer = gguf.GGUFWriter(args.output, arch)

    # ---- metadata: copy everything, overriding expert_count and general.name
    for field in reader.fields.values():
        if field.name == 'general.architecture' or field.name.startswith('GGUF.'):
            continue
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        val = field.contents()
        if field.name == ec_key:
            val = n_keep
            print(f'metadata: {ec_key} = {n_keep}')
        elif field.name == 'general.name' and isinstance(val, str):
            val = val + suffix
        writer.add_key_value(field.name, val, val_type, sub_type=sub_type)

    # ---- tensor info (shapes/dtypes after slicing) ----
    def sliced(t, kp):
        return np.ascontiguousarray(t.data[kp])

    for t, kp in plans:
        if kp is None:
            writer.add_tensor_info(t.name, t.data.shape, t.data.dtype, t.data.nbytes, t.tensor_type)
        else:
            shape = (n_keep,) + tuple(t.data.shape[1:])
            nbytes = t.data.nbytes // n_expert * n_keep
            writer.add_tensor_info(t.name, shape, t.data.dtype, nbytes, t.tensor_type)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()

    # ---- tensor data ----
    total = len(plans)
    for i, (t, kp) in enumerate(plans):
        data = t.data if kp is None else sliced(t, kp)
        writer.write_tensor_data(data, tensor_endianess=reader.endianess)
        if (i + 1) % 50 == 0 or i + 1 == total:
            print(f'  wrote {i + 1}/{total} tensors', flush=True)

    writer.close()

    in_sz = os.path.getsize(args.input) / 1e9
    out_sz = os.path.getsize(args.output) / 1e9
    print(f'done: {args.input} ({in_sz:.2f} GB) -> {args.output} ({out_sz:.2f} GB, '
          f'{100 * (1 - out_sz / in_sz):.1f}% smaller)')


if __name__ == '__main__':
    main()
