// src/drivers/VMagnetometer.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VMagnetometer (Virtual Magnetometer / Brújula)
 * ═══════════════════════════════════════════════════════════════
 *
 * Magnetómetro de 3 ejes. Modela el chip Asahi Kasei AK09918 que
 * un iPhone lleva para brújula, calibración de mapas, ARKit y
 * detección de orientación absoluta.
 *
 * Responsabilidades:
 *   - 3 ejes de campo magnético en μT (X, Y, Z)
 *   - Rango ±4900 μT, resolución 0.15 μT
 *   - Modos de operación: power-down / single / continuous
 *     (10, 20, 50, 100 Hz)
 *   - Heading (rumbo) en grados con declinación magnética
 *   - Calibración hard-iron (offset) y soft-iron (matriz de escala)
 *   - Detección de interferencias magnéticas (campo anómalo)
 *   - Detección de patrón figura-8 (calibración de usuario)
 *   - Fusión con acelerómetro para brújula con inclinación
 *   - Declinación según posición (modelo WMM simplificado)
 *   - Detección de campo anómalo (imanes, altavoces, etc)
 *   - Suscriptores de heading con rate configurable
 *   - IRQ_SENSOR con eventos: heading-changed, calibration-needed,
 *     interference, calibration-complete
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const MagState = {
  OFF:      'off',
  READY:    'ready',
  SAMPLING: 'sampling',
  ERROR:    'error',
};

export const MagMode = {
  POWER_DOWN: 'power-down',
  SINGLE:     'single',
  CONT_10HZ:  'continuous-10hz',
  CONT_20HZ:  'continuous-20hz',
  CONT_50HZ:  'continuous-50hz',
  CONT_100HZ: 'continuous-100hz',
};

export const MagRange = {
  UT_4900: 4900,   // rango estándar AK09918
};

export const CalibrationState = {
  UNCALIBRATED: 'uncalibrated',
  PARTIAL:      'partial',
  GOOD:         'good',
  EXCELLENT:    'excellent',
};

export const HeadingQuality = {
  INVALID:   'invalid',
  POOR:      'poor',
  FAIR:      'fair',
  GOOD:      'good',
  EXCELLENT: 'excellent',
};

// Fuerza del campo magnético terrestre (μT) según latitud (aprox)
// varía entre ~25 μT (ecuador) y ~65 μT (polos)
function earthFieldUT(lat) {
  const a = Math.abs(lat);
  return 25 + (a / 90) * 40;
}

// Declinación magnética aproximada (WMM muy simplificado)
// En España: ~ -1° a +2° según zona
function magneticDeclination(lat, lon) {
  // Fórmula simplificada solo válida como demo
  return Math.sin(lon / 30) * 3 + Math.cos(lat / 20) * 1.5;
}

// Umbral de interferencia (μT por encima del campo esperado)
const INTERFERENCE_THRESHOLD_UT = 25;

// Ruido del sensor (μT RMS)
const NOISE_UT_RMS = 0.35;

// Consumo según modo (μA)
function powerMicroAmp(mode) {
  switch (mode) {
    case MagMode.POWER_DOWN: return 0;
    case MagMode.SINGLE:     return 20;
    case MagMode.CONT_10HZ:  return 100;
    case MagMode.CONT_20HZ:  return 150;
    case MagMode.CONT_50HZ:  return 300;
    case MagMode.CONT_100HZ: return 550;
    default: return 100;
  }
}

function modeToHz(mode) {
  switch (mode) {
    case MagMode.CONT_10HZ:  return 10;
    case MagMode.CONT_20HZ:  return 20;
    case MagMode.CONT_50HZ:  return 50;
    case MagMode.CONT_100HZ: return 100;
    case MagMode.SINGLE:     return 1;
    default: return 0;
  }
}

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const normalizeAngle = (a) => {
  while (a < 0) a += 360;
  while (a >= 360) a -= 360;
  return a;
};

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
// Modelo de calibración (hard-iron + soft-iron)
// ───────────────────────────────────────────────────────────────
class CalibrationModel {
  constructor() {
    // Hard-iron: offset (bias) en cada eje (μT)
    this.hardIron = { x: 0, y: 0, z: 0 };

    // Soft-iron: matriz 3x3 que corrige la deformación del campo
    // Por defecto identidad
    this.softIron = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];

    // Metadatos
    this.state       = CalibrationState.UNCALIBRATED;
    this.qualityPct  = 0;
    this.calibratedAt= null;
    this.sampleCount = 0;

