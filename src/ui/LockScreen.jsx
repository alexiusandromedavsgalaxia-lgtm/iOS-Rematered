// src/ui/LockScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — LockScreen
//
// Pantalla de bloqueo completa:
//   • Reloj gigante con tipografía iOS (SF Pro Rounded), fecha en español,
//     widgets opcionales, y personalización por prop.
//   • Face ID "de verdad": animación de escaneo con máscara SVG, dots
//     TrueDepth, estados (idle/scanning/success/fail/lockout), reintentos,
//     bloqueo tras N fallos, cooldown, y desbloqueo vía os.unlockKeychain().
//   • Passcode numérico como fallback (6 dígitos, dots, shake en error).
//   • Notificaciones en lock (lista agrupada, scroll, tap para expandir).
//   • Acciones rápidas: linterna y cámara (esquinas inferiores).
//   • Swipe-up con física (drag, umbral, snap-back, haptic-like).
//   • Personalización: fondo (color/imagen), color del reloj, widgets,
//     posición del reloj, tema (light/dark/auto).
//
// Sin librerías externas. SVG inline. Todo conectado a useOS().
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

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FACE_ID_ATTEMPTS = 5;
const FACE_ID_COOLDOWN_MS = 30_000;
const PASSCODE_LENGTH = 6;
const SWIPE_THRESHOLD = 90; // px hacia arriba para desbloquear

/** Estados posibles de Face ID. */
const FACE_STATE = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  SUCCESS: 'success',
  FAIL: 'fail',
  LOCKOUT: 'lockout',
  DISABLED: 'disabled',
};

/** Días y meses en español para la fecha. */
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(date, use24h = false) {
  let h = date.getHours();
  const m = date.getMinutes();
  if (!use24h) {
    h = h % 12 || 12;
  }
  const hh = use24h ? String(h).padStart(2, '0') : String(h);
  const mm = String(m).padStart(2, '0');
  return { hh, mm };
}

function formatDate(date) {
  const d = DIAS[date.getDay()];
  const day = date.getDate();
  const m = MESES[date.getMonth()];
  return `${d}, ${day} de ${m}`;
}

function haptic(pattern = 'light') {
  // Vibración real si el navegador lo soporta (móvil), si no, no-op.
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12] };
    navigator.vibrate(map[pattern] || 8);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline
// ─────────────────────────────────────────────────────────────────────────────

function FlashlightIcon({ on, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M9 3h6l-1 6h-4L9 3z"
        fill={on ? '#fff' : 'rgba(255,255,255,0.9)'}
      />
      <path
        d="M10 9h4v10a2 2 0 0 1-2 2 2 2 0 0 1-2-2V9z"
        fill={on ? '#fff' : 'rgba(255,255,255,0.9)'}
      />
    </svg>
  );
}

function CameraIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="7" width="18" height="13" rx="3" fill="rgba(255,255,255,0.9)" />
      <circle cx="12" cy="13.5" r="3.4" fill="#1a1a1a" />
      <circle cx="12" cy="13.5" r="1.6" fill="rgba(255,255,255,0.9)" />
      <rect x="8" y="5" width="4" height="3" rx="1" fill="rgba(255,255,255,0.9)" />
    </svg>
  );
}

function LockGlyph({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="5" y="10" width="14" height="11" rx="2.5" fill="#fff" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="#fff" strokeWidth="2" fill="none" />
    </svg>
  );
}

/**
 * Máscara de Face ID: un círculo con dots animados (TrueDepth).
 * Cuando `progress` avanza (0..1), los dots se iluminan en secuencia.
 */
