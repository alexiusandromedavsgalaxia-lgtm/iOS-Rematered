// src/drivers/VBarometer.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VBarometer (Virtual Barometer / Altimeter)
 * ═══════════════════════════════════════════════════════════════
 *
 * Barómetro digital. Modela el chip Bosch BMP390 que un iPhone lleva
 * para medir presión atmosférica y calcular altitud. Se usa para:
 *   - Altitud en Salud y Fitness (subida de pisos)
 *   - Detección de cambios de tiempo (weather trending)
 *   - Altitud en Mapas (cuando GPS no da buena vertical)
 *   - ARKit (combinado con el acelerómetro para vertical tracking)
 *
 * Responsabilidades:
 *   - Presión atmosférica: rango 300-1250 hPa, precisión 0.03 hPa
 *   - Temperatura del sensor (°C)
 *   - Altitud calculada (fórmula barométrica)
 *   - Altitud relativa a una referencia (como iOS)
 *   - Modos: sleep / forced / normal (con sample rates 1-200 Hz)
 *   - Oversampling configurable (x1 a x32)
 *   - Filtro IIR configurable (coef 0-127)
 *   - Detección de pisos subidos/bajados (escaleras)
 *   - Detección de tendencia del tiempo (sube/baja/estable)
 *   - Historial de presión y altitud
 *   - Suscriptores de presión, altitud, pisos, tiempo
 *   - IRQ_SENSOR con eventos: pressure-changed, altitude-changed,
 *     floor-change, weather-trend, storm-warning
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const BaroState = {
  OFF:    'off',
  READY:  'ready',
  NORMAL: 'normal',
  FORCED: 'forced',
  ERROR:  'error',
};

export const BaroMode = {
  SLEEP:  'sleep',
  FORCED: 'forced',
  NORMAL: 'normal',
};

export const Oversampling = {
  X1:  1,
  X2:  2,
  X4:  4,
  X8:  8,
  X16: 16,
  X32: 32,
};

export const WeatherTrend = {
  STORM:      'storm',       // caída rápida, > -1.5 hPa/h
  RAIN:       'rain',        // bajando
  CHANGE:     'change',      // inestable
  FAIR:       'fair',        // subiendo despacio
  VERY_FAIR:  'very-fair',   // subiendo rápido
  STEADY:     'steady',      // estable
};

// Altura típica de un piso (m)
const FLOOR_HEIGHT_M = 3.0;

// Fórmula barométrica internacional
// p0 = presión a nivel del mar (1013.25 hPa), T = temperatura
function pressureToAltitude(pressureHpa, seaLevelHpa = 1013.25, tempC = 15) {
  // Formula: h = 44330 * (1 - (p/p0)^(1/5.255))
  const ratio = pressureHpa / seaLevelHpa;
  return 44330 * (1 - Math.pow(ratio, 1 / 5.255));
}

function altitudeToPressure(altitudeM, seaLevelHpa = 1013.25) {
  return seaLevelHpa * Math.pow(1 - altitudeM / 44330, 5.255);
}

// Precisión del sensor según oversampling (hPa RMS)
function precisionHpa(oversampling) {
  // A más oversampling, más precisión
  return 0.03 / Math.sqrt(oversampling);
}

// Sample rate por modo (Hz)
function modeToHz(mode) {
  switch (mode) {
    case BaroMode.SLEEP:  return 0;
    case BaroMode.FORCED: return 1;
    case BaroMode.NORMAL: return 10;
    default: return 1;
  }
}

// Consumo por modo (μA)
function powerMicroAmp(mode, oversampling) {
  const base = { [BaroMode.SLEEP]: 0, [BaroMode.FORCED]: 30, [BaroMode.NORMAL]: 300 }[mode] ?? 0;
  const factor = Math.sqrt(oversampling);
  return base * factor;
}

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randRange = (a, b) => a + Math.random() * (b - a);

