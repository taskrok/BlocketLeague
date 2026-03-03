// ============================================
// ArenaGeometry - Generates a rounded arena as a single BufferGeometry
// All transitions (floor-to-wall, wall-to-ceiling, wall-to-wall corners)
// use smooth quarter-circle fillets. UVs are world-space for grid shader.
// ============================================

import * as THREE from 'three';
import { ARENA } from '../../shared/constants.js';

const R   = ARENA.CURVE_RADIUS;      // fillet radius for floor/wall/ceiling
const CR  = ARENA.CORNER_RADIUS;    // vertical corner radius
const GER = ARENA.GOAL_EDGE_RADIUS; // fillet radius on goal post / crossbar edges
const S   = ARENA.CURVE_SEGMENTS;   // segments per quarter arc

const HW = ARENA.WIDTH / 2;         // half width (X)
const HL = ARENA.LENGTH / 2;        // half length (Z)
const H  = ARENA.HEIGHT;            // total height (Y)
const GW = ARENA.GOAL_WIDTH / 2;    // half goal width
const GH = ARENA.GOAL_HEIGHT;       // goal height
const GD = ARENA.GOAL_DEPTH;        // goal depth
const GFR = ARENA.GOAL_FILLET_RADIUS; // goal interior fillet radius

// Inner flat extents (after subtracting fillet radii)
const flatHW = HW - R;   // flat floor/ceiling half-width in X
const flatHL = HL - R;   // flat floor/ceiling half-length in Z
const flatH  = H - 2 * R; // flat wall height (between top of floor fillet and bottom of ceiling fillet)

// Wall/fillet extents limited by corner radius (walls stop where corners begin)
const cornerFlatHW = HW - CR;  // X extent for end walls & end fillets
const cornerFlatHL = HL - CR;  // Z extent for side walls & side fillets

export function createArenaGeometry() {
  // ---- Phase 1: Arena shell (existing) ----
  // ensureInwardNormals points toward (0, H/2, 0) which is correct for the shell
  // but would break goal ceiling normals, so goals are built separately.
  const shellParts = [];

  // 1) Floor (flat center)
  shellParts.push(makeFloorWithGoalCutouts());

  // 2) Ceiling (flat center)
  shellParts.push(makeCeiling());

  // 3) Side walls (left & right flat sections)
  shellParts.push(makeSideWall(-1));
  shellParts.push(makeSideWall(1));

  // 4) End walls (with goal cutouts)
  shellParts.push(makeEndWall(-1));
  shellParts.push(makeEndWall(1));

  // 5) Floor-to-side-wall fillets
  shellParts.push(makeFloorSideFillet(-1));
  shellParts.push(makeFloorSideFillet(1));

  // 6) Floor-to-end-wall fillets (with goal cutouts)
  shellParts.push(makeFloorEndFillet(-1));
  shellParts.push(makeFloorEndFillet(1));

  // 7) Ceiling-to-side-wall fillets
  shellParts.push(makeCeilingSideFillet(-1));
  shellParts.push(makeCeilingSideFillet(1));

  // 8) Ceiling-to-end-wall fillets
  shellParts.push(makeCeilingEndFillet(-1));
  shellParts.push(makeCeilingEndFillet(1));

  // 9) Vertical corner fillets
  shellParts.push(makeVerticalCorner(-1, -1));
  shellParts.push(makeVerticalCorner(1, -1));
  shellParts.push(makeVerticalCorner(-1, 1));
  shellParts.push(makeVerticalCorner(1, 1));

  // 10) Triple-junction corner patches
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      shellParts.push(makeTripleCorner(sx, sz, 'floor'));
      shellParts.push(makeTripleCorner(sx, sz, 'ceiling'));
    }
  }

  // 11) Goal edge fillets (rounded posts + crossbar + corner patches)
  for (const side of [-1, 1]) {
    shellParts.push(makeGoalPostFillet(side, -1));
    shellParts.push(makeGoalPostFillet(side, 1));
    shellParts.push(makeGoalCrossbarFillet(side));
    shellParts.push(makeGoalCornerPatch(side, -1));
    shellParts.push(makeGoalCornerPatch(side, 1));
  }

  // 12) Goal-zone floor strips (fill gap from flatHL to HL in front of goal mouths)
  //     The floor-to-end-wall fillet is cut out for the goal opening, but the flat
  //     floor only reaches flatHL. This strip fills the 8-unit gap at y=0.
  for (const side of [-1, 1]) {
    shellParts.push(makeFlatQuad(
      new THREE.Vector3(-GW, 0, side * flatHL),
      new THREE.Vector3(GW, 0, side * flatHL),
      new THREE.Vector3(GW, 0, side * HL),
      new THREE.Vector3(-GW, 0, side * HL)
    ));
  }

  const shell = mergeBufferGeometries(shellParts);
  ensureInwardNormals(shell);

  // ---- Phase 2: Goal interiors ----
  // Built separately with normals pointing toward each goal's interior center,
  // so ceiling-down normals aren't flipped by ensureInwardNormals.
  const goalParts = [];
  for (const side of [-1, 1]) {
    const parts = makeGoalInterior(side);
    const goalGeo = mergeBufferGeometries(parts);
    ensureNormalsTowardPoint(goalGeo, 0, GH / 2, side * (HL + GD / 2));
    goalParts.push(goalGeo);
  }

  const merged = mergeBufferGeometries([shell, ...goalParts]);
  merged.computeVertexNormals();
  return merged;
}