function FaceIDGlyph({ state, progress = 0, size = 72 }) {
  const dots = useMemo(() => {
    // 20 dots distribuidos en 2 anillos concéntricos
    const arr = [];
    const inner = 6;
    const outer = 14;
    for (let i = 0; i < inner; i++) {
      const a = (i / inner) * Math.PI * 2 - Math.PI / 2;
      arr.push({ cx: 50 + Math.cos(a) * 14, cy: 50 + Math.sin(a) * 14, r: 2.1, layer: 'inner' });
    }
    for (let i = 0; i < outer; i++) {
      const a = (i / outer) * Math.PI * 2 - Math.PI / 2;
      arr.push({ cx: 50 + Math.cos(a) * 30, cy: 50 + Math.sin(a) * 30, r: 1.7, layer: 'outer' });
    }
    return arr;
  }, []);

  const strokeColor =
    state === FACE_STATE.SUCCESS ? '#34c759' :
    state === FACE_STATE.FAIL    ? '#ff3b30' :
    state === FACE_STATE.LOCKOUT ? '#ff9500' :
    '#fff';

  const faceOpacity =
    state === FACE_STATE.LOCKOUT ? 0.35 :
    state === FACE_STATE.FAIL    ? 0.7  : 1;

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: 'block' }}>
      {/* Anillo exterior */}
      <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />

      {/* Dots TrueDepth */}
      {dots.map((d, i) => {
        const lit = progress > 0 && (i / dots.length) < progress;
        return (
          <circle
            key={i}
            cx={d.cx}
            cy={d.cy}
            r={d.r}
            fill={lit ? strokeColor : 'rgba(255,255,255,0.25)'}
            opacity={lit ? 1 : 0.5}
            style={{ transition: 'fill 120ms linear, opacity 120ms linear' }}
          />
        );
      })}

      {/* Cara estilizada */}
      <g opacity={faceOpacity}>
        {/* Ojos */}
        <ellipse cx="38" cy="44" rx="3.4" ry="4.4" fill="rgba(255,255,255,0.92)" />
        <ellipse cx="62" cy="44" rx="3.4" ry="4.4" fill="rgba(255,255,255,0.92)" />
        {/* Nariz */}
        <path d="M50 48v10l-2 2" stroke="rgba(255,255,255,0.6)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        {/* Boca */}
        <path
          d={state === FACE_STATE.SUCCESS ? 'M40 68q10 8 20 0' : state === FACE_STATE.FAIL ? 'M40 72q10 -6 20 0' : 'M40 70h20'}
          stroke="rgba(255,255,255,0.75)"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </g>

      {/* Indicador de éxito/fallo */}
      {state === FACE_STATE.SUCCESS && (
        <circle cx="50" cy="50" r="44" fill="none" stroke="#34c759" strokeWidth="2.5"
          style={{ filter: 'drop-shadow(0 0 6px rgba(52,199,89,0.6))' }} />
      )}
      {state === FACE_STATE.FAIL && (
        <circle cx="50" cy="50" r="44" fill="none" stroke="#ff3b30" strokeWidth="2.5"
          style={{ filter: 'drop-shadow(0 0 6px rgba(255,59,48,0.6))' }} />
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: Face ID real (máquina de estados + escaneo + lockout)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Máquina de estados de Face ID.
 *
 * Acciones:
 *   SCAN_START   → pasa a SCANNING, arranca progreso
 *   SCAN_TICK    → avanza progreso 0..1
 *   SCAN_OK      → SUCCESS (dispara onSuccess tras breve pausa)
 *   SCAN_FAIL    → FAIL (incrementa attempts, quizá LOCKOUT)
 *   LOCKOUT_TICK → cuenta atrás de cooldown
 *   RESET        → vuelve a IDLE
 *   DISABLE      → DESACTIVADO
 */
function faceReducer(state, action) {
  switch (action.type) {
    case 'SCAN_START':
      if (state.status === FACE_STATE.LOCKOUT) return state;
      return { ...state, status: FACE_STATE.SCANNING, progress: 0 };
    case 'SCAN_TICK':
      if (state.status !== FACE_STATE.SCANNING) return state;
      return { ...state, progress: Math.min(1, state.progress + action.dt) };
    case 'SCAN_OK':
      return { ...state, status: FACE_STATE.SUCCESS, progress: 1, attempts: 0 };
    case 'SCAN_FAIL': {
      const attempts = state.attempts + 1;
      if (attempts >= MAX_FACE_ID_ATTEMPTS) {
        return {
          ...state,
          status: FACE_STATE.LOCKOUT,
          attempts,
          cooldown: FACE_ID_COOLDOWN_MS,
        };
      }
      return { ...state, status: FACE_STATE.FAIL, attempts, progress: 0 };
    }
    case 'LOCKOUT_TICK': {
      const cooldown = Math.max(0, state.cooldown - action.dt);
      if (cooldown <= 0) {
        return { ...state, status: FACE_STATE.IDLE, cooldown: 0, attempts: 0 };
      }
      return { ...state, cooldown };
    }
    case 'RESET':
      if (state.status === FACE_STATE.LOCKOUT) return state;
      return { ...state, status: FACE_STATE.IDLE, progress: 0 };
    case 'DISABLE':
      return { ...state, status: FACE_STATE.DISABLED };
    default:
      return state;
  }
}

function useFaceID({ enabled, onSuccess, onFail, probe }) {
  const [state, dispatch] = useReducer(faceReducer, {
    status: enabled ? FACE_STATE.IDLE : FACE_STATE.DISABLED,
    progress: 0,
    attempts: 0,
    cooldown: 0,
  });
  const scanTimer = useRef(null);
  const lockTimer = useRef(null);
  const lastTick = useRef(0);

  // ── Arranque automático del escaneo cuando está en IDLE ───────────────────
  useEffect(() => {
    if (!enabled) return;
    if (state.status !== FACE_STATE.IDLE) return;
    const t = setTimeout(() => dispatch({ type: 'SCAN_START' }), 420);
    return () => clearTimeout(t);
  }, [enabled, state.status]);

  // ── Progreso del escaneo ──────────────────────────────────────────────────
  useEffect(() => {
    if (state.status !== FACE_STATE.SCANNING) return;
    lastTick.current = performance.now();
    let raf = 0;
    const step = (now) => {
      const dt = (now - lastTick.current) / 1000;
      lastTick.current = now;
      // ~1.6s de escaneo completo
      dispatch({ type: 'SCAN_TICK', dt: dt / 1.6 });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state.status]);

  // ── Decisión al completar el escaneo ──────────────────────────────────────
  useEffect(() => {
    if (state.status !== FACE_STATE.SCANNING) return;
    if (state.progress < 1) return;
    // `probe` es una función que devuelve true/false según biometría simulada.
    const ok = typeof probe === 'function' ? probe() : true;
    if (ok) {
      dispatch({ type: 'SCAN_OK' });
      haptic('double');
    } else {
      dispatch({ type: 'SCAN_FAIL' });
      haptic('heavy');
      onFail?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.progress, state.status]);

  // ── Transición SUCCESS → onSuccess ────────────────────────────────────────
  useEffect(() => {
    if (state.status !== FACE_STATE.SUCCESS) return;
    const t = setTimeout(() => onSuccess?.(), 520);
    return () => clearTimeout(t);
  }, [state.status, onSuccess]);

  // ── Transición FAIL → IDLE tras un instante ───────────────────────────────
  useEffect(() => {
    if (state.status !== FACE_STATE.FAIL) return;
    const t = setTimeout(() => dispatch({ type: 'RESET' }), 900);
    return () => clearTimeout(t);
  }, [state.status]);

  // ── Cooldown de lockout ───────────────────────────────────────────────────
  useEffect(() => {
    if (state.status !== FACE_STATE.LOCKOUT) return;
    lockTimer.current = performance.now();
    let raf = 0;
    const step = (now) => {
      const dt = (now - lockTimer.current) / 1000;
      lockTimer.current = now;
      dispatch({ type: 'LOCKOUT_TICK', dt: dt * 1000 });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state.status]);

  const trigger = useCallback(() => {
    if (state.status === FACE_STATE.IDLE) dispatch({ type: 'SCAN_START' });
  }, [state.status]);

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  return { state, trigger, reset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ─────────────────────────────────────────────────────────────────────────────

function BigClock({ date, use24h, clockColor, font, scale = 1 }) {
  const { hh, mm } = formatTime(date, use24h);
  const dateStr = formatDate(date);
  return (
    <div style={{ textAlign: 'center', color: clockColor, transform: `scale(${scale})` }}>
      <div
        style={{
          fontFamily: font || '"SF Pro Rounded", -apple-system, system-ui, sans-serif',
          fontSize: 82,
          fontWeight: 500,
          lineHeight: 0.95,
          letterSpacing: -2,
          fontVariantNumeric: 'tabular-nums',
          textShadow: '0 2px 24px rgba(0,0,0,0.35)',
        }}
      >
        {hh}:{mm}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 15,
          fontWeight: 500,
          opacity: 0.92,
          textShadow: '0 1px 12px rgba(0,0,0,0.35)',
        }}
      >
        {dateStr}
      </div>
    </div>
  );
}

function FaceIDStatusText({ state }) {
  const text =
    state.status === FACE_STATE.SCANNING ? 'Face ID' :
    state.status === FACE_STATE.SUCCESS  ? 'Desbloqueado' :
    state.status === FACE_STATE.FAIL     ? 'Face ID no reconocido' :
    state.status === FACE_STATE.LOCKOUT  ? `Face ID bloqueado · ${Math.ceil(state.cooldown / 1000)}s` :
    state.status === FACE_STATE.DISABLED ? 'Face ID desactivado' :
    'Toca para usar Face ID';
  return (
    <div
      style={{
        marginTop: 12,
        fontSize: 13,
        fontWeight: 500,
        color:
          state.status === FACE_STATE.SUCCESS ? '#34c759' :
          state.status === FACE_STATE.FAIL    ? '#ff3b30' :
          state.status === FACE_STATE.LOCKOUT ? '#ff9500' :
          'rgba(255,255,255,0.85)',
        textShadow: '0 1px 8px rgba(0,0,0,0.4)',
        transition: 'color 200ms ease',
      }}
    >
      {text}
    </div>
  );
}

function PasscodeDots({ length, filled, error }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        justifyContent: 'center',
        transform: error ? 'translateX(0)' : 'none',
        animation: error ? 'lockscreen-shake 380ms cubic-bezier(.36,.07,.19,.97)' : 'none',
      }}
    >
      {Array.from({ length }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1.5px solid rgba(255,255,255,0.9)',
            background: i < filled ? (error ? '#ff3b30' : '#fff') : 'transparent',
            transition: 'background 120ms ease, border-color 120ms ease',
          }}
        />
      ))}
    </div>
  );
}

