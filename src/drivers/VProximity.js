// src/drivers/VProximity.js
// Sensor de proximidad virtual — AMS TMD2755 (IR + visible)
// Uso típico: durante llamada, si hay objeto cerca (<N cm) → apagar pantalla
// e ignorar toques. También detecta bolsillo/funda para bloquear gestos.

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'PROX';

/* ------------------------------------------------------------------ *
 * Constantes del chip (TMD2755)
 * ------------------------------------------------------------------ */

// El TMD2755 tiene un canal IR (emisor + receptor) y un canal visible (clear)
// Rango útil de detección: ~0 … 10 cm (configurable por umbral)
const RANGE_MIN_CM = 0;
const RANGE_MAX_CM = 12;

// Tiempos de integración (µs del driver real → ms en nuestro modelo)
const INTEGRATION_TIMES_MS = [2.5, 5, 10, 20, 40, 80, 160, 320];

// Ganancia del receptor IR
const GAIN_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];

// Corriente del emisor IR (mA) — más corriente = más alcance, más consumo
const EMITTER_CURRENTS_MA = [5, 10, 20, 50, 100, 150, 200];

// Umbrales por defecto (cuentas ADC 16-bit)
const DEFAULT_NEAR_THRESHOLD = 12000;   // por encima → objeto cerca
const DEFAULT_FAR_THRESHOLD  = 8000;    // por debajo → objeto lejos (histéresis)
const ADC_MAX = 65535;

// Distancia estimada en cm a partir del ratio IR normalizado
// Modelo empírico: cerca → IR alto, lejos → IR bajo (caída ~ 1/d²)
const DIST_CURVE_EXP = 1.85;

// Persistencia: cuánto tiempo mantener el estado "near" tras la última lectura
const NEAR_HOLD_MS = 150;

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

/* ------------------------------------------------------------------ *
 * Escenarios de uso que influyen en la lectura
 * ------------------------------------------------------------------ */