function ensureInwardNormals(geometry) {
  const pos = geometry.getAttribute('position').array;
  const idx = geometry.index.array;
  const centerY = H / 2;

  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];

    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
    const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];

    // Face center
    const fx = (ax + bx + cx) / 3;
    const fy = (ay + by + cy) / 3;
    const fz = (az + bz + cz) / 3;

    // Face normal via cross product
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    // Direction from face center toward arena center (0, H/2, 0)
    const dx = -fx;
    const dy = centerY - fy;
    const dz = -fz;

    // If normal points away from center, flip the triangle
    if (nx * dx + ny * dy + nz * dz < 0) {
      idx[i + 1] = ic;
      idx[i + 2] = ib;
    }
  }
}

function ensureNormalsTowardPoint(geometry, px, py, pz) {
  const pos = geometry.getAttribute('position').array;
  const idx = geometry.index.array;

  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];

    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
    const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];

    const fx = (ax + bx + cx) / 3;
    const fy = (ay + by + cy) / 3;
    const fz = (az + bz + cz) / 3;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    const dx = px - fx;
    const dy = py - fy;
    const dz = pz - fz;

    if (nx * dx + ny * dy + nz * dz < 0) {
      idx[i + 1] = ic;
      idx[i + 2] = ib;
    }
  }
}

// ========== GOAL INTERIOR GEOMETRY ==========

function makeGoalInterior(side) {
  const parts = [];

  // Flat panels
  parts.push(makeGoalFloorPanel(side));
  parts.push(makeGoalCeilingPanel(side));
  parts.push(makeGoalSideWallPanel(side, -1));
  parts.push(makeGoalSideWallPanel(side, 1));
  parts.push(makeGoalBackWallPanel(side));

  // Edge fillets (quarter cylinders)
  parts.push(makeGoalFloorBackFillet(side));
  parts.push(makeGoalCeilingBackFillet(side));
  parts.push(makeGoalFloorSideFillet(side, -1));
  parts.push(makeGoalFloorSideFillet(side, 1));
  parts.push(makeGoalCeilingSideFillet(side, -1));
  parts.push(makeGoalCeilingSideFillet(side, 1));
  parts.push(makeGoalSideBackFillet(side, -1));
  parts.push(makeGoalSideBackFillet(side, 1));

  // Corner patches (1/8 spheres at back corners)
  parts.push(makeGoalBackCorner(side, -1, 'floor'));
  parts.push(makeGoalBackCorner(side, -1, 'ceiling'));
  parts.push(makeGoalBackCorner(side, 1, 'floor'));
  parts.push(makeGoalBackCorner(side, 1, 'ceiling'));

  return parts;
}

// -- Goal flat panels --

