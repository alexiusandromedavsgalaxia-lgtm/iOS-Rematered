// src/ui/GestureHandler.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — GestureHandler
//
// Sistema unificado de gestos táctiles. En vez de manejar pointer events a mano
// en cada componente (y reimplementar los umbrales, la velocidad, el swipe
// direccional, etc.), se centraliza aquí:
//
//   <GestureHandler onTap onLongPress onSwipeUp onSwipeLeft ...>
//     <div>contenido</div>
//   </GestureHandler>
//
// Gestos soportados:
//   • tap            — toque corto (< 250ms, sin movimiento)
//   • doubleTap      — dos taps en < 300ms
//   • longPress      — pulsación mantenida (520ms por defecto)
//   • pan            — arrastre libre (devuelve dx, dy)
//   • swipe          — arrastre rápido con dirección (up/down/left/right)
//   • pinch          — dos dedos, escala
//   • rotate         — dos dedos, ángulo
//   • edgeSwipe      — swipe desde un borde concreto (top/bottom/left/right)
//
// Cada gesto puede tener su propio umbral, duración y sensibilidad.
// Se puede cancelar y hay soporte para gestos simultáneos.
//
// API:
//   <GestureHandler
//     onTap={fn} onDoubleTap={fn} onLongPress={fn}
//     onSwipe={fn} onSwipeUp={fn} onSwipeLeft={fn}
//     onPan={fn} onPanEnd={fn}
//     onPinch={fn} onRotate={fn}
//     onEdgeSwipe={fn}
//     longPressDelay={500}
//     swipeThreshold={50}
//     panThreshold={6}
//     edge="top" edgeSize={30}
//   >
//     {children}
//   </GestureHandler>
//
// Hook subyacente: useGesture(ref, options) → estado del gesto en curso.
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes / defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  longPressDelay: 520,
  doubleTapDelay: 300,
  tapMaxDuration: 250,
  tapMaxMovement: 8,
  swipeThreshold: 50,        // px de desplazamiento
  swipeMinVelocity: 0.4,     // px/ms
  panThreshold: 6,           // px para empezar a considerar pan
  panMomentum: 0.92,         // factor de inercia tras soltar
  edgeSize: 30,              // px desde el borde para edge gestures
  pinchMinScale: 0.1,
  pinchMaxScale: 10,
  rotateMinAngle: 3,         // grados para empezar a emitir rotate
  allowSimultaneous: false,  // permitir pinch+rotate a la vez
};

/** Direcciones de swipe. */
export const SWIPE = {
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
};

