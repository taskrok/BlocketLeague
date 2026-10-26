// ============================================
// Progression - Persistent player progression system
// XP/level stored server-side (SQLite), localStorage used as cache
// ============================================

import {
  XP_VALUES, calculateLevel, xpForLevel,
  getRankFromMMR, getLevelTitle,
} from '../../shared/Ranks.js';

const STORAGE_KEY = 'blocket-progression';

// Car unlock thresholds: { level: count of additional cars unlocked at that level }
// Total model count may vary; we define which indices are unlocked at each level.
const CAR_UNLOCK_LEVELS = [
  { level: 0, count: 5 },   // first 5 cars
  { level: 3, count: 3 },   // +3 at level 3
  { level: 5, count: 3 },   // +3 at level 5
  { level: 10, count: Infinity }, // all remaining at level 10
];

function getDefaultData() {
  return {
    stats: {
      goals: 0,
      assists: 0,
      saves: 0,
      shots: 0,
      wins: 0,
      losses: 0,
      matches: 0,
      playTime: 0,
      demos: 0,
      aerialGoals: 0,
    },
    xp: 0,
    level: 0,
    unlockedCars: [0, 1, 2, 3, 4],
    // Rank data (from server)
    mmr_1v1: 1000,
    mmr_2v2: 1000,
    rank1v1: null,
    rank2v2: null,
    levelTitle: 'Rookie',
    prestige: 0,
  };
}

