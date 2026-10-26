// ============================================
// AIController - AI bot logic for singleplayer modes
// Extracted from Game.js
//
// Hot path is allocation-free: difficulty params are static tables, per-car
// bookkeeping (slot index, team, role, input object) is cached and only
// rebuilt when the car list changes, roles are recomputed every N frames,
// and ball-position math uses a module-level scratch object.
// ============================================

import * as CANNON from 'cannon-es';
import { ARENA as ARENA_CONST, BALL as BALL_CONST } from '../../shared/constants.js';

// Reusable temp vector for AI euler extraction
const _aiEuler = new CANNON.Vec3();

// Reusable scratch ball position (lead/jitter/reaction adjustments applied in place)
const _ballPos = { x: 0, y: 0, z: 0 };

// Recompute 2v2 attacker/support roles every N frames
const ROLE_REFRESH_FRAMES = 10;

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

// Static difficulty parameter tables (resolved once per difficulty change)
const AI_PARAMS = {
  rookie: Object.freeze({
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
  }),
  platinum: Object.freeze({
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
  }),
  allstar: Object.freeze({
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
  }),
  pro: Object.freeze({
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
  }),
};

function createAIInput() {
  return {
    throttle: 0,
    steer: 0,
    jump: false,
    jumpPressed: false,
    boost: false,
    ballCam: true,
    airRoll: 0,
    pitchUp: false,
    pitchDown: false,
    handbrake: false,
    dodgeForward: 0,
    dodgeSteer: 0,
  };
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

    // Cached params (resolved on difficulty change)
    this._params = null;
    this._paramsDifficulty = undefined;

    // Per-AI-car cached bookkeeping, parallel to this.aiCars:
    // { car, idx, teamDir, role, input }
    this._carInfo = [];
    this._carInfoAllCarsLen = -1;
    this._roleFrame = 0;
  }

  /** Difficulty params, resolved once per difficulty change (returned object is shared and frozen). */
  _getAIParams() {
    if (this._params === null || this._paramsDifficulty !== this.difficulty) {
      this._params = AI_PARAMS[this.difficulty] || AI_PARAMS.pro;
      this._paramsDifficulty = this.difficulty;
    }
    return this._params;
  }

  /** Validate the per-car cache against the live car lists; rebuild only when they changed. */
  _syncCarInfo() {
    const aiCars = this.aiCars;
    const info = this._carInfo;
    let dirty = info.length !== aiCars.length || this._carInfoAllCarsLen !== this.allCars.length;
    if (!dirty) {
      for (let i = 0; i < aiCars.length; i++) {
        const ci = info[i];
        if (ci.car !== aiCars[i]) { dirty = true; break; }
        // Slot moved within allCars (idx -1 = not in allCars; nothing to re-check)
        if (ci.idx >= 0 && this.allCars[ci.idx] !== ci.car) { dirty = true; break; }
      }
    }
    if (!dirty) return;

    const half = Math.floor(this.allCars.length / 2);
    info.length = 0;
    for (let i = 0; i < aiCars.length; i++) {
      const car = aiCars[i];
      const idx = this.allCars.indexOf(car);
      info.push({
        car,
        idx,
        teamDir: idx < half ? 1 : -1,
        role: 'attacker',
        input: createAIInput(),
      });
    }
    this._carInfoAllCarsLen = this.allCars.length;
    this._roleFrame = 0; // force role recompute on next update
  }

  /** 2v2 roles: on each team, AI car closest to ball = attacker, others = support. Allocation-free. */
  _assignRoles() {
    const info = this._carInfo;
    const ballPos = this.ball.getPosition();
    // Two passes, one per team (teamDir 1 = blue, -1 = orange)
    for (let pass = 0; pass < 2; pass++) {
      const teamDir = pass === 0 ? 1 : -1;
      let count = 0;
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < info.length; i++) {
        const ci = info[i];
        if (ci.teamDir !== teamDir) continue;
        count++;
        const cp = ci.car.getPosition();
        const d = (cp.x - ballPos.x) ** 2 + (cp.z - ballPos.z) ** 2;
        if (d < bestD) { bestD = d; best = ci; }
      }
      if (count === 0) continue;
      for (let i = 0; i < info.length; i++) {
        const ci = info[i];
        if (ci.teamDir !== teamDir) continue;
        ci.role = (count <= 1 || ci === best) ? 'attacker' : 'support';
      }
    }
  }

  update(dt) {
    this._syncCarInfo();

    if (this.aiMode === '2v2') {
      if (this._roleFrame <= 0) {
        this._assignRoles();
        this._roleFrame = ROLE_REFRESH_FRAMES;
      }
      this._roleFrame--;
    }

    const info = this._carInfo;
    for (let i = 0; i < info.length; i++) {
      const ci = info[i];
      if (ci.car.demolished) continue;
      const role = this.aiMode === '2v2' ? ci.role : 'attacker';
      this._updateAICar(ci.car, ci.teamDir, role, dt, ci.input);
    }
  }

  /**
   * @param {object} car
   * @param {number} teamDir
   * @param {string} role
   * @param {number} dt
   * @param {object} [input] - persistent per-car input object to fill (allocated if omitted)
   */
  _updateAICar(car, teamDir, role, dt, input) {
    const p = this._getAIParams();
    const aiInput = input || createAIInput();
    const ENEMY_GOAL_Z = teamDir === 1 ? ARENA_CONST.LENGTH / 2 : -ARENA_CONST.LENGTH / 2;
    const OWN_GOAL_Z = teamDir === 1 ? -ARENA_CONST.LENGTH / 2 : ARENA_CONST.LENGTH / 2;

    const rawBallPos = this.ball.getPosition();
    const ballVel = this.ball.body.velocity;
    const carPos = car.getPosition();

    // Work on a scratch copy of the ball position
    const ballPos = _ballPos;
    ballPos.x = rawBallPos.x;
    ballPos.y = rawBallPos.y;
    ballPos.z = rawBallPos.z;

    // Lead the ball by predicting its future position
    if (p.leadBall) {
      const t = p.leadTime;
      ballPos.x += ballVel.x * t;
      ballPos.y += ballVel.y * t;
      ballPos.z += ballVel.z * t;
    }

    // Add jitter to ball position (simulates imprecise reads)
    if (p.aimJitter > 0) {
      const jitterSeed = Math.floor(performance.now() / 200);
      ballPos.x += Math.sin(jitterSeed * 1.7) * p.aimJitter;
      ballPos.z += Math.cos(jitterSeed * 2.3) * p.aimJitter;
    }

    // Reaction delay -- use slightly stale ball position
    if (p.reactionDelay > 0) {
      const t = -p.reactionDelay;
      ballPos.x += ballVel.x * t;
      ballPos.z += ballVel.z * t;
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

      aiInput.throttle = sDist > 5 ? p.maxThrottle : 0.3;
      aiInput.steer = sAngleDiff > 0.05 ? 1 : sAngleDiff < -0.05 ? -1 : 0;
      aiInput.jump = false;
      aiInput.jumpPressed = false;
      aiInput.boost = !!(p.useBoost && sDist > 30 && sAbsAngle < 0.3);
      aiInput.ballCam = true;
      aiInput.airRoll = 0;
      aiInput.pitchUp = false;
      aiInput.pitchDown = false;
      aiInput.handbrake = sAbsAngle > p.handbrakeAngle && car.body.velocity.length() > p.handbrakeSpeed;
      aiInput.dodgeForward = 0;
      aiInput.dodgeSteer = 0;

      car.update(aiInput, dt);
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

    // Jump for aerial balls. Heights are tuned for the regulation ball, so
    // measure from where a resting ball's centre sits (mutators can enlarge it).
    let jumpPressed = false;
    const ballLift = (this.ball.radius || BALL_CONST.RADIUS) - BALL_CONST.RADIUS;
    const ballHeight = ballPos.y - ballLift;
    const jumpHeight = p.jumpHeight || 3;
    const jumpDist = p.jumpDist || 8;
    if (p.jumpBall && mode === 'attack' && distToBall < jumpDist && ballHeight > jumpHeight && car.isGrounded) {
      jumpPressed = true;
    }

    // Aerial boost -- hold boost while in air moving toward ball
    if (p.aerialBoost && !car.isGrounded && ballHeight > 3 && distToBall < 25) {
      boost = true;
    }

    // Dodge into ball for powerful hits
    let dodgeForward = 0;
    let dodgeSteer = 0;
    if (p.dodgeBall && mode === 'attack' && distToBall < (p.dodgeDist || 5)
        && !car.isGrounded && car.canDoubleJump && !car.isDodging
        && ballHeight < 5) {
      jumpPressed = true;
      dodgeForward = toBallNZ > 0 ? -1 : 1;
      dodgeSteer = toBallNX > 0.3 ? 1 : toBallNX < -0.3 ? -1 : 0;
    }

    aiInput.throttle = throttle;
    aiInput.steer = steer;
    aiInput.jump = false;
    aiInput.jumpPressed = jumpPressed;
    aiInput.boost = boost;
    aiInput.ballCam = true;
    aiInput.airRoll = 0;
    aiInput.pitchUp = false;
    aiInput.pitchDown = false;
    aiInput.handbrake = handbrake;
    aiInput.dodgeForward = dodgeForward;
    aiInput.dodgeSteer = dodgeSteer;

    car.update(aiInput, dt);
  }
}
