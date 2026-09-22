/*
 * CLI-to-Web Agent
 * ----------------
 * Runs on the home server / STB. Connects OUTBOUND to the relay server,
 * spawns local PTY shells on demand, and pipes I/O back through the relay.
 *
 * Environment:
 *   RELAY_URL    — wss://your-relay/ws/agent
 *   AGENT_TOKEN  — agentId:hmac token from relay
 *   SHELL        — shell to spawn (default /bin/bash)
 */

const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');

// ── Load .env if present ────────────────────────────────────────────
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch {}

// ── Config ──────────────────────────────────────────────────────────
const RELAY_URL = process.env.RELAY_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const SHELL = process.env.SHELL || '/bin/bash';

if (!RELAY_URL || !AGENT_TOKEN) {
  console.error('[AGENT] ERROR: RELAY_URL and AGENT_TOKEN must be set');
  console.error('  Copy .env.example to .env and fill in the values');
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────
// Active PTY sessions: Map<sessionId, ptyProcess>
const sessions = new Map();

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;  // start at 1s, exponential backoff to 30s

// ── Connect to relay ────────────────────────────────────────────────
function connect() {
  const url = `${RELAY_URL}?token=${encodeURIComponent(AGENT_TOKEN)}`;
  console.log(`[AGENT] Connecting to relay: ${RELAY_URL.replace(/\?.*/, '')} ...`);

  ws = new WebSocket(url, {
    headers: { 'User-Agent': 'cliweb-agent/1.0' }
  });

  ws.on('open', () => {
    console.log('[AGENT] ✓ Connected to relay server');
    reconnectDelay = 1000;  // reset backoff
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(msg);
    } catch (e) {
      console.error('[AGENT] Bad message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[AGENT] Disconnected (code=${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    cleanupAllSessions();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[AGENT] WebSocket error: ${err.message}`);
    // 'close' event will fire after this
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

// ── Message handler ─────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'spawn':
      spawnShell(msg.sessionId);
      break;
    case 'input':
      writeToSession(msg.sessionId, msg.data);
      break;
    case 'resize':
      resizeSession(msg.sessionId, msg.cols, msg.rows);
      break;
    case 'kill':
      killSession(msg.sessionId);
      break;
    default:
      console.log(`[AGENT] Unknown message type: ${msg.type}`);
  }
}

// ── PTY management ──────────────────────────────────────────────────
function spawnShell(sessionId) {
  if (sessions.has(sessionId)) {
    console.warn(`[AGENT] Session ${sessionId} already exists`);
    return;
  }

  console.log(`[AGENT] Spawning shell for session ${sessionId}`);

  try {
    const shell = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    sessions.set(sessionId, shell);

    shell.onData((data) => {
      sendToRelay({
        sessionId,
        type: 'output',
        data
      });
    });

    shell.onExit(({ exitCode, signal }) => {
      console.log(`[AGENT] Shell exited (session=${sessionId}, code=${exitCode}, signal=${signal})`);
      sessions.delete(sessionId);
      sendToRelay({
        sessionId,
        type: 'exit',
        exitCode,
        signal
      });
    });

  } catch (err) {
    console.error(`[AGENT] Failed to spawn shell: ${err.message}`);
    sendToRelay({
      sessionId,
      type: 'exit',
      exitCode: 1,
      error: err.message
    });
  }
}

function writeToSession(sessionId, data) {
  const shell = sessions.get(sessionId);
  if (shell) shell.write(data);
}

function resizeSession(sessionId, cols, rows) {
  const shell = sessions.get(sessionId);
  if (shell && cols > 0 && rows > 0) {
    try { shell.resize(cols, rows); } catch {}
  }
}

function killSession(sessionId) {
  const shell = sessions.get(sessionId);
  if (shell) {
    console.log(`[AGENT] Killing session ${sessionId}`);
    shell.kill();
    sessions.delete(sessionId);
  }
}

function cleanupAllSessions() {
  for (const [id, shell] of sessions) {
    try { shell.kill(); } catch {}
  }
  sessions.clear();
}

function sendToRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[AGENT] ${signal} received, shutting down...`);
  cleanupAllSessions();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ───────────────────────────────────────────────────────────
console.log('[AGENT] CLI-to-Web Agent starting...');
console.log(`[AGENT] Shell: ${SHELL}`);
connect();
