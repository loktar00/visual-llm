# visual-llm-capture — real recordings from llama.cpp

A ~350-line C++ tool that runs a generation with llama.cpp, taps the router
through the **eval callback** (`llama_context_params.cb_eval`), and writes a
JSONL recording (`../SCHEMA.md`) the frontend loads by **drag-and-drop**.

No llama.cpp fork, no patches — the eval callback is a supported hook (it's
how the built-in `imatrix` tool collects activation statistics). The MoE
routing tensors are read by name: `ffn_moe_topk-<layer>` (chosen experts) and
`ffn_moe_weights[_norm]-<layer>` (gate weights); the expert count is snooped
from the shape of `ffn_moe_logits`. Only a few hundred bytes per layer per
token cross the PCIe bus, but observing every graph node does disable some
backend fusion — expect roughly 60–80% of normal generation speed. Irrelevant
for capture-then-replay.

## Build (on the server that runs llama.cpp)

```bash
# from your llama.cpp checkout
cp -r /path/to/visual-llm/capture llama.cpp/examples/visual-llm-capture
echo 'add_subdirectory(visual-llm-capture)' >> llama.cpp/examples/CMakeLists.txt

# rebuild with the same flags as your normal build, e.g.:
cmake -B build -DGGML_CUDA=ON
cmake --build build --target visual-llm-capture -j
```

Newer llama.cpp checkouts keep example programs under `tools/` instead of
`examples/` — drop the folder wherever the peer programs (`main`, `imatrix`)
live and append the same `add_subdirectory` line to that directory's
CMakeLists.

## Run

```bash
./build/bin/visual-llm-capture \
  -m models/gpt-oss-20b-Q4_K_M.gguf \
  -p "The lighthouse keeper kept a second logbook, and in it" \
  -n 300 -ngl 99 -o lighthouse.jsonl
```

Generation streams to stderr so you can watch it; the recording is written at
the end. Flags: `-c` context, `--temp/--top-k/--top-p/--seed` sampling.

Then get the file to the machine running the frontend (`scp`, network share)
and **drag it onto `index.html`** — it appears in the recording selector with
real layer/expert counts, and every style, the heat, the reap lens, and the
token labels work on it unchanged.

VRAM note: this loads its own copy of the model — stop `llama-server` first
if the GPU is tight.

**Models bigger than your VRAM** (e.g. a 200GB+ MoE on a multi-GPU rig):
`--n-cpu-moe N` keeps the first N blocks' fused expert tensors in system RAM
(llama-server parity), and `--ot-cpu <regex>` pins any tensor pattern to RAM —
use the regex form to spread offloaded blocks **evenly** (e.g.
`blk\.(3|5|7|…)\.ffn_(up|down|gate)_exps`), because offloading a contiguous
prefix makes the remaining expert-heavy layers pile onto one GPU and OOM.
Routing capture works unchanged: the `ffn_moe_*` probe tensors are tiny and
live wherever the graph puts them. Mask determination is quant-independent,
so capture on your smallest quant and apply the mask to any larger one.

## Server mode — capture every prompt via llama-swap

Instead of running the CLI per prompt, run the tool as an OpenAI-compatible
server. Point any chat UI / eval harness at it and it records the routing of
**every request** into `--capture-dir`, one JSONL per request.

```bash
visual-llm-capture -m model.gguf --server --port 8081 \
  -ngl 99 -c 32000 --capture-dir /mnt/share/captures \
  --alias Qwen3.6-35B-A3B-tracking
```

