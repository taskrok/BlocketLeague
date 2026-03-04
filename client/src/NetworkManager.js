// ============================================
// NetworkManager — Client socket.io wrapper
// Handles connection, input sending, snapshot buffering,
// interpolation, and pending input buffer for reconciliation
// ============================================

import { io } from 'socket.io-client';
import { NETWORK } from '../../shared/constants.js';

export class NetworkManager {
  constructor() {
    this.socket = null;
    this.seq = 0;
    this.playerNumber = -1;

    // Snapshot buffer for interpolation (most recent 30)
    this.snapshots = [];
    this.maxSnapshots = 30;

    // Pending input buffer for client-side prediction reconciliation
    this.pendingInputs = [];

    // Event callbacks
    this._callbacks = {};
  }

  connect() {
    this.socket = io({ transports: ['websocket'] });

    this.socket.on('connect', () => {
      this._emit('connected');
    });

    this.socket.on('waiting', (data) => {
      this._emit('waiting', data);
    });

    this.socket.on('joined', (data) => {
      this.playerNumber = data.playerNumber;
      this._emit('joined', data);
    });

    this.socket.on('countdown', (data) => {
      this._emit('countdown', data);
    });

    this.socket.on('gameState', (data) => {
      // Tag with local receive time for interpolation
      data.localTime = performance.now();
      this.snapshots.push(data);

      // Keep buffer bounded
      if (this.snapshots.length > this.maxSnapshots) {
        this.snapshots.shift();
      }

      this._emit('gameState', data);
    });

    this.socket.on('demolition', (data) => {
      this._emit('demolition', data);
    });

    this.socket.on('goalScored', (data) => {
      this._emit('goalScored', data);
    });

    this.socket.on('overtime', (data) => {
      this._emit('overtime', data);
    });

    this.socket.on('gameOver', (data) => {
      this._emit('gameOver', data);
    });

    this.socket.on('opponentLeft', (data) => {
      this._emit('opponentLeft', data);
    });

    this.socket.on('disconnect', () => {
      this._emit('disconnected');
    });
  }

  joinGame(variantConfig) {
    if (this.socket) {
      this.socket.emit('joinGame', { variantConfig });
    }
  }

  sendInput(inputState) {
    this.seq++;
    const input = {
      seq: this.seq,
      throttle: inputState.throttle,
      steer: inputState.steer,
      jump: inputState.jump,
      jumpPressed: inputState.jumpPressed,
      boost: inputState.boost,
      airRoll: inputState.airRoll,
      pitchUp: inputState.pitchUp,
      pitchDown: inputState.pitchDown,
      handbrake: inputState.handbrake,
      dodgeForward: inputState.dodgeForward,
      dodgeSteer: inputState.dodgeSteer,
    };

    if (this.socket) {
      this.socket.emit('input', input);
    }

    return input;
  }

  // ========== INTERPOLATION ==========

  getInterpolatedState(renderTime) {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) return this.snapshots[0];

