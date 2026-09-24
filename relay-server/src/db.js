/*
 * Database — SQLite via better-sqlite3
 * Tables:
 *   users  — OAuth users
 *   agents — registered agent tokens per user
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'cliweb.db'));

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT NOT NULL,          -- 'google' | 'github'
    provider_id TEXT NOT NULL,          -- ID from provider
    email       TEXT,
    name        TEXT,
    avatar      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_id)
  );

  CREATE TABLE IF NOT EXISTS agent_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id   TEXT NOT NULL UNIQUE,   -- e.g. "stb-rumah-a497780d"
    name       TEXT NOT NULL,          -- friendly name set by user
    token_hash TEXT NOT NULL,          -- sha256 of the full token
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── User queries ─────────────────────────────────────────────────────

function upsertUser({ provider, providerId, email, name, avatar }) {
  const existing = db.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
  ).get(provider, providerId);

  if (existing) {
    db.prepare(
      'UPDATE users SET email=?, name=?, avatar=? WHERE id=?'
    ).run(email, name, avatar, existing.id);
    return { ...existing, email, name, avatar };
  }

  const result = db.prepare(
    'INSERT INTO users (provider, provider_id, email, name, avatar) VALUES (?,?,?,?,?)'
  ).run(provider, providerId, email, name, avatar);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ── Agent token queries ───────────────────────────────────────────────

function getAgentsByUser(userId) {
  return db.prepare(
    'SELECT id, agent_id, name, created_at FROM agent_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

function getAgentToken(agentId) {
  return db.prepare('SELECT * FROM agent_tokens WHERE agent_id = ?').get(agentId);
}

function createAgentToken({ userId, agentId, name, tokenHash }) {
  db.prepare(
    'INSERT INTO agent_tokens (user_id, agent_id, name, token_hash) VALUES (?,?,?,?)'
  ).run(userId, agentId, name, tokenHash);
}

function deleteAgentToken(agentId, userId) {
  db.prepare(
    'DELETE FROM agent_tokens WHERE agent_id = ? AND user_id = ?'
  ).run(agentId, userId);
}

function deleteAgentTokenById(agentId) {
  db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
}

function listAllAgents() {
  return db.prepare('SELECT agent_id, name, created_at FROM agent_tokens ORDER BY created_at DESC').all();
}

// Ensure user_id=1 exists for single-user mode
function ensureDefaultUser() {
  const row = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!row) {
    db.prepare("INSERT INTO users (id, provider, provider_id, name) VALUES (1, 'local', 'admin', 'Admin')").run();
  }
}
ensureDefaultUser();

module.exports = {
  upsertUser, getUserById,
  getAgentsByUser, getAgentToken, createAgentToken, deleteAgentToken,
  deleteAgentTokenById, listAllAgents,
};
