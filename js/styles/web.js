/* visual-llm style: Orb Weaver — the model as a spider's web at night.
   Layers are concentric rings (layer 0 innermost), experts are spokes.
   Token pulses are droplets of light running outward along silk threads;
   heat gathers as amber dew on the strands the light keeps touching.
   Reaped experts appear as torn spokes with dangling threads.

   REFERENCE STYLE — demonstrates the full contract in STYLE_GUIDE.md:
   deterministic layout from rng, offscreen static art, prerendered glow
   sprites, fade-based trails, per-token path caching, pulse rendering with
   VLM.splinePoint, heat rendering, and removed-expert ghosting. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const S = {
    id: 'web',
    name: 'Orb Weaver',
    blurb: 'the model as a spider’s web — tokens run the silk outward, heat gathers as amber dew',
    bg: '#04070e',
    fadeRGB: '4,7,14',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> spline points

      const cx = (this.cx = w * 0.5);
      const cy = (this.cy = h * 0.52);
      const rMin = (this.rMin = Math.min(w, h) * 0.05);
      const rMax = (this.rMax = Math.min(w, h) * 0.46);
      const nL = model.nLayers;
      const nE = model.nExperts;

      // node positions: ring per layer, spoke per expert, slight spiral twist
      // and per-node jitter so the web feels hand-spun, not mechanical
      this.pos = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const t = nL === 1 ? 1 : l / (nL - 1);
        const r = VLM.lerp(rMin, rMax, Math.pow(t, 0.85));
        for (let e = 0; e < nE; e++) {
          const a = (e / nE) * VLM.TAU + l * 0.045 + (rng() - 0.5) * 0.02;
          const rj = r * (1 + (rng() - 0.5) * 0.025);
          this.pos[l * nE + e] = [cx + Math.cos(a) * rj, cy + Math.sin(a) * rj];
        }
      }
      const P = (l, e) => this.pos[l * nE + e];

      // glow sprites, built once
      this.dew = VLM.makeGlowSprite(28, 38, 95, 60); // amber heat
      this.sprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.sprites[cat] = VLM.makeGlowSprite(24, VLM.CATEGORY_HUES[cat], 90, 66);
      }

      // static web on an offscreen canvas
      const web = (this.web = document.createElement('canvas'));
      web.width = Math.ceil(w);
      web.height = Math.ceil(h);
      const g = web.getContext('2d');
      g.lineCap = 'round';

      // anchor lines from the outer ring off the edges of the frame
      g.strokeStyle = 'rgba(185,205,255,0.10)';
      g.lineWidth = 1.1;
      const anchors = 7;
      for (let i = 0; i < anchors; i++) {
        const e = Math.floor((i / anchors) * nE);
        const [x, y] = P(nL - 1, e);
        const dx = x - cx, dy = y - cy;
        const len = Math.hypot(dx, dy) || 1;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (dx / len) * w, y + (dy / len) * h);
        g.stroke();
      }

      // radial spokes (curved because of the twist) — one per expert.
      // A spoke whose expert is pruned anywhere gets drawn broken there.
      g.strokeStyle = 'rgba(185,205,255,0.13)';
      g.lineWidth = 1;
      for (let e = 0; e < nE; e++) {
        for (let l = 0; l < nL - 1; l++) {
          const rm = model.isRemoved(l, e) || model.isRemoved(l + 1, e);
          const [x0, y0] = P(l, e);
          const [x1, y1] = P(l + 1, e);
          if (rm) {
            // torn silk: short dangling stub, then a gap
            g.strokeStyle = 'rgba(185,205,255,0.05)';
            g.beginPath();
            g.moveTo(x0, y0);
            g.lineTo(VLM.lerp(x0, x1, 0.3), VLM.lerp(y0, y1, 0.3) + 3);
            g.stroke();
            g.strokeStyle = 'rgba(185,205,255,0.13)';
            continue;
          }
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
          g.stroke();
        }
      }

      // ring threads with a gentle sag toward the center (classic orb web)
      for (let l = 0; l < nL; l++) {
        g.strokeStyle = `rgba(185,205,255,${l % 4 === 0 ? 0.16 : 0.09})`;
        g.lineWidth = l === nL - 1 ? 1.4 : 0.8;
        for (let e = 0; e < nE; e++) {
          const e2 = (e + 1) % nE;
          if (model.isRemoved(l, e) || model.isRemoved(l, e2)) continue; // torn pane
          const [x0, y0] = P(l, e);
          const [x1, y1] = P(l, e2);
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          const dx = mx - cx, dy = my - cy;
          const d = Math.hypot(dx, dy) || 1;
          const sag = Math.hypot(x1 - x0, y1 - y0) * 0.12;
          g.beginPath();
          g.moveTo(x0, y0);
          g.quadraticCurveTo(mx - (dx / d) * sag, my - (dy / d) * sag, x1, y1);
          g.stroke();
        }
      }

      // hub: a soft breath of light where tokens are born
      const hub = g.createRadialGradient(cx, cy, 0, cx, cy, rMin * 0.9);
      hub.addColorStop(0, 'rgba(200,215,255,0.05)');
      hub.addColorStop(1, 'rgba(200,215,255,0)');
      g.fillStyle = hub;
      g.beginPath();
      g.arc(cx, cy, rMin * 0.9, 0, VLM.TAU);
      g.fill();
    },

    /* Path a token takes: center hub, then per-layer a point pulled between
       its top-2 experts by their weights — branching made visible. */
    _pathFor(pulse) {
      let pts = this.paths.get(pulse.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      pts = [[this.cx, this.cy]];
      for (let l = 0; l < this.model.nLayers; l++) {
        const hop = pulse.hops[l];
        const a = this.pos[l * nE + hop.experts[0]];
        if (hop.experts.length > 1) {
          const b = this.pos[l * nE + hop.experts[1]];
          const wa = hop.weights[0], wb = hop.weights[1];
          const f = wb / (wa + wb + 1e-6) * 0.45; // lean toward runner-up
          pts.push([VLM.lerp(a[0], b[0], f), VLM.lerp(a[1], b[1], f)]);
        } else {
          pts.push([a[0], a[1]]);
        }
      }
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, pts);
      return pts;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = model.nExperts;

      VLM.fade(ctx, w, h, 0.1, this.fadeRGB);

      // the web itself, faint and constant beneath the light
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.web, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // amber dew where the heat lives
      for (let l = 0; l < model.nLayers; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.03) continue;
          const [x, y] = this.pos[l * nE + e];
          VLM.drawSprite(ctx, this.dew, x, y, 6 + 26 * v, Math.pow(v, 0.75) * 0.85);
        }
      }

      // pulses: droplets of light running the silk
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const t = p.progress;
        const sprite = this.sprites[p.cat] || this.sprites.word;

        // trailing streak — a few samples behind the head, dimming
        const TRAIL = 9;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.011;
          if (tt <= 0) continue;
          const [x, y] = VLM.splinePoint(pts, tt);
          const a = (1 - i / TRAIL) * 0.35 * p.glow;
          VLM.drawSprite(ctx, sprite, x, y, 10 - i * 0.6, a);
        }

        // head
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, sprite, hx, hy, 22, 0.95 * p.glow);
        ctx.fillStyle = `rgba(255,255,255,${0.85 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.8, 0, VLM.TAU);
        ctx.fill();

        // node flash as the droplet crosses each ring
        const near = Math.round(p.layerFloat);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.5 && p.progress < 1) {
          const hop = p.hops[near];
          const a = (1 - dist * 2) * 0.5 * p.glow;
          for (let k = 0; k < Math.min(2, hop.experts.length); k++) {
            const [x, y] = this.pos[near * nE + hop.experts[k]];
            VLM.drawSprite(ctx, sprite, x, y, 14 * hop.weights[k] * 4, a * hop.weights[k]);
          }
        }

        // landing bloom on the outer ring
        if (p.progress >= 1) {
          const [x, y] = pts[pts.length - 1];
          const r = (1 - p.glow) * 26 + 6;
          ctx.strokeStyle = VLM.hsla(p.hue, 85, 70, 0.5 * p.glow);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, VLM.TAU);
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
      this.web = null;
    },
  };

  VLM.registerStyle(S);
})();
