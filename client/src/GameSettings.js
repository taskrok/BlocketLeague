// ============================================
// Game Settings - Tabbed settings panel
// Tabs: Camera, Keys, Pad, Audio
// ============================================

import { InputManager } from './InputManager.js';

const CAMERA_STORAGE_KEY = 'blocket-camera-settings';
const AUDIO_STORAGE_KEY = 'blocket-audio-settings';
const GENERAL_STORAGE_KEY = 'blocket-general-settings';

// Shared accessor so main.js can read the setting without importing the class
export function getGeneralSettings() {
  try {
    const saved = localStorage.getItem(GENERAL_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { autoFullscreen: false };
}

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

// Convert key code to readable name
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

export class GameSettings {
  constructor(cameraController, inputManager) {
    this.controller = cameraController;
    this.input = inputManager;
    this.open = false;
    this.activeTab = 'camera';
    this.cameraValues = { ...CAMERA_DEFAULTS };
    this.cameraSliders = {};
    this._keyButtons = {};
    this._gpButtons = {};
    this._gpSliders = {};
    this._gpRebindRaf = null;

    this._loadCameraSettings();
    this._loadAudioSettings();
    this._loadGeneralSettings();
    this._buildDOM();
    this._bindEvents();

    this.controller.setSettings(this.cameraValues);
    this._applyAudioVolume();
  }

  // --- Camera persistence ---
  _loadCameraSettings() {
    try {
      const saved = localStorage.getItem(CAMERA_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const key of Object.keys(CAMERA_DEFAULTS)) {
          if (typeof parsed[key] === 'number') this.cameraValues[key] = parsed[key];
        }
      }
    } catch {}
  }

  _saveCameraSettings() {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(this.cameraValues));
  }

  // --- Audio persistence ---
  _loadAudioSettings() {
    this._audioVolume = 0.5;
    try {
      const saved = localStorage.getItem(AUDIO_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.musicVolume === 'number') this._audioVolume = parsed.musicVolume;
      }
    } catch {}
  }

  _saveAudioSettings() {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ musicVolume: this._audioVolume }));
  }

  _applyAudioVolume() {
    if (window.__blocketTitleMusic) {
      window.__blocketTitleMusic.volume = this._audioVolume;
    }
  }

  // --- General settings persistence ---
  _loadGeneralSettings() {
    const s = getGeneralSettings();
    this._autoFullscreen = s.autoFullscreen;
  }

  _saveGeneralSettings() {
    localStorage.setItem(GENERAL_STORAGE_KEY, JSON.stringify({ autoFullscreen: this._autoFullscreen }));
  }

  // --- DOM ---
  _buildDOM() {
    // Gear button (reuse existing ID for CSS)
    this.gearBtn = document.createElement('button');
    this.gearBtn.id = 'camera-settings-gear';
    this.gearBtn.setAttribute('aria-label', 'Settings');
    this.gearBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    document.getElementById('game-container').appendChild(this.gearBtn);

    // Panel
    this.panel = document.createElement('div');
    this.panel.id = 'camera-settings-panel';

    // Title
    const title = document.createElement('h3');
    title.className = 'cs-title';
    title.textContent = 'Settings';
    this.panel.appendChild(title);

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
    this._tabButtons = {};
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'gs-tab' + (tab.id === 'camera' ? ' active' : '');
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.addEventListener('click', () => this._switchTab(tab.id));
      tabBar.appendChild(btn);
      this._tabButtons[tab.id] = btn;
    }
    this.panel.appendChild(tabBar);

    // Tab content container
    this._tabContent = document.createElement('div');
    this._tabContent.className = 'gs-tab-content';

    // Camera pane
    this._cameraPane = this._buildCameraPane();
    this._tabContent.appendChild(this._cameraPane);

    // Controls pane
    this._controlsPane = this._buildControlsPane();
    this._tabContent.appendChild(this._controlsPane);

    // Controller pane
    this._controllerPane = this._buildControllerPane();
    this._tabContent.appendChild(this._controllerPane);

    // Audio pane
    this._audioPane = this._buildAudioPane();
    this._tabContent.appendChild(this._audioPane);

    // Display pane
    this._displayPane = this._buildDisplayPane();
    this._tabContent.appendChild(this._displayPane);

    this.panel.appendChild(this._tabContent);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'cs-hint';
    hint.textContent = 'Press Esc to close';
    this.panel.appendChild(hint);

    // Return to Lobby button
    this._lobbyBtn = document.createElement('button');
    this._lobbyBtn.className = 'cs-reset';
    Object.assign(this._lobbyBtn.style, {
      marginTop: '12px',
      background: 'rgba(255,60,60,0.15)',
      border: '1px solid rgba(255,60,60,0.4)',
      color: '#ff6666',
    });
    this._lobbyBtn.textContent = 'Return to Lobby';
    this._lobbyBtn.addEventListener('click', () => {
      if (this.onReturnToLobby) this.onReturnToLobby();
    });
    this.panel.appendChild(this._lobbyBtn);

    document.getElementById('game-container').appendChild(this.panel);
  }

  _buildCameraPane() {
    const pane = document.createElement('div');
    pane.className = 'gs-pane active';
    pane.dataset.pane = 'camera';

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
      valSpan.textContent = this.cameraValues[cfg.key];

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'cs-slider';
      input.min = cfg.min;
      input.max = cfg.max;
      input.step = cfg.step;
      input.value = this.cameraValues[cfg.key];

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.cameraValues[cfg.key] = v;
        valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
        this.controller.setSettings({ [cfg.key]: v });
        this._saveCameraSettings();
      });

      this.cameraSliders[cfg.key] = { input, valSpan };
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      slidersWrap.appendChild(row);
    }

    pane.appendChild(slidersWrap);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => this._resetCamera());
    pane.appendChild(resetBtn);

    return pane;
  }

  _buildControlsPane() {
    const pane = document.createElement('div');
    pane.className = 'gs-pane';
    pane.dataset.pane = 'controls';

    const list = document.createElement('div');
    list.className = 'gs-bind-list';

    const bindings = this.input.keyBindings;
    for (const action of Object.keys(KEY_ACTION_LABELS)) {
      const row = document.createElement('div');
      row.className = 'gs-bind-row';

      const label = document.createElement('span');
      label.className = 'gs-bind-label';
      label.textContent = KEY_ACTION_LABELS[action];

      const keyBtn = document.createElement('button');
      keyBtn.className = 'gs-bind-key';
      keyBtn.textContent = keyCodeToName(bindings[action]);
      keyBtn.addEventListener('click', () => this._startKeyRebind(action, keyBtn));

      this._keyButtons[action] = keyBtn;
      row.appendChild(label);
      row.appendChild(keyBtn);
      list.appendChild(row);
    }

    pane.appendChild(list);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => this._resetKeyBindings());
    pane.appendChild(resetBtn);

    return pane;
  }

  _buildControllerPane() {
    const pane = document.createElement('div');
    pane.className = 'gs-pane';
    pane.dataset.pane = 'controller';

    const list = document.createElement('div');
    list.className = 'gs-bind-list';

    const bindings = this.input.gpBindings;
    for (const action of Object.keys(GP_ACTION_LABELS)) {
      const row = document.createElement('div');
      row.className = 'gs-bind-row';

      const label = document.createElement('span');
      label.className = 'gs-bind-label';
      label.textContent = GP_ACTION_LABELS[action];

      const gpBtn = document.createElement('button');
      gpBtn.className = 'gs-bind-key';
      gpBtn.textContent = InputManager.getGpButtonName(bindings[action]);
      gpBtn.addEventListener('click', () => this._startGpRebind(action, gpBtn));

      this._gpButtons[action] = gpBtn;
      row.appendChild(label);
      row.appendChild(gpBtn);
      list.appendChild(row);
    }

    pane.appendChild(list);

    // Deadzone slider
    const dzWrap = document.createElement('div');
    dzWrap.className = 'cs-sliders';
    dzWrap.style.marginTop = '16px';

    const gpSettings = this.input.gpSettings;

    const dzRow = document.createElement('div');
    dzRow.className = 'cs-row';
    const dzLabel = document.createElement('label');
    dzLabel.className = 'cs-label';
    dzLabel.textContent = 'Deadzone';
    const dzVal = document.createElement('span');
    dzVal.className = 'cs-value';
    dzVal.textContent = gpSettings.deadzone.toFixed(2);
    const dzInput = document.createElement('input');
    dzInput.type = 'range';
    dzInput.className = 'cs-slider';
    dzInput.min = 0.01;
    dzInput.max = 0.5;
    dzInput.step = 0.01;
    dzInput.value = gpSettings.deadzone;
    dzInput.addEventListener('input', () => {
      const v = parseFloat(dzInput.value);
      dzVal.textContent = v.toFixed(2);
      this.input.setGpSettings({ deadzone: v });
    });
    dzRow.appendChild(dzLabel);
    dzRow.appendChild(dzInput);
    dzRow.appendChild(dzVal);
    dzWrap.appendChild(dzRow);
    this._gpSliders.deadzone = { input: dzInput, valSpan: dzVal };

    // Trigger threshold slider
    const ttRow = document.createElement('div');
    ttRow.className = 'cs-row';
    const ttLabel = document.createElement('label');
    ttLabel.className = 'cs-label';
    ttLabel.textContent = 'Trigger Threshold';
    const ttVal = document.createElement('span');
    ttVal.className = 'cs-value';
    ttVal.textContent = gpSettings.triggerThreshold.toFixed(2);
    const ttInput = document.createElement('input');
    ttInput.type = 'range';
    ttInput.className = 'cs-slider';
    ttInput.min = 0.01;
    ttInput.max = 0.5;
    ttInput.step = 0.01;
    ttInput.value = gpSettings.triggerThreshold;
    ttInput.addEventListener('input', () => {
      const v = parseFloat(ttInput.value);
      ttVal.textContent = v.toFixed(2);
      this.input.setGpSettings({ triggerThreshold: v });
    });
    ttRow.appendChild(ttLabel);
    ttRow.appendChild(ttInput);
    ttRow.appendChild(ttVal);
    dzWrap.appendChild(ttRow);
    this._gpSliders.triggerThreshold = { input: ttInput, valSpan: ttVal };

    pane.appendChild(dzWrap);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => this._resetGpBindings());
    pane.appendChild(resetBtn);

    return pane;
  }

  _buildAudioPane() {
    const pane = document.createElement('div');
    pane.className = 'gs-pane';
    pane.dataset.pane = 'audio';

    const slidersWrap = document.createElement('div');
    slidersWrap.className = 'cs-sliders';

    const row = document.createElement('div');
    row.className = 'cs-row';
    const label = document.createElement('label');
    label.className = 'cs-label';
    label.textContent = 'Music Volume';
    const valSpan = document.createElement('span');
    valSpan.className = 'cs-value';
    valSpan.textContent = Math.round(this._audioVolume * 100);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'cs-slider';
    input.min = 0;
    input.max = 1;
    input.step = 0.01;
    input.value = this._audioVolume;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      this._audioVolume = v;
      valSpan.textContent = Math.round(v * 100);
      this._applyAudioVolume();
      this._saveAudioSettings();
    });
    this._audioSlider = { input, valSpan };
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valSpan);
    slidersWrap.appendChild(row);
    pane.appendChild(slidersWrap);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset';
    resetBtn.style.marginTop = '16px';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => {
      this._audioVolume = 0.5;
      this._audioSlider.input.value = 0.5;
      this._audioSlider.valSpan.textContent = '50';
      this._applyAudioVolume();
      this._saveAudioSettings();
    });
    pane.appendChild(resetBtn);

    return pane;
  }

  _buildDisplayPane() {
    const pane = document.createElement('div');
    pane.className = 'gs-pane';
    pane.dataset.pane = 'display';

    // Fullscreen toggle button
    const fsBtn = document.createElement('button');
    fsBtn.className = 'cs-reset';
    fsBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Enter Fullscreen';
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Enter Fullscreen';
    });
    pane.appendChild(fsBtn);

    // Auto-fullscreen on game start checkbox
    const afRow = document.createElement('div');
    afRow.className = 'cs-row';
    afRow.style.marginTop = '10px';
    afRow.style.cursor = 'pointer';
    const afCheck = document.createElement('input');
    afCheck.type = 'checkbox';
    afCheck.checked = this._autoFullscreen;
    afCheck.id = 'gs-auto-fullscreen';
    afCheck.style.accentColor = '#00ffff';
    afCheck.style.cursor = 'pointer';
    const afLabel = document.createElement('label');
    afLabel.className = 'cs-label';
    afLabel.textContent = 'Auto-fullscreen on start';
    afLabel.htmlFor = 'gs-auto-fullscreen';
    afLabel.style.cursor = 'pointer';
    afCheck.addEventListener('change', () => {
      this._autoFullscreen = afCheck.checked;
      this._saveGeneralSettings();
    });
    afRow.appendChild(afCheck);
    afRow.appendChild(afLabel);
    pane.appendChild(afRow);

    return pane;
  }

  // --- Tab switching ---
  _switchTab(tabId) {
    this._cancelAnyRebind();
    this.activeTab = tabId;
    for (const [id, btn] of Object.entries(this._tabButtons)) {
      btn.classList.toggle('active', id === tabId);
    }
    for (const pane of this._tabContent.querySelectorAll('.gs-pane')) {
      pane.classList.toggle('active', pane.dataset.pane === tabId);
    }
  }

  // --- Key rebinding ---
  _startKeyRebind(action, btn) {
    this._cancelAnyRebind();
    btn.textContent = 'Press a key...';
    btn.classList.add('listening');

    this.input.waitForKey((code) => {
      btn.classList.remove('listening');
      if (code === null) {
        // Cancelled
        btn.textContent = keyCodeToName(this.input.keyBindings[action]);
        return;
      }

      // Check for duplicate — swap
      const current = this.input.keyBindings;
      const newBindings = { ...current };
      for (const otherAction of Object.keys(KEY_ACTION_LABELS)) {
        if (otherAction !== action && current[otherAction] === code) {
          // Swap: give the other action our old key
          newBindings[otherAction] = current[action];
          this._keyButtons[otherAction].textContent = keyCodeToName(current[action]);
          break;
        }
      }
      newBindings[action] = code;
      this.input.setKeyBindings(newBindings);
      btn.textContent = keyCodeToName(code);
    });
  }

  // --- Gamepad rebinding ---
  _startGpRebind(action, btn) {
    this._cancelAnyRebind();
    btn.textContent = 'Press a button...';
    btn.classList.add('listening');

    this._gpRebindAction = action;
    this._gpRebindBtn = btn;
    this._gpRebindPrev = new Set();

    // Snapshot currently pressed buttons to ignore them
    if (this.input._gamepadIndex !== null && navigator.getGamepads) {
      const gp = navigator.getGamepads()[this.input._gamepadIndex];
      if (gp) {
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i].pressed) this._gpRebindPrev.add(i);
        }
      }
    }

    // Also listen for Escape on keyboard
    this._gpRebindEscHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._cancelGpRebind();
        btn.textContent = InputManager.getGpButtonName(this.input.gpBindings[action]);
      }
    };
    window.addEventListener('keydown', this._gpRebindEscHandler, true);

    const poll = () => {
      if (!this._gpRebindAction) return;
      if (this.input._gamepadIndex === null || !navigator.getGamepads) {
        this._gpRebindRaf = requestAnimationFrame(poll);
        return;
      }
      const gp = navigator.getGamepads()[this.input._gamepadIndex];
      if (!gp) {
        this._gpRebindRaf = requestAnimationFrame(poll);
        return;
      }
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i].pressed && !this._gpRebindPrev.has(i)) {
          // Found newly pressed button
          this._finishGpRebind(i);
          return;
        }
      }
      // Update prev set (remove released)
      for (const idx of this._gpRebindPrev) {
        if (!gp.buttons[idx] || !gp.buttons[idx].pressed) this._gpRebindPrev.delete(idx);
      }
      this._gpRebindRaf = requestAnimationFrame(poll);
    };
    this._gpRebindRaf = requestAnimationFrame(poll);
  }

  _finishGpRebind(buttonIndex) {
    const action = this._gpRebindAction;
    const btn = this._gpRebindBtn;
    this._cancelGpRebind();

    // Check for duplicate — swap
    const current = this.input.gpBindings;
    const newBindings = { ...current };
    for (const otherAction of Object.keys(GP_ACTION_LABELS)) {
      if (otherAction !== action && current[otherAction] === buttonIndex) {
        newBindings[otherAction] = current[action];
        this._gpButtons[otherAction].textContent = InputManager.getGpButtonName(current[action]);
        break;
      }
    }
    newBindings[action] = buttonIndex;
    this.input.setGpBindings(newBindings);
    btn.classList.remove('listening');
    btn.textContent = InputManager.getGpButtonName(buttonIndex);
  }

  _cancelGpRebind() {
    if (this._gpRebindRaf) {
      cancelAnimationFrame(this._gpRebindRaf);
      this._gpRebindRaf = null;
    }
    if (this._gpRebindEscHandler) {
      window.removeEventListener('keydown', this._gpRebindEscHandler, true);
      this._gpRebindEscHandler = null;
    }
    if (this._gpRebindBtn) {
      this._gpRebindBtn.classList.remove('listening');
    }
    this._gpRebindAction = null;
    this._gpRebindBtn = null;
    this._gpRebindPrev = null;
  }

  _cancelAnyRebind() {
    if (this.input.isWaitingForKey) {
      this.input.cancelWaitForKey();
      // Restore all key button labels
      const bindings = this.input.keyBindings;
      for (const action of Object.keys(KEY_ACTION_LABELS)) {
        this._keyButtons[action].textContent = keyCodeToName(bindings[action]);
        this._keyButtons[action].classList.remove('listening');
      }
    }
    this._cancelGpRebind();
  }

  // --- Resets ---
  _resetCamera() {
    this.cameraValues = { ...CAMERA_DEFAULTS };
    this.controller.setSettings(this.cameraValues);
    this._saveCameraSettings();
    for (const cfg of CAMERA_SLIDERS) {
      const { input, valSpan } = this.cameraSliders[cfg.key];
      input.value = CAMERA_DEFAULTS[cfg.key];
      const v = CAMERA_DEFAULTS[cfg.key];
      valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
    }
  }

  _resetKeyBindings() {
    const defaults = InputManager.getDefaultKeyBindings();
    this.input.setKeyBindings(defaults);
    for (const action of Object.keys(KEY_ACTION_LABELS)) {
      this._keyButtons[action].textContent = keyCodeToName(defaults[action]);
    }
  }

  _resetGpBindings() {
    const defaults = InputManager.getDefaultGpBindings();
    const defaultSettings = InputManager.getDefaultGpSettings();
    this.input.setGpBindings(defaults);
    this.input.setGpSettings(defaultSettings);
    for (const action of Object.keys(GP_ACTION_LABELS)) {
      this._gpButtons[action].textContent = InputManager.getGpButtonName(defaults[action]);
    }
    this._gpSliders.deadzone.input.value = defaultSettings.deadzone;
    this._gpSliders.deadzone.valSpan.textContent = defaultSettings.deadzone.toFixed(2);
    this._gpSliders.triggerThreshold.input.value = defaultSettings.triggerThreshold;
    this._gpSliders.triggerThreshold.valSpan.textContent = defaultSettings.triggerThreshold.toFixed(2);
  }

  // --- Events ---
  _bindEvents() {
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && !this.input.isWaitingForKey && !this._gpRebindAction) {
        e.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    this.gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this._onPointerdown = (e) => {
      if (this.open && !this.panel.contains(e.target) && e.target !== this.gearBtn) {
        this.close();
      }
    };
    document.addEventListener('pointerdown', this._onPointerdown);
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  openPanel() {
    this.open = true;
    this.panel.classList.add('open');
    this.gearBtn.classList.add('active');
  }

  close() {
    this._cancelAnyRebind();
    this.open = false;
    this.panel.classList.remove('open');
    this.gearBtn.classList.remove('active');
  }

  destroy() {
    this._cancelAnyRebind();
    document.removeEventListener('keydown', this._onKeydown);
    document.removeEventListener('pointerdown', this._onPointerdown);
    if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
    if (this.gearBtn && this.gearBtn.parentNode) this.gearBtn.parentNode.removeChild(this.gearBtn);
  }
}
