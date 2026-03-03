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
 * @returns {{x:number,y:number,z:number}} velocity impulse to apply to ball
 */
export function computeBallHitImpulse(ballPos, ballVel, carPos, carVel, carForward) {
  // Direction: from car toward ball, with squished vertical + car-facing bias
  let dx = ballPos.x - carPos.x;
  let dy = (ballPos.y - carPos.y) * 0.35;
  let dz = ballPos.z - carPos.z;

  // Bias toward car forward
  dx -= 0.35 * carForward.x;
  dy -= 0.35 * carForward.y;
  dz -= 0.35 * carForward.z;

  // Suppress upward impulse when both car and ball are on the ground
  // (prevents ball popping up during normal dribbling)
  const bothLow = ballPos.y < 3.5 && carPos.y < 2.0;
  if (bothLow && dy > 0) {
    dy *= 0.15;
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

  // Power curve: slight super-linear scaling
  const powerFactor = 1.0 + 0.5 * Math.min(relSpeed / 50, 1.0);

  const mag = relSpeed * powerFactor;

  return {
    x: dx * mag,
    y: dy * mag,
    z: dz * mag,
  };
}
