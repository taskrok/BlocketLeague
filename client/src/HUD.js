// ============================================
// HUD - Heads-up display management
// ============================================

import { CAR, GAME } from '../../shared/constants.js';

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

  showMatchEnd(blueScore, orangeScore, stats, mvpIdx, maxPlayers) {
    if (!stats) {
      // Fallback: no stats available
      const winTeam = blueScore > orangeScore ? this._teamNames.blue : this._teamNames.orange;
      this.goalTextEl.textContent = `${winTeam} WINS!`;
      const color = blueScore > orangeScore ? '#0088ff' : '#ff6600';
      this.goalTextEl.style.color = color;
      this.goalTextEl.style.textShadow = `0 0 40px ${color}, 0 0 80px ${color}`;
      this.goalTextEl.style.opacity = '1';
      return;
    }

    // Hide the simple goal text, show full scoreboard
    this.goalTextEl.style.opacity = '0';
    this._showScoreboard(blueScore, orangeScore, stats, mvpIdx, maxPlayers || stats.length);
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

  _showScoreboard(blueScore, orangeScore, stats, mvpIdx, maxPlayers) {
    if (this._scoreboardEl) this._scoreboardEl.remove();

    // Hide conflicting HUD elements. (hud-top itself stays visible behind the
    // final board, as it always effectively did: hideLiveScoreboard restores it.)
    this.goalTextEl.style.opacity = '0';
    this.showReplayIndicator(false);
    this.hideLiveScoreboard();
    if (this.hudTop) this.hudTop.style.opacity = '1';

    const blueWins = blueScore > orangeScore;
    const winColor = blueWins ? '#0088ff' : '#ff6600';
    const winTeam = blueWins ? this._teamNames.blue : this._teamNames.orange;
    const winText = `${winTeam} WINS!`;
    const half = Math.floor(maxPlayers / 2);

    const el = document.createElement('div');
    el.id = 'match-scoreboard';
    this._scoreboardEl = el;

    // Header
    const header = document.createElement('div');
    header.className = 'scoreboard-header';
    header.style.color = winColor;
    header.style.textShadow = `0 0 30px ${winColor}, 0 0 60px ${winColor}`;
    header.textContent = winText;
    el.appendChild(header);

    // Score row
    const scoreRow = document.createElement('div');
    scoreRow.className = 'scoreboard-score-row';
    scoreRow.innerHTML = `<span class="sb-blue">${blueScore}</span> <span class="sb-dash">-</span> <span class="sb-orange">${orangeScore}</span>`;
    el.appendChild(scoreRow);

    // Table
    const table = document.createElement('table');
    table.className = 'scoreboard-table';

    // Header row
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th class="sb-player-col">Player</th>
      <th>Goals</th>
      <th>Assists</th>
      <th>Saves</th>
      <th>Shots</th>
      <th>Demos</th>
      <th class="sb-score-col">Score</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // Blue team rows
    for (let i = 0; i < half; i++) {
      tbody.appendChild(this._makeStatRow(i, stats[i], mvpIdx, maxPlayers, 'blue'));
    }

    // Separator
    const sepRow = document.createElement('tr');
    sepRow.className = 'scoreboard-separator';
    sepRow.innerHTML = `<td colspan="7"><div class="sb-sep-line"></div></td>`;
    tbody.appendChild(sepRow);

    // Orange team rows
    for (let i = half; i < maxPlayers; i++) {
      tbody.appendChild(this._makeStatRow(i, stats[i], mvpIdx, maxPlayers, 'orange'));
    }

    table.appendChild(tbody);
    el.appendChild(table);

    // Back to Lobby button
    const btn = document.createElement('button');
    btn.className = 'lobby-btn';
    btn.textContent = 'Back to Lobby';
    Object.assign(btn.style, {
      marginTop: '18px',
      fontSize: '16px',
      padding: '10px 32px',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      if (this.onBackToLobby) this.onBackToLobby();
    });
    el.appendChild(btn);

    const container = document.getElementById('game-container');
    (container || document.body).appendChild(el);
  }

  _makeStatRow(idx, stat, mvpIdx, maxPlayers, team) {
    const tr = document.createElement('tr');
    tr.className = `scoreboard-row ${team}`;

    const isMVP = idx === mvpIdx;
    const label = this._getPlayerLabel(idx, maxPlayers);
    const mvpStar = isMVP ? '<span class="sb-mvp">&#9733;</span> ' : '';

    tr.innerHTML = `
      <td class="sb-player-col">${mvpStar}${label}</td>
      <td>${stat.goals}</td>
      <td>${stat.assists}</td>
      <td>${stat.saves}</td>
      <td>${stat.shots}</td>
      <td>${stat.demos}</td>
      <td class="sb-score">${stat.score}</td>
    `;
    return tr;
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
    if (this._scoreboardEl) {
      this._scoreboardEl.remove();
      this._scoreboardEl = null;
    }
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
