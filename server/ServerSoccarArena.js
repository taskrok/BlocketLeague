// ============================================
// ServerSoccarArena — Headless mesh-based arena physics (ammo.js/Bullet)
// Single trimesh collider for BOTH ball AND car — no more box approximations.
// ============================================

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAmmo } from '../shared/AmmoLoader.js';
import { SOCCAR_ARENA, COLLISION_GROUPS } from '../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const meshData = JSON.parse(fs.readFileSync(join(__dirname, '../assets/soccar_collision.json'), 'utf8'));

const HW = SOCCAR_ARENA.WIDTH / 2;
const HL = SOCCAR_ARENA.GOAL_MOUTH_Z;
const H  = SOCCAR_ARENA.HEIGHT;
const GW = SOCCAR_ARENA.GOAL_WIDTH / 2;
const GH = SOCCAR_ARENA.GOAL_HEIGHT;
const GD = SOCCAR_ARENA.GOAL_DEPTH;

export class ServerSoccarArena {
  constructor(world) {
    this.world = world;
    this.Ammo = getAmmo();
    this._buildTrimesh();
    this._buildContainmentPlanes();
    this._buildGoalWalls();
  }

  // ========== SINGLE TRIMESH (ball + car) ==========

  _buildTrimesh() {
    const Ammo = this.Ammo;
    const { vertices, indices } = meshData;

    const triMesh = new Ammo.btTriangleMesh(true, true);

    // Temp vectors for triangle construction
    const v0 = new Ammo.btVector3(0, 0, 0);
    const v1 = new Ammo.btVector3(0, 0, 0);
    const v2 = new Ammo.btVector3(0, 0, 0);

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      v0.setValue(vertices[i0], vertices[i0 + 1], vertices[i0 + 2]);
      v1.setValue(vertices[i1], vertices[i1 + 1], vertices[i1 + 2]);
      v2.setValue(vertices[i2], vertices[i2 + 1], vertices[i2 + 2]);

      triMesh.addTriangle(v0, v1, v2, false);
    }

    Ammo.destroy(v0);
    Ammo.destroy(v1);
    Ammo.destroy(v2);

    const meshShape = new Ammo.btBvhTriangleMeshShape(triMesh, true, true);
    meshShape.setMargin(0.04);

    // Static body at origin
    const transform = new Ammo.btTransform();
    transform.setIdentity();
    const origin = new Ammo.btVector3(0, 0, 0);
    transform.setOrigin(origin);
    const motionState = new Ammo.btDefaultMotionState(transform);
    const localInertia = new Ammo.btVector3(0, 0, 0);
    const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, meshShape, localInertia);
    this.trimeshBody = new Ammo.btRigidBody(rbInfo);

    // Trimesh only collides with ball — cars use raycasts + analytical containment
    const group = COLLISION_GROUPS.ARENA_TRIMESH;
    const mask = COLLISION_GROUPS.BALL;
    this.world.addRigidBody(this.trimeshBody, group, mask);

    // Set friction and restitution on the trimesh body
    this.trimeshBody.setFriction(0.35);
    this.trimeshBody.setRestitution(0.3);

    // Cleanup temp objects
    Ammo.destroy(origin);
    Ammo.destroy(transform);
    Ammo.destroy(localInertia);
    Ammo.destroy(rbInfo);

    // Keep reference to prevent GC
    this._triMesh = triMesh;
    this._meshShape = meshShape;
  }

  // ========== CONTAINMENT PLANES (backup for ball/car escaping mesh) ==========

  _buildContainmentPlanes() {
    const Ammo = this.Ammo;
    const group = COLLISION_GROUPS.ARENA_CONTAINMENT;
    const mask = COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;

    const addPlane = (nx, ny, nz, d) => {
      const normal = new Ammo.btVector3(nx, ny, nz);
      const shape = new Ammo.btStaticPlaneShape(normal, d);
      shape.setMargin(0.04);
      const transform = new Ammo.btTransform();
      transform.setIdentity();
      const motionState = new Ammo.btDefaultMotionState(transform);
      const localInertia = new Ammo.btVector3(0, 0, 0);
      const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
      const body = new Ammo.btRigidBody(rbInfo);
      body.setFriction(0.35);
      body.setRestitution(0.3);
      this.world.addRigidBody(body, group, mask);
      Ammo.destroy(normal);
      Ammo.destroy(transform);
      Ammo.destroy(localInertia);
      Ammo.destroy(rbInfo);
    };

    // Floor (Y >= 0)
    addPlane(0, 1, 0, 0);
    // Ceiling (Y <= H)
    addPlane(0, -1, 0, -H);
    // Side walls (X bounds)
    addPlane(1, 0, 0, -HW);   // left wall: X >= -HW
    addPlane(-1, 0, 0, -HW);  // right wall: X <= HW
  }

  // ========== GOAL INTERIOR WALLS ==========

  _buildGoalWalls() {
    const Ammo = this.Ammo;
    const group = COLLISION_GROUPS.ARENA_CONTAINMENT;
    const mask = COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
    const t = SOCCAR_ARENA.WALL_THICKNESS;

    const addBox = (hx, hy, hz, px, py, pz) => {
      const halfExtents = new Ammo.btVector3(hx, hy, hz);
      const shape = new Ammo.btBoxShape(halfExtents);
      shape.setMargin(0.04);
      const transform = new Ammo.btTransform();
      transform.setIdentity();
      const pos = new Ammo.btVector3(px, py, pz);
      transform.setOrigin(pos);
      const motionState = new Ammo.btDefaultMotionState(transform);
      const localInertia = new Ammo.btVector3(0, 0, 0);
      const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
      const body = new Ammo.btRigidBody(rbInfo);
      body.setFriction(0.35);
      body.setRestitution(0.1);
      this.world.addRigidBody(body, group, mask);
      Ammo.destroy(halfExtents);
      Ammo.destroy(pos);
      Ammo.destroy(transform);
      Ammo.destroy(localInertia);
      Ammo.destroy(rbInfo);
    };

    [-1, 1].forEach(side => {
      const zMouth = side * HL;

      // Back wall
      addBox(GW, GH / 2, t / 2, 0, GH / 2, side * (HL + GD) + side * t / 2);

      // Side walls
      [-1, 1].forEach(sx => {
        const fd = GD / 2;
        addBox(t / 2, GH / 2, fd, sx * (GW + t / 2), GH / 2, zMouth + side * fd);
      });

      // Ceiling
      addBox(GW, t / 2, GD / 2, 0, GH + t / 2, zMouth + side * GD / 2);
    });
  }

  // ========== GOAL DETECTION ==========

  isInGoal(pos) {
    // pos can be btVector3 or {x,y,z} — handle both
    const x = typeof pos.x === 'function' ? pos.x() : pos.x;
    const y = typeof pos.y === 'function' ? pos.y() : pos.y;
    const z = typeof pos.z === 'function' ? pos.z() : pos.z;

    if (Math.abs(x) < GW && y < GH) {
      if (z < -HL && z > -(HL + GD)) return 1;
      if (z > HL && z < HL + GD) return 2;
    }
    return 0;
  }
}
