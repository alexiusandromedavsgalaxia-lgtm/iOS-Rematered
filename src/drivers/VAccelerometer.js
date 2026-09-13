// src/drivers/VAccelerometer.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VAccelerometer (Virtual Accelerometer)
 * ═══════════════════════════════════════════════════════════════
 *
 * Acelerómetro MEMS de 3 ejes. Modela el sensor que un iPhone lleva
 * para rotación de pantalla, podómetro, detección de caídas, shake,
 * y todas las features de Core Motion.
 *
 * Responsabilidades:
 *   - 3 ejes X/Y/Z con rango ±2g, ±4g, ±8g, ±16g configurable
 *   - Sample rate dinámico (1 Hz a 800 Hz)
 *   - Gravedad y aceleración lineal separadas
 *   - Filtro paso-bajo digital para suavizado
 *   - Detección de orientación:
 *       · portrait / landscape-left / landscape-right / portrait-upside-down
 *       · face-up / face-down
 *   - Detección de shake (con magnitud y dirección)
 *   - Detección de tilt (ángulo respecto a la gravedad)
 *   - Detección de free-fall (caída libre)
 *   - Detección de impacto / colisión
 *   - Podómetro (step counter) con detección de pico y cadencia
 *   - Clasificador de actividad: stationary / walking / running /
 *     cycling / automotive / unknown
 *   - Calibración con bias (offset) y matriz de escala
 *   - Historial circular de muestras (útil para gráficos)
 *   - Suscriptores configurables por frecuencia
 *   - IRQ_MOTION con eventos de cambio brusco
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const AccelState = {
  OFF:      'off',
  READY:    'ready',
  SAMPLING: 'sampling',
  ERROR:    'error',
};

export const AccelRange = {
  G_2:  2,
  G_4:  4,
  G_8:  8,
  G_16: 16,
};

export const Orientation = {
  PORTRAIT:          'portrait',
  LANDSCAPE_LEFT:    'landscape-left',
  LANDSCAPE_RIGHT:   'landscape-right',
  PORTRAIT_UPSIDE:   'portrait-upside-down',
  FACE_UP:           'face-up',
  FACE_DOWN:         'face-down',
  UNKNOWN:           'unknown',
};

export const Activity = {
  STATIONARY: 'stationary',
  WALKING:    'walking',
  RUNNING:    'running',
  CYCLING:    'cycling',
  AUTOMOTIVE: 'automotive',
  UNKNOWN:    'unknown',
};

// Constantes físicas
const GRAVITY_MS2 = 9.80665;
const G_TO_MS2    = GRAVITY_MS2;

// Umbrales (en g)
const THRESHOLDS = {
  SHAKE_G:           2.2,   // pico de magnitud para shake
  SHAKE_DURATION_MS: 250,   // ventana
  FREEFALL_G:        0.3,   // magnitud < esto = caída libre
  FREEFALL_MIN_MS:   120,   // duración mínima
  IMPACT_G:          5.0,   // pico para impacto
  TILT_MIN_DEG:      15,    // cambio de tilt para evento
  STILL_MAX_G:       0.02,  // varianza máxima para "still"
};

// Cadencia de pasos por actividad (pasos/minuto)
const STEP_CADENCE = {
  [Activity.STATIONARY]: 0,
  [Activity.WALKING]:    100,
  [Activity.RUNNING]:    160,
  [Activity.CYCLING]:    0,
  [Activity.AUTOMOTIVE]: 0,
  [Activity.UNKNOWN]:    0,
};

// Consumo por sample rate (μA) — aproximado
function powerMicroAmp(hz) {
  // El sensor real consume ~10 μA a 1 Hz hasta ~500 μA a 800 Hz
  return 10 + (hz / 800) * 490;
}

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randRange = (a, b) => a + Math.random() * (b - a);
const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// ───────────────────────────────────────────────────────────────
// Filtro paso bajo exponencial (EMA de 1er orden)
// ───────────────────────────────────────────────────────────────
class LowPassFilter {
  constructor(alpha = 0.2) {
    this.alpha = alpha;
    this.state = { x: 0, y: 0, z: 0 };
    this.initialized = false;
  }

  apply(sample) {
    if (!this.initialized) {
      this.state = { ...sample };
      this.initialized = true;
      return { ...sample };
    }
    this.state.x = this.state.x + this.alpha * (sample.x - this.state.x);
    this.state.y = this.state.y + this.alpha * (sample.y - this.state.y);
    this.state.z = this.state.z + this.alpha * (sample.z - this.state.z);
    return { ...this.state };
  }

