#!/usr/bin/env bash
# MuchuCraft — start the Paper server and the gateway, wait until both are ready.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .pids logs

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a
PORT="${PORT:-8090}"; MC_PORT="${MC_PORT:-25565}"

if [ ! -f server/paper.jar ]; then
  echo "[start-all] server not set up yet — running server/setup.sh"
  bash server/setup.sh
fi
if [ ! -d client/dist ]; then
  echo "[start-all] web client not downloaded yet — running client/setup.sh"
  bash client/setup.sh
fi

# --- Paper server ---
if port_open "$MC_PORT"; then
  echo "[start-all] Minecraft server already listening on :$MC_PORT"
else
  echo "[start-all] starting Paper server..."
  (cd server && nohup bash start.sh > logs-run.out 2>&1 & echo $! > "$ROOT/.pids/paper.pid")
  for i in $(seq 1 90); do
    port_open "$MC_PORT" && break
    if ! kill -0 "$(cat "$ROOT/.pids/paper.pid")" 2>/dev/null; then
      echo "[start-all] Paper died during startup — tail of server/logs-run.out:"; tail -20 server/logs-run.out; exit 1
    fi
    sleep 2
  done
  port_open "$MC_PORT" || { echo "[start-all] Paper did not open :$MC_PORT in time"; exit 1; }
  echo "[start-all] Paper is up on 127.0.0.1:$MC_PORT"
fi

# --- Gateway ---
if port_open "$PORT"; then
  echo "[start-all] something already listening on :$PORT — assuming gateway is up"
else
  echo "[start-all] starting gateway..."
  (cd gateway && nohup node src/index.js > "$ROOT/logs/gateway.log" 2>&1 & echo $! > "$ROOT/.pids/gateway.pid")
  for i in $(seq 1 30); do
    port_open "$PORT" && break
    if ! kill -0 "$(cat "$ROOT/.pids/gateway.pid")" 2>/dev/null; then
      echo "[start-all] gateway died during startup — tail of logs/gateway.log:"; tail -20 logs/gateway.log; exit 1
    fi
    sleep 1
  done
  port_open "$PORT" || { echo "[start-all] gateway did not open :$PORT in time"; exit 1; }
fi

HEALTH="$(curl -sf "http://127.0.0.1:$PORT/healthz" || true)"
echo "[start-all] healthz: ${HEALTH:-<no response>}"
echo
echo "  MuchuCraft is up:  http://localhost:$PORT/login/"
echo "  (connect a Solana wallet, claim your username, and play)"
