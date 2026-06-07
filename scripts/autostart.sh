#!/bin/bash
# Usage: ./scripts/autostart.sh [install|uninstall|status]
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
LOG_DIR="$PROJECT_DIR/logs"
OS="$(uname -s)"

# ── macOS ─────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  LABEL="com.claudemanager.server"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

  case "${1:-install}" in
    install)
      mkdir -p "$LOG_DIR"
      cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/server.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
PLIST_EOF

      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"

      echo ""
      echo "✓ ClaudeManager registrado como servicio de inicio (macOS LaunchAgent)"
      echo "  Proyecto : $PROJECT_DIR"
      echo "  Node     : $NODE_BIN"
      echo "  Logs     : $LOG_DIR"
      echo "  Plist    : $PLIST"
      echo ""
      echo "  El servidor arrancará automáticamente en cada inicio de sesión."
      echo "  Para ver logs en vivo: tail -f $LOG_DIR/server.log"
      ;;

    uninstall)
      if [ -f "$PLIST" ]; then
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        echo "✓ Autostart eliminado"
      else
        echo "No hay ningún autostart instalado"
      fi
      ;;

    status)
      if launchctl list | grep -q "$LABEL"; then
        echo "● ClaudeManager está registrado en launchd"
        launchctl list | grep "$LABEL"
      else
        echo "○ ClaudeManager NO está registrado"
      fi
      ;;

    *)
      echo "Uso: $0 [install|uninstall|status]"
      exit 1
      ;;
  esac

# ── Linux ─────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/claudemanager.service"

  case "${1:-install}" in
    install)
      mkdir -p "$SERVICE_DIR" "$LOG_DIR"
      cat > "$SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=ClaudeManager Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/error.log

[Install]
WantedBy=default.target
SERVICE_EOF

      systemctl --user daemon-reload
      systemctl --user enable claudemanager
      systemctl --user start claudemanager
      loginctl enable-linger "$(whoami)" 2>/dev/null || true

      echo ""
      echo "✓ ClaudeManager registrado como servicio de inicio (systemd user)"
      echo "  Proyecto : $PROJECT_DIR"
      echo "  Node     : $NODE_BIN"
      echo "  Logs     : $LOG_DIR"
      echo "  Service  : $SERVICE_FILE"
      echo ""
      echo "  El servidor arrancará automáticamente en cada inicio de sesión."
      echo "  Para ver logs en vivo: tail -f $LOG_DIR/server.log"
      echo "  O con systemd:         journalctl --user -u claudemanager -f"
      ;;

    uninstall)
      systemctl --user stop claudemanager 2>/dev/null || true
      systemctl --user disable claudemanager 2>/dev/null || true
      rm -f "$SERVICE_FILE"
      systemctl --user daemon-reload
      echo "✓ Autostart eliminado"
      ;;

    status)
      systemctl --user status claudemanager 2>/dev/null || echo "○ ClaudeManager NO está registrado"
      ;;

    *)
      echo "Uso: $0 [install|uninstall|status]"
      exit 1
      ;;
  esac

else
  echo "Sistema operativo no soportado por este script: $OS"
  echo "En Windows usa: scripts\\autostart.ps1"
  exit 1
fi
