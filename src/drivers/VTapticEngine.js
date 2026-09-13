// src/drivers/VTapticEngine.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VTapticEngine
 * ═══════════════════════════════════════════════════════════════
 *
 * Motor háptico virtual. Emula el comportamiento del Taptic Engine
 * de Apple y de la API Core Haptics:
 *
 *   - Reproduce patrones predefinidos (light, medium, heavy, success...)
 *   - Reproduce patrones personalizados (secuencias de pulsos con
 *     amplitud y nitidez variables)
 *   - Cola de reproducción (no se solapan patrones, se encolan)
 *   - Cooldown entre pulsos para no producir "buzz" contínuo
 *   - Respeta el modo silencio (silent switch)
 *   - Respeta el modo "reduce motion" y "reduce haptics"
 *   - Historial de reproducciones (para debug y para Ajustes)
 *   - Métricas: total reproducidos, cancelados, energía consumida,
 *     temperatura del motor, patrones por tipo
 *   - Suscriptores de eventos: started / pulse / finished / cancelled
 *   - Sistema de prioridades: si llega un háptico de prioridad mayor
 *     mientras otro se reproduce, se cancela el menor
 *   - Soporte para hápticos "background" (no interrumpen, se acumulan)
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';

// ───────────────────────────────────────────────────────────────
// Patrones predefinidos (estilo Core Haptics / UIKit)
// ───────────────────────────────────────────────────────────────
// Cada patrón es un array de pulsos:
//   { at: ms desde inicio, duration: ms, amplitude: 0..1, sharpness: 0..1 }
//
// Nota: en un iPhone real el Taptic Engine no produce sonido; aquí
// solo simulamos el consumo eléctrico y la temperatura.
export const HapticPatterns = Object.freeze({
  // ─── Básicos (UIKit Feedback Generator) ────────────────────
  light: [
    { at: 0, duration: 10, amplitude: 0.35, sharpness: 0.4 },
  ],
  medium: [
    { at: 0, duration: 15, amplitude: 0.6, sharpness: 0.5 },
  ],
  heavy: [
    { at: 0, duration: 20, amplitude: 0.95, sharpness: 0.6 },
  ],
  soft: [
    { at: 0, duration: 25, amplitude: 0.4, sharpness: 0.15 },
  ],
  rigid: [
    { at: 0, duration: 12, amplitude: 0.75, sharpness: 0.95 },
  ],

  // ─── Selection / Navigation ─────────────────────────────────
  selection: [
    { at: 0, duration: 6, amplitude: 0.25, sharpness: 0.8 },
  ],
  pickerTick: [
    { at: 0, duration: 5, amplitude: 0.2, sharpness: 0.9 },
  ],
  scrollBounce: [
    { at: 0,  duration: 8,  amplitude: 0.3, sharpness: 0.5 },
    { at: 20, duration: 10, amplitude: 0.4, sharpness: 0.6 },
    { at: 45, duration: 12, amplitude: 0.25, sharpness: 0.4 },
  ],

  // ─── Notification Feedback Generator ───────────────────────
  success: [
    { at: 0,  duration: 12, amplitude: 0.7,  sharpness: 0.7 },
    { at: 35, duration: 18, amplitude: 0.95, sharpness: 0.8 },
  ],
  warning: [
    { at: 0,  duration: 15, amplitude: 0.8, sharpness: 0.9 },
    { at: 25, duration: 15, amplitude: 0.8, sharpness: 0.9 },
  ],
  error: [
    { at: 0,  duration: 20, amplitude: 1.0, sharpness: 1.0 },
    { at: 30, duration: 20, amplitude: 1.0, sharpness: 1.0 },
    { at: 60, duration: 20, amplitude: 1.0, sharpness: 1.0 },
  ],

  // ─── Sistema iOS ────────────────────────────────────────────
  lock: [
    { at: 0, duration: 10, amplitude: 0.5, sharpness: 0.6 },
  ],
  unlock: [
    { at: 0, duration: 8, amplitude: 0.4, sharpness: 0.5 },
    { at: 15, duration: 8, amplitude: 0.5, sharpness: 0.6 },
  ],
  homeSwipe: [
    { at: 0, duration: 15, amplitude: 0.6, sharpness: 0.5 },
  ],
  keyboardTap: [
    { at: 0, duration: 6, amplitude: 0.3, sharpness: 0.8 },
  ],
  keyboardDelete: [
    { at: 0, duration: 8, amplitude: 0.35, sharpness: 0.9 },
  ],
  keyboardSpace: [
    { at: 0, duration: 8, amplitude: 0.35, sharpness: 0.7 },
  ],
  toggleSwitch: [
    { at: 0, duration: 10, amplitude: 0.5, sharpness: 0.7 },
  ],
  ringtoneStart: [
    { at: 0,   duration: 25, amplitude: 0.9, sharpness: 0.6 },
    { at: 100, duration: 25, amplitude: 0.9, sharpness: 0.6 },
    { at: 200, duration: 25, amplitude: 0.9, sharpness: 0.6 },
  ],
  ringtoneStop: [
    { at: 0, duration: 30, amplitude: 0.7, sharpness: 0.5 },
  ],
  messageSent: [
    { at: 0,  duration: 10, amplitude: 0.5, sharpness: 0.7 },
    { at: 20, duration: 15, amplitude: 0.7, sharpness: 0.8 },
  ],
  messageReceived: [
    { at: 0,  duration: 15, amplitude: 0.7, sharpness: 0.6 },
    { at: 40, duration: 20, amplitude: 0.9, sharpness: 0.7 },
  ],

  // ─── Apple Pay / Seguridad ─────────────────────────────────
  applePaySuccess: [
    { at: 0,  duration: 20, amplitude: 0.8, sharpness: 0.7 },
    { at: 60, duration: 40, amplitude: 1.0, sharpness: 0.85 },
    { at: 130, duration: 15, amplitude: 0.5, sharpness: 0.5 },
  ],
  faceIdSuccess: [
    { at: 0, duration: 12, amplitude: 0.6, sharpness: 0.6 },
    { at: 25, duration: 20, amplitude: 0.9, sharpness: 0.7 },
  ],
  faceIdFail: [
    { at: 0, duration: 40, amplitude: 0.8, sharpness: 0.85 },
  ],

  // ─── Media / Multimedia ────────────────────────────────────
  cameraShutter: [
    { at: 0, duration: 12, amplitude: 0.9, sharpness: 1.0 },
  ],
  videoStart: [
    { at: 0, duration: 20, amplitude: 0.6, sharpness: 0.6 },
  ],
  videoEnd: [
    { at: 0, duration: 25, amplitude: 0.5, sharpness: 0.5 },
  ],
});

