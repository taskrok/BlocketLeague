// ============================================
// ServerCar — Headless car physics (no rendering)
// All physics methods from Car.js, stripped of Three.js
// ============================================

import * as CANNON from 'cannon-es';
import { CAR, ARENA, COLLISION_GROUPS, PHYSICS, DEMOLITION } from '../shared/constants.js';
import { checkCurveSurface } from '../shared/CurveSurface.js';

export class ServerCar {
  constructor(world, position, direction = 1) {
    this.world = world;
    this.direction = direction;

    // State
    this.boost = 34;
    this.isGrounded = false;
    this.hasJumped = false;
    this.canDoubleJump = false;
    this.jumpTime = 0;
    this.isDodging = false;
    this.dodgeTime = 0;
    this.jumpLockout = 0;
    this._dodgeAngVel = null;
    this._dodgeDecaying = false;
    this._dodgeDecayStart = 0;
    this._stuckTimer = 0;

    // Surface tracking
    this.surfaceNormal = new CANNON.Vec3(0, 1, 0);
    this.onWall = false;
    this.onGoalSurface = false;

    // Demolition state
    this.demolished = false;
    this.respawnTimer = 0;

    this._createPhysics(position);
  }

  _createPhysics(position) {
    const shape = new CANNON.Box(
      new CANNON.Vec3(CAR.WIDTH / 2, CAR.HEIGHT / 2, CAR.LENGTH / 2)
    );

    // Tilt hitbox nose-down to match Octane profile
    const tiltRad = (CAR.HITBOX_ANGLE * Math.PI) / 180;
    const shapeOffset = new CANNON.Vec3(0, 0, 0);
    const shapeQuat = new CANNON.Quaternion();
    shapeQuat.setFromEuler(tiltRad, 0, 0);

    this.body = new CANNON.Body({
      mass: CAR.MASS,
      position: new CANNON.Vec3(position.x, position.y, position.z),
      linearDamping: 0.01,
      angularDamping: 0.5,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUPS.CAR,
      collisionFilterMask: COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR,
    });
    this.body.addShape(shape, shapeOffset, shapeQuat);

    if (this.direction === -1) {
      this.body.quaternion.setFromEuler(0, Math.PI, 0);
    }

    this.world.addBody(this.body);
  }

  update(input, dt) {
    if (this.demolished) return;
    this._checkGround();
    this._handleSelfRight(input, dt);
    this._handleMovement(input, dt);
    this._handleJump(input, dt);
    this._handleBoost(input, dt);
    this._handleAirThrottle(input, dt);
    this._handleAirControl(input, dt);
    this._clampAngularVelocity();
    this._applyStickyForce(dt);
  }

