// ============================================
// Progression - Persistent player progression system
// XP/level stored server-side (SQLite), localStorage used as cache
// ============================================

const STORAGE_KEY = 'blocket-progression';

// XP rewards
const XP_VALUES = {
  goal: 100,
  assist: 75,
  save: 60,
  shot: 20,
  win: 200,
  demo: 50,
  aerialGoal: 150,
  matchComplete: 50,
};

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
  };
}

export class Progression {
  constructor() {
    this._data = this._load();
    this._matchStartTime = null;
    this._pendingXP = []; // { label, amount } entries from current match
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Merge with defaults in case new fields were added
        const defaults = getDefaultData();
        return {
          stats: { ...defaults.stats, ...parsed.stats },
          xp: parsed.xp || 0,
          level: parsed.level || 0,
          unlockedCars: parsed.unlockedCars || defaults.unlockedCars,
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
   * Sync progression from server data (called on connect).
   * Server is source of truth for XP/level.
   */
  syncFromServer(serverData) {
    if (!serverData) return;
    if (typeof serverData.xp === 'number') {
      this._data.xp = serverData.xp;
    }
    if (typeof serverData.level === 'number') {
      this._data.level = serverData.level;
    }
    this._data.unlockedCars = this.getUnlockedCarIndices(100);
    this._save();
    this.updateLobbyDisplay();
  }

  // --- Accessors ---

  get stats() { return this._data.stats; }
  get xp() { return this._data.xp; }
  get level() { return this._data.level; }
  get unlockedCars() { return this._data.unlockedCars; }

  /**
   * Calculate level from total XP.
   * Level = floor(sqrt(totalXP / 100))
   */
  static calculateLevel(totalXP) {
    return Math.floor(Math.sqrt(totalXP / 100));
  }

  /**
   * XP needed to reach a given level.
   */
  static xpForLevel(level) {
    return level * level * 100;
  }

  /**
   * Get progress toward next level as 0-1 fraction.
   */
  getLevelProgress() {
    const currentLevelXP = Progression.xpForLevel(this.level);
    const nextLevelXP = Progression.xpForLevel(this.level + 1);
    const range = nextLevelXP - currentLevelXP;
    if (range <= 0) return 1;
    return Math.min(1, (this.xp - currentLevelXP) / range);
  }

  /**
   * Get unlocked car indices based on current level.
   * @param {number} totalModelCount - Total number of available car models
   * @returns {number[]} Array of unlocked model indices
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
  }

  /**
   * Record end-of-match stats from the performance tracker.
   * @param {object} playerStats - { goals, assists, saves, shots, demos, score }
   * @param {boolean} won - Whether the player won
   * @param {number} aerialGoals - Number of aerial goals scored
   */
  endMatch(playerStats, won, aerialGoals = 0) {
    if (!playerStats) return;

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

    // Apply XP
    const totalXP = this._pendingXP.reduce((sum, e) => sum + e.amount, 0);
    this._data.xp += totalXP;
    this._data.level = Progression.calculateLevel(this._data.xp);

    // Update unlocked cars
    // We keep a list but it's dynamically calculated from level now
    this._data.unlockedCars = this.getUnlockedCarIndices(100); // generous max

    this._save();
    return { entries: this._pendingXP, totalXP, newLevel: this._data.level };
  }

  // --- XP Screen UI ---

  /**
   * Show post-match XP breakdown overlay. Returns a Promise that resolves after the display.
   * @param {object} xpResult - { entries, totalXP, newLevel } from endMatch()
   * @returns {Promise}
   */
  showXPScreen(xpResult) {
    if (!xpResult || !xpResult.entries || xpResult.entries.length === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const container = document.getElementById('game-container') || document.body;

      const overlay = document.createElement('div');
      overlay.id = 'xp-screen';
      Object.assign(overlay.style, {
        position: 'fixed',
        top: '0', left: '0', width: '100%', height: '100%',
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        zIndex: '400',
        fontFamily: "'Orbitron', sans-serif",
        opacity: '0',
        transition: 'opacity 0.4s',
      });

      // Title
      const title = document.createElement('div');
      Object.assign(title.style, {
        fontSize: '28px', fontWeight: '800', color: '#00ffff',
        letterSpacing: '4px', marginBottom: '24px',
        textShadow: '0 0 20px rgba(0, 255, 255, 0.5)',
      });
      title.textContent = 'MATCH REWARDS';
      overlay.appendChild(title);

      // XP entries
      const list = document.createElement('div');
      Object.assign(list.style, {
        display: 'flex', flexDirection: 'column', gap: '8px',
        marginBottom: '24px', minWidth: '280px',
      });

      for (const entry of xpResult.entries) {
        const row = document.createElement('div');
        Object.assign(row.style, {
          display: 'flex', justifyContent: 'space-between',
          padding: '6px 16px',
          background: 'rgba(0, 255, 255, 0.05)',
          borderRadius: '4px',
          fontSize: '14px', letterSpacing: '1px',
        });
        const label = document.createElement('span');
        label.style.color = 'rgba(255, 255, 255, 0.8)';
        label.textContent = entry.label;
        const amount = document.createElement('span');
        amount.style.color = '#00ff88';
        amount.style.fontWeight = '700';
        amount.textContent = `+${entry.amount} XP`;
        row.appendChild(label);
        row.appendChild(amount);
        list.appendChild(row);
      }
      overlay.appendChild(list);

      // Total
      const totalRow = document.createElement('div');
      Object.assign(totalRow.style, {
        fontSize: '20px', fontWeight: '800', color: '#00ff88',
        letterSpacing: '2px', marginBottom: '20px',
        textShadow: '0 0 16px rgba(0, 255, 136, 0.5)',
      });
      totalRow.textContent = `TOTAL: +${xpResult.totalXP} XP`;
      overlay.appendChild(totalRow);

      // Level + XP bar
      const levelRow = document.createElement('div');
      Object.assign(levelRow.style, {
        display: 'flex', alignItems: 'center', gap: '12px',
        marginBottom: '8px',
      });
      const levelLabel = document.createElement('span');
      Object.assign(levelLabel.style, {
        fontSize: '16px', fontWeight: '700', color: '#fff',
        letterSpacing: '2px',
      });
      levelLabel.textContent = `LEVEL ${this.level}`;
      levelRow.appendChild(levelLabel);
      overlay.appendChild(levelRow);

      // XP progress bar
      const barOuter = document.createElement('div');
      Object.assign(barOuter.style, {
        width: '280px', height: '12px',
        background: 'rgba(255, 255, 255, 0.1)',
        borderRadius: '6px', overflow: 'hidden',
        border: '1px solid rgba(0, 255, 255, 0.3)',
      });
      const barFill = document.createElement('div');
      const progress = this.getLevelProgress();
      Object.assign(barFill.style, {
        width: '0%', height: '100%',
        background: 'linear-gradient(90deg, #00ffff, #00ff88)',
        borderRadius: '6px',
        transition: 'width 1.5s ease-out',
      });
      barOuter.appendChild(barFill);
      overlay.appendChild(barOuter);

      // XP text below bar
      const xpText = document.createElement('div');
      Object.assign(xpText.style, {
        fontSize: '11px', color: 'rgba(255, 255, 255, 0.5)',
        marginTop: '6px', letterSpacing: '1px',
      });
      const nextLevelXP = Progression.xpForLevel(this.level + 1);
      xpText.textContent = `${this.xp} / ${nextLevelXP} XP`;
      overlay.appendChild(xpText);

      container.appendChild(overlay);

      // Fade in
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        // Animate XP bar
        setTimeout(() => {
          barFill.style.width = `${Math.round(progress * 100)}%`;
        }, 200);
      });

      // Auto-dismiss after 3 seconds
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => {
          if (overlay.parentNode) overlay.remove();
          resolve();
        }, 400);
      }, 3000);
    });
  }

  // --- Lobby UI helpers ---

  /**
   * Create the level badge HTML string for the lobby or HUD.
   */
  getLevelBadgeHTML() {
    return `<span class="level-badge">LVL ${this.level}</span>`;
  }

  /**
   * Create and return a DOM element for the lobby XP display.
   */
  createLobbyXPDisplay() {
    const wrapper = document.createElement('div');
    wrapper.id = 'lobby-xp-display';
    Object.assign(wrapper.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '4px', marginBottom: '8px',
    });

    const levelLabel = document.createElement('div');
    Object.assign(levelLabel.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '13px', fontWeight: '700',
      color: '#00ffff', letterSpacing: '2px',
      textShadow: '0 0 10px rgba(0, 255, 255, 0.4)',
    });
    levelLabel.textContent = `LEVEL ${this.level}`;
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

  /**
   * Update the lobby XP display if it exists.
   */
  updateLobbyDisplay() {
    const label = document.getElementById('lobby-level-label');
    if (label) label.textContent = `LEVEL ${this.level}`;
    const fill = document.getElementById('lobby-xp-fill');
    if (fill) fill.style.width = `${Math.round(this.getLevelProgress() * 100)}%`;
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
