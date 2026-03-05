// ============================================
// ServerBoostPads — Headless boost pad logic
// ============================================

import { ARENA, BOOST_PAD, BOOST_PAD_LAYOUT } from '../shared/constants.js';

export class ServerBoostPads {
  constructor() {
    this.pads = [];
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
        amount: BOOST_PAD.SMALL_AMOUNT,
        respawnTime: BOOST_PAD.SMALL_RESPAWN_TIME,
        active: true,
        respawnTimer: 0,
      });
    });
  }

  update(dt, cars) {
    this.pads.forEach(pad => {
      if (!pad.active) {
        pad.respawnTimer -= dt;
        if (pad.respawnTimer <= 0) {
          pad.active = true;
        }
        return;
      }

      // Check car pickups
      cars.forEach(car => {
        if (!pad.active) return;
        const carPos = car.getPosition();
        const dx = carPos.x - pad.x;
        const dz = carPos.z - pad.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < pad.radius) {
          if (car.boost < 100 || pad.isLarge) {
            car.addBoost(pad.amount);
            pad.active = false;
            pad.respawnTimer = pad.respawnTime;
          }
        }
      });
    });
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
    const numBytes = Math.ceil(this.pads.length / 8);
    const bytes = new Uint8Array(numBytes);
    for (let i = 0; i < this.pads.length; i++) {
      if (this.pads[i].active) {
        bytes[i >> 3] |= (1 << (i & 7));
      }
    }
    return bytes;
  }

  resetAll() {
    this.pads.forEach(pad => {
      pad.active = true;
      pad.respawnTimer = 0;
    });
  }
}
