/*
 * CLI-to-Web Relay Server
 * -----------------------
 * Bridges browser WebSocket connections to agent WebSocket connections.
 *
 * Endpoints:
 *   WS  /ws/agent?token=<TOKEN>        — agent connects here
 *   WS  /ws/terminal?agentId=<ID>      — browser connects here (needs login cookie)
 *   GET /                              — Web UI (serves public/index.html)
 *   POST /api/login                    — authenticate, returns session token
 *   GET /api/agents                    — list online agents (needs auth)
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const bcrypt = require('bcryptjs');

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3100;
const RELAY_SECRET = process.env.RELAY_SECRET || 'change-me';
const WEB_USER = process.env.WEB_USER || 'admin';
const WEB_PASS_HASH = process.env.WEB_PASS_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ── State ───────────────────────────────────────────────────────────
// agents: Map<agentId, { ws, name, connectedAt, terminalSessions: Map<sessionId, browserWs> }>
const agents = new Map();
// sessions: Map<sessionToken, { user, expiresAt }>
const sessions = new Map();

// Rate limiting for login: Map<ip, { count, resetAt }>
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 60_000;   // 1 minute
const RATE_LIMIT_MAX = 5;           // max attempts per window

// ── Helpers ─────────────────────────────────────────────────────────

/** Verify agent token: token = agentId:hmac(agentId, RELAY_SECRET) */
function verifyAgentToken(token) {
  const parts = token.split(':');
  if (parts.length !== 2) return null;
  const [agentId, sig] = parts;
  const expected = crypto.createHmac('sha256', RELAY_SECRET).update(agentId).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return agentId;
}

/** Generate a new agent token */
function generateAgentToken(agentId) {
  const sig = crypto.createHmac('sha256', RELAY_SECRET).update(agentId).digest('hex');
  return `${agentId}:${sig}`;
}

/** Create a login session token */
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }); // 24h
  return token;
}

/** Validate session token from cookie */
function validateSession(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([a-f0-9]{64})/);
  if (!match) return null;
  const sess = sessions.get(match[1]);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) { sessions.delete(match[1]); return null; }
  return sess;
}

/** Check rate limit for IP */
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

/** Read request body as string */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Serve static file */
function serveFile(res, filePath, contentType) {
  const absPath = path.join(__dirname, '..', 'public', filePath);
  fs.readFile(absPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

/** Get client IP (trust X-Forwarded-For from reverse proxy) */
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

// ── HTTP Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers (same-origin in prod, permissive for dev)
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── POST /api/login ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const { username, password } = body;
      if (username !== WEB_USER || !WEB_PASS_HASH || !(await bcrypt.compare(password, WEB_PASS_HASH))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
        return;
      }
      const token = createSession(username);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
    }
    return;
  }

  // ── POST /api/logout ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /api/agents ───────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    if (!validateSession(req.headers.cookie)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const list = [];
    for (const [id, agent] of agents) {
      list.push({
        id,
        name: agent.name,
        connectedAt: agent.connectedAt,
        activeSessions: agent.terminalSessions.size
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: list }));
    return;
  }

  // ── GET /api/generate-token?name=<name> ───────────────────────
  // Utility: generate a new agent token (admin only)
  if (req.method === 'GET' && url.pathname === '/api/generate-token') {
    if (!validateSession(req.headers.cookie)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const name = url.searchParams.get('name') || 'agent';
    const agentId = `${name}-${crypto.randomBytes(4).toString('hex')}`;
    const token = generateAgentToken(agentId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agentId, token }));
    return;
  }

  // ── Static files (Web UI) ────────────────────────────────────
  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      serveFile(res, 'index.html', 'text/html');
    } else {
      // Try serving from public/
      const ext = path.extname(url.pathname);
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
      serveFile(res, url.pathname, types[ext] || 'application/octet-stream');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket Server ────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Agent connection: /ws/agent?token=<TOKEN> ─────────────────
  if (url.pathname === '/ws/agent') {
    const token = url.searchParams.get('token');
    if (!token) { socket.destroy(); return; }
    const agentId = verifyAgentToken(token);
    if (!agentId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAgentConnection(ws, agentId);
    });
    return;
  }

  // ── Browser terminal: /ws/terminal?agentId=<ID> ───────────────
  if (url.pathname === '/ws/terminal') {
    if (!validateSession(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const agentId = url.searchParams.get('agentId');
    if (!agentId || !agents.has(agentId)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleBrowserConnection(ws, agentId);
    });
    return;
  }

  socket.destroy();
});