Endpoints: `POST /v1/chat/completions` (applies the model's chat template),
`POST /v1/completions` (raw prompt), `GET /v1/models` + `GET /health` (health
checks), `GET /captures` + `GET /captures/<name>` (recording browser for the
frontend's `s` panel; one subdirectory level is listed too, so a corpus
captured into `captures/canvas/` shows up as `canvas/run-…` entries),
`GET`/`POST /mask` (read or replace the reap mask at
runtime — `{"pairs": [[layer, expert], …]}`, empty list clears; the frontend's
mask editor uses this for its *apply to server* button), and `POST /reap` +
`GET /reap` (run `reap_gguf.py` on the loaded model asynchronously and poll
its log — the frontend's *reap gguf* button; pass `--reap-script` so the
server can find the script; refuses sharded models and never overwrites).
`POST /reap` takes either `{"pairs": […]}` — a hand-picked mask — or
`{"set": "canvas", "frac": 0.25}`, which first aggregates router mass across
every recording in that capture subdirectory with `make_mask.py --exact`
(expected beside the reap script) and then reaps: the **one-click corpus
reap** behind the frontend's *mask from* selector. Streaming (`stream:true`, SSE) and non-streaming both work. Requests
are serialized (one generation at a time) so routing attribution stays clean;
each request clears the KV cache and re-reads the full conversation, so every
capture is a complete, self-contained recording of that turn. `--mask` works
here too — a masked server is a live as-if-reaped model.

### As a llama-swap upstream (a "tracking" model)

Add a model entry whose `cmd` launches the capture server on `${PORT}` with
`checkEndpoint: "/v1/models"`. It then appears alongside your normal models;
select it in your chat tool and recordings accumulate. Example entry:

```yaml
  "Qwen3.6-35B-A3B-tracking":
    cmd: |
      /opt/llama.cpp/build-capture-cuda/bin/visual-llm-capture
      --server
      --port ${PORT}
      -m ${models_dir}/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf
      -ngl 99
      -c 32000
      --capture-dir /mnt/share/captures
      --alias Qwen3.6-35B-A3B-tracking
      --jinja
      --chat-template-kwargs '{"preserve_thinking": true}'
      --temp 0.6
      --top-p 0.95
      --top-k 20
    env:
      - "CUDA_VISIBLE_DEVICES=0,1,2,3,4,5"
    checkEndpoint: "/v1/models"
    ttl: 3600
```

llama-swap picks up new entries on restart (or start it with `-watch-config`
to hot-reload). `--jinja` + `--chat-template-kwargs` use the identical
common-chat engine as llama-server, so thinking-tag handling matches your
production entries. Multi-GPU: set `CUDA_VISIBLE_DEVICES` to the cards you
want — the model layer-splits across all visible GPUs automatically.

On/off: capture is per-model, not global. Talking to the `-tracking` entry
records; your normal entries don't. llama-swap loads it on first request and
unloads it after `ttl` seconds idle, like any other model.

### Getting recordings to your machine

Captures land in `--capture-dir` (here `/mnt/share/captures`, on the external
drive next to the models). Pull them with scp:

```
scp -i ~/.ssh/your_key user@your-server:/mnt/share/captures/*.jsonl D:\dev\visual-llm\captures\
```

Then drag any onto `index.html`, or aggregate a batch with `make_mask.py`.

## Reap simulation (`--mask`) — force experts off without pruning

The frontend's ⤓ button (or `e`) exports the current reap candidates — each
layer's coldest quartile by observed usage — as `reap-mask.txt`. Feed it back:

```bash
./build/bin/visual-llm-capture -m model.gguf -p "same prompt" -n 300 \
  --mask reap-mask.txt -o run-reaped.jsonl
# or inline: --mask-pairs "3:17,3:90,12:4"
```

Masked experts get their **router logit forced to −1e30** right after
`ffn_moe_logits` is computed, before softmax/top-k — the router cannot select
them and the gate renormalizes over the survivors. That is mathematically what
an inference-time-pruned model does, so the run behaves as-if-reaped without
touching any weights (no VRAM savings — this is an evaluation tool). Layer
indices in the mask are consecutive MoE-layer indices, exactly what the
frontend displays and exports; a warmup decode maps them to true model layers,
which is why the tool briefly runs one throwaway token first.

The masked run's recording carries the mask as `removed_experts`, so the
frontend renders those slots as pruned scars automatically. Load the full and
masked recordings of the **same prompt** side by side (recording selector) and
compare routing *and* the generated text — if the text is still good with the
mask on, those experts are safe to truly reap.

Guard rails: a mask covering every expert in a layer would NaN the softmax,
so such layers are unmasked with a warning. Whole-*layer* skipping (bypassing
the FFN entirely) is not possible through this hook — that needs graph edits.

## The 100-prompt workflow (batch + aggregate + evaluate)

The frontend's ⤓ export reflects a *single* recording — for a mask you trust,
determine it across a corpus:

```bash
# 1. capture a corpus (model loads once; one recording per prompt line)
./build/bin/visual-llm-capture -m model.gguf --prompts-file prompts.txt \
  -n 200 -o runs/full.jsonl            # -> runs/full-000.jsonl ... full-099.jsonl

# 2. aggregate router mass across all runs into a mask
python make_mask.py runs/full-*.jsonl -o reap-mask.txt --frac 0.25
#    prints the masked share of total routed weight mass — lower = safer

# 3. re-run an eval set with the mask on (same seed per prompt = controlled A/B)
./build/bin/visual-llm-capture -m model.gguf --prompts-file eval-prompts.txt \
  --mask reap-mask.txt -n 200 -o runs/reaped.jsonl

# 4. compare: read the generated text pairs, and drag any full/reaped pair of
#    recordings into the frontend to see the routing difference
```

`--prompts-file` skips blank and `#` lines; the sampler is reset to the same
seed for every prompt, so a full run and a masked run of the same prompt file
differ only by the mask.

For multi-line prompts, use **`--prompts-dir`** instead: point it at a
directory of `.md`/`.txt` files (one prompt per file, YAML frontmatter
stripped), and recordings are named after the files. See `../prompts/` for
the convention and a ready-made canvas-js sample set, and `hf_prompts.py`
for dumping Hugging Face dataset columns into a set.

Tip: write the corpus into a subdirectory of the server's `--capture-dir`
(e.g. `-o /path/captures/canvas/run.jsonl`) — the frontend then lists every
run under a `canvas/` prefix, and the whole set becomes a one-click reap
source (next section).

## Physical reaping — actually shrink the GGUF (`reap_gguf.py`)

Once a mask has proven itself (good text under the `-reaped` sim across a real
corpus), make it permanent. **One-click:** in the frontend's `s` panel, set
*mask from* to a recorded corpus (any capture subdirectory), pick the coldness
fraction with the slider, and hit *reap gguf* — the server aggregates the mask
and runs the surgery in one go. By hand:

```bash
# 1. the mask must remove the SAME number of experts in every layer
#    (llama.cpp requires a uniform expert count) — use --exact
python3 make_mask.py 'captures/*tracking*.jsonl' --exact -o reap-mask-exact.txt

# 2. surgery: writes a NEW gguf, input untouched, no requantization
python3 reap_gguf.py model-Q4_K_M.gguf model-REAP192-Q4_K_M.gguf \
  --mask reap-mask-exact.txt
```

This slices the pruned experts out of the fused `ffn_*_exps` tensors (each
expert is a contiguous slab, so quantized data is cut byte-exact), slices the
router rows to match, renumbers experts, and updates `expert_count`. Verified
on Qwen3.6-35B-A3B: 256 → 192 experts, **22.66 GB → 17.63 GB (−22.2%)**,
loads and generates normally.

Speed expectations (measured, 35B-A3B 256→192 on RTX 3090s): reaping does
**not** speed up generation — the router still activates top-k=8 experts per
token, so decode does the same work (measured ~6% *slower*, likely MoE-kernel
tiling preferring 256). Prompt processing gains ~8% (a batch hits most of the
pool, so fewer experts = denser GEMMs). The real win is **VRAM**: −22% weight
memory is what lets the model fit fewer/smaller GPUs or keep a longer
context. For raw decode speed, lower the *active* expert count instead
(load-time `expert_used_count` override — no surgery, stacks with reaping).

The pruned file is a *normal GGUF* — serve it with your regular `llama-server`
via llama-swap, no capture tool involved. MTP note: next-token draft layers
(`nextn_predict_layers`) carry their own experts but never appear in captures;
`reap_gguf.py` prunes them with the last main layer's keep-list (worst case:
slightly lower speculative acceptance — the main model verifies all drafts).

