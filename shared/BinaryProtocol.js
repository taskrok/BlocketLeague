// ============================================
// Binary Protocol for network serialization
// ~80% smaller than JSON, works in Node.js + browser
// v2: server timestamp for clock-synced interpolation.
//     decodeGameStateInto() writes into a caller-owned snapshot object so the
//     client can decode straight into its ring buffer with zero allocation.
// ============================================

export const PROTOCOL_VERSION = 2;

const QUAT_SCALE = 30000;
const AV_SCALE = 5000;
const ANALOG_SCALE = 127;

const STATE_TO_ID = { waiting: 0, countdown: 1, playing: 2, goal: 3, overtime: 4, ended: 5 };
const ID_TO_STATE = ['waiting', 'countdown', 'playing', 'goal', 'overtime', 'ended'];

// Layout: header(22) + ball(30) + players(42 each)
// v2 header adds serverTime (Float32, 4 bytes)
const HEADER_SIZE = 22;
const BALL_SIZE = 30;
const PLAYER_SIZE = 42;

function clampI16(v) {
  return v < -32767 ? -32767 : v > 32767 ? 32767 : (v + 0.5) | 0;
}

// ========== PRE-ALLOCATED ENCODE BUFFERS (per player count) ==========
const _encodeBufs = {};
function _getEncodeBuf(playerCount) {
  if (!_encodeBufs[playerCount]) {
    const size = HEADER_SIZE + BALL_SIZE + playerCount * PLAYER_SIZE;
    const buf = new ArrayBuffer(size);
    _encodeBufs[playerCount] = {
      buf,
      view: new DataView(buf),
      bytes: new Uint8Array(buf),
    };
  }
  return _encodeBufs[playerCount];
}

// ========== GAME STATE ==========

export function encodeGameState(gs, playerCount) {
  const cached = _getEncodeBuf(playerCount);
  const buf = cached.buf;
  const v = cached.view;
  const bytes = cached.bytes;
  let o = 0;

  // Header
  v.setUint8(o, PROTOCOL_VERSION); o += 1;
  v.setUint32(o, gs.tick, true); o += 4;
  v.setUint8(o, STATE_TO_ID[gs.state] || 0); o += 1;
  v.setUint8(o, playerCount); o += 1;
  v.setFloat32(o, gs.timer, true); o += 4;
  v.setUint8(o, gs.score.blue); o += 1;
  v.setUint8(o, gs.score.orange); o += 1;
  v.setFloat32(o, gs.serverTime || 0, true); o += 4;  // server timestamp (seconds)

  // Boost pad bitmask (5 bytes = 40 bits)
  const bp = gs.boostPads;
  if (bp instanceof Uint8Array) {
    for (let i = 0; i < 5; i++) bytes[o + i] = bp[i] || 0;
  } else {
    for (let i = 0; i < 4; i++) bytes[o + i] = (bp >>> (i * 8)) & 0xFF;
    bytes[o + 4] = 0;
  }
  o += 5;

  // Ball: position(12) + velocity(12) + quat(6) = 30
  const b = gs.ball;
  v.setFloat32(o, b.px, true); o += 4;
  v.setFloat32(o, b.py, true); o += 4;
  v.setFloat32(o, b.pz, true); o += 4;
  v.setFloat32(o, b.vx, true); o += 4;
  v.setFloat32(o, b.vy, true); o += 4;
  v.setFloat32(o, b.vz, true); o += 4;
  o = writeQuat(v, o, b.qx, b.qy, b.qz, b.qw);

  // Players
  for (let i = 0; i < playerCount; i++) {
    const p = gs.players[i];
    v.setFloat32(o, p.px, true); o += 4;
    v.setFloat32(o, p.py, true); o += 4;
    v.setFloat32(o, p.pz, true); o += 4;
    v.setFloat32(o, p.vx, true); o += 4;
    v.setFloat32(o, p.vy, true); o += 4;
    v.setFloat32(o, p.vz, true); o += 4;
    o = writeQuat(v, o, p.qx, p.qy, p.qz, p.qw);
    v.setInt16(o, clampI16(p.avx * AV_SCALE), true); o += 2;
    v.setInt16(o, clampI16(p.avy * AV_SCALE), true); o += 2;
    v.setInt16(o, clampI16(p.avz * AV_SCALE), true); o += 2;
    v.setUint8(o, Math.round(Math.min(100, Math.max(0, p.boost)))); o += 1;
    v.setUint8(o, p.demolished ? 1 : 0); o += 1;
    v.setUint32(o, p.lastProcessedInput || 0, true); o += 4;
  }

  return buf.slice(0);
}

