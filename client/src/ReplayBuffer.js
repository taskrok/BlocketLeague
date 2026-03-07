// ============================================
// ReplayBuffer - Circular buffer for goal replays
// Records the last 5 seconds (300 frames @ 60Hz)
// ============================================

const MAX_FRAMES = 300; // 5 seconds × 60 fps
const MAX_CARS = 4;

export class ReplayBuffer {
  constructor() {
    this._frames = new Array(MAX_FRAMES);
    this._head = 0;   // next write position
    this._count = 0;  // how many frames stored
    this._pendingEvents = []; // events to attach to the next recorded frame
  }

  /**
   * Queue an event (explosion, etc.) to be stored with the next frame.
   * @param {object} event - { type: 'demolish'|'goal', x, y, z, color }
   */
  addEvent(event) {
    this._pendingEvents.push(event);
  }

  /**
   * Record a frame from live physics (singleplayer).
   * @param {object} ball  - ball.body (pos, vel, quat)
   * @param {Car[]} cars   - array of Car instances
   * @param {object} boostPads - BoostPads instance
   */
  record(ball, cars, boostPads) {
    const frame = this._frames[this._head] || (this._frames[this._head] = {});

    // Ball state
    const bp = ball.body.position;
    const bv = ball.body.velocity;
    const bq = ball.body.quaternion;
    frame.ball = {
      px: bp.x, py: bp.y, pz: bp.z,
      vx: bv.x, vy: bv.y, vz: bv.z,
      qx: bq.x, qy: bq.y, qz: bq.z, qw: bq.w,
    };

    // Cars state
    if (!frame.cars) frame.cars = [];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) {
        frame.cars[i] = null;
        continue;
      }
      const cp = car.body.position;
      const cv = car.body.velocity;
      const cq = car.body.quaternion;
      frame.cars[i] = {
        px: cp.x, py: cp.y, pz: cp.z,
        vx: cv.x, vy: cv.y, vz: cv.z,
        qx: cq.x, qy: cq.y, qz: cq.z, qw: cq.w,
        boost: car.boost,
        boosting: car.boostFlame ? car.boostFlame.visible : false,
        demolished: car.demolished,
      };
    }

    // Boost pads bitmask
    frame.boostPadMask = this._packBoostPads(boostPads);

    // Attach any pending events
    frame.events = this._pendingEvents.length > 0 ? this._pendingEvents.splice(0) : null;

    this._head = (this._head + 1) % MAX_FRAMES;
    if (this._count < MAX_FRAMES) this._count++;
  }

  /**
   * Record a frame from interpolated multiplayer snapshot.
   * @param {object} ballData   - { px, py, pz, vx, vy, vz, qx, qy, qz, qw }
   * @param {object[]} carsData - array of car state objects (same shape as above + boost/demolished)
   * @param {object} boostPads  - BoostPads instance
   */
  recordFromSnapshot(ballData, carsData, boostPads) {
    const frame = this._frames[this._head] || (this._frames[this._head] = {});

    frame.ball = { ...ballData };

    if (!frame.cars) frame.cars = [];
    for (let i = 0; i < carsData.length; i++) {
      frame.cars[i] = carsData[i] ? { ...carsData[i] } : null;
    }

    frame.boostPadMask = this._packBoostPads(boostPads);

    // Attach any pending events
    frame.events = this._pendingEvents.length > 0 ? this._pendingEvents.splice(0) : null;

    this._head = (this._head + 1) % MAX_FRAMES;
    if (this._count < MAX_FRAMES) this._count++;
  }

  /**
   * Get the most recent n frames in chronological order.
   */
  getRecentFrames(n) {
    const count = Math.min(n, this._count);
    if (count === 0) return [];

    const frames = new Array(count);
    let readIdx = (this._head - count + MAX_FRAMES) % MAX_FRAMES;
    for (let i = 0; i < count; i++) {
      frames[i] = this._frames[readIdx];
      readIdx = (readIdx + 1) % MAX_FRAMES;
    }
    return frames;
  }

  get frameCount() {
    return this._count;
  }

  clear() {
    this._head = 0;
    this._count = 0;
  }

  _packBoostPads(boostPads) {
    if (!boostPads || !boostPads.pads) return null;
    const pads = boostPads.pads;
    // Use a Uint8Array bitmask (supports up to 64 pads)
    const bytes = Math.ceil(pads.length / 8);
    const mask = new Uint8Array(bytes);
    for (let i = 0; i < pads.length; i++) {
      if (pads[i].active) {
        mask[i >> 3] |= (1 << (i & 7));
      }
    }
    return mask;
  }
}
