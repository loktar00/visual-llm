---
title: Gauntlet Crawl
tags:
  - canvas
  - game
  - assets
---
Create a single self-contained HTML file using only HTML, CSS, and JavaScript. No build tools or external assets. Use a full-screen 2D canvas.

Build a top-down dungeon crawler in the spirit of the arcade classic Gauntlet: a tile-based maze dungeon with walls, floors, locked doors and keys, food that restores health, treasure for score, and monster generators that continuously spawn enemies (ghosts, grunts) which swarm toward the hero. The hero fires projectiles in the direction of movement; shooting a generator destroys it. Health drains slowly over time, Gauntlet-style. When the exit is reached, generate a fresh maze level. HUD shows health, score, keys, and level.

The game must run as an autonomous attract mode by default: an AI-controlled hero explores, fights, collects, and descends levels endlessly with no input. Arrow keys/WASD + space take over control at any keypress; after 10 seconds of inactivity, attract mode resumes.

Art: draw everything as crisp vector/procedural art on canvas. ADDITIONALLY, declare at the top of your script a global `window.ASSET_MANIFEST` — a JSON object mapping asset slots to image-generation prompts, exactly this shape:

```js
window.ASSET_MANIFEST = {
  floor:     { file: "assets/floor.png",     prompt: "<your image-gen prompt for a 512x512 seamless dungeon floor tile>" },
  wall:      { file: "assets/wall.png",      prompt: "<...wall tile...>" },
  hero:      { file: "assets/hero.png",      prompt: "<...top-down hero sprite, centered, plain dark background...>" },
  ghost:     { file: "assets/ghost.png",     prompt: "<...enemy sprite...>" },
  grunt:     { file: "assets/grunt.png",     prompt: "<...enemy sprite...>" },
  generator: { file: "assets/generator.png", prompt: "<...monster generator...>" },
  key:       { file: "assets/key.png",       prompt: "<...>" },
  food:      { file: "assets/food.png",      prompt: "<...>" },
  treasure:  { file: "assets/treasure.png",  prompt: "<...>" },
  exit:      { file: "assets/exit.png",      prompt: "<...>" }
};
```

Write each prompt as you would brief a text-to-image model: subject, style, view angle, palette, background, "game asset" framing. At startup, attempt to load each file; any image that loads replaces the corresponding procedural art in-game (drawn to tile/sprite size), and any that fails to load falls back silently to your vector art. The game must be fully playable and visually complete with zero images present.

Output requirement: reply with ONLY the complete HTML file — a single code block, no explanation, no commentary, not a single word outside the code.
