// ============================================
// HUD - Heads-up display management
// ============================================

import { CAR, GAME } from '../../shared/constants.js';
import { progression } from './Progression.js';
import { xpForLevel, getLevelTitle } from '../../shared/Ranks.js';

// Gamepad buttons that drive the post-match results screen. A/B stay free for
// the celebration phase (jump/boost), so the menu uses Start / Back instead.
const GP_BTN_BACK = 8;
const GP_BTN_START = 9;

const RANDOM_NAMES = [
  'Donut','Penguin','Stumpy','Whicker','Shadow','Howard','Wilshire','Darling',
  'Disco','Jack','The Bear','Sneak','The Big L','Whisp','Wheezy','Crazy',
  'Goat','Pirate','Saucy','Hambone','Butcher','Walla Walla','Snake','Caboose',
  'Sleepy','Killer','Stompy','Mopey','Dopey','Weasel','Ghost','Dasher',
  'Grumpy','Hollywood','Tooth','Noodle','King','Cupid','Prancer',
];

export class HUD {
  constructor() {
    this.timerEl = document.getElementById('timer');
    this.scoreBlueEl = document.getElementById('score-blue');
    this.scoreOrangeEl = document.getElementById('score-orange');
    this.boostArc = document.getElementById('boost-arc');
    this.boostText = document.querySelector('.boost-text');
    this.speedFill = document.getElementById('speed-fill');
    this.countdownEl = document.getElementById('countdown');
    this.goalTextEl = document.getElementById('goal-text');
    this.controlsHint = document.getElementById('controls-hint');
    this.statusText = document.getElementById('status-text');
    this.demoText = document.getElementById('demo-text');
    this.hudTop = document.getElementById('hud-top');

    // Boost meter constants
    this.boostCircumference = 2 * Math.PI * 52; // r=52 from SVG
    this.boostArc.style.strokeDasharray = this.boostCircumference;

    // Player names for scoreboard
    this._playerNames = [];
    // Team names for 2v2 (blue, orange)
    this._teamNames = { blue: 'BLUE', orange: 'ORANGE' };

    // Ping display (created dynamically for multiplayer)
    this.pingEl = null;

    // Track active timeouts so we can clear them on reset/destroy
    this._timeouts = [];

    // Post-match results screen (see showMatchEnd). main.js wires the
    // callbacks; the screen only offers "play again" when onPlayAgain is set.
    this.onBackToLobby = null;
    this.onPlayAgain = null;
    this.playAgainLabel = 'Play Again';
    this._resultsEl = null;
    this._resultsPrimaryBtn = null;
    this._resultsSecondaryBtn = null;
    this._resultsRankEl = null;
    this._resultsKeyHandler = null;
    this._resultsCountRaf = null;
    this._autoReturnTimer = null;
    this._autoReturnLeft = 0;
    this._lastAutoReturnText = null;
    this._gpPrevStart = false;
    this._gpPrevBack = false;

    // Dirty-check caches: these updaters run every frame, so only touch the
    // DOM when the displayed value actually changes.
    this._lastTimerText = null;
    this._lastBlueScore = null;
    this._lastOrangeScore = null;
    this._lastBoostOffset = null;
    this._lastBoostText = null;
    this._lastBoostStroke = null;
    this._lastSpeedPct = null;
    this._lastPing = null;
    this._lastPingColor = null;
    this._liveScoreboardVisible = false;
    this._liveScoreboardKey = null;
    this._liveScoreboardTime = 0;

    // Hide controls hint after 8 seconds
    this._addTimeout(() => {
      if (this.controlsHint) {
        this.controlsHint.classList.add('hidden');
      }
    }, 8000);
  }

  _addTimeout(fn, ms) {
    const id = setTimeout(() => {
      fn();
      this._timeouts = this._timeouts.filter(t => t !== id);
    }, ms);
    this._timeouts.push(id);
  }

  _clearTimeouts() {
    for (const id of this._timeouts) {
      clearTimeout(id);
    }
    this._timeouts = [];
  }

  updateTimer(secondsRemaining) {
    const mins = Math.floor(secondsRemaining / 60);
    const secs = Math.floor(secondsRemaining % 60);
    const text = `${mins}:${secs.toString().padStart(2, '0')}`;
    if (text === this._lastTimerText) return;
    this._lastTimerText = text;
    this.timerEl.textContent = text;
  }