function makeGoalFloorPanel(side) {
  // y=0, x from -(GW-GFR) to +(GW-GFR), z from goal mouth to back fillet start
  const xMin = -(GW - GFR);
  const xMax = (GW - GFR);
  const zNear = side * HL;
  const zFar = side * (HL + GD - GFR);
  return makeFlatQuad(
    new THREE.Vector3(xMin, 0, zNear), new THREE.Vector3(xMax, 0, zNear),
    new THREE.Vector3(xMax, 0, zFar), new THREE.Vector3(xMin, 0, zFar)
  );
}

function makeGoalCeilingPanel(side) {
  // y=GH, same XZ extents as floor
  const xMin = -(GW - GFR);
  const xMax = (GW - GFR);
  const zNear = side * HL;
  const zFar = side * (HL + GD - GFR);
  return makeFlatQuad(
    new THREE.Vector3(xMin, GH, zNear), new THREE.Vector3(xMax, GH, zNear),
    new THREE.Vector3(xMax, GH, zFar), new THREE.Vector3(xMin, GH, zFar)
  );
}

function makeGoalSideWallPanel(side, postSide) {
  // x=postSide*GW, y from GFR to GH-GFR, z from mouth to back fillet start
  const x = postSide * GW;
  const zNear = side * HL;
  const zFar = side * (HL + GD - GFR);
  return makeFlatQuad(
    new THREE.Vector3(x, GFR, zNear), new THREE.Vector3(x, GFR, zFar),
    new THREE.Vector3(x, GH - GFR, zFar), new THREE.Vector3(x, GH - GFR, zNear)
  );
}

function makeGoalBackWallPanel(side) {
  // z=side*(HL+GD), x from -(GW-GFR) to +(GW-GFR), y from GFR to GH-GFR
  const z = side * (HL + GD);
  const xMin = -(GW - GFR);
  const xMax = (GW - GFR);
  return makeFlatQuad(
    new THREE.Vector3(xMin, GFR, z), new THREE.Vector3(xMax, GFR, z),
    new THREE.Vector3(xMax, GH - GFR, z), new THREE.Vector3(xMin, GH - GFR, z)
  );
}

// -- Goal edge fillets (quarter cylinders) --

function makeGoalFloorBackFillet(side) {
  // Quarter cylinder along X: connects floor (y=0) to back wall (z=side*(HL+GD))
  // Arc center at (x, GFR, side*(HL+GD-GFR))
  const cy = GFR;
  const cz = side * (HL + GD - GFR);
  const xMin = -(GW - GFR);
  const xMax = (GW - GFR);

  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= S; i++) {
    const angle = (Math.PI / 2) * (i / S);
    const ly = cy - GFR * Math.cos(angle);
    const lz = cz + side * GFR * Math.sin(angle);
    for (let j = 0; j <= 1; j++) {
      const x = j === 0 ? xMin : xMax;
      positions.push(x, ly, lz);
      uvs.push(x, lz);
    }
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return buildGeometry(positions, uvs, indices);
}

function makeGoalCeilingBackFillet(side) {
  // Quarter cylinder along X: connects ceiling (y=GH) to back wall
  // Arc center at (x, GH-GFR, side*(HL+GD-GFR))
  const cy = GH - GFR;
  const cz = side * (HL + GD - GFR);
  const xMin = -(GW - GFR);
  const xMax = (GW - GFR);

  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= S; i++) {
    const angle = (Math.PI / 2) * (i / S);
    const ly = cy + GFR * Math.cos(angle);
    const lz = cz + side * GFR * Math.sin(angle);
    for (let j = 0; j <= 1; j++) {
      const x = j === 0 ? xMin : xMax;
      positions.push(x, ly, lz);
      uvs.push(x, lz);
    }
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return buildGeometry(positions, uvs, indices);
}

function makeGoalFloorSideFillet(side, postSide) {
  // Quarter cylinder along Z: connects floor (y=0) to side wall (x=postSide*GW)
  // Arc center at (postSide*(GW-GFR), GFR, z)
  const cx = postSide * (GW - GFR);
  const zNear = side * HL;
  const zFar = side * (HL + GD - GFR);

  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= S; i++) {
    const angle = (Math.PI / 2) * (i / S);
    const lx = cx + postSide * GFR * Math.sin(angle);
    const ly = GFR - GFR * Math.cos(angle);
    for (let j = 0; j <= 1; j++) {
      const z = j === 0 ? zNear : zFar;
      positions.push(lx, ly, z);
      uvs.push(lx, z);
    }
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return buildGeometry(positions, uvs, indices);
}

