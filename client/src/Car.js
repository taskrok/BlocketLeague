// ============================================
// Car - Physics + Rendering for a Rocket League-style car
// Supports wall driving via surface-normal alignment
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CAR, ARENA, COLORS, COLLISION_GROUPS, PHYSICS, DEMOLITION } from '../../shared/constants.js';
import { checkCurveSurface } from '../../shared/CurveSurface.js';
import { buildCarMesh } from './CarMeshBuilder.js';

// Temp vectors reused each frame to avoid GC
const _v1 = new CANNON.Vec3();
const _v2 = new CANNON.Vec3();
const _v3 = new CANNON.Vec3();
const _v4 = new CANNON.Vec3();
const _v5 = new CANNON.Vec3();
const _euler = new CANNON.Vec3();
const _q1 = new CANNON.Quaternion();
const _hitNormal = new CANNON.Vec3();

export class Car {
  constructor(scene, world, position, color = COLORS.CYAN, direction = 1, arenaTrimeshBody = null, variantConfig = null) {
    this.scene = scene;
    this.world = world;
    this.color = color;
    this.direction = direction;
    this.arenaTrimeshBody = arenaTrimeshBody;
    this.variantConfig = variantConfig;

    // State
    this.boost = 34;
    this.isGrounded = false;
    this.hasJumped = false;
    this.canDoubleJump = false;
    this.jumpTime = 0;
    this.isDodging = false;
    this.dodgeTime = 0;
    this.jumpLockout = 0;         // timestamp: suppress ground check briefly after jump
    this._jumpedFromWall = false; // wall jumps need longer lockout to escape detect range
    this._dodgeAngVel = null;     // world-space angular velocity maintained during dodge
    this._dodgeDecaying = false;  // vertical momentum decay after dodge torque phase
    this._dodgeDecayStart = 0;    // timestamp when decay phase began
    this._selfRighting = false;   // active self-right state (triggered by throttle while tilted)

    // Surface tracking for wall driving
    this.surfaceNormal = new CANNON.Vec3(0, 1, 0);
    this.onWall = false;
    this.onGoalSurface = false;

    // Demolition state
    this.demolished = false;
    this.respawnTimer = 0;

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

  _createMesh() {
    if (this.variantConfig) {
      const result = buildCarMesh(this.variantConfig);
      this.mesh = result.mesh;
      this.wheels = result.wheels;
      this.bottomLight = result.bottomLight;
    } else {
      this._createSimpleMesh();
    }

    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);
    this.scene.add(this.mesh);
  }

  _createSimpleMesh() {
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
    if (this.demolished) return;
    // Reduce effective gravity for cars (lighter than ball for easier aerials)
    // Counteract (1 - GRAVITY_SCALE) of world gravity with upward force
    this.body.force.y -= PHYSICS.GRAVITY * CAR.MASS * (1 - CAR.GRAVITY_SCALE);
    this._checkGround();
    this._handleSelfRight(input, dt);
    this._handleMovement(input, dt);
    this._handleJump(input, dt);
    this._handleBoost(input, dt);
    this._handleAirThrottle(input, dt);
    this._handleAirControl(input, dt);
    this._clampAngularVelocity();
    this._applyStickyForce(dt);
    this._syncMesh();
    this._updateEffects(input, dt);
  }

  _checkGround() {
    // After jumping, suppress ground detection so the car can clear the surface.
    // Wall jumps need longer (450ms) because the car moves horizontally and
    // flat vertical walls take longer to escape than curved surfaces.
    const lockoutDuration = this._jumpedFromWall ? 450 : 100;
    if (this.hasJumped && (performance.now() - this.jumpLockout) < lockoutDuration) {
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

    // Try analytical curve detection (arena walls) and goal surfaces
    const curveHit = this._checkCurveSurface(pos);
    const goalHit = this._checkGoalSurface(pos);

    // Pick the closer hit
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

      // Magnetically snap car to the surface
      const offset = CAR.HEIGHT / 2 + 0.05;
      const targetX = hit.sx + hit.normal.x * offset;
      const targetY = hit.sy + hit.normal.y * offset;
      const targetZ = hit.sz + hit.normal.z * offset;

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
      this._jumpedFromWall = false;
    }
  }

