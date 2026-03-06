// Convert RocketSim .cmf collision mesh files to JSON for cannon-es trimesh
// CMF format: int32 triCount, int32 vertCount, then triCount*3 int32 indices, then vertCount*3 float32 vertices
// RL coordinate system: X = right, Y = forward (goal-to-goal), Z = up
// Our coordinate system: X = right, Y = up, Z = forward (goal-to-goal)
// NO SCALING — just coordinate swap. The mesh defines the arena dimensions.

import fs from 'fs';
import path from 'path';

const inputDir = path.resolve('assets/collision_meshes');
const outputJson = path.resolve('client/public/arena_collision.json');
const serverOutput = path.resolve('assets/arena_collision.json');

const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.cmf')).sort();

const allMeshes = [];

for (const file of files) {
  const buf = fs.readFileSync(path.join(inputDir, file));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let offset = 0;
  const numTris = view.getInt32(offset, true); offset += 4;
  const numVerts = view.getInt32(offset, true); offset += 4;

  const indices = [];
  for (let i = 0; i < numTris * 3; i++) {
    indices.push(view.getInt32(offset, true));
    offset += 4;
  }

  const rawVerts = [];
  for (let i = 0; i < numVerts; i++) {
    const x = view.getFloat32(offset, true); offset += 4;
    const y = view.getFloat32(offset, true); offset += 4;
    const z = view.getFloat32(offset, true); offset += 4;
    rawVerts.push([x, y, z]);
  }

  console.log(`${file}: ${numTris} tris, ${numVerts} verts`);
  allMeshes.push({ name: file, rawVerts, indices, numVerts, numTris });
}

// Combine ALL meshes (no exclusions) with coordinate swap only
const combinedVertices = [];
const combinedIndices = [];
let vertexOffset = 0;
let totalVerts = 0;
let totalTris = 0;

for (const mesh of allMeshes) {
  // Coordinate swap: GameX = RL_X, GameY = RL_Z, GameZ = RL_Y
  for (const [rx, ry, rz] of mesh.rawVerts) {
    combinedVertices.push(
      Math.round(rx * 100) / 100,   // X stays
      Math.round(rz * 100) / 100,   // Y = RL_Z (up)
      Math.round(ry * 100) / 100    // Z = RL_Y (forward)
    );
  }
  for (const idx of mesh.indices) {
    combinedIndices.push(idx + vertexOffset);
  }
  vertexOffset += mesh.numVerts;
  totalVerts += mesh.numVerts;
  totalTris += mesh.numTris;
}

// Validate
const maxIdx = Math.max(...combinedIndices);
const minIdx = Math.min(...combinedIndices);
console.log(`\nCombined: ${totalVerts} verts, ${totalTris} tris`);
console.log(`Index range: ${minIdx} to ${maxIdx} (should be 0 to ${totalVerts - 1})`);
if (minIdx < 0 || maxIdx >= totalVerts) {
  console.error('ERROR: Invalid indices detected!');
  process.exit(1);
}

// Compute bounding box
let minX = Infinity, maxX = -Infinity;
let minY = Infinity, maxY = -Infinity;
let minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < combinedVertices.length; i += 3) {
  minX = Math.min(minX, combinedVertices[i]);
  maxX = Math.max(maxX, combinedVertices[i]);
  minY = Math.min(minY, combinedVertices[i + 1]);
  maxY = Math.max(maxY, combinedVertices[i + 1]);
  minZ = Math.min(minZ, combinedVertices[i + 2]);
  maxZ = Math.max(maxZ, combinedVertices[i + 2]);
}
console.log(`Bounds: X [${minX}, ${maxX}], Y [${minY}, ${maxY}], Z [${minZ}, ${maxZ}]`);

// Write JSON
const json = JSON.stringify({ vertices: combinedVertices, indices: combinedIndices });
fs.writeFileSync(outputJson, json);
console.log(`\nWrote ${outputJson} (${(fs.statSync(outputJson).size / 1024).toFixed(0)} KB)`);

fs.copyFileSync(outputJson, serverOutput);
console.log(`Copied to ${serverOutput}`);