function makeGoalCeilingSideFillet(side, postSide) {
  // Quarter cylinder along Z: connects ceiling (y=GH) to side wall (x=postSide*GW)
  // Arc center at (postSide*(GW-GFR), GH-GFR, z)
  const cx = postSide * (GW - GFR);
  const cy = GH - GFR;
  const zNear = side * HL;
  const zFar = side * (HL + GD - GFR);

  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= S; i++) {
    const angle = (Math.PI / 2) * (i / S);
    const lx = cx + postSide * GFR * Math.sin(angle);
    const ly = cy + GFR * Math.cos(angle);
    for (let j = 0; j <= 1; j++) {
      const z = j === 0 ? zNear : zFar;
      positions.push(lx, ly, z);
      uvs.push(lx, z);
    }
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return buildGeometry(positions, uvs, indices);
}

function makeGoalSideBackFillet(side, postSide) {
  // Quarter cylinder along Y: connects side wall to back wall
  // Arc center at (postSide*(GW-GFR), y, side*(HL+GD-GFR))
  const cx = postSide * (GW - GFR);
  const cz = side * (HL + GD - GFR);
  const yBot = GFR;
  const yTop = GH - GFR;

  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= S; i++) {
    const angle = (Math.PI / 2) * (i / S);
    const lx = cx + postSide * GFR * Math.cos(angle);
    const lz = cz + side * GFR * Math.sin(angle);
    for (let j = 0; j <= 1; j++) {
      const y = j === 0 ? yBot : yTop;
      positions.push(lx, y, lz);
      uvs.push(lx, lz);
    }
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return buildGeometry(positions, uvs, indices);
}

// -- Goal corner patches (1/8 spheres at back corners) --

function makeGoalBackCorner(side, postSide, position) {
  // 1/8 sphere at junction of floor/ceiling + side + back fillets
  const cx = postSide * (GW - GFR);
  const cy = position === 'floor' ? GFR : GH - GFR;
  const cz = side * (HL + GD - GFR);
  const ySign = position === 'floor' ? -1 : 1;

  const N = Math.max(S, 6);
  const positions = [], uvs = [], indices = [];

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const phi = (Math.PI / 2) * (i / N);
      const theta = (Math.PI / 2) * (j / N);

      const lx = cx + postSide * GFR * Math.sin(phi) * Math.sin(theta);
      const ly = cy + ySign * GFR * Math.cos(phi);
      const lz = cz + side * GFR * Math.sin(phi) * Math.cos(theta);

      positions.push(lx, ly, lz);
      uvs.push(lx, lz);
    }
  }

  const stride = N + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

// ========== FLAT PANELS ==========

function makeFloorWithGoalCutouts() {
  // Floor is a rectangle from (-flatHW, 0, -flatHL) to (flatHW, 0, flatHL)
  // with no cutouts on the floor itself (goals are in the end walls)
  return makeFlatQuad(
    new THREE.Vector3(-flatHW, 0, -flatHL),
    new THREE.Vector3(flatHW, 0, -flatHL),
    new THREE.Vector3(flatHW, 0, flatHL),
    new THREE.Vector3(-flatHW, 0, flatHL)
  );
}

function makeCeiling() {
  return makeFlatQuad(
    new THREE.Vector3(-flatHW, H, flatHL),
    new THREE.Vector3(flatHW, H, flatHL),
    new THREE.Vector3(flatHW, H, -flatHL),
    new THREE.Vector3(-flatHW, H, -flatHL)
  );
}