Validation (how the surgery was proven): masking with −∞ ≡ physical pruning
mathematically, so pruned-vs-masked should agree modulo float noise. Measured:
80.9% identical top-8 expert sets on a shared greedy prefix, mismatches mostly
single tail-expert flips concentrated in late layers — while the *same* pruned
model run on CPU vs GPU only agrees with itself 73.4%. The surgery difference
is below the hardware noise floor.

## Physical reaping of the HF checkpoint (`reap_hf.py`) — the finetune path

To *finetune* a reaped model (prune-then-heal, or domain specialization) you
need full-precision weights, so there is a safetensors sibling of the GGUF
surgery:

```bash
python3 reap_hf.py Qwen3.6-35B-A3B/ Qwen3.6-35B-A3B-REAP192/ \
  --mask canvas-mask-exact.txt
```

Same philosophy: streams raw bytes (the expert index is axis 0 of the fused
`mlp.experts.*` tensors, so each expert is a contiguous slab — dtype-agnostic,
no torch, trivial RAM), slices the router rows to match, patches
`num_experts`, rewrites the shard index, and copies tokenizer/vision/etc.
verbatim. MTP/draft stacks are pruned with the last main layer's keep list.
Verified on Qwen3.6-35B-A3B: 71.9 → 55.4 GB bf16 (−23%).