  _checkGround() {
    if (this.hasJumped && (Date.now() - this.jumpLockout) < 100) {
      this.isGrounded = false;
      return;
    }

    // During dodge flip (and brief decay after), suppress ground detection
    // so the car can complete its rotation without being snapped to the floor.
    if (this.isDodging || this._dodgeDecaying) {
      this.isGrounded = false;
      return;
    }

    const wasGrounded = this.isGrounded;
    const pos = this.body.position;

    const curveHit = checkCurveSurface(pos);
    const goalHit = this._checkGoalSurface(pos);

    let hit = null;
    if (curveHit && goalHit) {
      hit = (curveHit.dist < goalHit.dist) ? curveHit : goalHit;
    } else {
      hit = curveHit || goalHit;
    }
    this.onGoalSurface = (hit === goalHit && hit !== null);

    if (hit) {
      this.isGrounded = true;
      this.surfaceNormal.copy(hit.normal);
      this.onWall = Math.abs(this.surfaceNormal.y) < 0.7;

      const offset = CAR.HEIGHT / 2 + 0.05;
      const targetX = hit.sx + hit.normal.x * offset;
      const targetY = hit.sy + hit.normal.y * offset;
      const targetZ = hit.sz + hit.normal.z * offset;

      const snap = 0.2;
      this.body.position.x += (targetX - pos.x) * snap;
      this.body.position.y += (targetY - pos.y) * snap;
      this.body.position.z += (targetZ - pos.z) * snap;

      const vDotN = this.body.velocity.dot(this.surfaceNormal);
      if (vDotN < 0) {
        this.body.velocity.x -= this.surfaceNormal.x * vDotN;
        this.body.velocity.y -= this.surfaceNormal.y * vDotN;
        this.body.velocity.z -= this.surfaceNormal.z * vDotN;
      }
    } else {
      const bottomY = pos.y - CAR.HEIGHT / 2;
      if (bottomY <= 0.5) {
        this.isGrounded = true;
        this.surfaceNormal.set(0, 1, 0);
        this.onWall = false;
        this.onGoalSurface = false;
      } else {
        this.isGrounded = false;
        this.onWall = false;
        this.onGoalSurface = false;
      }
    }

    if (this.isGrounded && !wasGrounded) {
      this.hasJumped = false;
      this.canDoubleJump = false;
      this.isDodging = false;
      this._dodgeDecaying = false;

      // Landing recovery: if tilted on nose/tail/side, snap toward upright
      const up = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
      const upDot = up.dot(this.surfaceNormal);
      if (upDot < 0.85) {
        const euler = new CANNON.Vec3();
        this.body.quaternion.toEuler(euler);
        const target = new CANNON.Quaternion();
        target.setFromEuler(0, euler.y, 0);
        this.body.quaternion.slerp(target, 0.6, this.body.quaternion);
        this.body.quaternion.normalize();
        this.body.angularVelocity.scale(0.1, this.body.angularVelocity);
        if (this.body.velocity.y < 2) {
          this.body.velocity.y = 2;
        }
      }
    }
  }

