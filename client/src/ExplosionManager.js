// ============================================
// ExplosionManager - Explosion/VFX and landing ring effects
// Extracted from Game.js with material pooling optimization
//
// Pooling strategy (allocation-free after warm-up):
//  - Every particle/flash/ring is a pooled Mesh that owns its own
//    MeshBasicMaterial. Pooled meshes live permanently under a single
//    container Group in the scene and are toggled via `visible`, so no
//    scene.add/remove churn per explosion.
//  - Point lights: a fixed pool of 2 PointLights added to the scene once
//    with intensity 0. Adding/removing lights forces every lit material to
//    re-evaluate (often recompile) its shader program in three r161, so the
//    light count must never change at runtime. An explosion borrows a
//    light if one is idle; otherwise it simply has no light.
//  - Explosion records and per-particle records are pooled as well.
// ============================================

import * as THREE from 'three';
import { DEMOLITION, COLORS } from '../../shared/constants.js';

// Pool warm-up sizes: sized for 2 concurrent goal explosions
// (1 flash + 50 sparks + 20 debris + 2 rings each) plus a couple of
// demolition explosions (1 flash + PARTICLE_COUNT debris each).
// Pools grow on demand if ever exhausted, so these only set the warm-up.
const FLASH_POOL_SIZE = 4;
const SPARK_POOL_SIZE = 100;
const DEBRIS_POOL_SIZE = 40 + DEMOLITION.PARTICLE_COUNT * 2;
const GOAL_RING_POOL_SIZE = 4;
const LANDING_RING_POOL_SIZE = 12;
const LIGHT_POOL_SIZE = 2;

// Reusable scratch colors (never retained)
const _tmpColor = new THREE.Color();
const _white = new THREE.Color(0xffffff);

export class ExplosionManager {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this._activeExplosions = [];
    this._activeLandingRings = [];

    // Shared geometries (reused across all explosions)
    this._sharedFlashGeo = new THREE.SphereGeometry(1, 12, 12);
    this._sharedDebrisGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    this._sharedSparkGeo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
    this._sharedRingGeo = new THREE.RingGeometry(0.8, 1.2, 24);      // landing rings
    this._sharedGoalRingGeo = new THREE.RingGeometry(0.5, 1.0, 32);  // goal shockwave rings

    // Container for all pooled meshes; lives in the scene permanently.
    this._fxRoot = new THREE.Group();
    this._fxRoot.name = 'ExplosionFX';
    this.scene.add(this._fxRoot);

    // Mesh pools: free-list stacks of pooled entries { mesh, vx, vy, vz, spin, isSpark }
    this._flashPool = this._createMeshPool(this._sharedFlashGeo, FLASH_POOL_SIZE, false);
    this._sparkPool = this._createMeshPool(this._sharedSparkGeo, SPARK_POOL_SIZE, false);
    this._debrisPool = this._createMeshPool(this._sharedDebrisGeo, DEBRIS_POOL_SIZE, false);
    this._goalRingPool = this._createMeshPool(this._sharedGoalRingGeo, GOAL_RING_POOL_SIZE, true);
    this._landingRingPool = this._createMeshPool(this._sharedRingGeo, LANDING_RING_POOL_SIZE, true);

    // Explosion record pool (free list)
    this._explosionRecordPool = [];
    // Landing ring record pool (free list)
    this._landingRecordPool = [];

