// ============================================
// CarMeshBuilder - Builds a Three.js Group from a variant config
// Supports both GLB models and procedural (~35-45 mesh parts) fallback
// ============================================

import * as THREE from 'three';
import { CAR } from '../../shared/constants.js';
import { modelLoader } from './ModelLoader.js';

const W = CAR.WIDTH;    // 2.2
const H = CAR.HEIGHT;   // 1.1
const L = CAR.LENGTH;   // 3.6

/**
 * Build a car mesh from a variant config.
 * Uses GLB model if config.modelId is set and cached, otherwise procedural.
 * @param {object} config - from generateCarVariant()
 * @returns {{ mesh: THREE.Group, wheels: THREE.Object3D[], bottomLight: THREE.PointLight }}
 */
export function buildCarMesh(config) {
  if (config.modelId) {
    const glbResult = buildFromGLB(config);
    if (glbResult) return glbResult;
  }
  return buildProceduralCarMesh(config);
}

/**
 * Build car mesh from a cached GLB model.
 * @returns {{ mesh: THREE.Group, wheels: THREE.Object3D[], bottomLight: THREE.PointLight }|null}
 */
function buildFromGLB(config) {
  const clone = modelLoader.getModel(config.modelId);
  if (!clone) return null;

  const mesh = new THREE.Group();

  // --- Normalize size to fit CAR dimensions ---
  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Scale to fill the car footprint (width × length), ignoring height
  // so all models end up the same general size regardless of shape
  const scaleX = W / Math.max(size.x, 0.001);
  const scaleZ = L / Math.max(size.z, 0.001);
  const scale = Math.min(scaleX, scaleZ);
  clone.scale.multiplyScalar(scale);

  // Re-center after scaling
  center.multiplyScalar(scale);
  clone.position.set(-center.x, -center.y, -center.z);

  // Align bottom to -H/2
  const boxAfter = new THREE.Box3().setFromObject(clone);
  const bottomOffset = boxAfter.min.y - (-H / 2);
  clone.position.y -= bottomOffset;

  mesh.add(clone);

  // --- Extract wheels ---
  const wheelCandidates = [];
  clone.traverse((child) => {
    if (child.isMesh && child.name && child.name.toLowerCase().includes('wheel')) {
      wheelCandidates.push(child);
    }
  });

  // Sort by position: front/back (z desc), then left/right (x asc)
  // Target order: FL, FR, RL, RR
  wheelCandidates.sort((a, b) => {
    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    a.getWorldPosition(posA);
    b.getWorldPosition(posB);
    // Split by z (front vs rear)
    const zDiff = posB.z - posA.z;
    if (Math.abs(zDiff) > 0.1) return zDiff;
    // Same z-zone → sort by x
    return posA.x - posB.x;
  });

  const wheels = [];
  // Take up to 4 wheels
  for (let i = 0; i < Math.min(4, wheelCandidates.length); i++) {
    wheels.push(wheelCandidates[i]);
  }
  // Pad with invisible dummy Object3Ds if needed
  while (wheels.length < 4) {
    const dummy = new THREE.Object3D();
    mesh.add(dummy);
    wheels.push(dummy);
  }

  // --- Recolor body panels via texture atlas swap ---
  // Kenney models share a colormap texture atlas (grid of solid color blocks).
  // Find the "body" mesh, sample its UVs to identify which color block is
  // the body paint, then replace those pixels with config.bodyColor.
  _recolorBodyTexture(clone, config.bodyColor);

  // --- Swap to MeshBasicMaterial (arena lighting is too dark for PBR) ---
  clone.traverse((child) => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const newMats = mats.map((mat) => {
        const basic = new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xb8b8b8),
          map: mat.map || null,
          vertexColors: !!mat.vertexColors,
        });
        mat.dispose();
        return basic;
      });
      child.material = newMats.length === 1 ? newMats[0] : newMats;
    }
  });

  // --- Compute actual model bounds for neon strip sizing ---
  const actualBox = new THREE.Box3().setFromObject(clone);
  const actualSize = new THREE.Vector3();
  actualBox.getSize(actualSize);
  const actualCenter = new THREE.Vector3();
  actualBox.getCenter(actualCenter);
  const mW = actualSize.x;  // actual model width
  const mH = actualSize.y;  // actual model height
  const mL = actualSize.z;  // actual model length
  const mCx = actualCenter.x;
  const mCz = actualCenter.z;
  const mBottom = actualBox.min.y;

  // --- Team color: underglow light pool (no visible geometry strips) ---
  // Soft colored light on the ground beneath the car
  const underGlowGeo = new THREE.PlaneGeometry(mW * 1.1, mL * 1.1);
  const underGlowMat = new THREE.MeshBasicMaterial({
    color: config.neonColor,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const underGlow = new THREE.Mesh(underGlowGeo, underGlowMat);
  underGlow.rotation.x = -Math.PI / 2;
  underGlow.position.set(mCx, mBottom - 0.04, mCz);
  mesh.add(underGlow);

  // Point light casts team color onto the ground
  const bottomLight = new THREE.PointLight(config.neonColor, 2, 10);
  bottomLight.position.set(mCx, mBottom - 0.2, mCz);
  mesh.add(bottomLight);

  return { mesh, wheels, bottomLight };
}

/**
 * Recolor the body panels by modifying the shared colormap texture.
 * 1. Find the "body" mesh (by name, or largest mesh)
 * 2. Sample its UVs to find the dominant color block in the texture
 * 3. Replace all pixels of that color with the new bodyColor
 * 4. Assign the modified texture as a new CanvasTexture
 */
function _recolorBodyTexture(clone, bodyColorHex) {
  // Find the body mesh — prefer one named "body", fall back to largest
  let bodyMesh = null;
  let largestMesh = null;
  let largestCount = 0;

  clone.traverse((child) => {
    if (!child.isMesh) return;
    if (child.name && child.name.toLowerCase().includes('body')) {
      bodyMesh = child;
    }
    const count = child.geometry ? (child.geometry.index ? child.geometry.index.count : child.geometry.getAttribute('position')?.count || 0) : 0;
    if (count > largestCount) {
      largestCount = count;
      largestMesh = child;
    }
  });
  bodyMesh = bodyMesh || largestMesh;
  if (!bodyMesh) return;

  // Get the texture from the body mesh's material
  const mat = Array.isArray(bodyMesh.material) ? bodyMesh.material[0] : bodyMesh.material;
  const tex = mat && mat.map;
  if (!tex || !tex.image) return;

  const img = tex.image;
  const w = img.width || img.naturalWidth || 512;
  const h = img.height || img.naturalHeight || 512;

  // Draw texture to offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  // Sample body mesh UVs to find which color block it uses
  const uvAttr = bodyMesh.geometry.getAttribute('uv');
  if (!uvAttr) return;

  // Sample body mesh UVs with BOTH UV conventions (GLTF top-left vs
  // OpenGL bottom-left) and merge results. Quantize to grid cells in
  // the colormap palette. The body mesh only contains body panels, so
  // ALL cells its UVs hit are body colors and should be replaced.
  const GRID_COLS = 8;
  const GRID_ROWS = 4;
  const cellW = Math.floor(w / GRID_COLS);
  const cellH = Math.floor(h / GRID_ROWS);

  const cellCounts = new Map();
  for (let i = 0; i < uvAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    const px = Math.min(w - 1, Math.max(0, Math.floor(u * w)));

    // Try both conventions, add both
    for (const pyVal of [v * h, (1 - v) * h]) {
      const py = Math.min(h - 1, Math.max(0, Math.floor(pyVal)));
      const col = Math.min(GRID_COLS - 1, Math.floor(px / cellW));
      const row = Math.min(GRID_ROWS - 1, Math.floor(py / cellH));
      const key = col + ',' + row;
      cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    }
  }

  // Sort cells by frequency, replace ALL that have significant coverage
  const totalSamples = uvAttr.count * 2;
  const sortedCells = [...cellCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count > totalSamples * 0.03); // >3% coverage

  if (sortedCells.length === 0) return;

  // Skip cells whose average color is very dark (tires/black trim)
  // or very light (windows/white). Only recolor chromatic cells.
  const chromCells = sortedCells.filter(([key]) => {
    const [col, row] = key.split(',').map(Number);
    const cx = col * cellW + Math.floor(cellW / 2);
    const cy = row * cellH + Math.floor(cellH / 2);
    const idx = (cy * w + cx) * 4;
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
    const brightness = (r + g + b) / 3;
    return brightness > 40 && brightness < 230;
  });

  if (chromCells.length === 0) return;

  const newColor = new THREE.Color(bodyColorHex);

  // Replace all body cells — primary gets bodyColor, others get
  // progressively darker shades for a natural two-tone look
  const cellsToReplace = chromCells.map(([key], i) => {
    const shade = newColor.clone();
    if (i > 0) shade.multiplyScalar(Math.max(0.5, 1 - i * 0.15));
    const [col, row] = key.split(',').map(Number);
    return {
      col, row,
      r: Math.round(shade.r * 255),
      g: Math.round(shade.g * 255),
      b: Math.round(shade.b * 255),
    };
  });

  for (const cell of cellsToReplace) {
    const startX = cell.col * cellW;
    const startY = cell.row * cellH;
    for (let cy = startY; cy < startY + cellH && cy < h; cy++) {
      for (let cx = startX; cx < startX + cellW && cx < w; cx++) {
        const idx = (cy * w + cx) * 4;
        pixels[idx] = cell.r;
        pixels[idx + 1] = cell.g;
        pixels[idx + 2] = cell.b;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  // Create a new CanvasTexture and assign to ALL meshes sharing this texture
  const newTex = new THREE.CanvasTexture(canvas);
  newTex.flipY = tex.flipY;
  newTex.wrapS = tex.wrapS;
  newTex.wrapT = tex.wrapT;
  newTex.colorSpace = tex.colorSpace;

  clone.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (m.map === tex) {
        m.map = newTex;
        m.needsUpdate = true;
      }
    });
  });
}

/**
 * Build a detailed procedural car mesh from a variant config.
 * ~35-45 mesh parts depending on aero/roof/door options
 * @param {object} config - from generateCarVariant()
 * @returns {{ mesh: THREE.Group, wheels: THREE.Object3D[], bottomLight: THREE.PointLight }}
 */
function buildProceduralCarMesh(config) {
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
