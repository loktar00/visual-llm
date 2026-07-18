#!/usr/bin/env python3
"""reap_hf.py — physically prune MoE experts from a Hugging Face safetensors
checkpoint (the finetune-ready sibling of reap_gguf.py).

Takes a reap mask (make_mask.py --exact: uniform count per layer) and writes a
NEW model directory with masked experts sliced out of the fused expert tensors,
router rows sliced to match, and config num_experts updated. Input untouched.

Works on raw bytes: the expert index is axis 0 of the fused tensors, so each
expert is a contiguous slab regardless of dtype (bf16/fp8/anything). No torch,
no RAM to speak of — tensors stream through slab by slab.

Layout support (auto-verified): fused expert tensors named
  <prefix>.layers.{i}.mlp.experts.gate_up_proj / .down_proj   [n_exp, ...]
  <prefix>.layers.{i}.mlp.gate.weight                          [n_exp, hidden]
Main-stack layers map 1:1 to the mask's viz layer indices; extra MTP/draft
stacks (e.g. mtp.layers.*) are pruned with the last main layer's keep list,
same rationale as reap_gguf.py. Shared-expert tensors are untouched.

usage:
  python3 reap_hf.py <src_model_dir> <out_dir> --mask canvas-mask-exact.txt
"""
import argparse
import json
import os
import re
import shutil
import struct
import sys

CHUNK = 16 * 1024 * 1024

EXPERT_RE = re.compile(
    r"^(?P<stack>.*?)\.layers\.(?P<layer>\d+)\.mlp\.(?:experts\.(?:gate_up_proj|down_proj)|gate\.weight)$"
)


def load_mask(path):
    mask = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            l, e = (int(x) for x in line.split()[:2])
            mask.setdefault(l, set()).add(e)
    if not mask:
        sys.exit("mask file contains no pairs")
    return mask