    // Para calcular el modelo: acumulamos min/max por eje
    this.min = { x: +Infinity, y: +Infinity, z: +Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
  }

  /** Añade una muestra cruda al modelo */
  addSample({ x, y, z }) {
    if (x < this.min.x) this.min.x = x;
    if (y < this.min.y) this.min.y = y;
    if (z < this.min.z) this.min.z = z;
    if (x > this.max.x) this.max.x = x;
    if (y > this.max.y) this.max.y = y;
    if (z > this.max.z) this.max.z = z;
    this.sampleCount++;
  }

  /** Calcula el hard-iron y el soft-iron a partir de min/max */
  compute() {
    if (this.sampleCount < 50) {
      this.state = CalibrationState.PARTIAL;
      this.qualityPct = Math.round((this.sampleCount / 50) * 40);
      return false;
    }

    const cx = (this.min.x + this.max.x) / 2;
    const cy = (this.min.y + this.max.y) / 2;
    const cz = (this.min.z + this.max.z) / 2;
    this.hardIron = { x: cx, y: cy, z: cz };

    const rx = (this.max.x - this.min.x) / 2 || 1;
    const ry = (this.max.y - this.min.y) / 2 || 1;
    const rz = (this.max.z - this.min.z) / 2 || 1;

    // El promedio de los radios es la esfera ideal
    const avgR = (rx + ry + rz) / 3;

    // Soft-iron: escalamos para que todos los ejes tengan el mismo radio
    this.softIron = [
      [avgR / rx, 0, 0],
      [0, avgR / ry, 0],
      [0, 0, avgR / rz],
    ];

    // Calidad: cuánto se parece a una esfera
    const variance = Math.abs(rx - avgR) + Math.abs(ry - avgR) + Math.abs(rz - avgR);
    const quality = clamp(100 - (variance / avgR) * 100, 0, 100);
    this.qualityPct = Math.round(quality);

    if (quality > 85)      this.state = CalibrationState.EXCELLENT;
    else if (quality > 65) this.state = CalibrationState.GOOD;
    else if (quality > 35) this.state = CalibrationState.PARTIAL;
    else                   this.state = CalibrationState.UNCALIBRATED;

    this.calibratedAt = Date.now();
    return this.state === CalibrationState.GOOD || this.state === CalibrationState.EXCELLENT;
  }

  /** Aplica la corrección a una muestra cruda */
  apply({ x, y, z }) {
    const hx = x - this.hardIron.x;
    const hy = y - this.hardIron.y;
    const hz = z - this.hardIron.z;
    const S = this.softIron;
    return {
      x: S[0][0] * hx + S[0][1] * hy + S[0][2] * hz,
      y: S[1][0] * hx + S[1][1] * hy + S[1][2] * hz,
      z: S[2][0] * hx + S[2][1] * hy + S[2][2] * hz,
    };
  }

