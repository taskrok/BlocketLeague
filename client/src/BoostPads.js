// ============================================
// Boost Pads - Collectible boost pickups
// ============================================

import * as THREE from 'three';
import { ARENA, BOOST_PAD, BOOST_PAD_LAYOUT, COLORS } from '../../shared/constants.js';

export class BoostPads {
  constructor(scene) {
    this.scene = scene;
    this.pads = [];

    this._createPads();
  }

  _createPads() {
    // Large boost pads
    BOOST_PAD_LAYOUT.large.forEach((pos) => {
      const worldPos = {
        x: pos.x * ARENA.WIDTH / 2,
        z: pos.z * ARENA.LENGTH / 2,
      };
      this._createPad(worldPos, true);
    });

    // Small boost pads
    BOOST_PAD_LAYOUT.small.forEach((pos) => {
      const worldPos = {
        x: pos.x * ARENA.WIDTH / 2,
        z: pos.z * ARENA.LENGTH / 2,
      };
      this._createPad(worldPos, false);
    });
  }

  _createPad(position, isLarge) {
    const radius = isLarge ? BOOST_PAD.LARGE_RADIUS : BOOST_PAD.SMALL_RADIUS;
    const height = isLarge ? BOOST_PAD.LARGE_HEIGHT : BOOST_PAD.SMALL_HEIGHT;
    const color = isLarge ? COLORS.ORANGE : COLORS.YELLOW;

    const group = new THREE.Group();
    group.position.set(position.x, 0, position.z);

    // Base glow circle on ground
    const baseGeo = new THREE.CircleGeometry(radius, isLarge ? 6 : 16);
    const baseMat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.03;
    group.add(base);

    if (isLarge) {
      // Large pad: floating orb
      const orbGeo = new THREE.OctahedronGeometry(0.8, 0);
      const orbMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 2.0,
        transparent: true,
        opacity: 0.8,
      });
      const orb = new THREE.Mesh(orbGeo, orbMat);
      orb.position.y = height;
      group.add(orb);

      // Light
      const light = new THREE.PointLight(color, 0.6, 8);
      light.position.y = height;
      group.add(light);
    } else {
      // Small pad: small glowing pill
      const pillGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 6);
      const pillMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.7,
      });
      const pill = new THREE.Mesh(pillGeo, pillMat);
      pill.position.y = height;
      group.add(pill);
    }

    this.scene.add(group);

    this.pads.push({
      mesh: group,
      position: new THREE.Vector3(position.x, 0, position.z),
      isLarge: isLarge,
      radius: radius,
      amount: isLarge ? BOOST_PAD.LARGE_AMOUNT : BOOST_PAD.SMALL_AMOUNT,
      respawnTime: isLarge ? BOOST_PAD.LARGE_RESPAWN_TIME : BOOST_PAD.SMALL_RESPAWN_TIME,
      active: true,
      respawnTimer: 0,
    });
  }

  update(dt, cars) {
    const time = performance.now() * 0.001;

    this.pads.forEach((pad) => {
      if (!pad.active) {
        // Respawn timer
        pad.respawnTimer -= dt;
        if (pad.respawnTimer <= 0) {
          pad.active = true;
          pad.mesh.visible = true;
        }
        return;
      }

      // Animate active pads
      const floatingObj = pad.mesh.children[1]; // orb or pill
      if (floatingObj) {
        floatingObj.rotation.y = time * 2;
        floatingObj.position.y = (pad.isLarge ? BOOST_PAD.LARGE_HEIGHT : BOOST_PAD.SMALL_HEIGHT) +
          Math.sin(time * 3) * 0.2;
      }

      // Check car collisions
      cars.forEach((car) => {
        if (!pad.active) return;
        const carPos = car.getPosition();
        const dx = carPos.x - pad.position.x;
        const dz = carPos.z - pad.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < pad.radius + 1.5) {
          // Only pick up if not full (or if large and not at max)
          if (car.boost < 100 || pad.isLarge) {
            car.addBoost(pad.amount);
            pad.active = false;
            pad.mesh.visible = false;
            pad.respawnTimer = pad.respawnTime;
          }
        }
      });
    });
  }
}
