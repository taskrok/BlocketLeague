// ============================================
// Lobby Settings - Full tabbed settings panel for lobby
// Reads/writes the same localStorage keys as in-game GameSettings
// ============================================

import { InputManager } from './InputManager.js';
import { DISPLAY_DEFAULTS } from './GameSettings.js';

const CAMERA_STORAGE_KEY = 'blocket-camera-settings';
const AUDIO_STORAGE_KEY = 'blocket-audio-settings';
const GENERAL_STORAGE_KEY = 'blocket-general-settings';
const DISPLAY_STORAGE_KEY = 'blocket-display-settings';
const KEY_BINDINGS_KEY = 'blocket-key-bindings';
const GP_BINDINGS_KEY = 'blocket-gamepad-bindings';
const GP_SETTINGS_KEY = 'blocket-gamepad-settings';

const CAMERA_DEFAULTS = {
  fov: 70,
  distance: 10,
  height: 4,
  smoothness: 5,
};

const CAMERA_SLIDERS = [
  { key: 'fov',        label: 'FOV',        min: 50,  max: 110, step: 1   },
  { key: 'distance',   label: 'Distance',   min: 5,   max: 25,  step: 0.5 },
  { key: 'height',     label: 'Height',     min: 1,   max: 12,  step: 0.5 },
  { key: 'smoothness', label: 'Smoothness', min: 1,   max: 15,  step: 0.5 },
];

const KEY_ACTION_LABELS = {
  throttleForward: 'Drive Forward',
  throttleReverse: 'Drive Reverse',
  steerLeft: 'Steer Left',
  steerRight: 'Steer Right',
  jump: 'Jump',
  boost: 'Boost',
  ballCam: 'Ball Cam',
  airRollLeft: 'Air Roll Left',
  airRollRight: 'Air Roll Right',
  handbrake: 'Handbrake',
  lookLeft: 'Look Left',
  lookRight: 'Look Right',
  scoreboard: 'Scoreboard',
};

const GP_ACTION_LABELS = {
  jump: 'Jump',
  boost: 'Boost',
  handbrake: 'Handbrake',
  ballCam: 'Ball Cam',
  airRollLeft: 'Air Roll Left',
  airRollRight: 'Air Roll Right',
};

function keyCodeToName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Bksp',
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    CapsLock: 'Caps', Escape: 'Esc',
  };
  return map[code] || code;
}

function loadJSON(key, defaults) {
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      const result = { ...defaults };
      for (const k of Object.keys(defaults)) {
        if (typeof parsed[k] === typeof defaults[k]) result[k] = parsed[k];
      }
      return result;
    }
  } catch {}
  return { ...defaults };
}

function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

