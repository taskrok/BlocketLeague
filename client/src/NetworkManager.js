// ============================================
// NetworkManager — Client socket.io wrapper
// Binary protocol, input deduplication, adaptive interpolation,
// RTT measurement, SLERP quaternion interpolation
// ============================================

import { io } from 'socket.io-client';
import { NETWORK } from '../../shared/constants.js';
import { decodeGameState, encodeInput } from '../../shared/BinaryProtocol.js';

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

    // Adaptive interpolation
    this._packetIntervals = [];
    this._lastPacketTime = 0;
    this._adaptiveDelay = NETWORK.INTERPOLATION_DELAY;

    // RTT measurement
    this.rtt = 0;
    this.playerPings = null; // per-slot ping array from server
    this._pingStart = 0;
    this._pingInterval = null;
  }

  connect() {
    this.socket = io({ transports: ['websocket'] });

    this.socket.on('connect', () => {
      this._startPing();
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
      // Decode binary protocol (or pass through if already object)
      const snapshot = decodeGameState(data);

      // Tag with local receive time for interpolation
      snapshot.localTime = performance.now();

      // Update adaptive interpolation delay
      this._updateJitter(snapshot.localTime);

      this.snapshots.push(snapshot);

      // Keep buffer bounded
      if (this.snapshots.length > this.maxSnapshots) {
        this.snapshots.shift();
      }

      this._emit('gameState', snapshot);
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

    this.socket.on('playerLeft', (data) => {
      this._emit('playerLeft', data);
    });

    this.socket.on('roomCreated', (data) => {
      this._emit('roomCreated', data);
    });

    this.socket.on('lobbyUpdate', (data) => {
      this._emit('lobbyUpdate', data);
    });

    this.socket.on('joinError', (data) => {
      this._emit('joinError', data);
    });

    this.socket.on('roomExpired', (data) => {
      this._emit('roomExpired', data);
    });

    this.socket.on('pong_measure', () => {
      this.rtt = performance.now() - this._pingStart;
      this.socket.volatile.emit('report_rtt', Math.round(this.rtt));
    });

    this.socket.on('playerPings', (pings) => {
      this.playerPings = pings;
    });

    this.socket.on('disconnect', () => {
      this._stopPing();
      this._emit('disconnected');
    });
  }

  createRoom(mode, variantConfig) {
    if (this.socket) {
      this.socket.emit('createRoom', { mode, variantConfig });
    }
  }

  joinRoom(code, variantConfig) {
    if (this.socket) {
      this.socket.emit('joinRoom', { code, variantConfig });
    }
  }

  // ========== INPUT (binary encoded, always sent reliably) ==========

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

    // Binary encode and send reliably (never volatile — every input matters
    // for server-side processing and reconciliation seq tracking)
    if (this.socket) {
      this.socket.emit('input', encodeInput(input));
    }

    return input;
  }

  // ========== INTERPOLATION (with SLERP + adaptive delay) ==========

  getInterpolatedState() {
    const renderTime = performance.now() - this._adaptiveDelay;

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
      return this.snapshots[this.snapshots.length - 1];
    }

    const range = after.localTime - before.localTime;
    const t = range > 0 ? (renderTime - before.localTime) / range : 0;

    return this._lerpSnapshots(before, after, t);
  }

  _lerpSnapshots(a, b, t) {
    return {
      tick: b.tick,
      ball: this._lerpBall(a.ball, b.ball, t),
      players: a.players.map((pa, i) => this._lerpPlayer(pa, b.players[i], t)),
      boostPads: b.boostPads,
      score: b.score,
      timer: b.timer,
      state: b.state,
      localTime: a.localTime + (b.localTime - a.localTime) * t,
    };
  }

  _lerpBall(a, b, t) {
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
    // Position + velocity: linear interpolation
    const result = {
      px: a.px + (b.px - a.px) * t,
      py: a.py + (b.py - a.py) * t,
      pz: a.pz + (b.pz - a.pz) * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      vz: a.vz + (b.vz - a.vz) * t,
      avx: a.avx + (b.avx - a.avx) * t,
      avy: a.avy + (b.avy - a.avy) * t,
      avz: a.avz + (b.avz - a.avz) * t,
      boost: a.boost + (b.boost - a.boost) * t,
      demolished: b.demolished,
      lastProcessedInput: b.lastProcessedInput,
    };

    // Quaternion: SLERP for smooth rotation interpolation
    const sq = slerp(a.qx, a.qy, a.qz, a.qw, b.qx, b.qy, b.qz, b.qw, t);
    result.qx = sq[0];
    result.qy = sq[1];
    result.qz = sq[2];
    result.qw = sq[3];

    return result;
  }

  // ========== ADAPTIVE INTERPOLATION ==========

  _updateJitter(now) {
    if (this._lastPacketTime > 0) {
      const interval = now - this._lastPacketTime;
      this._packetIntervals.push(interval);
      if (this._packetIntervals.length > 30) {
        this._packetIntervals.shift();
      }

      if (this._packetIntervals.length >= 10) {
        const intervals = this._packetIntervals;
        const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
        const variance = intervals.reduce((s, v) => s + (v - avg) * (v - avg), 0) / intervals.length;
        const jitter = Math.sqrt(variance);

        // Target delay: 2 packet intervals + 2x jitter margin for safety
        const target = avg * 2 + jitter * 2;
        const clamped = Math.max(
          NETWORK.MIN_INTERPOLATION_DELAY,
          Math.min(NETWORK.MAX_INTERPOLATION_DELAY, target)
        );

        // Slow ramp-up (increase delay quickly), slow ramp-down (decrease cautiously)
        const rate = clamped > this._adaptiveDelay ? 0.15 : 0.03;
        this._adaptiveDelay += (clamped - this._adaptiveDelay) * rate;
      }
    }
    this._lastPacketTime = now;
  }

  getAdaptiveDelay() {
    return this._adaptiveDelay;
  }

  // ========== RTT MEASUREMENT ==========

  _startPing() {
    this._pingInterval = setInterval(() => {
      if (this.socket) {
        this._pingStart = performance.now();
        this.socket.volatile.emit('ping_measure');
      }
    }, NETWORK.PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  getRTT() {
    return this.rtt;
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
    this._stopPing();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._callbacks = {};
    this.snapshots = [];
    this.pendingInputs = [];
    this._packetIntervals = [];
  }
}

// ========== SLERP (quaternion spherical interpolation) ==========

function slerp(ax, ay, az, aw, bx, by, bz, bw, t) {
  // Compute dot product
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  // If dot < 0, negate one quaternion to take shortest path
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }

  // If very close, use linear interpolation to avoid division by zero
  if (dot > 0.9995) {
    const rx = ax + (bx - ax) * t;
    const ry = ay + (by - ay) * t;
    const rz = az + (bz - az) * t;
    const rw = aw + (bw - aw) * t;
    const inv = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    return [rx * inv, ry * inv, rz * inv, rw * inv];
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  return [
    ax * wa + bx * wb,
    ay * wa + by * wb,
    az * wa + bz * wb,
    aw * wa + bw * wb,
  ];
}
