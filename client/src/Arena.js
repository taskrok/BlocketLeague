// ============================================
// Arena - Rounded arena with neon grid, dual collider system
// Trimesh for ball (sphere-trimesh works in cannon-es),
// simplified boxes/planes for car (box-trimesh does NOT work).
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ARENA, COLORS, COLLISION_GROUPS, BOOST_PAD_LAYOUT } from '../../shared/constants.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getArenaVisualGeometry, getArenaTrimeshData } from './ArenaGeometry.js';
import { createArenaMaterial } from './ArenaShader.js';
import { ARENA_THEMES } from './ArenaThemes.js';
const logoSvgUrl = '/BlocketLeagueLogo.svg';

const HW = ARENA.WIDTH / 2;
const HL = ARENA.LENGTH / 2;
const H  = ARENA.HEIGHT;
const GW = ARENA.GOAL_WIDTH / 2;
const GH = ARENA.GOAL_HEIGHT;
const GD = ARENA.GOAL_DEPTH;
const R  = ARENA.CURVE_RADIUS;
const CR = ARENA.CORNER_RADIUS;  // XZ corner radius

// ============================================
// Module-level caches — shared across `new Arena()` calls (one Game per match).
//
// Game.destroy() traverses the scene and calls dispose() on every geometry,
// material and texture it finds, including these cached objects. That is safe:
// three's dispose() only releases GPU-side resources and keeps the CPU data
// (BufferAttribute arrays / the canvas backing a CanvasTexture), so the next
// renderer that encounters the object simply re-uploads it. Nothing here needs
// to be re-created after a dispose.
// ============================================

// Ball-collision trimesh shape. Trimesh builds an octree in its constructor,
// so share one instance between bodies. cannon-es Body.addShape only writes
// `shape.body` (never read back), so a Shape can belong to several bodies.
let cachedTrimeshShape = null;
function getArenaTrimeshShape() {
  if (!cachedTrimeshShape) {
    const { vertices, indices } = getArenaTrimeshData();
    cachedTrimeshShape = new CANNON.Trimesh(vertices, indices);
  }
  return cachedTrimeshShape;
}

// Field logo (SVG -> canvas -> texture). Async; cached as a promise so a
// second Arena resolves immediately and never re-rasterises the SVG.
const LOGO_SVG_W = 889;   // SVG viewBox dimensions
const LOGO_SVG_H = 507;
const LOGO_TEX_W = 1024;  // was 2048 — logo is 28.5 units tall on the field, this is plenty
let logoTexturePromise = null;
function loadLogoTexture() {
  if (!logoTexturePromise) {
    logoTexturePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = LOGO_TEX_W;
        canvas.height = Math.round(LOGO_TEX_W * (LOGO_SVG_H / LOGO_SVG_W));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        resolve(texture);
      };
      img.onerror = (e) => {
        logoTexturePromise = null; // allow a retry next match
        reject(e);
      };
      img.src = logoSvgUrl;
    });
  }
  return logoTexturePromise;
}

// Exterior neon text, keyed by text + glow colour (theme-dependent).
const EXT_TEXT_W = 2048;  // was 4096x512
const EXT_TEXT_H = 256;
const exteriorTextTextures = new Map();
function getExteriorTextTexture(text, glowColor) {
  const key = `${text}|${glowColor}`;
  let texture = exteriorTextTextures.get(key);
  if (texture) return texture;

  const canvas = document.createElement('canvas');
  canvas.width = EXT_TEXT_W;
  canvas.height = EXT_TEXT_H;
  const ctx = canvas.getContext('2d');

  // Black fill — additive blending makes black invisible
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  // Font + blur radii are half the old 4096x512 values so the look is unchanged
  ctx.font = '900 130px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const glowHex = '#' + new THREE.Color(glowColor).getHexString();
  const glowBright = '#' + new THREE.Color(glowColor).lerp(new THREE.Color(0xffffff), 0.4).getHexString();
  const coreColor = '#' + new THREE.Color(glowColor).lerp(new THREE.Color(0xffffff), 0.8).getHexString();

  // Neon glow: layered soft shadows (outer -> inner)
  [
    { blur: 40, color: glowHex, alpha: 0.08 },
    { blur: 20, color: glowHex, alpha: 0.15 },
    { blur: 10, color: glowHex, alpha: 0.3 },
    { blur: 4,  color: glowBright, alpha: 0.6 },
  ].forEach(({ blur, color, alpha }) => {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  });

  // Bright core
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = coreColor;
  ctx.fillText(text, cx, cy);

  texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  exteriorTextTextures.set(key, texture);
  return texture;
}

