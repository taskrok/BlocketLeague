// ============================================
// Arena - Rounded arena with neon grid, dual collider system
// Trimesh for ball (sphere-trimesh works in cannon-es),
// simplified boxes/planes for car (box-trimesh does NOT work).
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ARENA, COLORS, COLLISION_GROUPS } from '../../shared/constants.js';
import { createArenaGeometry } from './ArenaGeometry.js';
import { createArenaMaterial } from './ArenaShader.js';
const logoSvgUrl = '/BlocketLeagueLogo.svg';

const HW = ARENA.WIDTH / 2;
const HL = ARENA.LENGTH / 2;
const H  = ARENA.HEIGHT;
const GW = ARENA.GOAL_WIDTH / 2;
const GH = ARENA.GOAL_HEIGHT;
const GD = ARENA.GOAL_DEPTH;
const R  = ARENA.CURVE_RADIUS;
const CR = ARENA.CORNER_RADIUS;  // XZ corner radius

export class Arena {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.meshes = [];

    this._buildArenaShell();
    this._buildGrassFloor();
    this._buildTrimeshCollider();
    this._buildCarColliders();
    this._buildGoals();
    this._buildLighting();
    this._buildFieldMarkings();
    this._buildFieldText();
    this._buildExteriorText();
  }

  // ========== GRASS FLOOR ==========

  _buildGrassFloor() {
    // Procedural striped grass shader — mowed-field look
    const grassMat = new THREE.ShaderMaterial({
      uniforms: {
        baseColor1: { value: new THREE.Color(0x2d7a2d) },  // lighter green stripe
        baseColor2: { value: new THREE.Color(0x1f5c1f) },  // darker green stripe
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
    const geometry = createArenaGeometry();
    const material = createArenaMaterial();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.arenaMesh = mesh;
  }

  // ========== TRIMESH COLLIDER (ball only) ==========

  _buildTrimeshCollider() {
    const geometry = this.arenaMesh.geometry;
    const posAttr = geometry.getAttribute('position');
    const index = geometry.index;

    const vertices = new Float32Array(posAttr.array);
    const indices = new Int32Array(index.array);

    const trimesh = new CANNON.Trimesh(
      Array.from(vertices),
      Array.from(indices)
    );

    this.trimeshBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      collisionFilterGroup: COLLISION_GROUPS.ARENA_TRIMESH,
      collisionFilterMask: COLLISION_GROUPS.BALL,
    });
    this.trimeshBody.addShape(trimesh);
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

    const goalMaterials = [
      new THREE.MeshStandardMaterial({
        color: COLORS.GOAL_BLUE,
        emissive: COLORS.GOAL_BLUE,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.3,
      }),
      new THREE.MeshStandardMaterial({
        color: COLORS.GOAL_ORANGE,
        emissive: COLORS.GOAL_ORANGE,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.3,
      }),
    ];

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

      // Transparent back wall indicator
      const backGeo = new THREE.BoxGeometry(GW * 2, GH, 0.5);
      const backMesh = new THREE.Mesh(backGeo, goalMaterials[idx]);
      backMesh.position.set(0, GH / 2, zBack);
      this.scene.add(backMesh);

      // Goal line glow on floor
      const lineGeo = new THREE.BoxGeometry(GW * 2, 0.05, 0.3);
      const lineMat = new THREE.MeshStandardMaterial({
        color: idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE,
        emissive: idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE,
        emissiveIntensity: 2,
      });
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.position.set(0, 0.06, zMouth);
      this.scene.add(line);
    });
  }

  // ========== LIGHTING ==========

  _buildLighting() {
    const ambient = new THREE.AmbientLight(COLORS.AMBIENT, 0.8);
    this.scene.add(ambient);

    const positions = [
      [0, H - 1, -ARENA.LENGTH / 4],
      [0, H - 1, ARENA.LENGTH / 4],
      [-ARENA.WIDTH / 3, H - 1, 0],
      [ARENA.WIDTH / 3, H - 1, 0],
    ];

    positions.forEach((pos) => {
      const light = new THREE.PointLight(0x4466aa, 0.6, 110);
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

  _buildFieldMarkings() {
    const blueColor = 0x0088ff;
    const redColor = 0xff2200;

    // Center line — neutral white divider
    const centerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.5,
    });
    const centerGeo = new THREE.BoxGeometry(ARENA.WIDTH, 0.02, 0.2);
    const centerLine = new THREE.Mesh(centerGeo, centerMat);
    centerLine.position.y = 0.06;
    this.scene.add(centerLine);

    // Center circle — blue half (negative Z, player 1 side)
    // After rotation.x = -PI/2: theta=PI..2PI maps to -Z half
    const blueRingGeo = new THREE.RingGeometry(13, 13.4, 32, 1, Math.PI, Math.PI);
    const blueRingMat = new THREE.MeshStandardMaterial({
      color: blueColor,
      emissive: blueColor,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const blueRing = new THREE.Mesh(blueRingGeo, blueRingMat);
    blueRing.rotation.x = -Math.PI / 2;
    blueRing.position.y = 0.06;
    this.scene.add(blueRing);

    // Center circle — red half (positive Z, player 2 side)
    // After rotation.x = -PI/2: theta=0..PI maps to +Z half
    const redRingGeo = new THREE.RingGeometry(13, 13.4, 32, 1, 0, Math.PI);
    const redRingMat = new THREE.MeshStandardMaterial({
      color: redColor,
      emissive: redColor,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const redRing = new THREE.Mesh(redRingGeo, redRingMat);
    redRing.rotation.x = -Math.PI / 2;
    redRing.position.y = 0.06;
    this.scene.add(redRing);
  }

  // ========== FIELD TEXT (painted on grass) ==========

  _buildFieldText() {
    const scene = this.scene;
    const meshes = this.meshes;

    // SVG dimensions from viewBox
    const svgW = 889;
    const svgH = 507;

    // Height stays the same, narrow the width to fix stretched look
    const planeWidth = 28.5;
    const planeLength = planeWidth * (svgW / svgH);

    const geo = new THREE.PlaneGeometry(planeLength, planeWidth);
    geo.rotateX(-Math.PI / 2);

    // Load SVG as image → canvas → texture
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = Math.round(2048 * (svgH / svgW));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        emissive: 0xffffff,
        emissiveIntensity: 0.2,
        emissiveMap: texture,
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
    };
    img.src = logoSvgUrl;
  }

  // ========== EXTERIOR NEON TEXT ==========

  _buildExteriorText() {
    const text = 'HIGH PING HEROES';

    // Render neon block letters to canvas
    const canvas = document.createElement('canvas');
    canvas.width = 4096;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // Black fill — additive blending makes black invisible
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.font = '900 260px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Neon glow: layered soft shadows (outer → inner)
    [
      { blur: 80, color: '#00ffff', alpha: 0.08 },
      { blur: 40, color: '#00ffff', alpha: 0.15 },
      { blur: 20, color: '#00ffff', alpha: 0.3 },
      { blur: 8,  color: '#66ffff', alpha: 0.6 },
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
    ctx.fillStyle = '#eeffff';
    ctx.fillText(text, cx, cy);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });

    const aspect = canvas.width / canvas.height;
    const textH = 12;
    const textW = textH * aspect;
    const geo = new THREE.PlaneGeometry(textW, textH);
    const offset = 1.5;
    const yPos = H * 0.45;

    // Place on side walls only (not goal ends)
    // Right wall — faces +X (toward inside of arena)
    const right = new THREE.Mesh(geo, mat);
    right.position.set(HW + offset, yPos, 0);
    right.rotation.y = -Math.PI / 2;
    right.frustumCulled = false;
    right.renderOrder = 999;
    this.scene.add(right);

    // Left wall — faces -X (toward inside of arena)
    const left = new THREE.Mesh(geo, mat);
    left.position.set(-HW - offset, yPos, 0);
    left.rotation.y = Math.PI / 2;
    left.frustumCulled = false;
    left.renderOrder = 999;
    this.scene.add(left);
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
