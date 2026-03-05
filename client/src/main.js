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
  const btnLetsGo = document.getElementById('btn-letsgo');
  const btnBack = document.getElementById('btn-back');
  const btnPrevModel = document.getElementById('btn-prev-model');
  const btnNextModel = document.getElementById('btn-next-model');
  const carModelName = document.getElementById('car-model-name');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingFill = document.getElementById('loading-fill');

  // Room lobby elements
  const roomLobby = document.getElementById('room-lobby');
  const roomLobbyOptions = roomLobby.querySelector('.room-lobby-options');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const roomCodeInput = document.getElementById('room-code-input');
  const modeSelector = document.getElementById('mode-selector');
  const btnMode1v1 = document.getElementById('btn-mode-1v1');
  const btnMode2v2 = document.getElementById('btn-mode-2v2');
  const waitingRoom = document.getElementById('waiting-room');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const roomModeLabel = document.getElementById('room-mode-label');
  const roomStatus = document.getElementById('room-status');
  const blueSlots = document.getElementById('blue-slots');
  const orangeSlots = document.getElementById('orange-slots');
  const btnRoomBack = document.getElementById('btn-room-back');

  // Difficulty selector elements
  const difficultySelector = document.getElementById('difficulty-selector');
  const btnDiffRookie = document.getElementById('btn-diff-rookie');
  const btnDiffPro = document.getElementById('btn-diff-pro');
  const btnDiffAllstar = document.getElementById('btn-diff-allstar');
  const btnDiffBack = document.getElementById('btn-diff-back');

  let selectedMode = null;
  let selectedDifficulty = 'pro';
  let chosenVariant = null;
  let currentModelIndex = 0;
  let availableModelIds = [];
  let activeGame = null;

  // Room lobby state
  let selectedRoomMode = null; // '1v1' | '2v2'
  let roomCode = null;
  let isRoomCreator = false;
  let networkManager = null;

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
    roomLobby.style.display = 'none';
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
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    lobby.style.display = '';
    lobbyButtons.style.display = '';
    roomLobby.style.display = 'none';
    carSelector.style.display = 'none';
    difficultySelector.style.display = 'none';
    roomCode = null;
    selectedRoomMode = null;
    isRoomCreator = false;
  }

  function requestFullscreen() {
    try {
      const el = document.documentElement;
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (rfs) {
        const result = rfs.call(el);
        if (result && result.catch) result.catch(() => {});
      }
    } catch (e) {
      // Fullscreen not supported (e.g. iPhone Safari)
    }
  }

  function showWaitingRoom(code) {
    lobbyButtons.style.display = 'none';
    roomLobby.style.display = 'flex';
    roomLobbyOptions.style.display = 'none';
    modeSelector.style.display = 'none';
    waitingRoom.style.display = 'flex';
    roomCodeDisplay.textContent = code;
    roomModeLabel.textContent = selectedRoomMode || '';
    roomStatus.textContent = 'Waiting for players...';
    blueSlots.innerHTML = '';
    orangeSlots.innerHTML = '';
  }

  // --- Render team lobby slots ---

  function renderTeamSlots(slots, network) {
    const myTeam = slots.find(s => s.isYou)?.team;

    blueSlots.innerHTML = '';
    orangeSlots.innerHTML = '';

    for (const s of slots) {
      const div = document.createElement('div');
      div.className = 'team-slot';

      if (s.filled) {
        if (s.isYou) {
          div.classList.add('filled', 'you');
          div.textContent = 'You';
        } else {
          div.classList.add('filled');
          div.textContent = 'Player';
        }
      } else {
        div.classList.add('open');
        if (s.team !== myTeam) {
          div.classList.add('joinable');
          div.textContent = 'Join';
          div.addEventListener('click', () => {
            network.switchTeam();
          });
        } else {
          div.textContent = 'Open';
        }
      }

      if (s.team === 'blue') {
        blueSlots.appendChild(div);
      } else {
        orangeSlots.appendChild(div);
      }
    }
  }

  // --- Start game (singleplayer or multiplayer after room is ready) ---

  function startGame() {
    destroyActiveGame();
    stopPreview();
    disposePreview();
    carSelector.style.display = 'none';

    if (selectedMode === 'singleplayer') {
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'singleplayer', null, chosenVariant, null, selectedDifficulty);
      activeGame = game;
      window.game = game;
      return;
    }

    // Multiplayer: show connecting state immediately, then connect
    showWaitingRoom(isRoomCreator ? '...' : roomCode);
    roomStatus.textContent = 'Connecting...';

    const network = new NetworkManager();
    networkManager = network;

    network.on('connected', () => {
      const variant = chosenVariant || generateCarVariant(COLORS.CYAN, availableModelIds);

      if (isRoomCreator) {
        network.createRoom(selectedRoomMode, variant);
      } else {
        network.joinRoom(roomCode, variant);
      }
    });

    network.on('roomCreated', (data) => {
      roomCode = data.code;
      roomCodeDisplay.textContent = data.code;
      roomStatus.textContent = 'Waiting for players...';
    });

    network.on('lobbyUpdate', (data) => {
      roomStatus.textContent = `Waiting for players... (${data.playerCount}/${data.maxPlayers})`;
      if (data.mode) {
        roomModeLabel.textContent = data.mode;
      }
      if (data.slots) {
        renderTeamSlots(data.slots, network);
      }
    });

    network.on('joinError', (data) => {
      alert(data.message);
      returnToLobby();
    });

    network.on('roomExpired', () => {
      alert('Room expired');
      returnToLobby();
    });

    network.on('joined', (data) => {
      // All players are in — launch the game
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'multiplayer', network, chosenVariant, data);
      game.onMatchEnd = () => {
        setTimeout(() => returnToLobby(), 4000);
      };
      activeGame = game;
      window.game = game;
      networkManager = null; // Game owns the network now
    });

    network.on('disconnected', () => {
      if (!activeGame) {
        returnToLobby();
      }
    });

    network.connect();
  }

  // --- Button handlers ---

  btnSingle.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    difficultySelector.style.display = 'flex';
  });

  btnDiffRookie.addEventListener('click', () => {
    selectedDifficulty = 'rookie';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffPro.addEventListener('click', () => {
    selectedDifficulty = 'pro';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffAllstar.addEventListener('click', () => {
    selectedDifficulty = 'allstar';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffBack.addEventListener('click', () => {
    difficultySelector.style.display = 'none';
    lobbyButtons.style.display = '';
  });

  // "Play Online" → show room lobby
  btnMulti.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    roomLobby.style.display = 'flex';
    roomLobbyOptions.style.display = 'flex';
    modeSelector.style.display = 'none';
    waitingRoom.style.display = 'none';
    roomCodeInput.value = '';
  });

  // "Create Room" → show mode selector
  btnCreateRoom.addEventListener('click', () => {
    isRoomCreator = true;
    roomLobbyOptions.style.display = 'none';
    modeSelector.style.display = 'flex';
  });

  // Mode selection → car selector
  btnMode1v1.addEventListener('click', () => {
    selectedRoomMode = '1v1';
    showCarSelector('multiplayer');
  });

  btnMode2v2.addEventListener('click', () => {
    selectedRoomMode = '2v2';
    showCarSelector('multiplayer');
  });

  // "Join Room" → validate code → car selector
  btnJoinRoom.addEventListener('click', () => {
    const code = roomCodeInput.value.toUpperCase().trim();
    if (code.length !== 4) return;
    isRoomCreator = false;
    roomCode = code;
    showCarSelector('multiplayer');
  });

  // Auto-uppercase room code input
  roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  // Room lobby back button
  btnRoomBack.addEventListener('click', () => {
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    roomLobby.style.display = 'none';
    lobbyButtons.style.display = '';
    roomCode = null;
    selectedRoomMode = null;
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

  btnLetsGo.addEventListener('click', () => {
    startGame();
  });

  btnBack.addEventListener('click', () => {
    hideCarSelector();
  });
});
