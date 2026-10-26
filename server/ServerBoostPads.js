// ============================================
// ServerBoostPads — Headless boost pad logic
// ============================================

import { ARENA, BOOST_PAD, BOOST_PAD_LAYOUT } from '../shared/constants.js';

export class ServerBoostPads {
  constructor() {
    this.pads = [];
    this._bitmaskBuf = null; // pre-allocated in _createPads after pad count is known
    this._createPads();
  }

  _createPads() {
    // Large pads first (same order as client)
    BOOST_PAD_LAYOUT.large.forEach(pos => {
      this.pads.push({
        x: pos.x * ARENA.WIDTH / 2,
        z: pos.z * ARENA.LENGTH / 2,
        isLarge: true,
        radius: BOOST_PAD.LARGE_RADIUS,
        radiusSq: BOOST_PAD.LARGE_RADIUS * BOOST_PAD.LARGE_RADIUS,
        amount: BOOST_PAD.LARGE_AMOUNT,
        respawnTime: BOOST_PAD.LARGE_RESPAWN_TIME,
        active: true,
        respawnTimer: 0,
      });
    });

    // Small pads
    BOOST_PAD_LAYOUT.small.forEach(pos => {
      this.pads.push({
        x: pos.x * ARENA.WIDTH / 2,
        z: pos.z * ARENA.LENGTH / 2,
        isLarge: false,
        radius: BOOST_PAD.SMALL_RADIUS,
        radiusSq: BOOST_PAD.SMALL_RADIUS * BOOST_PAD.SMALL_RADIUS,
        amount: BOOST_PAD.SMALL_AMOUNT,
        respawnTime: BOOST_PAD.SMALL_RESPAWN_TIME,
        active: true,
        respawnTimer: 0,
      });
    });

    // Pre-allocate bitmask buffer now that pad count is known
    this._bitmaskBuf = new Uint8Array(Math.ceil(this.pads.length / 8));
  }

  update(dt, cars) {
    // Indexed loops (no per-pad/per-car closures) and squared-distance
    // comparison against the precomputed radiusSq (no Math.sqrt per pair).
    const pads = this.pads;
    const numPads = pads.length;
    const numCars = cars.length;
    for (let i = 0; i < numPads; i++) {
      const pad = pads[i];
      if (!pad.active) {
        pad.respawnTimer -= dt;
        if (pad.respawnTimer <= 0) {
          pad.active = true;
        }
        continue;
      }

      // Check car pickups; the first car to pick up deactivates the pad
      for (let j = 0; j < numCars; j++) {
        const car = cars[j];
        const carPos = car.body.position;
        const dx = carPos.x - pad.x;
        const dz = carPos.z - pad.z;
        if (dx * dx + dz * dz < pad.radiusSq) {
          if (car.boost < 100 || pad.isLarge) {
            car.addBoost(pad.amount);
            pad.active = false;
            pad.respawnTimer = pad.respawnTime;
            break;
          }
        }
      }
    }
  }

  getActiveBitmask() {
    let mask = 0;
    for (let i = 0; i < Math.min(this.pads.length, 32); i++) {
      if (this.pads[i].active) {
        mask |= (1 << i);
      }
    }
    return mask;
  }

  // Returns Uint8Array bitmask supporting >32 pads (used by binary protocol)
  getActiveBitmaskBytes() {
    const bytes = this._bitmaskBuf;
    bytes.fill(0);
    for (let i = 0; i < this.pads.length; i++) {
      if (this.pads[i].active) {
        bytes[i >> 3] |= (1 << (i & 7));
      }
    }
    return bytes;
  }

  resetAll() {
    const pads = this.pads;
    for (let i = 0; i < pads.length; i++) {
      pads[i].active = true;
      pads[i].respawnTimer = 0;
    }
  }
}
