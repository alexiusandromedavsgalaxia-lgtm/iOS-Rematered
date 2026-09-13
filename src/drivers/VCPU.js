// src/drivers/VCPU.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VCPU (Virtual CPU)
 * ═══════════════════════════════════════════════════════════════
 *
 * Modela la CPU virtual del dispositivo. No ejecuta instrucciones
 * ARM reales (eso requeriría emulación binaria completa), pero sí
 * simula el comportamiento observable que el resto del OS necesita:
 *
 *   - Estado por core (idle / running / throttled / offline)
 *   - Frecuencia dinámica por core (DVFS - Dynamic Voltage Freq Scaling)
 *   - Carga por core (0-100%) con media móvil
 *   - Temperatura por core + temperatura global
 *   - Throttling térmico automático cuando supera umbrales
 *   - P-state selection (cuántos cores activos según la carga)
 *   - Instrucciones/segundo simuladas
 *   - Energía consumida (mW) por core
 *   - Estadísticas de context switch por core
 *   - Registro de "última carga por core" (para el HardwareMonitor)
 *
 * El Scheduler del kernel puede consultar este driver para decidir
 * cuántos cores usar y a qué frecuencia. En un iPhone real, el
 * kernel hace exactamente esto a través de XNU y el driver de PMGR.
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes del modelo de CPU
// ───────────────────────────────────────────────────────────────

// Frecuencias base (GHz) por tipo de core
const P_CORE_FREQ_MIN = 0.6;
const P_CORE_FREQ_MAX = 4.05;      // Everst (performance)
const E_CORE_FREQ_MIN = 0.6;
const E_CORE_FREQ_MAX = 2.42;      // Sawtooth (efficiency)

// Temperaturas (Celsius)
const TEMP_IDLE       = 32;
const TEMP_NORMAL     = 45;
const TEMP_WARM       = 55;
const TEMP_THROTTLE   = 65;
const TEMP_CRITICAL   = 80;
const TEMP_SHUTDOWN   = 95;

// P-states (frecuencias discretas seleccionables por DVFS)
const P_STATES = {
  performance: [0.6, 1.2, 1.8, 2.4, 3.0, 3.4, 3.7, 3.9, 4.05],   // 9 estados
  efficiency:  [0.6, 1.0, 1.4, 1.8, 2.0, 2.2, 2.42],             // 7 estados
};

// Voltajes por P-state (V) — escala con la frecuencia
function voltageForState(state, maxState, isP) {
  const minV = isP ? 0.65 : 0.55;
  const maxV = isP ? 1.15 : 0.95;
  return minV + (maxV - minV) * (state / maxState);
}

// Energía aproximada (mW) por core según frecuencia y carga
function estimatePowerMw(freqGHz, loadPct, voltageV, isP) {
  // P = C * V^2 * f  (simplificado)
  const capFactor = isP ? 12 : 4;    // capacidad efectiva (ficticia)
  const freqMhz = freqGHz * 1000;
  const dynamic = capFactor * voltageV * voltageV * freqMhz * (loadPct / 100);
  const static_ = isP ? 45 : 18;     // leakage
  return Math.max(static_, dynamic / 1000);
}