function makeSideWall(side) {
  // side = -1 for left (X = -HW), +1 for right (X = +HW)
  const x = side * HW;
  // Wall runs from Z = -cornerFlatHL to +cornerFlatHL (stops where corner arc begins)
  if (side === -1) {
    return makeFlatQuad(
      new THREE.Vector3(x, R, cornerFlatHL),
      new THREE.Vector3(x, R, -cornerFlatHL),
      new THREE.Vector3(x, R + flatH, -cornerFlatHL),
      new THREE.Vector3(x, R + flatH, cornerFlatHL)
    );
  } else {
    return makeFlatQuad(
      new THREE.Vector3(x, R, -cornerFlatHL),
      new THREE.Vector3(x, R, cornerFlatHL),
      new THREE.Vector3(x, R + flatH, cornerFlatHL),
      new THREE.Vector3(x, R + flatH, -cornerFlatHL)
    );
  }
}

function makeEndWall(side) {
  // side = -1 for Z = -HL, +1 for Z = +HL
  const z = side * HL;
  const yBot = R;
  const yTop = R + flatH;

  const geoParts = [];

  // Left section: from X = -cornerFlatHW to X = -GW
  if (side === -1) {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(-cornerFlatHW, yBot, z),
      new THREE.Vector3(-GW, yBot, z),
      new THREE.Vector3(-GW, yTop, z),
      new THREE.Vector3(-cornerFlatHW, yTop, z)
    ));
  } else {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(-GW, yBot, z),
      new THREE.Vector3(-cornerFlatHW, yBot, z),
      new THREE.Vector3(-cornerFlatHW, yTop, z),
      new THREE.Vector3(-GW, yTop, z)
    ));
  }

  // Right section: from X = +GW to X = +cornerFlatHW
  if (side === -1) {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(GW, yBot, z),
      new THREE.Vector3(cornerFlatHW, yBot, z),
      new THREE.Vector3(cornerFlatHW, yTop, z),
      new THREE.Vector3(GW, yTop, z)
    ));
  } else {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(cornerFlatHW, yBot, z),
      new THREE.Vector3(GW, yBot, z),
      new THREE.Vector3(GW, yTop, z),
      new THREE.Vector3(cornerFlatHW, yTop, z)
    ));
  }

  // Top section (above goal): from X = -GW to X = +GW, Y = GH to yTop
  if (GH < yTop) {
    if (side === -1) {
      geoParts.push(makeFlatQuad(
        new THREE.Vector3(-GW, GH, z),
        new THREE.Vector3(GW, GH, z),
        new THREE.Vector3(GW, yTop, z),
        new THREE.Vector3(-GW, yTop, z)
      ));
    } else {
      geoParts.push(makeFlatQuad(
        new THREE.Vector3(GW, GH, z),
        new THREE.Vector3(-GW, GH, z),
        new THREE.Vector3(-GW, yTop, z),
        new THREE.Vector3(GW, yTop, z)
      ));
    }
  }

  // Goal opens from Y=0 to GH. The end wall starts at yBot=R.
  // Since GH >= R, the goal opening fully covers the floor fillet zone in the goal area.
  // No additional bottom section needed under the goal.

  return mergeBufferGeometries(geoParts);
}

// ========== FILLETS (QUARTER CYLINDERS) ==========