  setAlpha(a) { this.alpha = clamp(a, 0.01, 1.0); }
  reset() { this.initialized = false; this.state = { x: 0, y: 0, z: 0 }; }
}

// ───────────────────────────────────────────────────────────────
// SampleBuffer — buffer circular de muestras
// ───────────────────────────────────────────────────────────────
class SampleBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(sample) {
    this.buffer[this.head] = sample;
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
// VAccelerometer — driver completo
// ───────────────────────────────────────────────────────────────
export class VAccelerometer {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VAccelerometer';
    this.model = DEVICE_MODEL.sensors.accelerometer.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = AccelState.OFF;

    // Configuración
    this.rangeG          = AccelRange.G_16;   // rango seleccionable
    this.sampleRateHz    = 100;               // 1 a 800
    this.enabled         = true;
    this.lowPowerMode    = false;

    // Muestra actual (en g)
    this.current = { x: 0, y: 0, z: -1 };     // -1 g en Z = típico reposo
    this.gravity = { x: 0, y: 0, z: -1 };     // gravedad estimada
    this.linear  = { x: 0, y: 0, z: 0 };      // aceleración sin gravedad

    // Filtro paso-bajo
    this.filter = new LowPassFilter(0.15);

    // Calibración
    this.bias   = { x: 0, y: 0, z: 0 };
    this.scale  = { x: 1, y: 1, z: 1 };
    this.calibration = {
      calibrated:    false,
      calibratedAt:  null,
      noiseG:        0.008,     // ruido del sensor (g)
      biasG:         { x: 0, y: 0, z: 0 },
    };

    // Orientación detectada
    this.orientation = Orientation.FACE_UP;

    // Actividad detectada
    this.activity = Activity.STATIONARY;
    this.activitySince = Date.now();

    // Podómetro
    this.steps = {
      total:        0,
      today:        0,
      lastResetTs:  Date.now(),
      cadenceSpm:   0,          // steps per minute
      lastStepTs:   0,
      walkingDistanceM: 0,
    };

    // Detección de eventos
    this.detection = {
      shake:       false,
      shakeIntensity: 0,
      lastShakeTs: null,
      freeFall:    false,
      freeFallStart: null,
      impact:      false,
      lastImpactTs: null,
      peakG:       0,
    };

    // Historial de muestras
    this.historySize = 600;    // ~6 s a 100 Hz
    this.history = new SampleBuffer(this.historySize);

    // Estadísticas por segundo
    this.throughput = {
      samplesLastSec: 0,
      samplesTotal:   0,
      lastSecondTs:   Date.now(),
      actualHz:       0,
    };

    // Suscriptores
    this.subscribers           = new Set();
    this.orientationSubscribers= new Set();
    this.activitySubscribers   = new Set();
    this.stepSubscribers       = new Set();
    this.motionSubscribers     = new Set();

    // Loop
    this.tickId = null;
    this.tickIntervalMs = Math.max(1, Math.round(1000 / this.sampleRateHz));

    // Detección interna (ventana deslizante para peak detection)
    this._peakWindow = [];
    this._lastOrientationCheck = 0;
    this._lastActivityCheck = 0;
    this._freeFallStart = null;
    this._shakeStart = null;

    // Métricas
    this.metrics = {
      samplesTaken:       0,
      shakeEvents:        0,
      freeFallEvents:     0,
      impactEvents:       0,
      orientationChanges: 0,
      activityChanges:    0,
      stepsDetected:      0,
      calibrationCount:   0,
      errors:             0,
      startedAt:          null,
    };

    // Consumo energético (mW)
    this.currentPowerMw = 0;

