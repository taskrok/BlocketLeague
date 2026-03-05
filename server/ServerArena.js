// ============================================
// ServerArena — Headless arena physics (no rendering)
// Builds trimesh + box colliders for server-side physics
// ============================================

import * as CANNON from 'cannon-es';
import { ARENA, COLLISION_GROUPS } from '../shared/constants.js';
import { createArenaGeometry } from '../client/src/ArenaGeometry.js';

const HW = ARENA.WIDTH / 2;
const HL = ARENA.LENGTH / 2;
const H  = ARENA.HEIGHT;
const GW = ARENA.GOAL_WIDTH / 2;
const GH = ARENA.GOAL_HEIGHT;
const GD = ARENA.GOAL_DEPTH;
const R  = ARENA.CURVE_RADIUS;
const CR = ARENA.CORNER_RADIUS;

export class ServerArena {
  constructor(world) {
    this.world = world;
    this._buildTrimeshCollider();
    this._buildCarColliders();
    this._buildGoals();
  }

  // ========== TRIMESH COLLIDER (ball only) ==========

  _buildTrimeshCollider() {
    const geometry = createArenaGeometry();
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

      const lb = new CANNON.Body({ type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(-(GW + leftW / 2), H / 2, z),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      this.world.addBody(lb);

      const rb = new CANNON.Body({ type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(leftW / 2, H / 2, t / 2)),
        position: new CANNON.Vec3(GW + leftW / 2, H / 2, z),
        collisionFilterGroup: bg, collisionFilterMask: bm });
      this.world.addBody(rb);

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
    const cornerFlatHW = HW - CR;
    const cornerFlatHL = HL - CR;

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

    const wallOutset = 1.5;

    // Side walls
    [-1, 1].forEach(side => {
      const body = new CANNON.Body({
        type: CANNON.Body.STATIC,
        position: new CANNON.Vec3(side * (HW + t / 2 + wallOutset), H / 2, 0),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, H / 2, cornerFlatHL)));
      this.world.addBody(body);
    });

    // End walls with goal openings
    [-1, 1].forEach(side => {
      const z = side * (HL + t / 2 + wallOutset);
      const sectionW = cornerFlatHW - GW;

      if (sectionW > 0) {
        const leftBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(sectionW / 2, H / 2, t / 2)),
          position: new CANNON.Vec3(-(GW + sectionW / 2), H / 2, z),
          collisionFilterGroup: group, collisionFilterMask: mask,
        });
        this.world.addBody(leftBody);

        const rightBody = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(sectionW / 2, H / 2, t / 2)),
          position: new CANNON.Vec3(GW + sectionW / 2, H / 2, z),
          collisionFilterGroup: group, collisionFilterMask: mask,
        });
        this.world.addBody(rightBody);
      }

      const topH = (H - GH) / 2;
      const topBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(GW, topH, t / 2)),
        position: new CANNON.Vec3(0, GH + topH, z),
        collisionFilterGroup: group, collisionFilterMask: mask,
      });
      this.world.addBody(topBody);
    });

    // Corner arc colliders
    const CORNER_SEGMENTS = 6;
    const segAngle = (Math.PI / 2) / CORNER_SEGMENTS;
    const chordHalf = (CR + t) * Math.tan(segAngle / 2);

    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      const ccx = sx * cornerFlatHW;
      const ccz = sz * cornerFlatHL;

      for (let i = 0; i < CORNER_SEGMENTS; i++) {
        const theta = (i + 0.5) * segAngle;
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

  // ========== GOALS (car-containment only, ball handled by trimesh) ==========
  // Flush colliders (no wallOutset) + fillet arc segments at interior corners
  // so cars don't clip through the mesh or get stuck in sharp 90-degree edges.

  _buildGoals() {
    const t = ARENA.WALL_THICKNESS;
    const group = COLLISION_GROUPS.ARENA_BOXES;
    const mask = COLLISION_GROUPS.CAR;
    const fr = ARENA.GOAL_FILLET_RADIUS; // interior corner rounding radius
    const SEGS = 5; // segments per quarter-arc fillet

    [-1, 1].forEach(side => {
      const zMouth = side * HL;

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
      [-1, 1].forEach(sx => {
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
      // Approximated as angled box segments, same approach as arena corners
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

      // Goal mouth post fillets (where end wall meets goal side wall at opening)
      // Cars slide smoothly into goal instead of snagging on sharp post edge
      const ger = ARENA.GOAL_EDGE_RADIUS;
      const mouthSegAngle = (Math.PI / 2) / SEGS;
      const mouthChordHalf = (ger + t / 2) * Math.tan(mouthSegAngle / 2);

      [-1, 1].forEach(sx => {
        const cx = sx * (GW - ger);
        const cz = side * (HL + ger);

        for (let i = 0; i < SEGS; i++) {
          const theta = (i + 0.5) * mouthSegAngle;
          const r = ger + t / 2;
          // Arc sweeps from end-wall face into the goal interior
          const px = cx + sx * r * Math.sin(theta);
          const pz = cz - side * r * Math.cos(theta);
          const yRot = Math.atan2(sx * Math.sin(theta), -side * Math.cos(theta));

          const body = new CANNON.Body({
            type: CANNON.Body.STATIC,
            position: new CANNON.Vec3(px, GH / 2, pz),
            collisionFilterGroup: group,
            collisionFilterMask: mask,
          });
          body.addShape(new CANNON.Box(new CANNON.Vec3(mouthChordHalf, GH / 2, t / 2)));
          body.quaternion.setFromEuler(0, yRot, 0);
          this.world.addBody(body);
        }
      });
    });
  }

  // ========== GOAL DETECTION ==========

  isInGoal(position) {
    if (Math.abs(position.x) < GW && position.y < GH) {
      if (position.z < -(HL) && position.z > -(HL + GD)) {
        return 1;
      }
      if (position.z > HL && position.z < HL + GD) {
        return 2;
      }
    }
    return 0;
  }
}