  _checkCurveSurface(pos) {
    return checkCurveSurface(pos);
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

      // -- Goal side walls flat (2): x=±GW --
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
      // These fill the dead zone where edge fillets don't overlap at diagonal corners.
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

  _handleSelfRight(input, dt) {
    if (this.onWall) return;
    if (this.isDodging || this._dodgeDecaying) return;
    // Don't fight intentional aerial tilt — but allow self-right if
    // the car has come back down near the floor (failed aerial / landed on head)
    if (this.hasJumped && this.body.position.y > CAR.HEIGHT * 3) return;

    _v1.set(0, 1, 0);
    const up = this.body.quaternion.vmult(_v1);
    const nearFloor = this.body.position.y < CAR.HEIGHT * 3;

    const isTilted = up.y < 0.1; // only when on back, side, or nose — not slight tilt
    if (!isTilted || !nearFloor) { this._endSelfRight(); return; }
    if (!input.throttle) { this._endSelfRight(); return; }

    this._selfRighting = true;

    // Determine roll/pitch axis to right the car
    _v1.set(0, 0, 1);
    const forward = this.body.quaternion.vmult(_v1);
    _v1.set(1, 0, 0);
    const right = this.body.quaternion.vmult(_v1);
    const rollSpeed = 8;

    if (Math.abs(forward.y) < 0.7) {
      // Car is rolled sideways — spin around forward axis
      const rollDir = right.y > 0 ? -1 : 1;
      this.body.angularVelocity.x = forward.x * rollSpeed * rollDir;
      this.body.angularVelocity.y = forward.y * rollSpeed * rollDir;
      this.body.angularVelocity.z = forward.z * rollSpeed * rollDir;
    } else {
      // Car is pitched (nose/tail down) — spin around right axis
      const pitchDir = forward.y > 0 ? 1 : -1;
      this.body.angularVelocity.x = right.x * rollSpeed * pitchDir;
      this.body.angularVelocity.y = right.y * rollSpeed * pitchDir;
      this.body.angularVelocity.z = right.z * rollSpeed * pitchDir;
    }
  }

  _endSelfRight() {
    this._selfRighting = false;
  }

  _handleMovement(input, dt) {
    if (!this.isGrounded) return;

    const vel = this.body.velocity;
    const quat = this.body.quaternion;
    const normal = this.surfaceNormal;

    // Get forward direction in world space (reuse _v1 as rawForward)
    _v1.set(0, 0, 1);
    quat.vmult(_v1, _v1);

    // Project forward onto the surface plane: forward - (forward·normal)*normal
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

    // Right direction: cross(forward, normal) — reuse _v3
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
      const maxFwd = (input.boost && this.boost > 0) ? CAR.BOOST_MAX_SPEED : CAR.MAX_SPEED;
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

    // Steering — rotate around surface normal
    const handbraking = !!input.handbrake;
    if (input.steer !== 0 && (Math.abs(forwardSpeed) > 0.5 || handbraking)) {
      const turnDir = input.throttle !== 0 ? Math.sign(input.throttle) : (forwardSpeed >= 0 ? 1 : -1);
      const turnMultiplier = handbraking ? CAR.HANDBRAKE_TURN_MULTIPLIER : 1;
      const turnAmount = input.steer * CAR.TURN_SPEED * turnDir * turnMultiplier;
      // Set angular velocity along surface normal
      this.body.angularVelocity.set(
        normal.x * turnAmount,
        normal.y * turnAmount,
        normal.z * turnAmount
      );
    } else if (!input.steer) {
      this.body.angularVelocity.scale(0.85, this.body.angularVelocity);
    }

    // Kill sideways velocity (grip) — reduced during handbrake to allow drifting.
    // RL drops lateral friction to ~10% during powerslide — the car preserves its
    // velocity vector naturally because sideways grip is almost zero.
    const gripFactor = handbraking ? CAR.HANDBRAKE_GRIP : 0.92;
    const sideSpeed = vel.dot(right);
    vel.x -= right.x * sideSpeed * gripFactor;
    vel.y -= right.y * sideSpeed * gripFactor;
    vel.z -= right.z * sideSpeed * gripFactor;

    // Align car to surface normal
    this._alignToSurface(dt);
  }

  _alignToSurface(dt) {
    const normal = this.surfaceNormal;
    // Reuse _v4 as carUp
    _v4.set(0, 1, 0);
    this.body.quaternion.vmult(_v4, _v4);

    // If already aligned, skip
    if (_v4.dot(normal) > 0.999) return;

    // Find rotation from carUp to normal — reuse _v5 as cross
    _v4.cross(normal, _v5);
    const crossLen = _v5.length();
    if (crossLen < 0.0001) return;
    _v5.scale(1 / crossLen, _v5);

    const dotVal = Math.min(1, Math.max(-1, _v4.dot(normal)));
    const angle = Math.acos(dotVal);

    // Slerp toward aligned orientation
    const slerpFactor = Math.min(1, 8 * dt); // fast alignment
    _q1.setFromAxisAngle(_v5, angle * slerpFactor);
    _q1.mult(this.body.quaternion, this.body.quaternion);
    this.body.quaternion.normalize();
  }

  _applyStickyForce(dt) {
    if (!this.isGrounded) return;

    // How wall-like is the surface? 0 = flat floor/ceiling, 1 = vertical wall
    const wallFactor = 1 - Math.abs(this.surfaceNormal.y);
    if (wallFactor < 0.05 && !this.onGoalSurface) return; // effectively flat floor, nothing to do

    // Don't stick to arena ceiling (normal pointing down means ceiling)
    // But DO stick to goal ceiling when on a goal surface
    if (this.surfaceNormal.y < -0.5 && !this.onGoalSurface) {
      this.isGrounded = false;
      this.onWall = false;
      return;
    }

    // Need minimum speed to stay on steep walls (like Rocket League)
    if (wallFactor > 0.3) {
      const speed = this.body.velocity.length();
      if (speed < 2) {
        this.isGrounded = false;
        this.onWall = false;
        return;
      }
    }

    // Graduated gravity cancellation — stronger as surface gets more vertical
    // PHYSICS.GRAVITY is negative, so this adds upward force
    this.body.force.y -= PHYSICS.GRAVITY * CAR.MASS * Math.max(wallFactor, this.onGoalSurface ? 1 : 0);

    if (this.onGoalSurface) {
      // Push into surface in all axes (Y included for ceiling driving)
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS;
      this.body.force.x -= this.surfaceNormal.x * stickForce;
      this.body.force.y -= this.surfaceNormal.y * stickForce;
      this.body.force.z -= this.surfaceNormal.z * stickForce;
    } else {
      // Push car into wall surface (XZ only — omit Y so we don't fight gravity cancel)
      const stickForce = CAR.WALL_STICK_FORCE * CAR.MASS * wallFactor;
      this.body.force.x -= this.surfaceNormal.x * stickForce;
      this.body.force.z -= this.surfaceNormal.z * stickForce;
    }
  }

  _handleJump(input, dt) {
    const now = performance.now();

    // First jump — launch along surface normal
    if (input.jumpPressed && this.isGrounded && !this.hasJumped) {
      const n = this.surfaceNormal;
      this._jumpedFromWall = this.onWall;

      if (this.onWall) {
        // Wall jump: kill velocity into wall, push away from wall + give upward boost
        const vDotN = this.body.velocity.dot(n);
        if (vDotN < 0) {
          this.body.velocity.x -= n.x * vDotN;
          this.body.velocity.y -= n.y * vDotN;
          this.body.velocity.z -= n.z * vDotN;
        }
        // Stronger push on flat vertical walls (wallFactor near 1) to escape detect range
        const wallFactor = 1 - Math.abs(n.y);
        const pushMult = 1.0 + wallFactor * 0.6;
        // Push away from wall surface
        this.body.velocity.x += n.x * CAR.JUMP_FORCE * pushMult;
        this.body.velocity.y += n.y * CAR.JUMP_FORCE * pushMult;
        this.body.velocity.z += n.z * CAR.JUMP_FORCE * pushMult;
        // Detach upward so gravity pulls car to floor
        this.body.velocity.y += CAR.JUMP_FORCE * 0.5;
      } else {
        this.body.velocity.x += n.x * CAR.JUMP_FORCE;
        this.body.velocity.y += n.y * CAR.JUMP_FORCE;
        this.body.velocity.z += n.z * CAR.JUMP_FORCE;
      }

      this.hasJumped = true;
      this.jumpTime = now;
      this.jumpLockout = now;
      this.canDoubleJump = true;
      this.isGrounded = false;
      this.onWall = false;
      this.onGoalSurface = false;
      return;
    }

    // Double jump / dodge
    if (input.jumpPressed && !this.isGrounded && this.canDoubleJump &&
        (now - this.jumpTime) < CAR.JUMP_COOLDOWN) {

      const df = input.dodgeForward !== undefined ? input.dodgeForward : input.throttle;
      const ds = input.dodgeSteer !== undefined ? input.dodgeSteer : input.steer;

      if (df !== 0 || ds !== 0) {
        // Dodge in the input direction — reuse _v1 as forward, _v2 as right
        _v1.set(0, 0, 1);
        this.body.quaternion.vmult(_v1, _v1);
        _v2.set(1, 0, 0);
        this.body.quaternion.vmult(_v2, _v2);
        _v1.y = 0; _v1.normalize();
        _v2.y = 0; _v2.normalize();

        // _v3 as dodgeDir
        _v3.set(_v1.x * df + _v2.x * ds, 0, _v1.z * df + _v2.z * ds);
        _v3.normalize();

        // Speed burst in dodge direction
        this.body.velocity.x += _v3.x * CAR.DODGE_FORCE;
        this.body.velocity.z += _v3.z * CAR.DODGE_FORCE;
        this.body.velocity.y = CAR.DODGE_VERTICAL;

        // Flip spin using DODGE_SPIN_SPEED (one rotation in DODGE_DURATION)
        // Normalize so diagonal flips have the same rotation speed as cardinal
        _v4.set(df, 0, -ds);
        const spinLen = _v4.length();
        if (spinLen > 0) _v4.scale(CAR.DODGE_SPIN_SPEED / spinLen, _v4);
        this._dodgeAngVel = this.body.quaternion.vmult(_v4);
        this.body.angularVelocity.copy(this._dodgeAngVel);

        this.isDodging = true;
        this._dodgeDecaying = false;
        this.dodgeTime = now;
      } else {
        // No directional input → small upward pop
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
      this.body.quaternion.toEuler(_euler);
      this.body.quaternion.setFromEuler(0, _euler.y, 0);
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

      _v1.set(0, 0, 1);
      this.body.quaternion.vmult(_v1, _v1);
      const vel = this.body.velocity;
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

  _handleAirThrottle(input, dt) {
    if (this.isGrounded || !input.throttle) return;

    _v1.set(0, 0, 1);
    this.body.quaternion.vmult(_v1, _v1);
    const accel = input.throttle * CAR.AIR_THROTTLE_ACCEL * dt;
    this.body.velocity.x += _v1.x * accel;
    this.body.velocity.y += _v1.y * accel;
    this.body.velocity.z += _v1.z * accel;
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
    const quat = this.body.quaternion;

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

    this.boost = 34;
    this.boostFlame.visible = false;
    this.hasJumped = false;
    this._jumpedFromWall = false;
    this.canDoubleJump = false;
    this.isDodging = false;
    this._dodgeDecaying = false;
    this._dodgeDecayStart = 0;
    this._endSelfRight();
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
    this.mesh.visible = false;
  }

  updateDemolition(dt, spawnPos, direction) {
    if (!this.demolished) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.demolished = false;
      this.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      this.mesh.visible = true;
      this.reset(spawnPos, direction);
    }
  }

  getPosition() { return this.body.position; }
  getVelocity() { return this.body.velocity; }
  getSpeed() { return this.body.velocity.length(); }
}
