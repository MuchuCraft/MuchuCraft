#!/usr/bin/env bash
# MuchuCraft — stop the gateway and gracefully stop the Paper server.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a; source "$ROOT/.env" 2>/dev/null; set +a

# --- Gateway ---
if [ -f .pids/gateway.pid ] && kill -0 "$(cat .pids/gateway.pid)" 2>/dev/null; then
  kill "$(cat .pids/gateway.pid)" && echo "[stop-all] gateway stopped"
fi
rm -f .pids/gateway.pid

# --- Paper: graceful stop via RCON, fallback SIGTERM ---
if [ -f .pids/paper.pid ] && kill -0 "$(cat .pids/paper.pid)" 2>/dev/null; then
  PAPER_PID="$(cat .pids/paper.pid)"
  echo "[stop-all] sending 'stop' via RCON..."
  (cd gateway && node --input-type=module -e "
    import { Rcon } from 'rcon-client';
    const r = await Rcon.connect({ host: '127.0.0.1', port: process.env.RCON_PORT || 25575, password: process.env.RCON_PASSWORD });
    await r.send('stop'); await r.end();
  " 2>/dev/null) || kill "$PAPER_PID" 2>/dev/null
  for i in $(seq 1 60); do kill -0 "$PAPER_PID" 2>/dev/null || break; sleep 1; done
  if kill -0 "$PAPER_PID" 2>/dev/null; then
    echo "[stop-all] Paper still running after 60s — SIGTERM"
    kill "$PAPER_PID" 2>/dev/null; sleep 5
  fi
  echo "[stop-all] Paper stopped"
fi
rm -f .pids/paper.pid
echo "[stop-all] done"
