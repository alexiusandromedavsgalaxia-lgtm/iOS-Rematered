// src/drivers/VDisplay.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VDisplay (Virtual Display)
 * ═══════════════════════════════════════════════════════════════
 *
 * Driver de pantalla. Modela el panel Super Retina XDR del iPhone:
 * OLED LTPO con ProMotion (1-120Hz variable), HDR10, Dolby Vision,
 * color P3, Dynamic Island, Always-On Display.
 *
 * Responsabilidades:
 *   - Estado del panel (encendido/apagado, brillo, modo AOD)
 *   - Brillo adaptativo por sensor de luz + True Tone + Night Shift
 *   - ProMotion: refresco variable 1..120Hz según contenido
 *   - Presupuesto de frame + jank detection (coordina con VGPU)
 *   - Rotación y safe areas según orientación
 *   - Modo oscuro/claro, reduce motion, reduce transparency
 *   - Dynamic Type (escala de texto)
 *   - Captura de pantalla (screenshot array)
 *   - Composición de capas (para SpringBoard / ventanas)
 *   - Consumo energético según brillo y contenido
 *   - IRQ_DISPLAY con eventos de estado y cambios
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const DisplayState = {
  OFF:         'off',
  ON:          'on',
  DIM:         'dim',            // atenuado pero no apagado (AOD)
  AOD:         'aod',            // always-on display
  SLEEPING:    'sleeping',       // pre-off, esperando timeout
  ERROR:       'error',
};

export const Orientation = {
  PORTRAIT:          'portrait',
  PORTRAIT_UPSIDE:   'portrait-upside-down',
  LANDSCAPE_LEFT:    'landscape-left',
  LANDSCAPE_RIGHT:   'landscape-right',
};

export const Appearance = {
  LIGHT:  'light',
  DARK:   'dark',
  AUTO:   'auto',
};

export const RefreshMode = {
  FIXED_60:  'fixed-60',
  FIXED_120: 'fixed-120',
  ADAPTIVE:  'adaptive',         // ProMotion: 1-120Hz según contenido
};

export const ColorSpace = {
  SRGB:  'sRGB',
  P3:    'Display P3',
  REC709:'Rec.709',
};

// Presupuestos por tasa de refresco (ms)
const FRAME_BUDGET_MS = {
  1:   1000,
  10:  100,
  24:  41.67,
  30:  33.33,
  60:  16.67,
  90:  11.11,
  120: 8.33,
};

// ───────────────────────────────────────────────────────────────
// Utilidad: clamp
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ───────────────────────────────────────────────────────────────
// Panel físico
// ───────────────────────────────────────────────────────────────
class Panel {
  constructor() {
    const d = DEVICE_MODEL.display;

    this.physicalW = d.width;         // 1206 px
    this.physicalH = d.height;        // 2622 px
    this.logicalW  = d.logicalW;      // 402 pt
    this.logicalH  = d.logicalH;      // 874 pt
    this.scale     = d.scale;         // 3x
    this.dpi       = d.dpi;           // 460
    this.refreshMin = 1;              // LTPO: 1Hz mínimo
    this.refreshMax = d.refreshHz;    // 120Hz

    // Specs físicas
    this.peakNits     = d.peakNits;      // 2000
    this.typicalNits  = d.typicalNits;   // 1000
    this.colorSpace   = ColorSpace.P3;
    this.hdr          = d.hdr;
    this.technologies = [...d.technologies];

    // Notch / Dynamic Island
    this.dynamicIsland = {
      width:  d.notch.width,
      height: d.notch.height,
      top:    d.notch.top,
    };

    // Corner radius
    this.cornerRadius = d.cornerRadius;

    // Borde de pantalla
    this.bezel = 3;   // px físicos
  }

  /** Tamaño lógico según orientación */
  logicalSize(orientation) {
    if (orientation === Orientation.PORTRAIT || orientation === Orientation.PORTRAIT_UPSIDE) {
      return { width: this.logicalW, height: this.logicalH };
    }
    return { width: this.logicalH, height: this.logicalW };
  }

