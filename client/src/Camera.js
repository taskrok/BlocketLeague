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
  }

  setTarget(car) {
    this.target = car;
  }

  setBallTarget(ball) {
    this.ballTarget = ball;
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

  update(dt, ballCamEnabled, lookX = 0) {
    if (!this.target) return;

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

    // Get car's backward direction (camera goes behind car)
    _backward.set(0, 0, -1);
    _backward.applyQuaternion(_carQuat);
    _backward.y = 0;
    _backward.normalize();

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

      // In ball cam, position camera so car is between camera and ball
      _carToBall.subVectors(_ballPos, _carPos);
      _carToBall.y = 0;
      _carToBall.normalize();

      _ballCamPos.set(
        _carPos.x - _carToBall.x * this.distance,
        _carPos.y + this.height,
        _carPos.z - _carToBall.z * this.distance
      );

      _desiredPos.lerp(_ballCamPos, 0.7);
      _desiredLookAt.set(
        _ballPos.x * 0.4 + _carPos.x * 0.6,
        _ballPos.y * 0.3 + this.lookHeight * 0.7,
        _ballPos.z * 0.4 + _carPos.z * 0.6
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

    // Apply
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}
