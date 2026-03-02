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

// Inner flat extents (after subtracting fillet radii)
const flatHW = HW - R;   // flat floor/ceiling half-width in X
const flatHL = HL - R;   // flat floor/ceiling half-length in Z
const flatH  = H - 2 * R; // flat wall height (between top of floor fillet and bottom of ceiling fillet)

export function createArenaGeometry() {
  const parts = [];

  // 1) Floor (flat center)
  parts.push(makeFloorWithGoalCutouts());

  // 2) Ceiling (flat center)
  parts.push(makeCeiling());

  // 3) Side walls (left & right flat sections)
  parts.push(makeSideWall(-1)); // left  (X = -HW)
  parts.push(makeSideWall(1));  // right (X = +HW)

  // 4) End walls (with goal cutouts)
  parts.push(makeEndWall(-1)); // Z = -HL
  parts.push(makeEndWall(1));  // Z = +HL

  // 5) Floor-to-side-wall fillets (left & right, long edges along Z)
  parts.push(makeFloorSideFillet(-1));
  parts.push(makeFloorSideFillet(1));

  // 6) Floor-to-end-wall fillets (front & back, long edges along X — with goal cutouts)
  parts.push(makeFloorEndFillet(-1));
  parts.push(makeFloorEndFillet(1));

  // 7) Ceiling-to-side-wall fillets
  parts.push(makeCeilingSideFillet(-1));
  parts.push(makeCeilingSideFillet(1));

  // 8) Ceiling-to-end-wall fillets
  parts.push(makeCeilingEndFillet(-1));
  parts.push(makeCeilingEndFillet(1));

  // 9) Vertical corner fillets (4 corners where side walls meet end walls)
  parts.push(makeVerticalCorner(-1, -1));
  parts.push(makeVerticalCorner(1, -1));
  parts.push(makeVerticalCorner(-1, 1));
  parts.push(makeVerticalCorner(1, 1));

  // 10) Triple-junction corner patches (8 total: 4 corners × floor + ceiling)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(makeTripleCorner(sx, sz, 'floor'));
      parts.push(makeTripleCorner(sx, sz, 'ceiling'));
    }
  }

  // 11) Goal edge fillets (rounded posts + crossbar + corner patches)
  for (const side of [-1, 1]) {
    parts.push(makeGoalPostFillet(side, -1));  // left post
    parts.push(makeGoalPostFillet(side, 1));   // right post
    parts.push(makeGoalCrossbarFillet(side));   // crossbar
    parts.push(makeGoalCornerPatch(side, -1)); // left post-crossbar junction
    parts.push(makeGoalCornerPatch(side, 1));  // right post-crossbar junction
  }

  // Merge all parts into one geometry
  const merged = mergeBufferGeometries(parts);

  // Fix face winding so all normals point INWARD (toward arena center)
  // cannon-es sphere-trimesh is one-sided — wrong normals = ball falls through
  ensureInwardNormals(merged);

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
  // Wall runs from Z = -flatHL to +flatHL, Y = R to R+flatH
  // For left wall, normal points +X (inward); for right, -X
  if (side === -1) {
    return makeFlatQuad(
      new THREE.Vector3(x, R, flatHL),
      new THREE.Vector3(x, R, -flatHL),
      new THREE.Vector3(x, R + flatH, -flatHL),
      new THREE.Vector3(x, R + flatH, flatHL)
    );
  } else {
    return makeFlatQuad(
      new THREE.Vector3(x, R, -flatHL),
      new THREE.Vector3(x, R, flatHL),
      new THREE.Vector3(x, R + flatH, flatHL),
      new THREE.Vector3(x, R + flatH, -flatHL)
    );
  }
}