  /** Tamaño físico según orientación */
  physicalSize(orientation) {
    if (orientation === Orientation.PORTRAIT || orientation === Orientation.PORTRAIT_UPSIDE) {
      return { width: this.physicalW, height: this.physicalH };
    }
    return { width: this.physicalH, height: this.physicalW };
  }
}

// ───────────────────────────────────────────────────────────────
// Safe areas según orientación
// ───────────────────────────────────────────────────────────────
class SafeArea {
  constructor(panel) {
    this.panel = panel;
  }

  for(orientation) {
    const isPortrait = orientation === Orientation.PORTRAIT || orientation === Orientation.PORTRAIT_UPSIDE;
    const island = this.panel.dynamicIsland;

    if (isPortrait) {
      return {
        top:    island.top + island.height + 8,
        bottom: 34,
        left:   0,
        right:  0,
      };
    }
    // landscape: notch en el lado izquierdo o derecho
    const sideInset = island.top + island.height + 8;
    return {
      top:   0,
      bottom: 21,
      left:  sideInset,
      right: sideInset,
    };
  }

  // Safe area para widgets / islas (en landscape)
  forEdge(orientation, edge) {
    return this.for(orientation)[edge];
  }
}

// ───────────────────────────────────────────────────────────────
// Content tracker (para auto-refresh adaptativo)
// ───────────────────────────────────────────────────────────────
class ContentTracker {
  constructor() {
    this.mode       = 'idle';        // idle | ui | video | game | text
    this.frameCount = 0;
    this.lastChangeTs = Date.now();
    this.changeRate = 0;             // cambios/s
  }

  noteChange() {
    this.frameCount++;
    const now = Date.now();
    const dt = now - this.lastChangeTs;
    if (dt > 0) {
      this.changeRate = this.changeRate * 0.9 + (1000 / dt) * 0.1;
    }
    this.lastChangeTs = now;
  }

  setIdle() { this.mode = 'idle'; }
  setUI()   { this.mode = 'ui'; }
  setVideo(){ this.mode = 'video'; }
  setGame() { this.mode = 'game'; }
  setText() { this.mode = 'text'; }

  /** Refresco recomendado según el contenido */
  recommendedRefresh() {
    switch (this.mode) {
      case 'idle':  return 1;
      case 'text':  return 10;
      case 'ui':    return 120;
      case 'video': return 60;
      case 'game':  return 120;
      default:      return 60;
    }
  }
}

// ───────────────────────────────────────────────────────────────
// Layer stack (composición de capas para SpringBoard)
// ───────────────────────────────────────────────────────────────
class LayerStack {
  constructor() {
    this.layers = new Map();     // layerId -> { id, z, rect, opacity, content, dirty }
    this.zCounter = 0;
  }

  upsert(layerId, { z = null, rect = null, opacity = 1, content = null, name = layerId } = {}) {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = {
        id:       layerId,
        name,
        z:        z ?? ++this.zCounter,
        rect:     rect ?? { x: 0, y: 0, w: 100, h: 100 },
        opacity:  clamp(opacity, 0, 1),
        content,
        dirty:    true,
        createdAt:Date.now(),
      };
      this.layers.set(layerId, layer);
    } else {
      if (z !== null) layer.z = z;
      if (rect) layer.rect = rect;
      layer.opacity = clamp(opacity, 0, 1);
      if (content !== null) layer.content = content;
      layer.dirty = true;
    }
    return layer;
  }

  remove(layerId) {
    return this.layers.delete(layerId);
  }

  get(layerId) {
    return this.layers.get(layerId) || null;
  }

  /** Devuelve las capas ordenadas por z descendente (arriba primero) */
  ordered() {
    return [...this.layers.values()].sort((a, b) => b.z - a.z);
  }

  /** Marca todas las capas como sucias (fuerza recomposición) */
  invalidateAll() {
    for (const l of this.layers.values()) l.dirty = true;
  }

  clear() {
    this.layers.clear();
    this.zCounter = 0;
  }

  size() { return this.layers.size; }
}

