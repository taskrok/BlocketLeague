// ============================================
// Stadium - Decorative exterior surrounding the arena
// Purely visual: tiered stands, animated crowd, structural
// elements, flood lights, exterior ground, and sky dome.
// All repeated geometry uses InstancedMesh for performance.
// ============================================

import * as THREE from 'three';
import { ARENA, COLORS } from '../../shared/constants.js';

const HW = ARENA.WIDTH / 2;   // 82
const HL = ARENA.LENGTH / 2;  // 118.5
const H  = ARENA.HEIGHT;      // 51
const GW = ARENA.GOAL_WIDTH / 2; // 17

// Team palette
const BLUE_PRIMARY  = new THREE.Color(0x3b82f6);
const BLUE_DARK     = new THREE.Color(0x1e40af);
const ORANGE_PRIMARY = new THREE.Color(0xf97316);
const ORANGE_DARK    = new THREE.Color(0xc2410c);
const NEUTRAL_LIGHT = new THREE.Color(0xccccdd);
const NEUTRAL_DARK  = new THREE.Color(0x667788);
const CYAN_GLOW     = new THREE.Color(0x00ffff);
const STRUCT_COLOR  = new THREE.Color(0x181828);
const STRUCT_ACCENT = new THREE.Color(0x0a0a18);

