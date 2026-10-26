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
import {
  getDayKey, getWeekKey, previousDayKey, getDailyChallenges, getWeeklyChallenge,
  matchEvents, streakBonusXP, ACHIEVEMENTS, BOOST_COLORS,
  getUnlockContext, isBoostUnlocked, unlockedBoostIds, validateLoadout,
  secondsUntilDayReset, secondsUntilWeekReset,
} from '../shared/Meta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// BLOCKET_DB_PATH lets tests/dev point at a scratch file; default is server/data/blocket.db
const DB_PATH = process.env.BLOCKET_DB_PATH || join(__dirname, 'data', 'blocket.db');
const DB_DIR = dirname(DB_PATH);

const LEADERBOARD_PAGE_SIZE = 20;
const LEADERBOARD_MAX_PAGE = 50;
const MMR_HISTORY_POINTS = 40;

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

// Leaderboard result cache: key -> { rows, expires }. Leaderboards are read
// by every client that opens the menu but only change when a match is saved,
// so results are served from memory for a few seconds and invalidated on write.
const LEADERBOARD_CACHE_TTL_MS = 5000;
const leaderboardCache = new Map();

function invalidateLeaderboardCache() {
  leaderboardCache.clear();
}

// ensurePlayer only rewrites last_seen when it is older than this (or the
// display name changed), so reconnect storms don't turn into a write each.
const LAST_SEEN_REFRESH_MS = 60 * 1000;

/** Parse SQLite's `datetime('now')` text (UTC, 'YYYY-MM-DD HH:MM:SS') to ms. */
function sqliteDateToMs(text) {
  if (!text) return NaN;
  return Date.parse(text.replace(' ', 'T') + 'Z');
}

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
    // With WAL, NORMAL only fsyncs at checkpoints; durable against process
    // crashes (not power loss) and avoids an fsync per transaction commit.
    db.pragma('synchronous = NORMAL');
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

    -- Retention loop: challenge progress (per period), unlocked achievements
    CREATE TABLE IF NOT EXISTS player_challenges (
      player_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      challenge_id TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (player_id, period_key, challenge_id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );
    CREATE INDEX IF NOT EXISTS idx_player_challenges_period ON player_challenges(period_key);

    CREATE TABLE IF NOT EXISTS player_achievements (
      player_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (player_id, achievement_id),
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

  // Leaderboard ordering indexes. Created here (not in _initSchema) because
  // the per-mode MMR columns are added by the migration above.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_player_stats_mmr_1v1 ON player_stats(mmr_1v1 DESC);
    CREATE INDEX IF NOT EXISTS idx_player_stats_mmr_2v2 ON player_stats(mmr_2v2 DESC);
  `);

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

  // Retention loop migration: milestone counters, play streak, peak MMR, loadout
  const metaMigrations = [
    ['total_hat_tricks', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_shutouts', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_ot_wins', 'INTEGER NOT NULL DEFAULT 0'],
    ['best_win_streak', 'INTEGER NOT NULL DEFAULT 0'],
    ['play_streak', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_play_day', 'TEXT DEFAULT NULL'],
    ['peak_mmr', 'INTEGER NOT NULL DEFAULT 1000'],
    ['equipped_boost', 'TEXT DEFAULT NULL'],
    ['equipped_title', 'TEXT DEFAULT NULL'],
  ];
  const needsPeakBackfill = !cols.includes('peak_mmr');
  for (const [col, type] of metaMigrations) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE player_stats ADD COLUMN ${col} ${type}`);
      console.log(`Migrated: added player_stats.${col}`);
    }
  }
  if (needsPeakBackfill) {
    // Existing players keep credit for the rank they already hold
    db.exec('UPDATE player_stats SET peak_mmr = MAX(peak_mmr, mmr_1v1, mmr_2v2)');
    console.log('Migrated: backfilled player_stats.peak_mmr');
  }

  // Drop challenge progress from past periods (table only needs the live day/week)
  _pruneChallenges();
}

