// src/ui/Toast.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Toast
//
// Sistema de notificaciones efímeras (banners) al estilo iOS:
//   • 5 tipos: success, error, info, warning, loading.
//   • 4 posiciones: top, bottom, center, o dentro de un contenedor.
//   • Cola: si llegan varios a la vez, se apilan sin pisarse.
//   • Duración configurable por toast; loading no auto-cierra.
//   • Swipe up/down para descartar manualmente.
//   • Acción opcional (botón "Deshacer", "Ver", etc.).
//   • Icono por tipo con color iOS.
//   • Blur + borde 0.5px + sombra de elevación.
//   • Animaciones de entrada/salida con curva iOS.
//   • API imperativa global: toast.success('Guardado'), toast.error(...), etc.
//
// Uso declarativo:
//   <ToastProvider>
//     <App />
//   </ToastProvider>
//
//   // En cualquier componente:
//   const toast = useToast();
//   toast.success('Guardado');
//
// Uso imperativo (fuera de React):
//   import { toast } from './Toast.jsx';
//   toast.success('Guardado');
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
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const POSITION = {
  TOP: 'top',
  BOTTOM: 'bottom',
  CENTER: 'center',
};

const TYPES = {
  SUCCESS: 'success',
  ERROR: 'error',
  INFO: 'info',
  WARNING: 'warning',
  LOADING: 'loading',
};

const TYPE_META = {
  [TYPES.SUCCESS]: { color: '#34c759', icon: 'success' },
  [TYPES.ERROR]:   { color: '#ff3b30', icon: 'error' },
  [TYPES.INFO]:    { color: '#0a84ff', icon: 'info' },
  [TYPES.WARNING]: { color: '#ff9500', icon: 'warning' },
  [TYPES.LOADING]: { color: '#8e8e93', icon: 'loading' },
};

const DEFAULT_DURATION = 2600;
const SPRING = 'cubic-bezier(.22,1,.36,1)';
const SWIPE_DISMISS_THRESHOLD = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