function PasscodePad({ onDigit, onDelete, onCancel }) {
  const keys = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['', ''], ['0', ''], ['del', ''],
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 72px)',
        gap: 14,
        justifyContent: 'center',
      }}
    >
      {keys.map(([k, sub], i) => {
        if (k === '') return <div key={i} />;
        if (k === 'del') {
          return (
            <button
              key={i}
              onClick={onDelete}
              style={padBtnStyle}
              aria-label="Borrar"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M9 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L2 12l7-7z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
                <path d="M12 9l6 6M18 9l-6 6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          );
        }
        return (
          <button
            key={i}
            onClick={() => onDigit(k)}
            style={padBtnStyle}
            aria-label={k}
          >
            <div style={{ fontSize: 26, fontWeight: 400, color: '#fff', lineHeight: 1 }}>{k}</div>
            {sub && (
              <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
                {sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

const padBtnStyle = {
  width: 72,
  height: 72,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255,255,255,0.14)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  userSelect: 'none',
  transition: 'background 100ms ease, transform 80ms ease',
};

function NotificationRow({ n }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      style={{
        background: 'rgba(255,255,255,0.14)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderRadius: 18,
        padding: 12,
        marginBottom: 8,
        color: '#fff',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: n.color || 'rgba(255,255,255,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {n.app?.[0]?.toUpperCase() || '?'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.9 }}>{n.app || 'App'}</div>
        </div>
        <div style={{ fontSize: 10, opacity: 0.6 }}>{n.time || 'ahora'}</div>
      </div>
      <div style={{ marginTop: 6, fontSize: 13, fontWeight: 500 }}>{n.title}</div>
      {expanded && n.body && (
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8, lineHeight: 1.4 }}>{n.body}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LockScreen
 *
 * @param {Object} props
 * @param {Function} [props.onUnlock]        Llamado al desbloquear con éxito.
 * @param {Function} [props.onOpenApp]       Llamado si se abre app desde notif.
 * @param {string}   [props.wallpaper]       Fondo: color CSS o url(...).
 * @param {string}   [props.clockColor]      Color del reloj (default #fff).
 * @param {string}   [props.clockFont]       Font-family del reloj.
 * @param {boolean}  [props.use24h]          Formato 24h (default false).
 * @param {'top'|'center'|'bottom'} [props.clockPosition='center']
 * @param {number}   [props.clockScale=1]    Escala del reloj.
 * @param {Array}    [props.widgets]         Array de {id, render} a mostrar bajo el reloj.
 * @param {Array}    [props.notifications]   Notificaciones iniciales.
 * @param {boolean}  [props.faceIDEnabled=true]
 * @param {boolean}  [props.passcodeEnabled=true]
 * @param {string}   [props.passcode]        Passcode correcto (default '123456').
 * @param {Function} [props.faceIDProbe]     () => boolean, simula biometría.
 * @param {boolean}  [props.showQuickActions=true]
 * @param {boolean}  [props.showNotifications=true]
 */
export default function LockScreen({
  onUnlock,
  onOpenApp,
  wallpaper = 'linear-gradient(160deg, #1c1c2e 0%, #2a1f3d 45%, #3b1f3d 100%)',
  clockColor = '#fff',
  clockFont,
  use24h = false,
  clockPosition = 'center',
  clockScale = 1,
  widgets = [],
  notifications: initialNotifications = null,
  faceIDEnabled = true,
  passcodeEnabled = true,
  passcode = '123456',
  faceIDProbe,
  showQuickActions = true,
  showNotifications = true,
}) {
  const os = useOS();

  // ── Estado local ──────────────────────────────────────────────────────────
  const [now, setNow] = useState(() => new Date());
  const [mode, setMode] = useState('face'); // 'face' | 'passcode'
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [flashlight, setFlashlight] = useState(false);
  const [drag, setDrag] = useState({ y: 0, dragging: false });
  const [unlocked, setUnlocked] = useState(false);

  const dragStart = useRef(null);
  const containerRef = useRef(null);

  // ── Notificaciones: si no se pasan, derivar de OSContext ──────────────────
  const notifications = useMemo(() => {
    if (Array.isArray(initialNotifications)) return initialNotifications;
    const raw =
      os?.notifications?.list?.() ||
      os?.snapshot?.notifications ||
      [];
    return raw.slice(0, 6).map((n) => ({
      id: n.id,
      app: n.appName || n.bundleId?.split('.').pop() || 'App',
      title: n.title || 'Notificación',
      body: n.body || '',
      time: n.time || '',
      color: n.color,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNotifications, os?.snapshot?.notifications]);

  // ── Reloj: tick cada segundo ──────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Cierre real de la pantalla de bloqueo ─────────────────────────────────
  const finishUnlock = useCallback(() => {
    if (unlocked) return;
    setUnlocked(true);
    haptic('medium');
    // Notifica al sistema (Keychain unlock) si está disponible.
    try {
      os?.unlockKeychain?.();
    } catch { /* ignore */ }
    // Pequeña pausa para la animación antes de avisar al padre.
    setTimeout(() => onUnlock?.(), 320);
  }, [unlocked, os, onUnlock]);

  // ── Face ID ───────────────────────────────────────────────────────────────
  const { state: faceState, trigger: triggerFace, reset: resetFace } = useFaceID({
    enabled: faceIDEnabled && mode === 'face',
    onSuccess: finishUnlock,
    onFail: () => {
      // Tras varios fallos, sugerir passcode.
      if (faceState.attempts + 1 >= 3 && passcodeEnabled) {
        // no forzamos, dejamos que el usuario pulse "Usar passcode"
      }
    },
    probe: faceIDProbe,
  });

  // Si Face ID está desactivado, ir directo a passcode.
  useEffect(() => {
    if (!faceIDEnabled && passcodeEnabled) setMode('passcode');
  }, [faceIDEnabled, passcodeEnabled]);

  // ── Passcode: añadir dígito ───────────────────────────────────────────────
  const handleDigit = useCallback((d) => {
    haptic('light');
    setPinError(false);
    setPin((prev) => {
      if (prev.length >= PASSCODE_LENGTH) return prev;
      const next = prev + d;
      if (next.length === PASSCODE_LENGTH) {
        // Validar
        setTimeout(() => {
          if (next === passcode) {
            finishUnlock();
          } else {
            setPinError(true);
            haptic('heavy');
            setTimeout(() => {
              setPin('');
              setPinError(false);
            }, 600);
          }
        }, 80);
      }
      return next;
    });
  }, [passcode, finishUnlock]);

  const handleDelete = useCallback(() => {
    haptic('light');
    setPin((p) => p.slice(0, -1));
  }, []);

  // ── Swipe-up ──────────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (mode === 'passcode') return;
    dragStart.current = { y: e.clientY, t: performance.now() };
    setDrag({ y: 0, dragging: true });
  }, [mode]);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    // Solo hacia arriba (dy negativo)
    const clamped = Math.min(0, dy);
    setDrag({ y: clamped, dragging: true });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    const dy = drag.y;
    dragStart.current = null;
    if (dy < -SWIPE_THRESHOLD) {
      // Intento de desbloqueo por swipe: si Face ID ya está OK, desbloquea.
      if (faceState.status === FACE_STATE.SUCCESS) {
        finishUnlock();
      } else if (passcodeEnabled) {
        setMode('passcode');
      } else {
        triggerFace();
      }
      setDrag({ y: 0, dragging: false });
    } else {
      // Snap-back
      setDrag({ y: 0, dragging: false });
    }
  }, [drag.y, faceState.status, passcodeEnabled, triggerFace, finishUnlock]);

  // ── Posición del reloj ────────────────────────────────────────────────────
  const clockPositionStyle = useMemo(() => {
    switch (clockPosition) {
      case 'top':    return { top: 80, left: 0, right: 0, position: 'absolute' };
      case 'bottom': return { bottom: 220, left: 0, right: 0, position: 'absolute' };
      default:       return { top: 120, left: 0, right: 0, position: 'absolute' };
    }
  }, [clockPosition]);

  // ── Render ────────────────────────────────────────────────────────────────
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
        background: wallpaper,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        overflow: 'hidden',
        color: '#fff',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        opacity: unlocked ? 0 : 1,
        transform: unlocked ? 'scale(1.08)' : 'scale(1)',
        transition: 'opacity 320ms ease, transform 320ms ease',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      {/* Estilos de animaciones */}
      <style>{`
        @keyframes lockscreen-shake {
          10%, 90% { transform: translateX(-2px); }
          20%, 80% { transform: translateX(4px); }
          30%, 50%, 70% { transform: translateX(-8px); }
          40%, 60% { transform: translateX(8px); }
        }
        @keyframes lockscreen-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Reloj */}
      <div style={{ ...clockPositionStyle, animation: 'lockscreen-fade-in 500ms ease' }}>
        <BigClock
          date={now}
          use24h={use24h}
          clockColor={clockColor}
          font={clockFont}
          scale={clockScale}
        />
        {/* Widgets bajo el reloj */}
        {widgets.length > 0 && (
          <div
            style={{
              marginTop: 18,
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
              padding: '0 40px',
            }}
          >
            {widgets.map((w) => (
              <div key={w.id} style={{ minWidth: 0 }}>
                {typeof w.render === 'function' ? w.render(os) : w.render}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notificaciones */}
      {showNotifications && notifications.length > 0 && mode === 'face' && (
        <div
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 200,
            maxHeight: 260,
            overflowY: 'auto',
            animation: 'lockscreen-fade-in 600ms ease 100ms both',
          }}
        >
          {notifications.map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
      )}

      {/* Bloque central: Face ID o Passcode */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: `translateY(${drag.y * 0.4}px)`,
          transition: drag.dragging ? 'none' : 'transform 320ms cubic-bezier(.22,1,.36,1)',
        }}
      >
        {mode === 'face' ? (
          <>
            {/* Icono de candado encima de Face ID */}
            <div style={{ marginBottom: 12, opacity: 0.85 }}>
              <LockGlyph size={18} />
            </div>

            <button
              onClick={triggerFace}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'block',
              }}
              aria-label="Face ID"
            >
              <FaceIDGlyph
                state={faceState.status}
                progress={faceState.progress}
                size={84}
              />
            </button>

            <FaceIDStatusText state={faceState} />

            {/* Botón "Usar passcode" cuando hay fallo */}
            {(faceState.status === FACE_STATE.FAIL || faceState.status === FACE_STATE.LOCKOUT) &&
             passcodeEnabled && (
              <button
                onClick={() => setMode('passcode')}
                style={{
                  marginTop: 14,
                  background: 'rgba(255,255,255,0.14)',
                  border: 'none',
                  borderRadius: 18,
                  padding: '8px 18px',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Usar passcode
              </button>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, opacity: 0.9, marginBottom: 20 }}>
              Introduce el passcode
            </div>
            <PasscodeDots
              length={PASSCODE_LENGTH}
              filled={pin.length}
              error={pinError}
            />
            <div style={{ marginTop: 28 }}>
              <PasscodePad
                onDigit={handleDigit}
                onDelete={handleDelete}
              />
            </div>
            {faceIDEnabled && (
              <button
                onClick={() => { setMode('face'); resetFace(); }}
                style={{
                  marginTop: 18,
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.8)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Usar Face ID
              </button>
            )}
          </>
        )}
      </div>

      {/* Acciones rápidas: linterna (izq) y cámara (der) */}
      {showQuickActions && mode === 'face' && (
        <>
          <button
            onClick={() => { setFlashlight((v) => !v); haptic('light'); }}
            style={{
              position: 'absolute',
              left: 28,
              bottom: 44,
              width: 48,
              height: 48,
              borderRadius: '50%',
              border: 'none',
              background: flashlight ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.18)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background 160ms ease',
            }}
            aria-label="Linterna"
          >
            <FlashlightIcon on={flashlight} />
          </button>
          <button
            onClick={() => onOpenApp?.('camera')}
            style={{
              position: 'absolute',
              right: 28,
              bottom: 44,
              width: 48,
              height: 48,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(255,255,255,0.18)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
            aria-label="Cámara"
          >
            <CameraIcon />
          </button>
        </>
      )}

      {/* Home indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 134,
          height: 5,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.85)',
          opacity: drag.dragging ? 0.4 : 0.85,
          transition: 'opacity 200ms ease',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
