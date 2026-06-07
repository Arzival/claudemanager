#!/bin/bash
# Wrapper de arranque para launchd — encuentra node sin depender del shell de login

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Buscar node en ubicaciones conocidas
for NODE_BIN in \
  "$HOME/Library/Application Support/Herd/config/nvm/versions/node/"*/bin/node \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"; do
  if [ -x "$NODE_BIN" ]; then
    exec "$NODE_BIN" "$PROJECT_DIR/server.js"
  fi
done

echo "[claudemanager] ERROR: no se encontró node" >&2
exit 1
