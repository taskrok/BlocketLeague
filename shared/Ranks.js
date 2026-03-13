// ============================================
// Ranks — Shared rank definitions and MMR functions
// Compatible with both Node (server) and browser (client)
// ============================================

// Rank tiers with division MMR ranges
// Division III is lowest within a rank, Division I is highest
export const RANKS = [
  { name: 'Scrap',    divisions: [{ div: 'III', min: 0 }, { div: 'II', min: 80 }, { div: 'I', min: 120 }] },
  { name: 'Iron',     divisions: [{ div: 'III', min: 160 }, { div: 'II', min: 220 }, { div: 'I', min: 280 }] },
  { name: 'Bronze',   divisions: [{ div: 'III', min: 340 }, { div: 'II', min: 420 }, { div: 'I', min: 500 }] },
  { name: 'Silver',   divisions: [{ div: 'III', min: 580 }, { div: 'II', min: 680 }, { div: 'I', min: 780 }] },
  { name: 'Gold',     divisions: [{ div: 'III', min: 880 }, { div: 'II', min: 1000 }, { div: 'I', min: 1120 }] },
  { name: 'Platinum', divisions: [{ div: 'III', min: 1240 }, { div: 'II', min: 1380 }, { div: 'I', min: 1520 }] },
  { name: 'Diamond',  divisions: [{ div: 'III', min: 1660 }, { div: 'II', min: 1820 }, { div: 'I', min: 1980 }] },
  { name: 'Champion', divisions: [{ div: '', min: 2140 }] },
];

export const RANK_COLORS = {
  'Scrap': '#8B7355',
  'Iron': '#A0A0A0',
  'Bronze': '#CD7F32',
  'Silver': '#C0C0C0',
  'Gold': '#FFD700',
  'Platinum': '#00CED1',
  'Diamond': '#9B59FF',
  'Champion': '#FF4444',
};

// Flat sorted list of all division boundaries for progress calculation
const ALL_DIV_MINS = RANKS.flatMap(r => r.divisions.map(d => d.min)).sort((a, b) => a - b);

/**
 * Get rank info from an MMR value.
 * @param {number} mmr
 * @returns {{ name: string, division: string, color: string, fullName: string, min: number, max: number, progress: number }}
 */
export function getRankFromMMR(mmr) {
  let result = { name: 'Scrap', division: 'III', color: RANK_COLORS['Scrap'], fullName: 'Scrap III', min: 0 };
  for (const rank of RANKS) {
    for (const div of rank.divisions) {
      if (mmr >= div.min) {
        const divText = div.div ? ` ${div.div}` : '';
        result = {
          name: rank.name,
          division: div.div,
          color: RANK_COLORS[rank.name],
          fullName: `${rank.name}${divText}`,
          min: div.min,
        };
      }
    }
  }
  // Find the ceiling (next division's min, or Infinity for Champion)
  const currentIdx = ALL_DIV_MINS.indexOf(result.min);
  result.max = currentIdx < ALL_DIV_MINS.length - 1 ? ALL_DIV_MINS[currentIdx + 1] - 1 : Infinity;
  result.progress = result.max === Infinity ? 1.0 :
    (mmr - result.min) / (result.max - result.min + 1);
  return result;
}

/**
 * Calculate MMR change for a match result.
 * Uses a simplified Glicko-inspired model with uncertainty and streak modifiers.
 *
 * @param {number} playerMMR - Current player MMR
 * @param {number} opponentMMR - Opponent (or opposing team avg) MMR
 * @param {boolean} won - Whether the player won
 * @param {number} matchesPlayed - Total ranked matches played (for uncertainty)
 * @param {number} winStreak - Current win streak (before this match)
 * @param {number} lossStreak - Current loss streak (before this match)
 * @returns {number} MMR delta (positive for gain, negative for loss)
 */
export function calculateMMRDelta(playerMMR, opponentMMR, won, matchesPlayed, winStreak, lossStreak) {
  const BASE_K = 40;

  // Expected outcome (logistic curve, standard Elo)
  const expected = 1 / (1 + Math.pow(10, (opponentMMR - playerMMR) / 400));

  // Uncertainty multiplier (high early for placement, settles at 1.0)
  const uncertainty = Math.max(1.0, 2.5 - (matchesPlayed * 0.15));

  // Streak modifier — amplifies when player is clearly misranked
  const streak = won ? winStreak : lossStreak;
  let streakMod = 1.0;
  if (streak >= 5) streakMod = 1.5;
  else if (streak >= 4) streakMod = 1.3;
  else if (streak >= 3) streakMod = 1.15;

  const K = BASE_K * uncertainty * streakMod;
  const outcome = won ? 1.0 : 0.0;
  const delta = Math.round(K * (outcome - expected));

  return delta;
}

// Level titles by level range
const LEVEL_TITLES = [
  { min: 0,   title: 'Rookie' },
  { min: 10,  title: 'Semi-Pro' },
  { min: 20,  title: 'Pro' },
  { min: 30,  title: 'Veteran' },
  { min: 40,  title: 'Expert' },
  { min: 50,  title: 'Master' },
  { min: 60,  title: 'Legend' },
  { min: 70,  title: 'Rocketeer' },
  { min: 80,  title: 'Transcendent' },
  { min: 90,  title: 'Ultimate' },
  { min: 100, title: 'Blocket Lord' },
];

/**
 * Get the level title for a given level.
 * @param {number} level
 * @returns {string}
 */
export function getLevelTitle(level) {
  let title = 'Rookie';
  for (const entry of LEVEL_TITLES) {
    if (level >= entry.min) {
      title = entry.title;
    }
  }
  return title;
}

// XP reward values (shared between server and client)
export const XP_VALUES = {
  goal: 100,
  assist: 75,
  save: 80,
  shot: 30,
  win: 200,
  demo: 30,
  aerialGoal: 150,
  matchComplete: 75,
  // Bonus XP thresholds
  hatTrick: 100,       // 3+ goals
  playmaker: 75,       // 3+ assists
  savior: 75,          // 3+ saves
  mvp: 50,             // match MVP
  overtimeWin: 50,     // winning in overtime
};

/**
 * Calculate level from total XP.
 * level = floor(sqrt(totalXP / 200))
 */
export function calculateLevel(totalXP) {
  return Math.floor(Math.sqrt(totalXP / 200));
}

/**
 * XP required to reach a given level.
 * xpForLevel(L) = L * L * 200
 */
export function xpForLevel(level) {
  return level * level * 200;
}

// Starting MMR for new players
export const STARTING_MMR = 1000;

// Inactivity settings
export const INACTIVITY_DAYS = 30;
export const INACTIVITY_UNCERTAINTY = 1.5;