// ───────────────────────────────────────────────────────────────
// VDisplay — driver completo
// ───────────────────────────────────────────────────────────────
export class VDisplay {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VDisplay';
    this.model = DEVICE_MODEL.display.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = DisplayState.OFF;

    // Panel
    this.panel       = new Panel();
    this.safeArea    = new SafeArea(this.panel);
    this.content     = new ContentTracker();
    this.layers      = new LayerStack();

    // Configuración
    this.brightness      = 0.85;    // 0..1 (usuario)
    this.autoBrightness  = true;    // brillo adaptativo por sensor
    this.effectiveBrightness = 0.85;// tras auto-brillo y atenuación
    this.trueTone        = true;
    this.nightShift      = false;
    this.nightShiftWarmth= 0.6;     // 0..1
    this.appearance      = Appearance.AUTO;
    this.orientation     = Orientation.PORTRAIT;
    this.refreshMode     = RefreshMode.ADAPTIVE;
    this.currentRefreshHz= 60;
    this.colorSpace      = ColorSpace.P3;
    this.hdrEnabled      = true;

    // Accesibilidad
    this.reduceMotion       = false;
    this.reduceTransparency = false;
    this.boldText           = false;
    this.dynamicTypeScale   = 1.0;    // 0.8..2.0
    this.increaseContrast   = false;

    // Always-On Display
    this.aodEnabled   = true;
    this.aodActive    = false;

    // Apagado programado
    this.autoLockMs   = 60_000;       // 60s
    this.lastActivityTs = Date.now();

    // Brillo ambiental (lux) — viene del sensor
    this.ambientLux = 200;

    // HDR / tone mapping
    this.hdrMetadata = {
      maxCLL:   1000,     // nits
      maxFALL:  400,
      masteringDisplay: 'P3 D65 1000 nits',
    };

    // Historial de refresco (por si el compositor quiere medirlo)
    this.historySize = 120;
    this.history = {
      ts:         [],
      refreshHz:  [],
      brightness: [],
      frameTimeMs:[],
    };

    // Suscriptores
    this.subscribers            = new Set();
    this.brightnessSubscribers  = new Set();
    this.orientationSubscribers = new Set();
    this.refreshSubscribers     = new Set();