function makeEndWall(side) {
  // side = -1 for Z = -HL, +1 for Z = +HL
  const z = side * HL;
  const yBot = R;
  const yTop = R + flatH;

  const geoParts = [];

  // Left section: from X = -flatHW to X = -GW
  if (side === -1) {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(-flatHW, yBot, z),
      new THREE.Vector3(-GW, yBot, z),
      new THREE.Vector3(-GW, yTop, z),
      new THREE.Vector3(-flatHW, yTop, z)
    ));
  } else {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(-GW, yBot, z),
      new THREE.Vector3(-flatHW, yBot, z),
      new THREE.Vector3(-flatHW, yTop, z),
      new THREE.Vector3(-GW, yTop, z)
    ));
  }

  // Right section: from X = +GW to X = +flatHW
  if (side === -1) {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(GW, yBot, z),
      new THREE.Vector3(flatHW, yBot, z),
      new THREE.Vector3(flatHW, yTop, z),
      new THREE.Vector3(GW, yTop, z)
    ));
  } else {
    geoParts.push(makeFlatQuad(
      new THREE.Vector3(flatHW, yBot, z),
      new THREE.Vector3(GW, yBot, z),
      new THREE.Vector3(GW, yTop, z),
      new THREE.Vector3(flatHW, yTop, z)
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
  // Center of arc at (side*(HW-R), R, z)
  // For side=-1: arc from angle PI (pointing -X = floor) to PI/2 (pointing +Y = wall)
  // Actually: floor is at Y=0, wall is at X=side*HW
  // Arc center at (side*(HW-R), R)
  // At angle 0: center + (R, 0) = wall position X = side*HW (when side=1)
  // At angle PI/2: center + (0, -R) = floor position Y = 0
  const cx = side * (HW - R);
  const cy = R;
  const zMin = -flatHL;
  const zMax = flatHL;

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

  // Left segment: X from -flatHW to -GW
  parts.push(_buildFloorEndFilletSegment(side, cz, cy, -flatHW, -GW));
  // Right segment: X from +GW to +flatHW
  parts.push(_buildFloorEndFilletSegment(side, cz, cy, GW, flatHW));
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
  const zMin = -flatHL;
  const zMax = flatHL;

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
      const x = j === 0 ? -flatHW : flatHW;
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
  // Spherical-ish patch at the junction of floor/ceiling fillet + side fillet + vertical corner
  // We use a parametric surface: bilinear blend of three fillet arcs
  const r = R; // use the smaller fillet radius for the blend
  const cx = sx * (HW - r);
  const cz = sz * (HL - r);
  const cy = position === 'floor' ? r : H - r;
  const ySign = position === 'floor' ? -1 : 1;

  const N = Math.max(S, 6); // resolution for the patch
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = i / N;
      const v = j / N;
      // Spherical coordinates: u controls angle from Y-axis, v controls angle around Y
      const phi = (Math.PI / 2) * u;   // 0 = along Y, PI/2 = horizontal
      const theta = (Math.PI / 2) * v; // sweep in XZ plane

      const lx = cx + sx * r * Math.sin(phi) * Math.cos(theta);
      const ly = cy + ySign * r * Math.cos(phi);
      const lz = cz + sz * r * Math.sin(phi) * Math.sin(theta);

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
  const cx = postSide * (GW - GER);
  const cz = side * (HL - GER);
  const yBot = 0;
  const yTop = GH - GER;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    // Arc sweeps from end-wall tangent (facing into arena on Z) to goal-side-wall tangent (facing inward on X)
    const lx = cx + postSide * GER * Math.sin(angle);
    const lz = cz + side * GER * Math.cos(angle);

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
  const cy = GH - GER;
  const cz = side * (HL - GER);
  const xMin = -(GW - GER);
  const xMax = GW - GER;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const angle = (Math.PI / 2) * t;
    // Arc sweeps from end-wall tangent (facing into arena on Z) to goal-ceiling tangent (facing down on Y)
    const ly = cy + GER * Math.sin(angle);
    const lz = cz + side * GER * Math.cos(angle);

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
  // Fills the gap at the post-crossbar corner
  const cx = postSide * (GW - GER);
  const cy = GH - GER;
  const cz = side * (HL - GER);
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
      const lz = cz + side * r * Math.sin(phi) * Math.cos(theta);

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
