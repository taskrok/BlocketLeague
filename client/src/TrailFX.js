// ============================================
// TrailFX - Ribbon trails for the ball and boosting cars
//
// Each trail is ONE Mesh with ONE BufferGeometry whose position/colour
// attributes are rewritten in place every frame (no per-frame allocation,
// no mesh churn). Points live in a fixed ring buffer; a point is only
// appended when the emitter has moved `minDist`, so the ribbon's shape is
// frame-rate independent. Old points age out by `lifetime`.
//
// The ribbon is widened along a blend of the camera-facing side vector and
// the ground-plane side vector, so it reads as a solid streak from the chase
// cam (where a pure billboard would collapse to a line when the trail points
// straight away from the viewer).
//
// Material: additive MeshBasicMaterial with vertex colours. Fade is encoded
// as darkening (additive black == invisible), so no per-vertex alpha is
// needed. Depth write is off; renderOrder puts it after the opaque scene.
// ============================================

import * as THREE from 'three';
import { BALL, CAR, COLORS } from '../../shared/constants.js';

// Module-level scratch (never retained)
const _dir = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _sideCam = new THREE.Vector3();
const _sideFlat = new THREE.Vector3();
const _side = new THREE.Vector3();
const _prevSide = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _col = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _up = new THREE.Vector3(0, 1, 0);

// Emitter jumps larger than this (ball reset, respawn, replay start) clear
// the trail instead of drawing a streak across the arena.
const TELEPORT_DIST_SQ = 12 * 12;