    // Fixed light pool: created once, added to the scene once, never removed/hidden.
    this._lights = [];
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 30);
      light.name = 'ExplosionLight' + i;
      light.userData.busy = false;
      this.scene.add(light);
      this._lights.push(light);
    }
  }

  // ========== POOL HELPERS ==========

  _createMeshPool(geometry, size, doubleSide) {
    const pool = { geometry, doubleSide, free: [] };
    for (let i = 0; i < size; i++) {
      pool.free.push(this._createPoolEntry(pool));
    }
    return pool;
  }

  _createPoolEntry(pool) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      side: pool.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(pool.geometry, mat);
    mesh.visible = false;
    this._fxRoot.add(mesh);
    return { mesh, vx: 0, vy: 0, vz: 0, spin: 0, isSpark: false };
  }

  /**
   * Borrow a pooled mesh entry; resets transform, sets color/opacity, makes it visible.
   * Grows the pool if exhausted (rare; warm-up sizes cover normal play).
   * @param {number|THREE.Color} color
   */
  _acquire(pool, color, opacity) {
    const entry = pool.free.length > 0 ? pool.free.pop() : this._createPoolEntry(pool);
    const mesh = entry.mesh;
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.material.color.set(color);
    mesh.material.opacity = opacity;
    mesh.visible = true;
    entry.vx = 0; entry.vy = 0; entry.vz = 0; entry.spin = 0; entry.isSpark = false;
    return entry;
  }

  /** Return a pooled mesh entry to idle state. */
  _release(pool, entry) {
    entry.mesh.visible = false;
    entry.mesh.material.opacity = 0;
    pool.free.push(entry);
  }

  /** Borrow an idle pooled light, or null if both are busy. */
  _borrowLight(color, intensity, distance, x, y, z) {
    for (let i = 0; i < this._lights.length; i++) {
      const light = this._lights[i];
      if (light.userData.busy) continue;
      light.userData.busy = true;
      light.color.set(color);
      light.intensity = intensity;
      light.distance = distance;
      light.position.set(x, y, z);
      return light;
    }
    return null;
  }

  _releaseLight(light) {
    if (!light) return;
    light.intensity = 0;
    light.userData.busy = false;
  }

  _acquireExplosionRecord() {
    if (this._explosionRecordPool.length > 0) return this._explosionRecordPool.pop();
    return {
      x: 0, y: 0, z: 0,
      flash: null,
      light: null,
      lightIntensity: 0,
      particles: [],
      elapsed: 0,
      isGoal: false,
      ring: null,
      ring2: null,
    };
  }

  _releaseExplosionRecord(ex) {
    this._release(this._flashPool, ex.flash);
    ex.flash = null;
    for (let i = 0; i < ex.particles.length; i++) {
      const p = ex.particles[i];
      this._release(p.isSpark ? this._sparkPool : this._debrisPool, p);
    }
    ex.particles.length = 0;
    if (ex.ring) { this._release(this._goalRingPool, ex.ring); ex.ring = null; }
    if (ex.ring2) { this._release(this._goalRingPool, ex.ring2); ex.ring2 = null; }
    this._releaseLight(ex.light);
    ex.light = null;
    ex.isGoal = false;
    ex.elapsed = 0;
    this._explosionRecordPool.push(ex);
  }

  get activeExplosions() {
    return this._activeExplosions;
  }

  get activeLandingRings() {
    return this._activeLandingRings;
  }

  // ========== EXPLOSIONS ==========

  spawnExplosion(pos, color) {
    const ex = this._acquireExplosionRecord();
    ex.x = pos.x; ex.y = pos.y; ex.z = pos.z;
    ex.isGoal = false;
    ex.elapsed = 0;

    // Flash sphere
    ex.flash = this._acquire(this._flashPool, color, 1);
    ex.flash.mesh.position.set(ex.x, ex.y, ex.z);

    // Point light (borrowed from the fixed pool; may be null)
    ex.lightIntensity = 5;
    ex.light = this._borrowLight(color, 5, 30, ex.x, ex.y, ex.z);

    // Debris particles
    for (let i = 0; i < DEMOLITION.PARTICLE_COUNT; i++) {
      const p = this._acquire(this._debrisPool, color, 1);
      p.mesh.position.set(ex.x, ex.y, ex.z);
      p.vx = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      p.vy = Math.random() * DEMOLITION.PARTICLE_SPEED;
      p.vz = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      ex.particles.push(p);
    }

    this._activeExplosions.push(ex);
  }

  spawnGoalExplosion(pos, color) {
    const ex = this._acquireExplosionRecord();
    ex.x = pos.x; ex.y = pos.y; ex.z = pos.z;
    ex.isGoal = true;
    ex.elapsed = 0;

    // Core flash sphere
    ex.flash = this._acquire(this._flashPool, color, 1);
    ex.flash.mesh.position.set(ex.x, ex.y, ex.z);

    // Bright point light (borrowed from the fixed pool; may be null)
    ex.lightIntensity = 10;
    ex.light = this._borrowLight(color, 10, 80, ex.x, ex.y, ex.z);

    // Expanding shockwave ring (horizontal)
    ex.ring = this._acquire(this._goalRingPool, color, 0.9);
    ex.ring.mesh.position.set(ex.x, ex.y, ex.z);
    ex.ring.mesh.rotation.x = -Math.PI / 2;

    // Second ring (vertical)
    ex.ring2 = this._acquire(this._goalRingPool, color, 0.9);
    ex.ring2.mesh.position.set(ex.x, ex.y, ex.z);

    // Outer sparks -- fast, small, elongated
    for (let i = 0; i < 50; i++) {
      _tmpColor.set(color).lerp(_white, 0.4 + Math.random() * 0.4);
      const p = this._acquire(this._sparkPool, _tmpColor, 1);
      p.isSpark = true;
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const spd = 20 + Math.random() * 25;
      p.vx = Math.cos(theta) * Math.cos(phi) * spd;
      p.vy = Math.sin(phi) * spd * 0.6 + Math.random() * 8;
      p.vz = Math.sin(theta) * Math.cos(phi) * spd;
      // Orient along velocity (lookAt from origin, as before), then move to the origin point
      p.mesh.lookAt(p.vx, p.vy, p.vz);
      p.mesh.position.set(ex.x, ex.y, ex.z);
      ex.particles.push(p);
    }

    // Chunky debris -- slower, heavier
    for (let i = 0; i < 20; i++) {
      const p = this._acquire(this._debrisPool, color, 1);
      p.mesh.position.set(ex.x, ex.y, ex.z);
      p.mesh.scale.setScalar(0.5 + Math.random() * 1.5);
      p.vx = (Math.random() - 0.5) * 20;
      p.vy = 5 + Math.random() * 15;
      p.vz = (Math.random() - 0.5) * 20;
      p.spin = (Math.random() - 0.5) * 10;
      ex.particles.push(p);
    }

    this._activeExplosions.push(ex);
  }

  updateExplosions(dt) {
    for (let i = this._activeExplosions.length - 1; i >= 0; i--) {
      const ex = this._activeExplosions[i];
      ex.elapsed += dt;

      const duration = ex.isGoal ? 1.0 : DEMOLITION.EXPLOSION_DURATION;
      const lifetime = ex.isGoal ? 1.4 : DEMOLITION.PARTICLE_LIFETIME;

      // Flash: scale up and fade out
      const flashT = Math.min(ex.elapsed / duration, 1);
      const flashScale = ex.isGoal ? 2 + flashT * 18 : 1 + flashT * 8;
      ex.flash.mesh.scale.setScalar(flashScale);
      ex.flash.mesh.material.opacity = Math.max(0, 1 - flashT);
      if (ex.light) ex.light.intensity = Math.max(0, ex.lightIntensity * (1 - flashT));

      // Goal: expanding shockwave rings
      if (ex.isGoal && ex.ring) {
        const ringScale = 2 + flashT * 40;
        ex.ring.mesh.scale.setScalar(ringScale);
        ex.ring.mesh.material.opacity = Math.max(0, 0.9 * (1 - flashT));
        ex.ring2.mesh.scale.setScalar(ringScale * 0.8);
        ex.ring2.mesh.material.opacity = Math.max(0, 0.7 * (1 - flashT * 1.2));
      }

      // Particles: move + gravity + fade
      const particleT = Math.min(ex.elapsed / lifetime, 1);
      const particles = ex.particles;
      for (let j = 0; j < particles.length; j++) {
        const p = particles[j];
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vy -= 30 * dt;

        if (p.isSpark) {
          p.vx *= 0.97;
          p.vy *= 0.97;
          p.vz *= 0.97;
          p.mesh.material.opacity = Math.max(0, 1 - particleT * 1.3);
        } else {
          if (p.spin) p.mesh.rotation.x += p.spin * dt;
          p.mesh.material.opacity = Math.max(0, 1 - particleT);
        }
      }

      // Cleanup when done: everything goes back to its pool
      if (ex.elapsed >= lifetime) {
        this._releaseExplosionRecord(ex);
        this._activeExplosions.splice(i, 1);
      }
    }
  }

  // ========== LANDING RING VFX ==========

  checkLandingEffects(allCars) {
    for (const car of allCars) {
      if (!car || car.demolished) continue;
      if (car._justLanded && car._landingVelY < -6) {
        const pos = car.body.position;
        const impactStrength = Math.min(Math.abs(car._landingVelY) / 20, 1);
        this.spawnLandingRing(pos.x, pos.z, impactStrength, car.color || COLORS.CYAN);
        car._justLanded = false;
      }
    }
  }

  spawnLandingRing(x, z, strength, color) {
    const startOpacity = 0.6 * strength;
    const entry = this._acquire(this._landingRingPool, color, startOpacity);
    entry.mesh.rotation.x = -Math.PI / 2;
    entry.mesh.position.set(x, 0.08, z);

    const r = this._landingRecordPool.length > 0
      ? this._landingRecordPool.pop()
      : { entry: null, mesh: null, elapsed: 0, duration: 0.3, maxScale: 0, startOpacity: 0 };
    r.entry = entry;
    r.mesh = entry.mesh;
    r.elapsed = 0;
    r.duration = 0.3;
    r.maxScale = 2 + strength * 4;
    r.startOpacity = startOpacity;
    this._activeLandingRings.push(r);
  }

  updateLandingRings(dt) {
    for (let i = this._activeLandingRings.length - 1; i >= 0; i--) {
      const r = this._activeLandingRings[i];
      r.elapsed += dt;
      const t = Math.min(r.elapsed / r.duration, 1);
      const scale = 1 + t * r.maxScale;
      r.mesh.scale.setScalar(scale);
      r.mesh.material.opacity = r.startOpacity * (1 - t);

      if (t >= 1) {
        this._release(this._landingRingPool, r.entry);
        r.entry = null;
        r.mesh = null;
        this._landingRecordPool.push(r);
        this._activeLandingRings.splice(i, 1);
      }
    }
  }

  /**
   * Clear all active effects and tear down pooled resources (used on destroy).
   * Removes the pooled meshes and lights from the scene and disposes the
   * shared geometries and pooled materials. The manager is not usable afterwards.
   */
  clear() {
    // Return every active effect to idle
    for (let i = this._activeExplosions.length - 1; i >= 0; i--) {
      this._releaseExplosionRecord(this._activeExplosions[i]);
    }
    this._activeExplosions.length = 0;
    for (let i = this._activeLandingRings.length - 1; i >= 0; i--) {
      const r = this._activeLandingRings[i];
      this._release(this._landingRingPool, r.entry);
      r.entry = null;
      r.mesh = null;
    }
    this._activeLandingRings.length = 0;
    for (const light of this._lights) this._releaseLight(light);

    // Tear down pooled GPU resources (safe to double-dispose)
    const pools = [this._flashPool, this._sparkPool, this._debrisPool, this._goalRingPool, this._landingRingPool];
    for (const pool of pools) {
      for (const entry of pool.free) entry.mesh.material.dispose();
      pool.free.length = 0;
    }
    this._sharedFlashGeo.dispose();
    this._sharedDebrisGeo.dispose();
    this._sharedSparkGeo.dispose();
    this._sharedRingGeo.dispose();
    this._sharedGoalRingGeo.dispose();

    if (this.scene) {
      this.scene.remove(this._fxRoot);
      for (const light of this._lights) this.scene.remove(light);
    }
    this._fxRoot.clear();
  }
}
