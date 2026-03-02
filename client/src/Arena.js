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

export class Arena {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.meshes = [];

    this._buildArenaShell();
    this._buildTrimeshCollider();
    this._buildCarColliders();
    this._buildGoals();
    this._buildLighting();
    this._buildFieldMarkings();
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

    // Side walls — full height, offset just outside the curve endpoint
    // The car code handles the curved transition magnetically;
    // these walls are containment only.
    [-1, 1].forEach(side => {
      const body = new CANNON.Body({
        type: CANNON.Body.STATIC,
        position: new CANNON.Vec3(side * (HW + t / 2), H / 2, 0),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, H / 2, HL + t)));
      this.world.addBody(body);
    });

    // End walls (with goal openings)
    [-1, 1].forEach(side => {
      const z = side * (HL + t / 2);
      const leftW = HW - GW;

      const leftBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(-(GW + leftW / 2), H / 2, z),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      this.world.addBody(leftBody);

      const rightBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(GW + leftW / 2, H / 2, z),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      this.world.addBody(rightBody);

      const topH = (H - GH) / 2;
      const topBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, topH, t / 2)),
        position: new CANNON.Vec3(0, GH + topH, z),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      this.world.addBody(topBody);
    });
  }

  // ========== GOALS (same as before) ==========

  _buildGoals() {
    const gw = GW;
    const gh = GH;
    const gd = GD;
    const t = 0.5;

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

    // Goal bodies collide with both ball and car
    const goalGroup = COLLISION_GROUPS.ARENA_TRIMESH | COLLISION_GROUPS.ARENA_BOXES;
    const goalMask = COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;

    [-1, 1].forEach((side, idx) => {
      const zBase = side * HL;
      const zBack = zBase + side * gd;

      // Back wall of goal
      const backBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(gw, gh / 2, t / 2)),
        position: new CANNON.Vec3(0, gh / 2, zBack),
        collisionFilterGroup: goalGroup,
        collisionFilterMask: goalMask,
      });
      this.world.addBody(backBody);

      const backGeo = new THREE.BoxGeometry(gw * 2, gh, t);
      const backMesh = new THREE.Mesh(backGeo, goalMaterials[idx]);
      backMesh.position.set(0, gh / 2, zBack);
      this.scene.add(backMesh);

      // Side walls of goal
      [-1, 1].forEach((sx) => {
        const sideBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(t / 2, gh / 2, gd / 2)),
          position: new CANNON.Vec3(sx * gw, gh / 2, zBase + side * gd / 2),
          collisionFilterGroup: goalGroup,
          collisionFilterMask: goalMask,
        });
        this.world.addBody(sideBody);

        const sideGeo = new THREE.BoxGeometry(t, gh, gd);
        const sideMesh = new THREE.Mesh(sideGeo, goalMaterials[idx]);
        sideMesh.position.set(sx * gw, gh / 2, zBase + side * gd / 2);
        this.scene.add(sideMesh);
      });

      // Ceiling of goal
      const ceilBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(gw, t / 2, gd / 2)),
        position: new CANNON.Vec3(0, gh, zBase + side * gd / 2),
        collisionFilterGroup: goalGroup,
        collisionFilterMask: goalMask,
      });
      this.world.addBody(ceilBody);

      const ceilGeo = new THREE.BoxGeometry(gw * 2, t, gd);
      const ceilMesh = new THREE.Mesh(ceilGeo, goalMaterials[idx]);
      ceilMesh.position.set(0, gh, zBase + side * gd / 2);
      this.scene.add(ceilMesh);

      // Goal line glow on floor
      const lineGeo = new THREE.BoxGeometry(gw * 2, 0.05, 0.3);
      const lineMat = new THREE.MeshStandardMaterial({
        color: idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE,
        emissive: idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE,
        emissiveIntensity: 2,
      });
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.position.set(0, 0.03, zBase);
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
      const light = new THREE.PointLight(0x4466aa, 0.6, 80);
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
    const lineMat = new THREE.MeshStandardMaterial({
      color: COLORS.CYAN,
      emissive: COLORS.CYAN,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.6,
    });

    // Center line
    const centerGeo = new THREE.BoxGeometry(ARENA.WIDTH, 0.02, 0.2);
    const centerLine = new THREE.Mesh(centerGeo, lineMat);
    centerLine.position.y = 0.02;
    this.scene.add(centerLine);

    // Center circle
    const circleGeo = new THREE.RingGeometry(9.8, 10.2, 64);
    const circleMat = new THREE.MeshStandardMaterial({
      color: COLORS.CYAN,
      emissive: COLORS.CYAN,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const circle = new THREE.Mesh(circleGeo, circleMat);
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = 0.02;
    this.scene.add(circle);
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