// ---- Decode-side DataView cache ----
// A DataView is only reused when the incoming message shares the same
// underlying ArrayBuffer as the previous one (true for Node Buffers carved
// from the shared pool; browsers hand us a fresh ArrayBuffer per message, in
// which case one DataView per packet is unavoidable).
let _decodeBuf = null;   // underlying ArrayBuffer of the cached view
let _decodeView = null;  // DataView over the WHOLE underlying buffer
let _decodeBase = 0;     // byte offset of the current message inside it

// Returns true when `data` is binary and _decodeView/_decodeBase are ready.
function _prepareDecodeView(data) {
  let ab, base;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    ab = data.buffer; base = data.byteOffset;
  } else if (data instanceof ArrayBuffer) {
    ab = data; base = 0;
  } else if (ArrayBuffer.isView(data)) {
    ab = data.buffer; base = data.byteOffset;
  } else {
    return false;
  }
  if (ab !== _decodeBuf) {
    _decodeBuf = ab;
    _decodeView = new DataView(ab);
  }
  _decodeBase = base;
  return true;
}

function _newPlayerState() {
  return {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    avx: 0, avy: 0, avz: 0,
    boost: 0, demolished: false, lastProcessedInput: 0,
  };
}

// Allocates a snapshot object with the shape decodeGameStateInto() expects.
// `playerSlots` player objects are pre-created so decoding never allocates.
export function createGameStateTarget(playerSlots = 0) {
  const players = new Array(playerSlots);
  for (let i = 0; i < playerSlots; i++) players[i] = _newPlayerState();
  return {
    tick: 0,
    state: 'waiting',
    timer: 0,
    score: { blue: 0, orange: 0 },
    boostPads: new Uint8Array(5),
    ball: { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    players,
    playerCount: 0,
    serverTime: 0,
  };
}

/**
 * Decode a binary game state packet directly into `target` (zero allocation
 * in steady state). `target` must have the shape produced by
 * createGameStateTarget(): ball, players[] (grown lazily if the packet has
 * more players than slots, never shrunk), score, boostPads Uint8Array(5),
 * tick, timer, state, serverTime, playerCount.
 *
 * Returns `target` on success, or null if `data` is not binary or carries a
 * different protocol version. `target.playerCount` holds the decoded player
 * count; `target.players.length` may be larger (pre-allocated slots).
 */
export function decodeGameStateInto(data, target) {
  if (!_prepareDecodeView(data)) return null;
  const v = _decodeView;
  let o = _decodeBase;

  // Header
  const version = v.getUint8(o); o += 1;
  if (version !== PROTOCOL_VERSION) {
    return null;
  }
  target.tick = v.getUint32(o, true); o += 4;
  target.state = ID_TO_STATE[v.getUint8(o)] || 'waiting'; o += 1;
  const playerCount = v.getUint8(o); o += 1;
  target.timer = v.getFloat32(o, true); o += 4;
  target.score.blue = v.getUint8(o); o += 1;
  target.score.orange = v.getUint8(o); o += 1;
  target.serverTime = v.getFloat32(o, true); o += 4;

  // Boost pad bitmask
  const boostPads = target.boostPads;
  for (let i = 0; i < 5; i++) boostPads[i] = v.getUint8(o + i);
  o += 5;

  // Ball
  const ball = target.ball;
  ball.px = v.getFloat32(o, true); o += 4;
  ball.py = v.getFloat32(o, true); o += 4;
  ball.pz = v.getFloat32(o, true); o += 4;
  ball.vx = v.getFloat32(o, true); o += 4;
  ball.vy = v.getFloat32(o, true); o += 4;
  ball.vz = v.getFloat32(o, true); o += 4;
  readQuatInto(v, o, ball); o += 6;

  // Players
  const players = target.players;
  target.playerCount = playerCount;
  for (let i = 0; i < playerCount; i++) {
    let p = players[i];
    if (p === undefined) p = players[i] = _newPlayerState(); // one-time growth
    p.px = v.getFloat32(o, true); o += 4;
    p.py = v.getFloat32(o, true); o += 4;
    p.pz = v.getFloat32(o, true); o += 4;
    p.vx = v.getFloat32(o, true); o += 4;
    p.vy = v.getFloat32(o, true); o += 4;
    p.vz = v.getFloat32(o, true); o += 4;
    readQuatInto(v, o, p); o += 6;
    p.avx = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.avy = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.avz = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.boost = v.getUint8(o); o += 1;
    p.demolished = v.getUint8(o) !== 0; o += 1;
    p.lastProcessedInput = v.getUint32(o, true); o += 4;
  }

  return target;
}

// Allocating convenience wrapper: returns a fresh snapshot whose
// players.length === decoded player count. Prefer decodeGameStateInto()
// on hot paths.
export function decodeGameState(data) {
  if (!(typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) &&
      !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    return data; // fallback: already an object
  }
  return decodeGameStateInto(data, createGameStateTarget(0));
}

// ========== INPUT ==========

const INPUT_SIZE = 10;

const _inputBuf = new ArrayBuffer(INPUT_SIZE);
const _inputView = new DataView(_inputBuf);

export function encodeInput(input) {
  _inputView.setUint32(0, input.seq, true);
  _inputView.setInt8(4, Math.round((input.throttle || 0) * ANALOG_SCALE));
  _inputView.setInt8(5, Math.round((input.steer || 0) * ANALOG_SCALE));
  _inputView.setInt8(6, Math.round((input.airRoll || 0) * ANALOG_SCALE));
  _inputView.setInt8(7, Math.round((input.dodgeForward || 0) * ANALOG_SCALE));
  _inputView.setInt8(8, Math.round((input.dodgeSteer || 0) * ANALOG_SCALE));

  let flags = 0;
  if (input.jump) flags |= 1;
  if (input.jumpPressed) flags |= 2;
  if (input.boost) flags |= 4;
  if (input.pitchUp) flags |= 8;
  if (input.pitchDown) flags |= 16;
  if (input.handbrake) flags |= 32;
  _inputView.setUint8(9, flags);

  return _inputBuf.slice(0);
}

/**
 * Decode a binary input packet into `target` (zero allocation in steady
 * state; the DataView is reused while messages share an underlying buffer).
 * Returns `target`, or null if `data` is not binary.
 */
export function decodeInputInto(data, target) {
  if (!_prepareDecodeView(data)) return null;
  const v = _decodeView;
  const o = _decodeBase;

  const flags = v.getUint8(o + 9);

  target.seq = v.getUint32(o, true);
  target.throttle = v.getInt8(o + 4) / ANALOG_SCALE;
  target.steer = v.getInt8(o + 5) / ANALOG_SCALE;
  target.airRoll = v.getInt8(o + 6) / ANALOG_SCALE;
  target.dodgeForward = v.getInt8(o + 7) / ANALOG_SCALE;
  target.dodgeSteer = v.getInt8(o + 8) / ANALOG_SCALE;
  target.jump = !!(flags & 1);
  target.jumpPressed = !!(flags & 2);
  target.boost = !!(flags & 4);
  target.pitchUp = !!(flags & 8);
  target.pitchDown = !!(flags & 16);
  target.handbrake = !!(flags & 32);

  return target;
}

// Module-level reusable result for decodeInput(). The SAME object is returned
// on every call and overwritten by the next decode — callers that retain the
// input must copy its fields out (server/GameRoom.receiveInput does this).
const _decodedInput = {
  seq: 0, throttle: 0, steer: 0, airRoll: 0,
  dodgeForward: 0, dodgeSteer: 0,
  jump: false, jumpPressed: false, boost: false,
  pitchUp: false, pitchDown: false, handbrake: false,
};

export function decodeInput(data) {
  const r = decodeInputInto(data, _decodedInput);
  return r === null ? data : r; // non-binary fallback: already an object
}

// ========== QUATERNION COMPRESSION ==========

function writeQuat(v, o, qx, qy, qz, qw) {
  if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; }
  v.setInt16(o, clampI16(qx * QUAT_SCALE), true);
  v.setInt16(o + 2, clampI16(qy * QUAT_SCALE), true);
  v.setInt16(o + 4, clampI16(qz * QUAT_SCALE), true);
  return o + 6;
}

function readQuatInto(v, o, target) {
  const qx = v.getInt16(o, true) / QUAT_SCALE;
  const qy = v.getInt16(o + 2, true) / QUAT_SCALE;
  const qz = v.getInt16(o + 4, true) / QUAT_SCALE;
  const wSq = 1 - qx * qx - qy * qy - qz * qz;
  target.qx = qx;
  target.qy = qy;
  target.qz = qz;
  target.qw = wSq > 0 ? Math.sqrt(wSq) : 0;
}
