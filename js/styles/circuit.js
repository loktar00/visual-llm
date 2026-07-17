/* visual-llm style: Copper Trace — the model as a printed circuit board.
   Layers are horizontal bus rows (layer 0 up top), experts are components
   soldered along each row on a strict grid: IC chips, vias, SMD pads. Copper
   traces route between rows the way real PCBs do — vertical, a 45° chamfer,
   then horizontal. A token is a signal: a cyan-green light that runs the
   Manhattan route through its top-1 component per layer, flashing each chip as
   it arrives. Heat is working silicon: pads glow amber. Reaped experts are
   unpopulated footprints — bare silkscreen, dead copper, never lit.

   MECHANICAL style: grid-aligned, rectilinear, right angles. Signal geometry
   is an arc-length-parameterized polyline (NOT VLM.splinePoint) so the light
   turns crisp corners. */
(function () {
  'use strict';
  const VLM = window.VLM;
  const TAU = VLM.TAU;

  const SOLDER = '#03110a';
  const TRACE = 'rgba(184,124,58,0.16)';
  const TRACE_PAIR = 'rgba(184,124,58,0.10)';
  const TRACE_CUT = 'rgba(184,124,58,0.30)';

  /* ---------- Manhattan routing + arc-length polyline ---------- */

  // Route from a top point down to a bottom point PCB-style: vertical run,
  // 45° chamfer, horizontal run, 45° chamfer, vertical run. Returns [x,y] pts.
  function routeSeg(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (Math.abs(dx) < 0.75) return [[x0, y0], [x1, y1]];
    const sgn = dx > 0 ? 1 : -1;
    const c = Math.min(Math.abs(dx) / 2, Math.abs(dy) * 0.35, 11);
    const yh = y0 + dy * 0.5;
    return [
      [x0, y0],
      [x0, yh - c],
      [x0 + sgn * c, yh],
      [x1 - sgn * c, yh],
      [x1, yh + c],
      [x1, y1],
    ];
  }

  // Precompute cumulative segment lengths so t∈0..1 maps to a point by
  // distance travelled — corners stay sharp, speed stays even.
  function buildPath(pts) {
    const cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(total);
    }
    return { pts, cum, total: total || 1 };
  }

  function pointAt(path, t) {
    const { pts, cum, total } = path;
    if (pts.length < 2) return [pts[0][0], pts[0][1]];
    const d = VLM.clamp(t, 0, 1) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = (d - cum[i - 1]) / seg;
    const a = pts[i - 1];
    const b = pts[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  function strokePoly(g, pts, ox, oy) {
    g.beginPath();
    g.moveTo(pts[0][0] + ox, pts[0][1] + oy);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + ox, pts[i][1] + oy);
    g.stroke();
  }

  const S = {
    id: 'circuit',
    name: 'Copper Trace',
    blurb: 'the model as a printed circuit board — tokens are signals racing the copper, silicon warms as it works',
    bg: SOLDER,
    fadeRGB: '3,17,10',

    /* ---------- layout + static art ---------- */

    init({ ctx, w, h, model, rng }) {
      this.ctx = ctx;
      this.w = w;
      this.h = h;
      this.model = model;
      this.rng = rng;
      this.nE = model.nExperts;
      this.paths = new Map();

      const nL = model.nLayers;
      const nE = model.nExperts;
      const marginX = Math.max(30, w * 0.05);
      const marginY = Math.max(30, h * 0.06);
      const top = (this.top = marginY);
      const bottom = h - marginY;
      const rowGap = (this.rowGap = nL > 1 ? (bottom - top) / (nL - 1) : 0);
      const colGap = (w - 2 * marginX) / nE;

      // component footprints on a strict grid, small alternating per-row x-shift
      const comps = (this.comps = new Array(nL * nE));
      for (let l = 0; l < nL; l++) {
        const y = nL > 1 ? top + rowGap * l : h * 0.5;
        const rowOff = ((l % 2) * 2 - 1) * colGap * 0.16;
        for (let e = 0; e < nE; e++) {
          const x = marginX + colGap * (e + 0.5) + rowOff;
          const removed = model.isRemoved(l, e);
          const r = rng();
          const kind = r < 0.5 ? 0 : r < 0.8 ? 1 : 2; // chip / via / smd
          let hw, hh;
          if (kind === 0) {
            hw = Math.min(colGap * 0.30, 9);
            hh = Math.min(rowGap * 0.24 || 6, 6);
          } else if (kind === 1) {
            hw = hh = Math.min(colGap * 0.17, rowGap * 0.17 || 5, 5);
          } else {
            hw = Math.min(colGap * 0.24, 7);
            hh = Math.min(rowGap * 0.16 || 4, 4);
          }
          comps[l * nE + e] = { x, y, kind, hw, hh, removed };
        }
      }

      // glow sprites — built once
      this.sig = VLM.makeGlowSprite(18, 158, 92, 60); // cyan-green signal
      this.heatSprite = VLM.makeGlowSprite(26, 32, 96, 56); // amber silicon heat
      this.ledSprites = {
        g: VLM.makeGlowSprite(11, 135, 96, 60),
        r: VLM.makeGlowSprite(11, 6, 96, 56),
      };

      // one or two sparse "power LED" blinkers
      this.leds = [];
      const nLed = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < nLed; i++) {
        const green = rng() < 0.55;
        this.leds.push({
          x: marginX + rng() * (w - 2 * marginX),
          y: marginY + rng() * (h - 2 * marginY),
          rate: TAU / (2.2 + rng() * 1.8),
          phase: rng() * TAU,
          sprite: green ? this.ledSprites.g : this.ledSprites.r,
        });
      }

      // ---------- static art: soldermask, drill grid, traces, components ----------
      const board = (this.staticArt = document.createElement('canvas'));
      board.width = Math.ceil(w);
      board.height = Math.ceil(h);
      const g = board.getContext('2d');
      g.fillStyle = SOLDER;
      g.fillRect(0, 0, w, h);

      // faint drill-hole dot grid across the whole board
      const pitch = VLM.clamp(Math.round(Math.min(w, h) / 46), 16, 30);
      g.fillStyle = 'rgba(0,0,0,0.20)';
      for (let y = pitch; y < h; y += pitch)
        for (let x = pitch; x < w; x += pitch) g.fillRect(x - 0.5, y - 0.5, 1, 1);

      // copper traces: each populated component fans to 2-3 nearby components
      // in the next row via Manhattan routing; some pairs run parallel
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const offsOrder = [0, -1, 1, 2, -2];
      for (let l = 0; l < nL - 1; l++) {
        for (let e = 0; e < nE; e++) {
          const a = comps[l * nE + e];
          if (a.removed) continue; // unpopulated: nothing to solder
          const want = 2 + (rng() < 0.45 ? 1 : 0);
          let drawn = 0;
          for (let k = 0; k < offsOrder.length && drawn < want; k++) {
            const te = e + offsOrder[k];
            if (te < 0 || te >= nE) continue;
            const b = comps[(l + 1) * nE + te];
            if (b.removed) {
              // trace toward a dead footprint ends in a tiny cut mark
              const my = a.y + (b.y - a.y) * 0.5;
              g.strokeStyle = TRACE;
              g.lineWidth = 1;
              g.beginPath();
              g.moveTo(a.x, a.y);
              g.lineTo(a.x, my);
              g.stroke();
              g.strokeStyle = TRACE_CUT;
              g.beginPath();
              g.moveTo(a.x - 3, my);
              g.lineTo(a.x + 3, my);
              g.stroke();
              drawn++;
              continue;
            }
            const pts = routeSeg(a.x, a.y, b.x, b.y);
            g.strokeStyle = TRACE;
            g.lineWidth = 1;
            strokePoly(g, pts, 0, 0);
            if (rng() < 0.22) {
              g.strokeStyle = TRACE_PAIR;
              strokePoly(g, pts, 2.5, 2.5); // parallel trace pair
            }
            drawn++;
          }
        }
      }

      // components, dark and dormant, over the copper
      for (let i = 0; i < comps.length; i++) this._drawComp(g, comps[i]);

      // fake silkscreen: tiny faint white reference-designator dashes
      g.strokeStyle = 'rgba(214,232,224,0.11)';
      g.lineWidth = 1;
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        if (rng() > 0.28) continue;
        const dx = c.x - c.hw - 3;
        const dy = c.y - c.hh - 3;
        g.beginPath();
        g.moveTo(dx - 5, dy);
        g.lineTo(dx, dy);
        g.stroke();
      }
    },

    // draw a single dormant component into the static-art context
    _drawComp(g, c) {
      if (c.removed) {
        g.strokeStyle = 'rgba(210,230,220,0.10)';
        g.lineWidth = 1;
        g.strokeRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2); // silkscreen only
        g.fillStyle = 'rgba(44,64,54,0.35)';
        g.fillRect(c.x - c.hw - 3, c.y - 1.5, 3, 3); // bare pads
        g.fillRect(c.x + c.hw, c.y - 1.5, 3, 3);
        return;
      }
      if (c.kind === 0) {
        // IC chip: dark body, thin border, pin-1 dot, pin stubs top & bottom
        g.fillStyle = 'rgba(7,15,11,1)';
        g.fillRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2);
        g.strokeStyle = 'rgba(58,88,72,0.55)';
        g.lineWidth = 1;
        g.strokeRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2);
        g.fillStyle = 'rgba(150,110,60,0.55)';
        g.beginPath();
        g.arc(c.x - c.hw + 2.2, c.y - c.hh + 2.2, 1, 0, TAU);
        g.fill();
        g.fillStyle = 'rgba(150,110,60,0.40)';
        const np = 3;
        for (let i = 0; i < np; i++) {
          const px = c.x - c.hw + (c.hw * 2) * ((i + 0.5) / np);
          g.fillRect(px - 0.8, c.y - c.hh - 2, 1.6, 2);
          g.fillRect(px - 0.8, c.y + c.hh, 1.6, 2);
        }
      } else if (c.kind === 1) {
        // via: copper ring pad with a drilled dark center
        g.strokeStyle = 'rgba(184,124,58,0.42)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(c.x, c.y, c.hw, 0, TAU);
        g.stroke();
        g.fillStyle = SOLDER;
        g.beginPath();
        g.arc(c.x, c.y, c.hw * 0.45, 0, TAU);
        g.fill();
      } else {
        // SMD component: two copper pads flanking a dark body
        g.fillStyle = 'rgba(160,110,55,0.42)';
        g.fillRect(c.x - c.hw, c.y - 2, c.hw * 0.7, 4);
        g.fillRect(c.x + c.hw * 0.3, c.y - 2, c.hw * 0.7, 4);
        g.fillStyle = 'rgba(20,30,25,0.9)';
        g.fillRect(c.x - c.hw * 0.32, c.y - 2.5, c.hw * 0.64, 5);
      }
    },

    /* Signal geometry: enter from the top bus, then route top-1 -> top-1
       through every layer. Cached per token, arc-length parameterized. */
    _pathFor(pulse) {
      let path = this.paths.get(pulse.tokenIdx);
      if (path) return path;
      const nE = this.nE;
      const nL = this.model.nLayers;
      const c0 = this.comps[pulse.hops[0].experts[0]];
      const entryY = Math.max(4, this.top - this.rowGap * 0.45);
      const pts = [[c0.x, entryY], [c0.x, c0.y]];
      for (let l = 0; l < nL - 1; l++) {
        const a = this.comps[l * nE + pulse.hops[l].experts[0]];
        const b = this.comps[(l + 1) * nE + pulse.hops[l + 1].experts[0]];
        const seg = routeSeg(a.x, a.y, b.x, b.y);
        for (let i = 1; i < seg.length; i++) pts.push(seg[i]); // skip shared node
      }
      path = buildPath(pts);
      if (this.paths.size > 64) this.paths.clear();
      this.paths.set(pulse.tokenIdx, path);
      return path;
    },

    // bright flash of a component as a signal lands on it
    _flash(ctx, c, a) {
      if (a <= 0) return;
      const s = Math.max(c.hw, c.hh);
      VLM.drawSprite(ctx, this.sig, c.x, c.y, s * 6 + 10, a * 0.5);
      ctx.fillStyle = `rgba(120,255,200,${a * 0.5})`;
      ctx.fillRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2);
      ctx.strokeStyle = `rgba(205,255,232,${a * 0.7})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2);
      if (c.kind === 0) {
        // pins glow briefly
        ctx.fillStyle = `rgba(180,255,220,${a * 0.6})`;
        const np = 3;
        for (let i = 0; i < np; i++) {
          const px = c.x - c.hw + c.hw * 2 * ((i + 0.5) / np);
          ctx.fillRect(px - 0.9, c.y - c.hh - 2, 1.8, 2);
          ctx.fillRect(px - 0.9, c.y + c.hh, 1.8, 2);
        }
      }
    },

    /* ---------- per-frame ---------- */

    render(f) {
      const { ctx, w, h, model } = f;
      const nE = this.nE;
      const nL = model.nLayers;

      VLM.fade(ctx, w, h, 0.12, this.fadeRGB); // short trails

      ctx.globalAlpha = 0.62;
      ctx.drawImage(this.staticArt, 0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // heat: silicon warming under load, amber pads with a thermal halo
      for (let l = 0; l < nL; l++) {
        for (let e = 0; e < nE; e++) {
          const v = f.heatAt(l, e);
          if (v < 0.04) continue;
          const c = this.comps[l * nE + e];
          if (c.removed) continue;
          VLM.drawSprite(ctx, this.heatSprite, c.x, c.y, 12 + 52 * v, Math.pow(v, 0.7) * 0.1);
          ctx.fillStyle = VLM.heatColor(0.35 + v * 0.6, Math.pow(v, 0.8) * 0.1);
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(c.hw, c.hh) * 0.7, 0, TAU);
          ctx.fill();
          if (v > 0.6) {
            ctx.strokeStyle = VLM.heatColor(v * 0.6, 0.05);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(c.x, c.y, Math.max(c.hw, c.hh) * 2.4, 0, TAU);
            ctx.stroke();
          }
        }
      }

      // signals: cyan-green light running the copper
      for (const p of f.pulses) {
        const path = this._pathFor(p);
        const t = p.progress;

        // short trailing streak behind the head
        const TRAIL = 8;
        for (let i = TRAIL; i >= 1; i--) {
          const tt = t - i * 0.012;
          if (tt <= 0) continue;
          const [x, y] = pointAt(path, tt);
          VLM.drawSprite(ctx, this.sig, x, y, 9 - i * 0.5, (1 - i / TRAIL) * 0.4 * p.glow);
        }

        // head
        const [hx, hy] = pointAt(path, t);
        VLM.drawSprite(ctx, this.sig, hx, hy, 16, 0.9 * p.glow);
        ctx.fillStyle = `rgba(212,255,236,${0.9 * p.glow})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.6, 0, TAU);
        ctx.fill();

        // flash the component the signal is crossing; runner-up flashes weaker
        const near = Math.round(p.layerFloat);
        const dist = Math.abs(p.layerFloat - near);
        if (dist < 0.5 && p.progress < 1 && near >= 0 && near < nL) {
          const hop = p.hops[near];
          const flash = (1 - dist * 2) * p.glow;
          this._flash(ctx, this.comps[near * nE + hop.experts[0]], flash);
          if (hop.experts.length > 1) {
            this._flash(
              ctx,
              this.comps[near * nE + hop.experts[1]],
              flash * VLM.clamp(hop.weights[1] * 1.8, 0, 0.7)
            );
          }
        }
      }

      // ambient power-LED blinks — wall clock so they live even when paused
      for (const led of this.leds) {
        const b = Math.pow(Math.max(0, Math.sin(f.wallNow * led.rate + led.phase)), 22);
        if (b < 0.02) continue;
        VLM.drawSprite(ctx, led.sprite, led.x, led.y, 8 + 10 * b, b * 0.85);
        ctx.fillStyle = `rgba(255,255,255,${b * 0.7})`;
        ctx.beginPath();
        ctx.arc(led.x, led.y, 1.3, 0, TAU);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    },

    // base screen home of an expert's component — powers the reap lens overlay
    nodePos(l, e) {
      const c = this.comps && this.comps[l * this.nE + e];
      return c ? [c.x, c.y] : [0, 0];
    },

    dispose() {
      this.paths && this.paths.clear();
      this.staticArt = null;
      this.sig = null;
      this.heatSprite = null;
      this.ledSprites = null;
      this.comps = null;
      this.leds = null;
    },
  };

  VLM.registerStyle(S);
})();