export function buildLobbySettings(container) {
  const state = {
    camera: loadJSON(CAMERA_STORAGE_KEY, CAMERA_DEFAULTS),
    keyBindings: loadJSON(KEY_BINDINGS_KEY, InputManager.getDefaultKeyBindings()),
    gpBindings: loadJSON(GP_BINDINGS_KEY, InputManager.getDefaultGpBindings()),
    gpSettings: loadJSON(GP_SETTINGS_KEY, InputManager.getDefaultGpSettings()),
    audioVolume: (() => {
      try {
        const s = localStorage.getItem(AUDIO_STORAGE_KEY);
        if (s) { const p = JSON.parse(s); if (typeof p.musicVolume === 'number') return p.musicVolume; }
      } catch {}
      return 0.5;
    })(),
    autoFullscreen: (() => {
      try {
        const s = localStorage.getItem(GENERAL_STORAGE_KEY);
        if (s) { const p = JSON.parse(s); if (typeof p.autoFullscreen === 'boolean') return p.autoFullscreen; }
      } catch {}
      return false;
    })(),
    display: loadJSON(DISPLAY_STORAGE_KEY, DISPLAY_DEFAULTS),
    _rebindHandler: null,
    _gpRebindRaf: null,
    _gpRebindAction: null,
    _gpRebindBtn: null,
    _gpRebindPrev: null,
    _gpRebindEscHandler: null,
    _keyButtons: {},
    _gpButtons: {},
  };

  container.innerHTML = '';

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'gs-tabs';
  const tabs = [
    { id: 'camera', label: 'Camera' },
    { id: 'controls', label: 'Keys' },
    { id: 'controller', label: 'Pad' },
    { id: 'audio', label: 'Audio' },
    { id: 'display', label: 'Display' },
  ];
  const tabButtons = {};
  const panes = {};

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className = 'gs-tab' + (tab.id === 'camera' ? ' active' : '');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => switchTab(tab.id));
    tabBar.appendChild(btn);
    tabButtons[tab.id] = btn;
  }
  container.appendChild(tabBar);

  const tabContent = document.createElement('div');
  tabContent.className = 'gs-tab-content';

  function switchTab(id) {
    cancelAnyRebind();
    for (const [tid, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle('active', tid === id);
    }
    for (const [pid, pane] of Object.entries(panes)) {
      pane.classList.toggle('active', pid === id);
    }
  }

  // --- Camera Pane ---
  const cameraPane = document.createElement('div');
  cameraPane.className = 'gs-pane active';
  const cameraSliderEls = {};
  const slidersWrap = document.createElement('div');
  slidersWrap.className = 'cs-sliders';

  for (const cfg of CAMERA_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'cs-row';
    const label = document.createElement('label');
    label.className = 'cs-label';
    label.textContent = cfg.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'cs-value';
    const v = state.camera[cfg.key];
    valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'cs-slider';
    input.min = cfg.min;
    input.max = cfg.max;
    input.step = cfg.step;
    input.value = state.camera[cfg.key];
    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      state.camera[cfg.key] = val;
      valSpan.textContent = val % 1 === 0 ? val : val.toFixed(1);
      saveJSON(CAMERA_STORAGE_KEY, state.camera);
    });
    cameraSliderEls[cfg.key] = { input, valSpan };
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valSpan);
    slidersWrap.appendChild(row);
  }
  cameraPane.appendChild(slidersWrap);

  const camResetBtn = document.createElement('button');
  camResetBtn.className = 'cs-reset';
  camResetBtn.textContent = 'Reset to Defaults';
  camResetBtn.addEventListener('click', () => {
    state.camera = { ...CAMERA_DEFAULTS };
    saveJSON(CAMERA_STORAGE_KEY, state.camera);
    for (const cfg of CAMERA_SLIDERS) {
      const el = cameraSliderEls[cfg.key];
      el.input.value = CAMERA_DEFAULTS[cfg.key];
      const v = CAMERA_DEFAULTS[cfg.key];
      el.valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
    }
  });
  cameraPane.appendChild(camResetBtn);
  panes.camera = cameraPane;
  tabContent.appendChild(cameraPane);

  // --- Controls (Keys) Pane ---
  const controlsPane = document.createElement('div');
  controlsPane.className = 'gs-pane';
  const keyList = document.createElement('div');
  keyList.className = 'gs-bind-list';

  for (const action of Object.keys(KEY_ACTION_LABELS)) {
    const row = document.createElement('div');
    row.className = 'gs-bind-row';
    const label = document.createElement('span');
    label.className = 'gs-bind-label';
    label.textContent = KEY_ACTION_LABELS[action];
    const keyBtn = document.createElement('button');
    keyBtn.className = 'gs-bind-key';
    keyBtn.textContent = keyCodeToName(state.keyBindings[action]);
    keyBtn.addEventListener('click', () => startKeyRebind(action, keyBtn));
    state._keyButtons[action] = keyBtn;
    row.appendChild(label);
    row.appendChild(keyBtn);
    keyList.appendChild(row);
  }
  controlsPane.appendChild(keyList);

  const keyResetBtn = document.createElement('button');
  keyResetBtn.className = 'cs-reset';
  keyResetBtn.textContent = 'Reset to Defaults';
  keyResetBtn.addEventListener('click', () => {
    state.keyBindings = InputManager.getDefaultKeyBindings();
    saveJSON(KEY_BINDINGS_KEY, state.keyBindings);
    for (const action of Object.keys(KEY_ACTION_LABELS)) {
      state._keyButtons[action].textContent = keyCodeToName(state.keyBindings[action]);
    }
  });
  controlsPane.appendChild(keyResetBtn);
  panes.controls = controlsPane;
  tabContent.appendChild(controlsPane);

  // --- Controller (Pad) Pane ---
  const controllerPane = document.createElement('div');
  controllerPane.className = 'gs-pane';
  const gpList = document.createElement('div');
  gpList.className = 'gs-bind-list';

  for (const action of Object.keys(GP_ACTION_LABELS)) {
    const row = document.createElement('div');
    row.className = 'gs-bind-row';
    const label = document.createElement('span');
    label.className = 'gs-bind-label';
    label.textContent = GP_ACTION_LABELS[action];
    const gpBtn = document.createElement('button');
    gpBtn.className = 'gs-bind-key';
    gpBtn.textContent = InputManager.getGpButtonName(state.gpBindings[action]);
    gpBtn.addEventListener('click', () => startGpRebind(action, gpBtn));
    state._gpButtons[action] = gpBtn;
    row.appendChild(label);
    row.appendChild(gpBtn);
    gpList.appendChild(row);
  }
  controllerPane.appendChild(gpList);

  // Deadzone + trigger threshold sliders
  const gpSlidersWrap = document.createElement('div');
  gpSlidersWrap.className = 'cs-sliders';
  gpSlidersWrap.style.marginTop = '16px';
  const gpSliderEls = {};

  for (const cfg of [
    { key: 'deadzone', label: 'Deadzone', min: 0.01, max: 0.5, step: 0.01 },
    { key: 'triggerThreshold', label: 'Trigger Threshold', min: 0.01, max: 0.5, step: 0.01 },
  ]) {
    const row = document.createElement('div');
    row.className = 'cs-row';
    const label = document.createElement('label');
    label.className = 'cs-label';
    label.textContent = cfg.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'cs-value';
    valSpan.textContent = state.gpSettings[cfg.key].toFixed(2);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'cs-slider';
    input.min = cfg.min;
    input.max = cfg.max;
    input.step = cfg.step;
    input.value = state.gpSettings[cfg.key];
    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      state.gpSettings[cfg.key] = val;
      valSpan.textContent = val.toFixed(2);
      saveJSON(GP_SETTINGS_KEY, state.gpSettings);
    });
    gpSliderEls[cfg.key] = { input, valSpan };
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valSpan);
    gpSlidersWrap.appendChild(row);
  }
  controllerPane.appendChild(gpSlidersWrap);

  const gpResetBtn = document.createElement('button');
  gpResetBtn.className = 'cs-reset';
  gpResetBtn.textContent = 'Reset to Defaults';
  gpResetBtn.addEventListener('click', () => {
    state.gpBindings = InputManager.getDefaultGpBindings();
    state.gpSettings = InputManager.getDefaultGpSettings();
    saveJSON(GP_BINDINGS_KEY, state.gpBindings);
    saveJSON(GP_SETTINGS_KEY, state.gpSettings);
    for (const action of Object.keys(GP_ACTION_LABELS)) {
      state._gpButtons[action].textContent = InputManager.getGpButtonName(state.gpBindings[action]);
    }
    for (const cfg of ['deadzone', 'triggerThreshold']) {
      gpSliderEls[cfg].input.value = state.gpSettings[cfg];
      gpSliderEls[cfg].valSpan.textContent = state.gpSettings[cfg].toFixed(2);
    }
  });
  controllerPane.appendChild(gpResetBtn);
  panes.controller = controllerPane;
  tabContent.appendChild(controllerPane);

  // --- Audio Pane ---
  const audioPane = document.createElement('div');
  audioPane.className = 'gs-pane';
  const audioWrap = document.createElement('div');
  audioWrap.className = 'cs-sliders';
  const audioRow = document.createElement('div');
  audioRow.className = 'cs-row';
  const audioLabel = document.createElement('label');
  audioLabel.className = 'cs-label';
  audioLabel.textContent = 'Music Volume';
  const audioVal = document.createElement('span');
  audioVal.className = 'cs-value';
  audioVal.textContent = Math.round(state.audioVolume * 100);
  const audioInput = document.createElement('input');
  audioInput.type = 'range';
  audioInput.className = 'cs-slider';
  audioInput.min = 0;
  audioInput.max = 1;
  audioInput.step = 0.01;
  audioInput.value = state.audioVolume;
  audioInput.addEventListener('input', () => {
    const val = parseFloat(audioInput.value);
    state.audioVolume = val;
    audioVal.textContent = Math.round(val * 100);
    saveJSON(AUDIO_STORAGE_KEY, { musicVolume: val });
    // Apply immediately to lobby music if playing
    if (window.__blocketTitleMusic) {
      window.__blocketTitleMusic.volume = val;
    }
  });
  audioRow.appendChild(audioLabel);
  audioRow.appendChild(audioInput);
  audioRow.appendChild(audioVal);
  audioWrap.appendChild(audioRow);
  audioPane.appendChild(audioWrap);

  const audioResetBtn = document.createElement('button');
  audioResetBtn.className = 'cs-reset';
  audioResetBtn.style.marginTop = '16px';
  audioResetBtn.textContent = 'Reset to Defaults';
  audioResetBtn.addEventListener('click', () => {
    state.audioVolume = 0.5;
    audioInput.value = 0.5;
    audioVal.textContent = '50';
    saveJSON(AUDIO_STORAGE_KEY, { musicVolume: 0.5 });
    if (window.__blocketTitleMusic) window.__blocketTitleMusic.volume = 0.5;
  });
  audioPane.appendChild(audioResetBtn);
  panes.audio = audioPane;
  tabContent.appendChild(audioPane);

  // --- Display Pane ---
  const displayPane = document.createElement('div');
  displayPane.className = 'gs-pane';

  const d = state.display;
  const displayCheckboxes = {};

  const fsBtn = document.createElement('button');
  fsBtn.className = 'cs-reset';
  const _isFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  fsBtn.textContent = _isFS() ? 'Exit Fullscreen' : 'Enter Fullscreen';
  fsBtn.addEventListener('click', () => {
    if (_isFS()) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    } else {
      const el = document.documentElement;
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen;
      if (rfs) {
        const r = rfs.call(el);
        if (r && r.catch) r.catch(() => {});
      }
    }
  });
  const _onFSChange = () => {
    fsBtn.textContent = _isFS() ? 'Exit Fullscreen' : 'Enter Fullscreen';
  };
  document.addEventListener('fullscreenchange', _onFSChange);
  document.addEventListener('webkitfullscreenchange', _onFSChange);
  displayPane.appendChild(fsBtn);

  const displayChecks = [
    { key: 'autoFullscreen', label: 'Auto-fullscreen on start', isGeneral: true },
    { key: 'bloom', label: 'Bloom (glow effects)' },
    { key: 'antialias', label: 'Anti-aliasing (restart required)' },
    { key: 'nameplates', label: 'Car nameplates' },
    { key: 'particles', label: 'Particles & debris' },
    { key: 'fpsCounter', label: 'FPS counter' },
  ];

  for (const cfg of displayChecks) {
    const row = document.createElement('div');
    row.className = 'cs-row';
    row.style.marginTop = '8px';
    row.style.cursor = 'pointer';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = cfg.isGeneral ? state.autoFullscreen : d[cfg.key];
    check.style.accentColor = '#00ffff';
    check.style.cursor = 'pointer';
    const label = document.createElement('label');
    label.className = 'cs-label';
    label.textContent = cfg.label;
    label.style.cursor = 'pointer';
    check.addEventListener('change', () => {
      if (cfg.isGeneral) {
        state.autoFullscreen = check.checked;
        saveJSON(GENERAL_STORAGE_KEY, { autoFullscreen: check.checked });
      } else {
        d[cfg.key] = check.checked;
        saveJSON(DISPLAY_STORAGE_KEY, d);
      }
    });
    label.addEventListener('click', () => { check.click(); });
    row.appendChild(check);
    row.appendChild(label);
    displayPane.appendChild(row);
    if (!cfg.isGeneral) displayCheckboxes[cfg.key] = check;
  }

  // Render Scale slider
  const rsWrap = document.createElement('div');
  rsWrap.className = 'cs-sliders';
  rsWrap.style.marginTop = '12px';
  const rsRow = document.createElement('div');
  rsRow.className = 'cs-row';
  const rsLabel = document.createElement('label');
  rsLabel.className = 'cs-label';
  rsLabel.textContent = 'Render Scale';
  const rsVal = document.createElement('span');
  rsVal.className = 'cs-value';
  rsVal.textContent = d.renderScale.toFixed(1) + 'x';
  const rsInput = document.createElement('input');
  rsInput.type = 'range';
  rsInput.className = 'cs-slider';
  rsInput.min = 0.5;
  rsInput.max = 2;
  rsInput.step = 0.25;
  rsInput.value = d.renderScale;
  rsInput.addEventListener('input', () => {
    const v = parseFloat(rsInput.value);
    rsVal.textContent = v.toFixed(1) + 'x';
    d.renderScale = v;
    saveJSON(DISPLAY_STORAGE_KEY, d);
  });
  rsRow.appendChild(rsLabel);
  rsRow.appendChild(rsInput);
  rsRow.appendChild(rsVal);
  rsWrap.appendChild(rsRow);
  displayPane.appendChild(rsWrap);

  // Reset button
  const displayResetBtn = document.createElement('button');
  displayResetBtn.className = 'cs-reset';
  displayResetBtn.style.marginTop = '12px';
  displayResetBtn.textContent = 'Reset to Defaults';
  displayResetBtn.addEventListener('click', () => {
    Object.assign(d, DISPLAY_DEFAULTS);
    saveJSON(DISPLAY_STORAGE_KEY, d);
    for (const [key, check] of Object.entries(displayCheckboxes)) {
      check.checked = DISPLAY_DEFAULTS[key];
    }
    rsInput.value = DISPLAY_DEFAULTS.renderScale;
    rsVal.textContent = DISPLAY_DEFAULTS.renderScale.toFixed(1) + 'x';
    state.autoFullscreen = false;
    saveJSON(GENERAL_STORAGE_KEY, { autoFullscreen: false });
  });
  displayPane.appendChild(displayResetBtn);
  panes.display = displayPane;
  tabContent.appendChild(displayPane);

  container.appendChild(tabContent);

  // --- Key Rebinding ---
  function cancelKeyRebind() {
    if (state._rebindHandler) {
      document.removeEventListener('keydown', state._rebindHandler, true);
      state._rebindHandler = null;
    }
  }

  function startKeyRebind(action, btn) {
    cancelAnyRebind();
    btn.textContent = 'Press a key...';
    btn.classList.add('listening');

    state._rebindHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelKeyRebind();
      btn.classList.remove('listening');

      if (e.code === 'Escape') {
        btn.textContent = keyCodeToName(state.keyBindings[action]);
        return;
      }

      const code = e.code;
      // Swap duplicates
      for (const otherAction of Object.keys(KEY_ACTION_LABELS)) {
        if (otherAction !== action && state.keyBindings[otherAction] === code) {
          state.keyBindings[otherAction] = state.keyBindings[action];
          state._keyButtons[otherAction].textContent = keyCodeToName(state.keyBindings[action]);
          break;
        }
      }
      state.keyBindings[action] = code;
      saveJSON(KEY_BINDINGS_KEY, state.keyBindings);
      btn.textContent = keyCodeToName(code);
    };
    document.addEventListener('keydown', state._rebindHandler, true);
  }

  // --- Gamepad Rebinding ---
  function cancelGpRebind() {
    if (state._gpRebindRaf) {
      cancelAnimationFrame(state._gpRebindRaf);
      state._gpRebindRaf = null;
    }
    if (state._gpRebindEscHandler) {
      document.removeEventListener('keydown', state._gpRebindEscHandler, true);
      state._gpRebindEscHandler = null;
    }
    if (state._gpRebindBtn) {
      state._gpRebindBtn.classList.remove('listening');
    }
    state._gpRebindAction = null;
    state._gpRebindBtn = null;
    state._gpRebindPrev = null;
  }

  function startGpRebind(action, btn) {
    cancelAnyRebind();
    btn.textContent = 'Press a button...';
    btn.classList.add('listening');

    state._gpRebindAction = action;
    state._gpRebindBtn = btn;
    state._gpRebindPrev = new Set();

    // Snapshot currently pressed buttons
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gamepads) {
      if (gp) {
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i].pressed) state._gpRebindPrev.add(i);
        }
        break;
      }
    }

    state._gpRebindEscHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelGpRebind();
        btn.textContent = InputManager.getGpButtonName(state.gpBindings[action]);
      }
    };
    window.addEventListener('keydown', state._gpRebindEscHandler, true);

    const poll = () => {
      if (!state._gpRebindAction) return;
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const g of gamepads) { if (g) { gp = g; break; } }
      if (!gp) {
        state._gpRebindRaf = requestAnimationFrame(poll);
        return;
      }
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i].pressed && !state._gpRebindPrev.has(i)) {
          // Found new button press
          cancelGpRebind();
          // Swap duplicates
          for (const otherAction of Object.keys(GP_ACTION_LABELS)) {
            if (otherAction !== action && state.gpBindings[otherAction] === i) {
              state.gpBindings[otherAction] = state.gpBindings[action];
              state._gpButtons[otherAction].textContent = InputManager.getGpButtonName(state.gpBindings[action]);
              break;
            }
          }
          state.gpBindings[action] = i;
          saveJSON(GP_BINDINGS_KEY, state.gpBindings);
          btn.classList.remove('listening');
          btn.textContent = InputManager.getGpButtonName(i);
          return;
        }
      }
      // Update prev set
      for (const idx of state._gpRebindPrev) {
        if (!gp.buttons[idx] || !gp.buttons[idx].pressed) state._gpRebindPrev.delete(idx);
      }
      state._gpRebindRaf = requestAnimationFrame(poll);
    };
    state._gpRebindRaf = requestAnimationFrame(poll);
  }

  function cancelAnyRebind() {
    cancelKeyRebind();
    // Restore key button labels if a rebind was in progress
    for (const action of Object.keys(KEY_ACTION_LABELS)) {
      state._keyButtons[action].classList.remove('listening');
      state._keyButtons[action].textContent = keyCodeToName(state.keyBindings[action]);
    }
    cancelGpRebind();
  }

  // Return cleanup function
  return { cancelAnyRebind };
}
