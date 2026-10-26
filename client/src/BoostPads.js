// ============================================
// Boost Pads - Collectible boost pickups
// ============================================

import * as THREE from 'three';
import { ARENA, BOOST_PAD, BOOST_PAD_LAYOUT, COLORS } from '../../shared/constants.js';
import { audioManager } from './AudioManager.js';

// Reusable scratch color for the small-pad disc pulse
const _pulseColor = new THREE.Color();

/**
 * Flat, unlit decal material. The pads previously used MeshStandardMaterial
 * with color == emissive and an emissiveIntensity; the equivalent unlit look
 * is a MeshBasicMaterial whose color is scaled by that intensity (values > 1
 * are kept as HDR and picked up by the bloom pass).
 */
function makePadMaterial(color, intensity, opacity, doubleSide) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    transparent: true,
    opacity,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
}

export class BoostPads {
  constructor(scene, isRemote = false) {
    this.scene = scene;
    this.isRemote = isRemote;
    this.pads = [];

    // 5 shared materials for all 34 pads (instead of one StandardMaterial per mesh)
    this._largeBaseMat = makePadMaterial(COLORS.ORANGE, 1.2, 0.5, true);
    this._largeRingMat = makePadMaterial(COLORS.ORANGE, 0.8, 0.3, true);
    this._largeOrbMat = makePadMaterial(COLORS.ORANGE, 2.5, 0.85, false);
    this._smallDiscMat = makePadMaterial(COLORS.YELLOW, 1.5, 0.6, true);
    this._smallGlowMat = makePadMaterial(COLORS.YELLOW, 0.8, 0.25, true);
    this._smallDiscBaseColor = new THREE.Color(COLORS.YELLOW);

    this._createPads();
  }

  _createPads() {
    // Large boost pads
    const large = BOOST_PAD_LAYOUT.large;
    for (let i = 0; i < large.length; i++) {
      this._createPad({
        x: large[i].x * ARENA.WIDTH / 2,
        z: large[i].z * ARENA.LENGTH / 2,
      }, true);
    }

    // Small boost pads
    const small = BOOST_PAD_LAYOUT.small;
    for (let i = 0; i < small.length; i++) {
      this._createPad({
        x: small[i].x * ARENA.WIDTH / 2,
        z: small[i].z * ARENA.LENGTH / 2,
      }, false);
    }
  }

  _createPad(position, isLarge) {
    const hitboxRadius = isLarge ? BOOST_PAD.LARGE_RADIUS : BOOST_PAD.SMALL_RADIUS;
    // Visual radius is smaller than hitbox — hitbox radii are RL-accurate pickup zones
    const visualRadius = isLarge ? 2.5 : 1.2;

    const group = new THREE.Group();
    group.position.set(position.x, 0, position.z);

    let orb = null;
    let disc = null;

    if (isLarge) {
      // Large pad: prominent hexagonal base + large floating sphere
      // (children order kept as base, ring, orb)
      const baseGeo = new THREE.CircleGeometry(visualRadius * 1.6, 6);
      const base = new THREE.Mesh(baseGeo, this._largeBaseMat);
      base.rotation.x = -Math.PI / 2;
      base.position.y = 0.08;
      group.add(base);

      // Outer ring glow
      const ringGeo = new THREE.RingGeometry(visualRadius * 1.2, visualRadius * 1.5, 6);
      const ring = new THREE.Mesh(ringGeo, this._largeRingMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      group.add(ring);

      // Floating sphere — bigger and brighter
      const orbGeo = new THREE.SphereGeometry(1.6, 16, 12);
      orb = new THREE.Mesh(orbGeo, this._largeOrbMat);
      orb.position.y = BOOST_PAD.LARGE_HEIGHT;
      group.add(orb);

      // No per-pad PointLight: the pad is emissive on its own, and toggling
      // pad visibility with a light inside changed the scene light count
      // (forcing shader recompiles of every lit material).
    } else {
      // Small pad: flat glowing disc flush with the ground
      const discGeo = new THREE.CircleGeometry(visualRadius, 16);
      disc = new THREE.Mesh(discGeo, this._smallDiscMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      group.add(disc);

      // Subtle outer glow ring
      const glowGeo = new THREE.RingGeometry(visualRadius * 0.85, visualRadius * 1.1, 16);
      const glow = new THREE.Mesh(glowGeo, this._smallGlowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.04;
      group.add(glow);
    }

    this.scene.add(group);

    this.pads.push({
      mesh: group,
      orb,
      disc,
      position: new THREE.Vector3(position.x, 0, position.z),
      isLarge: isLarge,
      radius: hitboxRadius,
      radiusSq: hitboxRadius * hitboxRadius,
      amount: isLarge ? BOOST_PAD.LARGE_AMOUNT : BOOST_PAD.SMALL_AMOUNT,
      respawnTime: isLarge ? BOOST_PAD.LARGE_RESPAWN_TIME : BOOST_PAD.SMALL_RESPAWN_TIME,
      active: true,
      respawnTimer: 0,
    });
  }

  update(dt, cars) {
    const time = performance.now() * 0.001;
    const pads = this.pads;
    const isRemote = this.isRemote;
    const carCount = (!isRemote && cars) ? cars.length : 0;

    // Small-pad pulse: all small discs share one material and the same phase,
    // so modulate the shared color once per frame instead of per pad.
    this._smallDiscMat.color.copy(_pulseColor.copy(this._smallDiscBaseColor)
      .multiplyScalar(1.2 + Math.sin(time * 4) * 0.4));

    const orbY = BOOST_PAD.LARGE_HEIGHT + Math.sin(time * 3) * 0.3;
    const orbRot = time * 2;

    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];

      if (!pad.active) {
        if (!isRemote) {
          // Respawn timer (only in single-player; server handles in multiplayer)
          pad.respawnTimer -= dt;
          if (pad.respawnTimer <= 0) {
            pad.active = true;
            pad.mesh.visible = true;
          }
        }
        continue;
      }

      // Animate active large pads: spin and bob the orb
      if (pad.isLarge && pad.orb) {
        pad.orb.rotation.y = orbRot;
        pad.orb.position.y = orbY;
      }

      // Check car collisions (only in single-player; server handles in multiplayer)
      for (let c = 0; c < carCount; c++) {
        const car = cars[c];
        if (!car) continue;
        const carPos = car.getPosition();
        const dx = carPos.x - pad.position.x;
        const dz = carPos.z - pad.position.z;

        if (dx * dx + dz * dz < pad.radiusSq) {
          if (car.boost < 100 || pad.isLarge) {
            car.addBoost(pad.amount);
            if (car.isLocalPlayer) {
              audioManager.playBoostPickup(pad.isLarge);
            }
            pad.active = false;
            pad.mesh.visible = false;
            pad.respawnTimer = pad.respawnTime;
            break;
          }
        }
      }
    }
  }
}
