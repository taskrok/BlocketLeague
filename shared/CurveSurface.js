// ============================================
// CurveSurface — Analytical arena curve surface detection
// Shared between client Car.js and server ServerCar.js
// Pure math using only ARENA/CAR constants and CANNON.Vec3
// ============================================

import * as CANNON from 'cannon-es';
import { CAR, ARENA } from './constants.js';

// Hoisted to module scope: iterating `[-1, 1]` literals per call allocated an
// array + iterator for every loop, every tick, every car.
const SIDES = [-1, 1];

// Single pre-allocated result object. checkCurveSurface() writes into this in
// place and returns it, so the RETURN VALUE IS REUSED ACROSS CALLS: callers
// must copy anything they need (e.g. `.copy()` the normal) before the next
// call and must never retain the reference across ticks.
const _result = { sx: 0, sy: 0, sz: 0, dist: 0, normal: new CANNON.Vec3() };

/**
 * Analytically compute the nearest arena curve surface from a position.
 * Returns the shared `_result` object { sx, sy, sz, dist, normal } or null if
 * not near any curve/wall. The returned object is reused on every call -- do
 * not hold onto it.
 * Handles: floor-to-wall fillets, flat walls, wall-to-ceiling fillets,
 * XZ corner arcs with toroidal floor/ceiling transitions.
 */