// ── Agent WebSocket Handler ─────────────────────────────────────────
function handleAgentConnection(ws, agentId) {
  // Extract name from agentId (format: name-hexhexhex)
  const name = agentId.replace(/-[a-f0-9]{8}$/, '');

  console.log(`[AGENT] Connected: ${agentId} (${name})`);

  const agent = {
    ws,
    name,
    agentId,
    connectedAt: new Date().toISOString(),
    terminalSessions: new Map()
  };
  agents.set(agentId, agent);

  ws.on('message', (data) => {
    // Agent sends: { sessionId, type: 'output'|'exit', data: '...' }
    try {
      const msg = JSON.parse(data);
      const browserWs = agent.terminalSessions.get(msg.sessionId);
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify(msg));
      }
    } catch (e) {
      console.error(`[AGENT] Bad message from ${agentId}:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[AGENT] Disconnected: ${agentId}`);
    // Close all browser sessions tied to this agent
    for (const [sid, browserWs] of agent.terminalSessions) {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: 'agent-disconnected' }));
        browserWs.close();
      }
    }
    agents.delete(agentId);
  });

  ws.on('error', (err) => {
    console.error(`[AGENT] Error from ${agentId}:`, err.message);
  });

  // Send heartbeat every 30s
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeat);
    }
  }, 30_000);

  ws.on('close', () => clearInterval(heartbeat));
}

// ── Browser WebSocket Handler ───────────────────────────────────────
function handleBrowserConnection(ws, agentId) {
  const agent = agents.get(agentId);
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
    ws.close(4004, 'Agent not available');
    return;
  }

  const sessionId = crypto.randomBytes(8).toString('hex');
  console.log(`[BROWSER] New terminal session ${sessionId} -> agent ${agentId}`);

  // Register this browser session with the agent
  agent.terminalSessions.set(sessionId, ws);

  // Tell agent to spawn a shell for this session
  agent.ws.send(JSON.stringify({
    type: 'spawn',
    sessionId
  }));

  ws.on('message', (data) => {
    // Browser sends keystrokes → forward to agent
    if (agent.ws.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.parse(data);
        agent.ws.send(JSON.stringify({
          sessionId,
          type: msg.type,   // 'input' or 'resize'
          data: msg.data,
          cols: msg.cols,
          rows: msg.rows
        }));
      } catch {
        // Raw text fallback
        agent.ws.send(JSON.stringify({
          sessionId,
          type: 'input',
          data: data.toString()
        }));
      }
    }
  });

  ws.on('close', () => {
    console.log(`[BROWSER] Session ${sessionId} closed`);
    agent.terminalSessions.delete(sessionId);
    // Tell agent to kill the shell
    if (agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(JSON.stringify({
        type: 'kill',
        sessionId
      }));
    }
  });

  ws.on('error', (err) => {
    console.error(`[BROWSER] Error in session ${sessionId}:`, err.message);
  });
}

// ── Cleanup expired sessions every 5 minutes ────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (now > sess.expiresAt) sessions.delete(token);
  }
}, 5 * 60_000);

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[RELAY] CLI-to-Web Relay Server running on port ${PORT}`);
  console.log(`[RELAY] Web UI: http://localhost:${PORT}`);

  // If no password hash is set, generate one for "admin"
  if (!WEB_PASS_HASH || WEB_PASS_HASH.includes('XXXX')) {
    console.warn('[RELAY] ⚠ WEB_PASS_HASH not set! Generate one with:');
    console.warn('  node -e "require(\'bcryptjs\').hash(\'yourpassword\',10).then(h=>console.log(h))"');
  }
});
