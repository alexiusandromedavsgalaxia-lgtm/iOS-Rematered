// src/drivers/VAmbientLight.js
// Sensor de luz ambiental virtual — AMS TSL2540
// Canales: Clear, Red, Green, Blue, IR (5 canales simultáneos)
// Rango: 1 lux (noche) → 100.000 lux (sol directo)
// Integración con VDisplay para True Tone y auto-brillo
// Integración con VThermal (placeholder) para throttling del sensor

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'ALS';

/* ------------------------------------------------------------------ *
 * Constantes físicas y de datasheet (TSL2540)
 * ------------------------------------------------------------------ */

// Ganancia analógica programable (×0.5 … ×128)
const GAIN_STEPS = [0.5, 1, 2, 4, 8, 16, 32, 64, 128];

// Tiempos de integración en ms (datasheet: 2.78ms … 711ms)
const INTEGRATION_TIMES_MS = [2.78, 5.56, 11.12, 22.24, 44.48, 88.96, 177.92, 355.84, 711.68];

// ATIME register → tiempo de integración (2.78ms * (256 - ATIME))
const ATIME_MIN = 0;
const ATIME_MAX = 255;
const ATIME_BASE_MS = 2.78;

// Saturación del ADC de 16 bits (el TSL2540 entrega hasta 65535)
const ADC_MAX = 65535;

// Coeficientes de calibración típicos del TSL2540 para lux
// Lux = (C + R + G + B) * coef_clear + corrección IR
const LUX_COEF_CLEAR = 0.132;   // aprox datasheet, ajustable por calibración
const LUX_COEF_IR    = 0.045;   // sustracción de IR (luz no visible)
const LUX_COEF_RGB   = 0.087;   // aporte ponderado de canales RGB

// Umbrales de clasificación lumínica (lux)
const LUX_BANDS = [
  { name: 'dark',       min: 0,      max: 5       },  // noche cerrada / sin luz
  { name: 'dim',        min: 5,      max: 50      },  // interior muy tenue
  { name: 'indoor',     min: 50,     max: 500     },  // interior típico
  { name: 'bright',     min: 500,    max: 2000    },  // interior muy iluminado / nublado
  { name: 'daylight',   min: 2000,   max: 10000   },  // exterior nublado
  { name: 'sunlight',   min: 10000,  max: 50000   },  // exterior soleado
  { name: 'harsh',      min: 50000,  max: 100000  },  // sol directo / reflejos
];

// Flicker detection (Hz) — fuentes típicas artificiales
const FLICKER_FREQS = [0, 50, 60, 100, 120]; // 0 = sin flicker detectable

// Temperatura de color correlacionada — rango útil
const CCT_MIN = 1000;
const CCT_MAX = 20000;

// Constantes McCamy para CCT a partir de xy
const MCCAMY_N = [0.3320, 0.1858];
const MCCAMY_COEF = [449, 3525, 6823.3, 5520.33]; // n³, n², n, const

// Auto-rango: si clear se acerca a saturación, bajamos ganancia/integración
const SATURATION_HIGH = 0.85; // 85% de ADC_MAX → bajar ganancia
const SATURATION_LOW  = 0.10; // 10% de ADC_MAX → subir ganancia

/* ------------------------------------------------------------------ *
 * Helpers matemáticos
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function round(v, d = 2)  { const f = 10 ** d; return Math.round(v * f) / f; }

// Ruido gaussiano simple (Box-Muller) para simular jitter del sensor
function gaussianNoise(sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ *
 * Curva día/noche (light schedule) para simular iluminación ambiente
 * realista cuando no hay override manual
 * ------------------------------------------------------------------ */

