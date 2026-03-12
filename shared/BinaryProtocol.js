// ============================================
// Binary Protocol for network serialization
// ~80% smaller than JSON, works in Node.js + browser
// ============================================

export const PROTOCOL_VERSION = 1;

const QUAT_SCALE = 30000;
const AV_SCALE = 5000;
const ANALOG_SCALE = 127;

const STATE_TO_ID = { waiting: 0, countdown: 1, playing: 2, goal: 3, overtime: 4, ended: 5 };
const ID_TO_STATE = ['waiting', 'countdown', 'playing', 'goal', 'overtime', 'ended'];

// Layout: header(18) + ball(30) + players(42 each)
const HEADER_SIZE = 18;
const BALL_SIZE = 30;
const PLAYER_SIZE = 42;

function clampI16(v) {
  return Math.max(-32767, Math.min(32767, Math.round(v)));
}

// ========== GAME STATE ==========

export function encodeGameState(gs, playerCount) {
  const size = HEADER_SIZE + BALL_SIZE + playerCount * PLAYER_SIZE;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;

  // Header
  v.setUint8(o, PROTOCOL_VERSION); o += 1;                 // version
  v.setUint32(o, gs.tick, true); o += 4;                  // tick
  v.setUint8(o, STATE_TO_ID[gs.state] || 0); o += 1;     // state
  v.setUint8(o, playerCount); o += 1;                     // playerCount
  v.setFloat32(o, gs.timer, true); o += 4;                // timer
  v.setUint8(o, gs.score.blue); o += 1;                   // blueScore
  v.setUint8(o, gs.score.orange); o += 1;                 // orangeScore

  // Boost pad bitmask (5 bytes = 40 bits, supports up to 40 pads)
  const bp = gs.boostPads;
  if (bp instanceof Uint8Array) {
    for (let i = 0; i < 5; i++) bytes[o + i] = bp[i] || 0;
  } else {
    // Legacy: number bitmask (only works for pads 0-31)
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

  return buf;
}

export function decodeGameState(data) {
  // Handle Node.js Buffer or ArrayBuffer
  let buf;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    buf = data;
  } else {
    return data; // fallback: already an object
  }

  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;

  // Header
  const version = v.getUint8(o); o += 1;
  if (version !== PROTOCOL_VERSION) {
    return null; // version mismatch — incompatible binary protocol
  }
  const tick = v.getUint32(o, true); o += 4;
  const stateId = v.getUint8(o); o += 1;
  const playerCount = v.getUint8(o); o += 1;
  const timer = v.getFloat32(o, true); o += 4;
  const blueScore = v.getUint8(o); o += 1;
  const orangeScore = v.getUint8(o); o += 1;

  // Boost pad bitmask bytes
  const boostPads = new Uint8Array(5);
  for (let i = 0; i < 5; i++) boostPads[i] = bytes[o + i];
  o += 5;

  // Ball
  const ball = {};
  ball.px = v.getFloat32(o, true); o += 4;
  ball.py = v.getFloat32(o, true); o += 4;
  ball.pz = v.getFloat32(o, true); o += 4;
  ball.vx = v.getFloat32(o, true); o += 4;
  ball.vy = v.getFloat32(o, true); o += 4;
  ball.vz = v.getFloat32(o, true); o += 4;
  const bq = readQuat(v, o); o += 6;
  ball.qx = bq[0]; ball.qy = bq[1]; ball.qz = bq[2]; ball.qw = bq[3];

  // Players
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const p = {};
    p.px = v.getFloat32(o, true); o += 4;
    p.py = v.getFloat32(o, true); o += 4;
    p.pz = v.getFloat32(o, true); o += 4;
    p.vx = v.getFloat32(o, true); o += 4;
    p.vy = v.getFloat32(o, true); o += 4;
    p.vz = v.getFloat32(o, true); o += 4;
    const pq = readQuat(v, o); o += 6;
    p.qx = pq[0]; p.qy = pq[1]; p.qz = pq[2]; p.qw = pq[3];
    p.avx = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.avy = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.avz = v.getInt16(o, true) / AV_SCALE; o += 2;
    p.boost = v.getUint8(o); o += 1;
    p.demolished = v.getUint8(o) !== 0; o += 1;
    p.lastProcessedInput = v.getUint32(o, true); o += 4;
    players.push(p);
  }

  return {
    tick,
    state: ID_TO_STATE[stateId] || 'waiting',
    timer,
    score: { blue: blueScore, orange: orangeScore },
    boostPads,
    ball,
    players,
  };
}

// ========== INPUT ==========

const INPUT_SIZE = 10;

export function encodeInput(input) {
  const buf = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(buf);

  v.setUint32(0, input.seq, true);
  v.setInt8(4, Math.round((input.throttle || 0) * ANALOG_SCALE));
  v.setInt8(5, Math.round((input.steer || 0) * ANALOG_SCALE));
  v.setInt8(6, Math.round((input.airRoll || 0) * ANALOG_SCALE));
  v.setInt8(7, Math.round((input.dodgeForward || 0) * ANALOG_SCALE));
  v.setInt8(8, Math.round((input.dodgeSteer || 0) * ANALOG_SCALE));

  let flags = 0;
  if (input.jump) flags |= 1;
  if (input.jumpPressed) flags |= 2;
  if (input.boost) flags |= 4;
  if (input.pitchUp) flags |= 8;
  if (input.pitchDown) flags |= 16;
  if (input.handbrake) flags |= 32;
  v.setUint8(9, flags);

  return buf;
}

export function decodeInput(data) {
  let buf;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    buf = data;
  } else {
    return data; // fallback: already an object
  }

  const v = new DataView(buf);
  const flags = v.getUint8(9);

  return {
    seq: v.getUint32(0, true),
    throttle: v.getInt8(4) / ANALOG_SCALE,
    steer: v.getInt8(5) / ANALOG_SCALE,
    airRoll: v.getInt8(6) / ANALOG_SCALE,
    dodgeForward: v.getInt8(7) / ANALOG_SCALE,
    dodgeSteer: v.getInt8(8) / ANALOG_SCALE,
    jump: !!(flags & 1),
    jumpPressed: !!(flags & 2),
    boost: !!(flags & 4),
    pitchUp: !!(flags & 8),
    pitchDown: !!(flags & 16),
    handbrake: !!(flags & 32),
  };
}

// ========== QUATERNION COMPRESSION ==========
// Drop-w: negate q if qw < 0, encode qx/qy/qz as int16, reconstruct qw

function writeQuat(v, o, qx, qy, qz, qw) {
  if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; }
  v.setInt16(o, clampI16(qx * QUAT_SCALE), true);
  v.setInt16(o + 2, clampI16(qy * QUAT_SCALE), true);
  v.setInt16(o + 4, clampI16(qz * QUAT_SCALE), true);
  return o + 6;
}

function readQuat(v, o) {
  const qx = v.getInt16(o, true) / QUAT_SCALE;
  const qy = v.getInt16(o + 2, true) / QUAT_SCALE;
  const qz = v.getInt16(o + 4, true) / QUAT_SCALE;
  const wSq = 1 - qx * qx - qy * qy - qz * qz;
  const qw = wSq > 0 ? Math.sqrt(wSq) : 0;
  return [qx, qy, qz, qw];
}
