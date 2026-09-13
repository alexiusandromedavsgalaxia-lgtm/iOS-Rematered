// src/drivers/VThermal.js
// Subsistema térmico global — sensores distribuidos + gestión de throttling
// Modela disipación acoplada entre subsistemas, aplica políticas de mitigación
// y notifica a los drivers consumidores (VCPU, VGPU, VStorage, VBattery, VDisplay).

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'THERMAL';

/* ------------------------------------------------------------------ *
 * Sensores térmicos distribuidos
 * ------------------------------------------------------------------ */

export const THERMAL_SENSORS = {
  SOC:      'soc',        // SoC package (A18 Pro)
  CPU_P:    'cpu-p',      // cluster performance
  CPU_E:    'cpu-e',      // cluster efficiency
  GPU:      'gpu',
  ANE:      'ane',        // Neural Engine
  NAND:     'nand',       // almacenamiento
  DRAM:     'dram',
  PMIC:     'pmic',       // gestión de energía
  BATTERY:  'battery',
  MODEM:    'modem',      // baseband
  WIFI:     'wifi',
  DISPLAY:  'display',
  CHASSIS:  'chassis',    // carcasa (para sensación al tacto)
  AMBIENT:  'ambient',    // temperatura ambiente estimada
};

// Metadatos por sensor: temperatura base, límites y coeficiente de acoplamiento
const SENSOR_META = {
  [THERMAL_SENSORS.SOC]:      { base: 34, warn: 72, throttle: 82, crit: 95, max: 110, tau: 8.0, weight: 0.9 },
  [THERMAL_SENSORS.CPU_P]:    { base: 35, warn: 74, throttle: 85, crit: 97, max: 112, tau: 6.0, weight: 0.85 },
  [THERMAL_SENSORS.CPU_E]:    { base: 33, warn: 68, throttle: 80, crit: 92, max: 108, tau: 7.5, weight: 0.7 },
  [THERMAL_SENSORS.GPU]:      { base: 34, warn: 70, throttle: 82, crit: 95, max: 110, tau: 6.5, weight: 0.85 },
  [THERMAL_SENSORS.ANE]:      { base: 33, warn: 70, throttle: 82, crit: 95, max: 110, tau: 7.0, weight: 0.75 },
  [THERMAL_SENSORS.NAND]:     { base: 32, warn: 60, throttle: 70, crit: 80,  max: 95,  tau: 20.0, weight: 0.6 },
  [THERMAL_SENSORS.DRAM]:     { base: 33, warn: 75, throttle: 85, crit: 95,  max: 110, tau: 12.0, weight: 0.5 },
  [THERMAL_SENSORS.PMIC]:     { base: 36, warn: 80, throttle: 90, crit: 100, max: 115, tau: 9.0, weight: 0.65 },
  [THERMAL_SENSORS.BATTERY]:  { base: 30, warn: 40, throttle: 45, crit: 50,  max: 60,  tau: 60.0, weight: 0.8 },
  [THERMAL_SENSORS.MODEM]:    { base: 34, warn: 75, throttle: 85, crit: 95,  max: 110, tau: 10.0, weight: 0.55 },
  [THERMAL_SENSORS.WIFI]:     { base: 33, warn: 75, throttle: 85, crit: 95,  max: 110, tau: 10.0, weight: 0.4 },
  [THERMAL_SENSORS.DISPLAY]:  { base: 30, warn: 55, throttle: 65, crit: 75,  max: 85,  tau: 15.0, weight: 0.5 },
  [THERMAL_SENSORS.CHASSIS]:  { base: 28, warn: 42, throttle: 46, crit: 50,  max: 55,  tau: 90.0, weight: 0.4 },
  [THERMAL_SENSORS.AMBIENT]:  { base: 22, warn: 45, throttle: 50, crit: 55,  max: 60,  tau: 180.0, weight: 0.0 }, // solo lectura
};

/* ------------------------------------------------------------------ *
 * Estados térmicos del sistema (estilo iOS)
 * ------------------------------------------------------------------ */

const THERMAL_STATE = {
  NOMINAL:  'nominal',    // todo bien
  FAIR:     'fair',       // ligeramente cálido
  SERIOUS:  'serious',    // throttling moderado
  CRITICAL: 'critical',   // throttling agresivo
  SHUTDOWN: 'shutdown',   // apagado por seguridad
};

/* ------------------------------------------------------------------ *
 * Niveles de mitigación
 * ------------------------------------------------------------------ */