// Devuelve lux esperado para una hora del día (0-24)
function daylightLuxForHour(hour) {
  // Amanecer ~7h, atardecer ~20h, pico al mediodía
  if (hour < 5 || hour > 22) return 1 + Math.random() * 2;      // noche
  if (hour < 7) return lerp(2, 200, (hour - 5) / 2);             // amanecer
  if (hour < 12) return lerp(200, 8000, (hour - 7) / 5);         // mañana
  if (hour < 15) return lerp(8000, 30000, (hour - 12) / 3);      // mediodía
  if (hour < 20) return lerp(30000, 3000, (hour - 15) / 5);      // tarde
  if (hour < 22) return lerp(3000, 20, (hour - 20) / 2);         // atardecer
  return 5 + Math.random() * 5;                                  // crepúsculo
}

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VAmbientLight {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Estado del chip ---
    this.powered      = false;
    this.enabled      = false;
    this.gainIndex    = 3;            // ×4 por defecto
    this.integrationMs = 88.96;       // integración media
    this.atime        = 255 - Math.round(this.integrationMs / ATIME_BASE_MS) + 1;
    this.mode         = 'continuous'; // 'power-down' | 'single' | 'continuous'
    this.sampleRateHz = 10;           // muestras por segundo en continuo

    // --- Calibración ---
    this.calibration = {
      offsetClear: 0,
      offsetIR: 0,
      gainTrim: 1.0,
      luxScale: 1.0,
      irScale: 1.0,
      // Coeficientes de la matriz de mezcla RGB (adaptados al panel del iPhone)
      mixMatrix: [
        [1.00, 0.00, 0.00, 0.00],
        [0.00, 1.00, 0.00, 0.00],
        [0.00, 0.00, 1.00, 0.00],
        [0.00, 0.00, 0.00, 1.00],
      ],
    };

    // --- Últimas lecturas crudas (ADC 16-bit por canal) ---
    this.raw = {
      clear: 0,
      red: 0,
      green: 0,
      blue: 0,
      ir: 0,
    };

    // --- Últimas lecturas procesadas ---
    this.lux        = 0;      // lux calibrados
    this.luxRaw     = 0;      // lux sin calibrar
    this.irRatio    = 0;      // ir/clear (0..1) — cuánta luz no visible hay
    this.cct        = 6500;   // temperatura de color correlacionada (K)
    this.chromaticity = { x: 0.3127, y: 0.3290 }; // blanco D65 por defecto
    this.band       = 'indoor';
    this.flickerHz  = 0;
    this.flickerConfidence = 0;

    // --- Estado de auto-rango ---
    this.autoRange   = true;
    this.saturated   = false;
    this.lastRangeChangeAt = 0;

    // --- Filtro exponencial (EMA) para estabilizar lecturas ---
    this.emaLuxAlpha = 0.35;
    this.emaLux      = 0;
    this.emaCctAlpha = 0.25;
    this.emaCct      = 6500;

    // --- Overrides manuales (para demos / tests) ---
    this.overrideLux = null;      // si no null, fuerza lux objetivo
    this.overrideCct = null;      // si no null, fuerza CCT objetivo

    // --- Historial ---
    this.historyMax = 120;
    this.history    = [];         // { t, lux, cct, ir, flicker }

    // --- Suscriptores reactivos ---
    this.subscribers = new Set();

    // --- Métricas de uso ---
    this.stats = {
      samples: 0,
      rangeChanges: 0,
      saturations: 0,
      flickerDetections: 0,
      powerOnMs: 0,
      lastSampleAt: 0,
      totalLuxIntegral: 0,   // para lux·s acumulados
      trueToneUpdates: 0,
    };

    // --- Estado interno de simulación ---
    this._t = 0;
    this._sampleAccumulator = 0;
    this._flickerPhase = Math.random() * Math.PI * 2;
    this._driftBias = 0;

    // --- Suscripción al bus si se pasa ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'als0',
        kind: 'ambient-light',
        model: 'AMS TSL2540',
        capabilities: ['lux', 'rgb', 'ir', 'flicker', 'cct'],
        irq: 'IRQ_ALS',
      });
    }

    Logger.debug(LOG_TAG, 'VAmbientLight instanciado (TSL2540)');
  }

  /* ---------------------------------------------------------------- *
   * Ciclo de vida
   * ---------------------------------------------------------------- */

  powerOn() {
    if (this.powered) return;
    this.powered = true;
    this.enabled = true;
    this.mode = 'continuous';
    Logger.info(LOG_TAG, 'Sensor ALS encendido (modo continuo)');
    this._emit('power', { on: true });
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this.enabled = false;
    this.mode = 'power-down';
    Logger.info(LOG_TAG, 'Sensor ALS apagado');
    this._emit('power', { on: false });
  }

  reset() {
    this.raw = { clear: 0, red: 0, green: 0, blue: 0, ir: 0 };
    this.lux = 0;
    this.luxRaw = 0;
    this.irRatio = 0;
    this.cct = 6500;
    this.band = 'dark';
    this.flickerHz = 0;
    this.flickerConfidence = 0;
    this.emaLux = 0;
    this.emaCct = 6500;
    this.saturated = false;
    this.gainIndex = 3;
    this.integrationMs = 88.96;
    this._sampleAccumulator = 0;
    Logger.warn(LOG_TAG, 'Sensor ALS reseteado a valores por defecto');
  }

  /* ---------------------------------------------------------------- *
   * Configuración
   * ---------------------------------------------------------------- */

  setGain(gain) {
    const idx = GAIN_STEPS.indexOf(gain);
    if (idx < 0) {
      Logger.warn(LOG_TAG, `Ganancia inválida: ${gain}`);
      return false;
    }
    this.gainIndex = idx;
    Logger.debug(LOG_TAG, `Ganancia fijada a ×${gain}`);
    return true;
  }

  get gain() { return GAIN_STEPS[this.gainIndex]; }

  setIntegrationTime(ms) {
    const idx = INTEGRATION_TIMES_MS.indexOf(ms);
    if (idx < 0) {
      // elegir la más cercana
      let best = 0, bestD = Infinity;
      for (let i = 0; i < INTEGRATION_TIMES_MS.length; i++) {
        const d = Math.abs(INTEGRATION_TIMES_MS[i] - ms);
        if (d < bestD) { bestD = d; best = i; }
      }
      this.integrationMs = INTEGRATION_TIMES_MS[best];
    } else {
      this.integrationMs = INTEGRATION_TIMES_MS[idx];
    }
    this.atime = clamp(256 - Math.round(this.integrationMs / ATIME_BASE_MS), ATIME_MIN, ATIME_MAX);
    Logger.debug(LOG_TAG, `Integración fijada a ${this.integrationMs}ms (ATIME=${this.atime})`);
    return true;
  }

  setSampleRate(hz) {
    this.sampleRateHz = clamp(hz, 1, 100);
    Logger.debug(LOG_TAG, `Sample rate: ${this.sampleRateHz}Hz`);
  }

  setAutoRange(on) {
    this.autoRange = !!on;
    Logger.debug(LOG_TAG, `Auto-rango ${this.autoRange ? 'activado' : 'desactivado'}`);
  }

  /* ---------------------------------------------------------------- *
   * Tick — llamado por el kernel/bus a ~60Hz (o al ritmo del scheduler)
   * ---------------------------------------------------------------- */

  tick(dtMs) {
    if (!this.powered) return;
    const dt = dtMs / 1000;
    this._t += dt;
    this.stats.powerOnMs += dtMs;

    if (this.mode === 'power-down') return;

    // Acumular tiempo para muestrear al sampleRateHz
    this._sampleAccumulator += dtMs;
    const periodMs = 1000 / this.sampleRateHz;
    if (this._sampleAccumulator < periodMs && this.mode !== 'single') {
      // aún no toca muestra; pero igualmente actualizamos fase de flicker
      this._flickerPhase += 2 * Math.PI * (this.flickerHz || 60) * dt;
      return;
    }
    this._sampleAccumulator = 0;

    this._simulatePhysicalLight(dt);
    this._readADC();
    this._processLux();
    this._processColor();
    this._detectFlicker(dt);
    this._autoRangeAdjust();

    // Push al historial
    this._pushHistory();

    // Notificar a suscriptores (throttled: no más de 20Hz de emisión)
    this._emit('sample', this.getReading());

    // True Tone → VDisplay (si está en el bus)
    if (this.bus) {
      this.bus.emit?.('als:reading', this.getReading());
    }

    this.stats.samples++;
    this.stats.lastSampleAt = this._t;
    this.stats.totalLuxIntegral += this.lux * dt;

    if (this.mode === 'single') {
      this.mode = 'power-down';
    }
  }

  /* ---------------------------------------------------------------- *
   * Simulación física de la luz incidente
   * ---------------------------------------------------------------- */

  _simulatePhysicalLight(dt) {
    let targetLux;

    if (this.overrideLux != null) {
      targetLux = this.overrideLux;
    } else {
      const hour = (new Date().getHours() + new Date().getMinutes() / 60);
      targetLux = daylightLuxForHour(hour);
    }

    // Deriva lenta (drift térmico del chip)
    this._driftBias += gaussianNoise(0.02) * dt;
    this._driftBias = clamp(this._driftBias, -2, 2);

    // Guardamos el objetivo para uso en _readADC
    this._targetLux = Math.max(0, targetLux * (1 + this._driftBias * 0.01));
  }

  /* ---------------------------------------------------------------- *
   * Conversión lux objetivo → cuentas ADC por canal
   * Modelo simplificado: clear ∝ lux, IR ∝ lux (fracción), RGB
   * dependen del CCT objetivo.
   * ---------------------------------------------------------------- */

  _readADC() {
    const lux = this._targetLux;
    const gain = this.gain;
    const tInt = this.integrationMs;

    // Factor de conversión: cuentas = lux * K * gain * tInt (con K empírico)
    // Ajustamos K para que con gain=×4 e int=88.96ms, ~500 lux → ~50% ADC
    const K = 0.9;

    // CCT objetivo: si hay override lo usamos, si no estimamos según hora
    const cctTarget = this.overrideCct != null
      ? this.overrideCct
      : this._estimateNaturalCCT();

    // Distribución espectral aproximada según CCT
    const spectrum = this._spectrumForCCT(cctTarget);

    const clear = lux * K * gain * (tInt / 88.96) * spectrum.clear;
    const red   = lux * K * gain * (tInt / 88.96) * spectrum.red;
    const green = lux * K * gain * (tInt / 88.96) * spectrum.green;
    const blue  = lux * K * gain * (tInt / 88.96) * spectrum.blue;
    const ir    = lux * K * gain * (tInt / 88.96) * spectrum.ir;

    // Añadir ruido de disparo (shot noise) proporcional a √cuentas
    const noisy = (v) => Math.max(0, Math.round(v + gaussianNoise(Math.sqrt(Math.max(1, v)) * 0.5)));

    this.raw.clear = noisy(clear);
    this.raw.red   = noisy(red);
    this.raw.green = noisy(green);
    this.raw.blue  = noisy(blue);
    this.raw.ir    = noisy(ir);

    // Detectar saturación
    const maxCount = Math.max(
      this.raw.clear, this.raw.red, this.raw.green, this.raw.blue, this.raw.ir
    );
    const wasSat = this.saturated;
    this.saturated = maxCount >= ADC_MAX * SATURATION_HIGH;
    if (this.saturated && !wasSat) {
      this.stats.saturations++;
      Logger.debug(LOG_TAG, `ADC saturado (clear=${this.raw.clear})`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Distribución espectral aproximada según CCT (normalizada a clear=1)
   * Basada en tablas empíricas simplificadas.
   * ---------------------------------------------------------------- */
  _spectrumForCCT(cct) {
    // Normalizamos cct a un rango 0..1 (2000K → 0, 10000K → 1)
    const t = clamp((cct - 2000) / 8000, 0, 1);

    // A medida que sube el CCT (luz más azulada):
    //  - rojo baja, azul sube, verde se mantiene, IR baja ligeramente
    const red   = lerp(0.55, 0.32, t);
    const green = lerp(0.42, 0.45, t);
    const blue  = lerp(0.28, 0.52, t);
    const ir    = lerp(0.35, 0.18, t);

    // Clear ≈ suma ponderada con factor de respuesta del sensor
    const clear = 0.55 * red + 0.75 * green + 0.40 * blue + 0.60 * ir;

    return { clear, red, green, blue, ir };
  }

  _estimateNaturalCCT() {
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    // Amanecer/atardecer cálidos (~2700K), mediodía frío (~6500K), noche (~2700K)
    if (hour < 6 || hour > 21) return 2700;
    if (hour < 8)  return lerp(2700, 5500, (hour - 6) / 2);
    if (hour < 12) return lerp(5500, 6500, (hour - 8) / 4);
    if (hour < 15) return lerp(6500, 6800, (hour - 12) / 3);
    if (hour < 18) return lerp(6800, 5500, (hour - 15) / 3);
    return lerp(5500, 3000, (hour - 18) / 3);
  }

  /* ---------------------------------------------------------------- *
   * Cálculo de lux a partir de las cuentas crudas
   * ---------------------------------------------------------------- */

  _processLux() {
    const c = this.raw.clear - this.calibration.offsetClear;
    const ir = this.raw.ir - this.calibration.offsetIR;

    // Lux crudo (sin compensación IR)
    const luxRaw = (c * LUX_COEF_CLEAR + this.raw.red * LUX_COEF_RGB * 0.3
                  + this.raw.green * LUX_COEF_RGB * 0.4
                  + this.raw.blue * LUX_COEF_RGB * 0.3);

    // Compensación IR (la luz IR no es visible → restar)
    const lux = Math.max(0, luxRaw - ir * LUX_COEF_IR) * this.calibration.luxScale;

    this.luxRaw = luxRaw;
    this.lux = lux;

    // Ratio IR / Clear (indicador de fuente de luz)
    this.irRatio = c > 0 ? clamp(ir / c, 0, 1) : 0;

    // EMA para estabilizar
    this.emaLux = this.emaLux === 0
      ? lux
      : lerp(this.emaLux, lux, this.emaLuxAlpha);

    // Clasificar banda
    this.band = this._classifyLuxBand(this.emaLux);
  }

  _classifyLuxBand(lux) {
    for (const b of LUX_BANDS) {
      if (lux >= b.min && lux < b.max) return b.name;
    }
    return 'harsh';
  }

  /* ---------------------------------------------------------------- *
   * Cálculo de CCT a partir de canales RGB (algoritmo McCamy)
   * ---------------------------------------------------------------- */

  _processColor() {
    // Pasamos RGB → XYZ (sRGB D65) con normalización por clear
    const total = this.raw.red + this.raw.green + this.raw.blue;
    if (total <= 0) {
      this.cct = this.emaCct;
      return;
    }

    const r = this.raw.red / total;
    const g = this.raw.green / total;
    const b = this.raw.blue / total;

    // Aproximación lineal sRGB → XYZ (simplificada)
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;

    const sum = X + Y + Z;
    if (sum <= 0) {
      this.cct = this.emaCct;
      return;
    }

    const x = X / sum;
    const y = Y / sum;
    this.chromaticity = { x, y };

    // McCamy: n = (x - 0.3320) / (0.1858 - y)
    const n = (x - MCCAMY_N[0]) / (MCCAMY_N[1] - y);
    let cct = MCCAMY_COEF[0] * n ** 3
            + MCCAMY_COEF[1] * n ** 2
            + MCCAMY_COEF[2] * n
            + MCCAMY_COEF[3];

    cct = clamp(cct, CCT_MIN, CCT_MAX);
    this.cct = cct;
    this.emaCct = lerp(this.emaCct, cct, this.emaCctAlpha);
  }

  /* ---------------------------------------------------------------- *
   * Detección de flicker (50/60/100/120Hz)
   * Se simula muestreando la fase y eligiendo la frecuencia más probable
   * según el entorno (interior artificial → 50/60Hz, exterior → 0)
   * ---------------------------------------------------------------- */

  _detectFlicker(dt) {
    // Solo tiene sentido en interiores con luz artificial
    const isArtificial = this.band === 'dim' || this.band === 'indoor';
    const hasFlicker = isArtificial && Math.random() < 0.7;

    if (!hasFlicker) {
      // Decaimiento de la confianza
      this.flickerConfidence = Math.max(0, this.flickerConfidence - dt * 2);
      if (this.flickerConfidence < 0.2) {
        this.flickerHz = 0;
      }
      return;
    }

    // Elegir 50 o 60Hz según región simulada (Europa → 50Hz)
    const target = Math.random() < 0.75 ? 50 : 60;
    if (this.flickerHz !== target) {
      this.flickerHz = target;
      this.flickerConfidence = 0.5;
      this.stats.flickerDetections++;
      Logger.debug(LOG_TAG, `Flicker detectado: ${target}Hz (band=${this.band})`);
    } else {
      this.flickerConfidence = Math.min(1, this.flickerConfidence + dt);
    }
  }

  /* ---------------------------------------------------------------- *
   * Auto-rango: ajusta ganancia/integración si hay saturación o poca señal
   * ---------------------------------------------------------------- */

  _autoRangeAdjust() {
    if (!this.autoRange || !this.powered) return;

    const maxCount = Math.max(
      this.raw.clear, this.raw.red, this.raw.green, this.raw.blue, this.raw.ir
    );
    const ratio = maxCount / ADC_MAX;

    const now = this._t;
    if (now - this.lastRangeChangeAt < 0.5) return; // no cambiar más de 2/s

    if (ratio > SATURATION_HIGH && this.gainIndex > 0) {
      this.gainIndex--;
      this.lastRangeChangeAt = now;
      this.stats.rangeChanges++;
      Logger.debug(LOG_TAG, `Auto-rango ↓ ganancia ×${this.gain}`);
    } else if (ratio < SATURATION_LOW && this.gainIndex < GAIN_STEPS.length - 1) {
      this.gainIndex++;
      this.lastRangeChangeAt = now;
      this.stats.rangeChanges++;
      Logger.debug(LOG_TAG, `Auto-rango ↑ ganancia ×${this.gain}`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Historial
   * ---------------------------------------------------------------- */

  _pushHistory() {
    this.history.push({
      t: this._t,
      lux: round(this.emaLux, 2),
      cct: Math.round(this.emaCct),
      ir: round(this.irRatio, 3),
      flicker: this.flickerHz,
      band: this.band,
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
   * API pública de lectura
   * ---------------------------------------------------------------- */

  getReading() {
    return {
      lux: round(this.emaLux, 2),
      luxRaw: round(this.luxRaw, 2),
      band: this.band,
      cct: Math.round(this.emaCct),
      chromaticity: { ...this.chromaticity },
      irRatio: round(this.irRatio, 4),
      flickerHz: this.flickerHz,
      flickerConfidence: round(this.flickerConfidence, 2),
      raw: { ...this.raw },
      gain: this.gain,
      integrationMs: this.integrationMs,
      saturated: this.saturated,
      trueToneReady: this.powered && this.emaLux > 0,
    };
  }

  getTrueToneData() {
    // Lo que consume VDisplay para ajustar white point
    return {
      ambientLux: round(this.emaLux, 2),
      cct: Math.round(this.emaCct),
      x: round(this.chromaticity.x, 4),
      y: round(this.chromaticity.y, 4),
      band: this.band,
      flickerHz: this.flickerHz,
    };
  }

  getStats() {
    return {
      ...this.stats,
      currentLux: round(this.emaLux, 2),
      currentCct: Math.round(this.emaCct),
      currentBand: this.band,
      gain: this.gain,
      integrationMs: this.integrationMs,
      sampleRateHz: this.sampleRateHz,
      powered: this.powered,
      mode: this.mode,
    };
  }

  getHistory() { return [...this.history]; }

  /* ---------------------------------------------------------------- *
   * Overrides para demos/tests
   * ---------------------------------------------------------------- */

  setOverrideLux(lux) {
    if (lux == null) { this.overrideLux = null; return; }
    this.overrideLux = clamp(lux, 0, 150000);
    Logger.debug(LOG_TAG, `Override lux → ${this.overrideLux}`);
  }

  setOverrideCCT(cct) {
    if (cct == null) { this.overrideCct = null; return; }
    this.overrideCct = clamp(cct, CCT_MIN, CCT_MAX);
    Logger.debug(LOG_TAG, `Override CCT → ${this.overrideCct}K`);
  }

  clearOverrides() {
    this.overrideLux = null;
    this.overrideCct = null;
  }

  /* ---------------------------------------------------------------- *
   * Calibración
   * ---------------------------------------------------------------- */

  calibrate(referenceLux, referenceCCT = null) {
    if (this.emaLux <= 0) {
      Logger.warn(LOG_TAG, 'No se puede calibrar: lux actual es 0');
      return false;
    }
    const factor = referenceLux / this.emaLux;
    this.calibration.luxScale *= factor;
    if (referenceCCT != null) {
      const cctFactor = referenceCCT / this.emaCct;
      // Ajustamos trim de ganancia como aproximación
      this.calibration.gainTrim *= cctFactor;
    }
    Logger.info(LOG_TAG,
      `Calibrado: luxScale=${round(this.calibration.luxScale, 4)} ` +
      `(ref=${referenceLux} lux, medido=${round(this.emaLux, 2)} lux)`
    );
    return true;
  }

  resetCalibration() {
    this.calibration.luxScale = 1.0;
    this.calibration.gainTrim = 1.0;
    this.calibration.offsetClear = 0;
    this.calibration.offsetIR = 0;
    Logger.info(LOG_TAG, 'Calibración reseteada');
  }

  /* ---------------------------------------------------------------- *
   * Serialización (para persistencia / snapshots del kernel)
   * ---------------------------------------------------------------- */

  serialize() {
    return {
      powered: this.powered,
      enabled: this.enabled,
      mode: this.mode,
      gainIndex: this.gainIndex,
      integrationMs: this.integrationMs,
      sampleRateHz: this.sampleRateHz,
      autoRange: this.autoRange,
      calibration: { ...this.calibration },
      overrideLux: this.overrideLux,
      overrideCct: this.overrideCct,
      stats: { ...this.stats },
    };
  }

  deserialize(data) {
    if (!data) return;
    this.powered = !!data.powered;
    this.enabled = !!data.enabled;
    this.mode = data.mode || 'power-down';
    this.gainIndex = clamp(data.gainIndex ?? 3, 0, GAIN_STEPS.length - 1);
    this.integrationMs = data.integrationMs ?? 88.96;
    this.sampleRateHz = data.sampleRateHz ?? 10;
    this.autoRange = data.autoRange ?? true;
    if (data.calibration) Object.assign(this.calibration, data.calibration);
    this.overrideLux = data.overrideLux ?? null;
    this.overrideCct = data.overrideCct ?? null;
    if (data.stats) Object.assign(this.stats, data.stats);
    Logger.info(LOG_TAG, 'Estado ALS restaurado');
  }

  /* ---------------------------------------------------------------- *
   * Diagnóstico
   * ---------------------------------------------------------------- */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VAmbientLight dump ───');
    Logger.kernel(LOG_TAG, `  lux(EMA)     : ${r.lux}`);
    Logger.kernel(LOG_TAG, `  lux(raw)     : ${r.luxRaw}`);
    Logger.kernel(LOG_TAG, `  banda        : ${r.band}`);
    Logger.kernel(LOG_TAG, `  CCT          : ${r.cct}K`);
    Logger.kernel(LOG_TAG, `  IR ratio     : ${r.irRatio}`);
    Logger.kernel(LOG_TAG, `  flicker      : ${r.flickerHz}Hz (conf ${r.flickerConfidence})`);
    Logger.kernel(LOG_TAG, `  ganancia     : ×${r.gain}`);
    Logger.kernel(LOG_TAG, `  integración  : ${r.integrationMs}ms`);
    Logger.kernel(LOG_TAG, `  saturado     : ${r.saturated}`);
    Logger.kernel(LOG_TAG, `  muestras     : ${this.stats.samples}`);
    Logger.kernel(LOG_TAG, `  cambios rango: ${this.stats.rangeChanges}`);
  }
}

export default VAmbientLight;
