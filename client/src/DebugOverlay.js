// ============================================
// DebugOverlay — Toggle with backtick (`) key
// Shows netcode stats, performance metrics, and interpolation health
// ============================================

export class DebugOverlay {
  constructor(networkManager) {
    this.network = networkManager;
    this.visible = false;
    this.el = null;

    // FPS tracking
    this._frames = 0;
    this._fpsTime = performance.now();
    this._fps = 0;

    // Packet rate tracking
    this._packetCount = 0;
    this._packetRateTime = performance.now();
    this._packetRate = 0;

    // Frame time tracking
    this._frameTimeSum = 0;
    this._frameTimeMax = 0;
    this._frameTimeSamples = 0;
    this._lastFrameTime = performance.now();

    this._createEl();
    this._bindKey();

    // Hook into gameState to count packets
    if (this.network) {
      this.network.on('gameState', () => { this._packetCount++; });
    }
  }

  _createEl() {
    this.el = document.createElement('div');
    this.el.id = 'debug-overlay';
    this.el.style.cssText = `
      position: fixed; top: 8px; left: 8px; z-index: 99999;
      background: rgba(0,0,0,0.8); color: #0f0; font: 12px monospace;
      padding: 8px 12px; border-radius: 4px; pointer-events: none;
      display: none; white-space: pre; line-height: 1.5;
    `;
    document.body.appendChild(this.el);
  }

  _bindKey() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
    });
  }

  update() {
    if (!this.visible) return;

    const now = performance.now();

    // FPS
    this._frames++;
    const fpsDt = now - this._fpsTime;
    if (fpsDt >= 1000) {
      this._fps = Math.round(this._frames * 1000 / fpsDt);
      this._frames = 0;
      this._fpsTime = now;
    }

    // Frame time
    const frameDt = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this._frameTimeSum += frameDt;
    this._frameTimeSamples++;
    if (frameDt > this._frameTimeMax) this._frameTimeMax = frameDt;

    // Packet rate (per second)
    const pktDt = now - this._packetRateTime;
    if (pktDt >= 1000) {
      this._packetRate = Math.round(this._packetCount * 1000 / pktDt);
      this._packetCount = 0;
      this._packetRateTime = now;
    }

    // Reset frame time stats every 2 seconds
    let avgFrame = 0;
    let maxFrame = 0;
    if (this._frameTimeSamples > 0) {
      avgFrame = this._frameTimeSum / this._frameTimeSamples;
      maxFrame = this._frameTimeMax;
    }
    if (fpsDt >= 1000) {
      this._frameTimeSum = 0;
      this._frameTimeMax = 0;
      this._frameTimeSamples = 0;
    }

    const net = this.network;
    const rtt = net ? net.getRTT().toFixed(0) : '-';
    const interpDelay = net ? net.getAdaptiveDelay().toFixed(1) : '-';
    const snapshotCount = net ? net._snapshotCount : 0;
    const jitterAvg = net ? this._calcJitter(net) : '-';

    const lines = [
      `FPS: ${this._fps}  frame: ${avgFrame.toFixed(1)}ms (max ${maxFrame.toFixed(1)}ms)`,
      `RTT: ${rtt}ms  packets/s: ${this._packetRate}`,
      `interp delay: ${interpDelay}ms  jitter: ${jitterAvg}ms`,
      `snapshots: ${snapshotCount}/${net ? net.maxSnapshots : '-'}`,
    ];

    // Show per-player pings if available
    if (net && net.playerPings) {
      lines.push(`player pings: [${net.playerPings.map(p => p + 'ms').join(', ')}]`);
    }

    this.el.textContent = lines.join('\n');
  }

  _calcJitter(net) {
    if (net._jitterCount < 2) return '-';
    let sum = 0;
    for (let i = 0; i < net._jitterCount; i++) sum += net._jitterBuf[i];
    const avg = sum / net._jitterCount;
    let varSum = 0;
    for (let i = 0; i < net._jitterCount; i++) {
      const diff = net._jitterBuf[i] - avg;
      varSum += diff * diff;
    }
    return Math.sqrt(varSum / net._jitterCount).toFixed(1);
  }

  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