    // Tick loop
    this.tickIntervalMs = 250;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      powerOns:              0,
      powerOffs:             0,
      orientationChanges:    0,
      brightnessChanges:     0,
      refreshChanges:        0,
      framesPresented:       0,
      framesDropped:         0,
      screenshots:           0,
      aodActivations:        0,
      autoBrightnessAdjusts: 0,
      startedAt:             null,
    };

    // Contabilidad energética (mW) — se consulta desde VBattery
    this.currentPowerMw = 0;

    logger.kernel('VDisplay',
      `creado: ${this.model} ${this.panel.logicalW}×${this.panel.logicalH}pt ` +
      `@${this.panel.scale}x (${this.panel.physicalW}×${this.panel.physicalH}px, ${this.panel.dpi}dpi)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VDisplay',
      `✓ init: ${this.model}, ProMotion ${this.panel.refreshMin}-${this.panel.refreshMax}Hz, ` +
      `${this.panel.peakNits}nits peak, ${this.panel.colorSpace}`);

    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'ready',
    }, 'vdisplay');
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
    this.powerOff();
    logger.info('VDisplay', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK — simulación periódica
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // 1) Brillo adaptativo (auto-brightness) por sensor de luz
    this._updateAutoBrightness();

    // 2) Refresco adaptativo (ProMotion)
    if (this.refreshMode === RefreshMode.ADAPTIVE && this.state === DisplayState.ON) {
      this._updateAdaptiveRefresh();
    }

    // 3) Always-On Display
    this._updateAOD();

    // 4) Apagado por inactividad
    this._updateAutoLock();

    // 5) Consumo energético
    this._updatePowerDraw();

    // 6) Historial
    this._pushHistory();

    // 7) Notificar
    this._emit();

    this.tickCount++;
  }

  _updateAutoBrightness() {
    if (!this.autoBrightness) return;
    if (this.state !== DisplayState.ON && this.state !== DisplayState.AOD) return;

    // Consultar el sensor de luz ambiental si está disponible
    const light = this.bus?.devices?.light;
    if (light?.lux) {
      this.ambientLux = light.lux;
    }

    // Curva perceptual: lux → brillo
    // 1 lux → 0.05, 100 lux → 0.4, 10000 lux → 1.0
    const logLux = Math.log10(Math.max(1, this.ambientLux));
    let target = clamp((logLux - 0.5) / 3.5, 0.05, 1.0);

    // Suavizar hacia el objetivo
    const prev = this.effectiveBrightness;
    this.effectiveBrightness = prev * 0.9 + target * 0.1;

    if (Math.abs(prev - this.effectiveBrightness) > 0.005) {
      this.metrics.autoBrightnessAdjusts++;
    }
  }

  _updateAdaptiveRefresh() {
    // El modo de contenido lo determina el compositor; aquí lo
    // leemos y aplicamos el refresco recomendado.
    let target = this.content.recommendedRefresh();

    // Si no hay cambios recientes, bajar a mínimo
    const sinceLastChange = Date.now() - this.content.lastChangeTs;
    if (sinceLastChange > 5000) target = Math.min(target, 10);
    if (sinceLastChange > 30000) target = 1;

    // AOD siempre a 1Hz
    if (this.state === DisplayState.AOD) target = 1;

    if (target !== this.currentRefreshHz) {
      this._setRefreshInternal(target);
    }
  }

  _updateAOD() {
    if (!this.aodEnabled) return;
    if (this.state !== DisplayState.ON) return;

    // Entrar en AOD tras inactividad
    const idle = Date.now() - this.lastActivityTs;
    if (idle > 5_000 && !this.aodActive) {
      this.aodActive = true;
      this.state = DisplayState.AOD;
      this.metrics.aodActivations++;
      logger.info('VDisplay', 'Always-On Display activado');
      this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
        source: 'vdisplay', event: 'aod-on',
      }, 'vdisplay');
    }
  }

  _updateAutoLock() {
    if (this.state !== DisplayState.ON) return;
    const idle = Date.now() - this.lastActivityTs;
    if (idle > this.autoLockMs) {
      // Apagar pantalla
      if (this.state !== DisplayState.OFF) {
        this.powerOff('auto-lock');
      }
    }
  }

  _updatePowerDraw() {
    if (this.state === DisplayState.OFF) {
      this.currentPowerMw = 0;
      return;
    }
    if (this.state === DisplayState.AOD) {
      this.currentPowerMw = 80;   // AOD bajo consumo
      return;
    }

    // Panel OLED: consumo = base + brillo^2 * max + contenido HDR
    const b = this.effectiveBrightness;
    const base = 120;
    const atMaxBrightness = 900;
    let mw = base + b * b * atMaxBrightness;

    // HDR: extra
    if (this.hdrEnabled && this.content.mode === 'video') {
      mw += 300;
    }
    // 120Hz: extra
    if (this.currentRefreshHz >= 120) {
      mw *= 1.10;
    } else if (this.currentRefreshHz >= 60) {
      mw *= 1.05;
    }
    // True Tone / Night Shift: mínima variación
    if (this.trueTone) mw *= 1.01;

    this.currentPowerMw = mw;
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.refreshHz.push(this.currentRefreshHz);
    this.history.brightness.push(this.effectiveBrightness);
    this.history.frameTimeMs.push(1000 / this.currentRefreshHz);
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ENCENDIDO / APAGADO
  // ═══════════════════════════════════════════════════════════

  powerOn() {
    if (this.state === DisplayState.ON) return true;
    this.state = DisplayState.ON;
    this.lastActivityTs = Date.now();
    this.aodActive = false;
    this.metrics.powerOns++;
    logger.info('VDisplay', '📱 pantalla on');
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'powered-on',
    }, 'vdisplay');
    this._emit();
    return true;
  }

  powerOff(reason = 'user') {
    if (this.state === DisplayState.OFF) return true;
    this.state = DisplayState.OFF;
    this.aodActive = false;
    this.metrics.powerOffs++;
    logger.info('VDisplay', `📱 pantalla off (${reason})`);
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'powered-off', reason,
    }, 'vdisplay');
    this._emit();
    return true;
  }

  /** Registra actividad del usuario (toca la pantalla, botón...) */
  noteActivity() {
    this.lastActivityTs = Date.now();
    if (this.state === DisplayState.AOD) {
      this.state = DisplayState.ON;
      this.aodActive = false;
      this._setRefreshInternal(120);
      logger.debug('VDisplay', 'AOD → ON por actividad');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BRILLO
  // ═══════════════════════════════════════════════════════════

  setBrightness(v) {
    v = clamp(v, 0, 1);
    if (v === this.brightness) return true;
    this.brightness = v;
    if (!this.autoBrightness) {
      this.effectiveBrightness = v;
    }
    this.metrics.brightnessChanges++;
    logger.debug('VDisplay', `brightness = ${(v * 100).toFixed(0)}%`);
    for (const fn of this.brightnessSubscribers) {
      try { fn({ brightness: v, effective: this.effectiveBrightness }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'brightness', value: v,
    }, 'vdisplay');
    this._emit();
    return true;
  }

  setAutoBrightness(on) {
    this.autoBrightness = !!on;
    if (!on) this.effectiveBrightness = this.brightness;
    logger.info('VDisplay', `auto-brightness = ${this.autoBrightness}`);
    this._emit();
  }

  setTrueTone(on) {
    this.trueTone = !!on;
    logger.info('VDisplay', `True Tone = ${this.trueTone}`);
    this._emit();
  }

  setNightShift(on, warmth = null) {
    this.nightShift = !!on;
    if (warmth !== null) this.nightShiftWarmth = clamp(warmth, 0, 1);
    logger.info('VDisplay', `Night Shift = ${this.nightShift} (warmth=${this.nightShiftWarmth})`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // ORIENTACIÓN
  // ═══════════════════════════════════════════════════════════

  setOrientation(orientation) {
    if (!Object.values(Orientation).includes(orientation)) {
      logger.warn('VDisplay', `orientación inválida: ${orientation}`);
      return false;
    }
    if (orientation === this.orientation) return true;
    const prev = this.orientation;
    this.orientation = orientation;
    this.metrics.orientationChanges++;

    logger.info('VDisplay', `orientación: ${prev} → ${orientation}`);
    for (const fn of this.orientationSubscribers) {
      try { fn({ orientation, safeArea: this.getSafeArea() }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'orientation-changed', orientation,
    }, 'vdisplay');
    this._emit();
    return true;
  }

  getSafeArea() {
    return this.safeArea.for(this.orientation);
  }

  getLogicalSize() {
    return this.panel.logicalSize(this.orientation);
  }

  getPhysicalSize() {
    return this.panel.physicalSize(this.orientation);
  }

  // ═══════════════════════════════════════════════════════════
  // REFRESCO
  // ═══════════════════════════════════════════════════════════

  setRefreshMode(mode) {
    if (!Object.values(RefreshMode).includes(mode)) {
      logger.warn('VDisplay', `refresh mode inválido: ${mode}`);
      return false;
    }
    this.refreshMode = mode;
    if (mode === RefreshMode.FIXED_60) this._setRefreshInternal(60);
    else if (mode === RefreshMode.FIXED_120) this._setRefreshInternal(120);
    logger.info('VDisplay', `refresh mode = ${mode}`);
    this._emit();
    return true;
  }

  _setRefreshInternal(hz) {
    hz = clamp(hz, this.panel.refreshMin, this.panel.refreshMax);
    if (hz === this.currentRefreshHz) return;
    this.currentRefreshHz = hz;
    this.metrics.refreshChanges++;
    for (const fn of this.refreshSubscribers) {
      try { fn({ refreshHz: hz, budgetMs: this.frameBudgetMs() }); } catch (_) {}
    }
    this.bus?.raiseInterrupt?.('IRQ_DISPLAY', {
      source: 'vdisplay', event: 'refresh-changed', hz,
    }, 'vdisplay');
  }

  frameBudgetMs() {
    // Interpolamos del diccionario
    const known = [1, 10, 24, 30, 60, 90, 120];
    for (const k of known) {
      if (k >= this.currentRefreshHz) return FRAME_BUDGET_MS[k];
    }
    return FRAME_BUDGET_MS[60];
  }

  // ═══════════════════════════════════════════════════════════
  // APARIENCIA / ACCESIBILIDAD
  // ═══════════════════════════════════════════════════════════

  setAppearance(mode) {
    if (!Object.values(Appearance).includes(mode)) {
      logger.warn('VDisplay', `appearance inválido: ${mode}`);
      return false;
    }
    this.appearance = mode;
    logger.info('VDisplay', `appearance = ${mode}`);
    this._emit();
    return true;
  }

  /** Resuelve el modo efectivo (light/dark) según preferencia + hora */
  resolvedAppearance() {
    if (this.appearance === Appearance.LIGHT) return Appearance.LIGHT;
    if (this.appearance === Appearance.DARK)  return Appearance.DARK;
    // AUTO: dark a partir de las 20:00 o antes de las 6:00
    const h = new Date().getHours();
    return (h >= 20 || h < 6) ? Appearance.DARK : Appearance.LIGHT;
  }

  setReduceMotion(on) {
    this.reduceMotion = !!on;
    logger.info('VDisplay', `reduce motion = ${this.reduceMotion}`);
    this._emit();
  }

  setReduceTransparency(on) {
    this.reduceTransparency = !!on;
    logger.info('VDisplay', `reduce transparency = ${this.reduceTransparency}`);
    this._emit();
  }

  setIncreaseContrast(on) {
    this.increaseContrast = !!on;
    logger.info('VDisplay', `increase contrast = ${this.increaseContrast}`);
    this._emit();
  }

  setBoldText(on) {
    this.boldText = !!on;
    logger.info('VDisplay', `bold text = ${this.boldText}`);
    this._emit();
  }

  setDynamicTypeScale(scale) {
    this.dynamicTypeScale = clamp(scale, 0.8, 2.0);
    logger.info('VDisplay', `dynamic type scale = ${this.dynamicTypeScale.toFixed(2)}`);
    this._emit();
  }

  setAODEnabled(on) {
    this.aodEnabled = !!on;
    if (!on && this.state === DisplayState.AOD) {
      this.powerOff('aod-disabled');
    }
    logger.info('VDisplay', `AOD = ${this.aodEnabled}`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // LAYERS / COMPOSICIÓN
  // ═══════════════════════════════════════════════════════════

  upsertLayer(layerId, props) {
    return this.layers.upsert(layerId, props);
  }

  removeLayer(layerId) {
    return this.layers.remove(layerId);
  }

  getLayer(layerId) {
    return this.layers.get(layerId);
  }

  orderedLayers() {
    return this.layers.ordered();
  }

  clearLayers() {
    this.layers.clear();
  }

  /** El compositor llama a esto cada vez que presenta un frame */
  presentFrame({ source = 'springboard', complexity = 1 } = {}) {
    if (this.state !== DisplayState.ON && this.state !== DisplayState.AOD) return null;

    const budget = this.frameBudgetMs();
    // coste en ms proporcional a la complejidad
    const cost = budget * Math.min(1.5, complexity * 0.6 + 0.2 * Math.random());

    this.metrics.framesPresented++;
    if (cost > budget * 1.5) {
      this.metrics.framesDropped++;
      logger.warn('VDisplay', `frame drop (source=${source}, cost=${cost.toFixed(1)}ms, budget=${budget.toFixed(1)}ms)`);
    }

    // Reportar al VGPU para que tenga en cuenta el jank
    const gpu = this.bus?.devices?.gpu;
    if (gpu?.submitFrame) {
      gpu.submitFrame({ source, complexity, layers: this.layers.size() });
    }

    // Registrar actividad de contenido para ProMotion
    this.content.noteChange();

    return { cost, budget, dropped: cost > budget * 1.5 };
  }

  setContentMode(mode) {
    if (mode === 'idle')  this.content.setIdle();
    else if (mode === 'ui')    this.content.setUI();
    else if (mode === 'video') this.content.setVideo();
    else if (mode === 'game')  this.content.setGame();
    else if (mode === 'text')  this.content.setText();
  }

  // ═══════════════════════════════════════════════════════════
  // CAPTURA DE PANTALLA
  // ═══════════════════════════════════════════════════════════

  /**
   * Captura la pantalla. Devuelve un objeto con metadatos y (si el
   * compositor colabora) un buffer de píxeles simulados.
   */
  screenshot({ scale = 1, format = 'png' } = {}) {
    const size = this.getPhysicalSize();
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);
    const pixels = new Uint8ClampedArray(w * h * 4);

    // Rellenamos con un patrón sutil para que no sea todo negro
    // (simula el wallpaper + layers, pero sin compositor real)
    for (let i = 0; i < pixels.length; i += 4) {
      const x = (i / 4) % w;
      const y = Math.floor((i / 4) / w);
      const t = (x + y) / (w + h);
      pixels[i]     = Math.round(30 + 40 * t);        // R
      pixels[i + 1] = Math.round(40 + 60 * t);        // G
      pixels[i + 2] = Math.round(80 + 100 * t);       // B
      pixels[i + 3] = 255;                            // A
    }

    this.metrics.screenshots++;
    logger.info('VDisplay', `screenshot: ${w}×${h} (${format}, scale=${scale})`);

    return {
      width:  w,
      height: h,
      format,
      scale,
      orientation: this.orientation,
      colorSpace:  this.colorSpace,
      brightness:  this.effectiveBrightness,
      appearance:  this.resolvedAppearance(),
      pixels,
      ts: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // HDR
  // ═══════════════════════════════════════════════════════════

  setHDREnabled(on) {
    this.hdrEnabled = !!on;
    logger.info('VDisplay', `HDR = ${this.hdrEnabled}`);
    this._emit();
  }

  setHDRMetadata({ maxCLL = null, maxFALL = null, masteringDisplay = null } = {}) {
    if (maxCLL !== null) this.hdrMetadata.maxCLL = maxCLL;
    if (maxFALL !== null) this.hdrMetadata.maxFALL = maxFALL;
    if (masteringDisplay !== null) this.hdrMetadata.masteringDisplay = masteringDisplay;
    logger.info('VDisplay', `HDR metadata: CLL=${this.hdrMetadata.maxCLL} FALL=${this.hdrMetadata.maxFALL}`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onBrightness(fn) {
    this.brightnessSubscribers.add(fn);
    return () => this.brightnessSubscribers.delete(fn);
  }

  onOrientation(fn) {
    this.orientationSubscribers.add(fn);
    return () => this.orientationSubscribers.delete(fn);
  }

  onRefresh(fn) {
    this.refreshSubscribers.add(fn);
    return () => this.refreshSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VDisplay', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    const size = this.getLogicalSize();
    return {
      model:             this.model,
      state:             this.state,
      logicalW:          size.width,
      logicalH:          size.height,
      physicalW:         this.getPhysicalSize().width,
      physicalH:         this.getPhysicalSize().height,
      scale:             this.panel.scale,
      dpi:               this.panel.dpi,
      brightness:        parseFloat(this.brightness.toFixed(3)),
      effectiveBrightness:parseFloat(this.effectiveBrightness.toFixed(3)),
      autoBrightness:    this.autoBrightness,
      trueTone:          this.trueTone,
      nightShift:        this.nightShift,
      appearance:        this.appearance,
      resolvedAppearance:this.resolvedAppearance(),
      orientation:       this.orientation,
      refreshMode:       this.refreshMode,
      refreshHz:         this.currentRefreshHz,
      frameBudgetMs:     parseFloat(this.frameBudgetMs().toFixed(3)),
      colorSpace:        this.colorSpace,
      hdrEnabled:        this.hdrEnabled,
      aod: {
        enabled: this.aodEnabled,
        active:  this.aodActive,
      },
      accessibility: {
        reduceMotion:       this.reduceMotion,
        reduceTransparency: this.reduceTransparency,
        increaseContrast:   this.increaseContrast,
        boldText:           this.boldText,
        dynamicTypeScale:   this.dynamicTypeScale,
      },
      powerMw:  parseFloat(this.currentPowerMw.toFixed(1)),
      layers:   this.layers.size(),
      safeArea: this.getSafeArea(),
      dynamicIsland: this.panel.dynamicIsland,
      contentMode: this.content.mode,
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      panel: {
        physicalW:  this.panel.physicalW,
        physicalH:  this.panel.physicalH,
        refreshMin: this.panel.refreshMin,
        refreshMax: this.panel.refreshMax,
        peakNits:   this.panel.peakNits,
      },
      powerMw: parseFloat(this.currentPowerMw.toFixed(1)),
    };
  }

  dump() {
    const s = this.getStats();
    const snap = this.getSnapshot();
    const lines = [
      `VDisplay [${s.state}] — ${s.model}`,
      `  panel:       ${snap.physicalW}×${snap.physicalH}px (${snap.logicalW}×${snap.logicalH}pt @${snap.scale}x)`,
      `  refresh:     ${snap.refreshHz}Hz (mode=${snap.refreshMode}, budget=${snap.frameBudgetMs}ms)`,
      `  brightness:  ${(snap.brightness * 100).toFixed(0)}% user → ${(snap.effectiveBrightness * 100).toFixed(0)}% effective (auto=${snap.autoBrightness})`,
      `  appearance:  ${snap.resolvedAppearance} (mode=${snap.appearance})`,
      `  orientation: ${snap.orientation}`,
      `  AOD:         ${snap.aod.enabled ? 'enabled' : 'disabled'}${snap.aod.active ? ' (active)' : ''}`,
      `  colorSpace:  ${snap.colorSpace}  HDR=${snap.hdrEnabled}`,
      `  safe areas:  top=${snap.safeArea.top} bottom=${snap.safeArea.bottom} left=${snap.safeArea.left} right=${snap.safeArea.right}`,
      `  layers:      ${snap.layers}`,
      `  power:       ${snap.powerMw}mW`,
      `  metrics:`,
      `    powerOns=${s.metrics.powerOns} powerOffs=${s.metrics.powerOffs} orientChanges=${s.metrics.orientationChanges}`,
      `    brightness=${s.metrics.brightnessChanges} refresh=${s.metrics.refreshChanges}`,
      `    frames=${s.metrics.framesPresented} dropped=${s.metrics.framesDropped}`,
      `    screenshots=${s.metrics.screenshots} aodActivations=${s.metrics.aodActivations}`,
    ];
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:          [...this.history.ts],
      refreshHz:   [...this.history.refreshHz],
      brightness:  [...this.history.brightness],
      frameTimeMs: [...this.history.frameTimeMs],
    };
  }
}