  updateScore(blueScore, orangeScore) {
    if (blueScore !== this._lastBlueScore) {
      this._lastBlueScore = blueScore;
      this.scoreBlueEl.textContent = blueScore;
    }
    if (orangeScore !== this._lastOrangeScore) {
      this._lastOrangeScore = orangeScore;
      this.scoreOrangeEl.textContent = orangeScore;
    }
  }

  updateBoost(boostAmount) {
    const pct = boostAmount / CAR.MAX_BOOST;
    // Round to 0.1px — finer changes are invisible on a r=52 arc
    const offset = Math.round(this.boostCircumference * (1 - pct) * 10) / 10;
    if (offset !== this._lastBoostOffset) {
      this._lastBoostOffset = offset;
      this.boostArc.style.strokeDashoffset = offset;
    }

    const text = Math.round(boostAmount);
    if (text !== this._lastBoostText) {
      this._lastBoostText = text;
      this.boostText.textContent = text;
    }

    // Color shift: orange when low, golden when high
    const stroke = pct > 0.5 ? '#ff8800' : pct > 0.2 ? '#ff6600' : '#ff3300';
    if (stroke !== this._lastBoostStroke) {
      this._lastBoostStroke = stroke;
      this.boostArc.style.stroke = stroke;
    }
  }

  updateSpeed(speed, maxSpeed) {
    // Round to 0.1% — sub-pixel on any realistic bar width
    const pct = Math.round(Math.min(speed / maxSpeed * 100, 100) * 10) / 10;
    if (pct === this._lastSpeedPct) return;
    this._lastSpeedPct = pct;
    this.speedFill.style.width = `${pct}%`;
  }

  showCountdown(number) {
    this.countdownEl.textContent = number === 0 ? 'GO!' : number;
    this.countdownEl.style.opacity = '1';
    this.countdownEl.style.transform = 'scale(1)';

    this._addTimeout(() => {
      this.countdownEl.style.opacity = '0';
    }, 800);
  }

  showVsBanner(blueTeamName, orangeTeamName) {
    if (this._vsBanner) this._vsBanner.remove();
    const el = document.createElement('div');
    el.id = 'vs-banner';
    Object.assign(el.style, {
      position: 'fixed', top: '18%', left: '50%', transform: 'translateX(-50%)',
      zIndex: '200', textAlign: 'center', pointerEvents: 'none',
      fontFamily: "'Rajdhani', 'Segoe UI', Arial, sans-serif",
      opacity: '0', transition: 'opacity 0.5s',
    });
    el.innerHTML = `
      <div style="font-size:32px;font-weight:800;letter-spacing:3px;text-transform:uppercase">
        <span style="color:#0088ff;text-shadow:0 0 20px rgba(0,136,255,0.5)">${blueTeamName}</span>
        <span style="color:rgba(255,255,255,0.4);font-size:20px;margin:0 12px;vertical-align:middle">VS</span>
        <span style="color:#ff6600;text-shadow:0 0 20px rgba(255,102,0,0.5)">${orangeTeamName}</span>
      </div>
    `;
    document.getElementById('game-container').appendChild(el);
    this._vsBanner = el;

    // Fade in
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    // Fade out after 3s
    this._addTimeout(() => {
      el.style.opacity = '0';
      this._addTimeout(() => { if (el.parentNode) el.remove(); }, 600);
    }, 3000);
  }

  showGoalScored(team, scorerName = null) {
    const color = team === 'blue' ? '#0088ff' : '#ff6600';
    if (scorerName) {
      this.goalTextEl.innerHTML = `GOAL!<div style="font-size:18px;margin-top:6px;letter-spacing:2px;opacity:0.85">${scorerName}</div>`;
    } else {
      this.goalTextEl.textContent = 'GOAL!';
    }
    this.goalTextEl.style.color = color;
    this.goalTextEl.style.textShadow = `0 0 40px ${color}, 0 0 80px ${color}`;
    this.goalTextEl.style.opacity = '1';

    this._addTimeout(() => {
      this.goalTextEl.style.opacity = '0';
    }, 2000);
  }

  showOvertime() {
    this.timerEl.textContent = 'OVERTIME';
    this._lastTimerText = 'OVERTIME';
    this.timerEl.style.color = '#ff3300';
    this.timerEl.style.textShadow = '0 0 20px rgba(255, 51, 0, 0.7)';
  }

