/* visual-llm style: Gravity Well — the self-sorting bubble map.
   Every expert starts adrift in a scattered cloud. As the replay runs and
   usage accrues, the experts the router loves fall inward and gather into a
   burning core; the ones it ignores drift out to a cold, sparse shell. The
   model's true shape condenses out of noise — and because usage resets when
   the recording loops, the sorting re-emerges from chaos on every pass.
   The outer dark ring is, literally, the reap-candidate list drawn as space.
   Reaped experts are pinned beyond the rim as dead cinders. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  const S = {
    id: 'gravity',
    name: 'Gravity Well',
    blurb: 'a self-sorting bubble map — experts the router loves fall into the burning core; the cold drift to the outer dark',
    bg: '#05060d',
    fadeRGB: '5,6,13',

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;

      const nL = model.nLayers;
      const nE = model.nExperts;
      const n = nL * nE;
      this.cx = w * 0.5;
      this.cy = h * 0.5;
      this.rCore = Math.min(w, h) * 0.045;
      this.rEdge = Math.min(w, h) * 0.46;
      this.squash = 0.86; // slight ellipse so the disc sits wide in the frame

      // node state: animated position + a stable angular identity per expert
      this.px = new Float32Array(n);
      this.py = new Float32Array(n);
      this.ang = new Float32Array(n);
      this.ph = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this.ang[i] = rng() * TAU;
        this.ph[i] = rng() * TAU;
        const r0 = this.rEdge * (0.3 + 0.7 * Math.sqrt(rng()));
        this.px[i] = this.cx + Math.cos(this.ang[i]) * r0;
        this.py[i] = this.cy + Math.sin(this.ang[i]) * r0 * this.squash;
      }

      this.glow = VLM.makeGlowSprite(26, 38, 96, 62); // warm bubble halo
      this.catS = {};
      for (const c of Object.keys(VLM.CATEGORY_HUES)) {
        this.catS[c] = VLM.makeGlowSprite(22, VLM.CATEGORY_HUES[c], 88, 68);
      }

      // static: whisper-faint orbit guides
      const art = (this.staticArt = document.createElement('canvas'));
      art.width = Math.ceil(w);
      art.height = Math.ceil(h);
      const g = art.getContext('2d');
      g.strokeStyle = 'rgba(150,170,220,0.05)';
      g.lineWidth = 1;
      for (let k = 1; k <= 4; k++) {
        g.beginPath();
        g.ellipse(this.cx, this.cy, (this.rEdge * k) / 4, (this.rEdge * this.squash * k) / 4, 0, 0, TAU);
        g.stroke();
      }
    },

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = model.nLayers;
      const nE = model.nExperts;

      VLM.fade(ctx, w, h, 0.16, this.fadeRGB);
      ctx.globalAlpha = 0.8;
      ctx.drawImage(this.staticArt, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // gravity: each bubble eases toward the radius its usage has earned.
      // Warm compresses hard because most experts carry very little mass.
      const ease = Math.min(1, f.dt * 1.6);
      const wob = 2.5;
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const i = l * nE + e;
          const removed = model.isRemoved(l, e);
          const u = f.usageAt(l, e);
          const heat = f.heatAt(l, e);
          const warm = Math.pow(u, 0.35);
          const rT = removed ? this.rEdge * 1.04 : VLM.lerp(this.rEdge, this.rCore, warm);
          const aT = this.ang[i] + f.now * 0.01 * (0.3 + warm); // the core swirls a touch faster
          const tx = this.cx + Math.cos(aT) * rT + Math.sin(f.wallNow * 0.7 + this.ph[i]) * wob;
          const ty = this.cy + Math.sin(aT) * rT * this.squash + Math.cos(f.wallNow * 0.6 + this.ph[i]) * wob;
          this.px[i] += (tx - this.px[i]) * ease;
          this.py[i] += (ty - this.py[i]) * ease;

          if (removed) {
            // dead cinder beyond the rim — dim but unmistakably there
            ctx.fillStyle = 'rgba(255,84,118,0.14)';
            ctx.fillRect(this.px[i] - 1, this.py[i] - 1, 2.2, 2.2);
            continue;
          }
          const v = Math.max(heat, u * 0.55);
          if (v < 0.02) {
            // cold speck adrift in the shell: clearly visible, cool-toned so
            // the burning core reads by contrast, with a slow twinkle
            const tw = 0.75 + 0.25 * Math.sin(f.wallNow * 0.9 + this.ph[i]);
            ctx.fillStyle = `rgba(142,162,215,${0.2 * tw})`;
            ctx.fillRect(this.px[i] - 1, this.py[i] - 1, 2.2, 2.2);
          } else {
            // warm bubble: accumulation-safe halo + heat-colored body
            VLM.drawSprite(ctx, this.glow, this.px[i], this.py[i], 4 + 30 * v, 0.02 + 0.1 * v);
            ctx.fillStyle = VLM.heatColor(0.25 + v * 0.7, 0.08 + 0.5 * v);
            ctx.beginPath();
            ctx.arc(this.px[i], this.py[i], 0.8 + 3.6 * v, 0, TAU);
            ctx.fill();
          }
        }
      }

      // pulses thread through the bubbles' CURRENT positions, so early in a
      // loop they stitch across the whole cloud and later they orbit the core
      this._pts = this._pts || [];
      for (const p of f.pulses) {
        const pts = this._pts;
        pts.length = 0;
        for (let l = 0; l < nL; l++) {
          const i = l * nE + p.hops[l].experts[0];
          pts.push([this.px[i], this.py[i]]);
        }
        const sprite = this.catS[p.cat] || this.catS.word;
        for (let k = 6; k >= 1; k--) {
          const tt = p.progress - k * 0.012;
          if (tt <= 0) continue;
          const b = VLM.splinePoint(pts, tt);
          VLM.drawSprite(ctx, sprite, b[0], b[1], 9 - k, (1 - k / 7) * 0.4 * p.glow);
        }
        const hd = VLM.splinePoint(pts, p.progress);
        VLM.drawSprite(ctx, sprite, hd[0], hd[1], 18, 0.9 * p.glow);
        ctx.fillStyle = `rgba(255,255,255,${0.85 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hd[0], hd[1], 1.6, 0, TAU);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // reap-lens / labels / click-to-mask track the moving bubbles live
    nodePos(l, e) {
      const i = l * this.model.nExperts + e;
      return [this.px[i], this.py[i]];
    },

    dispose() {
      this.staticArt = null;
      this.px = this.py = this.ang = this.ph = null;
      this.glow = this.catS = null;
      this._pts = null;
    },
  };

  VLM.registerStyle(S);
})();
