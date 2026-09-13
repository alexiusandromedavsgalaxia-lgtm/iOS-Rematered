// src/drivers/VCamera.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VCamera (Virtual Camera System)
 * ═══════════════════════════════════════════════════════════════
 *
 * Sistema de cámara completo. Modela las 4 cámaras físicas del
 * iPhone (wide 48MP, ultrawide 48MP, tele 12MP, frontal TrueDepth)
 * más el pipeline de procesamiento (ISP), flash, LiDAR, y Face ID.
 *
 * Responsabilidades:
 *   - 4 cámaras con specs reales (apertura, sensor, estabilización)
 *   - Estados: idle / preview / capturing / recording / processing /
 *     error / paused
 *   - Modos: photo / video / portrait / cinematic / proRAW / night /
 *     macro / live / slo-mo / time-lapse / pano
 *   - Zoom óptico (0.5x, 1x, 2x, 3x, 5x) + digital hasta 25x
 *   - Configuración manual: ISO, exposure, WB, focus, flash
 *   - Pipeline ISP: Deep Fusion, Smart HDR, Night mode, ProRAW
 *   - Grabación 4K120 / 1080p240 / ProRes / Dolby Vision
 *   - Estabilización OIS + EIS
 *   - Flash LED (True Tone) con temperatura y duración
 *   - LiDAR para autofocus y AR
 *   - TrueDepth + Face ID enrollment & matching
 *   - Galería interna de fotos y vídeos
 *   - Consumo energético (muy alto, como en la realidad)
 *   - IRQ_CAMERA con eventos: capture, recording-start/stop,
 *     faceid-match, faceid-enroll, lidar-reading
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const CameraState = {
  IDLE:       'idle',
  PREVIEW:    'preview',
  CAPTURING:  'capturing',
  RECORDING:  'recording',
  PROCESSING: 'processing',
  PAUSED:     'paused',
  ERROR:      'error',
};

export const CaptureMode = {
  PHOTO:      'photo',
  VIDEO:      'video',
  PORTRAIT:   'portrait',
  CINEMATIC:  'cinematic',
  PRORAW:     'proraw',
  NIGHT:      'night',
  MACRO:      'macro',
  LIVE:       'live',
  SLOMO:      'slo-mo',
  TIMELAPSE:  'time-lapse',
  PANO:       'pano',
  BURST:      'burst',
};

export const CameraPosition = {
  BACK_WIDE:       'wide-48',
  BACK_ULTRAWIDE:  'ultrawide-48',
  BACK_TELE:       'tele-12',
  FRONT_TRUEDEPTH: 'front-12',
};

export const FlashState = {
  OFF:   'off',
  AUTO:  'auto',
  ON:    'on',
};

export const FocusMode = {
  AUTO:      'auto',
  CONTINUOUS:'continuous',
  LOCKED:    'locked',
  MANUAL:    'manual',
  FACE:      'face',
};

export const WhiteBalance = {
  AUTO:      'auto',
  DAYLIGHT:  'daylight',
  CLOUDY:    'cloudy',
  SHADE:     'shade',
  TUNGSTEN:  'tungsten',
  FLUORESCENT:'fluorescent',
  CUSTOM:    'custom',
};

// ZOOM óptico disponible por cámara
const OPTICAL_ZOOM = {
  [CameraPosition.BACK_WIDE]:      1.0,
  [CameraPosition.BACK_ULTRAWIDE]: 0.5,
  [CameraPosition.BACK_TELE]:      5.0,
  [CameraPosition.FRONT_TRUEDEPTH]:1.0,
};

// Resoluciones de vídeo
const VIDEO_RESOLUTIONS = {
  '720p':  { w: 1280, h: 720,  fps: [30, 60] },
  '1080p': { w: 1920, h: 1080, fps: [30, 60, 120, 240] },
  '4K':    { w: 3840, h: 2160, fps: [24, 30, 60, 120] },
  '8K':    { w: 7680, h: 4320, fps: [24, 30] },
};

// Consumo por modo (mW)
const MODE_POWER_MW = {
  [CaptureMode.PHOTO]:     800,
  [CaptureMode.VIDEO]:    1500,
  [CaptureMode.PORTRAIT]:  900,
  [CaptureMode.CINEMATIC]: 1200,
  [CaptureMode.PRORAW]:   2200,
  [CaptureMode.NIGHT]:    1800,
  [CaptureMode.MACRO]:     700,
  [CaptureMode.LIVE]:      950,
  [CaptureMode.SLOMO]:    1900,
  [CaptureMode.TIMELAPSE]: 400,
  [CaptureMode.PANO]:     1200,
  [CaptureMode.BURST]:    1600,
};

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randRange = (a, b) => a + Math.random() * (b - a);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = (Math.random() * 16) | 0;
  const v = c === 'x' ? r : (r & 0x3) | 0x8;
  return v.toString(16);
});

