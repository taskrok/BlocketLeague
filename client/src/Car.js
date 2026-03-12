// ============================================
// Car - Physics (via shared CarPhysics) + Rendering
// Supports wall driving via surface-normal alignment
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CAR, COLORS, COLLISION_GROUPS, DEMOLITION } from '../../shared/constants.js';
import { carPhysics, createCarState, resetCarState } from '../../shared/CarPhysics.js';
import { buildCarMesh } from './CarMeshBuilder.js';
import { audioManager } from './AudioManager.js';

export class Car {
  constructor(scene, world, position, color = COLORS.CYAN, direction = 1, arenaTrimeshBody = null, variantConfig = null) {
    this.scene = scene;
    this.world = world;
    this.color = color;
    this.direction = direction;
    this.arenaTrimeshBody = arenaTrimeshBody;
    this.variantConfig = variantConfig;

    // Physics state (shared with server via CarPhysics module)
    this._state = createCarState();

    // Simulation time tracker (monotonic, based on tick count * timestep)
    this._simTime = 0;

    // Landing detection: track previous grounded state and vertical velocity
    this._wasGrounded = false;
    this._prevVelY = 0;
    this._justLanded = false;
    this._landingVelY = 0;

    // Audio state tracking
    this._wasBoosting = false;
    this._wasSupersonicBoosting = false;
    this._prevHasJumped = false;
    this._prevIsDodging = false;

    // Whether this car is the local player (set externally by Game)
    this.isLocalPlayer = false;

    this._createPhysics(position);
    this._createMesh();
    this._createBoostTrail();

    // Raycast result object (reused)
    this._rayResult = new CANNON.RaycastResult();
  }

  // ---- State property accessors (delegate to _state) ----
  get boost() { return this._state.boost; }
  set boost(v) { this._state.boost = v; }
  get isGrounded() { return this._state.isGrounded; }
  set isGrounded(v) { this._state.isGrounded = v; }
  get hasJumped() { return this._state.hasJumped; }
  set hasJumped(v) { this._state.hasJumped = v; }
  get canDoubleJump() { return this._state.canDoubleJump; }
  set canDoubleJump(v) { this._state.canDoubleJump = v; }
  get jumpTime() { return this._state.jumpTime; }
  set jumpTime(v) { this._state.jumpTime = v; }
  get isDodging() { return this._state.isDodging; }
  set isDodging(v) { this._state.isDodging = v; }
  get dodgeTime() { return this._state.dodgeTime; }
  set dodgeTime(v) { this._state.dodgeTime = v; }
  get jumpLockout() { return this._state.jumpLockout; }
  set jumpLockout(v) { this._state.jumpLockout = v; }
  get surfaceNormal() { return this._state.surfaceNormal; }
  get onWall() { return this._state.onWall; }
  set onWall(v) { this._state.onWall = v; }
  get onGoalSurface() { return this._state.onGoalSurface; }
  set onGoalSurface(v) { this._state.onGoalSurface = v; }
  get demolished() { return this._state.demolished; }
  set demolished(v) { this._state.demolished = v; }
  get respawnTimer() { return this._state.respawnTimer; }
  set respawnTimer(v) { this._state.respawnTimer = v; }

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

    // Improved boost trail: 10 particles with size variation
    const particleCount = 10;
    this._flameParticles = [];
    for (let i = 0; i < particleCount; i++) {
      const baseSize = 0.35 - (i / particleCount) * 0.2;
      const geo = new THREE.SphereGeometry(baseSize, 6, 6);
      const flameMat = new THREE.MeshBasicMaterial({
        color: COLORS.ORANGE,
        transparent: true,
        opacity: 0.8,
      });
      const flame = new THREE.Mesh(geo, flameMat);
      flame.position.z = -CAR.LENGTH / 2 - 0.4 - i * 0.28;
      flame._baseSize = baseSize;
      flame._baseZ = flame.position.z;
      this.boostFlame.add(flame);
      this._flameParticles.push(flame);
    }

