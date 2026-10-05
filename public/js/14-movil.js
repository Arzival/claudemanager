// 14-movil.js — Vista móvil: lista de sesiones ↔ terminal, compositor y lanzador.
//
// NO reimplementa terminales. Reutiliza los mismos `.panel` que el tablero de
// escritorio: aquí solo se decide cuál se ve, se le quita el cromo de ventana
// (css/movil.css) y se le añade una navegación pensada para el dedo.
//
// Script clásico: comparte scope global con los demás. Carga después de 13.

(function () {
  'use strict';

  // ── Detección ────────────────────────────────────────────────
  // Por viewport y tipo de puntero, NUNCA por user-agent (miente y envejece mal).
  // ?movil=1 / ?movil=0 fuerzan el modo para poder probarlo desde el escritorio.
  function esMovil() {
    const forzado = new URLSearchParams(location.search).get('movil');
    if (forzado === '1') return true;
    if (forzado === '0') return false;
    const angosto = Math.min(window.innerWidth, window.innerHeight) <= 820;
    const tactil = window.matchMedia('(pointer: coarse)').matches;
    return angosto && tactil;
  }

  let movil = esMovil();
  if (!movil) return;              // en escritorio este módulo no hace nada más
  document.body.classList.add('movil');

  const $ = id => document.getElementById(id);
  let sesionActiva = null;         // id de la sesión abierta, o null = lista

  // ── Alto real del viewport ───────────────────────────────────
  // En móvil el teclado no reduce 100vh: tapa la página. visualViewport sí
  // refleja el área visible, y de ahí sale --mv-vh.
  function ajustarAlto() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--mv-vh', h + 'px');
    if (sesionActiva) refitear(sesionActiva);
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', ajustarAlto);
    visualViewport.addEventListener('scroll', ajustarAlto);
  }
  window.addEventListener('resize', ajustarAlto);
  window.addEventListener('orientationchange', () => setTimeout(ajustarAlto, 250));
  ajustarAlto();

  // Recalcula columnas/filas y avisa al pty. Sin esto, al rotar el teléfono la
  // TUI de Claude/Codex se queda dibujada al tamaño anterior.
  function refitear(id) {
    const fit = fits[id], t = terms[id];
    if (!fit || !t) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'resize', sessionId: id, cols: t.cols, rows: t.rows }));
      } catch {}
    });
  }

  // ── Scroll táctil ────────────────────────────────────────────
  // xterm deja el scroll a un div interno (.xterm-viewport) que con el dedo
  // apenas responde: la capa .xterm-screen queda encima y se come el gesto.
  // Aquí se toma el control del arrastre sobre el panel y se traduce a
  // scrollTop del viewport, con inercia para que se sienta nativo.
  const conScroll = new WeakSet();

  function habilitarScrollTactil(panel) {
    if (!panel || conScroll.has(panel)) return;
    const vp = panel.querySelector('.xterm-viewport');
    if (!vp) return;
    conScroll.add(panel);

    let y0 = 0, top0 = 0, yUlt = 0, tUlt = 0, vel = 0, activo = false, anim = null;

    panel.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      if (anim) { cancelAnimationFrame(anim); anim = null; }
      y0 = yUlt = e.touches[0].clientY;
      top0 = vp.scrollTop; tUlt = Date.now(); vel = 0; activo = true;
    }, { passive: true });

    panel.addEventListener('touchmove', e => {
      if (!activo || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const nuevo = top0 - (y - y0);
      // Solo se intercepta el gesto si de verdad hay a dónde desplazarse; si no,
      // se deja pasar para no bloquear otros gestos del sistema.
      const max = vp.scrollHeight - vp.clientHeight;
      if (max > 0) {
        vp.scrollTop = Math.max(0, Math.min(max, nuevo));
        if (e.cancelable) e.preventDefault();
      }
      const ahora = Date.now(), dt = ahora - tUlt;
      if (dt > 0) vel = (yUlt - y) / dt;
      yUlt = y; tUlt = ahora;
    }, { passive: false });

    panel.addEventListener('touchend', () => {
      activo = false;
      let v = vel * 16;                       // px por frame
      const max = vp.scrollHeight - vp.clientHeight;
      (function inercia() {
        if (Math.abs(v) < 0.4) { anim = null; return; }
        vp.scrollTop = Math.max(0, Math.min(max, vp.scrollTop + v));
        v *= 0.93;
        anim = requestAnimationFrame(inercia);
      })();
    }, { passive: true });

    // Botón para volver al final: en una terminal larga, arrastrar hasta abajo
    // es tedioso.
    vp.addEventListener('scroll', () => {
      const alFinal = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 24;
      document.body.classList.toggle('scrolleado', !alFinal);
    }, { passive: true });
  }

  // ── Datos de una sesión (se leen del panel que ya existe) ────
  function infoSesion(id) {
    const p = document.querySelector(`.panel[data-id="${id}"]`);
    if (!p) return null;
    return {
      id,
      nombre: (p.querySelector('.ph-name') || {}).textContent || 'SESIÓN',
      cwd: (p.querySelector('.ph-cwd') || {}).textContent || '',
      estado: statuses[id] || 'running',
    };
  }
  const idsSesiones = () => [...document.querySelectorAll('.panel')].map(p => p.dataset.id);

  // ── Lista ────────────────────────────────────────────────────
  function pintarLista() {
    const cont = $('mv-sesiones'), ids = idsSesiones();
    cont.innerHTML = '';
    $('mv-vacio').classList.toggle('on', ids.length === 0);

    ids.forEach(id => {
      const s = infoSesion(id); if (!s) return;
      const card = document.createElement('div');
      card.className = 'mv-card';
      card.dataset.id = id;
      card.innerHTML = `
        <span class="dot ${s.estado}"></span>
        <div class="mv-card-txt">
          <div class="mv-card-n"></div>
          <div class="mv-card-s"></div>
        </div>
        <span class="mv-card-ch">›</span>`;
      card.querySelector('.mv-card-n').textContent = s.nombre;
      card.querySelector('.mv-card-s').textContent = s.cwd;
      card.addEventListener('click', () => abrir(id));
      cont.appendChild(card);
    });
  }

  // ── Navegación ───────────────────────────────────────────────
  function abrir(id) {
    if (!document.querySelector(`.panel[data-id="${id}"]`)) return;
    sesionActiva = id;
    document.querySelectorAll('.panel').forEach(p =>
      p.classList.toggle('mv-activo', p.dataset.id === id));
    document.body.classList.add('en-sesion');

    const s = infoSesion(id);
    $('mv-nombre').textContent = s ? s.nombre : '';
    $('mv-dot').className = 'dot ' + (s ? s.estado : 'running');

    // Entrada en el historial: así el botón físico de atrás de Android vuelve
    // a la lista en vez de cerrar la app.
    if (!history.state || history.state.mv !== id)
      history.pushState({ mv: id }, '', '#s=' + encodeURIComponent(id));

    refitear(id);
    setTimeout(() => {
      try { terms[id].scrollToBottom(); } catch {}
      habilitarScrollTactil(document.querySelector(`.panel[data-id="${id}"]`));
      document.body.classList.remove('scrolleado');
    }, 60);
  }

  function volver(desdeHistorial) {
    sesionActiva = null;
    document.body.classList.remove('en-sesion', 'escribiendo');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('mv-activo'));
    pintarLista();
    if (!desdeHistorial && history.state && history.state.mv) history.back();
  }

  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('en-sesion')) volver(true);
  });

  $('mv-abajo-del-todo').addEventListener('click', () => {
    if (!sesionActiva) return;
    try { terms[sesionActiva].scrollToBottom(); } catch {}
    document.body.classList.remove('scrolleado');
  });

  $('mv-atras').addEventListener('click', () => volver(false));
  $('mv-cerrar').addEventListener('click', () => {
    if (!sesionActiva) return;
    if (!confirm('¿Cerrar esta sesión?')) return;
    ws.send(JSON.stringify({ type: 'close', sessionId: sesionActiva }));
    volver(false);
  });

  // ── Compositor ───────────────────────────────────────────────
  const texto = $('mv-texto');

  function crecer() {
    texto.style.height = 'auto';
    texto.style.height = Math.min(texto.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  texto.addEventListener('input', crecer);

  function escribir(data) {
    if (!sesionActiva || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', sessionId: sesionActiva, data }));
  }

  function enviar() {
    const v = texto.value;
    if (!v.trim() || !sesionActiva) return;
    escribir(v);
    // El Enter va aparte y con un respiro: las TUI (Claude, Codex) necesitan
    // procesar el pegado antes de recibir el retorno. Mismo patrón que el dictado.
    setTimeout(() => escribir('\r'), 260);
    texto.value = '';
    crecer();
    document.body.classList.remove('escribiendo');
  }
  $('mv-enviar').addEventListener('click', enviar);

  // Modo "escribir en grande" para instrucciones largas
  $('mv-expandir').addEventListener('click', () => {
    document.body.classList.toggle('escribiendo');
    if (document.body.classList.contains('escribiendo')) texto.focus();
    else if (sesionActiva) refitear(sesionActiva);
  });

  // Teclas que el teclado táctil no tiene y las TUI sí necesitan
  const SECUENCIAS = {
    'esc': '\x1b', 'tab': '\t', 'enter': '\r', 'ctrl-c': '\x03',
    'up': '\x1b[A', 'down': '\x1b[B', 'right': '\x1b[C', 'left': '\x1b[D',
  };
  $('mv-teclas').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    const seq = SECUENCIAS[b.dataset.k];
    if (seq) { escribir(seq); e.preventDefault(); }
  });

  // ── Estados: refleja el punto en la lista y en la barra ──────
  // Se envuelve setDot en vez de editar 07-paneles.js.
  const setDotOriginal = setDot;
  setDot = function (id, st) {
    setDotOriginal(id, st);
    const card = document.querySelector(`.mv-card[data-id="${id}"] .dot`);
    if (card) card.className = 'dot ' + st;
    if (id === sesionActiva) $('mv-dot').className = 'dot ' + st;
  };

  // ── Lanzador (hoja inferior) ─────────────────────────────────
  let techSel = null, projSel = null, toolSel = null;
  // Contexto adicional: ruta → nombre. Se pasa por --add-dir al lanzar, igual
  // que el "＋ ctx" del tablero de escritorio.
  const ctxSel = new Map();
  let modoCtx = false;   // el selector elige contexto en vez del proyecto principal

  function abrirHoja() {
    techSel = projSel = null;
    modoCtx = false;
    ctxSel.clear();      // el contexto es por lanzamiento, no persiste
    toolSel = (toolsList[0] || {}).id || null;
    document.body.classList.add('hoja');
    if (!projectData.length) ws.send(JSON.stringify({ type: 'projects' }));
    pintarHoja();
  }
  function cerrarHoja() { document.body.classList.remove('hoja'); }

  $('mv-nueva').addEventListener('click', abrirHoja);
  $('mv-hoja-fondo').addEventListener('click', cerrarHoja);

  function pintarHoja() {
    // Migas: tecnología seleccionada
    $('mv-ruta').innerHTML = techSel === null
      ? 'Elige una carpeta'
      : `<b>${techSel}</b>${projSel ? ' › ' + projSel.name : ''}`;

    const lista = $('mv-proyectos');
    lista.innerHTML = '';

    if (techSel === null) {
      if (!projectData.length) {
        lista.innerHTML = '<div class="mv-item">Cargando…</div>';
      } else {
        projectData.forEach(t => {
          const el = document.createElement('div');
          el.className = 'mv-item';
          el.innerHTML = '<span class="ic">▸</span>';
          el.appendChild(document.createTextNode(`${t.tech}  (${t.projects.length})`));
          el.addEventListener('click', () => {
            techSel = t.tech;
            // Cambiar de tecnología reinicia la selección principal, PERO no
            // cuando estás navegando para marcar contexto: ahí el proyecto
            // principal ya está elegido y debe conservarse.
            if (!modoCtx) projSel = null;
            pintarHoja();
          });
          lista.appendChild(el);
        });
      }
    } else {
      const t = projectData.find(x => x.tech === techSel);
      const atras = document.createElement('div');
      atras.className = 'mv-item';
      atras.innerHTML = '<span class="ic">‹</span>';
      atras.appendChild(document.createTextNode('volver'));
      atras.addEventListener('click', () => { techSel = null; projSel = null; pintarHoja(); });
      lista.appendChild(atras);

      if (!t || !t.projects.length) {
        const v = document.createElement('div');
        v.className = 'mv-item'; v.textContent = 'Carpeta vacía';
        lista.appendChild(v);
      } else t.projects.forEach(p => {
        const esPrincipal = projSel && projSel.path === p.path;
        const enCtx = ctxSel.has(p.path);
        const el = document.createElement('div');
        el.className = 'mv-item' + ((modoCtx ? enCtx : esPrincipal) ? ' sel' : '');
        el.innerHTML = `<span class="ic">${modoCtx ? (enCtx ? '📎' : '□') : '■'}</span>`;
        el.appendChild(document.createTextNode(p.name));
        el.addEventListener('click', () => {
          if (modoCtx) {
            // El proyecto principal no puede ser además su propio contexto.
            if (projSel && projSel.path === p.path) return;
            if (enCtx) ctxSel.delete(p.path); else ctxSel.set(p.path, p.name);
          } else {
            projSel = p;
            ctxSel.delete(p.path);   // si estaba como contexto, deja de estarlo
          }
          pintarHoja();
        });
        lista.appendChild(el);
      });
    }

    // Herramientas
    const cont = $('mv-tools');
    cont.innerHTML = '';
    toolsList.forEach(t => {
      const c = document.createElement('div');
      c.className = 'mv-chip' + (t.id === toolSel ? ' sel' : '');
      c.textContent = t.name;
      c.addEventListener('click', () => { toolSel = t.id; pintarHoja(); });
      cont.appendChild(c);
    });

    // Los switches solo se muestran si la herramienta los soporta
    const tool = toolsList.find(t => t.id === toolSel);
    $('mv-sw-resume').classList.toggle('oculto', !(tool && tool.resumeFlag));
    $('mv-sw-skip').classList.toggle('oculto', !(tool && tool.skipPermsFlag));

    // Contexto: solo para herramientas que lo aceptan por flag. Sin addDirFlag
    // el servidor escribe las rutas como texto en la consola, y en una terminal
    // normal bash intentaría ejecutarlas.
    const aceptaCtx = !!(tool && tool.addDirFlag);
    $('mv-ctx-wrap').classList.toggle('oculto', !aceptaCtx || !projSel);
    if (!aceptaCtx && ctxSel.size) { ctxSel.clear(); modoCtx = false; }

    $('mv-ctx-modo').classList.toggle('on', modoCtx);
    $('mv-lbl-proy').textContent = modoCtx ? 'Elige proyectos de contexto' : 'Proyecto';

    const chips = $('mv-ctx-chips');
    chips.innerHTML = '';
    ctxSel.forEach((nombre, ruta) => {
      const c = document.createElement('span');
      c.className = 'mv-ctx-chip';
      c.innerHTML = '📎 <b></b><i>✕</i>';
      c.querySelector('b').textContent = nombre;
      c.addEventListener('click', () => { ctxSel.delete(ruta); pintarHoja(); });
      chips.appendChild(c);
    });
    $('mv-ctx-add').textContent = ctxSel.size
      ? '📎 agregar otro proyecto de contexto'
      : '📎 agregar proyecto de contexto';

    $('mv-lanzar').disabled = !(projSel && toolSel);
    $('mv-lanzar').textContent = ctxSel.size ? `LANZAR + ${ctxSel.size} ctx` : 'LANZAR';
  }

  // Entrar/salir del modo de selección de contexto
  $('mv-ctx-add').addEventListener('click', () => {
    modoCtx = true;
    techSel = null;          // vuelve a la raíz para poder navegar a otra tecnología
    pintarHoja();
    $('mv-proyectos').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('mv-ctx-fin').addEventListener('click', () => { modoCtx = false; pintarHoja(); });

  $('mv-lanzar').addEventListener('click', () => {
    if (!projSel || !toolSel) return;
    const tool = toolsList.find(t => t.id === toolSel);
    // Columnas/filas pensadas para el teléfono. El lanzador de escritorio fuerza
    // un mínimo de 80 columnas, que en vertical no cabe ni de lejos.
    const cols = Math.max(30, Math.floor((window.innerWidth - 20) / 8.4));
    const rows = Math.max(16, Math.floor((window.innerHeight * 0.55) / 17));
    ws.send(JSON.stringify({
      type: 'open',
      projectPath: projSel.path,
      projectName: projSel.name,
      toolId: toolSel,
      resume: !!(tool && tool.resumeFlag) && $('mv-resume').checked,
      dangerousSkip: !!(tool && tool.skipPermsFlag) && $('mv-skip').checked,
      // Mismo criterio que el tablero: el proyecto principal nunca va también
      // como contexto.
      contextPaths: [...ctxSel.keys()].filter(p => p !== projSel.path),
      cols, rows,
    }));
    cerrarHoja();
  });

  // ── Enganches con el resto de la app ─────────────────────────
  // El módulo de WS repinta paneles; se refresca la lista cuando cambian.
  const observador = new MutationObserver(() => {
    if (!document.body.classList.contains('en-sesion')) pintarLista();
    // Si se cerró la sesión que estabas viendo, vuelve a la lista.
    if (sesionActiva && !document.querySelector(`.panel[data-id="${sesionActiva}"]`)) volver(false);
  });
  observador.observe(canvas, { childList: true });

  // Repintar cuando llegan proyectos nuevos del servidor
  const pintarHojaSiAbierta = () => { if (document.body.classList.contains('hoja')) pintarHoja(); };
  setInterval(pintarHojaSiAbierta, 700);

  // Abrir una sesión concreta: al tocar una notificación
  navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'abrir-sesion' && ev.data.sessionId) abrir(ev.data.sessionId);
  });
  // …o si la app se abrió desde cero con ?session=
  const pedida = new URLSearchParams(location.search).get('session');
  if (pedida) setTimeout(() => abrir(pedida), 1200);

  // Exponer para otros módulos (notificaciones)
  window.mvAbrir = abrir;
  window.mvPintarLista = pintarLista;

  pintarLista();
  setTimeout(pintarLista, 800);   // por si los paneles llegan tras el primer render
})();
