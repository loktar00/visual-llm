/* visual-llm — replay engine.
   Owns the simulation clock, token pulses (time-remapped descents through the
   layer stack), the fast-decay heat buffer and no-decay usage buffer, scrubbing,
   looping, and the requestAnimationFrame loop that drives the active style.

   State is derived from absolute sim time wherever possible so scrubbing and
   looping are exact, not approximate. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const LN2 = Math.LN2;

  // All in *sim seconds* (scaled by the speed slider).
  const LAUNCH_INTERVAL = 0.42; // gap between token launches
  const DESCENT = 2.2;          // time for one token to cross the whole stack
  const LAND_FADE = 0.8;        // afterglow once a token lands
  const HEAT_HALFLIFE = 9.0;    // decay of the "recent activity" heat buffer
  const LOOP_PAUSE = 2.0;       // dark beat before the recording loops

  VLM.TIMING = { LAUNCH_INTERVAL, DESCENT, LAND_FADE };

  /* Minimal built-in fallback style, used only if a registered style throws. */
  const FALLBACK = {
    id: '__fallback', name: 'Fallback grid', blurb: 'a style crashed — plain view',
    bg: '#05060a', fadeRGB: '5,6,10',
    init(c) { this._c = c; },
    render(f) {
      const { ctx, w, h, model } = f;
      VLM.fade(ctx, w, h, 0.3, this.fadeRGB);
      const cw = w / model.nExperts, ch = h / model.nLayers;
      for (let l = 0; l < model.nLayers; l++)
        for (let e = 0; e < model.nExperts; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.02 && !model.isRemoved(l, e)) continue;
          ctx.fillStyle = model.isRemoved(l, e) ? 'rgba(255,60,110,0.15)' : VLM.heatColor(v, 0.9);
          ctx.fillRect(e * cw + 1, l * ch + 1, cw - 2, ch - 2);
        }
      ctx.globalCompositeOperation = 'lighter';
      for (const p of f.pulses) {
        const hop = p.hops[Math.round(p.layerFloat)];
        const x = (hop.experts[0] + 0.5) * cw, y = (p.layerFloat + 0.5) * ch;
        ctx.fillStyle = VLM.hsla(p.hue, 90, 65, 0.9 * p.glow);
        ctx.beginPath(); ctx.arc(x, y, 5, 0, VLM.TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
    dispose() {},
  };

  class ReplayEngine {
    constructor(canvas) {
      this.canvas = canvas;
      // opaque context: we always paint a solid background, and an alpha
      // channel invites premultiplied-compositing artifacts (pale halos)
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.style = null;
      this.rec = null;
      this.playing = true;
      this.speed = 1;
      this.loop = true;
      this.reapLens = false;
      this.showLabels = true; // input/output token text at entry and exit
      this.time = 0;
      this.processedTime = 0;
      this.pulses = [];
      this.pulseMap = new Map();
      this.tokensDoneCount = 0;
      this._styleErrors = 0;

      // callbacks wired by main.js
      this.onToken = null;      // (token, index) — a token just landed
      this.onRebuild = null;    // (doneTokens[]) — after scrub/loop reset
      this.onTick = null;       // (frame) — every rAF
      this.onStyleError = null; // (styleId, error)

      this._frame = {};
      this._last = performance.now() / 1000;
      this._wallNow = this._last;
      this._resizeQueued = true;
      const ro = new ResizeObserver(() => (this._resizeQueued = true));
      ro.observe(canvas.parentElement || canvas);
      this._raf = this._raf.bind(this);
      requestAnimationFrame(this._raf);
    }

    /* ---------- setup ---------- */

    setRecording(rec) {
      this.rec = rec;
      const m = rec.meta.model;
      this.nL = m.n_layers;
      this.nE = m.n_experts;
      const removed = rec.meta.removed || null;
      const nE = this.nE;
      this.model = {
        name: m.name,
        nLayers: this.nL,
        nExperts: nE,
        topK: m.top_k,
        removed,
        isRemoved: (l, e) => !!(removed && removed[l * nE + e]),
      };
      this.heat = new Float32Array(this.nL * nE);
      this.usage = new Float32Array(this.nL * nE);
      this.heatMax = 1e-6;
      this.usageMax = 1e-6;
      this.duration = (rec.tokens.length - 1) * LAUNCH_INTERVAL + DESCENT;
      this.time = 0;
      this._rebuild();
      if (this.style) this._initStyle();
    }

    setStyle(style) {
      if (this.style && this.style.dispose) {
        try { this.style.dispose(); } catch (e) { console.error(e); }
      }
      this.style = style;
      this._styleErrors = 0;
      if (this.rec) this._initStyle();
    }

    _initStyle() {
      this._applySize();
      const s = this.style;
      const rng = VLM.mulberry32(VLM.hashStr(s.id + '|' + this.model.name));
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1;
      this.ctx.fillStyle = s.bg;
      this.ctx.fillRect(0, 0, this.w, this.h);
      try {
        s.init({
          canvas: this.canvas, ctx: this.ctx,
          w: this.w, h: this.h, dpr: this.dpr,
          model: this.model, rng,
        });
      } catch (e) {
        this._styleFail(e);
      }
    }

    _applySize() {
      const el = this.canvas.parentElement || this.canvas;
      this.w = Math.max(64, el.clientWidth);
      this.h = Math.max(64, el.clientHeight);
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    _styleFail(e) {
      const id = this.style ? this.style.id : '?';
      console.error(`style "${id}" crashed:`, e);
      if (this.onStyleError) this.onStyleError(id, e);
      this.style = Object.assign({}, FALLBACK);
      this._initStyle();
    }

    /* ---------- transport ---------- */

    togglePlay() { this.playing = !this.playing; }
    setSpeed(s) { this.speed = VLM.clamp(s, 0.05, 5); }

    scrubTo(frac) {
      if (!this.rec) return;
      this.time = VLM.clamp(frac, 0, 1) * this.duration;
      this._rebuild();
    }

    /* Recompute heat/usage/done-count exactly for the current sim time. */
    _rebuild() {
      const tokens = this.rec.tokens;
      this.heat.fill(0);
      this.usage.fill(0);
      const time = this.time;
      let done = 0;
      for (let j = 0; j < tokens.length; j++) {
        const born = j * LAUNCH_INTERVAL;
        if (born > time) break;
        const tok = tokens[j];
        for (let l = 0; l < this.nL; l++) {
          const hit = born + DESCENT * (this.nL === 1 ? 1 : l / (this.nL - 1));
          if (hit > time) break;
          const hop = tok.layers[l];
          const age = time - hit;
          const decay = Math.exp((-age * LN2) / HEAT_HALFLIFE);
          for (let k = 0; k < hop.experts.length; k++) {
            const idx = l * this.nE + hop.experts[k];
            const w = hop.weights[k];
            this.usage[idx] += w;
            this.heat[idx] += w * decay;
          }
        }
        if (born + DESCENT <= time) done = j + 1;
      }
      this.tokensDoneCount = done;
      this.processedTime = time;
      this.pulseMap.clear();
      this._updateMaxes(true);
      if (this.onRebuild) this.onRebuild(tokens.slice(0, done));
    }

    /* ---------- per-frame simulation ---------- */

    _update(wallDt) {
      const dt = this.playing ? wallDt * this.speed : 0;
      if (dt > 0) {
        this.time += dt;
        const tokens = this.rec.tokens;

        // decay heat
        const decay = Math.exp((-dt * LN2) / HEAT_HALFLIFE);
        const heat = this.heat;
        for (let i = 0; i < heat.length; i++) heat[i] *= decay;

        // apply layer hits that occurred in (processedTime, time]
        const t0 = this.processedTime, t1 = this.time;
        const jMin = Math.max(0, Math.floor((t0 - DESCENT) / LAUNCH_INTERVAL));
        const jMax = Math.min(tokens.length - 1, Math.floor(t1 / LAUNCH_INTERVAL));
        for (let j = jMin; j <= jMax; j++) {
          const born = j * LAUNCH_INTERVAL;
          const tok = tokens[j];
          for (let l = 0; l < this.nL; l++) {
            const hit = born + DESCENT * (this.nL === 1 ? 1 : l / (this.nL - 1));
            if (hit <= t0 || hit > t1) continue;
            const hop = tok.layers[l];
            for (let k = 0; k < hop.experts.length; k++) {
              const idx = l * this.nE + hop.experts[k];
              const w = hop.weights[k];
              this.usage[idx] += w;
              heat[idx] += w;
            }
          }
        }
        this.processedTime = this.time;

        // landings
        const done = Math.min(
          tokens.length,
          Math.max(0, Math.floor((this.time - DESCENT) / LAUNCH_INTERVAL) + 1)
        );
        if (done > this.tokensDoneCount && this.onToken) {
          for (let j = this.tokensDoneCount; j < done; j++) this.onToken(tokens[j], j);
        }
        if (done > this.tokensDoneCount) this.tokensDoneCount = done;

        // loop
        if (this.loop && this.time > this.duration + LAND_FADE + LOOP_PAUSE) {
          this.time = 0;
          this._rebuild();
        }
        this._updateMaxes(false);
      }
      this._syncPulses();
    }

    /* Reap lens — drawn on a separate overlay canvas so the dimming veil never
       enters the styles' trail-fade feedback loop. Per layer, the coldest
       quartile of live experts (REAP prunes per-layer) gets a breathing
       crimson ring + slash, intensity ranked by coldness; already-pruned
       slots get a dark X. Positions come from the style's nodePos(l, e).
       Fades in as usage data accrues. */
    attachLensCanvas(canvas) {
      this.lensCanvas = canvas;
      this.lensCtx = canvas.getContext('2d');
      // inline styles so the overlay works even under a stale cached stylesheet
      const st = canvas.style;
      st.position = 'absolute';
      st.inset = '0';
      st.width = '100%';
      st.height = '100%';
      st.pointerEvents = 'none';
    }

    _clearLens() {
      if (this.lensCtx) {
        this.lensCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.lensCtx.clearRect(0, 0, this.lensCanvas.width, this.lensCanvas.height);
      }
      this._lensDirty = false;
    }

    /* Orchestrates the overlay canvas: sized/cleared once per frame, then the
       reap lens and/or token labels draw into it. Both need nodePos. */
    _drawOverlay() {
      const ctx = this.lensCtx;
      const style = this.style;
      const usable = style && typeof style.nodePos === 'function';
      if (!ctx || !usable || (!this.reapLens && !this.showLabels)) {
        if (this._lensDirty) this._clearLens();
        return;
      }
      if (this.lensCanvas.width !== this.canvas.width || this.lensCanvas.height !== this.canvas.height) {
        this.lensCanvas.width = this.canvas.width;
        this.lensCanvas.height = this.canvas.height;
      }
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this._lensDirty = true;
      if (this.reapLens) this._drawReapLens(ctx);
      if (this.showLabels) this._drawTokenLabels(ctx);
    }

    /* Input/output token text in the art itself: a launching pulse carries its
       token's text at the entry expert; a landing pulse reveals the NEXT token
       — what the model produced — at the exit expert. Watching the exit label
       become the next entry label is the autoregressive loop, made visible. */
    _drawTokenLabels(ctx) {
      const style = this.style;
      const nL = this.nL;
      ctx.font = '600 14px ui-monospace, "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      for (const p of this.pulses) {
        // entry: the token being fed in, fading as it descends
        if (p.progress < 0.35) {
          const pos = this._safeNodePos(style, 0, p.hops[0].experts[0]);
          if (pos) {
            const a = (1 - p.progress / 0.35) * 0.95;
            this._label(ctx, p.text, pos[0], Math.max(16, pos[1] - 16), p.hue, a, '▼');
          }
        }
        // exit: the next token — the model's output for this step
        if (p.progress >= 1) {
          const nxt = this.rec.tokens[p.tokenIdx + 1];
          if (nxt) {
            const pos = this._safeNodePos(style, nL - 1, p.hops[nL - 1].experts[0]);
            if (pos) {
              const hue = (VLM.CATEGORY_HUES[nxt.cat] ?? 200);
              const y = Math.min(this.h - 10, pos[1] + 24 + (1 - p.glow) * 6);
              this._label(ctx, nxt.text, pos[0], y, hue, p.glow, null);
            }
          }
        }
      }
      ctx.textAlign = 'left';
    }

    _safeNodePos(style, l, e) {
      try { return style.nodePos(l, e); } catch { return null; }
    }

    _label(ctx, text, x, y, hue, alpha, arrow) {
      if (alpha < 0.03 || !text) return;
      const t = text.trim() === '' ? '␣' : text;
      x = VLM.clamp(x, 30, this.w - 30);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 4;
      ctx.strokeText(t, x, y);
      ctx.fillStyle = VLM.hsla(hue, 85, 78, 1);
      ctx.fillText(t, x, y);
      if (arrow) {
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillText(arrow, x, y + 13);
      }
      ctx.globalAlpha = 1;
    }

    _drawReapLens(ctx) {
      const style = this.style;
      const nL = this.nL, nE = this.nE;
      const wn = this._wallNow;

      // a single, non-compounding veil to make the marks read
      ctx.fillStyle = 'rgba(2,3,6,0.38)';
      ctx.fillRect(0, 0, this.w, this.h);

      const ramp = Math.min(1, this.tokensDoneCount / 30); // data still thin?
      ctx.lineWidth = 1.3;
      const order = this._lensOrder || (this._lensOrder = []);
      for (let l = 0; l < nL; l++) {
        // rank this layer's live experts by usage, coldest first
        order.length = 0;
        let sum = 0;
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          if (this.model.removed && this.model.removed[idx]) {
            let p;
            try { p = style.nodePos(l, e); } catch { p = null; }
            if (!p) continue;
            ctx.strokeStyle = 'rgba(160,38,62,0.7)';
            ctx.beginPath();
            ctx.moveTo(p[0] - 4, p[1] - 4); ctx.lineTo(p[0] + 4, p[1] + 4);
            ctx.moveTo(p[0] + 4, p[1] - 4); ctx.lineTo(p[0] - 4, p[1] + 4);
            ctx.stroke();
            continue;
          }
          sum += this.usage[idx];
          order.push(e);
        }
        if (!order.length) continue;
        const mean = sum / order.length;
        order.sort((a, b) => this.usage[l * nE + a] - this.usage[l * nE + b]);
        const kMax = Math.max(1, Math.floor(order.length * 0.25));
        for (let k = 0; k < kMax; k++) {
          const e = order[k];
          const u = this.usage[l * nE + e];
          if (u > mean * 0.6) break; // layer is too uniform to call these cold
          let p;
          try { p = style.nodePos(l, e); } catch { p = null; }
          if (!p) continue;
          const cold = 1 - k / kMax;
          const breathe = 0.75 + 0.25 * Math.sin(wn * 2 + (l * 7 + e) * 0.7);
          const a = (0.18 + 0.5 * cold) * ramp * breathe;
          if (a < 0.03) continue;
          const r = 3 + 2.2 * cold;
          ctx.strokeStyle = `rgba(255,64,96,${a})`;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          ctx.moveTo(p[0] - r * 0.7, p[1] + r * 0.7);
          ctx.lineTo(p[0] + r * 0.7, p[1] - r * 0.7);
          ctx.stroke();
        }
      }
    }

    /* Current reap candidates — same per-layer bottom-quartile criteria the
       lens draws, as [layer, expert] pairs. Feed to visual-llm-capture --mask
       to simulate the reap via router masking. */
    getReapCandidates() {
      const out = [];
      if (!this.rec) return out;
      const nL = this.nL, nE = this.nE;
      for (let l = 0; l < nL; l++) {
        const live = [];
        let sum = 0;
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          if (this.model.removed && this.model.removed[idx]) continue;
          sum += this.usage[idx];
          live.push(e);
        }
        if (!live.length) continue;
        const mean = sum / live.length;
        live.sort((a, b) => this.usage[l * nE + a] - this.usage[l * nE + b]);
        const kMax = Math.max(1, Math.floor(live.length * 0.25));
        for (let k = 0; k < kMax; k++) {
          const e = live[k];
          if (this.usage[l * nE + e] > mean * 0.6) break;
          out.push([l, e]);
        }
      }
      return out;
    }

    _updateMaxes(force) {
      let hm = 0, um = 0;
      const heat = this.heat, usage = this.usage;
      for (let i = 0; i < heat.length; i++) {
        if (heat[i] > hm) hm = heat[i];
        if (usage[i] > um) um = usage[i];
      }
      if (force) this.heatMax = Math.max(hm, 1e-6);
      else this.heatMax = Math.max(hm, this.heatMax * 0.995, 1e-6);
      this.usageMax = Math.max(um, 1e-6);
    }

    _syncPulses() {
      const tokens = this.rec.tokens;
      const time = this.time;
      const jMin = Math.max(0, Math.ceil((time - DESCENT - LAND_FADE) / LAUNCH_INTERVAL));
      const jMax = Math.min(tokens.length - 1, Math.floor(time / LAUNCH_INTERVAL));
      for (const j of this.pulseMap.keys()) {
        if (j < jMin || j > jMax) this.pulseMap.delete(j);
      }
      const list = [];
      for (let j = jMin; j <= jMax; j++) {
        const born = j * LAUNCH_INTERVAL;
        if (born > time) continue;
        let p = this.pulseMap.get(j);
        if (!p) {
          const tok = tokens[j];
          p = {
            tokenIdx: j,
            text: tok.text,
            cat: tok.cat,
            hue: (VLM.CATEGORY_HUES[tok.cat] ?? 200) + (((j * 47) % 30) - 15),
            hops: tok.layers,
            born,
          };
          this.pulseMap.set(j, p);
        }
        const age = time - born;
        p.progress = Math.min(1, age / DESCENT);
        p.layerFloat = p.progress * (this.nL - 1);
        p.glow = age < DESCENT ? 1 : Math.max(0, 1 - (age - DESCENT) / LAND_FADE);
        if (p.glow > 0) list.push(p);
      }
      this.pulses = list;
    }

    /* ---------- render loop ---------- */

    _raf() {
      requestAnimationFrame(this._raf);
      const now = performance.now() / 1000;
      const wallDt = Math.min(0.1, now - this._last);
      this._last = now;
      this._wallNow = now;
      if (!this.rec || !this.style) return;
      if (this._resizeQueued) {
        this._resizeQueued = false;
        this._initStyle();
      }
      this._update(wallDt);

      const f = this._frame;
      f.ctx = this.ctx;
      f.w = this.w;
      f.h = this.h;
      f.dpr = this.dpr;
      f.now = this.time;          // sim clock (frozen when paused)
      f.wallNow = now;            // wall clock (always advances; ambient motion)
      f.dt = this.playing ? wallDt * this.speed : 0;
      f.wallDt = wallDt;
      f.model = this.model;
      f.pulses = this.pulses;
      f.heat = this.heat;
      f.usage = this.usage;
      f.heatMax = this.heatMax;
      f.usageMax = this.usageMax;
      if (!f.heatAt) {
        f.heatAt = (l, e) => this.heat[l * this.nE + e] / this.heatMax;
        f.usageAt = (l, e) => this.usage[l * this.nE + e] / this.usageMax;
      }
      f.progress = VLM.clamp(this.time / this.duration, 0, 1);
      f.playing = this.playing;
      f.speed = this.speed;
      f.tokensDone = this.tokensDoneCount;
      f.totalTokens = this.rec.tokens.length;

      try {
        this.style.render(f);
        this._styleErrors = 0;
      } catch (e) {
        if (++this._styleErrors > 2) this._styleFail(e);
      }
      this._drawOverlay();
      if (this.onTick) this.onTick(f);
    }
  }

  VLM.ReplayEngine = ReplayEngine;
})();
