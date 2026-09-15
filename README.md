# Claude Manager

Dashboard web para correr múltiples sesiones de Claude Code (u otras herramientas de IA CLI) en paralelo, cada una en su propio panel de terminal interactivo.

## Requisitos

- Node.js 18+

> **Si `npm install` falla** es porque una dependencia interna (`node-pty`) necesita compilar código nativo. Instala las herramientas de compilación de tu sistema y vuelve a intentarlo:
>
> - **macOS**: `xcode-select --install` (Command Line Tools, no el IDE)
> - **Linux**: `sudo apt install build-essential python3`
> - **Windows**: instala [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) y selecciona "Desarrollo para escritorio con C++"
>
> Si `npm install` funcionó sin errores, no necesitas hacer nada de esto.

## Instalación

```bash
git clone <repo>
cd claudemanager
npm install
npm start
```

Abre **http://localhost:3000** — la primera vez aparece un modal de configuración. No hay que editar ningún archivo manualmente. (El puerto se puede cambiar con la variable de entorno `PORT`.)

> Todo el estado del dashboard (sesiones, historial de comandos, voces, caché de consumo) vive en `~/.claudemanager/`, fuera del repo — actualizar el proyecto nunca toca tu configuración.

## Configuración inicial

Al abrir el dashboard por primera vez (o desde **⚙ CONFIG**):

1. **Projects Root** — carpeta que contiene tus subcarpetas por tecnología (`React/`, `Node/`, `Laravel/`, etc.)
2. **Herramientas** — lista de herramientas CLI configuradas. Claude Code viene preconfigurado. Puedes agregar Gemini, Aider o cualquier otra herramienta CLI.

### Agregar una herramienta nueva

En **⚙ CONFIG → Herramientas → ＋ Agregar herramienta**:

| Campo | Descripción |
|-------|-------------|
| Nombre | Nombre visible (ej. `Gemini CLI`) |
| Comando | Ruta al ejecutable (ej. `/usr/local/bin/gemini`) |
| Flag skip permisos | Flag para omitir confirmaciones (ej. `--dangerously-skip-permissions`). Dejar vacío si no aplica |
| Flag reanudar | Flag para retomar la última conversación (ej. `--continue`). Dejar vacío si no aplica |
| Flag agregar directorio | Flag para pasar directorios de contexto (ej. `--add-dir`). Claude Code lo trae preconfigurado |

## Abrir proyectos

Haz clic en **＋ OPEN PROJECT**:

1. Navega por tecnología (izquierda) y selecciona el proyecto principal (derecha)
2. Elige la **herramienta** a usar (Claude Code, Gemini, etc.) — los checkboxes se adaptan según lo que soporte cada herramienta
3. **↩ retomar** — reanuda la última conversación. Sin marcarlo la herramienta arranca desde cero
4. **⚡ skip perms** — omite las confirmaciones de permisos
5. **Contexto adicional** — haz clic en **＋ ctx** junto a otros proyectos para añadirlos como contexto (útil para tener front + back + mobile en la misma sesión). Puedes navegar a otra tecnología para buscar el proyecto de contexto — la selección principal no se pierde. Puedes agregar N proyectos
6. Click **LAUNCH**

> Los proyectos de contexto se pasan vía `--add-dir` al lanzar (en Claude Code), por lo que la IA tiene acceso real a esos directorios desde el inicio de la sesión.

### Lanzamiento rápido — clic derecho en el tablero

Para el día a día hay un camino más corto que el picker: **clic derecho sobre un hueco vacío del tablero** abre un menú compacto en el cursor:

- Elige la **herramienta** (si tienes varias; recuerda tu última elección) y los toggles de retomar/skip — solo aparecen los que esa herramienta soporta.
- **Clic derecho sobre un proyecto** de la lista lo marca como **contexto** (📎, equivalente a `＋ ctx`); marca los que quieras.
- **Clic en el proyecto principal** → la consola se lanza con ese contexto y el panel nace **con su esquina donde hiciste el clic derecho**.

### Crear carpetas desde el dashboard

En el picker de proyectos, al seleccionar una tecnología aparece el botón **＋ Nueva carpeta**. Crea la carpeta y lanza Claude ahí directamente para empezar un proyecto desde cero.

Las carpetas creadas externamente (Finder, terminal) se detectan automáticamente la próxima vez que abres el picker.

## Workspaces

Agrupa tus paneles en workspaces con nombre, como si fueran perfiles de trabajo:

| Acción | Cómo |
|--------|------|
| Crear workspace | **＋ Nuevo** — empieza vacío, agrega los proyectos que quieras |
| Cambiar workspace | Click en el tab correspondiente |
| Guardar estado | **↓ Guardar** (también se guarda automáticamente al mover/redimensionar) |
| Eliminar workspace | Hover sobre el tab → aparece **✕** |

Al cambiar de workspace los paneles no se matan — siguen corriendo en background. Al volver, aparecen en el mismo lugar donde los dejaste.

## Fondos y transparencia por workspace

Cada workspace puede tener su propio fondo de tablero y un nivel de transparencia para las terminales.

1. Copia tus imágenes (PNG, JPG, WEBP, GIF…) dentro de la carpeta **`fondos/`** del proyecto. La carpeta está versionada, pero su contenido se ignora en git (tus fondos quedan solo en tu equipo).
2. En la barra de workspaces haz clic en **🖼 Fondo** para abrir el selector.
3. Elige una miniatura (o **🚫 sin fondo**). Pasa el cursor por encima para previsualizar antes de aplicar.
4. Mueve el slider **Transparencia** para ajustar cuánto se transparenta el fondo de las terminales de ese workspace. El texto siempre se mantiene legible.

El fondo y la transparencia se guardan por workspace en `localStorage`, junto con el layout.

## Layout libre — organiza los paneles como quieras

Los paneles se comportan como ventanas independientes:

| Acción | Cómo |
|--------|------|
| **Mover** un panel | Arrastra desde su barra de título |
| **Redimensionar** por un borde | Arrastra el borde derecho, izquierdo, superior o inferior |
| **Redimensionar** diagonal | Arrastra el cuadrito cyan en la esquina inferior-derecha |
| **Scroll** cuando hay muchos paneles | Arrastra un panel hacia abajo — la página hace scroll automáticamente |
| **Traer al frente** | Haz clic en cualquier parte del panel |
| **Cerrar** un panel | Botón **✕** en la barra de título |

El layout se guarda automáticamente en `localStorage` — al recargar o reiniciar el servidor los paneles aparecen exactamente donde los dejaste.

## Dentro de cada terminal

| Acción | Cómo |
|--------|------|
| Escribir a la IA | Escribe directamente en el panel |
| Limpiar el panel localmente | **Ctrl + K** |

## Sugerencias de comandos (shells)

En sesiones cuyo proceso en primer plano es un shell (bash/zsh/ssh — nunca dentro de Claude u otra TUI), el dashboard **aprende los comandos que ejecutas** en una lista global compartida entre proyectos. Al escribir 2+ caracteres aparece una caja con coincidencias: `↑↓` elige, `Enter` ejecuta, `Tab` solo completa, `Esc` cierra, clic inserta y clic derecho borra la entrada. No registra líneas en prompts de contraseña ni líneas que empiecen con espacio.

El botón **⌨ CMDS** del header abre el gestor del historial: buscador, editar inline (corregir un typo hacia un comando existente fusiona los contadores), borrar por fila y purga de los comandos de un solo uso.

## Git integrado

Cada panel cuyo directorio es un repo muestra un **badge con la rama y los cambios pendientes** (`⎇ main ±3`). Clic en el badge → **drawer lateral** con la lista de archivos modificados y su diff coloreado; los `.md` se abren **renderizados** (con toggle MD/Diff). El ancho del drawer se ajusta arrastrando su borde izquierdo.

## Arrastrar archivos y carpetas a una terminal

Al soltar algo sobre una terminal se pega su **ruta**. El navegador oculta la ruta original por seguridad, así que el servidor la **encuentra**: en macOS con Spotlight (`mdfind`), en Linux buscando en tu Projects Root, Escritorio, Descargas y Documentos — verificando nombre y tamaño exactos (o hijos, en carpetas) y aceptando solo coincidencias únicas. Lo que no se puede resolver se sube como copia temporal (con aviso). Si la app de origen sí expone la ruta (VS Code…), se pega directa.

## Reinicio del servicio y actualización automática

- El botón **⟳** del header reinicia el servicio completo (con confirmación): las sesiones se relanzan y el navegador se reconecta solo. Requiere correr con el autostart (launchd/systemd/Task Scheduler) — con `npm start` a mano el servicio quedaría apagado.
- En **⚙ CONFIG** puedes poner un **comando de actualización** que corre en cada arranque/reinicio, en segundo plano (ej. `brew upgrade --cask claude-code` en macOS, `npm update -g @anthropic-ai/claude-code` o el gestor de tu distro en Linux). El resultado llega como aviso al dashboard. Vacío = desactivado.