export class RibbonTrail {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} opts
   * @param {number} opts.maxPoints  ring buffer size (vertices = 2x)
   * @param {number} opts.width      half-width at the head, world units
   * @param {number} opts.lifetime   seconds a point stays visible
   * @param {number} opts.minDist    min emitter travel between points
   * @param {number} opts.color      base colour (hex)
   */
  constructor(parent, { maxPoints = 40, width = 1, lifetime = 0.3, minDist = 0.4, color = 0xffffff } = {}) {
    this.maxPoints = maxPoints;
    this.width = width;
    this.lifetime = lifetime;
    this.minDist = minDist;
    this.color = new THREE.Color(color);
    this.intensity = 1; // brightness multiplier applied at the head (0..~2)

    // Ring buffer of emitter samples: x, y, z, time
    this._pts = new Float32Array(maxPoints * 4);
    this._head = -1;
    this._count = 0;

    const geo = new THREE.BufferGeometry();
    this._posArr = new Float32Array(maxPoints * 2 * 3);
    this._colArr = new Float32Array(maxPoints * 2 * 3);
    this._posAttr = new THREE.BufferAttribute(this._posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this._colAttr = new THREE.BufferAttribute(this._colArr, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('color', this._colAttr);

    // Static quad-strip index: segment i joins vertex pair (2i,2i+1) to (2i+2,2i+3)
    const idx = new Uint16Array((maxPoints - 1) * 6);
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      const o = i * 6;
      idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
      idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; // bounds change every frame; cheaper to always draw
    this.mesh.renderOrder = 5;
    parent.add(this.mesh);
  }

  /** Drop every point; the ribbon disappears next update. */
  clear() {
    this._head = -1;
    this._count = 0;
  }

  /**
   * Feed the emitter position for this frame.
   * @param {boolean} emit  false = do not add points (existing ones still fade)
   */
  push(x, y, z, now, emit) {
    const pts = this._pts;
    if (this._count > 0) {
      const h = this._head * 4;
      const dx = x - pts[h], dy = y - pts[h + 1], dz = z - pts[h + 2];
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq > TELEPORT_DIST_SQ) {
        this.clear();
      } else if (emit) {
        if (dsq < this.minDist * this.minDist) {
          // Head is "live": keep it glued to the emitter and fresh
          pts[h] = x; pts[h + 1] = y; pts[h + 2] = z; pts[h + 3] = now;
          return;
        }
      } else {
        return;
      }
    }
    if (!emit) return;
    this._head = (this._head + 1) % this.maxPoints;
    if (this._count < this.maxPoints) this._count++;
    const h = this._head * 4;
    pts[h] = x; pts[h + 1] = y; pts[h + 2] = z; pts[h + 3] = now;
  }

  /**
   * Rebuild the ribbon vertices from the point buffer.
   * @param {number} now           trail clock (seconds)
   * @param {THREE.Vector3} camPos camera world position (for billboarding)
   */
  update(now, camPos) {
    const pts = this._pts;
    const max = this.maxPoints;
    const life = this.lifetime;

    // Age out from the tail (oldest first)
    while (this._count > 0) {
      const oldest = ((this._head - this._count + 1) % max + max) % max;
      if (now - pts[oldest * 4 + 3] > life) this._count--;
      else break;
    }

    const n = this._count;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const start = ((this._head - n + 1) % max + max) % max;
    const posArr = this._posArr;
    const colArr = this._colArr;
    const baseR = this.color.r, baseG = this.color.g, baseB = this.color.b;
    const intensity = this.intensity;
    _prevSide.set(0, 0, 0);

    for (let k = 0; k < n; k++) {
      const i = (start + k) % max;
      const ip = (start + Math.max(k - 1, 0)) % max;
      const inx = (start + Math.min(k + 1, n - 1)) % max;
      const o = i * 4;
      const px = pts[o], py = pts[o + 1], pz = pts[o + 2];

      // Tangent via central difference
      _dir.set(pts[inx * 4] - pts[ip * 4], pts[inx * 4 + 1] - pts[ip * 4 + 1], pts[inx * 4 + 2] - pts[ip * 4 + 2]);
      const dl = _dir.length();
      if (dl > 1e-5) _dir.multiplyScalar(1 / dl); else _dir.set(0, 0, 1);

      // Side = camera-facing component (magnitude sin(angle to camera)) blended
      // with a ground-plane component so an end-on ribbon stays visible.
      _toCam.set(camPos.x - px, camPos.y - py, camPos.z - pz).normalize();
      _sideCam.crossVectors(_dir, _toCam);
      _sideFlat.crossVectors(_dir, _up);
      const fl = _sideFlat.length();
      if (fl > 1e-5) _sideFlat.multiplyScalar(0.6 / fl); else _sideFlat.set(0, 0, 0);
      _side.addVectors(_sideCam, _sideFlat);
      const sl = _side.length();
      if (sl > 1e-4) {
        _side.multiplyScalar(1 / sl);
        if (_prevSide.dot(_side) < 0) _side.negate(); // keep winding consistent
      } else if (_prevSide.lengthSq() > 0) {
        _side.copy(_prevSide);
      } else {
        _side.set(1, 0, 0);
      }
      _prevSide.copy(_side);

      // Age fade: 1 at the head, 0 at lifetime. Width and brightness taper with it.
      let f = 1 - (now - pts[o + 3]) / life;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      const hw = this.width * (0.15 + 0.85 * f);
      const bright = f * f * intensity;

      const v = k * 6;
      posArr[v]     = px + _side.x * hw; posArr[v + 1] = py + _side.y * hw; posArr[v + 2] = pz + _side.z * hw;
      posArr[v + 3] = px - _side.x * hw; posArr[v + 4] = py - _side.y * hw; posArr[v + 5] = pz - _side.z * hw;
      const r = baseR * bright, g = baseG * bright, b = baseB * bright;
      colArr[v] = r; colArr[v + 1] = g; colArr[v + 2] = b;
      colArr[v + 3] = r; colArr[v + 4] = g; colArr[v + 5] = b;
    }

    this._posAttr.needsUpdate = true;
    this._colAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------

const BALL_TRAIL_MIN_SPEED = 10;   // below this the ball leaves no streak
const BALL_TRAIL_FULL_SPEED = 60;  // full brightness/width
const BALL_TRAIL_HOT_SPEED = 85;   // streak whitens toward supersonic

/**
 * Owns the ball trail and one boost ribbon per car. Call update() once per
 * rendered frame (after meshes are synced, before composer.render()).
 */
export class TrailManager {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this._time = 0;

    this._root = new THREE.Group();
    this._root.name = 'TrailFX';
    scene.add(this._root);

    this._ball = null;
    this._ballTrail = null;
    this._ballBaseColor = new THREE.Color(COLORS.BALL);
    this._carTrails = []; // { car, trail }
  }

  setBall(ball) {
    this._ball = ball;
    if (!this._ballTrail) {
      this._ballTrail = new RibbonTrail(this._root, {
        maxPoints: 48,
        width: BALL.RADIUS * 0.9,
        lifetime: 0.3,
        minDist: 0.6,
        color: COLORS.BALL,
      });
    }
  }

  /** Replace the tracked car set (rebuilds ribbons; call when allCars changes). */
  setCars(cars) {
    for (let i = 0; i < this._carTrails.length; i++) this._carTrails[i].trail.dispose();
    this._carTrails.length = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      _col.set(car.color || COLORS.ORANGE).lerp(_white, 0.25);
      const trail = new RibbonTrail(this._root, {
        maxPoints: 32,
        width: 0.5,
        lifetime: 0.45,
        minDist: 0.35,
        color: _col.getHex(),
      });
      this._carTrails.push({ car, trail });
    }
  }

  setEnabled(on) {
    on = !!on;
    if (this.enabled === on) return;
    this.enabled = on;
    this._root.visible = on; // plain meshes only — no lights in this group
    if (!on) this._clearAll();
  }

  _clearAll() {
    if (this._ballTrail) this._ballTrail.clear();
    for (let i = 0; i < this._carTrails.length; i++) this._carTrails[i].trail.clear();
  }

  /** Force-clear (e.g. on kickoff reset) so no streak spans the teleport. */
  clear() {
    this._clearAll();
  }

  update(dt, camera) {
    if (!this.enabled) return;
    this._time += dt;
    const now = this._time;
    const camPos = camera.position;

    // --- Ball streak ---
    const ball = this._ball;
    if (ball && this._ballTrail) {
      const trail = this._ballTrail;
      const v = ball.body.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      const visible = ball._visible !== false && ball.mesh.visible;
      let t = (speed - BALL_TRAIL_MIN_SPEED) / (BALL_TRAIL_FULL_SPEED - BALL_TRAIL_MIN_SPEED);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      t = t * t * (3 - 2 * t); // smoothstep
      let hot = (speed - BALL_TRAIL_FULL_SPEED) / (BALL_TRAIL_HOT_SPEED - BALL_TRAIL_FULL_SPEED);
      if (hot < 0) hot = 0; else if (hot > 1) hot = 1;

      trail.intensity = 0.35 + t * 1.15;
      trail.width = BALL.RADIUS * (0.45 + 0.5 * t);
      trail.color.copy(this._ballBaseColor).lerp(_white, hot * 0.8);

      const p = ball.mesh.position;
      trail.push(p.x, p.y, p.z, now, visible && speed > BALL_TRAIL_MIN_SPEED);
      trail.update(now, camPos);
    }

    // --- Boost ribbons ---
    const list = this._carTrails;
    for (let i = 0; i < list.length; i++) {
      const car = list[i].car;
      const trail = list[i].trail;
      const mesh = car.mesh;
      const boosting = !!(car.boostFlame && car.boostFlame.visible) && mesh.visible && !car.demolished;
      // Exhaust point: just behind the rear bumper, slightly below centre
      _pos.set(0, -0.1, -CAR.LENGTH / 2 - 0.3).applyQuaternion(mesh.quaternion).add(mesh.position);
      const vel = car.body.velocity;
      const spd = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
      trail.intensity = 0.6 + Math.min(spd / CAR.BOOST_MAX_SPEED, 1) * 0.6;
      trail.push(_pos.x, _pos.y, _pos.z, now, boosting);
      trail.update(now, camPos);
    }
  }

  dispose() {
    if (this._ballTrail) { this._ballTrail.dispose(); this._ballTrail = null; }
    for (let i = 0; i < this._carTrails.length; i++) this._carTrails[i].trail.dispose();
    this._carTrails.length = 0;
    if (this._root.parent) this._root.parent.remove(this._root);
    this._ball = null;
  }
}
