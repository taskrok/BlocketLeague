// ============================================
// Meta — Shared retention-loop definitions
// Daily/weekly challenges, achievements, unlockable cosmetics, loadout and
// variantConfig validation. Pure module: no deps, runs in Node and browser.
// Server is the source of truth for progress/rewards; the client only uses
// these tables for display and for optimistic UI.
// ============================================

import { getRankFromMMR } from './Ranks.js';

// ---------- Time keys (UTC) ----------

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 'YYYY-MM-DD' for the UTC day containing `date`. */
export function getDayKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Day key of the UTC day before `dayKey`. */
export function previousDayKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86400000;
  return getDayKey(new Date(t));
}

/** ISO week key 'YYYY-Www' (weeks start Monday, UTC). */
export function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad2(week)}`;
}

/** Seconds until the next UTC midnight. */
export function secondsUntilDayReset(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

/** Seconds until the next ISO week starts (Monday 00:00 UTC). */
export function secondsUntilWeekReset(now = new Date()) {
  const dayNum = now.getUTCDay() || 7; // Mon=1..Sun=7
  const daysToMonday = 8 - dayNum;
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

// ---------- Seeded selection ----------

function hashString(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pickSeeded(pool, count, seedStr) {
  let s = hashString(seedStr) || 1;
  const idx = pool.map((_, i) => i);
  // Partial Fisher-Yates with xorshift32
  for (let i = 0; i < Math.min(count, idx.length); i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const j = i + (s % (idx.length - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx.slice(0, count).map(i => pool[i]);
}

// ---------- Challenges ----------
// `stat` names a key of matchEvents(); progress accumulates across matches
// within the period and completes once it reaches `target`.

export const DAILY_CHALLENGE_POOL = [
  { id: 'd_goals3',    name: 'Striker',        desc: 'Score 3 goals',               stat: 'goals',       target: 3, xp: 150 },
  { id: 'd_saves3',    name: 'Goalkeeper',     desc: 'Make 3 saves',                stat: 'saves',       target: 3, xp: 150 },
  { id: 'd_assists2',  name: 'Team Player',    desc: 'Get 2 assists',               stat: 'assists',     target: 2, xp: 150 },
  { id: 'd_shots8',    name: 'Shooter',        desc: 'Take 8 shots on goal',        stat: 'shots',       target: 8, xp: 100 },
  { id: 'd_demos2',    name: 'Demolisher',     desc: 'Demolish 2 opponents',        stat: 'demos',       target: 2, xp: 150 },
  { id: 'd_win1',      name: 'Winner',         desc: 'Win an online match',         stat: 'wins',        target: 1, xp: 150 },
  { id: 'd_win2',      name: 'Double Up',      desc: 'Win 2 online matches',        stat: 'wins',        target: 2, xp: 250 },
  { id: 'd_matches2',  name: 'Warm Up',        desc: 'Play 2 online matches',       stat: 'matches',     target: 2, xp: 100 },
  { id: 'd_matches3',  name: 'Grinder',        desc: 'Play 3 online matches',       stat: 'matches',     target: 3, xp: 150 },
  { id: 'd_mvp1',      name: 'Star Player',    desc: 'Earn MVP in a match',         stat: 'mvp',         target: 1, xp: 200 },
  { id: 'd_hattrick',  name: 'Hat Trick',      desc: 'Score 3 goals in one match',  stat: 'hatTrick',    target: 1, xp: 250 },
  { id: 'd_shutout',   name: 'Clean Sheet',    desc: 'Win without conceding',       stat: 'shutout',     target: 1, xp: 250 },
  { id: 'd_otwin',     name: 'Clutch',         desc: 'Win a match in overtime',     stat: 'overtimeWin', target: 1, xp: 200 },
  { id: 'd_2v2',       name: 'Buddy System',   desc: 'Play a 2v2 match',            stat: 'matches2v2',  target: 1, xp: 100 },
  { id: 'd_1v1',       name: 'Duelist',        desc: 'Play a 1v1 match',            stat: 'matches1v1',  target: 1, xp: 100 },
];

export const WEEKLY_CHALLENGE_POOL = [
  { id: 'w_goals15',   name: 'Goal Rush',      desc: 'Score 15 goals this week',    stat: 'goals',   target: 15, xp: 600 },
  { id: 'w_wins7',     name: 'Winning Week',   desc: 'Win 7 online matches',        stat: 'wins',    target: 7,  xp: 800 },
  { id: 'w_saves15',   name: 'Iron Curtain',   desc: 'Make 15 saves this week',     stat: 'saves',   target: 15, xp: 600 },
  { id: 'w_matches12', name: 'Regular',        desc: 'Play 12 online matches',      stat: 'matches', target: 12, xp: 600 },
  { id: 'w_demos10',   name: 'Wrecking Crew',  desc: 'Demolish 10 opponents',       stat: 'demos',   target: 10, xp: 600 },
  { id: 'w_mvp3',      name: 'Franchise Player', desc: 'Earn MVP 3 times',          stat: 'mvp',     target: 3,  xp: 700 },
  { id: 'w_shots40',   name: 'Volley',         desc: 'Take 40 shots this week',     stat: 'shots',   target: 40, xp: 500 },
];

export const DAILY_CHALLENGE_COUNT = 3;

/** The three daily challenges for a UTC day key (same for every player). */
export function getDailyChallenges(dayKey) {
  return pickSeeded(DAILY_CHALLENGE_POOL, DAILY_CHALLENGE_COUNT, 'daily:' + dayKey);
}

/** The weekly challenge for an ISO week key. */
export function getWeeklyChallenge(weekKey) {
  return pickSeeded(WEEKLY_CHALLENGE_POOL, 1, 'weekly:' + weekKey)[0];
}

export function getChallengeById(id) {
  return DAILY_CHALLENGE_POOL.find(c => c.id === id) || WEEKLY_CHALLENGE_POOL.find(c => c.id === id) || null;
}

/**
 * Per-match event counters for one player, derived server-side from the
 * saved match result. Every challenge `stat` and achievement check reads
 * from this shape.
 * @param {object} p - saveMatch player entry
 * @param {object} match - { mode, blueScore, orangeScore, isOvertime }
 */
export function matchEvents(p, match) {
  const goals = p.goals || 0;
  const won = !!p.won;
  const oppScore = p.team === 'blue' ? (match.orangeScore || 0) : (match.blueScore || 0);
  const mode = match.mode === '2v2' ? '2v2' : '1v1';
  return {
    goals,
    assists: p.assists || 0,
    saves: p.saves || 0,
    shots: p.shots || 0,
    demos: p.demos || 0,
    wins: won ? 1 : 0,
    losses: won ? 0 : 1,
    matches: 1,
    matches1v1: mode === '1v1' ? 1 : 0,
    matches2v2: mode === '2v2' ? 1 : 0,
    mvp: p.mvp ? 1 : 0,
    hatTrick: goals >= 3 ? 1 : 0,
    shutout: won && oppScore === 0 ? 1 : 0,
    overtimeWin: won && !!match.isOvertime ? 1 : 0,
  };
}

// ---------- Play streak ----------

export const STREAK_XP_PER_DAY = 25;   // daily bonus = 25 * min(streak, cap)
export const STREAK_XP_CAP_DAYS = 7;

export function streakBonusXP(streak) {
  return STREAK_XP_PER_DAY * Math.max(0, Math.min(streak, STREAK_XP_CAP_DAYS));
}

// ---------- Achievements ----------
// check(totals, ev): totals is the player's aggregated stats row AFTER the
// match is applied; ev is matchEvents() for the match. Each grants a title.

// Lowest-division MMR floor of each rank tier used by unlocks (see Ranks.js RANKS)
const RANK_MIN = { Gold: 880, Platinum: 1240, Diamond: 1660, Champion: 2140 };

export const ACHIEVEMENTS = [
  { id: 'first_win',     name: 'First Blood',     desc: 'Win your first online match',      title: 'Winner',           xp: 100, check: t => t.total_wins >= 1 },
  { id: 'wins_10',       name: 'Contender',       desc: 'Win 10 online matches',            title: 'Contender',        xp: 150, check: t => t.total_wins >= 10 },
  { id: 'wins_50',       name: 'Big Leagues',     desc: 'Win 50 online matches',            title: 'Big Leaguer',      xp: 300, check: t => t.total_wins >= 50 },
  { id: 'wins_100',      name: 'Conqueror',       desc: 'Win 100 online matches',           title: 'Conqueror',        xp: 500, check: t => t.total_wins >= 100 },
  { id: 'matches_100',   name: 'Centurion',       desc: 'Play 100 online matches',          title: 'Centurion',        xp: 300, check: t => t.total_matches >= 100 },
  { id: 'goals_10',      name: 'Sharpshooter',    desc: 'Score 10 goals',                   title: 'Sharpshooter',     xp: 100, check: t => t.total_goals >= 10 },
  { id: 'goals_100',     name: 'Goal Machine',    desc: 'Score 100 goals',                  title: 'Goal Machine',     xp: 300, check: t => t.total_goals >= 100 },
  { id: 'goals_500',     name: 'Net Breaker',     desc: 'Score 500 goals',                  title: 'Net Breaker',      xp: 600, check: t => t.total_goals >= 500 },
  { id: 'saves_25',      name: 'The Wall',        desc: 'Make 25 saves',                    title: 'The Wall',         xp: 150, check: t => t.total_saves >= 25 },
  { id: 'saves_100',     name: 'Brick Wall',      desc: 'Make 100 saves',                   title: 'Brick Wall',       xp: 300, check: t => t.total_saves >= 100 },
  { id: 'assists_25',    name: 'Playmaker',       desc: 'Get 25 assists',                   title: 'Playmaker',        xp: 150, check: t => t.total_assists >= 25 },
  { id: 'shots_100',     name: 'Trigger Happy',   desc: 'Take 100 shots',                   title: 'Trigger Happy',    xp: 150, check: t => t.total_shots >= 100 },
  { id: 'demos_25',      name: 'Wrecking Ball',   desc: 'Demolish 25 opponents',            title: 'Wrecking Ball',    xp: 150, check: t => t.total_demos >= 25 },
  { id: 'hat_trick',     name: 'Hat Trick Hero',  desc: 'Score 3 goals in one match',       title: 'Hat Trick Hero',   xp: 150, check: t => t.total_hat_tricks >= 1 },
  { id: 'shutout',       name: 'Clean Sheet',     desc: 'Win without conceding a goal',     title: 'Clean Sheet',      xp: 150, check: t => t.total_shutouts >= 1 },
  { id: 'ot_win',        name: 'Clutch',          desc: 'Win a match in overtime',          title: 'Clutch',           xp: 150, check: t => t.total_ot_wins >= 1 },
  { id: 'mvp_5',         name: 'Most Valuable',   desc: 'Earn MVP 5 times',                 title: 'MVP',              xp: 200, check: t => t.total_mvps >= 5 },
  { id: 'win_streak_5',  name: 'Unstoppable',     desc: 'Win 5 online matches in a row',    title: 'Unstoppable',      xp: 300, check: t => t.best_win_streak >= 5 },
  { id: 'streak_3',      name: 'Regular',         desc: 'Play online 3 days in a row',      title: 'Regular',          xp: 150, check: t => t.play_streak >= 3 },
  { id: 'streak_7',      name: 'Daily Driver',    desc: 'Play online 7 days in a row',      title: 'Daily Driver',     xp: 400, check: t => t.play_streak >= 7 },
  { id: 'level_10',      name: 'Rising Star',     desc: 'Reach level 10',                   title: 'Rising Star',      xp: 200, check: t => t.level >= 10 },
  { id: 'level_25',      name: 'Dedicated',       desc: 'Reach level 25',                   title: 'Dedicated',        xp: 400, check: t => t.level >= 25 },
  { id: 'level_50',      name: 'Blocket Legend',  desc: 'Reach level 50',                   title: 'Legend',           xp: 800, check: t => t.level >= 50 },
  // (No Gold achievement: STARTING_MMR 1000 already sits in Gold II.)
  { id: 'rank_platinum', name: 'Platinum Club',   desc: 'Reach Platinum in any playlist',   title: 'Platinum',         xp: 300, check: t => t.peak_mmr >= RANK_MIN.Platinum },
  { id: 'rank_diamond',  name: 'Diamond Hands',   desc: 'Reach Diamond in any playlist',    title: 'Diamond',          xp: 500, check: t => t.peak_mmr >= RANK_MIN.Diamond },
  { id: 'rank_champion', name: 'Champion',        desc: 'Reach Champion in any playlist',   title: 'Champion',         xp: 1000, check: t => t.peak_mmr >= RANK_MIN.Champion },
];

const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
export function getAchievementById(id) { return ACHIEVEMENT_BY_ID.get(id) || null; }

/** All equippable titles: one per achievement. */
export const TITLES = ACHIEVEMENTS.map(a => a.title);
const TITLE_SET = new Set(TITLES);

// ---------- Boost trail colors ----------
// hex null = team default (orange flame). unlock: { level } | { achievement } | { rank }

export const BOOST_COLORS = [
  { id: 'default',  name: 'Classic Flame', hex: null,     unlock: null },
  { id: 'inferno',  name: 'Inferno',       hex: 0xff3322, unlock: { level: 3 } },
  { id: 'toxic',    name: 'Toxic',         hex: 0x66ff33, unlock: { level: 6 } },
  { id: 'royal',    name: 'Royal',         hex: 0xaa44ff, unlock: { level: 10 } },
  { id: 'ice',      name: 'Glacier',       hex: 0x88eeff, unlock: { level: 15 } },
  { id: 'sunset',   name: 'Sunset',        hex: 0xff44cc, unlock: { achievement: 'hat_trick' } },
  { id: 'plasma',   name: 'Plasma',        hex: 0xffffff, unlock: { achievement: 'streak_7' } },
  { id: 'gold',     name: '24 Karat',      hex: 0xffd700, unlock: { achievement: 'wins_50' } },
  { id: 'platinum', name: 'Platinum Fire', hex: 0x00ced1, unlock: { rank: 'Platinum' } },
  { id: 'diamond',  name: 'Diamond Dust',  hex: 0x9b59ff, unlock: { rank: 'Diamond' } },
  { id: 'champion', name: 'Champion Blaze', hex: 0xff2244, unlock: { rank: 'Champion' } },
];

const BOOST_BY_ID = new Map(BOOST_COLORS.map(b => [b.id, b]));
export function getBoostColorById(id) { return BOOST_BY_ID.get(id) || null; }

/**
 * Build the unlock context from a player_stats row + unlocked achievement ids.
 * @param {object} statsRow - { level, peak_mmr, mmr_1v1, mmr_2v2 }
 * @param {Iterable<string>} achievementIds
 */
export function getUnlockContext(statsRow, achievementIds) {
  const s = statsRow || {};
  const peak = Math.max(s.peak_mmr || 0, s.mmr_1v1 || 0, s.mmr_2v2 || 0);
  return {
    level: s.level || 0,
    peakMMR: peak,
    peakRank: getRankFromMMR(peak).name,
    achievements: achievementIds instanceof Set ? achievementIds : new Set(achievementIds || []),
  };
}

export function isBoostUnlocked(def, ctx) {
  if (!def) return false;
  const u = def.unlock;
  if (!u) return true;
  if (u.level !== undefined) return ctx.level >= u.level;
  if (u.achievement) return ctx.achievements.has(u.achievement);
  if (u.rank) return ctx.peakMMR >= (RANK_MIN[u.rank] || Infinity);
  return false;
}

export function isTitleUnlocked(title, ctx) {
  if (title === null || title === undefined || title === '') return true;
  if (!TITLE_SET.has(title)) return false;
  for (const a of ACHIEVEMENTS) {
    if (a.title === title && ctx.achievements.has(a.id)) return true;
  }
  return false;
}

/** Human-readable unlock requirement for a boost color. */
export function describeUnlock(def) {
  const u = def && def.unlock;
  if (!u) return 'Unlocked';
  if (u.level !== undefined) return `Reach level ${u.level}`;
  if (u.achievement) {
    const a = getAchievementById(u.achievement);
    return a ? `Achievement: ${a.name}` : 'Achievement';
  }
  if (u.rank) return `Reach ${u.rank}`;
  return '';
}

/** Ids of every boost color unlocked in `ctx`. */
export function unlockedBoostIds(ctx) {
  return BOOST_COLORS.filter(b => isBoostUnlocked(b, ctx)).map(b => b.id);
}

// ---------- Loadout + variantConfig validation (server-side) ----------

/**
 * Validate a client-supplied loadout against the unlock context.
 * Returns { boost, title } with nulls for anything invalid/locked.
 */
export function validateLoadout(raw, ctx) {
  const out = { boost: null, title: null };
  if (raw && typeof raw.boost === 'string' && raw.boost.length <= 32) {
    const def = getBoostColorById(raw.boost);
    if (def && def.hex !== null && isBoostUnlocked(def, ctx)) out.boost = def.id;
  }
  if (raw && typeof raw.title === 'string' && raw.title.length <= 32) {
    if (TITLE_SET.has(raw.title) && isTitleUnlocked(raw.title, ctx)) out.title = raw.title;
  }
  return out;
}

const ROOF_STYLES = new Set(['coupe', 'convertible']);
const DOOR_STYLES = new Set(['normal', 'scissor']);
const MODEL_ID_RE = /^[a-z0-9-]{1,32}$/;

function cleanColor(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) ? v : null;
}

/**
 * Whitelist a client-supplied variantConfig and stamp the server-validated
 * loadout onto it (boostColor hex + title). Everything the other players
 * see comes through here, so nothing from the raw object survives unchecked.
 */
export function sanitizeVariantConfig(raw, loadout) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    modelId: (typeof r.modelId === 'string' && MODEL_ID_RE.test(r.modelId)) ? r.modelId : null,
    bodyColor: null, // always team-assigned client-side
    neonColor: cleanColor(r.neonColor),
    wheelAccentColor: cleanColor(r.wheelAccentColor),
    lightColor: cleanColor(r.lightColor),
    hasAero: !!r.hasAero,
    isLowered: !!r.isLowered,
    roofStyle: ROOF_STYLES.has(r.roofStyle) ? r.roofStyle : 'coupe',
    doorStyle: DOOR_STYLES.has(r.doorStyle) ? r.doorStyle : 'normal',
    hasPopupHeadlights: !!r.hasPopupHeadlights,
    boostColor: null,
    title: null,
  };
  if (out.neonColor === null) out.neonColor = 0x00ffff;
  if (out.wheelAccentColor === null) out.wheelAccentColor = 0x808080;
  if (out.lightColor === null) out.lightColor = 0xffffff;
  if (loadout) {
    const b = loadout.boost ? getBoostColorById(loadout.boost) : null;
    out.boostColor = b && b.hex !== null ? b.hex : null;
    out.title = (typeof loadout.title === 'string' && TITLE_SET.has(loadout.title)) ? loadout.title : null;
  }
  return out;
}
