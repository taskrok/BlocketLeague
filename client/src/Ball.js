// ============================================
// Ball - Physics + Rendering for the game ball
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BALL, ARENA, COLORS, COLLISION_GROUPS } from '../../shared/constants.js';

// Impulse detector tuning: accumulated velocity change (units/s) that counts
// as an impact, the accumulator's decay time constant, and the minimum gap
// between two reported impacts (a ball scraping along a car/wall otherwise
// fires every frame).
const IMPULSE_THRESHOLD = 16;
const IMPULSE_ACCUM_TAU = 0.07;
const IMPULSE_COOLDOWN = 0.12;

export class Ball {
  constructor(scene, world, isRemote = false) {
    this.scene = scene;
    this.world = world;
    this.isRemote = isRemote;

    this._createPhysics();
    this._createMesh();

    // Visual rotation tracked separately — cannon-es doesn't reliably
    // generate angular velocity from friction on trimesh contacts.
    this._spinQuat = new THREE.Quaternion();
    this._rollAxis = new THREE.Vector3();
    this._deltaQuat = new THREE.Quaternion();

    // Impact flash state
    this._flashIntensity = 0;
    this._flashDecayRate = 0;
    this._originalEmissiveColor = new THREE.Color(COLORS.BALL);
    this._flashColor = new THREE.Color(0xffffff);

    // Visual visibility (see setVisible). The point light is never hidden via
    // `visible` because changing the visible light count forces every lit
    // material in the scene to recompile; its intensity is driven instead.
    this._visible = true;

    // Impulse detector: a sudden velocity change (car hit, wall/floor bounce)
    // is exposed for one frame so VFX can react. Works identically whether the
    // velocity comes from local physics or the server (isRemote).
    // The velocity change is accumulated with a short decay so a hit that the
    // network interpolation spreads over 2-3 frames still registers once.
    this._prevVel = new THREE.Vector3();
    this._dvAccum = new THREE.Vector3();
    this._impulseCooldown = 0;
    this.lastImpulse = 0;                       // magnitude (0 = none this frame)
    this.lastImpulseDir = new THREE.Vector3();  // unit direction of the velocity change
  }

  /**
   * Show/hide the ball visuals. The glow light stays in the scene (constant
   * light count) and is dimmed to 0 instead of being hidden.
   */
  setVisible(visible) {
    visible = !!visible;
    this._visible = visible;
    this.sphere.visible = visible;
    this.shadowIndicator.visible = visible;
    if (!visible) this.light.intensity = 0;
  }

  _createPhysics() {
    const shape = new CANNON.Sphere(BALL.RADIUS);

    this.body = new CANNON.Body({
      mass: BALL.MASS,
      shape: shape,
      position: new CANNON.Vec3(0, BALL.RADIUS + 0.5, 0),
      linearDamping: BALL.LINEAR_DAMPING,
      angularDamping: BALL.ANGULAR_DAMPING,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUPS.BALL,
      collisionFilterMask: COLLISION_GROUPS.ARENA_TRIMESH | COLLISION_GROUPS.CAR,
    });

    this.body.material = new CANNON.Material('ball');

    if (!this.isRemote) {
      this.world.addBody(this.body);
    }
  }

  _createMesh() {
    this.mesh = new THREE.Group();

    // Main sphere
    const geometry = new THREE.IcosahedronGeometry(BALL.RADIUS, 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: COLORS.BALL,
      emissiveIntensity: 0.4,
      metalness: 0.3,
      roughness: 0.4,
    });

    this.sphere = new THREE.Mesh(geometry, material);
    this.sphere.castShadow = true;
    this.mesh.add(this.sphere);