    // Find the two snapshots bracketing renderTime
    let before = null;
    let after = null;

    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].localTime <= renderTime && this.snapshots[i + 1].localTime >= renderTime) {
        before = this.snapshots[i];
        after = this.snapshots[i + 1];
        break;
      }
    }

    if (before && after) {
      const range = after.localTime - before.localTime;
      const t = range > 0 ? (renderTime - before.localTime) / range : 0;
      return this._lerpSnapshots(before, after, t);
    }

    // No bracketing pair — extrapolate from the last snapshot using velocity
    const latest = this.snapshots[this.snapshots.length - 1];
    const elapsed = (renderTime - latest.localTime) / 1000; // seconds

    // Cap extrapolation to avoid wild prediction (max ~100ms ahead)
    if (elapsed < 0 || elapsed > 0.1) return latest;

    return this._extrapolate(latest, elapsed);
  }

  _extrapolate(snap, dt) {
    return {
      tick: snap.tick,
      ball: this._extrapolateEntity(snap.ball, dt),
      players: snap.players.map(p => this._extrapolatePlayer(p, dt)),
      boostPads: snap.boostPads,
      score: snap.score,
      timer: snap.timer,
      state: snap.state,
      localTime: snap.localTime,
    };
  }

  _extrapolateEntity(e, dt) {
    return {
      px: e.px + e.vx * dt,
      py: e.py + e.vy * dt,
      pz: e.pz + e.vz * dt,
      vx: e.vx, vy: e.vy, vz: e.vz,
      qx: e.qx, qy: e.qy, qz: e.qz, qw: e.qw,
    };
  }

  _extrapolatePlayer(p, dt) {
    const e = this._extrapolateEntity(p, dt);
    e.avx = p.avx; e.avy = p.avy; e.avz = p.avz;
    e.boost = p.boost;
    e.demolished = p.demolished;
    e.lastProcessedInput = p.lastProcessedInput;
    return e;
  }

  _lerpSnapshots(a, b, t) {
    return {
      tick: b.tick,
      ball: this._lerpEntity(a.ball, b.ball, t),
      players: a.players.map((pa, i) => this._lerpPlayer(pa, b.players[i], t)),
      boostPads: b.boostPads,
      score: b.score,
      timer: b.timer,
      state: b.state,
      localTime: a.localTime + (b.localTime - a.localTime) * t,
    };
  }

  _lerpEntity(a, b, t) {
    // SLERP for quaternion (proper spherical interpolation)
    const { qx, qy, qz, qw } = this._slerp(
      a.qx, a.qy, a.qz, a.qw,
      b.qx, b.qy, b.qz, b.qw,
      t
    );
    return {
      px: a.px + (b.px - a.px) * t,
      py: a.py + (b.py - a.py) * t,
      pz: a.pz + (b.pz - a.pz) * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      vz: a.vz + (b.vz - a.vz) * t,
      qx, qy, qz, qw,
    };
  }

  _slerp(ax, ay, az, aw, bx, by, bz, bw, t) {
    // Ensure shortest path
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) {
      bx = -bx; by = -by; bz = -bz; bw = -bw;
      dot = -dot;
    }
    // If very close, fall back to linear lerp + normalize
    if (dot > 0.9995) {
      const qx = ax + (bx - ax) * t;
      const qy = ay + (by - ay) * t;
      const qz = az + (bz - az) * t;
      const qw = aw + (bw - aw) * t;
      const inv = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      return { qx: qx * inv, qy: qy * inv, qz: qz * inv, qw: qw * inv };
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    return {
      qx: ax * wa + bx * wb,
      qy: ay * wa + by * wb,
      qz: az * wa + bz * wb,
      qw: aw * wa + bw * wb,
    };
  }

  _lerpPlayer(a, b, t) {
    const entity = this._lerpEntity(a, b, t);
    entity.avx = a.avx + (b.avx - a.avx) * t;
    entity.avy = a.avy + (b.avy - a.avy) * t;
    entity.avz = a.avz + (b.avz - a.avz) * t;
    entity.boost = a.boost + (b.boost - a.boost) * t;
    entity.demolished = b.demolished;
    entity.lastProcessedInput = b.lastProcessedInput;
    return entity;
  }

  // ========== PENDING INPUT BUFFER ==========

  addPendingInput(input) {
    this.pendingInputs.push(input);
  }

  clearPendingInputsBefore(seq) {
    this.pendingInputs = this.pendingInputs.filter(i => i.seq > seq);
  }

  getPendingInputs() {
    return this.pendingInputs;
  }

  getLatestSnapshot() {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  // ========== EVENT SYSTEM ==========

  on(event, fn) {
    if (!this._callbacks[event]) {
      this._callbacks[event] = [];
    }
    this._callbacks[event].push(fn);
  }

  _emit(event, data) {
    const cbs = this._callbacks[event];
    if (cbs) {
      cbs.forEach(fn => fn(data));
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._callbacks = {};
    this.snapshots = [];
    this.pendingInputs = [];
  }
}
