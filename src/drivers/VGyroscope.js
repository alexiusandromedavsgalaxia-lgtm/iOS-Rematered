// src/drivers/VGyroscope.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VGyroscope (Virtual Gyroscope)
 * ═══════════════════════════════════════════════════════════════
 *
 * Giroscopio MEMS de 3 ejes. Comparte package con el acelerómetro
 * (Bosch BMI286) pero se modela como driver independiente.
 *
 * Responsabilidades:
 *   - 3 ejes de velocidad angular (pitch, roll, yaw)
 *   - Rangos: ±125, ±250, ±500, ±1000, ±2000 °/s
 *   - Sample rate configurable hasta 800 Hz
 *   - Bias / drift con auto-calibración en reposo
 *   - Integración de ángulo acumulado (yaw/pitch/roll)
 *   - Detección de rotación brusca (spin)
 *   - Detección de estabilidad (steady)
 *   - Fusión con VAccelerometer (complementary filter) para
 *     orientación 3D fiable a largo plazo
 *   - Fusión con VMagnetometer si está disponible (yaw absoluto)
 *   - Detección de gestos: rotation-left, rotation-right,
 *     rotation-up, rotation-down, twist, flip
 *   - Historial circular de muestras
 *   - Suscriptores configurables
 *   - IRQ_MOTION con eventos de rotación y estabilidad
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const GyroState = {
  OFF:      'off',
  READY:    'ready',
  SAMPLING: 'sampling',
  ERROR:    'error',
};

export const GyroRange = {
  DPS_125:  125,
  DPS_250:  250,
  DPS_500:  500,
  DPS_1000: 1000,
  DPS_2000: 2000,
};

export const SpinDirection = {
  NONE:    'none',
  LEFT:    'left',
  RIGHT:   'right',
  UP:      'up',
  DOWN:    'down',
  TWIST:   'twist',
  FLIP:    'flip',
};

export const SteadinessLevel = {
  STEADY:     'steady',
  SLIGHT:     'slight',
  MODERATE:   'moderate',
  FAST:       'fast',
  VERY_FAST:  'very-fast',
};

// Umbrales (en °/s)
const TH = {
  STEADY_DPS:       2.0,    // < esto = steady
  SLIGHT_DPS:       20,
  MODERATE_DPS:     90,
  FAST_DPS:         300,
  VERY_FAST_DPS:    1000,
  SPIN_MIN_DPS:     200,    // para disparar "spin"
  SPIN_DURATION_MS: 250,    // debe durar al menos esto
  STEADY_DURATION_MS: 800,  // para declarar steady
  GESTURE_MIN_DPS:  150,
  GESTURE_MAX_MS:   600,
};

// Ruido del sensor (°/s RMS)
const NOISE_DPS_RMS = 0.08;

// Bias típico inicial (°/s)
const INITIAL_BIAS = { x: 0.02, y: -0.015, z: 0.01 };

// Drift por temperatura: empeora con el calor
function driftFactor(tempC) {
  if (tempC < 25) return 1.0;
  if (tempC < 40) return 1.0 + (tempC - 25) * 0.02;
  return 1.3 + (tempC - 40) * 0.04;
}

// Consumo según sample rate (μA)
function powerMicroAmp(hz) {
  return 15 + (hz / 800) * 600;
}

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randRange = (a, b) => a + Math.random() * (b - a);
const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const normalizeAngle = (a) => {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
};

// ───────────────────────────────────────────────────────────────
// Buffer circular de muestras
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
// Estimador de actitud (complementary filter acel + gyro)
// ───────────────────────────────────────────────────────────────
class AttitudeEstimator {
  constructor() {
    this.pitch = 0;    // grados
    this.roll  = 0;
    this.yaw   = 0;
    this.alpha = 0.98;   // peso del gyro vs acel
    this.lastTs = Date.now();
  }

