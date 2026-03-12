// ============================================
// Demolition - Shared demolition detection logic
// Used by both client Game.js and server GameRoom.js
// ============================================

import { CAR, DEMOLITION } from './constants.js';
import { COLLISION_GROUPS } from './constants.js';

/**
 * Check if a car-car collision results in a demolition.
 * Returns { attacker, victim } if a demolition occurs, or null if not.
 *
 * @param {object} carA - Car object with body (CANNON.Body), getSpeed(), demolished
 * @param {object} carB - Car object with body (CANNON.Body), getSpeed(), demolished
 * @returns {{ attacker: object, victim: object } | null}
 */
export function checkDemolition(carA, carB) {
  if (carA.demolished || carB.demolished) return null;

  const speedA = carA.getSpeed();
  const speedB = carB.getSpeed();

  // Demolition at supersonic speed -- but only if driving INTO the other car.
  // Dot product of attacker velocity direction vs direction toward victim must be > 0.5
  // (within ~60 degree cone). Side-by-side or same-direction travel won't demolish.
  if (speedA >= CAR.SUPERSONIC_THRESHOLD && speedA > speedB) {
    const va = carA.body.velocity;
    const dx = carB.body.position.x - carA.body.position.x;
    const dy = carB.body.position.y - carA.body.position.y;
    const dz = carB.body.position.z - carA.body.position.z;
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dot = (va.x * dx + va.y * dy + va.z * dz) / (speedA * dLen);
    if (dot > 0.5) {
      return { attacker: carA, victim: carB };
    }
  }

  if (speedB >= CAR.SUPERSONIC_THRESHOLD && speedB > speedA) {
    const vb = carB.body.velocity;
    const dx = carA.body.position.x - carB.body.position.x;
    const dy = carA.body.position.y - carB.body.position.y;
    const dz = carA.body.position.z - carB.body.position.z;
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dot = (vb.x * dx + vb.y * dy + vb.z * dz) / (speedB * dLen);
    if (dot > 0.5) {
      return { attacker: carB, victim: carA };
    }
  }

  return null;
}

/**
 * Handle sub-supersonic bump physics between two cars.
 * The faster car plows through, the slower car gets launched.
 *
 * @param {object} carA - Car object with body (CANNON.Body), getSpeed()
 * @param {object} carB - Car object with body (CANNON.Body), getSpeed()
 */
export function handleBump(carA, carB) {
  const speedA = carA.getSpeed();
  const speedB = carB.getSpeed();

  // Both nearly stationary, let physics handle it
  if (speedA < 2 && speedB < 2) return;

  const bumper = speedA >= speedB ? carA : carB;
  const bumped = bumper === carA ? carB : carA;

  // Direction from bumper to bumped
  const dx = bumped.body.position.x - bumper.body.position.x;
  const dz = bumped.body.position.z - bumper.body.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const nx = dx / dist;
  const nz = dz / dist;

  const bumperSpeed = bumper.getSpeed();
  const bumpStrength = Math.min(bumperSpeed * 0.3, 8);

  // Nudge the bumped car in bump direction + slight upward
  bumped.body.velocity.x += nx * bumpStrength;
  bumped.body.velocity.z += nz * bumpStrength;
  bumped.body.velocity.y += bumpStrength * 0.15;

  // Bumper loses a little speed
  const bv = bumper.body.velocity;
  bv.x *= 0.9;
  bv.z *= 0.9;
}

/**
 * Demolish a car: stop it, hide it below the arena, disable collisions.
 * Does NOT handle visual effects (explosions etc.) -- that's caller responsibility.
 *
 * @param {object} car - Car object with body and state (or combined as in current code)
 */
export function demolishCar(car) {
  car.demolished = true;
  car.respawnTimer = DEMOLITION.RESPAWN_TIME;
  car.body.velocity.set(0, 0, 0);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.position.y = -100;
  car.body.collisionFilterMask = 0;
}

/**
 * Update demolition timer and respawn if ready.
 *
 * @param {object} car - Car object
 * @param {number} dt - Delta time in seconds
 * @param {object} spawnPos - { x, y, z } spawn position
 * @param {number} direction - 1 or -1
 * @param {function} resetFn - Function to call for resetting the car (car.reset)
 * @returns {boolean} true if car respawned this frame
 */
export function updateDemolitionTimer(car, dt, spawnPos, direction, resetFn) {
  if (!car.demolished) return false;
  car.respawnTimer -= dt;
  if (car.respawnTimer <= 0) {
    car.demolished = false;
    car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
    resetFn(spawnPos, direction);
    return true;
  }
  return false;
}