let _lastPruneKey = null;
function _pruneChallenges() {
  const dayKey = getDayKey();
  if (_lastPruneKey === dayKey) return;
  _lastPruneKey = dayKey;
  try {
    db.prepare('DELETE FROM player_challenges WHERE period_key NOT IN (?, ?)')
      .run('D:' + dayKey, 'W:' + getWeekKey());
  } catch (err) {
    console.error('pruneChallenges error:', err.message);
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
        mmr = MAX(0, mmr + ?),
        total_hat_tricks = total_hat_tricks + ?,
        total_shutouts = total_shutouts + ?,
        total_ot_wins = total_ot_wins + ?,
        best_win_streak = MAX(best_win_streak, ?),
        play_streak = ?,
        last_play_day = ?,
        peak_mmr = MAX(peak_mmr, ?)
      WHERE player_id = ?
    `),

    // Retention loop
    getChallenge: db.prepare(
      'SELECT progress, completed FROM player_challenges WHERE player_id = ? AND period_key = ? AND challenge_id = ?'
    ),
    getChallengesForPeriods: db.prepare(
      'SELECT period_key, challenge_id, progress, completed FROM player_challenges WHERE player_id = ? AND period_key IN (?, ?)'
    ),
    upsertChallenge: db.prepare(`
      INSERT INTO player_challenges (player_id, period_key, challenge_id, progress, completed, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(player_id, period_key, challenge_id)
      DO UPDATE SET progress = excluded.progress, completed = excluded.completed, updated_at = excluded.updated_at
    `),
    getAchievements: db.prepare(
      'SELECT achievement_id, unlocked_at FROM player_achievements WHERE player_id = ? ORDER BY unlocked_at ASC'
    ),
    insertAchievement: db.prepare(
      'INSERT OR IGNORE INTO player_achievements (player_id, achievement_id) VALUES (?, ?)'
    ),
    updateLoadout: db.prepare(
      'UPDATE player_stats SET equipped_boost = ?, equipped_title = ? WHERE player_id = ?'
    ),
    getMMRHistory: db.prepare(`
      SELECT mmr_after FROM rank_history
      WHERE player_id = ? AND mode = ?
      ORDER BY date DESC, id DESC
      LIMIT ?
    `),
    getLeaderboardPage1v1: db.prepare(`
      SELECT p.id, p.display_name, ps.total_wins, ps.total_losses, ps.total_goals,
             ps.mmr_1v1 AS mmr, ps.level, ps.prestige, ps.equipped_title
      FROM player_stats ps
      JOIN players p ON p.id = ps.player_id
      WHERE ps.total_matches >= 1
      ORDER BY ps.mmr_1v1 DESC, ps.total_wins DESC, p.id ASC
      LIMIT ? OFFSET ?
    `),
    getLeaderboardPage2v2: db.prepare(`
      SELECT p.id, p.display_name, ps.total_wins, ps.total_losses, ps.total_goals,
             ps.mmr_2v2 AS mmr, ps.level, ps.prestige, ps.equipped_title
      FROM player_stats ps
      JOIN players p ON p.id = ps.player_id
      WHERE ps.total_matches >= 1
      ORDER BY ps.mmr_2v2 DESC, ps.total_wins DESC, p.id ASC
      LIMIT ? OFFSET ?
    `),
    countRanked: db.prepare('SELECT COUNT(*) AS n FROM player_stats WHERE total_matches >= 1'),
    rankPosition1v1: db.prepare(
      'SELECT COUNT(*) + 1 AS pos FROM player_stats WHERE total_matches >= 1 AND mmr_1v1 > ?'
    ),
    rankPosition2v2: db.prepare(
      'SELECT COUNT(*) + 1 AS pos FROM player_stats WHERE total_matches >= 1 AND mmr_2v2 > ?'
    ),

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
      // Read-first: only write when something actually changes.
      const newName = displayName || player.display_name;
      const nameChanged = newName !== player.display_name;
      const lastSeenMs = sqliteDateToMs(player.last_seen);
      const lastSeenStale = !(Date.now() - lastSeenMs < LAST_SEEN_REFRESH_MS); // also true if unparseable
      if (nameChanged || lastSeenStale) {
        stmts.updateLastSeen.run(newName, playerId);
        if (nameChanged) {
          player.display_name = newName;
          invalidateLeaderboardCache(); // leaderboard rows carry display_name
        }
      }
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
  const dayKey = getDayKey();
  const weekKey = getWeekKey();

  try {
    _pruneChallenges(); // no-op unless the UTC day rolled over since last call
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

        // Read the player's stats row once; create it only if missing
        let currentStats = stmts.getPlayerStats.get(p.playerId);
        if (!currentStats) {
          stmts.insertPlayerStats.run(p.playerId);
          currentStats = stmts.getPlayerStats.get(p.playerId);
        }
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
        const prevXP = currentStats ? currentStats.xp : 0;

        // ---- Retention loop: challenges, play streak, achievements, unlocks ----
        // All computed here from the saved result (never from client claims).
        const ev = matchEvents(p, matchData);
        const rewards = _applyMatchRewards(p.playerId, currentStats, ev, newMMR, newWinStreak, dayKey, weekKey, prevXP + matchXP);
        const totalEarned = matchXP + rewards.challengeXP + rewards.streakXP + rewards.achievementXP;
        const newTotalXP = prevXP + totalEarned;
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
          totalEarned,
          newLevel,
          mmrDelta,
          ev.hatTrick,
          ev.shutout,
          ev.overtimeWin,
          newWinStreak,
          rewards.streak,
          dayKey,
          newMMR,
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
          rewards: {
            ...rewards,
            matchXP,
            totalXP: totalEarned,
          },
        };
      }
    });

    saveTransaction();
    invalidateLeaderboardCache();
    return { matchId, playerResults };
  } catch (err) {
    console.error('saveMatch error:', err.message);
    return null;
  }
}

/**
 * Apply challenge progress, play streak and achievements for one player's
 * match result. Runs inside the saveMatch transaction (writes challenge and
 * achievement rows; the player_stats update is done by the caller).
 *
 * @param {string} playerId
 * @param {object|null} currentStats - player_stats row before this match
 * @param {object} ev - matchEvents() for this match
 * @param {number} newMMR - MMR after this match in the played mode
 * @param {number} newWinStreak - win streak after this match
 * @param {string} dayKey
 * @param {string} weekKey
 * @param {number} xpBeforeBonuses - total XP after match XP, before bonus XP
 * @returns {{ challenges, newAchievements, newUnlocks, streak, streakXP, challengeXP, achievementXP }}
 */
function _applyMatchRewards(playerId, currentStats, ev, newMMR, newWinStreak, dayKey, weekKey, xpBeforeBonuses) {
  const cur = currentStats || {};

  // --- Challenges (daily x3 + weekly x1; same set for everyone) ---
  const challenges = [];
  let challengeXP = 0;
  const applyChallenge = (def, periodKey, period) => {
    const row = stmts.getChallenge.get(playerId, periodKey, def.id);
    const prevProgress = row ? row.progress : 0;
    const wasCompleted = row ? row.completed === 1 : false;
    const inc = ev[def.stat] || 0;
    const progress = Math.min(def.target, prevProgress + inc);
    const justCompleted = !wasCompleted && progress >= def.target;
    if (justCompleted) challengeXP += def.xp;
    if (!row || inc > 0) {
      stmts.upsertChallenge.run(playerId, periodKey, def.id, progress, (wasCompleted || justCompleted) ? 1 : 0);
    }
    challenges.push({
      id: def.id, name: def.name, desc: def.desc, target: def.target, xp: def.xp, period,
      progress, delta: progress - prevProgress,
      completed: wasCompleted || justCompleted, justCompleted,
    });
  };
  for (const def of getDailyChallenges(dayKey)) applyChallenge(def, 'D:' + dayKey, 'daily');
  applyChallenge(getWeeklyChallenge(weekKey), 'W:' + weekKey, 'weekly');

  // --- Play streak (consecutive UTC days with an online match); bonus once per day ---
  let streak = cur.play_streak || 0;
  let streakXP = 0;
  let firstMatchToday = false;
  if (cur.last_play_day !== dayKey) {
    firstMatchToday = true;
    streak = cur.last_play_day === previousDayKey(dayKey) ? streak + 1 : 1;
    streakXP = streakBonusXP(streak);
  }

  // --- Achievements: evaluate against the predicted post-match totals ---
  const haveRows = stmts.getAchievements.all(playerId);
  const have = new Set(haveRows.map(r => r.achievement_id));
  const ctxBefore = getUnlockContext(cur, have);
  const after = {
    ...cur,
    total_wins: (cur.total_wins || 0) + ev.wins,
    total_losses: (cur.total_losses || 0) + ev.losses,
    total_goals: (cur.total_goals || 0) + ev.goals,
    total_assists: (cur.total_assists || 0) + ev.assists,
    total_saves: (cur.total_saves || 0) + ev.saves,
    total_shots: (cur.total_shots || 0) + ev.shots,
    total_demos: (cur.total_demos || 0) + ev.demos,
    total_mvps: (cur.total_mvps || 0) + ev.mvp,
    total_matches: (cur.total_matches || 0) + 1,
    total_hat_tricks: (cur.total_hat_tricks || 0) + ev.hatTrick,
    total_shutouts: (cur.total_shutouts || 0) + ev.shutout,
    total_ot_wins: (cur.total_ot_wins || 0) + ev.overtimeWin,
    best_win_streak: Math.max(cur.best_win_streak || 0, newWinStreak),
    play_streak: streak,
    peak_mmr: Math.max(cur.peak_mmr || 0, cur.mmr_1v1 || 0, cur.mmr_2v2 || 0, newMMR),
    level: calculateLevel(xpBeforeBonuses + challengeXP + streakXP),
  };
  const newAchievements = [];
  let achievementXP = 0;
  for (const def of ACHIEVEMENTS) {
    if (have.has(def.id)) continue;
    let ok = false;
    try { ok = !!def.check(after, ev); } catch { ok = false; }
    if (!ok) continue;
    stmts.insertAchievement.run(playerId, def.id);
    have.add(def.id);
    achievementXP += def.xp;
    newAchievements.push({ id: def.id, name: def.name, desc: def.desc, title: def.title, xp: def.xp });
  }
  // Final level includes achievement XP (a level-gated unlock crossing here is caught below)
  after.level = calculateLevel(xpBeforeBonuses + challengeXP + streakXP + achievementXP);

  // --- Cosmetic unlocks crossed this match ---
  const ctxAfter = getUnlockContext(after, have);
  const newUnlocks = [];
  for (const b of BOOST_COLORS) {
    if (!isBoostUnlocked(b, ctxBefore) && isBoostUnlocked(b, ctxAfter)) {
      newUnlocks.push({ type: 'boost', id: b.id, name: b.name, hex: b.hex });
    }
  }
  for (const a of newAchievements) {
    newUnlocks.push({ type: 'title', id: a.id, name: a.title });
  }

  return { challenges, newAchievements, newUnlocks, streak, firstMatchToday, streakXP, challengeXP, achievementXP };
}

/**
 * Player's equipped cosmetics, or defaults. Cheap (single indexed read):
 * called on connect to seed the per-socket loadout cache.
 */
export function getLoadout(playerId) {
  const database = getDB();
  if (!database) return { boost: null, title: null };
  try {
    const row = stmts.getPlayerStats.get(playerId);
    return {
      boost: row ? (row.equipped_boost || null) : null,
      title: row ? (row.equipped_title || null) : null,
    };
  } catch (err) {
    console.error('getLoadout error:', err.message);
    return { boost: null, title: null };
  }
}

/**
 * Validate and persist a loadout. Locked/unknown items are dropped (not an
 * error) so a stale client can never equip something it hasn't earned.
 * @returns {{ boost: string|null, title: string|null }}
 */
export function setLoadout(playerId, raw) {
  const database = getDB();
  if (!database) return { boost: null, title: null };
  try {
    let row = stmts.getPlayerStats.get(playerId);
    if (!row) {
      stmts.insertPlayerStats.run(playerId);
      row = stmts.getPlayerStats.get(playerId);
    }
    const have = new Set(stmts.getAchievements.all(playerId).map(r => r.achievement_id));
    const ctx = getUnlockContext(row, have);
    const clean = validateLoadout(raw, ctx);
    if (clean.boost !== (row.equipped_boost || null) || clean.title !== (row.equipped_title || null)) {
      stmts.updateLoadout.run(clean.boost, clean.title, playerId);
      invalidateLeaderboardCache(); // leaderboard rows carry equipped_title
    }
    return clean;
  } catch (err) {
    console.error('setLoadout error:', err.message);
    return { boost: null, title: null };
  }
}

/**
 * Everything the lobby profile screen needs in one round trip.
 */
export function getProfile(playerId) {
  const database = getDB();
  if (!database) return null;
  try {
    const stats = getPlayerStats(playerId);
    if (!stats) return null;

    const achievementRows = stmts.getAchievements.all(playerId);
    const have = new Set(achievementRows.map(r => r.achievement_id));
    const ctx = getUnlockContext(stats, have);

    const dayKey = getDayKey();
    const weekKey = getWeekKey();
    const progressRows = stmts.getChallengesForPeriods.all(playerId, 'D:' + dayKey, 'W:' + weekKey);
    const progressMap = new Map(progressRows.map(r => [r.period_key + '|' + r.challenge_id, r]));
    const withProgress = (def, periodKey, period) => {
      const r = progressMap.get(periodKey + '|' + def.id);
      return {
        id: def.id, name: def.name, desc: def.desc, target: def.target, xp: def.xp, period,
        progress: r ? Math.min(def.target, r.progress) : 0,
        completed: r ? r.completed === 1 : false,
      };
    };
    const weekly = getWeeklyChallenge(weekKey);

    const hist1 = stmts.getMMRHistory.all(playerId, '1v1', MMR_HISTORY_POINTS).map(r => r.mmr_after).reverse();
    const hist2 = stmts.getMMRHistory.all(playerId, '2v2', MMR_HISTORY_POINTS).map(r => r.mmr_after).reverse();

    const total = stats.total_matches || 0;
    return {
      stats: {
        displayName: stats.displayName,
        xp: stats.xp, level: stats.level, levelTitle: stats.levelTitle, prestige: stats.prestige || 0,
        mmr_1v1: stats.mmr_1v1, mmr_2v2: stats.mmr_2v2, peak_mmr: stats.peak_mmr,
        rank1v1: stats.rank1v1, rank2v2: stats.rank2v2,
        total_wins: stats.total_wins, total_losses: stats.total_losses, total_matches: total,
        win_rate: total > 0 ? Math.round((stats.total_wins / total) * 100) : 0,
        total_goals: stats.total_goals, total_assists: stats.total_assists, total_saves: stats.total_saves,
        total_shots: stats.total_shots, total_demos: stats.total_demos, total_mvps: stats.total_mvps,
        total_hat_tricks: stats.total_hat_tricks, total_shutouts: stats.total_shutouts, total_ot_wins: stats.total_ot_wins,
        play_time_minutes: Math.round(stats.play_time_minutes || 0),
        win_streak: stats.win_streak, best_win_streak: stats.best_win_streak,
        play_streak: stats.play_streak, last_play_day: stats.last_play_day,
        matches_played_ranked: stats.matches_played_ranked,
      },
      positions: {
        '1v1': total > 0 ? stmts.rankPosition1v1.get(stats.mmr_1v1).pos : null,
        '2v2': total > 0 ? stmts.rankPosition2v2.get(stats.mmr_2v2).pos : null,
      },
      achievements: achievementRows.map(r => ({ id: r.achievement_id, unlockedAt: r.unlocked_at })),
      challenges: {
        dayKey, weekKey,
        dayResetsIn: secondsUntilDayReset(),
        weekResetsIn: secondsUntilWeekReset(),
        daily: getDailyChallenges(dayKey).map(d => withProgress(d, 'D:' + dayKey, 'daily')),
        weekly: withProgress(weekly, 'W:' + weekKey, 'weekly'),
        streak: stats.play_streak || 0,
        playedToday: stats.last_play_day === dayKey,
      },
      loadout: { boost: stats.equipped_boost || null, title: stats.equipped_title || null },
      unlocks: { boosts: unlockedBoostIds(ctx) },
      mmrHistory: { '1v1': hist1, '2v2': hist2 },
      recentMatches: stmts.getMatchHistory.all(playerId, 10),
    };
  } catch (err) {
    console.error('getProfile error:', err.message);
    return null;
  }
}

/**
 * One page of the per-mode leaderboard. Cached like getLeaderboard.
 * @param {string} mode - '1v1' | '2v2'
 * @param {number} page - zero-based
 * @param {string|null} viewerId - include the viewer's own position
 */
export function getLeaderboardPage(mode, page, viewerId = null) {
  const database = getDB();
  const m = mode === '2v2' ? '2v2' : '1v1';
  const pg = Math.max(0, Math.min(LEADERBOARD_MAX_PAGE, Math.floor(Number(page) || 0)));
  const empty = { mode: m, page: pg, pageSize: LEADERBOARD_PAGE_SIZE, total: 0, rows: [], myPosition: null };
  if (!database) return empty;

  const key = `page:${m}:${pg}`;
  const now = Date.now();
  let cached = leaderboardCache.get(key);
  try {
    if (!cached || cached.expires <= now) {
      const stmt = m === '2v2' ? stmts.getLeaderboardPage2v2 : stmts.getLeaderboardPage1v1;
      const rows = stmt.all(LEADERBOARD_PAGE_SIZE, pg * LEADERBOARD_PAGE_SIZE).map((row, i) => ({
        position: pg * LEADERBOARD_PAGE_SIZE + i + 1,
        id: row.id,
        displayName: row.display_name,
        wins: row.total_wins, losses: row.total_losses, goals: row.total_goals,
        mmr: row.mmr, level: row.level, prestige: row.prestige,
        title: row.equipped_title || null,
        rank: getRankFromMMR(row.mmr || 1000),
      }));
      const total = stmts.countRanked.get().n;
      cached = { rows: { mode: m, page: pg, pageSize: LEADERBOARD_PAGE_SIZE, total, rows }, expires: now + LEADERBOARD_CACHE_TTL_MS };
      leaderboardCache.set(key, cached);
    }
    let myPosition = null;
    if (viewerId) {
      const me = stmts.getPlayerStats.get(viewerId);
      if (me && me.total_matches >= 1) {
        const mmr = m === '2v2' ? me.mmr_2v2 : me.mmr_1v1;
        myPosition = (m === '2v2' ? stmts.rankPosition2v2 : stmts.rankPosition1v1).get(mmr).pos;
      }
    }
    return { ...cached.rows, myPosition };
  } catch (err) {
    console.error('getLeaderboardPage error:', err.message);
    return empty;
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
 * Results are cached per limit for LEADERBOARD_CACHE_TTL_MS and invalidated
 * whenever a match is saved. Callers must treat the returned array as
 * read-only (the same array may be handed to several callers).
 * @param {number} limit - Number of entries to return (default 20)
 */
export function getLeaderboard(limit = 20) {
  const database = getDB();
  if (!database) return [];

  const clamped = Math.min(limit, 100);
  const now = Date.now();
  const cached = leaderboardCache.get(clamped);
  if (cached && cached.expires > now) return cached.rows;

  try {
    const rows = stmts.getLeaderboard.all(clamped).map(row => ({
      ...row,
      rank1v1: getRankFromMMR(row.mmr_1v1 || 1000),
      rank2v2: getRankFromMMR(row.mmr_2v2 || 1000),
      levelTitle: getLevelTitle(row.level || 0),
    }));
    leaderboardCache.set(clamped, { rows, expires: now + LEADERBOARD_CACHE_TTL_MS });
    return rows;
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
