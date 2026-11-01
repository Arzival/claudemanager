// 05-voz-dictado.js — Voz (1/2): mic, push-to-talk, ruteo por nombre, panel activo, rescate y lectura incremental
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── VOZ — dictado por push-to-talk + lectura de respuestas ────
// Flujo: mantén F9 (o el botón 🎙) y di «nombre, tu mensaje». El audio va al
// servidor, whisper.cpp lo transcribe local, aquí se rutea a la sesión cuyo
// nombre/nota coincida (con tolerancia difusa — whisper escribe «Xtifi» por
// «qstify») y se manda como prompt. Si ese panel tiene voz TTS asignada, la
// respuesta de Claude se lee con speechSynthesis cuando la salida se asienta.
const sbMic = document.getElementById('sb-mic');
const voiceToastEl = document.getElementById('voice-toast');
let micStream = null, micCtx = null, recording = false, recChunks = [], recRate = 48000;
let micReinit = false; // el mic por defecto cambió (AirPods…) — recapturar

// Si conectas/desconectas audífonos, suelta el stream para que el siguiente
// dictado capture el micrófono por defecto NUEVO (sin recargar la página).
function micTeardown() {
  try { micStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { micCtx?.close(); } catch {}
  micStream = null; micCtx = null;
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (recording) micReinit = true; // no cortar una grabación en curso
  else micTeardown();
});
const voiceByS = {};          // sessionId -> nombre de voz TTS ('' = sin voz)
let voicePendingSend = null;  // { id, nm, prompt, timer } — confirmación antes de enviar

function vToast(msg, ms = 3000) {
  voiceToastEl.textContent = msg;
  voiceToastEl.style.display = 'block';
  clearTimeout(vToast._t);
  if (ms) vToast._t = setTimeout(() => voiceToastEl.style.display = 'none', ms);
}

// Bip corto de confirmación — imprescindible cuando disparas el dictado
// desde otra app y no ves el toast. Usa el AudioContext del mic (ya activo).
function beep(freq) {
  try {
    if (!micCtx) return;
    const o = micCtx.createOscillator(), g = micCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.value = 0.07;
    o.connect(g); g.connect(micCtx.destination);
    o.start(); o.stop(micCtx.currentTime + 0.09);
  } catch {}
}

// Remuestrea a 16kHz (promediando la ventana), pasa a Int16 y codifica base64
function pcmEncode(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = recRate / 16000, n = Math.floor(all.length / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j];
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((s / (b - a || 1)) * 32767)));
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Dictado incremental: mientras grabas, los tramos ya hablados se van
// mandando a transcribir en segundo plano (cortando en silencios); al soltar
// solo falta la colita — el resultado sale casi al instante aunque hables
// varios minutos.
let recSeq = 0, recQuietMs = 0, recSentAny = false;

function micFlushPartial() {
  if (!recChunks.length) return;
  ws.send(JSON.stringify({ type: 'voice-partial', seq: recSeq++, audio: pcmEncode(recChunks) }));
  recChunks = [];
  recSentAny = true;
}

// Lista de micrófonos disponibles (para fijar uno en el menú del 🎙).
// Los nombres solo aparecen después de conceder el permiso de mic.
let micDevices = [];
async function refreshMicDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    micDevices = all.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
  } catch { micDevices = []; }
}

async function micStart() {
  if (recording) return;
  try {
    if (!micStream) {
      // Mic fijado por el usuario, o el del sistema si no hay/está desconectado
      const micId = localStorage.getItem('claudemgr-mic-device') || '';
      const base = { echoCancellation: true, noiseSuppression: true };
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { ...base, deviceId: { exact: micId } } : base,
        });
      } catch (err) {
        if (!micId) throw err;
        vToast('el micrófono fijado no está disponible — usando el del sistema', 4000);
        micStream = await navigator.mediaDevices.getUserMedia({ audio: base });
      }
      micCtx = new AudioContext();
      const src = micCtx.createMediaStreamSource(micStream);
      const node = micCtx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = e => {
        if (!recording) return;
        const buf = e.inputBuffer.getChannelData(0);
        recChunks.push(new Float32Array(buf));
        // Detección simple de silencio para cortar tramos en pausas naturales
        let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / (buf.length / 4));
        const frameMs = (buf.length / recRate) * 1000;
        recQuietMs = rms < 0.01 ? recQuietMs + frameMs : 0;
        const segSec = recChunks.reduce((a, c) => a + c.length, 0) / recRate;
        // corta en un silencio de ≥400ms pasados 8s, o a la fuerza a los 15s
        if ((segSec > 8 && recQuietMs > 400) || segSec > 15) micFlushPartial();
      };
      src.connect(node); node.connect(micCtx.destination);
      recRate = micCtx.sampleRate;
    }
    if (micCtx.state === 'suspended') await micCtx.resume();
    recChunks = []; recSeq = 0; recQuietMs = 0; recSentAny = false;
    recording = true;
    sbMic.classList.add('rec');
    beep(880);
    vToast('🎙 escuchando… (suelta para enviar)', 0);
  } catch (e) {
    vToast('No se pudo acceder al micrófono: ' + e.message);
  }
}

