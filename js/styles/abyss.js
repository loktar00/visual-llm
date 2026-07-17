/* visual-llm style: The Abyss — the model as a deep-sea water column.
   Layers are depth strata from the moonlit surface (layer 0) down to the
   abyssal floor (last layer); experts are bioluminescent creatures scattered
   across each stratum. Tokens are motes of light sinking through the dark,
   swaying toward the top-1 creature of each layer and waking it as they pass —
   jellyfish near the surface, plankton and fish in the twilight, anglerfish and
   brittle stars in the black below. Heat is a soft plankton fog; hot deep
   dwellers keep their amber lures lit, the only warm color in the scene. Reaped
   experts are sunken husks that never wake. Marine snow drifts down forever. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;
  const { clamp, lerp } = VLM;

  const S = {
    id: 'abyss',
    name: 'The Abyss',
    blurb: 'tokens sink as motes of light, waking bioluminescent creatures in the deep',
    bg: '#02060a',
    fadeRGB: '2,6,10',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.paths = new Map(); // tokenIdx -> spline points

      const nL = model.nLayers;
      const nE = model.nExperts;

      const ySurface = (this.ySurface = h * 0.05);
      const yTop = (this.yTop = h * 0.12);
      const yBot = h * 0.9;
      this.yFloor = h * 0.955;
      const margin = w * 0.06;
      const bandH = ((yBot - yTop) / Math.max(1, nL - 1)) * 0.78;

      // Positions + creature descriptors. One deterministic pass so the same
      // seed always yields the same seascape. Creature kind is chosen by depth.
      this.px = new Float32Array(nL * nE);
      this.py = new Float32Array(nL * nE);
      this.creatures = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 0 : l / (nL - 1);
        const bandY = lerp(yTop, yBot, t);
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          const frac = (e + 0.5) / nE;
          const jx = (rng() - 0.5) * ((w - 2 * margin) / nE) * 1.3;
          this.px[idx] = clamp(margin + frac * (w - 2 * margin) + jx, margin * 0.5, w - margin * 0.5);
          this.py[idx] = bandY + (rng() - 0.5) * bandH;

          let type, base;
          if (t < 0.34) { type = 'jelly'; base = 8; }
          else if (t < 0.67) { type = rng() < 0.5 ? 'plankton' : 'fish'; base = 5; }
          else { type = rng() < 0.55 ? 'angler' : 'brittle'; base = 6; }

          const size = base * (0.72 + rng() * 0.6);
          const c = { type, size, removed: model.isRemoved(l, e), phase: rng() * TAU };
          if (type === 'jelly') {
            c.tent = 3 + (rng() < 0.5 ? 0 : 1);
            c.tlen = [rng() * 0.9, rng() * 0.9, rng() * 0.9, rng() * 0.9];
          } else if (type === 'plankton') {
            const dn = 4 + Math.floor(rng() * 4);
            c.dots = [];
            for (let i = 0; i < dn; i++) {
              c.dots.push([(rng() - 0.5) * size * 2.4, (rng() - 0.5) * size * 1.7, size * 0.18 * (0.6 + rng())]);
            }
          } else if (type === 'fish') {
            c.rot = (rng() - 0.5) * 0.6;
            c.flip = rng() < 0.5 ? 1 : -1;
          } else if (type === 'angler') {
            c.lox = (rng() - 0.5) * size * 1.2;
            c.loy = -size * (1.6 + rng() * 0.5);
          } else {
            c.rot = rng() * TAU;
          }
          this.creatures[idx] = c;
        }
      }

      // Marine snow: dim motes that drift down and sideways forever, wrapping.
      const snowN = Math.round(clamp(w / 22, 40, 90));
      this.snow = new Array(snowN);
      for (let i = 0; i < snowN; i++) {
        this.snow[i] = {
          x0: rng() * w, y0: rng() * h,
          vy: 6 + rng() * 10, vx: (rng() - 0.5) * 3,
          drift: 8 + rng() * 14, sw: 0.2 + rng() * 0.4, ph: rng() * TAU,
          size: 1.5 + rng() * 2.5, a: 0.12 + rng() * 0.2,
        };
      }
      this.causticN = Math.max(10, Math.round(w / 80));

      // Glow sprites, built once.
      this.mote = VLM.makeGlowSprite(20, 190, 80, 80);   // white-cyan sinking mote
      this.bio = VLM.makeGlowSprite(26, 172, 95, 62);    // cyan-teal wake flash
      this.fog = VLM.makeGlowSprite(30, 178, 70, 45);    // soft plankton fog
      this.lure = VLM.makeGlowSprite(16, 40, 95, 60);    // warm amber lure (rare)
      this.puff = VLM.makeGlowSprite(24, 190, 20, 62);   // pale sediment landing
      this.snowSprite = VLM.makeGlowSprite(4, 188, 30, 85);
      this.caustic = VLM.makeGlowSprite(50, 176, 60, 70);
      this.tint = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.tint[cat] = VLM.makeGlowSprite(16, VLM.CATEGORY_HUES[cat], 85, 60);
      }

      // Static art: depth gradient, a static caustic shimmer band, and every
      // creature drawn once as a very faint dormant outline (husks if reaped).
      const off = (this.static = document.createElement('canvas'));
      off.width = Math.ceil(w);
      off.height = Math.ceil(h);
      const g = off.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgb(14,42,46)');
      grad.addColorStop(0.12, 'rgb(8,26,32)');
      grad.addColorStop(0.4, 'rgb(3,11,15)');
      grad.addColorStop(1, 'rgb(0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      g.strokeStyle = 'rgba(120,205,205,0.05)';
      g.lineWidth = 1;
      for (let li = 0; li < 4; li++) {
        const yy = lerp(4, ySurface + 12, li / 3);
        g.beginPath();
        for (let sx = 0; sx <= w; sx += 14) {
          const yo = Math.sin(sx * 0.03 + li * 1.7) * 3;
          if (sx === 0) g.moveTo(sx, yy + yo); else g.lineTo(sx, yy + yo);
        }
        g.stroke();
      }

      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          const c = this.creatures[idx];
          if (c.removed) {
            g.strokeStyle = 'rgba(200,205,195,0.05)';
            g.fillStyle = 'rgba(200,205,195,0.045)';
          } else {
            g.strokeStyle = 'rgba(150,195,200,0.075)';
            g.fillStyle = 'rgba(150,200,205,0.06)';
          }
          g.lineWidth = 1;
          this._shape(g, c, this.px[idx], this.py[idx], 0, 0);
        }
      }
    },

    /* Draw a creature's line/fill geometry with the caller's current stroke and
       fill styles. `pulse` (0..1) swells a jellyfish dome; `sway` animates
       tentacles. Shared by the dim static pass and the bright lit pass. */
    _shape(g, c, x, y, sway, pulse) {
      const s = c.size;
      if (c.type === 'jelly') {
        const r = s * (1 + 0.25 * (pulse || 0));
        g.beginPath();
        g.ellipse(x, y, r, r * 0.72, 0, Math.PI, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(x - r, y);
        g.quadraticCurveTo(x, y + r * 0.3, x + r, y);
        g.stroke();
        const tn = c.tent;
        for (let i = 0; i < tn; i++) {
          const tx = x + lerp(-r * 0.65, r * 0.65, tn === 1 ? 0.5 : i / (tn - 1));
          const len = r * (1.5 + c.tlen[i]);
          const sw = Math.sin(sway + i * 1.3) * r * 0.35;
          g.beginPath();
          g.moveTo(tx, y + r * 0.2);
          g.quadraticCurveTo(tx + sw, y + len * 0.55, tx + sw * 0.4, y + len);
          g.stroke();
        }
      } else if (c.type === 'plankton') {
        for (let i = 0; i < c.dots.length; i++) {
          const d = c.dots[i];
          g.beginPath();
          g.arc(x + d[0], y + d[1], d[2], 0, TAU);
          g.fill();
        }
      } else if (c.type === 'fish') {
        g.save();
        g.translate(x, y);
        g.rotate(c.rot);
        g.scale(c.flip, 1);
        g.beginPath();
        g.ellipse(0, 0, s, s * 0.5, 0, 0, TAU);
        g.fill();
        g.beginPath();
        g.moveTo(-s, 0);
        g.lineTo(-s - s * 0.7, -s * 0.45);
        g.lineTo(-s - s * 0.7, s * 0.45);
        g.closePath();
        g.stroke();
        g.restore();
      } else if (c.type === 'angler') {
        g.beginPath();
        g.ellipse(x, y, s, s * 0.7, 0, 0, TAU);
        g.stroke();
        g.beginPath();
        g.moveTo(x + s * 0.2, y - s * 0.5);
        g.quadraticCurveTo(x + c.lox * 1.4, y + c.loy * 0.6, x + c.lox, y + c.loy);
        g.stroke();
        g.beginPath();
        g.arc(x + c.lox, y + c.loy, s * 0.16, 0, TAU);
        g.fill();
      } else { // brittle star
        g.beginPath();
        g.arc(x, y, s * 0.3, 0, TAU);
        g.fill();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * TAU + c.rot;
          const ex = x + Math.cos(a) * s * 1.9, ey = y + Math.sin(a) * s * 1.9;
          const mx = x + Math.cos(a + 0.5) * s, my = y + Math.sin(a + 0.5) * s;
          g.beginPath();
          g.moveTo(x, y);
          g.quadraticCurveTo(mx, my, ex, ey);
          g.stroke();
        }
      }
    },

    /* Sinking path for a token: enter above the surface, thread through each
       layer's top-1 creature (Catmull-Rom makes the gentle S-curves), settle on
       the abyssal floor. Cached per token. */
    _pathFor(p) {
      let pts = this.paths.get(p.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      const nL = this.model.nLayers;
      pts = [[this.px[p.hops[0].experts[0]], this.yTop - 24]];
      for (let l = 0; l < nL; l++) {
        const idx = l * nE + p.hops[l].experts[0];
        pts.push([this.px[idx], this.py[idx]]);
      }
      const lastX = pts[pts.length - 1][0];
      const j = ((p.tokenIdx * 53) % 40) - 20;
      pts.push([clamp(lastX + j, 20, this.w - 20), this.yFloor]);
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(p.tokenIdx, pts);
      return pts;
    },

    /* A creature waking (or a runner-up glinting) on the additive pass. */
    _wake(ctx, l, e, intensity, wallNow, rings) {
      if (intensity <= 0.01) return;
      if (this.model.isRemoved(l, e)) return;
      const idx = l * this.model.nExperts + e;
      const c = this.creatures[idx];
      const x = this.px[idx], y = this.py[idx];
      const a = Math.min(0.9, intensity);

      VLM.drawSprite(ctx, this.bio, x, y, c.size * 4 + 10, Math.min(0.85, intensity * 0.8));
      ctx.strokeStyle = `rgba(170,255,238,${a})`;
      ctx.fillStyle = `rgba(205,255,246,${a})`;
      ctx.lineWidth = 1.3;
      this._shape(ctx, c, x, y, Math.sin(wallNow * 2 + c.phase) * 0.6, intensity);

      if (rings) {
        for (let k = 0; k < 2; k++) {
          const rr = c.size * (1.5 + (1 - intensity) * 6) + k * c.size * 1.3;
          const ra = intensity * 0.5 * (1 - k * 0.4);
          ctx.strokeStyle = `rgba(150,255,235,${ra})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, TAU);
          ctx.stroke();
        }
      }
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = model.nExperts;
      const nL = model.nLayers;
      const wallNow = f.wallNow;

      // Long lamp-like trails, then restore the water column beneath.
      VLM.fade(ctx, w, h, 0.085, this.fadeRGB);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.static, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // Surface caustics shimmering with wall time.
      for (let i = 0; i < this.causticN; i++) {
        const x = ((i + 0.5) / this.causticN) * w;
        const ca = (0.35 + 0.35 * Math.sin(wallNow * 0.9 + i * 0.9)) * 0.14;
        const cy = this.ySurface + Math.sin(wallNow * 0.6 + i) * 6;
        VLM.drawSprite(ctx, this.caustic, x, cy, 92, ca);
      }

      // Marine snow drifting endlessly downward and sideways, wrapping.
      for (let i = 0; i < this.snow.length; i++) {
        const s = this.snow[i];
        const drift = Math.sin(wallNow * s.sw + s.ph) * s.drift;
        const xx = (((s.x0 + drift + wallNow * s.vx) % w) + w) % w;
        const yy = (((s.y0 + wallNow * s.vy) % h) + h) % h;
        VLM.drawSprite(ctx, this.snowSprite, xx, yy, s.size, s.a);
      }

      // Heat: bioluminescent plankton fog; hot anglers keep their amber lures.
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue;
          const v = f.heatAt(l, e);
          if (v < 0.04) continue;
          const idx = l * nE + e;
          const x = this.px[idx], y = this.py[idx];
          const c = this.creatures[idx];
          VLM.drawSprite(ctx, this.fog, x, y, 10 + 34 * v, Math.pow(v, 0.8) * 0.4);
          if (c.type === 'angler' && v > 0.3) {
            const lx = x + c.lox, ly = y + c.loy;
            VLM.drawSprite(ctx, this.lure, lx, ly, 6 + 10 * v, v * 0.6);
            ctx.fillStyle = `rgba(255,214,150,${v * 0.85})`;
            ctx.beginPath();
            ctx.arc(lx, ly, 1.6, 0, TAU);
            ctx.fill();
          }
        }
      }

      // Pulses: motes of light sinking through the column.
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const t = p.progress;
        const tint = this.tint[p.cat] || this.tint.word;

        // Sinking streak: a few dimming samples behind the head.
        const TRAIL = 8;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.012;
          if (tt <= 0) continue;
          const [tx, ty] = VLM.splinePoint(pts, tt);
          VLM.drawSprite(ctx, this.mote, tx, ty, 14 - i * 0.7, (1 - i / TRAIL) * 0.3 * p.glow);
        }

        // Head: white-cyan lamp with a faint category-hue tint.
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, tint, hx, hy, 20, 0.35 * p.glow);
        VLM.drawSprite(ctx, this.mote, hx, hy, 26, 0.9 * p.glow);
        ctx.fillStyle = `rgba(230,255,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.8, 0, TAU);
        ctx.fill();

        // Waking the creatures the mote passes.
        const near = clamp(Math.round(p.layerFloat), 0, nL - 1);
        const dist = Math.abs(p.layerFloat - near);
        if (p.progress < 1 && dist < 0.5) {
          const hop = p.hops[near];
          const wake = (1 - dist * 2) * p.glow;
          this._wake(ctx, near, hop.experts[0], wake, wallNow, true);
          if (hop.experts.length > 1) {
            this._wake(ctx, near, hop.experts[1], wake * (hop.weights[1] || 0) * 0.8, wallNow, false);
          }
        }

        // Landing: a tiny sediment puff blooming on the floor.
        if (p.progress >= 1) {
          const end = pts[pts.length - 1];
          VLM.drawSprite(ctx, this.puff, end[0], end[1], (1 - p.glow) * 40 + 8, p.glow * 0.5);
        }
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: screen-space home of an expert creature
    nodePos(l, e) {
      if (!this.px) return null;
      const i = l * this.model.nExperts + e;
      return [this.px[i], this.py[i]];
    },

    dispose() {
      this.paths && this.paths.clear();
      this.static = null;
      this.creatures = null;
      this.snow = null;
      this.px = null;
      this.py = null;
    },
  };

  VLM.registerStyle(S);
})();
