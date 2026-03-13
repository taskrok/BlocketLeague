// ============================================
// CarPhysics - Shared car physics logic
// Used by both client Car.js and server ServerCar.js
// All time-based comparisons use simTime (monotonic simulation time in ms)
// ============================================

import * as CANNON from 'cannon-es';
import { CAR, ARENA, PHYSICS } from './constants.js';
import { checkCurveSurface } from './CurveSurface.js';

// Temp vectors reused each frame to avoid GC
const _v1 = new CANNON.Vec3();
const _v2 = new CANNON.Vec3();
const _v3 = new CANNON.Vec3();
const _v4 = new CANNON.Vec3();
const _v5 = new CANNON.Vec3();
const _q1 = new CANNON.Quaternion();

/**
 * CarPhysics operates on a car state object and a cannon-es Body.
 * It contains ALL shared physics methods extracted from Car.js / ServerCar.js.
 *
 * Usage:
 *   const physics = new CarPhysics();
 *   physics.update(body, state, input, dt, simTime);
 *
 * The `state` object must have all the fields initialized by `createCarState()`.
 */
export class CarPhysics {

  /**
   * Run one full physics tick.
   * @param {CANNON.Body} body - The cannon-es rigid body
   * @param {object} state - Car state object (see createCarState)
   * @param {object} input - Input object with throttle, steer, boost, jumpPressed, etc.
   * @param {number} dt - Delta time in seconds
   * @param {number} simTime - Monotonic simulation time in milliseconds
   */
  update(body, state, input, dt, simTime) {
    if (state.demolished) return;

    // Reduce effective gravity for cars (lighter than ball for easier aerials)
    body.force.y -= PHYSICS.GRAVITY * CAR.MASS * (1 - CAR.GRAVITY_SCALE);

    this.checkGround(body, state, simTime);
    this.handleSelfRight(body, state, input, dt);
    this.handleMovement(body, state, input, dt);
    this.handleJump(body, state, input, dt, simTime);
    this.handleBoost(body, state, input, dt);
    this.handleAirThrottle(body, state, input, dt);
    this.handleAirControl(body, state, input, dt);
    this.clampAngularVelocity(body, state);
    this.applyStickyForce(body, state, dt);
  }

  checkGround(body, state, simTime) {
    // After jumping, suppress ground detection so the car can clear the surface.
    // Wall jumps need 450ms. Curved/fillet surfaces need a scaled lockout based
    // on how tilted the normal is — the more tilted, the longer to escape detectRange.
    // Flat floor (normalY=1) → 100ms, 45° curve (normalY≈0.7) → ~250ms, wall → 450ms.
    let lockoutDuration;
    if (state._jumpedFromWall) {
      lockoutDuration = 450;
    } else {
      const normalY = Math.abs(state._jumpNormalY || 1);
      lockoutDuration = 100 + (1 - normalY) * 500;
    }
    if (state.hasJumped && (simTime - state.jumpLockout) < lockoutDuration) {
      state.isGrounded = false;
      return;
    }

    // During dodge flip (and brief decay after), suppress ground detection
    // so the car can complete its rotation without being snapped to the floor.
    if (state.isDodging || state._dodgeDecaying) {
      state.isGrounded = false;
      return;
    }

    const wasGrounded = state.isGrounded;
    const pos = body.position;

    // Try analytical curve detection (arena walls) and goal surfaces
    const curveHit = checkCurveSurface(pos);
    const goalHit = this.checkGoalSurface(pos);

    // Pick the closer hit
    let hit = null;
    if (curveHit && goalHit) {
      hit = (curveHit.dist < goalHit.dist) ? curveHit : goalHit;
    } else {
      hit = curveHit || goalHit;
    }
    state.onGoalSurface = (hit === goalHit && hit !== null);

    if (hit) {
      state.isGrounded = true;
      state.surfaceNormal.copy(hit.normal);
      state.onWall = Math.abs(state.surfaceNormal.y) < 0.7;

      // Magnetically snap car to the surface
      const offset = CAR.HEIGHT / 2 + 0.05;
      const targetX = hit.sx + hit.normal.x * offset;
      const targetY = hit.sy + hit.normal.y * offset;
      const targetZ = hit.sz + hit.normal.z * offset;

      const snap = 0.2;
      body.position.x += (targetX - pos.x) * snap;
      body.position.y += (targetY - pos.y) * snap;
      body.position.z += (targetZ - pos.z) * snap;

      // Kill velocity component going into the surface
      const vDotN = body.velocity.dot(state.surfaceNormal);
      if (vDotN < 0) {
        body.velocity.x -= state.surfaceNormal.x * vDotN;
        body.velocity.y -= state.surfaceNormal.y * vDotN;
        body.velocity.z -= state.surfaceNormal.z * vDotN;
      }
    } else {
      // Fallback: simple floor check
      const bottomY = pos.y - CAR.HEIGHT / 2;
      if (bottomY <= 0.5) {
        state.isGrounded = true;
        state.surfaceNormal.set(0, 1, 0);
        state.onWall = false;
        state.onGoalSurface = false;
      } else {
        state.isGrounded = false;
        state.onWall = false;
        state.onGoalSurface = false;
      }
    }

    if (state.isGrounded && !wasGrounded) {
      state.hasJumped = false;
      state.canDoubleJump = false;
      state.isDodging = false;
      state._dodgeDecaying = false;
      state._jumpedFromWall = false;
    }
  }