## Codex como herramienta

Codex CLI funciona igual que Claude como herramienta. En **⚙ CONFIG → Herramientas**:

| Campo | Valor |
|-------|-------|
| Comando | ruta de `codex` (ej. `/opt/homebrew/bin/codex` o `~/.local/bin/codex`) |
| Flag skip permisos | `--dangerously-bypass-approvals-and-sandbox` (o `--approve-for-me` para mantener su sandbox) |
| Flag reanudar | vacío (o `resume`, que abre su picker de sesiones) |
| Flag agregar directorio | `--add-dir` |

El **consumo también funciona con Codex**: al enfocar uno de sus paneles, la barra muta a los límites exactos de tu plan de ChatGPT (5h y semanal, etiquetados "· Codex") leídos de sus rollouts locales, con modelo y contexto por sesión — y vuelve a Anthropic al enfocar un panel de Claude. La lectura por voz de respuestas es Claude-only por ahora.

## Control por voz 🎙

Puedes dictarle prompts a cualquier consola diciendo su nombre, y opcionalmente que la respuesta se te lea en voz alta. Todo el reconocimiento es **local** (whisper.cpp en tu equipo): el audio nunca sale de tu máquina, y funciona en cualquier navegador (Opera GX, Brave, Chrome, Firefox…) porque no depende de las APIs de voz del navegador.

### Requisito: whisper.cpp + modelo

El servidor necesita el binario `whisper-cli` en el PATH y un modelo en `~/.claudemanager/models/ggml-small.bin` (~500 MB, se descarga una sola vez):