def read_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        return json.loads(f.read(n)), 8 + n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--mask", required=True)
    args = ap.parse_args()
    src, out = args.src.rstrip("/\\"), args.out.rstrip("/\\")
    if os.path.abspath(src) == os.path.abspath(out):
        sys.exit("refusing to overwrite the input model")

    cfg = json.load(open(os.path.join(src, "config.json")))
    tcfg = cfg.get("text_config", cfg)
    n_expert = int(tcfg["num_experts"])
    n_layers = int(tcfg["num_hidden_layers"])

    mask = load_mask(args.mask)
    if set(mask) - set(range(n_layers)):
        sys.exit(f"mask layers exceed num_hidden_layers={n_layers}")
    keep, counts = {}, set()
    for l in range(n_layers):
        bad = [e for e in mask.get(l, set()) if e < 0 or e >= n_expert]
        if bad:
            sys.exit(f"mask layer {l}: expert ids out of range: {bad[:5]}")
        k = sorted(set(range(n_expert)) - mask.get(l, set()))
        keep[l] = k
        counts.add(len(k))
    if len(counts) != 1:
        sys.exit(f"non-uniform kept counts ({sorted(counts)[:6]}) — regenerate with make_mask.py --exact")
    n_keep = counts.pop()
    print(f"experts {n_expert} -> {n_keep} across {n_layers} layers")

    idx_path = os.path.join(src, "model.safetensors.index.json")
    idx = json.load(open(idx_path))
    wm = idx["weight_map"]

    # identify the main stack (the one with num_hidden_layers MoE layers);
    # every other stack with expert tensors (MTP) uses the last layer's keep
    stacks = {}
    for key in wm:
        m = EXPERT_RE.match(key)
        if m:
            stacks.setdefault(m.group("stack"), set()).add(int(m.group("layer")))
    if not stacks:
        sys.exit("no fused expert tensors found — unsupported layout or not MoE")
    main_stack = max(stacks, key=lambda s: len(stacks[s]))
    if len(stacks[main_stack]) != n_layers:
        sys.exit(f"main stack {main_stack} has {len(stacks[main_stack])} MoE layers, expected {n_layers}")
    for s, layers in stacks.items():
        note = "main" if s == main_stack else "extra (pruned with last main layer's keep list)"
        print(f"stack {s}: {len(layers)} MoE layers [{note}]")

    def keep_for(key):
        m = EXPERT_RE.match(key)
        if not m:
            return None
        l = int(m.group("layer"))
        return keep[l] if m.group("stack") == main_stack else keep[n_layers - 1]

    os.makedirs(out, exist_ok=True)
    shards = sorted(set(wm.values()))
    total_out = 0
    total_tensor_bytes = 0
    n_sliced = 0

    for si, shard in enumerate(shards):
        header, data_start = read_header(os.path.join(src, shard))
        meta = header.pop("__metadata__", None)
        order = sorted(header.items(), key=lambda kv: kv[1]["data_offsets"][0])

        new_header, off = {}, 0
        for key, h in order:
            size = h["data_offsets"][1] - h["data_offsets"][0]
            kp = keep_for(key)
            if kp is not None:
                if h["shape"][0] != n_expert:
                    sys.exit(f"{key}: expected leading dim {n_expert}, found {h['shape']}")
                size = size // n_expert * n_keep
                shape = [n_keep] + list(h["shape"][1:])
            else:
                if len(h["shape"]) >= 2 and h["shape"][0] == n_expert and ".mlp." in key \
                        and "shared_expert" not in key:
                    sys.exit(f"{key}: unrecognized expert-sized tensor — refusing to guess")
                shape = h["shape"]
            new_header[key] = {"dtype": h["dtype"], "shape": shape, "data_offsets": [off, off + size]}
            off += size
        if meta is not None:
            new_header["__metadata__"] = meta

        total_tensor_bytes += off
        hbytes = json.dumps(new_header, separators=(",", ":")).encode()
        pad = (-len(hbytes)) % 8
        hbytes += b" " * pad

        with open(os.path.join(src, shard), "rb") as fin, \
             open(os.path.join(out, shard), "wb") as fout:
            fout.write(struct.pack("<Q", len(hbytes)))
            fout.write(hbytes)
            for key, h in order:
                begin, end = h["data_offsets"]
                kp = keep_for(key)
                if kp is None:
                    fin.seek(data_start + begin)
                    left = end - begin
                    while left:
                        buf = fin.read(min(CHUNK, left))
                        fout.write(buf)
                        left -= len(buf)
                else:
                    n_sliced += 1
                    slab = (end - begin) // n_expert
                    for e in kp:
                        fin.seek(data_start + begin + e * slab)
                        left = slab
                        while left:
                            buf = fin.read(min(CHUNK, left))
                            fout.write(buf)
                            left -= len(buf)
        total_out += os.path.getsize(os.path.join(out, shard))
        print(f"  shard {si + 1}/{len(shards)} done", flush=True)

    # index: same weight map, recomputed size
    idx_out = {"metadata": {"total_size": total_tensor_bytes}, "weight_map": wm}
    json.dump(idx_out, open(os.path.join(out, "model.safetensors.index.json"), "w"), indent=2)

    # config: patch expert count (nested text_config or flat)
    if "text_config" in cfg:
        cfg["text_config"]["num_experts"] = n_keep
    else:
        cfg["num_experts"] = n_keep
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=2)

    # everything else (tokenizer, templates, preprocessor, generation config)
    for fn in os.listdir(src):
        if fn.endswith(".safetensors") or fn in ("config.json", "model.safetensors.index.json"):
            continue
        p = os.path.join(src, fn)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(out, fn))

    in_sz = sum(os.path.getsize(os.path.join(src, s)) for s in shards) / 1e9
    print(f"done: {n_sliced} tensors sliced; weights {in_sz:.1f} GB -> {total_out / 1e9:.1f} GB "
          f"({100 * (1 - total_out / 1e9 / in_sz):.1f}% smaller)")


if __name__ == "__main__":
    main()
