/* visual-llm style: Night Transit — the model as a dark-mode metro map.
   Layers are metro lines stacked top (layer 0) to bottom; experts are stations
   spaced along each line at grid x positions. The lines run horizontal but make
   deterministic 45-degree jogs — never curves. Token pulses are trains: bright
   capsules threading station to station down the transfer corridors, tinted by
   the token's hue. Busy stations swell and warm; reaped experts are shuttered
   stations — hollow circles with an X, dashed line gaps, dead corridors.

   MECHANICAL style: grids, straight lines, 45-degree angles. Paths are polylines
   interpolated arc-length-parameterized (see STYLE_GUIDE "Straight-line paths"),
   NOT VLM.splinePoint, so corners stay crisp. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  // Eight muted night-metro line colors (hue, sat, light) — desaturated for dark.
  const PALETTE = [
    [4, 54, 58], [28, 52, 57], [48, 46, 60], [136, 40, 55],
    [180, 44, 54], [212, 50, 60], [270, 42, 60], [326, 46, 60],
  ];

  /* ---------- pure geometry helpers ---------- */

  // y on an x-monotonic polyline at a given x (piecewise-linear).
  function polyYAt(poly, x) {
    if (x <= poly[0][0]) return poly[0][1];
    for (let i = 1; i < poly.length; i++) {
      if (x <= poly[i][0]) {
        const a = poly[i - 1], b = poly[i];
        const f = (x - a[0]) / ((b[0] - a[0]) || 1);
        return a[1] + (b[1] - a[1]) * f;
      }
    }
    return poly[poly.length - 1][1];
  }

  // Route A->B with one 45-degree corner: either vertical-then-diagonal or
  // diagonal-then-horizontal, whichever the aspect wants. Returns [A, M, B].
  function route45(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    if (ady >= adx) return [[ax, ay], [ax, by - adx * sy], [bx, by]];
    return [[ax, ay], [ax + sx * ady, by], [bx, by]];
  }

  // Build an arc-length table for a polyline; dedupes zero-length steps.
  function buildArcPath(raw) {
    const pts = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const p = raw[i], q = pts[pts.length - 1];
      if (Math.abs(p[0] - q[0]) > 0.01 || Math.abs(p[1] - q[1]) > 0.01) pts.push(p);
    }
    const cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(total);
    }
    return { pts, cum, total: total || 1 };
  }

  // Point at t in 0..1 along an arc-length-parameterized path — crisp corners.
  function polyAt(path, t) {
    const { pts, cum, total } = path;
    if (pts.length === 1) return pts[0];
    const d = VLM.clamp(t, 0, 1) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = (d - cum[i - 1]) / seg;
    const a = pts[i - 1], b = pts[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  /* ---------- static-art drawing helpers ---------- */

  function strokePoly(g, pts) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  }

  // Stroke an x-monotonic polyline, leaving a gap centered on each gapX.
  function strokePolyWithGaps(g, poly, gapXs, half) {
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const x0 = a[0], x1 = b[0];
      const seg = (xx) => [xx, a[1] + (b[1] - a[1]) * ((xx - x0) / ((x1 - x0) || 1))];
      const iv = [];
      for (let k = 0; k < gapXs.length; k++) {
        const gx = gapXs[k];
        if (gx > x0 - half && gx < x1 + half)
          iv.push([Math.max(x0, gx - half), Math.min(x1, gx + half)]);
      }
      iv.sort((p, q) => p[0] - q[0]);
      let cursor = x0;
      for (let k = 0; k < iv.length; k++) {
        if (iv[k][0] > cursor) {
          const s = seg(cursor), e = seg(iv[k][0]);
          g.beginPath(); g.moveTo(s[0], s[1]); g.lineTo(e[0], e[1]); g.stroke();
        }
        cursor = Math.max(cursor, iv[k][1]);
      }
      if (cursor < x1) {
        const s = seg(cursor), e = seg(x1);
        g.beginPath(); g.moveTo(s[0], s[1]); g.lineTo(e[0], e[1]); g.stroke();
      }
    }
  }

  function drawStation(g, x, y, r, inter) {
    if (inter) {
      const R = r * 1.6;
      g.fillStyle = 'rgba(12,16,26,1)';
      g.beginPath(); g.arc(x, y, R, 0, TAU); g.fill();
      g.lineWidth = 1.4; g.strokeStyle = 'rgba(232,240,255,0.92)';
      g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
      g.lineWidth = 1.1; g.strokeStyle = 'rgba(232,240,255,0.7)';
      g.beginPath(); g.arc(x, y, R * 0.52, 0, TAU); g.stroke();
    } else {
      g.fillStyle = 'rgba(12,16,26,1)';
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.lineWidth = 1.2; g.strokeStyle = 'rgba(224,232,248,0.85)';
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    }
  }

  function drawClosedStation(g, x, y, r) {
    g.fillStyle = 'rgba(10,13,20,1)';
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(118,128,148,0.5)';
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    const d = r * 0.72;
    g.strokeStyle = 'rgba(158,120,120,0.55)';
    g.beginPath();
    g.moveTo(x - d, y - d); g.lineTo(x + d, y + d);
    g.moveTo(x + d, y - d); g.lineTo(x - d, y + d);
    g.stroke();
  }

  function drawCorridor(g, from, to) {
    const seg = route45(from[0], from[1], to[0], to[1]);
    g.beginPath();
    g.moveTo(seg[0][0], seg[0][1]);
    for (let i = 1; i < seg.length; i++) g.lineTo(seg[i][0], seg[i][1]);
    g.stroke();
  }

  /* ================================================================= */

  const S = {
    id: 'metro',
    name: 'Night Transit',
    blurb: 'the model as a dark-mode metro map — tokens are trains threading the lines',
    bg: '#0a0d14',
    fadeRGB: '10,13,20',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.paths = new Map(); // tokenIdx -> arc-length path

      const nL = model.nLayers, nE = model.nExperts;
      const marginX = Math.max(46, w * 0.06);
      const marginTop = Math.max(46, h * 0.09);
      const marginBottom = Math.max(56, h * 0.12);
      const rowGap = nL > 1 ? (h - marginTop - marginBottom) / (nL - 1) : 0;
      const colGap = nE > 1 ? (w - 2 * marginX) / (nE - 1) : 0;
      const xL = marginX, xR = w - marginX;
      const stationR = (this.stationR = Math.max(2.4, Math.min(5, rowGap * 0.17, colGap * 0.3 + 2)));
      this.lineW = VLM.clamp(rowGap * 0.14, 2.6, 4);
      this.trainW = Math.max(this.lineW * 1.5, stationR * 1.7);

      // per-line colors (palette by layer + small deterministic jitter)
      this.lines = new Array(nL);
      for (let l = 0; l < nL; l++) {
        const base = PALETTE[l % PALETTE.length];
        const hue = base[0] + (rng() - 0.5) * 8;
        const sat = VLM.clamp(base[1] + (rng() - 0.5) * 10, 30, 70);
        const li = VLM.clamp(base[2] + (rng() - 0.5) * 6, 46, 66);
        this.lines[l] = {
          h: hue, s: sat, li: li,
          css: `hsl(${hue.toFixed(1)},${sat.toFixed(1)}%,${li.toFixed(1)}%)`,
          glow: `hsl(${hue.toFixed(1)},${Math.min(90, sat + 14).toFixed(1)}%,${Math.min(84, li + 24).toFixed(1)}%)`,
        };
      }

      // each line: horizontal baseline with 1-3 deterministic 45-degree jogs
      const jogAmt = Math.max(8, rowGap * 0.46);
      this.linePoly = new Array(nL);
      for (let l = 0; l < nL; l++) {
        const y0 = marginTop + l * rowGap;
        const poly = [[xL, y0]];
        const nJogs = 1 + Math.floor(rng() * 3);
        const usable = xR - xL;
        for (let j = 0; j < nJogs; j++) {
          const s0 = xL + usable * ((j + 0.18) / nJogs);
          const s1 = xL + usable * ((j + 0.82) / nJogs);
          const xc = VLM.lerp(s0, s1, rng());
          const dir = rng() < 0.5 ? -1 : 1;
          const pw = Math.max(colGap * 0.7, usable * 0.045 * (0.7 + rng()));
          const a = xc - pw / 2 - jogAmt, b = xc - pw / 2;
          const c = xc + pw / 2, d = xc + pw / 2 + jogAmt;
          if (a <= poly[poly.length - 1][0] + 6 || d >= xR - 6) continue;
          const yj = y0 + dir * jogAmt;
          poly.push([a, y0], [b, yj], [c, yj], [d, y0]);
        }
        poly.push([xR, y0]);
        this.linePoly[l] = poly;
      }

      // station positions: grid x, y evaluated on the line's jogged polyline
      this.pos = new Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const poly = this.linePoly[l];
        for (let e = 0; e < nE; e++) {
          const x = nE > 1 ? xL + e * colGap : w * 0.5;
          this.pos[l * nE + e] = [x, polyYAt(poly, x)];
        }
      }

      // a couple of stations per line promoted to interchange marks
      this.interchange = new Uint8Array(nL * nE);
      for (let l = 0; l < nL; l++) {
        const n = 1 + Math.floor(rng() * 2);
        for (let k = 0; k < n; k++) {
          const e = Math.floor(rng() * nE);
          if (!model.isRemoved(l, e)) this.interchange[l * nE + e] = 1;
        }
      }

      // glow sprites (built once)
      this.heatSprite = VLM.makeGlowSprite(26, 40, 92, 60);   // amber station heat
      this.headGlow = VLM.makeGlowSprite(20, 46, 55, 82);     // warm-white headlight
      this.catSprite = {};
      for (const cat of Object.keys(VLM.CATEGORY_HUES))
        this.catSprite[cat] = VLM.makeGlowSprite(18, VLM.CATEGORY_HUES[cat], 88, 66);

      // ---- static map onto an offscreen canvas ----
      const art = (this.staticArt = document.createElement('canvas'));
      art.width = Math.ceil(w);
      art.height = Math.ceil(h);
      const g = art.getContext('2d');
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // faint river: a slightly-lighter navy band crossing on 45-degree bends
      const river = [];
      let rx = -30, ry = h * (0.18 + rng() * 0.18);
      river.push([rx, ry]);
      while (rx < w + 30) {
        if (rng() < 0.5) {
          rx += colGap * (1.4 + rng() * 2.4);
        } else {
          const dd = colGap * (1 + rng() * 1.6);
          rx += dd;
          ry += (rng() < 0.62 ? 1 : -1) * dd;
        }
        ry = VLM.clamp(ry, h * 0.12, h * 0.88);
        river.push([rx, ry]);
      }
      g.strokeStyle = 'rgba(58,78,120,0.15)';
      g.lineWidth = Math.max(14, rowGap * 0.85);
      strokePoly(g, river);
      g.strokeStyle = 'rgba(82,108,152,0.10)';
      g.lineWidth = Math.max(5, rowGap * 0.34);
      strokePoly(g, river);

      // transfer corridors: thin faint dashed links to nearest stations below
      g.save();
      g.setLineDash([2, 4]);
      g.lineWidth = 1;
      for (let l = 0; l < nL - 1; l++) {
        for (let e = 0; e < nE; e++) {
          const from = this.pos[l * nE + e];
          const deadFrom = model.isRemoved(l, e);
          const nb = e === 0 ? 1 : e === nE - 1 ? nE - 2 : (rng() < 0.5 ? e - 1 : e + 1);
          const targets = nb === e ? [e] : [e, nb];
          for (let ti = 0; ti < targets.length; ti++) {
            const te = targets[ti];
            const to = this.pos[(l + 1) * nE + te];
            const dead = deadFrom || model.isRemoved(l + 1, te);
            g.strokeStyle = dead ? 'rgba(120,130,150,0.09)' : 'rgba(150,170,205,0.13)';
            drawCorridor(g, from, to);
          }
        }
      }
      g.restore();

      // the thick colored lines, with dashed-look gaps at shuttered stations
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = this.lineW;
      for (let l = 0; l < nL; l++) {
        const gapXs = [];
        for (let e = 0; e < nE; e++)
          if (model.isRemoved(l, e)) gapXs.push(this.pos[l * nE + e][0]);
        g.strokeStyle = this.lines[l].css;
        strokePolyWithGaps(g, this.linePoly[l], gapXs, stationR * 2.2);
      }

      // stations on top
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const [x, y] = this.pos[l * nE + e];
          if (model.isRemoved(l, e)) drawClosedStation(g, x, y, stationR);
          else drawStation(g, x, y, stationR, this.interchange[l * nE + e]);
        }
      }

      // legend block in the bottom-right: short colored ticks, no text
      const lgN = Math.min(8, nL);
      const tickW = 22, rowH = 9, pad = 8;
      const lgW = tickW + pad * 2;
      const lgH = lgN * rowH + pad * 2;
      const lgX = xR - lgW;
      const lgY = h - marginBottom * 0.4 - lgH;
      g.fillStyle = 'rgba(18,24,36,0.55)';
      g.strokeStyle = 'rgba(120,140,180,0.18)';
      g.lineWidth = 1;
      g.beginPath();
      g.rect(lgX, lgY, lgW, lgH);
      g.fill();
      g.stroke();
      for (let i = 0; i < lgN; i++) {
        g.strokeStyle = this.lines[i].css;
        g.lineWidth = 2.6;
        const ty = lgY + pad + i * rowH + rowH * 0.5;
        g.beginPath();
        g.moveTo(lgX + pad, ty);
        g.lineTo(lgX + pad + tickW, ty);
        g.stroke();
      }
    },

    /* Train route: top-1 station on each line, linked by 45-degree corridors. */
    _pathFor(p) {
      let cached = this.paths.get(p.tokenIdx);
      if (cached) return cached;
      const nE = this.model.nExperts, nL = this.model.nLayers;
      const raw = [];
      for (let l = 0; l < nL; l++) {
        const hop = p.hops[l];
        if (!hop) continue;
        const st = this.pos[l * nE + hop.experts[0]];
        if (raw.length === 0) {
          raw.push([st[0], st[1]]);
        } else {
          const prev = raw[raw.length - 1];
          const seg = route45(prev[0], prev[1], st[0], st[1]);
          for (let i = 1; i < seg.length; i++) raw.push(seg[i]);
        }
      }
      if (raw.length === 0) raw.push([this.w * 0.5, this.h * 0.5]);
      const path = buildArcPath(raw);
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(p.tokenIdx, path);
      return path;
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nL = model.nLayers, nE = model.nExperts;
      const stationR = this.stationR;

      VLM.fade(ctx, w, h, 0.11, this.fadeRGB);

      // the map, dim and constant beneath the light
      ctx.globalAlpha = 0.6;
      ctx.drawImage(this.staticArt, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // heat: busy stations swell, warm, and the hottest breathe a ring.
      // Persistent (fixed-position) light — keep per-frame alpha low (fade x target).
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          if (model.isRemoved(l, e)) continue;
          const v = f.heatAt(l, e);
          if (v < 0.04) continue;
          const [x, y] = this.pos[l * nE + e];

          VLM.drawSprite(ctx, this.heatSprite, x, y, stationR * 3 + v * stationR * 6, 0.02 + 0.035 * v);

          // adjacent line segment brightens a touch, in the line's own color
          const eL = Math.max(0, e - 1), eR = Math.min(nE - 1, e + 1);
          const pa = this.pos[l * nE + eL], pb = this.pos[l * nE + eR];
          ctx.strokeStyle = this.lines[l].glow;
          ctx.globalAlpha = 0.02 + 0.035 * v;
          ctx.lineWidth = this.lineW * 1.05;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo((pa[0] + x) / 2, (pa[1] + y) / 2);
          ctx.lineTo(x, y);
          ctx.lineTo((pb[0] + x) / 2, (pb[1] + y) / 2);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // the station dot itself warms toward white-amber
          ctx.fillStyle = `rgba(255,${Math.round(206 + 44 * v)},${Math.round(150 + 60 * v)},${0.03 + 0.08 * v})`;
          ctx.beginPath();
          ctx.arc(x, y, stationR * (0.9 + 0.6 * v), 0, TAU);
          ctx.fill();

          // hottest stations: a slow pulsing outer ring (ambient clock)
          if (v > 0.55) {
            const pulse = 0.5 + 0.5 * Math.sin(f.wallNow * 2.2 + (l * 7 + e) * 0.3);
            const rr = stationR * 2.3 + pulse * stationR * 1.5;
            ctx.strokeStyle = `rgba(255,${200 + Math.round(40 * pulse)},150,${0.03 + 0.05 * v})`;
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.arc(x, y, rr, 0, TAU);
            ctx.stroke();
          }
        }
      }

      // pulses: trains threading the lines
      const capLen = Math.max(14, this.trainW * 2.4);
      ctx.lineCap = 'round';
      for (const p of f.pulses) {
        const path = this._pathFor(p);
        const t = VLM.clamp(p.progress, 0, 1);
        const capFrac = Math.min(0.9, capLen / path.total);
        const head = polyAt(path, t);
        const tail = polyAt(path, Math.max(0, t - capFrac));
        const glow = p.glow;
        const sp = this.catSprite[p.cat] || this.catSprite.word;

        // faint streak behind the capsule (the fade extends it)
        for (let i = 1; i <= 3; i++) {
          const tt = t - capFrac - i * 0.02;
          if (tt <= 0) break;
          const q = polyAt(path, tt);
          VLM.drawSprite(ctx, sp, q[0], q[1], this.trainW * 1.6, 0.14 * glow * (1 - i / 4));
        }

        // capsule body — a short thick round-cap segment along travel direction
        ctx.strokeStyle = `hsla(${p.hue},85%,66%,${0.9 * glow})`;
        ctx.lineWidth = this.trainW;
        ctx.beginPath();
        ctx.moveTo(tail[0], tail[1]);
        ctx.lineTo(head[0], head[1]);
        ctx.stroke();
        // bright inner filament
        ctx.strokeStyle = `hsla(${p.hue},70%,90%,${0.75 * glow})`;
        ctx.lineWidth = this.trainW * 0.42;
        ctx.beginPath();
        ctx.moveTo(tail[0], tail[1]);
        ctx.lineTo(head[0], head[1]);
        ctx.stroke();

        // headlight glow
        VLM.drawSprite(ctx, sp, head[0], head[1], this.trainW * 3.2, 0.65 * glow);
        VLM.drawSprite(ctx, this.headGlow, head[0], head[1], this.trainW * 2, 0.55 * glow);

        // "ding": a ring flash as the train reaches each line's station
        const near = Math.round(p.layerFloat);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.42 && p.progress < 1 && p.hops[near]) {
          const hop = p.hops[near];
          const base = 1 - dist / 0.42;
          const rr = stationR * 1.5 + base * stationR * 2.4;
          const s0 = this.pos[near * nE + hop.experts[0]];
          ctx.strokeStyle = `hsla(${p.hue},80%,74%,${base * 0.55 * glow})`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(s0[0], s0[1], rr, 0, TAU);
          ctx.stroke();
          if (hop.experts.length > 1) {
            const s1 = this.pos[near * nE + hop.experts[1]];
            ctx.strokeStyle = `hsla(${p.hue},75%,70%,${base * 0.4 * hop.weights[1] * glow})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(s1[0], s1[1], rr * 0.8, 0, TAU);
            ctx.stroke();
          }
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    // REQUIRED: screen-space home of expert (l, e).
    nodePos(l, e) {
      const p = this.pos && this.pos[l * this.model.nExperts + e];
      return p ? [p[0], p[1]] : [0, 0];
    },

    dispose() {
      if (this.paths) this.paths.clear();
      this.staticArt = null;
      this.catSprite = null;
      this.heatSprite = null;
      this.headGlow = null;
    },
  };

  VLM.registerStyle(S);
})();
