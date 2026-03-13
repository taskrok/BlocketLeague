// ============================================
// Camera Controller - Follow cam with ball-cam toggle
// ============================================

import * as THREE from 'three';

// Reusable temp objects to avoid per-frame allocations
const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _backward = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();
const _ballPos = new THREE.Vector3();
const _carToBall = new THREE.Vector3();
const _ballCamPos = new THREE.Vector3();

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.target = null;     // car to follow
    this.ballTarget = null; // ball to look at

    // Camera settings
    this.distance = 10;
    this.height = 4;
    this.lookHeight = 2;
    this.smoothSpeed = 5;
    this.ballCamSmooth = 3;

    // State
    this.ballCam = true;
    this.currentPos = new THREE.Vector3();
    this.currentLookAt = new THREE.Vector3();
    this.initialized = false;

    // Camera swivel (right stick / J,L keys)
    this.maxSwivel = Math.PI * 0.8; // ~144° max rotation
    this._swivelAngle = 0;          // current smoothed swivel angle

    // Camera shake system
    this._shakes = [];              // active shake instances
    this._shakeOffset = new THREE.Vector3();
  }

  setTarget(car) {
    this.target = car;
  }

  setBallTarget(ball) {
    this.ballTarget = ball;
  }

  resetSmoothing() {
    this.initialized = false;
  }

  getSettings() {
    return {
      fov: this.camera.fov,
      distance: this.distance,
      height: this.height,
      smoothness: this.smoothSpeed,
    };
  }

  setSettings(settings) {
    if (settings.fov !== undefined) {
      this.camera.fov = settings.fov;
      this.camera.updateProjectionMatrix();
    }
    if (settings.distance !== undefined) this.distance = settings.distance;
    if (settings.height !== undefined) this.height = settings.height;
    if (settings.smoothness !== undefined) this.smoothSpeed = settings.smoothness;
  }

  // --- Camera Shake System ---

  /**
   * Add a shake with given intensity and duration.
   * Multiple shakes stack additively.
   */
  shake(intensity, duration) {
    this._shakes.push({
      intensity,
      duration,
      elapsed: 0,
      frequency: 25 + Math.random() * 10,  // slightly randomized for organic feel
      decay: 5 / duration,                  // decay constant scaled to duration
      // random axis bias so shakes feel different each time
      axisX: 0.5 + Math.random() * 0.5,
      axisY: 0.8 + Math.random() * 0.4,
      axisZ: 0.3 + Math.random() * 0.3,
    });
  }

  /** Heavy shake for goal events */
  shakeGoal() {
    this.shake(0.8, 0.6);
  }

  /** Medium shake for demolition */
  shakeDemolition() {
    this.shake(0.4, 0.3);
  }

  /** Light shake scaled with ball hit speed */
  shakeHit(speed) {
    const t = Math.min(speed / 60, 1); // normalize speed
    const intensity = 0.1 + t * 0.2;   // 0.1 to 0.3
    this.shake(intensity, 0.15);
  }

  /** Compute combined shake offset from all active shakes */
  _updateShake(dt) {
    this._shakeOffset.set(0, 0, 0);
    for (let i = this._shakes.length - 1; i >= 0; i--) {
      const s = this._shakes[i];
      s.elapsed += dt;
      if (s.elapsed >= s.duration) {
        this._shakes.splice(i, 1);
        continue;
      }
      const amp = s.intensity * Math.sin(s.elapsed * s.frequency) * Math.exp(-s.decay * s.elapsed);
      this._shakeOffset.x += amp * s.axisX;
      this._shakeOffset.y += amp * s.axisY;
      this._shakeOffset.z += amp * s.axisZ;
    }
  }

  update(dt, ballCamEnabled, lookX = 0) {
    if (!this.target) return;

    // When demolished, orbit the ball instead of following the car underground
    if (this.target.demolished && this.ballTarget) {
      this._updateDemolishedCam(dt);
      return;
    }

    this.ballCam = ballCamEnabled;

    // Smooth the swivel angle for analog feel
    const targetSwivel = lookX * this.maxSwivel;
    const swivelSmooth = 1 - Math.exp(-12 * dt);
    this._swivelAngle += (targetSwivel - this._swivelAngle) * swivelSmooth;
    // Snap to zero when close to avoid drift
    if (Math.abs(this._swivelAngle) < 0.005 && lookX === 0) this._swivelAngle = 0;

    const isSwiveling = Math.abs(this._swivelAngle) > 0.01;

    _carPos.copy(this.target.body.position);
    _carQuat.copy(this.target.body.quaternion);

    // Determine "behind" direction for camera placement.
    // When airborne, use velocity (trajectory) direction so air rolls/pitch
    // don't spin the camera. On ground, use car's facing direction.
    const vel = this.target.body.velocity;
    const hSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const isAirborne = !this.target.isGrounded && hSpeed > 3;

    if (isAirborne) {
      // Use velocity direction projected onto ground plane
      _backward.set(-vel.x / hSpeed, 0, -vel.z / hSpeed);
    } else {
      // Use car's forward from quaternion, projected onto ground plane
      _backward.set(0, 0, 1);
      _backward.applyQuaternion(_carQuat);
      const hLen = Math.sqrt(_backward.x * _backward.x + _backward.z * _backward.z);
      if (hLen > 0.01) {
        _backward.set(-_backward.x / hLen, 0, -_backward.z / hLen);
      } else {
        _backward.set(-1, 0, 0).applyQuaternion(_carQuat);
        const fLen = Math.sqrt(_backward.x * _backward.x + _backward.z * _backward.z);
        if (fLen > 0.001) {
          _backward.set(_backward.x / fLen, 0, _backward.z / fLen);
        } else {
          _backward.set(0, 0, -1);
        }
      }
    }

    // Apply swivel: rotate the backward vector around Y axis
    if (isSwiveling) {
      const cos = Math.cos(this._swivelAngle);
      const sin = Math.sin(this._swivelAngle);
      const bx = _backward.x * cos - _backward.z * sin;
      const bz = _backward.x * sin + _backward.z * cos;
      _backward.x = bx;
      _backward.z = bz;
    }

    // Desired camera position: behind and above car
    _desiredPos.set(
      _carPos.x + _backward.x * this.distance,
      _carPos.y + this.height,
      _carPos.z + _backward.z * this.distance
    );

    if (isSwiveling) {
      // While swiveling, look past the car in the swivel direction
      _desiredLookAt.set(
        _carPos.x - _backward.x * 5,
        _carPos.y + this.lookHeight,
        _carPos.z - _backward.z * 5
      );
    } else if (this.ballCam && this.ballTarget) {
      _ballPos.copy(this.ballTarget.body.position);

      // Ball cam: camera on the far side of the car from the ball,
      // looking at the ball. Car stays visible between camera and ball.
      _carToBall.subVectors(_ballPos, _carPos);
      _carToBall.y = 0;
      const ballDist = _carToBall.length();
      if (ballDist > 0.01) {
        _carToBall.x /= ballDist;
        _carToBall.z /= ballDist;
      }

      // Position camera directly opposite the ball from the car.
      // When the ball is high, pull the camera back further and raise it
      // so the car stays in frame.
      const ballHeight = Math.max(_ballPos.y - _carPos.y, 0);
      const extraDist = Math.min(ballHeight * 0.3, 6);   // pull back up to 6 extra
      const extraHeight = Math.min(ballHeight * 0.25, 5); // raise up to 5 extra
      _desiredPos.set(
        _carPos.x - _carToBall.x * (this.distance + extraDist),
        _carPos.y + this.height + extraHeight,
        _carPos.z - _carToBall.z * (this.distance + extraDist)
      );

      // Look toward the ball but cap lookAt height so the car stays visible.
      // Max lookAt height = car Y + 12 — beyond that the ball indicator arrow
      // guides the player.
      const maxLookY = _carPos.y + 12;
      _desiredLookAt.set(
        _ballPos.x,
        Math.min(Math.max(_ballPos.y, 0) + 0.5, maxLookY),
        _ballPos.z
      );
    } else {
      _desiredLookAt.set(
        _carPos.x - _backward.x * 5,
        _carPos.y + this.lookHeight,
        _carPos.z - _backward.z * 5
      );
    }

    // Smooth interpolation
    if (!this.initialized) {
      this.currentPos.copy(_desiredPos);
      this.currentLookAt.copy(_desiredLookAt);
      this.initialized = true;
    }

    // Use faster lerp when swiveling for responsive feel
    const speed = isSwiveling ? Math.max(this.smoothSpeed, 10) : this.smoothSpeed;
    const lerpFactor = 1 - Math.exp(-speed * dt);
    this.currentPos.lerp(_desiredPos, lerpFactor);
    this.currentLookAt.lerp(_desiredLookAt, lerpFactor);

    // Keep camera above ground
    this.currentPos.y = Math.max(1, this.currentPos.y);

    // Apply shake offset
    this._updateShake(dt);

    // Apply
    this.camera.position.copy(this.currentPos);
    this.camera.position.add(this._shakeOffset);
    this.camera.lookAt(this.currentLookAt);
  }

  // Follow the ball from a fixed-ish elevated angle while demolished
  _updateDemolishedCam(dt) {
    _ballPos.copy(this.ballTarget.body.position);

    // Position: hold current XZ angle relative to ball, elevated view
    _desiredPos.set(
      _ballPos.x + (this.currentPos.x - _ballPos.x) * 0.3 + 0.01,
      Math.max(_ballPos.y + 12, 14),
      _ballPos.z + (this.currentPos.z - _ballPos.z) * 0.3 + 0.01
    );

    // Ensure minimum distance from ball so we don't sit right on top
    const dx = _desiredPos.x - _ballPos.x;
    const dz = _desiredPos.z - _ballPos.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);
    if (hDist < 15) {
      const scale = 15 / Math.max(hDist, 0.1);
      _desiredPos.x = _ballPos.x + dx * scale;
      _desiredPos.z = _ballPos.z + dz * scale;
    }

    _desiredLookAt.set(_ballPos.x, _ballPos.y + 1, _ballPos.z);

    const lerpFactor = 1 - Math.exp(-3 * dt);
    this.currentPos.lerp(_desiredPos, lerpFactor);
    this.currentLookAt.lerp(_desiredLookAt, lerpFactor);

    this.currentPos.y = Math.max(2, this.currentPos.y);

    this.camera.position.copy(this.currentPos);
    this.camera.position.add(this._shakeOffset);
    this.camera.lookAt(this.currentLookAt);
  }
}
