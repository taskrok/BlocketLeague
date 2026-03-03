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
    // Sync mesh to physics
    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);

    // Update light intensity based on speed
    const speed = this.body.velocity.length();
    this.light.intensity = 0.8 + Math.min(speed * 0.05, 1.5);

    // Emissive intensity based on speed
    const intensity = 0.3 + Math.min(speed * 0.02, 0.8);
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
  }

  getPosition() {
    return this.body.position;
  }

  getSpeed() {
    return this.body.velocity.length();
  }
}
