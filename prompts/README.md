# Prompt sets

A **prompt set is just a directory**: one prompt per file (`.md` or `.txt`),
YAML frontmatter (`--- ... ---`) stripped automatically, recordings named
after the files. Run a whole set against a model with:

```bash
visual-llm-capture -m model.gguf --prompts-dir prompts/canvas-js \
  -n 400 -ngl 99 -o runs/canvas.jsonl
# -> runs/canvas-aquarium.jsonl, runs/canvas-boids-murmuration.jsonl, ...
```

Then aggregate the whole set into a reap mask:

```bash
python capture/make_mask.py 'runs/canvas-*.jsonl' -o canvas-mask.txt
```

## Why directories (and not a database)

Categories are directories (`prompts/canvas-js/`, `prompts/agentic/`,
`prompts/writing/`), a prompt is a file you can open in any editor, the whole
set diffs cleanly in git, and `--prompts-dir` needs zero dependencies. A
SQLite layer would add tooling between you and your prompts without adding a
capability — tags beyond the directory level can live in the frontmatter,
which the capture tool already skips and your other tools can read. If a set
ever outgrows this (thousands of prompts, many-to-many tags), revisit then.

## Hugging Face datasets

`capture/hf_prompts.py` dumps any HF dataset column into a prompt set:

```bash
pip install datasets
python capture/hf_prompts.py HuggingFaceH4/no_robots --column prompt \
  --limit 200 -o prompts/no-robots
```

## Included set: `canvas-js/`

36 prompts for self-contained JavaScript Canvas demos (screensavers, physics
toys, autonomous sims) — a domain-calibration example. Pair it with your own
prompts in the same style; ~60–100 diverse prompts is plenty to separate hot
experts from cold on a 256-expert model.
