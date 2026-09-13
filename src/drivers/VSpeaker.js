// src/drivers/VSpeaker.js
// Subsistema de altavoces virtual — estéreo + woofer dedicado (iPhone 16 Pro)
// Funciones: reproducción multicanal, Spatial Audio con head-tracking,
// Dolby Atmos, perfiles por contenido, limitador de volumen, sincronía háptica.

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'SPK';

/* ------------------------------------------------------------------ *
 * Hardware de salida
 * ------------------------------------------------------------------ */

export const SPEAKER_IDS = ['left', 'right', 'woofer'];

// Posición física (mm) respecto al centro del chasis
const SPEAKER_POSITIONS_MM = {
  'left':   { x: -34, y: -68, z: 0, role: 'tweeter-mid' },
  'right':  { x:  34, y: -68, z: 0, role: 'tweeter-mid' },
  'woofer': { x:   0, y:  60, z: 0, role: 'woofer' },
};

// Respuesta en frecuencia aproximada (Hz)
const SPEAKER_FREQ_RANGE = {
  'left':   { min: 180, max: 20000 },
  'right':  { min: 180, max: 20000 },
  'woofer': { min:  50, max: 500 },
};

// Potencia nominal (W) y SPL máximo (dB @ 1m)
const SPEAKER_POWER_W  = { 'left': 2.0, 'right': 2.0, 'woofer': 3.5 };
const SPEAKER_MAX_SPL  = { 'left': 88,  'right': 88,  'woofer': 94 };

/* ------------------------------------------------------------------ *
 * Constantes de audio
 * ------------------------------------------------------------------ */

const SAMPLE_RATES = [22050, 32000, 44100, 48000, 96000];
const BIT_DEPTHS = [16, 24, 32];
const FRAME_SIZES = [256, 512, 1024, 2048];

// Niveles de volumen
const VOLUME_MIN = 0;
const VOLUME_MAX = 100;
const VOLUME_SAFE_LIMIT = 85;   // límite de seguridad EU (dB)
const VOLUME_HEADPHONE_WARN = 80;

// Protección auditiva
const SPL_DANGER_THRESHOLD_DB = 100;   // > 100 dB sostenido → aviso

// Spatial Audio
const SPATIAL_MODES = {
  OFF:      'off',
  FIXED:    'fixed',       // estéreo tradicional
  HEAD_TRACKED: 'head-tracked',  // sigue la cabeza con AirPods
  AUTO:     'auto',        // decide según contenido
};

/* ------------------------------------------------------------------ *
 * Máquina de estados
 * ------------------------------------------------------------------ */

const SPK_STATE = {
  OFF:      'off',
  INIT:     'init',
  IDLE:     'idle',
  PLAYING:  'playing',
  MUTED:    'muted',
  ROUTING:  'routing',
  FAULT:    'fault',
};