// ───────────────────────────────────────────────────────────────
// Buffer circular
// ───────────────────────────────────────────────────────────────
class SampleBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }
  push(s) {
    this.buffer[this.head] = s;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
  toArray() {
    if (this.size === 0) return [];
    if (this.size < this.capacity) return this.buffer.slice(0, this.size);
    const out = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return out;
  }
  last(n) {
    if (n >= this.size) return this.toArray();
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
// Filtro IIR (según BMP390)
// ───────────────────────────────────────────────────────────────
class IIRFilter {
  constructor(coef = 8) {
    this.coef = clamp(coef, 0, 127);
    this.initialized = false;
    this.value = 0;
  }

  apply(sample) {
    if (this.coef === 0) return sample;
    if (!this.initialized) {
      this.value = sample;
      this.initialized = true;
      return sample;
    }
    // Coeficiente de suavizado: más alto = más suave
    const alpha = 1 - Math.exp(-1 / this.coef);
    this.value = this.value + alpha * (sample - this.value);
    return this.value;
  }

  setCoef(c) { this.coef = clamp(c, 0, 127); }
  reset() { this.initialized = false; this.value = 0; }
}

// ───────────────────────────────────────────────────────────────
// Detector de pisos
// ───────────────────────────────────────────────────────────────
class FloorDetector {
  constructor() {
    this.referenceAltitudeM = null;    // altitud de referencia (piso 0)
    this.currentFloor = 0;
    this.floorsClimbed = 0;
    this.floorsDescended = 0;
    this.lastAltitudeM = null;
    this.accumulatedUp = 0;
    this.accumulatedDown = 0;
    this.samplesForFloor = 5;    // necesita N muestras consistentes
    this.recentFloors = [];
  }

  setReference(altitudeM) {
    this.referenceAltitudeM = altitudeM;
    this.currentFloor = 0;
    this.floorsClimbed = 0;
    this.floorsDescended = 0;
    this.lastAltitudeM = altitudeM;
    this.accumulatedUp = 0;
    this.accumulatedDown = 0;
    this.recentFloors = [];
  }

  /**
   * Procesa una nueva altitud. Devuelve un evento si hay cambio de piso.
   */
  update(altitudeM) {
    if (this.referenceAltitudeM === null) {
      this.setReference(altitudeM);
      return null;
    }

    if (this.lastAltitudeM === null) {
      this.lastAltitudeM = altitudeM;
      return null;
    }

    const delta = altitudeM - this.lastAltitudeM;
    this.lastAltitudeM = altitudeM;

    // Acumulamos cambios pequeños (para filtrar ruido)
    if (delta > 0) {
      this.accumulatedUp += delta;
      // Si vamos hacia arriba, reducimos el acumulado de bajada
      this.accumulatedDown = Math.max(0, this.accumulatedDown - delta * 0.5);
    } else if (delta < 0) {
      this.accumulatedDown += -delta;
      this.accumulatedUp = Math.max(0, this.accumulatedUp + delta * 0.5);
    }

    // Comprobamos si hemos subido un piso entero
    if (this.accumulatedUp >= FLOOR_HEIGHT_M * 0.8) {
      const floors = Math.floor(this.accumulatedUp / FLOOR_HEIGHT_M);
      if (floors > 0) {
        this.currentFloor += floors;
        this.floorsClimbed += floors;
        this.accumulatedUp -= floors * FLOOR_HEIGHT_M;
        this.recentFloors.push({ floor: this.currentFloor, direction: 'up', ts: Date.now() });
        if (this.recentFloors.length > 20) this.recentFloors.shift();
        return { direction: 'up', floors, currentFloor: this.currentFloor };
      }
    }

    // Comprobamos si hemos bajado un piso entero
    if (this.accumulatedDown >= FLOOR_HEIGHT_M * 0.8) {
      const floors = Math.floor(this.accumulatedDown / FLOOR_HEIGHT_M);
      if (floors > 0) {
        this.currentFloor -= floors;
        this.floorsDescended += floors;
        this.accumulatedDown -= floors * FLOOR_HEIGHT_M;
        this.recentFloors.push({ floor: this.currentFloor, direction: 'down', ts: Date.now() });
        if (this.recentFloors.length > 20) this.recentFloors.shift();
        return { direction: 'down', floors, currentFloor: this.currentFloor };
      }
    }

    return null;
  }

  snapshot() {
    return {
      referenceAltitudeM: this.referenceAltitudeM,
      currentFloor:       this.currentFloor,
      floorsClimbed:      this.floorsClimbed,
      floorsDescended:    this.floorsDescended,
      recentFloors:       this.recentFloors.slice(-5),
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VBarometer — driver completo
// ───────────────────────────────────────────────────────────────
export class VBarometer {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VBarometer';
    this.model = DEVICE_MODEL.sensors.barometer.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = BaroState.OFF;

    // Configuración
    this.mode           = BaroMode.NORMAL;
    this.sampleRateHz   = 10;
    this.oversampling   = Oversampling.X8;
    this.iirCoef        = 8;
    this.enabled        = true;
    this.lowPowerMode   = false;

    // Referencia para altitud
    this.referencePressureHpa = 1013.25;   // presión a nivel del mar
    this.referenceAltitudeM   = null;      // altitud de referencia relativa

    // Medidas
    this.pressureHpa   = 1013.25;
    this.temperatureC  = 22.5;
    this.altitudeM     = 650;              // altitud absoluta (Madrid)
    this.relativeAltitudeM = 0;            // relativa a la referencia

    // Filtros
    this.pressureFilter = new IIRFilter(this.iirCoef);
    this.temperatureFilter = new IIRFilter(this.iirCoef);

    // Detector de pisos
    this.floorDetector = new FloorDetector();

    // Tendencia del tiempo
    this.trend = {
      current:    WeatherTrend.STEADY,
      lastChange: Date.now(),
      delta1hHpa: 0,
      delta3hHpa: 0,
      pressureHistory: [],   // [{ ts, hpa }] — últimos 3h
    };

    // Detección de tormenta
    this.storm = {
      detected: false,
      since:    null,
      pressureDropRateHpa: 0,
      lastTs:   null,
    };

    // Historial
    this.historySize = 600;
    this.history = new SampleBuffer(this.historySize);

    // Throughput
    this.throughput = {
      samplesLastSec: 0,
      samplesTotal:   0,
      lastSecondTs:   Date.now(),
      actualHz:       0,
    };

    // Suscriptores
    this.subscribers          = new Set();
    this.pressureSubscribers  = new Set();
    this.altitudeSubscribers  = new Set();
    this.floorSubscribers     = new Set();
    this.trendSubscribers     = new Set();

    // Loop
    this.tickId = null;
    this.tickIntervalMs = Math.max(10, Math.round(1000 / Math.max(1, modeToHz(this.mode))));

    // Estado interno
    this._lastTrendCheckTs = 0;
    this._simulatedFloorStart = null;

    // Métricas
    this.metrics = {
      samplesTaken:      0,
      floorsClimbed:     0,
      floorsDescended:   0,
      trendChanges:      0,
      stormWarnings:     0,
      forcedMeasurements:0,
      peakPressure:      0,
      minPressure:       Infinity,
      errors:            0,
      startedAt:         null,
    };

    // Consumo energético
    this.currentPowerMw = 0;

    logger.kernel('VBarometer',
      `creado: ${this.model} (modo=${this.mode}, oversampling=x${this.oversampling})`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this.state = BaroState.READY;

    // Referencia inicial: altitud actual (Madrid por defecto)
    this.referenceAltitudeM = this.altitudeM;
    this.floorDetector.setReference(this.altitudeM);

    // Pre-poblar la presión en base a la altitud
    this.pressureHpa = altitudeToPressure(this.altitudeM, this.referencePressureHpa);

    this._startTickLoop();

    logger.info('VBarometer',
      `✓ init: ${this.model}, p=${this.pressureHpa.toFixed(2)}hPa, alt=${this.altitudeM.toFixed(1)}m`);
    this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
      source: 'vbaro', event: 'ready',
    }, 'vbaro');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.state = BaroState.NORMAL;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    this.state = BaroState.OFF;
    this.currentPowerMw = 0;
    logger.info('VBarometer', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const now = Date.now();

    // 1) Simular medida
    const rawPressure = this._simulatePressure();
    const rawTemp = this._simulateTemperature();

    // 2) Aplicar filtro IIR
    this.pressureHpa = this.pressureFilter.apply(rawPressure);
    this.temperatureC = this.temperatureFilter.apply(rawTemp);

    // 3) Calcular altitud
    const prevAlt = this.altitudeM;
    this.altitudeM = pressureToAltitude(this.pressureHpa, this.referencePressureHpa, this.temperatureC);
    this.relativeAltitudeM = this.referenceAltitudeM !== null
      ? this.altitudeM - this.referenceAltitudeM
      : 0;

    // 4) Trackear picos
    if (this.pressureHpa > this.metrics.peakPressure) this.metrics.peakPressure = this.pressureHpa;
    if (this.pressureHpa < this.metrics.minPressure) this.metrics.minPressure = this.pressureHpa;

    // 5) Detectar cambio de piso
    const floorEvent = this.floorDetector.update(this.altitudeM);
    if (floorEvent) {
      if (floorEvent.direction === 'up') this.metrics.floorsClimbed += floorEvent.floors;
      else this.metrics.floorsDescended += floorEvent.floors;
      logger.info('VBarometer',
        `🏢 ${floorEvent.direction === 'up' ? 'subido' : 'bajado'} ${floorEvent.floors} piso(s) → piso ${floorEvent.currentFloor}`);
      for (const fn of this.floorSubscribers) {
        try { fn(floorEvent); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
        source: 'vbaro', event: 'floor-change',
        direction: floorEvent.direction,
        floors: floorEvent.floors,
        currentFloor: floorEvent.currentFloor,
      }, 'vbaro');
    }

    // 6) Actualizar tendencia (cada 60s)
    if (now - this._lastTrendCheckTs > 60_000) {
      this._lastTrendCheckTs = now;
      this._updateTrend(now);
    }

    // 7) Push history
    this._pushHistory(now);

    // 8) Throughput
    this._updateThroughput(now);

    // 9) Consumo
    this.currentPowerMw = (powerMicroAmp(this.mode, this.oversampling) * 3.7) / 1000;

    // 10) Emit
    this._emit();

    this.metrics.samplesTaken++;
    this.throughput.samplesTotal++;

    // Notificar altitud si ha cambiado significativamente
    if (Math.abs(this.altitudeM - prevAlt) > 0.5) {
      for (const fn of this.altitudeSubscribers) {
        try { fn({ altitudeM: this.altitudeM, relativeM: this.relativeAltitudeM }); } catch (_) {}
      }
    }
  }

  _simulatePressure() {
    // Base: presión según altitud + variación atmosférica lenta + ruido
    const basePressure = altitudeToPressure(this.altitudeM, this.referencePressureHpa);

    // Deriva atmosférica: oscilación lenta (±2 hPa en horas)
    const t = Date.now() / 1000;
    const slowDrift = Math.sin(t / 3600) * 1.5 + Math.sin(t / 7200) * 1.0;

    // Si estamos subiendo/bajando (ruta simulada)
    let motionDelta = 0;
    if (this._simulatedFloorStart) {
      // Movimiento vertical simulado
      const elapsed = (Date.now() - this._simulatedFloorStart.startTs) / 1000;
      const rate = this._simulatedFloorStart.rateMps;
      const totalTarget = this._simulatedFloorStart.deltaM;
      const currentDelta = Math.min(totalTarget, elapsed * rate);
      motionDelta = currentDelta;
      if (currentDelta >= totalTarget) {
        this._simulatedFloorStart = null;
      }
    }

    const pressureAtCurrentAlt = altitudeToPressure(
      this.altitudeM + motionDelta,
      this.referencePressureHpa,
    );

    // Ruido según oversampling
    const sigma = precisionHpa(this.oversampling);
    const noise = (Math.random() - 0.5) * 2 * sigma;

    return basePressure + slowDrift + (pressureAtCurrentAlt - basePressure) + noise;
  }

  _simulateTemperature() {
    // Temperatura del sensor: ligada a la del chip principal
    const cpu = this.bus?.devices?.cpu;
    const ambientC = cpu ? cpu.avgTempC?.() ?? 25 : 25;
    // El barómetro está en el mismo chip, se calienta algo
    return ambientC + (Math.random() - 0.5) * 0.3;
  }

  _updateTrend(now) {
    // Guardamos la presión actual en el historial de tendencia
    this.trend.pressureHistory.push({ ts: now, hpa: this.pressureHpa });
    // Mantenemos 3 horas
    const cutoff = now - 3 * 3600 * 1000;
    this.trend.pressureHistory = this.trend.pressureHistory.filter(e => e.ts >= cutoff);

    // Calculamos deltas
    const p1h = this._pressureAt(now - 1 * 3600 * 1000);
    const p3h = this._pressureAt(now - 3 * 3600 * 1000);
    this.trend.delta1hHpa = p1h !== null ? this.pressureHpa - p1h : 0;
    this.trend.delta3hHpa = p3h !== null ? this.pressureHpa - p3h : 0;

    // Clasificar tendencia
    let newTrend = WeatherTrend.STEADY;
    const d3 = this.trend.delta3hHpa;

    if (d3 < -6)      newTrend = WeatherTrend.STORM;
    else if (d3 < -1.5) newTrend = WeatherTrend.RAIN;
    else if (d3 > 6)  newTrend = WeatherTrend.VERY_FAIR;
    else if (d3 > 1.5) newTrend = WeatherTrend.FAIR;
    else if (Math.abs(d3) < 0.5) newTrend = WeatherTrend.STEADY;
    else              newTrend = WeatherTrend.CHANGE;

    if (newTrend !== this.trend.current) {
      const prev = this.trend.current;
      this.trend.current = newTrend;
      this.trend.lastChange = now;
      this.metrics.trendChanges++;
      logger.info('VBarometer', `tendencia: ${prev} → ${newTrend} (Δ1h=${this.trend.delta1hHpa.toFixed(2)}hPa, Δ3h=${this.trend.delta3hHpa.toFixed(2)}hPa)`);
      for (const fn of this.trendSubscribers) {
        try { fn({ trend: newTrend, prev, delta1h: this.trend.delta1hHpa, delta3h: this.trend.delta3hHpa }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
        source: 'vbaro', event: 'weather-trend', trend: newTrend,
      }, 'vbaro');

      // Storm warning
      if (newTrend === WeatherTrend.STORM && !this.storm.detected) {
        this.storm.detected = true;
        this.storm.since = now;
        this.metrics.stormWarnings++;
        logger.warn('VBarometer', `⛈ storm warning (caída ${this.trend.delta3hHpa.toFixed(2)}hPa en 3h)`);
        this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
          source: 'vbaro', event: 'storm-warning',
          dropHpa: this.trend.delta3hHpa,
        }, 'vbaro');
      } else if (newTrend !== WeatherTrend.STORM) {
        this.storm.detected = false;
      }
    }
  }

  _pressureAt(targetTs) {
    // Busca en el historial el sample más cercano al timestamp
    let best = null;
    let bestDiff = Infinity;
    for (const e of this.trend.pressureHistory) {
      const diff = Math.abs(e.ts - targetTs);
      if (diff < bestDiff) { bestDiff = diff; best = e; }
    }
    return best ? best.hpa : null;
  }

  _pushHistory(now) {
    this.history.push({
      ts: now,
      pressureHpa: parseFloat(this.pressureHpa.toFixed(3)),
      temperatureC: parseFloat(this.temperatureC.toFixed(2)),
      altitudeM: parseFloat(this.altitudeM.toFixed(2)),
      relativeM: parseFloat(this.relativeAltitudeM.toFixed(2)),
    });
  }

  _updateThroughput(now) {
    if (now - this.throughput.lastSecondTs >= 1000) {
      this.throughput.actualHz = this.throughput.samplesLastSec;
      this.throughput.samplesLastSec = 0;
      this.throughput.lastSecondTs = now;
    }
    this.throughput.samplesLastSec++;
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ═══════════════════════════════════════════════════════════

  setMode(mode) {
    if (!Object.values(BaroMode).includes(mode)) {
      logger.warn('VBarometer', `modo inválido: ${mode}`);
      return false;
    }
    if (mode === this.mode) return true;
    this.mode = mode;

    const hz = modeToHz(mode);
    if (hz === 0) {
      this.shutdown();
    } else {
      this.tickIntervalMs = Math.max(10, Math.round(1000 / hz));
      if (this.running) {
        clearInterval(this.tickId);
        this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
      } else {
        this._startTickLoop();
      }
    }
    logger.info('VBarometer', `modo: ${mode} (${hz}Hz)`);
    this._emit();
    return true;
  }

  setOversampling(os) {
    if (!Object.values(Oversampling).includes(os)) return false;
    this.oversampling = os;
    logger.info('VBarometer', `oversampling: x${os}`);
    this._emit();
    return true;
  }

  setIIRCoef(coef) {
    coef = clamp(Math.round(coef), 0, 127);
    this.iirCoef = coef;
    this.pressureFilter.setCoef(coef);
    this.temperatureFilter.setCoef(coef);
    logger.info('VBarometer', `coef IIR: ${coef}`);
    this._emit();
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.setMode(BaroMode.SLEEP);
    else this.setMode(BaroMode.NORMAL);
  }

  setLowPowerMode(on) {
    this.lowPowerMode = !!on;
    if (on) {
      this.setMode(BaroMode.FORCED);
      this.setOversampling(Oversampling.X2);
    }
  }

  /**
   * Fuerza una medida puntual (útil para apps que no quieren
   * suscribirse al stream).
   */
  async forceMeasurement() {
    this.metrics.forcedMeasurements++;
    return {
      pressureHpa:  parseFloat(this.pressureHpa.toFixed(3)),
      temperatureC: parseFloat(this.temperatureC.toFixed(2)),
      altitudeM:    parseFloat(this.altitudeM.toFixed(2)),
      ts:           Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // REFERENCIA DE ALTITUD
  // ═══════════════════════════════════════════════════════════

  /**
   * Fija la altitud actual como referencia (piso 0).
   */
  setAltitudeReference(altitudeM = null) {
    const ref = altitudeM !== null ? altitudeM : this.altitudeM;
    this.referenceAltitudeM = ref;
    this.relativeAltitudeM = 0;
    this.floorDetector.setReference(ref);
    logger.info('VBarometer', `referencia altitud: ${ref.toFixed(2)}m`);
    this._emit();
    return true;
  }

  /**
   * Fija la presión a nivel del mar (útil para calibrar con
   * datos de una estación meteorológica).
   */
  setSeaLevelPressure(hpa) {
    hpa = clamp(hpa, 900, 1100);
    this.referencePressureHpa = hpa;
    logger.info('VBarometer', `presión nivel del mar: ${hpa.toFixed(2)}hPa`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // SIMULACIÓN
  // ═══════════════════════════════════════════════════════════

  /**
   * Simula que el usuario sube o baja N metros durante un tiempo.
   */
  simulateVerticalMotion({ deltaM = 10, rateMps = 1.5 } = {}) {
    this._simulatedFloorStart = {
      startTs: Date.now(),
      deltaM: Math.abs(deltaM),
      rateMps: Math.abs(rateMps),
      direction: deltaM >= 0 ? 'up' : 'down',
    };
    logger.info('VBarometer',
      `movimiento vertical simulado: ${deltaM >= 0 ? 'subir' : 'bajar'} ${Math.abs(deltaM)}m a ${rateMps}m/s`);
    return true;
  }

  /**
   * Simula cambios de tiempo (sube o baja presión).
   */
  simulateWeatherChange({ deltaHpa = -5, durationMs = 10000 } = {}) {
    this._weatherShift = {
      deltaHpa,
      durationMs,
      startTs: Date.now(),
    };
    setTimeout(() => { this._weatherShift = null; }, durationMs);
    logger.info('VBarometer', `cambio de tiempo simulado: ${deltaHpa}hPa en ${durationMs}ms`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  getMeasurement() {
    return {
      ts:            Date.now(),
      pressureHpa:   parseFloat(this.pressureHpa.toFixed(3)),
      temperatureC:  parseFloat(this.temperatureC.toFixed(2)),
      altitudeM:     parseFloat(this.altitudeM.toFixed(2)),
      relativeM:     parseFloat(this.relativeAltitudeM.toFixed(2)),
      referenceHpa:  this.referencePressureHpa,
      referenceAltM: this.referenceAltitudeM,
    };
  }

  getAltitude() {
    return {
      absoluteM: this.altitudeM,
      relativeM: this.relativeAltitudeM,
      referenceM: this.referenceAltitudeM,
    };
  }

  getFloorInfo() {
    return this.floorDetector.snapshot();
  }

  getTrend() {
    return {
      current:     this.trend.current,
      delta1hHpa:  parseFloat(this.trend.delta1hHpa.toFixed(2)),
      delta3hHpa:  parseFloat(this.trend.delta3hHpa.toFixed(2)),
      lastChange:  this.trend.lastChange,
      storm:       this.storm.detected,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onPressure(fn) {
    this.pressureSubscribers.add(fn);
    return () => this.pressureSubscribers.delete(fn);
  }

  onAltitude(fn) {
    this.altitudeSubscribers.add(fn);
    return () => this.altitudeSubscribers.delete(fn);
  }

  onFloor(fn) {
    this.floorSubscribers.add(fn);
    return () => this.floorSubscribers.delete(fn);
  }

  onTrend(fn) {
    this.trendSubscribers.add(fn);
    return () => this.trendSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VBarometer', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:         this.model,
      state:         this.state,
      mode:          this.mode,
      oversampling:  this.oversampling,
      iirCoef:       this.iirCoef,
      actualHz:      this.throughput.actualHz,
      measurement:   this.getMeasurement(),
      altitude:      this.getAltitude(),
      floors:        this.getFloorInfo(),
      trend:         this.getTrend(),
      powerMw:       parseFloat(this.currentPowerMw.toFixed(4)),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      throughput:  { ...this.throughput },
      historySize: this.history.length,
    };
  }

  dump() {
    const s = this.getStats();
    const m = this.getMeasurement();
    const f = this.getFloorInfo();
    const t = this.getTrend();
    const lines = [
      `VBarometer [${s.state}] — ${s.model}`,
      `  modo:        ${this.mode} (${this.throughput.actualHz}Hz, x${this.oversampling} OS, IIR=${this.iirCoef})`,
      `  presión:     ${m.pressureHpa} hPa`,
      `  temperatura: ${m.temperatureC} °C`,
      `  altitud:     ${m.altitudeM}m absoluta, ${m.relativeM}m relativa (ref ${m.referenceAltM?.toFixed(1) ?? '—'}m)`,
      `  pisos:       piso ${f.currentFloor}  subidos=${f.floorsClimbed}  bajados=${f.floorsDescended}`,
      `  tendencia:   ${t.current} (Δ1h=${t.delta1hHpa}hPa, Δ3h=${t.delta3hHpa}hPa)${t.storm ? ' ⛈ STORM' : ''}`,
      `  rango:       min=${s.metrics.minPressure === Infinity ? '—' : s.metrics.minPressure.toFixed(2)}hPa  max=${s.metrics.peakPressure.toFixed(2)}hPa`,
      `  consumo:     ${this.currentPowerMw.toFixed(4)}mW`,
    ];
    return lines.join('\n');
  }

  getHistory(n = 100) {
    return this.history.last(n);
  }

  clearHistory() {
    this.history.clear();
  }
}
