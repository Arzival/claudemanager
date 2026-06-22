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

Abre **http://localhost:3000** — la primera vez aparece un modal de configuración. No hay que editar ningún archivo manualmente.

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

## Tokens y consumo

Los tokens solo se consumen cuando la IA procesa texto y genera una respuesta. Ejecutar comandos del sistema **no consume tokens**:

- ✅ `npm run dev`, `git push`, compilaciones, tests → **0 tokens**, son procesos locales
- ✅ Tiempo que esos procesos llevan corriendo → **0 tokens**
- ❌ Texto que le escribes a la IA → consume tokens
- ❌ Respuestas que genera la IA → consumen tokens
- ❌ Archivos que la IA lee para darte contexto → consumen tokens

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