// ───────────────────────────────────────────────────────────────
// Prioridades: cuánto pesa un háptico frente a otro
// ───────────────────────────────────────────────────────────────
export const HapticPriority = {
  BACKGROUND:  0,   // nunca interrumpe (p. ej. pulso de reloj)
  LOW:         1,
  NORMAL:      2,
  HIGH:        3,
  CRITICAL:    4,   // siempre interrumpe (p. ej. error grave)
};

// ───────────────────────────────────────────────────────────────
// Estados del motor
// ───────────────────────────────────────────────────────────────
export const TapticState = {
  IDLE:      'idle',
  PLAYING:   'playing',
  COOLDOWN:  'cooldown',
  DISABLED:  'disabled',   // modo silencio + reduce haptics
  ERROR:     'error',
};

// ───────────────────────────────────────────────────────────────
// Reproducción en curso
// ───────────────────────────────────────────────────────────────
class Playback {
  constructor(id, name, pulses, options = {}) {
    this.id        = id;
    this.name      = name;
    this.pulses    = pulses;
    this.priority  = options.priority ?? HapticPriority.NORMAL;
    this.source    = options.source ?? 'unknown';
    this.startTs   = Date.now();
    this.endTs     = this.startTs + (pulses.length > 0
      ? Math.max(...pulses.map(p => p.at + p.duration))
      : 0);
    this.pulseIndex = 0;
    this.firedPulses = [];
    this.cancelled = false;
    this.finished  = false;
    this.energyMj  = 0;
    this.peakAmplitude = 0;
    this.avgAmplitude  = 0;
    this.totalDurationMs = this.endTs - this.startTs;
  }

