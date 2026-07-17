/* visual-llm — synthetic recording generator + JSONL encode/decode.
   Produces deterministic fake MoE routing data with plausible structure:
   shared always-on experts, per-category expert affinities, positional drift,
   and an optional REAP-style pruned ("reaped") variant of the same model. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const TEXT =
    'The model dreams in branching light. Each token wakes a small parliament ' +
    'of experts, and they vote in whispers of probability. Some speak often — ' +
    'they are the grammar of the machine — while others wait in the dark for ' +
    'one rare and beautiful word. Watch the paths: where the light pools, the ' +
    'network remembers; where it never travels, a gardener may prune. ' +
    '42 experts, 8 gates, 1 thought at a time. ' +
    '`route(h) = topk(softmax(W @ h))` and yet it feels like weather, like ' +
    'starlings turning over a winter field. What survives the reaping is only ' +
    'what the light kept touching. So we watch, and we keep the lanterns lit.';

  const CATS = ['word', 'code', 'number', 'punct'];

  function tokenize(text) {
    const out = [];
    const parts = text.split('`');
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        // inside backticks: everything is a code token
        part.split(/\s+/).filter(Boolean).forEach((w) => out.push({ text: w, cat: 'code' }));
        return;
      }
      const re = /[A-Za-z']+|[0-9]+|[^\sA-Za-z0-9]/g;
      let m;
      while ((m = re.exec(part))) {
        const s = m[0];
        out.push({
          text: s,
          cat: /[0-9]/.test(s) ? 'number' : /[A-Za-z]/.test(s) ? 'word' : 'punct',
        });
      }
    });
    out.forEach((t, i) => {
      t.id = 1000 + i;
      t.pos = i;
    });
    return out;
  }

  /* Router model: per layer, a couple of shared (always-hot) experts plus a
     small affinity set per token category. Scores get positional drift and
     noise so paths vary token to token but keep visible structure. */
  function buildRouter(cfg, rng) {
    const layers = [];
    for (let l = 0; l < cfg.nLayers; l++) {
      const shared = [];
      while (shared.length < 2) {
        const e = (rng() * cfg.nExperts) | 0;
        if (!shared.includes(e)) shared.push(e);
      }
      const aff = {};
      CATS.forEach((c) => {
        const set = new Map();
        const n = 3 + ((rng() * 3) | 0);
        while (set.size < n) {
          const e = (rng() * cfg.nExperts) | 0;
          if (!shared.includes(e)) set.set(e, 1.5 + rng() * 2.5);
        }
        aff[c] = set;
      });
      const phase = new Float32Array(cfg.nExperts);
      for (let e = 0; e < cfg.nExperts; e++) phase[e] = rng() * VLM.TAU;
      layers.push({ shared, aff, phase });
    }
    return layers;
  }

  function route(router, cfg, removed, tok, l, rng) {
    const L = router[l];
    const nE = cfg.nExperts;
    const scores = new Float32Array(nE);
    for (let e = 0; e < nE; e++) {
      if (removed && removed[l * nE + e]) {
        scores[e] = -1e9;
        continue;
      }
      let s = rng() * 0.9; // noise
      s += 0.7 * Math.sin(tok.pos * 0.03 + L.phase[e]); // slow positional drift
      if (L.shared.includes(e)) s += 2.6;
      const a = L.aff[tok.cat].get(e);
      if (a) s += a;
      scores[e] = s;
    }
    const idx = Array.from(scores.keys())
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, cfg.topK);
    const mx = scores[idx[0]];
    let sum = 0;
    const raw = idx.map((e) => {
      const v = Math.exp((scores[e] - mx) / 0.9);
      sum += v;
      return v;
    });
    return {
      experts: idx,
      weights: raw.map((v) => Math.round((v / sum) * 10000) / 10000),
    };
  }

  function deltaNorm(cat, l, nLayers, rng) {
    const x = nLayers > 1 ? l / (nLayers - 1) : 0.5;
    const bell = Math.exp(-((x - 0.55) * (x - 0.55)) / 0.09);
    const catF = { word: 1, code: 1.15, number: 0.9, punct: 0.55 }[cat] || 1;
    return Math.round((0.6 + 2.6 * bell) * catF * (0.85 + 0.3 * rng()) * 100) / 100;
  }

  /* REAP-style pruning: remove the experts the router was never drawn to —
     per layer, drop experts outside every affinity set and the shared pair. */
  function buildRemovedMask(cfg, router, rng) {
    const nE = cfg.nExperts;
    const removed = new Uint8Array(cfg.nLayers * nE);
    const target = Math.floor(nE * cfg.removedFrac);
    for (let l = 0; l < cfg.nLayers; l++) {
      const hot = new Set(router[l].shared);
      CATS.forEach((c) => router[l].aff[c].forEach((_, e) => hot.add(e)));
      const cold = [];
      for (let e = 0; e < nE; e++) if (!hot.has(e)) cold.push(e);
      // shuffle cold deterministically, prune `target` of them
      for (let i = cold.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        [cold[i], cold[j]] = [cold[j], cold[i]];
      }
      cold.slice(0, target).forEach((e) => (removed[l * nE + e] = 1));
    }
    return removed;
  }

  VLM.generateRecording = function (cfg) {
    const rng = VLM.mulberry32(cfg.seed >>> 0);
    const router = buildRouter(cfg, rng);
    const removed = cfg.removedFrac ? buildRemovedMask(cfg, router, rng) : null;
    const tokens = tokenize(cfg.text || TEXT).map((tok) => ({
      id: tok.id,
      text: tok.text,
      cat: tok.cat,
      pos: tok.pos,
      layers: Array.from({ length: cfg.nLayers }, (_, l) => {
        const hop = route(router, cfg, removed, tok, l, rng);
        hop.delta = deltaNorm(tok.cat, l, cfg.nLayers, rng);
        return hop;
      }),
    }));
    return {
      meta: {
        version: 1,
        model: {
          name: cfg.name,
          n_layers: cfg.nLayers,
          n_experts: cfg.nExperts,
          top_k: cfg.topK,
          d_model: 2048,
        },
        prompt: 'synthetic',
        removed,
      },
      tokens,
    };
  };

  VLM.RECORDINGS = [
    {
      id: 'full',
      label: 'Full model · 24L × 32E',
      build: () =>
        VLM.generateRecording({
          name: 'synthetic-moe-24x32',
          nLayers: 24, nExperts: 32, topK: 4, seed: 1337,
        }),
    },
    {
      id: 'reaped',
      label: 'Reaped model · 24L × 32E (~38% pruned)',
      build: () =>
        VLM.generateRecording({
          name: 'synthetic-moe-24x32-reaped',
          nLayers: 24, nExperts: 32, topK: 4, seed: 1337, removedFrac: 0.38,
        }),
    },
    {
      id: 'large',
      label: 'Large model · 32L × 64E',
      build: () =>
        VLM.generateRecording({
          name: 'synthetic-moe-32x64',
          nLayers: 32, nExperts: 64, topK: 8, seed: 4242,
        }),
    },
  ];

  /* ---------- JSONL (see SCHEMA.md) ---------- */

  VLM.recordingToJSONL = function (rec) {
    const lines = [];
    const meta = {
      type: 'meta',
      version: 1,
      model: rec.meta.model,
      prompt: rec.meta.prompt || '',
    };
    if (rec.meta.removed) {
      const pairs = [];
      const nE = rec.meta.model.n_experts;
      rec.meta.removed.forEach((v, i) => {
        if (v) pairs.push([Math.floor(i / nE), i % nE]);
      });
      meta.removed_experts = pairs;
    }
    lines.push(JSON.stringify(meta));
    rec.tokens.forEach((tok, t) => {
      lines.push(JSON.stringify({ type: 'token', t, id: tok.id, text: tok.text, cat: tok.cat, pos: tok.pos }));
      tok.layers.forEach((hop, layer) => {
        lines.push(JSON.stringify({ type: 'moe', t, layer, experts: hop.experts, weights: hop.weights }));
        lines.push(JSON.stringify({ type: 'resid', t, layer, delta: hop.delta }));
      });
    });
    lines.push(JSON.stringify({ type: 'done', n_tokens: rec.tokens.length }));
    return lines.join('\n');
  };

  VLM.parseJSONL = function (text) {
    let meta = null;
    const tokens = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try { ev = JSON.parse(s); } catch { continue; }
      if (ev.type === 'meta') {
        meta = {
          version: ev.version || 1,
          model: ev.model,
          prompt: ev.prompt || '',
          removed: null,
        };
        if (ev.removed_experts && ev.removed_experts.length) {
          const nE = ev.model.n_experts;
          meta.removed = new Uint8Array(ev.model.n_layers * nE);
          ev.removed_experts.forEach(([l, e]) => (meta.removed[l * nE + e] = 1));
        }
      } else if (ev.type === 'token') {
        tokens[ev.t] = {
          id: ev.id, text: ev.text,
          cat: ev.cat || inferCat(ev.text),
          pos: ev.pos ?? ev.t,
          layers: [],
        };
      } else if (ev.type === 'moe' && tokens[ev.t]) {
        const layers = tokens[ev.t].layers;
        layers[ev.layer] = Object.assign(layers[ev.layer] || { delta: 1 }, {
          experts: ev.experts, weights: ev.weights,
        });
      } else if (ev.type === 'resid' && tokens[ev.t]) {
        const layers = tokens[ev.t].layers;
        layers[ev.layer] = Object.assign(layers[ev.layer] || { experts: [], weights: [] }, {
          delta: ev.delta,
        });
      }
    }
    if (!meta || !tokens.length) throw new Error('parseJSONL: missing meta or tokens');
    // drop tokens with incomplete layer data (e.g. truncated capture)
    const nL = meta.model.n_layers;
    const clean = tokens.filter(
      (t) => t && t.layers.length === nL && t.layers.every((l) => l && l.experts && l.experts.length)
    );
    return { meta, tokens: clean };
  };

  function inferCat(text) {
    const s = (text || '').trim();
    if (/^[0-9]+$/.test(s)) return 'number';
    if (/^[A-Za-z']+$/.test(s)) return 'word';
    if (/[(){}\[\]=<>;_@#$%^&*\\|~`]/.test(s)) return 'code';
    return 'punct';
  }
})();
