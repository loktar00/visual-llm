/* visual-llm style: Mainframe — the model as a floor-to-ceiling server rack
   at night. Layers are 1U faceplates stacked top (layer 0) to bottom; experts
   are LEDs in a strict grid across each plate. A token is an LED chase marching
   downward: it lights its top-1 lens, flickers its neighbours, and flashes a
   thin vertical data line down to its lens on the next unit. Heat leaves LEDs
   lit — green when lightly used, drifting amber then hot white-orange. Reaped
   experts are empty sockets, sometimes with a dangling unplugged stub. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;
  const lerp = VLM.lerp;
  const clamp = VLM.clamp;

  // Core-dot color for a lit LED: dim green -> amber -> hot white-orange.
  function ledCore(v) {
    v = clamp(v, 0, 1);
    let r, g, b;
    if (v < 0.6) {
      const f = v / 0.6;
      r = lerp(60, 255, f); g = lerp(210, 178, f); b = lerp(92, 48, f);
    } else {
      const f = (v - 0.6) / 0.4;
      r = lerp(255, 255, f); g = lerp(178, 240, f); b = lerp(48, 214, f);
    }
    return (r | 0) + ',' + (g | 0) + ',' + (b | 0);
  }

  // Glow-sprite ramp matching the core ramp, indexed by heat.
  const LED_RAMP = [
    [135, 80, 45], [98, 85, 50], [62, 90, 52],
    [42, 95, 55], [30, 92, 60], [32, 55, 82],
  ];

  const S = {
    id: 'rack',
    name: 'Mainframe',
    blurb: 'the model as a rack of blinkenlights at night — tokens march the LEDs',
    bg: '#050608',
    fadeRGB: '5,6,8',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.paths = new Map(); // tokenIdx -> { pts }

      const nL = (this.nL = model.nLayers);
      const nE = (this.nE = model.nExperts);

      // --- rack geometry ---
      const marginX = Math.round(w * 0.10);
      const rackTop = Math.round(h * 0.045);
      const rackBot = Math.round(h * 0.955);
      const rackX0 = marginX;
      const rackX1 = w - marginX;
      const rackW = rackX1 - rackX0;
      const railW = clamp(rackW * 0.028, 14, 30);
      const plateX0 = rackX0 + railW + 6;
      const plateX1 = rackX1 - railW - 6;
      const plateW = plateX1 - plateX0;
      const rowH = (rackBot - rackTop) / nL;
      const gap = clamp(rowH * 0.14, 2, 6);
      const plateH = rowH - gap;
      this.plateHalf = plateH * 0.5;

      // module zone (varied faceplate art) on the left of every plate
      const moduleW = clamp(plateW * 0.13, 56, 170);
      const moduleX0 = plateX0 + 8;
      const moduleX1 = moduleX0 + moduleW;

      // LED strip: identical x-grid on every unit so data lines run vertical
      const stripX0 = moduleX1 + clamp(plateW * 0.03, 10, 30);
      const stripX1 = plateX1 - clamp(plateW * 0.02, 8, 24);
      const ledStep = nE > 1 ? (stripX1 - stripX0) / (nE - 1) : 0;
      this.ledX0 = stripX0;
      this.ledStep = ledStep;
      const ledR = (this.ledR = clamp(
        Math.min(nE > 1 ? ledStep * 0.24 : plateW * 0.2, plateH * 0.28),
        2, 5.5));

      // per-unit vertical centers
      const rowCY = (this.rowCY = new Array(nL));
      for (let l = 0; l < nL; l++) rowCY[l] = rackTop + l * rowH + rowH * 0.5;

      // deterministic faceplate type per row
      const rowType = (this.rowType = new Array(nL));
      for (let l = 0; l < nL; l++) {
        const r = rng();
        rowType[l] = r < 0.42 ? 'led' : r < 0.60 ? 'seg' : r < 0.76 ? 'vent' : r < 0.90 ? 'dial' : 'ports';
      }

      // --- glow sprites (built once) ---
      const Rg = Math.max(10, Math.round(ledR * 4));
      this.heatSprites = LED_RAMP.map((c) => VLM.makeGlowSprite(Rg, c[0], c[1], c[2]));
      this.warmSprite = VLM.makeGlowSprite(Math.max(12, Rg), 30, 90, 52);
      this.ambientSprite = VLM.makeGlowSprite(Math.max(8, Math.round(ledR * 2.6)), 135, 80, 55);
      this.hueSprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.hueSprites[cat] = VLM.makeGlowSprite(Rg, VLM.CATEGORY_HUES[cat], 92, 66);
      }

      // --- ambient idle blinkers (sparse, wall-clock driven) ---
      const nAmb = Math.round(clamp(nL * 1.5, 12, 60));
      const ambient = (this.ambient = []);
      for (let i = 0; i < nAmb; i++) {
        ambient.push({
          l: Math.floor(rng() * nL),
          e: Math.floor(rng() * nE),
          spd: 0.14 + rng() * 0.4,
          phase: rng(),
        });
      }

      // --- static art onto an offscreen canvas ---
      const art = (this.staticArt = document.createElement('canvas'));
      art.width = Math.ceil(w);
      art.height = Math.ceil(h);
      const g = art.getContext('2d');
      g.lineCap = 'round';

      // cold ambient gradient + overhead cool glow + vignette for depth
      const amb = g.createLinearGradient(0, 0, 0, h);
      amb.addColorStop(0, 'rgba(20,28,40,0.10)');
      amb.addColorStop(1, 'rgba(4,6,10,0)');
      g.fillStyle = amb;
      g.fillRect(0, 0, w, h);
      const top = g.createRadialGradient(w / 2, -h * 0.1, 0, w / 2, -h * 0.1, h * 0.6);
      top.addColorStop(0, 'rgba(34,50,74,0.12)');
      top.addColorStop(1, 'rgba(34,50,74,0)');
      g.fillStyle = top;
      g.fillRect(0, 0, w, h);
      const vig = g.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.2, w / 2, h * 0.5, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.45)');
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);

      // -- local drawing helpers --
      const port = (x, y, r) => {
        g.fillStyle = '#070809';
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(80,90,104,0.26)'; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
        g.fillStyle = '#02030a';
        g.beginPath(); g.arc(x, y, r * 0.5, 0, TAU); g.fill();
      };
      const drawSeg = (x, y, ww, hh) => {
        g.strokeStyle = 'rgba(60,70,82,0.16)';
        g.lineWidth = Math.max(1, hh * 0.08);
        const t = y, m = y + hh / 2, bt = y + hh, l = x, rt = x + ww;
        const seg = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
        seg(l, t, rt, t); seg(l, m, rt, m); seg(l, bt, rt, bt);
        seg(l, t, l, m); seg(rt, t, rt, m); seg(l, m, l, bt); seg(rt, m, rt, bt);
      };
      const moduleArt = (type, mx, mw, cy, ph) => {
        const pad = 3;
        if (type === 'seg') {
          const nd = 2, gapd = 4;
          const dw = (mw - pad * 2 - gapd * (nd - 1)) / nd;
          const dh = Math.min(ph * 0.72, dw * 1.7);
          for (let d = 0; d < nd; d++) {
            const dx = mx + pad + d * (dw + gapd), dy = cy - dh / 2;
            g.fillStyle = '#070809'; g.fillRect(dx, dy, dw, dh);
            g.strokeStyle = 'rgba(0,0,0,0.5)'; g.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
            drawSeg(dx + dw * 0.18, dy + dh * 0.12, dw * 0.64, dh * 0.76);
          }
        } else if (type === 'vent') {
          const n = Math.max(3, Math.floor(ph / 4));
          const sgap = (ph - 2) / n;
          for (let i = 0; i < n; i++) {
            const sy = cy - ph / 2 + 2 + i * sgap;
            g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(mx + pad, sy, mw - pad * 2, 1.6);
            g.fillStyle = 'rgba(90,100,112,0.06)'; g.fillRect(mx + pad, sy - 1, mw - pad * 2, 1);
          }
        } else if (type === 'dial') {
          const rr = Math.min(mw * 0.5, ph * 0.42) - 2;
          const dx = mx + mw * 0.42;
          g.fillStyle = '#0a0c0f'; g.beginPath(); g.arc(dx, cy, rr, 0, TAU); g.fill();
          g.strokeStyle = 'rgba(80,90,104,0.28)'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(dx, cy, rr, 0, TAU); g.stroke();
          for (let t = 0; t < 12; t++) {
            const a = t * TAU / 12;
            g.strokeStyle = 'rgba(90,100,114,0.20)'; g.lineWidth = 1;
            g.beginPath();
            g.moveTo(dx + Math.cos(a) * (rr - 2), cy + Math.sin(a) * (rr - 2));
            g.lineTo(dx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
            g.stroke();
          }
          g.strokeStyle = 'rgba(150,160,175,0.35)'; g.lineWidth = 1.4;
          g.beginPath(); g.moveTo(dx, cy);
          g.lineTo(dx + Math.cos(-0.9) * rr * 0.8, cy + Math.sin(-0.9) * rr * 0.8);
          g.stroke();
          port(mx + mw * 0.86, cy, Math.min(ph * 0.3, 5));
        } else if (type === 'ports') {
          port(mx + mw * 0.32, cy, Math.min(ph * 0.34, 6));
          port(mx + mw * 0.68, cy, Math.min(ph * 0.34, 6));
        } else {
          const lx = mx + pad, lw = mw - pad * 2;
          const lh = Math.min(ph * 0.62, 14), ly = cy - lh / 2;
          g.fillStyle = '#0a0c0f'; g.fillRect(lx + 8, ly, lw - 8, lh);
          g.strokeStyle = 'rgba(0,0,0,0.4)'; g.strokeRect(lx + 8.5, ly + 0.5, lw - 9, lh - 1);
          g.strokeStyle = 'rgba(95,105,120,0.14)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(lx + 12, cy - 2); g.lineTo(lx + lw - 6, cy - 2); g.stroke();
          g.beginPath(); g.moveTo(lx + 12, cy + 2); g.lineTo(lx + lw * 0.6, cy + 2); g.stroke();
          port(lx + 3, cy, Math.min(ph * 0.24, 3.2));
        }
      };
      const screw = (x, y) => {
        const r = 3.2;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = k * TAU / 6 + 0.3;
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
        g.fillStyle = '#0d0f12'; g.fill();
        g.strokeStyle = 'rgba(120,132,150,0.22)'; g.lineWidth = 0.8; g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.beginPath(); g.moveTo(x - r * 0.6, y); g.lineTo(x + r * 0.6, y); g.stroke();
      };
      const bezel = (x, y, rm) => {
        const b = ledR + 2.5;
        g.fillStyle = '#050607'; g.fillRect(x - b, y - b, b * 2, b * 2);
        g.strokeStyle = 'rgba(70,78,90,0.18)'; g.lineWidth = 1;
        g.strokeRect(x - b + 0.5, y - b + 0.5, b * 2 - 1, b * 2 - 1);
        if (rm) {
          g.fillStyle = '#020304';
          g.beginPath(); g.arc(x, y, ledR * 0.9, 0, TAU); g.fill();
          g.strokeStyle = 'rgba(60,66,76,0.25)'; g.lineWidth = 0.8;
          g.beginPath(); g.arc(x, y, ledR * 0.9, 0, TAU); g.stroke();
          return;
        }
        const lg = g.createRadialGradient(x - ledR * 0.3, y - ledR * 0.3, ledR * 0.1, x, y, ledR);
        lg.addColorStop(0, '#12161b'); lg.addColorStop(1, '#050708');
        g.fillStyle = lg;
        g.beginPath(); g.arc(x, y, ledR, 0, TAU); g.fill();
        g.fillStyle = 'rgba(180,195,215,0.18)';
        g.beginPath(); g.arc(x - ledR * 0.32, y - ledR * 0.32, ledR * 0.22, 0, TAU); g.fill();
      };

      // -- rails with mounting holes --
      for (const rx of [rackX0, rackX1 - railW]) {
        const grad = g.createLinearGradient(rx, 0, rx + railW, 0);
        grad.addColorStop(0, '#0b0d10'); grad.addColorStop(0.5, '#1a1d22'); grad.addColorStop(1, '#0b0d10');
        g.fillStyle = grad; g.fillRect(rx, rackTop, railW, rackBot - rackTop);
        g.fillStyle = 'rgba(120,132,150,0.10)'; g.fillRect(rx + 1, rackTop, 1, rackBot - rackTop);
        const hx = rx + railW * 0.5;
        for (let l = 0; l <= nL; l++) {
          const hy = rackTop + l * rowH;
          g.fillStyle = '#050607'; g.beginPath(); g.arc(hx, hy, 2.6, 0, TAU); g.fill();
          g.strokeStyle = 'rgba(90,100,115,0.25)'; g.lineWidth = 0.8;
          g.beginPath(); g.arc(hx, hy, 2.6, 0, TAU); g.stroke();
        }
      }

      // -- faceplates --
      for (let l = 0; l < nL; l++) {
        const cy = rowCY[l];
        const plateTop = cy - plateH * 0.5;
        const plateBottom = cy + plateH * 0.5;
        const pg = g.createLinearGradient(0, plateTop, 0, plateBottom);
        pg.addColorStop(0, '#191c21'); pg.addColorStop(0.12, '#15181c');
        pg.addColorStop(0.5, '#101216'); pg.addColorStop(1, '#0b0d10');
        g.fillStyle = pg; g.fillRect(plateX0, plateTop, plateW, plateH);
        g.fillStyle = 'rgba(140,150,165,0.14)'; g.fillRect(plateX0, plateTop, plateW, 1);
        g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(plateX0, plateBottom - 1, plateW, 1);

        // corner screws
        screw(plateX0 + 7, plateTop + Math.min(7, plateH * 0.28));
        screw(plateX1 - 7, plateTop + Math.min(7, plateH * 0.28));
        screw(plateX0 + 7, plateBottom - Math.min(7, plateH * 0.28));
        screw(plateX1 - 7, plateBottom - Math.min(7, plateH * 0.28));

        moduleArt(rowType[l], moduleX0, moduleW, cy, plateH);

        // vent-row slots behind the LED strip
        if (rowType[l] === 'vent') {
          g.fillStyle = 'rgba(0,0,0,0.4)';
          g.fillRect(stripX0, plateTop + plateH * 0.16, stripX1 - stripX0, 1.4);
          g.fillRect(stripX0, plateBottom - plateH * 0.16, stripX1 - stripX0, 1.4);
        }

        // LED lenses (dormant) / empty sockets, sometimes with a dangling stub
        for (let e = 0; e < nE; e++) {
          const x = stripX0 + e * ledStep;
          const rm = model.isRemoved(l, e);
          bezel(x, cy, rm);
          if (rm && rng() < 0.22) {
            const sy = cy + ledR + 2.5;
            const ex = x + (rng() - 0.5) * ledR * 3;
            const ey = sy + rowH * (0.3 + rng() * 0.5);
            g.strokeStyle = 'rgba(22,22,26,0.9)'; g.lineWidth = 2.2;
            g.beginPath(); g.moveTo(x, sy); g.quadraticCurveTo(x, (sy + ey) / 2, ex, ey); g.stroke();
            g.fillStyle = '#1a1c20'; g.fillRect(ex - 2, ey - 3, 4, 6);
          }
        }
      }

      // -- cable bundle down the right margin --
      const bx = rackX1 + (w - rackX1) * 0.45;
      const nC = 5;
      for (let i = 0; i < nC; i++) {
        const off = (i - (nC - 1) / 2) * 5;
        const amp = 6 + rng() * 5;
        const freq = 0.008 + rng() * 0.004;
        const phase = rng() * TAU;
        const tone = 16 + ((rng() * 10) | 0);
        g.strokeStyle = 'rgba(' + tone + ',' + (tone - 2) + ',' + (tone + 3) + ',0.95)';
        g.lineWidth = 3;
        g.beginPath();
        for (let y = rackTop; y <= rackBot; y += 8) {
          const cxp = bx + off + Math.sin(y * freq + phase) * amp;
          if (y === rackTop) g.moveTo(cxp, y); else g.lineTo(cxp, y);
        }
        g.stroke();
      }
      const tw = nC * 5 + 10;
      for (let y = rackTop + 60; y < rackBot; y += 150) {
        g.fillStyle = 'rgba(8,8,10,0.95)'; g.fillRect(bx - tw / 2, y, tw, 5);
        g.fillStyle = 'rgba(80,86,96,0.10)'; g.fillRect(bx - tw / 2, y, tw, 1);
      }
    },

    /* ---------- geometry ---------- */

    // REQUIRED: screen-space center of expert e's LED on unit l.
    nodePos(l, e) {
      const li = l < 0 ? 0 : l >= this.nL ? this.nL - 1 : l | 0;
      const ei = e < 0 ? 0 : e >= this.nE ? this.nE - 1 : e;
      return [this.ledX0 + ei * this.ledStep, this.rowCY[li]];
    },

    // Cached top-1 LED sequence per token: one point per unit.
    _pathFor(p) {
      let path = this.paths.get(p.tokenIdx);
      if (path) return path;
      const pts = [];
      for (let l = 0; l < this.nL; l++) {
        const hop = p.hops[l];
        pts.push(this.nodePos(l, hop ? hop.experts[0] : 0));
      }
      path = { pts };
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(p.tokenIdx, path);
      return path;
    },

    // Straight-line (arc-length within each segment is linear) point at
    // fractional layer position lf. No splines — crisp mechanical routing.
    _ptAt(pts, lf) {
      const n = pts.length;
      if (n === 0) return [0, 0];
      if (n === 1) return pts[0];
      lf = clamp(lf, 0, n - 1);
      const i = Math.min(n - 2, Math.floor(lf));
      const fr = lf - i;
      const a = pts[i], b = pts[i + 1];
      return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr];
    },

    // Light one unit's LEDs during a pulse pass: top-1 bright, runner-up
    // weaker, and a fast flicker across immediate neighbours.
    _lightUnit(f, p, l, prox) {
      if (prox <= 0) return;
      const ctx = f.ctx, model = f.model, nE = this.nE, ledR = this.ledR;
      const hop = p.hops[l];
      if (!hop) return;
      const sprite = this.hueSprites[p.cat] || this.hueSprites.word;
      const e0 = hop.experts[0];
      if (!model.isRemoved(l, e0)) {
        const c = this.nodePos(l, e0);
        VLM.drawSprite(ctx, sprite, c[0], c[1], ledR * 2 + ledR * 4 * prox, 0.7 * prox * p.glow);
        ctx.fillStyle = 'rgba(255,255,255,' + 0.85 * prox * p.glow + ')';
        ctx.beginPath(); ctx.arc(c[0], c[1], ledR * 0.7, 0, TAU); ctx.fill();
      }
      if (hop.experts.length > 1) {
        const e1 = hop.experts[1];
        const w1 = (hop.weights && hop.weights[1]) || 0;
        if (w1 > 0 && !model.isRemoved(l, e1)) {
          const c = this.nodePos(l, e1);
          VLM.drawSprite(ctx, sprite, c[0], c[1], ledR * 2 + ledR * 2 * prox, 0.4 * prox * w1 * p.glow);
        }
      }
      for (const dk of [-2, -1, 1, 2]) {
        const e2 = e0 + dk;
        if (e2 < 0 || e2 >= nE || model.isRemoved(l, e2)) continue;
        const fl = 0.5 + 0.5 * Math.sin(f.wallNow * 24 + e2 * 1.7 + p.tokenIdx * 0.7);
        const a = 0.13 * prox * p.glow * fl;
        if (a < 0.01) continue;
        const c = this.nodePos(l, e2);
        VLM.drawSprite(ctx, sprite, c[0], c[1], ledR * 2.4, a);
      }
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = this.nE, nL = this.nL, ledR = this.ledR;

      VLM.fade(ctx, w, h, 0.16, this.fadeRGB);

      // the rack, solid beneath the light
      ctx.globalAlpha = 0.62;
      ctx.drawImage(this.staticArt, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // heat: LEDs stay lit; color drifts green -> amber -> hot white-orange
      const unitHot = this._unitHot || (this._unitHot = new Float32Array(nL));
      unitHot.fill(0);
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.03 || model.isRemoved(l, e)) continue;
          const c = this.nodePos(l, e);
          const idx = clamp(Math.floor(v * LED_RAMP.length), 0, LED_RAMP.length - 1);
          VLM.drawSprite(ctx, this.heatSprites[idx], c[0], c[1], ledR * 2 + ledR * 6 * v, 0.02 + 0.035 * v);
          ctx.fillStyle = 'rgba(' + ledCore(v) + ',' + (0.35 + 0.5 * v) + ')';
          ctx.beginPath(); ctx.arc(c[0], c[1], ledR * 0.72, 0, TAU); ctx.fill();
          if (v > unitHot[l]) unitHot[l] = v;
        }
      }
      // hottest units get a warm under-glow along the faceplate edge
      for (let l = 0; l < nL; l++) {
        const v = unitHot[l];
        if (v < 0.25) continue;
        const cy = this.rowCY[l] + this.plateHalf;
        const bandH = ledR * 5;
        ctx.globalAlpha = 0.03 + 0.05 * v;
        ctx.drawImage(this.warmSprite, this.ledX0 - ledR, cy - bandH / 2,
          (nE > 1 ? (nE - 1) * this.ledStep : 0) + ledR * 2, bandH);
        ctx.globalAlpha = 1;
      }

      // ambient: sparse idle blinks (wall-clock driven, alive while paused)
      for (const b of this.ambient) {
        if (model.isRemoved(b.l, b.e)) continue;
        const ph = (f.wallNow * b.spd + b.phase) % 1;
        const on = ph < 0.05 ? 1 - ph / 0.05 : 0;
        if (on <= 0.02) continue;
        const c = this.nodePos(b.l, b.e);
        VLM.drawSprite(ctx, this.ambientSprite, c[0], c[1], ledR * 2.2, 0.12 * on);
        ctx.fillStyle = 'rgba(120,220,140,' + 0.25 * on + ')';
        ctx.beginPath(); ctx.arc(c[0], c[1], ledR * 0.6, 0, TAU); ctx.fill();
      }

      // pulses: an LED chase marching downward
      for (const p of f.pulses) {
        const path = this._pathFor(p);
        const lf = clamp(p.layerFloat, 0, nL - 1);
        const l0 = Math.min(Math.floor(lf), nL - 1);
        const l1 = Math.min(l0 + 1, nL - 1);
        const fr = clamp(lf - l0, 0, 1);
        const sprite = this.hueSprites[p.cat] || this.hueSprites.word;

        // soft glow trail behind the moving front
        const TR = 7;
        for (let i = 0; i <= TR; i++) {
          const s = lf - i * 0.1;
          if (s < 0) break;
          const c = this._ptAt(path.pts, s);
          const k = 1 - i / TR;
          VLM.drawSprite(ctx, sprite, c[0], c[1], ledR * 2 + ledR * 2 * k, 0.5 * k * p.glow);
        }

        // crisp thin data line, brightest near the front
        const head = this._ptAt(path.pts, lf);
        const back = this._ptAt(path.pts, Math.max(0, lf - 0.45));
        ctx.strokeStyle = VLM.hsla(p.hue, 90, 72, 0.55 * p.glow);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(back[0], back[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();
        const back2 = this._ptAt(path.pts, Math.max(0, lf - 0.18));
        ctx.strokeStyle = 'rgba(255,255,255,' + 0.5 * p.glow + ')';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(back2[0], back2[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();

        // moving front
        VLM.drawSprite(ctx, sprite, head[0], head[1], ledR * 5, 0.8 * p.glow);
        ctx.fillStyle = 'rgba(255,255,255,' + 0.9 * p.glow + ')';
        ctx.beginPath(); ctx.arc(head[0], head[1], ledR * 0.7, 0, TAU); ctx.fill();

        // chase: the unit being left fades, the next lights up
        this._lightUnit(f, p, l0, 1 - fr);
        if (l1 !== l0) this._lightUnit(f, p, l1, fr);
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    dispose() {
      this.paths && this.paths.clear();
      this.staticArt = null;
      this.heatSprites = null;
      this.hueSprites = null;
      this.warmSprite = null;
      this.ambientSprite = null;
      this.ambient = null;
      this._unitHot = null;
    },
  };

  VLM.registerStyle(S);
})();