let _idCounter = 0;
function nextId() {
  _idCounter += 1;
  return `toast-${Date.now()}-${_idCounter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store global (para uso imperativo fuera de React)
// ─────────────────────────────────────────────────────────────────────────────

const globalStore = {
  listeners: new Set(),
  toasts: [],
  nextId,
  add(toast) {
    this.toasts = [...this.toasts, toast];
    this.emit();
    return toast.id;
  },
  remove(id) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  },
  update(id, patch) {
    this.toasts = this.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.emit();
  },
  clear() {
    this.toasts = [];
    this.emit();
  },
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.toasts);
    return () => this.listeners.delete(fn);
  },
  emit() {
    for (const fn of this.listeners) fn(this.toasts);
  },
};

/**
 * API imperativa global. Funciona incluso fuera de un componente React,
 * siempre que <ToastProvider> esté montado en algún lugar del árbol.
 */
export const toast = {
  show(options) {
    if (typeof options === 'string') {
      options = { message: options };
    }
    const {
      type = TYPES.INFO,
      message,
      title,
      duration = DEFAULT_DURATION,
      position = POSITION.TOP,
      action,
      icon,
    } = options;

    const id = nextId();
    const payload = {
      id,
      type,
      message,
      title,
      duration: type === TYPES.LOADING ? 0 : duration,
      position,
      action,
      icon,
      createdAt: Date.now(),
    };
    globalStore.add(payload);
    haptic(type === TYPES.ERROR ? 'heavy' : 'light');
    return id;
  },
  success(message, options = {}) {
    return this.show({ ...options, type: TYPES.SUCCESS, message });
  },
  error(message, options = {}) {
    return this.show({ ...options, type: TYPES.ERROR, message });
  },
  info(message, options = {}) {
    return this.show({ ...options, type: TYPES.INFO, message });
  },
  warning(message, options = {}) {
    return this.show({ ...options, type: TYPES.WARNING, message });
  },
  loading(message, options = {}) {
    return this.show({ ...options, type: TYPES.LOADING, message, duration: 0 });
  },
  /** Actualiza un toast existente (p.ej. loading → success). */
  update(id, options = {}) {
    globalStore.update(id, options);
  },
  /** Cierra un toast. */
  dismiss(id) {
    globalStore.remove(id);
  },
  /** Cierra todos. */
  clear() {
    globalStore.clear();
  },
  /** Atajo: loading → success. */
  resolve(id, message, options = {}) {
    this.update(id, { type: TYPES.SUCCESS, message, duration: options.duration ?? DEFAULT_DURATION });
  },
  /** Atajo: loading → error. */
  reject(id, message, options = {}) {
    this.update(id, { type: TYPES.ERROR, message, duration: options.duration ?? DEFAULT_DURATION });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG
// ─────────────────────────────────────────────────────────────────────────────

function ToastIcon({ type, size = 18, color }) {
  if (type === TYPES.SUCCESS) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" fill={color} />
        <path d="M7 12 L10.5 15.5 L17 9" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === TYPES.ERROR) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" fill={color} />
        <path d="M8 8 L16 16 M16 8 L8 16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === TYPES.WARNING) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M12 3 L22 20 H2 Z" fill={color} />
        <path d="M12 9 V14 M12 17 V17.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === TYPES.LOADING) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'toast-spin 0.9s linear infinite' }}>
        <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.2)" strokeWidth="2.5" fill="none" />
        <path d="M12 3 a9 9 0 0 1 9 9" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  // INFO por defecto
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill={color} />
      <path d="M12 8 V8.5 M11 11 h1 v6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast individual
// ─────────────────────────────────────────────────────────────────────────────

function ToastItem({ item, index, total, onDismiss, position }) {
  const [phase, setPhase] = useState('closed'); // closed | opening | open | closing
  const [drag, setDrag] = useState({ y: 0, dragging: false });
  const dragStart = useRef(null);
  const dismissTimer = useRef(null);

  const meta = TYPE_META[item.type] || TYPE_META[TYPES.INFO];

  // ── Apertura ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  // ── Auto-cierre ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (item.duration <= 0) return;
    if (phase !== 'open') return;
    dismissTimer.current = setTimeout(() => {
      close();
    }, item.duration);
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, item.duration, item.id]);

  const close = useCallback(() => {
    if (phase === 'closing') return;
    setPhase('closing');
    haptic('light');
    setTimeout(() => onDismiss?.(item.id), 260);
  }, [phase, onDismiss, item.id]);

  // ── Drag para descartar ───────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (e.target.closest('[data-toast-action]')) return;
    dragStart.current = { y: e.clientY };
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    // Solo permitir en la dirección de salida
    const allowed = position === POSITION.TOP ? Math.min(0, dy) : Math.max(0, dy);
    setDrag({ y: allowed, dragging: true });
  }, [position]);

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    dragStart.current = null;
    const dy = drag.y;
    if (Math.abs(dy) > SWIPE_DISMISS_THRESHOLD) {
      close();
    }
    setDrag({ y: 0, dragging: false });
  }, [drag.y, close]);

  // ── Transform según phase ─────────────────────────────────────────────────
  const transform = useMemo(() => {
    const sign = position === POSITION.TOP ? -1 : 1;
    const closedOffset = sign * 90;
    if (phase === 'closed' || phase === 'opening') {
      return {
        transform: `translateY(${closedOffset}px)`,
        opacity: 0,
        scale: 0.9,
      };
    }
    if (phase === 'closing') {
      return {
        transform: `translateY(${closedOffset + drag.y}px)`,
        opacity: 0,
        scale: 0.92,
      };
    }
    // open
    if (drag.dragging) {
      const p = Math.min(1, Math.abs(drag.y) / 200);
      return {
        transform: `translateY(${drag.y}px)`,
        opacity: 1 - p * 0.7,
        scale: 1 - p * 0.08,
      };
    }
    return { transform: 'translateY(0)', opacity: 1, scale: 1 };
  }, [phase, position, drag]);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => {
        if (e.target.closest('[data-toast-action]')) return;
        if (item.type === TYPES.LOADING) return;
        close();
      }}
      style={{
        pointerEvents: 'auto',
        minWidth: 260,
        maxWidth: 380,
        borderRadius: 22,
        background: 'rgba(40,40,45,0.86)',
        backdropFilter: 'blur(34px) saturate(180%)',
        WebkitBackdropFilter: 'blur(34px) saturate(180%)',
        border: '0.5px solid rgba(255,255,255,0.12)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        color: '#fff',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        transform: `${transform.transform} scale(${transform.scale})`,
        opacity: transform.opacity,
        transition: drag.dragging
          ? 'none'
          : `transform 380ms ${SPRING}, opacity 260ms ease`,
        willChange: 'transform, opacity',
        cursor: item.type === TYPES.LOADING ? 'default' : 'pointer',
        userSelect: 'none',
        touchAction: 'none',
        marginBottom: 8,
      }}
    >
      <ToastIcon type={item.type} color={meta.color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {item.title && (
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
            {item.title}
          </div>
        )}
        <div
          style={{
            fontSize: item.title ? 12 : 14,
            fontWeight: item.title ? 400 : 500,
            lineHeight: 1.35,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: item.title ? 'normal' : 'nowrap',
          }}
        >
          {item.message}
        </div>
      </div>
      {item.action && (
        <button
          data-toast-action
          onClick={(e) => {
            e.stopPropagation();
            haptic('light');
            item.action.onPress?.(item.id);
            close();
          }}
          style={{
            background: 'rgba(255,255,255,0.18)',
            border: 'none',
            borderRadius: 14,
            padding: '6px 12px',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {item.action.label || 'Ver'}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contenedor de toasts por posición
// ─────────────────────────────────────────────────────────────────────────────

function ToastContainer({ position, toasts, onDismiss }) {
  const style = useMemo(() => {
    const base = {
      position: 'absolute',
      left: 0,
      right: 0,
      zIndex: 1500,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      pointerEvents: 'none',
      padding: '0 16px',
    };
    if (position === POSITION.TOP) return { ...base, top: 70 };
    if (position === POSITION.BOTTOM) return { ...base, bottom: 40, flexDirection: 'column-reverse' };
    return { ...base, top: '50%', transform: 'translateY(-50%)' };
  }, [position]);

  if (toasts.length === 0) return null;

  return (
    <div style={style}>
      {toasts.map((t, i) => (
        <ToastItem
          key={t.id}
          item={t}
          index={i}
          total={toasts.length}
          position={position}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

const ToastContext = createContext(null);

/**
 * ToastProvider — monta el sistema de toasts. Coloca los contenedores según
 * las posiciones usadas. Los toasts se renderizan sobre el resto de la UI.
 */
export function ToastProvider({ children, containerStyle }) {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const unsub = globalStore.subscribe((list) => setToasts(list));
    return () => unsub();
  }, []);

  const handleDismiss = useCallback((id) => {
    globalStore.remove(id);
  }, []);

  // Agrupar por posición
  const byPosition = useMemo(() => {
    const groups = { top: [], bottom: [], center: [] };
    for (const t of toasts) {
      const p = t.position || POSITION.TOP;
      if (groups[p]) groups[p].push(t);
      else groups.top.push(t);
    }
    return groups;
  }, [toasts]);

  const api = useMemo(
    () => ({
      show: (opts) => toast.show(opts),
      success: (msg, opts) => toast.success(msg, opts),
      error: (msg, opts) => toast.error(msg, opts),
      info: (msg, opts) => toast.info(msg, opts),
      warning: (msg, opts) => toast.warning(msg, opts),
      loading: (msg, opts) => toast.loading(msg, opts),
      update: (id, opts) => toast.update(id, opts),
      dismiss: (id) => toast.dismiss(id),
      clear: () => toast.clear(),
      resolve: (id, msg, opts) => toast.resolve(id, msg, opts),
      reject: (id, msg, opts) => toast.reject(id, msg, opts),
    }),
    []
  );

  return (
    <ToastContext.Provider value={api}>
      <style>{`
        @keyframes toast-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {children}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 1500,
          ...containerStyle,
        }}
      >
        {byPosition.top.length > 0 && (
          <ToastContainer position={POSITION.TOP} toasts={byPosition.top} onDismiss={handleDismiss} />
        )}
        {byPosition.center.length > 0 && (
          <ToastContainer position={POSITION.CENTER} toasts={byPosition.center} onDismiss={handleDismiss} />
        )}
        {byPosition.bottom.length > 0 && (
          <ToastContainer position={POSITION.BOTTOM} toasts={byPosition.bottom} onDismiss={handleDismiss} />
        )}
      </div>
    </ToastContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useToast — devuelve la API del sistema de toasts.
 * @returns {{ show, success, error, info, warning, loading, update, dismiss, clear, resolve, reject }}
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback: usar el store global directamente aunque no haya Provider
    return {
      show: (opts) => toast.show(opts),
      success: (msg, opts) => toast.success(msg, opts),
      error: (msg, opts) => toast.error(msg, opts),
      info: (msg, opts) => toast.info(msg, opts),
      warning: (msg, opts) => toast.warning(msg, opts),
      loading: (msg, opts) => toast.loading(msg, opts),
      update: (id, opts) => toast.update(id, opts),
      dismiss: (id) => toast.dismiss(id),
      clear: () => toast.clear(),
      resolve: (id, msg, opts) => toast.resolve(id, msg, opts),
      reject: (id, msg, opts) => toast.reject(id, msg, opts),
    };
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers específicos (integración con el OS)
// ─────────────────────────────────────────────────────────────────────────────

/** Muestra un toast al guardar correctamente (uso recurrente). */
export function toastSaved(message = 'Guardado') {
  return toast.success(message);
}

/** Toast de error de red. */
export function toastNetworkError(message = 'Sin conexión') {
  return toast.error(message);
}

/** Toast de instalación con progreso. Devuelve el id para actualizarlo. */
export function toastInstall(name) {
  return toast.loading(`Instalando ${name}…`);
}

/** Convierte un toast de instalación en éxito. */
export function toastInstallSuccess(id, name) {
  return toast.resolve(id, `${name} instalado`);
}

/** Convierte un toast de instalación en error. */
export function toastInstallError(id, name, error) {
  return toast.reject(id, `No se pudo instalar ${name}${error ? `: ${error}` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export default combinado (por si se quiere importar todo)
// ─────────────────────────────────────────────────────────────────────────────

export default {
  Provider: ToastProvider,
  useToast,
  toast,
  POSITION,
  TYPES,
  ToastProvider,
};
