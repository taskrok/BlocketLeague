// ============================================
// NetworkManager — Client socket.io wrapper
// Binary protocol, input deduplication, adaptive interpolation,
// RTT measurement, SLERP quaternion interpolation
// Optimized: zero-allocation interpolation, pooled objects, ring buffers
// ============================================

import { io } from 'socket.io-client';
import { NETWORK } from '../../shared/constants.js';
import { decodeGameState, encodeInput } from '../../shared/BinaryProtocol.js';

// Max players we'll ever support (for pre-allocating player arrays)
const MAX_SUPPORTED_PLAYERS = 4;

export class NetworkManager {
  constructor() {
    this.socket = null;
    this.seq = 0;
    this.playerNumber = -1;

    // Snapshot ring buffer for interpolation (fixed-size, O(1) push)
    this.maxSnapshots = 30;
    this._snapshotBuf = new Array(this.maxSnapshots);
    this._snapshotHead = 0;  // next write index
    this._snapshotCount = 0; // number of valid entries

    // Pre-allocate snapshot objects in the ring buffer to avoid GC pressure.
    // Each snapshot is a deep structure that gets overwritten on receive.
    for (let s = 0; s < this.maxSnapshots; s++) {
      this._snapshotBuf[s] = this._createEmptySnapshot();
    }

    // Pending input buffer for client-side prediction reconciliation
    this.pendingInputs = [];

    // Event callbacks
    this._callbacks = {};

    // Adaptive interpolation — ring buffer instead of shift/push array
    this._jitterBuf = new Float64Array(30);
    this._jitterHead = 0;
    this._jitterCount = 0;
    this._lastPacketTime = 0;
    this._adaptiveDelay = NETWORK.INTERPOLATION_DELAY;

    // RTT measurement
    this.rtt = 0;
    this.playerPings = null; // per-slot ping array from server
    this._pingStart = 0;
    this._pingInterval = null;

    // Pre-allocated interpolation result (reused every frame, avoids GC)
    this._interpResult = this._createEmptySnapshot();

    // Pre-allocated input object for sendInput (reused, copy returned)
    this._inputPool = [];
    this._inputPoolSize = 120; // enough for ~2s of inputs at 60Hz
    for (let i = 0; i < this._inputPoolSize; i++) {
      this._inputPool.push({
        seq: 0, throttle: 0, steer: 0, jump: false, jumpPressed: false,
        boost: false, airRoll: 0, pitchUp: false, pitchDown: false,
        handbrake: false, dodgeForward: 0, dodgeSteer: 0,
      });
    }
    this._inputPoolHead = 0;
  }

