// ============================================
// CurveSurface — Analytical arena curve surface detection
// Shared between client Car.js and server ServerCar.js
// Pure math using only ARENA/CAR constants and CANNON.Vec3
// ============================================

import * as CANNON from 'cannon-es';
import { CAR, ARENA } from './constants.js';

/**
 * Analytically compute the nearest arena curve surface from a position.
 * Returns { sx, sy, sz, normal } or null if not near any curve/wall.
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

  let best = null;
  let bestDist = Infinity;

  // --- Side walls (left/right, XY plane) ---
  for (const side of [-1, 1]) {
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
            best = { sx, sy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0) };
          }
        }
      }
    }

    // ---- Flat wall section ----
    if (distToWall < detectRange && pos.y >= r - 1 && pos.y <= H - r) {
      if (distToWall < bestDist) {
        bestDist = distToWall;
        best = { sx: wallX, sy: pos.y, sz: pos.z, normal: new CANNON.Vec3(-side, 0, 0) };
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
            best = { sx, sy, sz: pos.z, normal: new CANNON.Vec3(-ux, -uy, 0) };
          }
        }
      }
    }
  }

  // --- End walls (front/back, YZ plane, skip goal opening) ---
  for (const side of [-1, 1]) {
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
            best = { sx: pos.x, sy, sz, normal: new CANNON.Vec3(0, -uy, -uz) };
          }
        }
      }
    }

    // ---- Flat wall section ----
    if (distToWall < detectRange && pos.y >= r - 1 && pos.y <= H - r && !(inGoalX && inGoalY)) {
      if (distToWall < bestDist) {
        bestDist = distToWall;
        best = { sx: pos.x, sy: pos.y, sz: wallZ, normal: new CANNON.Vec3(0, 0, -side) };
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
            best = { sx: pos.x, sy, sz, normal: new CANNON.Vec3(0, -uy, -uz) };
          }
        }
      }
    }
  }

  // --- XZ Corner arcs (4 corners) ---
  const CR = ARENA.CORNER_RADIUS;
  const cornerFlatHW = hw - CR;
  const cornerFlatHL = hl - CR;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
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
            best = { sx: surfX, sy: surfY, sz: surfZ, normal: new CANNON.Vec3(nx, ny, nz) };
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
          best = {
            sx: surfX, sy: pos.y, sz: surfZ,
            normal: new CANNON.Vec3(-sx * dirX, 0, -sz * dirZ)
          };
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
              best = { sx: surfX, sy: surfY, sz: surfZ, normal: new CANNON.Vec3(cnx, cny, cnz) };
            }
          }
        }
      }
    }
  }

  // Floor baseline: if a fillet/wall claimed the car but the flat floor is
  // actually closer, the floor wins.
  if (best && pos.y < detectRange && pos.y < bestDist) {
    bestDist = pos.y;
    best = { sx: pos.x, sy: 0, sz: pos.z, normal: new CANNON.Vec3(0, 1, 0) };
  }

  if (best) best.dist = bestDist;
  return best;
}