export function checkCurveSurface(pos) {
  const r = ARENA.CURVE_RADIUS;
  const hw = ARENA.WIDTH / 2;
  const hl = ARENA.LENGTH / 2;
  const H = ARENA.HEIGHT;
  const flatHW = hw - r;
  const flatHL = hl - r;
  const detectRange = CAR.HEIGHT * 3.5;

  const best = _result;
  let found = false;
  let bestDist = Infinity;

  // --- Side walls (left/right, XY plane) ---
  for (let si = 0; si < 2; si++) {
    const side = SIDES[si];
    const dx = side * pos.x - flatHW;
    if (dx <= 0) continue;

    const wallX = side * hw;
    const distToWall = Math.abs(pos.x - wallX);

    // ---- Floor-to-wall fillet (nearest-point-on-arc) ----
    {
      const cx = side * flatHW;
      const cy = r;
      const dcx = pos.x - cx;
      const dcy = pos.y - cy;
      const d = Math.sqrt(dcx * dcx + dcy * dcy);
      if (d > 0.001) {
        const ux = dcx / d;
        const uy = dcy / d;
        if (side * ux >= 0 && uy <= 0) {
          const distToSurf = Math.abs(d - r);
          if (distToSurf < detectRange && distToSurf < bestDist) {
            const sx = cx + r * ux;
            const sy = cy + r * uy;
            bestDist = distToSurf;
            found = true;
            best.sx = sx; best.sy = sy; best.sz = pos.z;
            best.normal.set(-ux, -uy, 0);
          }
        }
      }
    }

    // ---- Flat wall section ----
    if (distToWall < detectRange && pos.y >= r - 1 && pos.y <= H - r) {
      if (distToWall < bestDist) {
        bestDist = distToWall;
        found = true;
        best.sx = wallX; best.sy = pos.y; best.sz = pos.z;
        best.normal.set(-side, 0, 0);
      }
    }

    // ---- Wall-to-ceiling fillet (nearest-point-on-arc) ----
    {
      const cx = side * flatHW;
      const cy = H - r;
      const dcx = pos.x - cx;
      const dcy = pos.y - cy;
      const d = Math.sqrt(dcx * dcx + dcy * dcy);
      if (d > 0.001) {
        const ux = dcx / d;
        const uy = dcy / d;
        if (side * ux >= 0 && uy >= 0) {
          const distToSurf = Math.abs(d - r);
          if (distToSurf < detectRange && distToSurf < bestDist) {
            const sx = cx + r * ux;
            const sy = cy + r * uy;
            bestDist = distToSurf;
            found = true;
            best.sx = sx; best.sy = sy; best.sz = pos.z;
            best.normal.set(-ux, -uy, 0);
          }
        }
      }
    }
  }

  // --- End walls (front/back, YZ plane, skip goal opening) ---
  for (let si = 0; si < 2; si++) {
    const side = SIDES[si];
    const dz = side * pos.z - flatHL;
    if (dz <= 0) continue;

    const inGoalX = Math.abs(pos.x) < ARENA.GOAL_WIDTH / 2;
    const inGoalY = pos.y < ARENA.GOAL_HEIGHT;
    const wallZ = side * hl;
    const distToWall = Math.abs(pos.z - wallZ);

    // ---- Floor-to-wall fillet ----
    if (!(inGoalX && inGoalY)) {
      const cz = side * flatHL;
      const cy = r;
      const dcz = pos.z - cz;
      const dcy = pos.y - cy;
      const d = Math.sqrt(dcz * dcz + dcy * dcy);
      if (d > 0.001) {
        const uz = dcz / d;
        const uy = dcy / d;
        if (side * uz >= 0 && uy <= 0) {
          const distToSurf = Math.abs(d - r);
          if (distToSurf < detectRange && distToSurf < bestDist) {
            const sz = cz + r * uz;
            const sy = cy + r * uy;
            bestDist = distToSurf;
            found = true;
            best.sx = pos.x; best.sy = sy; best.sz = sz;
            best.normal.set(0, -uy, -uz);
          }
        }
      }
    }

    // ---- Flat wall section ----
    if (distToWall < detectRange && pos.y >= r - 1 && pos.y <= H - r && !(inGoalX && inGoalY)) {
      if (distToWall < bestDist) {
        bestDist = distToWall;
        found = true;
        best.sx = pos.x; best.sy = pos.y; best.sz = wallZ;
        best.normal.set(0, 0, -side);
      }
    }

    // ---- Wall-to-ceiling fillet ----
    // Above the goal (y > GH), the arena ceiling fillet should still apply even when |x| < GW
    if (!(inGoalX && inGoalY)) {
      const cz = side * flatHL;
      const cy = H - r;
      const dcz = pos.z - cz;
      const dcy = pos.y - cy;
      const d = Math.sqrt(dcz * dcz + dcy * dcy);
      if (d > 0.001) {
        const uz = dcz / d;
        const uy = dcy / d;
        if (side * uz >= 0 && uy >= 0) {
          const distToSurf = Math.abs(d - r);
          if (distToSurf < detectRange && distToSurf < bestDist) {
            const sz = cz + r * uz;
            const sy = cy + r * uy;
            bestDist = distToSurf;
            found = true;
            best.sx = pos.x; best.sy = sy; best.sz = sz;
            best.normal.set(0, -uy, -uz);
          }
        }
      }
    }
  }

  // --- XZ Corner arcs (4 corners) ---
  const CR = ARENA.CORNER_RADIUS;
  const cornerFlatHW = hw - CR;
  const cornerFlatHL = hl - CR;

  for (let xi = 0; xi < 2; xi++) {
    const sx = SIDES[xi];
    for (let zi = 0; zi < 2; zi++) {
      const sz = SIDES[zi];
      const ccx = sx * cornerFlatHW;
      const ccz = sz * cornerFlatHL;

      const cdx = sx * pos.x - cornerFlatHW;
      const cdz = sz * pos.z - cornerFlatHL;
      if (cdx <= 0 || cdz <= 0) continue;

      const d = Math.sqrt(cdx * cdx + cdz * cdz);
      if (d < 0.001) continue;

      const dirX = cdx / d;
      const dirZ = cdz / d;

      // ---- Floor-to-corner fillet (toroidal surface) ----
      const innerR = CR - r;
      const dRad = d - innerR;
      const dY = pos.y - r;
      const dFromCenter = Math.sqrt(dRad * dRad + dY * dY);

      if (dFromCenter > 0.001 && pos.y < r + detectRange) {
        const uRad = dRad / dFromCenter;
        const uY = dY / dFromCenter;

        if (uRad >= 0 && uY <= 0) {
          const distToSurf = Math.abs(dFromCenter - r);

          if (distToSurf < detectRange && distToSurf < bestDist) {
            const surfRad = innerR + r * uRad;
            const surfY = r + r * uY;
            const surfX = ccx + sx * surfRad * dirX;
            const surfZ = ccz + sz * surfRad * dirZ;

            const nx = -sx * dirX * uRad;
            const ny = -uY;
            const nz = -sz * dirZ * uRad;

            bestDist = distToSurf;
            found = true;
            best.sx = surfX; best.sy = surfY; best.sz = surfZ;
            best.normal.set(nx, ny, nz);
          }
        }
      }

      // ---- Flat corner wall section (vertical cylinder) ----
      if (pos.y >= r && pos.y <= H - r) {
        const arcDist = Math.abs(d - CR);
        if (arcDist < detectRange && arcDist < bestDist) {
          bestDist = arcDist;
          const surfX = ccx + sx * CR * dirX;
          const surfZ = ccz + sz * CR * dirZ;
          found = true;
          best.sx = surfX; best.sy = pos.y; best.sz = surfZ;
          best.normal.set(-sx * dirX, 0, -sz * dirZ);
        }
      }

      // ---- Ceiling-to-corner fillet (toroidal surface) ----
      if (pos.y > H - r - detectRange) {
        const cdY = pos.y - (H - r);
        const cdFromCenter = Math.sqrt(dRad * dRad + cdY * cdY);

        if (cdFromCenter > 0.001) {
          const cuRad = dRad / cdFromCenter;
          const cuY = cdY / cdFromCenter;

          if (cuRad >= 0 && cuY >= 0) {
            const distToSurf = Math.abs(cdFromCenter - r);

            if (distToSurf < detectRange && distToSurf < bestDist) {
              const surfRad = innerR + r * cuRad;
              const surfY = (H - r) + r * cuY;
              const surfX = ccx + sx * surfRad * dirX;
              const surfZ = ccz + sz * surfRad * dirZ;

              const cnx = -sx * dirX * cuRad;
              const cny = -cuY;
              const cnz = -sz * dirZ * cuRad;

              bestDist = distToSurf;
              found = true;
              best.sx = surfX; best.sy = surfY; best.sz = surfZ;
              best.normal.set(cnx, cny, cnz);
            }
          }
        }
      }
    }
  }

  // Floor baseline: if a fillet/wall claimed the car but the flat floor is
  // actually closer, the floor wins.
  if (found && pos.y < detectRange && pos.y < bestDist) {
    bestDist = pos.y;
    best.sx = pos.x; best.sy = 0; best.sz = pos.z;
    best.normal.set(0, 1, 0);
  }

  if (!found) return null;
  best.dist = bestDist;
  return best;
}
