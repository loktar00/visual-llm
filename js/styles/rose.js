/* visual-llm style: Rose Window — the model as a great cathedral rose window.
   Concentric rings of glass panes are the layers (ring 0 innermost); the panes
   within a ring are its experts. At night the glass is dark; heat lights each
   pane from behind so the window slowly glows in the exact pattern of the
   routing — the model's stained-glass fingerprint. Token pulses are shafts of
   light stepping outward pane by pane, mirrored across the vertical axis into a
   kaleidoscope. Pruned experts are broken, cracked panes that never light.

   Contract: classic-script IIFE, deterministic layout from rng, static art on
   an offscreen canvas built in init (idempotent across resizes), prebuilt glow
   sprites, fade-based trails, per-token path cache, additive 'lighter' pass
   restored before return. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  // Jewel glass palette: ruby, sapphire, emerald, amber, violet, rose.
  const PALETTE = [
    { r: 182, g: 32, b: 56, h: 348 },
    { r: 38, g: 82, b: 196, h: 222 },
    { r: 26, g: 148, b: 98, h: 152 },
    { r: 226, g: 160, b: 46, h: 40 },
    { r: 138, g: 60, b: 190, h: 272 },
    { r: 216, g: 94, b: 134, h: 338 },
  ];
  const LEAD = 'rgba(7,8,13,1)';   // near-black came between panes
  const INSET = 1.4;               // half the lead gap, in px

  const S = {
    id: 'rose',
    name: 'Rose Window',
    blurb: 'the model as a cathedral rose window — light passes through pane by pane, and the glass remembers',
    bg: '#08070d',
    fadeRGB: '8,7,13',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.rays = new Map(); // tokenIdx -> centroid spline points

      const cx = (this.cx = w * 0.5);
      const cy = (this.cy = h * 0.5);
      const nL = model.nLayers;
      const nE = model.nExperts;
      const R = (this.R = Math.min(w, h) * 0.44);   // outer glass radius
      const rHub = (this.rHub = R * 0.15);          // central roundel hole
      const rRim = (this.rRim = R * 1.14);          // stone rim outer edge
      const slice = TAU / nE;

      // Per-ring geometry: radial band, a small rotation offset (so panes brick
      // rather than stack), and a few "petal" rings of gothic lens-shaped panes.
      const ring = new Array(nL);
      for (let l = 0; l < nL; l++) {
        const t0 = l / nL, t1 = (l + 1) / nL;
        ring[l] = {
          rIn: VLM.lerp(rHub, R, t0),
          rOut: VLM.lerp(rHub, R, t1),
          off: rng() * slice,
          petal: rng() < 0.22 && l > 0 && l < nL - 1,
        };
      }

      // Build every pane. Color is chosen to differ from the pane to its left
      // and the pane directly inward, so neighbors never share a jewel.
      const panes = (this.panes = new Array(nL * nE));
      const ci = new Int8Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const rg = ring[l];
        const rMid = (rg.rIn + rg.rOut) * 0.5;
        for (let e = 0; e < nE; e++) {
          const a0 = rg.off + e * slice;
          const aMid = a0 + slice * 0.5;
          const avoid = new Set();
          avoid.add(ci[l * nE + ((e - 1 + nE) % nE)]);
          if (l > 0) avoid.add(ci[(l - 1) * nE + e]);
          let c = 0;
          for (let tries = 0; tries < 8; tries++) {
            c = (rng() * PALETTE.length) | 0;
            if (!avoid.has(c)) break;
          }
          ci[l * nE + e] = c;
          panes[l * nE + e] = {
            l, e, a0, a1: a0 + slice, aMid,
            rIn: rg.rIn, rOut: rg.rOut, rMid,
            petal: rg.petal, ci: c,
            removed: model.isRemoved(l, e),
            px: cx + Math.cos(aMid) * rMid,
            py: cy + Math.sin(aMid) * rMid,
          };
        }
      }

      // Glow sprites (one per jewel, plus gold glint / landing flare / cloud).
      this.glow = PALETTE.map((p) => VLM.makeGlowSprite(64, p.h, 88, 60));
      this.glint = VLM.makeGlowSprite(48, 46, 80, 80);   // white-gold pulse head
      this.flare = VLM.makeGlowSprite(96, 44, 78, 82);   // landing on the rim
      this.cloud = VLM.makeGlowSprite(150, 214, 22, 72);  // ambient inner light

      // ---- static art: stone rim, dark glass, lead came, central flourish ----
      const off = (this.static = document.createElement('canvas'));
      off.width = Math.max(1, Math.ceil(w));
      off.height = Math.max(1, Math.ceil(h));
      const g = off.getContext('2d');
      g.lineJoin = 'round';
      g.lineCap = 'round';

      // Stone rim (radial gradient disc; panes cover the centre later).
      const sg = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, rRim);
      sg.addColorStop(0, '#17121c');
      sg.addColorStop(0.42, '#3b333f');
      sg.addColorStop(0.7, '#2a2430');
      sg.addColorStop(1, '#0b0910');
      g.fillStyle = sg;
      g.beginPath();
      g.arc(cx, cy, rRim, 0, TAU);
      g.fill();

      // Chiseled inner edge of the stone: a lit highlight and a seated shadow.
      g.strokeStyle = 'rgba(158,148,164,0.5)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, R + 5, 0, TAU);
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.lineWidth = 3.5;
      g.beginPath();
      g.arc(cx, cy, R + 1.5, 0, TAU);
      g.stroke();

      // Lead field beneath the glass — every gap between panes reads as came.
      g.fillStyle = LEAD;
      g.beginPath();
      g.arc(cx, cy, R, 0, TAU);
      g.fill();

      // Each pane: dark jewel glass at night, or a broken cracked pane.
      g.lineWidth = 2;
      for (let i = 0; i < panes.length; i++) {
        const p = panes[i];
        this._tracePane(g, p, INSET);
        if (p.removed) {
          g.fillStyle = 'rgba(5,5,9,1)';
          g.fill();
          g.strokeStyle = 'rgba(4,4,8,1)';
          g.stroke();
          this._drawCracks(g, p, rng);
        } else {
          const c = PALETTE[p.ci];
          g.fillStyle = `rgb(${(c.r * 0.16) | 0},${(c.g * 0.16) | 0},${(c.b * 0.16) | 0})`;
          g.fill();
          g.strokeStyle = LEAD;
          g.stroke();
        }
      }

      // Outer circular lead frame that seats the whole window in its stone.
      g.strokeStyle = 'rgba(4,4,8,1)';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(cx, cy, R - 0.5, 0, TAU);
      g.stroke();

      this._drawFlourish(g, cx, cy, rHub);
    },

    /* Trace a pane's inset outline onto ctx as a path (fill or stroke after).
       Sector rings are annular segments; petal rings are pointed glass lenses. */
    _tracePane(ctx, p, pad) {
      const cx = this.cx, cy = this.cy;
      if (p.petal) {
        const rIn = p.rIn + pad, rOut = p.rOut - pad, rMid = (rIn + rOut) * 0.5;
        const a = p.aMid;
        const spread = Math.max(0.012, (p.a1 - p.a0) * 0.5 - pad / Math.max(4, rMid) - 0.004);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
        ctx.quadraticCurveTo(
          cx + Math.cos(a - spread) * rMid, cy + Math.sin(a - spread) * rMid,
          cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut
        );
        ctx.quadraticCurveTo(
          cx + Math.cos(a + spread) * rMid, cy + Math.sin(a + spread) * rMid,
          cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn
        );
        ctx.closePath();
      } else {
        const angPad = pad / Math.max(4, p.rMid);
        let a0 = p.a0 + angPad, a1 = p.a1 - angPad;
        if (a1 <= a0) a0 = a1 = p.aMid;
        const rIn = p.rIn + pad, rOut = Math.max(rIn + 0.5, p.rOut - pad);
        ctx.beginPath();
        ctx.arc(cx, cy, rOut, a0, a1, false);
        ctx.arc(cx, cy, rIn, a1, a0, true);
        ctx.closePath();
      }
    },

    // Broken pane: a few cracks across the glass and a missing-shard notch.
    _drawCracks(g, p, rng) {
      const cx = this.cx, cy = this.cy;
      g.strokeStyle = 'rgba(124,132,150,0.42)';
      g.lineWidth = 1;
      const n = 2 + (rng() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const a0 = p.a0 + (p.a1 - p.a0) * rng();
        const a1 = p.a0 + (p.a1 - p.a0) * rng();
        const x0 = cx + Math.cos(a0) * (p.rIn + 2), y0 = cy + Math.sin(a0) * (p.rIn + 2);
        const x1 = cx + Math.cos(a1) * (p.rOut - 2), y1 = cy + Math.sin(a1) * (p.rOut - 2);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo((x0 + x1) * 0.5 + (rng() - 0.5) * 7, (y0 + y1) * 0.5 + (rng() - 0.5) * 7);
        g.lineTo(x1, y1);
        g.stroke();
      }
      const nr = p.rOut - 4, na = p.aMid + (rng() - 0.5) * (p.a1 - p.a0) * 0.5;
      g.fillStyle = 'rgba(3,3,6,1)';
      g.beginPath();
      g.arc(cx + Math.cos(na) * nr, cy + Math.sin(na) * nr, 3 + rng() * 2, 0, TAU);
      g.fill();
    },

    // Central roundel: a small quatrefoil flourish at the very heart.
    _drawFlourish(g, cx, cy, rHub) {
      const lobe = rHub * 0.52;
      g.fillStyle = 'rgb(18,10,24)';
      g.strokeStyle = LEAD;
      g.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        const a = k * (TAU / 4) - TAU / 8;
        const lx = cx + Math.cos(a) * rHub * 0.44;
        const ly = cy + Math.sin(a) * rHub * 0.44;
        g.beginPath();
        g.arc(lx, ly, lobe, 0, TAU);
        g.fill();
        g.stroke();
      }
      g.fillStyle = 'rgb(30,16,40)';
      g.beginPath();
      g.arc(cx, cy, rHub * 0.42, 0, TAU);
      g.fill();
      g.stroke();
    },

    /* Centroid path a token's shaft of light steps along: hub, then the top-1
       pane of each ring, outward. Cached per stable tokenIdx. */
    _pulsePath(pulse) {
      let pts = this.rays.get(pulse.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      pts = [[this.cx, this.cy]];
      for (let l = 0; l < this.model.nLayers; l++) {
        const hop = pulse.hops[l];
        const p = this.panes[l * nE + hop.experts[0]];
        pts.push([p.px, p.py]);
      }
      if (this.rays.size > 64) this.rays.clear();
      this.rays.set(pulse.tokenIdx, pts);
      return pts;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = model.nExperts;
      const cx = this.cx, cy = this.cy;

      // No fade/trail accumulation in this style: the window is repainted
      // opaque each frame and every light is computed fresh from current
      // heat/pulse state. (Re-blending the big dim stone disc at partial
      // alpha every frame triggers pale compositor halos around the rim.)
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(this.static, 0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';

      // Clouds passing outside: a very slow breathing of the window's light.
      // Kept inside the glass radius — additive light spilling past the stone
      // rim reads as a washed grey halo.
      const breath = 0.8 + 0.2 * Math.sin(f.wallNow * 0.33);
      VLM.drawSprite(ctx, this.cloud, cx, cy, this.R * 1.6, 0.14 * breath);

      // Heat lights the glass from behind. Hot panes glow their jewel; the
      // hottest bloom past their lead. Faint usage keeps a memory of routing.
      for (let l = 0; l < model.nLayers; l++) {
        for (let e = 0; e < nE; e++) {
          const p = this.panes[l * nE + e];
          if (p.removed) continue;
          const heat = f.heatAt(l, e);
          const bright = (heat * 0.9 + f.usageAt(l, e) * 0.1) * breath;
          if (bright < 0.03) continue;
          const c = PALETTE[p.ci];
          this._tracePane(ctx, p, INSET);
          // capped below 1 so hot glass stays its jewel color, never clips white
          ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${Math.min(0.8, bright)})`;
          ctx.fill();
          if (bright > 0.5) {
            const size = (p.rOut - p.rIn) * (1.3 + heat);
            VLM.drawSprite(ctx, this.glow[p.ci], p.px, p.py, size, (bright - 0.5) * 0.5);
          }
        }
      }

      // Token pulses: shafts of light stepping outward, mirrored kaleidoscopically.
      for (const pulse of f.pulses) {
        const pts = this._pulsePath(pulse);
        const tHead = pulse.progress;

        // Flare the pane the shaft is currently crossing to bright white-gold.
        if (tHead < 1) {
          const ringNear = Math.round(pulse.layerFloat);
          const dist = Math.abs(pulse.layerFloat - ringNear);
          if (dist < 0.5 && ringNear >= 0 && ringNear < model.nLayers) {
            const p = this.panes[ringNear * nE + pulse.hops[ringNear].experts[0]];
            if (!p.removed) {
              const a = (1 - dist * 2) * pulse.glow * 0.85;
              this._tracePane(ctx, p, INSET);
              ctx.fillStyle = `rgba(255,242,204,${a})`;
              ctx.fill();
            }
          }
        }

        // Traveling glint + its light ray, drawn once true and once mirrored.
        const [hx, hy] = VLM.splinePoint(pts, tHead);
        this._drawGlint(ctx, pts, tHead, hx, hy, pulse.glow, 1);
        this._drawGlint(ctx, pts, tHead, 2 * cx - hx, hy, pulse.glow, 0.35, true);

        // Landing: a soft radiant flare on the stone rim at the exit angle.
        if (tHead >= 1) {
          const last = pts[pts.length - 1];
          const ang = Math.atan2(last[1] - cy, last[0] - cx);
          const rr = (this.R + this.rRim) * 0.5;
          const lx = cx + Math.cos(ang) * rr, ly = cy + Math.sin(ang) * rr;
          const sz = (1 - pulse.glow) * 60 + 40;
          VLM.drawSprite(ctx, this.flare, lx, ly, sz, pulse.glow * 0.8);
          VLM.drawSprite(ctx, this.flare, 2 * cx - lx, ly, sz, pulse.glow * 0.28);
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    // A short bright comet along the spline ending at (hx,hy). Mirrored copies
    // pass mirrored=true to flip the sampled trail across the vertical axis.
    // Sprite samples only — a stroked polyline here reads as scratches across
    // the glass because consecutive pane centroids sit at very different angles.
    _drawGlint(ctx, pts, tHead, hx, hy, glow, alpha, mirrored) {
      if (glow <= 0) return;
      const cx = this.cx;
      for (let i = 5; i >= 1; i--) {
        const tt = tHead - i * 0.006;
        if (tt < 0) continue;
        let [x, y] = VLM.splinePoint(pts, tt);
        if (mirrored) x = 2 * cx - x;
        VLM.drawSprite(ctx, this.glint, x, y, 10 - i * 1.2, (1 - i / 6) * 0.4 * alpha * glow);
      }
      VLM.drawSprite(ctx, this.glint, hx, hy, 20 * glow + 6, 0.95 * alpha * glow);
    },

    // reap-lens support: pane centroid of an expert
    nodePos(l, e) {
      const p = this.panes && this.panes[l * this.model.nExperts + e];
      return p ? [p.px, p.py] : null;
    },

    dispose() {
      if (this.rays) this.rays.clear();
      this.static = null;
      this.glow = null;
      this.glint = this.flare = this.cloud = null;
      this.panes = null;
    },
  };

  VLM.registerStyle(S);
})();