    // Boost point light
    const flameLight = new THREE.PointLight(COLORS.ORANGE, 0, 10);
    flameLight.position.z = -CAR.LENGTH / 2 - 1;
    this.boostFlame.add(flameLight);
    this.flameLight = flameLight;

    this.boostFlame.visible = false;
    this.mesh.add(this.boostFlame);

    // Supersonic speed lines pool
    this._speedLines = [];
    this._speedLinesGroup = new THREE.Group();
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
    });
    const lineGeo = new THREE.BoxGeometry(0.04, 0.04, 3.0);
    for (let i = 0; i < 20; i++) {
      const line = new THREE.Mesh(lineGeo, lineMat.clone());
      line.visible = false;
      // Random cylindrical position around the car
      const angle = Math.random() * Math.PI * 2;
      const radius = 3 + Math.random() * 5;
      line._angle = angle;
      line._radius = radius;
      line._speed = 30 + Math.random() * 40;
      line._zOffset = (Math.random() - 0.5) * 20;
      this._speedLinesGroup.add(line);
      this._speedLines.push(line);
    }
    this.mesh.add(this._speedLinesGroup);

    // Supersonic emissive state
    this._supersonicGlow = 0;  // smoothed 0-1
  }

  update(input, dt) {
    if (this._state.demolished) return;

    // Advance simulation time (monotonic, in ms)
    this._simTime += dt * 1000;

    // Snapshot grounded state before physics for landing detection
    const wasGrounded = this._state.isGrounded;

    // Run shared physics
    carPhysics.update(this.body, this._state, input, dt, this._simTime);

    // Landing detection: just transitioned from airborne to grounded
    if (this._state.isGrounded && !wasGrounded) {
      this._justLanded = true;
      this._landingVelY = this._prevVelY;
    } else {
      this._justLanded = false;
    }
    this._wasGrounded = this._state.isGrounded;
    this._prevVelY = this.body.velocity.y;

    // Audio triggers (local player only)
    if (this.isLocalPlayer) {
      const isBoosting = input.boost && this._state.boost > 0;
      if (isBoosting && !this._wasBoosting) {
        audioManager.startBoost();
      } else if (!isBoosting && this._wasBoosting) {
        audioManager.stopBoost();
      }
      // Supersonic boost hit: trigger when crossing threshold while boosting
      const speed = this.body.velocity.length();
      const isSupersonic = speed >= CAR.SUPERSONIC_THRESHOLD;
      if (isBoosting && isSupersonic && !this._wasSupersonicBoosting) {
        audioManager.playSupersonicBoost();
      }
      this._wasSupersonicBoosting = isBoosting && isSupersonic;
      this._wasBoosting = isBoosting;

      if (this._state.hasJumped && !this._prevHasJumped) {
        audioManager.playJump();
      }
      this._prevHasJumped = this._state.hasJumped;

      if (this._state.isDodging && !this._prevIsDodging) {
        audioManager.playDodge();
      }
      this._prevIsDodging = this._state.isDodging;

      if (this._justLanded) {
        audioManager.playLanding(Math.abs(this._landingVelY));
      }
    }

    // Client-only: sync mesh and visual effects
    this._syncMesh();
    this._updateEffects(input, dt);
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
    const boosting = input.boost && this._state.boost > 0;
    const speed = this.body.velocity.length();
    const isSupersonic = speed >= CAR.SUPERSONIC_THRESHOLD;
    const speedRatio = Math.min(speed / CAR.BOOST_MAX_SPEED, 1);

    this.boostFlame.visible = boosting;

    if (boosting) {
      // Improved boost trail: per-particle jitter, size variation, speed scaling
      for (const flame of this._flameParticles) {
        const sizeScale = (0.7 + Math.random() * 0.6) * (0.8 + speedRatio * 0.6);
        // Bigger at supersonic
        const supScale = isSupersonic ? 1.4 : 1.0;
        flame.scale.setScalar(sizeScale * supScale);
        flame.material.opacity = 0.4 + Math.random() * 0.5;
        // Position jitter for organic flame look
        flame.position.x = (Math.random() - 0.5) * 0.25;
        flame.position.y = (Math.random() - 0.5) * 0.2;
        flame.position.z = flame._baseZ + (Math.random() - 0.5) * 0.15;
        // Brighter at supersonic
        if (isSupersonic) {
          flame.material.color.setHex(0xffcc44);
        } else {
          flame.material.color.setHex(COLORS.ORANGE);
        }
      }
      this.flameLight.intensity = (1 + Math.random() * 1.5) * (isSupersonic ? 2.0 : 1.0);
      this.bottomLight.intensity = 2.0;
    } else {
      this.bottomLight.intensity = 1.0;
      this.flameLight.intensity = 0;
    }

    // --- Supersonic visual effects ---

    // Smooth emissive glow transition
    const targetGlow = isSupersonic ? 1 : 0;
    this._supersonicGlow += (targetGlow - this._supersonicGlow) * Math.min(1, 6 * dt);
    if (this._supersonicGlow > 0.01) {
      // Increase emissive on car body meshes
      this.mesh.traverse((child) => {
        if (child.isMesh && child.material && child.material.emissiveIntensity !== undefined) {
          // Store original emissive intensity if not cached
          if (child._origEmissiveIntensity === undefined) {
            child._origEmissiveIntensity = child.material.emissiveIntensity;
          }
          child.material.emissiveIntensity = child._origEmissiveIntensity + this._supersonicGlow * 0.8;
        }
      });
    } else if (this._supersonicGlow <= 0.01 && this._supersonicGlow > 0) {
      // Restore original emissive
      this.mesh.traverse((child) => {
        if (child.isMesh && child._origEmissiveIntensity !== undefined) {
          child.material.emissiveIntensity = child._origEmissiveIntensity;
        }
      });
      this._supersonicGlow = 0;
    }

    // Speed lines: visible only at supersonic speed
    for (const line of this._speedLines) {
      if (isSupersonic) {
        line.visible = true;
        // Animate z offset to create streaking past effect
        line._zOffset -= line._speed * dt;
        if (line._zOffset < -15) {
          line._zOffset = 10 + Math.random() * 10;
          line._angle = Math.random() * Math.PI * 2;
          line._radius = 3 + Math.random() * 5;
        }
        const px = Math.cos(line._angle) * line._radius;
        const py = Math.sin(line._angle) * line._radius;
        line.position.set(px, py, line._zOffset);
        line.material.opacity = 0.15 + Math.random() * 0.2;
      } else {
        line.visible = false;
      }
    }
  }

  addBoost(amount) {
    this._state.boost = Math.min(CAR.MAX_BOOST, this._state.boost + amount);
  }

  reset(position, direction) {
    resetCarState(this.body, this._state, position, direction);
    this.boostFlame.visible = false;
    this._supersonicGlow = 0;
    this._wasGrounded = false;
    this._prevVelY = 0;
    this._justLanded = false;
    this._landingVelY = 0;
    if (this.isLocalPlayer && this._wasBoosting) {
      audioManager.stopBoost();
      this._wasBoosting = false;
    }
    // Hide speed lines on reset
    for (const line of this._speedLines) {
      line.visible = false;
    }
    // Restore original emissive intensities
    this.mesh.traverse((child) => {
      if (child.isMesh && child._origEmissiveIntensity !== undefined) {
        child.material.emissiveIntensity = child._origEmissiveIntensity;
      }
    });
  }

  demolish() {
    this._state.demolished = true;
    this._state.respawnTimer = DEMOLITION.RESPAWN_TIME;
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.position.y = -100;
    this.body.collisionFilterMask = 0;
    this.mesh.visible = false;
    if (this.isLocalPlayer && this._wasBoosting) {
      audioManager.stopBoost();
      this._wasBoosting = false;
    }
  }

  updateDemolition(dt, spawnPos, direction) {
    if (!this._state.demolished) return;
    this._state.respawnTimer -= dt;
    if (this._state.respawnTimer <= 0) {
      this._state.demolished = false;
      this.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      this.mesh.visible = true;
      this.reset(spawnPos, direction);
    }
  }

  getPosition() { return this.body.position; }
  getVelocity() { return this.body.velocity; }
  getSpeed() { return this.body.velocity.length(); }
}
