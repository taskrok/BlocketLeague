// ============================================
// Database — SQLite persistence for player stats
// Uses better-sqlite3 with WAL mode for performance
// ============================================

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import crypto from 'crypto';
import {
  XP_VALUES, calculateLevel, xpForLevel,
  calculateMMRDelta, getRankFromMMR, getLevelTitle,
  INACTIVITY_DAYS, INACTIVITY_UNCERTAINTY,
} from '../shared/Ranks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_DIR = join(__dirname, 'data');
const DB_PATH = join(DB_DIR, 'blocket.db');

function calculateXP(p) {
  let xp = XP_VALUES.matchComplete;
  xp += (p.goals || 0) * XP_VALUES.goal;
  xp += (p.assists || 0) * XP_VALUES.assist;
  xp += (p.saves || 0) * XP_VALUES.save;
  xp += (p.shots || 0) * XP_VALUES.shot;
  xp += (p.demos || 0) * XP_VALUES.demo;
  xp += (p.aerialGoals || 0) * XP_VALUES.aerialGoal;
  if (p.won) xp += XP_VALUES.win;

  // Bonus XP
  if ((p.goals || 0) >= 3) xp += XP_VALUES.hatTrick;
  if ((p.assists || 0) >= 3) xp += XP_VALUES.playmaker;
  if ((p.saves || 0) >= 3) xp += XP_VALUES.savior;
  if (p.mvp) xp += XP_VALUES.mvp;
  if (p.overtimeWin) xp += XP_VALUES.overtimeWin;

  return xp;
}

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
    _migrateSchema();
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
      total_matches INTEGER NOT NULL DEFAULT 0,
      total_aerial_goals INTEGER NOT NULL DEFAULT 0,
      play_time_minutes REAL NOT NULL DEFAULT 0,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      mmr INTEGER NOT NULL DEFAULT 1000,
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS rank_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT '1v1',
      mmr_before INTEGER NOT NULL,
      mmr_after INTEGER NOT NULL,
      mmr_delta INTEGER NOT NULL,
      rank_name TEXT NOT NULL,
      date TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (player_id) REFERENCES players(id),
      FOREIGN KEY (match_id) REFERENCES match_history(match_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rank_history_player ON rank_history(player_id, date DESC);

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players(player_id);
    CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
    CREATE INDEX IF NOT EXISTS idx_match_history_date ON match_history(date);
    CREATE INDEX IF NOT EXISTS idx_player_stats_mmr ON player_stats(mmr DESC);
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
  `);
}

function _migrateSchema() {
  // Add columns that may not exist in older databases
  const cols = db.prepare("PRAGMA table_info('player_stats')").all().map(c => c.name);
  const migrations = [
    ['total_matches', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_aerial_goals', 'INTEGER NOT NULL DEFAULT 0'],
    ['play_time_minutes', 'REAL NOT NULL DEFAULT 0'],
    ['xp', 'INTEGER NOT NULL DEFAULT 0'],
    ['level', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, type] of migrations) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE player_stats ADD COLUMN ${col} ${type}`);
      console.log(`Migrated: added player_stats.${col}`);
    }
  }

  // Ranking system migration — new columns
  const rankMigrations = [
    ['mmr_1v1', 'INTEGER NOT NULL DEFAULT 1000'],
    ['mmr_2v2', 'INTEGER NOT NULL DEFAULT 1000'],
    ['win_streak', 'INTEGER NOT NULL DEFAULT 0'],
    ['loss_streak', 'INTEGER NOT NULL DEFAULT 0'],
    ['matches_played_ranked', 'INTEGER NOT NULL DEFAULT 0'],
    ['prestige', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_match_date', 'TEXT DEFAULT NULL'],
  ];

  const needsRankDataMigration = !cols.includes('mmr_1v1');

  for (const [col, type] of rankMigrations) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE player_stats ADD COLUMN ${col} ${type}`);
      console.log(`Migrated: added player_stats.${col}`);
    }
  }

  // Copy existing MMR to new per-mode columns if they were just created
  if (needsRankDataMigration) {
    db.exec('UPDATE player_stats SET mmr_1v1 = mmr, mmr_2v2 = mmr');
    db.exec('UPDATE player_stats SET matches_played_ranked = total_matches');
    console.log('Migrated: copied mmr to mmr_1v1/mmr_2v2, set matches_played_ranked');
  }

  // Recalculate levels with new formula (level = floor(sqrt(xp / 200)))
  db.exec(`
    UPDATE player_stats
    SET level = CAST(SQRT(CAST(xp AS REAL) / 200.0) AS INTEGER)
  `);

  // match_players MMR columns
  const mpCols = db.prepare("PRAGMA table_info('match_players')").all().map(c => c.name);
  if (!mpCols.includes('mmr_before')) {
    db.exec('ALTER TABLE match_players ADD COLUMN mmr_before INTEGER DEFAULT NULL');
    db.exec('ALTER TABLE match_players ADD COLUMN mmr_after INTEGER DEFAULT NULL');
    console.log('Migrated: added match_players.mmr_before/mmr_after');
  }
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
      'INSERT INTO match_players (match_id, player_id, team, goals, assists, saves, shots, demos, mvp, won, mmr_before, mmr_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        total_matches = total_matches + 1,
        total_aerial_goals = total_aerial_goals + ?,
        play_time_minutes = play_time_minutes + ?,
        xp = xp + ?,
        level = ?,
        mmr = MAX(0, mmr + ?)
      WHERE player_id = ?
    `),

    // Mode-specific MMR updates
    updateMMR1v1: db.prepare(`
      UPDATE player_stats SET
        mmr_1v1 = MAX(0, ?),
        win_streak = ?,
        loss_streak = ?,
        matches_played_ranked = matches_played_ranked + 1,
        last_match_date = datetime('now')
      WHERE player_id = ?
    `),
    updateMMR2v2: db.prepare(`
      UPDATE player_stats SET
        mmr_2v2 = MAX(0, ?),
        win_streak = ?,
        loss_streak = ?,
        matches_played_ranked = matches_played_ranked + 1,
        last_match_date = datetime('now')
      WHERE player_id = ?
    `),

    insertRankHistory: db.prepare(`
      INSERT INTO rank_history (player_id, match_id, mode, mmr_before, mmr_after, mmr_delta, rank_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    getLeaderboard: db.prepare(`
      SELECT p.id, p.display_name, ps.total_wins, ps.total_losses, ps.total_goals,
             ps.total_assists, ps.total_saves, ps.total_shots, ps.total_demos,
             ps.total_mvps, ps.mmr, ps.mmr_1v1, ps.mmr_2v2, ps.level, ps.prestige
      FROM player_stats ps
      JOIN players p ON p.id = ps.player_id
      WHERE ps.total_matches >= 1
      ORDER BY ps.mmr_1v1 DESC
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
 * @param {object} matchData - { mode, durationSeconds, blueScore, orangeScore, isOvertime, players }
 *   players: [{ playerId, team, goals, assists, saves, shots, demos, mvp, won, aerialGoals, playTimeMinutes, opponentMMR }]
 * @returns {{ matchId: string, playerResults: Object.<string, { mmrDelta, mmrBefore, mmrAfter, rankBefore, rankAfter, xpEarned }> } | null}
 */
export function saveMatch(matchData) {
  const database = getDB();
  if (!database) return null;

  const matchId = crypto.randomUUID();
  const playerResults = {};

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

      const mode = matchData.mode || '1v1';
      const mmrColumn = mode === '2v2' ? 'mmr_2v2' : 'mmr_1v1';

      // Insert each player's match record and update aggregated stats
      for (const p of matchData.players) {
        if (!p.playerId) continue; // skip bots without playerId

        // Ensure player_stats row exists
        const existing = stmts.getPlayerStats.get(p.playerId);
        if (!existing) {
          stmts.insertPlayerStats.run(p.playerId);
        }

        const currentStats = stmts.getPlayerStats.get(p.playerId);
        const currentMMR = currentStats ? currentStats[mmrColumn] : 1000;
        const opponentMMR = p.opponentMMR !== undefined ? p.opponentMMR : currentMMR;
        const winStreak = currentStats ? currentStats.win_streak : 0;
        const lossStreak = currentStats ? currentStats.loss_streak : 0;
        const matchesPlayed = currentStats ? currentStats.matches_played_ranked : 0;

        // Check inactivity — reset uncertainty if 30+ days since last match
        let effectiveMatchesPlayed = matchesPlayed;
        if (currentStats && currentStats.last_match_date) {
          const lastMatch = new Date(currentStats.last_match_date);
          const now = new Date();
          const daysSinceLastMatch = (now - lastMatch) / (1000 * 60 * 60 * 24);
          if (daysSinceLastMatch >= INACTIVITY_DAYS) {
            // Reset to uncertainty=1.5 equivalent: matchesPlayed ~= (2.5 - 1.5) / 0.15 = ~6.67
            effectiveMatchesPlayed = Math.min(matchesPlayed, 7);
          }
        }

        // Calculate MMR delta using the proper algorithm
        const mmrDelta = calculateMMRDelta(
          currentMMR, opponentMMR, !!p.won,
          effectiveMatchesPlayed, winStreak, lossStreak
        );

        const newMMR = Math.max(0, currentMMR + mmrDelta);
        const rankBefore = getRankFromMMR(currentMMR);
        const rankAfter = getRankFromMMR(newMMR);

        // Update streaks
        const newWinStreak = p.won ? winStreak + 1 : 0;
        const newLossStreak = p.won ? 0 : lossStreak + 1;

        // Calculate XP earned this match
        const matchXP = calculateXP(p);
        const newTotalXP = (currentStats ? currentStats.xp : 0) + matchXP;
        const newLevel = calculateLevel(newTotalXP);

        // Insert match_players record with MMR tracking
        stmts.insertMatchPlayer.run(
          matchId, p.playerId, p.team,
          p.goals || 0, p.assists || 0, p.saves || 0,
          p.shots || 0, p.demos || 0, p.mvp ? 1 : 0, p.won ? 1 : 0,
          currentMMR, newMMR
        );

        // Update aggregate stats (uses old mmr column for backward compat)
        stmts.updatePlayerStats.run(
          p.won ? 1 : 0,       // wins
          p.won ? 0 : 1,       // losses
          p.goals || 0,
          p.assists || 0,
          p.saves || 0,
          p.shots || 0,
          p.demos || 0,
          p.mvp ? 1 : 0,
          p.aerialGoals || 0,
          p.playTimeMinutes || 0,
          matchXP,
          newLevel,
          mmrDelta,
          p.playerId
        );

        // Update mode-specific MMR + streaks
        if (mode === '2v2') {
          stmts.updateMMR2v2.run(newMMR, newWinStreak, newLossStreak, p.playerId);
        } else {
          stmts.updateMMR1v1.run(newMMR, newWinStreak, newLossStreak, p.playerId);
        }

        // Write rank history
        stmts.insertRankHistory.run(
          p.playerId, matchId, mode,
          currentMMR, newMMR, mmrDelta,
          rankAfter.fullName
        );

        // Store result for emission to client
        playerResults[p.playerId] = {
          mmrDelta,
          mmrBefore: currentMMR,
          mmrAfter: newMMR,
          rankBefore: rankBefore.fullName,
          rankAfter: rankAfter.fullName,
          rankColor: rankAfter.color,
          xpEarned: matchXP,
          newTotalXP,
          newLevel,
        };
      }
    });

    saveTransaction();
    return { matchId, playerResults };
  } catch (err) {
    console.error('saveMatch error:', err.message);
    return null;
  }
}

/**
 * Get aggregated stats for a player, including rank info.
 */
export function getPlayerStats(playerId) {
  const database = getDB();
  if (!database) return null;

  try {
    const stats = stmts.getPlayerStats.get(playerId);
    if (!stats) return null;

    const player = stmts.getPlayer.get(playerId);
    const rank1v1 = getRankFromMMR(stats.mmr_1v1 || 1000);
    const rank2v2 = getRankFromMMR(stats.mmr_2v2 || 1000);
    const levelTitle = getLevelTitle(stats.level || 0);

    return {
      playerId,
      displayName: player ? player.display_name : '',
      ...stats,
      rank1v1,
      rank2v2,
      levelTitle,
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
    const rows = stmts.getLeaderboard.all(Math.min(limit, 100));
    return rows.map(row => ({
      ...row,
      rank1v1: getRankFromMMR(row.mmr_1v1 || 1000),
      rank2v2: getRankFromMMR(row.mmr_2v2 || 1000),
      levelTitle: getLevelTitle(row.level || 0),
    }));
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