  /**
   * @param {object} gyro   { x, y, z } en °/s
   * @param {object} accel  { x, y, z } en g
   */
  update(gyro, accel) {
    const now = Date.now();
    const dt = Math.max(0.001, (now - this.lastTs) / 1000);
    this.lastTs = now;

    // 1) Integrar gyro
    this.pitch += gyro.x * dt;
    this.roll  += gyro.y * dt;
    this.yaw   += gyro.z * dt;

    // 2) Estimar pitch/roll desde el acelerómetro (gravedad)
    const mag = Math.hypot(accel.x, accel.y, accel.z);
    if (mag > 0.5) {
      const pitchAcc = deg(Math.atan2(-accel.x, Math.hypot(accel.y, accel.z)));
      const rollAcc  = deg(Math.atan2(accel.y, accel.z));

      // 3) Complementary filter
      this.pitch = this.alpha * this.pitch + (1 - this.alpha) * pitchAcc;
      this.roll  = this.alpha * this.roll  + (1 - this.alpha) * rollAcc;
    }

    // 4) Yaw solo se corrige con magnetómetro (si está enlazado)
    // El yaw puede derivar; lo normalizamos
    this.yaw = normalizeAngle(this.yaw);

    this.pitch = clamp(this.pitch, -90, 90);
    this.roll  = normalizeAngle(this.roll);

    return this.get();
  }

  get() {
    return {
      pitch: parseFloat(this.pitch.toFixed(2)),
      roll:  parseFloat(this.roll.toFixed(2)),
      yaw:   parseFloat(this.yaw.toFixed(2)),
    };
  }

  reset() {
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.lastTs = Date.now();
  }
}

// ───────────────────────────────────────────────────────────────
// VGyroscope — driver completo
// ───────────────────────────────────────────────────────────────
export class VGyroscope {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VGyroscope';
    this.model = DEVICE_MODEL.sensors.gyroscope.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = GyroState.OFF;

    // Configuración
    this.rangeDps        = GyroRange.DPS_2000;
    this.sampleRateHz    = 100;
    this.enabled         = true;
    this.lowPowerMode    = false;

    // Muestra actual (°/s)
    this.current = { x: 0, y: 0, z: 0 };
    this.filtered = { x: 0, y: 0, z: 0 };

    // Bias y calibración
    this.bias   = { ...INITIAL_BIAS };
    this.scale  = { x: 1, y: 1, z: 1 };
    this.calibration = {
      calibrated:    false,
      calibratedAt:  null,
      autoCalibrate: true,
      stillnessMs:   0,          // tiempo acumulado en reposo
      samplesForCal: 200,        // muestras necesarias
      collected:     { x: 0, y: 0, z: 0 },
      collectedCount:0,
    };

    // Actitud (pitch/roll/yaw)
    this.attitude = new AttitudeEstimator();

    // Estabilidad
    this.steadiness = SteadinessLevel.STEADY;
    this.steadinessSince = Date.now();

    // Detección de spin
    this.spin = {
      active:    false,
      direction: SpinDirection.NONE,
      since:     null,
      peakDps:   0,
      lastTs:    null,
    };

    // Detección de gestos
    this.gestures = {
      lastGesture:    null,
      lastGestureTs:  null,
    };

    // Temperatura del chip (afecta al drift)
    this.tempC = 30;

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
    this.rotationSubscribers  = new Set();
    this.attitudeSubscribers  = new Set();
    this.steadinessSubscribers= new Set();
    this.spinSubscribers      = new Set();
    this.gestureSubscribers   = new Set();

    // Loop
    this.tickId = null;
    this.tickIntervalMs = Math.max(1, Math.round(1000 / this.sampleRateHz));

    // Ventanas internas para detección
    this._steadyStart = Date.now();
    this._spinStart = null;
    this._lastSteadinessCheck = 0;

    // Métricas
    this.metrics = {
      samplesTaken:       0,
      spinsDetected:      0,
      gesturesDetected:   0,
      steadinessChanges:  0,
      calibrations:       0,
      autoCalibrations:   0,
      peakDps:            0,
      errors:             0,
      startedAt:          null,
    };