    logger.kernel('VAccelerometer',
      `creado: ${this.model} (${this.rangeG}g, ${this.sampleRateHz}Hz)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this.state = AccelState.READY;
    this._startTickLoop();

    // Simular calibración inicial automática
    this.calibrate({ silent: true });

    logger.info('VAccelerometer',
      `✓ init: ${this.model}, ±${this.rangeG}g, ${this.sampleRateHz}Hz`);
    this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
      source: 'vaccel', event: 'ready',
    }, 'vaccel');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.state = AccelState.SAMPLING;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    this.state = AccelState.OFF;
    this.currentPowerMw = 0;
    logger.info('VAccelerometer', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const now = Date.now();
    const dtSec = this.tickIntervalMs / 1000;

    // 1) Generar muestra simulada
    const sample = this._simulateSample(dtSec);

    // 2) Aplicar calibración
    const calibrated = {
      x: (sample.x - this.bias.x) * this.scale.x,
      y: (sample.y - this.bias.y) * this.scale.y,
      z: (sample.z - this.bias.z) * this.scale.z,
    };

    // 3) Filtro paso-bajo (para estabilizar)
    const filtered = this.filter.apply(calibrated);
    this.current = filtered;

    // 4) Estimar gravedad (filtro paso-bajo muy suave)
    const gAlpha = 0.05;
    this.gravity.x = this.gravity.x * (1 - gAlpha) + filtered.x * gAlpha;
    this.gravity.y = this.gravity.y * (1 - gAlpha) + filtered.y * gAlpha;
    this.gravity.z = this.gravity.z * (1 - gAlpha) + filtered.z * gAlpha;

    // 5) Aceleración lineal = muestra - gravedad
    this.linear.x = filtered.x - this.gravity.x;
    this.linear.y = filtered.y - this.gravity.y;
    this.linear.z = filtered.z - this.gravity.z;

    // 6) Detección de orientación
    this._detectOrientation(now);

    // 7) Detección de actividad
    this._detectActivity(now, dtSec);

    // 8) Podómetro
    this._updateStepCounter(now, dtSec);

    // 9) Detección de shake, free-fall, impacto
    this._detectMotionEvents(now, dtSec);

    // 10) Añadir al historial
    this._pushHistory(now);

    // 11) Actualizar throughput
    this._updateThroughput(now);

    // 12) Actualizar consumo
    this.currentPowerMw = (powerMicroAmp(this.sampleRateHz) * 3.7) / 1000;

    // 13) Notificar suscriptores
    this._emit();

    this.metrics.samplesTaken++;
    this.throughput.samplesTotal++;
  }

  _simulateSample(dtSec) {
    const noise = this.calibration.noiseG;
    const bias  = this.calibration.biasG;

    // Base: gravedad según orientación + ruido + movimiento si camina
    let baseX = 0, baseY = 0, baseZ = -1;

    // Si estamos caminando, añadimos movimiento oscilatorio
    if (this.activity === Activity.WALKING || this.activity === Activity.RUNNING) {
      const cadence = STEP_CADENCE[this.activity] / 60;   // Hz
      const t = Date.now() / 1000;
      const amp = this.activity === Activity.RUNNING ? 0.9 : 0.35;
      baseY += Math.sin(2 * Math.PI * cadence * t) * amp;
      baseZ += Math.cos(2 * Math.PI * cadence * t) * amp * 0.5;
    } else if (this.activity === Activity.AUTOMOTIVE) {
      // Vibración de motor
      const t = Date.now() / 1000;
      baseX += Math.sin(2 * Math.PI * 25 * t) * 0.05;
      baseY += Math.sin(2 * Math.PI * 27 * t) * 0.05;
    }

    // Movimiento residual si alguien lo provoca (shake activo)
    if (this.detection.shake) {
      const t = Date.now() / 1000;
      baseX += Math.sin(2 * Math.PI * 8 * t) * this.detection.shakeIntensity;
      baseY += Math.sin(2 * Math.PI * 11 * t) * this.detection.shakeIntensity;
      baseZ += Math.sin(2 * Math.PI * 13 * t) * this.detection.shakeIntensity;
    }

    // Caída libre: magnitud cercana a 0
    if (this.detection.freeFall) {
      baseX *= 0.05;
      baseY *= 0.05;
      baseZ *= 0.05;
    }

    // Ruido gaussiano aproximado
    const r = () => (Math.random() - 0.5) * 2 * noise;

    return {
      x: baseX + bias.x + r(),
      y: baseY + bias.y + r(),
      z: baseZ + bias.z + r(),
    };
  }

  _detectOrientation(now) {
    // Solo chequeamos cada 100 ms para no rebotar
    if (now - this._lastOrientationCheck < 100) return;
    this._lastOrientationCheck = now;

    const g = this.gravity;
    const mag = Math.hypot(g.x, g.y, g.z);
    if (mag < 0.5) return;

    // Normalizamos
    const nx = g.x / mag;
    const ny = g.y / mag;
    const nz = g.z / mag;

    let orientation = this.orientation;

    // Determinar orientación según el eje con mayor componente
    const absZ = Math.abs(nz);
    const absX = Math.abs(nx);
    const absY = Math.abs(ny);

    if (absZ > 0.75) {
      // Dispositivo plano: cara arriba o abajo
      orientation = nz < 0 ? Orientation.FACE_UP : Orientation.FACE_DOWN;
    } else if (absX > absY) {
      // Portrait o portrait-upside
      orientation = nx < 0 ? Orientation.PORTRAIT : Orientation.PORTRAIT_UPSIDE;
    } else {
      // Landscape
      orientation = ny > 0 ? Orientation.LANDSCAPE_LEFT : Orientation.LANDSCAPE_RIGHT;
    }

    if (orientation !== this.orientation) {
      const prev = this.orientation;
      this.orientation = orientation;
      this.metrics.orientationChanges++;
      logger.debug('VAccelerometer', `orientación: ${prev} → ${orientation}`);

      for (const fn of this.orientationSubscribers) {
        try { fn({ orientation, prev }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_SENSOR', {
        source: 'vaccel', event: 'orientation-changed', orientation, prev,
      }, 'vaccel');
    }
  }

  _detectActivity(now, dtSec) {
    // Solo cada 1s
    if (now - this._lastActivityCheck < 1000) return;
    this._lastActivityCheck = now;

    const lin = this.linear;
    const linMag = Math.hypot(lin.x, lin.y, lin.z);
    const cadence = this.steps.cadenceSpm;

    let newActivity = this.activity;

    if (linMag < 0.03 && cadence < 5) {
      newActivity = Activity.STATIONARY;
    } else if (cadence >= 140) {
      newActivity = Activity.RUNNING;
    } else if (cadence >= 60) {
      newActivity = Activity.WALKING;
    } else if (linMag > 0.15 && this._isLowFrequencyMotion()) {
      // Movimiento rápido y frecuente pero sin pasos → probable coche
      newActivity = Activity.AUTOMOTIVE;
    } else if (linMag > 0.05 && cadence < 20) {
      // Movimiento ligero sin pasos → quizás bicicleta
      newActivity = Activity.CYCLING;
    } else {
      newActivity = Activity.UNKNOWN;
    }

    if (newActivity !== this.activity) {
      const prev = this.activity;
      this.activity = newActivity;
      this.activitySince = now;
      this.metrics.activityChanges++;
      logger.info('VAccelerometer', `actividad: ${prev} → ${newActivity}`);

      for (const fn of this.activitySubscribers) {
        try { fn({ activity: newActivity, prev, since: this.activitySince }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_MOTION', {
        source: 'vaccel', event: 'activity-changed', activity: newActivity, prev,
      }, 'vaccel');
    }
  }

  _isLowFrequencyMotion() {
    // Baja frecuencia: poca varianza en la muestra pero magnitud alta
    const recent = this.history.last(20);
    if (recent.length < 10) return false;
    const mags = recent.map(s => Math.hypot(s.x, s.y, s.z));
    const avg = mags.reduce((a, b) => a + b, 0) / mags.length;
    const variance = mags.reduce((a, m) => a + (m - avg) ** 2, 0) / mags.length;
    return variance < 0.05;   // poca varianza → no son pasos
  }

  _updateStepCounter(now, dtSec) {
    // Solo añadimos pasos si la actividad implica caminar / correr
    const cadence = STEP_CADENCE[this.activity] || 0;
    if (cadence === 0) {
      this.steps.cadenceSpm = this.steps.cadenceSpm * 0.9;
      return;
    }

    // Suavizamos la cadencia hacia la objetivo
    this.steps.cadenceSpm = this.steps.cadenceSpm * 0.85 + cadence * 0.15;

    // Añadir pasos según dt
    const stepsToAdd = (this.steps.cadenceSpm / 60) * dtSec;
    const prevWhole = Math.floor(this.steps.today);
    this.steps.today += stepsToAdd;
    this.steps.total += stepsToAdd;

    // Distancia caminada: ~0.75 m por paso caminando, ~1.2 m corriendo
    const strideM = this.activity === Activity.RUNNING ? 1.2 : 0.75;
    this.steps.walkingDistanceM += stepsToAdd * strideM;

    // Notificar cada paso entero
    const newWhole = Math.floor(this.steps.today);
    if (newWhole > prevWhole) {
      const delta = newWhole - prevWhole;
      for (let i = 0; i < delta; i++) {
        this.metrics.stepsDetected++;
        this.steps.lastStepTs = now;
        for (const fn of this.stepSubscribers) {
          try { fn({ total: Math.floor(this.steps.total), today: newWhole }); } catch (_) {}
        }
      }
      this.bus?.raiseInterrupt?.('IRQ_MOTION', {
        source: 'vaccel', event: 'step',
        total: Math.floor(this.steps.total),
        today: newWhole,
        cadence: parseFloat(this.steps.cadenceSpm.toFixed(1)),
      }, 'vaccel');
    }
  }

  _detectMotionEvents(now, dtSec) {
    const mag = Math.hypot(this.current.x, this.current.y, this.current.z);

    // Actualizamos el pico
    if (mag > this.detection.peakG) this.detection.peakG = mag;

    // ─── Shake ─────────────────────────────────────────────
    const shakeActive = this.detection.shake;
    if (mag > THRESHOLDS.SHAKE_G) {
      if (!this._shakeStart) this._shakeStart = now;
      // Evaluamos la ventana
      if (now - this._shakeStart <= THRESHOLDS.SHAKE_DURATION_MS) {
        if (!shakeActive) {
          this.detection.shake = true;
          this.detection.shakeIntensity = Math.min(1.0, (mag - THRESHOLDS.SHAKE_G) / 3.0);
          this.detection.lastShakeTs = now;
          this.metrics.shakeEvents++;
          logger.debug('VAccelerometer', `🤝 shake detectado (mag=${mag.toFixed(2)}g)`);
          for (const fn of this.motionSubscribers) {
            try { fn({ type: 'shake', magnitude: mag, intensity: this.detection.shakeIntensity }); } catch (_) {}
          }
          this.bus?.raiseInterrupt?.('IRQ_MOTION', {
            source: 'vaccel', event: 'shake', magnitude: parseFloat(mag.toFixed(2)),
          }, 'vaccel');
        }
      }
    } else {
      // Si la magnitud ha bajado, terminamos el shake
      if (shakeActive && mag < THRESHOLDS.SHAKE_G * 0.7) {
        this.detection.shake = false;
        this.detection.shakeIntensity = 0;
        this._shakeStart = null;
      }
    }

    // ─── Free-fall ─────────────────────────────────────────
    if (mag < THRESHOLDS.FREEFALL_G) {
      if (!this._freeFallStart) {
        this._freeFallStart = now;
      } else if (now - this._freeFallStart > THRESHOLDS.FREEFALL_MIN_MS && !this.detection.freeFall) {
        this.detection.freeFall = true;
        this.detection.freeFallStart = this._freeFallStart;
        this.metrics.freeFallEvents++;
        logger.warn('VAccelerometer', `🪂 free-fall detectado (mag=${mag.toFixed(2)}g)`);
        for (const fn of this.motionSubscribers) {
          try { fn({ type: 'free-fall', since: this._freeFallStart }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_MOTION', {
          source: 'vaccel', event: 'free-fall',
        }, 'vaccel');
      }
    } else {
      if (this.detection.freeFall) {
        this.detection.freeFall = false;
        this.detection.freeFallStart = null;
      }
      this._freeFallStart = null;
    }

    // ─── Impacto ───────────────────────────────────────────
    if (mag > THRESHOLDS.IMPACT_G) {
      // Solo si no ha sido hace poco
      const sinceLast = now - (this.detection.lastImpactTs || 0);
      if (sinceLast > 1000) {
        this.detection.impact = true;
        this.detection.lastImpactTs = now;
        this.metrics.impactEvents++;
        logger.warn('VAccelerometer', `💥 impacto detectado (mag=${mag.toFixed(2)}g)`);
        for (const fn of this.motionSubscribers) {
          try { fn({ type: 'impact', magnitude: mag }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_MOTION', {
          source: 'vaccel', event: 'impact', magnitude: parseFloat(mag.toFixed(2)),
        }, 'vaccel');
      }
    }
  }

  _pushHistory(now) {
    this.history.push({
      ts: now,
      x:  this.current.x,
      y:  this.current.y,
      z:  this.current.z,
      linX: this.linear.x,
      linY: this.linear.y,
      linZ: this.linear.z,
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

  setRange(rangeG) {
    if (!Object.values(AccelRange).includes(rangeG)) {
      logger.warn('VAccelerometer', `rango inválido: ${rangeG}`);
      return false;
    }
    this.rangeG = rangeG;
    logger.info('VAccelerometer', `rango: ±${rangeG}g`);
    this._emit();
    return true;
  }

  setSampleRate(hz) {
    hz = clamp(Math.round(hz), 1, 800);
    if (hz === this.sampleRateHz) return true;
    this.sampleRateHz = hz;
    this.tickIntervalMs = Math.max(1, Math.round(1000 / hz));

    // Reiniciar el loop con el nuevo intervalo
    if (this.running) {
      clearInterval(this.tickId);
      this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
    }
    logger.info('VAccelerometer', `sample rate: ${hz}Hz`);
    this._emit();
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled && this.running) {
      this.shutdown();
    } else if (this.enabled && !this.running) {
      this._startTickLoop();
    }
    this._emit();
  }

  setLowPowerMode(on) {
    this.lowPowerMode = !!on;
    if (this.lowPowerMode) {
      // En low power, bajamos el sample rate
      this.setSampleRate(Math.min(this.sampleRateHz, 10));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CALIBRACIÓN
  // ═══════════════════════════════════════════════════════════

  calibrate({ silent = false } = {}) {
    // Estimamos el bias a partir de la gravedad media (si el
    // dispositivo está quieto, la gravedad debería ser 1g)
    const now = Date.now();
    const bias = {
      x: (Math.random() - 0.5) * 0.01,
      y: (Math.random() - 0.5) * 0.01,
      z: (Math.random() - 0.5) * 0.01,
    };
    this.bias = { x: 0, y: 0, z: 0 };  // el bias se aplicará a las muestras
    this.calibration = {
      calibrated:   true,
      calibratedAt: now,
      noiseG:       this.calibration.noiseG,
      biasG:        bias,
    };
    this.metrics.calibrationCount++;
    if (!silent) {
      logger.info('VAccelerometer', `calibrado (bias=${JSON.stringify(bias)})`);
      this._emit();
    }
    return this.calibration;
  }

  resetCalibration() {
    this.calibration.calibrated = false;
    this.calibration.calibratedAt = null;
    this.calibration.biasG = { x: 0, y: 0, z: 0 };
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // PODÓMETRO
  // ═══════════════════════════════════════════════════════════

  resetStepCounter({ today = true, total = false } = {}) {
    if (today) {
      this.steps.today = 0;
      this.steps.lastResetTs = Date.now();
      logger.info('VAccelerometer', 'podómetro: reiniciado el contador diario');
    }
    if (total) {
      this.steps.total = 0;
      logger.info('VAccelerometer', 'podómetro: reiniciado el contador total');
    }
    this._emit();
    return true;
  }

  getStepCount() {
    return {
      total:      Math.floor(this.steps.total),
      today:      Math.floor(this.steps.today),
      cadenceSpm: parseFloat(this.steps.cadenceSpm.toFixed(1)),
      distanceM:  parseFloat(this.steps.walkingDistanceM.toFixed(1)),
      distanceKm: parseFloat((this.steps.walkingDistanceM / 1000).toFixed(3)),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SIMULACIÓN (para que las apps puedan probar features)
  // ═══════════════════════════════════════════════════════════

  /**
   * Fuerza la detección de un shake durante N ms.
   */
  simulateShake(durationMs = 500, intensity = 0.8) {
    this.detection.shake = true;
    this.detection.shakeIntensity = clamp(intensity, 0, 1);
    this.detection.lastShakeTs = Date.now();
    this.metrics.shakeEvents++;
    logger.info('VAccelerometer', `shake simulado (${durationMs}ms, intensidad ${intensity})`);
    setTimeout(() => {
      this.detection.shake = false;
      this.detection.shakeIntensity = 0;
    }, durationMs);
  }

  /**
   * Fuerza la actividad (útil para tests de podómetro).
   */
  simulateActivity(activity, durationMs = 5000) {
    if (!Object.values(Activity).includes(activity)) return false;
    const prev = this.activity;
    this.activity = activity;
    this.activitySince = Date.now();
    this.metrics.activityChanges++;
    for (const fn of this.activitySubscribers) {
      try { fn({ activity, prev, since: this.activitySince }); } catch (_) {}
    }
    if (durationMs > 0) {
      setTimeout(() => {
        this.activity = prev;
        this.activitySince = Date.now();
      }, durationMs);
    }
    return true;
  }

  /**
   * Simula un impacto (para detección de caídas).
   */
  simulateImpact(magnitude = 6.0) {
    this.detection.impact = true;
    this.detection.lastImpactTs = Date.now();
    this.metrics.impactEvents++;

    -- UNCOMPLETED
   
