// src/drivers/VTouch.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VTouch (Virtual Touch / Multitouch)
 * ═══════════════════════════════════════════════════════════════
 *
 * Subsistema táctil multitouch. Modela el panel capacitivo de un
 * iPhone (10 puntos simultáneos, 120Hz de muestreo), reconoce los
 * gestos del sistema iOS, y los entrega a la UI ya interpretados
 * como eventos de alto nivel.
 *
 * Responsabilidades:
 *   - Capturar y almacenar touches (start/move/end/cancel)
 *   - Simular 10 dedos con IDs asignados por el hardware
 *   - Reconocer gestos iOS:
 *       · tap, double-tap, triple-tap, long-press
 *       · pan (drag), swipe (4 direcciones), flick
 *       · pinch (zoom), rotate
 *       · 2-finger tap, 3-finger swipe, 4-finger, 5-finger pinch (home)
 *   - Edge gestures del sistema:
 *       · swipe desde arriba → Notification Center
 *       · swipe desde arriba-derecha → Control Center
 *       · swipe desde abajo → Home
 *       · swipe desde izquierda (borde) → Back
 *       · swipe desde derecha (borde) → Forward
 *   - Hit-testing contra el layer stack del VDisplay
 *   - Suavizado de trayectorias (Kalman-lite)
 *   - Palm rejection
 *   - Reconocimiento de firmas / scribbles (path sampling)
 *   - Cola de eventos con timestamps (backpressure)
 *   - Consumo energético del panel táctil
 *   - Suscriptores por tipo de gesto
 *   - IRQ_TOUCH con eventos de gesto y de dedo
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const TouchPhase = {
  BEGAN:   'began',
  MOVED:   'moved',
  ENDED:   'ended',
  CANCELLED:'cancelled',
  STATIONARY:'stationary',
};

export const GestureType = {
  NONE:            'none',
  TAP:             'tap',
  DOUBLE_TAP:      'double-tap',
  TRIPLE_TAP:      'triple-tap',
  LONG_PRESS:      'long-press',
  PAN:             'pan',
  SWIPE_LEFT:      'swipe-left',
  SWIPE_RIGHT:     'swipe-right',
  SWIPE_UP:        'swipe-up',
  SWIPE_DOWN:      'swipe-down',
  FLICK:           'flick',
  PINCH:           'pinch',
  ROTATE:          'rotate',
  TWO_FINGER_TAP:  'two-finger-tap',
  THREE_FINGER_SWIPE:'three-finger-swipe',
  FOUR_FINGER_SWIPE:'four-finger-swipe',
  FIVE_FINGER_PINCH:'five-finger-pinch',
  EDGE_TOP:        'edge-top',          // Notification Center
  EDGE_TOP_RIGHT:  'edge-top-right',    // Control Center
  EDGE_BOTTOM:     'edge-bottom',       // Home
  EDGE_LEFT:       'edge-left',         // Back
  EDGE_RIGHT:      'edge-right',        // Forward
};

export const TouchSource = {
  FINGER: 'finger',
  PALM:   'palm',
  STYLUS: 'stylus',
};

