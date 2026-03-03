// ============================================
// CarMeshBuilder - Builds a detailed Three.js Group from a variant config
// ~35-45 mesh parts depending on aero/roof/door options
// ============================================

import * as THREE from 'three';
import { CAR } from '../../shared/constants.js';

const W = CAR.WIDTH;    // 2.2
const H = CAR.HEIGHT;   // 1.1
const L = CAR.LENGTH;   // 3.6

/**
 * Build a detailed car mesh from a variant config.
 * @param {object} config - from generateCarVariant()
 * @returns {{ mesh: THREE.Group, wheels: THREE.Object3D[], bottomLight: THREE.PointLight }}
 */
export function buildCarMesh(config) {
  const mesh = new THREE.Group();
  const wheels = [];

  // Lowered variant offsets
  const rideY = config.isLowered ? -0.08 : 0;
  const trackW = config.isLowered ? 0.12 : 0;

  // ---- Materials ----
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x222244,
    metalness: 0.7,
    roughness: 0.3,
    emissive: config.bodyColor,
    emissiveIntensity: 0.15,
  });

  const neonMat = new THREE.MeshStandardMaterial({
    color: config.neonColor,
    emissive: config.neonColor,
    emissiveIntensity: 3,
  });

  const glassMat = new THREE.MeshStandardMaterial({
    color: config.neonColor,
    emissive: config.neonColor,
    emissiveIntensity: 1.0,
    transparent: true,
    opacity: 0.45,
  });

  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x111122,
    metalness: 0.3,
    roughness: 0.8,
  });

  const lightMat = new THREE.MeshStandardMaterial({
    color: config.lightColor,
    emissive: config.lightColor,
    emissiveIntensity: 2,
  });

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff2200,
    emissive: 0xff2200,
    emissiveIntensity: 2,
  });

  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x222222,
    metalness: 0.1,
    roughness: 0.9,
  });

  const rimMat = new THREE.MeshStandardMaterial({
    color: config.wheelAccentColor,
    metalness: 0.8,
    roughness: 0.2,
  });

  const aeroMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2e,
    metalness: 0.5,
    roughness: 0.4,
  });

  // ==========================================
  // FRONT SECTION (8-10 parts)
  // ==========================================

  // Front bumper
  const bumperFGeo = new THREE.BoxGeometry(W * 1.02, H * 0.28, L * 0.12);
  const bumperF = new THREE.Mesh(bumperFGeo, bodyMat);
  bumperF.position.set(0, -H * 0.15 + rideY, L * 0.48);
  bumperF.castShadow = true;
  mesh.add(bumperF);

  // Hood
  const hoodGeo = new THREE.BoxGeometry(W * 0.96, H * 0.1, L * 0.35);
  const hood = new THREE.Mesh(hoodGeo, bodyMat);
  hood.position.set(0, H * 0.12 + rideY, L * 0.28);
  hood.castShadow = true;
  mesh.add(hood);

  // Under-panel (front)
  const underFGeo = new THREE.BoxGeometry(W * 0.9, H * 0.06, L * 0.4);
  const underF = new THREE.Mesh(underFGeo, darkMat);
  underF.position.set(0, -H * 0.32 + rideY, L * 0.25);
  mesh.add(underF);

  // Headlights
  const hlGeo = new THREE.BoxGeometry(W * 0.2, H * 0.14, L * 0.08);
  [-1, 1].forEach((side) => {
    const hl = new THREE.Mesh(hlGeo, lightMat);
    hl.position.set(side * W * 0.36, H * 0.05 + rideY, L * 0.47);
    mesh.add(hl);

    // Popup headlight covers
    if (config.hasPopupHeadlights) {
      const coverGeo = new THREE.BoxGeometry(W * 0.22, H * 0.08, L * 0.1);
      const cover = new THREE.Mesh(coverGeo, bodyMat);
      cover.position.set(side * W * 0.36, H * 0.15 + rideY, L * 0.47);
      cover.rotation.x = -0.4; // angled open
      mesh.add(cover);
    }
  });

  // Front fenders
  const fenderFGeo = new THREE.BoxGeometry(W * 0.14, H * 0.35, L * 0.28);
  [-1, 1].forEach((side) => {
    const fender = new THREE.Mesh(fenderFGeo, bodyMat);
    fender.position.set(side * W * 0.48, H * 0.0 + rideY, L * 0.28);
    fender.castShadow = true;
    mesh.add(fender);
  });

  // Turn signals
  const tsGeo = new THREE.BoxGeometry(W * 0.06, H * 0.06, L * 0.04);
  const tsMat = new THREE.MeshStandardMaterial({
    color: 0xffaa00,
    emissive: 0xffaa00,
    emissiveIntensity: 1.5,
  });
  [-1, 1].forEach((side) => {
    const ts = new THREE.Mesh(tsGeo, tsMat);
    ts.position.set(side * W * 0.47, H * 0.0 + rideY, L * 0.49);
    mesh.add(ts);
  });

  // ==========================================
  // COCKPIT SECTION (10-12 parts)
  // ==========================================

  // Main body lower
  const bodyLowerGeo = new THREE.BoxGeometry(W, H * 0.5, L);
  const bodyLower = new THREE.Mesh(bodyLowerGeo, bodyMat);
  bodyLower.position.set(0, 0 + rideY, 0);
  bodyLower.castShadow = true;
  mesh.add(bodyLower);

  // Cabin box
  const cabinGeo = new THREE.BoxGeometry(W * 0.72, H * 0.42, L * 0.38);
  const cabin = new THREE.Mesh(cabinGeo, darkMat);
  cabin.position.set(0, H * 0.46 + rideY, -L * 0.04);
  mesh.add(cabin);

  // Roof or roll-bar
  if (config.roofStyle === 'coupe') {
    const roofGeo = new THREE.BoxGeometry(W * 0.72, H * 0.08, L * 0.38);
    const roof = new THREE.Mesh(roofGeo, bodyMat);
    roof.position.set(0, H * 0.7 + rideY, -L * 0.04);
    roof.castShadow = true;
    mesh.add(roof);
  } else {
    // Convertible: roll-bar frame (two pillars + crossbar)
    const pillarGeo = new THREE.BoxGeometry(W * 0.06, H * 0.3, L * 0.06);
    [-1, 1].forEach((side) => {
      const pillar = new THREE.Mesh(pillarGeo, darkMat);
      pillar.position.set(side * W * 0.32, H * 0.55 + rideY, -L * 0.15);
      mesh.add(pillar);
    });
    const barGeo = new THREE.BoxGeometry(W * 0.7, H * 0.05, L * 0.05);
    const bar = new THREE.Mesh(barGeo, darkMat);
    bar.position.set(0, H * 0.72 + rideY, -L * 0.15);
    mesh.add(bar);
  }

  // Front windshield
  const fwGeo = new THREE.BoxGeometry(W * 0.68, H * 0.35, 0.08);
  const fwShield = new THREE.Mesh(fwGeo, glassMat);
  fwShield.position.set(0, H * 0.45 + rideY, L * 0.14);
  fwShield.rotation.x = -0.3;
  mesh.add(fwShield);

  // Rear windshield
  const rwGeo = new THREE.BoxGeometry(W * 0.64, H * 0.3, 0.08);
  const rwShield = new THREE.Mesh(rwGeo, glassMat);
  rwShield.position.set(0, H * 0.45 + rideY, -L * 0.22);
  rwShield.rotation.x = 0.35;
  mesh.add(rwShield);

  // Side windows
  const swGeo = new THREE.BoxGeometry(0.06, H * 0.28, L * 0.26);
  [-1, 1].forEach((side) => {
    const sw = new THREE.Mesh(swGeo, glassMat);
    sw.position.set(side * W * 0.37, H * 0.44 + rideY, -L * 0.02);
    mesh.add(sw);
  });

  // Door panels
  const doorGeo = new THREE.BoxGeometry(0.08, H * 0.42, L * 0.32);
  [-1, 1].forEach((side) => {
    const door = new THREE.Mesh(doorGeo, bodyMat);
    door.position.set(side * W * 0.5, H * 0.1 + rideY, -L * 0.02);
    if (config.doorStyle === 'scissor') {
      door.rotation.z = side * 0.08; // slight outward tilt
    }
    door.castShadow = true;
    mesh.add(door);
  });

  // Side mirrors
  const mirrorGeo = new THREE.BoxGeometry(W * 0.08, H * 0.06, L * 0.06);
  [-1, 1].forEach((side) => {
    const mirror = new THREE.Mesh(mirrorGeo, bodyMat);
    mirror.position.set(side * (W * 0.54), H * 0.28 + rideY, L * 0.1);
    mesh.add(mirror);
  });

  // Seats (visible on convertible, still included for both)
  const seatGeo = new THREE.BoxGeometry(W * 0.2, H * 0.22, L * 0.16);
  [-1, 1].forEach((side) => {
    const seat = new THREE.Mesh(seatGeo, darkMat);
    seat.position.set(side * W * 0.18, H * 0.28 + rideY, -L * 0.06);
    mesh.add(seat);
  });

  // Steering column
  const steerGeo = new THREE.BoxGeometry(W * 0.04, H * 0.14, L * 0.08);
  const steer = new THREE.Mesh(steerGeo, darkMat);
  steer.position.set(W * -0.15, H * 0.34 + rideY, L * 0.04);
  steer.rotation.x = -0.5;
  mesh.add(steer);

  // ==========================================
  // REAR SECTION (7-8 parts)
  // ==========================================

  // Rear bumper
  const bumperRGeo = new THREE.BoxGeometry(W * 1.02, H * 0.28, L * 0.1);
  const bumperR = new THREE.Mesh(bumperRGeo, bodyMat);
  bumperR.position.set(0, -H * 0.15 + rideY, -L * 0.48);
  bumperR.castShadow = true;
  mesh.add(bumperR);

  // Taillights
  const tlGeo = new THREE.BoxGeometry(W * 0.18, H * 0.1, L * 0.06);
  [-1, 1].forEach((side) => {
    const tl = new THREE.Mesh(tlGeo, tailMat);
    tl.position.set(side * W * 0.36, H * 0.05 + rideY, -L * 0.49);
    mesh.add(tl);
  });

  // Rear fenders
  const fenderRGeo = new THREE.BoxGeometry(W * 0.14, H * 0.35, L * 0.28);
  [-1, 1].forEach((side) => {
    const fender = new THREE.Mesh(fenderRGeo, bodyMat);
    fender.position.set(side * W * 0.48, H * 0.0 + rideY, -L * 0.28);
    fender.castShadow = true;
    mesh.add(fender);
  });

  // Trunk
  const trunkGeo = new THREE.BoxGeometry(W * 0.8, H * 0.1, L * 0.2);
  const trunk = new THREE.Mesh(trunkGeo, bodyMat);
  trunk.position.set(0, H * 0.12 + rideY, -L * 0.35);
  trunk.castShadow = true;
  mesh.add(trunk);

  // Under-panel (rear)
  const underRGeo = new THREE.BoxGeometry(W * 0.9, H * 0.06, L * 0.35);
  const underR = new THREE.Mesh(underRGeo, darkMat);
  underR.position.set(0, -H * 0.32 + rideY, -L * 0.28);
  mesh.add(underR);

  // Exhaust pipes
  const exhGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.14, 6);
  [-1, 1].forEach((side) => {
    const exh = new THREE.Mesh(exhGeo, rimMat);
    exh.rotation.x = Math.PI / 2;
    exh.position.set(side * W * 0.22, -H * 0.22 + rideY, -L * 0.52);
    mesh.add(exh);
  });

  // ==========================================
  // AERO PACKAGE (8 parts, conditional)
  // ==========================================

  if (config.hasAero) {
    // Front splitter
    const splitterGeo = new THREE.BoxGeometry(W * 1.1, H * 0.04, L * 0.08);
    const splitter = new THREE.Mesh(splitterGeo, aeroMat);
    splitter.position.set(0, -H * 0.3 + rideY, L * 0.52);
    mesh.add(splitter);

    // Hood scoop
    const scoopGeo = new THREE.BoxGeometry(W * 0.2, H * 0.1, L * 0.14);
    const scoop = new THREE.Mesh(scoopGeo, aeroMat);
    scoop.position.set(0, H * 0.2 + rideY, L * 0.22);
    mesh.add(scoop);

    // Canards
    const canardGeo = new THREE.BoxGeometry(W * 0.12, H * 0.04, L * 0.1);
    [-1, 1].forEach((side) => {
      const canard = new THREE.Mesh(canardGeo, aeroMat);
      canard.position.set(side * W * 0.48, -H * 0.18 + rideY, L * 0.44);
      canard.rotation.z = side * -0.2;
      mesh.add(canard);
    });

    // Side skirts
    const skirtGeo = new THREE.BoxGeometry(W * 0.06, H * 0.08, L * 0.85);
    [-1, 1].forEach((side) => {
      const skirt = new THREE.Mesh(skirtGeo, aeroMat);
      skirt.position.set(side * (W * 0.52 + trackW), -H * 0.28 + rideY, 0);
      mesh.add(skirt);
    });

    // Rear wing: 2 arms + blade
    const armGeo = new THREE.BoxGeometry(W * 0.04, H * 0.28, L * 0.04);
    [-1, 1].forEach((side) => {
      const arm = new THREE.Mesh(armGeo, aeroMat);
      arm.position.set(side * W * 0.28, H * 0.5 + rideY, -L * 0.42);
      mesh.add(arm);
    });

    const wingGeo = new THREE.BoxGeometry(W * 1.0, H * 0.04, L * 0.14);
    const wing = new THREE.Mesh(wingGeo, aeroMat);
    wing.position.set(0, H * 0.66 + rideY, -L * 0.42);
    wing.rotation.x = -0.1;
    mesh.add(wing);

    // Rear diffuser
    const diffGeo = new THREE.BoxGeometry(W * 0.9, H * 0.06, L * 0.12);
    const diff = new THREE.Mesh(diffGeo, aeroMat);
    diff.position.set(0, -H * 0.32 + rideY, -L * 0.52);
    diff.rotation.x = 0.15;
    mesh.add(diff);
  }

  // ==========================================
  // NEON UNDERGLOW (5 parts, always present)
  // ==========================================

  // Side neon strips
  const nStripGeo = new THREE.BoxGeometry(0.12, 0.15, L * 1.02);
  [-1, 1].forEach((side) => {
    const strip = new THREE.Mesh(nStripGeo, neonMat);
    strip.position.set(side * (W / 2 + 0.02 + trackW), -H * 0.1 + rideY, 0);
    mesh.add(strip);
  });

  // Front neon strip
  const nFrontGeo = new THREE.BoxGeometry(W * 1.02, 0.15, 0.12);
  const nFront = new THREE.Mesh(nFrontGeo, neonMat);
  nFront.position.set(0, -H * 0.1 + rideY, L / 2 + 0.02);
  mesh.add(nFront);

  // Rear neon strip
  const nRear = new THREE.Mesh(nFrontGeo.clone(), neonMat);
  nRear.position.set(0, -H * 0.1 + rideY, -L / 2 - 0.02);
  mesh.add(nRear);

  // Underglow plane
  const underGlowGeo = new THREE.PlaneGeometry(W * 0.8, L * 0.8);
  const underGlowMat = new THREE.MeshBasicMaterial({
    color: config.neonColor,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  });
  const underGlow = new THREE.Mesh(underGlowGeo, underGlowMat);
  underGlow.rotation.x = -Math.PI / 2;
  underGlow.position.y = -H / 2 - 0.05 + rideY;
  mesh.add(underGlow);

  // Bottom glow point light
  const bottomLight = new THREE.PointLight(config.neonColor, 1.5, 8);
  bottomLight.position.set(0, -0.5 + rideY, 0);
  mesh.add(bottomLight);

  // ==========================================
  // WHEELS (4 groups x 3 parts each)
  // ==========================================

  const wheelRadius = 0.38;
  const wheelWidth = 0.25;
  const tireGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 10);
  const rimGeo = new THREE.CylinderGeometry(wheelRadius * 0.65, wheelRadius * 0.65, wheelWidth + 0.02, 8);
  const hubGeo = new THREE.CylinderGeometry(wheelRadius * 0.2, wheelRadius * 0.2, wheelWidth + 0.04, 6);

  const wheelPositions = [
    [-W / 2 + 0.1 - trackW, -H / 2 + 0.15 + rideY, L * 0.3],   // FL
    [W / 2 - 0.1 + trackW, -H / 2 + 0.15 + rideY, L * 0.3],    // FR
    [-W / 2 + 0.1 - trackW, -H / 2 + 0.15 + rideY, -L * 0.3],  // RL
    [W / 2 - 0.1 + trackW, -H / 2 + 0.15 + rideY, -L * 0.3],   // RR
  ];

  wheelPositions.forEach((pos) => {
    const wheelGroup = new THREE.Group();

    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.z = Math.PI / 2;
    wheelGroup.add(tire);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    wheelGroup.add(rim);

    const hub = new THREE.Mesh(hubGeo, rimMat);
    hub.rotation.z = Math.PI / 2;
    wheelGroup.add(hub);

    wheelGroup.position.set(pos[0], pos[1], pos[2]);
    mesh.add(wheelGroup);
    wheels.push(wheelGroup);
  });

  return { mesh, wheels, bottomLight };
}
