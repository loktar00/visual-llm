# visual-llm — style module contract

A *style* is one full-screen artistic rendering of the same underlying data:
tokens descending through the layers of a Mixture-of-Experts model, choosing
`top_k` experts per layer. Styles are art first — legibility of the metaphor
matters more than scientific precision.

**Read `js/styles/web.js` before writing a style. It is the reference
implementation of everything below.** Also skim `js/utils.js` (helpers) and
the frame construction at the bottom of `js/replay.js`.

## File shape — MUST follow exactly

- One file: `js/styles/<id>.js`. **Classic script, NOT a module** — no
  `import`/`export` anywhere (the app runs over `file://`).
- Wrap the whole file in `(function () { 'use strict'; ... })();` — top-level
  `const` in classic scripts collides across files otherwise.
- Register with `VLM.registerStyle({...})` at the end of the IIFE.
- No external assets, fonts, images, or network requests. No `Date.now()` /
  `performance.now()` — use `frame.now` / `frame.wallNow`.

## Style definition

```js
VLM.registerStyle({
  id: 'web',                 // matches filename
  name: 'Orb Weaver',        // shown in the HUD
  blurb: 'one poetic line about the metaphor',
  bg: '#04070e',             // solid background color
  fadeRGB: '4,7,14',         // same color as bg, as "r,g,b" — used for trails
  init(initCtx) {},          // build layout + offscreen art. May be called
                             // again on resize — must be idempotent.
  render(frame) {},          // called every animation frame
  nodePos(l, e) {},          // REQUIRED for new styles: return [x, y] — the
                             // screen-space home of that expert in your layout
                             // (base position; ignore per-frame sway). Powers
                             // the app-wide "reap lens" overlay that dims the
                             // scene and marks cold experts in the art itself.
                             // If your whole layout rotates/scrolls over time,
                             // apply the current transform here too.
  dispose() {},              // drop big references (offscreen canvases, caches)
});
```

### `init(initCtx)` receives

```js
{ canvas, ctx,          // the live 2D context (already DPR-scaled: work in CSS px)
  w, h, dpr,            // canvas size in CSS pixels
  model,                // { name, nLayers, nExperts, topK,
                        //   isRemoved(l, e) -> bool }   // REAP-pruned slot?
  rng }                 // seeded () => 0..1 — use for ALL layout randomness so
                        // the layout is identical on every load. Store it on
                        // `this` if render needs it. Do not use Math.random().
```

Your job in `init`: decide where every (layer, expert) pair lives on screen
(store positions), and pre-render all static art onto offscreen canvases and
glow sprites. The engine fills the canvas with `bg` before calling `init`.

### `render(frame)` receives

```js
{ ctx, w, h, dpr,
  now,        // sim seconds — data clock; frozen while paused
  wallNow,    // wall seconds — always advances; use for ambient sway/shimmer
  dt, wallDt, // deltas for the two clocks
  model,      // same object as init
  pulses,     // tokens currently in flight (typically 5-7), see below
  heatAt(l, e),   // 0..1 — recent activity, decays over ~9s. THE hot/cold signal.
  usageAt(l, e),  // 0..1 — cumulative activity since the loop started, no decay
  heat, usage, heatMax, usageMax,  // raw Float32Array [l * nExperts + e]
  progress,   // 0..1 through the recording
  playing, speed, tokensDone, totalTokens }
```

### A pulse (one token in flight)

```js
{ tokenIdx,    // stable id — use as cache key for per-token geometry
  text, cat,   // cat in {word, code, number, punct}
  hue,         // suggested color hue (category hue + small per-token variation)
  progress,    // 0..1 descent through the layer stack
  layerFloat,  // progress * (nLayers - 1) — fractional layer position
  glow,        // 1 while traveling, then fades 1 -> 0 over ~0.8s after landing
  hops }       // per-layer routing: hops[l] = { experts: [i...], weights: [w...],
               //   delta }  — experts sorted by descending weight, weights sum ~1
```

## Rendering pattern (the trail trick)

The engine never clears the canvas — trails come from fading it yourself:

```js
render(f) {
  VLM.fade(f.ctx, f.w, f.h, 0.1, this.fadeRGB); // 1. fade previous frame
  f.ctx.globalAlpha = 0.5;                       // 2. re-draw static art dimly
  f.ctx.drawImage(this.staticCanvas, 0, 0, f.w, f.h);
  f.ctx.globalAlpha = 1;
  f.ctx.globalCompositeOperation = 'lighter';    // 3. additive light pass
  // ... heat glows, then pulses ...
  f.ctx.globalCompositeOperation = 'source-over'; // 4. ALWAYS restore
}
```

