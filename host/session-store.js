// Session persistence layer for Orellius Browser Bridge.
// Saves/loads session snapshots to ~/.config/orellius-browser-bridge/sessions/

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE_DIR = path.join(os.homedir(), ".config", "orellius-browser-bridge");
const SESSIONS_DIR = path.join(BASE_DIR, "sessions");
const DEFAULT_MAX_AGE_DAYS = 7;

// Ensure storage directory exists with secure permissions
function ensureDir() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

/**
 * Get config from ~/.config/orellius-browser-bridge/config.json
 */
function getConfig() {
  const configPath = path.join(BASE_DIR, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {}; // Default empty config
  }
}

/**
 * Save session snapshot to disk.
 * @param {string} sessionId - Unique session identifier
 * @param {object} state - Session state object
 * @returns {boolean} Success
 */
export function saveSnapshot(sessionId, state) {
  const config = getConfig();
  if (config.session?.enablePersistence === false) {
    return false; // Persistence disabled
  }

  ensureDir();
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  
  const snapshot = {
    sessionId,
    created: state.created || Date.now(),
    lastSnapshot: Date.now(),
    ...state,
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), {
      mode: 0o600, // Owner-only read/write
    });
    return true;
  } catch (err) {
    console.error(`[session-store] Failed to save snapshot for ${sessionId}:`, err.message);
    return false;
  }
}

/**
 * Load session snapshot from disk.
 * @param {string} sessionId - Session ID to restore
 * @returns {object|null} Session state or null if not found
 */
export function loadSnapshot(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[session-store] Failed to load snapshot for ${sessionId}:`, err.message);
    }
    return null;
  }
}

/**
 * List all saved sessions, sorted by lastSnapshot (newest first).
 * @returns {Array<object>} Array of session summaries
 */
export function listSessions() {
  ensureDir();
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    const sessions = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const filePath = path.join(SESSIONS_DIR, f);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const data = JSON.parse(raw);
          return {
            sessionId: data.sessionId,
            created: data.created,
            lastSnapshot: data.lastSnapshot,
            tabCount: data.tabs?.length || 0,
            note: data.context?.workingOn || null,
            file: filePath,
          };
        } catch {
          return null; // Skip corrupted files
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.lastSnapshot - a.lastSnapshot); // Newest first

    return sessions;
  } catch (err) {
    console.error("[session-store] Failed to list sessions:", err.message);
    return [];
  }
}

/**
 * Delete session snapshot file.
 * @param {string} sessionId - Session to delete
 * @returns {boolean} Success
 */
export function deleteSnapshot(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[session-store] Failed to delete snapshot for ${sessionId}:`, err.message);
    }
    return false;
  }
}

/**
 * Prune old session snapshots.
 * @param {number} maxAgeDays - Delete sessions older than this (default: 7)
 * @returns {number} Number of deleted files
 */
export function pruneOldSessions(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const config = getConfig();
  const effectiveMaxAge = config.session?.maxAgeDays || maxAgeDays;
  const cutoff = Date.now() - effectiveMaxAge * 24 * 60 * 60 * 1000;

  const sessions = listSessions();
  let deleted = 0;

  for (const session of sessions) {
    if (session.lastSnapshot < cutoff) {
      if (deleteSnapshot(session.sessionId)) {
        deleted++;
      }
    }
  }

  console.log(`[session-store] Pruned ${deleted} old sessions (older than ${effectiveMaxAge} days)`);
  return deleted;
}

/**
 * Check if a session snapshot exists.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function hasSnapshot(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  return fs.existsSync(filePath);
}

/**
 * Get human-readable time ago string.
 * @param {number} timestamp - Unix timestamp in ms
 * @returns {string}
 */
export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Auto-prune on module load (non-blocking)
setTimeout(() => {
  try {
    pruneOldSessions();
  } catch (err) {
    console.error("[session-store] Auto-prune failed:", err.message);
  }
}, 5000); // Wait 5s after startup