const SPK_TRANSITIONS = {
  [SPK_STATE.OFF]:     [SPK_STATE.INIT],
  [SPK_STATE.INIT]:    [SPK_STATE.IDLE, SPK_STATE.FAULT, SPK_STATE.OFF],
  [SPK_STATE.IDLE]:    [SPK_STATE.PLAYING, SPK_STATE.MUTED, SPK_STATE.ROUTING, SPK_STATE.OFF],
  [SPK_STATE.PLAYING]: [SPK_STATE.IDLE, SPK_STATE.MUTED, SPK_STATE.ROUTING, SPK_STATE.FAULT, SPK_STATE.OFF],
  [SPK_STATE.MUTED]:   [SPK_STATE.IDLE, SPK_STATE.PLAYING, SPK_STATE.OFF],
  [SPK_STATE.ROUTING]: [SPK_STATE.IDLE, SPK_STATE.PLAYING, SPK_STATE.OFF, SPK_STATE.FAULT],
  [SPK_STATE.FAULT]:   [SPK_STATE.INIT, SPK_STATE.OFF],
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
 * Fuentes de reproducción
 * ------------------------------------------------------------------ */

const SPK_SOURCES = {
  NONE:         'none',
  MUSIC:        'music',
  VIDEO:        'video',
  CALL:         'call',
  RINGTONE:     'ringtone',
  ALARM:        'alarm',
  UI_SOUND:     'ui-sound',
  NOTIFICATION: 'notification',
  TTS:          'tts',
  GAME:         'game',
  RECORDING:    'recording',   // playback de Voice Memos
};

// Contenido soportado por Spatial Audio / Atmos
const SPATIAL_SOURCES = new Set([
  SPK_SOURCES.MUSIC, SPK_SOURCES.VIDEO, SPK_SOURCES.GAME,
]);

// Fuentes mono forzadas
const MONO_SOURCES = new Set([
  SPK_SOURCES.CALL, SPK_SOURCES.TTS,
]);

/* ------------------------------------------------------------------ *
 * Perfiles de audio
 * ------------------------------------------------------------------ */

const SPK_PROFILES = {
  DEFAULT: {
    name: 'default',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    spatialMode: SPATIAL_MODES.AUTO,
    atmosEnabled: true,
    bassBoostDb: 0, trebleBoostDb: 0,
    loudnessEq: false,
    monoDownmix: false,
    targetSpl: 75,
  },
  MUSIC: {
    name: 'music',
    sampleRate: 48000, bitDepth: 24, frameSize: 2048,
    spatialMode: SPATIAL_MODES.HEAD_TRACKED,
    atmosEnabled: true,
    bassBoostDb: 3, trebleBoostDb: 1,
    loudnessEq: true,
    monoDownmix: false,
    targetSpl: 82,
  },
  VIDEO: {
    name: 'video',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    spatialMode: SPATIAL_MODES.HEAD_TRACKED,
    atmosEnabled: true,
    bassBoostDb: 2, trebleBoostDb: 0,
    loudnessEq: true,
    monoDownmix: false,
    targetSpl: 80,
  },
  CALL: {
    name: 'call',
    sampleRate: 16000, bitDepth: 16, frameSize: 256,
    spatialMode: SPATIAL_MODES.OFF,
    atmosEnabled: false,
    bassBoostDb: -2, trebleBoostDb: 2,
    loudnessEq: false,
    monoDownmix: true,
    targetSpl: 78,
  },
  ALARM: {
    name: 'alarm',
    sampleRate: 44100, bitDepth: 16, frameSize: 512,
    spatialMode: SPATIAL_MODES.OFF,
    atmosEnabled: false,
    bassBoostDb: 0, trebleBoostDb: 4,
    loudnessEq: false,
    monoDownmix: true,
    targetSpl: 90,
  },
  UI: {
    name: 'ui',
    sampleRate: 44100, bitDepth: 16, frameSize: 256,
    spatialMode: SPATIAL_MODES.OFF,
    atmosEnabled: false,
    bassBoostDb: 0, trebleBoostDb: 0,
    loudnessEq: false,
    monoDownmix: true,
    targetSpl: 65,
  },
  GAME: {
    name: 'game',
    sampleRate: 48000, bitDepth: 24, frameSize: 1024,
    spatialMode: SPATIAL_MODES.HEAD_TRACKED,
    atmosEnabled: true,
    bassBoostDb: 4, trebleBoostDb: 0,
    loudnessEq: true,
    monoDownmix: false,
    targetSpl: 84,
  },
  LOW_POWER: {
    name: 'low-power',
    sampleRate: 32000, bitDepth: 16, frameSize: 512,
    spatialMode: SPATIAL_MODES.OFF,
    atmosEnabled: false,
    bassBoostDb: -1, trebleBoostDb: 0,
    loudnessEq: false,
    monoDownmix: false,
    targetSpl: 72,
  },
};

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class VSpeaker {
  constructor(bus = null, options = {}) {
    this.bus = bus;

    // --- Estado ---
    this.state       = SPK_STATE.OFF;
    this.powered     = false;
    this.muted       = false;
    this.profileName = 'default';
    this.profile     = SPK_PROFILES.DEFAULT;

    // --- Configuración efectiva ---
    this.sampleRate = this.profile.sampleRate;
    this.bitDepth   = this.profile.bitDepth;
    this.frameSize  = this.profile.frameSize;
    this.spatialMode = this.profile.spatialMode;
    this.atmosEnabled = this.profile.atmosEnabled;
    this.bassBoostDb = this.profile.bassBoostDb;
    this.trebleBoostDb = this.profile.trebleBoostDb;
    this.loudnessEq = this.profile.loudnessEq;
    this.monoDownmix = this.profile.monoDownmix;

    // --- Volumen ---
    this.volume = 60;            // 0-100
    this.volumeDb = 0;
    this.maxVolume = VOLUME_MAX;
    this.safeLimit = VOLUME_SAFE_LIMIT;
    this._volumeRamp = null;

    // --- Fuente actual ---
    this.source = SPK_SOURCES.NONE;
    this.sourcePhase = 0;
    this.sourceVolume = 1.0;

    // --- Spatial Audio ---
    this.headAz = 0;             // azimut de la cabeza (grados)
    this.headEl = 0;
    this.headRoll = 0;
    this.spatialWidth = 1.0;
    this._spatialPhase = 0;

    // --- Dolby Atmos ---
    this.atmosObjects = 0;       // número de objetos de audio en la escena
    this.atmosBedLevel = 0;

    // --- Estado por altavoz ---
    this.speakers = {};
    for (const id of SPEAKER_IDS) {
      this.speakers[id] = {
        id,
        position: SPEAKER_POSITIONS_MM[id],
        freqRange: SPEAKER_FREQ_RANGE[id],
        powerW: SPEAKER_POWER_W[id],
        maxSpl: SPEAKER_MAX_SPL[id],
        enabled: true,
        gainDb: 0,
        lastSample: 0,
        splEstimate: 0,
        temperature: 25,
        health: 'ok',    // 'ok' | 'degraded' | 'overheat' | 'dead'
      };
    }

    // --- Métricas de nivel ---
    this.peakDbfs = -Infinity;
    this.rmsDbfs  = -Infinity;
    this.currentSpl = 0;
    this.limiterActive = false;
    this._limiterReductionDb = 0;
    this.clipping = false;

    // --- Protección auditiva ---
    this._loudExposureMs = 0;    // ms acumulados por encima del umbral
    this._warningIssued = false;

    // --- Crossfade de mute ---
    this._muteFadeMs = 0;

    // --- Watchdog ---
    this._lastFrameAt = 0;
    this._watchdogFires = 0;
    this._watchdogEnabled = true;

    // --- Cola IRQ ---
    this.irqQueue = [];
    this.irqDropped = 0;

    // --- Vinculaciones ---
    this.linkedTaptic  = null;
    this.linkedMicrophone = null;
    this.linkedCellular = null;
    this.linkedBluetooth = null;   // para rutear a AirPods

    // --- Rutas de salida ---
    this.route = 'speaker';   // 'speaker' | 'bluetooth' | 'airplay' | 'headphones'
    this.routeLatencyMs = 0;

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
      limiterTriggers: 0,
      volumeChanges: 0,
      muteEvents: 0,
      unmuteEvents: 0,
      sourceChanges: 0,
      routeChanges: 0,
      loudWarnings: 0,
      stateTransitions: 0,
      lastFrameAt: 0,
      totalEnergyDb: 0,
      perSpeakerFrames: Object.fromEntries(SPEAKER_IDS.map(id => [id, 0])),
    };

    // --- Internos ---
    this._t = 0;
    this._frameAccumulator = 0;

    // --- Registro en bus ---
    if (this.bus && typeof this.bus.registerDevice === 'function') {
      this.bus.registerDevice({
        id: 'spk0',
        kind: 'speaker-array',
        model: 'Stereo + woofer (iPhone 16 Pro)',
        capabilities: ['playback', 'spatial-audio', 'atmos', 'stereo', 'mono'],
        irq: 'IRQ_SPK',
      });
    }

    Logger.debug(LOG_TAG, 'VSpeaker instanciado (estéreo + woofer)');
  }

  /* ================================================================ *
   * FSM
   * ================================================================ */

  _canTransition(to) {
    return (SPK_TRANSITIONS[this.state] || []).includes(to);
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
    this._transition(SPK_STATE.INIT, 'power-on');
    this._transition(SPK_STATE.IDLE, 'init-done');
    Logger.info(LOG_TAG, 'Sistema de altavoces encendido');
    this._emit('power', { on: true });
  }

  powerOff() {
    if (!this.powered) return;
    this.powered = false;
    this._transition(SPK_STATE.OFF, 'power-off');
    Logger.info(LOG_TAG, 'Sistema de altavoces apagado');
    this._emit('power', { on: false });
  }

  mute() {
    if (this.muted) return;
    this.muted = true;
    this.stats.muteEvents++;
    this._muteFadeMs = 0;
    if (this.state === SPK_STATE.PLAYING) {
      this._transition(SPK_STATE.MUTED, 'mute');
    }
    Logger.info(LOG_TAG, 'Altavoces silenciados');
    this._emit('mute', { muted: true });
    this._pushIRQ('IRQ_SPK', { kind: 'mute' });
  }

  unmute() {
    if (!this.muted) return;
    this.muted = false;
    this.stats.unmuteEvents++;
    if (this.state === SPK_STATE.MUTED) {
      this._transition(SPK_STATE.PLAYING, 'unmute');
    }
    Logger.info(LOG_TAG, 'Altavoces activados');
    this._emit('mute', { muted: false });
    this._pushIRQ('IRQ_SPK', { kind: 'unmute' });
  }

  reset() {
    this.peakDbfs = -Infinity;
    this.rmsDbfs = -Infinity;
    this.currentSpl = 0;
    this.clipping = false;
    this.limiterActive = false;
    this._limiterReductionDb = 0;
    this._frameAccumulator = 0;
    this._loudExposureMs = 0;
    this._warningIssued = false;
    this.irqQueue = [];
    this._transition(SPK_STATE.INIT, 'reset');
    this._transition(SPK_STATE.IDLE, 'reset-done');
    Logger.warn(LOG_TAG, 'Sistema de altavoces reseteado');
  }

  /* ================================================================ *
   * Vinculaciones
   * ================================================================ */

  linkTaptic(t)      { this.linkedTaptic = t;     Logger.debug(LOG_TAG, 'Vinculado a VTapticEngine'); }
  linkMicrophone(m)  { this.linkedMicrophone = m; Logger.debug(LOG_TAG, 'Vinculado a VMicrophone'); }
  linkCellular(c)    { this.linkedCellular = c;   Logger.debug(LOG_TAG, 'Vinculado a VCellular'); }
  linkBluetooth(bt)  { this.linkedBluetooth = bt; Logger.debug(LOG_TAG, 'Vinculado a VBT'); }

  /* ================================================================ *
   * Configuración
   * ================================================================ */

  setVolume(v) {
    const prev = this.volume;
    this.volume = clamp(v, VOLUME_MIN, this.maxVolume);
    this.volumeDb = this._volumeToDb(this.volume);
    if (prev !== this.volume) {
      this.stats.volumeChanges++;
      this._emit('volume', { volume: this.volume, db: round(this.volumeDb, 2) });
      this._pushIRQ('IRQ_SPK', { kind: 'volume', value: this.volume });
    }
    // Rampa suave
    this._volumeRamp = { from: prev, to: this.volume, t: 0, durMs: 80 };
    return this.volume;
  }

  setVolumeDb(db) {
    const linear = dbToLinear(db);
    return this.setVolume(clamp(linear * 100, VOLUME_MIN, this.maxVolume));
  }

  _volumeToDb(v) {
    // Curva perceptual: 0-100 → -60 … 0 dB
    if (v <= 0) return -60;
    return -60 + 60 * (v / this.maxVolume);
  }

  setSampleRate(sr) {
    if (!SAMPLE_RATES.includes(sr)) return false;
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

  setSpatialMode(mode) {
    if (!Object.values(SPATIAL_MODES).includes(mode)) return false;
    this.spatialMode = mode;
    Logger.debug(LOG_TAG, `Spatial mode: ${mode}`);
    return true;
  }

  setAtmos(on) {
    this.atmosEnabled = !!on;
    return true;
  }

  setBassBoost(db) {
    this.bassBoostDb = clamp(db, -12, 12);
    return true;
  }

  setTrebleBoost(db) {
    this.trebleBoostDb = clamp(db, -12, 12);
    return true;
  }

  setMonoDownmix(on) {
    this.monoDownmix = !!on;
    return true;
  }

  setRoute(route) {
    const valid = ['speaker', 'bluetooth', 'airplay', 'headphones'];
    if (!valid.includes(route)) return false;
    const prev = this.route;
    this.route = route;
    this.routeLatencyMs = route === 'bluetooth' ? 180 : route === 'airplay' ? 250 : 0;
    this.stats.routeChanges++;
    Logger.info(LOG_TAG, `Ruta: ${prev} → ${route} (latencia ${this.routeLatencyMs}ms)`);
    this._emit('route', { route, latency: this.routeLatencyMs });
    return true;
  }

  /* ================================================================ *
   * Perfiles
   * ================================================================ */

  applyProfile(name) {
    const key = String(name).toUpperCase().replace(/-/g, '_');
    const p = SPK_PROFILES[key];
    if (!p) {
      Logger.warn(LOG_TAG, `Perfil desconocido: ${name}`);
      return false;
    }
    this.profile = p;
    this.profileName = p.name;
    this.sampleRate = p.sampleRate;
    this.bitDepth = p.bitDepth;
    this.frameSize = p.frameSize;
    this.spatialMode = p.spatialMode;
    this.atmosEnabled = p.atmosEnabled;
    this.bassBoostDb = p.bassBoostDb;
    this.trebleBoostDb = p.trebleBoostDb;
    this.loudnessEq = p.loudnessEq;
    this.monoDownmix = p.monoDownmix;
    Logger.debug(LOG_TAG, `Perfil aplicado: ${p.name}`);
    this._emit('profile', { name: p.name });
    return true;
  }

  /* ================================================================ *
   * Reproducción
   * ================================================================ */

  play(source = SPK_SOURCES.MUSIC, volume = 1.0) {
    if (!this.powered) return false;
    const prev = this.source;
    this.source = source;
    this.sourceVolume = clamp(volume, 0, 1);
    this.sourcePhase = 0;
    this.stats.sourceChanges++;
    this.autoSelectProfile();
    if (this.state === SPK_STATE.IDLE || this.state === SPK_STATE.MUTED) {
      this._transition(SPK_STATE.PLAYING, `play:${source}`);
    }
    Logger.info(LOG_TAG, `Reproduciendo ${source} (vol ${round(this.sourceVolume, 2)})`);
    this._emit('source', { from: prev, to: source });
    return true;
  }

  stop() {
    this.source = SPK_SOURCES.NONE;
    if (this.state === SPK_STATE.PLAYING) {
      this._transition(SPK_STATE.IDLE, 'stop');
    }
    return true;
  }

  autoSelectProfile() {
    switch (this.source) {
      case SPK_SOURCES.MUSIC:        return this.applyProfile('music');
      case SPK_SOURCES.VIDEO:        return this.applyProfile('video');
      case SPK_SOURCES.CALL:         return this.applyProfile('call');
      case SPK_SOURCES.RINGTONE:
      case SPK_SOURCES.ALARM:        return this.applyProfile('alarm');
      case SPK_SOURCES.UI_SOUND:
      case SPK_SOURCES.NOTIFICATION: return this.applyProfile('ui');
      case SPK_SOURCES.GAME:         return this.applyProfile('game');
      default:                       return this.applyProfile('default');
    }
  }

  /* ================================================================ *
   * Tick principal
   * ================================================================ */

  tick(dtMs) {
    if (!this.powered) return;
    const dt = dtMs / 1000;
    this._t += dt;
    this.stats.powerOnMs += dtMs;

    if (this.state === SPK_STATE.OFF || this.state === SPK_STATE.ROUTING) return;

    // Rampa de volumen
    if (this._volumeRamp) {
      this._volumeRamp.t += dtMs;
      const k = clamp(this._volumeRamp.t / this._volumeRamp.durMs, 0, 1);
      this.volume = lerp(this._volumeRamp.from, this._volumeRamp.to, k);
      this.volumeDb = this._volumeToDb(this.volume);
      if (k >= 1) this._volumeRamp = null;
    }

    // Actualizar head-tracking (Spatial Audio)
    this._updateHeadTracking(dt);

    // Frame period
    const framePeriodMs = (this.frameSize / this.sampleRate) * 1000;
    this._frameAccumulator += dtMs;
    if (this._frameAccumulator < framePeriodMs) return;
    this._frameAccumulator -= framePeriodMs;

    // Generar frame de audio
    const frame = this._generateFrame();

    // Procesado
    this._applySpatialMix(frame);
    this._applyEQ(frame);
    this._applyLimiter(frame);
    this._applyMuteFade(frame);
    this._measureLevels(frame);

    // Protección auditiva
    this._checkLoudExposure(dtMs);

    // Sincronía háptica (para UI sounds)
    if (this.source === SPK_SOURCES.UI_SOUND && this.linkedTaptic) {
      this.linkedTaptic.play?.('light');
    }

    // Push histórico
    this._pushHistory();
    this._emit('frame', {
      spl: round(this.currentSpl, 1),
      rmsDbfs: round(this.rmsDbfs, 2),
      limiter: this.limiterActive,
      reduction: round(this._limiterReductionDb, 2),
      volume: this.volume,
    });
    if (this.bus) this.bus.emit?.('spk:frame', this.getReading());

    this._lastFrameAt = this._t * 1000;
    this._runWatchdog(dtMs);

    this.stats.frames++;
    this.stats.totalSamples += this.frameSize * (this.monoDownmix ? 1 : 2);
    this.stats.lastFrameAt = this._t;
    if (this.rmsDbfs > -Infinity) this.stats.totalEnergyDb += this.rmsDbfs;
  }

  /* ================================================================ *
   * Generación de audio
   * ================================================================ */

  _generateFrame() {
    const N = this.frameSize;
    const sr = this.sampleRate;
    const frame = {
      n: N,
      sr,
      channels: {},   // por altavoz
      l: null,
      r: null,
      w: null,
    };

    const baseAmp = this._sourceAmplitude();
    const freq = this._sourceBaseFreq();

    // Buffer L / R / W
    const L = new Float32Array(N);
    const R = new Float32Array(N);
    const W = new Float32Array(N);

    // Fase global
    const phase0 = this.sourcePhase * 2 * Math.PI;

    for (let i = 0; i < N; i++) {
      const t = i / sr;

      // Señal estéreo decorrelacionada (L + Ligeramente distinto)
      const s1 = Math.sin(2 * Math.PI * freq * t + phase0) * 0.55;
      const s2 = Math.sin(2 * Math.PI * freq * 1.005 * t + phase0 + 0.3) * 0.45;
      const s3 = Math.sin(2 * Math.PI * freq * 2 * t + phase0) * 0.15;

      // Ruido suave para naturalidad
      const noise = gaussianNoise(0.001);

      // Componente mono central (música tiene centro)
      const center = (s1 + s2) * 0.5;

      // Aplicar ancho estéreo
      const w = this.spatialWidth;
      L[i] = clamp((center + (s1 - s2) * w * 0.5 + s3) * baseAmp + noise, -1, 1);
      R[i] = clamp((center - (s1 - s2) * w * 0.5 + s3) * baseAmp + noise, -1, 1);

      // Woofer: solo bajas frecuencias (LPF simplificado)
      const lowFreq = Math.sin(2 * Math.PI * (freq / 4) * t + phase0) * 0.7;
      W[i] = clamp(lowFreq * baseAmp * 0.8 + noise * 0.5, -1, 1);
    }

    // Downmix mono si aplica
    if (this.monoDownmix) {
      for (let i = 0; i < N; i++) {
        const m = (L[i] + R[i]) * 0.5;
        L[i] = m; R[i] = m;
      }
    }

    frame.l = L; frame.r = R; frame.w = W;
    frame.channels['left']   = L;
    frame.channels['right']  = R;
    frame.channels['woofer'] = W;

    this.sourcePhase += N / sr;
    return frame;
  }

  _sourceAmplitude() {
    switch (this.source) {
      case SPK_SOURCES.NONE:         return 0.0;
      case SPK_SOURCES.MUSIC:        return 0.32;
      case SPK_SOURCES.VIDEO:        return 0.28;
      case SPK_SOURCES.CALL:         return 0.22;
      case SPK_SOURCES.RINGTONE:     return 0.45;
      case SPK_SOURCES.ALARM:        return 0.5;
      case SPK_SOURCES.UI_SOUND:     return 0.10;
      case SPK_SOURCES.NOTIFICATION: return 0.18;
      case SPK_SOURCES.TTS:          return 0.25;
      case SPK_SOURCES.GAME:         return 0.30;
      case SPK_SOURCES.RECORDING:    return 0.26;
      default:                       return 0.0;
    }
  }

  _sourceBaseFreq() {
    switch (this.source) {
      case SPK_SOURCES.MUSIC:        return 220;
      case SPK_SOURCES.VIDEO:        return 180;
      case SPK_SOURCES.CALL:         return 300;
      case SPK_SOURCES.RINGTONE:     return 660;
      case SPK_SOURCES.ALARM:        return 880;
      case SPK_SOURCES.UI_SOUND:     return 1200;
      case SPK_SOURCES.NOTIFICATION: return 1046;
      case SPK_SOURCES.TTS:          return 200;
      case SPK_SOURCES.GAME:         return 260;
      case SPK_SOURCES.RECORDING:    return 240;
      default:                       return 220;
    }
  }

  /* ================================================================ *
   * Spatial Audio con head-tracking
   * ================================================================ */

  _updateHeadTracking(dt) {
    if (this.spatialMode !== SPATIAL_MODES.HEAD_TRACKED) return;
    // Movimiento natural de cabeza (respiración + micromovimientos)
    const t = this._t;
    this.headAz = Math.sin(t * 0.31) * 12 + gaussianNoise(0.3);
    this.headEl = Math.sin(t * 0.47) * 4 + gaussianNoise(0.2);
    this.headRoll = Math.sin(t * 0.19) * 3 + gaussianNoise(0.2);
    this._spatialPhase += dt;
  }

  _applySpatialMix(frame) {
    if (this.spatialMode === SPATIAL_MODES.OFF) return;
    if (!SPATIAL_SOURCES.has(this.source)) return;

    const azRad = this.headAz * Math.PI / 180;
    const gainL = 0.5 + 0.5 * Math.cos(azRad);
    const gainR = 0.5 + 0.5 * Math.cos(azRad + Math.PI);

    for (let i = 0; i < frame.n; i++) {
      frame.l[i] *= 2 * gainL - 1;
      frame.r[i] *= 2 * gainR - 1;
    }
  }

  /* ================================================================ *
   * EQ (bass/treble boost)
   * ================================================================ */

  _applyEQ(frame) {
    const bassGain = dbToLinear(this.bassBoostDb);
    const trebleGain = dbToLinear(this.trebleBoostDb);

    // Aplicamos bass boost al woofer y treble a L/R
    if (this.bassBoostDb !== 0) {
      for (let i = 0; i < frame.n; i++) {
        frame.w[i] = clamp(frame.w[i] * bassGain, -1, 1);
      }
    }
    if (this.trebleBoostDb !== 0) {
      for (let i = 0; i < frame.n; i++) {
        frame.l[i] = clamp(frame.l[i] * trebleGain, -1, 1);
        frame.r[i] = clamp(frame.r[i] * trebleGain, -1, 1);
      }
    }

    // Loudness EQ: refuerza extremos a bajo volumen (curva Fletcher-Munson)
    if (this.loudnessEq && this.volume < 40) {
      const compFactor = (40 - this.volume) / 40;   // 0..1
      const boost = 1 + compFactor * 0.35;
      for (let i = 0; i < frame.n; i++) {
        frame.w[i] = clamp(frame.w[i] * boost, -1, 1);
        frame.l[i] = clamp(frame.l[i] * (1 + compFactor * 0.15), -1, 1);
        frame.r[i] = clamp(frame.r[i] * (1 + compFactor * 0.15), -1, 1);
      }
    }
  }

  /* ================================================================ *
   * Limitador (protección)
   * ================================================================ */

  _applyLimiter(frame) {
    // Aplicar volumen actual
    const volLin = dbToLinear(this.volumeDb);
    for (const spk of SPEAKER_IDS) {
      const buf = frame.channels[spk];
      if (!buf) continue;
      for (let i = 0; i < buf.length; i++) {
        buf[i] = clamp(buf[i] * volLin, -0.999, 0.999);
      }
    }

    // Peak del frame post-volumen
    let peak = 0;
    for (const spk of SPEAKER_IDS) {
      const buf = frame.channels[spk];
      if (!buf) continue;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
    }

    const targetCeiling = 0.98;
    if (peak > targetCeiling) {
      const reduction = targetCeiling / peak;
      const reductionDb = linearToDb(reduction);
      this._limiterReductionDb = reductionDb;
      this.limiterActive = true;
      this.stats.limiterTriggers++;
      for (const spk of SPEAKER_IDS) {
        const buf = frame.channels[spk];
        if (!buf) continue;
        for (let i = 0; i < buf.length; i++) buf[i] *= reduction;
      }
    } else {
      this.limiterActive = false;
      this._limiterReductionDb = lerp(this._limiterReductionDb, 0, 0.3);
    }
  }

  _applyMuteFade(frame) {
    if (!this.muted) return;
    // Fade rápido (10ms)
    const fadeSamples = Math.max(1, Math.round(this.sampleRate * 0.010));
    const step = 1 / fadeSamples;
    for (const spk of SPEAKER_IDS) {
      const buf = frame.channels[spk];
      if (!buf) continue;
      for (let i = 0; i < buf.length; i++) {
        const k = clamp(1 - (this._muteFadeMs / 10), 0, 1);
        buf[i] *= k;
      }
    }
    this._muteFadeMs = Math.min(this._muteFadeMs + (frame.n / this.sampleRate) * 1000, 10);
  }

  /* ================================================================ *
   * Medición de niveles
   * ================================================================ */

  _measureLevels(frame) {
    let peak = 0, sum = 0, count = 0;
    for (const spk of SPEAKER_IDS) {
      const buf = frame.channels[spk];
      if (!buf) continue;
      let spkPeak = 0, spkSum = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > spkPeak) spkPeak = a;
        spkSum += buf[i] * buf[i];
      }
      const spkRms = Math.sqrt(spkSum / buf.length);
      this.speakers[spk].splEstimate = clamp(
        linearToDb(spkRms) + this.speakers[spk].maxSpl - 20,
        0, 130
      );
      if (spkPeak > peak) peak = spkPeak;
      sum += spkSum;
      count += buf.length;
      this.stats.perSpeakerFrames[spk]++;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    this.peakDbfs = linearToDb(peak);
    this.rmsDbfs = linearToDb(rms);
    this.currentSpl = clamp(
      this.rmsDbfs + 94 + (this.volume - 60) * 0.15,
      0, 130
    );
    this.clipping = peak >= 0.999;
  }

  /* ================================================================ *
   * Protección auditiva
   * ================================================================ */

  _checkLoudExposure(dtMs) {
    if (this.currentSpl > SPL_DANGER_THRESHOLD_DB) {
      this._loudExposureMs += dtMs;
      if (this._loudExposureMs > 30000 && !this._warningIssued) {
        this._warningIssued = true;
        this.stats.loudWarnings++;
        Logger.warn(LOG_TAG, `Exposición alta sostenida (${round(this.currentSpl, 1)} dB) — sugerir bajar volumen`);
        this._emit('loud-warning', { spl: this.currentSpl, ms: this._loudExposureMs });
        this._pushIRQ('IRQ_SPK', { kind: 'loud-warning' });
      }
    } else {
      this._loudExposureMs = Math.max(0, this._loudExposureMs - dtMs * 0.5);
      if (this._loudExposureMs < 1000) this._warningIssued = false;
    }
  }

  /* ================================================================ *
   * Watchdog
   * ================================================================ */

  _runWatchdog(dtMs) {
    if (!this._watchdogEnabled || !this.powered) return;
    if (this.state !== SPK_STATE.PLAYING) return;
    const now = this._t * 1000;
    if (now - this._lastFrameAt > 1000) {
      this._watchdogFires++;
      this.stats.watchdogFires = (this.stats.watchdogFires || 0) + 1;
      Logger.warn(LOG_TAG, 'Watchdog: sin frames de audio, reiniciando pipeline');
      this._transition(SPK_STATE.FAULT, 'watchdog');
      this._transition(SPK_STATE.INIT, 'recover');
      this._transition(SPK_STATE.IDLE, 'recover-done');
      if (this.source !== SPK_SOURCES.NONE) {
        this._transition(SPK_STATE.PLAYING, 'recover-resume');
      }
      this._lastFrameAt = now;
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
    this.history.push({
      t: this._t,
      spl: round(this.currentSpl, 1),
      rmsDbfs: round(this.rmsDbfs, 2),
      volume: round(this.volume, 1),
      limiter: this.limiterActive,
      source: this.source,
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
      source: this.source,
      sourceVolume: round(this.sourceVolume, 2),
      sampleRate: this.sampleRate,
      bitDepth: this.bitDepth,
      frameSize: this.frameSize,
      volume: round(this.volume, 1),
      volumeDb: round(this.volumeDb, 2),
      spatialMode: this.spatialMode,
      atmosEnabled: this.atmosEnabled,
      atmosObjects: this.atmosObjects,
      bassBoostDb: this.bassBoostDb,
      trebleBoostDb: this.trebleBoostDb,
      loudnessEq: this.loudnessEq,
      monoDownmix: this.monoDownmix,
      route: this.route,
      routeLatencyMs: this.routeLatencyMs,
      headTracking: {
        az: round(this.headAz, 1),
        el: round(this.headEl, 1),
        roll: round(this.headRoll, 1),
      },
      spl: round(this.currentSpl, 1),
      rmsDbfs: round(this.rmsDbfs, 2),
      peakDbfs: round(this.peakDbfs, 2),
      limiterActive: this.limiterActive,
      limiterReductionDb: round(this._limiterReductionDb, 2),
      clipping: this.clipping,
      loudExposureMs: Math.round(this._loudExposureMs),
    };
  }

  getStats() {
    return {
      ...this.stats,
      state: this.state,
      muted: this.muted,
      source: this.source,
      profile: this.profileName,
      volume: round(this.volume, 1),
      irqPending: this.irqQueue.length,
      irqDropped: this.irqDropped,
      watchdogFires: this._watchdogFires,
    };
  }

  getHistory() { return [...this.history]; }

  getSpeakerStatus() {
    return SPEAKER_IDS.map(id => ({
      id,
      ...this.speakers[id],
      gainDb: round(this.speakers[id].gainDb, 2),
    }));
  }

  getSpectrum(numBins = 32) {
    const bins = new Array(numBins).fill(0);
    const base = this.rmsDbfs > -Infinity ? this.rmsDbfs : -90;
    const bassPeak = this.bassBoostDb > 0 ? this.bassBoostDb : 0;
    const treblePeak = this.trebleBoostDb > 0 ? this.trebleBoostDb : 0;
    for (let i = 0; i < numBins; i++) {
      const x = i / (numBins - 1);
      const shape = Math.exp(-Math.pow((x - 0.4) / 0.35, 2));
      const bass = x < 0.25 ? bassPeak : 0;
      const treble = x > 0.75 ? treblePeak : 0;
      bins[i] = round(clamp(base + shape * 20 + bass + treble + gaussianNoise(1.5), -120, 0), 1);
    }
    return bins;
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const r = this.getReading();
    Logger.kernel(LOG_TAG, '─── VSpeaker dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${r.state}`);
    Logger.kernel(LOG_TAG, `  perfil       : ${r.profile}`);
    Logger.kernel(LOG_TAG, `  fuente       : ${r.source}`);
    Logger.kernel(LOG_TAG, `  SR/bit/frame : ${r.sampleRate}Hz / ${r.bitDepth}bit / ${r.frameSize}`);
    Logger.kernel(LOG_TAG, `  volumen      : ${r.volume} (${r.volumeDb} dB)`);
    Logger.kernel(LOG_TAG, `  muted        : ${r.muted}`);
    Logger.kernel(LOG_TAG, `  ruta         : ${r.route} (lat ${r.routeLatencyMs}ms)`);
    Logger.kernel(LOG_TAG, `  spatial      : ${r.spatialMode}`);
    Logger.kernel(LOG_TAG, `  atmos        : ${r.atmosEnabled} (objs ${r.atmosObjects})`);
    Logger.kernel(LOG_TAG, `  head-track   : az ${r.headTracking.az}° el ${r.headTracking.el}°`);
    Logger.kernel(LOG_TAG, `  SPL/RMS/peak : ${r.spl} / ${r.rmsDbfs} / ${r.peakDbfs}`);
    Logger.kernel(LOG_TAG, `  limiter      : ${r.limiterActive} (red ${r.limiterReductionDb} dB)`);
    Logger.kernel(LOG_TAG, `  loud expo    : ${r.loudExposureMs}ms`);
    Logger.kernel(LOG_TAG, `  frames       : ${this.stats.frames}`);
    Logger.kernel(LOG_TAG, `  samples      : ${this.stats.totalSamples}`);
    Logger.kernel(LOG_TAG, `  limiter trig : ${this.stats.limiterTriggers}`);
    Logger.kernel(LOG_TAG, `  watchdog     : ${this.stats.watchdogFires || 0}`);
    Logger.kernel(LOG_TAG, `  IRQ (p/drop) : ${this.irqQueue.length}/${this.irqDropped}`);
    for (const s of this.getSpeakerStatus()) {
      Logger.kernel(LOG_TAG, `    · ${s.id.padEnd(7)} ${s.health.padEnd(10)} gain=${s.gainDb}dB SPL≈${round(s.splEstimate,1)}`);
    }
  }
}

export { SPK_STATE, SPK_SOURCES, SPK_PROFILES, SPATIAL_MODES };

export default VSpeaker;
