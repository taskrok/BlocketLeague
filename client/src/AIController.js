// ============================================
// AIController - AI bot logic for singleplayer modes
// Extracted from Game.js
// ============================================

import * as CANNON from 'cannon-es';
import { ARENA as ARENA_CONST } from '../../shared/constants.js';

// Reusable temp vector for AI euler extraction
const _aiEuler = new CANNON.Vec3();

// AI team definitions for 2v2 mode -- each team has a name and two car model IDs
export const AI_TEAMS = [
  { name: 'First Responders', cars: ['ambulance', 'firetruck'] },
  { name: 'Boys in Blue', cars: ['police', 'tractor-police'] },
  { name: 'Street Racers', cars: ['race', 'sedan-sports'] },
  { name: 'Future Shock', cars: ['race-future', 'hatchback-sports'] },
  { name: 'Heavy Haul', cars: ['truck', 'truck-flat'] },
  { name: 'Special Delivery', cars: ['delivery', 'delivery-flat'] },
  { name: 'Sunday Drivers', cars: ['sedan', 'suv'] },
  { name: 'Country Club', cars: ['suv-luxury', 'taxi'] },
  { name: 'Mud Dogs', cars: ['tractor', 'tractor-shovel'] },
  { name: 'City Workers', cars: ['garbage-truck', 'van'] },
];

export function findPlayerTeam(playerModelId) {
  if (!playerModelId) return null;
  return AI_TEAMS.find(t => t.cars.includes(playerModelId)) || null;
}

export function pickOpponentTeam(availableModelIds, excludeTeam) {
  const valid = AI_TEAMS.filter(t =>
    t !== excludeTeam && t.cars.every(c => availableModelIds.includes(c))
  );
  if (valid.length === 0) return null;
  return valid[Math.floor(Math.random() * valid.length)];
}

export class AIController {
  /**
   * @param {object} opts
   * @param {Array} opts.allCars - array of all cars indexed by slot
   * @param {Array} opts.aiCars - array of AI-controlled cars
   * @param {object} opts.ball - Ball instance
   * @param {string} opts.difficulty - 'rookie' | 'pro' | 'platinum' | 'allstar'
   * @param {string} opts.aiMode - '1v1' | '2v2'
   */
  constructor({ allCars, aiCars, ball, difficulty, aiMode }) {
    this.allCars = allCars;
    this.aiCars = aiCars;
    this.ball = ball;
    this.difficulty = difficulty;
    this.aiMode = aiMode;
  }

  _getAIParams() {
    switch (this.difficulty) {
      case 'rookie':
        return {
          approachOffset: 14,
          attackAngle: 0.6,
          defenseZ: 25,
          clearDist: 18,
          steerDeadzone: 0.15,
          maxThrottle: 0.75,
          rotateSlowAngle: 0.8,
          rotateThrottle: 0.4,
          useBoost: true,
          boostThreshold: 0.7,    // only boosts when close and facing ball
          handbrakeAngle: 1.5,
          handbrakeSpeed: 15,
          jumpBall: false,
          dodgeBall: false,
          canJump: false,
          canDodge: false,
          reactionDelay: 0.15,
          aimJitter: 3.0,
        };
      case 'platinum':
        return {
          approachOffset: 10,
          attackAngle: 0.35,
          defenseZ: 35,
          clearDist: 12,
          steerDeadzone: 0.04,
          maxThrottle: 1.0,
          rotateSlowAngle: 1.2,
          rotateThrottle: 0.6,
          useBoost: true,
          handbrakeAngle: 1.0,
          handbrakeSpeed: 8,
          jumpBall: true,
          jumpHeight: 2.5,
          jumpDist: 10,
          dodgeBall: true,
          dodgeDist: 8,
          canJump: true,
          canDodge: true,
          reactionDelay: 0.05,
          aimJitter: 0.5,
          leadBall: true,
          leadTime: 0.3,
          shadowDefense: true,
        };
      case 'allstar':
        return {
          approachOffset: 7,
          attackAngle: 0.25,
          defenseZ: 40,
          clearDist: 10,
          steerDeadzone: 0.02,
          maxThrottle: 1,
          rotateSlowAngle: 1.4,
          rotateThrottle: 0.8,
          useBoost: true,
          handbrakeAngle: 0.8,
          handbrakeSpeed: 6,
          jumpBall: true,
          jumpHeight: 2.0,
          jumpDist: 14,
          dodgeBall: true,
          dodgeDist: 7,
          canJump: true,
          canDodge: true,
          reactionDelay: 0,
          aimJitter: 0,
          leadBall: true,
          leadTime: 0.6,
          aerialBoost: true,
          shadowDefense: true,
          boostForSpeed: true,
        };
      default: // pro
        return {
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
          canJump: true,
          canDodge: false,
          reactionDelay: 0,
          aimJitter: 0,
          leadBall: false,
        };
    }
  }