/** Bordes para edgeSwipe. */
export const EDGE = {
  TOP: 'top',
  BOTTOM: 'bottom',
  LEFT: 'left',
  RIGHT: 'right',
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function angleBetween(x1, y1, x2, y2) {
  return Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Determina la dirección dominante de un vector. */
function dominantDirection(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? SWIPE.RIGHT : SWIPE.LEFT;
  }
  return dy > 0 ? SWIPE.DOWN : SWIPE.UP;
}

/** Comprueba si un punto está en un borde del rect. */
function pointInEdge(x, y, rect, edge, size) {
  if (!rect) return false;
  const { left, right, top, bottom, width, height } = rect;
  const localX = x - left;
  const localY = y - top;
  switch (edge) {
    case EDGE.TOP:    return localY <= size && localX >= 0 && localX <= width;
    case EDGE.BOTTOM: return localY >= height - size && localX >= 0 && localX <= width;
    case EDGE.LEFT:   return localX <= size && localY >= 0 && localY <= height;
    case EDGE.RIGHT:  return localX >= width - size && localY >= 0 && localY <= height;
    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useGesture
// Reconocedor de gestos sobre un elemento. Devuelve handlers y estado.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {number}  [options.longPressDelay=520]
 * @param {number}  [options.doubleTapDelay=300]
 * @param {number}  [options.tapMaxDuration=250]
 * @param {number}  [options.tapMaxMovement=8]
 * @param {number}  [options.swipeThreshold=50]
 * @param {number}  [options.swipeMinVelocity=0.4]
 * @param {number}  [options.panThreshold=6]
 * @param {number}  [options.edgeSize=30]
 * @param {string}  [options.edge]                borde para edgeSwipe
 * @param {boolean} [options.disabled=false]
 * @param {boolean} [options.preventDefault=true] evita scroll por defecto
 * @param {Function} [options.onTap]
 * @param {Function} [options.onDoubleTap]
 * @param {Function} [options.onLongPress]
 * @param {Function} [options.onLongPressStart]
 * @param {Function} [options.onLongPressEnd]
 * @param {Function} [options.onSwipe]            recibe {direction, dx, dy, velocity}
 * @param {Function} [options.onSwipeUp]
 * @param {Function} [options.onSwipeDown]
 * @param {Function} [options.onSwipeLeft]
 * @param {Function} [options.onSwipeRight]
 * @param {Function} [options.onPan]              recibe {dx, dy, x, y}
 * @param {Function} [options.onPanStart]
 * @param {Function} [options.onPanEnd]
 * @param {Function} [options.onPinch]            recibe {scale, delta}
 * @param {Function} [options.onRotate]           recibe {angle, delta}
 * @param {Function} [options.onEdgeSwipe]        recibe {edge, dx, dy}
 * @returns {{ bind: Object, state: Object, reset: Function }}
 */
export function useGesture(options = {}) {
  const opts = useMemo(() => ({ ...DEFAULTS, ...options }), [options]);
  const {
    longPressDelay,
    doubleTapDelay,
    tapMaxDuration,
    tapMaxMovement,
    swipeThreshold,
    swipeMinVelocity,
    panThreshold,
    edgeSize,
    edge,
    disabled,
    preventDefault: preventDefaultOpt,
    onTap,
    onDoubleTap,
    onLongPress,
    onLongPressStart,
    onLongPressEnd,
    onSwipe,
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
    onPan,
    onPanStart,
    onPanEnd,
    onPinch,
    onRotate,
    onEdgeSwipe,
  } = opts;

  // Estado del gesto en curso (no dispara renders)
  const state = useRef({
    // pointer primario
    startX: 0, startY: 0, startT: 0,
    lastX: 0, lastY: 0,
    moved: false,
    // long-press
    longPressTimer: null,
    longPressActive: false,
    // doble tap
    lastTapT: 0,
    // pan
    panActive: false,
    // multi-touch
    pointers: new Map(),
    initialPinchDist: 0,
    initialAngle: 0,
    pinchActive: false,
    rotateActive: false,
    // edge
    edgeDetected: null,
  }).current;

  const [publicState, setPublicState] = useState({
    active: false,
    type: null,
    dx: 0, dy: 0,
  });

  const clearLongPress = useCallback(() => {
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
  }, [state]);

  const reset = useCallback(() => {
    clearLongPress();
    state.moved = false;
    state.longPressActive = false;
    state.panActive = false;
    state.pinchActive = false;
    state.rotateActive = false;
    state.edgeDetected = null;
    state.pointers.clear();
    setPublicState({ active: false, type: null, dx: 0, dy: 0 });
  }, [clearLongPress, state]);

  // ── PointerDown ───────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (disabled) return;
    // Guardar pointer
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // En multi-touch, gestionar pinch/rotate
    if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      state.initialPinchDist = distance(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      state.initialAngle = angleBetween(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      state.pinchActive = true;
      state.rotateActive = true;
      clearLongPress();
      return;
    }
    if (state.pointers.size > 2) return;

    // Single touch
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.startT = performance.now();
    state.moved = false;
    state.longPressActive = false;
    state.panActive = false;

    // Edge detection
    if (edge) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (pointInEdge(e.clientX, e.clientY, rect, edge, edgeSize)) {
        state.edgeDetected = edge;
      } else {
        state.edgeDetected = null;
      }
    }

    // Long press timer
    if (onLongPress || onLongPressStart || onLongPressEnd) {
      state.longPressTimer = setTimeout(() => {
        state.longPressActive = true;
        haptic('heavy');
        onLongPressStart?.({ x: state.startX, y: state.startY, event: e });
        onLongPress?.({ x: state.startX, y: state.startY, event: e });
        setPublicState({ active: true, type: 'longPress', dx: 0, dy: 0 });
      }, longPressDelay);
    }

    // Capturar para recibir eventos fuera del elemento
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }, [
    disabled, edge, edgeSize, longPressDelay,
    onLongPress, onLongPressStart, onLongPressEnd,
    state, clearLongPress,
  ]);

  // ── PointerMove ───────────────────────────────────────────────────────────
  const onPointerMove = useCallback((e) => {
    if (disabled) return;
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // ── Pinch / Rotate (2 dedos) ─────────────────────────────────────────
    if (state.pointers.size === 2 && (state.pinchActive || state.rotateActive)) {
      const pts = Array.from(state.pointers.values());
      const dist = distance(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      const angle = angleBetween(pts[0].x, pts[0].y, pts[1].x, pts[1].y);

      if (state.pinchActive && state.initialPinchDist > 0) {
        const scale = clamp(
          dist / state.initialPinchDist,
          DEFAULTS.pinchMinScale,
          DEFAULTS.pinchMaxScale
        );
        onPinch?.({ scale, delta: scale - 1 });
        setPublicState({ active: true, type: 'pinch', dx: 0, dy: 0 });
      }
      if (state.rotateActive) {
        let delta = angle - state.initialAngle;
        // normalizar a [-180, 180]
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        if (Math.abs(delta) >= DEFAULTS.rotateMinAngle) {
          onRotate?.({ angle, delta });
          setPublicState({ active: true, type: 'rotate', dx: 0, dy: 0 });
        }
      }
      return;
    }

    // ── Single touch ─────────────────────────────────────────────────────
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    const dist = Math.hypot(dx, dy);

    // Cancelar long-press si se mueve
    if (dist > tapMaxMovement && !state.moved) {
      state.moved = true;
      clearLongPress();
      if (state.longPressActive) {
        state.longPressActive = false;
        onLongPressEnd?.({ x: e.clientX, y: e.clientY });
      }
    }

    // Pan
    if (dist > panThreshold) {
      if (!state.panActive) {
        state.panActive = true;
        onPanStart?.({ x: e.clientX, y: e.clientY, dx, dy });
      }
      onPan?.({ dx, dy, x: e.clientX, y: e.clientY });
      setPublicState({ active: true, type: 'pan', dx, dy });
    }

    // Edge swipe en curso
    if (state.edgeDetected) {
      onEdgeSwipe?.({
        edge: state.edgeDetected,
        dx, dy,
        x: e.clientX, y: e.clientY,
        phase: 'move',
      });
    }

    state.lastX = e.clientX;
    state.lastY = e.clientY;

    if (preventDefaultOpt !== false) {
      // No llamamos e.preventDefault() porque los pointer events no lo permiten
      // sin touch-action: none. Se gestiona vía CSS en el componente.
    }
  }, [
    disabled, tapMaxMovement, panThreshold,
    onPanStart, onPan, onLongPressEnd,
    onEdgeSwipe, onPinch, onRotate,
    preventDefaultOpt, state, clearLongPress,
  ]);

  // ── PointerUp ─────────────────────────────────────────────────────────────
  const onPointerUp = useCallback((e) => {
    if (disabled) return;
    const wasPresent = state.pointers.delete(e.pointerId);
    if (!wasPresent) return;

    // ── Pinch / Rotate terminan ──────────────────────────────────────────
    if (state.pointers.size < 2) {
      state.pinchActive = false;
      state.rotateActive = false;
      state.initialPinchDist = 0;
      state.initialAngle = 0;
    }

    // ── Gestión single touch ─────────────────────────────────────────────
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    const dt = Math.max(1, performance.now() - state.startT);
    const dist = Math.hypot(dx, dy);
    const velocity = dist / dt;

    // Long-press terminó
    if (state.longPressActive) {
      state.longPressActive = false;
      onLongPressEnd?.({ x: e.clientX, y: e.clientY });
      reset();
      return;
    }

    // Pan terminó
    if (state.panActive) {
      onPanEnd?.({ dx, dy, x: e.clientX, y: e.clientY, velocity });
      reset();
      return;
    }

    // Edge swipe terminó
    if (state.edgeDetected) {
      onEdgeSwipe?.({
        edge: state.edgeDetected,
        dx, dy,
        x: e.clientX, y: e.clientY,
        phase: 'end',
      });
      reset();
      return;
    }

    // Swipe
    if (
      (dist > swipeThreshold || velocity > swipeMinVelocity) &&
      dt < 800
    ) {
      const direction = dominantDirection(dx, dy);
      const payload = { direction, dx, dy, velocity };
      onSwipe?.(payload);
      if (direction === SWIPE.UP) onSwipeUp?.(payload);
      if (direction === SWIPE.DOWN) onSwipeDown?.(payload);
      if (direction === SWIPE.LEFT) onSwipeLeft?.(payload);
      if (direction === SWIPE.RIGHT) onSwipeRight?.(payload);
      reset();
      return;
    }

    // Tap (sin movimiento y corto)
    if (dist < tapMaxMovement && dt < tapMaxDuration + 100) {
      const now = performance.now();
      if (onDoubleTap && now - state.lastTapT < doubleTapDelay) {
        state.lastTapT = 0;
        haptic('light');
        onDoubleTap?.({ x: e.clientX, y: e.clientY });
      } else {
        state.lastTapT = now;
        if (onTap) {
          haptic('light');
          onTap?.({ x: e.clientX, y: e.clientY });
        }
      }
      reset();
      return;
    }

    reset();
  }, [
    disabled, swipeThreshold, swipeMinVelocity, tapMaxMovement,
    tapMaxDuration, doubleTapDelay,
    onPanEnd, onLongPressEnd, onEdgeSwipe,
    onSwipe, onSwipeUp, onSwipeDown, onSwipeLeft, onSwipeRight,
    onTap, onDoubleTap,
    state, reset,
  ]);

  const onPointerCancel = useCallback((e) => {
    state.pointers.delete(e.pointerId);
    reset();
  }, [reset, state]);

  // Limpieza
  useEffect(() => () => reset(), [reset]);

  // ── bind ─────────────────────────────────────────────────────────────
  const bind = useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel]
  );

  return { bind, state: publicState, reset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto para propagar la config global de gestos
// ─────────────────────────────────────────────────────────────────────────────

const GestureContext = createContext({ defaults: DEFAULTS });
export const useGestureDefaults = () => useContext(GestureContext).defaults;

/** Provider opcional para cambiar los defaults de todos los GestureHandler. */
export function GestureProvider({ children, defaults = {} }) {
  const value = useMemo(() => ({ defaults: { ...DEFAULTS, ...defaults } }), [defaults]);
  return <GestureContext.Provider value={value}>{children}</GestureContext.Provider>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GestureHandler
 *
 * Envuelve children con reconocimiento de gestos. Pasa cualquier prop de la API
 * de `useGesture` (ver arriba) directamente.
 *
 * @param {Object} props
 * @param {string} [props.as='div']         Tag HTML
 * @param {string} [props.className]
 * @param {Object} [props.style]
 * @param {boolean} [props.block=false]     Si true, aplica touch-action none
 * @param {React.ReactNode} props.children
 */
export default function GestureHandler({
  as: Tag = 'div',
  className,
  style,
  block = false,
  children,
  ...gestureOptions
}) {
  const { bind, state } = useGesture(gestureOptions);
  const {
    onTap, onDoubleTap, onLongPress, onSwipe, onPan, onPinch, onRotate,
    onSwipeUp, onSwipeDown, onSwipeLeft, onSwipeRight,
    onPanStart, onPanEnd, onLongPressStart, onLongPressEnd,
    onEdgeSwipe, edge, disabled, preventDefault,
    longPressDelay, doubleTapDelay, tapMaxDuration, tapMaxMovement,
    swipeThreshold, swipeMinVelocity, panThreshold, panMomentum,
    edgeSize, pinchMinScale, pinchMaxScale, rotateMinAngle, allowSimultaneous,
    ...restProps
  } = gestureOptions;

  return (
    <Tag
      {...restProps}
      {...bind}
      className={className}
      style={{
        // Por defecto dejamos touch-action para que los gestos horizontales
        // funcionen sin bloquear el scroll vertical. `block` lo desactiva todo.
        touchAction: block ? 'none' : 'pan-y',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        ...style,
      }}
      data-gesture-active={state.active ? state.type : undefined}
    >
      {children}
    </Tag>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes especializados
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Swipeable — wrapper para tarjetas con swipe horizontal.
 * Llama a onSwipeLeft / onSwipeRight sin que tengas que gestionar umbrales.
 */
export function Swipeable({
  onSwipeLeft,
  onSwipeRight,
  threshold = 60,
  children,
  style,
  ...rest
}) {
  const [dx, setDx] = useState(0);
  return (
    <GestureHandler
      onPan={({ dx: d }) => setDx(d)}
      onPanEnd={({ dx: d, velocity }) => {
        if (d > threshold && onSwipeRight) onSwipeRight({ dx: d, velocity });
        else if (d < -threshold && onSwipeLeft) onSwipeLeft({ dx: d, velocity });
        setDx(0);
      }}
      style={{ ...style }}
      {...rest}
    >
      <div style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 280ms cubic-bezier(.22,1,.36,1)' : 'none' }}>
        {children}
      </div>
    </GestureHandler>
  );
}

/**
 * SwipeToDismiss — envuelve un elemento y lo descarta al hacer swipe.
 * @param {'left'|'right'|'both'} direction
 */
export function SwipeToDismiss({
  direction = 'both',
  threshold = 90,
  onDismiss,
  dismissDistance = 400,
  children,
  style,
  ...rest
}) {
  const [dx, setDx] = useState(0);
  const [dismissing, setDismissing] = useState(false);

  const allowLeft = direction === 'left' || direction === 'both';
  const allowRight = direction === 'right' || direction === 'both';

  const finish = useCallback((dir) => {
    setDismissing(true);
    setDx(dir === 'left' ? -dismissDistance : dismissDistance);
    haptic('medium');
    setTimeout(() => onDismiss?.(dir), 260);
  }, [dismissDistance, onDismiss]);

  return (
    <GestureHandler
      onPan={({ dx: d }) => {
        if (d > 0 && !allowRight) return;
        if (d < 0 && !allowLeft) return;
        setDx(d);
      }}
      onPanEnd={({ dx: d }) => {
        if (allowRight && d > threshold) finish('right');
        else if (allowLeft && d < -threshold) finish('left');
        else setDx(0);
      }}
      style={style}
      {...rest}
    >
      <div
        style={{
          transform: `translateX(${dx}px)`,
          opacity: dismissing ? 0 : 1,
          transition: dx === 0 || dismissing
            ? 'transform 280ms cubic-bezier(.22,1,.36,1), opacity 260ms ease'
            : 'none',
        }}
      >
        {children}
      </div>
    </GestureHandler>
  );
}

/**
 * EdgeGesture — zona sensible cerca de un borde de la pantalla.
 * Se usa para el sistema (control center, notification center, home).
 */
export function EdgeGesture({
  edge,
  size = 24,
  onStart,
  onMove,
  onEnd,
  style,
  ...rest
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      {...rest}
      style={{
        position: 'absolute',
        zIndex: 950,
        ...(edge === 'top'    ? { top: 0,    left: 0, right: 0, height: size } : null),
        ...(edge === 'bottom' ? { bottom: 0, left: 0, right: 0, height: size } : null),
        ...(edge === 'left'   ? { top: 0, bottom: 0, left: 0, width: size } : null),
        ...(edge === 'right'  ? { top: 0, bottom: 0, right: 0, width: size } : null),
        touchAction: 'none',
        ...style,
      }}
    >
      <GestureHandler
        edge={edge}
        edgeSize={size}
        onEdgeSwipe={({ dx, dy, phase }) => {
          if (phase === 'move') {
            if (!active) { setActive(true); onStart?.({ edge, dx, dy }); }
            onMove?.({ edge, dx, dy });
          } else if (phase === 'end') {
            setActive(false);
            onEnd?.({ edge, dx, dy });
          }
        }}
        onPanStart={() => onStart?.({ edge })}
        onPan={({ dx, dy }) => onMove?.({ edge, dx, dy })}
        onPanEnd={({ dx, dy }) => onEnd?.({ edge, dx, dy })}
      >
        <div style={{ width: '100%', height: '100%' }} />
      </GestureHandler>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes de conveniencia: TapHandler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TapHandler — solo tap + long-press. Útil cuando no quieres pan ni swipe.
 */
export function TapHandler({
  onTap,
  onLongPress,
  children,
  style,
  ...rest
}) {
  return (
    <GestureHandler
      onTap={onTap}
      onLongPress={onLongPress}
      block={false}
      style={style}
      {...rest}
    >
      {children}
    </GestureHandler>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes de conveniencia: PinchZoom
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PinchZoom — wrapper para contenido zoomable con pinch.
 * Mantiene escala y rotación internamente.
 */
export function PinchZoom({
  min = 0.5,
  max = 4,
  onScaleChange,
  onRotateChange,
  doubleTapScale = 2,
  children,
  style,
  ...rest
}) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => { onScaleChange?.(scale); }, [scale, onScaleChange]);
  useEffect(() => { onRotateChange?.(rotation); }, [rotation, onRotateChange]);

  return (
    <GestureHandler
      block
      onPinch={({ scale: s }) => setScale(clamp(s, min, max))}
      onRotate={({ delta }) => setRotation((r) => r + delta * 0.5)}
      onDoubleTap={() => setScale((s) => (s > 1 ? 1 : doubleTapScale))}
      style={style}
      {...rest}
    >
      <div
        style={{
          transform: `scale(${scale}) rotate(${rotation}deg)`,
          transition: 'transform 200ms cubic-bezier(.22,1,.36,1)',
          transformOrigin: 'center center',
        }}
      >
        {children}
      </div>
    </GestureHandler>
  );
}
