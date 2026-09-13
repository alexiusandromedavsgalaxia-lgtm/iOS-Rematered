// src/drivers/VGPU.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VGPU (Virtual GPU)
 * ═══════════════════════════════════════════════════════════════
 *
 * Modela la GPU virtual del dispositivo. Como con VCPU, no ejecuta
 * shaders reales, pero simula todo el comportamiento observable
 * que el resto del OS necesita:
 *
 *   - 6 cores GPU con carga individual y DVFS independiente
 *   - Motores especializados: vertex / fragment / compute / RT / mesh
 *   - Presupuesto por frame (16.67ms a 60Hz, 8.33ms a 120Hz)
 *   - Medición de FPS, frame time, jank, frames perdidos
 *   - Cola de comandos con backpressure
 *   - Memoria de texturas con pool unificado (16GB compartidos con CPU)
 *   - Throttling térmico (comparte temperatura con VCPU)
 *   - Modos: idle / UI / 3D / compute / RT
 *   - Contadores de triángulos/s, píxeles/s, rayos/s, TFLOPs usados
 *   - Integración con DisplayDriver (frame pacing)
 *   - API submitFrame() para el compositor (SpringBoard)
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes del modelo GPU
// ───────────────────────────────────────────────────────────────
const GPU_CORES          = DEVICE_MODEL.soc.gpu.cores;      // 6
const GPU_FREQ_MIN       = 0.35;   // GHz
const GPU_FREQ_MAX       = 1.62;   // GHz
const GPU_TFLOPS_MAX     = DEVICE_MODEL.soc.gpu.tflops;      // 2.15

// Presupuestos de frame según refresh
const FRAME_BUDGET_60HZ  = 1000 / 60;    // 16.667 ms
const FRAME_BUDGET_120HZ = 1000 / 120;   // 8.333 ms

// Temperaturas (comparte rango con VCPU porque están en el mismo die)
const GPU_TEMP_IDLE      = 32;
const GPU_TEMP_WARM      = 55;
const GPU_TEMP_THROTTLE  = 68;
const GPU_TEMP_CRITICAL  = 82;

// P-states de la GPU (9 estados)
const GPU_P_STATES = [0.35, 0.5, 0.7, 0.9, 1.1, 1.25, 1.4, 1.52, 1.62];

// Tipos de trabajo que la GPU puede procesar
export const GPUWorkload = {
  IDLE:      'idle',
  UI_2D:     'ui-2d',        // composición 2D, blur, sombras
  UI_3D:     'ui-3d',        // transiciones 3D, cover flow
  GAME_3D:   'game-3d',      // juego 3D intensivo
  VIDEO:     'video',        // decode/encode de vídeo
  COMPUTE:   'compute',      // ML / image processing
  RT:        'rt',           // ray tracing
  MESH:      'mesh',         // mesh shading
};

// Carga base por workload (fraction of GPU)
const WORKLOAD_INTENSITY = {
  [GPUWorkload.IDLE]:    0.02,
  [GPUWorkload.UI_2D]:   0.10,
  [GPUWorkload.UI_3D]:   0.35,
  [GPUWorkload.GAME_3D]: 0.85,
  [GPUWorkload.VIDEO]:   0.30,
  [GPUWorkload.COMPUTE]: 0.60,
  [GPUWorkload.RT]:      0.95,
  [GPUWorkload.MESH]:    0.75,
};