  reset() {
    this.hardIron = { x: 0, y: 0, z: 0 };
    this.softIron = [[1,0,0],[0,1,0],[0,0,1]];
    this.state = CalibrationState.UNCALIBRATED;
    this.qualityPct = 0;
    this.calibratedAt = null;
    this.sampleCount = 0;
    this.min = { x: +Infinity, y: +Infinity, z: +Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
  }

  snapshot() {
    return {
      state:       this.state,
      qualityPct:  this.qualityPct,
      calibratedAt:this.calibratedAt,
      sampleCount: this.sampleCount,
      hardIron:    { ...this.hardIron },
      softIron:    this.softIron.map(r => [...r]),
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VMagnetometer — driver completo
// ───────────────────────────────────────────────────────────────
export class VMagnetometer {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VMagnetometer';
    this.model = DEVICE_MODEL.sensors.magnetometer.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = MagState.OFF;

    // Configuración
    this.mode        = MagMode.CONT_10HZ;
    this.rangeUT     = MagRange.UT_4900;
    this.enabled     = true;
    this.lowPowerMode= false;

    // Muestra actual (μT) — cruda y corregida
    this.raw     = { x: 22, y: 4, z: 42 };
    this.current = { x: 22, y: 4, z: 42 };

    // Modelo de calibración
    this.calibration = new CalibrationModel();

    // Ubicación para calcular campo esperado + declinación
    this.location = { lat: 40.4168, lon: -3.7038 };   // Madrid por defecto
    this.expectedFieldUT = earthFieldUT(this.location.lat);
    this.declination = magneticDeclination(this.location.lat, this.location.lon);

    // Heading (rumbo)
    this.heading = 0;                 // grados (0 = norte)
    this.headingTrue = 0;             // con declinación aplicada
    this.headingQuality = HeadingQuality.INVALID;

    // Detección de interferencia
    this.interference = {
      detected:    false,
      since:       null,
      magnitudeUT: 0,
      lastTs:      null,
      events:      0,
    };

    // Detección figura-8 (para calibrar)
    this.figure8 = {
      inProgress:    false,
      startedAt:     null,
      coverage:      { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      progressPct:   0,
      lastUpdateTs:  null,
    };

    // Historial
    this.historySize = 600;
    this.history = new SampleBuffer(this.historySize);
    this.headingHistory = new SampleBuffer(this.historySize);

    // Throughput
    this.throughput = {
      samplesLastSec: 0,
      samplesTotal:   0,
      lastSecondTs:   Date.now(),
      actualHz:       0,
    };

    // Suscriptores
    this.subscribers            = new Set();
    this.headingSubscribers     = new Set();
    this.interferenceSubscribers= new Set();
    this.calibrationSubscribers = new Set();

    // Loop
    this.tickId = null;
    this.tickIntervalMs = Math.max(10, Math.round(1000 / Math.max(1, modeToHz(this.mode))));

    // Estado interno
    this._lastHeadingEmitTs = 0;
    this._lastHeadingValue  = 0;

    // Métricas
    this.metrics = {
      samplesTaken:        0,
      headingChanges:      0,
      interferenceEvents:  0,
      calibrationsStarted: 0,
      calibrationsCompleted:0,
      figure8Sessions:     0,
      peakUT:              0,
      errors:              0,
      startedAt:           null,
    };

    // Consumo energético
    this.currentPowerMw = 0;

    logger.kernel('VMagnetometer',
      `creado: ${this.model} (±${this.rangeUT}μT, modo=${this.mode})`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this.state = MagState.READY;
    this._startTickLoop();

    logger.info('VMagnetometer',
      `✓ init: ${this.model}, campo esperado ${this.expectedFieldUT.toFixed(1)}μT`);
    this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
      source: 'vmag', event: 'ready',
    }, 'vmag');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.state = MagState.SAMPLING;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    this.state = MagState.OFF;
    this.currentPowerMw = 0;
    logger.info('VMagnetometer', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const now = Date.now();

    // 1) Generar muestra cruda
    const rawSample = this._simulateSample();
    this.raw = rawSample;

    // 2) Trackear pico
    const mag = Math.hypot(rawSample.x, rawSample.y, rawSample.z);
    if (mag > this.metrics.peakUT) this.metrics.peakUT = mag;

    // 3) Aplicar calibración
    this.current = this.calibration.apply(rawSample);

    // 4) Detección de interferencia
    this._detectInterference(now, mag);

    // 5) Actualizar heading
    this._updateHeading(now);

    // 6) Figura-8 tracking (si está en progreso)
    if (this.figure8.inProgress) {
      this._updateFigure8(now, rawSample);
    }

    // 7) Actualizar location desde GPS si está disponible
    this._syncLocationFromGPS();

    // 8) Push history
    this._pushHistory(now);

    // 9) Throughput
    this._updateThroughput(now);

    // 10) Consumo
    this.currentPowerMw = (powerMicroAmp(this.mode) * 3.7) / 1000;

    // 11) Emit
    this._emit();

    this.metrics.samplesTaken++;
    this.throughput.samplesTotal++;
  }

  _simulateSample() {
    // Campo magnético terrestre: forma un vector en el espacio
    // dependiendo de la orientación del dispositivo. Aquí simulamos
    // que el dispositivo puede rotar (influido por gyro si está).
    const F = this.expectedFieldUT;

    // Ángulo del dispositivo: tomamos el yaw del gyro si está activo
    let yaw = 0;
    const gyro = this.bus?.devices?.gyro;
    if (gyro) {
      const att = gyro.getAttitude?.();
      if (att) yaw = att.yaw || 0;
    }

    // Inclinación (pitch, roll)
    let pitch = 0, roll = 0;
    const accel = this.bus?.devices?.accel;
    if (accel) {
      const t = accel.getTiltDegrees?.();
      if (t) { pitch = t.pitch; roll = t.roll; }
    }

    // Proyectamos el vector de campo sobre el dispositivo
    const radYaw   = rad(yaw);
    const radPitch = rad(pitch);
    const radRoll  = rad(roll);

    // Matriz rotación simplificada (aplicamos yaw sobre Z, pitch sobre X)
    // En reposo con el móvil plano, medimos X≈F*sin(yaw), Y≈F*cos(yaw)
    // El componente Z es la inclinación magnética (~60° en España)
    const incl = rad(60);   // inclinación magnética típica
    const horiz = F * Math.cos(incl);
    const vert  = F * Math.sin(incl);

    let x = horiz * Math.sin(radYaw);
    let y = horiz * Math.cos(radYaw);
    let z = vert;

    // Inclinación del dispositivo mezcla componentes
    x += vert * Math.sin(radPitch) * 0.5;
    y += vert * Math.sin(radRoll) * 0.5;

    // Interferencias: si estamos cerca de un imán (aleatorio)
    if (this._tempInterference) {
      x += this._tempInterference.x;
      y += this._tempInterference.y;
      z += this._tempInterference.z;
    }

    // Ruido
    const r = () => (Math.random() - 0.5) * 2 * NOISE_UT_RMS;
    return {
      x: x + r(),
      y: y + r(),
      z: z + r(),
    };
  }

  _detectInterference(now, magnitudeUT) {
    // Interferencia si la magnitud se aleja mucho del campo esperado
    const dev = Math.abs(magnitudeUT - this.expectedFieldUT);
    const threshold = INTERFERENCE_THRESHOLD_UT;

    if (dev > threshold) {
      if (!this.interference.detected) {
        this.interference.detected = true;
        this.interference.since = now;
        this.interference.magnitudeUT = magnitudeUT;
        this.interference.lastTs = now;
        this.interference.events++;
        this.metrics.interferenceEvents++;
        logger.warn('VMagnetometer',
          `⚠ interferencia magnética detectada (${magnitudeUT.toFixed(1)}μT, desviación ${dev.toFixed(1)}μT)`);
        for (const fn of this.interferenceSubscribers) {
          try { fn({ type: 'start', magnitudeUT, deviation: dev }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
          source: 'vmag', event: 'interference-start', magnitudeUT,
        }, 'vmag');
      } else {
        this.interference.magnitudeUT = magnitudeUT;
        this.interference.lastTs = now;
      }
    } else {
      if (this.interference.detected && dev < threshold * 0.5) {
        this.interference.detected = false;
        this.interference.since = null;
        logger.info('VMagnetometer', 'interferencia resuelta');
        for (const fn of this.interferenceSubscribers) {
          try { fn({ type: 'end' }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
          source: 'vmag', event: 'interference-end',
        }, 'vmag');
      }
    }
  }

  _updateHeading(now) {
    const m = this.current;

    // Brújula básica: ángulo del campo en el plano XY
    let heading = deg(Math.atan2(-m.y, m.x));
    heading = normalizeAngle(heading);

    // Compensación de inclinación (tilt-compensated compass)
    const accel = this.bus?.devices?.accel;
    if (accel) {
      const gravity = accel.gravity || { x: 0, y: 0, z: -1 };
      const gmag = Math.hypot(gravity.x, gravity.y, gravity.z);
      if (gmag > 0.5) {
        const gx = gravity.x / gmag;
        const gy = gravity.y / gmag;
        const gz = gravity.z / gmag;
        // Componente horizontal del campo
        const mDotG = m.x * gx + m.y * gy + m.z * gz;
        const mx = m.x - mDotG * gx;
        const my = m.y - mDotG * gy;
        const mz = m.z - mDotG * gz;
        // Heading con respecto al norte
        heading = deg(Math.atan2(-my, mx));
        if (isNaN(heading)) heading = this.heading;
      }
    }

    this.heading = heading;
    this.headingTrue = normalizeAngle(heading + this.declination);

    // Calidad del heading
    if (this.interference.detected) {
      this.headingQuality = HeadingQuality.POOR;
    } else {
      const q = this.calibration.qualityPct;
      if (q >= 90) this.headingQuality = HeadingQuality.EXCELLENT;
      else if (q >= 70) this.headingQuality = HeadingQuality.GOOD;
      else if (q >= 40) this.headingQuality = HeadingQuality.FAIR;
      else this.headingQuality = HeadingQuality.POOR;
    }

    // Emitir solo si el heading cambia > 2° o ha pasado > 500ms
    const delta = Math.abs(this.headingTrue - this._lastHeadingValue);
    if (delta > 2 || now - this._lastHeadingEmitTs > 500) {
      this._lastHeadingValue = this.headingTrue;
      this._lastHeadingEmitTs = now;
      this.metrics.headingChanges++;

      for (const fn of this.headingSubscribers) {
        try { fn({ heading: this.headingTrue, quality: this.headingQuality }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
        source: 'vmag', event: 'heading-changed', heading: this.headingTrue,
      }, 'vmag');
    }
  }

  _updateFigure8(now, rawSample) {
    // Actualizamos la cobertura del gesto figura-8
    const f = this.figure8.coverage;
    if (rawSample.x < f.minX) f.minX = rawSample.x;
    if (rawSample.x > f.maxX) f.maxX = rawSample.x;
    if (rawSample.y < f.minY) f.minY = rawSample.y;
    if (rawSample.y > f.maxY) f.maxY = rawSample.y;
    if (rawSample.z < f.minZ) f.minZ = rawSample.z;
    if (rawSample.z > f.maxZ) f.maxZ = rawSample.z;

    this.calibration.addSample(rawSample);
    this.figure8.lastUpdateTs = now;

    // Progreso aproximado: basado en cuánto abarca en X e Y
    const spanX = f.maxX - f.minX;
    const spanY = f.maxY - f.minY;
    const target = this.expectedFieldUT * 1.5;   // queremos cubrir al menos 1.5x el campo
    const progress = clamp(((spanX + spanY) / (2 * target)) * 100, 0, 100);
    this.figure8.progressPct = Math.round(progress);

    if (this.figure8.progressPct >= 90) {
      this._completeFigure8();
    }
  }

  _syncLocationFromGPS() {
    const gps = this.bus?.devices?.gps;
    if (!gps) return;
    const loc = gps.getLocation?.();
    if (loc && loc.lat && loc.lon) {
      this.location = { lat: loc.lat, lon: loc.lon };
      this.expectedFieldUT = earthFieldUT(this.location.lat);
      this.declination = magneticDeclination(this.location.lat, this.location.lon);
    }
  }

  _pushHistory(now) {
    this.history.push({
      ts: now,
      x:  parseFloat(this.current.x.toFixed(2)),
      y:  parseFloat(this.current.y.toFixed(2)),
      z:  parseFloat(this.current.z.toFixed(2)),
      mag:parseFloat(Math.hypot(this.current.x, this.current.y, this.current.z).toFixed(2)),
    });
    this.headingHistory.push({
      ts: now,
      heading: parseFloat(this.headingTrue.toFixed(1)),
      quality: this.headingQuality,
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
    if (!Object.values(MagMode).includes(mode)) {
      logger.warn('VMagnetometer', `modo inválido: ${mode}`);
      return false;
    }
    if (mode === this.mode) return true;
    this.mode = mode;

    // Reconfigurar el tick
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
    logger.info('VMagnetometer', `modo: ${mode} (${hz}Hz)`);
    this._emit();
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.setMode(MagMode.POWER_DOWN);
    else this.setMode(MagMode.CONT_10HZ);
  }

  setLowPowerMode(on) {
    this.lowPowerMode = !!on;
    if (on && this.mode === MagMode.CONT_100HZ) {
      this.setMode(MagMode.CONT_10HZ);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CALIBRACIÓN
  // ═══════════════════════════════════════════════════════════

  /**
   * Inicia el modo "figura 8" para calibrar. El usuario debe mover
   * el dispositivo en forma de 8. El progreso se mide por cobertura.
   */
  startFigure8() {
    this.figure8 = {
      inProgress:    true,
      startedAt:     Date.now(),
      coverage:      { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      progressPct:   0,
      lastUpdateTs:  Date.now(),
    };
    this.calibration.reset();
    this.metrics.calibrationsStarted++;
    this.metrics.figure8Sessions++;
    logger.info('VMagnetometer', 'calibración figura-8 iniciada');
    this._emit();
    return true;
  }

  _completeFigure8() {
    this.figure8.inProgress = false;
    const ok = this.calibration.compute();
    this.metrics.calibrationsCompleted++;
    logger.info('VMagnetometer',
      `✓ calibración ${ok ? 'exitosa' : 'parcial'}: calidad ${this.calibration.qualityPct}%`);
    for (const fn of this.calibrationSubscribers) {
      try { fn({ type: 'complete', ...this.calibration.snapshot() }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
      source: 'vmag', event: 'calibration-complete',
      qualityPct: this.calibration.qualityPct,
    }, 'vmag');
    this._emit();
  }

  cancelFigure8() {
    if (!this.figure8.inProgress) return false;
    this.figure8.inProgress = false;
    logger.info('VMagnetometer', 'calibración figura-8 cancelada');
    this._emit();
    return true;
  }

  resetCalibration() {
    this.calibration.reset();
    logger.info('VMagnetometer', 'calibración reseteada');
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // SIMULACIÓN
  // ═══════════════════════════════════════════════════════════

  /**
   * Inyecta interferencia magnética durante un tiempo (para probar).
   */
  simulateInterference({ x = 50, y = 0, z = 0, durationMs = 3000 } = {}) {
    this._tempInterference = { x, y, z };
    if (durationMs > 0) {
      setTimeout(() => { this._tempInterference = null; }, durationMs);
    }
    logger.info('VMagnetometer', `interferencia simulada (${x},${y},${z}) μT`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  getSample() {
    const m = this.current;
    const mag = Math.hypot(m.x, m.y, m.z);
    return {
      ts:        Date.now(),
      x:         parseFloat(m.x.toFixed(3)),
      y:         parseFloat(m.y.toFixed(3)),
      z:         parseFloat(m.z.toFixed(3)),
      magnitude: parseFloat(mag.toFixed(3)),
      raw: {
        x: parseFloat(this.raw.x.toFixed(3)),
        y: parseFloat(this.raw.y.toFixed(3)),
        z: parseFloat(this.raw.z.toFixed(3)),
      },
      expectedUT: parseFloat(this.expectedFieldUT.toFixed(2)),
      deviation:  parseFloat(Math.abs(mag - this.expectedFieldUT).toFixed(2)),
    };
  }

  getHeading() {
    return {
      magnetic: parseFloat(this.heading.toFixed(1)),
      true:     parseFloat(this.headingTrue.toFixed(1)),
      declination: parseFloat(this.declination.toFixed(2)),
      quality:  this.headingQuality,
    };
  }

  getCalibration() {
    return this.calibration.snapshot();
  }

  isInterfered() {
    return this.interference.detected;
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onHeading(fn) {
    this.headingSubscribers.add(fn);
    return () => this.headingSubscribers.delete(fn);
  }

  onInterference(fn) {
    this.interferenceSubscribers.add(fn);
    return () => this.interferenceSubscribers.delete(fn);
  }

  onCalibration(fn) {
    this.calibrationSubscribers.add(fn);
    return () => this.calibrationSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VMagnetometer', `subscriber falló: ${err.message}`, err);
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
      rangeUT:       this.rangeUT,
      actualHz:      this.throughput.actualHz,
      sample:        this.getSample(),
      heading:       this.getHeading(),
      calibration:   this.calibration.snapshot(),
      interference:  { ...this.interference },
      figure8:       { ...this.figure8 },
      location:      { ...this.location },
      powerMw:       parseFloat(this.currentPowerMw.toFixed(3)),
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
    const sample = this.getSample();
    const head = this.getHeading();
    const lines = [
      `VMagnetometer [${s.state}] — ${s.model}`,
      `  modo:        ${this.mode} (${this.throughput.actualHz}Hz)`,
      `  muestra:     x=${sample.x} y=${sample.y} z=${sample.z} (|B|=${sample.magnitude}μT)`,
      `  esperado:    ${sample.expectedUT}μT  desviación=${sample.deviation}μT`,
      `  heading:     magnético=${head.magnetic}°  verdadero=${head.true}°  (declinación ${head.declination}°)`,
      `  calidad:     ${head.quality}`,
      `  calibración: ${this.calibration.state} (${this.calibration.qualityPct}%)`,
      `  interferencia: ${this.interference.detected ? 'SÍ' : 'no'}`,
      `  location:    ${this.location.lat.toFixed(4)}, ${this.location.lon.toFixed(4)}`,
      `  métricas:`,
      `    samples=${s.metrics.samplesTaken}  headingChanges=${s.metrics.headingChanges}`,
      `    calibrations=${s.metrics.calibrationsCompleted}/${s.metrics.calibrationsStarted}`,
      `    interference=${s.metrics.interferenceEvents}`,
      `  consumo:     ${this.currentPowerMw.toFixed(3)}mW`,
    ];
    return lines.join('\n');
  }

  getHistory(n = 100) {
    return this.history.last(n);
  }

  getHeadingHistory(n = 100) {
    return this.headingHistory.last(n);
  }

  clearHistory() {
    this.history.clear();
    this.headingHistory.clear();
  }
}
