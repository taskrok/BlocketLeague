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

    // End walls (with goal openings) — shortened to stop at corner arc start
    [-1, 1].forEach(side => {
      const z = side * (HL + t / 2 + wallOutset);
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
    const wallOutset = 1.5;
    const group = COLLISION_GROUPS.ARENA_BOXES;
    const mask = COLLISION_GROUPS.CAR;

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
      const zBase = side * HL;
      const zBack = zBase + side * GD;

      // --- Car-containment box colliders ---

      // Back wall
      const backBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, GH / 2, t / 2)),
        position: new CANNON.Vec3(0, GH / 2, side * (HL + GD + t / 2 + wallOutset)),
        collisionFilterGroup: group,
        collisionFilterMask: mask,
      });
      this.world.addBody(backBody);

      // Side walls
      [-1, 1].forEach((sx) => {
        const sideBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(t / 2, GH / 2, GD / 2)),
          position: new CANNON.Vec3(sx * (GW + t / 2 + wallOutset), GH / 2, zBase + side * GD / 2),
          collisionFilterGroup: group,
          collisionFilterMask: mask,
        });
        this.world.addBody(sideBody);
      });

      // Ceiling
      const ceilBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, t / 2, GD / 2)),
        position: new CANNON.Vec3(0, GH + t / 2 + wallOutset, zBase + side * GD / 2),
        collisionFilterGroup: group,
        collisionFilterMask: mask,
      });
      this.world.addBody(ceilBody);

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
      line.position.set(0, 0.06, zBase);
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
