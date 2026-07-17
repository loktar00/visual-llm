/* visual-llm style: River Delta — the model as a braided river delta seen from
   above at night. Flow runs top (the source token stream) to bottom (the sea).
   Layers are elevation bands descending the canvas; experts are channel
   positions fanning wider across each band as the delta spreads.

   The signature: routing WEIGHTS are made visible as splitting water. A token's
   surge follows the weighted blend of its top-2 experts, but at every band a
   dimmer droplet also breaks off toward the runner-up channel — you literally
   watch the current divide. Heat blooms as bioluminescent algae along the hot
   arteries; reaped experts are dry, cracked channel beds that never light. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const CYAN = 190; // base hue of the water light

  const S = {
    id: 'delta',
    name: 'River Delta',
    blurb: 'a braided river delta at night — routing weights split the water into glowing channels',
    bg: '#04090e',
    fadeRGB: '4,9,14',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> spline points

      const nL = model.nLayers;
      const nE = model.nExperts;
      const cx = (this.cx = w * 0.5);
      const topY = (this.topY = h * 0.07);
      const seaY = (this.seaY = h * 0.85);
      this.seaBand = h - seaY;

      // elevation bands down the canvas (layer 0 up top, near the source)
      this.bandY = new Array(nL);
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 1 : l / (nL - 1);
        this.bandY[l] = VLM.lerp(topY, seaY, Math.pow(t, 1.05));
      }

      // per-band horizontal wander so whole channels meander as they descend
      const bandShift = new Array(nL);
      for (let l = 0; l < nL; l++) bandShift[l] = (rng() - 0.5) * w * 0.05;

      // node positions: one channel per expert, the delta fanning wider toward
      // the sea, with organic jitter so the braids wander rather than align
      this.pos = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 1 : l / (nL - 1);
        const spanW = VLM.lerp(w * 0.1, w * 0.86, Math.pow(t, 0.8));
        const gap = spanW / Math.max(1, nE - 1);
        for (let e = 0; e < nE; e++) {
          const baseFrac = nE === 1 ? 0 : e / (nE - 1) - 0.5; // -0.5..0.5
          const jx = (rng() - 0.5) * gap * 0.6;
          const jy = (rng() - 0.5) * h * 0.012;
          this.pos[l * nE + e] = [cx + baseFrac * spanW + bandShift[l] + jx, this.bandY[l] + jy];
        }
      }
      const P = (l, e) => this.pos[l * nE + e];

      // glow sprites, built once
      this.spr = {};
      this.hueOf = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        // cyan-white water light carrying a hint of the category hue
        const hue = Math.round(VLM.lerp(VLM.CATEGORY_HUES[cat], CYAN, 0.7));
        this.hueOf[cat] = hue;
        this.spr[cat] = VLM.makeGlowSprite(22, hue, 66, 74);
      }
      this.algae = VLM.makeGlowSprite(30, 158, 85, 50); // bioluminescent teal-green
      this.algaeCore = VLM.makeGlowSprite(14, 150, 92, 78); // brighter confluence core

      // ---- static riverbed onto an offscreen canvas ----
      const bed = (this.bed = document.createElement('canvas'));
      bed.width = Math.ceil(w);
      bed.height = Math.ceil(h);
      const g = bed.getContext('2d');
      g.lineCap = 'round';

      // the sea: a dark band at the bottom with a faint horizon glow
      const sea = g.createLinearGradient(0, seaY, 0, h);
      sea.addColorStop(0, 'rgba(6,22,28,0.92)');
      sea.addColorStop(1, 'rgba(2,8,12,0.99)');
      g.fillStyle = sea;
      g.fillRect(0, seaY, w, h - seaY);
      const horizon = g.createLinearGradient(0, seaY - 26, 0, seaY + 10);
      horizon.addColorStop(0, 'rgba(30,96,116,0)');
      horizon.addColorStop(0.7, 'rgba(46,132,152,0.16)');
      horizon.addColorStop(1, 'rgba(18,58,74,0)');
      g.fillStyle = horizon;
      g.fillRect(0, seaY - 26, w, 36);

      // banks: speckles of dark sediment texture scattered above the sea
      const speckN = Math.floor((w * h) / 6500);
      for (let i = 0; i < speckN; i++) {
        const x = rng() * w;
        const y = rng() * seaY;
        const brown = rng() < 0.5;
        g.fillStyle = brown
          ? `rgba(46,40,28,${0.05 + rng() * 0.08})`
          : `rgba(26,38,34,${0.05 + rng() * 0.08})`;
        g.fillRect(x, y, 1 + rng() * 1.6, 1 + rng() * 1.2);
      }

      // braided channel network: from each expert, 2-3 smooth ribbons to nearby
      // experts of the next band. Deep blue-green and barely visible; channels
      // touching a reaped slot are drawn as faint dotted dry beds instead.
      for (let l = 0; l < nL - 1; l++) {
        const t = l / Math.max(1, nL - 1);
        const width = VLM.lerp(0.8, 2.3, t);
        for (let e = 0; e < nE; e++) {
          const [x0, y0] = P(l, e);
          const targets = [e];
          if (e - 1 >= 0 && rng() < 0.72) targets.push(e - 1);
          if (e + 1 < nE && rng() < 0.72) targets.push(e + 1);
          if (e + 2 < nE && rng() < 0.22) targets.push(e + 2);
          if (e - 2 >= 0 && rng() < 0.22) targets.push(e - 2);
          for (let ti = 0; ti < targets.length; ti++) {
            const te = targets[ti];
            const [x1, y1] = P(l + 1, te);
            const my = (y0 + y1) * 0.5;
            const dry = model.isRemoved(l, e) || model.isRemoved(l + 1, te);
            if (dry) {
              g.setLineDash([2, 5]);
              g.strokeStyle = 'rgba(126,110,82,0.09)';
              g.lineWidth = 1;
            } else {
              g.setLineDash([]);
              g.strokeStyle = `rgba(30,80,92,${0.05 + rng() * 0.045})`;
              g.lineWidth = width;
            }
            g.beginPath();
            g.moveTo(x0, y0);
            g.bezierCurveTo(x0, my, x1, my, x1, y1);
            g.stroke();
          }
        }
      }
      g.setLineDash([]);

      // dry, cracked-earth marks at every reaped channel head
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (!model.isRemoved(l, e)) continue;
          const [x, y] = P(l, e);
          g.setLineDash([2, 3]);
          g.strokeStyle = 'rgba(150,132,96,0.14)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x - 5, y);
          g.lineTo(x + 5, y);
          g.moveTo(x, y - 3);
          g.lineTo(x + 2, y + 4);
          g.stroke();
        }
      }
      g.setLineDash([]);
    },

    /* Main surge path: source at the top, then per-band a point pulled between
       the token's top-2 experts by their weights (branching made visible),
       finally spilling into the sea. Cached per token. */
    _pathFor(pulse) {
      let pts = this.paths.get(pulse.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      pts = [[this.cx, this.topY]];
      let lastX = this.cx;
      for (let l = 0; l < this.model.nLayers; l++) {
        const hop = pulse.hops[l];
        const a = this.pos[l * nE + hop.experts[0]];
        let x = a[0];
        let y = a[1];
        if (hop.experts.length > 1) {
          const b = this.pos[l * nE + hop.experts[1]];
          const wa = hop.weights[0];
          const wb = hop.weights[1];
          const fr = (wb / (wa + wb + 1e-6)) * 0.5; // lean toward runner-up
          x = VLM.lerp(a[0], b[0], fr);
          y = VLM.lerp(a[1], b[1], fr);
        }
        pts.push([x, y]);
        lastX = x;
      }
      pts.push([lastX, this.seaY + this.seaBand * 0.45]); // out to sea
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, pts);
      return pts;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = model.nLayers;
      const nE = model.nExperts;

      VLM.fade(ctx, w, h, 0.09, this.fadeRGB);

      // the riverbed beneath the light, faint and constant
      ctx.globalAlpha = 0.62;
      ctx.drawImage(this.bed, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // ambient shimmer skating across the sea surface
      for (let i = 0; i < 7; i++) {
        const ph = i * 1.7;
        const sx = (i / 7 + 0.04 * Math.sin(f.wallNow * 0.4 + ph)) * w;
        const a = 0.03 + 0.03 * (0.5 + 0.5 * Math.sin(f.wallNow * 0.8 + ph));
        VLM.drawSprite(ctx, this.spr.word, sx, this.seaY + 8 + 8 * Math.sin(ph), 44, a);
      }

      // the source river entering at the top center
      const srcB = 0.5 + 0.5 * Math.sin(f.wallNow * 0.7);
      VLM.drawSprite(ctx, this.spr.word, this.cx, this.topY, 26 + 6 * srcB, 0.18 + 0.06 * srcB);

      // bioluminescent algae: a persistent glow along worn arteries (usage) plus
      // a brighter recent bloom (heat), with the hottest confluences cored white
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue;
          const hv = f.heatAt(l, e);
          const uv = f.usageAt(l, e);
          if (hv < 0.03 && uv < 0.05) continue;
          const [x, y] = this.pos[l * nE + e];
          const bs = 0.82 + 0.18 * Math.sin(f.wallNow * 1.3 + l * 7 + e);
          if (uv >= 0.05) VLM.drawSprite(ctx, this.algae, x, y, 6 + 18 * uv, Math.pow(uv, 0.9) * 0.26 * bs);
          if (hv >= 0.03) {
            VLM.drawSprite(ctx, this.algae, x, y, 8 + 30 * hv, Math.pow(hv, 0.7) * 0.62 * bs);
            if (hv > 0.6) VLM.drawSprite(ctx, this.algaeCore, x, y, 6 + 10 * hv, (hv - 0.6) * 1.4 * 0.8);
          }
        }
      }

      // pulses: glowing surges flowing downstream, dividing at every band
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const t = p.progress;
        const spr = this.spr[p.cat] || this.spr.word;
        const hue = this.hueOf[p.cat] || CYAN;

        // trailing water light behind the head, dimming
        const TRAIL = 10;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.01;
          if (tt <= 0) continue;
          const [x, y] = VLM.splinePoint(pts, tt);
          const a = (1 - i / TRAIL) * 0.3 * p.glow;
          VLM.drawSprite(ctx, spr, x, y, 11 - i * 0.6, a);
        }

        // the surge head at the weighted blend position
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, spr, hx, hy, 20, 0.9 * p.glow);
        ctx.fillStyle = `rgba(230,252,255,${0.85 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.8, 0, VLM.TAU);
        ctx.fill();

        // THE SIGNATURE: as the head crosses a band, the current visibly splits
        // between its top-2 channels — a thread of light and a droplet run to
        // each expert, brightness scaled by that expert's routing weight
        const near = VLM.clamp(Math.round(p.layerFloat), 0, nL - 1);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.5 && p.progress < 1) {
          const hop = p.hops[near];
          const fall = 1 - dist * 2; // 1 at band center, 0 at the edges
          const k = Math.min(2, hop.experts.length);
          for (let j = 0; j < k; j++) {
            const q = this.pos[near * nE + hop.experts[j]];
            const wj = hop.weights[j];
            ctx.strokeStyle = VLM.hsla(hue, 80, 80, fall * wj * 0.5 * p.glow);
            ctx.lineWidth = 1 + 2 * wj;
            ctx.beginPath();
            ctx.moveTo(hx, hy);
            ctx.lineTo(q[0], q[1]);
            ctx.stroke();
            VLM.drawSprite(ctx, spr, q[0], q[1], 6 + 16 * wj, fall * wj * 0.85 * p.glow);
          }
        }

        // landing: the surge reaches the sea and rings out
        if (p.progress >= 1) {
          const last = pts[pts.length - 1];
          const r = (1 - p.glow) * 30 + 6;
          ctx.strokeStyle = VLM.hsla(hue, 80, 76, 0.5 * p.glow);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(last[0], last[1], r, 0, VLM.TAU);
          ctx.stroke();
          ctx.strokeStyle = VLM.hsla(hue, 80, 82, 0.3 * p.glow);
          ctx.beginPath();
          ctx.arc(last[0], last[1], r * 0.55, 0, VLM.TAU);
          ctx.stroke();
        }
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: screen-space home of an expert node
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      return p ? [p[0], p[1]] : null;
    },

    dispose() {
      this.paths && this.paths.clear();
      this.bed = null;
      this.spr = null;
    },
  };

  VLM.registerStyle(S);
})();
