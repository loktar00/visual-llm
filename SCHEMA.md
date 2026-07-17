# visual-llm recording schema (v1)

A **recording** is a JSONL stream (one JSON object per line) describing a single
generation pass through a Mixture-of-Experts model. The same schema is used for:

- synthetic recordings (generated in-browser by `js/synthetic.js`)
- real captures (future C++ runner on llama.cpp's `cb_eval` hook)
- live streaming (same objects over a WebSocket, `type` field unchanged)

The frontend never needs to know which source produced the events.

## Line types

### `meta` — first line, exactly once

```json
{"type":"meta","version":1,
 "model":{"name":"qwen3-30b-a3b","n_layers":48,"n_experts":128,"top_k":8,"d_model":2048},
 "prompt":"original prompt text",
 "removed_experts":[[3,17],[3,90],[12,4]],
 "created":"2026-07-17T00:00:00Z"}
```

- `removed_experts` — optional; list of `[layer, expert]` pairs pruned from the
  model (REAP-style expert pruning). Lets the frontend render "ghost" slots and
  compare full vs reaped runs of the same prompt.

### `token` — one per generated token, before its layer events

```json
{"type":"token","t":12,"id":8074,"text":" fire","cat":"word","pos":12}
```

- `t` — token index within the generation (monotonic, 0-based). All subsequent
  layer events carry the same `t`.
- `cat` — optional coarse category for coloring: `word | code | number | punct`.
  Real captures may omit it; the frontend infers from `text` when absent.

### `moe` — one per MoE layer per token

```json
{"type":"moe","t":12,"layer":17,"experts":[4,31,77,90],"weights":[0.41,0.22,0.19,0.18]}
```

- `experts` — top-k expert indices chosen by the router (descending weight).
- `weights` — normalized gate weights, same order, sum ≈ 1.
- Source in llama.cpp: `ffn_moe_topk-<layer>` / `ffn_moe_weights-<layer>`
  tensors via the eval callback.

### `resid` — optional, one per layer per token

```json
{"type":"resid","t":12,"layer":17,"delta":3.2}
```

- `delta` — L2 norm of the residual-stream change made by this layer. Cheap
  scalar "how hard did this layer work on this token" signal.

### `lens` — optional, logit-lens summary per layer per token

```json
{"type":"lens","t":12,"layer":17,"top":[["fire",0.31],["flame",0.12]]}
```

### `done` — last line

```json
{"type":"done","n_tokens":214,"ms":8630}
```

## Sizes

Per token: 1 `token` + n_layers × (`moe` + `resid`) lines ≈ 100 bytes each.
A 1,000-token generation on a 48-layer model ≈ 100k lines ≈ 10 MB raw,
~1–2 MB gzipped. Small enough to load fully into browser memory.

## In-browser normalized form

`js/synthetic.js` `parseJSONL()` folds the stream into:

```js
{
  meta: { version, model: {name, n_layers, n_experts, top_k}, prompt,
          removed: Uint8Array(n_layers * n_experts) | null },
  tokens: [ { id, text, cat, pos,
              layers: [ {experts:[], weights:[], delta} ] /* length n_layers */ } ]
}
```

Unknown line types are ignored (forward-compatible). Missing `resid` lines
default `delta` to 1.
