/* visual-llm style: Neural Cortex — the model as a living brain.
   A brain silhouette in profile fills the frame. Layers are bands sweeping
   from the frontal lobe (layer 0) to the occipital pole (last layer); experts
   are neurons scattered with organic jitter inside their band — a soma dot
   with a few curved dendrites. A token pulse is an action potential: a white-
   cyan spark racing along a curved axon that threads its top-1 neuron in each
   layer, flashing somas and flickering dendrites as it passes. Heat pools as
   warm embers on the neurons the mind keeps using; pruned experts are dead
   husks scarring the tissue. The whole cortex breathes and drifts with glia.

   Follows STYLE_GUIDE.md: classic-script IIFE, deterministic rng layout,
   offscreen static art, prebuilt glow sprites, fade-based trails, per-token
   path caching, additive light pass restored to source-over. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  const S = {
    id: 'synapse',
    name: 'Neural Cortex',
    blurb: 'the model as a living brain — tokens fire as action potentials, memory pools as warm embers',
    bg: '#080612',
    fadeRGB: '8,6,18',

    /* ---------- brain outline (star-convex radial profile, faces left) ---------- */

    _shape(th) {
      const s = Math.sin(th), c = Math.cos(th);
      let r = 1.0;
      r += 0.05 * Math.cos(th - 0.25);      // gentle front/back asymmetry
      r += 0.045 * Math.cos(2 * th + 0.5);  // widen the frontal & occipital lobes
      r -= 0.045 * Math.cos(3 * th + 1.1);  // small surface lumps
      r += 0.05 * Math.max(0, -c);          // fuller forehead (left)
      r -= 0.06 * (s > 0 ? s * s : 0);      // flatten the temporal underside
      r += 0.03 * (s < 0 ? -s : 0);         // fuller cranial dome
      let d = th - 1.15;                     // brain-stem nub, lower-back
      d = Math.atan2(Math.sin(d), Math.cos(d));
      r += 0.1 * Math.exp(-(d * d) / 0.05);
      return r;
    },

    _inside(x, y, scale) {
      const dx = (x - this.cx) / this.rx, dy = (y - this.cy) / this.ry;
      const r = Math.hypot(dx, dy);
      if (r === 0) return true;
      return r <= this._shape(Math.atan2(dy, dx)) * scale;
    },

    /* ---------- layout + static art (idempotent; rebuilt on every resize) ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.nL = model.nLayers;
      this.nE = model.nExperts;
      this.paths = new Map(); // tokenIdx -> spline control points (top-1 axon)

      const nL = this.nL, nE = this.nE;
      const U = Math.min(w, h);
      const cx = (this.cx = w * 0.5);
      const cy = (this.cy = h * 0.52);
      const ry = (this.ry = Math.min(h * 0.42, w * 0.34));
      const rx = (this.rx = ry * 1.2);
      const shape = (th) => this._shape(th);

      // glow sprites — built once, drawn many
      this.spark = VLM.makeGlowSprite(26, 185, 90, 72);            // action potential
      this.mote = VLM.makeGlowSprite(16, 210, 55, 66);            // neuroglia
      this.embers = [];                                            // heat, cool->warm ramp
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        this.embers.push(VLM.makeGlowSprite(30, VLM.lerp(6, 44, t), 92, VLM.lerp(42, 74, t)));
      }

      // neuron positions (flat [x,y] pairs) + per-neuron dendrite geometry
      this.pos = new Array(nL * nE);
      this.dend = new Array(nL * nE);
      const bandW = rx * 0.035;
      const Ld = U * 0.02; // base dendrite length

      // offscreen tissue: silhouette, sulci, somas, dendrites, dead husks
      const off = (this.static = document.createElement('canvas'));
      off.width = Math.ceil(w);
      off.height = Math.ceil(h);
      const g = off.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      const trace = () => {
        g.beginPath();
        const N = 168;
        for (let i = 0; i <= N; i++) {
          const th = (i / N) * TAU;
          const rr = shape(th);
          const x = cx + Math.cos(th) * rx * rr;
          const y = cy + Math.sin(th) * ry * rr;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
      };

      // faint interior mass (clipped radial fill) for depth
      g.save();
      trace();
      g.clip();
      const rg = g.createRadialGradient(cx - rx * 0.15, cy, 0, cx, cy, Math.max(rx, ry) * 1.05);
      rg.addColorStop(0, 'rgba(42,36,74,0.5)');
      rg.addColorStop(0.6, 'rgba(23,19,46,0.32)');
      rg.addColorStop(1, 'rgba(10,8,22,0.04)');
      g.fillStyle = rg;
      g.fillRect(0, 0, w, h);
      g.restore();

      // outline stroke — very faint
      trace();
      g.strokeStyle = 'rgba(152,152,216,0.13)';
      g.lineWidth = 1.4;
      g.stroke();

      // sulci: the lateral fissure (temporal lobe) plus a shorter upper groove
      g.strokeStyle = 'rgba(140,140,206,0.09)';
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(cx - rx * 0.46, cy + ry * 0.04);
      g.bezierCurveTo(cx - rx * 0.15, cy + ry * 0.3, cx + rx * 0.22, cy + ry * 0.24, cx + rx * 0.52, cy - ry * 0.06);
      g.stroke();
      g.strokeStyle = 'rgba(140,140,206,0.06)';
      g.beginPath();
      g.moveTo(cx - rx * 0.3, cy - ry * 0.34);
      g.bezierCurveTo(cx - rx * 0.02, cy - ry * 0.16, cx + rx * 0.24, cy - ry * 0.2, cx + rx * 0.44, cy - ry * 0.38);
      g.stroke();

      // neurons, band by band (front -> back)
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 0.5 : l / (nL - 1);
        const bx = VLM.lerp(cx - rx * 0.7, cx + rx * 0.7, t);
        const fx = VLM.clamp((bx - cx) / rx, -0.999, 0.999);
        const vHalf = ry * Math.sqrt(1 - fx * fx); // ellipse half-height at this x
        for (let e = 0; e < nE; e++) {
          let vb = nE === 1 ? 0 : ((e + 0.5) / nE - 0.5) * 2;
          vb += (rng() - 0.5) * (2 / nE) * 1.25;
          let x = bx + (rng() - 0.5) * bandW * 2;
          let y = cy + vb * vHalf * 0.82;
          // pull inside the (inset) silhouette
          let tries = 0;
          while (!this._inside(x, y, 0.9) && tries < 10) {
            x = VLM.lerp(cx, x, 0.88);
            y = VLM.lerp(cy, y, 0.88);
            tries++;
          }
          const idx = l * nE + e;
          this.pos[idx] = [x, y];

          if (model.isRemoved(l, e)) {
            // dead neuron — dark husk with a faint scar, no dendrites, never lit
            this.dend[idx] = null;
            g.fillStyle = 'rgba(15,11,25,0.95)';
            g.beginPath();
            g.arc(x, y, 2.2, 0, TAU);
            g.fill();
            g.strokeStyle = 'rgba(72,60,96,0.26)';
            g.lineWidth = 0.8;
            g.beginPath();
            g.arc(x, y, 3.5, 0, TAU);
            g.stroke();
            continue;
          }

          // dendrites: 3-5 short curved strokes fanning from the soma
          const k = 3 + Math.floor(rng() * 3);
          const dends = [];
          for (let j = 0; j < k; j++) {
            const ang = rng() * TAU;
            const len = Ld * (0.7 + rng() * 0.9);
            const dxa = Math.cos(ang), dya = Math.sin(ang);
            const px = -dya, py = dxa; // perpendicular for the curve bow
            const c1 = [x + dxa * len * 0.5 + px * (rng() - 0.5) * len * 0.5,
                        y + dya * len * 0.5 + py * (rng() - 0.5) * len * 0.5];
            const c2 = [x + dxa * len, y + dya * len];
            dends.push([[x, y], c1, c2]);
          }
          this.dend[idx] = dends;

          g.strokeStyle = 'rgba(122,142,206,0.16)';
          g.lineWidth = 0.8;
          for (const d of dends) {
            g.beginPath();
            g.moveTo(d[0][0], d[0][1]);
            g.quadraticCurveTo(d[1][0], d[1][1], d[2][0], d[2][1]);
            g.stroke();
          }
          g.fillStyle = 'rgba(150,170,226,0.5)';
          g.beginPath();
          g.arc(x, y, 1.7, 0, TAU);
          g.fill();
          g.fillStyle = 'rgba(214,228,255,0.55)';
          g.beginPath();
          g.arc(x, y, 0.8, 0, TAU);
          g.fill();
        }
      }

      // neuroglia motes drifting inside the tissue (ambient, wall-clock driven)
      this.motes = [];
      const M = 44;
      for (let i = 0; i < M; i++) {
        const th = rng() * TAU;
        const rr = Math.sqrt(rng()) * 0.72 * shape(th);
        this.motes.push({
          x: cx + Math.cos(th) * rx * rr,
          y: cy + Math.sin(th) * ry * rr,
          ph: rng() * TAU,
          sp: 0.15 + rng() * 0.4,
          amp: U * 0.01 * (0.5 + rng()),
          rad: U * 0.01 * (0.6 + rng() * 0.8),
          a: 0.05 + rng() * 0.08,
        });
      }
    },

    /* Axon path for a token: its chosen top-1 neuron in each consecutive layer,
       smoothed by splinePoint. Cached by tokenIdx like the reference style. */
    _path(p) {
      let pts = this.paths.get(p.tokenIdx);
      if (pts) return pts;
      const nE = this.nE;
      pts = [];
      for (let l = 0; l < this.nL; l++) {
        const hop = p.hops[l];
        if (!hop) continue;
        const pos = this.pos[l * nE + hop.experts[0]];
        if (pos) pts.push(pos);
      }
      if (pts.length === 0) pts = [[this.cx, this.cy]];
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(p.tokenIdx, pts);
      return pts;
    },

    /* Fire a neuron: soma glow + white core + dendrite flicker (additive). */
    _flash(f, l, e, intensity) {
      if (intensity <= 0.01) return;
      const ctx = f.ctx;
      const idx = l * this.nE + e;
      const pos = this.pos[idx];
      if (!pos) return;
      VLM.drawSprite(ctx, this.spark, pos[0], pos[1], 13 + 20 * intensity, 0.7 * intensity);
      ctx.fillStyle = `rgba(232,252,255,${0.85 * intensity})`;
      ctx.beginPath();
      ctx.arc(pos[0], pos[1], 2.2, 0, TAU);
      ctx.fill();
      const dends = this.dend[idx];
      if (dends) {
        const flick = 0.55 + 0.45 * Math.sin(f.wallNow * 26 + idx);
        ctx.strokeStyle = `rgba(198,244,255,${0.5 * intensity * flick})`;
        ctx.lineWidth = 1;
        for (const d of dends) {
          ctx.beginPath();
          ctx.moveTo(d[0][0], d[0][1]);
          ctx.quadraticCurveTo(d[1][0], d[1][1], d[2][0], d[2][1]);
          ctx.stroke();
        }
      }
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = this.nL, nE = this.nE;

      // 1. fade previous frame — long, luminous afterglow
      VLM.fade(ctx, w, h, 0.085, this.fadeRGB);

      // 2. the tissue, redrawn dimly with a subtle breathing swell
      const breathe = 1 + 0.005 * Math.sin(f.wallNow * 0.6);
      ctx.globalAlpha = 0.55;
      ctx.save();
      ctx.translate(this.cx, this.cy);
      ctx.scale(breathe, breathe);
      ctx.translate(-this.cx, -this.cy);
      ctx.drawImage(this.static, 0, 0, w, h);
      ctx.restore();
      ctx.globalAlpha = 1;

      // 3. additive light pass
      ctx.globalCompositeOperation = 'lighter';

      // neuroglia motes: faint cool sparks drifting on the wall clock
      for (const m of this.motes) {
        const x = m.x + Math.sin(f.wallNow * m.sp + m.ph) * m.amp;
        const y = m.y + Math.cos(f.wallNow * m.sp * 0.8 + m.ph) * m.amp;
        const tw = 1.3 + 0.5 * Math.sin(f.wallNow * m.sp * 1.7 + m.ph);
        VLM.drawSprite(ctx, this.mote, x, y, m.rad * tw, m.a);
      }

      // heat: warm embers glowing on the neurons the mind keeps using
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue; // husks never light
          const v = f.heatAt(l, e);
          if (v < 0.04) continue;
          const pos = this.pos[l * nE + e];
          if (!pos) continue;
          const s = this.embers[Math.min(4, Math.floor(v * 5))];
          VLM.drawSprite(ctx, s, pos[0], pos[1], 6 + 30 * v, Math.pow(v, 0.7) * 0.8);
        }
      }

      // pulses: action potentials racing the axons
      for (const p of f.pulses) {
        const pts = this._path(p);
        const t = p.progress;

        // trailing afterglow — dimming samples behind the head
        const TRAIL = 10;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.01;
          if (tt <= 0) continue;
          const [x, y] = VLM.splinePoint(pts, tt);
          const a = (1 - i / TRAIL) * 0.4 * p.glow;
          VLM.drawSprite(ctx, this.spark, x, y, 4 + (1 - i / TRAIL) * 10, a);
        }

        // bright head + hot white core
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, this.spark, hx, hy, 20, 0.95 * p.glow);
        ctx.fillStyle = `rgba(236,253,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 2, 0, TAU);
        ctx.fill();

        // firing: flash the neuron under the spark (and, faintly, its runner-up)
        const near = Math.round(p.layerFloat);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.5 && p.progress > 0 && p.progress < 1) {
          const hop = p.hops[near];
          if (hop) {
            const inten = (1 - dist * 2) * p.glow;
            this._flash(f, near, hop.experts[0], inten);
            if (hop.experts.length > 1) {
              this._flash(f, near, hop.experts[1], inten * 0.55 * (hop.weights[1] || 0));
            }
          }
        }

        // landing bloom at the occipital pole
        if (p.progress >= 1) {
          const last = pts[pts.length - 1];
          const r = (1 - p.glow) * 30 + 6;
          ctx.strokeStyle = VLM.hsla(190, 90, 76, 0.5 * p.glow);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(last[0], last[1], r, 0, TAU);
          ctx.stroke();
        }
      }

      // 4. ALWAYS restore
      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: screen-space home of an expert node
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      return p ? [p[0], p[1]] : null;
    },

    dispose() {
      this.paths && this.paths.clear();
      this.static = null;
      this.spark = null;
      this.mote = null;
      this.embers = null;
      this.pos = null;
      this.dend = null;
      this.motes = null;
    },
  };

  VLM.registerStyle(S);
})();
