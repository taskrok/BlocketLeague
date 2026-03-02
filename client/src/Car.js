// ============================================
// Car - Physics + Rendering for a Rocket League-style car
// Supports wall driving via surface-normal alignment
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CAR, ARENA, COLORS, COLLISION_GROUPS, PHYSICS } from '../../shared/constants.js';

// Temp vectors reused each frame to avoid GC
const _v1 = new CANNON.Vec3();
const _v2 = new CANNON.Vec3();
const _q1 = new CANNON.Quaternion();

export class Car {
  constructor(scene, world, position, color = COLORS.CYAN, direction = 1, arenaTrimeshBody = null) {
    this.scene = scene;
    this.world = world;
    this.color = color;
    this.direction = direction;
    this.arenaTrimeshBody = arenaTrimeshBody;

    // State
    this.boost = 33;
    this.isGrounded = false;
    this.hasJumped = false;
    this.canDoubleJump = false;
    this.jumpTime = 0;
    this.isDodging = false;
    this.dodgeTime = 0;
    this.jumpLockout = 0;         // timestamp: suppress ground check briefly after jump

    // Surface tracking for wall driving
    this.surfaceNormal = new CANNON.Vec3(0, 1, 0);
    this.onWall = false;

    this._createPhysics(position);
    this._createMesh();
    this._createBoostTrail();

    // Raycast result object (reused)
    this._rayResult = new CANNON.RaycastResult();
  }

  _createPhysics(position) {
    const shape = new CANNON.Box(
      new CANNON.Vec3(CAR.WIDTH / 2, CAR.HEIGHT / 2, CAR.LENGTH / 2)
    );

    this.body = new CANNON.Body({
      mass: CAR.MASS,
      shape: shape,
      position: new CANNON.Vec3(position.x, position.y, position.z),
      linearDamping: 0.01,
      angularDamping: 0.5,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUPS.CAR,
      collisionFilterMask: COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR,
    });

    if (this.direction === -1) {
      this.body.quaternion.setFromEuler(0, Math.PI, 0);
    }

    this.world.addBody(this.body);
  }

