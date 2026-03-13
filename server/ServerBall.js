// ============================================
// ServerBall — Headless ball physics (no rendering)
// ============================================

import * as CANNON from 'cannon-es';
import { BALL, ARENA, COLLISION_GROUPS } from '../shared/constants.js';

export class ServerBall {
  constructor(world) {
    this.world = world;
    this._createPhysics();
  }

  _createPhysics() {
    const shape = new CANNON.Sphere(BALL.RADIUS);

    this.body = new CANNON.Body({
      mass: BALL.MASS,
      shape: shape,
      position: new CANNON.Vec3(0, BALL.RADIUS + 0.5, 0),
      linearDamping: BALL.LINEAR_DAMPING,
      angularDamping: BALL.ANGULAR_DAMPING,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUPS.BALL,
      collisionFilterMask: COLLISION_GROUPS.ARENA_TRIMESH | COLLISION_GROUPS.CAR,
    });

    this.body.material = new CANNON.Material('ball');
    this.world.addBody(this.body);
  }

  update(dt) {
    // Clamp ball speed
    const vel = this.body.velocity;
    const speed = vel.length();
    if (speed > BALL.MAX_SPEED) {
      const scale = BALL.MAX_SPEED / speed;
      vel.x *= scale;
      vel.y *= scale;
      vel.z *= scale;
    }

    // Clamp angular velocity
    const av = this.body.angularVelocity;
    const avMag = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
    if (avMag > BALL.MAX_ANGULAR_VELOCITY) {
      const avScale = BALL.MAX_ANGULAR_VELOCITY / avMag;
      av.x *= avScale;
      av.y *= avScale;
      av.z *= avScale;
    }

    // Prevent ball from tunneling through arena boundaries
    const pos = this.body.position;
    const R = BALL.RADIUS;
    const HW = ARENA.WIDTH / 2;
    const HL = ARENA.LENGTH / 2;
    const H = ARENA.HEIGHT;

    // Floor
    if (pos.y < R) {
      pos.y = R;
      if (vel.y < 0) vel.y *= -BALL.RESTITUTION;
    }
    // Ceiling
    if (pos.y > H - R) {
      pos.y = H - R;
      if (vel.y > 0) vel.y *= -BALL.RESTITUTION;
    }
    // Side walls
    if (pos.x < -HW + R) {
      pos.x = -HW + R;
      if (vel.x < 0) vel.x *= -BALL.RESTITUTION;
    } else if (pos.x > HW - R) {
      pos.x = HW - R;
      if (vel.x > 0) vel.x *= -BALL.RESTITUTION;
    }
    // End walls (skip if inside goal mouth)
    const inGoalX = Math.abs(pos.x) < ARENA.GOAL_WIDTH / 2;
    const inGoalY = pos.y < ARENA.GOAL_HEIGHT;
    if (!inGoalX || !inGoalY) {
      if (pos.z < -HL + R) {
        pos.z = -HL + R;
        if (vel.z < 0) vel.z *= -BALL.RESTITUTION;
      } else if (pos.z > HL - R) {
        pos.z = HL - R;
        if (vel.z > 0) vel.z *= -BALL.RESTITUTION;
      }
    }
  }

  reset() {
    this.body.position.set(0, BALL.RADIUS + 0.5, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
  }

  getPosition() {
    return this.body.position;
  }

  getVelocity() {
    return this.body.velocity;
  }
}