const MITIGATION = {
  NONE:               0,
  THROTTLE_LIGHT:     1,   // -10% rendimiento
  THROTTLE_MODERATE:  2,   // -25% rendimiento
  THROTTLE_HEAVY:     3,   // -50% rendimiento
  THROTTLE_SEVERE:    4,   // -70% rendimiento
  BRIGHTNESS_REDUCE:  5,   // bajar brillo pantalla
  CHARGE_PAUSE:       6,   // pausar carga batería
  RADIO_BACKOFF:      7,   // reducir potencia radios
  SHUTDOWN:           8,   // apagado crítico
};

// Acción asociada a cada nivel (para notificar a subsistemas)
const MITIGATION_EFFECTS = {
  [MITIGATION.THROTTLE_LIGHT]:    { cpu: 0.90, gpu: 0.90, nand: 1.00, radio: 1.00, display: 1.00, charge: true },
  [MITIGATION.THROTTLE_MODERATE]: { cpu: 0.75, gpu: 0.75, nand: 0.95, radio: 0.95, display: 1.00, charge: true },
  [MITIGATION.THROTTLE_HEAVY]:    { cpu: 0.50, gpu: 0.50, nand: 0.90, radio: 0.85, display: 0.85, charge: false },
  [MITIGATION.THROTTLE_SEVERE]:   { cpu: 0.30, gpu: 0.30, nand: 0.80, radio: 0.70, display: 0.70, charge: false },
  [MITIGATION.SHUTDOWN]:          { cpu: 0.00, gpu: 0.00, nand: 0.00, radio: 0.00, display: 0.00, charge: false },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function round(v, d = 2)  { const f = 10 ** d; return Math.round(v * f) / f; }

function gaussianNoise(sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Ecuación de enfriamiento newtoniano: T(t+dt) = T_env + (T - T_env) * exp(-dt/tau)
function coolTowards(current, target, tauS, dtS) {
  const k = Math.exp(-dtS / tauS);
  return target + (current - target) * k;
}

/* ------------------------------------------------------------------ *
 * Perfiles térmicos (ambiente + carga)
 * ------------------------------------------------------------------ */

const THERMAL_SCENARIOS = {
  IDLE:        { name: 'idle',        ambientC: 22, loadFactor: 0.05, sunExposure: false },
  LIGHT:       { name: 'light',       ambientC: 24, loadFactor: 0.20, sunExposure: false },
  MEDIUM:      { name: 'medium',      ambientC: 25, loadFactor: 0.50, sunExposure: false },
  HEAVY:       { name: 'heavy',       ambientC: 26, loadFactor: 0.80, sunExposure: false },
  GAMING:      { name: 'gaming',      ambientC: 27, loadFactor: 0.95, sunExposure: false },
  CHARGING:    { name: 'charging',    ambientC: 24, loadFactor: 0.30, sunExposure: false },
  HOT_CAR:     { name: 'hot-car',     ambientC: 55, loadFactor: 0.60, sunExposure: true  },
  DIRECT_SUN:  { name: 'direct-sun',  ambientC: 45, loadFactor: 0.40, sunExposure: true  },
  COLD:        { name: 'cold',        ambientC:  5, loadFactor: 0.30, sunExposure: false },
  EXTREME_COLD:{ name: 'extreme-cold',ambientC: -15, loadFactor: 0.30, sunExposure: false },
};

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VThermal {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Sensores: temperatura actual por sensor ---
    this.sensors = {};
    for (const id of Object.values(THERMAL_SENSORS)) {
      this.sensors[id] = {
        id,
        tempC: SENSOR_META[id].base,
        meta: SENSOR_META[id],
        powered: true,
        lastReadAt: 0,
        trend: 0,        // °C/s
        historyMax: 60,
        history: [],
      };
    }

    // --- Estado global ---
    this.state = THERMAL_STATE.NOMINAL;
    this.mitigationLevel = MITIGATION.NONE;
    this.powered = true;
    this.scenario = THERMAL_SCENARIOS.IDLE;
    this.ambientC = 22;

    // --- Sumideros de calor (heat sources) ---
    // Cada subsistema genera calor según su carga (inyectada externamente)
    this.heatSources = {
      cpu:      { load: 0, watt: 0, peakWatt: 8.0 },   // A18 Pro P-core
      gpu:      { load: 0, watt: 0, peakWatt: 6.0 },
      ane:      { load: 0, watt: 0, peakWatt: 3.0 },
      nand:     { load: 0, watt: 0, peakWatt: 1.5 },
      modem:    { load: 0, watt: 0, peakWatt: 2.5 },
      wifi:     { load: 0, watt: 0, peakWatt: 1.0 },
      display:  { load: 0, watt: 0, peakWatt: 2.0 },
      battery:  { load: 0, watt: 0, peakWatt: 3.0 },   // carga
    };

    // --- Fuentes vinculadas (drivers que reportan load) ---
    this.linkedCPU = null;
    this.linkedGPU = null;
    this.linkedStorage = null;
    this.linkedBattery = null;
    this.linkedWiFi = null;
    this.linkedBT = null;
    this.linkedCellular = null;
    this.linkedDisplay = null;

    // --- Políticas ---
    this.autoThrottleEnabled = true;
    this.chargeThrottleEnabled = true;
    this.displayDimEnabled = true;
    this.shutdownThresholdC = 105;   // SoC
    this.hysteresisC = 3;            // grados de histéresis para bajar estado

    // --- Watchdog ---
    this._watchdogEnabled = true;
    this._lastTickAt = 0;
    this._watchdogFires = 0;

    // --- Cola IRQ ---
    this.irqQueue = [];
    this.irqDropped = 0;

    // --- Historial global ---
    this.historyMax = 300;
    this.history = [];

    // --- Suscriptores ---
    this.subscribers = new Set();

    // --- Métricas ---
    this.stats = {
      ticks: 0,
      powerOnMs: 0,
      stateTransitions: 0,
      mitigationChanges: 0,
      throttleEvents: 0,
      shutdowns: 0,
      chargePauses: 0,
      dimEvents: 0,
      peakCpuTemp: 0,
      peakGpuTemp: 0,
      peakBatteryTemp: 0,
      peakSocTemp: 0,
      timeInState: {
        nominal: 0, fair: 0, serious: 0, critical: 0, shutdown: 0,
      },
      lastTickAt: 0,
    };

    // --- Internos ---
    this._t = 0;

    // --- Registro en bus ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'thermal0',
        kind: 'thermal-manager',
        model: 'Distributed thermal sensors',
        capabilities: ['temp-read', 'throttle', 'mitigation', 'shutdown'],
        irq: 'IRQ_THERMAL',
      });
    }

    Logger.debug(LOG_TAG, `VThermal instanciado (${Object.keys(this.sensors).length} sensores)`);
  }

  /* ================================================================ *
   * Vinculaciones
   * ================================================================ */

  linkCPU(cpu)         { this.linkedCPU = cpu;       Logger.debug(LOG_TAG, 'Vinculado a VCPU'); }
  linkGPU(gpu)         { this.linkedGPU = gpu;       Logger.debug(LOG_TAG, 'Vinculado a VGPU'); }
  linkStorage(st)      { this.linkedStorage = st;    Logger.debug(LOG_TAG, 'Vinculado a VStorage'); }
  linkBattery(bat)     { this.linkedBattery = bat;   Logger.debug(LOG_TAG, 'Vinculado a VBattery'); }
  linkWiFi(wifi)       { this.linkedWiFi = wifi;     Logger.debug(LOG_TAG, 'Vinculado a VWiFi'); }
  linkBT(bt)           { this.linkedBT = bt;         Logger.debug(LOG_TAG, 'Vinculado a VBT'); }
  linkCellular(cell)   { this.linkedCellular = cell; Logger.debug(LOG_TAG, 'Vinculado a VCellular'); }
  linkDisplay(disp)    { this.linkedDisplay = disp;  Logger.debug(LOG_TAG, 'Vinculado a VDisplay'); }

  /* ================================================================ *
   * Ciclo de vida
   * ================================================================ */

  powerOn() {
    this.powered = true;
    Logger.info(LOG_TAG, 'Gestión térmica activada');
  }

  powerOff() {
    this.powered = false;
    Logger.info(LOG_TAG, 'Gestión térmica desactivada');
  }

  reset() {
    for (const s of Object.values(this.sensors)) {
      s.tempC = s.meta.base;
      s.trend = 0;
      s.history = [];
    }
    this.state = THERMAL_STATE.NOMINAL;
    this.mitigationLevel = MITIGATION.NONE;
    this.irqQueue = [];
    Logger.warn(LOG_TAG, 'Estado térmico reseteado');
  }

  /* ================================================================ *
   * Configuración / escenarios
   * ================================================================ */

  setScenario(name) {
    const key = String(name).toUpperCase().replace(/-/g, '_');
    const s = THERMAL_SCENARIOS[key];
    if (!s) {
      Logger.warn(LOG_TAG, `Escenario desconocido: ${name}`);
      return false;
    }
    this.scenario = s;
    this.ambientC = s.ambientC;
    this.sensors[THERMAL_SENSORS.AMBIENT].tempC = s.ambientC;
    Logger.debug(LOG_TAG, `Escenario: ${s.name} (ambient=${s.ambientC}°C, load=${s.loadFactor})`);
    return true;
  }

  setAmbient(c) {
    this.ambientC = clamp(c, -30, 80);
    this.sensors[THERMAL_SENSORS.AMBIENT].tempC = this.ambientC;
  }

  setAutoThrottle(on)    { this.autoThrottleEnabled = !!on; }
  setChargeThrottle(on)  { this.chargeThrottleEnabled = !!on; }
  setDisplayDim(on)      { this.displayDimEnabled = !!on; }
  setShutdownThreshold(c){ this.shutdownThresholdC = clamp(c, 80, 130); }

  /* ================================================================ *
   * Lectura de temperatura
   * ================================================================ */

  getTemp(sensorId) {
    const s = this.sensors[sensorId];
    return s ? s.tempC : null;
  }

  getMaxTemp() {
    let max = -Infinity, id = null;
    for (const s of Object.values(this.sensors)) {
      if (s.id === THERMAL_SENSORS.AMBIENT) continue;
      if (s.tempC > max) { max = s.tempC; id = s.id; }
    }
    return { sensor: id, tempC: max };
  }

  getAvgTemp() {
    let sum = 0, count = 0;
    for (const s of Object.values(this.sensors)) {
      if (s.id === THERMAL_SENSORS.AMBIENT) continue;
      sum += s.tempC;
      count++;
    }
    return sum / Math.max(1, count);
  }

  /* ================================================================ *
   * Inyección de carga (llamada por el kernel u otros drivers)
   * ================================================================ */

  reportLoad(source, load) {
    if (source in this.heatSources) {
      this.heatSources[source].load = clamp(load, 0, 1);
    }
  }

  _computeHeatSources() {
    // Si tenemos drivers vinculados, usamos sus métricas reales
    if (this.linkedCPU?.getStats) {
      const s = this.linkedCPU.getStats();
      const util = s.utilization ?? s.load ?? 0;
      this.heatSources.cpu.load = clamp(util, 0, 1);
    }
    if (this.linkedGPU?.getStats) {
      const s = this.linkedGPU.getStats();
      const util = s.utilization ?? s.load ?? 0;
      this.heatSources.gpu.load = clamp(util, 0, 1);
    }
    if (this.linkedStorage?.getStats) {
      const s = this.linkedStorage.getStats();
      const util = s.utilization ?? (s.readThroughput > 0 ? 0.5 : 0.1);
      this.heatSources.nand.load = clamp(util, 0, 1);
    }
    if (this.linkedWiFi?.getStats) {
      const s = this.linkedWiFi.getStats();
      this.heatSources.wifi.load = s.state === 'associated' ? clamp(s.throughputMbps / 1000, 0, 1) : 0.05;
    }
    if (this.linkedCellular?.getStats) {
      const s = this.linkedCellular.getStats();
      this.heatSources.modem.load = s.state === 'data-connected' ? 0.5 : 0.05;
    }
    if (this.linkedDisplay?.getStats) {
      const s = this.linkedDisplay.getStats();
      this.heatSources.display.load = clamp(s.brightness / 1000, 0, 1);
    }
    if (this.linkedBattery?.getStats) {
      const s = this.linkedBattery.getStats();
      const charging = s.state === 'charging' || s.state === 'fast-charging';
      this.heatSources.battery.load = charging ? 1.0 : 0.0;
    }

    // Si no hay drivers vinculados, usamos el loadFactor del escenario
    if (!this.linkedCPU) this.heatSources.cpu.load = this.scenario.loadFactor;
    if (!this.linkedGPU) this.heatSources.gpu.load = this.scenario.loadFactor * 0.7;
    if (!this.linkedStorage) this.heatSources.nand.load = this.scenario.loadFactor * 0.3;

    // Watt disipados
    for (const k of Object.keys(this.heatSources)) {
      const h = this.heatSources[k];
      h.watt = h.peakWatt * h.load;
    }
  }

  /* ================================================================ *
   * Modelo térmico (acoplamiento entre sensores)
   * ================================================================ */

  _updateSensorTemps(dtS) {
    const ambient = this.ambientC;
    const sunBoost = this.scenario.sunExposure ? 6 : 0;

    // Matriz de acoplamiento simplificada: cada sensor recibe calor de
    // su fuente directa + algo de los vecinos.
    const coupling = {
      [THERMAL_SENSORS.SOC]:     { cpu: 0.55, gpu: 0.25, ane: 0.10, pmic: 0.10 },
      [THERMAL_SENSORS.CPU_P]:   { cpu: 1.00, soc: 0.30 },
      [THERMAL_SENSORS.CPU_E]:   { cpu: 0.60, soc: 0.30 },
      [THERMAL_SENSORS.GPU]:     { gpu: 1.00, soc: 0.30 },
      [THERMAL_SENSORS.ANE]:     { ane: 1.00, soc: 0.25 },
      [THERMAL_SENSORS.NAND]:    { nand: 1.00 },
      [THERMAL_SENSORS.DRAM]:    { soc: 0.40, gpu: 0.30 },
      [THERMAL_SENSORS.PMIC]:    { pmic: 0.70, battery: 0.30 },
      [THERMAL_SENSORS.BATTERY]: { battery: 1.00, pmic: 0.20 },
      [THERMAL_SENSORS.MODEM]:   { modem: 1.00 },
      [THERMAL_SENSORS.WIFI]:    { wifi: 1.00 },
      [THERMAL_SENSORS.DISPLAY]: { display: 1.00, soc: 0.10 },
      [THERMAL_SENSORS.CHASSIS]: { soc: 0.20, display: 0.15, battery: 0.10, nand: 0.10 },
      [THERMAL_SENSORS.AMBIENT]: {},
    };

    // Ganancia de inyección: cuántos °C aporta cada watt (por segundo en régimen)
    const WATT_TO_DELTA_C = 1.8;

    for (const s of Object.values(this.sensors)) {
      const meta = s.meta;
      if (s.id === THERMAL_SENSORS.AMBIENT) {
        // El sensor ambiente sigue al ambiente con suavizado
        s.tempC = coolTowards(s.tempC, ambient, meta.tau, dtS);
        continue;
      }

      // 1) Calor inyectado por fuentes acopladas a este sensor
      let injectedHeat = 0;
      const map = coupling[s.id] || {};
      for (const [src, weight] of Object.entries(map)) {
        const h = this.heatSources[src];
        if (h) injectedHeat += h.watt * weight * WATT_TO_DELTA_C;
      }

      // 2) Temperatura objetivo considerando aporte + ambiente + sol
      const targetEnv = ambient + sunBoost;
      const target = targetEnv + injectedHeat * meta.tau / 8;

      // 3) Enfriamiento newtoniano hacia el objetivo
      const prev = s.tempC;
      s.tempC = coolTowards(s.tempC, target, meta.tau, dtS);

      // 4) Ruido de medición
      s.tempC += gaussianNoise(0.05);

      // 5) Tendencia (°C/s)
      s.trend = (s.tempC - prev) / dtS;

      // 6) Historial por sensor
      s.history.push(s.tempC);
      if (s.history.length > s.historyMax) s.history.shift();

      s.lastReadAt = this._t;
    }
  }

  /* ================================================================ *
   * Cálculo del estado térmico global
   * ================================================================ */

  _computeState() {
    const soc = this.getTemp(THERMAL_SENSORS.SOC);
    const cpu = this.getTemp(THERMAL_SENSORS.CPU_P);
    const gpu = this.getTemp(THERMAL_SENSORS.GPU);
    const bat = this.getTemp(THERMAL_SENSORS.BATTERY);
    const nand = this.getTemp(THERMAL_SENSORS.NAND);

    // Temperatura "de decisión": máximo ponderado
    const weighted = Math.max(
      soc * 1.0,
      cpu * 0.95,
      gpu * 0.95,
      bat * 1.1,
      nand * 0.9,
    );

    const meta = SENSOR_META[THERMAL_SENSORS.SOC];

    // Umbrales del estado global
    const nominalMax  = meta.warn - 6;
    const fairMax     = meta.warn + 2;
    const seriousMax  = meta.throttle;
    const criticalMax = meta.crit;

    let newState = THERMAL_STATE.NOMINAL;
    if (weighted >= this.shutdownThresholdC) newState = THERMAL_STATE.SHUTDOWN;
    else if (weighted >= criticalMax) newState = THERMAL_STATE.CRITICAL;
    else if (weighted >= seriousMax) newState = THERMAL_STATE.SERIOUS;
    else if (weighted >= fairMax) newState = THERMAL_STATE.FAIR;
    else if (weighted >= nominalMax) newState = THERMAL_STATE.FAIR;

    // Histéresis: solo bajamos estado si hemos bajado > hysteresisC
    const order = [THERMAL_STATE.NOMINAL, THERMAL_STATE.FAIR, THERMAL_STATE.SERIOUS, THERMAL_STATE.CRITICAL, THERMAL_STATE.SHUTDOWN];
    const curIdx = order.indexOf(this.state);
    const newIdx = order.indexOf(newState);
    if (newIdx < curIdx) {
      const refTemp = {
        [THERMAL_STATE.FAIR]:     fairMax,
        [THERMAL_STATE.SERIOUS]:  seriousMax,
        [THERMAL_STATE.CRITICAL]: criticalMax,
        [THERMAL_STATE.SHUTDOWN]: this.shutdownThresholdC,
      }[this.state];
      if (weighted > refTemp - this.hysteresisC) {
        newState = this.state;   // mantener estado actual hasta enfriar
      }
    }

    if (newState !== this.state) {
      this._transitionState(newState, weighted);
    }
  }

  _transitionState(to, tempC) {
    const from = this.state;
    this.state = to;
    this.stats.stateTransitions++;
    Logger.warn(LOG_TAG, `Estado térmico: ${from} → ${to} (${round(tempC, 1)}°C)`);
    this._emit('state', { from, to, tempC: round(tempC, 1) });
    this._pushIRQ('IRQ_THERMAL', { kind: 'state', from, to, tempC: round(tempC, 1) });
    if (to === THERMAL_STATE.SHUTDOWN) {
      this._triggerShutdown(tempC);
    }
  }

  /* ================================================================ *
   * Mitigación
   * ================================================================ */

  _computeMitigation() {
    let level = MITIGATION.NONE;
    const socTemp = this.getTemp(THERMAL_SENSORS.SOC);
    const socMeta = SENSOR_META[THERMAL_SENSORS.SOC];

    if (this.state === THERMAL_STATE.NOMINAL) level = MITIGATION.NONE;
    else if (this.state === THERMAL_STATE.FAIR) {
      level = MITIGATION.THROTTLE_LIGHT;
    } else if (this.state === THERMAL_STATE.SERIOUS) {
      level = MITIGATION.THROTTLE_MODERATE;
      if (socTemp > socMeta.throttle + 3) level = MITIGATION.THROTTLE_HEAVY;
    } else if (this.state === THERMAL_STATE.CRITICAL) {
      level = MITIGATION.THROTTLE_HEAVY;
      if (socTemp > socMeta.crit - 2) level = MITIGATION.THROTTLE_SEVERE;
    } else if (this.state === THERMAL_STATE.SHUTDOWN) {
      level = MITIGATION.SHUTDOWN;
    }

    if (!this.autoThrottleEnabled && level <= MITIGATION.THROTTLE_SEVERE) {
      level = MITIGATION.NONE;
    }

    if (level !== this.mitigationLevel) {
      this.mitigationLevel = level;
      this.stats.mitigationChanges++;
      this._applyMitigation(level);
    }

    // Mitigaciones adicionales independientes del throttling
    const batTemp = this.getTemp(THERMAL_SENSORS.BATTERY);
    if (this.chargeThrottleEnabled && batTemp > SENSOR_META[THERMAL_SENSORS.BATTERY].throttle) {
      this._pauseCharging();
    } else {
      this._resumeCharging();
    }

    if (this.displayDimEnabled && this.state === THERMAL_STATE.SERIOUS) {
      this._dimDisplay(0.85);
    } else if (this.displayDimEnabled && this.state === THERMAL_STATE.CRITICAL) {
      this._dimDisplay(0.6);
    } else {
      this._dimDisplay(1.0);
    }
  }

  _applyMitigation(level) {
    const effects = MITIGATION_EFFECTS[level] || MITIGATION_EFFECTS[MITIGATION.NONE] ||
      { cpu: 1.0, gpu: 1.0, nand: 1.0, radio: 1.0, display: 1.0, charge: true };

    Logger.warn(LOG_TAG, `Aplicando mitigación nivel ${level} → cpu ${effects.cpu*100}%, gpu ${effects.gpu*100}%`);

    // Notificar a los drivers vinculados
    if (this.linkedCPU?.setThrottle)      this.linkedCPU.setThrottle(effects.cpu);
    if (this.linkedGPU?.setThrottle)      this.linkedGPU.setThrottle(effects.gpu);
    if (this.linkedStorage?.setThrottle)  this.linkedStorage.setThrottle(effects.nand);
    if (this.linkedWiFi?.setThrottle)     this.linkedWiFi.setThrottle(effects.radio);
    if (this.linkedCellular?.setThrottle) this.linkedCellular.setThrottle(effects.radio);

    if (level >= MITIGATION.THROTTLE_LIGHT) this.stats.throttleEvents++;

    this._emit('mitigation', { level, effects });
    if (this.bus) this.bus.emit?.('thermal:mitigation', { level, effects });
  }

  _pauseCharging() {
    if (this._chargePaused) return;
    this._chargePaused = true;
    this.stats.chargePauses++;
    Logger.warn(LOG_TAG, 'Carga pausada por temperatura de batería');
    if (this.linkedBattery?.setCharging) this.linkedBattery.setCharging(false);
    this._emit('charge', { paused: true });
  }

  _resumeCharging() {
    if (!this._chargePaused) return;
    this._chargePaused = false;
    Logger.info(LOG_TAG, 'Carga reanudada');
    if (this.linkedBattery?.setCharging) this.linkedBattery.setCharging(true);
    this._emit('charge', { paused: false });
  }

  _dimDisplay(factor) {
    if (this._dimFactor === factor) return;
    this._dimFactor = factor;
    if (factor < 1) this.stats.dimEvents++;
    if (this.linkedDisplay?.setThermalDim) this.linkedDisplay.setThermalDim(factor);
    this._emit('display-dim', { factor });
  }

  _triggerShutdown(tempC) {
    this.stats.shutdowns++;
    Logger.fatal?.(LOG_TAG, `SHUTDOWN TÉRMICO a ${round(tempC, 1)}°C`);
    this._emit('shutdown', { tempC: round(tempC, 1) });
    if (this.bus) this.bus.emit?.('thermal:shutdown', { tempC: round(tempC, 1) });
    this._pushIRQ('IRQ_THERMAL', { kind: 'shutdown', tempC: round(tempC, 1) });
  }

  /* ================================================================ *
   * Tick principal
   * ================================================================ */

  tick(dtMs) {
    if (!this.powered) return;
    const dtS = dtMs / 1000;
    this._t += dtS;
    this.stats.powerOnMs += dtMs;

    // 1) Calcular fuentes de calor
    this._computeHeatSources();

    // 2) Actualizar temperaturas
    this._updateSensorTemps(dtS);

    // 3) Evaluar estado
    this._computeState();

    // 4) Aplicar mitigación
    this._computeMitigation();

    // 5) Historial global
    this._pushHistory();

    // 6) Watchdog
    this._lastTickAt = this._t * 1000;
    this._runWatchdog(dtMs);

    // 7) Métricas
    this.stats.ticks++;
    this.stats.lastTickAt = this._t;
    this.stats.timeInState[this.state] += dtMs;
    const soc = this.getTemp(THERMAL_SENSORS.SOC);
    const gpu = this.getTemp(THERMAL_SENSORS.GPU);
    const bat = this.getTemp(THERMAL_SENSORS.BATTERY);
    if (soc > this.stats.peakSocTemp)     this.stats.peakSocTemp = soc;
    if (gpu > this.stats.peakGpuTemp)     this.stats.peakGpuTemp = gpu;
    if (bat > this.stats.peakBatteryTemp) this.stats.peakBatteryTemp = bat;

    // 8) Emitir muestra
    this._emit('tick', this.getReading());
    if (this.bus) this.bus.emit?.('thermal:reading', this.getReading());
  }

  /* ================================================================ *
   * Watchdog
   * ================================================================ */

  _runWatchdog(dtMs) {
    if (!this._watchdogEnabled || !this.powered) return;
    const now = this._t * 1000;
    if (this._lastTickAt && (now - this._lastTickAt) > 3000) {
      this._watchdogFires++;
      Logger.warn(LOG_TAG, 'Watchdog: sin ticks térmicos, forzando re-medición');
      this._lastTickAt = now;
    }
  }

  /* ================================================================ *
   * Cola IRQ
   * ================================================================ */

  _pushIRQ(irq, payload) {
    if (this.irqQueue.length >= 32) { this.irqDropped++; return false; }
    this.irqQueue.push({ irq, payload, t: this._t });
    return true;
  }

  drainIRQ() {
    const q = this.irqQueue;
    this.irqQueue = [];
    return q;
  }

  /* ================================================================ *
   * Historial + suscriptores
   * ================================================================ */

  _pushHistory() {
    const max = this.getMaxTemp();
    this.history.push({
      t: this._t,
      state: this.state,
      maxSensor: max.sensor,
      maxTemp: round(max.tempC, 1),
      ambient: round(this.ambientC, 1),
      mitigation: this.mitigationLevel,
    });
    if (this.history.length > this.historyMax) this.history.shift();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.subscribers) {
      try { fn({ type, payload, ts: this._t }); }
      catch (e) { Logger.error(LOG_TAG, `Subscriber error: ${e.message}`); }
    }
  }

  /* ================================================================ *
   * Lecturas públicas
   * ================================================================ */

  getTemps() {
    const out = {};
    for (const s of Object.values(this.sensors)) {
      out[s.id] = {
        tempC: round(s.tempC, 1),
        trend: round(s.trend, 3),
        meta: {
          base: s.meta.base,
          warn: s.meta.warn,
          throttle: s.meta.throttle,
          crit: s.meta.crit,
          max: s.meta.max,
        },
      };
    }
    return out;
  }

  getReading() {
    const max = this.getMaxTemp();
    return {
      state: this.state,
      mitigation: this.mitigationLevel,
      ambientC: round(this.ambientC, 1),
      maxSensor: max.sensor,
      maxTemp: round(max.tempC, 1),
      avgTemp: round(this.getAvgTemp(), 1),
      scenario: this.scenario.name,
      sensorCount: Object.keys(this.sensors).length,
      chargePaused: !!this._chargePaused,
      dimFactor: this._dimFactor ?? 1.0,
    };
  }

  getStats() {
    return {
      ...this.stats,
      state: this.state,
      mitigation: this.mitigationLevel,
      maxSensor: this.getMaxTemp().sensor,
      maxTemp: round(this.getMaxTemp().tempC, 1),
      irqPending: this.irqQueue.length,
      irqDropped: this.irqDropped,
      watchdogFires: this._watchdogFires,
    };
  }

  getHistory() { return [...this.history]; }

  getSensorHistory(id) {
    const s = this.sensors[id];
    return s ? [...s.history] : [];
  }

  /* ================================================================ *
   * Serialización
   * ================================================================ */

  serialize() {
    return {
      state: this.state,
      mitigation: this.mitigationLevel,
      ambientC: this.ambientC,
      scenarioName: this.scenario.name,
      autoThrottleEnabled: this.autoThrottleEnabled,
      chargeThrottleEnabled: this.chargeThrottleEnabled,
      displayDimEnabled: this.displayDimEnabled,
      shutdownThresholdC: this.shutdownThresholdC,
      sensors: Object.fromEntries(
        Object.values(this.sensors).map(s => [s.id, { tempC: s.tempC }])
      ),
      stats: { ...this.stats },
    };
  }

  deserialize(data) {
    if (!data) return;
    this.state = data.state || THERMAL_STATE.NOMINAL;
    this.mitigationLevel = data.mitigation ?? MITIGATION.NONE;
    this.ambientC = data.ambientC ?? 22;
    if (data.scenarioName) this.setScenario(data.scenarioName);
    this.autoThrottleEnabled = data.autoThrottleEnabled ?? true;
    this.chargeThrottleEnabled = data.chargeThrottleEnabled ?? true;
    this.displayDimEnabled = data.displayDimEnabled ?? true;
    this.shutdownThresholdC = data.shutdownThresholdC ?? 105;
    if (data.sensors) {
      for (const [id, s] of Object.entries(data.sensors)) {
        if (this.sensors[id]) this.sensors[id].tempC = s.tempC;
      }
    }
    if (data.stats) Object.assign(this.stats, data.stats);
    Logger.info(LOG_TAG, 'Estado térmico restaurado');
  }

  /* ================================================================ *
   * Utilidades de simulación
   * ================================================================ */

  tickAll(seconds, dtMs = 100) {
    const steps = Math.floor((seconds * 1000) / dtMs);
    for (let i = 0; i < steps; i++) this.tick(dtMs);
    return this.getStats();
  }

  soak(scenarioName, seconds) {
    this.setScenario(scenarioName);
    return this.tickAll(seconds);
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VThermal dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${r.state}`);
    Logger.kernel(LOG_TAG, `  mitigación   : ${r.mitigation}`);
    Logger.kernel(LOG_TAG, `  escenario    : ${r.scenario}`);
    Logger.kernel(LOG_TAG, `  ambiente     : ${r.ambientC}°C`);
    Logger.kernel(LOG_TAG, `  máx sensor   : ${r.maxSensor} @ ${r.maxTemp}°C`);
    Logger.kernel(LOG_TAG, `  media        : ${r.avgTemp}°C`);
    Logger.kernel(LOG_TAG, `  carga pausa  : ${r.chargePaused}`);
    Logger.kernel(LOG_TAG, `  dim display  : ${r.dimFactor}`);
    Logger.kernel(LOG_TAG, `  transiciones : ${this.stats.stateTransitions}`);
    Logger.kernel(LOG_TAG, `  throttles    : ${this.stats.throttleEvents}`);
    Logger.kernel(LOG_TAG, `  shutdowns    : ${this.stats.shutdowns}`);
    Logger.kernel(LOG_TAG, `  picos SoC/GPU/Bat: ${round(this.stats.peakSocTemp,1)}/${round(this.stats.peakGpuTemp,1)}/${round(this.stats.peakBatteryTemp,1)}`);
    Logger.kernel(LOG_TAG, `  tiempo estados:`);
    for (const [k, v] of Object.entries(this.stats.timeInState)) {
      Logger.kernel(LOG_TAG, `    · ${k.padEnd(9)} ${round(v/1000, 1)}s`);
    }
    Logger.kernel(LOG_TAG, `  sensores:`);
    for (const s of Object.values(this.sensors)) {
      const meta = s.meta;
      const bar = this._tempBar(s.tempC, meta);
      Logger.kernel(LOG_TAG, `    · ${s.id.padEnd(9)} ${round(s.tempC,1).toString().padStart(5)}°C ${bar}`);
    }
  }

  _tempBar(temp, meta) {
    const width = 20;
    const pct = clamp((temp - meta.base) / (meta.max - meta.base), 0, 1);
    const filled = Math.round(pct * width);
    const marker = temp >= meta.crit ? '!' : temp >= meta.throttle ? '*' : temp >= meta.warn ? '~' : ' ';
    return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + ']' + marker;
  }
}

export { THERMAL_STATE, THERMAL_SENSORS, MITIGATION, THERMAL_SCENARIOS };

export default VThermal;
