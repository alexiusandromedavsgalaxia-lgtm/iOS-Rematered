// src/drivers/VMicrophone.js
// Subsistema de micrófonos virtual — 4 MEMS (array) estilo iPhone 16 Pro
// Funciones: captura multichannel, beamforming, NS, AGC, DOA, perfiles de uso.
// Se integra con VCellular (llamadas), VCamera (vídeo), y apps (Notas, Voice Memos).

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'MIC';

/* ------------------------------------------------------------------ *
 * Hardware: array de 4 micrófonos
 * ------------------------------------------------------------------ */

export const MIC_IDS = ['bottom-left', 'bottom-right', 'top-front', 'back'];

// Posiciones físicas (mm) respecto al centro del chasis.
// Se usan para calcular retardos de fase → DOA (direction of arrival).
const MIC_POSITIONS_MM = {
  'bottom-left':  { x: -32, y: -70, z:  0 },
  'bottom-right': { x:  32, y: -70, z:  0 },
  'top-front':    { x:   0, y:  68, z:  2 },
  'back':         { x:   0, y:  -8, z: -8 },
};

// Velocidad del sonido en aire a 20°C (mm/ms)
const SOUND_SPEED_MM_PER_MS = 343;

/* ------------------------------------------------------------------ *
 * Constantes de audio
 * ------------------------------------------------------------------ */

// Sample rates soportados
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];

// Bit depths
const BIT_DEPTHS = [16, 24, 32];

// Tamaños de buffer por frame (samples)
const FRAME_SIZES = [128, 256, 512, 1024, 2048];

// Rango dinámico típico de un MEMS (dB SPL)
const SPL_MIN = 30;
const SPL_MAX = 120;
const SPL_REFERENCE_DB = 94; // dB SPL → 1 Pa

// Sensibilidad del micrófono (dBFS a 94 dB SPL, típico -26 dBFS)
const MIC_SENSITIVITY_DBFS = -26;

// Piso de ruido propio del micrófono (dB SPL)
const MIC_SELF_NOISE_DB = 29;

// Ganancia AGC
const AGC_GAIN_MIN_DB = -12;
const AGC_GAIN_MAX_DB = 36;
const AGC_TARGET_DBFS = -18;
const AGC_ATTACK_MS = 5;
const AGC_RELEASE_MS = 120;

// NS (noise suppression) niveles
const NS_LEVELS = {
  OFF:      0,
  LIGHT:    0.35,
  MODERATE: 0.6,
  STRONG:   0.85,
  MAX:      1.0,
};

/* ------------------------------------------------------------------ *
 * Máquina de estados
 * ------------------------------------------------------------------ */

const MIC_STATE = {
  OFF:       'off',
  INIT:      'init',
  IDLE:      'idle',
  CAPTURING: 'capturing',
  MUTED:     'muted',
  SUSPENDED: 'suspended',
  FAULT:     'fault',
};

