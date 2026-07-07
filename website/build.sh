#!/usr/bin/env bash
# Assembles the muchu.app static package into public/:
#   /            marketing site
#   /login/      wallet launcher (talks to https://web.muchu.app APIs)
#   /play/       minecraft-web-client dist (downloaded, not committed)
# Runs on Vercel (buildCommand) and locally for testing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CLIENT_VERSION="v2.0.1"
GAME_HOST="https://web.muchu.app"

rm -rf public
mkdir -p public
cp index.html styles.css site.js public/
cp -r assets public/assets
cp -r login public/login

echo "[build] fetching minecraft-web-client ${CLIENT_VERSION} self-host bundle..."
curl -fsSL -o /tmp/mwc-self-host.zip \
  "https://github.com/zardoy/minecraft-web-client/releases/download/${CLIENT_VERSION}/self-host.zip"
unzip -oq /tmp/mwc-self-host.zip -d /tmp/mwc-bundle
mv /tmp/mwc-bundle/dist public/play
rm -rf /tmp/mwc-bundle /tmp/mwc-self-host.zip

# MuchuCraft pointer-lock guard (fixes upstream #562).
node ../scripts/patch-client-dist.mjs public/play

# Point the client at the game host's proxy and pin the promoted server.
node - "$GAME_HOST" <<'EOF'
const fs = require('fs');
const gameHost = process.argv[2];
const p = 'public/play/config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
Object.assign(cfg, {
  defaultProxy: gameHost,
  allowAutoConnect: true,
  defaultHost: 'web.muchu.app:25565',
  promoteServers: [{
    ip: 'web.muchu.app:25565',
    name: 'MuchuCraft',
    description: 'Wallet-verified survival — muchucraft',
    version: '1.21.4',
  }],
  pauseLinks: [[
    { type: 'url', url: 'https://github.com/MuchuCraft/MuchuCraft', text: 'GitHub' },
    { type: 'url', url: 'https://x.com/muchucraft', text: 'X @muchucraft' },
  ]],
  rightSideText: 'MuchuCraft — wallet-verified survival',
});
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('[build] play config patched: proxy=' + gameHost);
EOF

echo "[build] done: $(du -sh public | cut -f1) in public/"