    // Consumo energético (mW)
    this.currentPowerMw = 0;

    logger.kernel('VGyroscope',
      `creado: ${this.model} (±${this.rangeDps}°/s, ${this.sampleRateHz}Hz)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this.state = GyroState.READY;
    this._startTickLoop();

    logger.info('VGyroscope',
      `✓ init: ${this.model}, ±${this.rangeDps}°/s, ${this.sampleRateHz}Hz`);
    this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
      source: 'vgyro', event: 'ready',
    }, 'vgyro');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.state = GyroState.SAMPLING;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    this.state = GyroState.OFF;
    this.currentPowerMw = 0;
    logger.info('VGyroscope', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const now = Date.now();
    const dtSec = this.tickIntervalMs / 1000;

    // 1) Actualizar temperatura (ligeramente sube con uso, se enfría)
    this.tempC = clamp(this.tempC + (Math.random() - 0.48) * 0.05, 25, 45);

    // 2) Generar muestra simulada
    const raw = this._simulateSample(dtSec);

    // 3) Aplicar bias + drift
    const drift = driftFactor(this.tempC);
    const biased = {
      x: raw.x + this.bias.x * drift,
      y: raw.y + this.bias.y * drift,
      z: raw.z + this.bias.z * drift,
    };

    // 4) Aplicar escala
    const scaled = {
      x: biased.x * this.scale.x,
      y: biased.y * this.scale.y,
      z: biased.z * this.scale.z,
    };

    // 5) Filtro paso-bajo suave
    const alpha = 0.35;
    this.filtered.x = this.filtered.x + alpha * (scaled.x - this.filtered.x);
    this.filtered.y = this.filtered.y + alpha * (scaled.y - this.filtered.y);
    this.filtered.z = this.filtered.z + alpha * (scaled.z - this.filtered.z);
    this.current = { ...this.filtered };

    // 6) Trackear pico
    const mag = Math.hypot(this.current.x, this.current.y, this.current.z);
    if (mag > this.metrics.peakDps) this.metrics.peakDps = mag;

    // 7) Auto-calibración si estamos quietos
    if (this.calibration.autoCalibrate) {
      this._tryAutoCalibrate(mag, raw);
    }

    // 8) Actualizar actitud (fusión con acelerómetro)
    const accel = this.bus?.devices?.accel?.gravity || { x: 0, y: 0, z: -1 };
    this.attitude.update(this.current, accel);

    // 9) Detectar estabilidad
    this._detectSteadiness(now, mag);

    // 10) Detectar spin
    this._detectSpin(now, mag);

    // 11) Detectar gestos
    this._detectGestures(now);

    // 12) Push history
    this._pushHistory(now);

    // 13) Throughput
    this._updateThroughput(now);

    // 14) Consumo
    this.currentPowerMw = (powerMicroAmp(this.sampleRateHz) * 3.7) / 1000;

    // 15) Emit
    this._emit();

    this.metrics.samplesTaken++;
    this.throughput.samplesTotal++;
  }

  _simulateSample(dtSec) {
    // Base: casi nada (reposo) con algo de ruido
    const r = () => (Math.random() - 0.5) * 2 * NOISE_DPS_RMS;

    let baseX = 0, baseY = 0, baseZ = 0;

    // Si hay spin activo, movemos según su dirección
    if (this.spin.active) {
      const t = Date.now() / 1000;
      const amp = this.spin.peakDps * 0.7;
      switch (this.spin.direction) {
        case SpinDirection.RIGHT: baseY = Math.sin(2 * Math.PI * 3 * t) * amp; break;
        case SpinDirection.LEFT:  baseY = -Math.sin(2 * Math.PI * 3 * t) * amp; break;
        case SpinDirection.UP:    baseX = Math.sin(2 * Math.PI * 3 * t) * amp; break;
        case SpinDirection.DOWN:  baseX = -Math.sin(2 * Math.PI * 3 * t) * amp; break;
        case SpinDirection.TWIST: baseZ = Math.sin(2 * Math.PI * 4 * t) * amp; break;
        case SpinDirection.FLIP:  baseX = Math.sin(2 * Math.PI * 2 * t) * amp; break;
      }
    }

    // Si estamos en modo "movimiento manual" (para tests), respetamos
    if (this._manualMotion) {
      baseX += this._manualMotion.x || 0;
      baseY += this._manualMotion.y || 0;
      baseZ += this._manualMotion.z || 0;
      // Decrecer poco a poco
      const decay = 0.95;
      this._manualMotion.x *= decay;
      this._manualMotion.y *= decay;
      this._manualMotion.z *= decay;
      if (Math.hypot(this._manualMotion.x, this._manualMotion.y, this._manualMotion.z) < 0.1) {
        this._manualMotion = null;
      }
    }

    // Oscilación muy leve de fondo (como si el usuario respirara)
    const t = Date.now() / 1000;
    baseX += Math.sin(2 * Math.PI * 0.15 * t) * 0.4;
    baseY += Math.sin(2 * Math.PI * 0.18 * t + 1.2) * 0.4;

    return {
      x: baseX + r(),
      y: baseY + r(),
      z: baseZ + r(),
    };
  }

  _tryAutoCalibrate(magDps, raw) {
    // Solo calibrar si magnitud está por debajo del umbral de steady
    if (magDps < TH.STEADY_DPS * 3) {
      const c = this.calibration.collected;
      c.x += raw.x; c.y += raw.y; c.z += raw.z;
      this.calibration.collectedCount++;

      if (this.calibration.collectedCount >= this.calibration.samplesForCal) {
        // Media = bias estimado
        const n = this.calibration.collectedCount;
        this.bias.x = c.x / n;
        this.bias.y = c.y / n;
        this.bias.z = c.z / n;
        this.calibration.calibrated = true;
        this.calibration.calibratedAt = Date.now();
        this.calibration.collected = { x: 0, y: 0, z: 0 };
        this.calibration.collectedCount = 0;
        this.metrics.autoCalibrations++;
        logger.debug('VGyroscope',
          `auto-calibrado (bias: ${this.bias.x.toFixed(3)}, ${this.bias.y.toFixed(3)}, ${this.bias.z.toFixed(3)})`);
      }
    } else {
      // Nos movemos: descartamos lo recolectado
      this.calibration.collected = { x: 0, y: 0, z: 0 };
      this.calibration.collectedCount = 0;
    }
  }

  _detectSteadiness(now, magDps) {
    let newLevel;
    if (magDps < TH.STEADY_DPS)      newLevel = SteadinessLevel.STEADY;
    else if (magDps < TH.SLIGHT_DPS) newLevel = SteadinessLevel.SLIGHT;
    else if (magDps < TH.MODERATE_DPS) newLevel = SteadinessLevel.MODERATE;
    else if (magDps < TH.FAST_DPS)   newLevel = SteadinessLevel.FAST;
    else                             newLevel = SteadinessLevel.VERY_FAST;

    if (newLevel !== this.steadiness) {
      const prev = this.steadiness;
      this.steadiness = newLevel;
      this.steadinessSince = now;
      this.metrics.steadinessChanges++;
      logger.debug('VGyroscope', `estabilidad: ${prev} → ${newLevel} (${magDps.toFixed(1)}°/s)`);
      for (const fn of this.steadinessSubscribers) {
        try { fn({ level: newLevel, prev, magnitude: magDps }); } catch (_) {}
      }
    }
  }

  _detectSpin(now, magDps) {
    const spinning = magDps >= TH.SPIN_MIN_DPS;

    if (spinning && !this.spin.active) {
      // Inicio de un posible spin
      if (!this._spinStart) this._spinStart = now;
      if (now - this._spinStart >= TH.SPIN_DURATION_MS) {
        // Confirmar spin
        this.spin.active = true;
        this.spin.since = this._spinStart;
        this.spin.peakDps = magDps;
        this.spin.lastTs = now;
        this.spin.direction = this._classifySpinDirection();
        this.metrics.spinsDetected++;
        logger.info('VGyroscope', `🌀 spin ${this.spin.direction} (${magDps.toFixed(0)}°/s)`);
        for (const fn of this.spinSubscribers) {
          try { fn({ type: 'start', direction: this.spin.direction, magnitude: magDps }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_MOTION', {
          source: 'vgyro', event: 'spin', direction: this.spin.direction,
        }, 'vgyro');
      }
    } else if (spinning && this.spin.active) {
      // Actualizar pico
      if (magDps > this.spin.peakDps) this.spin.peakDps = magDps;
      this.spin.lastTs = now;
    } else if (!spinning && this.spin.active) {
      // Fin del spin (solo si ha bajado claramente)
      if (magDps < TH.SPIN_MIN_DPS * 0.4) {
        const peak = this.spin.peakDps;
        const dir = this.spin.direction;
        this.spin.active = false;
        this.spin.direction = SpinDirection.NONE;
        this._spinStart = null;
        for (const fn of this.spinSubscribers) {
          try { fn({ type: 'end', direction: dir, peak }); } catch (_) {}
        }
      }
    } else {
      this._spinStart = null;
    }
  }

  _classifySpinDirection() {
    const g = this.current;
    const absX = Math.abs(g.x);
    const absY = Math.abs(g.y);
    const absZ = Math.abs(g.z);

    // Si el giro principal es sobre Z → twist
    if (absZ > absX && absZ > absY && absZ > 300) {
      return SpinDirection.TWIST;
    }
    // Si es sobre X → flip / vertical
    if (absX > absY) {
      // Flip si supera 500°/s en X
      if (absX > 500) return SpinDirection.FLIP;
      return g.x > 0 ? SpinDirection.UP : SpinDirection.DOWN;
    }
    // Sobre Y → rotación horizontal
    return g.y > 0 ? SpinDirection.RIGHT : SpinDirection.LEFT;
  }

  _detectGestures(now) {
    // Un gesto es un spin corto y con un patrón específico
    if (!this.spin.active) return;

    const since = now - this.spin.since;
    if (since > TH.GESTURE_MAX_MS) return;

    // Evitamos repetir gestos en un corto espacio
    if (this.gestures.lastGestureTs && now - this.gestures.lastGestureTs < 500) return;

    // Si llevamos poco y hay dirección clara, es un gesto
    const dir = this.spin.direction;
    if (dir === SpinDirection.NONE) return;

    let gestureName = null;
    switch (dir) {
      case SpinDirection.LEFT:  gestureName = 'rotate-left'; break;
      case SpinDirection.RIGHT: gestureName = 'rotate-right'; break;
      case SpinDirection.UP:    gestureName = 'rotate-up'; break;
      case SpinDirection.DOWN:  gestureName = 'rotate-down'; break;
      case SpinDirection.TWIST: gestureName = 'twist'; break;
      case SpinDirection.FLIP:  gestureName = 'flip'; break;
    }
    if (!gestureName) return;

    this.gestures.lastGesture = gestureName;
    this.gestures.lastGestureTs = now;
    this.metrics.gesturesDetected++;

    logger.debug('VGyroscope', `gesto: ${gestureName}`);
    for (const fn of this.gestureSubscribers) {
      try { fn({ gesture: gestureName, magnitude: this.spin.peakDps }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_MOTION', {
      source: 'vgyro', event: 'gesture', gesture: gestureName,
    }, 'vgyro');
  }

  _pushHistory(now) {
    this.history.push({
      ts: now,
      x:  parseFloat(this.current.x.toFixed(3)),
      y:  parseFloat(this.current.y.toFixed(3)),
      z:  parseFloat(this.current.z.toFixed(3)),
      mag:parseFloat(Math.hypot(this.current.x, this.current.y, this.current.z).toFixed(3)),
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

  setRange(rangeDps) {
    if (!Object.values(GyroRange).includes(rangeDps)) {
      logger.warn('VGyroscope', `rango inválido: ${rangeDps}`);
      return false;
    }
    this.rangeDps = rangeDps;
    logger.info('VGyroscope', `rango: ±${rangeDps}°/s`);
    this._emit();
    return true;
  }

  setSampleRate(hz) {
    hz = clamp(Math.round(hz), 1, 800);
    if (hz === this.sampleRateHz) return true;
    this.sampleRateHz = hz;
    this.tickIntervalMs = Math.max(1, Math.round(1000 / hz));
    if (this.running) {
      clearInterval(this.tickId);
      this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
    }
    logger.info('VGyroscope', `sample rate: ${hz}Hz`);
    this._emit();
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled && this.running) this.shutdown();
    else if (this.enabled && !this.running) this._startTickLoop();
    this._emit();
  }

  setLowPowerMode(on) {
    this.lowPowerMode = !!on;
    if (on) this.setSampleRate(Math.min(this.sampleRateHz, 10));
  }

  // ═══════════════════════════════════════════════════════════
  // CALIBRACIÓN
  // ═══════════════════════════════════════════════════════════

  async calibrate({ durationMs = 1500 } = {}) {
    logger.info('VGyroscope', `calibrando durante ${durationMs}ms...`);
    this.calibration.collected = { x: 0, y: 0, z: 0 };
    this.calibration.collectedCount = 0;
    this.calibration.calibrating = true;

    await new Promise(r => setTimeout(r, durationMs));

    this.calibration.calibrating = false;
    if (this.calibration.collectedCount > 0) {
      const n = this.calibration.collectedCount;
      this.bias.x = this.calibration.collected.x / n;
      this.bias.y = this.calibration.collected.y / n;
      this.bias.z = this.calibration.collected.z / n;
      this.calibration.calibrated = true;
      this.calibration.calibratedAt = Date.now();
      this.metrics.calibrations++;
      logger.info('VGyroscope',
        `✓ calibrado: bias=(${this.bias.x.toFixed(4)}, ${this.bias.y.toFixed(4)}, ${this.bias.z.toFixed(4)})`);
    } else {
      logger.warn('VGyroscope', 'calibración fallida: sin muestras');
    }
    this._emit();
    return this.calibration.calibrated;
  }

  resetBias() {
    this.bias = { x: 0, y: 0, z: 0 };
    this.calibration.calibrated = false;
    this.calibration.calibratedAt = null;
    this._emit();
  }

  resetAttitude() {
    this.attitude.reset();
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // SIMULACIÓN
  // ═══════════════════════════════════════════════════════════

  /**
   * Aplica un vector de rotación durante un tiempo.
   */
  applyRotation({ x = 0, y = 0, z = 0, durationMs = 500 } = {}) {
    this._manualMotion = { x, y, z };
    if (durationMs > 0) {
      setTimeout(() => { this._manualMotion = null; }, durationMs);
    }
    logger.debug('VGyroscope',
      `rotación manual aplicada: (${x}, ${y}, ${z}) °/s durante ${durationMs}ms`);
    return true;
  }

  /**
   * Fuerza la detección de un spin.
   */
  simulateSpin(direction = SpinDirection.RIGHT, magnitude = 600, durationMs = 400) {
    this.spin.active = true;
    this.spin.direction = direction;
    this.spin.since = Date.now();
    this.spin.peakDps = magnitude;
    this.spin.lastTs = Date.now();
    this.metrics.spinsDetected++;
    for (const fn of this.spinSubscribers) {
      try { fn({ type: 'start', direction, magnitude }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_MOTION', {
      source: 'vgyro', event: 'spin', direction,
    }, 'vgyro');
    if (durationMs > 0) {
      setTimeout(() => {
        this.spin.active = false;
        this.spin.direction = SpinDirection.NONE;
        for (const fn of this.spinSubscribers) {
          try { fn({ type: 'end', direction, peak: magnitude }); } catch (_) {}
        }
      }, durationMs);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  getSample() {
    const mag = Math.hypot(this.current.x, this.current.y, this.current.z);
    return {
      ts:        Date.now(),
      x:         parseFloat(this.current.x.toFixed(4)),
      y:         parseFloat(this.current.y.toFixed(4)),
      z:         parseFloat(this.current.z.toFixed(4)),
      magnitude: parseFloat(mag.toFixed(4)),
      radPerSec: {
        x: parseFloat(rad(this.current.x).toFixed(5)),
        y: parseFloat(rad(this.current.y).toFixed(5)),
        z: parseFloat(rad(this.current.z).toFixed(5)),
      },
    };
  }

  getAttitude() {
    return this.attitude.get();
  }

  getSteadiness() {
    return this.steadiness;
  }

  isSpinning() {
    return this.spin.active;
  }

  getSpinInfo() {
    return {
      active:    this.spin.active,
      direction: this.spin.direction,
      since:     this.spin.since,
      peakDps:   parseFloat(this.spin.peakDps.toFixed(2)),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onRotation(fn) {
    this.rotationSubscribers.add(fn);
    return () => this.rotationSubscribers.delete(fn);
  }

  onAttitude(fn) {
    this.attitudeSubscribers.add(fn);
    return () => this.attitudeSubscribers.delete(fn);
  }

  onSteadiness(fn) {
    this.steadinessSubscribers.add(fn);
    return () => this.steadinessSubscribers.delete(fn);
  }

  onSpin(fn) {
    this.spinSubscribers.add(fn);
    return () => this.spinSubscribers.delete(fn);
  }

  onGesture(fn) {
    this.gestureSubscribers.add(fn);
    return () => this.gestureSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VGyroscope', `subscriber falló: ${err.message}`, err);
      }
    }
    // Notificar attitude a sus suscriptores
    if (this.attitudeSubscribers.size > 0) {
      const a = this.getAttitude();
      for (const fn of this.attitudeSubscribers) {
        try { fn(a); } catch (_) {}
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:        this.model,
      state:        this.state,
      rangeDps:     this.rangeDps,
      sampleRateHz: this.sampleRateHz,
      actualHz:     this.throughput.actualHz,
      sample:       this.getSample(),
      attitude:     this.getAttitude(),
      steadiness:   this.steadiness,
      spin:         this.getSpinInfo(),
      calibrated:   this.calibration.calibrated,
      tempC:        parseFloat(this.tempC.toFixed(1)),
      powerMw:      parseFloat(this.currentPowerMw.toFixed(3)),
      lastGesture:  this.gestures.lastGesture,
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
      calibration: { ...this.calibration },
      bias:        { ...this.bias },
    };
  }

  dump() {
    const s = this.getStats();
    const sample = this.getSample();
    const att = this.getAttitude();
    const lines = [
      `VGyroscope [${s.state}] — ${s.model}`,
      `  rango:       ±${this.rangeDps}°/s`,
      `  sample rate: ${this.sampleRateHz}Hz (actual ${this.throughput.actualHz}Hz)`,
      `  muestra:     x=${sample.x} y=${sample.y} z=${sample.z} (|ω|=${sample.magnitude}°/s)`,
      `  attitude:    pitch=${att.pitch}° roll=${att.roll}° yaw=${att.yaw}°`,
      `  estabilidad: ${this.steadiness}`,
      `  spin:        ${this.spin.active ? `sí (${this.spin.direction}, ${this.spin.peakDps.toFixed(0)}°/s)` : 'no'}`,
      `  bias:        (${this.bias.x.toFixed(4)}, ${this.bias.y.toFixed(4)}, ${this.bias.z.toFixed(4)})`,
      `  calibrado:   ${this.calibration.calibrated}`,
      `  temperatura: ${this.tempC.toFixed(1)}°C`,
      `  gestos:      ${s.metrics.gesturesDetected} detectados (último: ${this.gestures.lastGesture || '—'})`,
      `  pico:        ${s.metrics.peakDps.toFixed(0)}°/s`,
      `  consumo:     ${this.currentPowerMw.toFixed(3)}mW`,
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