function micStop() {
  if (!recording) return;
  recording = false;
  sbMic.classList.remove('rec');
  const total = recChunks.reduce((a, c) => a + c.length, 0);
  if (!recSentAny && total < recRate * 0.4) {
    recChunks = [];
    vToast('muy corto — mantén presionado mientras hablas');
    if (micReinit) { micReinit = false; micTeardown(); }
    return;
  }
  // La colita final (o '' si no queda nada útil — el servidor une los tramos)
  const tail = total >= recRate * 0.3 ? pcmEncode(recChunks) : '';
  recChunks = [];
  ws.send(JSON.stringify({ type: 'voice-final', seq: recSeq++, audio: tail }));
  beep(590);
  vToast('⏳ transcribiendo…', 0);
  if (micReinit) { micReinit = false; micTeardown(); } // aplica el cambio de mic ya sin grabación en curso
}

// Tecla de push-to-talk configurable: clic derecho en 🎙 y presiona la que
// quieras (se guarda por navegador). Se comparan e.code, no e.key, para que
// sirvan también los modificadores derechos (⌥ derecho, etc.).
let pttCode = localStorage.getItem('claudemgr-ptt-code') || 'F9';
let pttLabel = localStorage.getItem('claudemgr-ptt-label') || 'F9';
let pttCapture = false;
// «Panel activo»: tras cada dictado, ese panel recibe los dictados SIN nombre
// mientras la conversación siga viva (ventana deslizante, configurable).
let voiceActive = null; // { id, nm, at }
function voiceWindowMin() {
  const m = parseFloat(localStorage.getItem('claudemgr-voice-window-min'));
  return isNaN(m) ? 5 : Math.max(0, m); // default 5 min; 0 = desactivado
}
function updateMicTitle() {
  sbMic.title = `Mantén presionado para dictar (o mantén ${pttLabel}) — clic derecho: opciones`;
}
updateMicTitle();

sbMic.addEventListener('mousedown', e => { if (e.button === 0) { e.preventDefault(); micStart(); } });
// Menú del mic: tecla, ventana del panel activo y el FILTRO DE IDIOMAS de las
// voces (global — aplica a los selectores de todos los paneles).
function renderMicMenu(m) {
  const win = voiceWindowMin();
  const sel = voiceLangsGet();
  const counts = {};
  for (const v of allVoicesMerged()) { const b = baseLang(v.lang); if (b) counts[b] = (counts[b] || 0) + 1; }
  const langs = Object.keys(counts).sort((a, b) => (b === 'es') - (a === 'es') || a.localeCompare(b));
  const micSel = localStorage.getItem('claudemgr-mic-device') || '';
  const micKnown = micDevices.some(d => d.deviceId === micSel);
  m.innerHTML =
    `<div class="vm-hdr">DICTADO</div>` +
    `<div class="vm-item" data-a="key">🎹 Cambiar tecla (actual: ${escHtml(pttLabel)})</div>` +
    `<div class="vm-item" data-a="win">⏱ Panel activo: ${win > 0 ? win + ' min' : 'desactivado'}</div>` +
    `<div class="vm-hdr">MICRÓFONO</div>` +
    `<div class="vm-item vm-mic" data-d="">${micSel === '' ? '◉' : '○'} Automático (el del sistema)</div>` +
    micDevices.map(d =>
      `<div class="vm-item vm-mic" data-d="${escHtml(d.deviceId)}">${micSel === d.deviceId ? '◉' : '○'} ${escHtml(d.label || 'Micrófono sin nombre')}</div>`
    ).join('') +
    (micSel && !micKnown ? '<div class="vm-hdr">el mic fijado no está conectado — se usa el del sistema</div>' : '') +
    (!micDevices.length ? '<div class="vm-hdr">usa el dictado una vez para ver los nombres de tus mics</div>' : '') +
    `<div class="vm-hdr">IDIOMAS DE VOCES — marca uno o varios (ninguno = todos)</div>` +
    langs.map(l =>
      `<div class="vm-item vm-lang" data-l="${l}">${sel.includes(l) ? '☑' : '☐'} ${escHtml(langLabel(l))} <span class="vm-src">${counts[l]}</span></div>`
    ).join('');
}

