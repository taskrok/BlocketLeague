// ============================================
// Ball - Physics + Rendering for the game ball
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BALL, COLORS, COLLISION_GROUPS } from '../../shared/constants.js';

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

    // Inner glow light
    this.light = new THREE.PointLight(COLORS.BALL, 1.0, 20);
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

    // Update light intensity based on speed
    this.light.intensity = 0.8 + Math.min(curSpeed * 0.05, 1.5);

    // Emissive intensity based on speed
    const intensity = 0.3 + Math.min(curSpeed * 0.02, 0.8);
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
    this._spinQuat.identity();
  }

  getPosition() {
    return this.body.position;
  }

  getSpeed() {
    return this.body.velocity.length();
  }
}
