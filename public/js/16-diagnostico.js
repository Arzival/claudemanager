// 16-diagnostico.js — Panel de diagnóstico de renderizado.
//
// Se activa SOLO con ?diag=1 en la URL. Existe porque depurar "la terminal se ve
// en blanco" en un teléfono ajeno es imposible a ciegas: aquí se miden las cosas
// que de verdad importan (renderizador, fuente resuelta, tamaño de carácter,
// dimensiones del contenedor) y basta una captura de pantalla para saber qué pasa.

(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('diag') !== '1') return;

  const caja = document.createElement('div');
  caja.style.cssText = `position:fixed;left:6px;right:6px;bottom:6px;z-index:9999;
    background:rgba(4,6,14,.96);border:1px solid #00f5ff;border-radius:10px;
    padding:10px 12px;font:11px/1.5 monospace;color:#b8cbe0;max-height:52vh;
    overflow:auto;white-space:pre-wrap;word-break:break-word`;
  document.body.appendChild(caja);

  function medirFuente(familia) {
    // Truco estándar: si el ancho de un texto con la familia pedida difiere del
    // de una familia inexistente, es que la fuente se resolvió de verdad.
    const c = document.createElement('canvas').getContext('2d');
    const txt = 'MMMMMMMMMMWWWWWWWWWW';
    c.font = `13px ${familia}`;           const a = c.measureText(txt).width;
    c.font = '13px "no-existe-xyz-123"';  const b = c.measureText(txt).width;
    return { ancho: Math.round(a * 100) / 100, resuelta: Math.abs(a - b) > 0.5 };
  }

  function soportaWebGL() {
    try {
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      if (!gl) return 'NO disponible';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 44) : 'sí (sin detalle)';
    } catch (e) { return 'error: ' + e.message; }
  }

  function informe() {
    const p = document.querySelector('.panel.mv-activo') || document.querySelector('.panel');
    const id = p && p.dataset.id;
    const t = id && typeof terms !== 'undefined' ? terms[id] : null;
    const filas = p ? p.querySelectorAll('.xterm-rows > div').length : 0;
    const lienzos = p ? p.querySelectorAll('canvas').length : 0;
    const tw = p ? p.querySelector('.tw') : null;
    const scr = p ? p.querySelector('.xterm-screen') : null;

    const fuentes = ['Courier New', 'DejaVu Sans Mono', 'Roboto Mono', 'Droid Sans Mono', 'monospace']
      .map(f => { const m = medirFuente(`"${f}"`); return `    ${f}: ${m.resuelta ? 'SÍ' : 'no'} (${m.ancho}px)`; })
      .join('\n');

    let texto = '';
    try { texto = (p.querySelector('.xterm-rows') || {}).innerText || ''; } catch {}

    caja.textContent =
`DIAGNÓSTICO  ·  toca para actualizar  ·  ✕ para cerrar
──────────────────────────────────────────
modo body    : ${document.body.className || '(escritorio)'}
panel activo : ${id || 'NINGUNO'}
renderizador : ${lienzos > 0 ? 'WebGL/canvas (' + lienzos + ' lienzos)' : (filas > 0 ? 'DOM (' + filas + ' filas)' : 'NINGUNO ⚠')}
term cols×rows: ${t ? t.cols + '×' + t.rows : '—'}
.tw tamaño   : ${tw ? Math.round(tw.clientWidth) + '×' + Math.round(tw.clientHeight) : '—'}
.xterm-screen: ${scr ? Math.round(scr.clientWidth) + '×' + Math.round(scr.clientHeight) : '—'}
texto en DOM : ${texto.trim().length} caracteres
WebSocket    : ${typeof ws !== 'undefined' ? ['CONECTANDO','ABIERTO','CERRANDO','CERRADO'][ws.readyState] : '—'}
devicePixelRatio: ${window.devicePixelRatio}
viewport     : ${innerWidth}×${innerHeight}
webgl del SO : ${soportaWebGL()}

fuentes disponibles:
${fuentes}

navegador    : ${navigator.userAgent.slice(0, 96)}`;
  }

  caja.addEventListener('click', informe);
  const x = document.createElement('button');
  x.textContent = '✕';
  x.style.cssText = 'position:absolute;top:4px;right:6px;background:none;border:none;color:#00f5ff;font-size:16px';
  x.addEventListener('click', e => { e.stopPropagation(); caja.remove(); });
  caja.appendChild(x);

  informe();
  setInterval(informe, 2000);
})();
