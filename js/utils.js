/* visual-llm — shared helpers + style registry.
   Classic script (no modules) so index.html works over file:// with no server.
   Everything lives under window.VLM. Every other file wraps itself in an IIFE. */
(function () {
  'use strict';
  const VLM = (window.VLM = window.VLM || {});

  VLM.TAU = Math.PI * 2;

  /* ---------- deterministic randomness ---------- */

  VLM.hashStr = function (s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  VLM.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* ---------- math ---------- */

  VLM.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  VLM.lerp = (a, b, t) => a + (b - a) * t;
  VLM.smoothstep = (t) => {
    t = VLM.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };
  VLM.easeInOut = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /* ---------- color ---------- */

  VLM.hsla = (h, s, l, a) => `hsla(${h},${s}%,${l}%,${a})`;

  // Token-category hues used across all styles so the color language is shared.
  VLM.CATEGORY_HUES = { word: 205, code: 135, number: 290, punct: 45 };

  // Inferno-like heat ramp: near-black violet -> crimson -> amber -> white.
  const HEAT_STOPS = [
    [0.0, 6, 5, 18],
    [0.2, 45, 12, 78],
    [0.45, 150, 32, 70],
    [0.7, 235, 110, 35],
    [0.88, 252, 190, 80],
    [1.0, 255, 246, 214],
  ];
  VLM.heatRGB = function (t) {
    t = VLM.clamp(t, 0, 1);
    for (let i = 1; i < HEAT_STOPS.length; i++) {
      if (t <= HEAT_STOPS[i][0]) {
        const [t0, r0, g0, b0] = HEAT_STOPS[i - 1];
        const [t1, r1, g1, b1] = HEAT_STOPS[i];
        const f = (t - t0) / (t1 - t0 || 1);
        return [
          Math.round(VLM.lerp(r0, r1, f)),
          Math.round(VLM.lerp(g0, g1, f)),
          Math.round(VLM.lerp(b0, b1, f)),
        ];
      }
    }
    return [255, 246, 214];
  };
  VLM.heatColor = function (t, a = 1) {
    const [r, g, b] = VLM.heatRGB(t);
    return `rgba(${r},${g},${b},${a})`;
  };

  /* ---------- canvas helpers ---------- */

  // Trail fade: paint a translucent rect of the style's background color.
  // Called at the top of render() instead of clearing — motion leaves streaks.
  VLM.fade = function (ctx, w, h, alpha, rgb) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(${rgb || '4,6,12'},${alpha})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  };

  // Pre-rendered radial glow sprite. Build once in init(), draw many per frame.
  VLM.makeGlowSprite = function (radius, hue, sat = 90, light = 62) {
    const r = Math.max(2, radius | 0);
    const c = document.createElement('canvas');
    c.width = c.height = r * 2;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, VLM.hsla(hue, Math.min(100, sat), Math.min(96, light + 32), 0.95));
    grad.addColorStop(0.3, VLM.hsla(hue, sat, light, 0.6));
    grad.addColorStop(0.7, VLM.hsla(hue, sat, Math.max(20, light - 12), 0.18));
    grad.addColorStop(1, VLM.hsla(hue, sat, light, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
    return c;
  };

  // Draw a sprite centered at (x, y), scaled so its footprint is `size` px wide.
  VLM.drawSprite = function (ctx, sprite, x, y, size, alpha = 1) {
    if (alpha <= 0 || size <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
  };

  /* ---------- splines (Catmull-Rom) ---------- */

  function crPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    ];
  }

  // Point along a smooth curve through pts (array of [x,y]) at t in 0..1.
  VLM.splinePoint = function (pts, t) {
    const n = pts.length;
    if (n === 0) return [0, 0];
    if (n === 1) return pts[0];
    t = VLM.clamp(t, 0, 1);
    const f = t * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const lt = f - i;
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    return crPoint(p0, p1, p2, p3, lt);
  };

  // Stroke a smooth path through pts using the current ctx stroke state.
  VLM.spline = function (ctx, pts, samplesPerSeg = 6) {
    const n = pts.length;
    if (n < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      for (let s = 1; s <= samplesPerSeg; s++) {
        const [x, y] = crPoint(p0, p1, p2, p3, s / samplesPerSeg);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  /* ---------- style registry ---------- */

  VLM.styles = [];
  VLM.registerStyle = function (def) {
    if (
      !def ||
      typeof def.id !== 'string' ||
      typeof def.init !== 'function' ||
      typeof def.render !== 'function'
    ) {
      console.error('VLM.registerStyle: invalid style definition', def);
      return;
    }
    if (VLM.styles.some((s) => s.id === def.id)) {
      console.warn('VLM.registerStyle: duplicate id', def.id);
      return;
    }
    def.name = def.name || def.id;
    def.blurb = def.blurb || '';
    def.bg = def.bg || '#04060c';
    def.fadeRGB = def.fadeRGB || '4,6,12';
    VLM.styles.push(def);
  };
})();