The output is a normal HF model: QLoRA it on domain data (router frozen,
LoRA on attention + surviving expert projections), merge, then
`convert_hf_to_gguf.py` + `llama-quantize` and serve. Validate the surgery
the same way as reap_gguf: convert → quantize → greedy-compare routing
against the masked original.

## Related knob: fewer active experts

A different-but-adjacent experiment needs no mask at all: llama.cpp can
override the number of experts used per token at load time, e.g.
`--override-kv qwen3moe.expert_used_count=int:4` on a top-8 model (the key
prefix is the model arch). Good for feeling out how much routed capacity a
model actually needs.

## Model suggestions

| Model | MoE shape | Why |
| --- | --- | --- |
| **GPT-OSS-20B** | 24 layers × 32 experts, top-4 | exactly the shape the styles were tuned on; ~12–16 GB quantized |
| OLMoE-1B-7B | 16 × 64, top-8 | tiny and fast for iteration |
| Qwen3-30B-A3B | 48 × 128, top-8 | dramatic, but denser than the styles were tuned for |

Prompt tokens are captured too (`pos` order), so the replay shows the model
*reading* the prompt before it starts writing.

## If the build errors (llama.cpp API drift)

The tool is written against the llama.cpp API current as of early 2026. The
call sites that have historically been renamed, with their older spellings:

| Call in this tool | Older name if your checkout predates the rename |
| --- | --- |
| `llama_model_load_from_file` | `llama_load_model_from_file` |
| `llama_init_from_model` | `llama_new_context_with_model` |
| `llama_model_free` | `llama_free_model` |
| `llama_model_get_vocab` + vocab-taking `llama_tokenize` / `llama_token_to_piece` / `llama_vocab_is_eog` | model-taking variants (`llama_token_is_eog(model, …)`) |
| `llama_batch_get_one(tokens, n)` | older signature took extra `pos`/`seq_id` args |
| `llama_memory_clear(llama_get_memory(ctx), true)` | `llama_kv_self_clear(ctx)`, earlier `llama_kv_cache_clear(ctx)` |

The tensor-name matching (`ffn_moe_*`) is prefix-based and has been stable for
a long time, but if a capture reports "no ffn_moe_* tensors observed" on a
model you know is MoE, grep `build_moe_ffn` in `src/llama-graph.cpp` (or
`llama.cpp`) for the current `cb(...)` names and adjust the three prefixes at
the top of `cb_eval`.

## Not yet captured (schema supports them)

- `resid` events (per-layer residual delta norms) — needs the `l_out-<layer>`
  tensors plus a previous-layer buffer to diff against; frontend defaults
  `delta` to 1 without them.
- `lens` events (logit-lens top predictions per layer) — needs hidden states
  projected through the unembedding; a later, chunkier addition.
- Live streaming — same JSON objects over a WebSocket instead of a file; the
  frontend already treats recordings as event streams.

## Contrastive reaping (`contrast_mask.py`) — cut what's busy elsewhere

Pure cold-ranking eventually cuts "quiet everywhere" experts — often
rare-but-critical glue whose loss shows up as long-form repetition collapse.
`contrast_mask.py` scores candidates differently: capture an **anti-domain
corpus** (world knowledge, multilingual, prose — everything your domain never
does) and cut experts that are **cold under your target AND hot under the
anti-domain** — experts with a demonstrated full-time job somewhere you don't
go.

```bash
python3 contrast_mask.py 'runs/target-*.jsonl' 'runs/anti-*.jsonl' \
  --frac 0.5 --cold-pool 0.625 -o contrast-mask.txt
```

Measured on Qwen3.6-35B-A3B (canvas target vs 60-prompt anti corpus): at a
62.5% cut, the pure-cold mask collapses long-form generation into repetition
loops on every test prompt while the contrastive mask stays clean and even
completes its files — at a cut carrying 74% of the anti-domain's routed mass.
Domain overlap context: canvas-hot and anti-hot expert sets share only 48%.