// ───────────────────────────────────────────────────────────────
// CoreVirtual — un core individual
// ───────────────────────────────────────────────────────────────
class CoreVirtual {
  /**
   * @param {number} id        Número de core (0-indexed)
   * @param {string} type      'performance' | 'efficiency'
   * @param {object} config    { name, freqGHz }
   */
  constructor(id, type, config) {
    this.id       = id;
    this.type     = type;
    this.name     = config.name;
    this.freqMin  = type === 'performance' ? P_CORE_FREQ_MIN : E_CORE_FREQ_MIN;
    this.freqMax  = type === 'performance' ? P_CORE_FREQ_MAX : E_CORE_FREQ_MAX;
    this.pStates  = type === 'performance' ? P_STATES.performance : P_STATES.efficiency;

    this.state    = 'idle';           // idle | running | throttled | offline
    this.freqGHz  = this.freqMin;
    this.pState   = 0;
    this.voltage  = voltageForState(0, this.pStates.length - 1, type === 'performance');

    // Carga
    this.load     = 0;                // 0-100
    this.loadEma  = 0;
    this.loadPeak = 0;

    // Temperatura local
    this.tempC    = TEMP_IDLE;

    // Contabilidad
    this.busyMs          = 0;
    this.idleMs          = 0;
    this.contextSwitches = 0;
    this.instructionsM   = 0;         // millones de instrucciones acumuladas
    this.powerMw         = 0;
    this.energyMj        = 0;         // energía acumulada (mJ)

    // Timestamps
    this.createdAt    = Date.now();
    this.lastActiveAt = null;
    this.lastThrottleAt = null;
    this.throttleCount  = 0;
  }

  setPState(state) {
    state = Math.max(0, Math.min(this.pStates.length - 1, state | 0));
    if (state === this.pState && this.freqGHz > 0) return;
    this.pState = state;
    this.freqGHz = this.pStates[state];
    this.voltage = voltageForState(state, this.pStates.length - 1, this.type === 'performance');
  }

