// ============================================
// ReplayBuffer - Circular buffer for goal replays
// Records the last 5 seconds (300 frames @ 60Hz)
// ============================================

const MAX_FRAMES = 300; // 5 seconds × 60 fps
const MAX_CARS = 4;

export class ReplayBuffer {
  constructor() {
    // Pre-allocate all frame slots to avoid per-frame object creation
    this._frames = new Array(MAX_FRAMES);
    for (let i = 0; i < MAX_FRAMES; i++) {
      this._frames[i] = {
        ball: { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
        cars: ReplayBuffer._allocCars(),
        carCount: 0,
        boostPadMask: new Uint8Array(5), // ceil(34 / 8) = 5 bytes, covers up to 40 pads
        events: null,
      };
    }
    this._head = 0;   // next write position
    this._count = 0;  // how many frames stored
    this._pendingEvents = []; // events to attach to the next recorded frame
  }

  static _allocCars() {
    const cars = new Array(MAX_CARS);
    for (let i = 0; i < MAX_CARS; i++) {
      cars[i] = {
        active: false,
        px: 0, py: 0, pz: 0,
        vx: 0, vy: 0, vz: 0,
        qx: 0, qy: 0, qz: 0, qw: 1,
        boost: 0,
        boosting: false,
        demolished: false,
      };
    }
    return cars;
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
    const frame = this._frames[this._head];

    // Ball state — copy into pre-allocated object
    const fb = frame.ball;
    const bp = ball.body.position;
    const bv = ball.body.velocity;
    const bq = ball.body.quaternion;
    fb.px = bp.x; fb.py = bp.y; fb.pz = bp.z;
    fb.vx = bv.x; fb.vy = bv.y; fb.vz = bv.z;
    fb.qx = bq.x; fb.qy = bq.y; fb.qz = bq.z; fb.qw = bq.w;

    // Cars state — copy into pre-allocated car slots
    frame.carCount = cars.length;
    for (let i = 0; i < cars.length; i++) {
      const fc = frame.cars[i];
      const car = cars[i];
      if (!car) {
        fc.active = false;
        continue;
      }
      fc.active = true;
      const cp = car.body.position;
      const cv = car.body.velocity;
      const cq = car.body.quaternion;
      fc.px = cp.x; fc.py = cp.y; fc.pz = cp.z;
      fc.vx = cv.x; fc.vy = cv.y; fc.vz = cv.z;
      fc.qx = cq.x; fc.qy = cq.y; fc.qz = cq.z; fc.qw = cq.w;
      fc.boost = car.boost;
      fc.boosting = car.boostFlame ? car.boostFlame.visible : false;
      fc.demolished = car.demolished;
    }

    // Boost pads bitmask — pack into pre-allocated Uint8Array
    this._packBoostPads(boostPads, frame.boostPadMask);

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
    const frame = this._frames[this._head];

    // Ball state — copy fields into pre-allocated object
    const fb = frame.ball;
    fb.px = ballData.px; fb.py = ballData.py; fb.pz = ballData.pz;
    fb.vx = ballData.vx; fb.vy = ballData.vy; fb.vz = ballData.vz;
    fb.qx = ballData.qx; fb.qy = ballData.qy; fb.qz = ballData.qz; fb.qw = ballData.qw;

    // Cars state — copy fields into pre-allocated car slots
    frame.carCount = carsData.length;
    for (let i = 0; i < carsData.length; i++) {
      const fc = frame.cars[i];
      const src = carsData[i];
      if (!src) {
        fc.active = false;
        continue;
      }
      fc.active = true;
      fc.px = src.px; fc.py = src.py; fc.pz = src.pz;
      fc.vx = src.vx; fc.vy = src.vy; fc.vz = src.vz;
      fc.qx = src.qx; fc.qy = src.qy; fc.qz = src.qz; fc.qw = src.qw;
      fc.boost = src.boost;
      fc.boosting = src.boosting;
      fc.demolished = src.demolished;
    }

    // Boost pads bitmask — pack into pre-allocated Uint8Array
    this._packBoostPads(boostPads, frame.boostPadMask);

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

  _packBoostPads(boostPads, mask) {
    if (!boostPads || !boostPads.pads) { mask.fill(0); return; }
    const pads = boostPads.pads;
    // Clear the pre-allocated mask, then set active bits
    mask.fill(0);
    for (let i = 0; i < pads.length; i++) {
      if (pads[i].active) {
        mask[i >> 3] |= (1 << (i & 7));
      }
    }
  }
}
