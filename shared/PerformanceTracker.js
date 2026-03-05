// ============================================
// PerformanceTracker — Shared stat tracking
// Pure math, no engine dependencies.
// Used by server (multiplayer) and client (singleplayer).
// ============================================

import { ARENA, PHYSICS } from './constants.js';

const HL = ARENA.LENGTH / 2; // half-length (Z)
const GW = ARENA.GOAL_WIDTH;
const GH = ARENA.GOAL_HEIGHT;
const GRAVITY = PHYSICS.GRAVITY; // -30

const TOUCH_DEBOUNCE_MS = 100;
const ASSIST_WINDOW_S = 5;
const MAX_TOUCH_HISTORY = 20;

function emptyStats() {
  return { goals: 0, assists: 0, saves: 0, shots: 0, clears: 0, touches: 0, demos: 0, score: 0 };
}

export class PerformanceTracker {
  constructor(maxPlayers) {
    this.maxPlayers = maxPlayers;
    this.stats = [];
    for (let i = 0; i < maxPlayers; i++) this.stats.push(emptyStats());

    this.touchHistory = []; // { carIdx, time, ballPos, ballVelBefore, ballVelAfter, carPos }
    this.lastToucher = null;
    this._pendingTouch = null;
    this._lastTouchTime = new Array(maxPlayers).fill(-Infinity); // per-car debounce
    this._matchElapsed = 0;
  }

  // ---------- Time ----------

  setMatchTime(elapsed) {
    this._matchElapsed = elapsed;
  }

  // ---------- Touches ----------

  /** Call BEFORE impulse is applied. */
  recordTouch(carIdx, ballPos, ballVelBefore, carPos) {
    if (carIdx < 0 || carIdx >= this.maxPlayers) return;

    const now = this._matchElapsed;
    if (now - this._lastTouchTime[carIdx] < TOUCH_DEBOUNCE_MS / 1000) return;
    this._lastTouchTime[carIdx] = now;

    this.stats[carIdx].touches++;
    this.stats[carIdx].score += 2;

    this._pendingTouch = {
      carIdx,
      time: now,
      ballPos: { x: ballPos.x, y: ballPos.y, z: ballPos.z },
      ballVelBefore: { x: ballVelBefore.x, y: ballVelBefore.y, z: ballVelBefore.z },
      carPos: { x: carPos.x, y: carPos.y, z: carPos.z },
      ballVelAfter: null,
    };
  }

  /** Call AFTER impulse is applied. Runs shot/save/clear detection. */
  finalizePendingTouch(ballVelAfter) {
    const touch = this._pendingTouch;
    if (!touch) return;
    this._pendingTouch = null;

    touch.ballVelAfter = { x: ballVelAfter.x, y: ballVelAfter.y, z: ballVelAfter.z };

    // Push to ring buffer
    this.touchHistory.push(touch);
    if (this.touchHistory.length > MAX_TOUCH_HISTORY) this.touchHistory.shift();
    this.lastToucher = touch;

    const carIdx = touch.carIdx;
    const team = this._getTeam(carIdx);

    // Shot detection (after touch, ball heading toward opponent goal)
    if (this._isShot(touch, team)) {
      this.stats[carIdx].shots++;
      this.stats[carIdx].score += 10;
    }

    // Save detection (before touch, ball was heading into own goal)
    if (this._isSave(touch, team)) {
      this.stats[carIdx].saves++;
      this.stats[carIdx].score += 50;
    }

    // Clear detection
    if (this._isClear(touch, team)) {
      this.stats[carIdx].clears++;
      this.stats[carIdx].score += 20;
    }
  }

  // ---------- Goal ----------

