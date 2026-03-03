// ============================================
// Blocket League - Entry Point
// ============================================

import * as THREE from 'three';
import { Game } from './Game.js';
import { NetworkManager } from './NetworkManager.js';
import { generateCarVariant } from './CarVariants.js';
import { buildCarMesh } from './CarMeshBuilder.js';
import { modelLoader } from './ModelLoader.js';
import { COLORS } from '../../shared/constants.js';

window.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('game-canvas');
  const lobby = document.getElementById('lobby');
  const lobbyButtons = lobby.querySelector('.lobby-buttons');
  const lobbyTitle = lobby.querySelector('.lobby-title-wrap');
  const carSelector = document.getElementById('car-selector');
  const previewCanvas = document.getElementById('car-preview');
  const btnSingle = document.getElementById('btn-singleplayer');
  const btnMulti = document.getElementById('btn-multiplayer');
  const btnRandomize = document.getElementById('btn-randomize');
  const btnLetsGo = document.getElementById('btn-letsgo');
  const btnResetColors = document.getElementById('btn-reset-colors');
  const btnBack = document.getElementById('btn-back');
  const btnPrevModel = document.getElementById('btn-prev-model');
  const btnNextModel = document.getElementById('btn-next-model');
  const carModelName = document.getElementById('car-model-name');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingFill = document.getElementById('loading-fill');

  let selectedMode = null;
  let chosenVariant = null;
  let currentModelIndex = 0;
  let availableModelIds = [];
  let activeGame = null;

  // --- 3D Preview state ---
  let previewRenderer = null;
  let previewScene = null;
  let previewCamera = null;
  let previewCarMesh = null;
  let previewAnimId = null;

  canvas.addEventListener('click', () => {
    canvas.focus();
  });

  // --- Preload models ---
  // Hide lobby content while loading
  lobbyButtons.style.display = 'none';
  lobbyTitle.style.display = 'none';

  await modelLoader.preloadAll((loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    loadingFill.style.width = pct + '%';
  });

  availableModelIds = modelLoader.getModelIds();

  // Hide loading, show lobby
  loadingScreen.classList.add('hidden');
  lobbyButtons.style.display = '';
  lobbyTitle.style.display = '';

  // --- Preview setup / teardown ---

  function initPreview() {
    previewRenderer = new THREE.WebGLRenderer({
      canvas: previewCanvas,
      antialias: true,
    });
    const w = previewCanvas.clientWidth;
    const h = previewCanvas.clientHeight;
    previewRenderer.setSize(w, h, false);
    previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    previewRenderer.setClearColor(0x0a0a2e);
    previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    previewRenderer.toneMappingExposure = 1.4;

    previewScene = new THREE.Scene();

    previewCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 50);
    previewCamera.position.set(5, 3.5, 5);
    previewCamera.lookAt(0, 0.3, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0x222244, 0.8);
    previewScene.add(ambient);

    const cyanLight = new THREE.PointLight(0x00ffff, 2, 20);
    cyanLight.position.set(4, 4, 3);
    previewScene.add(cyanLight);

    const warmLight = new THREE.PointLight(0xff8844, 1.5, 20);
    warmLight.position.set(-4, 3, -3);
    previewScene.add(warmLight);
  }

  function setPreviewCar(variant) {
    // Remove old car mesh
    if (previewCarMesh) {
      previewScene.remove(previewCarMesh);
      disposeObject(previewCarMesh);
      previewCarMesh = null;
    }

    const result = buildCarMesh(variant);
    previewCarMesh = result.mesh;
    previewScene.add(previewCarMesh);
  }

  function updateModelLabel() {
    if (availableModelIds.length > 0 && chosenVariant && chosenVariant.modelId) {
      carModelName.textContent = modelLoader.getModelName(chosenVariant.modelId);
    } else {
      carModelName.textContent = 'Procedural';
    }
  }

  function startPreviewLoop() {
    function animate() {
      previewAnimId = requestAnimationFrame(animate);
      if (previewCarMesh) {
        previewCarMesh.rotation.y += 0.01;
      }
      previewRenderer.render(previewScene, previewCamera);
    }
    animate();
  }

  function stopPreview() {
    if (previewAnimId !== null) {
      cancelAnimationFrame(previewAnimId);
      previewAnimId = null;
    }
  }

  function disposePreview() {
    stopPreview();
    if (previewCarMesh) {
      previewScene.remove(previewCarMesh);
      disposeObject(previewCarMesh);
      previewCarMesh = null;
    }
    if (previewRenderer) {
      previewRenderer.dispose();
      previewRenderer = null;
    }
    previewScene = null;
    previewCamera = null;
  }

  function disposeObject(obj) {
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  // --- UI transitions ---

  function showCarSelector(mode) {
    selectedMode = mode;
    lobbyButtons.style.display = 'none';
    carSelector.style.display = 'flex';

    initPreview();

    // Default to first model if available
    if (availableModelIds.length > 0) {
      currentModelIndex = 0;
    }
    chosenVariant = generateCarVariant(COLORS.CYAN, availableModelIds);
    if (availableModelIds.length > 0) {
      chosenVariant.modelId = availableModelIds[currentModelIndex];
    }
    setPreviewCar(chosenVariant);
    updateModelLabel();
    startPreviewLoop();
  }

  function hideCarSelector() {
    stopPreview();
    disposePreview();
    carSelector.style.display = 'none';
    lobbyButtons.style.display = '';
    selectedMode = null;
    chosenVariant = null;
  }

  function destroyActiveGame() {
    if (activeGame) {
      activeGame.destroy();
      activeGame = null;
      window.game = null;
    }
  }

  function returnToLobby() {
    destroyActiveGame();
    lobby.style.display = '';
    lobbyButtons.style.display = '';
    carSelector.style.display = 'none';
  }

  function startGame() {
    destroyActiveGame();
    stopPreview();
    disposePreview();
    carSelector.style.display = 'none';
    lobby.style.display = 'none';

    if (selectedMode === 'multiplayer') {
      const network = new NetworkManager();
      const game = new Game(canvas, 'multiplayer', network, chosenVariant);
      game.onMatchEnd = () => {
        setTimeout(() => returnToLobby(), 4000);
      };
      activeGame = game;
      window.game = game;
    } else {
      const game = new Game(canvas, 'singleplayer', null, chosenVariant);
      activeGame = game;
      window.game = game;
    }
  }

  // --- Button handlers ---

  btnSingle.addEventListener('click', () => {
    showCarSelector('singleplayer');
  });

  btnMulti.addEventListener('click', () => {
    showCarSelector('multiplayer');
  });

  // Prev/Next model buttons
  btnPrevModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex - 1 + availableModelIds.length) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
  });

  btnNextModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex + 1) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
  });

  // Random Colors — re-rolls colors but keeps current model
  btnRandomize.addEventListener('click', () => {
    const currentModelId = chosenVariant ? chosenVariant.modelId : null;
    chosenVariant = generateCarVariant(COLORS.CYAN, availableModelIds);
    if (currentModelId) {
      chosenVariant.modelId = currentModelId;
    }
    setPreviewCar(chosenVariant);
  });

  // Reset Colors — restore model's original texture colors
  btnResetColors.addEventListener('click', () => {
    if (!chosenVariant) return;
    chosenVariant.bodyColor = null;
    setPreviewCar(chosenVariant);
  });

  btnLetsGo.addEventListener('click', () => {
    startGame();
  });

  btnBack.addEventListener('click', () => {
    hideCarSelector();
  });
});