// Unlit stand-in for the old `MeshStandardMaterial({ color: c, emissive: c,
// emissiveIntensity: k })` decals: emissive k plus roughly 0.35 of ambient-lit
// base colour. Values above 1 still feed the bloom pass like the originals.
function emissiveBasicColor(hex, emissiveIntensity) {
  return new THREE.Color(hex).multiplyScalar(emissiveIntensity + 0.35);
}

export class Arena {
  constructor(scene, world, theme = null) {
    this.scene = scene;
    this.world = world;
    this.meshes = [];
    this.theme = theme || ARENA_THEMES[0];

    this._buildArenaShell();
    this._buildGrassFloor();
    this._buildTrimeshCollider();
    this._buildCarColliders();
    this._buildGoals();
    this._buildLighting();
    this._buildFieldMarkings();
    this._buildFieldText();
    this._buildExteriorText();

    // Reactive grid: the neon shell's emissive strength and colours are
    // uniforms, so the whole arena can pulse on hits/goals/kickoff for the
    // cost of a few uniform writes (no material or geometry changes).
    this._gridUniforms = this.arenaMesh.material.userData.gridUniforms || null;
    this._gridBaseStrength = this.theme.gridEmissive;
    this._gridBaseBlue = new THREE.Color(this.theme.gridColor1);
    this._gridBaseRed = new THREE.Color(this.theme.gridColor2);
    this._flashColor = new THREE.Color(0xffffff);
    this._pulse = 0;        // additive brightness, decays fast
    this._flash = 0;        // 0..1 blend toward _flashColor, decays slower
    this._flashDirty = false;
    this._time = 0;
  }

  // ========== REACTIVE GRID ==========

  /** Brighten the whole grid briefly. 0.2 = subtle tick, 1.5 = goal. */
  pulse(strength) {
    if (strength > this._pulse) this._pulse = strength;
  }

  /** Wash the grid toward a colour (e.g. scoring team), fading back over ~1.5 s. */
  flashColor(color, strength = 1) {
    this._flashColor.set(color);
    this._flash = Math.max(this._flash, strength);
    this._flashDirty = true;
  }

  update(dt) {
    const u = this._gridUniforms;
    if (!u) return;
    this._time += dt;

    if (this._pulse > 0) {
      this._pulse *= Math.exp(-4.5 * dt);
      if (this._pulse < 0.005) this._pulse = 0;
    }
    // Slow ambient breathing so the arena never reads as completely static
    const breathe = 1 + 0.05 * Math.sin(this._time * 1.1);
    u.gridEmissiveStrength.value = this._gridBaseStrength * (breathe + this._pulse);

    if (this._flashDirty) {
      this._flash *= Math.exp(-1.8 * dt);
      if (this._flash < 0.01) {
        this._flash = 0;
        this._flashDirty = false;
      }
      u.gridColorBlue.value.copy(this._gridBaseBlue).lerp(this._flashColor, this._flash);
      u.gridColorRed.value.copy(this._gridBaseRed).lerp(this._flashColor, this._flash);
    }
  }

  // ========== GRASS FLOOR ==========