// Seeded PRNG for deterministic randomness
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Stadium {
  constructor(scene) {
    this.scene = scene;
    this.meshes = [];
    this.disposables = []; // geometries + materials to clean up
    this.fanInstances = []; // { mesh, phaseArray }
    this._time = 0;

    this._buildSkyDome();
    this._buildExteriorGround();
    this._buildStands();
    this._buildCrowd();
    this._buildStructure();
    this._buildFloodLights();
    this._buildNeonAccents();
  }

  // ==========================================================
  //  SKY DOME
  // ==========================================================

  _buildSkyDome() {
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor:    { value: new THREE.Color(0x020010) },
        bottomColor: { value: new THREE.Color(0x0a0820) },
        horizonColor:{ value: new THREE.Color(0x100c30) },
        offset:      { value: 20 },
        exponent:    { value: 0.8 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform vec3 horizonColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          // Blend: bottom -> horizon -> top
          vec3 col = mix(bottomColor, horizonColor, smoothstep(0.0, 0.15, t));
          col = mix(col, topColor, smoothstep(0.15, 1.0, t));
          // Subtle stars
          float star = fract(sin(dot(vWorldPosition.xz * 0.05, vec2(12.9898, 78.233))) * 43758.5453);
          star = step(0.998, star) * step(0.3, h) * 0.6;
          col += vec3(star);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -1;
    this.scene.add(sky);
    this.meshes.push(sky);
    this.disposables.push(skyGeo, skyMat);
  }

  // ==========================================================
  //  EXTERIOR GROUND
  // ==========================================================

  _buildExteriorGround() {
    const groundGeo = new THREE.PlaneGeometry(800, 800, 1, 1);
    groundGeo.rotateX(-Math.PI / 2);

    const groundMat = new THREE.ShaderMaterial({
      uniforms: {
        baseColor: { value: new THREE.Color(0x0a0a12) },
        lineColor: { value: new THREE.Color(0x151520) },
      },
      vertexShader: `
        varying vec2 vWorldXZ;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldXZ = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 lineColor;
        varying vec2 vWorldXZ;
        void main() {
          // Subtle parking lot grid
          vec2 grid = abs(fract(vWorldXZ / 20.0) - 0.5);
          float line = 1.0 - smoothstep(0.47, 0.49, min(grid.x, grid.y));
          vec3 col = mix(baseColor, lineColor, line * 0.3);
          // Distance fade
          float d = length(vWorldXZ) / 400.0;
          col *= 1.0 - smoothstep(0.5, 1.0, d) * 0.5;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.1;
    ground.renderOrder = -1;
    this.scene.add(ground);
    this.meshes.push(ground);
    this.disposables.push(groundGeo, groundMat);
  }

  // ==========================================================
  //  STANDS / SEATING
  // ==========================================================

  _buildStands() {
    // Stand configuration
    const TIERS = 4;
    const TIER_HEIGHT = 8;
    const TIER_DEPTH = 10;
    const SEAT_SPACING = 2.5;
    const START_GAP = 8; // gap between arena wall and first stand row

    // Build stand sections around 4 sides, leaving goal openings
    // Sections: left side (-X), right side (+X), blue end (-Z), orange end (+Z)
    const sections = this._computeStandSections(START_GAP, TIERS, TIER_HEIGHT, TIER_DEPTH);

    // Concrete tiers (large slabs per tier per section)
    const tierGeo = new THREE.BoxGeometry(1, 1, 1);
    const tierMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      roughness: 0.9,
      metalness: 0.1,
    });
    this.disposables.push(tierGeo, tierMat);

    sections.forEach(section => {
      for (let t = 0; t < TIERS; t++) {
        const yBase = t * TIER_HEIGHT;
        const depthOffset = START_GAP + t * TIER_DEPTH;

        const slab = new THREE.Mesh(tierGeo, tierMat);
        // Scale and position depend on section orientation
        if (section.axis === 'x') {
          // Side stand (runs along Z)
          slab.scale.set(TIER_DEPTH, TIER_HEIGHT * 0.3, section.length);
          slab.position.set(
            section.sign * (HW + depthOffset + TIER_DEPTH / 2),
            yBase + TIER_HEIGHT * 0.15,
            section.center
          );
        } else {
          // End stand (runs along X)
          slab.scale.set(section.length, TIER_HEIGHT * 0.3, TIER_DEPTH);
          slab.position.set(
            section.center,
            yBase + TIER_HEIGHT * 0.15,
            section.sign * (HL + depthOffset + TIER_DEPTH / 2)
          );
        }
        this.scene.add(slab);
        this.meshes.push(slab);
      }
    });

    // Store for crowd placement
    this._standSections = sections;
    this._standConfig = { TIERS, TIER_HEIGHT, TIER_DEPTH, SEAT_SPACING, START_GAP };
  }

  _computeStandSections(startGap, tiers, tierH, tierD) {
    const sections = [];
    // Side stands (along Z axis) - full length
    sections.push({ axis: 'x', sign: -1, start: -HL + 15, end: HL - 15, center: 0, length: ARENA.LENGTH - 30 });
    sections.push({ axis: 'x', sign:  1, start: -HL + 15, end: HL - 15, center: 0, length: ARENA.LENGTH - 30 });

    // End stands (along X axis) - leave gap for goals
    // Blue end (-Z): two wing sections flanking the goal
    const endWingLength = (HW - GW - 10);
    if (endWingLength > 5) {
      // Left wing
      sections.push({ axis: 'z', sign: -1, center: -(GW + 10 + endWingLength / 2), length: endWingLength });
      // Right wing
      sections.push({ axis: 'z', sign: -1, center: (GW + 10 + endWingLength / 2), length: endWingLength });
      // Orange end (+Z)
      sections.push({ axis: 'z', sign: 1, center: -(GW + 10 + endWingLength / 2), length: endWingLength });
      sections.push({ axis: 'z', sign: 1, center: (GW + 10 + endWingLength / 2), length: endWingLength });
    }

    return sections;
  }

  // ==========================================================
  //  CROWD / FANS
  // ==========================================================

  _buildCrowd() {
    const { TIERS, TIER_HEIGHT, TIER_DEPTH, SEAT_SPACING, START_GAP } = this._standConfig;
    const rng = mulberry32(42);

    // Collect all fan positions + colors
    const fanPositions = [];
    const fanColors = [];

    this._standSections.forEach(section => {
      for (let t = 0; t < TIERS; t++) {
        const yBase = t * TIER_HEIGHT + TIER_HEIGHT * 0.3 + 0.5;
        const depthBase = START_GAP + t * TIER_DEPTH;

        // Place fans in rows within this tier
        const rowsPerTier = 3;
        for (let row = 0; row < rowsPerTier; row++) {
          const rowDepth = depthBase + 2 + row * (TIER_DEPTH / rowsPerTier);
          const rowY = yBase + row * 1.8;

          if (section.axis === 'x') {
            // Side stand: fans along Z
            const zStart = section.center - section.length / 2 + 2;
            const zEnd = section.center + section.length / 2 - 2;
            for (let z = zStart; z < zEnd; z += SEAT_SPACING) {
              const px = section.sign * (HW + rowDepth + TIER_DEPTH / 2);
              const pz = z + (rng() - 0.5) * 0.8;
              fanPositions.push(px, rowY, pz);
              fanColors.push(...this._fanColor(pz, rng));
            }
          } else {
            // End stand: fans along X
            const xStart = section.center - section.length / 2 + 2;
            const xEnd = section.center + section.length / 2 - 2;
            for (let x = xStart; x < xEnd; x += SEAT_SPACING) {
              const pz = section.sign * (HL + rowDepth + TIER_DEPTH / 2);
              const px = x + (rng() - 0.5) * 0.8;
              fanPositions.push(px, rowY, pz);
              fanColors.push(...this._fanColor(pz, rng));
            }
          }
        }
      }
    });

    const fanCount = fanPositions.length / 3;
    if (fanCount === 0) return;

    // Build instanced mesh for fan bodies
    const bodyGeo = new THREE.BoxGeometry(0.8, 1.8, 0.8);
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.7,
      metalness: 0.0,
    });
    this.disposables.push(bodyGeo, bodyMat);

    const fanMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, fanCount);
    fanMesh.frustumCulled = false;

    // Head spheres
    const headGeo = new THREE.SphereGeometry(0.4, 6, 4);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xddccbb,
      roughness: 0.8,
    });
    this.disposables.push(headGeo, headMat);
    const headMesh = new THREE.InstancedMesh(headGeo, headMat, fanCount);
    headMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const phaseArray = new Float32Array(fanCount);
    const baseY = new Float32Array(fanCount);

    for (let i = 0; i < fanCount; i++) {
      const px = fanPositions[i * 3];
      const py = fanPositions[i * 3 + 1];
      const pz = fanPositions[i * 3 + 2];

      // Body
      dummy.position.set(px, py, pz);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      fanMesh.setMatrixAt(i, dummy.matrix);
      color.setRGB(fanColors[i * 3], fanColors[i * 3 + 1], fanColors[i * 3 + 2]);
      fanMesh.setColorAt(i, color);

      // Head
      dummy.position.set(px, py + 1.3, pz);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);

      phaseArray[i] = rng() * Math.PI * 2;
      baseY[i] = py;
    }

    fanMesh.instanceMatrix.needsUpdate = true;
    fanMesh.instanceColor.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(fanMesh);
    this.scene.add(headMesh);
    this.meshes.push(fanMesh, headMesh);

    this.fanInstances.push({
      body: fanMesh,
      head: headMesh,
      phaseArray,
      baseY,
      count: fanCount,
      positions: fanPositions,
    });
  }

  _fanColor(zPos, rng) {
    // Team coloring based on Z position (blue = -Z, orange = +Z)
    const neutralChance = 0.15;
    if (rng() < neutralChance) {
      const c = NEUTRAL_LIGHT.clone().lerp(NEUTRAL_DARK, rng());
      return [c.r, c.g, c.b];
    }

    if (zPos < 0) {
      // Blue side
      const c = BLUE_PRIMARY.clone().lerp(BLUE_DARK, rng());
      return [c.r, c.g, c.b];
    } else {
      // Orange side
      const c = ORANGE_PRIMARY.clone().lerp(ORANGE_DARK, rng());
      return [c.r, c.g, c.b];
    }
  }

  // ==========================================================
  //  STRUCTURAL ELEMENTS
  // ==========================================================

  _buildStructure() {
    this._buildPillars();
    this._buildUpperRim();
    this._buildLightRigs();
  }

  _buildPillars() {
    const pillarGeo = new THREE.BoxGeometry(3, 1, 3);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: STRUCT_COLOR,
      roughness: 0.6,
      metalness: 0.4,
    });
    this.disposables.push(pillarGeo, pillarMat);

    // Pillar locations: corners + midpoints along sides
    const { START_GAP, TIERS, TIER_DEPTH, TIER_HEIGHT } = this._standConfig;
    const outerOffset = START_GAP + TIERS * TIER_DEPTH + 5;
    const pillarHeight = TIERS * TIER_HEIGHT + 15;

    const pillarPositions = [];

    // 4 main corners
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      pillarPositions.push([sx * (HW + outerOffset), sz * (HL + outerOffset)]);
    });

    // Side midpoints
    [-1, 1].forEach(sx => {
      pillarPositions.push([sx * (HW + outerOffset), 0]);
      pillarPositions.push([sx * (HW + outerOffset), -HL * 0.5]);
      pillarPositions.push([sx * (HW + outerOffset), HL * 0.5]);
    });

    // End midpoints (avoid goal area)
    [-1, 1].forEach(sz => {
      pillarPositions.push([-(HW * 0.6), sz * (HL + outerOffset)]);
      pillarPositions.push([(HW * 0.6), sz * (HL + outerOffset)]);
    });

    const pillarCount = pillarPositions.length;
    const pillarMesh = new THREE.InstancedMesh(pillarGeo, pillarMat, pillarCount);
    pillarMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    pillarPositions.forEach(([px, pz], i) => {
      dummy.position.set(px, pillarHeight / 2, pz);
      dummy.scale.set(1, pillarHeight, 1);
      dummy.updateMatrix();
      pillarMesh.setMatrixAt(i, dummy.matrix);
    });
    pillarMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(pillarMesh);
    this.meshes.push(pillarMesh);

    this._pillarHeight = pillarHeight;
    this._outerOffset = outerOffset;
  }

  _buildUpperRim() {
    const rimHeight = 4;
    const rimDepth = 15;
    const { TIERS, TIER_HEIGHT } = this._standConfig;
    const rimY = TIERS * TIER_HEIGHT + rimHeight / 2 + 5;
    const outerOffset = this._outerOffset;

    const rimGeo = new THREE.BoxGeometry(1, 1, 1);
    const rimMat = new THREE.MeshStandardMaterial({
      color: STRUCT_ACCENT,
      roughness: 0.5,
      metalness: 0.5,
    });
    this.disposables.push(rimGeo, rimMat);

    // 4 rim sections (canopy overhangs)
    const rims = [];

    // Side rims
    [-1, 1].forEach(sx => {
      rims.push({
        px: sx * (HW + outerOffset - rimDepth / 2 + 2),
        py: rimY,
        pz: 0,
        sx: rimDepth,
        sy: rimHeight,
        sz: ARENA.LENGTH + 20,
      });
    });

    // End rims
    [-1, 1].forEach(sz => {
      rims.push({
        px: 0,
        py: rimY,
        pz: sz * (HL + outerOffset - rimDepth / 2 + 2),
        sx: ARENA.WIDTH + 20,
        sy: rimHeight,
        sz: rimDepth,
      });
    });

    const rimCount = rims.length;
    const rimMesh = new THREE.InstancedMesh(rimGeo, rimMat, rimCount);
    rimMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    rims.forEach((r, i) => {
      dummy.position.set(r.px, r.py, r.pz);
      dummy.scale.set(r.sx, r.sy, r.sz);
      dummy.updateMatrix();
      rimMesh.setMatrixAt(i, dummy.matrix);
    });
    rimMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(rimMesh);
    this.meshes.push(rimMesh);

    this._rimY = rimY;
  }

  _buildLightRigs() {
    // Light rig bars along the underside of the rim — glowing strips
    const rigGeo = new THREE.BoxGeometry(1, 0.4, 1);
    const rigMat = new THREE.MeshStandardMaterial({
      color: 0x222244,
      emissive: 0x334466,
      emissiveIntensity: 0.5,
      roughness: 0.3,
      metalness: 0.7,
    });
    this.disposables.push(rigGeo, rigMat);

    const { TIERS, TIER_HEIGHT } = this._standConfig;
    const rigY = TIERS * TIER_HEIGHT + 3;
    const outerOffset = this._outerOffset;
    const rigs = [];

    // Light strips under the rim on each side
    const stripCount = 8;
    [-1, 1].forEach(sx => {
      for (let i = 0; i < stripCount; i++) {
        const z = -HL + 20 + i * ((ARENA.LENGTH - 40) / (stripCount - 1));
        rigs.push({
          px: sx * (HW + outerOffset - 8),
          py: rigY,
          pz: z,
          sx: 6,
          sz: 3,
        });
      }
    });
    [-1, 1].forEach(sz => {
      for (let i = 0; i < 4; i++) {
        const x = -HW + 30 + i * ((ARENA.WIDTH - 60) / 3);
        rigs.push({
          px: x,
          py: rigY,
          pz: sz * (HL + outerOffset - 8),
          sx: 3,
          sz: 6,
        });
      }
    });

    const rigCount = rigs.length;
    const rigMesh = new THREE.InstancedMesh(rigGeo, rigMat, rigCount);
    rigMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    rigs.forEach((r, i) => {
      dummy.position.set(r.px, r.py, r.pz);
      dummy.scale.set(r.sx, 1, r.sz);
      dummy.updateMatrix();
      rigMesh.setMatrixAt(i, dummy.matrix);
    });
    rigMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(rigMesh);
    this.meshes.push(rigMesh);
  }

  // ==========================================================
  //  FLOOD LIGHTS (4 corners)
  // ==========================================================

  _buildFloodLights() {
    const outerOffset = this._outerOffset;
    const poleHeight = this._pillarHeight + 15;

    const corners = [
      [-(HW + outerOffset + 5), -(HL + outerOffset + 5)],
      [-(HW + outerOffset + 5),  (HL + outerOffset + 5)],
      [ (HW + outerOffset + 5), -(HL + outerOffset + 5)],
      [ (HW + outerOffset + 5),  (HL + outerOffset + 5)],
    ];

    // Poles
    const poleGeo = new THREE.CylinderGeometry(0.8, 1.2, poleHeight, 6);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x222233,
      roughness: 0.4,
      metalness: 0.6,
    });
    this.disposables.push(poleGeo, poleMat);

    // Light fixture (cluster of boxes)
    const fixtureGeo = new THREE.BoxGeometry(6, 3, 6);
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffeedd,
      emissiveIntensity: 2.0,
      roughness: 0.2,
      metalness: 0.3,
    });
    this.disposables.push(fixtureGeo, fixtureMat);

    // Lens glow panels on fixture underside
    const lensGeo = new THREE.PlaneGeometry(5, 5);
    const lensMat = new THREE.MeshBasicMaterial({
      color: 0xfff8e0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(lensGeo, lensMat);

    corners.forEach(([cx, cz]) => {
      // Pole
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(cx, poleHeight / 2, cz);
      this.scene.add(pole);
      this.meshes.push(pole);

      // Fixture housing
      const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
      fixture.position.set(cx, poleHeight + 1.5, cz);
      this.scene.add(fixture);
      this.meshes.push(fixture);

      // Lens glow (underside, pointing down + toward arena center)
      const lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.set(cx, poleHeight - 0.5, cz);
      lens.rotation.x = -Math.PI / 2;
      this.scene.add(lens);
      this.meshes.push(lens);

      // Actual point light aiming toward the arena
      const light = new THREE.PointLight(0xfff0dd, 0.4, 350, 1.5);
      light.position.set(cx, poleHeight + 2, cz);
      this.scene.add(light);
      this.meshes.push(light);
    });
  }

  // ==========================================================
  //  NEON ACCENT STRIPS
  // ==========================================================

  _buildNeonAccents() {
    // Glowing cyan strips along the rim edges and stand fronts
    const stripGeo = new THREE.BoxGeometry(1, 0.15, 1);
    const stripMat = new THREE.MeshBasicMaterial({
      color: CYAN_GLOW,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(stripGeo, stripMat);

    const { TIERS, TIER_HEIGHT, START_GAP, TIER_DEPTH } = this._standConfig;
    const strips = [];

    // Horizontal neon strips along the front edge of each tier (sides)
    for (let t = 0; t < TIERS; t++) {
      const yBase = t * TIER_HEIGHT + TIER_HEIGHT * 0.3;
      const depthOffset = START_GAP + t * TIER_DEPTH;

      [-1, 1].forEach(sx => {
        strips.push({
          px: sx * (HW + depthOffset),
          py: yBase,
          pz: 0,
          sx: 0.3,
          sy: 1,
          sz: ARENA.LENGTH - 20,
        });
      });
    }

    // Rim edge strips
    const rimY = this._rimY;
    [-1, 1].forEach(sx => {
      strips.push({
        px: sx * (HW + this._outerOffset - 1),
        py: rimY - 2,
        pz: 0,
        sx: 0.3,
        sy: 1,
        sz: ARENA.LENGTH + 10,
      });
    });
    [-1, 1].forEach(sz => {
      strips.push({
        px: 0,
        py: rimY - 2,
        pz: sz * (HL + this._outerOffset - 1),
        sx: ARENA.WIDTH + 10,
        sy: 1,
        sz: 0.3,
      });
    });

    const stripCount = strips.length;
    const stripMesh = new THREE.InstancedMesh(stripGeo, stripMat, stripCount);
    stripMesh.frustumCulled = false;
    stripMesh.renderOrder = 10;

    const dummy = new THREE.Object3D();
    strips.forEach((s, i) => {
      dummy.position.set(s.px, s.py, s.pz);
      dummy.scale.set(s.sx, s.sy, s.sz);
      dummy.updateMatrix();
      stripMesh.setMatrixAt(i, dummy.matrix);
    });
    stripMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(stripMesh);
    this.meshes.push(stripMesh);

    // Team-colored glow strips at the ends
    const teamStrips = [
      { color: BLUE_PRIMARY, z: -(HL + this._outerOffset - 3), sign: -1 },
      { color: ORANGE_PRIMARY, z: (HL + this._outerOffset - 3), sign: 1 },
    ];

    teamStrips.forEach(({ color, z }) => {
      const tGeo = new THREE.BoxGeometry(ARENA.WIDTH * 0.6, 0.3, 0.3);
      const tMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const tMesh = new THREE.Mesh(tGeo, tMat);
      tMesh.position.set(0, this._rimY - 2, z);
      this.scene.add(tMesh);
      this.meshes.push(tMesh);
      this.disposables.push(tGeo, tMat);
    });
  }

  // ==========================================================
  //  UPDATE (animation)
  // ==========================================================

  update(dt) {
    this._time += dt;

    // Animate crowd — bob up and down with sine wave
    const dummy = new THREE.Object3D();
    this.fanInstances.forEach(({ body, head, phaseArray, baseY, count, positions }) => {
      for (let i = 0; i < count; i++) {
        const phase = phaseArray[i];
        const bob = Math.sin(this._time * 2.5 + phase) * 0.6;
        // Only positive bob (fans stand up from seated, never sink below seat)
        const yOffset = Math.max(0, bob);

        const px = positions[i * 3];
        const py = baseY[i] + yOffset;
        const pz = positions[i * 3 + 2];

        // Body
        dummy.position.set(px, py, pz);
        dummy.scale.setScalar(1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);

        // Head
        dummy.position.set(px, py + 1.3, pz);
        dummy.updateMatrix();
        head.setMatrixAt(i, dummy.matrix);
      }

      body.instanceMatrix.needsUpdate = true;
      head.instanceMatrix.needsUpdate = true;
    });
  }

  // ==========================================================
  //  DISPOSE
  // ==========================================================

  dispose() {
    this.meshes.forEach(obj => {
      if (obj.parent) obj.parent.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    this.disposables.forEach(d => {
      if (d && typeof d.dispose === 'function') d.dispose();
    });
    this.meshes = [];
    this.disposables = [];
    this.fanInstances = [];
  }
}
