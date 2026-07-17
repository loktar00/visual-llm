/* visual-llm style: Token Flow — the plain-spoken view. Layers are rows from
   top to bottom, experts are columns left to right, and the grid is a true
   heatmap: cells brighten through the inferno ramp where the router routes,
   and cool as attention moves on. Tokens are bright dots dropping straight
   down the stack, a thin thread linking each hop, with a dimmer echo on the
   runner-up expert showing the gate split. Built to be understood in five
   seconds — the explainer the other fourteen styles riff on. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  const S = {
    id: 'flow',
    name: 'Token Flow',
    blurb: 'the plain view — layers top to bottom, experts left to right, heat where the router lives',
    bg: '#05070c',
    fadeRGB: '5,7,12',

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      const nL = (this.nL = model.nLayers);
      const nE = (this.nE = model.nExperts);

      const mLeft = (this.mLeft = Math.max(46, w * 0.045));
      const mRight = Math.max(24, w * 0.025);
      const mTop = (this.mTop = Math.max(52, h * 0.07));
      const mBottom = Math.max(56, h * 0.075);
      this.gw = w - mLeft - mRight;
      this.gh = h - mTop - mBottom;
      this.cw = this.gw / nE;
      this.ch = this.gh / nL;
      // cell inset: visible gutters make the grid read as discrete slots
      this.ix = Math.min(3, this.cw * 0.12);
      this.iy = Math.min(3, this.ch * 0.14);

      this.cellX = (e) => this.mLeft + e * this.cw;
      this.cellY = (l) => this.mTop + l * this.ch;
      this.cx = (e) => this.mLeft + (e + 0.5) * this.cw;
      this.cy = (l) => this.mTop + (l + 0.5) * this.ch;

      this.sprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.sprites[cat] = VLM.makeGlowSprite(20, VLM.CATEGORY_HUES[cat], 88, 68);
      }

      // ---- static sheet: faint grid, axis labels, entry arrow ----
      const art = (this.staticArt = document.createElement('canvas'));
      art.width = Math.ceil(w);
      art.height = Math.ceil(h);
      const g = art.getContext('2d');
      g.strokeStyle = 'rgba(150,170,220,0.07)';
      g.lineWidth = 1;
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          this._cellPath(g, l, e);
          g.stroke();
        }
      }
      g.font = '11px ui-monospace, Consolas, monospace';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(180,195,235,0.35)';
      for (let l = 0; l < nL; l += 4) {
        g.fillText('L' + l, mLeft - 8, this.cy(l));
      }
      g.fillText('L' + (nL - 1), mLeft - 8, this.cy(nL - 1));
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = 'rgba(180,195,235,0.4)';
      g.fillText('tokens ▼', mLeft, mTop - 26);
      g.fillStyle = 'rgba(180,195,235,0.28)';
      g.fillText('experts →', mLeft, mTop - 12);
      g.textAlign = 'right';
      g.fillText('output ▼', mLeft + this.gw, h - mBottom + 24);

      // heat legend swatch strip, bottom-left: cold → hot
      const lw = Math.min(180, this.gw * 0.2);
      const ly = h - mBottom + 16;
      for (let i = 0; i < 40; i++) {
        g.fillStyle = VLM.heatColor(i / 39, 0.9);
        g.fillRect(mLeft + (i / 40) * lw, ly, lw / 40 + 0.5, 6);
      }
      g.textAlign = 'left';
      g.fillStyle = 'rgba(180,195,235,0.35)';
      g.fillText('cold', mLeft, ly + 18);
      g.textAlign = 'right';
      g.fillText('hot', mLeft + lw, ly + 18);

      // removed slots: statically scarred so pruning is visible at a glance
      g.strokeStyle = 'rgba(255,70,105,0.28)';
      g.lineWidth = 1;
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (!model.isRemoved(l, e)) continue;
          const x = this.cellX(e) + this.ix, y = this.cellY(l) + this.iy;
          const x1 = this.cellX(e) + this.cw - this.ix, y1 = this.cellY(l) + this.ch - this.iy;
          g.beginPath();
          g.moveTo(x, y); g.lineTo(x1, y1);
          g.moveTo(x1, y); g.lineTo(x, y1);
          g.stroke();
        }
      }
    },

    _cellPath(g, l, e) {
      const x = this.cellX(e) + this.ix;
      const y = this.cellY(l) + this.iy;
      const wRect = this.cw - this.ix * 2;
      const hRect = this.ch - this.iy * 2;
      const r = Math.min(3, hRect * 0.3, wRect * 0.3);
      g.beginPath();
      g.roundRect ? g.roundRect(x, y, wRect, hRect, r) : g.rect(x, y, wRect, hRect);
    },

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = this.nL, nE = this.nE;

      VLM.fade(ctx, w, h, 0.18, this.fadeRGB);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.staticArt, 0, 0, w, h);
      ctx.globalAlpha = 1;

      // ---- the heatmap itself: source-over fills, no accumulation games.
      // Recent heat leads; a faint usage floor keeps the session's history
      // visible after the heat cools. ----
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue;
          const v = Math.max(f.heatAt(l, e), f.usageAt(l, e) * 0.4);
          if (v < 0.015) continue;
          this._cellPath(ctx, l, e);
          ctx.fillStyle = VLM.heatColor(Math.pow(v, 0.85), 0.28 + 0.62 * Math.min(1, v));
          ctx.fill();
        }
      }

      ctx.globalCompositeOperation = 'lighter';

      // ---- tokens: dots dropping straight down, thread linking the hops ----
      for (const p of f.pulses) {
        const sprite = this.sprites[p.cat] || this.sprites.word;
        const lf = p.layerFloat;
        const l0 = Math.floor(lf);
        const l1 = Math.min(nL - 1, l0 + 1);
        const frac = lf - l0;
        const hop0 = p.hops[l0];
        const hop1 = p.hops[l1];
        const x0 = this.cx(hop0.experts[0]);
        const y0 = this.cy(l0);
        const x1 = this.cx(hop1.experts[0]);
        const y1 = this.cy(l1);

        // entering from above the grid on the first row
        let hx, hy;
        if (p.progress <= 0.001 || (l0 === 0 && frac < 0.001)) {
          hx = x0; hy = y0;
        } else {
          hx = VLM.lerp(x0, x1, frac);
          hy = VLM.lerp(y0, y1, frac);
        }

        // the thread: current hop segment, bright near the head
        ctx.strokeStyle = VLM.hsla(p.hue, 85, 70, 0.35 * p.glow);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        // current cell outline flash
        const nearL = Math.round(lf);
        if (nearL >= 0 && nearL < nL && p.progress < 1) {
          const d = Math.abs(lf - nearL);
          if (d < 0.5) {
            const hop = p.hops[nearL];
            const a = (1 - d * 2) * p.glow;
            ctx.strokeStyle = VLM.hsla(p.hue, 90, 75, 0.8 * a);
            ctx.lineWidth = 1.4;
            this._cellPath(ctx, nearL, hop.experts[0]);
            ctx.stroke();
            // runner-up echo: the gate split made visible
            if (hop.experts.length > 1) {
              const w2 = hop.weights[1] || 0;
              ctx.strokeStyle = VLM.hsla(p.hue, 80, 70, 0.55 * a * Math.min(1, w2 * 2.4));
              ctx.lineWidth = 1;
              this._cellPath(ctx, nearL, hop.experts[1]);
              ctx.stroke();
              VLM.drawSprite(ctx, sprite, this.cx(hop.experts[1]), this.cy(nearL),
                8 + 10 * w2, 0.5 * a * Math.min(1, w2 * 2));
            }
          }
        }

        // head
        VLM.drawSprite(ctx, sprite, hx, hy, 16, 0.9 * p.glow);
        ctx.fillStyle = `rgba(255,255,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.6, 0, TAU);
        ctx.fill();

        // landing: a soft flash under the last row
        if (p.progress >= 1) {
          const lx = this.cx(p.hops[nL - 1].experts[0]);
          VLM.drawSprite(ctx, sprite, lx, this.mTop + this.gh + 10, 26 * (1.4 - p.glow), 0.5 * p.glow);
        }
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens support: cell centers
    nodePos(l, e) {
      return [this.cx(e), this.cy(l)];
    },

    dispose() {
      this.staticArt = null;
      this.sprites = null;
    },
  };

  VLM.registerStyle(S);
})();