- **macOS**: `brew install whisper-cpp`
- **Linux**: `brew install whisper-cpp` (Homebrew en Linux) o compila [whisper.cpp](https://github.com/ggerganov/whisper.cpp) y pon `whisper-cli` en el PATH
- **Windows**: descarga el binario desde los [releases de whisper.cpp](https://github.com/ggerganov/whisper.cpp/releases) y agrega su carpeta al PATH

Modelo (igual en los tres sistemas):

```bash
mkdir -p ~/.claudemanager/models
curl -L -o ~/.claudemanager/models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

> El micrófono en el navegador requiere contexto seguro: funciona en `localhost` sin más. Si accedes al dashboard por IP desde otra máquina, el navegador bloqueará el mic (haría falta HTTPS).

### Dictar a una consola

1. **Nómbrala**: el nombre del proyecto ya sirve, o ponle una nota corta (doble clic junto al nombre del panel) — la nota también funciona como "nombre de voz".
2. **Mantén presionado el botón 🎙** de la barra inferior (o su tecla, default F9) y di: *"oye qstifydesktop, ¿qué falta por hacer?"*.
3. Suelta: whisper transcribe, un aviso muestra a qué consola va y qué entendió, y se envía en 1.5 s (**Esc cancela**). El matching del nombre es tolerante — no importa si whisper escribe "Xtifi Desktop" en vez de "qstifydesktop". Si dos paneles comparten nombre, gana el que corre una IA y luego el de actividad más reciente (aun así, tags únicos = ruteo más fiable).

**Panel activo (conversación continua):** después de cada dictado, ese panel queda "activo" — los siguientes dictados **sin nombre** le llegan directo, mientras sigas hablando con pausas menores a la ventana (5 min por defecto; cada mensaje la renueva). Decir solo el nombre (*"desk"*) también lo selecciona sin mandar nada. Pasada la ventana en silencio, vuelve el "¿a qué consola?". Junto al 🎙 de la barra verás el contador en vivo (`🎯 desk ⟳ 4:32`) de quién recibe los dictados sin nombre y cuánto le queda.

**Clic derecho en 🎙** abre las opciones de voz: cambiar la tecla de push-to-talk, ajustar los minutos de la ventana del panel activo (0 la desactiva), **fijar un micrófono** concreto (o dejar el del sistema; si el fijado no está conectado, cae al default con aviso) y el **filtro de idiomas de las voces** (marca uno o varios; nada marcado = todas — aplica a los selectores de todos los paneles). Todo se guarda por navegador.

**Si el nombre no se reconoce, el dictado no se pierde**: aparece un panel de rescate con el texto transcrito y un botón por cada consola para mandarlo con un clic (o cancelar) — persiste hasta que decidas.

### Voz de respuesta (opcional, por panel)

Cada panel tiene un botón **🔇/🔊** en su barra de título:

- Clic → selector de voz: una **lista plana** con todas las voces disponibles mezcladas (ya filtradas por los idiomas que marcaste en el menú del 🎙), cada una con su etiqueta de origen. O **"Sin voz (yo la leo)"** — el default. Al elegir una suena una demo corta.
- Si el panel tiene voz asignada **y el prompt fue dictado**, la respuesta se lee **conforme Claude la va escribiendo**, bloque a bloque (el código se omite). **Esc detiene la lectura.** Prompts escritos con teclado nunca se leen.
- La lectura sale del transcript real de Claude Code en disco, no de la pantalla — llega completa y limpia.
- La voz elegida se guarda en el servidor y sobrevive reinicios.

**Fuentes de voces** (las tres se mezclan en el selector, cada una con su etiqueta):

| Fuente | Qué es | Requiere |
|--------|--------|----------|
| sistema | Las voces TTS de tu SO vía el navegador | Nada |
| Kokoro | Motor neuronal local (calidad alta) — español e inglés, ~31 voces | Instalación abajo |
| Piper | Motor neuronal local ligero — todo su catálogo es/en (~50 voces) | Instalación abajo |

Los motores neuronales son **opcionales**: sin instalarlos, el selector muestra solo las voces del sistema. Las voces Piper se **descargan solas la primera vez** que las eliges (verás el aviso con el tamaño y el marcador `⬇` en el selector); después quedan en `~/.claudemanager/voices/piper/`. Nada sale de tu equipo.

Notas de rendimiento: la primera vez que un motor se usa paga un arranque en frío (~2-5s cargando el modelo); el servidor **precalienta al arrancar** los motores de las voces que ya tengas asignadas a paneles, así que en el uso diario no lo notas. La lectura incremental sintetiza cada bloque mientras suena el anterior.

Instalación de los motores (macOS/Linux; en Windows cambia las rutas). En Linux necesitas `python3-venv` y `pip` (`sudo apt install python3-venv python3-pip` en Debian/Ubuntu):

```bash
python3 -m venv ~/.claudemanager/tts/venv
~/.claudemanager/tts/venv/bin/pip install kokoro-onnx soundfile piper-tts
# modelo Kokoro (~340MB, una vez)
curl -L -o ~/.claudemanager/tts/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o ~/.claudemanager/tts/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
# índice de voces Piper (para el catálogo y las descargas bajo demanda)
mkdir -p ~/.claudemanager/voices
curl -L -o ~/.claudemanager/voices/piper-index.json https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json
```

### Dictado largo (hasta 5 minutos, sin espera)

Puedes hablar hasta 5 minutos por dictado. Mientras mantienes presionado, los tramos ya hablados se **transcriben en segundo plano** (cortando en tus pausas naturales), así que al soltar solo se procesa la colita final y el texto sale casi al instante — sin importar cuánto hayas hablado.

### Dictar sin tener el foco (atajo global del sistema)

Las páginas web no reciben teclas globales, así que el servidor expone endpoints de disparo y cada quien los conecta al atajo global de su sistema operativo:

```
POST http://localhost:3000/ptt/toggle   # una pulsación abre, otra corta y envía
POST http://localhost:3000/ptt/start    # para herramientas con keydown/keyup
POST http://localhost:3000/ptt/stop
```

El dashboard suena un **bip agudo** al empezar a escuchar y uno **grave** al enviar, para que sepas que te oyó sin mirar la pestaña. Si hay varias pestañas abiertas, solo la más reciente reacciona. La grabación y la lectura en voz alta funcionan con la pestaña en segundo plano.

**macOS — skhd (recomendado):**

```bash
brew install koekeishiya/formulae/skhd
mkdir -p ~/.config/skhd
echo 'f16 : curl -s -X POST localhost:3000/ptt/toggle' >> ~/.config/skhd/skhdrc
skhd --start-service
```

La primera vez macOS pedirá darle permiso de **Accesibilidad** a skhd (Ajustes → Privacidad y seguridad → Accesibilidad); después `skhd --restart-service`. Cambia `f16` por la tecla que quieras.

> ¿Por qué no la app Atajos? Sus atajos de teclado globales son poco confiables — con teclas de función macOS les agrega el modificador 🌐/Fn y a menudo simplemente no disparan. skhd escucha la tecla física directo.

**Windows — AutoHotkey v2** (este sí permite "mantener presionado" de verdad):

```autohotkey
F16::{
    Run('curl -s -X POST localhost:3000/ptt/start', , 'Hide')
    KeyWait('F16')                     ; espera a que sueltes la tecla
    Run('curl -s -X POST localhost:3000/ptt/stop', , 'Hide')
}
```

O la variante toggle con una sola línea: `F16::Run('curl -s -X POST localhost:3000/ptt/toggle', , 'Hide')`.

**Linux** — atajos personalizados del escritorio:

- **GNOME**: Configuración → Teclado → Atajos personalizados → comando: `curl -s -X POST localhost:3000/ptt/toggle`
- **KDE**: Preferencias → Atajos → Agregar orden
- O con [sxhkd](https://github.com/baskerville/sxhkd): `F16` + la misma línea de curl en `~/.config/sxhkd/sxhkdrc`

> Los endpoints no llevan autenticación, igual que el resto del dashboard: cualquiera con acceso al puerto 3000 de tu máquina puede dispararlos. En uso local (localhost) no cambia nada.

## Tokens y consumo

Los tokens solo se consumen cuando la IA procesa texto y genera una respuesta. Ejecutar comandos del sistema **no consume tokens**:

- ✅ `npm run dev`, `git push`, compilaciones, tests → **0 tokens**, son procesos locales
- ✅ Tiempo que esos procesos llevan corriendo → **0 tokens**
- ❌ Texto que le escribes a la IA → consume tokens
- ❌ Respuestas que genera la IA → consumen tokens
- ❌ Archivos que la IA lee para darte contexto → consumen tokens

## Barra de consumo (parte inferior)

Una barra fija en el borde inferior de la página —siempre visible, fuera del scroll del tablero— muestra el **consumo real de tu cuenta**, pensado para monitorear tu uso y no pasarte de los límites. Es **global**: agrega todas tus consolas abiertas y todos los modelos, no es por panel.

Muestra dos límites, leídos directamente de tu cuenta:

- **Sesión** (cyan) — porcentaje usado de tu ventana de 5 horas, con **⟳ se restablece en …** (cuenta regresiva en vivo, baja segundo a segundo).
- **Semanal** (ámbar) — porcentaje usado del límite semanal, con su propio contador de reinicio.

A la derecha, de forma secundaria: el contexto de la **sesión activa** (el panel enfocado), el total de tokens de la sesión, **hace Xs** (cuándo fue la última lectura) y un botón **⟳** para refrescar al instante.

El consumo se **actualiza automáticamente cada 60 segundos** (o al instante con **⟳**), y los contadores de reinicio se animan cada segundo. Al llegar a cero, la barra vuelve a leer sola para mostrar la ventana nueva.

### De dónde sale el dato

El porcentaje real se obtiene de tu cuenta usando las **credenciales locales** que la herramienta CLI ya guarda en tu equipo; el servidor las relee en cada consulta, nunca las almacena ni las registra. Si por algún motivo no puede leerlas (sin conexión o credenciales no disponibles), la barra cae a una **estimación local** calculada desde los registros de uso en disco (marcada con `~`), de modo que nunca se queda sin información.

> El lector de consumo está pensado para ser **extensible por herramienta**: cada CLI define de dónde se lee su uso, así que puede ampliarse a otras herramientas que expongan su consumo.

## Puntos de estado

- 🟢 Verde — sesión activa con output reciente
- 🟡 Amarillo — idle (sin output por más de 5 s)
- 🔴 Rojo — proceso terminado

## Autostart al encender el equipo

Ejecuta esto una sola vez después de configurar el dashboard. El script detecta el sistema operativo automáticamente.

**macOS / Linux:**
```bash
./scripts/autostart.sh install
./scripts/autostart.sh uninstall  # quitar
./scripts/autostart.sh status     # ver estado
```

- **macOS** usa LaunchAgents (`launchctl`)
- **Linux** usa systemd user service (`systemctl --user`)

**Windows** (PowerShell como Administrador):
```powershell
.\scripts\autostart.ps1 install
.\scripts\autostart.ps1 uninstall  # quitar
.\scripts\autostart.ps1 status     # ver estado
```

- Registra una tarea en el **Programador de tareas** de Windows que arranca con el inicio de sesión

En todos los casos, el servidor arranca automáticamente sin abrir ninguna terminal. Solo abre **http://localhost:3000** en el navegador.

## Desarrollo

```bash
npm run dev   # hot-reload: el servidor se reinicia al guardar server.js
              # y el browser recarga solo al guardar index.html
```
