// ============================================
// Camera Controller - Follow cam with ball-cam toggle
// ============================================

import * as THREE from 'three';

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

  update(dt, ballCamEnabled) {
    if (!this.target) return;

    this.ballCam = ballCamEnabled;

    const carPos = new THREE.Vector3().copy(this.target.body.position);
    const carQuat = new THREE.Quaternion().copy(this.target.body.quaternion);

    // Get car's backward direction (camera goes behind car)
    const backward = new THREE.Vector3(0, 0, -1);
    backward.applyQuaternion(carQuat);
    backward.y = 0;
    backward.normalize();

    // Desired camera position: behind and above car
    const desiredPos = new THREE.Vector3(
      carPos.x + backward.x * this.distance,
      carPos.y + this.height,
      carPos.z + backward.z * this.distance
    );

    // Where camera should look
    let desiredLookAt;

    if (this.ballCam && this.ballTarget) {
      const ballPos = new THREE.Vector3().copy(this.ballTarget.body.position);

      // In ball cam, position camera so car is between camera and ball
      const carToBall = new THREE.Vector3().subVectors(ballPos, carPos);
      carToBall.y = 0;
      carToBall.normalize();

      const ballCamPos = new THREE.Vector3(
        carPos.x - carToBall.x * this.distance,
        carPos.y + this.height,
        carPos.z - carToBall.z * this.distance
      );

      desiredPos.lerp(ballCamPos, 0.7);
      desiredLookAt = new THREE.Vector3(
        ballPos.x * 0.4 + carPos.x * 0.6,
        ballPos.y * 0.3 + this.lookHeight * 0.7,
        ballPos.z * 0.4 + carPos.z * 0.6
      );
    } else {
      desiredLookAt = new THREE.Vector3(
        carPos.x - backward.x * 5,
        carPos.y + this.lookHeight,
        carPos.z - backward.z * 5
      );
    }

    // Smooth interpolation
    if (!this.initialized) {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLookAt);
      this.initialized = true;
    }

    const lerpFactor = 1 - Math.exp(-this.smoothSpeed * dt);
    this.currentPos.lerp(desiredPos, lerpFactor);
    this.currentLookAt.lerp(desiredLookAt, lerpFactor);

    // Keep camera above ground
    this.currentPos.y = Math.max(1, this.currentPos.y);

    // Apply
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}