  checkGoalSurface(pos) {
    const GW = ARENA.GOAL_WIDTH / 2;
    const GH = ARENA.GOAL_HEIGHT;
    const GD = ARENA.GOAL_DEPTH;
    const GFR = ARENA.GOAL_FILLET_RADIUS;
    const HL = ARENA.LENGTH / 2;
    const detectRange = CAR.HEIGHT * 3.5;

    let best = null;
    let bestDist = Infinity;

    // Early exit: skip if car isn't near either goal
    if (Math.abs(pos.x) > GW + detectRange || pos.y > GH + detectRange) return null;

    for (const side of [-1, 1]) {
      // Signed distance into the goal (positive = deeper inside)
      const depthInGoal = side * (pos.z - side * HL);
      // Car must be near/past the goal mouth
      if (depthInGoal < -detectRange) continue;
      // Car must be before the back wall + detect range
      if (depthInGoal > GD + detectRange) continue;

      const zMouth = side * HL;
      const zBack = side * (HL + GD);
      const zFilletStart = side * (HL + GD - GFR);

      // -- Goal ceiling flat: y=GH --
      if (Math.abs(pos.x) < GW - GFR && side * pos.z > side * zMouth && side * pos.z < side * zFilletStart) {
        const dist = Math.abs(pos.y - GH);
        if (dist < detectRange && dist < bestDist) {
          bestDist = dist;
          best = { sx: pos.x, sy: GH, sz: pos.z, normal: new CANNON.Vec3(0, -1, 0), dist };
        }
      }

      // -- Goal back wall flat: z=zBack --
      if (Math.abs(pos.x) < GW - GFR && pos.y > GFR && pos.y < GH - GFR) {
        const dist = Math.abs(pos.z - zBack);
        if (dist < detectRange && dist < bestDist) {
          bestDist = dist;
          best = { sx: pos.x, sy: pos.y, sz: zBack, normal: new CANNON.Vec3(0, 0, -side), dist };
        }
      }

      // -- Goal side walls flat (2): x=+/-GW --
      for (const ps of [-1, 1]) {
        const wallX = ps * GW;
        if (pos.y > GFR && pos.y < GH - GFR && side * pos.z > side * zMouth && side * pos.z < side * zFilletStart) {
          const dist = Math.abs(pos.x - wallX);
          if (dist < detectRange && dist < bestDist) {
            bestDist = dist;
            best = { sx: wallX, sy: pos.y, sz: pos.z, normal: new CANNON.Vec3(-ps, 0, 0), dist };
          }
        }
      }

      // -- Floor-to-back fillet: arc in YZ plane --
      if (Math.abs(pos.x) < GW - GFR) {
        const cy = GFR;
        const cz = side * (HL + GD - GFR);
        const dcy = pos.y - cy;
        const dcz = pos.z - cz;
        const d = Math.sqrt(dcy * dcy + dcz * dcz);
        if (d > 0.001) {
          const uy = dcy / d;
          const uz = dcz / d;
          // Valid quarter: uy <= 0 (below center) and side*uz >= 0 (toward back)
          if (uy <= 0 && side * uz >= 0) {
            const dist = Math.abs(d - GFR);
            if (dist < detectRange && dist < bestDist) {
              bestDist = dist;
              const sy = cy + GFR * uy;
              const sz = cz + GFR * uz;
              best = { sx: pos.x, sy, sz, normal: new CANNON.Vec3(0, -uy, -uz), dist };
            }
          }
        }
      }

      // -- Ceiling-to-back fillet: arc in YZ plane --
      if (Math.abs(pos.x) < GW - GFR) {
        const cy = GH - GFR;
        const cz = side * (HL + GD - GFR);
        const dcy = pos.y - cy;
        const dcz = pos.z - cz;
        const d = Math.sqrt(dcy * dcy + dcz * dcz);
        if (d > 0.001) {
          const uy = dcy / d;
          const uz = dcz / d;
          // Valid quarter: uy >= 0 (above center) and side*uz >= 0 (toward back)
          if (uy >= 0 && side * uz >= 0) {
            const dist = Math.abs(d - GFR);
            if (dist < detectRange && dist < bestDist) {
              bestDist = dist;
              const sy = cy + GFR * uy;
              const sz = cz + GFR * uz;
              best = { sx: pos.x, sy, sz, normal: new CANNON.Vec3(0, -uy, -uz), dist };
            }
          }
        }
      }

      // -- Floor-to-side fillets (2): arc in XY plane --
      for (const ps of [-1, 1]) {
        if (side * pos.z > side * zMouth && side * pos.z < side * zFilletStart) {
          const cx = ps * (GW - GFR);
          const cy = GFR;
          const dcx = pos.x - cx;
          const dcy = pos.y - cy;
          const d = Math.sqrt(dcx * dcx + dcy * dcy);
          if (d > 0.001) {
            const ux = dcx / d;
            const uy = dcy / d;
            // Valid quarter: ps*ux >= 0 (toward side wall) and uy <= 0 (below center)
            if (ps * ux >= 0 && uy <= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                const sx = cx + GFR * ux;
                const sy = cy + GFR * uy;
                best = { sx, sy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0), dist };
              }
            }
          }
        }
      }