  update(dt) {
    // In 2v2, assign roles: on each team, car closest to ball = attacker, farther = support
    let roles = null;
    if (this.aiMode === '2v2') {
      const rawBallPos = this.ball.getPosition();
      roles = new Map();
      const half = Math.floor(this.allCars.length / 2);
      const blueAI = [];
      const orangeAI = [];
      for (const car of this.aiCars) {
        const idx = this.allCars.indexOf(car);
        if (idx < half) blueAI.push(car);
        else orangeAI.push(car);
      }
      for (const team of [blueAI, orangeAI]) {
        if (team.length <= 1) {
          for (const c of team) roles.set(c, 'attacker');
          continue;
        }
        const sorted = [...team].sort((a, b) => {
          const ap = a.getPosition();
          const bp = b.getPosition();
          const da = (ap.x - rawBallPos.x) ** 2 + (ap.z - rawBallPos.z) ** 2;
          const db = (bp.x - rawBallPos.x) ** 2 + (bp.z - rawBallPos.z) ** 2;
          return da - db;
        });
        roles.set(sorted[0], 'attacker');
        for (let i = 1; i < sorted.length; i++) roles.set(sorted[i], 'support');
      }
    }

    for (const car of this.aiCars) {
      if (car.demolished) continue;
      const idx = this.allCars.indexOf(car);
      const half = Math.floor(this.allCars.length / 2);
      const teamDir = idx < half ? 1 : -1;
      const role = roles ? roles.get(car) : 'attacker';
      this._updateAICar(car, teamDir, role, dt);
    }
  }

