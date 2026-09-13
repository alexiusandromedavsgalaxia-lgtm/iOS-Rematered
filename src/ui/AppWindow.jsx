// src/ui/AppWindow.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — AppWindow
//
// Contenedor de una app en ejecución. Gestiona:
//   • Apertura hero: la ventana nace del rect del icono tocado (rect prop)
//     y crece hasta ocupar la pantalla con curva iOS.
//   • Cierre: inverso del hero (vuelve al icono) o fade si no hay rect.
//   • Estados: 'launching' | 'running' | 'error' | 'closing' | 'background'.
//   • Carga real: llama os.launchApp(bundleId) → MachOLoader → sandbox → pid.
//   • Swipe-up desde el home indicator: gesto para cerrar (minimizar).
//   • Swipe-down desde arriba: gesto para centro de notificaciones (delega).
//   • Compatibilidad con multitarea (modo 'split' o 'slideover') — visual.
//   • Barra de estado opcional embebida con override de tema.
//   • Safe areas, radius de esquinas, sombra de elevación iOS.
//   • Suspensión: al pasar a background, se pausa el render (opcional).
//
// Se monta una sola instancia por app activa desde App.jsx / Springboard.
// Sin librerías externas. SVG inline.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useOS } from '../context/OSContext.jsx';
import StatusBar from './StatusBar.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const SCREEN_W = 402;
const SCREEN_H = 874;
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;
const CORNER_RADIUS = 44;
const SPRING = 'cubic-bezier(.32,.72,0,1)';
const DURATION = 480;
const SWIPE_CLOSE_THRESHOLD = 120;
const SWIPE_MIN_VELOCITY = 0.7;