  _createMesh() {
    this.mesh = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x222244,
      metalness: 0.7,
      roughness: 0.3,
      emissive: this.color,
      emissiveIntensity: 0.15,
    });

    const neonMat = new THREE.MeshStandardMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 3,
    });

    // Main body
    const bodyGeo = new THREE.BoxGeometry(CAR.WIDTH, CAR.HEIGHT * 0.5, CAR.LENGTH);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    this.mesh.add(body);

    // Top / cabin
    const topGeo = new THREE.BoxGeometry(CAR.WIDTH * 0.72, CAR.HEIGHT * 0.45, CAR.LENGTH * 0.5);
    const top = new THREE.Mesh(topGeo, bodyMat);
    top.position.set(0, CAR.HEIGHT * 0.47, -CAR.LENGTH * 0.08);
    this.mesh.add(top);

    // Windshield
    const shieldGeo = new THREE.BoxGeometry(CAR.WIDTH * 0.68, CAR.HEIGHT * 0.4, 0.1);
    const shieldMat = new THREE.MeshStandardMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.6,
    });
    const shield = new THREE.Mesh(shieldGeo, shieldMat);
    shield.position.set(0, CAR.HEIGHT * 0.45, CAR.LENGTH * 0.16);
    shield.rotation.x = -0.3;
    this.mesh.add(shield);

    // Side neon strips
    const stripGeo = new THREE.BoxGeometry(0.15, 0.2, CAR.LENGTH * 1.05);
    [-1, 1].forEach((side) => {
      const strip = new THREE.Mesh(stripGeo, neonMat);
      strip.position.set(side * (CAR.WIDTH / 2 + 0.02), -0.05, 0);
      this.mesh.add(strip);
    });

    // Front strip
    const frontGeo = new THREE.BoxGeometry(CAR.WIDTH * 1.05, 0.2, 0.15);
    const front = new THREE.Mesh(frontGeo, neonMat);
    front.position.set(0, -0.05, CAR.LENGTH / 2 + 0.02);
    this.mesh.add(front);

    // Rear strip
    const rear = new THREE.Mesh(frontGeo.clone(), neonMat);
    rear.position.set(0, -0.05, -CAR.LENGTH / 2 - 0.02);
    this.mesh.add(rear);

    // Undercar neon glow
    const underGeo = new THREE.PlaneGeometry(CAR.WIDTH * 0.8, CAR.LENGTH * 0.8);
    const underMat = new THREE.MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const under = new THREE.Mesh(underGeo, underMat);
    under.rotation.x = -Math.PI / 2;
    under.position.y = -CAR.HEIGHT / 2 - 0.05;
    this.mesh.add(under);

    // Bottom glow light
    this.bottomLight = new THREE.PointLight(this.color, 1.5, 8);
    this.bottomLight.position.set(0, -0.5, 0);
    this.mesh.add(this.bottomLight);

    // Wheels
    this.wheels = [];
    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.25, 8);
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x333344,
      metalness: 0.6,
      roughness: 0.4,
    });

    const wheelPositions = [
      [-CAR.WIDTH / 2 + 0.1, -CAR.HEIGHT / 2 + 0.15, CAR.LENGTH * 0.3],
      [CAR.WIDTH / 2 - 0.1, -CAR.HEIGHT / 2 + 0.15, CAR.LENGTH * 0.3],
      [-CAR.WIDTH / 2 + 0.1, -CAR.HEIGHT / 2 + 0.15, -CAR.LENGTH * 0.3],
      [CAR.WIDTH / 2 - 0.1, -CAR.HEIGHT / 2 + 0.15, -CAR.LENGTH * 0.3],
    ];

    wheelPositions.forEach((pos) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(...pos);
      this.mesh.add(wheel);
      this.wheels.push(wheel);
    });

    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);

    this.scene.add(this.mesh);
  }

  _createBoostTrail() {
    this.boostFlame = new THREE.Group();

    const flameMat = new THREE.MeshBasicMaterial({
      color: COLORS.ORANGE,
      transparent: true,
      opacity: 0.8,
    });

    for (let i = 0; i < 3; i++) {
      const size = 0.3 - i * 0.08;
      const geo = new THREE.SphereGeometry(size, 6, 6);
      const flame = new THREE.Mesh(geo, flameMat.clone());
      flame.position.z = -CAR.LENGTH / 2 - 0.5 - i * 0.4;
      this.boostFlame.add(flame);
    }

    const flameLight = new THREE.PointLight(COLORS.ORANGE, 1, 8);
    flameLight.position.z = -CAR.LENGTH / 2 - 1;
    this.boostFlame.add(flameLight);
    this.flameLight = flameLight;

    this.boostFlame.visible = false;
    this.mesh.add(this.boostFlame);
  }

  update(input, dt) {
    this._checkGround();
    this._handleSelfRight(input, dt);
    this._handleMovement(input, dt);
    this._handleJump(input, dt);
    this._handleBoost(input, dt);
    this._handleAirControl(input, dt);
    this._applyStickyForce(dt);
    this._syncMesh();
    this._updateEffects(input, dt);
  }

  _checkGround() {
    // After jumping, suppress ground detection for 100ms so the car
    // can clear the floor threshold before _checkGround re-grounds it.
    if (this.hasJumped && (performance.now() - this.jumpLockout) < 100) {
      this.isGrounded = false;
      return;
    }

    const wasGrounded = this.isGrounded;
    const pos = this.body.position;

    // Try analytical curve detection first (for wall transitions)
    const curveHit = this._checkCurveSurface(pos);

    if (curveHit) {
      this.isGrounded = true;
      this.surfaceNormal.copy(curveHit.normal);
      this.onWall = Math.abs(this.surfaceNormal.y) < 0.7;

      // Magnetically snap car to the curve surface
      const offset = CAR.HEIGHT / 2 + 0.05;
      const targetX = curveHit.sx + curveHit.normal.x * offset;
      const targetY = curveHit.sy + curveHit.normal.y * offset;
      const targetZ = curveHit.sz + curveHit.normal.z * offset;

      const snap = 0.2;
      this.body.position.x += (targetX - pos.x) * snap;
      this.body.position.y += (targetY - pos.y) * snap;
      this.body.position.z += (targetZ - pos.z) * snap;

      // Kill velocity component going into the surface
      const vDotN = this.body.velocity.dot(this.surfaceNormal);
      if (vDotN < 0) {
        this.body.velocity.x -= this.surfaceNormal.x * vDotN;
        this.body.velocity.y -= this.surfaceNormal.y * vDotN;
        this.body.velocity.z -= this.surfaceNormal.z * vDotN;
      }
    } else {
      // Fallback: simple floor check
      const bottomY = pos.y - CAR.HEIGHT / 2;
      if (bottomY <= 0.5) {
        this.isGrounded = true;
        this.surfaceNormal.set(0, 1, 0);
        this.onWall = false;
      } else {
        this.isGrounded = false;
        this.onWall = false;
      }
    }

    if (this.isGrounded && !wasGrounded) {
      this.hasJumped = false;
      this.canDoubleJump = false;
      this.isDodging = false;
    }
  }

  // Analytically compute the nearest arena curve surface from the car's position.
  // Returns { sx, sy, sz, normal } or null if car is not near any curve/wall.
  _checkCurveSurface(pos) {
    const r = ARENA.CURVE_RADIUS;
    const hw = ARENA.WIDTH / 2;
    const hl = ARENA.LENGTH / 2;
    const flatHW = hw - r;
    const flatHL = hl - r;
    const detectRange = CAR.HEIGHT * 2.5; // how close before we "grab" the surface

    let best = null;
    let bestDist = Infinity;

    // --- Side wall curves (left/right, XY plane) ---
    for (const side of [-1, 1]) {
      const dx = side * pos.x - flatHW; // distance into curve zone
      if (dx > 0 && pos.y < r + detectRange) {
        if (dx < r) {
          // On the curve: floor-to-wall transition
          const ratio = Math.min(dx / r, 1);
          const theta = Math.asin(ratio);
          const sy = r - r * Math.cos(theta);
          const sx = side * (flatHW + dx);
          const nx = -side * Math.sin(theta);  // inward toward arena center
          const ny = Math.cos(theta);
          const dist = Math.sqrt((pos.x - sx) ** 2 + (pos.y - sy) ** 2);
          if (dist < detectRange && dist < bestDist) {
            bestDist = dist;
            best = { sx, sy, sz: pos.z, normal: new CANNON.Vec3(nx, ny, 0) };
          }
        } else {
          // Past the curve, on the flat wall
          const wallX = side * hw;
          const dist = Math.abs(pos.x - wallX);
          if (dist < detectRange && pos.y >= r && pos.y <= ARENA.HEIGHT - r && dist < bestDist) {
            bestDist = dist;
            best = { sx: wallX, sy: pos.y, sz: pos.z, normal: new CANNON.Vec3(-side, 0, 0) };
          }
        }
      }
    }

    // --- End wall curves (front/back, YZ plane, skip goal opening) ---
    for (const side of [-1, 1]) {
      const dz = side * pos.z - flatHL;
      // Skip if in the goal opening zone (X within goal width AND Y below goal height)
      const inGoalX = Math.abs(pos.x) < ARENA.GOAL_WIDTH / 2;
      const inGoalY = pos.y < ARENA.GOAL_HEIGHT;

      if (dz > 0 && pos.y < r + detectRange && !(inGoalX && inGoalY)) {
        if (dz < r) {
          const ratio = Math.min(dz / r, 1);
          const theta = Math.asin(ratio);
          const sy = r - r * Math.cos(theta);
          const sz = side * (flatHL + dz);
          const nz = -side * Math.sin(theta);  // inward toward arena center
          const ny = Math.cos(theta);
          const dist = Math.sqrt((pos.z - sz) ** 2 + (pos.y - sy) ** 2);
          if (dist < detectRange && dist < bestDist) {
            bestDist = dist;
            best = { sx: pos.x, sy, sz, normal: new CANNON.Vec3(0, ny, nz) };
          }
        } else if (!inGoalX || !inGoalY) {
          const wallZ = side * hl;
          const dist = Math.abs(pos.z - wallZ);
          if (dist < detectRange && pos.y >= r && pos.y <= ARENA.HEIGHT - r && dist < bestDist) {
            bestDist = dist;
            best = { sx: pos.x, sy: pos.y, sz: wallZ, normal: new CANNON.Vec3(0, 0, -side) };
          }
        }
      }
    }

    return best;
  }

  _handleSelfRight(input, dt) {
    if (this.onWall) return; // don't self-right when on a wall

    const up = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    const isFlipped = up.y < 0.3;
    const onFloor = this.body.position.y < CAR.HEIGHT * 3;

    if (isFlipped && onFloor && input.throttle !== 0) {
      this.body.velocity.y = 8;
      const euler = new CANNON.Vec3();
      this.body.quaternion.toEuler(euler);
      const target = new CANNON.Quaternion();
      target.setFromEuler(0, euler.y, 0);
      this.body.quaternion.slerp(target, 0.15, this.body.quaternion);
      this.body.angularVelocity.scale(0.5, this.body.angularVelocity);
    }
  }

  _handleMovement(input, dt) {
    if (!this.isGrounded) return;

    const vel = this.body.velocity;
    const quat = this.body.quaternion;
    const normal = this.surfaceNormal;

    // Get forward direction in world space
    const rawForward = quat.vmult(new CANNON.Vec3(0, 0, 1));

    // Project forward onto the surface plane: forward - (forward·normal)*normal
    const dot = rawForward.dot(normal);
    const forward = new CANNON.Vec3(
      rawForward.x - dot * normal.x,
      rawForward.y - dot * normal.y,
      rawForward.z - dot * normal.z
    );
    const fLen = forward.length();
    if (fLen < 0.001) return;
    forward.scale(1 / fLen, forward);

    // Right direction: cross(forward, normal)
    const right = new CANNON.Vec3();
    forward.cross(normal, right);
    const rLen = right.length();
    if (rLen < 0.001) return;
    right.scale(1 / rLen, right);

    // Current forward speed
    const forwardSpeed = vel.dot(forward);

    // Throttle
    if (input.throttle !== 0) {
      const maxSpeed = (input.boost && this.boost > 0) ? CAR.BOOST_MAX_SPEED : CAR.MAX_SPEED;
      const accel = input.throttle > 0 ? CAR.ACCELERATION : CAR.BRAKE_FORCE;
      let targetSpeed = forwardSpeed + input.throttle * accel * dt;
      targetSpeed = Math.max(-maxSpeed, Math.min(maxSpeed, targetSpeed));

      const dv = targetSpeed - forwardSpeed;
      vel.x += forward.x * dv;
      vel.y += forward.y * dv;
      vel.z += forward.z * dv;
    } else {
      // Deceleration — project velocity onto surface and decay
      const drag = Math.pow(0.02, dt);
      const surfVelFwd = vel.dot(forward);
      const surfVelRight = vel.dot(right);
      const normalVel = vel.dot(normal);
      vel.set(
        forward.x * surfVelFwd * drag + right.x * surfVelRight * drag + normal.x * normalVel,
        forward.y * surfVelFwd * drag + right.y * surfVelRight * drag + normal.y * normalVel,
        forward.z * surfVelFwd * drag + right.z * surfVelRight * drag + normal.z * normalVel
      );
    }

    // Steering — rotate around surface normal
    if (input.steer !== 0 && Math.abs(forwardSpeed) > 0.5) {
      const turnDir = forwardSpeed > 0 ? 1 : -1;
      const turnAmount = input.steer * CAR.TURN_SPEED * turnDir;
      // Set angular velocity along surface normal
      this.body.angularVelocity.set(
        normal.x * turnAmount,
        normal.y * turnAmount,
        normal.z * turnAmount
      );
    } else if (!input.steer) {
      this.body.angularVelocity.scale(0.85, this.body.angularVelocity);
    }

    // Kill sideways velocity (grip)
    const sideSpeed = vel.dot(right);
    vel.x -= right.x * sideSpeed * 0.92;
    vel.y -= right.y * sideSpeed * 0.92;
    vel.z -= right.z * sideSpeed * 0.92;

    // Align car to surface normal
    this._alignToSurface(dt);
  }

  _alignToSurface(dt) {
    const normal = this.surfaceNormal;
    const carUp = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));

    // If already aligned, skip
    if (carUp.dot(normal) > 0.999) return;

    // Find rotation from carUp to normal
    const cross = new CANNON.Vec3();
    carUp.cross(normal, cross);
    const crossLen = cross.length();
    if (crossLen < 0.0001) return;
    cross.scale(1 / crossLen, cross);

    const dotVal = Math.min(1, Math.max(-1, carUp.dot(normal)));
    const angle = Math.acos(dotVal);

    // Slerp toward aligned orientation
    const slerpFactor = Math.min(1, 8 * dt); // fast alignment
    const correction = new CANNON.Quaternion();
    correction.setFromAxisAngle(cross, angle * slerpFactor);
    correction.mult(this.body.quaternion, this.body.quaternion);
    this.body.quaternion.normalize();
  }

  _applyStickyForce(dt) {
    if (!this.isGrounded || !this.onWall) return;

    // Don't stick to ceiling (normal pointing down means ceiling)
    if (this.surfaceNormal.y < -0.5) {
      this.isGrounded = false;
      this.onWall = false;
      return;
    }

    // Cancel gravity so the car doesn't slide down the wall
    // PHYSICS.GRAVITY is negative, so this adds upward force
    this.body.force.y -= PHYSICS.GRAVITY * CAR.MASS;

    // Apply force pushing car into the surface
    const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS;
    this.body.force.x -= this.surfaceNormal.x * stickForce;
    this.body.force.y -= this.surfaceNormal.y * stickForce;
    this.body.force.z -= this.surfaceNormal.z * stickForce;
  }

  _handleJump(input, dt) {
    const now = performance.now();

    // First jump — launch along surface normal
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

    // Double jump / dodge
    if (input.jumpPressed && !this.isGrounded && this.canDoubleJump &&
        (now - this.jumpTime) < CAR.JUMP_COOLDOWN) {

      if (input.throttle !== 0 || input.steer !== 0) {
        // Dodge in the input direction
        const forward = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
        const right = this.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
        forward.y = 0; forward.normalize();
        right.y = 0; right.normalize();

        const dodgeDir = new CANNON.Vec3(
          forward.x * input.throttle + right.x * (-input.steer),
          0,
          forward.z * input.throttle + right.z * (-input.steer)
        );
        dodgeDir.normalize();

        // Speed burst in dodge direction
        this.body.velocity.x += dodgeDir.x * CAR.DODGE_FORCE;
        this.body.velocity.z += dodgeDir.z * CAR.DODGE_FORCE;
        this.body.velocity.y = CAR.DODGE_VERTICAL;

        // Flip spin in car's local frame, transformed to world space
        // pitch around local X (right axis), roll around local Z (forward axis)
        const localSpin = new CANNON.Vec3(
          input.throttle * 15,
          0,
          input.steer * 15
        );
        this.body.angularVelocity.copy(this.body.quaternion.vmult(localSpin));

        this.isDodging = true;
        this.dodgeTime = now;
      } else {
        // No directional input → small upward pop
        this.body.velocity.y = CAR.DOUBLE_JUMP_FORCE;
      }
      this.canDoubleJump = false;
    }

    // End dodge spin after 400ms
    if (this.isDodging && (now - this.dodgeTime) > 400) {
      this.isDodging = false;
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

  _syncMesh() {
    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);

    const speed = this.body.velocity.length();
    this.wheels.forEach((wheel) => {
      wheel.rotation.x += speed * 0.05;
    });
  }

  _updateEffects(input, dt) {
    const boosting = input.boost && this.boost > 0;
    this.boostFlame.visible = boosting;

    if (boosting) {
      this.boostFlame.children.forEach((child) => {
        if (child.isMesh) {
          child.scale.setScalar(0.8 + Math.random() * 0.5);
          child.material.opacity = 0.5 + Math.random() * 0.5;
        }
      });
      this.flameLight.intensity = 1 + Math.random() * 1.5;
      this.bottomLight.intensity = 2.0;
    } else {
      this.bottomLight.intensity = 1.0;
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

    this.boost = 33;
    this.hasJumped = false;
    this.canDoubleJump = false;
    this.isDodging = false;
    this.isGrounded = false;
    this.onWall = false;
    this.surfaceNormal.set(0, 1, 0);
  }

  getPosition() { return this.body.position; }
  getVelocity() { return this.body.velocity; }
  getSpeed() { return this.body.velocity.length(); }
}