  /** Escoge el P-state más cercano a la frecuencia deseada. */
  setFrequency(targetGHz) {
    const arr = this.pStates;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i] - targetGHz);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    this.setPState(best);
  }

  setLoad(loadPct) {
    this.load = Math.max(0, Math.min(100, loadPct));
    this.loadEma = this.loadEma * 0.85 + this.load * 0.15;
    if (this.load > this.loadPeak) this.loadPeak = this.load;
    if (this.load > 5) this.lastActiveAt = Date.now();
  }

  /** Añade calor por trabajo realizado (mW * ms). */
  addHeat(mwMs) {
    // El calor no sube indefinidamente porque también disipa.
    const delta = mwMs / 250000;    // factor de escalado arbitrario realista
    this.tempC += delta;
    if (this.tempC > TEMP_SHUTDOWN) this.tempC = TEMP_SHUTDOWN;
  }

  /** Disipa calor hacia el ambiente. */
  dissipate(deltaMs, ambientC = TEMP_IDLE) {
    const k = 0.0006;               // coeficiente de disipación
    const diff = this.tempC - ambientC;
    if (diff > 0) {
      this.tempC -= diff * k * deltaMs;
      if (this.tempC < ambientC) this.tempC = ambientC;
    }
  }

  /** Ejecuta trabajo durante `ms` a `load%`. Actualiza contabilidad. */
  execute(ms, load) {
    this.setLoad(load);
    const fraction = load / 100;
    const busy = ms * fraction;

    this.busyMs += busy;
    this.idleMs += ms - busy;

    // Instrucciones: IPC medio ~2 en P-core, ~1.4 en E-core
    const ipc = this.type === 'performance' ? 2.0 : 1.4;
    const freqGhz = this.freqGHz;
    const instructions = freqGhz * 1e9 * (busy / 1000) * ipc;   // instrucciones
    this.instructionsM += instructions / 1e6;

    // Potencia y energía
    this.powerMw = estimatePowerMw(this.freqGHz, load, this.voltage, this.type === 'performance');
    const mj = (this.powerMw * ms) / 1000;
    this.energyMj += mj;

    // Calor
    this.addHeat(this.powerMw * ms);
  }

  getSnapshot() {
    return {
      id:       this.id,
      name:     this.name,
      type:     this.type,
      state:    this.state,
      freqGHz:  parseFloat(this.freqGHz.toFixed(3)),
      pState:   this.pState,
      pStates:  this.pStates.length,
      voltage:  parseFloat(this.voltage.toFixed(3)),
      load:     parseFloat(this.load.toFixed(1)),
      loadEma:  parseFloat(this.loadEma.toFixed(1)),
      loadPeak: parseFloat(this.loadPeak.toFixed(1)),
      tempC:    parseFloat(this.tempC.toFixed(2)),
      busyMs:   Math.round(this.busyMs),
      idleMs:   Math.round(this.idleMs),
      powerMw:  parseFloat(this.powerMw.toFixed(1)),
      energyMj: parseFloat(this.energyMj.toFixed(2)),
      instructionsM: parseFloat(this.instructionsM.toFixed(1)),
      contextSwitches: this.contextSwitches,
      throttleCount:   this.throttleCount,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VCPU — driver completo
// ───────────────────────────────────────────────────────────────
export class VCPU {
  constructor(bus) {
    this.bus   = bus;
    this.model = `${DEVICE_MODEL.soc.name} (${DEVICE_MODEL.soc.cpu.cores}-core)`;
    this.name  = 'VCPU';

    // Crear cores según el modelo
    this.cores = [];
    let idx = 0;
    for (const cfg of DEVICE_MODEL.soc.cpu.config) {
      for (let i = 0; i < cfg.count; i++) {
        this.cores.push(new CoreVirtual(idx++, cfg.type, cfg));
      }
    }

    // Estado global
    this.initialized = false;
    this.running     = false;
    this.lowPower    = false;
    this.thermalState = 'nominal';    // nominal | fair | serious | critical | shutdown
    this.totalPowerMw = 0;
    this.totalEnergyMj = 0;
    this.ambientTempC = 25;

    // Ventana de muestreo (histórico de los últimos N segundos)
    this.historySize = 120;           // 120 muestras = ~60s a 2Hz
    this.history = {
      ts:       [],
      loadTotal:[],
      tempAvg:  [],
      powerMw:  [],
      freqAvg:  [],
    };

    // Suscriptores
    this.subscribers = new Set();

    // Timer de tick (200ms)
    this.tickIntervalMs = 200;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas globales
    this.metrics = {
      ticks:            0,
      totalContextSwitches: 0,
      throttleEvents:   0,
      thermalWarnings:  0,
      thermalCriticals: 0,
      peakPowerMw:      0,
      peakTempC:        TEMP_IDLE,
      avgLoad:          0,
      uptimeMs:         0,
      startedAt:        null,
    };

    logger.kernel('VCPU', `creado: ${this.cores.length} cores (${this._coreSummary()})`);
  }

  _coreSummary() {
    const p = this.cores.filter(c => c.type === 'performance').length;
    const e = this.cores.filter(c => c.type === 'efficiency').length;
    return `${p}P + ${e}E`;
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;

    // Estado inicial: todos idle a mínima frecuencia
    for (const core of this.cores) {
      core.state = 'idle';
      core.setFrequency(core.freqMin);
    }

    this.initialized = true;
    this.metrics.startedAt = Date.now();

    // Arrancamos el bucle de simulación
    this._startTickLoop();

    logger.info('VCPU', `✓ init: ${this.model}, DVFS activo, ${P_STATES.performance.length + P_STATES.efficiency.length} P-states`);
    this.bus?.raiseInterrupt?.('IRQ_POWER', { source: 'vcpu', event: 'ready' }, 'vcpu');
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
    logger.info('VCPU', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK — simulación periódica
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const dtMs = this.tickIntervalMs;

    // Cada core disipa calor hacia el ambiente
    for (const core of this.cores) {
      core.dissipate(dtMs, this.ambientTempC);
    }

    // El kernel nos dice cuánta carga hay; si no, la estimamos del scheduler
    const targetLoad = this._estimateLoadFromKernel();
    this._distributeLoad(targetLoad);

    // Aplicar DVFS según carga
    this._applyDVFS();

    // Aplicar throttling térmico
    this._applyThermalPolicy();

    // Consolidar métricas globales
    this._consolidateMetrics(dtMs);

    // Guardar histórico
    this._pushHistory();

    // Notificar
    this._emit();

    this.metrics.ticks++;
    this.tickCount++;
  }

  _estimateLoadFromKernel() {
    // Si el kernel está enlazado, leemos la carga del scheduler.
    // Si no, hacemos una simulación plausible con ruido + un pulso lento.
    if (this.bus?.kernel?.scheduler) {
      const load = this.bus.kernel.scheduler.getStats().cpuLoad;
      if (typeof load === 'number' && !isNaN(load)) return load;
    }
    // Simulación de respaldo: onda sinusoidal + ruido + picos
    const t = this.tickCount / 20;
    const base = 25 + Math.sin(t) * 15 + Math.sin(t * 3.7) * 8;
    const noise = (Math.random() - 0.5) * 6;
    const spike = Math.random() < 0.03 ? 30 : 0;
    return Math.max(0, Math.min(100, base + noise + spike));
  }

  _distributeLoad(totalLoad) {
    // Los P-cores se saturan primero, los E-cores absorben el resto.
    // Esto es lo que hace Apple Silicon realmente (asymmetric scheduling).
    const pCores = this.cores.filter(c => c.type === 'performance');
    const eCores = this.cores.filter(c => c.type === 'efficiency');

    // Reparto: hasta 60% va a P-cores, por encima se reparte a E-cores
    const pLoad = Math.min(100, (totalLoad / 60) * 100);
    const eLoad = totalLoad <= 60 ? Math.min(15, totalLoad / 8) : Math.min(100, ((totalLoad - 60) / 40) * 100);

    for (const core of pCores) {
      core.execute(this.tickIntervalMs, pLoad * (0.9 + Math.random() * 0.2));
    }
    for (const core of eCores) {
      core.execute(this.tickIntervalMs, eLoad * (0.9 + Math.random() * 0.2));
    }
  }

  _applyDVFS() {
    // Si lowPower mode está activo, capamos la frecuencia
    const pCap = this.lowPower ? 2.4 : P_CORE_FREQ_MAX;
    const eCap = this.lowPower ? 1.4 : E_CORE_FREQ_MAX;

    for (const core of this.cores) {
      // Frecuencia objetivo proporcional a carga (con curva no lineal)
      const load = core.loadEma;
      const curve = Math.pow(load / 100, 0.7);   // más sensible en cargas bajas
      let targetFreq = core.freqMin + (core.freqMax - core.freqMin) * curve;
      targetFreq = Math.min(targetFreq, core.type === 'performance' ? pCap : eCap);

      // Frecuencia mínima: nunca por debajo de freqMin
      targetFreq = Math.max(core.freqMin, targetFreq);

      core.setFrequency(targetFreq);

      // Estado observable
      if (load < 3) {
        core.state = 'idle';
        // Bajar a frecuencia mínima cuando idle
        core.setFrequency(core.freqMin);
      } else if (this.thermalState === 'serious' || this.thermalState === 'critical') {
        core.state = 'throttled';
      } else {
        core.state = 'running';
      }
    }
  }

  _applyThermalPolicy() {
    // Temperatura media de todos los cores
    const avgTemp = this.cores.reduce((a, c) => a + c.tempC, 0) / this.cores.length;
    const maxTemp = Math.max(...this.cores.map(c => c.tempC));

    let prevState = this.thermalState;

    if (maxTemp >= TEMP_SHUTDOWN) {
      this.thermalState = 'shutdown';
    } else if (maxTemp >= TEMP_CRITICAL) {
      this.thermalState = 'critical';
    } else if (maxTemp >= TEMP_THROTTLE) {
      this.thermalState = 'serious';
    } else if (maxTemp >= TEMP_WARM) {
      this.thermalState = 'fair';
    } else {
      this.thermalState = 'nominal';
    }

    // Si sube a serious o critical, forzamos throttling
    if (this.thermalState === 'serious' || this.thermalState === 'critical') {
      for (const core of this.cores) {
        if (this.thermalState === 'critical') {
          core.setFrequency(core.freqMin);
        } else {
          // serious: bajar al 50% del rango
          const mid = (core.freqMin + core.freqMax) * 0.5;
          core.setFrequency(Math.min(core.freqGHz, mid));
        }
        if (core.state !== 'throttled') {
          core.throttleCount++;
          this.metrics.throttleEvents++;
          core.lastThrottleAt = Date.now();
        }
      }
      if (prevState !== this.thermalState) {
        this.metrics.thermalWarnings++;
        if (this.thermalState === 'critical') this.metrics.thermalCriticals++;
        logger.warn('VCPU', `⚠ thermal state → ${this.thermalState} (avg=${avgTemp.toFixed(1)}°C max=${maxTemp.toFixed(1)}°C)`);
        this.bus?.raiseInterrupt?.('IRQ_THERMAL', {
          source: 'vcpu',
          state: this.thermalState,
          avgTemp,
          maxTemp,
        }, 'vcpu');
      }
    } else if (prevState !== this.thermalState) {
      logger.info('VCPU', `thermal state → ${this.thermalState}`);
      this.bus?.raiseInterrupt?.('IRQ_THERMAL', {
        source: 'vcpu',
        state: this.thermalState,
        avgTemp,
        maxTemp,
      }, 'vcpu');
    }

    this.metrics.peakTempC = Math.max(this.metrics.peakTempC, maxTemp);
  }

  _consolidateMetrics(dtMs) {
    let totalPower = 0;
    let totalLoad = 0;
    let totalCs = 0;
    for (const core of this.cores) {
      totalPower += core.powerMw;
      totalLoad += core.loadEma;
      totalCs += core.contextSwitches;
    }
    this.totalPowerMw = totalPower;
    this.totalEnergyMj += (totalPower * dtMs) / 1000;
    this.metrics.avgLoad = totalLoad / this.cores.length;
    this.metrics.totalContextSwitches = totalCs;
    if (totalPower > this.metrics.peakPowerMw) this.metrics.peakPowerMw = totalPower;
    this.metrics.uptimeMs += dtMs;
  }

  _pushHistory() {
    const avgTemp = this.cores.reduce((a, c) => a + c.tempC, 0) / this.cores.length;
    const avgFreq = this.cores.reduce((a, c) => a + c.freqGHz, 0) / this.cores.length;

    this.history.ts.push(Date.now());
    this.history.loadTotal.push(this.metrics.avgLoad);
    this.history.tempAvg.push(avgTemp);
    this.history.powerMw.push(this.totalPowerMw);
    this.history.freqAvg.push(avgFreq);

    // Ring buffer
    for (const key of Object.keys(this.history)) {
      if (this.history[key].length > this.historySize) this.history[key].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA (lo que el kernel / scheduler consumen)
  // ═══════════════════════════════════════════════════════════

  /** Devuelve el número de cores disponibles. */
  coreCount() {
    return this.cores.length;
  }

  /** Devuelve los cores performance disponibles (no throttled ni offline). */
  availablePCores() {
    return this.cores.filter(c => c.type === 'performance' && c.state !== 'offline').length;
  }

  /** Devuelve los cores efficiency disponibles. */
  availableECores() {
    return this.cores.filter(c => c.type === 'efficiency' && c.state !== 'offline').length;
  }

  /** Frecuencia media actual. */
  avgFrequencyGHz() {
    return this.cores.reduce((a, c) => a + c.freqGHz, 0) / this.cores.length;
  }

  /** Carga media. */
  avgLoad() {
    return this.metrics.avgLoad;
  }

  /** Temperatura media. */
  avgTempC() {
    return this.cores.reduce((a, c) => a + c.tempC, 0) / this.cores.length;
  }

  /** Temperatura máxima. */
  maxTempC() {
    return Math.max(...this.cores.map(c => c.tempC));
  }

  /** ¿Está throttled por temperatura? */
  isThrottled() {
    return this.thermalState === 'serious' || this.thermalState === 'critical';
  }

  /** Notifica un context switch (el scheduler lo llama). */
  notifyContextSwitch(coreHint = null) {
    let core = null;
    if (coreHint != null && this.cores[coreHint]) {
      core = this.cores[coreHint];
    } else {
      // Elegimos el P-core menos cargado
      const pcs = this.cores.filter(c => c.type === 'performance');
      core = pcs.reduce((a, b) => (a.loadEma <= b.loadEma ? a : b));
    }
    core.contextSwitches++;
  }

  /** Activa/desactiva modo bajo consumo (afecta a DVFS). */
  setLowPowerMode(on) {
    this.lowPower = !!on;
    logger.info('VCPU', `low power ${this.lowPower ? 'ON' : 'OFF'}`);
  }

  /** Cambia el ambiente térmico (útil para simular condiciones). */
  setAmbientTemp(c) {
    this.ambientTempC = Math.max(-10, Math.min(60, c));
    logger.debug('VCPU', `ambient temp = ${this.ambientTempC}°C`);
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES / EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit() {
    const payload = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(payload); } catch (err) {
        logger.error('VCPU', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS / SNAPSHOTS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:         this.model,
      coreCount:     this.cores.length,
      pCores:        this.cores.filter(c => c.type === 'performance').length,
      eCores:        this.cores.filter(c => c.type === 'efficiency').length,
      thermalState:  this.thermalState,
      lowPower:      this.lowPower,
      totalPowerMw:  parseFloat(this.totalPowerMw.toFixed(1)),
      totalEnergyMj: parseFloat(this.totalEnergyMj.toFixed(2)),
      avgLoad:       parseFloat(this.metrics.avgLoad.toFixed(1)),
      avgFreqGHz:    parseFloat(this.avgFrequencyGHz().toFixed(3)),
      avgTempC:      parseFloat(this.avgTempC().toFixed(2)),
      maxTempC:      parseFloat(this.maxTempC().toFixed(2)),
      ambientTempC:  this.ambientTempC,
      cores:         this.cores.map(c => c.getSnapshot()),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      thermalState:this.thermalState,
      metrics:     { ...this.metrics },
      avgLoad:     parseFloat(this.metrics.avgLoad.toFixed(1)),
      peakPowerMw: parseFloat(this.metrics.peakPowerMw.toFixed(1)),
      peakTempC:   parseFloat(this.metrics.peakTempC.toFixed(2)),
      historyLen:  this.history.ts.length,
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VCPU [${s.running ? 'RUNNING' : 'STOPPED'}] — ${s.model}`,
      `  thermal:     ${s.thermalState}`,
      `  avg load:    ${s.avgLoad}%`,
      `  peak power:  ${s.peakPowerMw} mW`,
      `  peak temp:   ${s.peakTempC} °C`,
      `  cores:`,
    ];
    for (const c of this.cores) {
      const snap = c.getSnapshot();
      lines.push(
        `    [${snap.id}] ${snap.type.padEnd(12)} ${snap.state.padEnd(10)} ` +
        `${snap.freqGHz.toFixed(2)}GHz p=${snap.pState} ` +
        `load=${String(snap.load).padStart(5)}% ` +
        `temp=${String(snap.tempC).padStart(5)}°C ` +
        `pwr=${String(snap.powerMw).padStart(6)}mW`
      );
    }
    return lines.join('\n');
  }

  /** Devuelve el histórico (para gráficas del HardwareMonitor). */
  getHistory() {
    return {
      ts:        [...this.history.ts],
      loadTotal: [...this.history.loadTotal],
      tempAvg:   [...this.history.tempAvg],
      powerMw:   [...this.history.powerMw],
      freqAvg:   [...this.history.freqAvg],
    };
  }
}
