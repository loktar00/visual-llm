/* visual-llm style: Aurora Curtains — the model as northern lights over a
   frozen ridge. Layers are stacked wavy curtain bands filling the polar sky
   from just above a black mountain silhouette (layer 0) to the top of the
   frame. Experts are anchor positions strung along each band; where heat
   gathers a vertical ray climbs from the band baseline, deep green at the
   foot and shifting to pink-magenta at its tip. Token pulses are solar-wind
   surges that sweep upward band by band, a rising light tracing the route,
   blooming magenta at the top of the sky when the token lands. Pruned experts
   are permanent gaps the curtain never lights. The most abstract of the ten. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const SW = 40;   // streak sprite width
  const SH = 300;  // streak sprite height

  // A soft vertical streak: bright at the foot, feathered up and along the
  // sides. Built once; stretched with drawImage per ray.
  function makeStreak(rgb, stops) {
    const c = document.createElement('canvas');
    c.width = SW;
    c.height = SH;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, SH, 0, 0); // pos 0 = foot, 1 = tip
    for (const [pos, a] of stops) grad.addColorStop(pos, `rgba(${rgb},${a})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SW, SH);
    // feather the vertical edges so the ray has no hard sides
    g.globalCompositeOperation = 'destination-in';
    const m = g.createLinearGradient(0, 0, SW, 0);
    m.addColorStop(0, 'rgba(0,0,0,0)');
    m.addColorStop(0.5, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m;
    g.fillRect(0, 0, SW, SH);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  const S = {
    id: 'aurora',
    name: 'Aurora Curtains',
    blurb: 'the model as northern lights over a frozen ridge — heat climbs the sky in green and magenta',
    bg: '#03060d',
    fadeRGB: '3,6,13',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.pathCache = new Map(); // tokenIdx -> [[layer, expert], ...]

      const nL = (this.nL = model.nLayers);
      const nE = (this.nE = model.nExperts);

      const horizonY = (this.horizonY = h * 0.8);
      const skyBottom = h * 0.62; // baseline of band 0 (lowest), just above ridge
      const skyTop = h * 0.05;    // baseline of the top band
      const margin = w * 0.04;
      const usable = w - margin * 2;

      // Per-band curtain data: slow wavy baseline, plus sway + shimmer speeds.
      this.bands = [];
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 0.5 : l / (nL - 1);
        this.bands.push({
          y: VLM.lerp(skyBottom, skyTop, t),
          amp1: VLM.lerp(7, 17, rng()),
          freq1: VLM.TAU / (w * VLM.lerp(0.6, 1.3, rng())),
          speed1: VLM.lerp(0.12, 0.4, rng()) * (rng() < 0.5 ? -1 : 1),
          phase1: rng() * VLM.TAU,
          amp2: VLM.lerp(3, 8, rng()),
          freq2: VLM.TAU / (w * VLM.lerp(0.2, 0.5, rng())),
          speed2: VLM.lerp(0.2, 0.6, rng()),
          phase2: rng() * VLM.TAU,
          xAmp: VLM.lerp(2, 7, rng()),
          xSpeed: VLM.lerp(0.3, 0.9, rng()),
          xPhase: rng() * VLM.TAU,
          shSpeed: VLM.lerp(0.5, 1.4, rng()),
        });
      }

      // Anchor x per (layer, expert): spread across the band with light jitter
      // so the curtains never line up into rigid columns.
      this.anchorX = new Float32Array(nL * nE);
      this.removed = new Uint8Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          const base = margin + ((e + 0.5) / nE) * usable;
          this.anchorX[idx] = base + (rng() - 0.5) * (usable / nE) * 0.5;
          this.removed[idx] = model.isRemoved && model.isRemoved(l, e) ? 1 : 0;
        }
      }

      // Aurora streak sprites (green body, magenta tip, and a flipped green for
      // the ice reflection) + glow sprites for the pulse lights.
      this.green = makeStreak('130,255,178', [
        [0, 0.85], [0.35, 0.46], [0.7, 0.13], [1, 0],
      ]);
      this.magenta = makeStreak('255,132,220', [
        [0, 0], [0.4, 0.05], [0.75, 0.62], [0.92, 0.85], [1, 0],
      ]);
      this.greenFlip = document.createElement('canvas');
      this.greenFlip.width = SW;
      this.greenFlip.height = SH;
      const gf = this.greenFlip.getContext('2d');
      gf.translate(0, SH);
      gf.scale(1, -1);
      gf.drawImage(this.green, 0, 0);

      this.lead = VLM.makeGlowSprite(30, 150, 95, 82);  // white-green surge head
      this.bloom = VLM.makeGlowSprite(70, 315, 95, 72); // magenta landing bloom
      this.star = VLM.makeGlowSprite(5, 210, 25, 92);
      this.catSprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.catSprites[cat] = VLM.makeGlowSprite(22, VLM.CATEGORY_HUES[cat], 85, 70);
      }

      // ---- static night: haze, stars, black ridge — pre-rendered once ----
      const bg = (this.night = document.createElement('canvas'));
      bg.width = Math.ceil(w);
      bg.height = Math.ceil(h);
      const g = bg.getContext('2d');

      // faint horizon haze (distant aurora glow sitting on the ridge line)
      const haze = g.createLinearGradient(0, horizonY - 60, 0, horizonY + 12);
      haze.addColorStop(0, 'rgba(40,120,110,0)');
      haze.addColorStop(0.6, 'rgba(46,150,130,0.10)');
      haze.addColorStop(1, 'rgba(30,90,120,0)');
      g.fillStyle = haze;
      g.fillRect(0, horizonY - 60, w, 72);

      // sparse star field above the ridge
      const nStars = Math.min(420, Math.floor((w * h) / 7000));
      this.twinkle = [];
      for (let i = 0; i < nStars; i++) {
        const sx = rng() * w;
        const sy = rng() * (horizonY - 20);
        const b = 0.25 + rng() * 0.6;
        const r = rng() < 0.85 ? 0.6 : 1.1;
        g.fillStyle = `rgba(214,226,255,${b})`;
        g.beginPath();
        g.arc(sx, sy, r, 0, VLM.TAU);
        g.fill();
        if (this.twinkle.length < 30 && rng() < 0.12) {
          this.twinkle.push({ x: sx, y: sy, ph: rng() * VLM.TAU, sp: 0.6 + rng() * 1.6 });
        }
      }
      // a few extra stars showing through the permanent gaps left by pruning
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (!this.removed[l * nE + e]) continue;
          const gx = this.anchorX[l * nE + e];
          const gy = this.bands[l].y - rng() * 26;
          for (let k = 0; k < 2; k++) {
            g.fillStyle = `rgba(200,220,255,${0.2 + rng() * 0.35})`;
            g.beginPath();
            g.arc(gx + (rng() - 0.5) * 22, gy - rng() * 30, 0.7, 0, VLM.TAU);
            g.fill();
          }
        }
      }

      // jagged black mountain ridge sitting on the horizon
      g.fillStyle = '#000000';
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, horizonY);
      const steps = Math.max(24, Math.floor(w / 34));
      let ry = horizonY - h * 0.05;
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const target = horizonY - h * 0.03 - rng() * h * 0.08 - (rng() < 0.14 ? rng() * h * 0.07 : 0);
        ry = VLM.lerp(ry, target, 0.55) + (rng() - 0.5) * h * 0.02;
        g.lineTo(x, ry);
      }
      g.lineTo(w, horizonY);
      g.lineTo(w, h);
      g.closePath();
      g.fill();
    },

    /* ---------- ripple helpers (wallNow-driven so they live while paused) ---------- */

    _baseY(l, x, wn) {
      const b = this.bands[l];
      return (
        b.y +
        b.amp1 * Math.sin(x * b.freq1 + wn * b.speed1 + b.phase1) +
        b.amp2 * Math.sin(x * b.freq2 - wn * b.speed2 + b.phase2)
      );
    },

    _xSway(l, e, wn) {
      const b = this.bands[l];
      return b.xAmp * Math.sin(wn * b.xSpeed + e * 0.6 + b.xPhase);
    },

    _ray(ctx, x, baseY, H, W, gA, mA) {
      if (gA > 0.004) {
        ctx.globalAlpha = gA;
        ctx.drawImage(this.green, x - W / 2, baseY - H, W, H);
      }
      if (mA > 0.01) {
        const mw = W * 0.85;
        ctx.globalAlpha = mA;
        ctx.drawImage(this.magenta, x - mw / 2, baseY - H, mw, H);
      }
      ctx.globalAlpha = 1;
    },

    _reflect(ctx, x, H, W, a) {
      if (a < 0.01) return;
      ctx.globalAlpha = a;
      ctx.drawImage(this.greenFlip, x - W / 2, this.horizonY, W, H * 0.6);
      ctx.globalAlpha = 1;
    },

    // Rippled point sequence a token traces: its top-1 expert per layer,
    // bottom band to top. Identities cached; positions rebuilt each frame.
    _pathFor(p, wn) {
      let seq = this.pathCache.get(p.tokenIdx);
      if (!seq) {
        seq = [];
        for (let l = 0; l < this.nL; l++) seq.push([l, p.hops[l].experts[0]]);
        if (this.pathCache.size > 64) this.pathCache.clear();
        this.pathCache.set(p.tokenIdx, seq);
      }
      const pts = [];
      for (let i = 0; i < seq.length; i++) {
        const l = seq[i][0], e = seq[i][1];
        const x = this.anchorX[l * this.nE + e] + this._xSway(l, e, wn);
        pts.push([x, this._baseY(l, x, wn)]);
      }
      return pts;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h } = f;
      const nL = this.nL, nE = this.nE;
      const wn = f.wallNow;

      VLM.fade(ctx, w, h, 0.1, this.fadeRGB);

      // restore the static night on top of the faded frame (ridge stays crisp
      // and fully occludes; stars and haze hold steady)
      ctx.globalAlpha = 1;
      ctx.drawImage(this.night, 0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';

      // twinkle a handful of the brighter stars
      for (let i = 0; i < this.twinkle.length; i++) {
        const s = this.twinkle[i];
        const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(wn * s.sp + s.ph));
        VLM.drawSprite(ctx, this.star, s.x, s.y, 4.5, a);
      }

      // ---- ambient curtains: each band is one continuous translucent ribbon
      // following its wavy baseline — silk, not stamps. Very low per-frame
      // alpha; the additive accumulation under the fade does the rest. ----
      const RIB = 28; // baseline samples per ribbon
      for (let l = 0; l < nL; l++) {
        const b = this.bands[l];
        const sh = 0.5 + 0.5 * Math.sin(wn * b.shSpeed + b.phase1);
        const H = 34 + 14 * sh;
        const yRef = b.y;
        const grad = ctx.createLinearGradient(0, yRef - H, 0, yRef + 4);
        grad.addColorStop(0, 'rgba(120,255,170,0)');
        grad.addColorStop(0.75, 'rgba(125,255,175,0.55)');
        grad.addColorStop(1, 'rgba(160,255,200,0.9)');
        ctx.globalAlpha = 0.014 + 0.014 * sh;
        ctx.fillStyle = grad;
        ctx.beginPath();
        for (let i = 0; i <= RIB; i++) {
          const x = (i / RIB) * w;
          const y = this._baseY(l, x, wn);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = RIB; i >= 0; i--) {
          const x = (i / RIB) * w;
          ctx.lineTo(x, this._baseY(l, x, wn) - H);
        }
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ---- heat rays: where an expert is warm, a bright ray climbs the sky ----
      for (let l = 0; l < nL; l++) {
        const b = this.bands[l];
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          if (this.removed[idx]) continue;
          const v = f.heatAt(l, e);
          if (v < 0.03) continue;
          const x = this.anchorX[idx] + this._xSway(l, e, wn);
          const y = this._baseY(l, x, wn);
          const sh = 0.75 + 0.25 * Math.sin(wn * b.shSpeed + e * 0.8 + b.phase2);
          const H = 70 + 150 * v;
          const W = 16 + 18 * v;
          this._ray(ctx, x, y, H, W, (0.05 + 0.3 * v) * sh, Math.pow(v, 1.6) * 0.35);
          if (v > 0.18) this._reflect(ctx, x, H, W, 0.1 * v);
        }
      }

      // ---- pulses: solar-wind surges sweeping upward through the bands ----
      for (const p of f.pulses) {
        const pts = this._pathFor(p, wn);
        const lf = p.layerFloat;
        const glow = p.glow;

        // brighten the token's chosen experts in the bands around the wavefront
        const L0 = Math.max(0, Math.floor(lf - 1));
        const L1 = Math.min(nL - 1, Math.ceil(lf + 1));
        for (let l = L0; l <= L1; l++) {
          const env = 1 - Math.abs(lf - l);
          if (env <= 0.02) continue;
          const hop = p.hops[l];
          for (let k = 0; k < hop.experts.length; k++) {
            const e = hop.experts[k];
            if (this.removed[l * nE + e]) continue;
            const wgt = k === 0 ? 1 : hop.weights[k];
            const boost = env * wgt * glow;
            if (boost < 0.02) continue;
            const x = this.anchorX[l * nE + e] + this._xSway(l, e, wn);
            const y = this._baseY(l, x, wn);
            const H = 80 + 110 * boost;
            const W = 18 + 14 * boost;
            this._ray(ctx, x, y, H, W, 0.25 * boost + 0.1 * env, 0.5 * boost);
            this._reflect(ctx, x, H, W, 0.16 * boost);
            if (k === 0) {
              VLM.drawSprite(ctx, this.lead, x, y - H * 0.55, 26 + 26 * env, 0.5 * boost);
            }
          }
        }

        // the rising light itself — a smooth head tracing the route, faintly
        // tinted by the token's category hue
        const head = VLM.splinePoint(pts, VLM.clamp(p.progress, 0, 1));
        const cat = this.catSprites[p.cat] || this.catSprites.word;
        VLM.drawSprite(ctx, cat, head[0], head[1], 34, 0.4 * glow);
        VLM.drawSprite(ctx, this.lead, head[0], head[1], 22, 0.85 * glow);
        ctx.fillStyle = `rgba(235,255,240,${0.8 * glow})`;
        ctx.beginPath();
        ctx.arc(head[0], head[1], 1.7, 0, VLM.TAU);
        ctx.fill();

        // landing: a slow magenta bloom at the top of the sky
        if (p.progress >= 1) {
          const top = pts[pts.length - 1];
          const grow = 1 + (1 - glow) * 1.6;
          VLM.drawSprite(ctx, this.bloom, top[0], h * 0.06, 130 * grow, 0.5 * glow);
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: curtain anchor of an expert (baseline, no ripple)
    nodePos(l, e) {
      if (!this.anchorX || !this.bands) return null;
      return [this.anchorX[l * this.nE + e], this.bands[l].y];
    },

    dispose() {
      this.pathCache && this.pathCache.clear();
      this.night = null;
      this.green = null;
      this.magenta = null;
      this.greenFlip = null;
      this.lead = null;
      this.bloom = null;
      this.star = null;
      this.catSprites = null;
      this.twinkle = null;
    },
  };

  VLM.registerStyle(S);
})();