Lower fade alpha = longer streaks. 0.06–0.14 is the sweet spot.

### Additive accumulation — the #1 tuning trap

Under a fade of alpha `f`, any additive ('lighter') light you redraw at the
SAME position every frame at alpha `a` settles at roughly `a / f` brightness.
With `f = 0.1`, drawing a glow at `a = 0.5` per frame accumulates to 5× — a
blown-out white blob. Rules of thumb:

- Persistent glows (heat, ambient, static-position lights): per-frame alpha
  ≈ `fade × target` — think 0.02–0.06, not 0.3–0.9.
- Moving lights (pulse heads, trails) don't accumulate — normal alphas are fine.
- Filled shapes re-lit additively every frame (glass panes, LED lenses, windows)
  clip toward white past saturation — cap their per-frame alpha low, or skip
  the fade entirely and repaint your static art opaque each frame, computing
  all light fresh from current heat (valid for styles that don't need trails).

### Naming hazard

Never assign `this.bg` inside init — `bg` is the style's background-color
string, which the engine reads on every re-init. Name offscreen canvases
`this.staticArt` / `this.night` / etc.

### Straight-line paths (mechanical styles)

`VLM.splinePoint` smooths corners away. For crisp right-angle or 45° routing,
build a polyline and interpolate it arc-length-parameterized yourself:
precompute cumulative segment lengths, then map t∈0..1 to a point. ~10 lines
of code; cache it per tokenIdx like any path. Long straight stroked polylines
redrawn every frame read as scratches — prefer moving sprite heads with short
trails (the fade supplies the streak).

## Helpers in `js/utils.js` (`window.VLM`)

- `VLM.TAU`, `clamp`, `lerp`, `smoothstep(t)`, `easeInOut(t)`
- `VLM.hashStr(s)`, `VLM.mulberry32(seed)` — extra deterministic RNGs
- `VLM.hsla(h, s, l, a)`
- `VLM.CATEGORY_HUES` — `{word: 205, code: 135, number: 290, punct: 45}`
- `VLM.heatRGB(t)` / `VLM.heatColor(t, a)` — shared inferno-like heat ramp
- `VLM.fade(ctx, w, h, alpha, rgb)` — the trail fade
- `VLM.makeGlowSprite(radius, hue, sat, light)` — pre-rendered radial glow
- `VLM.drawSprite(ctx, sprite, x, y, size, alpha)` — draw it centered
- `VLM.splinePoint(pts, t)` — point at t∈0..1 along a Catmull-Rom through pts
- `VLM.spline(ctx, pts)` — stroke that curve

## Performance budget (60 fps at 1080p, Canvas 2D)

- Pre-render every static thing in `init` (offscreen canvas). Never redraw
  complex static geometry per frame.
- Pre-build glow sprites in `init`; `drawImage` is cheap, `createRadialGradient`
  per frame is not (keep < ~100/frame).
- Iterate all `nLayers × nExperts` cells per frame only with an early-out
  (`if (v < 0.03) continue;`). Worst case is 32 × 64 = 2048 cells.
- Cache per-token geometry (paths) in a `Map` keyed by `pulse.tokenIdx`; clear
  it when it grows past ~64 entries, and in `dispose`.

## Correctness checklist

- Handles any model size gracefully: 24–32 layers, 32–64 experts, topK 4–8.
- Uses `model.isRemoved(l, e)` — pruned slots render as ghosts/scars/gaps
  (dim, broken, dead) and routing never visits them, so don't light them.
- Uses `pulse.hue` / `VLM.CATEGORY_HUES` so token colors mean the same thing
  in every style; heat uses warm tones (or `VLM.heatColor`) unless the
  metaphor demands otherwise.
- Ambient motion (sway, twinkle, ripple) uses `wallNow`; anything data-driven
  uses `now` / pulse fields, so pausing freezes the data but the scene stays alive.
- `render` must not throw for empty `pulses`, heat all zeros, or 1-token
  recordings. Restore `globalCompositeOperation`/`globalAlpha` before returning.
- Layout is deterministic: same `rng` seed → same picture. `init` may run many
  times (every resize) — rebuild cleanly, leak nothing.