  /**
   * Post-match results screen: outcome, score, per-player stats, XP rewards
   * and the next-action buttons. Replaces the old scoreboard + separate XP
   * overlay so everything a player wants after the whistle is on one panel.
   * @param {object} [opts]
   * @param {number} [opts.localIdx]   slot of the local player (highlights the row)
   * @param {string} [opts.localTeam]  'blue' | 'orange' (VICTORY / DEFEAT header)
   * @param {object} [opts.xpResult]   return value of progression.endMatch()
   * @param {boolean} [opts.showRank]  listen for the server rank change (online)
   */
  showMatchEnd(blueScore, orangeScore, stats, mvpIdx, maxPlayers, opts = {}) {
    this.goalTextEl.style.opacity = '0';
    this.showReplayIndicator(false);
    this.hideLiveScoreboard();
    if (this.hudTop) this.hudTop.style.opacity = '1';
    this._showResults(blueScore, orangeScore, stats || null, mvpIdx, maxPlayers || (stats ? stats.length : 2), opts);
  }

  showDemolished() {
    if (!this.demoText) return;
    this.demoText.textContent = 'DEMOLISHED!';
    this.demoText.style.opacity = '1';
    this._addTimeout(() => {
      this.demoText.style.opacity = '0';
    }, 1500);
  }

  updatePing(rttMs) {
    if (!this.pingEl) {
      this.pingEl = document.createElement('div');
      Object.assign(this.pingEl.style, {
        position: 'fixed',
        top: '8px',
        right: '8px',
        color: '#0ff',
        fontFamily: 'monospace',
        fontSize: '12px',
        opacity: '0.7',
        zIndex: '100',
        pointerEvents: 'none',
      });
      document.body.appendChild(this.pingEl);
    }
    const ping = Math.round(rttMs);
    if (ping === this._lastPing) return;
    this._lastPing = ping;
    const color = ping < 60 ? '#0f0' : ping < 120 ? '#ff0' : '#f00';
    if (color !== this._lastPingColor) {
      this._lastPingColor = color;
      this.pingEl.style.color = color;
    }
    this.pingEl.textContent = `${ping}ms`;
  }

