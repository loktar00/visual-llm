/* visual-llm style: Blueprint — the model as a cyanotype engineering drawing
   of a great machine. Layers are horizontal sections of a schematic tower;
   experts are drafted line-art components (gears, pistons, valves, bolts,
   springs, bearings) on a strict grid. Nothing moves but the light: token
   pulses are the draftsman's lamp, tracing straight routes section by section
   and inking each component in as they cross it. Heat is ink soaking into the
   print — cold components are a barely-there ghost, hot ones are crisp and
   glowing. Reaped experts are revision-clouded deletions, crossed out, never
   inked. Two-tone throughout: Prussian-blue paper, pale white-cyan ink; only
   the pulse heads carry the faintest warm tint of their token category.

   Follows STYLE_GUIDE.md: deterministic rng layout, offscreen static art,
   prerendered glow sprites, fade-based trails, arc-length polyline routing
   (crisp corners, NOT splines), per-token path caching, heat inking with an
   early-out, and removed-expert ghosting. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;
  const INK = '215,236,250';            // pale white-cyan drafting ink
  const KINDS = ['gear', 'piston', 'valve', 'bolt', 'spring', 'bearing'];

  /* ---------- line-art component symbols (stroke-only) ----------
     Each draws with the context's CURRENT strokeStyle / lineWidth, so the very
     same routine renders the faint print, the per-frame heat inking, and the
     flash. Centered at (x, y); overall reach ~r; p carries per-symbol params. */
  function drawSymbol(g, kind, x, y, r, p) {
    switch (kind) {
      case 'gear': {
        const rr = r * 0.62;
        g.beginPath(); g.arc(x, y, rr, 0, TAU); g.stroke();
        g.beginPath(); g.arc(x, y, r * 0.22, 0, TAU); g.stroke();
        g.beginPath();
        for (let i = 0; i < p.n; i++) {
          const a = (i / p.n) * TAU + p.rot, c = Math.cos(a), s = Math.sin(a);
          g.moveTo(x + c * rr, y + s * rr);
          g.lineTo(x + c * r, y + s * r);
        }
        g.stroke();
        break;
      }
      case 'piston': {
        const wx = r * 0.82, hy = r * 1.05;
        g.strokeRect(x - wx, y - hy, wx * 2, hy * 2);
        g.strokeRect(x - wx * 0.55, y - hy * 0.15, wx * 1.1, hy * 0.55);
        g.beginPath();
        g.moveTo(x, y - hy * 0.15); g.lineTo(x, y - hy - r * 0.5);
        g.stroke();
        break;
      }
      case 'valve': {
        const rr = r * 0.6;
        g.beginPath(); g.arc(x, y, rr, 0, TAU); g.stroke();
        g.beginPath();
        g.moveTo(x - rr, y); g.lineTo(x + rr, y);
        g.moveTo(x, y - rr); g.lineTo(x, y + rr);
        g.moveTo(x, y - rr); g.lineTo(x, y - r);
        g.moveTo(x - r * 0.45, y - r); g.lineTo(x + r * 0.45, y - r);
        g.stroke();
        break;
      }
      case 'bolt': {
        const rr = r * 0.72;
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + Math.PI / 6 + p.rot;
          const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath(); g.stroke();
        g.beginPath(); g.arc(x, y, rr * 0.5, 0, TAU); g.stroke();
        break;
      }
      case 'spring': {
        const span = r * 1.1, amp = r * 0.7;
        g.beginPath();
        g.moveTo(x, y - span);
        for (let i = 1; i < p.n; i++) {
          g.lineTo(x + (i % 2 ? amp : -amp), y + VLM.lerp(-span, span, i / p.n));
        }
        g.lineTo(x, y + span);
        g.stroke();
        break;
      }
      case 'bearing': {
        g.beginPath(); g.arc(x, y, r * 0.72, 0, TAU); g.stroke();
        g.beginPath(); g.arc(x, y, r * 0.34, 0, TAU); g.stroke();
        const br = r * 0.12, mid = r * 0.53;
        g.beginPath();
        for (let i = 0; i < p.n; i++) {
          const a = (i / p.n) * TAU + p.rot;
          const cx = x + Math.cos(a) * mid, cy = y + Math.sin(a) * mid;
          g.moveTo(cx + br, cy); g.arc(cx, cy, br, 0, TAU);
        }
        g.stroke();
        break;
      }
    }
  }

  /* ---------- drafting helpers ---------- */

  // A shaft / pipe: two parallel lines offset perpendicular to the run.
  function doubleLine(g, x0, y0, x1, y1, off) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const nx = (-dy / L) * off, ny = (dx / L) * off;
    g.beginPath();
    g.moveTo(x0 + nx, y0 + ny); g.lineTo(x1 + nx, y1 + ny);
    g.moveTo(x0 - nx, y0 - ny); g.lineTo(x1 - nx, y1 - ny);
    g.stroke();
  }

  function arrowHead(g, x, y, ux, uy) {
    const a = 6, wgt = 2.4, px = -uy, py = ux;
    const bx = x + ux * a, by = y + uy * a;
    g.beginPath();
    g.moveTo(x, y); g.lineTo(bx + px * wgt, by + py * wgt);
    g.moveTo(x, y); g.lineTo(bx - px * wgt, by - py * wgt);
    g.stroke();
  }

  // Dimension between two points: extension lines, an arrow-tipped dimension
  // line offset perpendicular, and two tiny center ticks (annotation, no text).
  function dimension(g, x0, y0, x1, y1, off) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L, px = -uy, py = ux;
    const ex0 = x0 + px * off, ey0 = y0 + py * off;
    const ex1 = x1 + px * off, ey1 = y1 + py * off;
    g.beginPath();
    g.moveTo(x0 + px * 3, y0 + py * 3); g.lineTo(ex0 + px * 4, ey0 + py * 4);
    g.moveTo(x1 + px * 3, y1 + py * 3); g.lineTo(ex1 + px * 4, ey1 + py * 4);
    g.moveTo(ex0, ey0); g.lineTo(ex1, ey1);
    g.stroke();
    arrowHead(g, ex0, ey0, ux, uy);
    arrowHead(g, ex1, ey1, -ux, -uy);
    const mx = (ex0 + ex1) / 2, my = (ey0 + ey1) / 2;
    g.beginPath();
    g.moveTo(mx - ux * 3 + px * 3, my - uy * 3 + py * 3);
    g.lineTo(mx - ux * 3 - px * 3, my - uy * 3 - py * 3);
    g.moveTo(mx + ux * 3 + px * 3, my + uy * 3 + py * 3);
    g.lineTo(mx + ux * 3 - px * 3, my + uy * 3 - py * 3);
    g.stroke();
  }

  // Scalloped revision cloud: a ring of outward half-circle bumps.
  function revisionCloud(g, x, y, rad) {
    const bumps = Math.max(9, Math.round(rad * 0.6));
    const br = (TAU * rad) / bumps / 2;
    for (let i = 0; i < bumps; i++) {
      const a = (i / bumps) * TAU;
      g.beginPath();
      g.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, br, a - Math.PI / 2, a + Math.PI / 2);
      g.stroke();
    }
  }

  const S = {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'the model as a cyanotype engineering drawing — the light of the routing inks the machine in',
    bg: '#0d2242',
    fadeRGB: '13,34,66',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      const nL = (this.nL = model.nLayers);
      const nE = (this.nE = model.nExperts);
      this.paths = new Map();
      this.flash = new Float32Array(nL * nE);

      // sheet + machine geometry
      const inner = Math.max(26, Math.min(w, h) * 0.035);
      const mTop = (this.mTop = inner + 30);
      const mBottom = (this.mBottom = h - inner - 30);
      const mH = Math.max(40, mBottom - mTop);
      const drawW = w - inner * 2;
      const mW = drawW * 0.64;
      const mCx = (this.mCx = inner + drawW / 2);
      const left = mCx - mW / 2;

      // strict component grid within each horizontal section
      const secH = mH / nL;
      const rows = VLM.clamp(Math.round(Math.sqrt((nE * secH) / mW)), 1, 4);
      const cols = Math.ceil(nE / rows);
      const cellW = mW / cols, cellH = secH / rows;
      const r = (this.r = VLM.clamp(Math.min(cellW, cellH) * 0.32, 3, 12));

      this.comp = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const row = Math.floor(e / cols), col = e % cols;
          const x = left + (col + 0.5) * cellW;
          const y = mTop + l * secH + (row + 0.5) * cellH;
          const kind = KINDS[Math.floor(rng() * KINDS.length)];
          const p = { n: 6 + Math.floor(rng() * 4), rot: rng() * TAU };
          this.comp[l * nE + e] = { x, y, r, kind, p, removed: model.isRemoved(l, e) };
        }
      }

      // glow sprites: cyan heat halo + faintly-tinted white pulse heads
      this.heatGlow = VLM.makeGlowSprite(30, 190, 55, 66);
      this.pulseSprites = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES)) {
        this.pulseSprites[cat] = VLM.makeGlowSprite(22, VLM.CATEGORY_HUES[cat], 42, 82);
      }

      // ---- static drafting sheet (offscreen, ink only; paper is the bg) ----
      const sheet = document.createElement('canvas');
      sheet.width = Math.ceil(w);
      sheet.height = Math.ceil(h);
      const g = sheet.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // paper wash: a few big soft blotches so the print isn't dead flat
      for (let i = 0; i < 5; i++) {
        const bx = rng() * w, by = rng() * h, rad = Math.min(w, h) * (0.25 + rng() * 0.35);
        const col = rng() < 0.5 ? '80,120,170' : '4,14,32';
        const grad = g.createRadialGradient(bx, by, 0, bx, by, rad);
        grad.addColorStop(0, `rgba(${col},${0.04 + rng() * 0.04})`);
        grad.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
      }

      // faint square grid across the sheet
      g.strokeStyle = `rgba(${INK},0.045)`;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = inner; x <= w - inner; x += 28) { g.moveTo(x, inner); g.lineTo(x, h - inner); }
      for (let y = inner; y <= h - inner; y += 28) { g.moveTo(inner, y); g.lineTo(w - inner, y); }
      g.stroke();

      // dash-dot centerlines through the machine axis
      g.save();
      g.strokeStyle = `rgba(${INK},0.16)`;
      g.setLineDash([14, 5, 2, 5]);
      g.beginPath();
      g.moveTo(mCx, inner); g.lineTo(mCx, h - inner);
      const midY = (mTop + mBottom) / 2;
      g.moveTo(inner, midY); g.lineTo(w - inner, midY);
      g.stroke();
      g.restore();

      // connecting shafts between sections (double parallel lines)
      g.strokeStyle = `rgba(${INK},0.07)`;
      g.lineWidth = 1;
      for (let l = 0; l < nL - 1; l++) {
        for (let e = 0; e < nE; e++) {
          const a = this.comp[l * nE + e], b = this.comp[(l + 1) * nE + e];
          if (a.removed || b.removed) continue;
          doubleLine(g, a.x, a.y + r * 0.9, b.x, b.y - r * 0.9, 1.6);
          if (rng() < 0.16 && e + 1 < nE) {
            const c = this.comp[(l + 1) * nE + e + 1];
            if (!c.removed) doubleLine(g, a.x, a.y + r * 0.6, c.x, c.y - r * 0.6, 1.2);
          }
        }
      }

      // the components themselves — faint print, or revision-clouded deletion
      for (let i = 0; i < this.comp.length; i++) {
        const c = this.comp[i];
        if (c.removed) {
          g.strokeStyle = `rgba(${INK},0.06)`;
          g.lineWidth = 1;
          drawSymbol(g, c.kind, c.x, c.y, c.r, c.p);
          g.strokeStyle = `rgba(${INK},0.14)`;
          revisionCloud(g, c.x, c.y, c.r * 1.35);
          g.beginPath();
          g.moveTo(c.x - c.r, c.y - c.r); g.lineTo(c.x + c.r, c.y + c.r);
          g.moveTo(c.x + c.r, c.y - c.r); g.lineTo(c.x - c.r, c.y + c.r);
          g.stroke();
        } else {
          g.strokeStyle = `rgba(${INK},0.18)`;
          g.lineWidth = 1;
          drawSymbol(g, c.kind, c.x, c.y, c.r, c.p);
        }
      }

      // a few dimension lines between random component pairs
      g.strokeStyle = `rgba(${INK},0.13)`;
      g.lineWidth = 1;
      const nDim = VLM.clamp(Math.round(Math.min(w, h) / 130), 4, 9);
      let placed = 0, tries = 0;
      while (placed < nDim && tries < nDim * 8) {
        tries++;
        const vertical = rng() < 0.5;
        let a, b;
        if (vertical) {
          const e = Math.floor(rng() * nE);
          const l0 = Math.floor(rng() * nL), l1 = l0 + 2 + Math.floor(rng() * 4);
          if (l1 >= nL) continue;
          a = this.comp[l0 * nE + e]; b = this.comp[l1 * nE + e];
        } else {
          const l = Math.floor(rng() * nL);
          const e0 = Math.floor(rng() * nE), e1 = e0 + 2 + Math.floor(rng() * 5);
          if (e1 >= nE) continue;
          a = this.comp[l * nE + e0]; b = this.comp[l * nE + e1];
        }
        if (a.removed || b.removed) continue;
        dimension(g, a.x, a.y, b.x, b.y, (vertical ? -1 : 1) * (16 + rng() * 16));
        placed++;
      }

      // border frame + tick graticule
      g.strokeStyle = `rgba(${INK},0.30)`;
      g.lineWidth = 1.3;
      g.strokeRect(inner, inner, w - inner * 2, h - inner * 2);
      g.strokeStyle = `rgba(${INK},0.16)`;
      g.lineWidth = 1;
      g.strokeRect(inner + 6, inner + 6, w - inner * 2 - 12, h - inner * 2 - 12);
      g.strokeStyle = `rgba(${INK},0.22)`;
      g.beginPath();
      for (let x = inner; x <= w - inner; x += 40) {
        g.moveTo(x, inner); g.lineTo(x, inner + 6);
        g.moveTo(x, h - inner); g.lineTo(x, h - inner - 6);
      }
      for (let y = inner; y <= h - inner; y += 40) {
        g.moveTo(inner, y); g.lineTo(inner + 6, y);
        g.moveTo(w - inner, y); g.lineTo(w - inner - 6, y);
      }
      g.stroke();

      // title block, lower-right — solid paper panel over the drawing
      const tbW = Math.min(drawW * 0.32, 320);
      const tbH = Math.min(mH * 0.24, 132);
      const tbx = w - inner - 6 - tbW, tby = h - inner - 6 - tbH;
      g.fillStyle = 'rgba(13,34,66,0.92)';
      g.fillRect(tbx, tby, tbW, tbH);
      g.strokeStyle = `rgba(${INK},0.34)`;
      g.lineWidth = 1.3;
      g.strokeRect(tbx, tby, tbW, tbH);
      g.strokeStyle = `rgba(${INK},0.2)`;
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 1; i < 4; i++) { const yy = tby + (i * tbH) / 4; g.moveTo(tbx, yy); g.lineTo(tbx + tbW * 0.62, yy); }
      g.moveTo(tbx + tbW * 0.62, tby); g.lineTo(tbx + tbW * 0.62, tby + tbH);
      g.stroke();
      // stamp circle (double)
      const sx = tbx + tbW * 0.81, sy = tby + tbH * 0.5, sr = tbH * 0.22;
      g.strokeStyle = `rgba(${INK},0.26)`;
      g.beginPath();
      g.arc(sx, sy, sr, 0, TAU);
      g.moveTo(sx + sr * 0.7, sy); g.arc(sx, sy, sr * 0.7, 0, TAU);
      g.stroke();
      // fake signature squiggle — a few short strokes, no real glyphs
      g.strokeStyle = `rgba(${INK},0.3)`;
      g.lineWidth = 1.1;
      for (let s = 0; s < 3; s++) {
        const bx = tbx + tbW * (0.1 + s * 0.14), by = tby + tbH * 0.72;
        g.beginPath();
        g.moveTo(bx, by);
        for (let k = 1; k <= 4; k++) {
          g.quadraticCurveTo(bx + k * 6 - 3, by - 6 + rng() * 12, bx + k * 6, by + (rng() - 0.5) * 6);
        }
        g.stroke();
      }

      this.sheet = sheet;
    },

    /* ---------- per-token routing (straight polyline, arc-length param) ---------- */

    _pathFor(pulse) {
      let path = this.paths.get(pulse.tokenIdx);
      if (path) return path;
      const nE = this.nE, nL = this.nL;
      const pts = [];
      for (let l = 0; l < nL; l++) {
        const hop = pulse.hops[l];
        if (!hop || !hop.experts.length) continue;
        const c = this.comp[l * nE + hop.experts[0]];
        pts.push([c.x, c.y]);
      }
      if (pts.length === 0) pts.push([this.mCx, this.mTop]);
      pts.unshift([pts[0][0], this.mTop - 22]);              // lamp enters top
      pts.push([pts[pts.length - 1][0], this.mBottom + 22]); // and leaves bottom
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      path = { pts, cum, total: cum[cum.length - 1] || 1 };
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, path);
      return path;
    },

    _at(path, t) {
      const { pts, cum, total } = path;
      if (pts.length === 1) return pts[0];
      const d = VLM.clamp(t, 0, 1) * total;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1] || 1;
      const f = (d - cum[i - 1]) / seg;
      const a = pts[i - 1], b = pts[i];
      return [VLM.lerp(a[0], b[0], f), VLM.lerp(a[1], b[1], f)];
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h } = f;
      const nE = this.nE, nL = this.nL, r = this.r;

      // 1. fade toward the Prussian-blue paper — short crisp trails
      VLM.fade(ctx, w, h, 0.14, this.fadeRGB);

      // 2. the drawing itself, redrawn crisp beneath the light
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.sheet, 0, 0, w, h);

      // 3. flash map: which components the light is crossing this instant
      const flash = this.flash;
      flash.fill(0);
      for (const p of f.pulses) {
        const lf = VLM.clamp(p.layerFloat, 0, nL - 1);
        const near = Math.round(lf);
        const dist = Math.abs(lf - near);
        if (dist >= 0.5 || p.progress >= 1) continue;
        const hop = p.hops[near];
        if (!hop) continue;
        const beat = (1 - dist * 2) * p.glow;
        const kmax = Math.min(2, hop.experts.length);
        for (let k = 0; k < kmax; k++) {
          const idx = near * nE + hop.experts[k];
          const v = beat * (k === 0 ? 1 : (hop.weights[k] || 0) * 1.4);
          if (v > flash[idx]) flash[idx] = v;
        }
      }

      // 4. ink the machine in where heat + light live (opaque, freshly drawn)
      ctx.lineCap = 'round';
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const idx = l * nE + e;
          const c = this.comp[idx];
          if (c.removed) continue;
          const heat = f.heatAt(l, e);
          const hi = heat > 0.03 ? Math.pow((heat - 0.03) / 0.97, 0.7) * 0.85 : 0;
          const a = Math.max(hi, flash[idx]);
          if (a < 0.04) continue;
          ctx.strokeStyle = `rgba(232,246,255,${VLM.clamp(a, 0, 1)})`;
          ctx.lineWidth = 1 + a * 0.6;
          drawSymbol(ctx, c.kind, c.x, c.y, c.r, c.p);
        }
      }

      // 5. additive light: cyan glow behind hot parts + the travelling lamps
      ctx.globalCompositeOperation = 'lighter';

      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const heat = f.heatAt(l, e);
          if (heat < 0.06) continue;
          const c = this.comp[l * nE + e];
          if (c.removed) continue;
          VLM.drawSprite(ctx, this.heatGlow, c.x, c.y, c.r * 3 + heat * c.r * 4, 0.05 * heat);
        }
      }

      for (const p of f.pulses) {
        const path = this._pathFor(p);
        const spr = this.pulseSprites[p.cat] || this.pulseSprites.word;
        const t = p.progress;
        // short trailing streak — colinear on the straight runs
        for (let i = 6; i >= 1; i--) {
          const tt = t - i * 0.012;
          if (tt <= 0) continue;
          const [x, y] = this._at(path, tt);
          VLM.drawSprite(ctx, spr, x, y, 9 - i * 0.7, (1 - i / 6) * 0.4 * p.glow);
        }
        const [hx, hy] = this._at(path, t);
        VLM.drawSprite(ctx, spr, hx, hy, r * 2.4 + 6, 0.85 * p.glow);
        ctx.fillStyle = `rgba(240,252,255,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.6, 0, TAU);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    nodePos(l, e) {
      const c = this.comp && this.comp[l * this.nE + e];
      return c ? [c.x, c.y] : [0, 0];
    },

    dispose() {
      this.paths && this.paths.clear();
      this.sheet = null;
      this.comp = null;
      this.flash = null;
    },
  };

  VLM.registerStyle(S);
})();
