// ============================================
// Database — SQLite persistence for player stats
// Uses better-sqlite3 with WAL mode for performance
// ============================================

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_DIR = join(__dirname, 'data');
const DB_PATH = join(DB_DIR, 'blocket.db');

let db = null;

// Prepared statements (cached after init)
let stmts = {};

function getDB() {
  if (db) return db;

  // Ensure data directory exists
  try {
    mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.error('Failed to create database directory:', err.message);
      return null;
    }
  }

  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    _initSchema();
    _prepareStatements();
    console.log('Database initialized at', DB_PATH);
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    db = null;
    return null;
  }

  return db;
}

function _initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS match_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL DEFAULT (datetime('now')),
      mode TEXT NOT NULL DEFAULT '1v1',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      blue_score INTEGER NOT NULL DEFAULT 0,
      orange_score INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS match_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team TEXT NOT NULL,
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      shots INTEGER NOT NULL DEFAULT 0,
      demos INTEGER NOT NULL DEFAULT 0,
      mvp INTEGER NOT NULL DEFAULT 0,
      won INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (match_id) REFERENCES match_history(match_id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS player_stats (
      player_id TEXT PRIMARY KEY,
      total_wins INTEGER NOT NULL DEFAULT 0,
      total_losses INTEGER NOT NULL DEFAULT 0,
      total_goals INTEGER NOT NULL DEFAULT 0,
      total_assists INTEGER NOT NULL DEFAULT 0,
      total_saves INTEGER NOT NULL DEFAULT 0,
      total_shots INTEGER NOT NULL DEFAULT 0,
      total_demos INTEGER NOT NULL DEFAULT 0,
      total_mvps INTEGER NOT NULL DEFAULT 0,
      mmr INTEGER NOT NULL DEFAULT 1000,
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players(player_id);
    CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
    CREATE INDEX IF NOT EXISTS idx_match_history_date ON match_history(date);
    CREATE INDEX IF NOT EXISTS idx_player_stats_mmr ON player_stats(mmr DESC);
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
  `);
}

function _prepareStatements() {
  stmts = {
    getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
    insertPlayer: db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)'),
    updateLastSeen: db.prepare("UPDATE players SET last_seen = datetime('now'), display_name = ? WHERE id = ?"),

    insertMatch: db.prepare(
      'INSERT INTO match_history (match_id, mode, duration_seconds, blue_score, orange_score) VALUES (?, ?, ?, ?, ?)'
    ),
    insertMatchPlayer: db.prepare(
      'INSERT INTO match_players (match_id, player_id, team, goals, assists, saves, shots, demos, mvp, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),

    getPlayerStats: db.prepare('SELECT * FROM player_stats WHERE player_id = ?'),
    insertPlayerStats: db.prepare('INSERT INTO player_stats (player_id) VALUES (?)'),
    updatePlayerStats: db.prepare(`
      UPDATE player_stats SET
        total_wins = total_wins + ?,
        total_losses = total_losses + ?,
        total_goals = total_goals + ?,
        total_assists = total_assists + ?,
        total_saves = total_saves + ?,
        total_shots = total_shots + ?,
        total_demos = total_demos + ?,
        total_mvps = total_mvps + ?,
        mmr = MAX(0, mmr + ?)
      WHERE player_id = ?
    `),

    getLeaderboard: db.prepare(`
      SELECT p.id, p.display_name, ps.total_wins, ps.total_losses, ps.total_goals,
             ps.total_assists, ps.total_saves, ps.total_shots, ps.total_demos,
             ps.total_mvps, ps.mmr
      FROM player_stats ps
      JOIN players p ON p.id = ps.player_id
      ORDER BY ps.mmr DESC
      LIMIT ?
    `),

    getMatchHistory: db.prepare(`
      SELECT mh.match_id, mh.date, mh.mode, mh.duration_seconds, mh.blue_score, mh.orange_score,
             mp.team, mp.goals, mp.assists, mp.saves, mp.shots, mp.demos, mp.mvp, mp.won
      FROM match_history mh
      JOIN match_players mp ON mp.match_id = mh.match_id
      WHERE mp.player_id = ?
      ORDER BY mh.date DESC
      LIMIT ?
    `),
  };
}

// ========== Public API ==========

export function generatePlayerId() {
  return crypto.randomUUID();
}

/**
 * Ensure a player exists in the database. Creates if new.
 * Returns the player record.
 */
export function ensurePlayer(playerId, displayName = '') {
  const database = getDB();
  if (!database) return null;

  try {
    let player = stmts.getPlayer.get(playerId);
    if (!player) {
      stmts.insertPlayer.run(playerId, displayName);
      stmts.insertPlayerStats.run(playerId);
      player = stmts.getPlayer.get(playerId);
    } else {
      stmts.updateLastSeen.run(displayName || player.display_name, playerId);
    }
    return player;
  } catch (err) {
    console.error('ensurePlayer error:', err.message);
    return null;
  }
}

/**
 * Save a completed match and update all participating players' stats.
 * @param {object} matchData - { mode, durationSeconds, blueScore, orangeScore, players }
 *   players: [{ playerId, team, goals, assists, saves, shots, demos, mvp, won }]
 */
export function saveMatch(matchData) {
  const database = getDB();
  if (!database) return null;

  const matchId = crypto.randomUUID();

  try {
    const saveTransaction = database.transaction(() => {
      // Insert match record
      stmts.insertMatch.run(
        matchId,
        matchData.mode || '1v1',
        matchData.durationSeconds || 0,
        matchData.blueScore || 0,
        matchData.orangeScore || 0
      );

      // Insert each player's match record and update aggregated stats
      for (const p of matchData.players) {
        if (!p.playerId) continue; // skip bots without playerId

        stmts.insertMatchPlayer.run(
          matchId, p.playerId, p.team,
          p.goals || 0, p.assists || 0, p.saves || 0,
          p.shots || 0, p.demos || 0, p.mvp ? 1 : 0, p.won ? 1 : 0
        );

        // Ensure player_stats row exists
        const existing = stmts.getPlayerStats.get(p.playerId);
        if (!existing) {
          stmts.insertPlayerStats.run(p.playerId);
        }

        // MMR change: +25 for win, -25 for loss
        const mmrDelta = p.won ? 25 : -25;

        stmts.updatePlayerStats.run(
          p.won ? 1 : 0,       // wins
          p.won ? 0 : 1,       // losses
          p.goals || 0,
          p.assists || 0,
          p.saves || 0,
          p.shots || 0,
          p.demos || 0,
          p.mvp ? 1 : 0,
          mmrDelta,
          p.playerId
        );
      }
    });

    saveTransaction();
    return matchId;
  } catch (err) {
    console.error('saveMatch error:', err.message);
    return null;
  }
}

/**
 * Get aggregated stats for a player.
 */
export function getPlayerStats(playerId) {
  const database = getDB();
  if (!database) return null;

  try {
    const stats = stmts.getPlayerStats.get(playerId);
    if (!stats) return null;

    const player = stmts.getPlayer.get(playerId);
    return {
      playerId,
      displayName: player ? player.display_name : '',
      ...stats,
    };
  } catch (err) {
    console.error('getPlayerStats error:', err.message);
    return null;
  }
}

/**
 * Get leaderboard sorted by MMR.
 * @param {number} limit - Number of entries to return (default 20)
 */
export function getLeaderboard(limit = 20) {
  const database = getDB();
  if (!database) return [];

  try {
    return stmts.getLeaderboard.all(Math.min(limit, 100));
  } catch (err) {
    console.error('getLeaderboard error:', err.message);
    return [];
  }
}

/**
 * Get recent match history for a player.
 * @param {string} playerId
 * @param {number} limit - Number of matches to return (default 10)
 */
export function getMatchHistory(playerId, limit = 10) {
  const database = getDB();
  if (!database) return [];

  try {
    return stmts.getMatchHistory.all(playerId, Math.min(limit, 50));
  } catch (err) {
    console.error('getMatchHistory error:', err.message);
    return [];
  }
}

/**
 * Initialize the database (call on server start).
 * Lazy — will create on first actual use if not called.
 */
export function initDatabase() {
  return getDB() !== null;
}