  /** ¿Ya toca disparar el siguiente pulso? */
  nextPulseDue(nowTs) {
    if (this.pulseIndex >= this.pulses.length) return null;
    const next = this.pulses[this.pulseIndex];
    if (nowTs - this.startTs >= next.at) {
      this.pulseIndex++;
      return next;
    }
    return null;
  }

  isFinished(nowTs) {
    return this.pulseIndex >= this.pulses.length && nowTs >= this.endTs;
  }

  snapshot() {
    return {
      id:           this.id,
      name:         this.name,
      priority:     this.priority,
      source:       this.source,
      startTs:      this.startTs,
      endTs:        this.endTs,
      pulseCount:   this.pulses.length,
      firedCount:   this.firedPulses.length,
      totalDurationMs: this.totalDurationMs,
      energyMj:     parseFloat(this.energyMj.toFixed(4)),
      peakAmplitude:parseFloat(this.peakAmplitude.toFixed(2)),
      avgAmplitude: parseFloat(this.avgAmplitude.toFixed(2)),
      cancelled:    this.cancelled,
      finished:     this.finished,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VTapticEngine — driver completo
// ───────────────────────────────────────────────────────────────
export class VTapticEngine {
  constructor(bus) {
    this.bus  = bus;
    this.name = 'VTapticEngine';
    this.model = 'Taptic Engine (2ª gen)';

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = TapticState.IDLE;

    // Configuración de usuario
    this.enabled            = true;    // reduce haptics / switch global
    this.silentMode         = false;   // interruptor lateral
    this.reduceMotion       = false;   // accesibilidad
    this.hapticsForKeyboard = true;
    this.hapticsForSystem   = true;
    this.hapticsForApps     = true;

    // Capacidades físicas del motor
    this.maxAmplitude    = 1.0;
    this.maxFrequencyHz  = 180;   // frecuencia de resonancia aprox.
    this.minPulseMs      = 5;
    this.maxPulseMs      = 500;
    this.cooldownMs      = 30;    // tiempo mínimo entre pulsos distintos
    this.thermalMaxC     = 55;    // temperatura a la que se auto-limita

    // Cola de reproducción
    this.queue       = [];        // pendientes
    this.maxQueue    = 32;
    this.current     = null;      // Playback en curso
    this.lastPulseEndTs = 0;

    // Motor físico (temperatura, energía, desgaste)
    this.motor = {
      tempC:        28.0,
      ambientC:     25.0,
      energyMjTotal: 0,
      energyMjWindow: [],         // últimos N pulsos (para media)
      peakPowerMw:  0,
      currentPowerMw: 0,
      cycles:       0,
      wearPercent:  0,            // 0-100, decrementa con cada ciclo
    };

    // Historial (últimos N eventos)
    this.historySize = 200;
    this.history = [];            // eventos: pulse-fired, playback-started, etc.

    // Contadores
    this.metrics = {
      playbacksStarted:   0,
      playbacksFinished:  0,
      playbacksCancelled: 0,
      playbacksRejected:  0,
      pulsesFired:        0,
      pulsesDropped:      0,
      highPriorityInterrupts: 0,
      unknownPatterns:    0,
      queueFull:          0,
      startedAt:          null,
    };

    // Suscriptores
    this.subscribers         = new Set();  // estado general
    this.pulseSubscribers    = new Set();  // cada pulso
    this.lifecycleSubscribers= new Set();  // started/finished/cancelled

    // Tick loop (32ms = ~31Hz, más que suficiente para simular pulsos)
    this.tickIntervalMs = 32;
    this.tickId = null;
    this.tickCount = 0;

    // Historial de carga (para gráficos)
    this.historySizeH = 120;
    this.historyH = {
      ts:       [],
      powerMw:  [],
      tempC:    [],
    };

    logger.kernel('VTapticEngine', `creado: ${this.model}`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;

    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VTapticEngine',
      `✓ init: ${this.model}, cooldown=${this.cooldownMs}ms, ` +
      `maxAmp=${this.maxAmplitude}, thermalLimit=${this.thermalMaxC}°C`);
    this.bus?.raiseInterrupt?.('IRQ_HAPTIC', {
      source: 'vtaptic', event: 'ready',
    }, 'vtaptic');
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
    this.stopAll('shutdown');
    logger.info('VTapticEngine', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK — procesa la cola y el playback actual
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const dtMs = this.tickIntervalMs;
    const now = Date.now();

    // 1) Disipar calor del motor
    this._dissipateHeat(dtMs);

    // 2) Si hay playback activo, disparar pulsos que toque
    if (this.current) {
      this._processCurrentPlayback(now);
    }

    // 3) Si no hay playback activo y hay cola, arrancar siguiente
    if (!this.current && this.queue.length > 0) {
      this._startNextFromQueue();
    }

    // 4) Actualizar estado público
    this._updateState(now);

    // 5) Historial
    this._pushHistory();

    // 6) Notificar
    this._emit();

    this.tickCount++;
  }

  _processCurrentPlayback(now) {
    const pb = this.current;
    if (!pb) return;

    // Si el usuario desactivó haptics a mitad de reproducción, cancelamos
    if (!this.enabled || this.silentMode || this.reduceMotion) {
      this._cancelCurrent('user-disabled');
      return;
    }

    // Disparar pulsos pendientes
    let pulse = pb.nextPulseDue(now);
    while (pulse) {
      this._firePulse(pb, pulse);
      pulse = pb.nextPulseDue(now);
    }

    // Fin de reproducción
    if (pb.isFinished(now)) {
      pb.finished = true;
      this._finishCurrent();
    }
  }

  _startNextFromQueue() {
    // Ordenar por prioridad desc para decidir si adelantar alguno
    this.queue.sort((a, b) => b.priority - a.priority);
    const next = this.queue.shift();
    if (!next) return;

    // Comprobar cooldown: si el último pulso fue hace menos de cooldownMs,
    // retrasamos el arranque unos ms metiéndolo de nuevo en la cola.
    const sinceLastPulse = Date.now() - this.lastPulseEndTs;
    if (sinceLastPulse < this.cooldownMs) {
      this.queue.unshift(next);
      return;
    }

    this.current = next;
    pb.startedAt = Date.now();
    this.metrics.playbacksStarted++;
    this._emitLifecycle('started', next);
    logger.debug('VTapticEngine',
      `▶ playback "${next.name}" [${next.id.slice(-6)}] ` +
      `prio=${next.priority} src=${next.source} pulses=${next.pulses.length}`);
  }

  _firePulse(pb, pulse) {
    // Comprobar límites físicos
    if (pulse.duration < this.minPulseMs) {
      pulse = { ...pulse, duration: this.minPulseMs };
    }
    if (pulse.duration > this.maxPulseMs) {
      pulse = { ...pulse, duration: this.maxPulseMs };
    }

    const amplitude = Math.max(0, Math.min(this.maxAmplitude, pulse.amplitude ?? 0.5));
    const sharpness = Math.max(0, Math.min(1, pulse.sharpness ?? 0.5));

    // Energía: proporcional a amplitud^2 * duración + sharpness extra
    const baseMj = amplitude * amplitude * pulse.duration * 0.02;
    const sharpnessBonus = sharpness * 0.005 * pulse.duration;
    const energyMj = baseMj + sharpnessBonus;
    pb.energyMj += energyMj;
    pb.firedPulses.push({ ts: Date.now(), amplitude, sharpness, duration: pulse.duration });

    // Actualizar stats del playback
    pb.peakAmplitude = Math.max(pb.peakAmplitude, amplitude);
    const fired = pb.firedPulses.length;
    pb.avgAmplitude = ((pb.avgAmplitude * (fired - 1)) + amplitude) / fired;

    // Actualizar motor
    this.motor.energyMjTotal += energyMj;
    this.motor.energyMjWindow.push(energyMj);
    if (this.motor.energyMjWindow.length > 32) this.motor.energyMjWindow.shift();
    this.motor.cycles++;

    // Potencia instantánea y temperatura
    const powerMw = (energyMj / pulse.duration) * 1000;
    this.motor.currentPowerMw = powerMw;
    if (powerMw > this.motor.peakPowerMw) this.motor.peakPowerMw = powerMw;
    this.motor.tempC += (powerMw * pulse.duration) / 3000000;

    // Desgaste acumulado
    this.motor.wearPercent = Math.min(100, this.motor.wearPercent + energyMj * 0.00005);

    // Marcar fin del pulso (para cooldown)
    this.lastPulseEndTs = Date.now() + pulse.duration;

    // Métricas
    this.metrics.pulsesFired++;

    // Emitir IRQ de hardware (por si alguien lo escucha)
    this.bus?.raiseInterrupt?.('IRQ_HAPTIC', {
      source: 'vtaptic',
      pattern: pb.name,
      amplitude,
      sharpness,
      duration: pulse.duration,
      energyMj,
    }, 'vtaptic');

    // Notificar suscriptores de pulso
    const evt = {
      ts:        Date.now(),
      playbackId:pb.id,
      pattern:   pb.name,
      amplitude, sharpness,
      duration:  pulse.duration,
      energyMj,
      source:    pb.source,
    };
    for (const fn of this.pulseSubscribers) {
      try { fn(evt); } catch (_) {}
    }

    // Log solo si es interesante
    if (amplitude >= 0.8) {
      logger.debug('VTapticEngine',
        `pulse amp=${amplitude.toFixed(2)} sharp=${sharpness.toFixed(2)} ` +
        `dur=${pulse.duration}ms energy=${energyMj.toFixed(4)}mJ`);
    }
  }

  _finishCurrent() {
    const pb = this.current;
    if (!pb) return;
    this.metrics.playbacksFinished++;
    this._emitLifecycle('finished', pb);
    logger.debug('VTapticEngine',
      `✓ playback "${pb.name}" finished (${pb.firedPulses.length} pulses, ` +
      `${pb.energyMj.toFixed(4)}mJ)`);
    this.current = null;
  }

  _cancelCurrent(reason = 'user') {
    const pb = this.current;
    if (!pb) return;
    pb.cancelled = true;
    this.metrics.playbacksCancelled++;
    this._emitLifecycle('cancelled', pb, reason);
    logger.debug('VTapticEngine',
      `✗ playback "${pb.name}" cancelado (${reason})`);
    this.current = null;
  }

  _dissipateHeat(dtMs) {
    const k = 0.0012;
    const diff = this.motor.tempC - this.motor.ambientC;
    if (diff > 0) {
      this.motor.tempC -= diff * k * dtMs;
      if (this.motor.tempC < this.motor.ambientC) {
        this.motor.tempC = this.motor.ambientC;
      }
    }
    // Potencia actual decae hacia 0 cuando no hay pulso reciente
    const sincePulse = Date.now() - this.lastPulseEndTs;
    if (sincePulse > 100) {
      this.motor.currentPowerMw = Math.max(0, this.motor.currentPowerMw * 0.9);
    }
  }

  _updateState(now) {
    if (!this.enabled || this.silentMode || this.reduceMotion) {
      this.state = TapticState.DISABLED;
      return;
    }
    if (this.motor.tempC >= this.thermalMaxC) {
      this.state = TapticState.COOLDOWN;
      return;
    }
    if (this.current) {
      this.state = TapticState.PLAYING;
      return;
    }
    if (now - this.lastPulseEndTs < this.cooldownMs) {
      this.state = TapticState.COOLDOWN;
      return;
    }
    this.state = TapticState.IDLE;
  }

  _pushHistory() {
    this.historyH.ts.push(Date.now());
    this.historyH.powerMw.push(this.motor.currentPowerMw);
    this.historyH.tempC.push(this.motor.tempC);
    for (const k of Object.keys(this.historyH)) {
      if (this.historyH[k].length > this.historySizeH) this.historyH[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA — play / stop
  // ═══════════════════════════════════════════════════════════

  /**
   * Reproduce un patrón.
   * @param {string|Array} pattern  Nombre de patrón o array de pulsos
   * @param {object} opts           { priority, source }
   * @returns {string|null}         id del playback o null si rechazado
   */
  play(pattern, opts = {}) {
    // 1) Comprobaciones de estado
    if (!this.enabled) {
      this.metrics.playbacksRejected++;
      logger.debug('VTapticEngine', `play rechazado (disabled): ${typeof pattern === 'string' ? pattern : 'custom'}`);
      return null;
    }
    if (this.silentMode && opts.priority !== HapticPriority.CRITICAL) {
      this.metrics.playbacksRejected++;
      return null;
    }
    if (this.reduceMotion) {
      this.metrics.playbacksRejected++;
      return null;
    }
    if (this.state === TapticState.COOLDOWN) {
      // En cooldown solo pasan los de prioridad >= HIGH
      if ((opts.priority ?? HapticPriority.NORMAL) < HapticPriority.HIGH) {
        this.metrics.playbacksRejected++;
        return null;
      }
    }

    // 2) Resolver patrón
    let pulses;
    let name;
    if (typeof pattern === 'string') {
      const def = HapticPatterns[pattern];
      if (!def) {
        this.metrics.unknownPatterns++;
        logger.warn('VTapticEngine', `patrón desconocido: ${pattern}`);
        return null;
      }
      pulses = def;
      name = pattern;
    } else if (Array.isArray(pattern)) {
      pulses = pattern;
      name = opts.name || 'custom';
    } else {
      logger.warn('VTapticEngine', `play: pattern debe ser string o array`);
      return null;
    }

    // 3) Cola llena?
    if (this.queue.length >= this.maxQueue) {
      this.metrics.queueFull++;
      logger.warn('VTapticEngine', `cola llena, descartando playback (${name})`);
      return null;
    }

    // 4) Crear playback
    const id = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pb = new Playback(id, name, pulses, opts);

    // 5) Prioridad: si hay current y es de menor prioridad, cancelarlo
    if (this.current && pb.priority > this.current.priority) {
      this.metrics.highPriorityInterrupts++;
      logger.debug('VTapticEngine',
        `interrumpiendo "${this.current.name}" por "${name}" ` +
        `(prio ${pb.priority} > ${this.current.priority})`);
      this._cancelCurrent('preempted');
    }

    // 6) Encolar o arrancar
    if (this.current) {
      this.queue.push(pb);
    } else {
      this.current = pb;
      pb.startedAt = Date.now();
      this.metrics.playbacksStarted++;
      this._emitLifecycle('started', pb);
    }

    return id;
  }

  /**
   * Reproduce un patrón custom compuesto por múltiples segmentos.
   * Ejemplo: [['light', 0], ['success', 100]]
   */
  playSequence(sequence, opts = {}) {
    if (!Array.isArray(sequence)) return null;
    const flat = [];
    let timeOffset = 0;
    for (const [patternName, delay = 0] of sequence) {
      timeOffset += delay;
      const def = HapticPatterns[patternName];
      if (!def) continue;
      for (const p of def) {
        flat.push({ ...p, at: timeOffset + p.at });
      }
      // tiempo que dura el patrón antes del siguiente delay
      const lastEnd = Math.max(...def.map(p => p.at + p.duration));
      timeOffset += lastEnd;
    }
    if (flat.length === 0) return null;
    return this.play(flat, { ...opts, name: opts.name || 'sequence' });
  }

  /**
   * Cancela un playback por ID. Si está en cola, se elimina; si es el
   * actual, se cancela.
   */
  cancel(id, reason = 'user') {
    if (this.current && this.current.id === id) {
      this._cancelCurrent(reason);
      return true;
    }
    const idx = this.queue.findIndex(p => p.id === id);
    if (idx >= 0) {
      const [removed] = this.queue.splice(idx, 1);
      removed.cancelled = true;
      this.metrics.playbacksCancelled++;
      this._emitLifecycle('cancelled', removed, reason);
      return true;
    }
    return false;
  }

  /** Detiene el playback actual, si lo hay. */
  stop(reason = 'user') {
    if (!this.current) return false;
    this._cancelCurrent(reason);
    return true;
  }

  /** Detiene todo: cancela el actual y vacía la cola. */
  stopAll(reason = 'user') {
    const cancelled = [];
    if (this.current) {
      cancelled.push(this.current);
      this._cancelCurrent(reason);
    }
    while (this.queue.length > 0) {
      const pb = this.queue.shift();
      pb.cancelled = true;
      this.metrics.playbacksCancelled++;
      cancelled.push(pb);
      this._emitLifecycle('cancelled', pb, reason);
    }
    return cancelled.length;
  }

  /** Activa/desactiva el motor. */
  setEnabled(on) {
    const prev = this.enabled;
    this.enabled = !!on;
    if (!this.enabled && prev) {
      this.stopAll('disabled');
    }
    logger.info('VTapticEngine', `enabled = ${this.enabled}`);
    this._emit();
  }

  /** Activa/desactiva el modo silencio (interruptor lateral). */
  setSilentMode(on) {
    const prev = this.silentMode;
    this.silentMode = !!on;
    if (this.silentMode && !prev) {
      // No cancelamos críticos
      if (this.current && this.current.priority < HapticPriority.CRITICAL) {
        this.stopAll('silent-mode');
      }
    }
    logger.info('VTapticEngine', `silent = ${this.silentMode}`);
    this._emit();
  }

  setReduceMotion(on) {
    this.reduceMotion = !!on;
    if (this.reduceMotion) this.stopAll('reduce-motion');
    this._emit();
  }

  setKeyboardHaptics(on) { this.hapticsForKeyboard = !!on; this._emit(); }
  setSystemHaptics(on)   { this.hapticsForSystem   = !!on; this._emit(); }
  setAppHaptics(on)      { this.hapticsForApps     = !!on; this._emit(); }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isPlaying() {
    return !!this.current;
  }

  currentPlayback() {
    return this.current ? this.current.snapshot() : null;
  }

  queueLength() {
    return this.queue.length;
  }

  listAvailablePatterns() {
    return Object.keys(HapticPatterns);
  }

  getPattern(name) {
    return HapticPatterns[name] || null;
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onPulse(fn) {
    this.pulseSubscribers.add(fn);
    return () => this.pulseSubscribers.delete(fn);
  }

  onLifecycle(fn) {
    this.lifecycleSubscribers.add(fn);
    return () => this.lifecycleSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VTapticEngine', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitLifecycle(type, pb, reason = null) {
    const evt = {
      ts:       Date.now(),
      type,     // 'started' | 'finished' | 'cancelled'
      playback: pb.snapshot(),
      reason,
    };
    // Guardar en historial
    this.history.push(evt);
    if (this.history.length > this.historySize) this.history.shift();

    for (const fn of this.lifecycleSubscribers) {
      try { fn(evt); } catch (_) {}
    }
  }

  getHistory(n = 50) {
    return this.history.slice(-n);
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:      this.model,
      state:      this.state,
      enabled:    this.enabled,
      silentMode: this.silentMode,
      reduceMotion: this.reduceMotion,
      playing:    !!this.current,
      current:    this.current ? this.current.snapshot() : null,
      queued:     this.queue.length,
      motor: {
        tempC:      parseFloat(this.motor.tempC.toFixed(2)),
        ambientC:   this.motor.ambientC,
        powerMw:    parseFloat(this.motor.currentPowerMw.toFixed(2)),
        peakPowerMw:parseFloat(this.motor.peakPowerMw.toFixed(2)),
        energyMj:   parseFloat(this.motor.energyMjTotal.toFixed(3)),
        cycles:     this.motor.cycles,
        wearPercent:parseFloat(this.motor.wearPercent.toFixed(3)),
      },
      cooldownMs: this.cooldownMs,
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      queued:      this.queue.length,
      historyLen:  this.history.length,
      motor:       this.getSnapshot().motor,
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VTapticEngine [${s.state}] — ${s.model}`,
      `  enabled:       ${this.enabled}`,
      `  silentMode:    ${this.silentMode}`,
      `  reduceMotion:  ${this.reduceMotion}`,
      `  queue:         ${s.queued}`,
      `  motor temp:    ${s.motor.tempC}°C (peak power ${s.motor.peakPowerMw}mW)`,
      `  motor wear:    ${s.motor.wearPercent}%`,
      `  metrics:`,
      `    playbacks:   started=${s.metrics.playbacksStarted} finished=${s.metrics.playbacksFinished}`,
      `                 cancelled=${s.metrics.playbacksCancelled} rejected=${s.metrics.playbacksRejected}`,
      `    pulses:      fired=${s.metrics.pulsesFired} dropped=${s.metrics.pulsesDropped}`,
      `    interrupts:  ${s.metrics.highPriorityInterrupts}`,
      `    unknown:     ${s.metrics.unknownPatterns}`,
      `    queueFull:   ${s.metrics.queueFull}`,
    ];
    return lines.join('\n');
  }

  getHistoryData() {
    return {
      ts:      [...this.historyH.ts],
      powerMw: [...this.historyH.powerMw],
      tempC:   [...this.historyH.tempC],
    };
  }
}