export class Progression {
  constructor() {
    this._data = this._load();
    this._matchStartTime = null;
    this._pendingXP = []; // { label, amount } entries from current match
    this._lastRankChange = null; // store last match rank change for display
    // Set by the HUD results screen while it is visible; called when the
    // server's post-match progression event carries a rank change.
    this.onRankChange = null;
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const defaults = getDefaultData();
        // XP/level come from server now — only use cached values
        // if they were set by syncFromServer (not legacy localStorage)
        return {
          stats: { ...defaults.stats, ...parsed.stats },
          xp: parsed._serverSynced ? (parsed.xp || 0) : 0,
          level: parsed._serverSynced ? (parsed.level || 0) : 0,
          unlockedCars: defaults.unlockedCars,
          _serverSynced: parsed._serverSynced || false,
          mmr_1v1: parsed.mmr_1v1 || 1000,
          mmr_2v2: parsed.mmr_2v2 || 1000,
          rank1v1: parsed.rank1v1 || null,
          rank2v2: parsed.rank2v2 || null,
          levelTitle: parsed.levelTitle || 'Rookie',
          prestige: parsed.prestige || 0,
        };
      }
    } catch {}
    return getDefaultData();
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch {}
  }

  /**
   * Sync progression from server data (called on connect and after match).
   * Server is source of truth for XP/level/rank.
   */
  syncFromServer(serverData) {
    if (!serverData) return;
    if (typeof serverData.xp === 'number') {
      this._data.xp = serverData.xp;
    }
    if (typeof serverData.level === 'number') {
      this._data.level = serverData.level;
    }
    if (typeof serverData.mmr_1v1 === 'number') {
      this._data.mmr_1v1 = serverData.mmr_1v1;
    }
    if (typeof serverData.mmr_2v2 === 'number') {
      this._data.mmr_2v2 = serverData.mmr_2v2;
    }
    if (serverData.rank1v1) {
      this._data.rank1v1 = serverData.rank1v1;
    }
    if (serverData.rank2v2) {
      this._data.rank2v2 = serverData.rank2v2;
    }
    if (serverData.levelTitle) {
      this._data.levelTitle = serverData.levelTitle;
    }
    if (typeof serverData.prestige === 'number') {
      this._data.prestige = serverData.prestige;
    }

    // Store rank change data if present (from post-match progression emit)
    if (serverData.mmrDelta !== null && serverData.mmrDelta !== undefined) {
      this._lastRankChange = {
        mmrDelta: serverData.mmrDelta,
        mmrBefore: serverData.mmrBefore,
        mmrAfter: serverData.mmrAfter,
        rankBefore: serverData.rankBefore,
        rankAfter: serverData.rankAfter,
        rankColor: serverData.rankColor,
        xpEarned: serverData.xpEarned,
        matchMode: serverData.matchMode,
      };
    }

    this._data._serverSynced = true;
    this._data.unlockedCars = this.getUnlockedCarIndices(100);
    this._save();
    this.updateLobbyDisplay();

    if (this._lastRankChange && this.onRankChange) {
      this.onRankChange(this._lastRankChange);
    }
  }

  // --- Accessors ---

  get stats() { return this._data.stats; }
  get xp() { return this._data.xp; }
  get level() { return this._data.level; }
  get unlockedCars() { return this._data.unlockedCars; }
  get mmr1v1() { return this._data.mmr_1v1; }
  get mmr2v2() { return this._data.mmr_2v2; }
  get prestige() { return this._data.prestige; }

  /**
   * Calculate level from total XP.
   * Level = floor(sqrt(totalXP / 200))
   */
  static calculateLevel(totalXP) {
    return calculateLevel(totalXP);
  }

  /**
   * XP needed to reach a given level.
   */
  static xpForLevel(level) {
    return xpForLevel(level);
  }

  /**
   * Get progress toward next level as 0-1 fraction.
   */
  getLevelProgress() {
    const currentLevelXP = xpForLevel(this.level);
    const nextLevelXP = xpForLevel(this.level + 1);
    const range = nextLevelXP - currentLevelXP;
    if (range <= 0) return 1;
    return Math.min(1, (this.xp - currentLevelXP) / range);
  }

  /**
   * Get level title for current level.
   */
  getLevelTitle() {
    return this._data.levelTitle || getLevelTitle(this.level);
  }

  /**
   * Get rank display info for a given mode.
   * @param {string} mode - '1v1' or '2v2'
   * @returns {{ name, division, color, fullName, min, max, progress }}
   */
  getRankDisplay(mode = '1v1') {
    const mmr = mode === '2v2' ? this._data.mmr_2v2 : this._data.mmr_1v1;
    return getRankFromMMR(mmr);
  }

  /**
   * Get the last rank change data (after a match).
   */
  getLastRankChange() {
    return this._lastRankChange;
  }

  /**
   * Clear the last rank change data (after it has been displayed).
   */
  clearLastRankChange() {
    this._lastRankChange = null;
  }

  /**
   * Get unlocked car indices based on current level.
   */
  getUnlockedCarIndices(totalModelCount) {
    let unlocked = 0;
    for (const tier of CAR_UNLOCK_LEVELS) {
      if (this.level >= tier.level) {
        unlocked += tier.count;
      }
    }
    unlocked = Math.min(unlocked, totalModelCount);
    const indices = [];
    for (let i = 0; i < unlocked; i++) {
      indices.push(i);
    }
    return indices;
  }

  /**
   * Check if a specific car index is unlocked.
   */
  isCarUnlocked(index, totalModelCount) {
    return this.getUnlockedCarIndices(totalModelCount).includes(index);
  }

  /**
   * Get the level required to unlock a car at a given index.
   */
  getUnlockLevel(carIndex) {
    let cumulative = 0;
    for (const tier of CAR_UNLOCK_LEVELS) {
      cumulative += tier.count;
      if (carIndex < cumulative) {
        return tier.level;
      }
    }
    return 10; // fallback
  }

  // --- Match lifecycle ---

  startMatch() {
    this._matchStartTime = Date.now();
    this._pendingXP = [];
    this._lastRankChange = null;
  }

  /**
   * Record end-of-match stats from the performance tracker.
   * @param {object} playerStats - { goals, assists, saves, shots, demos, score }
   * @param {boolean} won - Whether the player won
   * @param {number} aerialGoals - Number of aerial goals scored
   * @param {object} extraData - { isMVP, isOvertimeWin }
   */
  endMatch(playerStats, won, aerialGoals = 0, extraData = {}) {
    if (!playerStats) return;

    const xpBefore = this._data.xp;
    const levelBefore = this._data.level;
    const s = this._data.stats;
    s.goals += playerStats.goals || 0;
    s.assists += playerStats.assists || 0;
    s.saves += playerStats.saves || 0;
    s.shots += playerStats.shots || 0;
    s.demos += playerStats.demos || 0;
    s.aerialGoals += aerialGoals;
    s.matches += 1;

    if (won) {
      s.wins += 1;
    } else {
      s.losses += 1;
    }

    // Play time
    if (this._matchStartTime) {
      const elapsed = (Date.now() - this._matchStartTime) / 60000; // minutes
      s.playTime += elapsed;
    }

    // Calculate XP breakdown
    this._pendingXP = [];
    if (playerStats.goals > 0) {
      this._pendingXP.push({ label: `Goals x${playerStats.goals}`, amount: playerStats.goals * XP_VALUES.goal });
    }
    if (playerStats.assists > 0) {
      this._pendingXP.push({ label: `Assists x${playerStats.assists}`, amount: playerStats.assists * XP_VALUES.assist });
    }
    if (playerStats.saves > 0) {
      this._pendingXP.push({ label: `Saves x${playerStats.saves}`, amount: playerStats.saves * XP_VALUES.save });
    }
    if (playerStats.shots > 0) {
      this._pendingXP.push({ label: `Shots x${playerStats.shots}`, amount: playerStats.shots * XP_VALUES.shot });
    }
    if (playerStats.demos > 0) {
      this._pendingXP.push({ label: `Demos x${playerStats.demos}`, amount: playerStats.demos * XP_VALUES.demo });
    }
    if (aerialGoals > 0) {
      this._pendingXP.push({ label: `Aerial Goals x${aerialGoals}`, amount: aerialGoals * XP_VALUES.aerialGoal });
    }
    if (won) {
      this._pendingXP.push({ label: 'Victory Bonus', amount: XP_VALUES.win });
    }
    this._pendingXP.push({ label: 'Match Complete', amount: XP_VALUES.matchComplete });

    // Bonus XP
    if ((playerStats.goals || 0) >= 3) {
      this._pendingXP.push({ label: 'Hat Trick', amount: XP_VALUES.hatTrick });
    }
    if ((playerStats.assists || 0) >= 3) {
      this._pendingXP.push({ label: 'Playmaker', amount: XP_VALUES.playmaker });
    }
    if ((playerStats.saves || 0) >= 3) {
      this._pendingXP.push({ label: 'Savior', amount: XP_VALUES.savior });
    }
    if (extraData.isMVP) {
      this._pendingXP.push({ label: 'MVP', amount: XP_VALUES.mvp });
    }
    if (extraData.isOvertimeWin) {
      this._pendingXP.push({ label: 'Overtime Win', amount: XP_VALUES.overtimeWin });
    }

    // Apply XP
    const totalXP = this._pendingXP.reduce((sum, e) => sum + e.amount, 0);
    this._data.xp += totalXP;
    this._data.level = calculateLevel(this._data.xp);
    this._data.levelTitle = getLevelTitle(this._data.level);

    // Update unlocked cars
    this._data.unlockedCars = this.getUnlockedCarIndices(100); // generous max

    this._save();
    return {
      entries: this._pendingXP,
      totalXP,
      newLevel: this._data.level,
      xpBefore,
      levelBefore,
      xpAfter: this._data.xp,
    };
  }

  // --- Lobby UI helpers ---

  /**
   * Create the level badge HTML string for the lobby or HUD.
   */
  getLevelBadgeHTML() {
    return `<span class="level-badge">LVL ${this.level}</span>`;
  }

  /**
   * Create a rank badge HTML string.
   * @param {string} mode - '1v1' or '2v2'
   */
  getRankBadgeHTML(mode = '1v1') {
    const rank = this.getRankDisplay(mode);
    return `<span class="rank-badge" style="color:${rank.color};border-color:${rank.color}40">${rank.fullName.toUpperCase()}</span>`;
  }

  /**
   * Create and return a DOM element for the lobby XP display with rank.
   */
  createLobbyXPDisplay() {
    const wrapper = document.createElement('div');
    wrapper.id = 'lobby-xp-display';
    Object.assign(wrapper.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '4px', marginBottom: '8px',
    });

    // Rank badge
    const rankBadge = document.createElement('div');
    rankBadge.id = 'lobby-rank-badge';
    Object.assign(rankBadge.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '11px', fontWeight: '700',
      letterSpacing: '2px',
      padding: '2px 10px',
      borderRadius: '4px',
      border: '1px solid',
      marginBottom: '2px',
    });
    this._updateRankBadgeElement(rankBadge);
    wrapper.appendChild(rankBadge);

    // Level + title
    const levelLabel = document.createElement('div');
    Object.assign(levelLabel.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '13px', fontWeight: '700',
      color: '#00ffff', letterSpacing: '2px',
      textShadow: '0 0 10px rgba(0, 255, 255, 0.4)',
    });
    const prestigePrefix = this.prestige > 0 ? '\u2605'.repeat(Math.min(this.prestige, 10)) + ' ' : '';
    levelLabel.textContent = `${prestigePrefix}LVL ${this.level} - ${this.getLevelTitle()}`;
    levelLabel.id = 'lobby-level-label';
    wrapper.appendChild(levelLabel);

    const barOuter = document.createElement('div');
    Object.assign(barOuter.style, {
      width: '160px', height: '6px',
      background: 'rgba(255, 255, 255, 0.1)',
      borderRadius: '3px', overflow: 'hidden',
      border: '1px solid rgba(0, 255, 255, 0.2)',
    });
    const barFill = document.createElement('div');
    const progress = this.getLevelProgress();
    Object.assign(barFill.style, {
      width: `${Math.round(progress * 100)}%`, height: '100%',
      background: 'linear-gradient(90deg, #00ffff, #00ff88)',
      borderRadius: '3px',
      transition: 'width 0.5s',
    });
    barFill.id = 'lobby-xp-fill';
    barOuter.appendChild(barFill);
    wrapper.appendChild(barOuter);

    return wrapper;
  }

  _updateRankBadgeElement(el) {
    const rank = this.getRankDisplay('1v1');
    el.style.color = rank.color;
    el.style.borderColor = rank.color + '40';
    el.style.background = rank.color + '15';
    el.style.textShadow = `0 0 8px ${rank.color}40`;
    el.textContent = rank.fullName.toUpperCase();

    // Champion pulsing glow
    if (rank.name === 'Champion') {
      el.style.animation = 'champion-glow 2s ease-in-out infinite';
    } else {
      el.style.animation = '';
    }
  }

  /**
   * Update the lobby XP display if it exists.
   */
  updateLobbyDisplay() {
    const label = document.getElementById('lobby-level-label');
    if (label) {
      const prestigePrefix = this.prestige > 0 ? '\u2605'.repeat(Math.min(this.prestige, 10)) + ' ' : '';
      label.textContent = `${prestigePrefix}LVL ${this.level} - ${this.getLevelTitle()}`;
    }
    const fill = document.getElementById('lobby-xp-fill');
    if (fill) fill.style.width = `${Math.round(this.getLevelProgress() * 100)}%`;

    const rankBadge = document.getElementById('lobby-rank-badge');
    if (rankBadge) {
      this._updateRankBadgeElement(rankBadge);
    }
  }

  /**
   * Create a HUD level badge element for in-game display.
   */
  createHUDLevelBadge() {
    const badge = document.createElement('div');
    badge.id = 'hud-level-badge';
    Object.assign(badge.style, {
      position: 'fixed',
      top: '8px', left: '8px',
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '11px', fontWeight: '700',
      color: '#00ffff', letterSpacing: '2px',
      opacity: '0.6',
      zIndex: '100',
      pointerEvents: 'none',
      textShadow: '0 0 8px rgba(0, 255, 255, 0.3)',
    });
    badge.textContent = `LVL ${this.level}`;
    return badge;
  }
}

// Singleton instance
export const progression = new Progression();