sbMic.addEventListener('contextmenu', e => {
  e.preventDefault();
  closeVoiceMenu();
  const m = document.createElement('div');
  m.id = 'voice-menu';
  const r = sbMic.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.left - 120, innerWidth - 290)) + 'px';
  m.style.bottom = (innerHeight - r.top + 6) + 'px';
  renderMicMenu(m);
  // Los nombres de los mics llegan async — repinta cuando estén
  refreshMicDevices().then(() => { if (document.getElementById('voice-menu') === m) renderMicMenu(m); });
  m.addEventListener('click', ev => {
    const lang = ev.target.closest('.vm-lang');
    if (lang) { // toggle de idioma — el menú se queda abierto y se repinta
      const l = lang.dataset.l;
      const sel = voiceLangsGet();
      const i = sel.indexOf(l);
      if (i >= 0) sel.splice(i, 1); else sel.push(l);
      localStorage.setItem('claudemgr-voice-langs', JSON.stringify(sel));
      renderMicMenu(m);
      return;
    }
    const mic = ev.target.closest('.vm-mic');
    if (mic) { // fija (o libera) el micrófono — aplica desde el siguiente dictado
      localStorage.setItem('claudemgr-mic-device', mic.dataset.d);
      micTeardown();
      renderMicMenu(m);
      vToast(mic.dataset.d ? '✓ micrófono fijado' : '✓ micrófono automático (el del sistema)');
      return;
    }
    const it = ev.target.closest('.vm-item');
    if (!it) return;
    closeVoiceMenu();
    if (it.dataset.a === 'key') {
      pttCapture = true;
      vToast('presiona la tecla que usarás para dictar… (Esc cancela)', 0);
    } else if (it.dataset.a === 'win') {
      const win = voiceWindowMin();
      const v = prompt('Minutos de la "conversación activa" por voz — los dictados sin nombre van al último panel usado (0 = desactivar):', String(win));
      if (v === null) return;
      const n = Math.max(0, parseFloat(v) || 0);
      localStorage.setItem('claudemgr-voice-window-min', String(n));
      vToast(n > 0 ? `✓ panel activo durante ${n} min tras cada dictado` : '✓ desactivado — siempre hay que decir el nombre', 4000);
    }
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', voiceMenuAway), 0);
});

// Contador del panel activo en la barra (estilo contador de sesión): quién
// recibe los dictados sin nombre y cuánto le queda a la ventana.
const sbVoiceWin = document.getElementById('sb-voice-win');
setInterval(() => {
  const win = voiceWindowMin();
  if (!voiceActive || win <= 0 || !terms[voiceActive.id]) { sbVoiceWin.style.display = 'none'; return; }
  const left = win * 60000 - (Date.now() - voiceActive.at);
  if (left <= 0) { sbVoiceWin.style.display = 'none'; return; }
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  sbVoiceWin.textContent = `🎯 ${voiceActive.nm} ⟳ ${mm}:${String(ss).padStart(2, '0')}`;
  sbVoiceWin.style.display = '';
}, 1000);
document.addEventListener('mouseup', () => { if (recording) micStop(); });

