// ============================================
// ServerAI — Server-side AI controller
// "Pro" difficulty bot for replacing disconnected players
// Ported from client-side Game._updateAICar
// ============================================

import * as CANNON from 'cannon-es';
import { ARENA } from '../shared/constants.js';

const _euler = new CANNON.Vec3();

const PRO_PARAMS = {
  approachOffset: 12,
  attackAngle: 0.4,
  defenseZ: 30,
  clearDist: 15,
  steerDeadzone: 0.05,
  maxThrottle: 1,
  rotateSlowAngle: 1.0,
  rotateThrottle: 0.5,
  useBoost: true,
  handbrakeAngle: 1.2,
  handbrakeSpeed: 10,
  jumpBall: true,
  jumpHeight: 3,
  jumpDist: 8,
  dodgeBall: false,
  reactionDelay: 0,
  aimJitter: 0,
  leadBall: false,
};

/**
 * Compute AI input for a server-side bot car.
 *
 * @param {object} car     - ServerCar instance
 * @param {object} ball    - ServerBall instance
 * @param {number} teamDir - 1 = blue (attacks toward +Z), -1 = orange (attacks toward -Z)
 * @param {string} role    - 'attacker' or 'support'
 * @returns {object} input state (throttle, steer, boost, etc.)
 */
export function computeAIInput(car, ball, teamDir, role) {
  const p = PRO_PARAMS;

  const ENEMY_GOAL_Z = teamDir === 1 ? ARENA.LENGTH / 2 : -ARENA.LENGTH / 2;
  const OWN_GOAL_Z = teamDir === 1 ? -ARENA.LENGTH / 2 : ARENA.LENGTH / 2;

  const ballBody = ball.body;
  const ballPos = { x: ballBody.position.x, y: ballBody.position.y, z: ballBody.position.z };
  const ballVel = ballBody.velocity;
  const carPos = car.body.position;

  // Support role: position between ball and own goal
  if (role === 'support') {
    const midX = ballPos.x * 0.3;
    const midZ = (ballPos.z + OWN_GOAL_Z) * 0.5;
    const sDx = midX - carPos.x;
    const sDz = midZ - carPos.z;
    const sAngle = Math.atan2(sDx, sDz);
    car.body.quaternion.toEuler(_euler);
    let sAngleDiff = sAngle - _euler.y;
    while (sAngleDiff > Math.PI) sAngleDiff -= 2 * Math.PI;
    while (sAngleDiff < -Math.PI) sAngleDiff += 2 * Math.PI;
    const sAbsAngle = Math.abs(sAngleDiff);
    const sDist = Math.sqrt(sDx * sDx + sDz * sDz);

    const sSteer = sAngleDiff > 0.05 ? 1 : sAngleDiff < -0.05 ? -1 : 0;
    const sThrottle = sDist > 5 ? p.maxThrottle : 0.3;
    const sBoost = p.useBoost && sDist > 30 && sAbsAngle < 0.3;
    const sHandbrake = sAbsAngle > p.handbrakeAngle && car.body.velocity.length() > p.handbrakeSpeed;

    return {
      seq: 0,
      throttle: sThrottle, steer: sSteer, jump: false, jumpPressed: false,
      boost: sBoost, airRoll: 0, pitchUp: false, pitchDown: false,
      handbrake: sHandbrake, dodgeForward: 0, dodgeSteer: 0,
    };
  }

  const toBallX = ballPos.x - carPos.x;
  const toBallZ = ballPos.z - carPos.z;
  const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

  // Ideal hit direction: ball -> enemy goal
  const goalDx = 0 - ballPos.x;
  const goalDz = ENEMY_GOAL_Z - ballPos.z;
  const goalDist = Math.sqrt(goalDx * goalDx + goalDz * goalDz) || 1;
  const idealDirX = goalDx / goalDist;
  const idealDirZ = goalDz / goalDist;

  // Car->ball direction (normalized)
  const toBallDist = distToBall || 1;
  const toBallNX = toBallX / toBallDist;
  const toBallNZ = toBallZ / toBallDist;

  const approachDot = toBallNX * idealDirX + toBallNZ * idealDirZ;

  // Decide mode
  let mode;
  let targetX, targetZ;

  const ballOnOwnSide = teamDir === 1
    ? ballPos.z < -p.defenseZ
    : ballPos.z > p.defenseZ;
  const ballMovingToOwnGoal = teamDir === 1
    ? ballVel.z < 5
    : ballVel.z > -5;

  if (ballOnOwnSide && ballMovingToOwnGoal) {
    mode = 'defend';
  } else if (approachDot > Math.cos(p.attackAngle)) {
    mode = 'attack';
  } else {
    mode = 'rotate';
  }

  // Compute target position per mode
  if (mode === 'attack') {
    targetX = ballPos.x;
    targetZ = ballPos.z;
  } else if (mode === 'defend') {
    const sideSign = ballPos.x > 0 ? 1 : -1;
    if (distToBall < p.clearDist) {
      targetX = ballPos.x + sideSign * 5;
      targetZ = ballPos.z + teamDir * 3;
    } else {
      targetX = ballPos.x;
      targetZ = (ballPos.z + OWN_GOAL_Z) / 2;
    }
  } else {
    const fromGoalX = ballPos.x;
    const fromGoalZ = ballPos.z - ENEMY_GOAL_Z;
    const fromGoalDist = Math.sqrt(fromGoalX * fromGoalX + fromGoalZ * fromGoalZ) || 1;
    targetX = ballPos.x + (fromGoalX / fromGoalDist) * p.approachOffset;
    targetZ = ballPos.z + (fromGoalZ / fromGoalDist) * p.approachOffset;
  }

  // Steering
  const steerDx = targetX - carPos.x;
  const steerDz = targetZ - carPos.z;
  const targetAngle = Math.atan2(steerDx, steerDz);
  car.body.quaternion.toEuler(_euler);
  let angleDiff = targetAngle - _euler.y;
  while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
  while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
  const absAngle = Math.abs(angleDiff);

  // Throttle
  let throttle = p.maxThrottle;
  if (mode === 'rotate' && absAngle > p.rotateSlowAngle) {
    throttle = p.rotateThrottle;
  }

  // Steer (deadzone)
  const dz = p.steerDeadzone;
  const steer = angleDiff > dz ? 1 : angleDiff < -dz ? -1 : 0;

  // Boost
  let boost = false;
  if (p.useBoost) {
    if (mode === 'attack' && absAngle < 0.3) {
      boost = true;
    } else if (mode === 'rotate' && distToBall > 30) {
      boost = true;
    } else if (mode === 'defend') {
      const distToOwnGoal = Math.abs(ballPos.z - OWN_GOAL_Z);
      if (distToOwnGoal < 25) boost = true;
    }
  }

  // Handbrake
  const speed = car.body.velocity.length();
  const handbrake = absAngle > p.handbrakeAngle && speed > p.handbrakeSpeed;

  // Jump for aerial balls
  let jumpPressed = false;
  const jumpHeight = p.jumpHeight || 3;
  const jumpDist = p.jumpDist || 8;
  if (p.jumpBall && mode === 'attack' && distToBall < jumpDist && ballPos.y > jumpHeight && car.isGrounded) {
    jumpPressed = true;
  }

  return {
    seq: 0,
    throttle,
    steer,
    jump: false,
    jumpPressed,
    boost,
    airRoll: 0,
    pitchUp: false,
    pitchDown: false,
    handbrake,
    dodgeForward: 0,
    dodgeSteer: 0,
  };
}
