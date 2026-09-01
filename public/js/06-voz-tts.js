// 06-voz-tts.js — Voz (2/2): síntesis (sistema + Kokoro/Piper), cola de audio y selector por panel
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── TTS con la voz del panel ──────────────────────────────────
// Dos familias de voces: las del sistema (speechSynthesis, el navegador las
// reproduce) y las de motor (kokoro:/piper: — el servidor sintetiza WAVs que
// aquí se encolan y encadenan).
let voiceList = [];
function refreshVoiceList() { try { voiceList = speechSynthesis.getVoices(); } catch {} }
if (window.speechSynthesis) {
  refreshVoiceList();
  speechSynthesis.onvoiceschanged = refreshVoiceList;
}

let ttsVoices = [];            // catálogo Kokoro/Piper que manda el servidor
const isEngineVoice = v => /^(kokoro|piper):/.test(v || '');
const ttsGen = {};             // sessionId -> generación (para cancelar)
const ttsPlay = {};            // sessionId -> { queue: [], audio }
let ttsSeq = 0;

function chunkText(text, max) {
  const parts = text.match(/[^.!?\n]+[.!?]?/g) || [text];
  let buf = '';
  const chunks = [];
  for (const p of parts) {
    if ((buf + p).length > max) { if (buf.trim()) chunks.push(buf); buf = p; }
    else buf += p;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.slice(0, 60);
}

function stopEngineSpeech(id) {
  ttsGen[id] = (ttsGen[id] || 0) + 1;
  const p = ttsPlay[id];
  if (p) { p.queue = []; try { p.audio?.pause(); } catch {} p.audio = null; }
}

function enqueueTtsWav(id, wav) {
  const p = ttsPlay[id] || (ttsPlay[id] = { queue: [], audio: null });
  p.queue.push(wav);
  if (!p.audio) playNextTts(id);
}

function playNextTts(id) {
  const p = ttsPlay[id];
  if (!p) return;
  const wav = p.queue.shift();
  if (!wav) { p.audio = null; return; }
  const a = new Audio('data:audio/wav;base64,' + wav);
  p.audio = a;
  a.onended = () => playNextTts(id);
  a.onerror = () => playNextTts(id);
  a.play().catch(() => playNextTts(id));
}

// append=true encola SIN cortar lo que ya se está leyendo — así los bloques
// que van llegando en vivo se encadenan uno tras otro.
function speak(id, text, append) {
  const vName = voiceByS[id];
  if (!vName) return;
  if (isEngineVoice(vName)) {
    if (!append) stopEngineSpeech(id);
    const gen = ttsGen[id] || 0;
    for (const c of chunkText(text, 380)) {
      ws.send(JSON.stringify({ type: 'tts', reqId: `${gen}:${++ttsSeq}`,
        sessionId: id, voice: vName, text: c.trim() }));
    }
    return;
  }
  if (!window.speechSynthesis) return;
  const v = voiceList.find(x => x.name === vName);
  if (!append) speechSynthesis.cancel();
  for (const c of chunkText(text, 220)) {
    const u = new SpeechSynthesisUtterance(c.trim());
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-MX';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
}

// ── Selector de voz por panel ─────────────────────────────────
// Lista PLANA con todas las fuentes mezcladas (sistema + Kokoro + Piper),
// filtrada por los idiomas que marques arriba (persistidos globalmente).
function voiceLangsGet() {
  try { return JSON.parse(localStorage.getItem('claudemgr-voice-langs')) || []; }
  catch { return []; }
}
const baseLang = l => (l || '').toLowerCase().split(/[-_]/)[0];
let langNamer = null;
try { langNamer = new Intl.DisplayNames(['es'], { type: 'language' }); } catch {}
function langLabel(c) {
  try { const n = langNamer && langNamer.of(c); return n ? n[0].toUpperCase() + n.slice(1) : c; }
  catch { return c; }
}

function allVoicesMerged() {
  refreshVoiceList();
  const sys = voiceList.map(v => ({ id: v.name, name: v.name, lang: v.lang || '', source: 'sistema' }));
  return [...ttsVoices, ...sys];
}

function voiceDisplayName(val) {
  if (!val) return '';
  const hit = allVoicesMerged().find(v => v.id === val);
  return hit ? hit.name : val;
}

function updateVoiceBtn(id) {
  const btn = document.querySelector(`.panel[data-id="${id}"] .ph-voice`);
  if (!btn) return;
  const on = !!voiceByS[id];
  btn.textContent = on ? '🔊' : '🔇';
  btn.classList.toggle('on', on);
  btn.title = on ? `Voz: ${voiceDisplayName(voiceByS[id])}` : 'Sin voz — clic para elegir una';
}

function closeVoiceMenu() {
  document.getElementById('voice-menu')?.remove();
  document.removeEventListener('mousedown', voiceMenuAway);
}
function voiceMenuAway(e) {
  if (!e.target.closest('#voice-menu')) closeVoiceMenu();
}

function renderVoiceMenu(m, id) {
  const sel = voiceLangsGet();
  const cur = voiceByS[id] || '';
  const shown = allVoicesMerged()
    .filter(v => !sel.length || sel.includes(baseLang(v.lang)))
    .sort((a, b) => baseLang(a.lang).localeCompare(baseLang(b.lang)) || a.name.localeCompare(b.name));
  const filtro = sel.length ? sel.map(langLabel).join(', ') : 'todos';
  m.innerHTML =
    `<div class="vm-hdr">VOCES — idiomas: ${escHtml(filtro)} (cámbialos con clic derecho en 🎙)</div>` +
    `<div class="vm-item ${cur === '' ? 'sel' : ''}" data-v="">🔇 Sin voz (yo la leo)</div>` +
    (shown.map(v =>
      `<div class="vm-item ${v.id === cur ? 'sel' : ''}" data-v="${escHtml(v.id)}">${escHtml(v.name)}` +
      `<span class="vm-src">${escHtml(v.source)}${v.downloaded === false ? ' · ⬇' + (v.sizeMb || '?') + 'MB' : ''}</span></div>`
    ).join('') || '<div class="vm-hdr">sin voces en esos idiomas</div>');
}

function openVoiceMenu(id, btn) {
  closeVoiceMenu();
  const m = document.createElement('div');
  m.id = 'voice-menu';
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.left, innerWidth - 290)) + 'px';
  m.style.top = Math.min(r.bottom + 4, innerHeight - 340) + 'px';
  renderVoiceMenu(m, id);
  m.addEventListener('click', e => {
    const it = e.target.closest('.vm-item');
    if (!it || it.dataset.v === undefined) return;
    const val = it.dataset.v;
    voiceByS[id] = val;
    ws.send(JSON.stringify({ type: 'save-voice', sessionId: id, voice: val }));
    updateVoiceBtn(id);
    if (val) speak(id, 'Así voy a leer las respuestas de esta consola', false); // demo
    closeVoiceMenu();
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', voiceMenuAway), 0);
}

