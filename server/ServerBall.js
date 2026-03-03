// ============================================
// ServerBall — Headless ball physics (no rendering)
// ============================================

import * as CANNON from 'cannon-es';
import { BALL, COLLISION_GROUPS } from '../shared/constants.js';

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
