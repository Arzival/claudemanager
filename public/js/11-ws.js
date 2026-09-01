// 11-ws.js — WebSocket: conexión y dispatcher de todos los mensajes del servidor
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── WebSocket ─────────────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}`);
ws.addEventListener('open', () => { connEl.textContent='◉ ONLINE'; connEl.classList.add('ok'); startUsagePolling(); });

ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'config-state') {
    detectedClaude = msg.detectedClaude||'';
    backgrounds = msg.backgrounds || [];
    toolsList = msg.tools || [];
    selectedToolId = msg.defaultTool || toolsList[0]?.id || null;
    renderToolPills();
    if (!msg.configured) openConfig(msg);
    ws.send(JSON.stringify({ type:'list' }));

  } else if (msg.type === 'tools-updated') {
    toolsList = msg.tools || [];
    if (!toolsList.find(t => t.id === selectedToolId)) selectedToolId = toolsList[0]?.id || null;
    renderToolPills(); renderToolsList();

  } else if (msg.type === 'sessions') {
    // Dispose any previous terminals before rebuilding so their WebGL
    // contexts and listeners don't leak.
    Object.keys(terms).forEach(id => {
      try { terms[id].dispose(); } catch {}
      delete terms[id]; delete fits[id];
    });
    canvas.innerHTML=''; panelCount=0; zTop=10;
    msg.sessions.forEach((s, i) => {
      statuses[s.id]=s.status;
      buildPanel(s, defaultLayout(i, msg.sessions.length));
    });
    // Create default workspace if none exist
    if (!Object.keys(wsStore.workspaces).length) {
      wsStore.workspaces['DEFAULT'] = { panelIds: msg.sessions.map(s=>s.id), layout: snapshotLayout(), bg: null, bgOpacity: 1 };
      wsStore.active = 'DEFAULT';
      saveWsStore();
    }
    applyWorkspaceTheme();
    renderWsBar();
    updateGitBadges();     // repaint badges on rebuilt panels
    requestGitInfo();      // and fetch fresh git state
    // After panels are built (with correct layout via getSavedLayout), just show/hide per workspace.
    // Don't re-apply layout or re-fit — buildPanel already did it correctly.
    if (wsStore.active && Object.keys(wsStore.workspaces).length) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const activeWs = wsStore.workspaces[wsStore.active];
        if (!activeWs) return;
        canvas.querySelectorAll('.panel').forEach(p => {
          const id = p.dataset.id;
          if (activeWs.panelIds.includes(id)) {
            delete p.dataset.hidden;
            p.style.visibility = ''; p.style.pointerEvents = '';
            try { terms[id]?.scrollToBottom(); } catch {}
          } else {
            p.dataset.hidden = '1';
            p.style.visibility = 'hidden'; p.style.pointerEvents = 'none';
          }
        });
        updateCanvasHeight();
        restoreWsScroll(); // cada workspace recuerda su scroll, también tras recargar
        [0, 100, 400, 1200].forEach(d => setTimeout(scheduleRefit, d));
      }));
    }

  } else if (msg.type === 'session-added') {
    statuses[msg.session.id]=msg.session.status;
    const total = canvas.querySelectorAll('.panel').length + 1;
    const offset = (total % 5) * 0.03;
    // Lanzamiento rápido con clic derecho: el panel nace donde estaba el cursor
    const lay = spawnPos
      ? { l: spawnPos.l, t: spawnPos.t, w: 0.45, h: 0.45 }
      : { l: 0.1 + offset, t: 0.1 + offset, w: 0.45, h: 0.45 };
    spawnPos = null;
    buildPanel(msg.session, lay);
    // Add to active workspace
    if (wsStore.active && wsStore.workspaces[wsStore.active]) {
      wsStore.workspaces[wsStore.active].panelIds.push(msg.session.id);
      persistToWorkspace();
    }
    requestGitInfo(); // populate the new panel's git badge right away

  } else if (msg.type === 'session-removed') {
    const p = document.querySelector(`.panel[data-id="${msg.sessionId}"]`);
    if (p) { p.remove(); updateCanvasHeight(); }
    // Dispose the Terminal so its WebGL context is released — leaked contexts
    // eventually hit the browser's limit and kill the contexts of LIVE panels.
    try { terms[msg.sessionId]?.dispose(); } catch {}
    delete terms[msg.sessionId]; delete fits[msg.sessionId]; delete usageData[msg.sessionId];
    delete lastOut[msg.sessionId]; delete statuses[msg.sessionId]; delete lastResizeTime[msg.sessionId];
    clearTimeout(fitTimers[msg.sessionId]); delete fitTimers[msg.sessionId];
    delete gitInfo[msg.sessionId];
    delete cmdTrack[msg.sessionId]; delete cmdShellOk[msg.sessionId];
    delete cmdMatchCache[msg.sessionId]; delete cmdSel[msg.sessionId];
    delete voiceByS[msg.sessionId];
    if (voiceReading && voiceReading.id === msg.sessionId) voiceReading = null;
    if (voiceActive && voiceActive.id === msg.sessionId) voiceActive = null;
    stopEngineSpeech(msg.sessionId);
    delete ttsPlay[msg.sessionId]; delete ttsGen[msg.sessionId];
    if (voicePendingSend && voicePendingSend.id === msg.sessionId) { clearTimeout(voicePendingSend.timer); voicePendingSend = null; }
    if (gdSession === msg.sessionId) closeGitDrawer();
    if (activeSessionId === msg.sessionId) { activeSessionId = null; renderStatusBar(); }
    // Remove from all workspaces
    Object.values(wsStore.workspaces).forEach(ws => {
      ws.panelIds = ws.panelIds.filter(id => id !== msg.sessionId);
      delete ws.layout[msg.sessionId];
    });
    persistToWorkspace();

  } else if (msg.type === 'output') {
    const t=terms[msg.sessionId];
    if (t) {
      t.write(msg.data);
      lastOut[msg.sessionId]=Date.now();
      // After a resize the app redraws via SIGWINCH; scroll to bottom when that output arrives
      if (Date.now() - (lastResizeTime[msg.sessionId] || 0) < 1500) t.scrollToBottom();
    }
    // Only touch the DOM when the dot actually changes state — this handler
    // runs for every output chunk under heavy streaming.
    if (statuses[msg.sessionId]!=='exited' && statuses[msg.sessionId]!=='running')
      setDot(msg.sessionId,'running');

  } else if (msg.type === 'status') {
    setDot(msg.sessionId, msg.status);
    if (msg.status==='running') lastOut[msg.sessionId]=Date.now();

  } else if (msg.type === 'folder-created') {
    // Re-select the same tech to show the new folder highlighted
    const tEl=document.getElementById('tech-list');
    const techLi = [...tEl.children].find(li => li.textContent === msg.tech);
    if (techLi) {
      const idx = [...tEl.children].indexOf(techLi);
      selectTech(idx, techLi);
      // Auto-select the newly created folder
      setTimeout(() => {
        const pEl = document.getElementById('proj-list');
        const newLi = [...pEl.children].find(li => li.textContent === msg.name);
        if (newLi) newLi.click();
      }, 50);
    }

  } else if (msg.type === 'projects') {
    projectData=msg.data;
    if (spawnMenuEl) renderSpawnMenu(); // el menú de clic derecho esperaba la lista
    const prevTech = currentTechIdx >= 0 && projectData[currentTechIdx] ? projectData[currentTechIdx].tech : null;
    const tEl=document.getElementById('tech-list'); tEl.innerHTML='';
    msg.data.forEach((t,i)=>{ const li=document.createElement('li'); li.textContent=t.tech;
      li.addEventListener('click',()=>selectTech(i,li)); tEl.appendChild(li); });
    // Restore selected tech or default to first
    const restoreIdx = prevTech ? msg.data.findIndex(t=>t.tech===prevTech) : 0;
    if (msg.data.length) selectTech(Math.max(0,restoreIdx), tEl.children[Math.max(0,restoreIdx)]);

  } else if (msg.type === 'detected-claude') {
    const b=document.getElementById('cfg-detect'); b.textContent='Auto detect Claude'; b.disabled=false;
    if (msg.path) {
      document.getElementById('cfg-claude').value = msg.path;
      // Also fill tool form if open
      const tfCmd = document.getElementById('tf-cmd');
      if (document.getElementById('tool-form').style.display !== 'none' && !tfCmd.value)
        tfCmd.value = msg.path;
    } else alert('claude no encontrado — ingresa la ruta manualmente');

  } else if (msg.type === 'image-pasted') {
    const t = terms[msg.sessionId];
    if (t) t.paste(msg.path);

  } else if (msg.type === 'drop-resolved') {
    const cb = dropPending.get(msg.reqId);
    if (cb) { dropPending.delete(msg.reqId); cb(msg.paths); }

  } else if (msg.type === 'files-dropped') {
    const t = terms[msg.sessionId];
    if (t) t.paste(msg.paths.join(' ')); // temp paths are sanitized — no escaping needed

  } else if (msg.type === 'usage') {
    usageData = {};
    msg.sessions.forEach(s => { usageData[s.id] = s.usage; });
    official = msg.official || null;
    officialStatus = msg.officialStatus || null;
    windowInfo = msg.window || null;
    lastUsageAt = Date.now();
    // Default the bar to the first session that actually reports usage
    if (!activeSessionId || !document.querySelector(`.panel[data-id="${activeSessionId}"]`)) {
      const first = msg.sessions.find(s => s.usage);
      activeSessionId = first ? first.id : activeSessionId;
    }
    renderStatusBar();

  } else if (msg.type === 'response-block') {
    // Un bloque de la respuesta recién escrito al transcript — se lee ya,
    // aunque Claude siga generando los siguientes.
    if (voiceReading && voiceReading.id === msg.sessionId && voiceByS[msg.sessionId] && msg.text) {
      if (voiceReading.blocks === 0) vToast('🔊 leyendo conforme responde… (Esc detiene)', 4000);
      voiceReading.blocks++;
      speak(msg.sessionId, speechFromMarkdown(msg.text), true);
    }

  } else if (msg.type === 'response-end') {
    if (voiceReading && voiceReading.id === msg.sessionId) {
      if (!voiceReading.blocks && !msg.blocks)
        vToast('🔇 no hubo respuesta nueva que leer (¿se envió el prompt?)', 6000);
      voiceReading = null;
    }

  } else if (msg.type === 'ptt') {
    // Disparo remoto (atajo global del SO vía /ptt/*) — funciona sin foco
    if (msg.action === 'start') micStart();
    else if (msg.action === 'stop') micStop();
    else recording ? micStop() : micStart();

  } else if (msg.type === 'tts-catalog') {
    ttsVoices = msg.voices || [];

  } else if (msg.type === 'tts-status') {
    vToast('⬇ ' + msg.msg, 0);

  } else if (msg.type === 'tts-audio') {
    // Un trozo sintetizado por el servidor — se descarta si ya se canceló
    const gen = parseInt(msg.reqId, 10);
    if (msg.error) vToast('⚠ voz: ' + msg.error, 5000);
    else if (gen === (ttsGen[msg.sessionId] || 0)) enqueueTtsWav(msg.sessionId, msg.wav);

  } else if (msg.type === 'voice-text') {
    if (msg.error) vToast('⚠ ' + msg.error, 6000);
    else routeVoiceText(msg.text);

  } else if (msg.type === 'voice-saved') {
    voiceByS[msg.sessionId] = msg.voice || '';
    updateVoiceBtn(msg.sessionId);

  } else if (msg.type === 'cmd-log') {
    cmdLog = msg.commands || [];
    // Repinta las cajas abiertas (p.ej. tras borrar un comando con clic derecho)
    document.querySelectorAll('.cmdbox.open').forEach(el => renderCmdBox(el.id.slice(3)));

  } else if (msg.type === 'cmd-state') {
    cmdShellOk[msg.sessionId] = { val: !!msg.shell, at: Date.now() };
    renderCmdBox(msg.sessionId);

  } else if (msg.type === 'git-info') {
    gitInfo = msg.data || {};
    updateGitBadges();

  } else if (msg.type === 'git-diff') {
    if (msg.sessionId === gdSession && msg.file === gdFile) renderGitDiff(msg.diff || '');

  } else if (msg.type === 'file-content') {
    if (msg.sessionId === gdSession && msg.file === gdFile && gdView === 'md')
      renderMdFile(msg.content, msg.error);

  } else if (msg.type === 'backgrounds') {
    backgrounds = msg.files || [];
    if (bgOv.classList.contains('open')) renderBgGrid();

  } else if (msg.type === 'reload') {
    location.reload();
  }
});

ws.addEventListener('close', () => {
  connEl.textContent='◉ OFFLINE'; connEl.classList.remove('ok');
  document.querySelectorAll('.dot').forEach(d=>d.className='dot exited');
  setTimeout(()=>location.reload(),1200);
});
