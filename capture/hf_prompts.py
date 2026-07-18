#!/usr/bin/env python3
"""hf_prompts.py — dump a Hugging Face dataset column into a prompt set
directory usable with `visual-llm-capture --prompts-dir`.

usage:
  pip install datasets
  python hf_prompts.py <dataset> [--config c] [--split train] [--column prompt]
                       [--limit 200] [--max-chars 4000] -o prompts/my-set
"""
import argparse
import os
import re
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--config", default=None)
    ap.add_argument("--split", default="train")
    ap.add_argument("--column", default=None, help="auto-detects prompt/text/question/instruction")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--max-chars", type=int, default=4000)
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    try:
        from datasets import load_dataset
    except ImportError:
        sys.exit("pip install datasets")

    ds = load_dataset(args.dataset, args.config, split=args.split, streaming=True)
    column = args.column
    os.makedirs(args.out, exist_ok=True)

    n = 0
    for row in ds:
        if column is None:
            for cand in ("prompt", "text", "question", "instruction", "input"):
                if cand in row and isinstance(row[cand], str):
                    column = cand
                    break
            if column is None:
                sys.exit(f"no obvious prompt column; available: {list(row.keys())} — pass --column")
            print(f"using column: {column}")
        text = row.get(column)
        if not isinstance(text, str) or not text.strip():
            continue
        text = text.strip()[: args.max_chars]
        slug = re.sub(r"[^a-z0-9]+", "-", text[:40].lower()).strip("-") or "prompt"
        path = os.path.join(args.out, f"{n:04d}-{slug}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        n += 1
        if n >= args.limit:
            break

    print(f"wrote {n} prompts to {args.out}")


if __name__ == "__main__":
    main()
