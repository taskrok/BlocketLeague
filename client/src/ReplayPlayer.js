// ============================================
// ReplayPlayer - Playback engine for goal replays
// Drives meshes directly from recorded frames (physics paused)
// ============================================

import * as THREE from 'three';
import { BALL } from '../../shared/constants.js';

const PLAYBACK_SPEED = 0.75;  // 0.75x speed → 5s gameplay ≈ 6.7s replay
const ORBIT_SPEED = 0.4;      // radians per second
const ORBIT_RADIUS = 20;
const ORBIT_HEIGHT = 8;

// Reusable temp objects
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _rollAxis = new THREE.Vector3();
const _deltaQuat = new THREE.Quaternion();

export class ReplayPlayer {
  constructor() {
    this._frames = null;
    this._cursor = 0;       // float frame index
    this._playing = false;
    this._orbitAngle = 0;
    this._ballSpinQuat = new THREE.Quaternion();
    this._done = false;
  }

  get isPlaying() {
    return this._playing;
  }

  get isDone() {
    return this._done;
  }

  /**
   * Start playback.
   * @param {object[]} frames - array of recorded frames (chronological)
   */
  start(frames) {
    this._frames = frames;
    this._cursor = 0;
    this._prevFrame = -1;
    this._orbitAngle = 0;
    this._playing = true;
    this._done = false;
    this._ballSpinQuat.identity();
  }

  /**
   * Advance playback by dt seconds.
   * Drives ball mesh, car meshes, boost pads, and camera.
   * @returns {boolean} true if still playing, false if finished
   */
  update(dt, ball, cars, boostPads, camera) {
    if (!this._playing || !this._frames) return false;

    const totalFrames = this._frames.length;
    const lastIdx = totalFrames - 1;

    // Advance cursor at playback speed (each frame = 1/60s of game time)
    this._prevFrame = Math.floor(this._cursor);
    this._cursor += dt * 60 * PLAYBACK_SPEED;

    if (this._cursor >= lastIdx) {
      this._cursor = lastIdx;
      this._playing = false;
      this._done = true;
    }

    // Interpolate between two surrounding frames
    const frameA = Math.floor(this._cursor);
    const frameB = Math.min(frameA + 1, lastIdx);
    const t = this._cursor - frameA;

    const fA = this._frames[frameA];
    const fB = this._frames[frameB];

    // --- Ball ---
    this._interpolateBall(fA, fB, t, ball, dt);

    // --- Cars ---
    this._interpolateCars(fA, fB, t, cars);

    // --- Boost pads ---
    this._applyBoostPads(fA, boostPads);

    // --- Cinematic camera ---
    this._updateCamera(dt, ball, camera);

    return !this._done;
  }

  skip() {
    this._playing = false;
    this._done = true;
  }

  get frames() { return this._frames; }
  get lastFrameIndex() { return Math.floor(this._cursor); }
  get prevFrameIndex() { return this._prevFrame; }

  _interpolateBall(fA, fB, t, ball, dt) {
    const a = fA.ball;
    const b = fB.ball;

    // Lerp position
    ball.body.position.x = a.px + (b.px - a.px) * t;
    ball.body.position.y = a.py + (b.py - a.py) * t;
    ball.body.position.z = a.pz + (b.pz - a.pz) * t;

    // Lerp velocity (for visual spin computation)
    const vx = a.vx + (b.vx - a.vx) * t;
    const vy = a.vy + (b.vy - a.vy) * t;
    const vz = a.vz + (b.vz - a.vz) * t;
    ball.body.velocity.x = vx;
    ball.body.velocity.y = vy;
    ball.body.velocity.z = vz;

    // Sync mesh position
    ball.mesh.position.copy(ball.body.position);

    // Reconstruct ball spin from velocity (same formula as Ball.update)
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > 0.5) {
      _rollAxis.set(vz, 0, -vx).normalize();
      if (_rollAxis.lengthSq() > 0.001) {
        const angularSpeed = speed / BALL.RADIUS;
        // Scale dt by playback speed for correct visual spin rate
        _deltaQuat.setFromAxisAngle(_rollAxis, angularSpeed * dt * PLAYBACK_SPEED);
        this._ballSpinQuat.premultiply(_deltaQuat);
        this._ballSpinQuat.normalize();
      }
    }
    ball.mesh.quaternion.copy(this._ballSpinQuat);

