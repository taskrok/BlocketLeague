// ============================================
// Boost Pads - Collectible boost pickups
// ============================================

import * as THREE from 'three';
import { ARENA, BOOST_PAD, BOOST_PAD_LAYOUT, COLORS } from '../../shared/constants.js';
import { audioManager } from './AudioManager.js';

export class BoostPads {
  constructor(scene, isRemote = false) {
    this.scene = scene;
    this.isRemote = isRemote;
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
    const hitboxRadius = isLarge ? BOOST_PAD.LARGE_RADIUS : BOOST_PAD.SMALL_RADIUS;
    // Visual radius is smaller than hitbox — hitbox radii are RL-accurate pickup zones
    const visualRadius = isLarge ? 2.5 : 1.2;
    const color = isLarge ? COLORS.ORANGE : COLORS.YELLOW;

    const group = new THREE.Group();
    group.position.set(position.x, 0, position.z);

    if (isLarge) {
      // Large pad: prominent hexagonal base + large floating sphere
      const baseGeo = new THREE.CircleGeometry(visualRadius * 1.6, 6);
      const baseMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.rotation.x = -Math.PI / 2;
      base.position.y = 0.08;
      group.add(base);

      // Outer ring glow
      const ringGeo = new THREE.RingGeometry(visualRadius * 1.2, visualRadius * 1.5, 6);
      const ringMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      group.add(ring);

      // Floating sphere — bigger and brighter
      const orbGeo = new THREE.SphereGeometry(1.6, 16, 12);
      const orbMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 2.5,
        transparent: true,
        opacity: 0.85,
      });
      const orb = new THREE.Mesh(orbGeo, orbMat);
      orb.position.y = BOOST_PAD.LARGE_HEIGHT;
      group.add(orb);

      // Point light so the pad glows on nearby surfaces
      const light = new THREE.PointLight(color, 1.5, 8);
      light.position.y = BOOST_PAD.LARGE_HEIGHT;
      group.add(light);
    } else {
      // Small pad: flat glowing disc flush with the ground
      const discGeo = new THREE.CircleGeometry(visualRadius, 16);
      const discMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      });
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      group.add(disc);

      // Subtle outer glow ring
      const glowGeo = new THREE.RingGeometry(visualRadius * 0.85, visualRadius * 1.1, 16);
      const glowMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.04;
      group.add(glow);
    }

    this.scene.add(group);

    this.pads.push({
      mesh: group,
      position: new THREE.Vector3(position.x, 0, position.z),
      isLarge: isLarge,
      radius: hitboxRadius,
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
        if (!this.isRemote) {
          // Respawn timer (only in single-player; server handles in multiplayer)
          pad.respawnTimer -= dt;
          if (pad.respawnTimer <= 0) {
            pad.active = true;
            pad.mesh.visible = true;
          }
        }
        return;
      }

      // Animate active pads
      if (pad.isLarge) {
        // Large: spin and bob the orb (child 2: base, ring, orb, light)
        const orb = pad.mesh.children[2];
        if (orb) {
          orb.rotation.y = time * 2;
          orb.position.y = BOOST_PAD.LARGE_HEIGHT + Math.sin(time * 3) * 0.3;
        }
      } else {
        // Small: gentle pulse on the disc opacity
        const disc = pad.mesh.children[0];
        if (disc && disc.material) {
          disc.material.emissiveIntensity = 1.2 + Math.sin(time * 4) * 0.4;
        }
      }

      if (!this.isRemote) {
        // Check car collisions (only in single-player; server handles in multiplayer)
        cars.forEach((car) => {
          if (!pad.active) return;
          const carPos = car.getPosition();
          const dx = carPos.x - pad.position.x;
          const dz = carPos.z - pad.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < pad.radius) {
            if (car.boost < 100 || pad.isLarge) {
              car.addBoost(pad.amount);
              if (car.isLocalPlayer) {
                audioManager.playBoostPickup(pad.isLarge);
              }
              pad.active = false;
              pad.mesh.visible = false;
              pad.respawnTimer = pad.respawnTime;
            }
          }
        });
      }
    });
  }
}
