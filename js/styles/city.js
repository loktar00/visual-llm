/* visual-llm style: Neon Metropolis — the model as a rain-slicked city at night.
   Avenues are horizontal layers stacked from the top of the frame (layer 0) down
   to the last layer; intersections along each avenue are experts. Token pulses are
   long-exposure car light-streaks running downtown through their top-1 intersection
   per avenue. Heat is the city waking: windows glow amber and neon signs flare where
   routing concentrates. Pruned experts are demolished lots — dark gaps with no
   windows and no streets running to them. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const S = {
    id: 'city',
    name: 'Neon Metropolis',
    blurb: 'the model as a rain-slicked city — tokens are long-exposure traffic, heat is the skyline waking',
    bg: '#05070e',
    fadeRGB: '5,7,14',

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
      const cx = w * 0.5;
      const padX = w * 0.05;
      const colStep = (w - padX * 2) / nE;
      const top = h * 0.1;
      const bot = h * 0.92;

      // avenue baselines (y per layer) + intersection positions (x per expert).
      // Slight per-avenue spacing scale and shift + per-node jitter break the grid.
      this.rowY = new Array(nL);
      this.pos = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const ty = nL === 1 ? 0.5 : l / (nL - 1);
        const y = VLM.lerp(top, bot, ty);
        this.rowY[l] = y;
        const rowScale = 1 + (rng() - 0.5) * 0.1;
        const rowOff = (rng() - 0.5) * colStep * 0.6;
        for (let e = 0; e < nE; e++) {
          const jit = (rng() - 0.5) * colStep * 0.22;
          let x = cx + (e - (nE - 1) / 2) * colStep * rowScale + rowOff + jit;
          x = VLM.clamp(x, padX * 0.4, w - padX * 0.4);
          this.pos[l * nE + e] = [x, y];
        }
      }
      const P = (l, e) => this.pos[l * nE + e];

      // glow sprites, built once
      this.catSprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.catSprites[cat] = VLM.makeGlowSprite(26, VLM.CATEGORY_HUES[cat], 95, 64);
      }
      this.winGlow = VLM.makeGlowSprite(12, 34, 92, 60); // warm amber window
      this.signHues = [330, 190, 275, 45, 150, 15]; // jewel neon
      this.signSprites = this.signHues.map((hue) => VLM.makeGlowSprite(18, hue, 95, 62));

      // static city on an offscreen canvas (transparent — drawn dimly each frame)
      const city = (this.city = document.createElement('canvas'));
      city.width = Math.ceil(w);
      city.height = Math.ceil(h);
      const g = city.getContext('2d');
      g.lineCap = 'round';

      this.winByCell = new Array(nL * nE); // per-intersection window coords for heat
      this.ambient = []; // slowly-flickering windows so districts are never fully dark

      // building silhouettes filling the band above each avenue, one per intersection
      for (let l = 0; l < nL; l++) {
        const bandTop = l > 0 ? this.rowY[l - 1] : 0;
        const base = this.rowY[l] - h * 0.006; // building base sits on the avenue
        const bandH = base - bandTop;
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          const ix = P(l, e)[0];
          const bw = colStep * (0.5 + rng() * 0.35);
          const bx0 = ix - bw / 2;
          const bx1 = ix + bw / 2;

          if (model.isRemoved(l, e)) {
            // demolished lot: a faint broken outline, an empty dark gap, no windows
            const rh = Math.min(bandH * 0.22, h * 0.03);
            g.strokeStyle = 'rgba(70,80,110,0.1)';
            g.lineWidth = 1;
            g.setLineDash([3, 4]);
            g.strokeRect(bx0, base - rh, bw, rh);
            g.setLineDash([]);
            this.winByCell[idx] = [];
            continue;
          }

          const bh = bandH * (0.42 + rng() * 0.46);
          const by = base - bh;
          g.fillStyle = 'rgba(17,23,39,1)';
          g.fillRect(bx0, by, bw, bh);
          // rooftop parapet catching the city's ambient glow
          g.strokeStyle = 'rgba(80,100,150,0.18)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(bx0, by + 0.5);
          g.lineTo(bx1, by + 0.5);
          g.stroke();
          // occasional antenna, sometimes with a warning light
          if (rng() < 0.3) {
            const ax = VLM.lerp(bx0, bx1, 0.3 + rng() * 0.4);
            const ah = bh * (0.12 + rng() * 0.22);
            g.strokeStyle = 'rgba(90,110,160,0.22)';
            g.beginPath();
            g.moveTo(ax, by);
            g.lineTo(ax, by - ah);
            g.stroke();
            if (rng() < 0.5) {
              g.fillStyle = 'rgba(230,120,90,0.5)';
              g.fillRect(ax - 0.8, by - ah - 1.5, 1.6, 1.6);
            }
          }
          // windows: dim warm dots baked in, a handful stored for heat to light up
          const cols = Math.max(1, Math.floor(bw / 6));
          const rows = Math.max(1, Math.floor(bh / 8));
          const cellW = bw / cols;
          const cellH = bh / rows;
          const wins = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (rng() > 0.34) continue;
              const wx = bx0 + (c + 0.5) * cellW + (rng() - 0.5) * cellW * 0.3;
              const wy = by + (r + 0.5) * cellH + (rng() - 0.5) * cellH * 0.3;
              g.fillStyle = 'rgba(255,196,120,0.11)';
              g.fillRect(wx - 1, wy - 1.4, 2, 2.8);
              if (wins.length < 8) wins.push([wx, wy]);
              if (this.ambient.length < 70 && rng() < 0.03) {
                this.ambient.push({ x: wx, y: wy, ph: rng() * VLM.TAU });
              }
            }
          }
          this.winByCell[idx] = wins;
        }
      }

      // avenue lines — barely-visible cool streaks
      g.strokeStyle = 'rgba(120,150,215,0.09)';
      g.lineWidth = 1;
      for (let l = 0; l < nL; l++) {
        const y = this.rowY[l];
        g.beginPath();
        g.moveTo(padX * 0.4, y);
        g.lineTo(w - padX * 0.4, y);
        g.stroke();
      }

      // sparse faint diagonal connector streets to 2-3 nearby next-avenue intersections
      g.strokeStyle = 'rgba(95,125,185,0.055)';
      g.lineWidth = 1;
      for (let l = 0; l < nL - 1; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue; // no streets from a demolished lot
          const [x0, y0] = P(l, e);
          const nConn = 2 + (rng() < 0.5 ? 1 : 0);
          for (let k = 0; k < nConn; k++) {
            const te = VLM.clamp(e + (k - 1), 0, nE - 1);
            if (model.isRemoved(l + 1, te)) continue; // no street into a demolished lot
            const [x1, y1] = P(l + 1, te);
            g.beginPath();
            g.moveTo(x0, y0);
            g.lineTo(x1, y1);
            g.stroke();
          }
        }
      }
    },

    /* Cached path a token drives: enter from above the frame, thread each avenue's
       top-1 intersection, exit off the bottom. Keyed by tokenIdx. */
    _pathFor(p) {
      let pts = this.paths.get(p.tokenIdx);
      if (pts) return pts;
      const nE = this.model.nExperts;
      const nL = this.model.nLayers;
      const first = this.pos[p.hops[0].experts[0]];
      pts = [[first[0], -this.h * 0.06]];
      for (let l = 0; l < nL; l++) {
        const q = this.pos[l * nE + p.hops[l].experts[0]];
        pts.push([q[0], q[1]]);
      }
      const last = this.pos[(nL - 1) * nE + p.hops[nL - 1].experts[0]];
      pts.push([last[0], this.h * 1.06]);
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(p.tokenIdx, pts);
      return pts;
    },

    /* Rain-slick reflection: an elongated smear of a light dropped below it. */
    _reflect(ctx, sprite, x, y, size, alpha) {
      if (alpha <= 0 || size <= 0) return;
      ctx.globalAlpha = alpha;
      const rw = size * 0.5;
      const rh = size * 1.8;
      ctx.drawImage(sprite, x - rw / 2, y + size * 0.1, rw, rh);
      ctx.globalAlpha = 1;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = model.nLayers;
      const nE = model.nExperts;

      VLM.fade(ctx, w, h, 0.06, this.fadeRGB); // low fade → long light-streaks linger

      // the city itself, faint and constant beneath the lights
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.city, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // heat: windows near hot intersections warm up; the hottest raise neon signs
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.03) continue;
          const idx = l * nE + e;
          const wins = this.winByCell[idx];
          const flick = 0.8 + 0.2 * Math.sin(f.wallNow * 2.3 + idx * 1.7);
          if (wins) {
            for (let i = 0; i < wins.length; i++) {
              VLM.drawSprite(ctx, this.winGlow, wins[i][0], wins[i][1], 5 + 5 * v, Math.pow(v, 0.8) * 0.85 * flick);
            }
          }
          if (v > 0.5) {
            const [x, y] = this.pos[idx];
            const a = (v - 0.5) / 0.5;
            const si = idx % this.signSprites.length;
            VLM.drawSprite(ctx, this.signSprites[si], x, y, 10 + 20 * a, 0.65 * a);
            ctx.fillStyle = VLM.hsla(this.signHues[si], 92, 66, 0.7 * a);
            ctx.fillRect(x - 3, y - 1.5, 6, 3);
            this._reflect(ctx, this.signSprites[si], x, y, 12 + 16 * a, 0.2 * a);
          }
        }
      }

      // ambient window flicker so districts are never fully dark (alive while paused)
      for (let i = 0; i < this.ambient.length; i++) {
        const a = this.ambient[i];
        const s = 0.5 + 0.5 * Math.sin(f.wallNow * 0.7 + a.ph);
        if (s < 0.62) continue;
        VLM.drawSprite(ctx, this.winGlow, a.x, a.y, 4.5, 0.13 * ((s - 0.62) / 0.38));
      }

      // pulses: long-exposure traffic running downtown
      for (const p of f.pulses) {
        const pts = this._pathFor(p);
        const sprite = this.catSprites[p.cat] || this.catSprites.word;
        const t = p.progress;

        // luminous trail behind the head — the long-exposure streak
        const TRAIL = 26;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.006;
          if (tt <= 0) continue;
          const [x, y] = VLM.splinePoint(pts, tt);
          const k = 1 - i / TRAIL;
          VLM.drawSprite(ctx, sprite, x, y, 4 + 10 * k, k * k * 0.5 * p.glow);
        }

        // bright neon head + its wet-street reflection + a white-hot core
        const [hx, hy] = VLM.splinePoint(pts, t);
        VLM.drawSprite(ctx, sprite, hx, hy, 26, 0.9 * p.glow);
        this._reflect(ctx, sprite, hx, hy, 26, 0.28 * p.glow);
        ctx.fillStyle = `rgba(255,255,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 2, 0, VLM.TAU);
        ctx.fill();

        // flash the crossed intersection, plus a weaker flash on the runner-up
        const near = Math.round(p.layerFloat);
        if (near >= 0 && near < nL && p.progress < 1) {
          const dist = Math.abs(p.layerFloat - near);
          if (dist < 0.5) {
            const hop = p.hops[near];
            const a = (1 - dist * 2) * 0.7 * p.glow;
            const [x0, y0] = this.pos[near * nE + hop.experts[0]];
            VLM.drawSprite(ctx, sprite, x0, y0, 32, a);
            this._reflect(ctx, sprite, x0, y0, 30, a * 0.35);
            if (hop.experts.length > 1) {
              const wgt = hop.weights[1] || 0;
              const [x1, y1] = this.pos[near * nE + hop.experts[1]];
              VLM.drawSprite(ctx, sprite, x1, y1, 14 + 24 * wgt, a * wgt);
            }
          }
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
      this.paths = null;
      this.city = null;
      this.winByCell = null;
      this.ambient = null;
      this.catSprites = null;
      this.signSprites = null;
    },
  };

  VLM.registerStyle(S);
})();