  _createEmptySnapshot() {
    const players = [];
    for (let i = 0; i < MAX_SUPPORTED_PLAYERS; i++) {
      players.push({
        px: 0, py: 0, pz: 0,
        vx: 0, vy: 0, vz: 0,
        qx: 0, qy: 0, qz: 0, qw: 1,
        avx: 0, avy: 0, avz: 0,
        boost: 0, demolished: false, lastProcessedInput: 0,
      });
    }
    return {
      tick: 0,
      ball: { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      players,
      playerCount: 0,
      boostPads: new Uint8Array(5),
      score: { blue: 0, orange: 0 },
      timer: 0,
      state: 'waiting',
      localTime: 0,
      serverTime: 0,
    };
  }

  // Deep-copy a decoded snapshot into a pre-allocated target
  _copySnapshotInto(target, src) {
    target.tick = src.tick;
    target.state = src.state;
    target.timer = src.timer;
    target.score.blue = src.score.blue;
    target.score.orange = src.score.orange;
    target.localTime = src.localTime || 0;
    target.serverTime = src.serverTime || 0;

    // Copy boost pads
    const srcPads = src.boostPads;
    const tgtPads = target.boostPads;
    for (let i = 0; i < 5; i++) tgtPads[i] = srcPads[i];

    // Copy ball
    const sb = src.ball, tb = target.ball;
    tb.px = sb.px; tb.py = sb.py; tb.pz = sb.pz;
    tb.vx = sb.vx; tb.vy = sb.vy; tb.vz = sb.vz;
    tb.qx = sb.qx; tb.qy = sb.qy; tb.qz = sb.qz; tb.qw = sb.qw;

    // Copy players
    const playerCount = src.players.length;
    target.playerCount = playerCount;
    for (let i = 0; i < playerCount; i++) {
      const sp = src.players[i], tp = target.players[i];
      tp.px = sp.px; tp.py = sp.py; tp.pz = sp.pz;
      tp.vx = sp.vx; tp.vy = sp.vy; tp.vz = sp.vz;
      tp.qx = sp.qx; tp.qy = sp.qy; tp.qz = sp.qz; tp.qw = sp.qw;
      tp.avx = sp.avx; tp.avy = sp.avy; tp.avz = sp.avz;
      tp.boost = sp.boost;
      tp.demolished = sp.demolished;
      tp.lastProcessedInput = sp.lastProcessedInput;
    }
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
      // Decode binary protocol (returns a pooled object — we must copy it)
      const decoded = decodeGameState(data);
      if (!decoded) return; // version mismatch or decode failure

      const now = performance.now();

      // Copy decoded state into our ring buffer's pre-allocated snapshot
      const snapshot = this._snapshotBuf[this._snapshotHead];
      this._copySnapshotInto(snapshot, decoded);
      snapshot.localTime = now;

      // Update adaptive interpolation delay
      this._updateJitter(now);

      // Advance ring buffer head
      this._snapshotHead = (this._snapshotHead + 1) % this.maxSnapshots;
      if (this._snapshotCount < this.maxSnapshots) {
        this._snapshotCount++;
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

    this.socket.on('playerDisconnected', (data) => {
      this._emit('playerDisconnected', data);
    });

    this.socket.on('matchFound', (data) => {
      this._emit('matchFound', data);
    });

    this.socket.on('queueUpdate', (data) => {
      this._emit('queueUpdate', data);
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

    this.socket.on('quickChat', (data) => {
      this._emit('quickChat', data);
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

  createRoom(mode, variantConfig, playerName) {
    if (this.socket) {
      this.socket.emit('createRoom', { mode, variantConfig, playerName });
    }
  }

  joinRoom(code, variantConfig, playerName) {
    if (this.socket) {
      this.socket.emit('joinRoom', { code, variantConfig, playerName });
    }
  }

  quickMatch(variantConfig, playerName, mode) {
    if (this.socket) {
      this.socket.emit('quickMatch', { variantConfig, playerName, mode: mode || '1v1' });
    }
  }

  cancelQueue() {
    if (this.socket) {
      this.socket.emit('cancelQueue');
    }
  }

  switchTeam() {
    if (this.socket) {
      this.socket.emit('switchTeam');
    }
  }

  // ========== INPUT (binary encoded, always sent reliably) ==========

  sendInput(inputState) {
    this.seq++;

    // Get a pooled input object instead of allocating a new one
    const input = this._inputPool[this._inputPoolHead];
    this._inputPoolHead = (this._inputPoolHead + 1) % this._inputPoolSize;

    input.seq = this.seq;
    input.throttle = inputState.throttle;
    input.steer = inputState.steer;
    input.jump = inputState.jump;
    input.jumpPressed = inputState.jumpPressed;
    input.boost = inputState.boost;
    input.airRoll = inputState.airRoll;
    input.pitchUp = inputState.pitchUp;
    input.pitchDown = inputState.pitchDown;
    input.handbrake = inputState.handbrake;
    input.dodgeForward = inputState.dodgeForward;
    input.dodgeSteer = inputState.dodgeSteer;

    // Binary encode and send reliably (never volatile — every input matters
    // for server-side processing and reconciliation seq tracking)
    if (this.socket) {
      this.socket.emit('input', encodeInput(input));
    }

    return input;
  }

  // ========== RING BUFFER ACCESS ==========

  // Get snapshot by logical index (0 = oldest, count-1 = newest)
  _getSnapshot(logicalIndex) {
    const start = (this._snapshotHead - this._snapshotCount + this.maxSnapshots) % this.maxSnapshots;
    return this._snapshotBuf[(start + logicalIndex) % this.maxSnapshots];
  }

  // ========== INTERPOLATION (with SLERP + adaptive delay) ==========

  getInterpolatedState() {
    const count = this._snapshotCount;
    const renderTime = performance.now() - this._adaptiveDelay;

    if (count < 2) {
      return count > 0 ? this._getSnapshot(count - 1) : null;
    }

    // Find the two snapshots bracketing renderTime
    let before = null;
    let after = null;

    for (let i = 0; i < count - 1; i++) {
      const a = this._getSnapshot(i);
      const b = this._getSnapshot(i + 1);
      if (a.localTime <= renderTime && b.localTime >= renderTime) {
        before = a;
        after = b;
        break;
      }
    }

    if (!before || !after) {
      return this._getSnapshot(count - 1);
    }

    const range = after.localTime - before.localTime;
    const t = range > 0 ? (renderTime - before.localTime) / range : 0;

    // Write interpolated result into pre-allocated object (zero allocation)
    this._lerpSnapshotsInto(this._interpResult, before, after, t);
    return this._interpResult;
  }

  _lerpSnapshotsInto(out, a, b, t) {
    out.tick = b.tick;
    out.state = b.state;
    out.timer = b.timer;
    out.localTime = a.localTime + (b.localTime - a.localTime) * t;
    out.serverTime = a.serverTime + (b.serverTime - a.serverTime) * t;

    // Copy boost pads and score from 'b' (latest)
    const srcPads = b.boostPads;
    const tgtPads = out.boostPads;
    for (let i = 0; i < 5; i++) tgtPads[i] = srcPads[i];
    out.score.blue = b.score.blue;
    out.score.orange = b.score.orange;

    // Interpolate ball
    this._lerpBallInto(out.ball, a.ball, b.ball, t);

    // Interpolate players
    const playerCount = b.playerCount || b.players.length;
    out.playerCount = playerCount;
    for (let i = 0; i < playerCount; i++) {
      this._lerpPlayerInto(out.players[i], a.players[i], b.players[i], t);
    }
  }

  _lerpBallInto(out, a, b, t) {
    out.px = a.px + (b.px - a.px) * t;
    out.py = a.py + (b.py - a.py) * t;
    out.pz = a.pz + (b.pz - a.pz) * t;
    out.vx = a.vx + (b.vx - a.vx) * t;
    out.vy = a.vy + (b.vy - a.vy) * t;
    out.vz = a.vz + (b.vz - a.vz) * t;
    // SLERP for ball quaternion (writes directly into out.qx/qy/qz/qw)
    slerpInto(out, a.qx, a.qy, a.qz, a.qw, b.qx, b.qy, b.qz, b.qw, t);
  }

  _lerpPlayerInto(out, a, b, t) {
    // Position + velocity: linear interpolation
    out.px = a.px + (b.px - a.px) * t;
    out.py = a.py + (b.py - a.py) * t;
    out.pz = a.pz + (b.pz - a.pz) * t;
    out.vx = a.vx + (b.vx - a.vx) * t;
    out.vy = a.vy + (b.vy - a.vy) * t;
    out.vz = a.vz + (b.vz - a.vz) * t;
    out.avx = a.avx + (b.avx - a.avx) * t;
    out.avy = a.avy + (b.avy - a.avy) * t;
    out.avz = a.avz + (b.avz - a.avz) * t;
    out.boost = a.boost + (b.boost - a.boost) * t;
    out.demolished = b.demolished;
    out.lastProcessedInput = b.lastProcessedInput;

    // Quaternion: SLERP for smooth rotation interpolation (writes into out)
    slerpInto(out, a.qx, a.qy, a.qz, a.qw, b.qx, b.qy, b.qz, b.qw, t);
  }

  // ========== ADAPTIVE INTERPOLATION ==========

  _updateJitter(now) {
    if (this._lastPacketTime > 0) {
      const interval = now - this._lastPacketTime;

      // Ring buffer for jitter intervals (avoids shift/push array operations)
      this._jitterBuf[this._jitterHead] = interval;
      this._jitterHead = (this._jitterHead + 1) % 30;
      if (this._jitterCount < 30) this._jitterCount++;

      if (this._jitterCount >= 10) {
        // Compute avg and variance using for-loop (avoids .reduce closure allocation)
        let sum = 0;
        for (let i = 0; i < this._jitterCount; i++) sum += this._jitterBuf[i];
        const avg = sum / this._jitterCount;

        let varSum = 0;
        for (let i = 0; i < this._jitterCount; i++) {
          const diff = this._jitterBuf[i] - avg;
          varSum += diff * diff;
        }
        const jitter = Math.sqrt(varSum / this._jitterCount);

        // Target delay: 2 packet intervals + 2x jitter margin for safety
        const target = avg * 2 + jitter * 2;
        const clamped = target < NETWORK.MIN_INTERPOLATION_DELAY
          ? NETWORK.MIN_INTERPOLATION_DELAY
          : target > NETWORK.MAX_INTERPOLATION_DELAY
            ? NETWORK.MAX_INTERPOLATION_DELAY
            : target;

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
    // In-place removal instead of .filter() which creates a new array every call.
    // Inputs are always ordered by seq, so find the first keeper and shift.
    let writeIdx = 0;
    for (let i = 0; i < this.pendingInputs.length; i++) {
      if (this.pendingInputs[i].seq > seq) {
        this.pendingInputs[writeIdx++] = this.pendingInputs[i];
      }
    }
    this.pendingInputs.length = writeIdx;
  }

  getPendingInputs() {
    return this.pendingInputs;
  }

  getLatestSnapshot() {
    return this._snapshotCount > 0 ? this._getSnapshot(this._snapshotCount - 1) : null;
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
      for (let i = 0; i < cbs.length; i++) cbs[i](data);
    }
  }

  disconnect() {
    this._stopPing();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._callbacks = {};
    this._snapshotHead = 0;
    this._snapshotCount = 0;
    this.pendingInputs.length = 0;
    this._jitterHead = 0;
    this._jitterCount = 0;
    this._inputPoolHead = 0;
  }
}

// ========== SLERP (quaternion spherical interpolation, zero-allocation) ==========
// Writes result into target.qx, target.qy, target.qz, target.qw

function slerpInto(target, ax, ay, az, aw, bx, by, bz, bw, t) {
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
    target.qx = rx * inv;
    target.qy = ry * inv;
    target.qz = rz * inv;
    target.qw = rw * inv;
    return;
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  target.qx = ax * wa + bx * wb;
  target.qy = ay * wa + by * wb;
  target.qz = az * wa + bz * wb;
  target.qw = aw * wa + bw * wb;
}