  showReplayIndicator(show, scorerName = null) {
    if (show) {
      if (this._replayEl) return; // already showing
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'fixed',
        top: '120px',
        left: '50%',
        transform: 'translateX(-50%)',
        textAlign: 'center',
        zIndex: '200',
        pointerEvents: 'none',
      });
      const scorerHtml = scorerName ? `
        <div style="
          font-family: 'Orbitron', sans-serif;
          font-size: 18px;
          font-weight: 700;
          color: rgba(255,255,255,0.85);
          letter-spacing: 3px;
          margin-bottom: 4px;
          text-shadow: 0 0 16px rgba(255,255,255,0.5);
        ">${scorerName}</div>` : '';
      el.innerHTML = `
        ${scorerHtml}
        <div style="
          font-family: 'Orbitron', sans-serif;
          font-size: 28px;
          font-weight: 700;
          color: #fff;
          text-shadow: 0 0 20px rgba(255,255,255,0.8), 0 0 40px rgba(255,255,255,0.4);
          letter-spacing: 6px;
        ">REPLAY</div>
        <div style="
          font-family: 'Orbitron', sans-serif;
          font-size: 13px;
          color: rgba(255,255,255,0.5);
          margin-top: 8px;
          letter-spacing: 2px;
        ">Press any key to skip</div>
      `;
      document.body.appendChild(el);
      this._replayEl = el;
    } else {
      if (this._replayEl) {
        this._replayEl.remove();
        this._replayEl = null;
      }
    }
  }

  showStatus(msg) {
    if (!this.statusText) return;
    this.statusText.textContent = msg;
    this.statusText.style.opacity = msg ? '1' : '0';
  }

  /**
   * Persistent "MUTATOR: NAME" pill under the scoreboard for offline mutator
   * matches. Built once per match (static text, no per-frame writes) and
   * removed by reset().
   */
  showMutatorBadge(name) {
    if (!this.hudTop) return;
    if (!this._mutatorBadge) {
      this._mutatorBadge = document.createElement('div');
      this._mutatorBadge.id = 'mutator-badge';
      this.hudTop.appendChild(this._mutatorBadge);
    }
    this._mutatorBadge.textContent = name;
    this._mutatorBadge.style.display = '';
  }

  showLiveScoreboard(blueScore, orangeScore, stats, maxPlayers, pings) {
    if (!stats) return;
    const half = Math.floor(maxPlayers / 2);
    const hasPings = pings && pings.length >= maxPlayers;

    // Create element once, then update contents
    if (!this._liveScoreboardEl) {
      const el = document.createElement('div');
      el.id = 'live-scoreboard';
      this._liveScoreboardEl = el;
      const container = document.getElementById('game-container');
      (container || document.body).appendChild(el);
    }

    const el = this._liveScoreboardEl;
    if (!this._liveScoreboardVisible) {
      this._liveScoreboardVisible = true;
      el.style.display = '';
      if (this.hudTop) this.hudTop.style.opacity = '0';
    }

    // Only rebuild the table when its inputs changed, and at most ~5Hz
    // (pings drift continuously; stats change rarely).
    const now = performance.now();
    if (this._liveScoreboardKey !== null && now - this._liveScoreboardTime < 200) return;

    let key = `${blueScore}|${orangeScore}|${maxPlayers}|${hasPings ? 1 : 0}`;
    for (let i = 0; i < maxPlayers; i++) {
      const s = stats[i];
      if (s) key += `|${s.goals},${s.assists},${s.saves},${s.shots},${s.demos},${s.score}`;
      else key += '|-';
      if (hasPings) key += `,${Math.round(pings[i])}`;
      key += `,${this._getPlayerLabel(i, maxPlayers)}`;
    }
    if (key === this._liveScoreboardKey) return;
    this._liveScoreboardKey = key;
    this._liveScoreboardTime = now;

    const cols = hasPings ? 8 : 7;
    const pingHeader = hasPings ? '<th class="sb-ping-col">Ping</th>' : '';

    let html = `<table class="scoreboard-table live">
      <thead><tr>
        <th class="sb-player-col">Player</th>
        <th>G</th><th>A</th><th>Sv</th><th>Sh</th><th>D</th><th class="sb-score-col">Pts</th>${pingHeader}
      </tr></thead><tbody>`;

    for (let i = 0; i < half; i++) {
      html += this._liveStatRow(i, stats[i], maxPlayers, 'blue', hasPings ? pings[i] : null);
    }
    html += `<tr class="scoreboard-separator"><td colspan="${cols}"><div class="sb-sep-line"></div></td></tr>`;
    for (let i = half; i < maxPlayers; i++) {
      html += this._liveStatRow(i, stats[i], maxPlayers, 'orange', hasPings ? pings[i] : null);
    }
    html += '</tbody></table>';

    // Score header
    el.innerHTML = `<div class="live-score-row"><span class="sb-blue">${blueScore}</span> <span class="sb-dash">-</span> <span class="sb-orange">${orangeScore}</span></div>${html}`;
  }

  _liveStatRow(idx, s, maxPlayers, team, ping) {
    const label = this._getPlayerLabel(idx, maxPlayers);
    const pingCell = ping !== null ? `<td class="sb-ping">${this._pingText(ping)}</td>` : '';
    return `<tr class="scoreboard-row ${team}"><td class="sb-player-col">${label}</td><td>${s.goals}</td><td>${s.assists}</td><td>${s.saves}</td><td>${s.shots}</td><td>${s.demos}</td><td class="sb-score">${s.score}</td>${pingCell}</tr>`;
  }

  _pingText(ms) {
    const v = Math.round(ms);
    const color = v < 60 ? '#0f0' : v < 120 ? '#ff0' : '#f00';
    return `<span style="color:${color}">${v}ms</span>`;
  }

  hideLiveScoreboard() {
    if (!this._liveScoreboardVisible) return;
    this._liveScoreboardVisible = false;
    if (this._liveScoreboardEl) {
      this._liveScoreboardEl.style.display = 'none';
    }
    if (this.hudTop) this.hudTop.style.opacity = '1';
  }

  _showResults(blueScore, orangeScore, stats, mvpIdx, maxPlayers, opts) {
    this._removeResults();

    const localIdx = typeof opts.localIdx === 'number' ? opts.localIdx : 0;
    const blueWins = blueScore > orangeScore;
    const winTeam = blueWins ? 'blue' : 'orange';
    const half = Math.floor(maxPlayers / 2);
    const localTeam = opts.localTeam || (localIdx < half ? 'blue' : 'orange');
    const localWon = localTeam === winTeam;

    const root = document.createElement('div');
    root.id = 'match-results';
    root.className = localWon ? 'mr-win' : 'mr-loss';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Match results');
    root.tabIndex = -1;
    this._resultsActionFired = false;

    const panel = document.createElement('div');
    panel.className = 'mr-panel';
    root.appendChild(panel);

    // Outcome + winning team
    const outcome = document.createElement('div');
    outcome.className = `mr-outcome ${winTeam}`;
    outcome.textContent = localWon ? 'VICTORY' : 'DEFEAT';
    panel.appendChild(outcome);

    const sub = document.createElement('div');
    sub.className = 'mr-subtitle';
    sub.textContent = `${this._teamNames[winTeam]} WINS`;
    panel.appendChild(sub);

    const scoreRow = document.createElement('div');
    scoreRow.className = 'mr-score';
    scoreRow.innerHTML = `<span class="sb-blue">${blueScore}</span><span class="sb-dash">-</span><span class="sb-orange">${orangeScore}</span>`;
    panel.appendChild(scoreRow);

    const body = document.createElement('div');
    body.className = 'mr-body';
    panel.appendChild(body);

    // Stats table
    if (stats) {
      const tableWrap = document.createElement('div');
      tableWrap.className = 'mr-table-wrap';
      const table = document.createElement('table');
      table.className = 'scoreboard-table mr-table';
      table.innerHTML = `<thead><tr>
        <th class="sb-player-col">Player</th>
        <th title="Goals">G</th><th title="Assists">A</th><th title="Saves">Sv</th>
        <th title="Shots">Sh</th><th title="Demolitions">D</th><th class="sb-score-col">Pts</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');
      for (let i = 0; i < half; i++) {
        tbody.appendChild(this._makeStatRow(i, stats[i], mvpIdx, maxPlayers, 'blue', i === localIdx));
      }
      const sepRow = document.createElement('tr');
      sepRow.className = 'scoreboard-separator';
      sepRow.innerHTML = '<td colspan="7"><div class="sb-sep-line"></div></td>';
      tbody.appendChild(sepRow);
      for (let i = half; i < maxPlayers; i++) {
        tbody.appendChild(this._makeStatRow(i, stats[i], mvpIdx, maxPlayers, 'orange', i === localIdx));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      if (typeof mvpIdx === 'number' && mvpIdx >= 0 && stats[mvpIdx]) {
        const mvp = document.createElement('div');
        mvp.className = 'mr-mvp-line';
        mvp.innerHTML = `<span class="sb-mvp">&#9733;</span> MVP <strong>${this._escape(this._getPlayerLabel(mvpIdx, maxPlayers))}</strong> &middot; ${stats[mvpIdx].score} pts`;
        tableWrap.appendChild(mvp);
      }
      body.appendChild(tableWrap);
    }

    // Rewards (XP) column
    if (opts.xpResult && opts.xpResult.entries && opts.xpResult.entries.length) {
      body.appendChild(this._buildRewards(opts.xpResult, !!opts.showRank));
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'mr-actions';
    if (this.onPlayAgain) {
      const primary = document.createElement('button');
      primary.className = 'lobby-btn mr-primary';
      primary.textContent = this.playAgainLabel || 'Play Again';
      primary.addEventListener('click', () => this._firePlayAgain());
      actions.appendChild(primary);
      this._resultsPrimaryBtn = primary;
    }
    const secondary = document.createElement('button');
    secondary.className = 'lobby-btn lobby-btn-back mr-secondary';
    secondary.textContent = 'Back to Lobby';
    secondary.addEventListener('click', () => this._fireBackToLobby());
    actions.appendChild(secondary);
    this._resultsSecondaryBtn = secondary;
    panel.appendChild(actions);

    // Input hints (keyboard + gamepad); hidden on coarse-pointer devices via CSS
    const hints = document.createElement('div');
    hints.className = 'mr-hints';
    const hasPad = !!(navigator.getGamepads && Array.from(navigator.getGamepads()).some(Boolean));
    let hintHtml = '';
    if (this.onPlayAgain) {
      hintHtml += `<span><kbd>Enter</kbd>${hasPad ? '<kbd class="mr-kbd-pad">Start</kbd>' : ''} ${this._escape(this.playAgainLabel || 'Play Again')}</span>`;
    }
    hintHtml += hasPad ? '<span><kbd class="mr-kbd-pad">Back</kbd> Lobby</span>' : '<span><kbd>Esc</kbd> Settings</span>';
    hintHtml += '<span class="mr-hint-celebrate">Jump &amp; boost to celebrate</span>';
    hints.innerHTML = hintHtml;
    panel.appendChild(hints);

    const container = document.getElementById('game-container');
    (container || document.body).appendChild(root);
    this._resultsEl = root;

    // Keyboard: Enter = primary action. Esc is left to the settings panel.
    this._resultsKeyHandler = (e) => {
      if (e.key === 'Enter' && this._resultsPrimaryBtn && !e.repeat) {
        e.preventDefault();
        this._firePlayAgain();
      }
    };
    window.addEventListener('keydown', this._resultsKeyHandler);

    // Prime gamepad edge detection so a held button doesn't fire instantly
    this._gpPrevStart = true;
    this._gpPrevBack = true;

    // Focus the dialog itself (not a button): Space must keep jumping during
    // the celebration, and Enter is handled above. Tab reaches the buttons.
    this._addTimeout(() => { if (root.isConnected) root.focus({ preventScroll: true }); }, 450);

    // Entrance animation
    requestAnimationFrame(() => root.classList.add('mr-visible'));
  }

  _buildRewards(xpResult, showRank) {
    const box = document.createElement('div');
    box.className = 'mr-rewards';

    const title = document.createElement('div');
    title.className = 'mr-rewards-title';
    title.textContent = 'MATCH REWARDS';
    box.appendChild(title);

    const list = document.createElement('div');
    list.className = 'mr-xp-list';
    xpResult.entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'mr-xp-row';
      row.style.setProperty('--i', i);
      row.innerHTML = `<span>${this._escape(entry.label)}</span><span class="mr-xp-amt">+${entry.amount}</span>`;
      list.appendChild(row);
    });
    box.appendChild(list);

    const total = document.createElement('div');
    total.className = 'mr-xp-total';
    total.innerHTML = '+<span class="mr-xp-count">0</span> XP';
    box.appendChild(total);
    const countEl = total.querySelector('.mr-xp-count');

    // Level + progress bar (animates from pre-match progress to post-match)
    const levelAfter = typeof xpResult.newLevel === 'number' ? xpResult.newLevel : progression.level;
    const levelBefore = typeof xpResult.levelBefore === 'number' ? xpResult.levelBefore : levelAfter;
    const xpAfter = typeof xpResult.xpAfter === 'number' ? xpResult.xpAfter : progression.xp;
    const xpBefore = typeof xpResult.xpBefore === 'number' ? xpResult.xpBefore : xpAfter - xpResult.totalXP;
    const leveledUp = levelAfter > levelBefore;

    const levelRow = document.createElement('div');
    levelRow.className = 'mr-level-row';
    const prestigePrefix = progression.prestige > 0 ? '★'.repeat(Math.min(progression.prestige, 10)) + ' ' : '';
    levelRow.innerHTML = `<span class="mr-level">${prestigePrefix}LVL ${levelAfter} &middot; ${this._escape(getLevelTitle(levelAfter))}</span>` +
      (leveledUp ? '<span class="mr-levelup">LEVEL UP</span>' : '');
    box.appendChild(levelRow);

    const bar = document.createElement('div');
    bar.className = 'mr-bar';
    const fill = document.createElement('div');
    fill.className = 'mr-bar-fill';
    bar.appendChild(fill);
    box.appendChild(bar);

    const xpText = document.createElement('div');
    xpText.className = 'mr-xp-text';
    xpText.textContent = `${xpAfter} / ${xpForLevel(levelAfter + 1)} XP`;
    box.appendChild(xpText);

    // Rank change line (online). Rendered now if already known, otherwise
    // when the server's progression event lands.
    if (showRank) {
      const rank = document.createElement('div');
      rank.className = 'mr-rank';
      rank.textContent = 'Updating rank…';
      box.appendChild(rank);
      this._resultsRankEl = rank;
      const existing = progression.getLastRankChange();
      if (existing) this._renderRankChange(existing);
      progression.onRankChange = (rc) => this._renderRankChange(rc);
    }

    const progressOf = (xp, level) => {
      const lo = xpForLevel(level);
      const hi = xpForLevel(level + 1);
      return hi > lo ? Math.max(0, Math.min(1, (xp - lo) / (hi - lo))) : 1;
    };
    const startPct = Math.round(progressOf(xpBefore, levelBefore) * 100);
    const endPct = Math.round(progressOf(xpAfter, levelAfter) * 100);
    fill.style.width = `${startPct}%`;

    // Count-up + bar animation, started after the row stagger finishes.
    const rowsDone = 350 + xpResult.entries.length * 90;
    this._addTimeout(() => {
      this._animateCount(countEl, xpResult.totalXP, 900);
      if (leveledUp) {
        fill.style.width = '100%';
        this._addTimeout(() => {
          fill.classList.add('mr-bar-snap');
          fill.style.width = '0%';
          this._addTimeout(() => {
            fill.classList.remove('mr-bar-snap');
            fill.style.width = `${endPct}%`;
          }, 60);
        }, 950);
      } else {
        fill.style.width = `${endPct}%`;
      }
    }, rowsDone);

    return box;
  }

  // Bounded count-up (<1s); writes only when the rounded value changes.
  _animateCount(el, target, durationMs) {
    if (this._resultsCountRaf) cancelAnimationFrame(this._resultsCountRaf);
    const start = performance.now();
    let last = -1;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = Math.round(target * eased);
      if (v !== last) { last = v; el.textContent = v; }
      if (t < 1) this._resultsCountRaf = requestAnimationFrame(tick);
      else this._resultsCountRaf = null;
    };
    this._resultsCountRaf = requestAnimationFrame(tick);
  }

  _renderRankChange(rc) {
    const el = this._resultsRankEl;
    if (!el || !rc || rc.mmrDelta === null || rc.mmrDelta === undefined) return;
    const up = rc.mmrDelta >= 0;
    const rankName = rc.rankAfter || '';
    const changed = rc.rankBefore && rc.rankAfter && rc.rankBefore !== rc.rankAfter;
    const color = rc.rankColor || (up ? '#00ff88' : '#ff4444');
    el.innerHTML = `<span class="mr-rank-name" style="color:${color}">${this._escape(String(rankName).toUpperCase())}</span>` +
      `<span class="mr-rank-delta ${up ? 'up' : 'down'}">${up ? '+' : ''}${rc.mmrDelta} MMR</span>` +
      (changed ? `<span class="mr-rank-tag ${up ? 'up' : 'down'}">${up ? 'RANK UP' : 'RANK DOWN'}</span>` : '') +
      `<span class="mr-rank-mode">${this._escape(String(rc.matchMode || '1v1').toUpperCase())}</span>`;
    el.classList.add('mr-rank-ready');
  }

  _makeStatRow(idx, stat, mvpIdx, maxPlayers, team, isLocal) {
    const tr = document.createElement('tr');
    tr.className = `scoreboard-row ${team}${isLocal ? ' you' : ''}`;
    const s = stat || { goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 };
    const mvpStar = idx === mvpIdx ? '<span class="sb-mvp" title="MVP">&#9733;</span> ' : '';
    const youTag = isLocal ? '<span class="sb-you">YOU</span>' : '';
    tr.innerHTML = `
      <td class="sb-player-col">${mvpStar}${this._escape(this._getPlayerLabel(idx, maxPlayers))}${youTag}</td>
      <td>${s.goals}</td>
      <td>${s.assists}</td>
      <td>${s.saves}</td>
      <td>${s.shots}</td>
      <td>${s.demos}</td>
      <td class="sb-score">${s.score}</td>
    `;
    return tr;
  }

  _escape(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Both actions tear the match down, so they fire at most once per screen.
  _firePlayAgain() {
    if (!this.onPlayAgain || !this._resultsEl || this._resultsActionFired) return;
    this._resultsActionFired = true;
    this.stopAutoReturn();
    this.onPlayAgain();
  }

  _fireBackToLobby() {
    if (this._resultsActionFired) return;
    this._resultsActionFired = true;
    this.stopAutoReturn();
    if (this.onBackToLobby) this.onBackToLobby();
  }

  /**
   * Per-frame gamepad hook for the results screen (Game calls this while the
   * match is in the 'ended' state). Start = primary action, Back = lobby.
   */
  pollMatchEndGamepad(gp) {
    if (!this._resultsEl) return;
    if (!gp) { this._gpPrevStart = false; this._gpPrevBack = false; return; }
    const start = !!(gp.buttons[GP_BTN_START] && gp.buttons[GP_BTN_START].pressed);
    const back = !!(gp.buttons[GP_BTN_BACK] && gp.buttons[GP_BTN_BACK].pressed);
    if (start && !this._gpPrevStart && this._resultsPrimaryBtn) this._firePlayAgain();
    else if (back && !this._gpPrevBack) this._fireBackToLobby();
    this._gpPrevStart = start;
    this._gpPrevBack = back;
  }

  /**
   * Count down to an automatic return to the lobby (online matches: the room
   * is torn down server-side). Shown on the lobby button when the results
   * screen is up, otherwise in the status line.
   */
  startAutoReturn(seconds) {
    this.stopAutoReturn();
    this._autoReturnLeft = Math.max(1, Math.round(seconds));
    this._lastAutoReturnText = null;
    // Keep whatever the status line was saying (e.g. "A player disconnected")
    const statusVisible = this.statusText && this.statusText.style.opacity === '1' && this.statusText.textContent;
    const prefix = statusVisible ? `${this.statusText.textContent} — ` : '';
    const tick = () => {
      const text = this._resultsSecondaryBtn
        ? `Back to Lobby (${this._autoReturnLeft})`
        : `${prefix}Returning to lobby in ${this._autoReturnLeft}…`;
      if (text !== this._lastAutoReturnText) {
        this._lastAutoReturnText = text;
        if (this._resultsSecondaryBtn) this._resultsSecondaryBtn.textContent = text;
        else this.showStatus(text);
      }
      if (this._autoReturnLeft <= 0) {
        this.stopAutoReturn();
        if (this.onBackToLobby) this.onBackToLobby();
        return;
      }
      this._autoReturnLeft--;
    };
    tick();
    this._autoReturnTimer = setInterval(tick, 1000);
  }

  stopAutoReturn() {
    if (this._autoReturnTimer) {
      clearInterval(this._autoReturnTimer);
      this._autoReturnTimer = null;
    }
  }

  _removeResults() {
    this.stopAutoReturn();
    if (this._resultsKeyHandler) {
      window.removeEventListener('keydown', this._resultsKeyHandler);
      this._resultsKeyHandler = null;
    }
    if (this._resultsCountRaf) {
      cancelAnimationFrame(this._resultsCountRaf);
      this._resultsCountRaf = null;
    }
    progression.onRankChange = null;
    if (this._resultsEl) {
      this._resultsEl.remove();
      this._resultsEl = null;
    }
    this._resultsPrimaryBtn = null;
    this._resultsSecondaryBtn = null;
    this._resultsRankEl = null;
  }

  setPlayerNames(names) {
    this._playerNames = names || [];
  }

  setTeamNames(blue, orange) {
    this._teamNames = { blue: blue || 'BLUE', orange: orange || 'ORANGE' };
  }

  _getPlayerLabel(idx, maxPlayers) {
    if (this._playerNames[idx]) return this._playerNames[idx];
    if (maxPlayers === 2) {
      return idx === 0 ? 'Player' : 'AI';
    }
    const half = Math.floor(maxPlayers / 2);
    if (idx < half) {
      return `Blue ${idx + 1}`;
    }
    return `Orange ${idx - half + 1}`;
  }

  reset() {
    this._clearTimeouts();
    this.timerEl.textContent = '5:00';
    this.timerEl.style.color = '';
    this.timerEl.style.textShadow = '';
    this.scoreBlueEl.textContent = '0';
    this.scoreOrangeEl.textContent = '0';
    // Invalidate dirty-check caches so the next update writes through
    this._lastTimerText = null;
    this._lastBlueScore = null;
    this._lastOrangeScore = null;
    this._lastBoostOffset = null;
    this._lastBoostText = null;
    this._lastBoostStroke = null;
    this._lastSpeedPct = null;
    this._lastPing = null;
    this._lastPingColor = null;
    this._liveScoreboardVisible = false;
    this._liveScoreboardKey = null;
    if (this.hudTop) this.hudTop.style.opacity = '1';
    this.countdownEl.style.opacity = '0';
    this.goalTextEl.style.opacity = '0';
    if (this.statusText) this.statusText.style.opacity = '0';
    if (this.demoText) this.demoText.style.opacity = '0';
    if (this.pingEl) {
      this.pingEl.remove();
      this.pingEl = null;
    }
    this._removeResults();
    progression.clearLastRankChange();
    if (this._liveScoreboardEl) {
      this._liveScoreboardEl.remove();
      this._liveScoreboardEl = null;
    }
    if (this._vsBanner) {
      this._vsBanner.remove();
      this._vsBanner = null;
    }
    if (this._mutatorBadge) {
      this._mutatorBadge.remove();
      this._mutatorBadge = null;
    }
    this.showReplayIndicator(false);
  }
}