    // Update shadow indicator
    if (ball.shadowIndicator) {
      ball.shadowIndicator.position.set(
        ball.body.position.x,
        0.05,
        ball.body.position.z
      );
      const height = ball.body.position.y;
      ball.shadowMat.opacity = Math.max(0, 0.4 - height * 0.015);
    }

    // Update light intensity
    if (ball.light) {
      ball.light.intensity = 0.8 + Math.min(speed * 0.05, 1.5);
    }
    if (ball.sphere) {
      ball.sphere.material.emissiveIntensity = 0.3 + Math.min(speed * 0.02, 0.8);
    }
  }

  _interpolateCars(fA, fB, t, cars) {
    const carsA = fA.cars;
    const carsB = fB.cars;
    if (!carsA) return;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;

      const a = carsA[i];
      const b = carsB ? carsB[i] : a;
      if (!a) continue;

      // Handle demolished visibility
      car.mesh.visible = !a.demolished;
      if (a.demolished) continue;

      // Lerp position
      car.body.position.x = a.px + ((b ? b.px : a.px) - a.px) * t;
      car.body.position.y = a.py + ((b ? b.py : a.py) - a.py) * t;
      car.body.position.z = a.pz + ((b ? b.pz : a.pz) - a.pz) * t;

      // Slerp quaternion
      _q1.set(a.qx, a.qy, a.qz, a.qw);
      if (b) {
        _q2.set(b.qx, b.qy, b.qz, b.qw);
        _q1.slerp(_q2, t);
      }
      car.body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);

      // Sync mesh
      car._syncMesh();

      // Show boost flame if car was boosting in this frame
      if (car.boostFlame) {
        const wasBoosting = a.boosting || false;
        car.boostFlame.visible = wasBoosting;
        if (wasBoosting) {
          car.boostFlame.children.forEach((child) => {
            if (child.isMesh) {
              child.scale.setScalar(0.8 + Math.random() * 0.5);
              child.material.opacity = 0.5 + Math.random() * 0.5;
            }
          });
          if (car.flameLight) car.flameLight.intensity = 1 + Math.random() * 1.5;
          if (car.bottomLight) car.bottomLight.intensity = 2.0;
        } else {
          if (car.bottomLight) car.bottomLight.intensity = 1.0;
        }
      }
    }
  }

  _applyBoostPads(frame, boostPads) {
    if (!boostPads || !frame.boostPadMask) return;
    const mask = frame.boostPadMask;
    const pads = boostPads.pads;

    for (let i = 0; i < pads.length; i++) {
      const active = !!((mask[i >> 3] || 0) & (1 << (i & 7)));
      pads[i].active = active;
      pads[i].mesh.visible = active;
    }
  }

  _updateCamera(dt, ball, camera) {
    this._orbitAngle += ORBIT_SPEED * dt;

    const bx = ball.body.position.x;
    const by = ball.body.position.y;
    const bz = ball.body.position.z;

    // Orbit around ball
    const cx = bx + Math.cos(this._orbitAngle) * ORBIT_RADIUS;
    const cy = Math.max(by + ORBIT_HEIGHT, ORBIT_HEIGHT);
    const cz = bz + Math.sin(this._orbitAngle) * ORBIT_RADIUS;

    // Smooth camera movement
    const lerpFactor = 1 - Math.exp(-3 * dt);
    camera.position.x += (cx - camera.position.x) * lerpFactor;
    camera.position.y += (cy - camera.position.y) * lerpFactor;
    camera.position.z += (cz - camera.position.z) * lerpFactor;

    // Look at ball
    _v1.set(bx, by + 1, bz);
    camera.lookAt(_v1);
  }
}
