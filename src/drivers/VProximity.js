// src/drivers/VProximity.js
// Sensor de proximidad virtual — AMS TMD2755 (IR + visible)
// Uso típico: durante llamada, si hay objeto cerca (<N cm) → apagar pantalla
// e ignorar toques. También detecta bolsillo/funda para bloquear gestos.
// Incluye máquina de estados, auto-rango, cola IRQ, watchdog y fusión con ALS.

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'PROX';

/* ------------------------------------------------------------------ *
 * Constantes del chip (TMD2755)
 * ------------------------------------------------------------------ */

const RANGE_MIN_CM = 0;
const RANGE_MAX_CM = 12;

const INTEGRATION_TIMES_MS = [2.5, 5, 10, 20, 40, 80, 160, 320];
const GAIN_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];
const EMITTER_CURRENTS_MA = [5, 10, 20, 50, 100, 150, 200];

const DEFAULT_NEAR_THRESHOLD = 12000;
const DEFAULT_FAR_THRESHOLD  = 8000;
const ADC_MAX = 65535;

const DIST_CURVE_EXP = 1.85;
const NEAR_HOLD_MS = 150;

// Auto-rango
const SATURATION_HIGH = 0.85;
const SATURATION_LOW  = 0.10;
const RANGE_CHANGE_COOLDOWN_MS = 400;

// Watchdog
const WATCHDOG_TIMEOUT_MS = 2000;   // sin transición durante >2s en CALL_EAR → forzar re-medición

// Cola IRQ
const IRQ_QUEUE_MAX = 32;

/* ------------------------------------------------------------------ *
 * Máquina de estados del sensor
 * ------------------------------------------------------------------ */

const PROX_STATE = {
  OFF:        'off',
  INIT:       'init',
  IDLE:       'idle',
  MEASURING:  'measuring',
  READY:      'ready',
  SLEEP:      'sleep',
  FAULT:      'fault',
};

// Transiciones válidas desde cada estado
const PROX_TRANSITIONS = {
  [PROX_STATE.OFF]:       [PROX_STATE.INIT],
  [PROX_STATE.INIT]:      [PROX_STATE.IDLE, PROX_STATE.FAULT, PROX_STATE.OFF],
  [PROX_STATE.IDLE]:      [PROX_STATE.MEASURING, PROX_STATE.SLEEP, PROX_STATE.OFF, PROX_STATE.FAULT],
  [PROX_STATE.MEASURING]: [PROX_STATE.READY, PROX_STATE.FAULT, PROX_STATE.OFF],
  [PROX_STATE.READY]:     [PROX_STATE.IDLE, PROX_STATE.MEASURING, PROX_STATE.SLEEP, PROX_STATE.OFF],
  [PROX_STATE.SLEEP]:     [PROX_STATE.IDLE, PROX_STATE.OFF, PROX_STATE.FAULT],
  [PROX_STATE.FAULT]:     [PROX_STATE.INIT, PROX_STATE.OFF],
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

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = clamp(Math.floor((p / 100) * s.length), 0, s.length - 1);
  return s[idx];
}

/* ------------------------------------------------------------------ *
 * Escenarios simulados
 * ------------------------------------------------------------------ */

const PROX_SCENARIOS = {
  CLEAR:       'clear',
  CALL_EAR:    'call-ear',
  POCKET:      'pocket',
  FLIP_COVER:  'flip-cover',
  HAND_COVER:  'hand-cover',
  TABLE:       'table',
};

/* ------------------------------------------------------------------ *
 * Perfiles de operación (auto-configuración por contexto)
 * ------------------------------------------------------------------ */