document.addEventListener('keydown', e => {
  if (pttCapture) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { pttCapture = false; vToast('cambio de tecla cancelado'); return; }
    // Nada que interfiera al escribir en las terminales
    if (!e.code || /^(Key[A-Z]|Digit\d|Numpad\d|Space|Enter|NumpadEnter|Backspace|Tab|Arrow|Delete|Escape)/.test(e.code)) {
      vToast('esa tecla interferiría al escribir — usa una F, bloq mayús, o un modificador derecho (⌥/⌃)', 5000);
      return;
    }
    pttCode = e.code;
    pttLabel = e.code.replace(/^(Control|Alt|Meta|Shift)(Left|Right)$/, '$1-$2');
    localStorage.setItem('claudemgr-ptt-code', pttCode);
    localStorage.setItem('claudemgr-ptt-label', pttLabel);
    pttCapture = false;
    updateMicTitle();
    vToast(`✓ dictado: mantener ${pttLabel}`);
    return;
  }
  if (e.code === pttCode && !e.repeat) { e.preventDefault(); e.stopPropagation(); micStart(); }
  else if (e.key === 'Escape' && voiceCancel()) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('keyup', e => {
  if (e.code === pttCode) { e.preventDefault(); e.stopPropagation(); micStop(); }
}, true);

// Rescate de dictados sin destino: el mensaje NO se pierde — se muestra con
// botones de las consolas visibles para mandarlo con un clic, y persiste
// hasta que elijas o canceles (Esc también cancela).
const voicePickEl = document.getElementById('voice-pick');
let voicePickText = null;

function showVoicePick(text) {
  voicePickText = text;
  const panels = [...canvas.querySelectorAll('.panel')].filter(p => !p.dataset.hidden).map(p => ({
    id: p.dataset.id,
    sys: p.querySelector('.ph-id')?.textContent.trim() || '',
    nm: p.querySelector('.ph-sub')?.textContent.trim() || p.querySelector('.ph-name')?.textContent.trim() || '?',
  }));
  voicePickEl.innerHTML =
    `<div class="vp-txt">🎙 «${escHtml(text.length > 220 ? text.slice(0, 220) + '…' : text)}»</div>` +
    `<div class="vp-q">No reconocí el nombre de la consola — ¿a cuál lo mando?</div>` +
    '<div class="vp-btns">' +
    panels.map(p =>
      `<button class="vp-btn" data-id="${p.id}" data-nm="${escHtml(p.nm)}">${escHtml(p.nm)}<span class="vp-sys">${escHtml(p.sys)}</span></button>`
    ).join('') +
    '<button class="vp-btn vp-cancel">✕ Cancelar</button></div>';
  voicePickEl.style.display = 'block';
}
function hideVoicePick() { voicePickEl.style.display = 'none'; voicePickText = null; }

voicePickEl.addEventListener('click', e => {
  const b = e.target.closest('.vp-btn');
  if (!b) return;
  if (b.classList.contains('vp-cancel')) { hideVoicePick(); vToast('envío cancelado ✕'); return; }
  const text = voicePickText;
  hideVoicePick();
  if (text) sendVoicePrompt(b.dataset.id, b.dataset.nm, text);
});

// Cancela lo que esté vivo del flujo de voz; true si había algo que cancelar
function voiceCancel() {
  let did = false;
  if (voicePendingSend) { clearTimeout(voicePendingSend.timer); voicePendingSend = null; vToast('cancelado ✕'); did = true; }
  if (voicePickText !== null) { hideVoicePick(); vToast('envío cancelado ✕'); did = true; }
  if (window.speechSynthesis && speechSynthesis.speaking) { speechSynthesis.cancel(); did = true; }
  for (const id of Object.keys(ttsPlay)) {
    if (ttsPlay[id].audio || ttsPlay[id].queue.length) { stopEngineSpeech(id); did = true; }
  }
  if (voiceReading) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop-watch' }));
    voiceReading = null; did = true;
  }
  return did;
}

// ── Ruteo: «nombre, mensaje» → sesión ─────────────────────────
const VOICE_FILLER = new Set(['oye', 'hey', 'ok', 'okey', 'okay', 'ey', 'oe', 'a', 'ver']);
const normVoice = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function levDist(a, b) {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[a.length][b.length];
}