  /** Call when a goal is scored. goalSide: 1 = scored on blue goal (orange scores), -1 = scored on orange goal (blue scores). Returns { scorerIdx, assistIdx }. */
  recordGoal(goalSide) {
    const scoringTeam = goalSide === 1 ? 'orange' : 'blue';

    let scorerIdx = -1;
    let assistIdx = -1;

    // Walk history backward to find scorer (last same-team toucher)
    for (let i = this.touchHistory.length - 1; i >= 0; i--) {
      const t = this.touchHistory[i];
      if (this._getTeam(t.carIdx) === scoringTeam) {
        scorerIdx = t.carIdx;
        break;
      }
    }

    if (scorerIdx >= 0) {
      this.stats[scorerIdx].goals++;
      this.stats[scorerIdx].score += 100;

      // Find assister: different same-team player, within ASSIST_WINDOW_S before the scorer's touch
      const scorerTouch = this.touchHistory.findLast(t => t.carIdx === scorerIdx);
      if (scorerTouch) {
        for (let i = this.touchHistory.length - 1; i >= 0; i--) {
          const t = this.touchHistory[i];
          if (t === scorerTouch) continue;
          if (this._getTeam(t.carIdx) === scoringTeam && t.carIdx !== scorerIdx) {
            if (scorerTouch.time - t.time <= ASSIST_WINDOW_S) {
              assistIdx = t.carIdx;
              break;
            }
          }
        }
      }

      if (assistIdx >= 0) {
        this.stats[assistIdx].assists++;
        this.stats[assistIdx].score += 50;
      }
    }

    return { scorerIdx, assistIdx };
  }

  // ---------- Demolition ----------

  recordDemolition(attackerIdx) {
    if (attackerIdx < 0 || attackerIdx >= this.maxPlayers) return;
    this.stats[attackerIdx].demos++;
  }

  // ---------- MVP ----------

  /** Awards +50 to highest scorer on winning team. Returns mvpIdx or -1. */
  computeMVP(winningTeam) {
    let mvpIdx = -1;
    let best = -1;
    for (let i = 0; i < this.maxPlayers; i++) {
      if (this._getTeam(i) !== winningTeam) continue;
      if (this.stats[i].score > best) {
        best = this.stats[i].score;
        mvpIdx = i;
      }
    }
    if (mvpIdx >= 0) {
      this.stats[mvpIdx].score += 50;
    }
    return mvpIdx;
  }

  // ---------- Reset ----------

  resetTouchHistory() {
    this.touchHistory = [];
    this.lastToucher = null;
    this._pendingTouch = null;
  }

  // ---------- Getters ----------

  getStats() {
    return this.stats.map(s => ({ ...s }));
  }

  // ---------- Internal helpers ----------

  _getTeam(idx) {
    return idx < this.maxPlayers / 2 ? 'blue' : 'orange';
  }

  /** After touch, does the ball trajectory enter the opponent's goal? */
  _isShot(touch, team) {
    const v = touch.ballVelAfter;
    if (!v) return false;

    // Opponent goal is at +HL for blue, -HL for orange
    const goalZ = team === 'blue' ? HL : -HL;
    const headingToGoal = team === 'blue' ? v.z > 5 : v.z < -5;
    if (!headingToGoal) return false;

    const dz = goalZ - touch.ballPos.z;
    const t = dz / v.z;
    if (t <= 0 || t > 5) return false;

    const xAtGoal = touch.ballPos.x + v.x * t;
    const yAtGoal = touch.ballPos.y + v.y * t + 0.5 * GRAVITY * t * t;
    return Math.abs(xAtGoal) < GW / 2 && yAtGoal > 0 && yAtGoal < GH;
  }

  /** Before touch, was the ball heading into own goal? (save detection) */
  _isSave(touch, team) {
    const v = touch.ballVelBefore;

    // Own goal is at -HL for blue, +HL for orange
    const goalZ = team === 'blue' ? -HL : HL;
    const headingToOwn = team === 'blue' ? v.z < -5 : v.z > 5;
    if (!headingToOwn) return false;

    const dz = goalZ - touch.ballPos.z;
    const t = dz / v.z;
    if (t <= 0 || t > 3) return false;

    const xAtGoal = touch.ballPos.x + v.x * t;
    const yAtGoal = touch.ballPos.y + v.y * t + 0.5 * GRAVITY * t * t;
    return Math.abs(xAtGoal) < GW / 2 && yAtGoal > 0 && yAtGoal < GH;
  }

  /** Ball in defensive third and sent away from own goal. */
  _isClear(touch, team) {
    const v = touch.ballVelAfter;
    if (!v) return false;

    const defenseThreshold = HL * 0.4; // 47.4 units
    const ownGoalZ = team === 'blue' ? -HL : HL;

    // Is ball in defensive third?
    const distFromOwnGoal = Math.abs(touch.ballPos.z - ownGoalZ);
    if (distFromOwnGoal > defenseThreshold) return false;

    // Ball sent away from own goal
    const awayFromGoal = team === 'blue' ? v.z > 10 : v.z < -10;
    return awayFromGoal;
  }
}
