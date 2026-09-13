// src/ui/NotificationCenterUI.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — NotificationCenterUI
//
// Centro de notificaciones deslizante desde arriba:
//   • Widgets superiores: reloj grande, fecha, clima, batería, calendario.
//   • Stack de notificaciones agrupadas por bundleId + threadId.
//   • Cada grupo expandible/colapsable con contador "N más".
//   • Swipe horizontal en una notificación → descartar (derecha) o abrir (izq).
//   • Long-press → acciones rápidas (Reply, Marcar, Silenciar, Eliminar).
//   • Sección "Notificaciones antiguas" plegable al final.
//   • Botón "X" para limpiar todo con confirmación.
//   • Blur iOS real, animaciones de entrada/salida escalonadas.
//   • Lee y escribe al NotificationCenter del OSContext.
//
// Sin librerías externas. SVG inline.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOS } from '../context/OSContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_PADDING = 16;
const CARD_RADIUS = 22;
const BLUR = 'blur(38px) saturate(180%)';
const SPRING = 'cubic-bezier(.22,1,.36,1)';
const SWIPE_DISMISS = 90;
const SWIPE_OPEN = -60;
const DRAG_CLOSE_THRESHOLD = 100;
const LONG_PRESS_MS = 480;

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

/** Formatea tiempo relativo ("ahora", "hace 5m", "hace 2h", "ayer"). */
function relativeTime(ts) {
  if (!ts) return 'ahora';
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'ahora';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d}d`;
  const date = new Date(ts);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

/** Agrupa notificaciones por bundleId + threadId. */
function groupNotifications(list) {
  const groups = new Map();
  for (const n of list) {
    const key = `${n.bundleId || n.app || 'unknown'}::${n.threadId || n.title || 'main'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        bundleId: n.bundleId,
        app: n.app || n.appName || 'App',
        appColor: n.color || n.appColor,
        icon: n.icon,
        threadId: n.threadId,
        notifications: [],
        latestTs: 0,
      });
    }
    const g = groups.get(key);
    g.notifications.push(n);
    g.latestTs = Math.max(g.latestTs, n.timestamp || Date.now());
  }
  // Ordenar cada grupo por timestamp desc, y ordenar grupos por latestTs desc
  for (const g of groups.values()) {
    g.notifications.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
  return Array.from(groups.values()).sort((a, b) => b.latestTs - a.latestTs);
}