function routeVoiceText(raw) {
  let text = (raw || '').trim();
  if (!text) { vToast('no se entendió nada'); return; }
  let words = text.split(/\s+/);
  while (words.length && VOICE_FILLER.has(normVoice(words[0]))) words.shift();
  if (!words.length) { vToast('no se entendió nada'); return; }

  // Candidatos: nota (subtítulo) y nombre de cada panel visible
  const cands = [];
  canvas.querySelectorAll('.panel').forEach(p => {
    if (p.dataset.hidden) return;
    const id = p.dataset.id;
    const sub = p.querySelector('.ph-sub')?.textContent.trim();
    const name = p.querySelector('.ph-name')?.textContent.trim();
    if (sub) cands.push({ id, nm: sub });
    if (name) cands.push({ id, nm: name });
  });

  // Prueba las primeras 1..4 palabras contra cada candidato, con tolerancia
  // difusa proporcional al largo del nombre (whisper deforma nombres raros).
  // Desempate entre paneles con el MISMO nombre (ej. el Claude y el shell del
  // mismo proyecto): gana el que corre una IA (reporta consumo de tokens) y,
  // de persistir el empate, el de actividad más reciente.
  const tieRank = id => (usageData[id] ? 1e13 : 0) + (lastOut[id] || 0);
  let best = null;
  for (const c of cands) {
    const target = normVoice(c.nm);
    if (target.length < 2) continue;
    for (let k = 1; k <= Math.min(4, words.length); k++) {
      const joined = normVoice(words.slice(0, k).join(''));
      if (joined.length < 2) continue;
      const d = levDist(joined, target);
      const tol = Math.max(1, Math.floor(target.length * 0.34));
      if (d > tol) continue;
      const better = !best || d < best.d ||
        (d === best.d && (k > best.k || (k === best.k && tieRank(c.id) > tieRank(best.id))));
      if (better) best = { id: c.id, nm: c.nm, k, d };
    }
  }
  if (!best) {
    // Sin nombre reconocido → «panel activo»: continúa la conversación con el
    // último panel usado, si la ventana deslizante sigue viva.
    const win = voiceWindowMin();
    if (win > 0 && voiceActive && Date.now() - voiceActive.at < win * 60000 && terms[voiceActive.id]) {
      const prompt = words.join(' ').replace(/^[\s,.:;¿?¡!—-]+/, '').trim();
      if (!prompt) { vToast('no se entendió nada'); return; }
      voicePendingSend = {
        id: voiceActive.id, nm: voiceActive.nm, prompt,
        timer: setTimeout(() => {
          const ps = voicePendingSend; voicePendingSend = null;
          sendVoicePrompt(ps.id, ps.nm, ps.prompt);
        }, 1500),
      };
      vToast(`→ ${voiceActive.nm} (continúa): ${prompt}   (Esc cancela)`, 0);
      return;
    }
    // El mensaje no se pierde: rescate persistente para elegir destino a mano
    const orphan = words.join(' ').replace(/^[\s,.:;¿?¡!—-]+/, '').trim();
    if (orphan) showVoicePick(orphan);
    else vToast('no se entendió nada');
    return;
  }

  const prompt = words.slice(best.k).join(' ').replace(/^[\s,.:;¿?¡!—-]+/, '').trim();
  if (!prompt) {
    // Solo dijiste el nombre → deja ese panel como el activo de la conversación
    if (voiceWindowMin() > 0) {
      voiceActive = { id: best.id, nm: best.nm, at: Date.now() };
      vToast(`🎯 panel activo: ${best.nm} — dicta sin nombre durante ${voiceWindowMin()} min`, 4000);
    } else {
      vToast(`entendí «${best.nm}» pero faltó el mensaje`, 4000);
    }
    return;
  }

  // Confirmación breve: se manda en 1.5s salvo que canceles con Esc
  voicePendingSend = {
    id: best.id, nm: best.nm, prompt,
    timer: setTimeout(() => {
      const ps = voicePendingSend; voicePendingSend = null;
      sendVoicePrompt(ps.id, ps.nm, ps.prompt);
    }, 1500),
  };
  vToast(`→ ${best.nm}: ${prompt}   (Esc cancela)`, 0);
}

function sendVoicePrompt(id, nm, prompt) {
  if (!terms[id]) { vToast('esa consola ya no existe'); return; }
  voiceActive = { id, nm, at: Date.now() }; // cada envío renueva la ventana
  // El Enter va aparte y con pausa: si llega pegado al texto, Claude lo trata
  // como parte de un "pegado" y lo convierte en salto de línea sin enviar.
  ws.send(JSON.stringify({ type: 'input', sessionId: id, data: prompt }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'input', sessionId: id, data: '\r' })), 300);
  vToast(`✓ enviado a ${nm}`);
  if (!voiceByS[id] || !window.speechSynthesis) return; // sin voz asignada — lo lees tú
  // Lectura incremental: el servidor vigila el transcript de la sesión y va
  // mandando cada bloque de texto conforme Claude lo termina de escribir;
  // aquí solo se encolan en la voz (ver response-block).
  speechSynthesis.cancel(); // corta cualquier lectura anterior
  voiceReading = { id, nm, blocks: 0 };
  ws.send(JSON.stringify({ type: 'watch-response', sessionId: id }));
}
let voiceReading = null; // { id, nm, blocks } — sesión cuya respuesta se está leyendo

// Markdown → texto hablable: fuera código, símbolos y enlaces
function speechFromMarkdown(md) {
  let t = md.replace(/```[\s\S]*?```/g, ' — código omitido — ');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/\|/g, ', ').replace(/[▐▌│─╭╮╰╯]/g, ' ');
  return t.replace(/\n{2,}/g, '. ').replace(/\n/g, '. ').replace(/\.\s*\.+/g, '.').trim();
}