      // -- Ceiling-to-side fillets (2): arc in XY plane --
      for (const ps of [-1, 1]) {
        if (side * pos.z > side * zMouth && side * pos.z < side * zFilletStart) {
          const cx = ps * (GW - GFR);
          const cy = GH - GFR;
          const dcx = pos.x - cx;
          const dcy = pos.y - cy;
          const d = Math.sqrt(dcx * dcx + dcy * dcy);
          if (d > 0.001) {
            const ux = dcx / d;
            const uy = dcy / d;
            // Valid quarter: ps*ux >= 0 (toward side wall) and uy >= 0 (above center)
            if (ps * ux >= 0 && uy >= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                const sx = cx + GFR * ux;
                const sy = cy + GFR * uy;
                best = { sx, sy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0), dist };
              }
            }
          }
        }
      }

      // -- Side-to-back fillets (2): arc in XZ plane --
      for (const ps of [-1, 1]) {
        if (pos.y > GFR && pos.y < GH - GFR) {
          const cx = ps * (GW - GFR);
          const cz = side * (HL + GD - GFR);
          const dcx = pos.x - cx;
          const dcz = pos.z - cz;
          const d = Math.sqrt(dcx * dcx + dcz * dcz);
          if (d > 0.001) {
            const ux = dcx / d;
            const uz = dcz / d;
            // Valid quarter: ps*ux >= 0 (toward side) and side*uz >= 0 (toward back)
            if (ps * ux >= 0 && side * uz >= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                const sx = cx + GFR * ux;
                const sz = cz + GFR * uz;
                best = { sx, sy: pos.y, sz, normal: new CANNON.Vec3(-ux, 0, -uz), dist };
              }
            }
          }
        }
      }

      // -- 1/8 sphere corner patches (4 per goal): floor+side+back & ceiling+side+back --
      for (const ps of [-1, 1]) {
        for (const yPos of ['floor', 'ceiling']) {
          const cx = ps * (GW - GFR);
          const cy = yPos === 'floor' ? GFR : GH - GFR;
          const cz = side * (HL + GD - GFR);
          const ySign = yPos === 'floor' ? -1 : 1;

          const dcx = pos.x - cx;
          const dcy = pos.y - cy;
          const dcz = pos.z - cz;
          const d = Math.sqrt(dcx * dcx + dcy * dcy + dcz * dcz);
          if (d < 0.001) continue;

          const ux = dcx / d;
          const uy = dcy / d;
          const uz = dcz / d;

          // Valid octant: toward side wall, toward floor/ceiling, toward back wall
          if (ps * ux >= 0 && ySign * uy <= 0 && side * uz >= 0) {
            const dist = Math.abs(d - GFR);
            if (dist < detectRange && dist < bestDist) {
              bestDist = dist;
              const sx = cx + GFR * ux;
              const sy = cy + GFR * uy;
              const sz = cz + GFR * uz;
              best = { sx, sy, sz, normal: new CANNON.Vec3(-ux, -uy, -uz), dist };
            }
          }
        }
      }
    }

    if (best) best.dist = bestDist;
    return best;
  }

  handleSelfRight(body, state, input, dt) {
    if (state.onWall) return;
    if (state.isDodging || state._dodgeDecaying) return;
    // Don't fight intentional aerial tilt -- but allow self-right if
    // the car has come back down near the floor (failed aerial / landed on head)
    if (state.hasJumped && body.position.y > CAR.HEIGHT * 3) return;

    _v1.set(0, 1, 0);
    const up = body.quaternion.vmult(_v1);
    const nearFloor = body.position.y < CAR.HEIGHT * 3;

    const isTilted = up.y < 0.1; // only when on back, side, or nose -- not slight tilt
    if (!isTilted || !nearFloor) { state._selfRighting = false; return; }
    if (!input.throttle) { state._selfRighting = false; return; }

    state._selfRighting = true;

    // Determine roll/pitch axis to right the car
    _v1.set(0, 0, 1);
    const forward = body.quaternion.vmult(_v1);
    _v1.set(1, 0, 0);
    const right = body.quaternion.vmult(_v1);
    const rollSpeed = 8;

    if (Math.abs(forward.y) < 0.7) {
      // Car is rolled sideways -- spin around forward axis
      const rollDir = right.y > 0 ? -1 : 1;
      body.angularVelocity.x = forward.x * rollSpeed * rollDir;
      body.angularVelocity.y = forward.y * rollSpeed * rollDir;
      body.angularVelocity.z = forward.z * rollSpeed * rollDir;
    } else {
      // Car is pitched (nose/tail down) -- spin around right axis
      const pitchDir = forward.y > 0 ? 1 : -1;
      body.angularVelocity.x = right.x * rollSpeed * pitchDir;
      body.angularVelocity.y = right.y * rollSpeed * pitchDir;
      body.angularVelocity.z = right.z * rollSpeed * pitchDir;
    }
  }

  handleMovement(body, state, input, dt) {
    if (!state.isGrounded) return;

    const vel = body.velocity;
    const quat = body.quaternion;
    const normal = state.surfaceNormal;

    // Get forward direction in world space (reuse _v1 as rawForward)
    _v1.set(0, 0, 1);
    quat.vmult(_v1, _v1);

    // Project forward onto the surface plane: forward - (forward.normal)*normal
    // Reuse _v2 as forward
    const dot = _v1.dot(normal);
    _v2.set(
      _v1.x - dot * normal.x,
      _v1.y - dot * normal.y,
      _v1.z - dot * normal.z
    );
    const fLen = _v2.length();
    if (fLen < 0.001) return;
    _v2.scale(1 / fLen, _v2);
    const forward = _v2;

    // Right direction: cross(forward, normal) -- reuse _v3
    forward.cross(normal, _v3);
    const rLen = _v3.length();
    if (rLen < 0.001) return;
    _v3.scale(1 / rLen, _v3);
    const right = _v3;

    // Current forward speed
    const forwardSpeed = vel.dot(forward);

    // Throttle
    if (input.throttle !== 0) {
      const goingForward = input.throttle > 0;
      const maxFwd = (input.boost && state.boost > 0) ? CAR.BOOST_MAX_SPEED : CAR.MAX_SPEED;
      const maxSpeed = goingForward ? maxFwd : CAR.REVERSE_MAX_SPEED;
      // Use brake force when throttle opposes current velocity (counter-braking)
      const opposing = (goingForward && forwardSpeed < -0.5) || (!goingForward && forwardSpeed > 0.5);
      let accel;
      if (opposing) {
        accel = CAR.BRAKE_FORCE;
      } else {
        // Non-linear acceleration: explosive at low speed, tapering near max
        const speedRatio = Math.min(Math.abs(forwardSpeed) / maxSpeed, 1);
        const taper = 1 - speedRatio * speedRatio; // quadratic falloff
        accel = CAR.ACCELERATION * Math.max(taper, 0.05);
      }
      let targetSpeed = forwardSpeed + input.throttle * accel * dt;
      targetSpeed = Math.max(-maxSpeed, Math.min(maxSpeed, targetSpeed));

      const dv = targetSpeed - forwardSpeed;
      vel.x += forward.x * dv;
      vel.y += forward.y * dv;
      vel.z += forward.z * dv;
    } else {
      // Linear deceleration when coasting (no throttle)
      const surfVelFwd = vel.dot(forward);
      const surfVelRight = vel.dot(right);
      const decel = CAR.COAST_DECEL * dt;

      // Decelerate forward component
      let newFwd = surfVelFwd;
      if (Math.abs(surfVelFwd) > decel) {
        newFwd -= Math.sign(surfVelFwd) * decel;
      } else {
        newFwd = 0;
      }

      // Decelerate sideways component
      let newRight = surfVelRight;
      if (Math.abs(surfVelRight) > decel) {
        newRight -= Math.sign(surfVelRight) * decel;
      } else {
        newRight = 0;
      }

      const normalVel = vel.dot(normal);
      vel.set(
        forward.x * newFwd + right.x * newRight + normal.x * normalVel,
        forward.y * newFwd + right.y * newRight + normal.y * normalVel,
        forward.z * newFwd + right.z * newRight + normal.z * normalVel
      );
    }

    // Steering -- rotate around surface normal
    const handbraking = !!input.handbrake;
    if (input.steer !== 0 && (Math.abs(forwardSpeed) > 0.5 || handbraking)) {
      const turnDir = input.throttle !== 0 ? Math.sign(input.throttle) : (forwardSpeed >= 0 ? 1 : -1);
      const turnMultiplier = handbraking ? CAR.HANDBRAKE_TURN_MULTIPLIER : 1;
      const turnAmount = input.steer * CAR.TURN_SPEED * turnDir * turnMultiplier;
      // Set angular velocity along surface normal
      body.angularVelocity.set(
        normal.x * turnAmount,
        normal.y * turnAmount,
        normal.z * turnAmount
      );
    } else if (!input.steer) {
      body.angularVelocity.scale(0.85, body.angularVelocity);
    }

    // Kill sideways velocity (grip) -- reduced during handbrake to allow drifting.
    // RL drops lateral friction to ~10% during powerslide -- the car preserves its
    // velocity vector naturally because sideways grip is almost zero.
    const gripFactor = handbraking ? CAR.HANDBRAKE_GRIP : 0.92;
    const sideSpeed = vel.dot(right);
    vel.x -= right.x * sideSpeed * gripFactor;
    vel.y -= right.y * sideSpeed * gripFactor;
    vel.z -= right.z * sideSpeed * gripFactor;

    // Align car to surface normal
    this.alignToSurface(body, state, dt);
  }

  alignToSurface(body, state, dt) {
    const normal = state.surfaceNormal;
    // Reuse _v4 as carUp
    _v4.set(0, 1, 0);
    body.quaternion.vmult(_v4, _v4);

    // If already aligned, skip
    if (_v4.dot(normal) > 0.999) return;

    // Find rotation from carUp to normal -- reuse _v5 as cross
    _v4.cross(normal, _v5);
    const crossLen = _v5.length();
    if (crossLen < 0.0001) return;
    _v5.scale(1 / crossLen, _v5);

    const dotVal = Math.min(1, Math.max(-1, _v4.dot(normal)));
    const angle = Math.acos(dotVal);

    // Slerp toward aligned orientation
    const slerpFactor = Math.min(1, 8 * dt); // fast alignment
    _q1.setFromAxisAngle(_v5, angle * slerpFactor);
    _q1.mult(body.quaternion, body.quaternion);
    body.quaternion.normalize();
  }

  applyStickyForce(body, state, dt) {
    if (!state.isGrounded) return;

    // How wall-like is the surface? 0 = flat floor/ceiling, 1 = vertical wall
    const wallFactor = 1 - Math.abs(state.surfaceNormal.y);
    if (wallFactor < 0.05 && !state.onGoalSurface) return; // effectively flat floor, nothing to do

    // Ceiling driving is allowed -- no detach check for arena ceiling.
    // Cars can drive on ceilings (both arena and goal surfaces).

    // Need minimum speed to stay on steep walls (like Rocket League)
    if (wallFactor > 0.3) {
      const speed = body.velocity.length();
      if (speed < 2) {
        state.isGrounded = false;
        state.onWall = false;
        return;
      }
    }

    // Graduated gravity cancellation -- stronger as surface gets more vertical
    // PHYSICS.GRAVITY is negative, so this adds upward force
    body.force.y -= PHYSICS.GRAVITY * CAR.MASS * Math.max(wallFactor, state.onGoalSurface ? 1 : 0);

    if (state.onGoalSurface) {
      // Push into surface in all axes (Y included for ceiling driving)
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS;
      body.force.x -= state.surfaceNormal.x * stickForce;
      body.force.y -= state.surfaceNormal.y * stickForce;
      body.force.z -= state.surfaceNormal.z * stickForce;
    } else {
      // Push car into wall surface (XZ only -- omit Y so we don't fight gravity cancel)
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS * wallFactor;
      body.force.x -= state.surfaceNormal.x * stickForce;
      body.force.z -= state.surfaceNormal.z * stickForce;
    }
  }

  handleJump(body, state, input, dt, simTime) {
    // First jump -- launch along surface normal
    if (input.jumpPressed && state.isGrounded && !state.hasJumped) {
      const n = state.surfaceNormal;
      state._jumpedFromWall = state.onWall;
      state._jumpNormalY = n.y;

      if (state.onWall) {
        // Wall jump: kill velocity into wall, push away from wall + give upward boost
        const vDotN = body.velocity.dot(n);
        if (vDotN < 0) {
          body.velocity.x -= n.x * vDotN;
          body.velocity.y -= n.y * vDotN;
          body.velocity.z -= n.z * vDotN;
        }
        // Stronger push on flat vertical walls (wallFactor near 1) to escape detect range
        const wallFactor = 1 - Math.abs(n.y);
        const pushMult = 1.0 + wallFactor * 0.6;
        // Push away from wall surface
        body.velocity.x += n.x * CAR.JUMP_FORCE * pushMult;
        body.velocity.y += n.y * CAR.JUMP_FORCE * pushMult;
        body.velocity.z += n.z * CAR.JUMP_FORCE * pushMult;
        // Detach upward so gravity pulls car to floor
        body.velocity.y += CAR.JUMP_FORCE * 0.5;
      } else {
        body.velocity.x += n.x * CAR.JUMP_FORCE;
        body.velocity.y += n.y * CAR.JUMP_FORCE;
        body.velocity.z += n.z * CAR.JUMP_FORCE;
      }

      state.hasJumped = true;
      state.jumpTime = simTime;
      state.jumpLockout = simTime;
      state.canDoubleJump = true;
      state.isGrounded = false;
      state.onWall = false;
      state.onGoalSurface = false;
      return;
    }

    // Double jump / dodge
    if (input.jumpPressed && !state.isGrounded && state.canDoubleJump &&
        (simTime - state.jumpTime) < CAR.JUMP_COOLDOWN) {

      const df = input.dodgeForward !== undefined ? input.dodgeForward : input.throttle;
      const ds = input.dodgeSteer !== undefined ? input.dodgeSteer : input.steer;

      if (df !== 0 || ds !== 0) {
        // Dodge in the input direction -- reuse _v1 as forward, _v2 as right
        _v1.set(0, 0, 1);
        body.quaternion.vmult(_v1, _v1);
        _v2.set(1, 0, 0);
        body.quaternion.vmult(_v2, _v2);
        _v1.y = 0; _v1.normalize();
        _v2.y = 0; _v2.normalize();

        // _v3 as dodgeDir
        _v3.set(_v1.x * df + _v2.x * ds, 0, _v1.z * df + _v2.z * ds);
        _v3.normalize();

        // Speed burst in dodge direction
        body.velocity.x += _v3.x * CAR.DODGE_FORCE;
        body.velocity.z += _v3.z * CAR.DODGE_FORCE;
        body.velocity.y = CAR.DODGE_VERTICAL;

        // Flip spin using DODGE_SPIN_SPEED (one rotation in DODGE_DURATION)
        // Normalize so diagonal flips have the same rotation speed as cardinal
        _v4.set(df, 0, -ds);
        const spinLen = _v4.length();
        if (spinLen > 0) _v4.scale(CAR.DODGE_SPIN_SPEED / spinLen, _v4);
        state._dodgeAngVel = body.quaternion.vmult(_v4);
        body.angularVelocity.copy(state._dodgeAngVel);

        state.isDodging = true;
        state._dodgeDecaying = false;
        state.dodgeTime = simTime;
      } else {
        // No directional input -> small upward pop
        body.velocity.y = CAR.DOUBLE_JUMP_FORCE;
      }
      state.canDoubleJump = false;
    }

    // Maintain flip spin during dodge torque phase
    if (state.isDodging) {
      body.angularVelocity.copy(state._dodgeAngVel);
      // Cancel gravity so the car floats during the flip -- prevents floor
      // collision from blocking the rotation
      body.force.y -= PHYSICS.GRAVITY * CAR.MASS;
    }

    // End dodge torque phase after DODGE_DURATION, enter decay.
    // FIX: Instead of snapping to wheels-down, just kill the dodge-specific
    // angular velocity component and let natural damping (0.5) bring the car to rest.
    if (state.isDodging && (simTime - state.dodgeTime) > CAR.DODGE_DURATION) {
      state.isDodging = false;

      // Remove the dodge angular velocity component from the current angular velocity.
      // Project current angVel onto the dodge axis and subtract it, preserving any
      // natural angular velocity the car picked up from collisions etc.
      if (state._dodgeAngVel) {
        const dav = state._dodgeAngVel;
        const davLen = Math.sqrt(dav.x * dav.x + dav.y * dav.y + dav.z * dav.z);
        if (davLen > 0.001) {
          // Normalized dodge axis
          const ax = dav.x / davLen;
          const ay = dav.y / davLen;
          const az = dav.z / davLen;
          // Project current angular velocity onto dodge axis
          const av = body.angularVelocity;
          const proj = av.x * ax + av.y * ay + av.z * az;
          // Remove that projection
          av.x -= ax * proj;
          av.y -= ay * proj;
          av.z -= az * proj;
        }
      }

      state._dodgeDecaying = true;
      state._dodgeDecayStart = simTime;
    }

    // Decay vertical momentum for 150ms after dodge torque ends
    if (state._dodgeDecaying) {
      if ((simTime - state._dodgeDecayStart) < 150) {
        body.velocity.y *= 0.65;
      } else {
        state._dodgeDecaying = false;
      }
    }
  }

  handleBoost(body, state, input, dt) {
    if (input.boost && state.boost > 0) {
      state.boost -= CAR.BOOST_USAGE_RATE * dt;
      if (state.boost < 0) state.boost = 0;

      _v1.set(0, 0, 1);
      body.quaternion.vmult(_v1, _v1);
      const vel = body.velocity;
      vel.x += _v1.x * CAR.BOOST_ACCELERATION * dt;
      vel.y += _v1.y * CAR.BOOST_ACCELERATION * dt;
      vel.z += _v1.z * CAR.BOOST_ACCELERATION * dt;

      // Clamp total speed to boost max
      const speed = vel.length();
      if (speed > CAR.BOOST_MAX_SPEED) {
        const scale = CAR.BOOST_MAX_SPEED / speed;
        vel.x *= scale;
        vel.y *= scale;
        vel.z *= scale;
      }
    }
  }

  handleAirThrottle(body, state, input, dt) {
    if (state.isGrounded || !input.throttle) return;

    _v1.set(0, 0, 1);
    body.quaternion.vmult(_v1, _v1);
    const accel = input.throttle * CAR.AIR_THROTTLE_ACCEL * dt;
    body.velocity.x += _v1.x * accel;
    body.velocity.y += _v1.y * accel;
    body.velocity.z += _v1.z * accel;
  }

  clampAngularVelocity(body, state) {
    // Skip during dodge -- dodge spin intentionally exceeds the cap
    if (state.isDodging) return;

    const av = body.angularVelocity;
    const mag = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
    if (mag > CAR.MAX_ANGULAR_VELOCITY) {
      const scale = CAR.MAX_ANGULAR_VELOCITY / mag;
      av.x *= scale;
      av.y *= scale;
      av.z *= scale;
    }
  }

  handleAirControl(body, state, input, dt) {
    if (state.isGrounded || state.isDodging) return;

    const angVel = body.angularVelocity;
    const quat = body.quaternion;

    // Get car's local axes in world space
    _v1.set(1, 0, 0);
    const rightAxis = quat.vmult(_v1);
    _v1.set(0, 1, 0);
    const upAxis = quat.vmult(_v1);
    _v1.set(0, 0, 1);
    const forwardAxis = quat.vmult(_v1);

    // Decompose world angular velocity into local axes
    const localPitch = angVel.x * rightAxis.x + angVel.y * rightAxis.y + angVel.z * rightAxis.z;
    const localYaw = angVel.x * upAxis.x + angVel.y * upAxis.y + angVel.z * upAxis.z;
    const localRoll = angVel.x * forwardAxis.x + angVel.y * forwardAxis.y + angVel.z * forwardAxis.z;

    // Input values
    const pitchInput = input.pitchUp ? -1 : (input.pitchDown ? 1 : 0);
    const yawInput = input.steer || 0;
    const rollInput = input.airRoll || 0;

    // RL torque model: torque = input * torqueStrength
    // RL damping model: damping reduces with input magnitude for pitch/yaw,
    //                   roll damping is always on
    const torqueScale = 0.1;  // tuning factor (approximates RL's CAR_TORQUE_SCALE * inertia)

    const pitchTorque = pitchInput * CAR.AIR_PITCH_TORQUE * torqueScale;
    const yawTorque = yawInput * CAR.AIR_YAW_TORQUE * torqueScale;
    const rollTorque = rollInput * CAR.AIR_ROLL_TORQUE * torqueScale;

    // Per-axis damping: pitch/yaw damping reduces when that axis has input
    const pitchDamp = CAR.AIR_PITCH_DAMPING * (1 - Math.abs(pitchInput)) * torqueScale;
    const yawDamp = CAR.AIR_YAW_DAMPING * (1 - Math.abs(yawInput)) * torqueScale;
    const rollDamp = CAR.AIR_ROLL_DAMPING * torqueScale;  // always on, even with input

    // Compute local angular acceleration: torque - damping * velocity
    const dPitch = (pitchTorque - pitchDamp * localPitch) * dt;
    const dYaw = (yawTorque - yawDamp * localYaw) * dt;
    const dRoll = (rollTorque - rollDamp * localRoll) * dt;

    // Apply back in world space
    angVel.x += rightAxis.x * dPitch + upAxis.x * dYaw + forwardAxis.x * dRoll;
    angVel.y += rightAxis.y * dPitch + upAxis.y * dYaw + forwardAxis.y * dRoll;
    angVel.z += rightAxis.z * dPitch + upAxis.z * dYaw + forwardAxis.z * dRoll;
  }
}

