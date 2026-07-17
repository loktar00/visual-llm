/* visual-llm style: Spiral Galaxy — the model as a spiral galaxy at rest.
   Layers are distance from the galactic core (layer 0 innermost); experts are
   stars strewn along logarithmic spiral arms. Token pulses are comets that fly
   from the core to the rim, flaring each star they pass and popping as a tiny
   supernova when they land. Heat blooms into magenta-teal star-forming nebulae;
   reaped experts are dark dust voids that never light.

   Contract notes: fixed starfield stays put while the galaxy disk turns, so the
   static art is split across two offscreen canvases — one drawn straight (stars,
   core glow), one drawn under a slow rotation (arm stars, dust lanes, voids).
   All dynamic light (nebulae, flares, comets, pops) is rotated by that same
   angle so it stays registered with the baked arm stars. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;
  const ARMS = 3;
  const ROT_RATE = 0.012; // rad/s — an extremely slow turn of the whole disk

  const S = {
    id: 'galaxy',
    name: 'Spiral Galaxy',
    blurb: 'a mixture of experts as a spiral galaxy — tokens are comets flung from the core to the rim',
    bg: '#060418',
    fadeRGB: '6,4,24',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> spline points (base, unrotated)

      const cx = (this.cx = w * 0.5);
      const cy = (this.cy = h * 0.5);
      const nL = model.nLayers;
      const nE = model.nExperts;
      const mind = Math.min(w, h);
      const rMin = (this.rMin = mind * 0.05);
      const rMax = (this.rMax = mind * 0.46);

      // spiral geometry — deterministic per seed
      const totalWind = TAU * (1.2 + rng() * 0.3);
      const armPhase = [];
      for (let a = 0; a < ARMS; a++) armPhase.push((a / ARMS) * TAU + rng() * 0.25);
      const nPerArm = Math.ceil(nE / ARMS);
      const armPoint = (a, lt) => {
        const ang = armPhase[a] + lt * totalWind;
        const rad = rMin * Math.pow(rMax / rMin, lt);
        return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
      };

      // (layer, expert) -> star position. Each expert picks an arm and a rank
      // within it; radius grows exponentially with the layer (log spiral).
      // Jitter is multiplicative so lanes tighten toward the dense core.
      this.pos = new Array(nL * nE);
      this.layerT = new Array(nL);
      for (let l = 0; l < nL; l++) {
        const lt = nL > 1 ? l / (nL - 1) : 0.5;
        this.layerT[l] = lt;
        const radius = rMin * Math.pow(rMax / rMin, lt);
        for (let e = 0; e < nE; e++) {
          const arm = e % ARMS;
          const k = Math.floor(e / ARMS);
          const off = nPerArm > 1 ? k / (nPerArm - 1) - 0.5 : 0; // -0.5..0.5 in lane
          const ang = armPhase[arm] + lt * totalWind + off * 0.55 + (rng() - 0.5) * 0.1;
          const rr = radius * (1 + off * 0.18 + (rng() - 0.5) * 0.09);
          this.pos[l * nE + e] = [cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr];
        }
      }

      // a handful of bright foreground stars that twinkle with cross-flare
      this.brightStars = [];
      for (let i = 0; i < 18; i++) {
        this.brightStars.push({
          x: rng() * w,
          y: rng() * h,
          size: 2 + rng() * 3,
          phase: rng() * TAU,
          tw: 0.4 + rng() * 1.1,
        });
      }

      // glow sprites, built once
      this.cometHead = VLM.makeGlowSprite(26, 46, 70, 82); // white-gold head
      this.starFlare = VLM.makeGlowSprite(22, 45, 55, 84); // warm star flash
      this.spark = VLM.makeGlowSprite(18, 48, 25, 92); // supernova flash
      this.coreSprite = VLM.makeGlowSprite(140, 42, 65, 66); // breathing core
      this.nebMagenta = VLM.makeGlowSprite(96, 315, 75, 54);
      this.nebTeal = VLM.makeGlowSprite(96, 176, 70, 52);
      this.tailSprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.tailSprites[cat] = VLM.makeGlowSprite(20, VLM.CATEGORY_HUES[cat], 85, 66);
      }

      // ---- fixed offscreen: scattered starfield + warm core glow ----
      const sf = (this.starCanvas = document.createElement('canvas'));
      sf.width = Math.ceil(w);
      sf.height = Math.ceil(h);
      const sg = sf.getContext('2d');
      const N = Math.min(720, Math.floor((w * h) / 2400));
      for (let i = 0; i < N; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 0.4 + rng() * 1.0;
        const a = 0.12 + rng() * 0.5;
        sg.fillStyle = `rgba(${180 + ((rng() * 40) | 0)},${190 + ((rng() * 40) | 0)},${210 + ((rng() * 45) | 0)},${a})`;
        sg.beginPath();
        sg.arc(x, y, r, 0, TAU);
        sg.fill();
      }
      let cg = sg.createRadialGradient(cx, cy, 0, cx, cy, mind * 0.34);
      cg.addColorStop(0, 'rgba(255,232,196,0.42)');
      cg.addColorStop(0.25, 'rgba(255,206,150,0.20)');
      cg.addColorStop(0.6, 'rgba(150,120,180,0.07)');
      cg.addColorStop(1, 'rgba(20,16,40,0)');
      sg.fillStyle = cg;
      sg.fillRect(0, 0, w, h);
      cg = sg.createRadialGradient(cx, cy, 0, cx, cy, mind * 0.08);
      cg.addColorStop(0, 'rgba(255,248,230,0.58)');
      cg.addColorStop(1, 'rgba(255,230,190,0)');
      sg.fillStyle = cg;
      sg.fillRect(0, 0, w, h);

      // ---- rotating offscreen: dust lanes, dim arm stars, dark voids ----
      const gx = (this.galaxyCanvas = document.createElement('canvas'));
      gx.width = Math.ceil(w);
      gx.height = Math.ceil(h);
      const gg = gx.getContext('2d');
      gg.lineCap = 'round';
      gg.lineJoin = 'round';
      for (let a = 0; a < ARMS; a++) {
        const pts = [];
        for (let sI = 0; sI <= 26; sI++) pts.push(armPoint(a, sI / 26));
        gg.strokeStyle = 'rgba(120,90,110,0.05)';
        gg.lineWidth = mind * 0.035;
        VLM.spline(gg, pts);
        gg.strokeStyle = 'rgba(90,120,150,0.04)';
        gg.lineWidth = mind * 0.018;
        VLM.spline(gg, pts);
      }
      for (let l = 0; l < nL; l++) {
        const lt = this.layerT[l];
        for (let e = 0; e < nE; e++) {
          const [x, y] = this.pos[l * nE + e];
          if (model.isRemoved(l, e)) {
            const vg = gg.createRadialGradient(x, y, 0, x, y, 5);
            vg.addColorStop(0, 'rgba(64,46,34,0.30)');
            vg.addColorStop(1, 'rgba(30,22,18,0)');
            gg.fillStyle = vg;
            gg.beginPath();
            gg.arc(x, y, 5, 0, TAU);
            gg.fill();
            continue;
          }
          gg.fillStyle = `rgba(220,224,255,${0.18 + 0.5 * (1 - lt)})`;
          gg.beginPath();
          gg.arc(x, y, 0.7 + 1.0 * (1 - lt), 0, TAU);
          gg.fill();
        }
      }
    },

    /* Comet path: the galactic core, then the token's top-1 star at each layer.
       Points reference this.pos (base, unrotated) — sampled with splinePoint and
       rotated at draw time. Cached by stable tokenIdx. */
    _pathFor(pulse) {
      let pts = this.paths.get(pulse.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      pts = [[this.cx, this.cy]];
      for (let l = 0; l < this.model.nLayers; l++) {
        pts.push(this.pos[l * nE + pulse.hops[l].experts[0]]);
      }
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, pts);
      return pts;
    },

    _rot(x, y, c, s) {
      const dx = x - this.cx;
      const dy = y - this.cy;
      return [this.cx + dx * c - dy * s, this.cy + dx * s + dy * c];
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = model.nExperts;
      const nL = model.nLayers;
      const rot = f.wallNow * ROT_RATE;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      this._lc = c; // remembered for nodePos (reap lens tracks the turning disk)
      this._ls = s;

      VLM.fade(ctx, w, h, 0.09, this.fadeRGB);

      // fixed starfield + core glow, held constant beneath the light
      ctx.globalAlpha = 0.6;
      ctx.drawImage(this.starCanvas, 0, 0, w, h);
      ctx.globalAlpha = 1;

      // the galaxy disk, slowly turning
      ctx.save();
      ctx.translate(this.cx, this.cy);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.galaxyCanvas, -this.cx, -this.cy, w, h);
      ctx.restore();
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // breathing core shimmer — tiny per-frame alpha: additive light under a
      // 0.09 fade accumulates to ~11x its per-frame value at steady state
      const breathe = 0.85 + 0.15 * Math.sin(f.wallNow * 0.4);
      VLM.drawSprite(ctx, this.coreSprite, this.cx, this.cy, Math.min(w, h) * 0.5, 0.03 * breathe);

      // heat = star-forming nebulae (magenta / teal by expert parity) + a warm
      // glow on the hot star itself. Voids never light.
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.05) continue;
          if (model.isRemoved(l, e)) continue;
          const base = this.pos[l * nE + e];
          const [x, y] = this._rot(base[0], base[1], c, s);
          const neb = e & 1 ? this.nebTeal : this.nebMagenta;
          VLM.drawSprite(ctx, neb, x, y, Math.min(w, h) * (0.025 + 0.07 * v), Math.pow(v, 0.8) * 0.045);
          VLM.drawSprite(ctx, this.starFlare, x, y, 3 + 12 * v, v * 0.07);
        }
      }

      // foreground stars: twinkle + diffraction cross-flare (fixed positions)
      for (const st of this.brightStars) {
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f.wallNow * st.tw + st.phase));
        VLM.drawSprite(ctx, this.starFlare, st.x, st.y, st.size * 2.4, 0.06 * tw);
        const len = st.size * 2.6 * tw;
        ctx.strokeStyle = `rgba(220,230,255,${0.06 * tw})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(st.x - len, st.y);
        ctx.lineTo(st.x + len, st.y);
        ctx.moveTo(st.x, st.y - len);
        ctx.lineTo(st.x, st.y + len);
        ctx.stroke();
      }

      // comets
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const t = p.progress;
        const tail = this.tailSprites[p.cat] || this.tailSprites.word;

        // curved trailing tail — samples behind the head along the spiral path
        const TRAIL = 12;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.012;
          if (tt <= 0) continue;
          const b = VLM.splinePoint(pts, tt);
          const [x, y] = this._rot(b[0], b[1], c, s);
          VLM.drawSprite(ctx, tail, x, y, Math.max(2, 14 - i * 0.7), (1 - i / TRAIL) * 0.5 * p.glow);
        }

        // bright white-gold head
        const bh = VLM.splinePoint(pts, t);
        const [hx, hy] = this._rot(bh[0], bh[1], c, s);
        VLM.drawSprite(ctx, this.cometHead, hx, hy, 24, 0.95 * p.glow);
        ctx.fillStyle = `rgba(255,255,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 2, 0, TAU);
        ctx.fill();

        // star flare as the comet crosses a layer — top-1 strong, runner-up
        // weaker, scaled by weight. Voids never flare.
        const near = Math.round(p.layerFloat);
        if (p.progress < 1 && near >= 0 && near < nL) {
          const dist = Math.abs(p.layerFloat - near);
          if (dist < 0.5) {
            const hop = p.hops[near];
            const strength = (1 - dist * 2) * p.glow;
            for (let k = 0; k < Math.min(2, hop.experts.length); k++) {
              const e = hop.experts[k];
              if (model.isRemoved(near, e)) continue;
              const w8 = hop.weights[k] || 0;
              const base = this.pos[near * nE + e];
              const [x, y] = this._rot(base[0], base[1], c, s);
              if (k === 0) {
                VLM.drawSprite(ctx, this.starFlare, x, y, 12 + 32 * w8, strength * 0.9);
              } else {
                VLM.drawSprite(ctx, this.starFlare, x, y, 8 + 18 * w8, strength * 0.5 * Math.min(1, w8 * 1.6));
              }
            }
          }
        }

        // supernova pop on landing at the rim: expanding ring + flash
        if (p.progress >= 1) {
          const last = pts[pts.length - 1];
          const [x, y] = this._rot(last[0], last[1], c, s);
          const r = 6 + (1 - p.glow) * 40;
          VLM.drawSprite(ctx, this.spark, x, y, 8 + 30 * p.glow, 0.9 * p.glow);
          ctx.strokeStyle = VLM.hsla(p.hue, 85, 78, 0.6 * p.glow);
          ctx.lineWidth = 0.5 + 2 * p.glow;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.stroke();
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    // reap-lens support: expert star position, in the disk's current rotation
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      if (!p) return null;
      if (this._lc === undefined) return [p[0], p[1]];
      return this._rot(p[0], p[1], this._lc, this._ls);
    },

    dispose() {
      this.paths && this.paths.clear();
      this.paths = null;
      this.starCanvas = null;
      this.galaxyCanvas = null;
      this.cometHead = this.starFlare = this.spark = this.coreSprite = null;
      this.nebMagenta = this.nebTeal = this.tailSprites = null;
      this.pos = this.brightStars = null;
    },
  };

  VLM.registerStyle(S);
})();