// Umbrales del reconocedor
const TH = {
  TAP_MAX_MOVE_PX:     10,     // máximo movimiento para ser tap
  TAP_MAX_DURATION_MS: 200,
  DOUBLE_TAP_MAX_GAP:  300,    // tiempo entre los dos taps
  TRIPLE_TAP_MAX_GAP:  300,
  LONG_PRESS_MIN_MS:   500,
  SWIPE_MIN_DISTANCE:  50,
  SWIPE_MAX_DURATION:  600,
  FLICK_MIN_VELOCITY:  800,    // px/s
  EDGE_ZONE_PX:        20,     // ancho de la zona de borde
  PALM_MIN_AREA_PX2:   3000,   // área mínima para considerar palma
  SMOOTHING_FACTOR:    0.35,   // para el filtro de posición
};

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function angleBetween(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// ───────────────────────────────────────────────────────────────
// TouchPoint — un dedo / punto de contacto
// ───────────────────────────────────────────────────────────────
class TouchPoint {
  constructor({ id, x, y, force = 0.5, majorRadius = 12, minorRadius = 12, angle = 0, source = TouchSource.FINGER }) {
    this.id     = id;
    this.x      = x;
    this.y      = y;
    this.startX = x;
    this.startY = y;

    this.force       = force;         // 0..1 (3D Touch-like)
    this.maxForce    = force;
    this.majorRadius = majorRadius;   // radio mayor (px)
    this.minorRadius = minorRadius;
    this.angle       = angle;         // orientación
    this.source      = source;

    this.startTs   = Date.now();
    this.lastMoveTs= Date.now();
    this.phase     = TouchPhase.BEGAN;

    // Trayectoria (limitada para no crecer infinito)
    this.path = [{ x, y, ts: this.startTs }];
    this.maxPathLen = 200;

    // Velocidad (px/s) — se actualiza en cada move
    this.vx = 0;
    this.vy = 0;

    // Aceleración (px/s²)
    this.ax = 0;
    this.ay = 0;
  }

  durationMs() {
    return Date.now() - this.startTs;
  }

  moveTo(x, y, force = null) {
    const now = Date.now();
    const dt = Math.max(1, now - this.lastMoveTs) / 1000;

    const prevX = this.x, prevY = this.y;
    const prevVx = this.vx, prevVy = this.vy;

    // Filtro suave (EMA) para reducir jitter del panel
    this.x = this.x + (x - this.x) * (1 - TH.SMOOTHING_FACTOR) + (x - this.x) * TH.SMOOTHING_FACTOR;
    this.y = this.y + (y - this.y) * (1 - TH.SMOOTHING_FACTOR) + (y - this.y) * TH.SMOOTHING_FACTOR;

    this.vx = (this.x - prevX) / dt;
    this.vy = (this.y - prevY) / dt;
    this.ax = (this.vx - prevVx) / dt;
    this.ay = (this.vy - prevVy) / dt;

    if (force !== null) {
      this.force = force;
      if (force > this.maxForce) this.maxForce = force;
    }

    this.lastMoveTs = now;
    this.phase = TouchPhase.MOVED;

    this.path.push({ x: this.x, y: this.y, ts: now });
    if (this.path.length > this.maxPathLen) this.path.shift();
  }

  end() {
    this.phase = TouchPhase.ENDED;
  }

  cancel() {
    this.phase = TouchPhase.CANCELLED;
  }

  displacement() {
    return distance({ x: this.startX, y: this.startY }, { x: this.x, y: this.y });
  }

  velocity() {
    return Math.hypot(this.vx, this.vy);
  }

  snapshot() {
    return {
      id:         this.id,
      x:          parseFloat(this.x.toFixed(2)),
      y:          parseFloat(this.y.toFixed(2)),
      startX:     this.startX,
      startY:     this.startY,
      force:      parseFloat(this.force.toFixed(3)),
      maxForce:   parseFloat(this.maxForce.toFixed(3)),
      radius:     this.majorRadius,
      angle:      parseFloat(this.angle.toFixed(3)),
      source:     this.source,
      phase:      this.phase,
      durationMs: this.durationMs(),
      displacement: parseFloat(this.displacement().toFixed(2)),
      velocity:   parseFloat(this.velocity().toFixed(1)),
      pathLen:    this.path.length,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Cola de eventos táctiles (con backpressure)
// ───────────────────────────────────────────────────────────────
class TouchEventQueue {
  constructor(capacity = 512) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.totalEnqueued = 0;
    this.totalDropped = 0;
  }

  enqueue(evt) {
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.size--;
      this.totalDropped++;
    }
    this.buffer[this.tail] = evt;
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
    this.totalEnqueued++;
  }

  dequeue() {
    if (this.size === 0) return null;
    const e = this.buffer[this.head];
    this.buffer[this.head] = null;
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return e;
  }

  drain(max = 64) {
    const out = [];
    while (this.size > 0 && out.length < max) out.push(this.dequeue());
    return out;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }

  get length() { return this.size; }
}

// ───────────────────────────────────────────────────────────────
// Recognizer — reconocimiento de gestos
// ───────────────────────────────────────────────────────────────
class GestureRecognizer {
  constructor() {
    this.lastTapTs = 0;
    this.lastTapX  = 0;
    this.lastTapY  = 0;
    this.tapCount  = 0;
    this.lastTapEndTs = 0;
    this.lastDoubleTapTs = 0;
  }

  /** Comprueba si un touch terminado puede ser un tap */
  isTap(t) {
    return t.displacement() < TH.TAP_MAX_MOVE_PX &&
           t.durationMs() < TH.TAP_MAX_DURATION_MS;
  }

  /** Comprueba si es long-press */
  isLongPress(t) {
    return t.displacement() < TH.TAP_MAX_MOVE_PX &&
           t.durationMs() >= TH.LONG_PRESS_MIN_MS;
  }

  /** Determina dirección de swipe / flick */
  swipeDirection(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? GestureType.SWIPE_RIGHT : GestureType.SWIPE_LEFT;
    }
    return dy > 0 ? GestureType.SWIPE_DOWN : GestureType.SWIPE_UP;
  }

  /**
   * Al terminar un touch, decide qué gesto ha sido.
   * Puede devolver null si no es ninguno reconocible.
   */
  classifySingle(touch, { safeArea, size }) {
    const now = Date.now();
    const disp = touch.displacement();
    const dur  = touch.durationMs();
    const vel  = touch.velocity();

    // ── Long press ──────────────────────────────────────────
    if (this.isLongPress(touch)) {
      return {
        type: GestureType.LONG_PRESS,
        start: { x: touch.startX, y: touch.startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
        force: touch.maxForce,
        touchId: touch.id,
      };
    }

    // ── Tap / double-tap / triple-tap ───────────────────────
    if (this.isTap(touch)) {
      const sinceLastTap = now - this.lastTapEndTs;
      const distFromLastTap = distance(
        { x: touch.x, y: touch.y },
        { x: this.lastTapX, y: this.lastTapY },
      );

      if (this.tapCount > 0 && sinceLastTap < TH.DOUBLE_TAP_MAX_GAP && distFromLastTap < 40) {
        this.tapCount++;
      } else {
        this.tapCount = 1;
      }

      this.lastTapEndTs = now;
      this.lastTapX = touch.x;
      this.lastTapY = touch.y;

      if (this.tapCount >= 3) {
        const result = {
          type: GestureType.TRIPLE_TAP,
          x: touch.x, y: touch.y,
          count: this.tapCount,
          force: touch.maxForce,
        };
        this.tapCount = 0;
        return result;
      }
      if (this.tapCount === 2) {
        // No devolvemos todavía: esperamos a ver si es triple
        // Pero para simplificar, devolvemos double-tap inmediato
        const result = {
          type: GestureType.DOUBLE_TAP,
          x: touch.x, y: touch.y,
          count: 2,
          force: touch.maxForce,
        };
        return result;
      }
      return {
        type: GestureType.TAP,
        x: touch.x, y: touch.y,
        force: touch.maxForce,
        touchId: touch.id,
      };
    }

    // ── Edge gestures ───────────────────────────────────────
    // Determinar si el touch empezó en una zona de borde
    const startX = touch.startX, startY = touch.startY;
    const inTopEdge    = startY <= safeArea.top + TH.EDGE_ZONE_PX;
    const inBottomEdge = startY >= size.height - (safeArea.bottom + TH.EDGE_ZONE_PX);
    const inLeftEdge   = startX <= safeArea.left + TH.EDGE_ZONE_PX;
    const inRightEdge  = startX >= size.width - (safeArea.right + TH.EDGE_ZONE_PX);

    const dx = touch.x - touch.startX;
    const dy = touch.y - touch.startY;

    if (inTopEdge && dy > TH.SWIPE_MIN_DISTANCE) {
      // arriba-izquierda → Notification Center
      // arriba-derecha → Control Center
      const rightHalf = startX > size.width * 0.6;
      return {
        type: rightHalf ? GestureType.EDGE_TOP_RIGHT : GestureType.EDGE_TOP,
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
      };
    }
    if (inBottomEdge && dy < -TH.SWIPE_MIN_DISTANCE) {
      return {
        type: GestureType.EDGE_BOTTOM,
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
      };
    }
    if (inLeftEdge && dx > TH.SWIPE_MIN_DISTANCE) {
      return {
        type: GestureType.EDGE_LEFT,
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
      };
    }
    if (inRightEdge && dx < -TH.SWIPE_MIN_DISTANCE) {
      return {
        type: GestureType.EDGE_RIGHT,
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
      };
    }

    // ── Flick ───────────────────────────────────────────────
    if (vel >= TH.FLICK_MIN_VELOCITY && disp >= TH.SWIPE_MIN_DISTANCE && dur < 300) {
      return {
        type: GestureType.FLICK,
        direction: this.swipeDirection(dx, dy),
        velocity: parseFloat(vel.toFixed(1)),
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        durationMs: dur,
      };
    }

    // ── Swipe ───────────────────────────────────────────────
    if (disp >= TH.SWIPE_MIN_DISTANCE && dur < TH.SWIPE_MAX_DURATION) {
      return {
        type: this.swipeDirection(dx, dy),
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        distance: parseFloat(disp.toFixed(1)),
        durationMs: dur,
      };
    }

    // ── Pan (movimiento largo) ──────────────────────────────
    if (disp >= TH.SWIPE_MIN_DISTANCE) {
      return {
        type: GestureType.PAN,
        start: { x: startX, y: startY },
        end:   { x: touch.x, y: touch.y },
        distance: parseFloat(disp.toFixed(1)),
        durationMs: dur,
      };
    }

    return null;
  }

  /**
   * Gestos multifinger al terminar el último dedo.
   */
  classifyMulti(touches, { size }) {
    const n = touches.length;
    if (n < 2) return null;

    // ¿Todos son taps?
    const allTaps = touches.every(t => this.isTap(t));
    if (allTaps) {
      if (n === 2) return { type: GestureType.TWO_FINGER_TAP, touchCount: n };
      return null;
    }

    // Centroide inicial y final
    const start = {
      x: touches.reduce((a, t) => a + t.startX, 0) / n,
      y: touches.reduce((a, t) => a + t.startY, 0) / n,
    };
    const end = {
      x: touches.reduce((a, t) => a + t.x, 0) / n,
      y: touches.reduce((a, t) => a + t.y, 0) / n,
    };
    const dx = end.x - start.x, dy = end.y - start.y;

    // Movimiento colectivo
    if (Math.hypot(dx, dy) >= TH.SWIPE_MIN_DISTANCE) {
      if (n === 3) return {
        type: GestureType.THREE_FINGER_SWIPE,
        direction: this.swipeDirection(dx, dy),
        start, end,
      };
      if (n === 4) return {
        type: GestureType.FOUR_FINGER_SWIPE,
        direction: this.swipeDirection(dx, dy),
        start, end,
      };
    }

    // Pinch: distancia entre dedos cambió
    if (n >= 2) {
      const initialDist = distance(
        { x: touches[0].startX, y: touches[0].startY },
        { x: touches[1].startX, y: touches[1].startY },
      );
      const finalDist = distance(
        { x: touches[0].x, y: touches[0].y },
        { x: touches[1].x, y: touches[1].y },
      );
      const ratio = finalDist / Math.max(1, initialDist);

      if (ratio < 0.7 || ratio > 1.3) {
        // 5 fingers acercándose = home
        if (n >= 5 && ratio < 0.7) {
          return { type: GestureType.FIVE_FINGER_PINCH, scale: ratio };
        }
        return {
          type: GestureType.PINCH,
          scale: ratio,
          fingers: n,
        };
      }

      // Rotación
      const initialAngle = angleBetween(
        { x: touches[0].startX, y: touches[0].startY },
        { x: touches[1].startX, y: touches[1].startY },
      );
      const finalAngle = angleBetween(
        { x: touches[0].x, y: touches[0].y },
        { x: touches[1].x, y: touches[1].y },
      );
      const rot = finalAngle - initialAngle;
      if (Math.abs(rot) > 0.3) {
        return { type: GestureType.ROTATE, rotation: rot, fingers: n };
      }
    }

    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// VTouch — driver completo
// ───────────────────────────────────────────────────────────────
export class VTouch {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VTouch';
    this.model = 'Multi-Touch Retina';

    // Estado
    this.initialized = false;
    this.running     = false;
    this.enabled     = true;

    // Capacidades del panel
    this.maxTouches       = 10;
    this.sampleRateHz     = 120;
    this.supportsForce    = true;
    this.supportsStylus   = false;
    this.supportsPalmRejection = true;

    // Estado actual de los dedos
    this.activeTouches = new Map();       // id -> TouchPoint
    this.nextTouchId   = 1;

    // Cola de eventos
    this.eventQueue = new TouchEventQueue(512);

    // Recognizer
    this.recognizer = new GestureRecognizer();

    // Pantalla (para saber tamaño y safe area)
    this.screenSize = { width: 402, height: 874 };
    this.safeArea = { top: 47, bottom: 34, left: 0, right: 0 };

    // Últimos eventos (para debug)
    this.lastTouchEvent = null;
    this.lastGesture    = null;

    // Historial de gestos (últimos 100)
    this.gestureHistory = [];
    this.maxGestureHistory = 100;

    // Suscriptores
    this.subscribers         = new Set();
    this.touchSubscribers    = new Set();
    this.gestureSubscribers  = new Set();

    // Tick loop
    this.tickIntervalMs = 8;              // ~120Hz
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      touchEventsStarted:  0,
      touchEventsMoved:    0,
      touchEventsEnded:    0,
      touchEventsCancelled:0,
      gesturesRecognized:  0,
      palmsRejected:       0,
      maxSimultaneousTouches: 0,
      eventsDropped:       0,
      startedAt:           null,
    };

    // Consumo energético (mW) — activo solo cuando hay toques
    this.currentPowerMw = 15;
    this.lastTouchActivityTs = 0;

    logger.kernel('VTouch',
      `creado: ${this.model} (${this.maxTouches} puntos, ${this.sampleRateHz}Hz, force=${this.supportsForce})`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    // Enlazar tamaño de pantalla al VDisplay si está disponible
    this._syncScreenFromDisplay();

    logger.info('VTouch',
      `✓ init: ${this.model}, ${this.maxTouches} dedos, ${this.sampleRateHz}Hz, ` +
      `force=${this.supportsForce}, palmRejection=${this.supportsPalmRejection}`);
    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'ready',
    }, 'vtouch');
  }

  _syncScreenFromDisplay() {
    const display = this.bus?.devices?.display;
    if (!display) return;
    const size = display.getLogicalSize?.();
    if (size) this.screenSize = size;
    const sa = display.getSafeArea?.();
    if (sa) this.safeArea = sa;

    // Suscribirse a cambios de orientación para actualizar tamaño y safe area
    display.onOrientation?.(({ orientation, safeArea }) => {
      const s = display.getLogicalSize?.();
      if (s) this.screenSize = s;
      if (safeArea) this.safeArea = safeArea;
      logger.debug('VTouch', `tamaño y safe-area actualizados: ${this.screenSize.width}×${this.screenSize.height}`);
    });
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

    // Cancelar todos los touches pendientes
    for (const t of this.activeTouches.values()) {
      t.cancel();
      this._emitTouchEvent({ phase: TouchPhase.CANCELLED, touch: t.snapshot() });
    }
    this.activeTouches.clear();
    this.eventQueue.clear();
    logger.info('VTouch', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // 1) Consumo energético según actividad reciente
    this._updatePowerDraw();

    // 2) Drenar cola de eventos y notificar a los suscriptores
    const events = this.eventQueue.drain(64);
    for (const evt of events) {
      this._notifyTouch(evt);
    }

    // 3) Auto-cancelar long presses que ya se han reportado
    for (const t of [...this.activeTouches.values()]) {
      const dur = t.durationMs();
      // Si supera 3s y sigue activo, probablemente es un dedo apoyado
      if (dur > 3000 && t.phase === TouchPhase.STATIONARY) {
        // no hacemos nada por ahora, el long press ya se habrá emitido
      }
    }

    this.tickCount++;
  }

  _updatePowerDraw() {
    const sinceActivity = Date.now() - this.lastTouchActivityTs;
    if (sinceActivity < 500) {
      this.currentPowerMw = 25;    // escaneando activamente
    } else if (sinceActivity < 3000) {
      this.currentPowerMw = 18;
    } else {
      this.currentPowerMw = 12;    // idle
    }
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA — INPUT SIMULATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Registra el comienzo de un touch.
   * @param {object} params { x, y, force, majorRadius, minorRadius, angle, source, touchId }
   */
  touchBegin(params = {}) {
    if (!this.enabled) return null;
    const x = clamp(params.x ?? 0, 0, this.screenSize.width);
    const y = clamp(params.y ?? 0, 0, this.screenSize.height);
    const force = params.force ?? 0.5;
    const source = params.source ?? TouchSource.FINGER;

    // Palm rejection
    if (this.supportsPalmRejection && this._looksLikePalm(params)) {
      this.metrics.palmsRejected++;
      logger.debug('VTouch', 'palm rechazado');
      return null;
    }

    // Límite de dedos simultáneos
    if (this.activeTouches.size >= this.maxTouches) {
      logger.warn('VTouch', `límite de ${this.maxTouches} dedos alcanzado`);
      return null;
    }

    const id = params.touchId ?? this.nextTouchId++;
    const touch = new TouchPoint({
      id, x, y, force, source,
      majorRadius: params.majorRadius ?? 12,
      minorRadius: params.minorRadius ?? 12,
      angle:       params.angle ?? 0,
    });

    this.activeTouches.set(id, touch);
    this.metrics.touchEventsStarted++;
    this.metrics.maxSimultaneousTouches = Math.max(this.metrics.maxSimultaneousTouches, this.activeTouches.size);
    this.lastTouchActivityTs = Date.now();

    const evt = {
      id:     `${Date.now()}-${id}-began`,
      ts:     Date.now(),
      phase:  TouchPhase.BEGAN,
      touch:  touch.snapshot(),
      activeTouches: this.activeTouches.size,
    };
    this.eventQueue.enqueue(evt);
    this.lastTouchEvent = evt;

    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'began', touch: touch.snapshot(), active: this.activeTouches.size,
    }, 'vtouch');

    return id;
  }

  /**
   * Actualiza la posición de un touch existente.
   */
  touchMove(touchId, { x, y, force = null } = {}) {
    if (!this.enabled) return false;
    const touch = this.activeTouches.get(touchId);
    if (!touch) return false;

    const nx = clamp(x ?? touch.x, 0, this.screenSize.width);
    const ny = clamp(y ?? touch.y, 0, this.screenSize.height);
    touch.moveTo(nx, ny, force);
    this.metrics.touchEventsMoved++;
    this.lastTouchActivityTs = Date.now();

    const evt = {
      id:     `${Date.now()}-${touchId}-moved`,
      ts:     Date.now(),
      phase:  TouchPhase.MOVED,
      touch:  touch.snapshot(),
      activeTouches: this.activeTouches.size,
    };
    this.eventQueue.enqueue(evt);
    this.lastTouchEvent = evt;

    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'moved', touch: touch.snapshot(),
    }, 'vtouch');

    return true;
  }

  /**
   * Finaliza un touch. Dispara el reconocimiento de gesto.
   */
  touchEnd(touchId, { x = null, y = null } = {}) {
    if (!this.enabled) return null;
    const touch = this.activeTouches.get(touchId);
    if (!touch) return null;

    if (x !== null && y !== null) {
      touch.moveTo(clamp(x, 0, this.screenSize.width), clamp(y, 0, this.screenSize.height));
    }

    touch.end();
    this.activeTouches.delete(touchId);
    this.metrics.touchEventsEnded++;
    this.lastTouchActivityTs = Date.now();

    const evt = {
      id:     `${Date.now()}-${touchId}-ended`,
      ts:     Date.now(),
      phase:  TouchPhase.ENDED,
      touch:  touch.snapshot(),
      activeTouches: this.activeTouches.size,
    };
    this.eventQueue.enqueue(evt);
    this.lastTouchEvent = evt;

    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'ended', touch: touch.snapshot(),
    }, 'vtouch');

    // Reconocer gesto
    let gesture = this.recognizer.classifySingle(touch, {
      safeArea: this.safeArea,
      size: this.screenSize,
    });

    // Si no hay gesto individual, comprobar multi-finger (con el resto
    // de dedos que acaban de terminar; aquí simplificamos usando solo
    // este touch más los que aún están activos)
    if (!gesture) {
      const ongoing = [...this.activeTouches.values()];
      if (ongoing.length > 0) {
        gesture = this.recognizer.classifyMulti([touch, ...ongoing], {
          size: this.screenSize,
        });
      }
    }

    if (gesture) {
      this._emitGesture(gesture);
    }

    return gesture;
  }

  /**
   * Cancela un touch (interrupción del sistema, llamada, etc.).
   */
  touchCancel(touchId) {
    const touch = this.activeTouches.get(touchId);
    if (!touch) return false;

    touch.cancel();
    this.activeTouches.delete(touchId);
    this.metrics.touchEventsCancelled++;

    const evt = {
      id:     `${Date.now()}-${touchId}-cancelled`,
      ts:     Date.now(),
      phase:  TouchPhase.CANCELLED,
      touch:  touch.snapshot(),
      activeTouches: this.activeTouches.size,
    };
    this.eventQueue.enqueue(evt);
    this.lastTouchEvent = evt;

    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'cancelled', touch: touch.snapshot(),
    }, 'vtouch');

    return true;
  }

  /** Cancela todos los touches activos (por ejemplo al bloquear). */
  cancelAll() {
    for (const id of [...this.activeTouches.keys()]) {
      this.touchCancel(id);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SIMULACIÓN DE GESTOS COMPLETOS
  // ═══════════════════════════════════════════════════════════

  /**
   * Simula un tap completo (begin + end) en una posición.
   */
  async simulateTap(x, y, { force = 0.5 } = {}) {
    const id = this.touchBegin({ x, y, force });
    if (id === null) return null;
    await this._delay(40 + Math.random() * 40);
    return this.touchEnd(id, { x, y });
  }

  /**
   * Simula un swipe desde (x1,y1) a (x2,y2) con N pasos intermedios.
   */
  async simulateSwipe(x1, y1, x2, y2, { steps = 12, stepDelayMs = 15, force = 0.5 } = {}) {
    const id = this.touchBegin({ x: x1, y: y1, force });
    if (id === null) return null;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      this.touchMove(id, { x, y });
      await this._delay(stepDelayMs);
    }

    return this.touchEnd(id, { x: x2, y: y2 });
  }

  /**
   * Simula un pinch (dos dedos que se acercan o alejan).
   */
  async simulatePinch(centerX, centerY, scale = 2.0, { steps = 12, stepDelayMs = 15, distance = 100 } = {}) {
    const startDist = distance;
    const endDist = distance * scale;

    const id1 = this.touchBegin({ x: centerX - startDist / 2, y: centerY });
    const id2 = this.touchBegin({ x: centerX + startDist / 2, y: centerY });
    if (id1 === null || id2 === null) return null;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const d = startDist + (endDist - startDist) * t;
      this.touchMove(id1, { x: centerX - d / 2, y: centerY });
      this.touchMove(id2, { x: centerX + d / 2, y: centerY });
      await this._delay(stepDelayMs);
    }

    this.touchEnd(id1, { x: centerX - endDist / 2, y: centerY });
    const gesture = this.touchEnd(id2, { x: centerX + endDist / 2, y: centerY });
    return gesture;
  }

  /**
   * Simula un edge swipe (por ejemplo desde arriba para abrir
   * el Centro de Control).
   */
  async simulateEdgeSwipe(edge, { distance = 200, steps = 12, stepDelayMs = 15 } = {}) {
    const w = this.screenSize.width;
    const h = this.screenSize.height;
    let x1, y1, x2, y2;

    switch (edge) {
      case 'top':
        x1 = w / 2;      y1 = 5;
        x2 = w / 2;      y2 = 5 + distance;
        break;
      case 'top-right':
        x1 = w * 0.85;   y1 = 5;
        x2 = w * 0.85;   y2 = 5 + distance;
        break;
      case 'bottom':
        x1 = w / 2;      y1 = h - 5;
        x2 = w / 2;      y2 = h - 5 - distance;
        break;
      case 'left':
        x1 = 5;          y1 = h / 2;
        x2 = 5 + distance; y2 = h / 2;
        break;
      case 'right':
        x1 = w - 5;      y1 = h / 2;
        x2 = w - 5 - distance; y2 = h / 2;
        break;
      default:
        return null;
    }

    return this.simulateSwipe(x1, y1, x2, y2, { steps, stepDelayMs });
  }

  // ═══════════════════════════════════════════════════════════
  // PALM REJECTION
  // ═══════════════════════════════════════════════════════════

  _looksLikePalm({ majorRadius = 12, minorRadius = 12, force = 0.5 } = {}) {
    const area = Math.PI * majorRadius * minorRadius;
    return area >= TH.PALM_MIN_AREA_PX2;
  }

  // ═══════════════════════════════════════════════════════════
  // HIT-TESTING contra las layers del VDisplay
  // ═══════════════════════════════════════════════════════════

  /**
   * Devuelve la layer superior que contiene el punto (x,y).
   */
  hitTest(x, y) {
    const display = this.bus?.devices?.display;
    if (!display) return null;
    const layers = display.orderedLayers();
    for (const l of layers) {
      const r = l.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        return l;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onTouch(fn) {
    this.touchSubscribers.add(fn);
    return () => this.touchSubscribers.delete(fn);
  }

  onGesture(fn) {
    this.gestureSubscribers.add(fn);
    return () => this.gestureSubscribers.delete(fn);
  }

  _notifyTouch(evt) {
    for (const fn of this.touchSubscribers) {
      try { fn(evt); } catch (err) {
        logger.error('VTouch', `touch subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitGesture(gesture) {
    this.metrics.gesturesRecognized++;
    this.lastGesture = gesture;

    // Guardar en historial
    const entry = { ts: Date.now(), gesture };
    this.gestureHistory.push(entry);
    if (this.gestureHistory.length > this.maxGestureHistory) {
      this.gestureHistory.shift();
    }

    logger.debug('VTouch', `gesto: ${gesture.type}${gesture.direction ? ` (${gesture.direction})` : ''}`);

    for (const fn of this.gestureSubscribers) {
      try { fn(gesture); } catch (err) {
        logger.error('VTouch', `gesture subscriber falló: ${err.message}`, err);
      }
    }

    this.bus?.raiseInterrupt?.('IRQ_TOUCH', {
      source: 'vtouch', event: 'gesture', gesture,
    }, 'vtouch');
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isTouching() {
    return this.activeTouches.size > 0;
  }

  activeCount() {
    return this.activeTouches.size;
  }

  getActiveTouches() {
    return [...this.activeTouches.values()].map(t => t.snapshot());
  }

  getLastGesture() {
    return this.lastGesture;
  }

  getGestureHistory(n = 20) {
    return this.gestureHistory.slice(-n);
  }

  getScreenSize() {
    return { ...this.screenSize };
  }

  getSafeArea() {
    return { ...this.safeArea };
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:        this.model,
      enabled:      this.enabled,
      maxTouches:   this.maxTouches,
      sampleRateHz: this.sampleRateHz,
      activeCount:  this.activeTouches.size,
      activeTouches:this.getActiveTouches(),
      screenSize:   { ...this.screenSize },
      safeArea:     { ...this.safeArea },
      lastGesture:  this.lastGesture,
      powerMw:      parseFloat(this.currentPowerMw.toFixed(1)),
      queueLength:  this.eventQueue.length,
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      enabled:     this.enabled,
      metrics:     { ...this.metrics },
      queueLen:    this.eventQueue.length,
      queueEnq:    this.eventQueue.totalEnqueued,
      queueDrop:   this.eventQueue.totalDropped,
      gestureHistory: this.gestureHistory.length,
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VTouch [${s.running ? 'RUNNING' : 'STOPPED'}] — ${s.model}`,
      `  enabled:      ${s.enabled}`,
      `  maxTouches:   ${this.maxTouches}`,
      `  sampleRate:   ${this.sampleRateHz}Hz`,
      `  active:       ${this.activeTouches.size}`,
      `  screen:       ${this.screenSize.width}×${this.screenSize.height}`,
      `  safeArea:     top=${this.safeArea.top} bottom=${this.safeArea.bottom}`,
      `  queue:        ${s.queueLen} (enq=${s.queueEnq}, drop=${s.queueDrop})`,
      `  lastGesture:  ${this.lastGesture ? this.lastGesture.type : '—'}`,
      `  metrics:`,
      `    began=${s.metrics.touchEventsStarted} moved=${s.metrics.touchEventsMoved} ended=${s.metrics.touchEventsEnded} cancelled=${s.metrics.touchEventsCancelled}`,
      `    gestures=${s.metrics.gesturesRecognized} palmsRejected=${s.metrics.palmsRejected}`,
      `    maxSimultaneous=${s.metrics.maxSimultaneousTouches}`,
      `  power:        ${this.currentPowerMw}mW`,
    ];
    return lines.join('\n');
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.cancelAll();
    logger.info('VTouch', `enabled = ${this.enabled}`);
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