const MIC_TRANSITIONS = {
  [MIC_STATE.OFF]:       [MIC_STATE.INIT],
  [MIC_STATE.INIT]:      [MIC_STATE.IDLE, MIC_STATE.FAULT, MIC_STATE.OFF],
  [MIC_STATE.IDLE]:      [MIC_STATE.CAPTURING, MIC_STATE.MUTED, MIC_STATE.SUSPENDED, MIC_STATE.OFF],
  [MIC_STATE.CAPTURING]: [MIC_STATE.IDLE, MIC_STATE.MUTED, MIC_STATE.SUSPENDED, MIC_STATE.FAULT, MIC_STATE.OFF],
  [MIC_STATE.MUTED]:     [MIC_STATE.CAPTURING, MIC_STATE.IDLE, MIC_STATE.OFF],
  [MIC_STATE.SUSPENDED]: [MIC_STATE.IDLE, MIC_STATE.OFF],
  [MIC_STATE.FAULT]:     [MIC_STATE.INIT, MIC_STATE.OFF],
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function round(v, d = 2)  { const f = 10 ** d; return Math.round(v * f) / f; }
function dbToLinear(db)   { return 10 ** (db / 20); }
function linearToDb(x)    { return 20 * Math.log10(Math.max(1e-12, x)); }

function gaussianNoise(sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ *
 * Fuentes de sonido simuladas
 * ------------------------------------------------------------------ */

const MIC_SCENARIOS = {
  SILENCE:       'silence',
  SPEECH_NEAR:   'speech-near',
  SPEECH_FAR:    'speech-far',
  CALL:          'call',
  VIDEO:         'video',
  WIND:          'wind',
  MUSIC:         'music',
  CROWD:         'crowd',
  MECHANICAL:    'mechanical',
};

// Azimut (grados, 0=frente) y elevación por escenario
const SCENARIO_DIRECTIONS = {
  [MIC_SCENARIOS.SILENCE]:     { az: 0,   el: 0  },
  [MIC_SCENARIOS.SPEECH_NEAR]: { az: 0,   el: 0  },
  [MIC_SCENARIOS.SPEECH_FAR]:  { az: 15,  el: -5 },
  [MIC_SCENARIOS.CALL]:        { az: 0,   el: 0  },
  [MIC_SCENARIOS.VIDEO]:       { az: 0,   el: 0  },
  [MIC_SCENARIOS.WIND]:        { az: 90,  el: 0  },
  [MIC_SCENARIOS.MUSIC]:       { az: 180, el: 0  },
  [MIC_SCENARIOS.CROWD]:       { az: 45,  el: 0  },
  [MIC_SCENARIOS.MECHANICAL]:  { az: -60, el: -10 },
};

/* ------------------------------------------------------------------ *
 * Perfiles de uso (ajustan SR, NS, AGC, beamforming)
 * ------------------------------------------------------------------ */

const MIC_PROFILES = {
  DEFAULT: {
    name: 'default',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    nsLevel: NS_LEVELS.MODERATE,
    agcEnabled: true, agcTarget: -18,
    beamforming: true, beamAz: 0, beamWidth: 60,
    highpassHz: 80, channels: 4,
  },
  VOICE_ISOLATION: {
    name: 'voice-isolation',
    sampleRate: 48000, bitDepth: 24, frameSize: 512,
    nsLevel: NS_LEVELS.MAX,
    agcEnabled: true, agcTarget: -16,
    beamforming: true, beamAz: 0, beamWidth: 30,
    highpassHz: 100, channels: 2,
  },
  WIDE_SPECTRUM: {
    name: 'wide-spectrum',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    nsLevel: NS_LEVELS.LIGHT,
    agcEnabled: true, agcTarget: -20,
    beamforming: false, beamAz: 0, beamWidth: 360,
    highpassHz: 20, channels: 4,
  },
  VIDEO_RECORDING: {
    name: 'video-recording',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    nsLevel: NS_LEVELS.MODERATE,
    agcEnabled: true, agcTarget: -18,
    beamforming: true, beamAz: 0, beamWidth: 90,
    highpassHz: 60, channels: 4,
  },
  CALL: {
    name: 'call',
    sampleRate: 16000, bitDepth: 16, frameSize: 256,
    nsLevel: NS_LEVELS.STRONG,
    agcEnabled: true, agcTarget: -16,
    beamforming: true, beamAz: 0, beamWidth: 45,
    highpassHz: 120, channels: 1,   // mono para llamada
  },
  MEASUREMENT: {
    name: 'measurement',
    sampleRate: 48000, bitDepth: 32, frameSize: 2048,
    nsLevel: NS_LEVELS.OFF,
    agcEnabled: false, agcTarget: -18,
    beamforming: false, beamAz: 0, beamWidth: 360,
    highpassHz: 10, channels: 4,
  },
  LOW_POWER: {
    name: 'low-power',
    sampleRate: 16000, bitDepth: 16, frameSize: 512,
    nsLevel: NS_LEVELS.MODERATE,
    agcEnabled: true, agcTarget: -20,
    beamforming: false, beamAz: 0, beamWidth: 180,
    highpassHz: 100, channels: 1,
  },
};

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VMicrophone {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Estado del chip ---
    this.state       = MIC_STATE.OFF;
    this.powered     = false;
    this.muted       = false;
    this.profileName = 'default';
    this.profile     = MIC_PROFILES.DEFAULT;

    // --- Configuración efectiva ---
    this.sampleRate = this.profile.sampleRate;
    this.bitDepth   = this.profile.bitDepth;
    this.frameSize  = this.profile.frameSize;
    this.channels   = this.profile.channels;
    this.highpassHz = this.profile.highpassHz;

    // --- NS / AGC / Beamforming ---
    this.nsLevel       = this.profile.nsLevel;
    this.agcEnabled    = this.profile.agcEnabled;
    this.agcTarget     = this.profile.agcTarget;
    this.agcGainDb     = 0;
    this.beamforming   = this.profile.beamforming;
    this.beamAz        = this.profile.beamAz;
    this.beamWidth     = this.profile.beamWidth;

    // --- Escenario simulado ---
    this.scenario      = MIC_SCENARIOS.SILENCE;
    this.scenarioPhase = 0;

    // --- Estado por micrófono ---
    this.mics = {};
    for (const id of MIC_IDS) {
      this.mics[id] = {
        id,
        position: MIC_POSITIONS_MM[id],
        enabled: true,
        gainDb: 0,
        dcOffset: gaussianNoise(0.001),
        selfNoiseDb: MIC_SELF_NOISE_DB + gaussianNoise(0.5),
        snrDb: 65,
        lastSample: 0,
        health: 'ok',   // 'ok' | 'degraded' | 'dead'
      };
    }

    // --- Filtro highpass (estado interno por canal) ---
    this._hpPrev = { in: 0, out: 0 };

    // --- Beamformer ---
    this._beamWeights = new Array(MIC_IDS.length).fill(1 / MIC_IDS.length);
    this._lastDoaAz = 0;
    this._lastDoaEl = 0;
    this._doaConfidence = 0;

    // --- Nivel y métricas ---
    this.peakDbfs   = -Infinity;
    this.rmsDbfs    = -Infinity;
    this.splEstimate = 30;
    this.clipping   = false;
    this._clipCount = 0;

    // --- Watchdog ---
    this._lastFrameAt = 0;
    this._watchdogFires = 0;
    this._watchdogEnabled = true;

    // --- Cola IRQ ---
    this.irqQueue = [];
    this.irqDropped = 0;

    // --- Consumidores vinculados ---
    this.linkedCellular = null;
    this.linkedCamera   = null;
    this.linkedSpeaker  = null;

    // --- Historial ---
    this.historyMax = 180;
    this.history = [];

    // --- Suscriptores ---
    this.subscribers = new Set();

    // --- Métricas ---
    this.stats = {
      frames: 0,
      powerOnMs: 0,
      totalSamples: 0,
      agcAdjustments: 0,
      nsActivations: 0,
      doaUpdates: 0,
      clips: 0,
      watchdogFires: 0,
      stateTransitions: 0,
      muteEvents: 0,
      unmuteEvents: 0,
      lastFrameAt: 0,
      totalEnergyDb: 0,
      perMicFrames: Object.fromEntries(MIC_IDS.map(id => [id, 0])),
    };

    // --- Internos ---
    this._t = 0;
    this._frameAccumulator = 0;

    // --- Registro en bus ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'mic0',
        kind: 'microphone-array',
        model: '4x MEMS (iPhone 16 Pro)',
        capabilities: ['capture', 'beamforming', 'ns', 'agc', 'doa'],
        irq: 'IRQ_MIC',
      });
    }

    Logger.debug(LOG_TAG, 'VMicrophone instanciado (4 micrófonos MEMS)');
  }

  /* ================================================================ *
   * FSM
   * ================================================================ */

  _canTransition(to) {
    return (MIC_TRANSITIONS[this.state] || []).includes(to);
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
    this._transition(MIC_STATE.INIT, 'power-on');
    this._transition(MIC_STATE.IDLE, 'init-done');
    Logger.info(LOG_TAG, 'Array de micrófonos encendido');
    this._emit('power', { on: true });
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this._transition(MIC_STATE.OFF, 'power-off');
    Logger.info(LOG_TAG, 'Array de micrófonos apagado');
    this._emit('power', { on: false });
  }

  suspend() {
    if (this.state === MIC_STATE.SUSPENDED) return;
    this._transition(MIC_STATE.SUSPENDED, 'explicit');
  }

  resume() {
    if (this.state !== MIC_STATE.SUSPENDED) return;
    this._transition(MIC_STATE.IDLE, 'resume');
  }

  mute() {
    if (this.muted) return;
    this.muted = true;
    this.stats.muteEvents++;
    if (this.state === MIC_STATE.CAPTURING) {
      this._transition(MIC_STATE.MUTED, 'user-mute');
    }
    Logger.info(LOG_TAG, 'Micrófono silenciado (mute)');
    this._emit('mute', { muted: true });
    this._pushIRQ('IRQ_MIC', { kind: 'mute' });
  }

  unmute() {
    if (!this.muted) return;
    this.muted = false;
    this.stats.unmuteEvents++;
    if (this.state === MIC_STATE.MUTED) {
      this._transition(MIC_STATE.CAPTURING, 'user-unmute');
    }
    Logger.info(LOG_TAG, 'Micrófono activado (unmute)');
    this._emit('mute', { muted: false });
    this._pushIRQ('IRQ_MIC', { kind: 'unmute' });
  }

  reset() {
    this._hpPrev = { in: 0, out: 0 };
    this.peakDbfs = -Infinity;
    this.rmsDbfs = -Infinity;
    this.agcGainDb = 0;
    this._clipCount = 0;
    this.clipping = false;
    this._frameAccumulator = 0;
    this.irqQueue = [];
    this._transition(MIC_STATE.INIT, 'reset');
    this._transition(MIC_STATE.IDLE, 'reset-done');
    Logger.warn(LOG_TAG, 'Array de micrófonos reseteado');
  }

  /* ================================================================ *
   * Vinculaciones
   * ================================================================ */

  linkCellular(cell)  { this.linkedCellular = cell; Logger.debug(LOG_TAG, 'Vinculado a VCellular'); }
  linkCamera(cam)     { this.linkedCamera = cam;   Logger.debug(LOG_TAG, 'Vinculado a VCamera'); }
  linkSpeaker(spk)    { this.linkedSpeaker = spk;  Logger.debug(LOG_TAG, 'Vinculado a VSpeaker'); }

  /* ================================================================ *
   * Configuración
   * ================================================================ */

  setSampleRate(sr) {
    if (!SAMPLE_RATES.includes(sr)) {
      Logger.warn(LOG_TAG, `Sample rate inválido: ${sr}`);
      return false;
    }
    this.sampleRate = sr;
    return true;
  }

  setBitDepth(bd) {
    if (!BIT_DEPTHS.includes(bd)) return false;
    this.bitDepth = bd;
    return true;
  }

  setFrameSize(fs) {
    if (!FRAME_SIZES.includes(fs)) return false;
    this.frameSize = fs;
    return true;
  }

  setNSLevel(level) {
    if (typeof level === 'string') {
      const key = level.toUpperCase();
      if (!(key in NS_LEVELS)) return false;
      this.nsLevel = NS_LEVELS[key];
    } else {
      this.nsLevel = clamp(level, 0, 1);
    }
    return true;
  }

  setAGC(enabled, targetDbfs = AGC_TARGET_DBFS) {
    this.agcEnabled = !!enabled;
    this.agcTarget = clamp(targetDbfs, -30, 0);
    if (!enabled) this.agcGainDb = 0;
    return true;
  }

  setBeam(az, widthDeg) {
    this.beamAz = ((az % 360) + 360) % 360;
    this.beamWidth = clamp(widthDeg, 10, 360);
    this._recomputeBeamWeights();
    return true;
  }

  enableMic(id, on = true) {
    const m = this.mics[id];
    if (!m) return false;
    m.enabled = !!on;
    this._recomputeBeamWeights();
    return true;
  }

  _recomputeBeamWeights() {
    const enabled = MIC_IDS.filter(id => this.mics[id].enabled);
    if (!enabled.length) {
      this._beamWeights = new Array(MIC_IDS.length).fill(0);
      return;
    }
    const weights = new Array(MIC_IDS.length).fill(0);
    for (let i = 0; i < MIC_IDS.length; i++) {
      const id = MIC_IDS[i];
      const m = this.mics[id];
      if (!m.enabled) continue;
      // Ángulo relativo entre la dirección del haz y la posición del micrófono
      const posAngle = Math.atan2(m.position.x, m.position.y) * 180 / Math.PI;
      const diff = Math.abs(((this.beamAz - posAngle + 540) % 360) - 180);
      const gain = Math.max(0, Math.cos((diff / (this.beamWidth / 2)) * Math.PI / 2));
      weights[i] = gain;
    }
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    this._beamWeights = weights.map(w => w / sum);
  }

  /* ================================================================ *
   * Perfiles
   * ================================================================ */

  applyProfile(name) {
    const key = String(name).toUpperCase().replace(/-/g, '_');
    const p = MIC_PROFILES[key];
    if (!p) {
      Logger.warn(LOG_TAG, `Perfil desconocido: ${name}`);
      return false;
    }
    this.profile = p;
    this.profileName = p.name;
    this.sampleRate = p.sampleRate;
    this.bitDepth = p.bitDepth;
    this.frameSize = p.frameSize;
    this.channels = p.channels;
    this.highpassHz = p.highpassHz;
    this.nsLevel = p.nsLevel;
    this.agcEnabled = p.agcEnabled;
    this.agcTarget = p.agcTarget;
    this.beamforming = p.beamforming;
    this.beamAz = p.beamAz;
    this.beamWidth = p.beamWidth;
    this._recomputeBeamWeights();
    Logger.debug(LOG_TAG, `Perfil aplicado: ${p.name}`);
    this._emit('profile', { name: p.name });
    return true;
  }

  setScenario(scenario) {
    if (!Object.values(MIC_SCENARIOS).includes(scenario)) return false;
    const prev = this.scenario;
    this.scenario = scenario;
    this.scenarioPhase = 0;
    Logger.debug(LOG_TAG, `Escenario: ${prev} → ${scenario}`);
    return true;
  }

  startCapture() {
    if (this.state === MIC_STATE.CAPTURING) return true;
    if (this.state === MIC_STATE.MUTED) return this.unmute();
    if (this.state === MIC_STATE.IDLE) {
      this._transition(MIC_STATE.CAPTURING, 'start-capture');
      return true;
    }
    return false;
  }

  stopCapture() {
    if (this.state !== MIC_STATE.CAPTURING && this.state !== MIC_STATE.MUTED) return false;
    this._transition(MIC_STATE.IDLE, 'stop-capture');
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

    if (this.state === MIC_STATE.SUSPENDED || this.state === MIC_STATE.OFF) return;

    // Frame period
    const framePeriodMs = (this.frameSize / this.sampleRate) * 1000;
    this._frameAccumulator += dtMs;
    if (this._frameAccumulator < framePeriodMs) return;
    this._frameAccumulator -= framePeriodMs;

    // Simular y procesar un frame
    const frame = this._simulateFrame();
    this._applyHighpass(frame);
    this._applyBeamforming(frame);
    this._applyNoiseSuppression(frame);
    this._applyAGC(frame);
    this._measureLevels(frame);

    // DOA sobre el frame original (antes de beamforming)
    if (this.beamforming && this.scenario !== MIC_SCENARIOS.SILENCE) {
      this._estimateDOA(frame);
    }

    // Push histórico + notificar
    this._pushHistory();
    this._emit('frame', {
      peakDbfs: round(this.peakDbfs, 2),
      rmsDbfs: round(this.rmsDbfs, 2),
      spl: round(this.splEstimate, 1),
      agcGainDb: round(this.agcGainDb, 2),
      doa: { az: round(this._lastDoaAz, 1), el: round(this._lastDoaEl, 1), conf: round(this._doaConfidence, 2) },
      muted: this.muted,
    });
    if (this.bus) this.bus.emit?.('mic:frame', this.getReading());

    // Watchdog
    this._lastFrameAt = this._t * 1000;
    this._runWatchdog(dtMs);

    this.stats.frames++;
    this.stats.totalSamples += this.frameSize * this.channels;
    this.stats.lastFrameAt = this._t;
    if (this.rmsDbfs > -Infinity) this.stats.totalEnergyDb += this.rmsDbfs;
  }

  /* ================================================================ *
   * Simulación de captura
   * ================================================================ */

  _simulateFrame() {
    const N = this.frameSize;
    const sr = this.sampleRate;
    const frame = {
      n: N,
      sr,
      channels: {},
    };

    const srcDir = SCENARIO_DIRECTIONS[this.scenario] || { az: 0, el: 0 };
    const srcAmp = this._scenarioAmplitude();
    const noiseAmp = this._scenarioNoiseAmp();

    for (const id of MIC_IDS) {
      const m = this.mics[id];
      if (!m.enabled || m.health === 'dead') {
        frame.channels[id] = new Float32Array(N);
        continue;
      }

      // Retardo por distancia a la fuente (basado en azimut)
      const azRad = srcDir.az * Math.PI / 180;
      const elRad = srcDir.el * Math.PI / 180;
      const dx = Math.sin(azRad) * Math.cos(elRad);
      const dy = Math.cos(azRad) * Math.cos(elRad);
      const dz = Math.sin(elRad);
      const dist = m.position.x * dx + m.position.y * dy + m.position.z * dz;
      const delayMs = dist / SOUND_SPEED_MM_PER_MS;
      const delaySamples = (delayMs / 1000) * sr;

      // Generar señal
      const buf = new Float32Array(N);
      const phase0 = this.scenarioPhase * 2 * Math.PI;
      const baseFreq = this._scenarioBaseFreq();
      for (let i = 0; i < N; i++) {
        const t = (i + delaySamples) / sr;

        // Componente principal (armónicos de voz / música)
        let s = 0;
        s += Math.sin(2 * Math.PI * baseFreq * t + phase0) * 0.5;
        s += Math.sin(2 * Math.PI * baseFreq * 2 * t + phase0) * 0.2;
        s += Math.sin(2 * Math.PI * baseFreq * 3 * t + phase0) * 0.1;

        // Modulación tipo voz (AM lento)
        const env = 0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 3.5 * t));
        s *= env;

        // Ruido propio del micrófono + ruido ambiente
        const selfNoise = gaussianNoise(dbToLinear(m.selfNoiseDb - 94) * 0.5);
        const ambNoise  = gaussianNoise(noiseAmp);
        const windNoise = this.scenario === MIC_SCENARIOS.WIND
          ? gaussianNoise(0.15) * Math.abs(Math.sin(2 * Math.PI * 0.7 * t))
          : 0;

        // Aplicar amplitud, ganancia del mic y offset DC
        const sample = clamp(
          s * srcAmp * dbToLinear(m.gainDb) + selfNoise + ambNoise + windNoise + m.dcOffset,
          -1, 1
        );
        buf[i] = sample;
      }
      frame.channels[id] = buf;
      this.stats.perMicFrames[id]++;
    }

    this.scenarioPhase += N / sr;
    return frame;
  }

  _scenarioAmplitude() {
    switch (this.scenario) {
      case MIC_SCENARIOS.SILENCE:     return 0.0005;
      case MIC_SCENARIOS.SPEECH_NEAR: return 0.35;
      case MIC_SCENARIOS.SPEECH_FAR:  return 0.08;
      case MIC_SCENARIOS.CALL:        return 0.25;
      case MIC_SCENARIOS.VIDEO:       return 0.2;
      case MIC_SCENARIOS.WIND:        return 0.05;
      case MIC_SCENARIOS.MUSIC:       return 0.4;
      case MIC_SCENARIOS.CROWD:       return 0.15;
      case MIC_SCENARIOS.MECHANICAL:  return 0.12;
      default:                        return 0.05;
    }
  }

  _scenarioNoiseAmp() {
    switch (this.scenario) {
      case MIC_SCENARIOS.SILENCE:     return 0.0008;
      case MIC_SCENARIOS.SPEECH_NEAR: return 0.006;
      case MIC_SCENARIOS.SPEECH_FAR:  return 0.012;
      case MIC_SCENARIOS.CALL:        return 0.01;
      case MIC_SCENARIOS.VIDEO:       return 0.008;
      case MIC_SCENARIOS.WIND:        return 0.05;
      case MIC_SCENARIOS.MUSIC:       return 0.01;
      case MIC_SCENARIOS.CROWD:       return 0.04;
      case MIC_SCENARIOS.MECHANICAL:  return 0.03;
      default:                        return 0.01;
    }
  }

  _scenarioBaseFreq() {
    switch (this.scenario) {
      case MIC_SCENARIOS.MUSIC:       return 220;
      case MIC_SCENARIOS.MECHANICAL:  return 60;
      case MIC_SCENARIOS.WIND:        return 20;
      default:                        return 180;
    }
  }

  /* ================================================================ *
   * DSP
   * ================================================================ */

  _applyHighpass(frame) {
    if (!this.highpassHz || this.highpassHz <= 0) return;
    // Filtro RC de primer orden: y[n] = a*(y[n-1] + x[n] - x[n-1])
    const rc = 1 / (2 * Math.PI * this.highpassHz);
    const dt = 1 / frame.sr;
    const a = rc / (rc + dt);
    for (const id of MIC_IDS) {
      const buf = frame.channels[id];
      if (!buf) continue;
      let prevIn = this._hpPrev.in;
      let prevOut = this._hpPrev.out;
      for (let i = 0; i < buf.length; i++) {
        const x = buf[i];
        const y = a * (prevOut + x - prevIn);
        buf[i] = y;
        prevIn = x;
        prevOut = y;
      }
      this._hpPrev.in = prevIn;
      this._hpPrev.out = prevOut;
    }
  }

  _applyBeamforming(frame) {
    if (!this.beamforming) return;
    const N = frame.n;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let m = 0; m < MIC_IDS.length; m++) {
        const buf = frame.channels[MIC_IDS[m]];
        if (!buf) continue;
        acc += buf[i] * this._beamWeights[m];
      }
      out[i] = acc;
    }
    // Reemplazamos el canal "virtual" beamformed
    frame.channels['__beam'] = out;
  }

  _applyNoiseSuppression(frame) {
    if (this.nsLevel <= 0) return;

    // NS simple: sustracción espectral simplificada con floor de ruido
    // Estimamos RMS del frame y aplicamos atenuación sobre las partes de baja energía.
    const target = frame.channels['__beam'] || frame.channels['bottom-left'];
    if (!target) return;

    const N = target.length;
    // RMS global
    let sum = 0;
    for (let i = 0; i < N; i++) sum += target[i] * target[i];
    const rms = Math.sqrt(sum / N);

    // Threshold adaptativo: si rms por debajo de un piso relativo, atenuar
    const nsFloor = 0.005;
    const strength = this.nsLevel;
    if (rms < nsFloor) {
      const att = 1 - strength * (1 - rms / nsFloor);
      for (let i = 0; i < N; i++) target[i] *= att;
      this.stats.nsActivations++;
    } else {
      // Atenuación suave proporcional
      const att = 1 - strength * 0.15;
      for (let i = 0; i < N; i++) target[i] *= att;
    }
  }

  _applyAGC(frame) {
    if (!this.muted) {
      if (!this.agcEnabled) return;
    }
    const target = frame.channels['__beam'] || frame.channels['bottom-left'];
    if (!target) return;

    const N = target.length;
    let peak = 0, sum = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(target[i]);
      if (a > peak) peak = a;
      sum += target[i] * target[i];
    }
    const rms = Math.sqrt(sum / N);
    const currentDbfs = linearToDb(rms);

    if (!this.agcEnabled) {
      this.agcGainDb = 0;
      return;
    }

    const error = this.agcTarget - currentDbfs;
    const attack = error < 0 ? (1 - Math.exp(-1 / (AGC_ATTACK_MS / (1000 / (N / frame.sr)))))
                              : (1 - Math.exp(-1 / (AGC_RELEASE_MS / (1000 / (N / frame.sr)))));
    this.agcGainDb = clamp(
      lerp(this.agcGainDb, this.agcGainDb + error, attack),
      AGC_GAIN_MIN_DB, AGC_GAIN_MAX_DB
    );
    this.stats.agcAdjustments++;

    const linGain = dbToLinear(this.agcGainDb);
    for (let i = 0; i < N; i++) {
      target[i] = clamp(target[i] * linGain, -1, 1);
    }
  }

  _measureLevels(frame) {
    const target = frame.channels['__beam'] || frame.channels['bottom-left'];
    if (!target) return;

    let peak = 0, sum = 0, clips = 0;
    for (let i = 0; i < target.length; i++) {
      const a = Math.abs(target[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clips++;
      sum += target[i] * target[i];
    }
    const rms = Math.sqrt(sum / target.length);

    this.peakDbfs = linearToDb(peak);
    this.rmsDbfs  = linearToDb(rms);
    this.clipping = clips > 0;
    if (this.clipping) {
      this._clipCount += clips;
      this.stats.clips += clips;
    }

    // Estimar SPL a partir de dBFS + sensibilidad
    this.splEstimate = clamp(
      this.rmsDbfs - MIC_SENSITIVITY_DBFS + SPL_REFERENCE_DB,
      SPL_MIN, SPL_MAX
    );
  }

  /* ================================================================ *
   * DOA
   * ================================================================ */

  _estimateDOA(frame) {
    // Correlación cruzada simplificada entre pares de micrófonos
    // para estimar el retardo y derivar azimut.
    const pairs = [
      ['bottom-left', 'bottom-right'],
      ['top-front', 'bottom-left'],
      ['top-front', 'bottom-right'],
    ];
    let sumAz = 0, sumEl = 0, count = 0;

    for (const [aId, bId] of pairs) {
      const A = frame.channels[aId];
      const B = frame.channels[bId];
      if (!A || !B) continue;

      const lag = this._crossCorrelationLag(A, B, 40);
      const lagMs = (lag / frame.sr) * 1000;
      const dist = lagMs * SOUND_SPEED_MM_PER_MS;
      const dx = this.mics[bId].position.x - this.mics[aId].position.x;
      const dy = this.mics[bId].position.y - this.mics[aId].position.y;
      const denom = Math.hypot(dx, dy) || 1;
      const proj = clamp(dist / denom, -1, 1);

      const az = Math.atan2(dy * proj, dx * proj) * 180 / Math.PI;
      sumAz += az;
      sumEl += 0;
      count++;
    }

    if (count > 0) {
      const measuredAz = ((sumAz / count) % 360 + 360) % 360;
      const prevAz = this._lastDoaAz;
      const deltaAz = ((measuredAz - prevAz + 540) % 360) - 180;
      this._lastDoaAz = (prevAz + deltaAz * 0.3 + 360) % 360;
      this._lastDoaEl = sumEl / count;
      this._doaConfidence = clamp(0.5 + Math.abs(this.rmsDbfs + 40) / 80, 0, 1);
      this.stats.doaUpdates++;
    }
  }

  _crossCorrelationLag(A, B, maxLag) {
    let bestLag = 0;
    let bestCorr = -Infinity;
    const N = Math.min(A.length, B.length);
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = Math.max(0, -lag); i < Math.min(N, N - lag); i++) {
        corr += A[i] * B[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    return bestLag;
  }

  /* ================================================================ *
   * Watchdog
   * ================================================================ */

  _runWatchdog(dtMs) {
    if (!this._watchdogEnabled || !this.powered) return;
    if (this.state !== MIC_STATE.CAPTURING) return;
    const now = this._t * 1000;
    if (now - this._lastFrameAt > 1000) {
      this._watchdogFires++;
      this.stats.watchdogFires++;
      Logger.warn(LOG_TAG, 'Watchdog: sin frames, reinicializando captura');
      this._transition(MIC_STATE.INIT, 'watchdog');
      this._transition(MIC_STATE.IDLE, 'watchdog-done');
      this._transition(MIC_STATE.CAPTURING, 'watchdog-resume');
      this._lastFrameAt = now;
    }
  }

  /* ================================================================ *
   * Cola IRQ
   * ================================================================ */

  _pushIRQ(irq, payload) {
    if (this.irqQueue.length >= 32) {
      this.irqDropped++;
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
      rmsDbfs: round(this.rmsDbfs, 2),
      peakDbfs: round(this.peakDbfs, 2),
      spl: round(this.splEstimate, 1),
      agc: round(this.agcGainDb, 2),
      az: round(this._lastDoaAz, 1),
      muted: this.muted,
      scenario: this.scenario,
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

  getReading() {
    return {
      state: this.state,
      powered: this.powered,
      muted: this.muted,
      profile: this.profileName,
      scenario: this.scenario,
      sampleRate: this.sampleRate,
      bitDepth: this.bitDepth,
      frameSize: this.frameSize,
      channels: this.channels,
      highpassHz: this.highpassHz,
      nsLevel: this.nsLevel,
      agcEnabled: this.agcEnabled,
      agcGainDb: round(this.agcGainDb, 2),
      beamforming: this.beamforming,
      beamAz: this.beamAz,
      beamWidth: this.beamWidth,
      rmsDbfs: round(this.rmsDbfs, 2),
      peakDbfs: round(this.peakDbfs, 2),
      spl: round(this.splEstimate, 1),
      clipping: this.clipping,
      doa: {
        az: round(this._lastDoaAz, 1),
        el: round(this._lastDoaEl, 1),
        confidence: round(this._doaConfidence, 2),
      },
    };
  }

  getStats() {
    return {
      ...this.stats,
      state: this.state,
      muted: this.muted,
      profile: this.profileName,
      scenario: this.scenario,
      frames: this.stats.frames,
      irqPending: this.irqQueue.length,
      irqDropped: this.irqDropped,
      watchdogFires: this._watchdogFires,
    };
  }

  getHistory() { return [...this.history]; }

  getMicStatus() {
    return MIC_IDS.map(id => ({
      id,
      ...this.mics[id],
      weight: round(this._beamWeights[MIC_IDS.indexOf(id)], 3),
    }));
  }

  getSpectrum(numBins = 32) {
    // Espectro simulado del frame actual (log-spaced)
    const bins = new Array(numBins).fill(0);
    const base = this.rmsDbfs > -Infinity ? this.rmsDbfs : -90;
    for (let i = 0; i < numBins; i++) {
      const shape = Math.exp(-Math.pow((i - numBins / 3) / (numBins / 3), 2));
      bins[i] = round(clamp(base + shape * 30 + gaussianNoise(2), -120, 0), 1);
    }
    return bins;
  }

  /* ================================================================ *
   * Calibración
   * ================================================================ */

  calibrateMic(id, referenceDbSpl) {
    const m = this.mics[id];
    if (!m) return false;
    const measured = this.rmsDbfs - MIC_SENSITIVITY_DBFS + SPL_REFERENCE_DB;
    m.gainDb = clamp(referenceDbSpl - measured, -24, 24);
    Logger.info(LOG_TAG, `Mic ${id} calibrado: gainDb=${round(m.gainDb, 2)}`);
    return true;
  }

  resetCalibration() {
    for (const id of MIC_IDS) this.mics[id].gainDb = 0;
    Logger.info(LOG_TAG, 'Calibración reseteada');
  }

  /* ================================================================ *
   * Serialización
   * ================================================================ */

  serialize() {
    return {
      state: this.state,
      powered: this.powered,
      muted: this.muted,
      profileName: this.profileName,
      sampleRate: this.sampleRate,
      bitDepth: this.bitDepth,
      frameSize: this.frameSize,
      channels: this.channels,
      highpassHz: this.highpassHz,
      nsLevel: this.nsLevel,
      agcEnabled: this.agcEnabled,
      agcTarget: this.agcTarget,
      beamforming: this.beamforming,
      beamAz: this.beamAz,
      beamWidth: this.beamWidth,
      mics: Object.fromEntries(MIC_IDS.map(id => [id, { ...this.mics[id] }])),
      stats: { ...this.stats },
    };
  }

  deserialize(data) {
    if (!data) return;
    this.powered = !!data.powered;
    this.muted = !!data.muted;
    this.state = data.state || MIC_STATE.OFF;
    this.profileName = data.profileName || 'default';
    this.sampleRate = data.sampleRate || 48000;
    this.bitDepth = data.bitDepth || 24;
    this.frameSize = data.frameSize || 1024;
    this.channels = data.channels || 4;
    this.highpassHz = data.highpassHz ?? 80;
    this.nsLevel = data.nsLevel ?? 0.6;
    this.agcEnabled = data.agcEnabled ?? true;
    this.agcTarget = data.agcTarget ?? -18;
    this.beamforming = data.beamforming ?? true;
    this.beamAz = data.beamAz ?? 0;
    this.beamWidth = data.beamWidth ?? 60;
    if (data.mics) {
      for (const id of MIC_IDS) {
        if (data.mics[id]) Object.assign(this.mics[id], data.mics[id]);
      }
    }
    if (data.stats) Object.assign(this.stats, data.stats);
    this._recomputeBeamWeights();
    Logger.info(LOG_TAG, 'Estado micrófonos restaurado');
  }

  /* ================================================================ *
   * Utilidades de simulación
   * ================================================================ */

  tickAll(seconds, dtMs = 16.67) {
    const steps = Math.floor((seconds * 1000) / dtMs);
    for (let i = 0; i < steps; i++) this.tick(dtMs);
    return this.getStats();
  }

  captureSeconds(seconds) {
    this.startCapture();
    const prev = this.scenario;
    if (this.scenario === MIC_SCENARIOS.SILENCE) this.setScenario(MIC_SCENARIOS.SPEECH_NEAR);
    const stats = this.tickAll(seconds);
    this.setScenario(prev);
    this.stopCapture();
    return stats;
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VMicrophone dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${r.state}`);
    Logger.kernel(LOG_TAG, `  perfil       : ${r.profile}`);
    Logger.kernel(LOG_TAG, `  escenario    : ${r.scenario}`);
    Logger.kernel(LOG_TAG, `  SR/bit/frame : ${r.sampleRate}Hz / ${r.bitDepth}bit / ${r.frameSize}`);
    Logger.kernel(LOG_TAG, `  canales      : ${r.channels}`);
    Logger.kernel(LOG_TAG, `  muted        : ${r.muted}`);
    Logger.kernel(LOG_TAG, `  RMS/peak     : ${r.rmsDbfs} / ${r.peakDbfs} dBFS`);
    Logger.kernel(LOG_TAG, `  SPL estimado : ${r.spl} dB`);
    Logger.kernel(LOG_TAG, `  AGC gain     : ${r.agcGainDb} dB`);
    Logger.kernel(LOG_TAG, `  NS level     : ${r.nsLevel}`);
    Logger.kernel(LOG_TAG, `  beamforming  : ${r.beamforming ? `${r.beamAz}° ±${r.beamWidth/2}°` : 'off'}`);
    Logger.kernel(LOG_TAG, `  DOA az/el    : ${r.doa.az}° / ${r.doa.el}° (conf ${r.doa.confidence})`);
    Logger.kernel(LOG_TAG, `  frames       : ${this.stats.frames}`);
    Logger.kernel(LOG_TAG, `  samples      : ${this.stats.totalSamples}`);
    Logger.kernel(LOG_TAG, `  clips        : ${this.stats.clips}`);
    Logger.kernel(LOG_TAG, `  watchdog     : ${this.stats.watchdogFires}`);
    Logger.kernel(LOG_TAG, `  IRQ (p/drop) : ${this.irqQueue.length}/${this.irqDropped}`);
    for (const m of this.getMicStatus()) {
      Logger.kernel(LOG_TAG, `    · ${m.id.padEnd(14)} ${m.health.padEnd(9)} gain=${round(m.gainDb,1)}dB w=${m.weight}`);
    }
  }
}

export { MIC_STATE, MIC_SCENARIOS, MIC_PROFILES, NS_LEVELS };

export default VMicrophone;
