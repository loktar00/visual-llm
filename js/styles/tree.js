/* visual-llm style: Illuminated Tree — the model as a golden tree-of-life
   from an illuminated manuscript. Tokens enter at the roots (bottom) and
   climb as beads of light up the trunk, through the top-1 expert of each
   layer-tier, to bloom at the crown. Tiers are gentle arcs that widen toward
   the top so the whole envelope reads as a tree. Heat swells the nodes into
   glowing lanterns/fruit; reaped experts are dry grey stubs — gaps in the
   crown where a branch was pruned. Thin gold ink on deep indigo. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const INK = '198,160,96';   // gold ink for the static lattice/trunk
  const GOLD_HUE = 44;

  const S = {
    id: 'tree',
    name: 'Illuminated Tree',
    blurb: 'the model as a golden tree-of-life — tokens climb from root to crown as beads of light',
    bg: '#0c0a22',
    fadeRGB: '12,10,34',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> spline points

      const nL = (this.nL = model.nLayers);
      const nE = (this.nE = model.nExperts);
      const cx = (this.cx = w * 0.5);

      // Vertical envelope: layer 0 (roots) low, last layer (crown) high.
      const topMargin = h * 0.10;
      const bottomTier = h * 0.80;
      const groundY = (this.groundY = h * 0.885);
      const wBottom = Math.min(w, h) * 0.055; // narrow near the trunk base
      const wWide = w * 0.43;                  // broad canopy at the crown

      const tierT = (l) => (nL === 1 ? 1 : l / (nL - 1));
      const tierY = (this.tierY = new Array(nL));
      const tierHW = (this.tierHW = new Array(nL));
      for (let l = 0; l < nL; l++) {
        const t = tierT(l);
        tierY[l] = VLM.lerp(bottomTier, topMargin, t);
        tierHW[l] = VLM.lerp(wBottom, wWide, Math.pow(t, 0.72));
      }

      // Node positions: each tier a shallow smile-arc, edges sweeping upward.
      this.pos = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const hw = tierHW[l];
        const bow = hw * 0.11;
        for (let e = 0; e < nE; e++) {
          const u = nE === 1 ? 0 : (e / (nE - 1)) * 2 - 1;
          const x = cx + u * hw + (rng() - 0.5) * 3;
          const y = tierY[l] + bow * (1 - u * u) + (rng() - 0.5) * 3;
          this.pos[l * nE + e] = [x, y];
        }
      }
      const P = (l, e) => this.pos[l * nE + e];

      // Central spine of the trunk: ground anchor up through each tier centre.
      const spine = [[cx, h * 0.965], [cx, groundY]];
      for (let l = 0; l < nL; l++) spine.push([cx, tierY[l] + tierHW[l] * 0.11]);
      this.spine = spine;

      // ---- glow sprites (built once) ----
      this.halo = VLM.makeGlowSprite(40, GOLD_HUE, 78, 58);  // heat lanterns
      this.bead = VLM.makeGlowSprite(26, 46, 86, 64);        // climbing light
      this.flareS = VLM.makeGlowSprite(30, 40, 82, 62);      // node flares

      // ---- static art, pre-rendered to an offscreen canvas ----
      const art = (this.art = document.createElement('canvas'));
      art.width = Math.ceil(w);
      art.height = Math.ceil(h);
      const g = art.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      this._drawTrunk(g);
      this._drawLattice(g, P);
      this._drawStubs(g, P);
      this._drawRoots(g, groundY);

      // Gold-leaf flecks: scattered within the silhouette. Baked faintly for
      // the base composition, kept in a list for the per-frame glimmer.
      const nFleck = Math.round(VLM.clamp(nE * 0.8, 30, 54));
      const flecks = (this.flecks = []);
      for (let i = 0; i < nFleck; i++) {
        const l = Math.floor(rng() * nL);
        const u = (rng() - 0.5) * 2.1;
        const fx = cx + u * tierHW[l] + (rng() - 0.5) * 24;
        const fy = tierY[l] + (rng() - 0.5) * 40;
        const size = 2 + rng() * 3.5;
        flecks.push({ x: fx, y: fy, size, phase: rng() * VLM.TAU, spd: 0.4 + rng() * 0.9 });
        g.fillStyle = `rgba(${INK},0.16)`;
        g.beginPath();
        g.arc(fx, fy, size * 0.5, 0, VLM.TAU);
        g.fill();
      }
    },

    // Filled, tapering gold trunk with a bright calligraphic centre-line.
    _drawTrunk(g) {
      const sp = this.spine;
      const n = sp.length;
      const baseThk = Math.min(this.w, this.h) * 0.011;
      const tipThk = 0.6;
      const thk = (i) => VLM.lerp(baseThk, tipThk, i / (n - 1));

      g.beginPath();
      g.moveTo(sp[0][0] - baseThk * 1.2, sp[0][1]);
      for (let i = 0; i < n; i++) g.lineTo(sp[i][0] - thk(i), sp[i][1]);
      for (let i = n - 1; i >= 0; i--) g.lineTo(sp[i][0] + thk(i), sp[i][1]);
      g.closePath();
      // airy wash, not a solid wedge — the calligraphic centre-line carries it
      const grad = g.createLinearGradient(0, sp[n - 1][1], 0, this.groundY);
      grad.addColorStop(0, 'rgba(232,200,130,0.22)');
      grad.addColorStop(0.6, 'rgba(205,166,98,0.16)');
      grad.addColorStop(1, 'rgba(150,112,54,0.12)');
      g.fillStyle = grad;
      g.fill();

      g.strokeStyle = 'rgba(238,208,140,0.42)';
      g.lineWidth = 1;
      VLM.spline(g, sp, 8);
    },

    // Sparse, airy lattice: 2-3 curved strokes from each node to its nearest
    // neighbours in the next tier only. Nothing all-pairs; nothing to a stub.
    _drawLattice(g, P) {
      const nL = this.nL, nE = this.nE, cx = this.cx, rng = this.rng, m = this.model;
      g.lineWidth = 1;
      for (let l = 0; l < nL - 1; l++) {
        for (let e = 0; e < nE; e++) {
          if (m.isRemoved(l, e)) continue;
          const targets = [e]; // nearest is the same fractional slot
          const pool = [];
          if (e > 0) pool.push(e - 1);
          if (e < nE - 1) pool.push(e + 1);
          if (pool.length && rng() < 0.85) targets.push(pool[rng() < 0.5 ? 0 : pool.length - 1]);
          if (pool.length === 2 && rng() < 0.4) targets.push(pool[1]);
          const [x0, y0] = P(l, e);
          for (let k = 0; k < targets.length; k++) {
            const te = targets[k];
            if (te === targets[k - 1] || m.isRemoved(l + 1, te)) continue;
            const [x1, y1] = P(l + 1, te);
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            // curve control pulled gently toward the trunk, bowed upward
            const ctrlX = mx + (cx - mx) * 0.13;
            const ctrlY = my - (Math.abs(x1 - x0) * 0.15 + 5) + (rng() - 0.5) * 4;
            g.strokeStyle = `rgba(${INK},${0.05 + rng() * 0.04})`;
            g.beginPath();
            g.moveTo(x0, y0);
            g.quadraticCurveTo(ctrlX, ctrlY, x1, y1);
            g.stroke();
          }
        }
      }
    },

    // Reaped experts: a small dry grey stub with a broken fork — a gap where
    // a branch used to be. Its lattice strokes were already skipped above.
    _drawStubs(g, P) {
      const nL = this.nL, nE = this.nE, m = this.model;
      g.lineWidth = 1;
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (!m.isRemoved(l, e)) continue;
          const [x, y] = P(l, e);
          g.strokeStyle = 'rgba(122,124,142,0.30)';
          g.beginPath();
          g.moveTo(x, y + 5);
          g.lineTo(x, y - 3);
          g.moveTo(x, y);
          g.lineTo(x - 3, y - 5);
          g.moveTo(x, y - 1);
          g.lineTo(x + 3, y - 4);
          g.stroke();
        }
      }
    },

    // Delicate root flourish fanning from the trunk base into the ground.
    _drawRoots(g, groundY) {
      const cx = this.cx, rng = this.rng, w = this.w;
      g.strokeStyle = `rgba(${INK},0.20)`;
      // faint ground line
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(cx - w * 0.16, groundY + 2);
      g.quadraticCurveTo(cx, groundY + 6, cx + w * 0.16, groundY + 2);
      g.stroke();

      const roots = 7;
      for (let i = 0; i < roots; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        const spread = (0.18 + (i / roots) * 0.5) * dir;
        const len = w * (0.05 + rng() * 0.07);
        const ex = cx + w * 0.12 * spread;
        const ey = groundY + len;
        g.lineWidth = 1.4 - i * 0.12;
        g.strokeStyle = `rgba(${INK},${0.22 - i * 0.02})`;
        g.beginPath();
        g.moveTo(cx, groundY - 2);
        g.quadraticCurveTo(cx + w * 0.05 * spread, groundY + len * 0.5, ex, ey);
        g.stroke();
        // a little hair-root off the tip
        g.lineWidth = 0.7;
        g.beginPath();
        g.moveTo(ex, ey);
        g.lineTo(ex + w * 0.02 * spread, ey + len * 0.25);
        g.stroke();
      }
    },

    /* Bead path: ground base, then the top-1 expert node of each tier, root
       to crown. Routing never visits a removed slot, so every node is live. */
    _pathFor(pulse) {
      let pts = this.paths.get(pulse.tokenIdx);
      if (pts) return pts;
      const nE = this.nE;
      pts = [[this.cx, this.groundY]];
      for (let l = 0; l < this.nL; l++) {
        pts.push(this.pos[l * nE + pulse.hops[l].experts[0]]);
      }
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, pts);
      return pts;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = this.nE, nL = this.nL;

      VLM.fade(ctx, w, h, 0.09, this.fadeRGB);

      // the tree itself, faint and constant beneath the light
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.art, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // ambient: slow glimmer of the gold-leaf flecks (wall clock, never pauses)
      for (let i = 0; i < this.flecks.length; i++) {
        const fl = this.flecks[i];
        const glim = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f.wallNow * fl.spd + fl.phase));
        VLM.drawSprite(ctx, this.bead, fl.x, fl.y, fl.size * 2.4, 0.22 * glim);
      }

      // heat: nodes swell into glowing lanterns / fruit
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue;
          const v = f.heatAt(l, e);
          if (v < 0.03) continue;
          const [x, y] = this.pos[l * nE + e];
          VLM.drawSprite(ctx, this.halo, x, y, 8 + 40 * v, Math.pow(v, 0.7) * 0.8);
          if (v > 0.78) {
            // the hottest gain a fine radiant ring
            const r = 7 + 9 * v;
            ctx.strokeStyle = VLM.hsla(GOLD_HUE, 82, 74, (v - 0.78) * 1.6);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, VLM.TAU);
            ctx.stroke();
          }
        }
      }

      // pulses: beads of golden light climbing the tree
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const t = p.progress;

        // trailing shimmer behind the head
        const TRAIL = 9;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.012;
          if (tt <= 0) continue;
          const [x, y] = VLM.splinePoint(pts, tt);
          const a = (1 - i / TRAIL) * 0.32 * p.glow;
          VLM.drawSprite(ctx, this.bead, x, y, 11 - i * 0.7, a);
        }

        // the bead head — golden glow with a subtle category-hued core
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, this.bead, hx, hy, 22, 0.9 * p.glow);
        ctx.fillStyle = VLM.hsla(p.hue, 78, 72, 0.85 * p.glow);
        ctx.beginPath();
        ctx.arc(hx, hy, 2.4, 0, VLM.TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(255,250,232,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.2, 0, VLM.TAU);
        ctx.fill();

        // flare the tier nodes as the bead crosses them
        const near = Math.round(p.layerFloat);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.5 && p.progress < 1 && near >= 0 && near < nL) {
          const hop = p.hops[near];
          const a = (1 - dist * 2) * p.glow;
          const e0 = hop.experts[0];
          if (!model.isRemoved(near, e0)) {
            const [x, y] = this.pos[near * nE + e0];
            VLM.drawSprite(ctx, this.flareS, x, y, 26, a * 0.7);
          }
          if (hop.experts.length > 1) {
            const e1 = hop.experts[1], w1 = hop.weights[1];
            if (!model.isRemoved(near, e1)) {
              const [x, y] = this.pos[near * nE + e1];
              VLM.drawSprite(ctx, this.flareS, x, y, 12 + 26 * w1, a * w1 * 0.7);
            }
          }
        }

        // landing bloom at the crown: a small leaf/fruit flourish
        if (p.progress >= 1) {
          const [x, y] = pts[pts.length - 1];
          const grow = 1 - p.glow;         // 0 at land -> 1 as it fades
          const a = p.glow;                // fades out
          const r = 6 + grow * 22;
          ctx.strokeStyle = VLM.hsla(GOLD_HUE, 84, 74, 0.55 * a);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, VLM.TAU);
          ctx.stroke();
          // ripe fruit at the centre
          VLM.drawSprite(ctx, this.halo, x, y, 16, 0.6 * a);
          ctx.fillStyle = VLM.hsla(p.hue, 70, 68, 0.7 * a);
          ctx.beginPath();
          ctx.arc(x, y, 2 + grow * 1.5, 0, VLM.TAU);
          ctx.fill();
          // two small leaves unfurling
          for (let s = -1; s <= 1; s += 2) {
            const lx = x + s * (4 + grow * 10);
            const ly = y - grow * 6;
            ctx.strokeStyle = VLM.hsla(GOLD_HUE, 78, 70, 0.5 * a);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.quadraticCurveTo(x + s * (2 + grow * 4), y - grow * 5, lx, ly);
            ctx.stroke();
          }
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    // reap-lens support: screen-space home of an expert node
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      return p ? [p[0], p[1]] : null;
    },

    dispose() {
      this.paths && this.paths.clear();
      this.art = null;
      this.halo = this.bead = this.flareS = null;
      this.flecks = null;
      this.pos = null;
      this.spine = null;
    },
  };

  VLM.registerStyle(S);
})();
