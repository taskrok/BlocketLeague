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
    };

    if (this.socket) {
      this.socket.emit('input', input);
    }

    return input;
  }

  // ========== INTERPOLATION ==========

  getInterpolatedState(renderTime) {
    if (this.snapshots.length < 2) {
      return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
    }

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

    if (!before || !after) {
      // Use latest available
      return this.snapshots[this.snapshots.length - 1];
    }

    const range = after.localTime - before.localTime;
    const t = range > 0 ? (renderTime - before.localTime) / range : 0;

    return this._lerpSnapshots(before, after, t);
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
    return {
      px: a.px + (b.px - a.px) * t,
      py: a.py + (b.py - a.py) * t,
      pz: a.pz + (b.pz - a.pz) * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      vz: a.vz + (b.vz - a.vz) * t,
      qx: a.qx + (b.qx - a.qx) * t,
      qy: a.qy + (b.qy - a.qy) * t,
      qz: a.qz + (b.qz - a.qz) * t,
      qw: a.qw + (b.qw - a.qw) * t,
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
}