// ───────────────────────────────────────────────────────────────
// CameraModule — una cámara física
// ───────────────────────────────────────────────────────────────
class CameraModule {
  constructor(spec) {
    this.id          = spec.id;
    this.name        = spec.name;
    this.position    = spec.position;
    this.megapixels  = spec.megapixels;
    this.aperture    = spec.aperture;
    this.sensorSize  = spec.sensorSize;
    this.focusPixels = spec.focusPixels || false;
    this.stabilisation = spec.stabilisation || 'none';
    this.zoom        = spec.zoom || 1;
    this.macro       = spec.macro || false;
    this.faceId      = spec.faceId || false;
    this.autofocus   = spec.autofocus || false;
    this.video       = spec.video || [];
    this.opticalZoom = OPTICAL_ZOOM[this.id] || 1;

    // Estado
    this.enabled     = true;
    this.active      = false;
    this.exposureTimeUs = 8000;    // μs
    this.iso         = 100;
    this.wbK         = 5500;       // Kelvin
    this.wbMode      = WhiteBalance.AUTO;
    this.focusDistanceM = 2.5;
    this.focusMode   = FocusMode.CONTINUOUS;
    this.ois         = true;
    this.eis         = true;
    this.hdr         = true;
    this.deepFusion  = true;
    this.nightMode   = false;

    // Métricas
    this.captures    = 0;
    this.totalExposureMs = 0;
    this.lastCaptureTs = null;
  }

