// ============================================
// ArenaShader - Neon grid via MeshStandardMaterial.onBeforeCompile
// Uses triplanar world-space projection for clean grid lines
// on all surfaces including walls and curved transitions.
// ============================================

import * as THREE from 'three';
import { ARENA, COLORS } from '../../shared/constants.js';

export function createArenaMaterial(theme = null) {
  const floorColor = theme ? theme.floorColor : COLORS.FLOOR;
  const gridCol1 = theme ? theme.gridColor1 : 0x0088ff;
  const gridCol2 = theme ? theme.gridColor2 : 0xff2200;
  const gridEmissive = theme ? theme.gridEmissive : 2.5;

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(floorColor),
    roughness: 0.8,
    metalness: 0.2,
    side: THREE.FrontSide,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.gridCellSize = { value: ARENA.GRID_CELL_SIZE };
    shader.uniforms.gridColorBlue = { value: new THREE.Color(gridCol1) };
    shader.uniforms.gridColorRed = { value: new THREE.Color(gridCol2) };
    shader.uniforms.gridEmissiveStrength = { value: gridEmissive };

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

    // Fragment shader: triplanar grid with per-half coloring
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;
      uniform float gridCellSize;
      uniform vec3 gridColorBlue;
      uniform vec3 gridColorRed;
      uniform float gridEmissiveStrength;
      float arenaGridFactor;

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

        arenaGridFactor = gXZ * blend.y + gXY * blend.z + gYZ * blend.x;

        // Blue grid for negative-Z half, red for positive-Z half
        float zBlend = smoothstep(-3.0, 3.0, vWorldPos.z);
        vec3 gridCol = mix(gridColorBlue, gridColorRed, zBlend);

        totalEmissiveRadiance += gridCol * arenaGridFactor * gridEmissiveStrength;

        // Discard fragments between grid lines so the stadium exterior
        // is visible through the shell (alpha blending alone doesn't work
        // with the post-processing pipeline)
        if (arenaGridFactor < 0.01) discard;
      }`
    );

    // Transparent shell — only neon grid lines are visible
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      `#include <output_fragment>
      gl_FragColor.a = arenaGridFactor * 0.85;`
    );
  };

  material.customProgramCacheKey = () => `arena-neon-grid-${gridCol1}-${gridCol2}`;

  return material;
}
