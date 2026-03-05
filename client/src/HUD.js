// ============================================
// HUD - Heads-up display management
// ============================================

import { CAR, GAME } from '../../shared/constants.js';

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

    // Boost meter constants
    this.boostCircumference = 2 * Math.PI * 52; // r=52 from SVG
    this.boostArc.style.strokeDasharray = this.boostCircumference;

    // Ping display (created dynamically for multiplayer)
    this.pingEl = null;

    // Track active timeouts so we can clear them on reset/destroy
    this._timeouts = [];

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
    this.timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  updateScore(blueScore, orangeScore) {
    this.scoreBlueEl.textContent = blueScore;
    this.scoreOrangeEl.textContent = orangeScore;
  }

  updateBoost(boostAmount) {
    const pct = boostAmount / CAR.MAX_BOOST;
    const offset = this.boostCircumference * (1 - pct);
    this.boostArc.style.strokeDashoffset = offset;
    this.boostText.textContent = Math.round(boostAmount);

    // Color shift: orange when low, golden when high
    if (pct > 0.5) {
      this.boostArc.style.stroke = '#ff8800';
    } else if (pct > 0.2) {
      this.boostArc.style.stroke = '#ff6600';
    } else {
      this.boostArc.style.stroke = '#ff3300';
    }
  }

  updateSpeed(speed, maxSpeed) {
    const pct = Math.min(speed / maxSpeed * 100, 100);
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

  showGoalScored(team) {
    const color = team === 'blue' ? '#0088ff' : '#ff6600';
    this.goalTextEl.textContent = 'GOAL!';
    this.goalTextEl.style.color = color;
    this.goalTextEl.style.textShadow = `0 0 40px ${color}, 0 0 80px ${color}`;
    this.goalTextEl.style.opacity = '1';

    this._addTimeout(() => {
      this.goalTextEl.style.opacity = '0';
    }, 2000);
  }

  showOvertime() {
    this.timerEl.textContent = 'OVERTIME';
    this.timerEl.style.color = '#ff3300';
    this.timerEl.style.textShadow = '0 0 20px rgba(255, 51, 0, 0.7)';
  }

  showMatchEnd(blueScore, orangeScore) {
    this.goalTextEl.textContent = blueScore > orangeScore ? 'BLUE WINS!' : 'ORANGE WINS!';
    const color = blueScore > orangeScore ? '#0088ff' : '#ff6600';
    this.goalTextEl.style.color = color;
    this.goalTextEl.style.textShadow = `0 0 40px ${color}, 0 0 80px ${color}`;
    this.goalTextEl.style.opacity = '1';
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
    const color = ping < 60 ? '#0f0' : ping < 120 ? '#ff0' : '#f00';
    this.pingEl.style.color = color;
    this.pingEl.textContent = `${ping}ms`;
  }

  showReplayIndicator(show) {
    if (show) {
      if (this._replayEl) return; // already showing
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'fixed',
        top: '60px',
        left: '50%',
        transform: 'translateX(-50%)',
        textAlign: 'center',
        zIndex: '200',
        pointerEvents: 'none',
      });
      el.innerHTML = `
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

  reset() {
    this._clearTimeouts();
    this.timerEl.textContent = '5:00';
    this.timerEl.style.color = '';
    this.timerEl.style.textShadow = '';
    this.scoreBlueEl.textContent = '0';
    this.scoreOrangeEl.textContent = '0';
    this.countdownEl.style.opacity = '0';
    this.goalTextEl.style.opacity = '0';
    if (this.statusText) this.statusText.style.opacity = '0';
    if (this.demoText) this.demoText.style.opacity = '0';
    if (this.pingEl) {
      this.pingEl.remove();
      this.pingEl = null;
    }
    this.showReplayIndicator(false);
  }
}
