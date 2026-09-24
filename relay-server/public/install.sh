#!/bin/bash
# CLI-to-Web Agent Installer
# Usage: curl -sSL https://webssh.albiontools.fun/install.sh | bash -s -- <TOKEN>
# ─────────────────────────────────────────────────────────────────────

set -e

RELAY_URL="wss://webssh.albiontools.fun/ws/agent"
INSTALL_DIR="$HOME/cliweb-agent"
SERVICE_NAME="cliweb-agent"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Check token argument ─────────────────────────────────────────────
TOKEN="$1"
if [ -z "$TOKEN" ]; then
  error "Usage: curl -sSL https://webssh.albiontools.fun/install.sh | bash -s -- <TOKEN>"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     CLI-to-Web Agent Installer       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Check dependencies ───────────────────────────────────────────────
info "Memeriksa dependencies..."

# Node.js
if ! command -v node &>/dev/null; then
  info "Node.js tidak ditemukan, menginstall..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - &>/dev/null
    sudo apt-get install -y nodejs &>/dev/null
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - &>/dev/null
    sudo yum install -y nodejs &>/dev/null
  else
    error "Tidak bisa install Node.js otomatis. Install manual dulu: https://nodejs.org"
  fi
fi

NODE_VER=$(node --version)
success "Node.js $NODE_VER"

# npm
if ! command -v npm &>/dev/null; then
  error "npm tidak ditemukan. Install Node.js yang include npm."
fi

# ── Create install directory ─────────────────────────────────────────
info "Membuat direktori $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

# ── Write package.json ───────────────────────────────────────────────
cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "name": "cliweb-agent",
  "version": "1.0.0",
  "description": "CLI-to-Web Agent",
  "main": "agent.js",
  "type": "commonjs",
  "dependencies": {
    "ws": "^8.18.0",
    "node-pty": "^1.0.0"
  }
}
PKGJSON

# ── Write agent.js ───────────────────────────────────────────────────
cat > "$INSTALL_DIR/agent.js" << 'AGENTJS'
/*
 * CLI-to-Web Agent
 * Connects outbound to relay, spawns local PTY shells on demand.
 */

const WebSocket = require('ws');
const pty       = require('node-pty');
const os        = require('os');
const fs        = require('fs');
const path      = require('path');

// Load .env
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}

const RELAY_URL   = process.env.RELAY_URL   || 'wss://webssh.albiontools.fun/ws/agent';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const SHELL       = process.env.SHELL       || '/bin/bash';

if (!AGENT_TOKEN) { console.error('[AGENT] AGENT_TOKEN not set'); process.exit(1); }

const shells = new Map(); // sessionId -> pty process
let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

function connect() {
  const url = `${RELAY_URL}?token=${encodeURIComponent(AGENT_TOKEN)}`;
  console.log(`[AGENT] Connecting to ${RELAY_URL.replace(/token=[^&]+/, 'token=...')}...`);

  ws = new WebSocket(url, { handshakeTimeout: 15000 });

  ws.on('open', () => {
    console.log('[AGENT] Connected to relay');
    reconnectDelay = 1000;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'spawn':   spawnShell(msg.sessionId); break;
        case 'input':   writeInput(msg.sessionId, msg.data); break;
        case 'resize':  resizeShell(msg.sessionId, msg.cols, msg.rows); break;
        case 'kill':    killShell(msg.sessionId); break;
      }
    } catch (e) { console.error('[AGENT] Bad message:', e.message); }
  });

  ws.on('close', (code, reason) => {
    console.log(`[AGENT] Disconnected (${code}). Reconnecting in ${reconnectDelay}ms...`);
    // Kill all shells
    for (const [sid, shell] of shells) { try { shell.kill(); } catch {} }
    shells.clear();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err) => console.error('[AGENT] WS error:', err.message));

  // Heartbeat pong
  ws.on('ping', () => { try { ws.pong(); } catch {} });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function spawnShell(sessionId) {
  if (shells.has(sessionId)) return;
  console.log(`[AGENT] Spawning shell for session ${sessionId}`);

  const shell = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 80, rows: 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  shell.onData(data => send({ sessionId, type: 'output', data }));

  shell.onExit(() => {
    console.log(`[AGENT] Shell exited: ${sessionId}`);
    shells.delete(sessionId);
    send({ sessionId, type: 'exit' });
  });

  shells.set(sessionId, shell);
}

function writeInput(sessionId, data) {
  const shell = shells.get(sessionId);
  if (shell) shell.write(data);
}

function resizeShell(sessionId, cols, rows) {
  const shell = shells.get(sessionId);
  if (shell && cols > 0 && rows > 0) shell.resize(cols, rows);
}

function killShell(sessionId) {
  const shell = shells.get(sessionId);
  if (shell) { try { shell.kill(); } catch {} shells.delete(sessionId); }
}

connect();
AGENTJS

# ── Write .env ───────────────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" << ENVFILE
RELAY_URL=${RELAY_URL}
AGENT_TOKEN=${TOKEN}
ENVFILE

chmod 600 "$INSTALL_DIR/.env"
success ".env ditulis"

# ── Install npm dependencies ─────────────────────────────────────────
info "Menginstall npm dependencies (ws, node-pty)..."
cd "$INSTALL_DIR"

# node-pty butuh build tools
if command -v apt-get &>/dev/null; then
  if ! dpkg -l python3 make g++ 2>/dev/null | grep -q "^ii" ; then
    warn "Menginstall build tools (python3, make, g++)..."
    sudo apt-get install -y python3 make g++ &>/dev/null || true
  fi
fi

npm install --silent 2>/dev/null
success "Dependencies terinstall"

# ── Setup systemd service (jika tersedia) ────────────────────────────
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null 2>&1 || [ -d /run/systemd/system ]; then
  info "Membuat systemd service..."

  # Detect current user
  CURRENT_USER=$(whoami)
  NODE_BIN=$(which node)

  sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << SVCFILE
[Unit]
Description=CLI-to-Web Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CURRENT_USER}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent.js
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCFILE

  sudo systemctl daemon-reload
  sudo systemctl enable --now ${SERVICE_NAME}.service

  sleep 2
  if systemctl is-active --quiet ${SERVICE_NAME}.service; then
    success "Service '${SERVICE_NAME}' berjalan!"
  else
    warn "Service gagal start. Cek: journalctl -u ${SERVICE_NAME} -n 20"
  fi

else
  warn "systemd tidak tersedia. Jalankan agent manual:"
  echo ""
  echo "  cd $INSTALL_DIR && node agent.js"
  echo ""
fi

# ── Done ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Instalasi selesai!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "  📁 Install dir : ${CYAN}$INSTALL_DIR${NC}"
echo -e "  🔗 Relay       : ${CYAN}$RELAY_URL${NC}"
echo -e "  🤖 Agent ID    : ${CYAN}$(echo $TOKEN | cut -d: -f1)${NC}"
echo ""
echo -e "  Cek status : ${YELLOW}systemctl status $SERVICE_NAME${NC}"
echo -e "  Lihat log  : ${YELLOW}journalctl -u $SERVICE_NAME -f${NC}"
echo ""