  _updateAICar(car, teamDir, role, dt) {
    const p = this._getAIParams();
    const ENEMY_GOAL_Z = teamDir === 1 ? ARENA_CONST.LENGTH / 2 : -ARENA_CONST.LENGTH / 2;
    const OWN_GOAL_Z = teamDir === 1 ? -ARENA_CONST.LENGTH / 2 : ARENA_CONST.LENGTH / 2;

    let ballPos = this.ball.getPosition();
    const ballVel = this.ball.body.velocity;
    const carPos = car.getPosition();

    // Lead the ball by predicting its future position
    if (p.leadBall) {
      const t = p.leadTime;
      ballPos = {
        x: ballPos.x + ballVel.x * t,
        y: ballPos.y + ballVel.y * t,
        z: ballPos.z + ballVel.z * t,
      };
    }

    // Add jitter to ball position (simulates imprecise reads)
    if (p.aimJitter > 0) {
      const jitterSeed = Math.floor(performance.now() / 200);
      const jx = (Math.sin(jitterSeed * 1.7) * p.aimJitter);
      const jz = (Math.cos(jitterSeed * 2.3) * p.aimJitter);
      ballPos = { x: ballPos.x + jx, y: ballPos.y, z: ballPos.z + jz };
    }

    // Reaction delay -- use slightly stale ball position
    if (p.reactionDelay > 0) {
      const t = -p.reactionDelay;
      ballPos = {
        x: ballPos.x + ballVel.x * t,
        y: ballPos.y,
        z: ballPos.z + ballVel.z * t,
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

    // Support role: position between ball and own goal instead of chasing ball
    if (role === 'support') {
      const midX = ballPos.x * 0.3;
      const midZ = (ballPos.z + OWN_GOAL_Z) * 0.5;
      const sDx = midX - carPos.x;
      const sDz = midZ - carPos.z;
      const sAngle = Math.atan2(sDx, sDz);
      car.body.quaternion.toEuler(_aiEuler);
      let sAngleDiff = sAngle - _aiEuler.y;
      while (sAngleDiff > Math.PI) sAngleDiff -= 2 * Math.PI;
      while (sAngleDiff < -Math.PI) sAngleDiff += 2 * Math.PI;
      const sAbsAngle = Math.abs(sAngleDiff);
      const sDist = Math.sqrt(sDx * sDx + sDz * sDz);

      const sSteer = sAngleDiff > 0.05 ? 1 : sAngleDiff < -0.05 ? -1 : 0;
      const sThrottle = sDist > 5 ? p.maxThrottle : 0.3;
      const sBoost = p.useBoost && sDist > 30 && sAbsAngle < 0.3;
      const sHandbrake = sAbsAngle > p.handbrakeAngle && car.body.velocity.length() > p.handbrakeSpeed;

      car.update({
        throttle: sThrottle, steer: sSteer, jump: false, jumpPressed: false,
        boost: sBoost, ballCam: true, airRoll: 0, pitchUp: false, pitchDown: false,
        handbrake: sHandbrake, dodgeForward: 0, dodgeSteer: 0,
      }, dt);
      return;
    }

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
      } else if (p.shadowDefense) {
        targetX = ballPos.x * 0.8;
        targetZ = ballPos.z + (OWN_GOAL_Z - ballPos.z) * 0.3;
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
    car.body.quaternion.toEuler(_aiEuler);
    let angleDiff = targetAngle - _aiEuler.y;
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
      // Rookie: conditional boosting (only when close and facing ball)
      if (p.boostThreshold) {
        if (mode === 'attack' && absAngle < 0.3 && distToBall < 20) {
          boost = true;
        }
      } else {
        if (mode === 'attack' && absAngle < 0.3) {
          boost = true;
        } else if (mode === 'rotate' && distToBall > 30) {
          boost = true;
        } else if (mode === 'defend') {
          const distToOwnGoal = Math.abs(ballPos.z - OWN_GOAL_Z);
          if (distToOwnGoal < 25) boost = true;
        }
        // Boost for supersonic speed when approaching ball
        if (p.boostForSpeed && mode === 'attack' && absAngle < 0.5 && distToBall > 20) {
          boost = true;
        }
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

    // Aerial boost -- hold boost while in air moving toward ball
    if (p.aerialBoost && !car.isGrounded && ballPos.y > 3 && distToBall < 25) {
      boost = true;
    }

    // Dodge into ball for powerful hits
    let dodgeForward = 0;
    let dodgeSteer = 0;
    if (p.dodgeBall && mode === 'attack' && distToBall < (p.dodgeDist || 5)
        && !car.isGrounded && car.canDoubleJump && !car.isDodging
        && ballPos.y < 5) {
      jumpPressed = true;
      dodgeForward = toBallNZ > 0 ? -1 : 1;
      dodgeSteer = toBallNX > 0.3 ? 1 : toBallNX < -0.3 ? -1 : 0;
    }

    const aiInput = {
      throttle,
      steer,
      jump: false,
      jumpPressed,
      boost,
      ballCam: true,
      airRoll: 0,
      pitchUp: false,
      pitchDown: false,
      handbrake,
      dodgeForward,
      dodgeSteer,
    };

    car.update(aiInput, dt);
  }
}
