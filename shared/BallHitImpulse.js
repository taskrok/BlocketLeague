// ============================================
// BallHitImpulse — Psyonix-style directional ball impulse
// Pure math, no engine dependencies
// ============================================

/**
 * Compute a Psyonix-style velocity impulse for the ball when hit by a car.
 *
 * @param {{x:number,y:number,z:number}} ballPos
 * @param {{x:number,y:number,z:number}} ballVel
 * @param {{x:number,y:number,z:number}} carPos
 * @param {{x:number,y:number,z:number}} carVel
 * @param {{x:number,y:number,z:number}} carForward  unit vector
 * @param {object} [opts] optional car state flags
 * @param {number} [opts.carSpeed] car linear speed
 * @param {boolean} [opts.isDodging] car is in dodge flip
 * @param {boolean} [opts.dodgeDecaying] car is in dodge decay phase
 * @returns {{x:number,y:number,z:number}} velocity impulse to apply to ball
 */
export function computeBallHitImpulse(ballPos, ballVel, carPos, carVel, carForward, opts) {
  // Direction: from car toward ball, with squished vertical + car-facing bias
  let dx = ballPos.x - carPos.x;
  let dy = (ballPos.y - carPos.y) * 0.35;
  let dz = ballPos.z - carPos.z;

  const spd = opts && opts.carSpeed || 0;

  // Bias toward car forward — stronger at low speed to keep ball in front
  // when pushing/dribbling, weaker at high speed to allow natural deflection
  const fwdBias = spd < 20 ? 0.75 : 0.35;
  dx -= fwdBias * carForward.x;
  dy -= fwdBias * carForward.y;
  dz -= fwdBias * carForward.z;

  // Ground hit handling: suppress upward impulse at low speed (dribbling),
  // but allow a chip effect at high speed (ball pops up on hard ground hits)
  const bothLow = ballPos.y < 3.5 && carPos.y < 2.0;
  if (bothLow && dy > 0) {
    if (spd > 30) {
      // High speed: chip the ball upward — scale from 0.55 to 1.3
      const chipFactor = 0.55 + 0.75 * Math.min((spd - 30) / 16, 1.0);
      dy *= chipFactor;
    } else {
      // Low speed: keep ball flat (dribbling)
      dy *= 0.15;
    }
  }

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.001) {
    // Fallback: just use car forward
    dx = carForward.x;
    dy = carForward.y;
    dz = carForward.z;
  } else {
    dx /= len;
    dy /= len;
    dz /= len;
  }

  // Relative speed between car and ball
  const rvx = carVel.x - ballVel.x;
  const rvy = carVel.y - ballVel.y;
  const rvz = carVel.z - ballVel.z;
  const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);

  // Power curve: super-linear scaling
  const powerFactor = 1.0 + 0.5 * Math.min(relSpeed / 50, 1.0);

  // Supersonic bonus: ramp from 1.0 to 1.45 near supersonic/max speed
  let speedBonus = 1.0;
  if (spd > 38) {
    speedBonus = 1.0 + 0.45 * Math.min((spd - 38) / 8, 1.0);
  }

  // Dodge flip bonus: hits during a flip feel punchier
  let dodgeBonus = 1.0;
  if (opts && (opts.isDodging || opts.dodgeDecaying)) {
    dodgeBonus = 1.1;
  }

  const mag = relSpeed * powerFactor * speedBonus * dodgeBonus;

  return {
    x: dx * mag,
    y: dy * mag,
    z: dz * mag,
  };
}