/** Aplica un gradiente determinista si no hay color de app. */
function gradientFor(name) {
  const seed = (name || '?').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const palettes = [
    ['#ff9a3c', '#ff3b30'], ['#5ac8fa', '#007aff'], ['#af52de', '#5856d6'],
    ['#34c759', '#30b0c7'], ['#ff2d55', '#ff6482'], ['#ffcc00', '#ff9500'],
    ['#8e8e93', '#48484a'], ['#00c7be', '#30b0c7'],
  ];
  const [a, b] = palettes[seed % palettes.length];
  return `linear-gradient(160deg, ${a}, ${b})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG
// ─────────────────────────────────────────────────────────────────────────────

function ChevronIcon({ dir = 'down', size = 12, color = 'rgba(255,255,255,0.7)' }) {
  const rotate = dir === 'up' ? 180 : dir === 'right' ? -90 : dir === 'left' ? 90 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ transform: `rotate(${rotate}deg)`, transition: 'transform 220ms ease' }}>
      <path d="M6 9 L12 15 L18 9" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function CloseIcon({ size = 14, color = 'rgba(255,255,255,0.75)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 6 L18 18 M18 6 L6 18" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function ReplyIcon({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M9 10 L4 15 L9 20 M4 15 H14 a6 6 0 0 0 6 -6 V7" stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MuteIcon({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 9 h3 l4 -4 v14 l-4 -4 h-3 z" fill={color} />
      <path d="M16 9 L21 14 M21 9 L16 14" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 7 H20 M9 7 V5 a1 1 0 0 1 1 -1 h4 a1 1 0 0 1 1 1 V7 M6 7 l1 12 a2 2 0 0 0 2 2 h6 a2 2 0 0 0 2 -2 l1 -12" stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MarkReadIcon({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 12 L9 17 L20 6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockWidgetIcon({ size = 18, color = 'rgba(255,255,255,0.7)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.6" fill="none" />
      <path d="M12 7 v5 l3 2" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function CalendarWidgetIcon({ size = 18, color = 'rgba(255,255,255,0.7)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke={color} strokeWidth="1.6" fill="none" />
      <path d="M3 9 H21 M8 3 V6 M16 3 V6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function WeatherIcon({ condition = 'sunny', size = 22 }) {
  if (condition === 'rain') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M6 14 a4 4 0 0 1 1 -8 a5 5 0 0 1 9 1 a3 3 0 0 1 1 6 z" fill="rgba(255,255,255,0.75)" />
        <path d="M8 18 l-1 3 M12 18 l-1 3 M16 18 l-1 3" stroke="#5ac8fa" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="5" fill="#ffcc00" />
      <path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M5 5 l2 2 M17 17 l2 2 M5 19 l2 -2 M17 7 l2 -2" stroke="#ffcc00" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BatteryWidgetIcon({ size = 18, color = 'rgba(255,255,255,0.7)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="16" height="8" rx="2" stroke={color} strokeWidth="1.6" fill="none" />
      <rect x="4.5" y="9.5" width="10" height="5" rx="1" fill="#34c759" />
      <rect x="20" y="10.5" width="1.5" height="3" rx="0.6" fill={color} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Widgets superiores
// ─────────────────────────────────────────────────────────────────────────────

function BigClockWidget({ os }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dows = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  return (
    <div
      style={{
        borderRadius: CARD_RADIUS,
        background: 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        padding: 16,
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 110,
      }}
    >
      <div style={{ fontSize: 10, opacity: 0.7, fontWeight: 500, letterSpacing: 0.3 }}>
        {dows[now.getDay()].toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 300,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: -1,
        }}
      >
        {hh}:{mm}
      </div>
    </div>
  );
}

function WeatherWidget({ os, data }) {
  const temp = data?.temp ?? 22;
  const cond = data?.condition ?? 'sunny';
  const city = data?.city ?? 'Madrid';
  return (
    <div
      style={{
        borderRadius: CARD_RADIUS,
        background: 'linear-gradient(160deg, #5ac8fa, #007aff)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        padding: 14,
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 110,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <WeatherIcon condition={cond} size={18} />
        <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.9 }}>{city}</span>
      </div>
      <div style={{ fontSize: 34, fontWeight: 300, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {temp}°
      </div>
      <div style={{ fontSize: 10, opacity: 0.85 }}>
        {cond === 'rain' ? 'Lluvia' : 'Soleado'}
      </div>
    </div>
  );
}

function BatteryWidget({ os }) {
  const snap = os?.snapshot || {};
  const level = typeof snap.battery?.level === 'number' ? snap.battery.level : 100;
  const charging = !!snap.battery?.charging;
  return (
    <div
      style={{
        borderRadius: CARD_RADIUS,
        background: 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        padding: 14,
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 110,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <BatteryWidgetIcon size={16} color="rgba(255,255,255,0.85)" />
        <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.85 }}>Batería</span>
      </div>
      <div style={{ fontSize: 34, fontWeight: 300, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(level)}%
      </div>
      <div style={{ fontSize: 10, opacity: 0.75 }}>
        {charging ? 'Cargando' : 'En uso'}
      </div>
    </div>
  );
}

function CalendarWidget({ os }) {
  const now = new Date();
  const dow = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][now.getDay()];
  return (
    <div
      style={{
        borderRadius: CARD_RADIUS,
        background: 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        padding: 14,
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 110,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CalendarWidgetIcon size={16} />
        <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.85 }}>{dow.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 34, fontWeight: 300, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {now.getDate()}
      </div>
      <div style={{ fontSize: 10, opacity: 0.75 }}>
        Sin eventos
      </div>
    </div>
  );
}

function WidgetsRow({ os, weather }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        marginBottom: 18,
      }}
    >
      <BigClockWidget os={os} />
      <WeatherWidget os={os} data={weather} />
      <BatteryWidget os={os} />
      <CalendarWidget os={os} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarjeta de notificación individual
// ─────────────────────────────────────────────────────────────────────────────

function NotificationCard({
  notification,
  expanded = false,
  onOpen,
  onDismiss,
  onAction,
  onLongPress,
}) {
  const [drag, setDrag] = useState({ x: 0, dragging: false, dismissing: false });
  const dragStart = useRef(null);
  const longTimer = useRef(null);
  const longFired = useRef(false);

  const onPointerDown = useCallback((e) => {
    // Ignorar si empieza en un botón de acción
    if (e.target.closest('[data-nc-action]')) return;
    dragStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    longFired.current = false;
    longTimer.current = setTimeout(() => {
      longFired.current = true;
      haptic('heavy');
      onLongPress?.(notification);
    }, LONG_PRESS_MS);
  }, [notification, onLongPress]);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    // Cancelar long-press si se mueve más de 6px
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
      if (longTimer.current) {
        clearTimeout(longTimer.current);
        longTimer.current = null;
      }
    }
    // Solo swipe horizontal (dx dominante)
    if (Math.abs(dx) > Math.abs(dy) * 1.4) {
      setDrag({ x: dx, dragging: true, dismissing: false });
    }
  }, []);

  const onPointerUp = useCallback(() => {
    if (longTimer.current) {
      clearTimeout(longTimer.current);
      longTimer.current = null;
    }
    if (!dragStart.current) return;
    const dx = drag.x;
    dragStart.current = null;

    if (longFired.current) {
      setDrag({ x: 0, dragging: false, dismissing: false });
      return;
    }

    if (dx > SWIPE_DISMISS) {
      // Descartar hacia la derecha
      setDrag({ x: 500, dragging: false, dismissing: true });
      haptic('medium');
      setTimeout(() => onDismiss?.(notification), 260);
    } else if (dx < SWIPE_OPEN) {
      // Abrir hacia la izquierda
      haptic('light');
      onOpen?.(notification);
      setDrag({ x: 0, dragging: false, dismissing: false });
    } else {
      // Snap back
      setDrag({ x: 0, dragging: false, dismissing: false });
    }
  }, [drag.x, notification, onDismiss, onOpen]);

  // Tap normal
  const onTap = useCallback(() => {
    if (drag.dragging || drag.dismissing) return;
    if (longFired.current) return;
    haptic('light');
    onOpen?.(notification);
  }, [drag, onOpen, notification]);

  const t = notification.timestamp || Date.now();
  const appColor = notification.color || notification.appColor || gradientFor(notification.app || 'App');
  const appInitial = (notification.app || notification.appName || '?')[0].toUpperCase();

  // Índice de la notificación dentro del grupo (para mostrar "más")
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onTap}
      style={{
        position: 'relative',
        borderRadius: 20,
        background: drag.dismissing
          ? 'rgba(120,120,128,0.15)'
          : 'rgba(120,120,128,0.42)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        padding: '12px 14px',
        color: '#fff',
        cursor: 'pointer',
        transform: `translateX(${drag.x}px)`,
        opacity: drag.dismissing ? 0 : 1,
        transition: drag.dragging
          ? 'none'
          : `transform 320ms ${SPRING}, opacity 260ms ease, background 220ms ease`,
        touchAction: 'pan-y',
        userSelect: 'none',
        marginBottom: 8,
      }}
    >
      {/* Indicador de descartar detrás (rojo sutil) */}
      {drag.x > 20 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 20,
            background: `rgba(255,59,48,${Math.min(0.35, drag.x / 400)})`,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Indicador de abrir detrás (azul sutil) */}
      {drag.x < -20 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 20,
            background: `rgba(10,132,255,${Math.min(0.35, -drag.x / 400)})`,
            pointerEvents: 'none',
          }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, position: 'relative' }}>
        {/* Icono de app */}
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 9,
            background: appColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            fontSize: 16,
            fontWeight: 700,
            color: '#fff',
            boxShadow: '0 2px 6px rgba(0,0,0,0.28)',
          }}
        >
          {notification.icon ? notification.icon : appInitial}
        </div>

        {/* Contenido */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.85,
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {notification.app || notification.appName || 'App'}
            </span>
            <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 500, flexShrink: 0 }}>
              {relativeTime(t)}
            </span>
          </div>

          {notification.title && (
            <div
              style={{
                marginTop: 3,
                fontSize: 14,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {notification.title}
            </div>
          )}

          {notification.body && (
            <div
              style={{
                marginTop: 2,
                fontSize: 13,
                opacity: 0.82,
                lineHeight: 1.35,
                display: '-webkit-box',
                WebkitLineClamp: expanded ? 'unset' : 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {notification.body}
            </div>
          )}

          {/* Acciones interactivas */}
          {notification.actions && notification.actions.length > 0 && expanded && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {notification.actions.map((a, i) => (
                <button
                  key={i}
                  data-nc-action
                  onClick={(e) => {
                    e.stopPropagation();
                    haptic('light');
                    onAction?.(notification, a);
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 14,
                    border: 'none',
                    background: 'rgba(255,255,255,0.18)',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {a.title || a.label || 'Acción'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grupo de notificaciones
// ─────────────────────────────────────────────────────────────────────────────

function NotificationGroup({
  group,
  onOpen,
  onDismiss,
  onAction,
  onLongPress,
  onExpand,
}) {
  const [expanded, setExpanded] = useState(false);
  const notifications = group.notifications;
  const first = notifications[0];
  const rest = notifications.slice(1);

  const handleExpand = useCallback(() => {
    haptic('light');
    setExpanded((v) => !v);
    onExpand?.(group);
  }, [group, onExpand]);

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Stack visual: si hay más de una y no expandido, mostramos "N más" */}
      {rest.length > 0 && !expanded && (
        <div
          style={{
            position: 'relative',
            paddingLeft: 0,
            marginBottom: 6,
          }}
        >
          <div
            onClick={handleExpand}
            style={{
              borderRadius: 20,
              background: 'rgba(120,120,128,0.22)',
              backdropFilter: BLUR,
              WebkitBackdropFilter: BLUR,
              height: 40,
              marginBottom: -32,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 0,
              transform: 'scale(0.96)',
              transition: `transform 280ms ${SPRING}`,
            }}
          >
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>
              {rest.length} notificación{rest.length > 1 ? 'es' : ''} más
            </span>
          </div>
        </div>
      )}

      {/* Notificación principal o todas si expandido */}
      {expanded ? (
        notifications.map((n) => (
          <NotificationCard
            key={n.id || `${n.timestamp}-${Math.random()}`}
            notification={n}
            expanded
            onOpen={onOpen}
            onDismiss={onDismiss}
            onAction={onAction}
            onLongPress={onLongPress}
          />
        ))
      ) : (
        <NotificationCard
          notification={first}
          expanded={false}
          onOpen={onOpen}
          onDismiss={onDismiss}
          onAction={onAction}
          onLongPress={onLongPress}
        />
      )}

      {/* Botón "Mostrar menos" al final del grupo expandido */}
      {expanded && rest.length > 0 && (
        <button
          onClick={handleExpand}
          style={{
            width: '100%',
            padding: '8px 0',
            borderRadius: 14,
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.55)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Mostrar menos
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay de acciones rápidas (long-press)
// ─────────────────────────────────────────────────────────────────────────────

function ActionSheet({ notification, onClose, onAction, onDismiss }) {
  if (!notification) return null;
  const actions = [
    { id: 'reply', label: 'Responder', icon: <ReplyIcon /> },
    { id: 'markRead', label: 'Marcar como leída', icon: <MarkReadIcon /> },
    { id: 'mute', label: 'Silenciar 1 hora', icon: <MuteIcon /> },
    { id: 'dismiss', label: 'Eliminar', icon: <TrashIcon />, danger: true },
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: PANEL_PADDING,
        animation: 'nc-fade-in 220ms ease both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          borderRadius: 26,
          background: 'rgba(40,40,45,0.92)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          overflow: 'hidden',
          marginBottom: 10,
        }}
      >
        {/* Preview */}
        <div
          style={{
            padding: 16,
            borderBottom: '0.5px solid rgba(255,255,255,0.1)',
            color: '#fff',
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
            {notification.app || notification.appName || 'App'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {notification.title || 'Notificación'}
          </div>
        </div>
        {/* Acciones */}
        {actions.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              haptic('light');
              if (a.id === 'dismiss') onDismiss?.(notification);
              else onAction?.(notification, a);
              onClose?.();
            }}
            style={{
              width: '100%',
              padding: '15px 16px',
              background: 'transparent',
              border: 'none',
              borderTop: '0.5px solid rgba(255,255,255,0.08)',
              color: a.danger ? '#ff453a' : '#fff',
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              textAlign: 'left',
            }}
          >
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <button
        onClick={onClose}
        style={{
          padding: '15px',
          borderRadius: 26,
          border: 'none',
          background: 'rgba(40,40,45,0.92)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          color: '#fff',
          fontSize: 15,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Cancelar
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NotificationCenterUI
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {Function} props.onClose
 * @param {Function} [props.onOpenApp]     (bundleId) => void
 * @param {boolean} [props.showWidgets=true]
 * @param {boolean} [props.grouped=true]
 * @param {Object}  [props.weather]         { temp, condition, city }
 */
export default function NotificationCenterUI({
  open,
  onClose,
  onOpenApp,
  showWidgets = true,
  grouped = true,
  weather,
}) {
  const os = useOS();
  const snap = os?.snapshot || {};
  const [actionSheet, setActionSheet] = useState(null);
  const [drag, setDrag] = useState({ y: 0, dragging: false });
  const dragStart = useRef(null);

  // ── Notificaciones del snapshot ───────────────────────────────────────────
  const notifications = useMemo(() => {
    let list = [];
    if (os?.notifications?.list) {
      try { list = os.notifications.list() || []; } catch { list = []; }
    }
    if (!Array.isArray(list) || list.length === 0) {
      list = snap.notifications || [];
    }
    return list.map((n) => ({
      id: n.id || `${n.bundleId}-${n.timestamp}-${Math.random()}`,
      bundleId: n.bundleId,
      app: n.app || n.appName || (n.bundleId ? n.bundleId.split('.').pop() : 'App'),
      appColor: n.appColor,
      color: n.color,
      icon: n.icon,
      title: n.title,
      body: n.body,
      timestamp: n.timestamp || n.time || Date.now(),
      threadId: n.threadId,
      actions: n.actions || [],
      isRead: n.isRead,
    }));
  }, [os?.notifications, snap.notifications]);

  // ── Agrupar ───────────────────────────────────────────────────────────────
  const groups = useMemo(
    () => (grouped ? groupNotifications(notifications) : notifications.map((n) => ({
      key: n.id,
      app: n.app,
      notifications: [n],
      latestTs: n.timestamp,
    }))),
    [notifications, grouped]
  );

  // Separar "recientes" (< 24h) y "antiguas"
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const { recent, old } = useMemo(() => {
    const r = [], o = [];
    for (const g of groups) {
      if (now - g.latestTs < DAY) r.push(g);
      else o.push(g);
    }
    return { recent: r, old: o };
  }, [groups, now]);

  const [showOld, setShowOld] = useState(false);

  // ── Acciones sobre notificaciones ─────────────────────────────────────────
  const handleDismiss = useCallback((n) => {
    try {
      os?.notifications?.dismiss?.(n.id);
    } catch { /* ignore */ }
    // Actualizar snapshot si la API no refresca
    haptic('light');
  }, [os]);

  const handleClearAll = useCallback(() => {
    if (!window.confirm('¿Borrar todas las notificaciones?')) return;
    try {
      os?.notifications?.clearAll?.();
    } catch { /* ignore */ }
    haptic('medium');
  }, [os]);

  const handleOpen = useCallback((n) => {
    haptic('light');
    try {
      os?.notifications?.markRead?.(n.id);
    } catch { /* ignore */ }
    if (n.bundleId) onOpenApp?.(n.bundleId);
    onClose?.();
  }, [os, onOpenApp, onClose]);

  const handleAction = useCallback((n, action) => {
    try {
      os?.notifications?.performAction?.(n.id, action.id);
    } catch { /* ignore */ }
    if (action.id === 'dismiss') handleDismiss(n);
    haptic('light');
  }, [os, handleDismiss]);

  // ── Gestos de cierre ──────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (e.target.closest('[data-nc-interactive]')) return;
    dragStart.current = { y: e.clientY, t: performance.now() };
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dy = Math.max(0, e.clientY - dragStart.current.y);
    setDrag({ y: dy, dragging: true });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    const dy = drag.y;
    dragStart.current = null;
    if (dy > DRAG_CLOSE_THRESHOLD) {
      onClose?.();
    }
    setDrag({ y: 0, dragging: false });
  }, [drag.y, onClose]);

  // ── Escape ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const hasAny = recent.length > 0 || old.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 850,
        background: open ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0)',
        backdropFilter: open ? 'blur(2px)' : 'none',
        WebkitBackdropFilter: open ? 'blur(2px)' : 'none',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'background 320ms ease, backdrop-filter 320ms ease',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-nc-interactive
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          maxHeight: '100%',
          padding: `70px ${PANEL_PADDING}px 40px`,
          display: 'flex',
          flexDirection: 'column',
          transform: open ? `translateY(${drag.y}px)` : 'translateY(-102%)',
          opacity: open ? Math.max(0.4, 1 - drag.y / 700) : 0,
          transition: drag.dragging
            ? 'none'
            : `transform 520ms ${SPRING}, opacity 320ms ease`,
          willChange: 'transform, opacity',
          touchAction: 'none',
        }}
      >
        <style>{`
          @keyframes nc-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes nc-slide-in {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* ── Scroll interior ──────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingRight: 4,
            paddingBottom: 20,
            animation: open ? 'nc-fade-in 260ms ease 100ms both' : 'none',
          }}
        >
          {/* Widgets */}
          {showWidgets && <WidgetsRow os={os} weather={weather} />}

          {/* Barra de título + limpiar */}
          {hasAny && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
                paddingLeft: 4,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.7)',
                  letterSpacing: 0.3,
                }}
              >
                NOTIFICACIONES
              </span>
              <button
                onClick={handleClearAll}
                style={{
                  background: 'rgba(120,120,128,0.35)',
                  border: 'none',
                  borderRadius: 14,
                  padding: '5px 10px',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <CloseIcon size={10} />
                Borrar
              </button>
            </div>
          )}

          {/* Sin notificaciones */}
          {!hasAny && (
            <div
              style={{
                color: 'rgba(255,255,255,0.45)',
                textAlign: 'center',
                fontSize: 13,
                marginTop: 40,
                lineHeight: 1.5,
              }}
            >
              No hay notificaciones nuevas
            </div>
          )}

          {/* Recientes */}
          {recent.map((g, i) => (
            <div
              key={g.key}
              style={{
                animation: open ? `nc-slide-in 340ms ${SPRING} ${i * 40}ms both` : 'none',
              }}
            >
              <NotificationGroup
                group={g}
                onOpen={handleOpen}
                onDismiss={handleDismiss}
                onAction={handleAction}
                onLongPress={(n) => setActionSheet(n)}
              />
            </div>
          ))}

          {/* Antiguas (plegables) */}
          {old.length > 0 && (
            <>
              <button
                onClick={() => { haptic('light'); setShowOld((v) => !v); }}
                style={{
                  width: '100%',
                  padding: '12px 0',
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <ChevronIcon dir={showOld ? 'up' : 'down'} size={12} />
                Notificaciones antiguas ({old.length})
              </button>

              {showOld && old.map((g, i) => (
                <div
                  key={g.key}
                  style={{
                    animation: `nc-slide-in 340ms ${SPRING} ${i * 40}ms both`,
                  }}
                >
                  <NotificationGroup
                    group={g}
                    onOpen={handleOpen}
                    onDismiss={handleDismiss}
                    onAction={handleAction}
                    onLongPress={(n) => setActionSheet(n)}
                  />
                </div>
              ))}
            </>
          )}
        </div>

        {/* Home indicator */}
        <div
          style={{
            height: 5,
            width: 80,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.35)',
            alignSelf: 'center',
            marginTop: 8,
          }}
        />
      </div>

      {/* Action sheet de long-press */}
      {actionSheet && (
        <ActionSheet
          notification={actionSheet}
          onClose={() => setActionSheet(null)}
          onAction={handleAction}
          onDismiss={handleDismiss}
        />
      )}
    </div>
  );
}