function makeFloorSideFillet(side) {
  // Quarter cylinder along Z-axis at floor-to-side-wall junction
  // Stops at ±cornerFlatHL where vertical corners begin
  const cx = side * (HW - R);
  const cy = R;
  const zMin = -cornerFlatHL;
  const zMax = cornerFlatHL;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    // Angle goes from pointing toward floor (downward) to pointing toward wall (outward)
    const t = i / S;
    const angle = (Math.PI / 2) * t; // 0 = down, PI/2 = side
    const lx = cx + side * R * Math.sin(angle);
    const ly = cy - R * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const z = j === 0 ? zMin : zMax;
      positions.push(lx, ly, z);
      uvs.push(lx, z); // world-space UV
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    if (side === 1) {
      indices.push(a, c, b, b, c, d);
    } else {
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

function makeFloorEndFillet(side) {
  // Quarter cylinder along X-axis at floor-to-end-wall junction
  // With goal cutout: skip X range [-GW, +GW] at floor level
  const cz = side * (HL - R);
  const cy = R;
  const parts = [];

  // Left segment: X from -cornerFlatHW to -GW
  parts.push(_buildFloorEndFilletSegment(side, cz, cy, -cornerFlatHW, -GW));
  // Right segment: X from +GW to +cornerFlatHW
  parts.push(_buildFloorEndFilletSegment(side, cz, cy, GW, cornerFlatHW));
  // Goal region (X = -GW to +GW): goal opens Y=0..GH which covers the floor fillet (0..R).
  // Since GH >= R, the entire fillet would be inside the goal opening — skip it.

  return mergeBufferGeometries(parts);
}

function _buildFloorEndFilletSegment(side, cz, cy, xMin, xMax) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    const lz = cz + side * R * Math.sin(angle);
    const ly = cy - R * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const x = j === 0 ? xMin : xMax;
      positions.push(x, ly, lz);
      uvs.push(x, lz);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    if (side === -1) {
      indices.push(a, c, b, b, c, d);
    } else {
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

function makeCeilingSideFillet(side) {
  const cx = side * (HW - R);
  const cy = H - R;
  const zMin = -cornerFlatHL;
  const zMax = cornerFlatHL;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    const lx = cx + side * R * Math.sin(angle);
    const ly = cy + R * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const z = j === 0 ? zMin : zMax;
      positions.push(lx, ly, z);
      uvs.push(lx, z);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    if (side === -1) {
      indices.push(a, c, b, b, c, d);
    } else {
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

function makeCeilingEndFillet(side) {
  const cz = side * (HL - R);
  const cy = H - R;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    const lz = cz + side * R * Math.sin(angle);
    const ly = cy + R * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const x = j === 0 ? -cornerFlatHW : cornerFlatHW;
      positions.push(x, ly, lz);
      uvs.push(x, lz);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    if (side === 1) {
      indices.push(a, c, b, b, c, d);
    } else {
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

// ========== VERTICAL CORNER FILLETS ==========

function makeVerticalCorner(sx, sz) {
  // Quarter cylinder along Y-axis at the junction of side wall and end wall
  // Center at (sx*(HW - CR), y, sz*(HL - CR))
  const cx = sx * (HW - CR);
  const cz = sz * (HL - CR);
  const yBot = R;
  const yTop = R + flatH;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    // Arc sweeps from end-wall-facing to side-wall-facing
    const lx = cx + sx * CR * Math.cos(angle);
    const lz = cz + sz * CR * Math.sin(angle);

    for (let j = 0; j <= 1; j++) {
      const y = j === 0 ? yBot : yTop;
      positions.push(lx, y, lz);
      uvs.push(lx, lz);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    // Winding depends on corner orientation
    const flip = sx * sz;
    if (flip > 0) {
      indices.push(a, b, c, b, d, c);
    } else {
      indices.push(a, c, b, b, c, d);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

// ========== TRIPLE-JUNCTION CORNER PATCHES ==========

function makeTripleCorner(sx, sz, position) {
  // Toroidal patch at the junction of floor/ceiling fillet + vertical corner
  // The fillet cross-section (radius R) sweeps along the vertical corner arc (radius CR)
  const ccx = sx * (HW - CR);  // vertical corner center X
  const ccz = sz * (HL - CR);  // vertical corner center Z
  const cy = position === 'floor' ? R : H - R;
  const ySign = position === 'floor' ? -1 : 1;

  const N = Math.max(S, 6);
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const theta = (Math.PI / 2) * (i / N); // corner arc sweep in XZ (0=side wall, π/2=end wall)
      const phi = (Math.PI / 2) * (j / N);   // fillet profile (0=floor/ceiling, π/2=wall)

      // Distance from corner center in XZ: ranges from CR-R (at floor) to CR (at wall)
      const d = CR - R + R * Math.sin(phi);
      const lx = ccx + sx * d * Math.cos(theta);
      const ly = cy + ySign * R * Math.cos(phi);
      const lz = ccz + sz * d * Math.sin(theta);

      positions.push(lx, ly, lz);
      uvs.push(lx, lz);
    }
  }

  const stride = N + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;

      const flip = sx * sz * ySign;
      if (flip > 0) {
        indices.push(a, c, b, b, c, d);
      } else {
        indices.push(a, b, c, b, d, c);
      }
    }
  }

  return buildGeometry(positions, uvs, indices);
}

// ========== GOAL EDGE FILLETS ==========

function makeGoalPostFillet(side, postSide) {
  // Quarter-cylinder along Y-axis rounding the edge where end wall meets goal side wall
  // side: -1 or +1 for which end of the arena (Z direction)
  // postSide: -1 (left post) or +1 (right post)
  // The fillet curves from the end wall face INTO the goal (not into the arena).
  const cx = postSide * (GW - GER);
  const cz = side * (HL + GER);
  const yBot = 0;
  const yTop = GH - GER;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    // Arc sweeps from end-wall face (z=side*HL) into the goal interior
    const lx = cx + postSide * GER * Math.sin(angle);
    const lz = cz - side * GER * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const y = j === 0 ? yBot : yTop;
      positions.push(lx, y, lz);
      uvs.push(lx, lz);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    const flip = side * postSide;
    if (flip > 0) {
      indices.push(a, c, b, b, c, d);
    } else {
      indices.push(a, b, c, b, d, c);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

function makeGoalCrossbarFillet(side) {
  // Quarter-cylinder along X-axis rounding the edge where end wall meets goal ceiling
  // side: -1 or +1 for which end of the arena
  // The fillet curves from the end wall face INTO the goal (not into the arena).
  const cy = GH - GER;
  const cz = side * (HL + GER);
  const xMin = -(GW - GER);
  const xMax = GW - GER;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    // Arc sweeps from end-wall face (z=side*HL) into the goal interior
    const ly = cy + GER * Math.sin(angle);
    const lz = cz - side * GER * Math.cos(angle);

    for (let j = 0; j <= 1; j++) {
      const x = j === 0 ? xMin : xMax;
      positions.push(x, ly, lz);
      uvs.push(x, lz);
    }
  }

  for (let i = 0; i < S; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    if (side === -1) {
      indices.push(a, b, c, b, d, c);
    } else {
      indices.push(a, c, b, b, c, d);
    }
  }

  return buildGeometry(positions, uvs, indices);
}

function makeGoalCornerPatch(side, postSide) {
  // 1/8 sphere at the junction where a goal post fillet meets the crossbar fillet
  // Fills the gap at the post-crossbar corner. Curves INTO the goal, not the arena.
  const cx = postSide * (GW - GER);
  const cy = GH - GER;
  const cz = side * (HL + GER);
  const r = GER;

  const N = Math.max(S, 6);
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = i / N;
      const v = j / N;
      // Spherical patch: u sweeps from Y-axis (up) to horizontal, v sweeps in XZ
      const phi = (Math.PI / 2) * u;     // 0 = up (+Y), PI/2 = horizontal
      const theta = (Math.PI / 2) * v;   // sweep from Z-axis to X-axis

      const lx = cx + postSide * r * Math.sin(phi) * Math.sin(theta);
      const ly = cy + r * Math.cos(phi);
      const lz = cz - side * r * Math.sin(phi) * Math.cos(theta);

      positions.push(lx, ly, lz);
      uvs.push(lx, lz);
    }
  }

  const stride = N + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;

      const flip = side * postSide;
      if (flip > 0) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  return buildGeometry(positions, uvs, indices);
}

// ========== HELPERS ==========

function makeFlatQuad(a, b, c, d) {
  // Create a quad from 4 Vector3 corners (wound CCW from outside)
  const positions = [
    a.x, a.y, a.z,
    b.x, b.y, b.z,
    c.x, c.y, c.z,
    d.x, d.y, d.z,
  ];
  const uvs = [
    a.x, a.z,
    b.x, b.z,
    c.x, c.z,
    d.x, d.z,
  ];
  const indices = [0, 1, 2, 0, 2, 3];
  return buildGeometry(positions, uvs, indices);
}

function buildGeometry(positions, uvs, indices) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function mergeBufferGeometries(geometries) {
  // Simple merge: concatenate vertex data and offset indices
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.getAttribute('position').count;
    totalIndices += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;
  let vertCount = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const idx = g.index;

    positions.set(pos.array, vOffset * 3);
    if (uv) uvs.set(uv.array, vOffset * 2);

    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices[iOffset + i] = idx.array[i] + vOffset;
      }
      iOffset += idx.count;
    }

    vOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