  _checkGoalSurface(pos) {
    const GW = ARENA.GOAL_WIDTH / 2;
    const GH = ARENA.GOAL_HEIGHT;
    const GD = ARENA.GOAL_DEPTH;
    const GFR = ARENA.GOAL_FILLET_RADIUS;
    const HL = ARENA.LENGTH / 2;
    const detectRange = CAR.HEIGHT * 3.5;

    let best = null;
    let bestDist = Infinity;

    if (Math.abs(pos.x) > GW + detectRange || pos.y > GH + detectRange) return null;

    for (const side of [-1, 1]) {
      if (side * pos.z < side * (HL - detectRange)) continue;
      if (side * pos.z > side * (HL + GD + detectRange)) continue;

      const zMouth = side * HL;
      const zBack = side * (HL + GD);
      const zFilletStart = side * (HL + GD - GFR);

      // Goal ceiling flat
      if (Math.abs(pos.x) < GW - GFR && side * pos.z > side * zMouth && side * pos.z < side * zFilletStart) {
        const dist = Math.abs(pos.y - GH);
        if (dist < detectRange && dist < bestDist) {
          bestDist = dist;
          best = { sx: pos.x, sy: GH, sz: pos.z, normal: new CANNON.Vec3(0, -1, 0), dist };
        }
      }

      // Goal back wall flat
      if (Math.abs(pos.x) < GW - GFR && pos.y > GFR && pos.y < GH - GFR) {
        const dist = Math.abs(pos.z - zBack);
        if (dist < detectRange && dist < bestDist) {
          bestDist = dist;
          best = { sx: pos.x, sy: pos.y, sz: zBack, normal: new CANNON.Vec3(0, 0, -side), dist };
        }
      }

      // Goal side walls flat
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

      // Floor-to-back fillet
      if (Math.abs(pos.x) < GW - GFR) {
        const cy = GFR;
        const cz = side * (HL + GD - GFR);
        const dcy = pos.y - cy;
        const dcz = pos.z - cz;
        const d = Math.sqrt(dcy * dcy + dcz * dcz);
        if (d > 0.001) {
          const uy = dcy / d;
          const uz = dcz / d;
          if (uy <= 0 && side * uz >= 0) {
            const dist = Math.abs(d - GFR);
            if (dist < detectRange && dist < bestDist) {
              bestDist = dist;
              best = { sx: pos.x, sy: cy + GFR * uy, sz: cz + GFR * uz, normal: new CANNON.Vec3(0, -uy, -uz), dist };
            }
          }
        }
      }

      // Ceiling-to-back fillet
      if (Math.abs(pos.x) < GW - GFR) {
        const cy = GH - GFR;
        const cz = side * (HL + GD - GFR);
        const dcy = pos.y - cy;
        const dcz = pos.z - cz;
        const d = Math.sqrt(dcy * dcy + dcz * dcz);
        if (d > 0.001) {
          const uy = dcy / d;
          const uz = dcz / d;
          if (uy >= 0 && side * uz >= 0) {
            const dist = Math.abs(d - GFR);
            if (dist < detectRange && dist < bestDist) {
              bestDist = dist;
              best = { sx: pos.x, sy: cy + GFR * uy, sz: cz + GFR * uz, normal: new CANNON.Vec3(0, -uy, -uz), dist };
            }
          }
        }
      }

      // Floor-to-side fillets
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
            if (ps * ux >= 0 && uy <= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                best = { sx: cx + GFR * ux, sy: cy + GFR * uy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0), dist };
              }
            }
          }
        }
      }

      // Ceiling-to-side fillets
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
            if (ps * ux >= 0 && uy >= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                best = { sx: cx + GFR * ux, sy: cy + GFR * uy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0), dist };
              }
            }
          }
        }
      }

      // Side-to-back fillets
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
            if (ps * ux >= 0 && side * uz >= 0) {
              const dist = Math.abs(d - GFR);
              if (dist < detectRange && dist < bestDist) {
                bestDist = dist;
                best = { sx: cx + GFR * ux, sy: pos.y, sz: cz + GFR * uz, normal: new CANNON.Vec3(-ux, 0, -uz), dist };
              }
            }
          }
        }
      }
    }

    if (best) best.dist = bestDist;
    return best;
  }

  _handleSelfRight(input, dt) {
    if (this.onWall) return;

    const up = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    const onFloor = this.body.position.y < CAR.HEIGHT * 3;

    if (!onFloor) {
      this._stuckTimer = 0;
      return;
    }

    const isTilted = up.y < 0.7;
    const isFlipped = up.y < 0.3;

    if (!isTilted) {
      this._stuckTimer = 0;
      return;
    }

    this._stuckTimer = (this._stuckTimer || 0) + dt;

    const hasInput = input.throttle !== 0 || input.jumpPressed || input.steer !== 0;
    if (isFlipped && hasInput) {
      this._doSelfRight(0.2);
      return;
    }

    if (this._stuckTimer > 0.4) {
      this._doSelfRight(0.25);
    }
  }

  _doSelfRight(slerpFactor) {
    if (this.body.velocity.y < 3) {
      this.body.velocity.y = 8;
    }
    const euler = new CANNON.Vec3();
    this.body.quaternion.toEuler(euler);
    const target = new CANNON.Quaternion();
    target.setFromEuler(0, euler.y, 0);
    this.body.quaternion.slerp(target, slerpFactor, this.body.quaternion);
    this.body.angularVelocity.scale(0.3, this.body.angularVelocity);
  }

  _handleMovement(input, dt) {
    if (!this.isGrounded) return;

    const vel = this.body.velocity;
    const quat = this.body.quaternion;
    const normal = this.surfaceNormal;

    const rawForward = quat.vmult(new CANNON.Vec3(0, 0, 1));

    const dot = rawForward.dot(normal);
    const forward = new CANNON.Vec3(
      rawForward.x - dot * normal.x,
      rawForward.y - dot * normal.y,
      rawForward.z - dot * normal.z
    );
    const fLen = forward.length();
    if (fLen < 0.001) return;
    forward.scale(1 / fLen, forward);

    const right = new CANNON.Vec3();
    forward.cross(normal, right);
    const rLen = right.length();
    if (rLen < 0.001) return;
    right.scale(1 / rLen, right);

    const forwardSpeed = vel.dot(forward);

    if (input.throttle !== 0) {
      const goingForward = input.throttle > 0;
      const maxFwd = (input.boost && this.boost > 0) ? CAR.BOOST_MAX_SPEED : CAR.MAX_SPEED;
      const maxSpeed = goingForward ? maxFwd : CAR.REVERSE_MAX_SPEED;
      const opposing = (goingForward && forwardSpeed < -0.5) || (!goingForward && forwardSpeed > 0.5);
      let accel;
      if (opposing) {
        accel = CAR.BRAKE_FORCE;
      } else {
        const speedRatio = Math.min(Math.abs(forwardSpeed) / maxSpeed, 1);
        const taper = 1 - speedRatio * speedRatio;
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

    const handbraking = !!input.handbrake;
    if (input.steer !== 0 && (Math.abs(forwardSpeed) > 0.5 || handbraking)) {
      const turnDir = forwardSpeed >= 0 ? 1 : -1;
      const turnMultiplier = handbraking ? CAR.HANDBRAKE_TURN_MULTIPLIER : 1;
      const turnAmount = input.steer * CAR.TURN_SPEED * turnDir * turnMultiplier;
      this.body.angularVelocity.set(
        normal.x * turnAmount,
        normal.y * turnAmount,
        normal.z * turnAmount
      );
    } else if (!input.steer) {
      this.body.angularVelocity.scale(0.85, this.body.angularVelocity);
    }

    const gripFactor = handbraking ? CAR.HANDBRAKE_GRIP : 0.92;
    const sideSpeed = vel.dot(right);
    const sideRemoval = sideSpeed * gripFactor;
    vel.x -= right.x * sideRemoval;
    vel.y -= right.y * sideRemoval;
    vel.z -= right.z * sideRemoval;

    if (handbraking && Math.abs(sideRemoval) > 0.1) {
      const fwdSign = forwardSpeed >= 0 ? 1 : -1;
      vel.x += forward.x * Math.abs(sideRemoval) * 0.7 * fwdSign;
      vel.y += forward.y * Math.abs(sideRemoval) * 0.7 * fwdSign;
      vel.z += forward.z * Math.abs(sideRemoval) * 0.7 * fwdSign;
    }

    this._alignToSurface(dt);
  }

  _alignToSurface(dt) {
    const normal = this.surfaceNormal;
    const carUp = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));

    if (carUp.dot(normal) > 0.999) return;

    const cross = new CANNON.Vec3();
    carUp.cross(normal, cross);
    const crossLen = cross.length();
    if (crossLen < 0.0001) return;
    cross.scale(1 / crossLen, cross);

    const dotVal = Math.min(1, Math.max(-1, carUp.dot(normal)));
    const angle = Math.acos(dotVal);

    const slerpFactor = Math.min(1, 8 * dt);
    const correction = new CANNON.Quaternion();
    correction.setFromAxisAngle(cross, angle * slerpFactor);
    correction.mult(this.body.quaternion, this.body.quaternion);
    this.body.quaternion.normalize();
  }

  _applyStickyForce(dt) {
    if (!this.isGrounded) return;

    const wallFactor = 1 - Math.abs(this.surfaceNormal.y);
    if (wallFactor < 0.05 && !this.onGoalSurface) return;

    if (this.surfaceNormal.y < -0.5 && !this.onGoalSurface) {
      this.isGrounded = false;
      this.onWall = false;
      return;
    }

    if (wallFactor > 0.3) {
      const speed = this.body.velocity.length();
      if (speed < 2) {
        this.isGrounded = false;
        this.onWall = false;
        return;
      }
    }

    this.body.force.y -= PHYSICS.GRAVITY * CAR.MASS * Math.max(wallFactor, this.onGoalSurface ? 1 : 0);

    if (this.onGoalSurface) {
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS;
      this.body.force.x -= this.surfaceNormal.x * stickForce;
      this.body.force.y -= this.surfaceNormal.y * stickForce;
      this.body.force.z -= this.surfaceNormal.z * stickForce;
    } else {
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS * wallFactor;
      this.body.force.x -= this.surfaceNormal.x * stickForce;
      this.body.force.z -= this.surfaceNormal.z * stickForce;
    }
  }

  _handleJump(input, dt) {
    const now = Date.now();

    if (input.jumpPressed && this.isGrounded && !this.hasJumped) {
      const n = this.surfaceNormal;
      this.body.velocity.x += n.x * CAR.JUMP_FORCE;
      this.body.velocity.y += n.y * CAR.JUMP_FORCE;
      this.body.velocity.z += n.z * CAR.JUMP_FORCE;

      this.hasJumped = true;
      this.jumpTime = now;
      this.jumpLockout = now;
      this.canDoubleJump = true;
      this.isGrounded = false;
      this.onWall = false;
      return;
    }

    if (input.jumpPressed && !this.isGrounded && this.canDoubleJump &&
        (now - this.jumpTime) < CAR.JUMP_COOLDOWN) {

      const df = input.dodgeForward !== undefined ? input.dodgeForward : input.throttle;
      const ds = input.dodgeSteer !== undefined ? input.dodgeSteer : input.steer;

      if (df !== 0 || ds !== 0) {
        const forward = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
        const right = this.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
        forward.y = 0; forward.normalize();
        right.y = 0; right.normalize();

        const dodgeDir = new CANNON.Vec3(
          forward.x * df + right.x * ds,
          0,
          forward.z * df + right.z * ds
        );
        dodgeDir.normalize();

        this.body.velocity.x += dodgeDir.x * CAR.DODGE_FORCE;
        this.body.velocity.z += dodgeDir.z * CAR.DODGE_FORCE;
        this.body.velocity.y = CAR.DODGE_VERTICAL;

        // Flip spin using DODGE_SPIN_SPEED (one rotation in DODGE_DURATION)
        // Normalize so diagonal flips have the same rotation speed as cardinal
        const localSpin = new CANNON.Vec3(
          df,
          0,
          -ds
        );
        const spinLen = localSpin.length();
        if (spinLen > 0) localSpin.scale(CAR.DODGE_SPIN_SPEED / spinLen, localSpin);
        this._dodgeAngVel = this.body.quaternion.vmult(localSpin);
        this.body.angularVelocity.copy(this._dodgeAngVel);

        this.isDodging = true;
        this._dodgeDecaying = false;
        this.dodgeTime = now;
      } else {
        this.body.velocity.y = CAR.DOUBLE_JUMP_FORCE;
      }
      this.canDoubleJump = false;
    }

    // Maintain flip spin during dodge torque phase
    if (this.isDodging) {
      this.body.angularVelocity.copy(this._dodgeAngVel);
      // Cancel gravity so the car floats during the flip — prevents floor
      // collision from blocking the rotation
      this.body.force.y -= PHYSICS.GRAVITY * CAR.MASS;
    }

    // End dodge torque phase after DODGE_DURATION, enter decay
    if (this.isDodging && (now - this.dodgeTime) > CAR.DODGE_DURATION) {
      this.isDodging = false;
      // Zero angular velocity and snap to wheels-down (preserve yaw only)
      this.body.angularVelocity.set(0, 0, 0);
      const euler = new CANNON.Vec3();
      this.body.quaternion.toEuler(euler);
      this.body.quaternion.setFromEuler(0, euler.y, 0);
      this._dodgeDecaying = true;
      this._dodgeDecayStart = now;
    }

    // Decay vertical momentum for 150ms after dodge torque ends
    if (this._dodgeDecaying) {
      if ((now - this._dodgeDecayStart) < 150) {
        this.body.velocity.y *= 0.65;
      } else {
        this._dodgeDecaying = false;
      }
    }
  }

  _handleBoost(input, dt) {
    if (input.boost && this.boost > 0) {
      this.boost -= CAR.BOOST_USAGE_RATE * dt;
      if (this.boost < 0) this.boost = 0;

      const forward = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
      const vel = this.body.velocity;
      vel.x += forward.x * CAR.BOOST_ACCELERATION * dt;
      vel.y += forward.y * CAR.BOOST_ACCELERATION * dt;
      vel.z += forward.z * CAR.BOOST_ACCELERATION * dt;

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

  _handleAirThrottle(input, dt) {
    if (this.isGrounded || !input.throttle) return;

    const forward = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
    const accel = input.throttle * CAR.AIR_THROTTLE_ACCEL * dt;
    this.body.velocity.x += forward.x * accel;
    this.body.velocity.y += forward.y * accel;
    this.body.velocity.z += forward.z * accel;
  }

  _clampAngularVelocity() {
    // Skip during dodge — dodge spin intentionally exceeds the cap
    if (this.isDodging) return;

    const av = this.body.angularVelocity;
    const mag = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
    if (mag > CAR.MAX_ANGULAR_VELOCITY) {
      const scale = CAR.MAX_ANGULAR_VELOCITY / mag;
      av.x *= scale;
      av.y *= scale;
      av.z *= scale;
    }
  }

  _handleAirControl(input, dt) {
    if (this.isGrounded || this.isDodging) return;

    const angVel = this.body.angularVelocity;

    if (input.pitchUp) {
      const axis = this.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
      angVel.x += axis.x * -CAR.AIR_PITCH_SPEED * dt;
      angVel.y += axis.y * -CAR.AIR_PITCH_SPEED * dt;
      angVel.z += axis.z * -CAR.AIR_PITCH_SPEED * dt;
    }
    if (input.pitchDown) {
      const axis = this.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
      angVel.x += axis.x * CAR.AIR_PITCH_SPEED * dt;
      angVel.y += axis.y * CAR.AIR_PITCH_SPEED * dt;
      angVel.z += axis.z * CAR.AIR_PITCH_SPEED * dt;
    }

    if (input.steer !== 0) {
      angVel.y += input.steer * CAR.AIR_YAW_SPEED * dt;
    }

    if (input.airRoll !== 0) {
      const axis = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
      angVel.x += axis.x * input.airRoll * CAR.AIR_ROLL_SPEED * dt;
      angVel.y += axis.y * input.airRoll * CAR.AIR_ROLL_SPEED * dt;
      angVel.z += axis.z * input.airRoll * CAR.AIR_ROLL_SPEED * dt;
    }
  }

  addBoost(amount) {
    this.boost = Math.min(CAR.MAX_BOOST, this.boost + amount);
  }

  reset(position, direction) {
    this.body.position.set(position.x, position.y, position.z);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);

    if (direction === -1) {
      this.body.quaternion.setFromEuler(0, Math.PI, 0);
    } else {
      this.body.quaternion.setFromEuler(0, 0, 0);
    }

    this.boost = 34;
    this.hasJumped = false;
    this.canDoubleJump = false;
    this.isDodging = false;
    this._dodgeDecaying = false;
    this._dodgeDecayStart = 0;
    this.isGrounded = false;
    this.onWall = false;
    this.onGoalSurface = false;
    this.surfaceNormal.set(0, 1, 0);
  }

  demolish() {
    this.demolished = true;
    this.respawnTimer = DEMOLITION.RESPAWN_TIME;
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.position.y = -100;
    this.body.collisionFilterMask = 0;
  }

  updateDemolition(dt, spawnPos, direction) {
    if (!this.demolished) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.demolished = false;
      this.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      this.reset(spawnPos, direction);
    }
  }

  getPosition() { return this.body.position; }
  getVelocity() { return this.body.velocity; }
  getSpeed() { return this.body.velocity.length(); }
}