// ───────────────────────────────────────────────────────────────
// FrameStats — estadísticas de frame para jank detection
// ───────────────────────────────────────────────────────────────
class FrameRing {
  constructor(capacity = 240) {   // 240 frames = 4s a 60Hz, 2s a 120Hz
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(frame) {
    this.buffer[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray() {
    if (this.size < this.capacity) return this.buffer.slice(0, this.size);
    const out = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return out;
  }

  last(n) {
    const total = this.size;
    if (n >= total) return this.toArray();
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.capacity) % this.capacity;
      out[i] = this.buffer[idx];
    }
    return out;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  get length() { return this.size; }
}

// ───────────────────────────────────────────────────────────────
// GPU core individual
// ───────────────────────────────────────────────────────────────
class GPUCore {
  constructor(id) {
    this.id       = id;
    this.name     = `GPU Core ${id}`;
    this.state    = 'idle';       // idle | running | throttled | offline
    this.pState   = 0;
    this.freqGHz  = GPU_P_STATES[0];
    this.load     = 0;            // 0-100
    this.loadEma  = 0;
    this.tempC    = GPU_TEMP_IDLE;

    // Contadores
    this.busyMs        = 0;
    this.powerMw       = 0;
    this.energyMj      = 0;
    this.trianglesM    = 0;       // millones de triángulos
    this.pixelsM       = 0;       // millones de píxeles
    this.raysM         = 0;       // millones de rayos (RT)
    this.tflopsUsed    = 0;       // TFLOPs efectivos
  }

  setFrequency(targetGHz) {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < GPU_P_STATES.length; i++) {
      const d = Math.abs(GPU_P_STATES[i] - targetGHz);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    this.pState = best;
    this.freqGHz = GPU_P_STATES[best];
  }

  execute(ms, load, workload) {
    this.load = Math.max(0, Math.min(100, load));
    this.loadEma = this.loadEma * 0.85 + this.load * 0.15;

    const fraction = this.load / 100;
    const busyMs = ms * fraction;
    this.busyMs += busyMs;

    // TFLOPs efectivos: (freq/freqMax) * tflopsMax * fraction / cores
    const perCoreTflops = (GPU_TFLOPS_MAX / GPU_CORES) * (this.freqGHz / GPU_FREQ_MAX);
    const effective = perCoreTflops * fraction;
    this.tflopsUsed = effective;

    // Contadores según workload
    const workloadIntensity = WORKLOAD_INTENSITY[workload] || 0;
    const seconds = busyMs / 1000;
    // Triángulos/s ~ 500M por core a máxima frecuencia
    const triRate = 500e6 * (this.freqGHz / GPU_FREQ_MAX) * workloadIntensity;
    this.trianglesM += (triRate * seconds) / 1e6;
    // Píxeles/s ~ 5G por core a máxima frecuencia (fill rate)
    const pixelRate = 5e9 * (this.freqGHz / GPU_FREQ_MAX) * workloadIntensity;
    this.pixelsM += (pixelRate * seconds) / 1e6;
    // Rayos/s si es RT
    if (workload === GPUWorkload.RT) {
      const rayRate = 800e6 * (this.freqGHz / GPU_FREQ_MAX) * workloadIntensity;
      this.raysM += (rayRate * seconds) / 1e6;
    }

    // Potencia: escalado cuadrático con frecuencia + lineal con carga
    const v = 0.55 + 0.45 * (this.freqGHz / GPU_FREQ_MAX);
    const capFactor = 8;
    const dynamic = capFactor * v * v * this.freqGHz * 1000 * fraction;
    this.powerMw = Math.max(30, dynamic / 1000);
    this.energyMj += (this.powerMw * ms) / 1000;

    // Calor
    this.tempC += (this.powerMw * ms) / 300000;
    if (this.tempC > GPU_TEMP_CRITICAL) this.tempC = GPU_TEMP_CRITICAL;
  }

  dissipate(ms, ambientC = GPU_TEMP_IDLE) {
    const k = 0.0008;
    const diff = this.tempC - ambientC;
    if (diff > 0) {
      this.tempC -= diff * k * ms;
      if (this.tempC < ambientC) this.tempC = ambientC;
    }
  }

  snapshot() {
    return {
      id:        this.id,
      name:      this.name,
      state:     this.state,
      pState:    this.pState,
      freqGHz:   parseFloat(this.freqGHz.toFixed(3)),
      load:      parseFloat(this.load.toFixed(1)),
      loadEma:   parseFloat(this.loadEma.toFixed(1)),
      tempC:     parseFloat(this.tempC.toFixed(2)),
      busyMs:    Math.round(this.busyMs),
      powerMw:   parseFloat(this.powerMw.toFixed(1)),
      energyMj:  parseFloat(this.energyMj.toFixed(2)),
      tflopsUsed:parseFloat(this.tflopsUsed.toFixed(3)),
      trianglesM:parseFloat(this.trianglesM.toFixed(2)),
      pixelsM:   parseFloat(this.pixelsM.toFixed(2)),
      raysM:     parseFloat(this.raysM.toFixed(2)),
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Command buffer entry
// ───────────────────────────────────────────────────────────────
class GPUCommand {
  constructor(type, payload = {}, source = 'unknown') {
    this.id      = `gpu-${GPUCommand._seq++}`;
    this.type    = type;            // 'draw' | 'compute' | 'blit' | 'present'
    this.payload = payload;
    this.source  = source;
    this.ts      = Date.now();
    this.cost    = payload.cost ?? 1;   // unidades de coste estimadas
  }
  static _seq = 0;
}

// ───────────────────────────────────────────────────────────────
// VGPU — driver completo
// ───────────────────────────────────────────────────────────────
export class VGPU {
  constructor(bus) {
    this.bus     = bus;
    this.name    = 'VGPU';
    this.model   = DEVICE_MODEL.soc.gpu.name;

    // Crear cores
    this.cores = [];
    for (let i = 0; i < GPU_CORES; i++) this.cores.push(new GPUCore(i));

    // Estado global
    this.initialized = false;
    this.running     = false;
    this.thermalState = 'nominal';
    this.lowPower    = false;
    this.workload    = GPUWorkload.IDLE;

    // Refresh objetivo (viene del DisplayDriver, pero por defecto 120Hz)
    this.targetRefreshHz = DEVICE_MODEL.display.refreshHz;
    this.frameBudgetMs = 1000 / this.targetRefreshHz;

    // Cola de comandos (con backpressure)
    this.commandQueue = [];
    this.maxCommandQueue = 512;
    this.commandsDropped = 0;

    // Estadísticas de frames
    this.frameRing = new FrameRing(240);
    this.frameCounter = 0;
    this.lastFrameStart = 0;
    this.currentFrameStart = 0;

    // Memoria de texturas (pool unificado, 4GB reservados para GPU)
    this.textureMemoryLimit = 4 * 1024 * 1024 * 1024;
    this.textureMemoryUsed = 0;
    this.textures = new Map();      // id -> { sizeBytes, format, created }

    // Contadores globales
    this.totalPowerMw = 0;
    this.totalEnergyMj = 0;
    this.ambientTempC = 25;

    // Suscriptores
    this.subscribers = new Set();
    this.frameSubscribers = new Set();      // solo frames
    this.jankSubscribers = new Set();       // solo jank

    // Tick loop
    this.tickIntervalMs = 100;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      ticks:            0,
      framesRendered:   0,
      framesDropped:    0,
      jankEvents:       0,
      commandsSubmitted:0,
      commandsExecuted: 0,
      peakPowerMw:      0,
      peakTempC:        GPU_TEMP_IDLE,
      peakLoad:         0,
      drawCalls:        0,
      computeDispatches:0,
      presentCalls:     0,
      throttlesTriggered: 0,
      avgFps:           0,
      minFps:           Infinity,
      maxFps:           0,
      startedAt:        null,
    };

    // Historial de carga (para gráficos)
    this.historySize = 120;
    this.history = {
      ts:       [],
      loadAvg:  [],
      tempAvg:  [],
      powerMw:  [],
      fps:      [],
    };

    logger.kernel('VGPU', `creado: ${this.model} (${GPU_CORES} cores @ ${GPU_FREQ_MAX}GHz, ${GPU_TFLOPS_MAX} TFLOPs)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;

    for (const core of this.cores) {
      core.state = 'idle';
      core.setFrequency(GPU_FREQ_MIN);
    }

    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VGPU', `✓ init: ${this.model}, ${GPU_P_STATES.length} P-states, target=${this.targetRefreshHz}Hz`);
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', { source: 'vgpu', event: 'ready' }, 'vgpu');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    for (const core of this.cores) core.state = 'offline';
    this.textures.clear();
    this.textureMemoryUsed = 0;
    logger.info('VGPU', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const dtMs = this.tickIntervalMs;

    // Disipar calor
    for (const core of this.cores) core.dissipate(dtMs, this.ambientTempC);

    // Determinar carga según workload y cola de comandos
    const baseIntensity = WORKLOAD_INTENSITY[this.workload] || 0.05;
    const queueBoost = Math.min(0.3, this.commandQueue.length / this.maxCommandQueue * 0.5);
    const intensity = Math.min(1, baseIntensity + queueBoost);
    const targetLoad = intensity * 100;

    // Distribuir carga por cores (todos igual en GPU)
    for (const core of this.cores) {
      const jitter = 0.95 + Math.random() * 0.1;
      core.execute(dtMs, targetLoad * jitter, this.workload);
    }

    // DVFS
    this._applyDVFS();

    // Thermal policy (comparte lógica con VCPU)
    this._applyThermalPolicy();

    // Procesar comandos pendientes
    this._drainCommands();

    // Consolidar
    this._consolidateMetrics(dtMs);
    this._pushHistory();

    // Auto-bajar workload si no hay comandos ni frames
    if (this.commandQueue.length === 0 && this.workload !== GPUWorkload.IDLE) {
      this._idleTicks = (this._idleTicks || 0) + 1;
      if (this._idleTicks > 10) {
        this.setWorkload(GPUWorkload.IDLE);
        this._idleTicks = 0;
      }
    } else {
      this._idleTicks = 0;
    }

    this.metrics.ticks++;
    this.tickCount++;
    this._emit();
  }

  _applyDVFS() {
    const pCap = this.lowPower ? 0.9 : GPU_FREQ_MAX;

    for (const core of this.cores) {
      const load = core.loadEma;
      const curve = Math.pow(load / 100, 0.6);
      let targetFreq = GPU_FREQ_MIN + (GPU_FREQ_MAX - GPU_FREQ_MIN) * curve;
      targetFreq = Math.min(targetFreq, pCap);
      targetFreq = Math.max(GPU_FREQ_MIN, targetFreq);
      core.setFrequency(targetFreq);

      if (load < 3) {
        core.state = 'idle';
        core.setFrequency(GPU_FREQ_MIN);
      } else if (this.thermalState === 'serious' || this.thermalState === 'critical') {
        core.state = 'throttled';
      } else {
        core.state = 'running';
      }
    }
  }

  _applyThermalPolicy() {
    const maxTemp = Math.max(...this.cores.map(c => c.tempC));
    let prevState = this.thermalState;

    if (maxTemp >= GPU_TEMP_CRITICAL)      this.thermalState = 'critical';
    else if (maxTemp >= GPU_TEMP_THROTTLE) this.thermalState = 'serious';
    else if (maxTemp >= GPU_TEMP_WARM)     this.thermalState = 'fair';
    else                                   this.thermalState = 'nominal';

    if (this.thermalState === 'serious' || this.thermalState === 'critical') {
      for (const core of this.cores) {
        if (this.thermalState === 'critical') core.setFrequency(GPU_FREQ_MIN);
        else core.setFrequency(Math.min(core.freqGHz, (GPU_FREQ_MIN + GPU_FREQ_MAX) * 0.5));
      }
      if (prevState !== this.thermalState) {
        this.metrics.throttlesTriggered++;
        logger.warn('VGPU', `⚠ thermal → ${this.thermalState} (max=${maxTemp.toFixed(1)}°C)`);
        this.bus?.raiseInterrupt?.('IRQ_THERMAL', {
          source: 'vgpu', state: this.thermalState, maxTemp,
        }, 'vgpu');
      }
    } else if (prevState !== this.thermalState) {
      this.bus?.raiseInterrupt?.('IRQ_THERMAL', {
        source: 'vgpu', state: this.thermalState, maxTemp,
      }, 'vgpu');
    }

    this.metrics.peakTempC = Math.max(this.metrics.peakTempC, maxTemp);
  }

  _drainCommands() {
    if (this.commandQueue.length === 0) return;
    // Procesamos hasta el presupuesto de frame
    const budgetMs = this.frameBudgetMs * 0.7;
    const start = performance.now();
    let processed = 0;

    while (this.commandQueue.length > 0) {
      if (performance.now() - start >= budgetMs) break;
      const cmd = this.commandQueue.shift();
      this._executeCommand(cmd);
      processed++;
      if (processed >= 64) break;    // safety cap
    }

    this.metrics.commandsExecuted += processed;
  }

  _executeCommand(cmd) {
    switch (cmd.type) {
      case 'draw':
        this.metrics.drawCalls++;
        break;
      case 'compute':
        this.metrics.computeDispatches++;
        break;
      case 'blit':
        // copia de textura: no cuenta como draw
        break;
      case 'present':
        this.metrics.presentCalls++;
        break;
    }
  }

  _consolidateMetrics(dtMs) {
    let totalPower = 0;
    let totalLoad = 0;
    for (const core of this.cores) {
      totalPower += core.powerMw;
      totalLoad += core.loadEma;
    }
    this.totalPowerMw = totalPower;
    this.totalEnergyMj += (totalPower * dtMs) / 1000;
    const avgLoad = totalLoad / this.cores.length;
    this.metrics.peakLoad = Math.max(this.metrics.peakLoad, avgLoad);
    if (totalPower > this.metrics.peakPowerMw) this.metrics.peakPowerMw = totalPower;
  }

  _pushHistory() {
    const avgTemp = this.cores.reduce((a, c) => a + c.tempC, 0) / this.cores.length;
    const avgLoad = this.cores.reduce((a, c) => a + c.loadEma, 0) / this.cores.length;
    const lastFrame = this.frameRing.length > 0 ? this.frameRing.toArray().slice(-1)[0] : null;
    const fps = lastFrame ? lastFrame.fps : 0;

    this.history.ts.push(Date.now());
    this.history.loadAvg.push(avgLoad);
    this.history.tempAvg.push(avgTemp);
    this.history.powerMw.push(this.totalPowerMw);
    this.history.fps.push(fps);

    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA — submitFrame, submitCommand, setWorkload
  // ═══════════════════════════════════════════════════════════

  /**
   * El compositor (SpringBoard) llama a esto cada vez que compone un
   * frame. Registramos el tiempo y calculamos FPS/jank.
   */
  submitFrame({ source = 'springboard', complexity = 1, layers = 1 } = {}) {
    const now = performance.now();
    const prevStart = this.lastFrameStart;
    this.lastFrameStart = now;

    let frameTimeMs = 0;
    let fps = 0;

    if (prevStart > 0) {
      frameTimeMs = now - prevStart;
      fps = frameTimeMs > 0 ? 1000 / frameTimeMs : 0;
    }

    const budgetMs = this.frameBudgetMs;
    const overBudget = frameTimeMs > budgetMs * 1.5;
    const jank = frameTimeMs > budgetMs * 2;

    const frame = {
      id:        this.frameCounter++,
      ts:        Date.now(),
      frameTimeMs: parseFloat(frameTimeMs.toFixed(3)),
      fps:       parseFloat(fps.toFixed(1)),
      budgetMs:  parseFloat(budgetMs.toFixed(3)),
      overBudget,
      jank,
      source,
      complexity,
      layers,
    };

    this.frameRing.push(frame);
    this.metrics.framesRendered++;
    if (overBudget) this.metrics.framesDropped++;
    if (jank) {
      this.metrics.jankEvents++;
      this._emitJank(frame);
      logger.warn('VGPU', `⚠ jank: frame ${frame.id} ${frameTimeMs.toFixed(1)}ms (budget=${budgetMs.toFixed(1)}ms)`);
    }

    if (fps > 0) {
      this.metrics.avgFps = this.metrics.avgFps * 0.9 + fps * 0.1;
      if (fps < this.metrics.minFps) this.metrics.minFps = fps;
      if (fps > this.metrics.maxFps) this.metrics.maxFps = fps;
    }

    // Notificar a suscriptores de frame
    for (const fn of this.frameSubscribers) {
      try { fn(frame); } catch (_) {}
    }

    return frame;
  }

  /**
   * Encola un comando GPU. Devuelve true si aceptado, false si la cola
   * está llena (backpressure).
   */
  submitCommand(type, payload = {}, source = 'unknown') {
    if (this.commandQueue.length >= this.maxCommandQueue) {
      this.commandsDropped++;
      logger.warn('VGPU', `comando descartado (cola llena): ${type} de ${source}`);
      return false;
    }
    const cmd = new GPUCommand(type, payload, source);
    this.commandQueue.push(cmd);
    this.metrics.commandsSubmitted++;
    // Ajustar workload automáticamente
    if (type === 'draw' && this.workload === GPUWorkload.IDLE) {
      this.setWorkload(GPUWorkload.UI_2D);
    } else if (type === 'compute' && this.workload === GPUWorkload.IDLE) {
      this.setWorkload(GPUWorkload.COMPUTE);
    }
    return true;
  }

  /** Cambia el modo de trabajo. Ajusta carga base y DVFS. */
  setWorkload(mode) {
    if (!Object.values(GPUWorkload).includes(mode)) {
      logger.warn('VGPU', `workload desconocido: ${mode}`);
      return;
    }
    if (this.workload === mode) return;
    logger.info('VGPU', `workload: ${this.workload} → ${mode}`);
    this.workload = mode;
    this._emit();
  }

  getWorkload() {
    return this.workload;
  }

  /** Cambia el refresh objetivo. Ajusta presupuesto de frame. */
  setRefreshRate(hz) {
    if (![60, 90, 120].includes(hz)) {
      logger.warn('VGPU', `refresh rate no soportado: ${hz}Hz (usando 60)`);
      hz = 60;
    }
    this.targetRefreshHz = hz;
    this.frameBudgetMs = 1000 / hz;
    logger.info('VGPU', `refresh objetivo = ${hz}Hz (budget=${this.frameBudgetMs.toFixed(2)}ms)`);
    this._emit();
  }

  /** Activa/desactiva modo bajo consumo. */
  setLowPowerMode(on) {
    this.lowPower = !!on;
    logger.info('VGPU', `low power ${this.lowPower ? 'ON' : 'OFF'}`);
  }

  setAmbientTemp(c) {
    this.ambientTempC = Math.max(-10, Math.min(60, c));
  }

  // ═══════════════════════════════════════════════════════════
  // MEMORIA DE TEXTURAS
  // ═══════════════════════════════════════════════════════════

  /**
   * Reserva memoria para una textura. Devuelve un id o null si no hay.
   */
  allocateTexture(sizeBytes, format = 'rgba8', source = 'unknown') {
    if (sizeBytes <= 0) {
      logger.warn('VGPU', `allocateTexture: size inválido ${sizeBytes}`);
      return null;
    }
    if (this.textureMemoryUsed + sizeBytes > this.textureMemoryLimit) {
      logger.warn('VGPU', `OOM de texturas: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB solicitados, ${((this.textureMemoryLimit - this.textureMemoryUsed) / 1024 / 1024).toFixed(1)}MB libres`);
      return null;
    }
    const id = `tex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.textures.set(id, {
      id, sizeBytes, format, source,
      createdAt: Date.now(),
    });
    this.textureMemoryUsed += sizeBytes;
    return id;
  }

  freeTexture(id) {
    const t = this.textures.get(id);
    if (!t) return false;
    this.textureMemoryUsed -= t.sizeBytes;
    this.textures.delete(id);
    return true;
  }

  getTextureStats() {
    return {
      count:       this.textures.size,
      usedBytes:   this.textureMemoryUsed,
      usedMB:      parseFloat((this.textureMemoryUsed / 1024 / 1024).toFixed(2)),
      limitBytes:  this.textureMemoryLimit,
      limitMB:     parseFloat((this.textureMemoryLimit / 1024 / 1024).toFixed(0)),
      usagePct:    parseFloat(((this.textureMemoryUsed / this.textureMemoryLimit) * 100).toFixed(2)),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES / EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onFrame(fn) {
    this.frameSubscribers.add(fn);
    return () => this.frameSubscribers.delete(fn);
  }

  onJank(fn) {
    this.jankSubscribers.add(fn);
    return () => this.jankSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VGPU', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitJank(frame) {
    for (const fn of this.jankSubscribers) {
      try { fn(frame); } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS / SNAPSHOTS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    const avgLoad = this.cores.reduce((a, c) => a + c.loadEma, 0) / this.cores.length;
    const avgFreq = this.cores.reduce((a, c) => a + c.freqGHz, 0) / this.cores.length;
    const avgTemp = this.cores.reduce((a, c) => a + c.tempC, 0) / this.cores.length;
    const maxTemp = Math.max(...this.cores.map(c => c.tempC));

    return {
      model:         this.model,
      coreCount:     this.cores.length,
      workload:      this.workload,
      thermalState:  this.thermalState,
      lowPower:      this.lowPower,
      targetRefreshHz: this.targetRefreshHz,
      frameBudgetMs: parseFloat(this.frameBudgetMs.toFixed(3)),
      avgLoad:       parseFloat(avgLoad.toFixed(1)),
      avgFreqGHz:    parseFloat(avgFreq.toFixed(3)),
      avgTempC:      parseFloat(avgTemp.toFixed(2)),
      maxTempC:      parseFloat(maxTemp.toFixed(2)),
      totalPowerMw:  parseFloat(this.totalPowerMw.toFixed(1)),
      totalEnergyMj: parseFloat(this.totalEnergyMj.toFixed(2)),
      commandQueue:  this.commandQueue.length,
      maxCommandQueue: this.maxCommandQueue,
      textures:      this.getTextureStats(),
      cores:         this.cores.map(c => c.snapshot()),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      workload:    this.workload,
      thermalState:this.thermalState,
      metrics:     { ...this.metrics },
      framesInRing:this.frameRing.length,
      commandsDropped: this.commandsDropped,
      textureMemory: this.getTextureStats(),
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VGPU [${s.running ? 'RUNNING' : 'STOPPED'}] — ${s.model}`,
      `  workload:    ${s.workload}`,
      `  thermal:     ${s.thermalState}`,
      `  refresh:     ${this.targetRefreshHz}Hz (budget=${this.frameBudgetMs.toFixed(2)}ms)`,
      `  frames:      ${s.metrics.framesRendered} rendered, ${s.metrics.framesDropped} dropped, ${s.metrics.jankEvents} jank`,
      `  avg FPS:     ${s.metrics.avgFps.toFixed(1)}`,
      `  commands:    ${s.metrics.commandsSubmitted} submitted, ${s.metrics.commandsExecuted} executed, ${s.commandsDropped} dropped`,
      `  textures:    ${s.textureMemory.count} (${s.textureMemory.usedMB}MB / ${s.textureMemory.limitMB}MB)`,
      `  cores:`,
    ];
    for (const c of this.cores) {
      const snap = c.snapshot();
      lines.push(
        `    [${snap.id}] ${snap.state.padEnd(10)} ` +
        `${snap.freqGHz.toFixed(2)}GHz p=${snap.pState} ` +
        `load=${String(snap.load).padStart(5)}% ` +
        `temp=${String(snap.tempC).padStart(5)}°C ` +
        `pwr=${String(snap.powerMw).padStart(6)}mW ` +
        `TFLOPS=${snap.tflopsUsed.toFixed(2)}`
      );
    }
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:      [...this.history.ts],
      loadAvg: [...this.history.loadAvg],
      tempAvg: [...this.history.tempAvg],
      powerMw: [...this.history.powerMw],
      fps:     [...this.history.fps],
    };
  }

  getRecentFrames(n = 60) {
    return this.frameRing.last(n);
  }

  getJankReport() {
    const frames = this.frameRing.toArray();
    if (frames.length === 0) return { total: 0, jank: 0, p50: 0, p95: 0, p99: 0, worst: 0 };
    const times = frames.map(f => f.frameTimeMs).sort((a, b) => a - b);
    const jankCount = frames.filter(f => f.jank).length;
    return {
      total:  frames.length,
      jank:   jankCount,
      p50:    times[Math.floor(times.length * 0.5)],
      p95:    times[Math.floor(times.length * 0.95)],
      p99:    times[Math.floor(times.length * 0.99)],
      worst:  times[times.length - 1],
      avgFps: this.metrics.avgFps,
    };
  }
}