    // Dark pentagon patches placed at icosahedron vertices so spin is visible
    const phi = (1 + Math.sqrt(5)) / 2;
    const patchDirs = [
      [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
      [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
      [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
    ];
    const patchMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      emissive: COLORS.BALL,
      emissiveIntensity: 0.15,
      metalness: 0.4,
      roughness: 0.5,
    });
    const patchGeo = new THREE.CircleGeometry(BALL.RADIUS * 0.38, 5);
    patchDirs.forEach(v => {
      const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
      const dir = new THREE.Vector3(v[0]/len, v[1]/len, v[2]/len);
      const patch = new THREE.Mesh(patchGeo, patchMat);
      patch.position.copy(dir).multiplyScalar(BALL.RADIUS * 1.001);
      patch.lookAt(dir.clone().multiplyScalar(BALL.RADIUS * 2));
      this.sphere.add(patch);
    });

    // Inner glow light (smaller range on touch devices to avoid visible aura)
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.light = new THREE.PointLight(COLORS.BALL, isMobile ? 0.4 : 1.0, isMobile ? 8 : 20);
    this.mesh.add(this.light);

    // Ground shadow indicator (ring on the floor below ball)
    const shadowGeo = new THREE.RingGeometry(0.5, BALL.RADIUS * 0.8, 32);
    this.shadowMat = new THREE.MeshBasicMaterial({
      color: COLORS.BALL,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    this.shadowIndicator = new THREE.Mesh(shadowGeo, this.shadowMat);
    this.shadowIndicator.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadowIndicator);

    this.scene.add(this.mesh);
  }

  /**
   * Trigger a visual flash on ball impact.
   * @param {number} impactSpeed - speed of the impact (used to scale intensity)
   */
  flash(impactSpeed) {
    const t = Math.min(impactSpeed / 80, 1);  // normalize
    this._flashIntensity = 1.0 + t * 1.5;     // 1.0 to 2.5
    this._flashDecayRate = this._flashIntensity / 0.1; // fully decay over ~100ms
  }

  update(dt) {
    // Clamp ball speed
    const vel = this.body.velocity;
    const speed = vel.length();
    if (speed > BALL.MAX_SPEED) {
      const scale = BALL.MAX_SPEED / speed;
      vel.x *= scale;
      vel.y *= scale;
      vel.z *= scale;
    }

    // Clamp angular velocity
    const av = this.body.angularVelocity;
    const avMag = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
    if (avMag > BALL.MAX_ANGULAR_VELOCITY) {
      const avScale = BALL.MAX_ANGULAR_VELOCITY / avMag;
      av.x *= avScale;
      av.y *= avScale;
      av.z *= avScale;
    }

    // Prevent ball from tunneling through arena boundaries
    const pos = this.body.position;
    const R = BALL.RADIUS;
    const HW = ARENA.WIDTH / 2;
    const HL = ARENA.LENGTH / 2;
    const H = ARENA.HEIGHT;
    if (pos.y < R) { pos.y = R; if (vel.y < 0) vel.y *= -BALL.RESTITUTION; }
    if (pos.y > H - R) { pos.y = H - R; if (vel.y > 0) vel.y *= -BALL.RESTITUTION; }
    if (pos.x < -HW + R) { pos.x = -HW + R; if (vel.x < 0) vel.x *= -BALL.RESTITUTION; }
    else if (pos.x > HW - R) { pos.x = HW - R; if (vel.x > 0) vel.x *= -BALL.RESTITUTION; }
    const inGoalX = Math.abs(pos.x) < ARENA.GOAL_WIDTH / 2;
    const inGoalY = pos.y < ARENA.GOAL_HEIGHT;
    if (!inGoalX || !inGoalY) {
      if (pos.z < -HL + R) { pos.z = -HL + R; if (vel.z < 0) vel.z *= -BALL.RESTITUTION; }
      else if (pos.z > HL - R) { pos.z = HL - R; if (vel.z > 0) vel.z *= -BALL.RESTITUTION; }
    }

    // Impulse detection (after clamping so a MAX_SPEED clamp never registers)
    const pv = this._prevVel;
    const acc = this._dvAccum;
    const decay = Math.exp(-dt / IMPULSE_ACCUM_TAU);
    acc.x = acc.x * decay + (vel.x - pv.x);
    acc.y = acc.y * decay + (vel.y - pv.y);
    acc.z = acc.z * decay + (vel.z - pv.z);
    pv.set(vel.x, vel.y, vel.z);
    this._impulseCooldown -= dt;
    const dv = acc.length();
    if (dv > IMPULSE_THRESHOLD && this._impulseCooldown <= 0) {
      this.lastImpulse = dv;
      this.lastImpulseDir.set(acc.x / dv, acc.y / dv, acc.z / dv);
      acc.set(0, 0, 0);
      this._impulseCooldown = IMPULSE_COOLDOWN;
      // Remote balls get no collide events; flash from the detector instead
      if (this.isRemote) this.flash(dv);
    } else {
      this.lastImpulse = 0;
    }

    // Sync position from physics
    this.mesh.position.copy(this.body.position);

    // Derive visual spin from linear velocity (rolling ball: ω = v / r)
    const curSpeed = vel.length();
    if (curSpeed > 0.5) {
      // Roll axis = cross(velocity, up) — perpendicular to both
      this._rollAxis.set(vel.z, 0, -vel.x).normalize();
      if (this._rollAxis.lengthSq() > 0.001) {
        const angularSpeed = curSpeed / BALL.RADIUS;
        this._deltaQuat.setFromAxisAngle(this._rollAxis, angularSpeed * dt);
        this._spinQuat.premultiply(this._deltaQuat);
        this._spinQuat.normalize();
      }
    }
    this.mesh.quaternion.copy(this._spinQuat);

    // Update light intensity based on speed (0 while hidden — see setVisible)
    if (!this._visible) {
      this.light.intensity = 0;
    } else {
      this.light.intensity = this.light.distance <= 8
        ? 0.3 + Math.min(curSpeed * 0.02, 0.5)   // mobile: subtle
        : 0.8 + Math.min(curSpeed * 0.05, 1.5);   // desktop: full glow
    }

    // Emissive intensity based on speed
    let intensity = 0.3 + Math.min(curSpeed * 0.02, 0.8);

    // Impact flash: blend emissive toward white and boost intensity
    if (this._flashIntensity > 0) {
      this._flashIntensity -= this._flashDecayRate * dt;
      if (this._flashIntensity < 0) this._flashIntensity = 0;
      const flashT = this._flashIntensity / 2.5; // 0 to 1
      this.sphere.material.emissive.copy(this._originalEmissiveColor).lerp(this._flashColor, flashT);
      intensity += this._flashIntensity;
    } else {
      this.sphere.material.emissive.copy(this._originalEmissiveColor);
    }
    this.sphere.material.emissiveIntensity = intensity;

    // Update shadow indicator position (always on ground below ball)
    this.shadowIndicator.position.set(
      this.body.position.x,
      0.05,
      this.body.position.z
    );

    // Shadow opacity based on height
    const height = this.body.position.y;
    this.shadowMat.opacity = Math.max(0, 0.4 - height * 0.015);
  }

  reset() {
    this.body.position.set(0, BALL.RADIUS + 0.5, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this._prevVel.set(0, 0, 0);
    this._dvAccum.set(0, 0, 0);
    this.lastImpulse = 0;
    this._spinQuat.identity();
    // Sync mesh immediately so visuals match reset position
    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.set(0, 0, 0, 1);
  }

  getPosition() {
    return this.body.position;
  }

  getSpeed() {
    return this.body.velocity.length();
  }
}