const PROX_SCENARIOS = {
  // Sin nada delante → lectura baja
  CLEAR: 'clear',
  // Teléfono en la oreja durante llamada → cerca, movimiento leve
  CALL_EAR: 'call-ear',
  // Teléfono en bolsillo → cerca + oscuridad + movimiento
  POCKET: 'pocket',
  // Funda cerrada (flip cover) → cerca fijo
  FLIP_COVER: 'flip-cover',
  // Mano tapando el sensor sin intención → cerca breve
  HAND_COVER: 'hand-cover',
  // Superficie plana (mesa) → lejos pero con reflexión
  TABLE: 'table',
};

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VProximity {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Estado del chip ---
    this.powered    = false;
    this.enabled    = false;
    this.mode       = 'continuous'; // 'power-down' | 'single' | 'continuous'
    this.sampleRateHz = 20;
    this.gainIndex  = 3;            // ×8 por defecto
    this.integrationMs = 20;
    this.emitterCurrentIndex = 3;   // 50mA

    // --- Umbrales (con histéresis) ---
    this.nearThreshold = DEFAULT_NEAR_THRESHOLD;
    this.farThreshold  = DEFAULT_FAR_THRESHOLD;

    // --- Estado actual ---
    this.near = false;              // ¿hay objeto cerca?
    this.distanceCm = RANGE_MAX_CM; // distancia estimada
    this.rawIR = 0;                 // cuentas crudas canal IR
    this.rawVisible = 0;            // cuentas crudas canal visible
    this.irNormalized = 0;          // 0..1 tras calibración
    this.ambientIR = 0;             // IR ambiental (sin emisor)

    // --- Escenario simulado ---
    this.scenario = PROX_SCENARIOS.CLEAR;
    this.scenarioPhase = 0;         // fase de animación (para CALL_EAR breathing)

    // --- Calibración ---
    this.calibration = {
      offsetIR: 0,          // cuentas en ausencia de objeto
      scaleIR: 1.0,         // factor de escala
      crosstalkComp: 0.05,  // compensación de crosstalk interno
    };

    // --- Histéresis y hold ---
    this._lastNearAt = 0;           // timestamp del último "near" verdadero
    this._holdMs = NEAR_HOLD_MS;

    // --- Filtro EMA ---
    this.emaAlpha = 0.4;
    this.emaIR = 0;
    this.emaDistance = RANGE_MAX_CM;

    // --- Debounce (evita parpadeos) ---
    this.debounceMs = 80;
    this._lastTransitionAt = 0;

    // --- Consumidores vinculados ---
    // VDisplay se apaga cuando near=true y hay llamada activa
    this.linkedDisplay = null;
    this.linkedTouch = null;
    this.linkedCellular = null;     // para saber si hay llamada activa

    // --- Historial ---
    this.historyMax = 200;
    this.history = [];              // { t, ir, dist, near, scenario }

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
    };

    // --- Internos ---
    this._t = 0;
    this._sampleAccumulator = 0;
    this._callActive = false;

    // --- Registro en bus ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'prox0',
        kind: 'proximity',
        model: 'AMS TMD2755',
        capabilities: ['near-far', 'distance', 'ir', 'pocket-detect'],
        irq: 'IRQ_PROX',
      });
    }

    Logger.debug(LOG_TAG, 'VProximity instanciado (TMD2755)');
  }

  /* ---------------------------------------------------------------- *
   * Ciclo de vida
   * ---------------------------------------------------------------- */

  powerOn() {
    if (this.powered) return;
    this.powered = true;
    this.enabled = true;
    this.mode = 'continuous';
    Logger.info(LOG_TAG, 'Sensor de proximidad encendido');
    this._emit('power', { on: true });
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this.enabled = false;
    this.mode = 'power-down';
    Logger.info(LOG_TAG, 'Sensor de proximidad apagado');
    this._emit('power', { on: false });
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
    Logger.warn(LOG_TAG, 'Sensor de proximidad reseteado');
  }

  /* ---------------------------------------------------------------- *
   * Vinculaciones (para automatización del apagado de pantalla)
   * ---------------------------------------------------------------- */

  linkDisplay(display) { this.linkedDisplay = display; Logger.debug(LOG_TAG, 'Vinculado a VDisplay'); }
  linkTouch(touch)     { this.linkedTouch   = touch;   Logger.debug(LOG_TAG, 'Vinculado a VTouch'); }
  linkCellular(cell)   { this.linkedCellular = cell;   Logger.debug(LOG_TAG, 'Vinculado a VCellular'); }

  setCallActive(active) {
    this._callActive = !!active;
    Logger.debug(LOG_TAG, `Llamada activa: ${this._callActive}`);
  }

  /* ---------------------------------------------------------------- *
   * Configuración
   * ---------------------------------------------------------------- */

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
    Logger.debug(LOG_TAG, `Umbrales actualizados: near=${near}, far=${far}`);
    return true;
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
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Tick — llamado por kernel/bus a ~60Hz
   * ---------------------------------------------------------------- */

  tick(dtMs) {
    if (!this.powered) return;
    const dt = dtMs / 1000;
    this._t += dt;
    this.stats.powerOnMs += dtMs;

    if (this.mode === 'power-down') return;

    this._sampleAccumulator += dtMs;
    const periodMs = 1000 / this.sampleRateHz;
    if (this._sampleAccumulator < periodMs && this.mode !== 'single') return;
    this._sampleAccumulator = 0;

    // 1) Simular cuentas crudas según escenario
    this._simulateRawIR(dt);

    // 2) Normalizar y estimar distancia
    this._normalizeIR();
    this._estimateDistance();

    // 3) Aplicar histéresis + debounce
    this._updateNearState();

    // 4) Automatización de pantalla si corresponde
    this._applyScreenAutomation();

    // 5) Historial + suscriptores
    this._pushHistory();
    this._emit('sample', this.getReading());
    if (this.bus) this.bus.emit?.('prox:reading', this.getReading());

    // 6) Métricas
    this.stats.samples++;
    this.stats.lastSampleAt = this._t;
    if (this.near) this.stats.totalNearMs += dtMs;
    else           this.stats.totalFarMs  += dtMs;

    if (this.mode === 'single') this.mode = 'power-down';
  }

  /* ---------------------------------------------------------------- *
   * Simulación de cuentas IR crudas según escenario
   * ---------------------------------------------------------------- */

  _simulateRawIR(dt) {
    const gain = this.gain;
    const tInt = this.integrationMs;
    const emit = this.emitterCurrent;

    // Base: reflexión interna + luz ambiental (siempre hay algo)
    let baseIR = 400 + gaussianNoise(60);

    // IR ambiental (luz solar, incandescente, etc.) afecta al receptor
    const ambientIR = this._ambientIRLevel();
    this.ambientIR = ambientIR;
    baseIR += ambientIR * 0.3;

    // Reflexión del objeto según escenario
    let reflection = 0;
    this.scenarioPhase += dt;

    switch (this.scenario) {
      case PROX_SCENARIOS.CLEAR: {
        // Nada delante → reflexión residual muy baja
        reflection = 100 + gaussianNoise(30);
        break;
      }
      case PROX_SCENARIOS.CALL_EAR: {
        // Oreja pegada: muy cerca, con micro-movimientos (breathing)
        const breath = 1 + 0.03 * Math.sin(this.scenarioPhase * 2.2);
        reflection = 55000 * breath + gaussianNoise(800);
        break;
      }
      case PROX_SCENARIOS.POCKET: {
        // Tela + movimiento → señal alta pero variable
        const jitter = 1 + 0.08 * Math.sin(this.scenarioPhase * 5.0)
                         + gaussianNoise(0.04);
        reflection = 48000 * jitter + gaussianNoise(1500);
        break;
      }
      case PROX_SCENARIOS.FLIP_COVER: {
        // Funda cerrada: reflexión estable y alta
        reflection = 52000 + gaussianNoise(300);
        break;
      }
      case PROX_SCENARIOS.HAND_COVER: {
        // Mano sin contacto: distancia ~3-5cm, reflejo moderado
        reflection = 22000 + gaussianNoise(1200);
        break;
      }
      case PROX_SCENARIOS.TABLE: {
        // Mesa plana: reflexión baja pero perceptible
        reflection = 2500 + gaussianNoise(200);
        break;
      }
      default:
        reflection = 100;
    }

    // Factor de ganancia / integración / corriente del emisor
    const scaleFactor = (gain / 8) * (tInt / 20) * (emit / 50);

    // Crosstalk interno (el emisor ilumina parte del receptor)
    const crosstalk = 800 * this.calibration.crosstalkComp * scaleFactor;

    // Compensar por offset de calibración
    const total = (baseIR + reflection) * scaleFactor + crosstalk
                - this.calibration.offsetIR;

    const ir = Math.max(0, Math.round(total + gaussianNoise(Math.sqrt(Math.max(1, total)) * 0.4)));

    // Canal visible (clear) — sirve para descartar luz ambiental
    const visible = Math.max(0, Math.round(
      ambientIR * 0.5 * scaleFactor + 50 + gaussianNoise(20)
    ));

    this.rawIR = Math.min(ADC_MAX, ir);
    this.rawVisible = Math.min(ADC_MAX, visible);
    this.stats.maxIRSeen = Math.max(this.stats.maxIRSeen, this.rawIR);
  }

  _ambientIRLevel() {
    // Aproximación: si el ALS está vinculado podríamos consultarlo;
    // si no, estimamos según hora del día.
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    if (hour < 6 || hour > 21) return 20 + Math.random() * 30;   // noche
    if (hour < 8 || hour > 19) return 200 + Math.random() * 300; // crepúsculo
    return 800 + Math.random() * 1500;                            // día
  }

  /* ---------------------------------------------------------------- *
   * Normalización y estimación de distancia
   * ---------------------------------------------------------------- */

  _normalizeIR() {
    // Restamos el ambient IR (canal visible es proxy de IR ambiental)
    const corrected = Math.max(0, this.rawIR - this.rawVisible * 0.5);
    const scaled = corrected * this.calibration.scaleIR;
    this.irNormalized = clamp(scaled / ADC_MAX, 0, 1);

    // EMA
    this.emaIR = this.emaIR === 0
      ? this.irNormalized
      : lerp(this.emaIR, this.irNormalized, this.emaAlpha);
  }

  _estimateDistance() {
    // Modelo: irNorm ~ 1 / (d^exp)  →  d = (1/irNorm)^(1/exp)
    // Ajustado para que irNorm=1 → d≈0.5cm, irNorm=0.1 → d≈6cm, irNorm=0.02 → d≈12cm
    const ir = Math.max(0.001, this.emaIR);
    const d = (1 / ir) ** (1 / DIST_CURVE_EXP) * 0.55;
    this.distanceCm = clamp(d, RANGE_MIN_CM, RANGE_MAX_CM);

    this.emaDistance = this.emaDistance === RANGE_MAX_CM
      ? this.distanceCm
      : lerp(this.emaDistance, this.distanceCm, this.emaAlpha);
  }

  /* ---------------------------------------------------------------- *
   * Histéresis + debounce
   * ---------------------------------------------------------------- */

  _updateNearState() {
    const ir = this.rawIR;
    const now = this._t * 1000; // ms

    let wantNear = this.near;

    if (!this.near && ir >= this.nearThreshold) {
      wantNear = true;
    } else if (this.near && ir <= this.farThreshold) {
      wantNear = false;
    }

    // Hold: si estamos en "near", mantenerlo un poco más allá de la última lectura
    if (wantNear) this._lastNearAt = now;
    if (!wantNear && (now - this._lastNearAt) < this._holdMs) {
      wantNear = true;
    }

    // Debounce: no aceptar transición si fue demasiado reciente
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
      Logger.debug(LOG_TAG, `→ NEAR (dist≈${round(this.emaDistance, 2)}cm, ir=${this.rawIR})`);
    } else {
      this.stats.farEvents++;
      Logger.debug(LOG_TAG, `→ FAR (dist≈${round(this.emaDistance, 2)}cm, ir=${this.rawIR})`);
    }
    this._emit('transition', { from: prev, to: value, distanceCm: round(this.emaDistance, 2) });
    if (this.bus) this.bus.emit?.('prox:transition', { near: value, distanceCm: round(this.emaDistance, 2) });
  }

  /* ---------------------------------------------------------------- *
   * Automatización: apagar pantalla durante llamada, bloquear toques
   * en bolsillo, etc.
   * ---------------------------------------------------------------- */

  _applyScreenAutomation() {
    // 1) Llamada activa + objeto cerca → apagar pantalla
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

    // 2) En bolsillo → bloquear gestos de toque (palm rejection extendido)
    const inPocket = this.near && this.scenario === PROX_SCENARIOS.POCKET;
    if (this.linkedTouch) {
      this.linkedTouch._pocketBlocked = inPocket;
    }

    // 3) Funda cerrada → no encender pantalla al recibir notificación
    const flipClosed = this.near && this.scenario === PROX_SCENARIOS.FLIP_COVER;
    if (this.linkedDisplay) {
      this.linkedDisplay._coverClosed = flipClosed;
    }
  }

  /* ---------------------------------------------------------------- *
   * Historial
   * ---------------------------------------------------------------- */

  _pushHistory() {
    this.history.push({
      t: this._t,
      ir: this.rawIR,
      irNorm: round(this.emaIR, 4),
      dist: round(this.emaDistance, 2),
      near: this.near,
      scenario: this.scenario,
    });
    if (this.history.length > this.historyMax) this.history.shift();
  }

  /* ---------------------------------------------------------------- *
   * Suscriptores
   * ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- *
   * Lecturas públicas
   * ---------------------------------------------------------------- */

  getReading() {
    return {
      near: this.near,
      distanceCm: round(this.emaDistance, 2),
      ir: this.rawIR,
      irNormalized: round(this.emaIR, 4),
      visible: this.rawVisible,
      ambientIR: round(this.ambientIR, 1),
      scenario: this.scenario,
      gain: this.gain,
      integrationMs: this.integrationMs,
      emitterCurrent: this.emitterCurrent,
      callActive: this._callActive,
    };
  }

  getStats() {
    return {
      ...this.stats,
      near: this.near,
      distanceCm: round(this.emaDistance, 2),
      scenario: this.scenario,
      gain: this.gain,
      emitterCurrent: this.emitterCurrent,
      powered: this.powered,
      mode: this.mode,
    };
  }

  getHistory() { return [...this.history]; }

  /* ---------------------------------------------------------------- *
   * Calibración (offset en ausencia de objeto + escala)
   * ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- *
   * Serialización
   * ---------------------------------------------------------------- */

  serialize() {
    return {
      powered: this.powered,
      enabled: this.enabled,
      mode: this.mode,
      gainIndex: this.gainIndex,
      integrationMs: this.integrationMs,
      emitterCurrentIndex: this.emitterCurrentIndex,
      nearThreshold: this.nearThreshold,
      farThreshold: this.farThreshold,
      sampleRateHz: this.sampleRateHz,
      scenario: this.scenario,
      calibration: { ...this.calibration },
      stats: { ...this.stats },
    };
  }

  deserialize(data) {
    if (!data) return;
    this.powered = !!data.powered;
    this.enabled = !!data.enabled;
    this.mode = data.mode || 'power-down';
    this.gainIndex = clamp(data.gainIndex ?? 3, 0, GAIN_STEPS.length - 1);
    this.integrationMs = data.integrationMs ?? 20;
    this.emitterCurrentIndex = clamp(data.emitterCurrentIndex ?? 3, 0, EMITTER_CURRENTS_MA.length - 1);
    this.nearThreshold = data.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
    this.farThreshold  = data.farThreshold  ?? DEFAULT_FAR_THRESHOLD;
    this.sampleRateHz  = data.sampleRateHz  ?? 20;
    this.scenario = data.scenario || PROX_SCENARIOS.CLEAR;
    if (data.calibration) Object.assign(this.calibration, data.calibration);
    if (data.stats) Object.assign(this.stats, data.stats);
    Logger.info(LOG_TAG, 'Estado proximidad restaurado');
  }

  /* ---------------------------------------------------------------- *
   * Diagnóstico
   * ---------------------------------------------------------------- */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VProximity dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${r.near ? 'NEAR' : 'FAR'}`);
    Logger.kernel(LOG_TAG, `  distancia    : ${r.distanceCm} cm`);
    Logger.kernel(LOG_TAG, `  IR raw       : ${r.ir} (norm ${r.irNormalized})`);
    Logger.kernel(LOG_TAG, `  visible raw  : ${r.visible}`);
    Logger.kernel(LOG_TAG, `  IR ambiental : ${r.ambientIR}`);
    Logger.kernel(LOG_TAG, `  escenario    : ${r.scenario}`);
    Logger.kernel(LOG_TAG, `  ganancia     : ×${r.gain}`);
    Logger.kernel(LOG_TAG, `  emisor       : ${r.emitterCurrent} mA`);
    Logger.kernel(LOG_TAG, `  llamada      : ${r.callActive}`);
    Logger.kernel(LOG_TAG, `  near events  : ${this.stats.nearEvents}`);
    Logger.kernel(LOG_TAG, `  far events   : ${this.stats.farEvents}`);
    Logger.kernel(LOG_TAG, `  screen off   : ${this.stats.screenOffEvents}`);
    Logger.kernel(LOG_TAG, `  max IR       : ${this.stats.maxIRSeen}`);
  }
}

export default VProximity;
