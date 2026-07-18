/* visual-llm — app controller: style cycling, transport UI, ticker,
   usage overlay, keyboard shortcuts, drag-drop JSONL recordings. */
(function () {
  'use strict';
  const VLM = window.VLM;

  const CYCLE_SECONDS = 25;

  window.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const canvas = $('stage');
    const styles = VLM.styles;

    if (!styles.length) {
      toast('No visual styles registered — check the console for script errors.', 8000);
      return;
    }

    const params = new URLSearchParams(location.search);
    const engine = new VLM.ReplayEngine(canvas);
    engine.attachLensCanvas($('lensCanvas'));
    window.vllmEngine = engine; // console/debug handle

    /* ---------- recordings ---------- */

    const recCache = new Map();
    const recDefs = VLM.RECORDINGS.slice();
    function getRecording(id) {
      if (!recCache.has(id)) {
        const def = recDefs.find((r) => r.id === id) || recDefs[0];
        recCache.set(id, def.build());
      }
      return recCache.get(id);
    }
    const selRec = $('selRec');
    function rebuildRecOptions() {
      selRec.innerHTML = '';
      recDefs.forEach((r) => {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.label;
        selRec.appendChild(o);
      });
    }
    rebuildRecOptions();

    let recId = params.get('rec') || 'full';
    if (!recDefs.some((r) => r.id === recId)) recId = 'full';
    selRec.value = recId;
    engine.setRecording(getRecording(recId));

    selRec.addEventListener('change', () => {
      recId = selRec.value;
      engine.setRecording(getRecording(recId));
      rebuildTicker([]);
    });

    /* ---------- styles ---------- */

    const selStyle = $('selStyle');
    styles.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${i + 1} · ${s.name}`;
      selStyle.appendChild(o);
    });

    let styleIdx = 0;
    const wanted = params.get('style');
    if (wanted != null) {
      const found = styles.findIndex((s) => s.id === wanted);
      if (found >= 0) styleIdx = found;
      else if (/^\d+$/.test(wanted)) styleIdx = VLM.clamp(+wanted, 0, styles.length - 1);
    }

    const fadeOverlay = $('fadeOverlay');
    let switching = false;
    function setStyle(i, instant) {
      styleIdx = ((i % styles.length) + styles.length) % styles.length;
      const s = styles[styleIdx];
      lastSwitch = performance.now();
      selStyle.value = String(styleIdx);
      if (instant) {
        applyStyle(s);
        return;
      }
      if (switching) return;
      switching = true;
      fadeOverlay.classList.add('on');
      setTimeout(() => {
        applyStyle(s);
        fadeOverlay.classList.remove('on');
        switching = false;
      }, 370);
    }
    function applyStyle(s) {
      engine.setStyle(s);
      $('styleName').textContent = s.name;
      $('styleBlurb').textContent = s.blurb;
    }

    $('btnPrev').addEventListener('click', () => setStyle(styleIdx - 1));
    $('btnNext').addEventListener('click', () => setStyle(styleIdx + 1));
    selStyle.addEventListener('change', () => setStyle(+selStyle.value));

    /* ---------- auto-cycle ---------- */

    const chkCycle = $('chkCycle');
    if (params.get('nocycle')) chkCycle.checked = false;
    let lastSwitch = performance.now();
    setInterval(() => {
      if (!chkCycle.checked || document.hidden) return;
      if (performance.now() - lastSwitch > CYCLE_SECONDS * 1000) setStyle(styleIdx + 1);
    }, 500);

    /* ---------- transport ---------- */

    const btnPlay = $('btnPlay');
    function syncPlayBtn() { btnPlay.textContent = engine.playing ? '⏸' : '▶'; }
    btnPlay.addEventListener('click', () => { engine.togglePlay(); syncPlayBtn(); });

    $('speed').addEventListener('input', (e) => engine.setSpeed(+e.target.value));

    const progress = $('progress');
    const progressFill = $('progressFill');
    let scrubbing = false;
    function scrubFromEvent(e) {
      const r = progress.getBoundingClientRect();
      engine.scrubTo((e.clientX - r.left) / r.width);
      rebuildTicker(engine.rec.tokens.slice(0, engine.tokensDoneCount));
    }
    progress.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      try { progress.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      scrubFromEvent(e);
    });
    progress.addEventListener('pointermove', (e) => scrubbing && scrubFromEvent(e));
    progress.addEventListener('pointerup', () => (scrubbing = false));

    /* ---------- ticker ---------- */

    const ticker = $('ticker');
    const MAX_SPANS = 90;
    function tokenSpan(tok) {
      const span = document.createElement('span');
      span.className = `cat-${tok.cat} fresh`;
      const t = tok.text;
      span.textContent = /^[A-Za-z0-9']+$/.test(t) ? ' ' + t : t;
      setTimeout(() => span.classList.remove('fresh'), 600);
      return span;
    }
    function rebuildTicker(tokens) {
      ticker.innerHTML = '';
      tokens.slice(-MAX_SPANS).forEach((tok) => ticker.appendChild(tokenSpan(tok)));
    }
    engine.onToken = (tok) => {
      ticker.appendChild(tokenSpan(tok));
      while (ticker.children.length > MAX_SPANS) ticker.removeChild(ticker.firstChild);
    };
    engine.onRebuild = (tokens) => rebuildTicker(tokens);

    /* ---------- usage overlay ---------- */

    const usageWrap = $('usageWrap');
    const usageCanvas = $('usageCanvas');
    const btnUsage = $('btnUsage');
    let usageLast = 0;
    function toggleUsage() { usageWrap.hidden = !usageWrap.hidden; usageLast = 0; }
    btnUsage.addEventListener('click', toggleUsage);

    /* ---------- reap lens ---------- */

    const btnLens = $('btnLens');
    function toggleLens() {
      if (!engine.reapLens && engine.style && typeof engine.style.nodePos !== 'function') {
        toast('this style has no expert positions yet — reap lens unavailable');
        return;
      }
      engine.reapLens = !engine.reapLens;
      btnLens.style.color = engine.reapLens ? '#ff4060' : '';
      if (engine.reapLens)
        toast('reap lens: ring+slash = cold expert (reap candidate) · X = already pruned');
    }
    btnLens.addEventListener('click', toggleLens);
    if (params.get('lens')) setTimeout(toggleLens, 400);

    /* ---------- reap mask export (for visual-llm-capture --mask) ---------- */

    function exportMask() {
      const manual = manualMask.size > 0;
      const cands = manual ? maskPairs() : engine.getReapCandidates();
      if (!cands.length) {
        toast('no reap candidates yet — let the replay run a while first');
        return;
      }
      let txt =
        `# visual-llm reap mask — ${engine.model.name} — ${cands.length} experts` +
        `${manual ? ' (hand-picked)' : ''}\n` +
        `# usage: visual-llm-capture --mask reap-mask.txt ...\n# layer expert\n`;
      cands.forEach(([l, e]) => (txt += `${l} ${e}\n`));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
      a.download = 'reap-mask.txt';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`exported ${cands.length} reap candidates as reap-mask.txt`);
    }
    $('btnMask').addEventListener('click', exportMask);

    function drawUsage(f) {
      const { model } = f;
      const cell = Math.max(3, Math.min(10, Math.floor(380 / model.nExperts)));
      const W = model.nExperts * cell, H = model.nLayers * cell;
      if (usageCanvas.width !== W || usageCanvas.height !== H) {
        usageCanvas.width = W;
        usageCanvas.height = H;
      }
      const g = usageCanvas.getContext('2d');
      g.fillStyle = '#07080f';
      g.fillRect(0, 0, W, H);
      for (let l = 0; l < model.nLayers; l++) {
        for (let e = 0; e < model.nExperts; e++) {
          if (model.isRemoved(l, e)) {
            g.fillStyle = 'rgba(255,60,160,0.55)';
          } else {
            g.fillStyle = VLM.heatColor(Math.pow(f.usageAt(l, e), 0.6));
          }
          g.fillRect(e * cell, l * cell, cell - 1, cell - 1);
        }
      }
    }

    /* ---------- engine tick ---------- */

    engine.onTick = (f) => {
      progressFill.style.width = (f.progress * 100).toFixed(2) + '%';
      if (!usageWrap.hidden && f.wallNow - usageLast > 0.15) {
        usageLast = f.wallNow;
        drawUsage(f);
      }
      // savings estimate follows the evolving usage while the panel is open
      if (!srvWrap.hidden && f.wallNow - estLast > 1) {
        estLast = f.wallNow;
        updateMaskEst();
      }
    };
    engine.onStyleError = (id, e) =>
      toast(`style "${id}" crashed — showing fallback (details in console)`);

    /* ---------- keyboard ---------- */

    window.addEventListener('keydown', (e) => {
      if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') setStyle(styleIdx - 1);
      else if (e.key === 'ArrowRight') setStyle(styleIdx + 1);
      else if (e.key === ' ') { e.preventDefault(); engine.togglePlay(); syncPlayBtn(); }
      else if (e.key === 'u' || e.key === 'U') toggleUsage();
      else if (e.key === 'r' || e.key === 'R') toggleLens();
      else if (e.key === 'e' || e.key === 'E') exportMask();
      else if (e.key === 's' || e.key === 'S') toggleServer();
      else if (e.key === 'm' || e.key === 'M') toggleMaskEdit();
      else if (e.key === 'Escape' && maskEdit) toggleMaskEdit();
      else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && maskEdit) { e.preventDefault(); undoMask(); }
      else if (e.key === 't' || e.key === 'T') {
        engine.showLabels = !engine.showLabels;
        toast(engine.showLabels
          ? 'token labels on — input text at the entry, produced token at the exit'
          : 'token labels off');
      }
      else if (e.key === 'c' || e.key === 'C') chkCycle.checked = !chkCycle.checked;
      else if (/^[0-9]$/.test(e.key)) {
        const n = e.key === '0' ? 9 : +e.key - 1;
        if (n < styles.length) setStyle(n);
      }
    });

    /* ---------- drag-drop JSONL recordings ---------- */

    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      try {
        const rec = VLM.parseJSONL(await file.text());
        const id = 'drop:' + file.name;
        recCache.set(id, rec);
        if (!recDefs.some((r) => r.id === id)) {
          recDefs.push({ id, label: `📼 ${file.name}`, build: () => rec });
          rebuildRecOptions();
        }
        selRec.value = id;
        recId = id;
        engine.setRecording(rec);
        rebuildTicker([]);
        toast(`loaded ${file.name} — ${rec.tokens.length} tokens, ${rec.meta.model.n_layers}L × ${rec.meta.model.n_experts}E`);
      } catch (err) {
        console.error(err);
        toast(`could not parse ${file.name} as a visual-llm JSONL recording`);
      }
    });

    /* ---------- interactive mask editor ---------- */

    const manualMask = engine.manualMask;
    const btnMaskEdit = $('btnMaskEdit');
    const maskCount = $('maskCount');
    const maskBar = $('maskBar');
    let maskEdit = false;
    let painting = false;
    let boxing = null; // { sx, sy, erase } while shift-dragging a rectangle
    let lastPaint = 0;
    const undoStack = [];

    function pushUndo() {
      undoStack.push([...manualMask]);
      if (undoStack.length > 40) undoStack.shift();
    }
    function undoMask() {
      if (!undoStack.length) { toast('nothing to undo'); return; }
      const prev = undoStack.pop();
      manualMask.clear();
      prev.forEach((k) => manualMask.add(k));
      syncMaskUi();
    }
    function clearMask() {
      if (!manualMask.size) return;
      pushUndo();
      manualMask.clear();
      syncMaskUi();
    }

    function syncMaskUi() {
      const label = manualMask.size ? `${manualMask.size} experts` : 'nothing selected';
      maskCount.textContent = manualMask.size ? `· ${manualMask.size} experts` : '· click the art with ✎ on';
      $('maskBarCount').textContent = label;
      btnMaskEdit.style.color = maskEdit ? '#ffa430' : '';
      updateMaskEst(); // hoisted; defined with the threshold slider below
    }
    function toggleMaskEdit() {
      maskEdit = !maskEdit;
      maskBar.hidden = !maskEdit;
      canvas.style.cursor = maskEdit ? 'crosshair' : '';
      if (maskEdit && chkCycle.checked) chkCycle.checked = false; // don't yank the layout mid-edit
      if (!maskEdit) hideRubber();
      syncMaskUi();
    }
    btnMaskEdit.addEventListener('click', toggleMaskEdit);
    $('maskBarDone').addEventListener('click', toggleMaskEdit);
    $('maskBarClear').addEventListener('click', clearMask);
    $('maskBarUndo').addEventListener('click', undoMask);

    // rubber band for shift-drag box selection
    let rubber = null;
    function showRubber(x0, y0, x1, y1) {
      if (!rubber) {
        rubber = document.createElement('div');
        rubber.id = 'rubberBand';
        document.body.appendChild(rubber);
      }
      rubber.style.left = Math.min(x0, x1) + 'px';
      rubber.style.top = Math.min(y0, y1) + 'px';
      rubber.style.width = Math.abs(x1 - x0) + 'px';
      rubber.style.height = Math.abs(y1 - y0) + 'px';
      rubber.style.display = 'block';
    }
    function hideRubber() { if (rubber) rubber.style.display = 'none'; }

    function paintAt(e, toggle) {
      const r = canvas.getBoundingClientRect();
      const hit = engine.nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (!hit) return;
      const key = hit[0] + ':' + hit[1];
      if (toggle) manualMask.has(key) ? manualMask.delete(key) : manualMask.add(key);
      else if (e.altKey) manualMask.delete(key);
      else manualMask.add(key);
      syncMaskUi();
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (!maskEdit) return;
      if (e.shiftKey) {
        boxing = { sx: e.clientX, sy: e.clientY, erase: e.altKey };
        showRubber(e.clientX, e.clientY, e.clientX, e.clientY);
        return;
      }
      painting = true;
      pushUndo();
      paintAt(e, true);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!maskEdit) return;
      if (boxing) { showRubber(boxing.sx, boxing.sy, e.clientX, e.clientY); return; }
      if (!painting) return;
      const now = performance.now();
      if (now - lastPaint < 40) return; // hit-testing walks every node
      lastPaint = now;
      paintAt(e, false);
    });
    window.addEventListener('pointerup', (e) => {
      if (boxing) {
        hideRubber();
        const r = canvas.getBoundingClientRect();
        const hits = engine.nodesIn(boxing.sx - r.left, boxing.sy - r.top, e.clientX - r.left, e.clientY - r.top);
        if (hits.length) {
          pushUndo();
          const erase = boxing.erase || e.altKey;
          hits.forEach(([l, ex]) => (erase ? manualMask.delete(l + ':' + ex) : manualMask.add(l + ':' + ex)));
          toast(`${erase ? 'removed' : 'selected'} ${hits.length} experts in the box`);
          syncMaskUi();
        }
        boxing = null;
      }
      painting = false;
    });

    $('maskSeed').addEventListener('click', () => {
      const cands = engine.getReapCandidates();
      pushUndo();
      cands.forEach(([l, e]) => manualMask.add(l + ':' + e));
      syncMaskUi();
      toast(`seeded ${cands.length} lens candidates — refine by clicking with ✎`);
    });
    $('maskClear').addEventListener('click', clearMask);
    function maskPairs() {
      return [...manualMask]
        .map((k) => k.split(':').map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }
    $('maskApply').addEventListener('click', async () => {
      if (!srvBase()) { srvStatus.textContent = 'enter the capture server url'; return; }
      try {
        const r = await fetch(srvBase() + '/mask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairs: maskPairs() }),
        });
        const d = await r.json();
        toast(d.applied
          ? `server mask applied: ${d.applied} experts ablated from the next request on`
          : 'server mask cleared — model is whole again');
      } catch (err) {
        console.error(err);
        srvStatus.textContent = 'mask apply failed — see console';
      }
    });

    /* ---------- candidate threshold slider + savings estimate ---------- */

    // measured on the Qwen3.6-A3B surgery: a 25% expert cut shrank the gguf
    // 22.2%, i.e. expert tensors are ~89% of a big MoE file
    const EXPERT_FILE_SHARE = 0.888;
    let srvModelBytes = 0; // learned from the capture server on connect

    const reapFracEl = $('reapFrac');
    reapFracEl.addEventListener('input', () => {
      engine.reapFrac = +reapFracEl.value / 100;
      $('reapFracLabel').textContent = reapFracEl.value + '%';
      updateMaskEst();
    });

    function updateMaskEst() {
      const m = engine.model;
      if (!m) return;
      const pairs = manualMask.size ? maskPairs() : engine.getReapCandidates();
      const nE = m.nExperts;
      let live = 0;
      for (let l = 0; l < m.nLayers; l++)
        for (let e = 0; e < nE; e++) if (!m.isRemoved(l, e)) live++;
      let mass = 0, total = 0;
      for (let i = 0; i < engine.usage.length; i++) total += engine.usage[i];
      pairs.forEach(([l, e]) => (mass += engine.usage[l * nE + e]));
      const fracE = pairs.length / Math.max(1, live);
      let txt = `${manualMask.size ? 'hand-picked' : 'slider'}: ${pairs.length} experts ` +
        `(${(fracE * 100).toFixed(0)}%) carrying ${total ? ((100 * mass) / total).toFixed(2) : '0.00'}% of routed mass`;
      if (srvModelBytes) {
        const gb = srvModelBytes / 1e9;
        const saved = gb * EXPERT_FILE_SHARE * fracE;
        txt += ` · est. reaped file ≈ ${(gb - saved).toFixed(1)} GB (−${saved.toFixed(1)} GB of ${gb.toFixed(1)})`;
      }
      $('maskEst').textContent = txt;
    }
    let estLast = 0;

    /* ---------- physical reap from the UI ---------- */

    // llama.cpp needs a uniform expert count per layer, so the selection is
    // balanced: every layer trimmed to the same N, keeping its coldest picks.
    function balancedMask() {
      const src = manualMask.size ? maskPairs() : engine.getReapCandidates();
      if (!src.length) return { error: 'no mask — seed from lens or click experts first' };
      const per = new Map();
      src.forEach(([l, e]) => { if (!per.has(l)) per.set(l, []); per.get(l).push(e); });
      const nL = engine.model.nLayers;
      if (per.size < nL) {
        return { error: `selections cover ${per.size}/${nL} layers — a physical reap needs every layer (try "seed from lens" first)` };
      }
      const n = Math.min(...[...per.values()].map((a) => a.length));
      const nE = engine.model.nExperts;
      let trimmed = 0;
      const pairs = [];
      for (const [l, es] of per) {
        es.sort((a, b) => engine.usage[l * nE + a] - engine.usage[l * nE + b]);
        trimmed += es.length - n;
        es.slice(0, n).forEach((e) => pairs.push([l, e]));
      }
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return { pairs, n, trimmed };
    }

    const btnReap = $('maskReap');
    const reapSrc = $('reapSrc');
    let reapArmed = null;
    btnReap.addEventListener('click', async () => {
      if (!srvBase()) { srvStatus.textContent = 'enter the capture server url'; return; }
      const set = reapSrc.value;
      let b = null;
      if (!set) {
        b = balancedMask();
        if (b.error) { toast(b.error); return; }
      }
      if (!reapArmed) {
        toast(set
          ? `this will aggregate router mass across every recording in ${set}/ on the server, then write a NEW gguf with the coldest ${Math.round(engine.reapFrac * 100)}% of every layer cut — the original is untouched. Click again to run.`
          : `this will write a NEW gguf with ${b.n} experts cut from every layer` +
            `${b.trimmed ? ` (${b.trimmed} picks trimmed to balance)` : ''} — the original is untouched. Click again to run.`);
        btnReap.textContent = 'sure? click again';
        reapArmed = setTimeout(() => { reapArmed = null; btnReap.textContent = 'reap gguf'; }, 8000);
        return;
      }
      clearTimeout(reapArmed);
      reapArmed = null;
      btnReap.textContent = 'reap gguf';
      try {
        const r = await fetch(srvBase() + '/reap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(set ? { set, frac: engine.reapFrac } : { pairs: b.pairs }),
        });
        const d = await r.json();
        if (!r.ok || d.error) { toast('reap refused: ' + (d.error || r.status)); return; }
        srvStatus.textContent = 'reaping…';
        const poll = setInterval(async () => {
          try {
            const s = await (await fetch(srvBase() + '/reap')).json();
            const lines = (s.log || '').trim().split('\n');
            srvStatus.textContent = s.running ? ('reap: ' + lines[lines.length - 1]) : '';
            if (!s.running) {
              clearInterval(poll);
              if (s.exit_code === 0) toast('reaped ✂ → ' + s.output, 9000);
              else { toast('reap failed — details in console'); console.error('reap log:\n' + s.log); }
            }
          } catch { clearInterval(poll); }
        }, 3000);
      } catch (err) {
        console.error(err);
        srvStatus.textContent = 'reap request failed — see console';
      }
    });

    /* ---------- capture server panel ---------- */

    const srvWrap = $('serverWrap');
    const srvUrl = $('srvUrl');
    const srvList = $('srvList');
    const srvStatus = $('srvStatus');
    const srvGen = $('srvGen');
    srvUrl.value = localStorage.getItem('vllm-server-url') || '';

    function srvBase() { return srvUrl.value.trim().replace(/\/+$/, ''); }
    function toggleServer() {
      srvWrap.hidden = !srvWrap.hidden;
      if (!srvWrap.hidden && srvBase()) refreshCaptures();
    }
    $('btnServer').addEventListener('click', toggleServer);

    async function refreshCaptures() {
      const base = srvBase();
      if (!base) { srvStatus.textContent = 'enter the capture server url'; return null; }
      localStorage.setItem('vllm-server-url', base);
      srvStatus.textContent = 'connecting…';
      try {
        const d = await (await fetch(base + '/captures')).json();
        srvList.innerHTML = '';
        d.captures.slice(0, 30).forEach((c) => {
          const row = document.createElement('div');
          row.className = 'srvItem';
          const nm = document.createElement('span');
          nm.textContent = c.name.replace(/\.jsonl$/, '');
          const sz = document.createElement('span');
          sz.className = 'sz';
          sz.textContent = (c.bytes / 1024).toFixed(0) + ' KB';
          row.append(nm, sz);
          row.addEventListener('click', () => loadServerCapture(c.name));
          srvList.appendChild(row);
        });
        srvStatus.textContent = `${d.model} · ${d.captures.length} recording(s)`;
        srvModelBytes = d.model_bytes || 0;
        updateMaskEst();
        // corpus subdirectories become one-click reap sources
        const sets = new Map();
        d.captures.forEach((c) => {
          const i = c.name.indexOf('/');
          if (i > 0) { const s = c.name.slice(0, i); sets.set(s, (sets.get(s) || 0) + 1); }
        });
        const srcEl = $('reapSrc');
        const cur = srcEl.value;
        [...srcEl.options].slice(1).forEach((o) => o.remove());
        for (const [s, n] of sets) {
          const o = document.createElement('option');
          o.value = s;
          o.textContent = `corpus: ${s}/ (${n} recordings)`;
          srcEl.appendChild(o);
        }
        if (sets.has(cur)) srcEl.value = cur;
        return d;
      } catch (err) {
        console.error(err);
        srvStatus.textContent = 'connection failed — is the capture server running?';
        return null;
      }
    }
    $('srvConnect').addEventListener('click', refreshCaptures);
    srvUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshCaptures(); });

    async function loadServerCapture(name) {
      try {
        srvStatus.textContent = 'loading ' + name + '…';
        const text = await (await fetch(srvBase() + '/captures/' + encodeURIComponent(name))).text();
        const rec = VLM.parseJSONL(text);
        const id = 'srv:' + name;
        recCache.set(id, rec);
        if (!recDefs.some((r) => r.id === id)) {
          recDefs.push({ id, label: `⇄ ${name.replace(/\.jsonl$/, '')}`, build: () => rec });
          rebuildRecOptions();
        }
        selRec.value = id;
        recId = id;
        engine.setRecording(rec);
        rebuildTicker([]);
        srvStatus.textContent = `loaded — ${rec.tokens.length} tokens, ${rec.meta.model.n_layers}L × ${rec.meta.model.n_experts}E`;
      } catch (err) {
        console.error(err);
        srvStatus.textContent = 'could not load ' + name;
      }
    }

    async function generateRemote() {
      const prompt = $('srvPrompt').value.trim();
      if (!prompt) { srvStatus.textContent = 'write a prompt first'; return; }
      if (!srvBase()) { srvStatus.textContent = 'enter the capture server url'; return; }
      srvGen.disabled = true;
      srvStatus.textContent = 'generating… (the model is thinking)';
      try {
        const r = await fetch(srvBase() + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 400, stream: false }),
        });
        if (!r.ok) throw new Error('http ' + r.status);
        await r.json();
        const d = await refreshCaptures();
        if (d && d.captures.length) await loadServerCapture(d.captures[0].name);
      } catch (err) {
        console.error(err);
        srvStatus.textContent = 'generation failed — see console';
      }
      srvGen.disabled = false;
    }
    srvGen.addEventListener('click', generateRemote);

    /* ---------- idle chrome hiding ---------- */

    let idleTimer = null;
    function poke() {
      document.body.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => document.body.classList.add('idle'), 3500);
    }
    ['mousemove', 'pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, poke));
    poke();

    /* ---------- toast ---------- */

    let toastTimer = null;
    function toast(msg, ms = 4000) {
      const el = $('toast');
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.hidden = true), ms);
    }

    /* ---------- go ---------- */

    setStyle(styleIdx, true);
    syncPlayBtn();
  });
})();