const PROX_PROFILES = {
  DEFAULT: {
    name: 'default',
    gainIndex: 3, integrationIdx: 3, emitterIdx: 3,   // ×8, 20ms, 50mA
    nearThreshold: DEFAULT_NEAR_THRESHOLD,
    farThreshold:  DEFAULT_FAR_THRESHOLD,
    sampleRateHz: 20,
    autoRange: true,
  },
  CALL: {
    name: 'call',
    gainIndex: 4, integrationIdx: 2, emitterIdx: 4,   // ×16, 10ms, 100mA
    nearThreshold: 14000,
    farThreshold:  9000,
    sampleRateHz: 30,   // más rápido para reaccionar al separar de la oreja
    autoRange: false,
  },
  POCKET: {
    name: 'pocket',
    gainIndex: 3, integrationIdx: 4, emitterIdx: 2,   // ×8, 40ms, 20mA
    nearThreshold: 11000,
    farThreshold:  7000,
    sampleRateHz: 8,    // menos muestras para ahorrar batería
    autoRange: true,
  },
  COVER: {
    name: 'cover',
    gainIndex: 2, integrationIdx: 5, emitterIdx: 1,   // ×4, 80ms, 10mA
    nearThreshold: 10000,
    farThreshold:  6000,
    sampleRateHz: 4,    // solo comprobar apertura/cierre
    autoRange: false,
  },
  MEASURE: {
    name: 'measure',
    gainIndex: 5, integrationIdx: 1, emitterIdx: 5,   // ×32, 5ms, 150mA
    nearThreshold: 16000,
    farThreshold:  10000,
    sampleRateHz: 50,
    autoRange: false,
  },
  LOW_POWER: {
    name: 'low-power',
    gainIndex: 1, integrationIdx: 6, emitterIdx: 0,   // ×2, 160ms, 5mA
    nearThreshold: 15000,
    farThreshold:  8000,
    sampleRateHz: 2,
    autoRange: false,
  },
};

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VProximity {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Estado del chip ---
    this.state      = PROX_STATE.OFF;
    this.powered    = false;
    this.enabled    = false;
    this.mode       = 'continuous';
    this.sampleRateHz = 20;
    this.gainIndex  = 3;
    this.integrationMs = 20;
    this.integrationIdx = 3;
    this.emitterCurrentIndex = 3;

    // --- Umbrales ---
    this.nearThreshold = DEFAULT_NEAR_THRESHOLD;
    this.farThreshold  = DEFAULT_FAR_THRESHOLD;

    // --- Lecturas ---
    this.near = false;
    this.distanceCm = RANGE_MAX_CM;
    this.rawIR = 0;
    this.rawVisible = 0;
    this.irNormalized = 0;
    this.ambientIR = 0;

    // --- Escenario / perfil ---
    this.scenario = PROX_SCENARIOS.CLEAR;
    this.scenarioPhase = 0;
    this.profile = PROX_PROFILES.DEFAULT;
    this.profileName = 'default';

    // --- Calibración ---
    this.calibration = {
      offsetIR: 0,
      scaleIR: 1.0,
      crosstalkComp: 0.05,
    };

    // --- Histéresis ---
    this._lastNearAt = 0;
    this._holdMs = NEAR_HOLD_MS;
    this.debounceMs = 80;
    this._lastTransitionAt = 0;

    // --- Filtro EMA ---
    this.emaAlpha = 0.4;
    this.emaIR = 0;
    this.emaDistance = RANGE_MAX_CM;

    // --- Auto-rango ---
    this.autoRange = true;
    this.saturated = false;
    this._lastRangeChangeAt = 0;

    // --- Watchdog ---
    this._watchdogEnabled = true;
    this._lastReadingAt = 0;
    this._watchdogFires = 0;

    // --- Cola IRQ ---
    this.irqQueue = [];
    this.irqDropped = 0;

    // --- Consumidores vinculados ---
    this.linkedDisplay = null;
    this.linkedTouch = null;
    this.linkedCellular = null;
    this.linkedAmbientLight = null;

    // --- Historial ---
    this.historyMax = 200;
    this.history = [];

    // --- Suscriptores ---
    this.subscribers = new Set();

    // --- Métricas ---
    this.stats = {
      samples: 0,
      nearEvents: 0,
      farEvents: 0,
      screenOffEvents: 0,
      maxIRSeen: 0,
      powerOnMs: 0,
      lastSampleAt: 0,
      totalNearMs: 0,
      totalFarMs: 0,
      rangeChanges: 0,
      saturations: 0,
      watchdogFires: 0,
      coverEvents: 0,
      uncoverEvents: 0,
      dwellEvents: 0,
      stateTransitions: 0,
    };

    // --- Estado interno ---
    this._t = 0;
    this._sampleAccumulator = 0;
    this._callActive = false;
    this._covered = false;
    this._dwellStart = 0;
    this._dwellArmed = false;
    this._dwellThresholdMs = 3000;

    // --- Registro en bus ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'prox0',
        kind: 'proximity',
        model: 'AMS TMD2755',
        capabilities: ['near-far', 'distance', 'ir', 'pocket-detect', 'cover-detect'],
        irq: 'IRQ_PROX',
      });
    }

    Logger.debug(LOG_TAG, 'VProximity instanciado (TMD2755)');
  }

  /* ================================================================ *
   * Máquina de estados
   * ================================================================ */

  _canTransition(to) {
    const allowed = PROX_TRANSITIONS[this.state] || [];
    return allowed.includes(to);
  }

  _transition(to, reason = '') {
    if (this.state === to) return true;
    if (!this._canTransition(to)) {
      Logger.warn(LOG_TAG, `Transición inválida ${this.state} → ${to} (${reason})`);
      return false;
    }
    const from = this.state;
    this.state = to;
    this.stats.stateTransitions++;
    Logger.debug(LOG_TAG, `Estado: ${from} → ${to}${reason ? ' · ' + reason : ''}`);
    this._emit('state', { from, to, reason });
    return true;
  }

  getState() { return this.state; }

  /* ================================================================ *
   * Ciclo de vida
   * ================================================================ */

  powerOn() {
    if (this.powered) return;
    this.powered = true;
    this.enabled = true;
    this.mode = 'continuous';
    this._transition(PROX_STATE.INIT, 'power-on');
    this._transition(PROX_STATE.IDLE, 'init-done');
    Logger.info(LOG_TAG, 'Sensor de proximidad encendido');
    this._emit('power', { on: true });
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this.enabled = false;
    this.mode = 'power-down';
    this._transition(PROX_STATE.OFF, 'power-off');
    Logger.info(LOG_TAG, 'Sensor de proximidad apagado');
    this._emit('power', { on: false });
  }

  sleep() {
    if (this.state === PROX_STATE.SLEEP) return;
    this._transition(PROX_STATE.SLEEP, 'explicit');
  }

  wake() {
    if (this.state !== PROX_STATE.SLEEP) return;
    this._transition(PROX_STATE.IDLE, 'wake');
  }

  reset() {
    this.rawIR = 0;
    this.rawVisible = 0;
    this.irNormalized = 0;
    this.distanceCm = RANGE_MAX_CM;
    this.near = false;
    this.emaIR = 0;
    this.emaDistance = RANGE_MAX_CM;
    this.scenario = PROX_SCENARIOS.CLEAR;
    this._sampleAccumulator = 0;
    this._covered = false;
    this._dwellArmed = false;
    this.irqQueue = [];
    this._transition(PROX_STATE.INIT, 'reset');
    this._transition(PROX_STATE.IDLE, 'reset-done');
    Logger.warn(LOG_TAG, 'Sensor de proximidad reseteado');
  }

  /* ================================================================ *
   * Vinculaciones
   * ================================================================ */

  linkDisplay(display) { this.linkedDisplay = display; Logger.debug(LOG_TAG, 'Vinculado a VDisplay'); }
  linkTouch(touch)     { this.linkedTouch   = touch;   Logger.debug(LOG_TAG, 'Vinculado a VTouch'); }
  linkCellular(cell)   { this.linkedCellular = cell;   Logger.debug(LOG_TAG, 'Vinculado a VCellular'); }
  linkAmbientLight(als){ this.linkedAmbientLight = als; Logger.debug(LOG_TAG, 'Vinculado a VAmbientLight'); }

  setCallActive(active) {
    this._callActive = !!active;
    if (active) this.applyProfile('call');
    else        this.applyProfile('default');
    Logger.debug(LOG_TAG, `Llamada activa: ${this._callActive}`);
  }

  /* ================================================================ *
   * Configuración
   * ================================================================ */

  setGain(g) {
    const idx = GAIN_STEPS.indexOf(g);
    if (idx < 0) return false;
    this.gainIndex = idx;
    return true;
  }
  get gain() { return GAIN_STEPS[this.gainIndex]; }

  setIntegrationTime(ms) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < INTEGRATION_TIMES_MS.length; i++) {
      const d = Math.abs(INTEGRATION_TIMES_MS[i] - ms);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.integrationIdx = best;
    this.integrationMs = INTEGRATION_TIMES_MS[best];
    return true;
  }

  setEmitterCurrent(ma) {
    const idx = EMITTER_CURRENTS_MA.indexOf(ma);
    if (idx < 0) return false;
    this.emitterCurrentIndex = idx;
    return true;
  }
  get emitterCurrent() { return EMITTER_CURRENTS_MA[this.emitterCurrentIndex]; }

  setThresholds(near, far) {
    if (far >= near) {
      Logger.warn(LOG_TAG, `Umbrales inválidos: far(${far}) >= near(${near})`);
      return false;
    }
    this.nearThreshold = clamp(near, 0, ADC_MAX);
    this.farThreshold  = clamp(far, 0, ADC_MAX);
    return true;
  }

  setSampleRate(hz) {
    this.sampleRateHz = clamp(hz, 1, 100);
  }

  setAutoRange(on) {
    this.autoRange = !!on;
  }

  setDwellThreshold(ms) {
    this._dwellThresholdMs = clamp(ms, 500, 30000);
  }

  /* ================================================================ *
   * Perfiles
   * ================================================================ */

  applyProfile(name) {
    const key = String(name).toUpperCase().replace(/-/g, '_');
    const p = PROX_PROFILES[key];
    if (!p) {
      Logger.warn(LOG_TAG, `Perfil desconocido: ${name}`);
      return false;
    }
    this.profile = p;
    this.profileName = p.name;
    this.gainIndex = p.gainIndex;
    this.integrationIdx = p.integrationIdx;
    this.integrationMs = INTEGRATION_TIMES_MS[p.integrationIdx];
    this.emitterCurrentIndex = p.emitterIdx;
    this.nearThreshold = p.nearThreshold;
    this.farThreshold  = p.farThreshold;
    this.sampleRateHz  = p.sampleRateHz;
    this.autoRange = p.autoRange;
    Logger.debug(LOG_TAG, `Perfil aplicado: ${p.name}`);
    this._emit('profile', { name: p.name });
    return true;
  }

  autoSelectProfile() {
    if (this._callActive)                    return this.applyProfile('call');
    if (this.scenario === PROX_SCENARIOS.POCKET)     return this.applyProfile('pocket');
    if (this.scenario === PROX_SCENARIOS.FLIP_COVER) return this.applyProfile('cover');
    return this.applyProfile('default');
  }

  setScenario(scenario) {
    if (!Object.values(PROX_SCENARIOS).includes(scenario)) {
      Logger.warn(LOG_TAG, `Escenario inválido: ${scenario}`);
      return false;
    }
    const prev = this.scenario;
    this.scenario = scenario;
    this.scenarioPhase = 0;
    Logger.debug(LOG_TAG, `Escenario: ${prev} → ${scenario}`);
    this.autoSelectProfile();
    return true;
  }

  /* ================================================================ *
   * Tick principal
   * ================================================================ */

  tick(dtMs) {
    if (!this.powered) return;
    const dt = dtMs / 1000;
    this._t += dt;
    this.stats.powerOnMs += dtMs;

    if (this.state === PROX_STATE.SLEEP || this.state === PROX_STATE.OFF) return;

    this._sampleAccumulator += dtMs;
    const periodMs = 1000 / this.sampleRateHz;
    if (this._sampleAccumulator < periodMs && this.mode !== 'single') return;
    this._sampleAccumulator = 0;

    this._transition(PROX_STATE.MEASURING, 'sample');

    this._simulateRawIR(dt);
    this._normalizeIR();
    this._estimateDistance();
    this._updateNearState();
    this._detectCoverEvents();
    this._detectDwell();
    this._applyScreenAutomation();
    this._autoRangeAdjust();
    this._runWatchdog(dtMs);
    this._pushHistory();

    this._transition(PROX_STATE.READY, 'sample-done');
    this._transition(PROX_STATE.IDLE, 'ready-done');

    this._emit('sample', this.getReading());
    if (this.bus) this.bus.emit?.('prox:reading', this.getReading());

    this.stats.samples++;
    this.stats.lastSampleAt = this._t;
    this._lastReadingAt = this._t * 1000;
    if (this.near) this.stats.totalNearMs += dtMs;
    else           this.stats.totalFarMs  += dtMs;

    if (this.mode === 'single') this.mode = 'power-down';
  }

  /* ================================================================ *
   * Simulación física
   * ================================================================ */

  _simulateRawIR(dt) {
    const gain = this.gain;
    const tInt = this.integrationMs;
    const emit = this.emitterCurrent;

    let baseIR = 400 + gaussianNoise(60);
    const ambientIR = this._ambientIRLevel();
    this.ambientIR = ambientIR;
    baseIR += ambientIR * 0.3;

    let reflection = 0;
    this.scenarioPhase += dt;

    switch (this.scenario) {
      case PROX_SCENARIOS.CLEAR:
        reflection = 100 + gaussianNoise(30);
        break;
      case PROX_SCENARIOS.CALL_EAR: {
        const breath = 1 + 0.03 * Math.sin(this.scenarioPhase * 2.2);
        reflection = 55000 * breath + gaussianNoise(800);
        break;
      }
      case PROX_SCENARIOS.POCKET: {
        const jitter = 1 + 0.08 * Math.sin(this.scenarioPhase * 5.0)
                         + gaussianNoise(0.04);
        reflection = 48000 * jitter + gaussianNoise(1500);
        break;
      }
      case PROX_SCENARIOS.FLIP_COVER:
        reflection = 52000 + gaussianNoise(300);
        break;
      case PROX_SCENARIOS.HAND_COVER:
        reflection = 22000 + gaussianNoise(1200);
        break;
      case PROX_SCENARIOS.TABLE:
        reflection = 2500 + gaussianNoise(200);
        break;
      default:
        reflection = 100;
    }

    const scaleFactor = (gain / 8) * (tInt / 20) * (emit / 50);
    const crosstalk = 800 * this.calibration.crosstalkComp * scaleFactor;
    const total = (baseIR + reflection) * scaleFactor + crosstalk
                - this.calibration.offsetIR;

    const ir = Math.max(0, Math.round(total + gaussianNoise(Math.sqrt(Math.max(1, total)) * 0.4)));
    const visible = Math.max(0, Math.round(
      ambientIR * 0.5 * scaleFactor + 50 + gaussianNoise(20)
    ));

    this.rawIR = Math.min(ADC_MAX, ir);
    this.rawVisible = Math.min(ADC_MAX, visible);
    this.stats.maxIRSeen = Math.max(this.stats.maxIRSeen, this.rawIR);

    const wasSat = this.saturated;
    this.saturated = this.rawIR >= ADC_MAX * SATURATION_HIGH;
    if (this.saturated && !wasSat) this.stats.saturations++;
  }

  _ambientIRLevel() {
    // Si tenemos ALS vinculado, derivamos ambientIR del lux real
    if (this.linkedAmbientLight) {
      const r = this.linkedAmbientLight.getReading?.();
      if (r) return clamp(r.lux * 0.4, 0, 3000);
    }
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    if (hour < 6 || hour > 21) return 20 + Math.random() * 30;
    if (hour < 8 || hour > 19) return 200 + Math.random() * 300;
    return 800 + Math.random() * 1500;
  }

  /* ================================================================ *
   * Procesado
   * ================================================================ */

  _normalizeIR() {
    const corrected = Math.max(0, this.rawIR - this.rawVisible * 0.5);
    const scaled = corrected * this.calibration.scaleIR;
    this.irNormalized = clamp(scaled / ADC_MAX, 0, 1);
    this.emaIR = this.emaIR === 0
      ? this.irNormalized
      : lerp(this.emaIR, this.irNormalized, this.emaAlpha);
  }

  _estimateDistance() {
    const ir = Math.max(0.001, this.emaIR);
    const d = (1 / ir) ** (1 / DIST_CURVE_EXP) * 0.55;
    this.distanceCm = clamp(d, RANGE_MIN_CM, RANGE_MAX_CM);
    this.emaDistance = this.emaDistance === RANGE_MAX_CM
      ? this.distanceCm
      : lerp(this.emaDistance, this.distanceCm, this.emaAlpha);
  }

  _updateNearState() {
    const ir = this.rawIR;
    const now = this._t * 1000;

    let wantNear = this.near;
    if (!this.near && ir >= this.nearThreshold) wantNear = true;
    else if (this.near && ir <= this.farThreshold) wantNear = false;

    if (wantNear) this._lastNearAt = now;
    if (!wantNear && (now - this._lastNearAt) < this._holdMs) wantNear = true;

    if (wantNear !== this.near) {
      if (now - this._lastTransitionAt < this.debounceMs) return;
      this._lastTransitionAt = now;
      this._transitionNear(wantNear);
    }
  }

  _transitionNear(value) {
    const prev = this.near;
    this.near = value;
    if (value) {
      this.stats.nearEvents++;
      this._dwellStart = this._t * 1000;
      this._dwellArmed = true;
      Logger.debug(LOG_TAG, `→ NEAR (dist≈${round(this.emaDistance, 2)}cm)`);
      this._emitDomain('prox:enter', { distanceCm: round(this.emaDistance, 2) });
    } else {
      this.stats.farEvents++;
      this._dwellArmed = false;
      Logger.debug(LOG_TAG, `→ FAR (dist≈${round(this.emaDistance, 2)}cm)`);
      this._emitDomain('prox:leave', { distanceCm: round(this.emaDistance, 2) });
    }
    this._emit('transition', { from: prev, to: value, distanceCm: round(this.emaDistance, 2) });
  }

  _detectCoverEvents() {
    // Cubrir = near + banda de luz muy baja (si ALS disponible)
    const alsReading = this.linkedAmbientLight?.getReading?.();
    const isDark = alsReading ? alsReading.lux < 20 : this.scenario === PROX_SCENARIOS.POCKET;
    const covered = this.near && isDark;

    if (covered && !this._covered) {
      this._covered = true;
      this.stats.coverEvents++;
      Logger.debug(LOG_TAG, 'Cover detectado');
      this._emitDomain('prox:cover', {});
      this._pushIRQ('IRQ_PROX', { kind: 'cover' });
    } else if (!covered && this._covered) {
      this._covered = false;
      this.stats.uncoverEvents++;
      Logger.debug(LOG_TAG, 'Uncover detectado');
      this._emitDomain('prox:uncover', {});
      this._pushIRQ('IRQ_PROX', { kind: 'uncover' });
    }
  }

  _detectDwell() {
    if (!this._dwellArmed || !this.near) return;
    const now = this._t * 1000;
    if (now - this._dwellStart >= this._dwellThresholdMs) {
      this._dwellArmed = false;
      this.stats.dwellEvents++;
      Logger.debug(LOG_TAG, `Dwell alcanzado (${this._dwellThresholdMs}ms)`);
      this._emitDomain('prox:dwell', { ms: now - this._dwellStart });
    }
  }

  /* ================================================================ *
   * Automatización
   * ================================================================ */

  _applyScreenAutomation() {
    if (this._callActive && this.near) {
      if (this.linkedDisplay && !this.linkedDisplay._proxBlanked) {
        this.linkedDisplay._proxBlanked = true;
        this.stats.screenOffEvents++;
        this.linkedDisplay.setScreenOff?.(true);
        Logger.info(LOG_TAG, 'Pantalla apagada por proximidad (llamada)');
        this._emit('screen', { off: true, reason: 'call' });
      }
    } else {
      if (this.linkedDisplay && this.linkedDisplay._proxBlanked) {
        this.linkedDisplay._proxBlanked = false;
        this.linkedDisplay.setScreenOff?.(false);
        Logger.info(LOG_TAG, 'Pantalla restaurada (proximidad liberada)');
        this._emit('screen', { off: false, reason: 'call' });
      }
    }

    const inPocket = this.near && this.scenario === PROX_SCENARIOS.POCKET;
    if (this.linkedTouch) this.linkedTouch._pocketBlocked = inPocket;

    const flipClosed = this.near && this.scenario === PROX_SCENARIOS.FLIP_COVER;
    if (this.linkedDisplay) this.linkedDisplay._coverClosed = flipClosed;
  }

  /* ================================================================ *
   * Auto-rango
   * ================================================================ */

  _autoRangeAdjust() {
    if (!this.autoRange || !this.powered) return;
    const now = this._t * 1000;
    if (now - this._lastRangeChangeAt < RANGE_CHANGE_COOLDOWN_MS) return;

    const ratio = this.rawIR / ADC_MAX;

    if (ratio > SATURATION_HIGH && this.gainIndex > 0) {
      this.gainIndex--;
      if (this.emitterCurrentIndex > 0) this.emitterCurrentIndex--;
      this._lastRangeChangeAt = now;
      this.stats.rangeChanges++;
      Logger.debug(LOG_TAG, `Auto-rango ↓ (gain ×${this.gain}, emit ${this.emitterCurrent}mA)`);
    } else if (ratio < SATURATION_LOW && this.gainIndex < GAIN_STEPS.length - 1) {
      this.gainIndex++;
      if (this.emitterCurrentIndex < EMITTER_CURRENTS_MA.length - 1) this.emitterCurrentIndex++;
      this._lastRangeChangeAt = now;
      this.stats.rangeChanges++;
      Logger.debug(LOG_TAG, `Auto-rango ↑ (gain ×${this.gain}, emit ${this.emitterCurrent}mA)`);
    }
  }

  /* ================================================================ *
   * Watchdog
   * ================================================================ */

  _runWatchdog(dtMs) {
    if (!this._watchdogEnabled || !this.powered) return;
    const now = this._t * 1000;
    // Solo importa el watchdog si esperamos transiciones (ej: llamada)
    if (!this._callActive && this.scenario === PROX_SCENARIOS.CLEAR) return;
    if (now - this._lastReadingAt > WATCHDOG_TIMEOUT_MS) {
      this._watchdogFires++;
      this.stats.watchdogFires++;
      Logger.warn(LOG_TAG, 'Watchdog: sin lecturas, forzando re-medición');
      this._transition(PROX_STATE.INIT, 'watchdog');
      this._transition(PROX_STATE.IDLE, 'watchdog-done');
      this._lastReadingAt = now;
    }
  }

  /* ================================================================ *
   * Cola IRQ (coalescing + backpressure)
   * ================================================================ */

  _pushIRQ(irq, payload) {
    if (this.irqQueue.length >= IRQ_QUEUE_MAX) {
      this.irqDropped++;
      Logger.warn(LOG_TAG, `Cola IRQ llena (${IRQ_QUEUE_MAX}), drop`);
      return false;
    }
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
    this.history.push({
      t: this._t,
      ir: this.rawIR,
      irNorm: round(this.emaIR, 4),
      dist: round(this.emaDistance, 2),
      near: this.near,
      scenario: this.scenario,
      state: this.state,
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

  _emitDomain(event, payload) {
    this._emit(event, payload);
    if (this.bus) this.bus.emit?.(event, payload);
  }

  /* ================================================================ *
   * Lecturas públicas
   * ================================================================ */

  getReading() {
    return {
      near: this.near,
      distanceCm: round(this.emaDistance, 2),
      ir: this.rawIR,
      irNormalized: round(this.emaIR, 4),
      visible: this.rawVisible,
      ambientIR: round(this.ambientIR, 1),
      scenario: this.scenario,
      profile: this.profileName,
      state: this.state,
      gain: this.gain,
      integrationMs: this.integrationMs,
      emitterCurrent: this.emitterCurrent,
      callActive: this._callActive,
      covered: this._covered,
    };
  }

  getStats() {
    return {
      ...this.stats,
      near: this.near,
      distanceCm: round(this.emaDistance, 2),
      scenario: this.scenario,
      profile: this.profileName,
      state: this.state,
      gain: this.gain,
      emitterCurrent: this.emitterCurrent,
      powered: this.powered,
      mode: this.mode,
      irqDropped: this.irqDropped,
      irqPending: this.irqQueue.length,
    };
  }

  getHistory() { return [...this.history]; }

  getDistancePercentiles() {
    const dists = this.history.map(h => h.dist);
    return {
      p10: round(percentile(dists, 10), 2),
      p50: round(percentile(dists, 50), 2),
      p90: round(percentile(dists, 90), 2),
      max: round(Math.max(0, ...dists), 2),
      min: round(Math.min(RANGE_MAX_CM, ...dists), 2),
    };
  }

  /* ================================================================ *
   * Calibración
   * ================================================================ */

  calibrateAtClear() {
    if (this.scenario !== PROX_SCENARIOS.CLEAR) {
      Logger.warn(LOG_TAG, 'Calibración requiere escenario CLEAR');
      return false;
    }
    this.calibration.offsetIR = this.rawIR;
    Logger.info(LOG_TAG, `Calibrado: offsetIR=${this.calibration.offsetIR}`);
    return true;
  }

  calibrateScale(referenceIR) {
    if (this.rawIR <= 0) return false;
    this.calibration.scaleIR = referenceIR / this.rawIR;
    Logger.info(LOG_TAG, `scaleIR=${round(this.calibration.scaleIR, 4)}`);
    return true;
  }

  resetCalibration() {
    this.calibration.offsetIR = 0;
    this.calibration.scaleIR = 1.0;
    this.calibration.crosstalkComp = 0.05;
    Logger.info(LOG_TAG, 'Calibración reseteada');
  }

  /* ================================================================ *
   * Serialización
   * ================================================================ */

  serialize() {
    return {
      state: this.state,
      powered: this.powered,
      enabled: this.enabled,
      mode: this.mode,
      gainIndex: this.gainIndex,
      integrationIdx: this.integrationIdx,
      integrationMs: this.integrationMs,
      emitterCurrentIndex: this.emitterCurrentIndex,
      nearThreshold: this.nearThreshold,
      farThreshold: this.farThreshold,
      sampleRateHz: this.sampleRateHz,
      scenario: this.scenario,
      profileName: this.profileName,
      autoRange: this.autoRange,
      calibration: { ...this.calibration },
      stats: { ...this.stats },
    };
  }

  deserialize(data) {
    if (!data) return;
    this.powered = !!data.powered;
    this.enabled = !!data.enabled;
    this.mode = data.mode || 'power-down';
    this.state = data.state || PROX_STATE.OFF;
    this.gainIndex = clamp(data.gainIndex ?? 3, 0, GAIN_STEPS.length - 1);
    this.integrationIdx = clamp(data.integrationIdx ?? 3, 0, INTEGRATION_TIMES_MS.length - 1);
    this.integrationMs = INTEGRATION_TIMES_MS[this.integrationIdx];
    this.emitterCurrentIndex = clamp(data.emitterCurrentIndex ?? 3, 0, EMITTER_CURRENTS_MA.length - 1);
    this.nearThreshold = data.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
    this.farThreshold  = data.farThreshold  ?? DEFAULT_FAR_THRESHOLD;
    this.sampleRateHz  = data.sampleRateHz  ?? 20;
    this.scenario = data.scenario || PROX_SCENARIOS.CLEAR;
    this.profileName = data.profileName || 'default';
    this.autoRange = data.autoRange ?? true;
    if (data.calibration) Object.assign(this.calibration, data.calibration);
    if (data.stats) Object.assign(this.stats, data.stats);
    Logger.info(LOG_TAG, 'Estado proximidad restaurado');
  }

  /* ================================================================ *
   * Utilidades de simulación batch
   * ================================================================ */

  tickAll(seconds, dtMs = 16.67) {
    const steps = Math.floor((seconds * 1000) / dtMs);
    for (let i = 0; i < steps; i++) this.tick(dtMs);
    return this.getStats();
  }

  simulateNear(ms = 1000) {
    const prevScenario = this.scenario;
    this.setScenario(PROX_SCENARIOS.CALL_EAR);
    this.tickAll(ms / 1000);
    this.setScenario(prevScenario);
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VProximity dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${r.state}`);
    Logger.kernel(LOG_TAG, `  near/far     : ${r.near ? 'NEAR' : 'FAR'}`);
    Logger.kernel(LOG_TAG, `  distancia    : ${r.distanceCm} cm`);
    Logger.kernel(LOG_TAG, `  IR raw       : ${r.ir} (norm ${r.irNormalized})`);
    Logger.kernel(LOG_TAG, `  visible raw  : ${r.visible}`);
    Logger.kernel(LOG_TAG, `  IR ambiental : ${r.ambientIR}`);
    Logger.kernel(LOG_TAG, `  escenario    : ${r.scenario}`);
    Logger.kernel(LOG_TAG, `  perfil       : ${r.profile}`);
    Logger.kernel(LOG_TAG, `  ganancia     : ×${r.gain}`);
    Logger.kernel(LOG_TAG, `  emisor       : ${r.emitterCurrent} mA`);
    Logger.kernel(LOG_TAG, `  cubierto     : ${r.covered}`);
    Logger.kernel(LOG_TAG, `  llamada      : ${r.callActive}`);
    Logger.kernel(LOG_TAG, `  near events  : ${this.stats.nearEvents}`);
    Logger.kernel(LOG_TAG, `  far events   : ${this.stats.farEvents}`);
    Logger.kernel(LOG_TAG, `  cover/uncover: ${this.stats.coverEvents}/${this.stats.uncoverEvents}`);
    Logger.kernel(LOG_TAG, `  dwell        : ${this.stats.dwellEvents}`);
    Logger.kernel(LOG_TAG, `  screen off   : ${this.stats.screenOffEvents}`);
    Logger.kernel(LOG_TAG, `  watchdog     : ${this.stats.watchdogFires}`);
    Logger.kernel(LOG_TAG, `  state trans. : ${this.stats.stateTransitions}`);
    Logger.kernel(LOG_TAG, `  IRQ (drop/p) : ${this.irqDropped}/${this.irqQueue.length}`);
  }
}

export { PROX_STATE, PROX_SCENARIOS, PROX_PROFILES };

export default VProximity;
