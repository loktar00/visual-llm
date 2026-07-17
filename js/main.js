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
      const cands = engine.getReapCandidates();
      if (!cands.length) {
        toast('no reap candidates yet — let the replay run a while first');
        return;
      }
      let txt =
        `# visual-llm reap mask — ${engine.model.name} — ${cands.length} experts\n` +
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