  _buildGrassFloor() {
    // Procedural striped grass shader — mowed-field look
    const grassMat = new THREE.ShaderMaterial({
      uniforms: {
        baseColor1: { value: new THREE.Color(this.theme.grass1) },
        baseColor2: { value: new THREE.Color(this.theme.grass2) },
        stripeWidth: { value: 8.0 },                        // width of each mow stripe
        arenaHalfW: { value: HW },
        arenaHalfL: { value: HL },
        curveR: { value: R },
        cornerR: { value: CR },
      },
      vertexShader: `
        varying vec2 vWorldXZ;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldXZ = worldPos.xz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor1;
        uniform vec3 baseColor2;
        uniform float stripeWidth;
        uniform float arenaHalfW;
        uniform float arenaHalfL;
        uniform float curveR;
        uniform float cornerR;

        varying vec2 vWorldXZ;

        void main() {
          // Mow stripes along Z axis
          float stripe = sin(vWorldXZ.y / stripeWidth * 3.14159) * 0.5 + 0.5;
          vec3 col = mix(baseColor2, baseColor1, stripe);

          // Subtle per-blade noise via high-freq sin
          float noise = fract(sin(dot(vWorldXZ, vec2(12.9898, 78.233))) * 43758.5453);
          col += (noise - 0.5) * 0.03;

          // Fade out near walls so the neon floor underneath peeks through
          float dx = max(0.0, abs(vWorldXZ.x) - (arenaHalfW - curveR));
          float dz = max(0.0, abs(vWorldXZ.y) - (arenaHalfL - curveR));
          float edgeDist = max(dx, dz);
          float fade = 1.0 - smoothstep(0.0, curveR * 0.8, edgeDist);

          // Also fade at XZ corners (rounded)
          if (dx > 0.0 && dz > 0.0) {
            float cornerDist = length(vec2(dx, dz));
            fade = 1.0 - smoothstep(0.0, curveR * 0.8, cornerDist);
          }

          gl_FragColor = vec4(col, fade);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    const grassGeo = new THREE.PlaneGeometry(ARENA.WIDTH, ARENA.LENGTH);
    grassGeo.rotateX(-Math.PI / 2);
    const grassMesh = new THREE.Mesh(grassGeo, grassMat);
    grassMesh.position.y = 0.03; // just above the shell floor
    grassMesh.renderOrder = 1;
    this.scene.add(grassMesh);
    this.meshes.push(grassMesh);
  }

  // ========== VISUAL MESH (single curved geometry) ==========

  _buildArenaShell() {
    // Geometry is theme-independent and cached at module scope (see ArenaGeometry.js)
    const geometry = getArenaVisualGeometry();
    const material = createArenaMaterial(this.theme);

    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.arenaMesh = mesh;
  }

  // ========== TRIMESH COLLIDER (ball only) ==========

  _buildTrimeshCollider() {
    // Coarser tessellation than the visual mesh (same analytic curves), built
    // and octree'd once per process — see getArenaTrimeshShape().
    this.trimeshBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      collisionFilterGroup: COLLISION_GROUPS.ARENA_TRIMESH,
      collisionFilterMask: COLLISION_GROUPS.BALL,
    });
    this.trimeshBody.addShape(getArenaTrimeshShape());
    this.world.addBody(this.trimeshBody);

    // Backup planes for ball — cannon-es trimesh can be unreliable,
    // these flat surfaces prevent the ball from ever escaping the arena.
    // The trimesh still handles curved surfaces (ball hits curves first).
    const bg = COLLISION_GROUPS.ARENA_TRIMESH;
    const bm = COLLISION_GROUPS.BALL;

    // Floor
    const ballFloor = new CANNON.Body({ type: CANNON.Body.STATIC,
      collisionFilterGroup: bg, collisionFilterMask: bm });
    ballFloor.addShape(new CANNON.Plane());
    ballFloor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ballFloor);

    // Ceiling
    const ballCeil = new CANNON.Body({ type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(0, H, 0),
      collisionFilterGroup: bg, collisionFilterMask: bm });
    ballCeil.addShape(new CANNON.Plane());
    ballCeil.quaternion.setFromEuler(Math.PI / 2, 0, 0);
    this.world.addBody(ballCeil);

    // Side walls
    const wallConfigs = [
      { pos: [-HW, 0, 0], rot: [0, Math.PI / 2, 0] },
      { pos: [HW, 0, 0],  rot: [0, -Math.PI / 2, 0] },
    ];
    wallConfigs.forEach(cfg => {
      const b = new CANNON.Body({ type: CANNON.Body.STATIC,
        position: new CANNON.Vec3(...cfg.pos),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      b.addShape(new CANNON.Plane());
      b.quaternion.setFromEuler(...cfg.rot);
      this.world.addBody(b);
    });

    // End walls (with goal cutout — use boxes)
    [-1, 1].forEach(side => {
      const z = side * HL;
      const t = ARENA.WALL_THICKNESS;
      const leftW = HW - GW;

      // Left section
      const lb = new CANNON.Body({ type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(-(GW + leftW / 2), H / 2, z),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      this.world.addBody(lb);

      // Right section
      const rb = new CANNON.Body({ type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(GW + leftW / 2, H / 2, z),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      this.world.addBody(rb);

      // Top section (above goal)
      const topH = (H - GH) / 2;
      const tb = new CANNON.Body({ type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, topH, t / 2)),
        position: new CANNON.Vec3(0, GH + topH, z),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      this.world.addBody(tb);
    });
  }

  // ========== SIMPLIFIED BOX/PLANE COLLIDERS (car only) ==========

  _buildCarColliders() {
    const group = COLLISION_GROUPS.ARENA_BOXES;
    const mask = COLLISION_GROUPS.CAR;
    const t = ARENA.WALL_THICKNESS;

    // Flat extents — where the straight walls end before the corner arc begins
    const cornerFlatHW = HW - CR;  // 45 - 20 = 25
    const cornerFlatHL = HL - CR;  // 65 - 20 = 45

    // Floor plane
    const floorBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      collisionFilterGroup: group, collisionFilterMask: mask,
    });
    floorBody.addShape(new CANNON.Plane());
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floorBody);

    // Ceiling box
    const ceilBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(0, H + t / 2, 0),
      collisionFilterGroup: group, collisionFilterMask: mask,
    });
    ceilBody.addShape(new CANNON.Box(new CANNON.Vec3(HW + t, t / 2, HL + t)));
    this.world.addBody(ceilBody);

    // Wall boxes are pushed 1.5 units outward from the visual wall surface.
    // This prevents the car's tilted physics box from clipping the inner face
    // during the floor-to-wall fillet transition. The magnetic snap handles
    // precise wall contact; these boxes are last-resort containment.
    const wallOutset = 1.5;

    // Side walls — shortened to stop at corner arc start
    [-1, 1].forEach(side => {
      const body = new CANNON.Body({
        type: CANNON.Body.STATIC,
        position: new CANNON.Vec3(side * (HW + t / 2 + wallOutset), H / 2, 0),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, H / 2, cornerFlatHL)));
      this.world.addBody(body);
    });

    // End walls (with goal openings) — flush (no wallOutset) so the opening
    // aligns exactly with the goal side walls and doesn't overhang into the goal
    [-1, 1].forEach(side => {
      const z = side * (HL + t / 2);
      // Width from goal edge to corner start
      const sectionW = cornerFlatHW - GW;

      if (sectionW > 0) {
        // Left section: from -cornerFlatHW to -GW
        const leftBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(sectionW / 2, H / 2, t / 2)),
          position: new CANNON.Vec3(-(GW + sectionW / 2), H / 2, z),
          collisionFilterGroup: group, collisionFilterMask: mask,
        });
        this.world.addBody(leftBody);

        // Right section: from +GW to +cornerFlatHW
        const rightBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(sectionW / 2, H / 2, t / 2)),
          position: new CANNON.Vec3(GW + sectionW / 2, H / 2, z),
          collisionFilterGroup: group, collisionFilterMask: mask,
        });
        this.world.addBody(rightBody);
      }

      // Top section above goal
      const topH = (H - GH) / 2;
      const topBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, topH, t / 2)),
        position: new CANNON.Vec3(0, GH + topH, z),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      this.world.addBody(topBody);
    });

    // Corner arc colliders — approximate each corner with angled box segments
    const CORNER_SEGMENTS = 6;
    const segAngle = (Math.PI / 2) / CORNER_SEGMENTS;
    const chordHalf = (CR + t) * Math.tan(segAngle / 2);

    // 4 corners: (sx, sz) = sign of X center, sign of Z center
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      const ccx = sx * cornerFlatHW;
      const ccz = sz * cornerFlatHL;

      for (let i = 0; i < CORNER_SEGMENTS; i++) {
        const theta = (i + 0.5) * segAngle;

        // Push corner segments outward by wallOutset too
        const r = CR + t / 2 + wallOutset;
        const px = ccx + sx * r * Math.sin(theta);
        const pz = ccz + sz * r * Math.cos(theta);

        const yRot = Math.atan2(sx * Math.sin(theta), sz * Math.cos(theta));

        const body = new CANNON.Body({
          type: CANNON.Body.STATIC,
          position: new CANNON.Vec3(px, H / 2, pz),
          collisionFilterGroup: group, collisionFilterMask: mask,
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(chordHalf, H / 2, t / 2)));
        body.quaternion.setFromEuler(0, yRot, 0);
        this.world.addBody(body);
      }
    });
  }

  // ========== GOALS ==========
  // Ball collisions handled by trimesh (which now includes goal interior geometry).
  // Only car-containment box colliders here (same pattern as arena car colliders).
  // Visual overlays are decoration only — no physics.

  _buildGoals() {
    const t = ARENA.WALL_THICKNESS;
    const group = COLLISION_GROUPS.ARENA_BOXES;
    const mask = COLLISION_GROUPS.CAR;
    const fr = ARENA.GOAL_FILLET_RADIUS; // interior corner rounding radius
    const SEGS = 5; // segments per quarter-arc fillet
    const postW = 0.3;

    [-1, 1].forEach((side, idx) => {
      const zMouth = side * HL;
      const zBack = zMouth + side * GD;

      // --- Car-containment box colliders (flush, with fillet arcs) ---

      // Back wall — narrowed to leave room for side-back fillet arcs
      const backBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW - fr, GH / 2, t / 2)),
        position: new CANNON.Vec3(0, GH / 2, side * (HL + GD) + side * t / 2),
        collisionFilterGroup: group,
        collisionFilterMask: mask,
      });
      this.world.addBody(backBody);

      // Side walls — shortened to stop before back fillet zone
      [-1, 1].forEach((sx) => {
        const flatDepth = (GD - fr) / 2;
        const sideBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(t / 2, GH / 2, flatDepth)),
          position: new CANNON.Vec3(sx * (GW + t / 2), GH / 2, zMouth + side * flatDepth),
          collisionFilterGroup: group,
          collisionFilterMask: mask,
        });
        this.world.addBody(sideBody);
      });

      // Ceiling
      const ceilBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, t / 2, GD / 2)),
        position: new CANNON.Vec3(0, GH + t / 2, zMouth + side * GD / 2),
        collisionFilterGroup: group,
        collisionFilterMask: mask,
      });
      this.world.addBody(ceilBody);

      // Back corner fillet arcs (where side wall meets back wall)
      const segAngle = (Math.PI / 2) / SEGS;
      const chordHalf = (fr + t / 2) * Math.tan(segAngle / 2);

      [-1, 1].forEach(sx => {
        const cx = sx * (GW - fr);
        const cz = side * (HL + GD - fr);

        for (let i = 0; i < SEGS; i++) {
          const theta = (i + 0.5) * segAngle;
          const r = fr + t / 2;
          const px = cx + sx * r * Math.sin(theta);
          const pz = cz + side * r * Math.cos(theta);
          const yRot = Math.atan2(sx * Math.sin(theta), side * Math.cos(theta));

          const body = new CANNON.Body({
            type: CANNON.Body.STATIC,
            position: new CANNON.Vec3(px, GH / 2, pz),
            collisionFilterGroup: group,
            collisionFilterMask: mask,
          });
          body.addShape(new CANNON.Box(new CANNON.Vec3(chordHalf, GH / 2, t / 2)));
          body.quaternion.setFromEuler(0, yRot, 0);
          this.world.addBody(body);
        }
      });

      // --- Visual overlays (decoration only, no physics) ---

      // Goal frame — neon posts + crossbar outline + goal line at the goal mouth.
      // Purely emissive, so unlit; the four static boxes share one material and
      // are merged into a single draw call per goal.
      const gc = idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE;
      const frameMat = new THREE.MeshBasicMaterial({ color: emissiveBasicColor(gc, 2) });

      const frameGeo = mergeGeometries([
        new THREE.BoxGeometry(postW, GH, postW).translate(-GW, GH / 2, zMouth),          // left post
        new THREE.BoxGeometry(postW, GH, postW).translate(GW, GH / 2, zMouth),           // right post
        new THREE.BoxGeometry(GW * 2 + postW, postW, postW).translate(0, GH, zMouth),    // crossbar
        new THREE.BoxGeometry(GW * 2, 0.05, 0.3).translate(0, 0.06, zMouth),             // goal line glow on floor
      ]);
      const frame = new THREE.Mesh(frameGeo, frameMat);
      this.scene.add(frame);
      this.meshes.push(frame);
    });
  }

  // ========== LIGHTING ==========

  _buildLighting() {
    const ambient = new THREE.AmbientLight(this.theme.ambientColor, 0.8);
    this.scene.add(ambient);

    const positions = [
      [0, H - 1, -ARENA.LENGTH / 4],
      [0, H - 1, ARENA.LENGTH / 4],
      [-ARENA.WIDTH / 3, H - 1, 0],
      [ARENA.WIDTH / 3, H - 1, 0],
    ];

    positions.forEach((pos) => {
      const light = new THREE.PointLight(this.theme.lightColor, 0.6, 110);
      light.position.set(...pos);
      this.scene.add(light);
    });

    const goalLight1 = new THREE.PointLight(COLORS.GOAL_BLUE, 0.8, 30);
    goalLight1.position.set(0, 5, -HL);
    this.scene.add(goalLight1);

    const goalLight2 = new THREE.PointLight(COLORS.GOAL_ORANGE, 0.8, 30);
    goalLight2.position.set(0, 5, HL);
    this.scene.add(goalLight2);
  }

  // ========== FIELD MARKINGS ==========

  // All markings are flat emissive decals: unlit MeshBasicMaterial, one
  // material per distinct colour/opacity, static geometry merged per material.
  // None of these materials are mutated at runtime, so sharing is safe.

  _buildFieldMarkings() {
    const blueColor = this.theme.markingBlue;
    const redColor = this.theme.markingRed;

    // Center line — neutral white divider
    const centerMat = new THREE.MeshBasicMaterial({
      color: emissiveBasicColor(0xffffff, 0.6),
      transparent: true,
      opacity: 0.5,
    });
    const centerGeo = new THREE.BoxGeometry(ARENA.WIDTH, 0.02, 0.2);
    const centerLine = new THREE.Mesh(centerGeo, centerMat);
    centerLine.position.y = 0.06;
    this.scene.add(centerLine);
    this.meshes.push(centerLine);

    // Center circle — blue half (negative Z, player 1 side)
    // After rotation.x = -PI/2: theta=PI..2PI maps to -Z half
    const blueRingGeo = new THREE.RingGeometry(13, 13.4, 32, 1, Math.PI, Math.PI);
    const blueRingMat = new THREE.MeshBasicMaterial({
      color: emissiveBasicColor(blueColor, 0.8),
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const blueRing = new THREE.Mesh(blueRingGeo, blueRingMat);
    blueRing.rotation.x = -Math.PI / 2;
    blueRing.position.y = 0.06;
    this.scene.add(blueRing);
    this.meshes.push(blueRing);

    // Center circle — red half (positive Z, player 2 side)
    // After rotation.x = -PI/2: theta=0..PI maps to +Z half
    const redRingGeo = new THREE.RingGeometry(13, 13.4, 32, 1, 0, Math.PI);
    const redRingMat = new THREE.MeshBasicMaterial({
      color: emissiveBasicColor(redColor, 0.8),
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const redRing = new THREE.Mesh(redRingGeo, redRingMat);
    redRing.rotation.x = -Math.PI / 2;
    redRing.position.y = 0.06;
    this.scene.add(redRing);
    this.meshes.push(redRing);

    // ---- White 40%-opacity markings: 6 boost-pad circles + 2 arched boundary
    //      lines. Same colour/opacity, so one material and one merged mesh. ----
    const boostCircleRadius = 6;
    const boostCircleThickness = 0.3;
    const markY = 0.12;

    // One ring geometry, pre-rotated flat, cloned+translated per pad
    const circleGeo = new THREE.RingGeometry(
      boostCircleRadius, boostCircleRadius + boostCircleThickness, 32
    ).rotateX(-Math.PI / 2);

    // Large pad world positions: [0]=back-left, [1]=back-right, [2]=mid-left, [3]=mid-right, [4]=front-left, [5]=front-right
    const largePads = BOOST_PAD_LAYOUT.large.map(p => ({
      x: p.x * HW,
      z: p.z * HL,
    }));

    const whiteParts = largePads.map(p => circleGeo.clone().translate(p.x, markY, p.z));

    // Arched boundary lines — one continuous arch per side through all 3 large pads,
    // bowing outward toward the wall
    const lineThickness = 0.25;
    const arcSegments = 64;

    // Left chain: pads 0 → 2 → 4 (back-left → mid-left → front-left)
    // Right chain: pads 1 → 3 → 5 (back-right → mid-right → front-right)
    const chains = [
      [largePads[0], largePads[2], largePads[4]],
      [largePads[1], largePads[3], largePads[5]],
    ];

    chains.forEach((chainPads) => {
      // Use the 3 pad positions as control points — CatmullRom will arch through all of them
      const controlPoints = chainPads.map(p => new THREE.Vector3(p.x, markY, p.z));
      const curve = new THREE.CatmullRomCurve3(controlPoints);
      whiteParts.push(new THREE.TubeGeometry(curve, arcSegments, lineThickness / 2, 4, false));
    });

    const whiteMat = new THREE.MeshBasicMaterial({
      color: emissiveBasicColor(0xffffff, 0.6),
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide, // rings are single-sided planes; tubes don't care
    });
    const whiteGeo = mergeGeometries(whiteParts); // sources were never uploaded; nothing to dispose

    const whiteMarkings = new THREE.Mesh(whiteGeo, whiteMat);
    this.scene.add(whiteMarkings);
    this.meshes.push(whiteMarkings);
  }

  // ========== FIELD TEXT (painted on grass) ==========

  _buildFieldText() {
    const scene = this.scene;
    const meshes = this.meshes;

    // Height stays the same, narrow the width to fix stretched look
    const planeWidth = 28.5;
    const planeLength = planeWidth * (LOGO_SVG_W / LOGO_SVG_H);

    const geo = new THREE.PlaneGeometry(planeLength, planeWidth);
    geo.rotateX(-Math.PI / 2);

    // Texture is rasterised once per process and cached (see loadLogoTexture)
    loadLogoTexture().then((texture) => {
      // Unlit: old material was textured colour under ambient (~0.35) plus the
      // same texture as emissive at 0.2 — fold both into a single tint.
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        color: new THREE.Color(0xffffff).multiplyScalar(0.55),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

      // One on each sideline, rotated so logo runs along the Z axis
      const xOffset = HW * 0.55;
      [-1, 1].forEach(side => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(side * xOffset, 0.03, 0);
        mesh.rotation.y = side * Math.PI / 2;
        mesh.renderOrder = 2;
        scene.add(mesh);
        meshes.push(mesh);
      });
    }).catch((e) => {
      console.warn('[Arena] field logo failed to load', e);
    });
  }

  // ========== EXTERIOR NEON TEXT ==========

  _buildExteriorText() {
    const text = this.theme.exteriorText || 'HIGH PING HEROES';
    const gc = this.theme.exteriorGlow || 0x00ffff;

    // Neon block letters rendered to a canvas once per (text, glow) and cached
    const texture = getExteriorTextTexture(text, gc);

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // glows through the (transparent) wall shell regardless of draw order
      side: THREE.DoubleSide,
    });

    const aspect = EXT_TEXT_W / EXT_TEXT_H;
    const textH = 12;
    const textW = textH * aspect;
    const geo = new THREE.PlaneGeometry(textW, textH);
    const offset = 1.5;
    const yPos = H * 0.45;

    // Place on side walls only (not goal ends). Frustum culling is left on:
    // the plane has a proper bounding sphere, so it is only drawn when in view.
    // Right wall — faces +X (toward inside of arena)
    const right = new THREE.Mesh(geo, mat);
    right.position.set(HW + offset, yPos, 0);
    right.rotation.y = -Math.PI / 2;
    right.renderOrder = 999;
    this.scene.add(right);
    this.meshes.push(right);

    // Left wall — faces -X (toward inside of arena)
    const left = new THREE.Mesh(geo, mat);
    left.position.set(-HW - offset, yPos, 0);
    left.rotation.y = Math.PI / 2;
    left.renderOrder = 999;
    this.scene.add(left);
    this.meshes.push(left);
  }

  // ========== GOAL DETECTION ==========

  isInGoal(position) {
    const gw = GW;
    const gh = GH;
    const gd = GD;

    if (Math.abs(position.x) < gw && position.y < gh) {
      if (position.z < -(HL) && position.z > -(HL + gd)) {
        return 1;
      }
      if (position.z > HL && position.z < HL + gd) {
        return 2;
      }
    }
    return 0;
  }
}
