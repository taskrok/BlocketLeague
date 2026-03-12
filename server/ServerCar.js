// ============================================
// ServerCar -- Headless car physics (no rendering)
// Thin wrapper around shared CarPhysics module
// ============================================

import * as CANNON from 'cannon-es';
import { CAR, COLLISION_GROUPS, DEMOLITION } from '../shared/constants.js';
import { carPhysics, createCarState, resetCarState } from '../shared/CarPhysics.js';

export class ServerCar {
  constructor(world, position, direction = 1) {
    this.world = world;
    this.direction = direction;

    // Physics state (shared with client via CarPhysics module)
    this._state = createCarState();

    // Simulation time tracker (monotonic, based on tick count * timestep)
    this._simTime = 0;

    this._createPhysics(position);
  }

  // ---- State property accessors (delegate to _state) ----
  get boost() { return this._state.boost; }
  set boost(v) { this._state.boost = v; }
  get isGrounded() { return this._state.isGrounded; }
  set isGrounded(v) { this._state.isGrounded = v; }
  get hasJumped() { return this._state.hasJumped; }
  set hasJumped(v) { this._state.hasJumped = v; }
  get canDoubleJump() { return this._state.canDoubleJump; }
  set canDoubleJump(v) { this._state.canDoubleJump = v; }
  get jumpTime() { return this._state.jumpTime; }
  set jumpTime(v) { this._state.jumpTime = v; }
  get isDodging() { return this._state.isDodging; }
  set isDodging(v) { this._state.isDodging = v; }
  get dodgeTime() { return this._state.dodgeTime; }
  set dodgeTime(v) { this._state.dodgeTime = v; }
  get jumpLockout() { return this._state.jumpLockout; }
  set jumpLockout(v) { this._state.jumpLockout = v; }
  get surfaceNormal() { return this._state.surfaceNormal; }
  get onWall() { return this._state.onWall; }
  set onWall(v) { this._state.onWall = v; }
  get onGoalSurface() { return this._state.onGoalSurface; }
  set onGoalSurface(v) { this._state.onGoalSurface = v; }
  get demolished() { return this._state.demolished; }
  set demolished(v) { this._state.demolished = v; }
  get respawnTimer() { return this._state.respawnTimer; }
  set respawnTimer(v) { this._state.respawnTimer = v; }

  _createPhysics(position) {
    const shape = new CANNON.Box(
      new CANNON.Vec3(CAR.WIDTH / 2, CAR.HEIGHT / 2, CAR.LENGTH / 2)
    );

    // Tilt hitbox nose-down to match Octane profile
    const tiltRad = (CAR.HITBOX_ANGLE * Math.PI) / 180;
    const shapeOffset = new CANNON.Vec3(0, 0, 0);
    const shapeQuat = new CANNON.Quaternion();
    shapeQuat.setFromEuler(tiltRad, 0, 0);

    this.body = new CANNON.Body({
      mass: CAR.MASS,
      position: new CANNON.Vec3(position.x, position.y, position.z),
      linearDamping: 0.01,
      angularDamping: 0.5,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUPS.CAR,
      collisionFilterMask: COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR,
    });
    this.body.addShape(shape, shapeOffset, shapeQuat);

    if (this.direction === -1) {
      this.body.quaternion.setFromEuler(0, Math.PI, 0);
    }

    this.world.addBody(this.body);
  }

  update(input, dt) {
    if (this._state.demolished) return;

    // Advance simulation time (monotonic, in ms)
    this._simTime += dt * 1000;

    // Run shared physics
    carPhysics.update(this.body, this._state, input, dt, this._simTime);
  }

  addBoost(amount) {
    this._state.boost = Math.min(CAR.MAX_BOOST, this._state.boost + amount);
  }

  reset(position, direction) {
    resetCarState(this.body, this._state, position, direction);
  }

  demolish() {
    this._state.demolished = true;
    this._state.respawnTimer = DEMOLITION.RESPAWN_TIME;
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.position.y = -100;
    this.body.collisionFilterMask = 0;
  }

  updateDemolition(dt, spawnPos, direction) {
    if (!this._state.demolished) return;
    this._state.respawnTimer -= dt;
    if (this._state.respawnTimer <= 0) {
      this._state.demolished = false;
      this.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      this.reset(spawnPos, direction);
    }
  }

  getPosition() { return this.body.position; }
  getVelocity() { return this.body.velocity; }
  getSpeed() { return this.body.velocity.length(); }
}
