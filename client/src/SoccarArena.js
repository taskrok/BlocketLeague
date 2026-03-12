// ============================================
// SoccarArena — Mesh-based arena built entirely from RocketSim CMF data
// Completely independent visual + physics system, no code shared with Arena.js
// ============================================

import * as THREE from 'three';
import { getAmmo } from '../../shared/AmmoLoader.js';
import { SOCCAR_ARENA, COLORS, COLLISION_GROUPS } from '../../shared/constants.js';
import { ARENA_THEMES } from './ArenaThemes.js';

const HW = SOCCAR_ARENA.WIDTH / 2;
const HL = SOCCAR_ARENA.GOAL_MOUTH_Z;
const H  = SOCCAR_ARENA.HEIGHT;
const GW = SOCCAR_ARENA.GOAL_WIDTH / 2;
const GH = SOCCAR_ARENA.GOAL_HEIGHT;
const GD = SOCCAR_ARENA.GOAL_DEPTH;
const CR = SOCCAR_ARENA.CORNER_RADIUS;

export class SoccarArena {
  constructor(scene, world, theme = null, meshData = null) {
    this.scene = scene;
    this.world = world;
    this.Ammo = getAmmo();
    this.meshes = [];
    this.theme = theme || ARENA_THEMES[0];
    this.meshData = meshData;

    this._buildShell();
    this._buildTurf();
    this._buildTrimesh();
    this._buildContainmentPlanes();
    this._buildGoalWalls();
    this._buildGoalStructures();
    this._buildStadiumLights();
    this._buildPitchMarkings();
  }

  // ========== ARENA SHELL — hex wireframe material on mesh ==========

