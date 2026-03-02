// ============================================
// ArenaShader - Neon grid via MeshStandardMaterial.onBeforeCompile
// Uses triplanar world-space projection for clean grid lines
// on all surfaces including walls and curved transitions.
// ============================================

import * as THREE from 'three';
import { ARENA, COLORS } from '../../shared/constants.js';

export function createArenaMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(COLORS.FLOOR),
    roughness: 0.8,
    metalness: 0.2,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.gridCellSize = { value: ARENA.GRID_CELL_SIZE };
    shader.uniforms.gridColor = { value: new THREE.Color(COLORS.GRID) };
    shader.uniforms.gridEmissiveStrength = { value: 2.5 };

    // Vertex shader: pass world position and world normal
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vWorldNrm = normalize(mat3(modelMatrix) * normal);`
    );

    // Fragment shader: triplanar grid
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;
      uniform float gridCellSize;
      uniform vec3 gridColor;
      uniform float gridEmissiveStrength;

      float gridLine(vec2 coord) {
        vec2 grid = abs(fract(coord - 0.5) - 0.5);
        vec2 lw = fwidth(coord) * 1.5;
        vec2 lines = smoothstep(lw * 0.5, lw * 1.5, grid);
        return 1.0 - min(lines.x, lines.y);
      }`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        // Triplanar blending — picks the right grid projection per surface
        vec3 blend = abs(normalize(vWorldNrm));
        blend = blend / (blend.x + blend.y + blend.z + 0.001);

        float gXZ = gridLine(vWorldPos.xz / gridCellSize); // floor / ceiling
        float gXY = gridLine(vWorldPos.xy / gridCellSize); // end walls (front/back)
        float gYZ = gridLine(vWorldPos.yz / gridCellSize); // side walls (left/right)

        float gridFactor = gXZ * blend.y + gXY * blend.z + gYZ * blend.x;
        totalEmissiveRadiance += gridColor * gridFactor * gridEmissiveStrength;
      }`
    );
  };

  material.customProgramCacheKey = () => 'arena-neon-grid-v2';

  return material;
}
