/* visual-llm style: Windswept Bonsai — the model as a living, wind-leaning tree.
   A single organic fractal tree is grown once in init from the seeded rng and
   baked into an offscreen canvas as deep umber bark. Sample points collected
   along every branch are sorted by their path-distance from the root and split
   into nLayers height-bands (layer 0 = trunk base, last layer = twig tips);
   within each band the nExperts slots are spread across the wood. Token pulses
   are warm white-gold sap-light climbing the route from trunk to canopy; heat
   opens rose-pink blossoms where the routing lives; reaped experts are dead grey
   twig stubs that never flower. A gentle wind sways the light, blossoms, and a
   few drifting petal motes — the rigid bark stays put. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;
  const lerp = VLM.lerp;
  const clamp = VLM.clamp;

  const MAX_DEPTH = 9;

  const S = {
    id: 'bonsai',
    name: 'Windswept Bonsai',
    blurb: 'the model as a windswept tree — sap-light climbs the wood and the canopy flowers where routing lives',
    bg: '#080604',
    fadeRGB: '8,6,4',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> { pts, hgt }
      this._bloom = new Map(); // cell index -> petal layout
      this._scratch = [];
      this._seed = (rng() * 0xffffffff) >>> 0;

      const nL = model.nLayers;
      const nE = model.nExperts;
      const rootX = (this.rootX = w * 0.44 + (rng() - 0.5) * w * 0.04);
      const rootY = (this.rootY = h * 0.9);
      this.swayAmp = Math.max(4, Math.min(w, h) * 0.008);

      // offscreen bark canvas
      const off = (this.staticCanvas = document.createElement('canvas'));
      off.width = Math.ceil(w);
      off.height = Math.ceil(h);
      const g = off.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // a barely-there warm moon low in the open (upwind) sky
      const mR = Math.min(w, h) * 0.17;
      const mx = w * 0.24;
      const my = h * 0.2;
      const halo = g.createRadialGradient(mx, my, 0, mx, my, mR);
      halo.addColorStop(0, 'rgba(255,244,222,0.20)');
      halo.addColorStop(0.55, 'rgba(255,238,212,0.07)');
      halo.addColorStop(1, 'rgba(255,238,212,0)');
      g.fillStyle = halo;
      g.beginPath();
      g.arc(mx, my, mR, 0, TAU);
      g.fill();

      // grow the tree, collecting samples with their path-distance from root
      const samples = [];
      const trunkW = Math.max(9, Math.min(w, h) * 0.015);
      const trunkLen = h * 0.15;

      const drawTaper = (x0, y0, w0, x1, y1, w1, col) => {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const a0 = w0 * 0.5;
        const a1 = w1 * 0.5;
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(x0 + nx * a0, y0 + ny * a0);
        g.lineTo(x1 + nx * a1, y1 + ny * a1);
        g.lineTo(x1 - nx * a1, y1 - ny * a1);
        g.lineTo(x0 - nx * a0, y0 - ny * a0);
        g.closePath();
        g.fill();
      };

      const barkColor = (depth, jitter) => {
        const t = depth / MAX_DEPTH;
        const k = 0.82 + jitter * 0.32;
        const r = Math.round(lerp(58, 104, t) * k);
        const gg = Math.round(lerp(40, 78, t) * k);
        const b = Math.round(lerp(28, 56, t) * k);
        return `rgb(${clamp(r, 0, 255)},${clamp(gg, 0, 255)},${clamp(b, 0, 255)})`;
      };

      // grow one branch (a gently curved, tapering run of segments) then split.
      // windLean gently biases every angle downwind (to the right) so the whole
      // silhouette leans; sway later moves tips more than the trunk.
      const grow = (x, y, angle, length, width, depth, dist) => {
        if (depth > MAX_DEPTH || width < 0.5) return;
        const segs = clamp(6 - depth, 2, 6);
        const segLen = length / segs;
        const endW = width * 0.62;
        const col = barkColor(depth, rng());
        const windLean = 0.02;
        let px = x;
        let py = y;
        let a = angle;
        for (let s = 0; s < segs; s++) {
          a += (rng() - 0.5) * 0.18 + windLean;
          const w0 = lerp(width, endW, s / segs);
          const w1 = lerp(width, endW, (s + 1) / segs);
          const nx = px + Math.cos(a) * segLen;
          const ny = py + Math.sin(a) * segLen;
          drawTaper(px, py, w0, nx, ny, w1, col);
          // two samples per segment for a dense canopy of candidate slots
          for (let k = 1; k <= 2; k++) {
            const f = (s + k / 2) / segs;
            const sx = lerp(px, nx, k / 2);
            const sy = lerp(py, ny, k / 2);
            const hf = clamp((rootY - sy) / (h * 0.66), 0, 1);
            samples.push({ x: sx, y: sy, d: dist + segLen * f, h: hf });
          }
          px = nx;
          py = ny;
          dist += segLen;
        }

        if (depth === MAX_DEPTH) return;
        const spread = 0.4 + rng() * 0.35;
        const nCh = depth >= 2 && depth <= 5 && rng() < 0.18 ? 3 : 2;
        for (let c = 0; c < nCh; c++) {
          let off;
          if (nCh === 2) off = c === 0 ? -spread * 0.45 : spread * 0.8;
          else off = (c - 1) * spread * 0.85;
          const childA = a + off + windLean * 4;
          const childLen = length * (0.72 + rng() * 0.12);
          const childW = width * (0.64 + rng() * 0.08);
          grow(px, py, childA, childLen, childW, depth + 1, dist);
        }
      };

      grow(rootX, rootY, -Math.PI / 2, trunkLen, trunkW, 0, 0);

      // sort by path-distance and split into equal-count height bands
      samples.sort((p, q) => p.d - q.d);
      const N = samples.length;
      this.pos = new Array(nL * nE);
      this.hgt = new Float32Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const start = Math.floor((l / nL) * N);
        const end = Math.max(start + 1, Math.floor(((l + 1) / nL) * N));
        const band = samples.slice(start, end);
        band.sort((p, q) => p.x - q.x); // spread experts across the band width
        const m = band.length;
        for (let e = 0; e < nE; e++) {
          let idx = Math.floor(((e + rng() * 0.6) / nE) * m);
          idx = clamp(idx, 0, m - 1);
          const sp = band[idx];
          const i = l * nE + e;
          this.pos[i] = [sp.x, sp.y];
          this.hgt[i] = sp.h;
        }
      }

      // reaped experts: short grey lifeless twig stubs baked into the bark
      g.lineWidth = 1.6;
      g.strokeStyle = 'rgba(120,118,120,0.5)';
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (!model.isRemoved(l, e)) continue;
          const p = this.pos[l * nE + e];
          if (!p) continue;
          g.beginPath();
          g.moveTo(p[0], p[1]);
          g.lineTo(p[0] + (rng() - 0.5) * 5, p[1] - 5 - rng() * 4);
          g.stroke();
          g.fillStyle = 'rgba(110,108,110,0.45)';
          g.beginPath();
          g.arc(p[0], p[1], 1.4, 0, TAU);
          g.fill();
        }
      }

      samples.length = 0; // free the working set; positions are baked

      // glow sprites, built once
      this.sap = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        const hue = lerp(VLM.CATEGORY_HUES[cat], 45, 0.72);
        this.sap[cat] = VLM.makeGlowSprite(20, hue, 82, 72);
      }
      this.blossom = VLM.makeGlowSprite(16, 342, 64, 72); // rose-pink petal
      this.core = VLM.makeGlowSprite(11, 348, 30, 92); // white-pink hot core
      this.mote = VLM.makeGlowSprite(6, 340, 45, 84); // drifting petal

      // drifting petal motes — deterministic starts, animated from wallNow
      this.motes = [];
      const nMotes = 16;
      for (let k = 0; k < nMotes; k++) {
        this.motes.push({
          x0: rng() * w,
          y0: rng() * h,
          spd: 8 + rng() * 16,
          drift: 5 + rng() * 14,
          phase: rng() * TAU,
          swayA: 6 + rng() * 10,
          size: 3 + rng() * 3,
          off: rng() * 1000,
        });
      }
    },

    /* wind: rigid bark stays put; light/blossoms/motes sway, tips most */
    _sway(x, y, hf, wn) {
      const amp = (0.15 + hf * hf) * this.swayAmp;
      const ph = x * 0.012 + y * 0.01;
      return [
        x + Math.sin(wn * 0.7 + ph) * amp + Math.sin(wn * 1.7 + ph * 1.6) * amp * 0.35,
        y + Math.cos(wn * 0.55 + ph) * amp * 0.35,
      ];
    },

    /* deterministic petal cluster for a blooming cell (cached) */
    _bloomFor(i) {
      let b = this._bloom.get(i);
      if (b) return b;
      const r = VLM.mulberry32((Math.imul(i, 2654435761) ^ this._seed) >>> 0);
      const n = 2 + Math.floor(r() * 3);
      const petals = [];
      for (let k = 0; k < n; k++) {
        const ang = r() * TAU;
        const rad = 2 + r() * 5;
        petals.push({ ox: Math.cos(ang) * rad, oy: Math.sin(ang) * rad, sz: 7 + r() * 6 });
      }
      b = { petals };
      if (this._bloom.size > 400) this._bloom.clear();
      this._bloom.set(i, b);
      return b;
    },

    /* the route a token climbs: root base, then each layer's chosen expert */
    _pathFor(pulse) {
      let e = this.paths.get(pulse.tokenIdx);
      if (e) return e;
      const nE = this.model.nExperts;
      const pts = [[this.rootX, this.rootY]];
      const hgt = [0];
      for (let l = 0; l < this.model.nLayers; l++) {
        const hop = pulse.hops[l];
        if (!hop || !hop.experts.length) continue;
        const i = l * nE + hop.experts[0];
        const p = this.pos[i];
        if (!p) continue;
        pts.push([p[0], p[1]]);
        hgt.push(this.hgt[i]);
      }
      if (this.paths.size > 64) this.paths.clear();
      e = { pts, hgt };
      this.paths.set(pulse.tokenIdx, e);
      return e;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = model.nExperts;
      const wn = f.wallNow;

      VLM.fade(ctx, w, h, 0.085, this.fadeRGB); // trails

      // bark + moon, faint and constant beneath the light
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.staticCanvas, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // blossoms: the canopy flowers wherever the routing lives
      for (let l = 0; l < model.nLayers; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.04 || model.isRemoved(l, e)) continue;
          const i = l * nE + e;
          const p = this.pos[i];
          if (!p) continue;
          const s = this._sway(p[0], p[1], this.hgt[i], wn);
          const bl = this._bloomFor(i);
          const a = Math.pow(v, 0.7) * 0.7;
          for (let k = 0; k < bl.petals.length; k++) {
            const pt = bl.petals[k];
            VLM.drawSprite(ctx, this.blossom, s[0] + pt.ox, s[1] + pt.oy, pt.sz * (0.6 + v * 0.9), a);
          }
          if (v > 0.55) {
            VLM.drawSprite(ctx, this.core, s[0], s[1], 6 + 9 * v, ((v - 0.55) / 0.45) * 0.85);
          }
        }
      }

      // pulses: warm sap-light climbing the wood to the canopy
      for (const p of f.pulses) {
        const path = this._pathFor(p);
        const pts = path.pts;
        const hgt = path.hgt;
        if (pts.length < 2) continue;
        const sp = this._scratch;
        sp.length = 0;
        for (let i = 0; i < pts.length; i++) sp.push(this._sway(pts[i][0], pts[i][1], hgt[i], wn));

        const sprite = this.sap[p.cat] || this.sap.word;
        const t = p.progress;

        // soft trailing glow behind the head
        const TRAIL = 10;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.02;
          if (tt <= 0) continue;
          const q = VLM.splinePoint(sp, tt);
          const a = (1 - i / TRAIL) * 0.4 * p.glow;
          VLM.drawSprite(ctx, sprite, q[0], q[1], 14 - i * 0.6, a);
        }

        // the climbing head + a hot white sap core
        const head = VLM.splinePoint(sp, t);
        VLM.drawSprite(ctx, sprite, head[0], head[1], 20, 0.95 * p.glow);
        ctx.fillStyle = `rgba(255,248,225,${0.85 * p.glow})`;
        ctx.beginPath();
        ctx.arc(head[0], head[1], 1.6, 0, TAU);
        ctx.fill();
      }

      // drifting petal motes falling on the wind
      const span = h + 60;
      const wspan = w + 120;
      for (const m of this.motes) {
        const life = wn + m.off;
        const y = ((m.y0 + life * m.spd) % span) - 30;
        let x = m.x0 + life * m.drift + Math.sin(life * 0.6 + m.phase) * m.swayA;
        x = ((x % wspan) + wspan) % wspan - 60;
        const a = clamp(0.22 + 0.18 * Math.sin(life * 1.3 + m.phase), 0, 0.44);
        VLM.drawSprite(ctx, this.mote, x, y, m.size, a);
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: screen-space home of an expert node (base, unswayed)
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      return p ? [p[0], p[1]] : null;
    },

    dispose() {
      this.paths && this.paths.clear();
      this._bloom && this._bloom.clear();
      this.staticCanvas = null;
      this.pos = null;
      this.hgt = null;
      this.motes = null;
      this.sap = null;
      this.blossom = this.core = this.mote = null;
    },
  };

  VLM.registerStyle(S);
})();