/**
 * Create a fresh car state object with all physics-relevant fields.
 * Used by both client and server car classes.
 */
export function createCarState() {
  return {
    boost: 33,  // RL starts with 33 boost, not 34
    isGrounded: false,
    hasJumped: false,
    canDoubleJump: false,
    jumpTime: 0,
    isDodging: false,
    dodgeTime: 0,
    jumpLockout: 0,
    _jumpedFromWall: false,
    _jumpNormalY: 1,
    _dodgeAngVel: null,
    _dodgeDecaying: false,
    _dodgeDecayStart: 0,
    _selfRighting: false,
    surfaceNormal: new CANNON.Vec3(0, 1, 0),
    onWall: false,
    onGoalSurface: false,
    demolished: false,
    respawnTimer: 0,
  };
}

/**
 * Reset car state (e.g. after goal or respawn).
 * Also resets the body position/velocity/quaternion.
 */
export function resetCarState(body, state, position, direction) {
  body.position.set(position.x, position.y, position.z);
  body.velocity.set(0, 0, 0);
  body.angularVelocity.set(0, 0, 0);

  if (direction === -1) {
    body.quaternion.setFromEuler(0, Math.PI, 0);
  } else {
    body.quaternion.setFromEuler(0, 0, 0);
  }

  state.boost = 33;  // RL-accurate starting boost
  state.hasJumped = false;
  state._jumpedFromWall = false;
  state._jumpNormalY = 1;
  state.canDoubleJump = false;
  state.isDodging = false;
  state._dodgeDecaying = false;
  state._dodgeDecayStart = 0;
  state._selfRighting = false;
  state.isGrounded = false;
  state.onWall = false;
  state.onGoalSurface = false;
  state.surfaceNormal.set(0, 1, 0);
}

// Singleton instance -- both client and server can share
export const carPhysics = new CarPhysics();