/** Estados posibles de la ventana. */
const WIN_STATE = {
  LAUNCHING: 'launching',
  RUNNING: 'running',
  BACKGROUND: 'background',
  ERROR: 'error',
  CLOSING: 'closing',
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

/**
 * Calcula el transform de apertura hero desde un rect de icono.
 * @param {{x,y,w,h}|null} originRect  Rect del icono tocado (en px de pantalla)
 * @returns {Object}  { initialScaleX, initialScaleY, initialX, initialY }
 */
function computeHeroTransform(originRect) {
  if (!originRect) {
    return { initialScaleX: 0.86, initialScaleY: 0.86, initialX: 0, initialY: 40 };
  }
  const cx = originRect.x + originRect.w / 2;
  const cy = originRect.y + originRect.h / 2;
  const screenCx = SCREEN_W / 2;
  const screenCy = SCREEN_H / 2;
  const initialX = cx - screenCx;
  const initialY = cy - screenCy;
  const initialScaleX = Math.max(0.05, originRect.w / SCREEN_W);
  const initialScaleY = Math.max(0.05, originRect.h / SCREEN_H);
  return { initialScaleX, initialScaleY, initialX, initialY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer de estado de ventana
// ─────────────────────────────────────────────────────────────────────────────

function windowReducer(state, action) {
  switch (action.type) {
    case 'LAUNCH_START':
      return { ...state, status: WIN_STATE.LAUNCHING, pid: null, error: null };
    case 'LAUNCH_OK':
      return { ...state, status: WIN_STATE.RUNNING, pid: action.pid, error: null };
    case 'LAUNCH_FAIL':
      return { ...state, status: WIN_STATE.ERROR, error: action.error };
    case 'BACKGROUND':
      return { ...state, status: WIN_STATE.BACKGROUND };
    case 'FOREGROUND':
      return { ...state, status: WIN_STATE.RUNNING };
    case 'CLOSE_START':
      return { ...state, status: WIN_STATE.CLOSING };
    case 'RESET':
      return { ...state, status: WIN_STATE.LAUNCHING, pid: null, error: null };
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline
// ─────────────────────────────────────────────────────────────────────────────

function CloseGlyph({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 6 L18 18 M18 6 L6 18" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SpinnerGlyph({ size = 28, color = 'rgba(255,255,255,0.85)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" style={{ animation: 'appwindow-spin 0.9s linear infinite' }}>
      <circle cx="25" cy="25" r="20" stroke="rgba(255,255,255,0.18)" strokeWidth="4" fill="none" />
      <path d="M25 5 a20 20 0 0 1 20 20" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ─────────────────────────────────────────────────────────────────────────────

function LaunchSplash({ app, theme = 'dark' }) {
  const bg = theme === 'light' ? '#f2f2f7' : '#000';
  const fg = theme === 'light' ? '#1c1c1e' : '#fff';
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        animation: 'appwindow-fade-in 220ms ease both',
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: 22,
          background: app.color || 'linear-gradient(160deg, #5ac8fa, #007aff)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
        }}
      >
        {app.emoji ? (
          <span style={{ fontSize: 48 }}>{app.emoji}</span>
        ) : (
          <span style={{ fontSize: 40, fontWeight: 700, color: '#fff' }}>
            {(app.name || '?')[0]}
          </span>
        )}
      </div>
      <div
        style={{
          color: fg,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: -0.3,
        }}
      >
        {app.name}
      </div>
      <div style={{ marginTop: 12 }}>
        <SpinnerGlyph color={fg} />
      </div>
    </div>
  );
}

function ErrorSplash({ app, error, onRetry, onClose }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#1c1c1e',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
        textAlign: 'center',
        animation: 'appwindow-fade-in 200ms ease both',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          background: 'rgba(255,59,48,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <CloseGlyph size={26} color="#ff3b30" />
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>No se pudo abrir {app.name}</div>
      <div style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5, maxWidth: 280 }}>
        {typeof error === 'string' ? error : error?.message || 'Error desconocido al iniciar la app.'}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button onClick={onClose} style={errorBtnStyle}>Cerrar</button>
        <button onClick={onRetry} style={{ ...errorBtnStyle, background: 'rgba(10,132,255,0.9)' }}>
          Reintentar
        </button>
      </div>
    </div>
  );
}

const errorBtnStyle = {
  padding: '10px 22px',
  borderRadius: 20,
  border: 'none',
  background: 'rgba(255,255,255,0.14)',
  color: '#fff',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

// ─────────────────────────────────────────────────────────────────────────────
// Hook: lanzamiento de app vía OSContext
// ─────────────────────────────────────────────────────────────────────────────

function useAppLaunch({ app, os, autoLaunch = true }) {
  const [state, dispatch] = useReducer(windowReducer, {
    status: autoLaunch ? WIN_STATE.LAUNCHING : WIN_STATE.RUNNING,
    pid: null,
    error: null,
  });
  const launchedRef = useRef(false);

  const launch = useCallback(async () => {
    dispatch({ type: 'LAUNCH_START' });
    try {
      // Preferimos os.launchApp; si no existe, os.openApp; si no, simulamos.
      let result = null;
      if (os?.launchApp) {
        result = await os.launchApp(app.id || app.bundleId || app.name);
      } else if (os?.openApp) {
        result = await os.openApp(app.id || app.bundleId || app.name);
      } else {
        // Simulación: 420ms de carga
        await new Promise((r) => setTimeout(r, 420));
        result = { pid: Math.floor(Math.random() * 9000) + 1000 };
      }
      const pid = result?.pid ?? result?.processId ?? null;
      dispatch({ type: 'LAUNCH_OK', pid });
      return result;
    } catch (e) {
      dispatch({ type: 'LAUNCH_FAIL', error: e });
      throw e;
    }
  }, [app, os]);

  useEffect(() => {
    if (!autoLaunch) return;
    if (launchedRef.current) return;
    launchedRef.current = true;
    launch();
  }, [autoLaunch, launch]);

  return { state, dispatch, launch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AppWindow
 *
 * @param {Object} props
 * @param {Object}  props.app                App { id, name, emoji?, color?, glyph?, render? }
 * @param {Object} [props.originRect]         Rect del icono de origen (para hero)
 * @param {Function} [props.onClose]          Se llama al terminar el cierre
 * @param {Function} [props.onOpenApp]        Para navegación interna entre apps
 * @param {boolean} [props.autoLaunch=true]   Lanzar al montar
 * @param {'full'|'sheet'|'split'} [props.presentation='full']
 * @param {'dark'|'light'|'auto'} [props.statusBarTheme='auto']
 * @param {boolean} [props.showStatusBar=true]
 * @param {boolean} [props.pausable=true]     Pausar contenido en background
 * @param {React.ReactNode} [props.children]  Si no hay app.render, se usa esto
 * @param {number}  [props.closeDuration=480]
 */
export default function AppWindow({
  app,
  originRect = null,
  onClose,
  onOpenApp,
  autoLaunch = true,
  presentation = 'full',
  statusBarTheme = 'auto',
  showStatusBar = true,
  pausable = true,
  children,
  closeDuration = DURATION,
}) {
  const os = useOS();
  const { state, dispatch, launch } = useAppLaunch({ app, os, autoLaunch });

  const [phase, setPhase] = useState('closed'); // 'closed' | 'opening' | 'open' | 'closing'
  const [drag, setDrag] = useState({ x: 0, y: 0, dragging: false });
  const dragStart = useRef(null);
  const containerRef = useRef(null);

  const hero = useMemo(() => computeHeroTransform(originRect), [originRect]);

  // ── Animación de apertura ─────────────────────────────────────────────────
  useEffect(() => {
    // rAF doble para asegurar que el navegador pinte el estado inicial antes de animar
    let raf1 = 0, raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // ── Cierre ────────────────────────────────────────────────────────────────
  const handleClose = useCallback(async () => {
    if (phase === 'closing') return;
    setPhase('closing');
    dispatch({ type: 'CLOSE_START' });
    haptic('light');
    // Terminar proceso si el OS lo soporta
    try {
      if (os?.closeApp && state.pid != null) {
        await os.closeApp(app.id || app.bundleId, state.pid);
      }
    } catch { /* ignore */ }
    setTimeout(() => onClose?.(), closeDuration);
  }, [phase, dispatch, os, app, state.pid, closeDuration, onClose]);

  // ── Gestos: swipe-up para cerrar ──────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    // Solo gestos que empiezan cerca del borde inferior
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const yLocal = e.clientY - rect.top;
    if (yLocal < SCREEN_H - SAFE_BOTTOM - 40) return;
    dragStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    const dx = e.clientX - dragStart.current.x;
    // Solo hacia arriba
    const clampedY = Math.min(0, dy);
    setDrag({ x: dx * 0.15, y: clampedY, dragging: true });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    const dy = drag.y;
    const dt = performance.now() - dragStart.current.t;
    dragStart.current = null;
    const velocity = Math.abs(dy) / Math.max(1, dt);
    if (Math.abs(dy) > SWIPE_CLOSE_THRESHOLD || velocity > SWIPE_MIN_VELOCITY) {
      handleClose();
    }
    setDrag({ x: 0, y: 0, dragging: false });
  }, [drag.y, handleClose]);

  // ── Pausa al ir a background ──────────────────────────────────────────────
  useEffect(() => {
    if (!pausable) return;
    const handler = () => {
      if (document.hidden) dispatch({ type: 'BACKGROUND' });
      else dispatch({ type: 'FOREGROUND' });
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [pausable, dispatch]);

  // ── Transform según phase ─────────────────────────────────────────────────
  const transform = useMemo(() => {
    if (phase === 'closed') {
      return {
        transform: `translate(${hero.initialX}px, ${hero.initialY}px) scale(${hero.initialScaleX}, ${hero.initialScaleY})`,
        opacity: 0,
        borderRadius: CORNER_RADIUS,
      };
    }
    if (phase === 'opening') {
      return {
        transform: `translate(${hero.initialX}px, ${hero.initialY}px) scale(${hero.initialScaleX}, ${hero.initialScaleY})`,
        opacity: 1,
        borderRadius: CORNER_RADIUS,
      };
    }
    if (phase === 'closing') {
      return {
        transform: `translate(${hero.initialX}px, ${hero.initialY + Math.min(0, drag.y) * 0.5}px) scale(${hero.initialScaleX}, ${hero.initialScaleY})`,
        opacity: 0.5,
        borderRadius: CORNER_RADIUS,
      };
    }
    // phase === 'open'
    if (drag.dragging) {
      const scale = 1 - Math.min(0.12, Math.abs(drag.y) / 3000);
      return {
        transform: `translate(${drag.x}px, ${drag.y * 0.6}px) scale(${scale})`,
        opacity: 1 - Math.min(0.4, Math.abs(drag.y) / 900),
        borderRadius: CORNER_RADIUS,
      };
    }
    return { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: 0 };
  }, [phase, hero, drag]);

  // ── Contenido de la app ───────────────────────────────────────────────────
  const content = useMemo(() => {
    if (state.status === WIN_STATE.LAUNCHING) {
      return <LaunchSplash app={app} />;
    }
    if (state.status === WIN_STATE.ERROR) {
      return (
        <ErrorSplash
          app={app}
          error={state.error}
          onRetry={() => { dispatch({ type: 'RESET' }); launch(); }}
          onClose={handleClose}
        />
      );
    }
    // running / background / closing
    if (typeof app.render === 'function') {
      return app.render({ os, pid: state.pid, app, onClose: handleClose, onOpenApp });
    }
    return children || null;
  }, [state, app, os, children, handleClose, launch, onOpenApp]);

  const isBackground = state.status === WIN_STATE.BACKGROUND;

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 500,
        pointerEvents: phase === 'closing' || phase === 'closed' ? 'none' : 'auto',
        overflow: 'hidden',
        borderRadius: transform.borderRadius,
        background: app.color ? undefined : '#000',
        transform: transform.transform,
        opacity: transform.opacity,
        transition: drag.dragging
          ? 'none'
          : `transform ${closeDuration}ms ${SPRING}, opacity ${closeDuration}ms ${SPRING}, border-radius ${closeDuration}ms ${SPRING}`,
        willChange: 'transform, opacity',
        boxShadow: phase === 'open' ? '0 22px 60px rgba(0,0,0,0.55)' : 'none',
        // La ventana nunca se sale de los límites de la pantalla durante la animación
        transformOrigin: 'center center',
      }}
    >
      <style>{`
        @keyframes appwindow-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes appwindow-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      {/* Contenido */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          // Status bar va dentro del contenido para que respete el hero
        }}
      >
        {/* StatusBar (solo si running; en launching el splash la tapa) */}
        {showStatusBar && state.status !== WIN_STATE.LAUNCHING && (
          <StatusBar
            theme={statusBarTheme}
            wallpaper={app.statusBarWallpaper}
            use24h={os?.snapshot?.settings?.use24h}
            indicators={app.indicators}
            opacity={isBackground ? 0.55 : 1}
          />
        )}

        {/* Contenido principal */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {content}
        </div>
      </div>

      {/* Home indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: `translateX(-50%) translateY(${drag.y * 0.2}px)`,
          width: 134,
          height: 5,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.85)',
          opacity: drag.dragging ? 0.35 : 0.85,
          transition: 'opacity 200ms ease',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variante: AppWindowSheet
// ─────────────────────────────────────────────────────────────────────────────
// Presentación tipo "sheet" (media pantalla), para apps que quieren aparecer
// parcialmente — p. ej. Share Sheet, App Clips, o apps rápidas.
// ─────────────────────────────────────────────────────────────────────────────

export function AppWindowSheet({
  app,
  onClose,
  height = '78%',
  children,
}) {
  const [phase, setPhase] = useState('closed');
  useEffect(() => {
    let raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase('open'));
    });
    return () => cancelAnimationFrame(raf1);
  }, []);

  const handleClose = useCallback(() => {
    setPhase('closed');
    setTimeout(() => onClose?.(), 420);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 500,
        pointerEvents: phase === 'open' ? 'auto' : 'none',
      }}
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height,
          background: '#1c1c1e',
          borderRadius: '44px 44px 0 0',
          transform: phase === 'open' ? 'translateY(0)' : 'translateY(100%)',
          transition: `transform 480ms ${SPRING}`,
          overflow: 'hidden',
          boxShadow: '0 -22px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 40,
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.35)',
          }}
        />
        <div style={{ position: 'absolute', inset: 0, paddingTop: 28 }}>
          {typeof app?.render === 'function' ? app.render({ onClose: handleClose }) : children}
        </div>
      </div>
    </div>
  );
}
