// ============================================
// ExplosionManager - Explosion/VFX and landing ring effects
// Extracted from Game.js with material pooling optimization
// ============================================

import * as THREE from 'three';
import { DEMOLITION, COLORS } from '../../shared/constants.js';

// Material pool size for particle reuse
const MATERIAL_POOL_SIZE = 30;

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
    this._sharedRingGeo = new THREE.RingGeometry(0.8, 1.2, 24);

    // Material pool: reusable MeshBasicMaterial instances to avoid per-particle allocation
    this._materialPool = [];
    this._materialPoolIndex = 0;
    for (let i = 0; i < MATERIAL_POOL_SIZE; i++) {
      this._materialPool.push(new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
      }));
    }
  }

  /** Borrow a material from the pool, setting color and opacity. */
  _borrowMaterial(color, opacity = 1) {
    const mat = this._materialPool[this._materialPoolIndex];
    this._materialPoolIndex = (this._materialPoolIndex + 1) % MATERIAL_POOL_SIZE;
    mat.color.set(color);
    mat.opacity = opacity;
    mat.visible = true;
    return mat;
  }

  /** Return a material to idle state (no disposal needed since pool owns them). */
  _releaseMaterial(mat) {
    mat.opacity = 0;
    mat.visible = false;
  }

  get activeExplosions() {
    return this._activeExplosions;
  }

  get activeLandingRings() {
    return this._activeLandingRings;
  }

  spawnExplosion(pos, color) {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);

    // Flash sphere
    const flashMat = this._borrowMaterial(color, 1);
    const flash = new THREE.Mesh(this._sharedFlashGeo, flashMat);
    group.add(flash);

    // Point light
    const light = new THREE.PointLight(color, 5, 30);
    group.add(light);

    // Debris particles
    const particles = [];
    for (let i = 0; i < DEMOLITION.PARTICLE_COUNT; i++) {
      const mat = this._borrowMaterial(color, 1);
      const p = new THREE.Mesh(this._sharedDebrisGeo, mat);
      p.position.set(0, 0, 0);
      const vx = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      const vy = Math.random() * DEMOLITION.PARTICLE_SPEED;
      const vz = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz });
    }

    this.scene.add(group);
    this._activeExplosions.push({
      group,
      flash,
      flashMat,
      light,
      particles,
      elapsed: 0,
    });
  }

  spawnGoalExplosion(pos, color) {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);
    const c = new THREE.Color(color);

    // Core flash sphere
    const flashMat = this._borrowMaterial(color, 1);
    const flash = new THREE.Mesh(this._sharedFlashGeo, flashMat);
    group.add(flash);

    // Bright point light
    const light = new THREE.PointLight(color, 10, 80);
    group.add(light);

    // Expanding shockwave ring (horizontal)
    const ringGeo = new THREE.RingGeometry(0.5, 1.0, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // Second ring (vertical)
    const ring2Mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    });
    const ring2 = new THREE.Mesh(ringGeo, ring2Mat);
    group.add(ring2);

    const particles = [];

    // Outer sparks -- fast, small, elongated
    for (let i = 0; i < 50; i++) {
      const bright = c.clone().lerp(new THREE.Color(0xffffff), 0.4 + Math.random() * 0.4);
      const mat = this._borrowMaterial(bright, 1);
      const p = new THREE.Mesh(this._sharedSparkGeo, mat);
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const spd = 20 + Math.random() * 25;
      const vx = Math.cos(theta) * Math.cos(phi) * spd;
      const vy = Math.sin(phi) * spd * 0.6 + Math.random() * 8;
      const vz = Math.sin(theta) * Math.cos(phi) * spd;
      p.lookAt(vx, vy, vz);
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz, isSpark: true });
    }

    // Chunky debris -- slower, heavier
    for (let i = 0; i < 20; i++) {
      const mat = this._borrowMaterial(color, 1);
      const p = new THREE.Mesh(this._sharedDebrisGeo, mat);
      const scale = 0.5 + Math.random() * 1.5;
      p.scale.setScalar(scale);
      const vx = (Math.random() - 0.5) * 20;
      const vy = 5 + Math.random() * 15;
      const vz = (Math.random() - 0.5) * 20;
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz, spin: (Math.random() - 0.5) * 10 });
    }

    this.scene.add(group);
    this._activeExplosions.push({
      group, flash, flashMat, light, particles, elapsed: 0,
      isGoal: true, ring, ringMat, ring2, ring2Mat,
    });
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
      ex.flash.scale.setScalar(flashScale);
      ex.flash.material.opacity = Math.max(0, 1 - flashT);
      ex.light.intensity = Math.max(0, (ex.isGoal ? 10 : 5) * (1 - flashT));

      // Goal: expanding shockwave rings
      if (ex.isGoal && ex.ring) {
        const ringScale = 2 + flashT * 40;
        ex.ring.scale.setScalar(ringScale);
        ex.ring.material.opacity = Math.max(0, 0.9 * (1 - flashT));
        ex.ring2.scale.setScalar(ringScale * 0.8);
        ex.ring2.material.opacity = Math.max(0, 0.7 * (1 - flashT * 1.2));
      }

      // Particles: move + gravity + fade
      const particleT = Math.min(ex.elapsed / lifetime, 1);
      for (const p of ex.particles) {
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

      // Cleanup when done
      if (ex.elapsed >= lifetime) {
        this.scene.remove(ex.group);
        // Release pooled materials back
        this._releaseMaterial(ex.flashMat);
        for (const p of ex.particles) {
          this._releaseMaterial(p.mesh.material);
        }
        // Goal ring materials are not pooled (created fresh for rings)
        if (ex.ringMat) ex.ringMat.dispose();
        if (ex.ring2Mat) ex.ring2Mat.dispose();
        ex.light.dispose();
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
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.6 * strength,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(this._sharedRingGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.08, z);
    this.scene.add(ring);

    this._activeLandingRings.push({
      mesh: ring,
      elapsed: 0,
      duration: 0.3,
      maxScale: 2 + strength * 4,
      startOpacity: mat.opacity,
    });
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
        this.scene.remove(r.mesh);
        r.mesh.material.dispose();
        this._activeLandingRings.splice(i, 1);
      }
    }
  }

  /** Clear all active effects (used on destroy). */
  clear() {
    this._activeExplosions = [];
    this._activeLandingRings = [];
  }
}
