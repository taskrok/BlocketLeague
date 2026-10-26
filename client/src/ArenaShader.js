// ============================================
// ArenaShader - Neon grid via MeshBasicMaterial.onBeforeCompile
// Uses triplanar world-space projection for clean grid lines
// on all surfaces including walls and curved transitions.
//
// The shell is unlit: the grid is purely emissive, so PBR lighting added
// nothing but cost. Fragments that are not on a grid line are discarded
// before any further work, so the (full-viewport, transparent) shell only
// pays for the ~5% of pixels that actually show a line.
// ============================================

import * as THREE from 'three';
import { ARENA, COLORS } from '../../shared/constants.js';

// Fraction of the (unlit) floor colour mixed under the grid lines. Approximates
// the ambient-lit base the old MeshStandardMaterial produced on line pixels.
const BASE_TINT = 0.35;

function replaceOrWarn(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    console.warn(`[ArenaShader] shader chunk "${needle}" not found (${label}); grid shader may be incomplete`);
    return source;
  }
  return source.replace(needle, replacement);
}

export function createArenaMaterial(theme = null) {
  const floorColor = theme ? theme.floorColor : COLORS.FLOOR;
  const gridCol1 = theme ? theme.gridColor1 : 0x0088ff;
  const gridCol2 = theme ? theme.gridColor2 : 0xff2200;
  const gridEmissive = theme ? theme.gridEmissive : 2.5;

  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(floorColor),
    side: THREE.FrontSide,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
  });

  // Exposed so callers can retarget the grid at runtime (theme change) without
  // recompiling: material.userData.gridUniforms.gridColorBlue.value.set(...)
  const gridUniforms = {
    gridCellSize: { value: ARENA.GRID_CELL_SIZE },
    gridColorBlue: { value: new THREE.Color(gridCol1) },
    gridColorRed: { value: new THREE.Color(gridCol2) },
    gridEmissiveStrength: { value: gridEmissive },
    gridBaseTint: { value: BASE_TINT },
  };
  material.userData.gridUniforms = gridUniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, gridUniforms);

    // Vertex shader: pass world position and world normal.
    // (`normal` is always declared in three's vertex prefix, even for MeshBasicMaterial.)
    shader.vertexShader = replaceOrWarn(shader.vertexShader,
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;`,
      'vertex common');

    shader.vertexShader = replaceOrWarn(shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vWorldNrm = normalize(mat3(modelMatrix) * normal);`,
      'begin_vertex');

    // Fragment shader: declarations + grid helper
    shader.fragmentShader = replaceOrWarn(shader.fragmentShader,
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;
      uniform float gridCellSize;
      uniform vec3 gridColorBlue;
      uniform vec3 gridColorRed;
      uniform float gridEmissiveStrength;
      uniform float gridBaseTint;
      float arenaGridFactor;
      vec3 arenaGridEmissive;

      float gridLine(vec2 coord) {
        vec2 grid = abs(fract(coord - 0.5) - 0.5);
        vec2 lw = fwidth(coord) * 1.5;
        vec2 lines = smoothstep(lw * 0.5, lw * 1.5, grid);
        return 1.0 - min(lines.x, lines.y);
      }`,
      'fragment common');

    // Compute the grid as the very first thing in main() and bail out early
    // for the (vast majority of) fragments that are not on a line.
    shader.fragmentShader = replaceOrWarn(shader.fragmentShader,
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `vec4 diffuseColor = vec4( diffuse, opacity );
      {
        // Triplanar blending — picks the right grid projection per surface
        vec3 blend = abs(normalize(vWorldNrm));
        blend = blend / (blend.x + blend.y + blend.z + 0.001);

        float gXZ = gridLine(vWorldPos.xz / gridCellSize); // floor / ceiling
        float gXY = gridLine(vWorldPos.xy / gridCellSize); // end walls (front/back)
        float gYZ = gridLine(vWorldPos.yz / gridCellSize); // side walls (left/right)

        arenaGridFactor = gXZ * blend.y + gXY * blend.z + gYZ * blend.x;
        if (arenaGridFactor < 0.01) discard;

        // Blue grid for negative-Z half, red for positive-Z half
        float zBlend = smoothstep(-3.0, 3.0, vWorldPos.z);
        vec3 gridCol = mix(gridColorBlue, gridColorRed, zBlend);

        arenaGridEmissive = gridCol * arenaGridFactor * gridEmissiveStrength;
      }`,
      'diffuseColor');

    // Replace the unlit base colour with base tint + emissive grid
    shader.fragmentShader = replaceOrWarn(shader.fragmentShader,
      'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
      'vec3 outgoingLight = reflectedLight.indirectDiffuse * gridBaseTint + arenaGridEmissive;',
      'outgoingLight');

    // Transparent shell — only neon grid lines are visible.
    // (r154+ renamed <output_fragment> to <opaque_fragment>.)
    shader.fragmentShader = replaceOrWarn(shader.fragmentShader,
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
      gl_FragColor.a = arenaGridFactor * 0.85;`,
      'opaque_fragment');
  };

  // Colours are uniforms, so one program serves every theme.
  material.customProgramCacheKey = () => 'arena-neon-grid';

  return material;
}