  snapshot() {
    return {
      id:          this.id,
      name:        this.name,
      position:    this.position,
      megapixels:  this.megapixels,
      aperture:    this.aperture,
      sensorSize:  this.sensorSize,
      focusPixels: this.focusPixels,
      stabilisation: this.stabilisation,
      opticalZoom: this.opticalZoom,
      macro:       this.macro,
      faceId:      this.faceId,
      video:       [...this.video],
      enabled:     this.enabled,
      active:      this.active,
      settings: {
        exposureTimeUs: this.exposureTimeUs,
        iso:            this.iso,
        wbK:            this.wbK,
        wbMode:         this.wbMode,
        focusDistanceM: this.focusDistanceM,
        focusMode:      this.focusMode,
        ois:            this.ois,
        eis:            this.eis,
        hdr:            this.hdr,
        deepFusion:     this.deepFusion,
        nightMode:      this.nightMode,
      },
      stats: {
        captures:        this.captures,
        totalExposureMs: Math.round(this.totalExposureMs),
        lastCaptureTs:   this.lastCaptureTs,
      },
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Photo — una captura almacenada
// ───────────────────────────────────────────────────────────────
class Photo {
  constructor({ cameraId, mode, width, height, iso, exposureUs, wbK, flash, location = null, isRaw = false }) {
    this.id          = uuid();
    this.cameraId    = cameraId;
    this.mode        = mode;
    this.width       = width;
    this.height      = height;
    this.iso         = iso;
    this.exposureUs  = exposureUs;
    this.wbK         = wbK;
    this.flash       = flash;
    this.location    = location;    // { lat, lon } si GPS activo
    this.isRaw       = isRaw;
    this.ts          = Date.now();
    this.sizeBytes   = this._estimateSize();
    this.thumbBytes  = this._estimateThumbSize();
    this.favorite    = false;
    this.albums      = [];
    this.edited      = false;
  }

  _estimateSize() {
    // JPEG: ~1.5MB para 12MP, ~4MB para 48MP con HEIF
    const mp = (this.width * this.height) / 1e6;
    const perMp = this.isRaw ? 3_500_000 : 250_000;
    return Math.round(mp * perMp + Math.random() * 500_000);
  }

  _estimateThumbSize() {
    return 24_000 + Math.round(Math.random() * 16_000);
  }

  snapshot() {
    return {
      id:         this.id,
      cameraId:   this.cameraId,
      mode:       this.mode,
      width:      this.width,
      height:     this.height,
      iso:        this.iso,
      exposureUs: this.exposureUs,
      wbK:        this.wbK,
      flash:      this.flash,
      location:   this.location,
      isRaw:      this.isRaw,
      ts:         this.ts,
      sizeBytes:  this.sizeBytes,
      sizeMB:     parseFloat((this.sizeBytes / 1024 / 1024).toFixed(2)),
      favorite:   this.favorite,
      albums:     [...this.albums],
      edited:     this.edited,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Video — un vídeo grabado
// ───────────────────────────────────────────────────────────────
class Video {
  constructor({ cameraId, mode, width, height, fps, codec, durationMs, hasAudio = true, dolbyVision = false, proRes = false }) {
    this.id          = uuid();
    this.cameraId    = cameraId;
    this.mode        = mode;
    this.width       = width;
    this.height      = height;
    this.fps         = fps;
    this.codec       = codec;
    this.durationMs  = durationMs;
    this.hasAudio    = hasAudio;
    this.dolbyVision = dolbyVision;
    this.proRes      = proRes;
    this.ts          = Date.now();
    this.sizeBytes   = this._estimateSize();
    this.favorite    = false;
    this.albums      = [];
  }

  _estimateSize() {
    // bitrate depende de resolución y fps y codec
    const pixels = this.width * this.height;
    const bitsPerPixel = this.proRes ? 0.8 : this.dolbyVision ? 0.25 : 0.1;
    const bytesPerSec = (pixels * this.fps * bitsPerPixel) / 8;
    return Math.round(bytesPerSec * (this.durationMs / 1000));
  }

  snapshot() {
    return {
      id:         this.id,
      cameraId:   this.cameraId,
      mode:       this.mode,
      width:      this.width,
      height:     this.height,
      fps:        this.fps,
      codec:      this.codec,
      durationMs: this.durationMs,
      durationS:  parseFloat((this.durationMs / 1000).toFixed(2)),
      hasAudio:   this.hasAudio,
      dolbyVision:this.dolbyVision,
      proRes:     this.proRes,
      ts:         this.ts,
      sizeBytes:  this.sizeBytes,
      sizeMB:     parseFloat((this.sizeBytes / 1024 / 1024).toFixed(2)),
      favorite:   this.favorite,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// FaceID — subsistema de reconocimiento facial
// ───────────────────────────────────────────────────────────────
class FaceID {
  constructor() {
    this.enrolled    = false;
    this.enrolledAt  = null;
    this.faceIdHash  = null;
    this.attentionDetection = true;
    this.requireAttention   = true;
    this.maskCompatible     = true;
    this.matchAttempts = 0;
    this.matchSuccesses= 0;
    this.matchFailures = 0;
    this.lastMatchAt   = null;
    this.lockoutUntil  = 0;
  }

  enroll() {
    // Simular enrollment
    this.faceIdHash = uuid() + uuid();
    this.enrolled = true;
    this.enrolledAt = Date.now();
    return true;
  }

  unenroll() {
    this.enrolled = false;
    this.enrolledAt = null;
    this.faceIdHash = null;
  }

  /**
   * Simula un match. Con probabilidad de éxito ~97% si está enrolled.
   * Si falla varias veces, se bloquea temporalmente.
   */
  match({ attention = true } = {}) {
    if (!this.enrolled) return { ok: false, reason: 'not-enrolled' };
    if (Date.now() < this.lockoutUntil) {
      return { ok: false, reason: 'locked-out', unlockAt: this.lockoutUntil };
    }
    if (this.requireAttention && !attention) {
      this.matchAttempts++;
      this.matchFailures++;
      return { ok: false, reason: 'no-attention' };
    }

    this.matchAttempts++;
    const ok = Math.random() < 0.97;
    if (ok) {
      this.matchSuccesses++;
      this.matchFailures = 0;
      this.lastMatchAt = Date.now();
      return { ok: true, confidence: randRange(0.92, 0.999) };
    } else {
      this.matchFailures++;
      // Bloqueo tras 5 fallos consecutivos
      if (this.matchFailures >= 5) {
        this.lockoutUntil = Date.now() + 60_000;
      }
      return { ok: false, reason: 'no-match' };
    }
  }

  snapshot() {
    return {
      enrolled:          this.enrolled,
      enrolledAt:        this.enrolledAt,
      attentionDetection:this.attentionDetection,
      requireAttention:  this.requireAttention,
      maskCompatible:    this.maskCompatible,
      attempts:          this.matchAttempts,
      successes:         this.matchSuccesses,
      failures:          this.matchFailures,
      locked:            Date.now() < this.lockoutUntil,
      lockoutUntil:      this.lockoutUntil > Date.now() ? this.lockoutUntil : null,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VCamera — driver completo
// ───────────────────────────────────────────────────────────────
export class VCamera {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VCamera';
    this.model = 'Triple + TrueDepth';

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = CameraState.IDLE;
    this.activeCameraId = CameraPosition.BACK_WIDE;
    this.activeMode  = CaptureMode.PHOTO;

    // Cámaras físicas
    this.cameras = new Map();
    for (const spec of DEVICE_MODEL.cameras) {
      this.cameras.set(spec.id, new CameraModule(spec));
    }

    // Configuración activa (referencias a la cámara activa, se
    // re-leen al cambiar de cámara)
    this.zoomFactor   = 1.0;      // 0.5 .. 25
    this.zoomType     = 'optical';// 'optical' | 'digital'
    this.flash        = FlashState.AUTO;
    this.flashActive  = false;
    this.flashTempK   = 5500;
    this.hdrEnabled   = true;
    this.nightMode    = false;
    this.livePhoto    = false;
    this.portraitMode = false;
    this.rawEnabled   = false;

    // Vídeo
    this.videoResolution = '4K';
    this.videoFps        = 30;
    this.videoCodec      = 'HEVC';
    this.recording       = null;
    this.recordingStartTs = null;

    // Foto en curso
    this.captureInProgress = null;

    // Galería (fotos + vídeos)
    this.gallery = [];
    this.maxGallery = 5000;

    // Face ID
    this.faceId = new FaceID();

    // LiDAR
    this.lidar = {
      enabled: true,
      lastReading: null,
      minRangeM: 0.1,
      maxRangeM: 5.0,
      precisionCm: 1,
    };

    // Sensores de imagen (ISP)
    this.isp = {
      pipeline: 4,
      deepFusion: true,
      smartHdr: true,
      photographic: true,
      nightModeAvailable: true,
    };

    // Suscriptores
    this.subscribers         = new Set();
    this.captureSubscribers  = new Set();
    this.recordingSubscribers= new Set();
    this.faceIdSubscribers   = new Set();
    this.photoSubscribers    = new Set();

    // Tick loop (preview a ~30Hz, es lo típico)
    this.tickIntervalMs = 33;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      photosTaken:       0,
      videosRecorded:    0,
      totalRecordingMs:  0,
      switches:          0,
      modeChanges:       0,
      zoomChanges:       0,
      focusAdjustments:  0,
      exposureAdjustments:0,
      ispCycles:         0,
      faceIdMatches:     0,
      faceIdFailures:    0,
      errors:            0,
      startedAt:         null,
    };

    // Consumo energético (la cámara consume mucho)
    this.currentPowerMw = 0;

    logger.kernel('VCamera', `creado: ${this.model} (${this.cameras.size} cámaras)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VCamera',
      `✓ init: ${this.model}, cámaras=[${[...this.cameras.keys()].join(', ')}]`);
    this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
      source: 'vcamera', event: 'ready',
    }, 'vcamera');
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

    if (this.recording) {
      await this.stopRecording();
    }
    for (const cam of this.cameras.values()) cam.active = false;
    this.state = CameraState.IDLE;
    this.currentPowerMw = 0;
    logger.info('VCamera', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // Actualizar exposición / ISO automáticos si la cámara está activa
    if (this.state === CameraState.PREVIEW || this.state === CameraState.RECORDING) {
      this._autoExposure();
      this._autoFocus();
      this.metrics.ispCycles++;
    }

    // Grabación en curso: actualizar duración
    if (this.recording) {
      // No hacemos nada especial aquí; solo acumulamos cuando para
    }

    // Consumo energético
    this._updatePower();

    // Auto-flash: si el modo es AUTO y la escena es oscura
    if (this.flash === FlashState.AUTO && this.state !== CameraState.IDLE) {
      // la luz ambiental la consultamos si existe el driver
      const lux = this.bus?.devices?.light?.lux ?? 200;
      this.flashActive = lux < 50;
    } else if (this.flash === FlashState.ON) {
      this.flashActive = true;
    } else {
      this.flashActive = false;
    }

    this.tickCount++;
  }

  _autoExposure() {
    const cam = this.activeCamera();
    if (!cam) return;

    // Simular ajuste automático: si la escena es oscura, subir ISO y
    // tiempo de exposición. Si es clara, bajar.
    const lux = this.bus?.devices?.light?.lux ?? 200;
    const targetIso = clamp(Math.round(100 + (200 / Math.max(1, lux)) * 800), 50, 6400);
    const targetExposureUs = clamp(Math.round(8000 * (200 / Math.max(1, lux))), 500, 100000);

    cam.iso = Math.round(cam.iso * 0.9 + targetIso * 0.1);
    cam.exposureTimeUs = Math.round(cam.exposureTimeUs * 0.9 + targetExposureUs * 0.1);
  }

  _autoFocus() {
    const cam = this.activeCamera();
    if (!cam) return;

    if (cam.focusMode === FocusMode.CONTINUOUS || cam.focusMode === FocusMode.AUTO) {
      // El LiDAR da la distancia si está activo
      let target;
      if (this.lidar.enabled && this.lidar.lastReading) {
        target = this.lidar.lastReading.distanceM;
      } else {
        target = randRange(0.5, 8.0);
      }
      cam.focusDistanceM = cam.focusDistanceM * 0.9 + target * 0.1;
    }
  }

  _updatePower() {
    if (this.state === CameraState.IDLE) {
      this.currentPowerMw = 0;
      return;
    }
    const base = MODE_POWER_MW[this.activeMode] || 800;
    let mw = base;

    // Flash encendido: +3W
    if (this.flashActive) mw += 3000;
    // Grabación: +20%
    if (this.state === CameraState.RECORDING) mw *= 1.2;
    // Face ID activo: +200mW
    if (this.state === CameraState.PREVIEW && this.activeCameraId === CameraPosition.FRONT_TRUEDEPTH) {
      mw += 200;
    }

    this.currentPowerMw = mw;
  }

  // ═══════════════════════════════════════════════════════════
  // CÁMARA ACTIVA
  // ═══════════════════════════════════════════════════════════

  activeCamera() {
    return this.cameras.get(this.activeCameraId) || null;
  }

  switchCamera(cameraId) {
    if (!this.cameras.has(cameraId)) {
      logger.warn('VCamera', `cámara desconocida: ${cameraId}`);
      return false;
    }
    if (this.state === CameraState.RECORDING) {
      logger.warn('VCamera', 'no se puede cambiar de cámara grabando');
      return false;
    }
    const prev = this.activeCamera();
    if (prev) prev.active = false;

    this.activeCameraId = cameraId;
    const next = this.activeCamera();
    if (next) next.active = true;

    // Ajustar zoom al mínimo óptico de la nueva cámara
    this.zoomFactor = next ? next.opticalZoom : 1.0;
    this.zoomType   = 'optical';
    this.metrics.switches++;

    logger.info('VCamera', `cámara activa: ${next.name} (zoom ${this.zoomFactor}x)`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // ESTADOS
  // ═══════════════════════════════════════════════════════════

  async startPreview(cameraId = null) {
    if (cameraId && cameraId !== this.activeCameraId) {
      this.switchCamera(cameraId);
    }
    if (this.state === CameraState.PREVIEW) return true;

    this.state = CameraState.PREVIEW;
    const cam = this.activeCamera();
    if (cam) cam.active = true;
    logger.info('VCamera', `preview iniciada (${cam?.name})`);
    this._emit();
    return true;
  }

  stopPreview() {
    if (this.state !== CameraState.PREVIEW) return false;
    this.state = CameraState.IDLE;
    for (const cam of this.cameras.values()) cam.active = false;
    logger.info('VCamera', 'preview detenida');
    this._emit();
    return true;
  }

  setMode(mode) {
    if (!Object.values(CaptureMode).includes(mode)) {
      logger.warn('VCamera', `modo inválido: ${mode}`);
      return false;
    }
    if (this.state === CameraState.RECORDING) {
      logger.warn('VCamera', 'no se puede cambiar de modo grabando');
      return false;
    }
    const prev = this.activeMode;
    this.activeMode = mode;
    this.metrics.modeChanges++;

    // Ajustes según modo
    if (mode === CaptureMode.NIGHT) {
      this.nightMode = true;
    } else {
      this.nightMode = false;
    }
    if (mode === CaptureMode.PRORAW) {
      this.rawEnabled = true;
    }
    if (mode === CaptureMode.LIVE) {
      this.livePhoto = true;
    } else {
      this.livePhoto = false;
    }
    if (mode === CaptureMode.PORTRAIT || mode === CaptureMode.CINEMATIC) {
      this.portraitMode = true;
    } else {
      this.portraitMode = false;
    }

    logger.info('VCamera', `modo: ${prev} → ${mode}`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // ZOOM
  // ═══════════════════════════════════════════════════════════

  setZoom(factor, type = null) {
    const cam = this.activeCamera();
    if (!cam) return false;

    factor = clamp(factor, 0.5, 25.0);
    if (factor === this.zoomFactor && (type === null || type === this.zoomType)) return true;

    this.zoomFactor = factor;
    // Determinar tipo si no se especifica
    if (type) {
      this.zoomType = type;
    } else {
      // Si está entre los ópticos disponibles, es óptico; si no, digital
      this.zoomType = 'digital';
      for (const c of this.cameras.values()) {
        if (Math.abs(c.opticalZoom - factor) < 0.01) {
          this.zoomType = 'optical';
          // Si es un óptico puro, cambiamos la cámara automáticamente
          if (c.position === 'back') {
            this.switchCamera(c.id);
          }
          break;
        }
      }
    }

    this.metrics.zoomChanges++;
    logger.debug('VCamera', `zoom ${factor}x (${this.zoomType})`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIGURACIÓN DE EXPOSICIÓN / WB / FOCO
  // ═══════════════════════════════════════════════════════════

  setISO(iso) {
    const cam = this.activeCamera();
    if (!cam) return false;
    cam.iso = clamp(Math.round(iso), 25, 12800);
    this.metrics.exposureAdjustments++;
    this._emit();
    return true;
  }

  setExposureTime(us) {
    const cam = this.activeCamera();
    if (!cam) return false;
    cam.exposureTimeUs = clamp(Math.round(us), 100, 200000);
    this.metrics.exposureAdjustments++;
    this._emit();
    return true;
  }

  setWhiteBalance({ mode = null, kelvin = null } = {}) {
    const cam = this.activeCamera();
    if (!cam) return false;
    if (mode) {
      if (!Object.values(WhiteBalance).includes(mode)) return false;
      cam.wbMode = mode;
      // Valores por defecto por modo
      const presets = {
        [WhiteBalance.DAYLIGHT]:    5500,
        [WhiteBalance.CLOUDY]:      6500,
        [WhiteBalance.SHADE]:       7500,
        [WhiteBalance.TUNGSTEN]:    3200,
        [WhiteBalance.FLUORESCENT]: 4000,
        [WhiteBalance.AUTO]:        5500,
      };
      cam.wbK = presets[mode] ?? cam.wbK;
    }
    if (kelvin !== null) {
      cam.wbK = clamp(Math.round(kelvin), 2000, 10000);
      cam.wbMode = WhiteBalance.CUSTOM;
    }
    this._emit();
    return true;
  }

  setFocusDistance(meters) {
    const cam = this.activeCamera();
    if (!cam) return false;
    cam.focusDistanceM = clamp(meters, 0.01, 100);
    cam.focusMode = FocusMode.MANUAL;
    this.metrics.focusAdjustments++;
    this._emit();
    return true;
  }

  setFocusMode(mode) {
    const cam = this.activeCamera();
    if (!cam) return false;
    if (!Object.values(FocusMode).includes(mode)) return false;
    cam.focusMode = mode;
    this.metrics.focusAdjustments++;
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // FLASH
  // ═══════════════════════════════════════════════════════════

  setFlash(state) {
    if (!Object.values(FlashState).includes(state)) return false;
    this.flash = state;
    logger.debug('VCamera', `flash = ${state}`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CAPTURA DE FOTO
  // ═══════════════════════════════════════════════════════════

  /**
   * Toma una foto. Devuelve la Photo creada.
   */
  async capturePhoto({ flash = null, location = null, iso = null, exposureUs = null } = {}) {
    if (this.state === CameraState.RECORDING) {
      logger.warn('VCamera', 'capturePhoto rechazado: grabando vídeo');
      return null;
    }
    const cam = this.activeCamera();
    if (!cam) return null;
    if (this.captureInProgress) {
      logger.warn('VCamera', 'capturePhoto rechazado: ya hay una captura en curso');
      return null;
    }

    this.state = CameraState.CAPTURING;
    const captureId = `cap-${Date.now()}`;
    this.captureInProgress = { id: captureId, startTs: Date.now() };
    this.metrics.photosTaken++;

    // Overrides opcionales
    const useIso        = iso ?? cam.iso;
    const useExposureUs = exposureUs ?? cam.exposureTimeUs;

    // Determinar flash
    let useFlash = this.flashActive;
    if (flash !== null) useFlash = flash;

    // Simular duración del disparo (shutter + procesado)
    const shutterMs = Math.min(500, useExposureUs / 1000);
    const processingMs = cam.deepFusion ? 250 : 100;
    await this._delay(shutterMs + processingMs);

    // Resolución final según modo
    const megapixels = cam.megapixels;
    let width, height;
    if (megapixels >= 48) {
      width = 8064; height = 6048;  // 48MP
    } else {
      width = 4032; height = 3024;  // 12MP
    }

    // Recortar por zoom
    const zoomFactor = this.zoomFactor;
    const croppedW = Math.round(width / zoomFactor);
    const croppedH = Math.round(height / zoomFactor);

    // Si hay GPS, incluir ubicación
    let photoLocation = location;
    if (!photoLocation && this.bus?.devices?.gps?.hasFix?.()) {
      const loc = this.bus.devices.gps.getLocation();
      if (loc) photoLocation = { lat: loc.lat, lon: loc.lon };
    }

    const photo = new Photo({
      cameraId: cam.id,
      mode:     this.activeMode,
      width:    croppedW,
      height:   croppedH,
      iso:      useIso,
      exposureUs: useExposureUs,
      wbK:      cam.wbK,
      flash:    useFlash,
      location: photoLocation,
      isRaw:    this.rawEnabled,
    });

    // Añadir a galería
    this.gallery.push(photo);
    if (this.gallery.length > this.maxGallery) this.gallery.shift();

    cam.captures++;
    cam.totalExposureMs += useExposureUs / 1000;
    cam.lastCaptureTs = Date.now();

    this.captureInProgress = null;
    this.state = CameraState.PREVIEW;

    logger.info('VCamera',
      `📷 foto: ${photo.width}×${photo.height} (${photo.sizeMB}MB) iso=${photo.iso} exp=${photo.exposureUs}μs zoom=${zoomFactor}x`);

    this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
      source: 'vcamera', event: 'capture', id: photo.id, size: photo.sizeBytes,
    }, 'vcamera');
    for (const fn of this.captureSubscribers) {
      try { fn({ type: 'photo', photo: photo.snapshot() }); } catch (_) {}
    }
    for (const fn of this.photoSubscribers) {
      try { fn({ type: 'added', photo: photo.snapshot() }); } catch (_) {}
    }
    this._emit();
    return photo.snapshot();
  }

  /**
   * Captura en ráfaga: N fotos seguidas.
   */
  async captureBurst({ count = 10, intervalMs = 100 } = {}) {
    const photos = [];
    const prevMode = this.activeMode;
    this.activeMode = CaptureMode.BURST;
    for (let i = 0; i < count; i++) {
      const p = await this.capturePhoto();
      if (p) photos.push(p);
      await this._delay(intervalMs);
    }
    this.activeMode = prevMode;
    return photos;
  }

  // ═══════════════════════════════════════════════════════════
  // GRABACIÓN DE VÍDEO
  // ═══════════════════════════════════════════════════════════

  setVideoResolution(res) {
    if (!VIDEO_RESOLUTIONS[res]) {
      logger.warn('VCamera', `resolución no soportada: ${res}`);
      return false;
    }
    this.videoResolution = res;
    // Si el FPS actual no está soportado en esta resolución, bajamos
    const fps = VIDEO_RESOLUTIONS[res].fps;
    if (!fps.includes(this.videoFps)) {
      this.videoFps = fps[fps.length - 1];
    }
    this._emit();
    return true;
  }

  setVideoFps(fps) {
    const res = VIDEO_RESOLUTIONS[this.videoResolution];
    if (!res || !res.fps.includes(fps)) {
      logger.warn('VCamera', `fps ${fps} no soportado en ${this.videoResolution}`);
      return false;
    }
    this.videoFps = fps;
    this._emit();
    return true;
  }

  setVideoCodec(codec) {
    if (!['H.264', 'HEVC', 'ProRes'].includes(codec)) return false;
    this.videoCodec = codec;
    this._emit();
    return true;
  }

  async startRecording({ resolution = null, fps = null, codec = null } = {}) {
    if (this.state === CameraState.RECORDING) {
      logger.warn('VCamera', 'startRecording: ya grabando');
      return false;
    }
    const cam = this.activeCamera();
    if (!cam) return false;

    if (resolution) this.setVideoResolution(resolution);
    if (fps) this.setVideoFps(fps);
    if (codec) this.setVideoCodec(codec);

    const res = VIDEO_RESOLUTIONS[this.videoResolution];
    this.state = CameraState.RECORDING;
    this.recordingStartTs = Date.now();
    this.recording = {
      cameraId:  cam.id,
      mode:      this.activeMode,
      width:     res.w,
      height:    res.h,
      fps:       this.videoFps,
      codec:     this.videoCodec,
      hasAudio:  true,
      dolbyVision: this.hdrEnabled && this.videoFps <= 60,
      proRes:    this.videoCodec === 'ProRes',
    };

    logger.info('VCamera',
      `🎥 grabando: ${this.videoResolution}@${this.videoFps}fps ${this.videoCodec}`);

    this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
      source: 'vcamera', event: 'recording-start',
      resolution: this.videoResolution, fps: this.videoFps,
    }, 'vcamera');
    for (const fn of this.recordingSubscribers) {
      try { fn({ type: 'started', recording: { ...this.recording } }); } catch (_) {}
    }
    this._emit();
    return true;
  }

  async stopRecording() {
    if (this.state !== CameraState.RECORDING || !this.recording) return null;

    const durationMs = Date.now() - this.recordingStartTs;
    const rec = this.recording;
    this.recording = null;
    this.recordingStartTs = null;

    const video = new Video({
      cameraId:    rec.cameraId,
      mode:        rec.mode,
      width:       rec.width,
      height:      rec.height,
      fps:         rec.fps,
      codec:       rec.codec,
      durationMs,
      hasAudio:    rec.hasAudio,
      dolbyVision: rec.dolbyVision,
      proRes:      rec.proRes,
    });
    this.gallery.push(video);
    if (this.gallery.length > this.maxGallery) this.gallery.shift();
    this.metrics.videosRecorded++;
    this.metrics.totalRecordingMs += durationMs;
    this.state = CameraState.PREVIEW;

    logger.info('VCamera',
      `🎥 grabación parada: ${(durationMs / 1000).toFixed(1)}s (${video.sizeMB}MB)`);

    this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
      source: 'vcamera', event: 'recording-stop',
      durationMs, size: video.sizeBytes,
    }, 'vcamera');
    for (const fn of this.recordingSubscribers) {
      try { fn({ type: 'stopped', video: video.snapshot() }); } catch (_) {}
    }
    this._emit();
    return video.snapshot();
  }

  getRecordingDuration() {
    if (!this.recordingStartTs) return 0;
    return Date.now() - this.recordingStartTs;
  }

  // ═══════════════════════════════════════════════════════════
  // GALERÍA
  // ═══════════════════════════════════════════════════════════

  getGallery({ type = 'all', limit = 100, offset = 0 } = {}) {
    let items = this.gallery;
    if (type === 'photos') items = items.filter(i => i instanceof Photo);
    else if (type === 'videos') items = items.filter(i => i instanceof Video);
    return items
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map(i => i.snapshot());
  }

  getGalleryCount() {
    const photos = this.gallery.filter(i => i instanceof Photo).length;
    const videos = this.gallery.filter(i => i instanceof Video).length;
    return { total: this.gallery.length, photos, videos };
  }

  deleteFromGallery(id) {
    const idx = this.gallery.findIndex(i => i.id === id);
    if (idx < 0) return false;
    this.gallery.splice(idx, 1);
    return true;
  }

  toggleFavorite(id) {
    const item = this.gallery.find(i => i.id === id);
    if (!item) return false;
    item.favorite = !item.favorite;
    return item.favorite;
  }

  clearGallery() {
    this.gallery = [];
    logger.info('VCamera', 'galería vaciada');
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // LiDAR
  // ═══════════════════════════════════════════════════════════

  readLiDAR() {
    if (!this.lidar.enabled) return null;
    const distanceM = randRange(0.1, 5.0);
    const reading = {
      distanceM: parseFloat(distanceM.toFixed(3)),
      precisionCm: this.lidar.precisionCm + Math.round(Math.random() * 2),
      ts: Date.now(),
      valid: true,
    };
    this.lidar.lastReading = reading;
    this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
      source: 'vcamera', event: 'lidar-reading', distanceM,
    }, 'vcamera');
    return reading;
  }

  setLiDAREnabled(on) {
    this.lidar.enabled = !!on;
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // FACE ID
  // ═══════════════════════════════════════════════════════════

  faceIdEnroll() {
    const ok = this.faceId.enroll();
    if (ok) {
      logger.info('VCamera', '👤 Face ID: enrollment completado');
      this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
        source: 'vcamera', event: 'faceid-enroll',
      }, 'vcamera');
      for (const fn of this.faceIdSubscribers) {
        try { fn({ type: 'enrolled' }); } catch (_) {}
      }
    }
    this._emit();
    return ok;
  }

  faceIdUnenroll() {
    this.faceId.unenroll();
    logger.info('VCamera', '👤 Face ID: enrollment borrado');
    this._emit();
    return true;
  }

  /**
   * Intenta hacer match con Face ID.
   */
  faceIdMatch({ attention = true } = {}) {
    const result = this.faceId.match({ attention });
    if (result.ok) {
      this.metrics.faceIdMatches++;
      logger.info('VCamera', `👤 Face ID MATCH (confianza ${(result.confidence * 100).toFixed(1)}%)`);
      this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
        source: 'vcamera', event: 'faceid-match',
        confidence: result.confidence,
      }, 'vcamera');
      for (const fn of this.faceIdSubscribers) {
        try { fn({ type: 'match', ...result }); } catch (_) {}
      }
    } else {
      this.metrics.faceIdFailures++;
      logger.info('VCamera', `👤 Face ID FALLO: ${result.reason}`);
      this.bus?.raiseInterrupt?.('IRQ_CAMERA', {
        source: 'vcamera', event: 'faceid-fail',
        reason: result.reason,
      }, 'vcamera');
      for (const fn of this.faceIdSubscribers) {
        try { fn({ type: 'fail', ...result }); } catch (_) {}
      }
    }
    this._emit();
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isPreviewing() { return this.state === CameraState.PREVIEW; }
  isRecording()  { return this.state === CameraState.RECORDING; }
  isCapturing()  { return this.state === CameraState.CAPTURING; }

  getActiveCamera() {
    const cam = this.activeCamera();
    return cam ? cam.snapshot() : null;
  }

  getAllCameras() {
    return [...this.cameras.values()].map(c => c.snapshot());
  }

  getZoomInfo() {
    return {
      factor: this.zoomFactor,
      type:   this.zoomType,
      availableOptical: [0.5, 1, 2, 3, 5],
      maxDigital: 25,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onCapture(fn) {
    this.captureSubscribers.add(fn);
    return () => this.captureSubscribers.delete(fn);
  }

  onRecording(fn) {
    this.recordingSubscribers.add(fn);
    return () => this.recordingSubscribers.delete(fn);
  }

  onFaceId(fn) {
    this.faceIdSubscribers.add(fn);
    return () => this.faceIdSubscribers.delete(fn);
  }

  onPhotoAdded(fn) {
    this.photoSubscribers.add(fn);
    return () => this.photoSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VCamera', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    const cam = this.activeCamera();
    return {
      model:         this.model,
      state:         this.state,
      activeMode:    this.activeMode,
      activeCameraId:this.activeCameraId,
      activeCamera:  cam ? cam.snapshot() : null,
      zoom:          this.getZoomInfo(),
      flash:         this.flash,
      flashActive:   this.flashActive,
      hdr:           this.hdrEnabled,
      nightMode:     this.nightMode,
      portraitMode:  this.portraitMode,
      rawEnabled:    this.rawEnabled,
      livePhoto:     this.livePhoto,
      recording:     this.recording ? {
        resolution:  this.videoResolution,
        fps:         this.videoFps,
        codec:       this.videoCodec,
        durationMs:  this.getRecordingDuration(),
      } : null,
      gallery:       this.getGalleryCount(),
      faceId:        this.faceId.snapshot(),
      lidar: {
        enabled:     this.lidar.enabled,
        lastReading: this.lidar.lastReading,
      },
      powerMw:       parseFloat(this.currentPowerMw.toFixed(1)),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      gallery:     this.getGalleryCount(),
      faceId:      this.faceId.snapshot(),
    };
  }

  dump() {
    const s = this.getStats();
    const cam = this.activeCamera();
    const lines = [
      `VCamera [${s.state}] — ${s.model}`,
      `  modo:        ${this.activeMode}`,
      `  cámara:      ${cam ? `${cam.name} (${cam.megapixels}MP ${cam.aperture})` : '—'}`,
      `  zoom:        ${this.zoomFactor}x (${this.zoomType})`,
      `  flash:       ${this.flash}${this.flashActive ? ' [active]' : ''}`,
      `  HDR:         ${this.hdrEnabled}  night=${this.nightMode}  portrait=${this.portraitMode}  raw=${this.rawEnabled}`,
      `  vídeo:       ${this.videoResolution}@${this.videoFps}fps ${this.videoCodec}`,
      `  grabando:    ${this.recording ? `sí (${(this.getRecordingDuration() / 1000).toFixed(1)}s)` : 'no'}`,
      `  galería:     ${s.gallery.photos} fotos + ${s.gallery.videos} vídeos`,
      `  Face ID:     ${this.faceId.enrolled ? 'enrolled' : 'no enrolled'}`,
      `  LiDAR:       ${this.lidar.enabled ? 'on' : 'off'}`,
      `  métricas:`,
      `    photos=${s.metrics.photosTaken} videos=${s.metrics.videosRecorded}`,
      `    switches=${s.metrics.switches} zoom=${s.metrics.zoomChanges} modes=${s.metrics.modeChanges}`,
      `    faceId: matches=${s.metrics.faceIdMatches} fails=${s.metrics.faceIdFailures}`,
      `  consumo:     ${this.currentPowerMw.toFixed(0)}mW`,
    ];
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