  _buildShell() {
    if (!this.meshData) return;

    const { vertices, indices } = this.meshData;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Flip normals inward
    const nrm = geo.getAttribute('normal');
    const pos = geo.getAttribute('position');
    const cy = H / 2;
    for (let i = 0; i < pos.count; i++) {
      const dx = -pos.getX(i);
      const dy = cy - pos.getY(i);
      const dz = -pos.getZ(i);
      if (nrm.getX(i) * dx + nrm.getY(i) * dy + nrm.getZ(i) * dz < 0) {
        nrm.setX(i, -nrm.getX(i));
        nrm.setY(i, -nrm.getY(i));
        nrm.setZ(i, -nrm.getZ(i));
      }
    }
    nrm.needsUpdate = true;

    // Solid metallic shell with scanline effect
    const t = this.theme;
    const shellMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.floorColor),
      roughness: 0.4,
      metalness: 0.6,
      side: THREE.DoubleSide,
    });

    shellMat.onBeforeCompile = (shader) => {
      shader.uniforms.uColor1 = { value: new THREE.Color(t.gridColor1) };
      shader.uniforms.uColor2 = { value: new THREE.Color(t.gridColor2) };
      shader.uniforms.uGlow = { value: t.gridEmissive || 2.5 };

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * normal);`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        uniform vec3 uColor1;
        uniform vec3 uColor2;
        uniform float uGlow;

        float hexGrid(vec2 p) {
          // Hexagonal grid pattern
          float s = 4.0;
          vec2 a = mod(p, s) - s * 0.5;
          vec2 b = mod(p + s * 0.5, s) - s * 0.5;
          float d = min(dot(a, a), dot(b, b));
          return smoothstep(0.15, 0.25, sqrt(d));
        }

        float scanlines(float y) {
          return 0.92 + 0.08 * sin(y * 3.14159 * 2.0);
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 absN = abs(normalize(vWNrm));
          absN = absN / (absN.x + absN.y + absN.z + 0.001);

          // Triplanar hex grid
          float hXZ = 1.0 - hexGrid(vWPos.xz);
          float hXY = 1.0 - hexGrid(vWPos.xy);
          float hYZ = 1.0 - hexGrid(vWPos.yz);
          float hex = hXZ * absN.y + hXY * absN.z + hYZ * absN.x;

          // Horizontal scanlines on walls
          float scan = scanlines(vWPos.y * 0.5);

          // Team color split
          float zMix = smoothstep(-5.0, 5.0, vWPos.z);
          vec3 lineCol = mix(uColor1, uColor2, zMix);

          float edge = hex * scan;
          totalEmissiveRadiance += lineCol * edge * uGlow;
        }`
      );

      // Make non-hex areas mostly transparent, hex lines opaque
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        `#include <output_fragment>
        {
          vec3 absN2 = abs(normalize(vWNrm));
          absN2 = absN2 / (absN2.x + absN2.y + absN2.z + 0.001);
          float hh = (1.0 - hexGrid(vWPos.xz)) * absN2.y
                   + (1.0 - hexGrid(vWPos.xy)) * absN2.z
                   + (1.0 - hexGrid(vWPos.yz)) * absN2.x;
          float alpha = max(hh * 0.9, 0.04);
          gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha);
        }`
      );
    };

    shellMat.transparent = true;
    shellMat.depthWrite = false;
    shellMat.premultipliedAlpha = true;
    shellMat.blending = THREE.CustomBlending;
    shellMat.blendSrc = THREE.OneFactor;
    shellMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    shellMat.customProgramCacheKey = () => `soccar-hex-${t.gridColor1}-${t.gridColor2}`;

    const mesh = new THREE.Mesh(geo, shellMat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.arenaMesh = mesh;
  }

  // ========== TURF — diamond-cut synthetic turf ==========

  _buildTurf() {
    const t = this.theme;
    const turfMat = new THREE.ShaderMaterial({
      uniforms: {
        uCol1: { value: new THREE.Color(t.grass1) },
        uCol2: { value: new THREE.Color(t.grass2) },
        uHW: { value: HW },
        uHL: { value: HL },
      },
      vertexShader: `
        varying vec2 vUV;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vUV = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uCol1, uCol2;
        uniform float uHW, uHL;
        varying vec2 vUV;

        void main() {
          // Diamond checkerboard pattern
          float scale = 10.0;
          float dx = abs(fract(vUV.x / scale) - 0.5);
          float dz = abs(fract(vUV.y / scale) - 0.5);
          float diamond = step(dx + dz, 0.5);
          vec3 col = mix(uCol1, uCol2, diamond);

          // Subtle variation
          float n = fract(sin(dot(vUV * 0.1, vec2(127.1, 311.7))) * 43758.5453);
          col += (n - 0.5) * 0.02;

          // Circular fade near walls
          float r = length(vUV / vec2(uHW, uHL));
          float fade = 1.0 - smoothstep(0.85, 1.0, r);

          gl_FragColor = vec4(col, fade);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    const turfGeo = new THREE.PlaneGeometry(HW * 2, HL * 2);
    turfGeo.rotateX(-Math.PI / 2);
    const turfMesh = new THREE.Mesh(turfGeo, turfMat);
    turfMesh.position.y = 0.03;
    turfMesh.renderOrder = 1;
    this.scene.add(turfMesh);
    this.meshes.push(turfMesh);
  }

  // ========== TRIMESH (ammo.js — single collider for ball AND car) ==========

  _buildTrimesh() {
    if (!this.meshData) return;
    const Ammo = this.Ammo;
    const { vertices, indices } = this.meshData;

    const triMesh = new Ammo.btTriangleMesh(true, true);
    const v0 = new Ammo.btVector3(0, 0, 0);
    const v1 = new Ammo.btVector3(0, 0, 0);
    const v2 = new Ammo.btVector3(0, 0, 0);

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;
      v0.setValue(vertices[i0], vertices[i0 + 1], vertices[i0 + 2]);
      v1.setValue(vertices[i1], vertices[i1 + 1], vertices[i1 + 2]);
      v2.setValue(vertices[i2], vertices[i2 + 1], vertices[i2 + 2]);
      triMesh.addTriangle(v0, v1, v2, false);
    }

    Ammo.destroy(v0);
    Ammo.destroy(v1);
    Ammo.destroy(v2);

    const meshShape = new Ammo.btBvhTriangleMeshShape(triMesh, true, true);
    meshShape.setMargin(0.04);

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    const origin = new Ammo.btVector3(0, 0, 0);
    transform.setOrigin(origin);
    const motionState = new Ammo.btDefaultMotionState(transform);
    const localInertia = new Ammo.btVector3(0, 0, 0);
    const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, meshShape, localInertia);
    this.trimeshBody = new Ammo.btRigidBody(rbInfo);

    this.trimeshBody.setFriction(0.35);
    this.trimeshBody.setRestitution(0.3);

    // Trimesh only collides with ball — cars use raycasts for wall driving
    // and analytical containment to stay in bounds
    const group = COLLISION_GROUPS.ARENA_TRIMESH;
    const mask = COLLISION_GROUPS.BALL;
    this.world.addRigidBody(this.trimeshBody, group, mask);

    Ammo.destroy(origin);
    Ammo.destroy(transform);
    Ammo.destroy(localInertia);
    Ammo.destroy(rbInfo);

    this._triMesh = triMesh;
    this._meshShape = meshShape;
  }

  // ========== CONTAINMENT PLANES (backup) ==========

  _buildContainmentPlanes() {
    const Ammo = this.Ammo;
    const group = COLLISION_GROUPS.ARENA_CONTAINMENT;
    const mask = COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;

    const addPlane = (nx, ny, nz, d) => {
      const normal = new Ammo.btVector3(nx, ny, nz);
      const shape = new Ammo.btStaticPlaneShape(normal, d);
      shape.setMargin(0.04);
      const transform = new Ammo.btTransform();
      transform.setIdentity();
      const motionState = new Ammo.btDefaultMotionState(transform);
      const localInertia = new Ammo.btVector3(0, 0, 0);
      const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
      const body = new Ammo.btRigidBody(rbInfo);
      body.setFriction(0.35);
      body.setRestitution(0.3);
      this.world.addRigidBody(body, group, mask);
      Ammo.destroy(normal);
      Ammo.destroy(transform);
      Ammo.destroy(localInertia);
      Ammo.destroy(rbInfo);
    };

    addPlane(0, 1, 0, 0);      // floor
    addPlane(0, -1, 0, -H);    // ceiling
    addPlane(1, 0, 0, -HW);    // left wall
    addPlane(-1, 0, 0, -HW);   // right wall
  }

  // ========== GOAL INTERIOR WALLS ==========

  _buildGoalWalls() {
    const Ammo = this.Ammo;
    const group = COLLISION_GROUPS.ARENA_CONTAINMENT;
    const mask = COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
    const t = SOCCAR_ARENA.WALL_THICKNESS;

    const addBox = (hx, hy, hz, px, py, pz) => {
      const halfExtents = new Ammo.btVector3(hx, hy, hz);
      const shape = new Ammo.btBoxShape(halfExtents);
      shape.setMargin(0.04);
      const transform = new Ammo.btTransform();
      transform.setIdentity();
      const pos = new Ammo.btVector3(px, py, pz);
      transform.setOrigin(pos);
      const motionState = new Ammo.btDefaultMotionState(transform);
      const localInertia = new Ammo.btVector3(0, 0, 0);
      const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
      const body = new Ammo.btRigidBody(rbInfo);
      body.setFriction(0.35);
      body.setRestitution(0.1);
      this.world.addRigidBody(body, group, mask);
      Ammo.destroy(halfExtents);
      Ammo.destroy(pos);
      Ammo.destroy(transform);
      Ammo.destroy(localInertia);
      Ammo.destroy(rbInfo);
    };

    [-1, 1].forEach(side => {
      const zMouth = side * HL;
      // Back wall
      addBox(GW, GH / 2, t / 2, 0, GH / 2, side * (HL + GD) + side * t / 2);
      // Side walls
      [-1, 1].forEach(sx => {
        const fd = GD / 2;
        addBox(t / 2, GH / 2, fd, sx * (GW + t / 2), GH / 2, zMouth + side * fd);
      });
      // Ceiling
      addBox(GW, t / 2, GD / 2, 0, GH + t / 2, zMouth + side * GD / 2);
    });
  }

  // ========== GOALS — cylindrical posts with glow rings ==========

  _buildGoalStructures() {
    [-1, 1].forEach((side, idx) => {
      const zm = side * HL;
      const teamColor = idx === 0 ? COLORS.GOAL_BLUE : COLORS.GOAL_ORANGE;

      // Cylindrical posts (not boxes)
      const postR = 0.25;
      const postGeo = new THREE.CylinderGeometry(postR, postR, GH, 8);
      const postMat = new THREE.MeshStandardMaterial({
        color: 0x888888,
        metalness: 0.9,
        roughness: 0.1,
      });

      [-1, 1].forEach(sx => {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(sx * GW, GH / 2, zm);
        this.scene.add(post);
      });

      // Crossbar (horizontal cylinder)
      const barGeo = new THREE.CylinderGeometry(postR, postR, GW * 2, 8);
      barGeo.rotateZ(Math.PI / 2);
      const bar = new THREE.Mesh(barGeo, postMat);
      bar.position.set(0, GH, zm);
      this.scene.add(bar);

      // Glow rings around posts (unique to this arena)
      const ringMat = new THREE.MeshBasicMaterial({
        color: teamColor,
        transparent: true,
        opacity: 0.7,
      });

      const ringCount = 3;
      for (let r = 0; r < ringCount; r++) {
        const y = (GH / (ringCount + 1)) * (r + 1);
        const ringGeo = new THREE.TorusGeometry(postR + 0.15, 0.06, 8, 16);
        [-1, 1].forEach(sx => {
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.position.set(sx * GW, y, zm);
          ring.rotation.x = Math.PI / 2;
          this.scene.add(ring);
        });
      }

      // Goal net — translucent back panel
      const netMat = new THREE.MeshStandardMaterial({
        color: teamColor,
        emissive: teamColor,
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        wireframe: true,
      });

      // Back net
      const backNet = new THREE.Mesh(
        new THREE.PlaneGeometry(GW * 2, GH, 12, 6),
        netMat
      );
      backNet.position.set(0, GH / 2, zm + side * GD);
      this.scene.add(backNet);

      // Side nets
      [-1, 1].forEach(sx => {
        const sideNet = new THREE.Mesh(
          new THREE.PlaneGeometry(GD, GH, 6, 6),
          netMat
        );
        sideNet.position.set(sx * GW, GH / 2, zm + side * GD / 2);
        sideNet.rotation.y = Math.PI / 2;
        this.scene.add(sideNet);
      });

      // Ceiling net
      const ceilNet = new THREE.Mesh(
        new THREE.PlaneGeometry(GW * 2, GD, 12, 6),
        netMat
      );
      ceilNet.position.set(0, GH, zm + side * GD / 2);
      ceilNet.rotation.x = Math.PI / 2;
      this.scene.add(ceilNet);

      // Goal line — glowing strip on floor
      const lineMat = new THREE.MeshStandardMaterial({
        color: teamColor,
        emissive: teamColor,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.6,
      });
      const goalLine = new THREE.Mesh(
        new THREE.PlaneGeometry(GW * 2, 0.4),
        lineMat
      );
      goalLine.rotation.x = -Math.PI / 2;
      goalLine.position.set(0, 0.04, zm);
      this.scene.add(goalLine);

      // Team color point light inside goal
      const gLight = new THREE.PointLight(teamColor, 0.6, 25);
      gLight.position.set(0, GH / 2, zm + side * GD * 0.6);
      this.scene.add(gLight);
    });
  }

  // ========== STADIUM LIGHTS — overhead ring of spotlights ==========

  _buildStadiumLights() {
    const t = this.theme;

    // Ambient
    const ambient = new THREE.AmbientLight(t.ambientColor, 0.6);
    this.scene.add(ambient);

    // Hemisphere light for sky/ground color separation
    const hemi = new THREE.HemisphereLight(t.lightColor, 0x111122, 0.4);
    this.scene.add(hemi);

    // 6 spotlights in an oval ring above the field
    const spotCount = 6;
    for (let i = 0; i < spotCount; i++) {
      const angle = (i / spotCount) * Math.PI * 2;
      const x = Math.cos(angle) * HW * 0.7;
      const z = Math.sin(angle) * HL * 0.7;

      const spot = new THREE.SpotLight(t.lightColor, 1.0, 0, Math.PI / 4, 0.5, 1);
      spot.position.set(x, H + 10, z);
      spot.target.position.set(0, 0, 0);
      this.scene.add(spot);
      this.scene.add(spot.target);

      // Small glowing sphere at light position (visible fixture)
      const bulbGeo = new THREE.SphereGeometry(0.5, 8, 8);
      const bulbMat = new THREE.MeshBasicMaterial({
        color: t.lightColor,
        transparent: true,
        opacity: 0.4,
      });
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.copy(spot.position);
      this.scene.add(bulb);
    }
  }

  // ========== PITCH MARKINGS — penalty arcs, corner arcs, center diamond ==========

  _buildPitchMarkings() {
    const t = this.theme;
    const markMat1 = new THREE.MeshStandardMaterial({
      color: t.markingBlue,
      emissive: t.markingBlue,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const markMat2 = new THREE.MeshStandardMaterial({
      color: t.markingRed,
      emissive: t.markingRed,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const yMark = 0.05;

    // Center diamond (instead of center circle)
    const dSize = 12;
    const diamondShape = new THREE.Shape();
    diamondShape.moveTo(dSize, 0);
    diamondShape.lineTo(0, dSize);
    diamondShape.lineTo(-dSize, 0);
    diamondShape.lineTo(0, -dSize);
    diamondShape.closePath();

    // Inner cutout
    const inner = dSize - 0.4;
    const hole = new THREE.Path();
    hole.moveTo(inner, 0);
    hole.lineTo(0, inner);
    hole.lineTo(-inner, 0);
    hole.lineTo(0, -inner);
    hole.closePath();
    diamondShape.holes.push(hole);

    const diamondGeo = new THREE.ShapeGeometry(diamondShape);
    diamondGeo.rotateX(-Math.PI / 2);

    // Blue half (negative Z)
    const dBlue = new THREE.Mesh(diamondGeo, markMat1);
    dBlue.position.y = yMark;
    this.scene.add(dBlue);

    // Center line
    const centerGeo = new THREE.PlaneGeometry(HW * 2, 0.3);
    centerGeo.rotateX(-Math.PI / 2);
    const centerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const centerLine = new THREE.Mesh(centerGeo, centerMat);
    centerLine.position.y = yMark;
    this.scene.add(centerLine);

    // Penalty arcs (semicircles near each goal)
    [-1, 1].forEach((side, idx) => {
      const mat = idx === 0 ? markMat1 : markMat2;
      const arcR = 18;
      const arcGeo = new THREE.RingGeometry(arcR - 0.3, arcR, 32, 1,
        side > 0 ? Math.PI : 0, Math.PI);
      arcGeo.rotateX(-Math.PI / 2);
      const arc = new THREE.Mesh(arcGeo, mat);
      arc.position.set(0, yMark, side * HL * 0.65);
      this.scene.add(arc);

      // Penalty box outline
      const boxW = GW * 1.8;
      const boxD = 20;
      const lineW = 0.25;

      // Front line of penalty box
      const frontLine = new THREE.Mesh(
        new THREE.PlaneGeometry(boxW * 2, lineW),
        mat
      );
      frontLine.rotation.x = -Math.PI / 2;
      frontLine.position.set(0, yMark, side * (HL - boxD));
      this.scene.add(frontLine);

      // Side lines of penalty box
      [-1, 1].forEach(sx => {
        const sideLine = new THREE.Mesh(
          new THREE.PlaneGeometry(lineW, boxD),
          mat
        );
        sideLine.rotation.x = -Math.PI / 2;
        sideLine.position.set(sx * boxW, yMark, side * (HL - boxD / 2));
        this.scene.add(sideLine);
      });
    });

    // Corner arcs (quarter circles at each corner of the playing field)
    const cornerR = 4;
    [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([sx, sz]) => {
      const startAngle = sx > 0
        ? (sz > 0 ? Math.PI : Math.PI * 1.5)
        : (sz > 0 ? Math.PI * 0.5 : 0);

      const cornerGeo = new THREE.RingGeometry(cornerR - 0.2, cornerR, 16, 1, startAngle, Math.PI / 2);
      cornerGeo.rotateX(-Math.PI / 2);
      const corner = new THREE.Mesh(cornerGeo, sz < 0 ? markMat1 : markMat2);
      corner.position.set(sx * (HW - CR * 0.5), yMark, sz * (HL - CR * 0.5));
      this.scene.add(corner);
    });
  }

  // ========== GOAL DETECTION ==========

  isInGoal(position) {
    if (Math.abs(position.x) < GW && position.y < GH) {
      if (position.z < -HL && position.z > -(HL + GD)) return 1;
      if (position.z > HL && position.z < HL + GD) return 2;
    }
    return 0;
  }
}
