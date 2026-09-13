// src/apps/Settings.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Settings
//
// App Ajustes completa. Estructura de navegación por stack:
//   root → sección → subsección → ...
// Cada pantalla es un "screen" definido en un mapa. El stack mantiene la
// historia y permite volver con el botón atrás (o swipe desde el borde).
//
// Secciones raíz:
//   • Buscar (barra de búsqueda global)
//   • Modo Avión / WiFi / Bluetooth / Datos móviles
//   • Notificaciones / Sonidos / Concentración / Pantalla / Batería
//   • General (Información, Actualización, Almacenamiento, Fecha, Idioma…)
//   • Face ID y código / Emergencia SOS / Privacidad y seguridad
//   • Accesibilidad / Fondo de pantalla / Siri / Apple Pencil
//
// Todos los toggles escriben al OSContext → drivers V* reales.
// Sin librerías externas.
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
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG
// ─────────────────────────────────────────────────────────────────────────────

const I = {
  airplane: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2 L13 9 L21 13 V15 L13 13 L13 19 L16 21 V22 L12 21 L8 22 V21 L11 19 L11 13 L3 15 V13 L11 9 Z" fill={c} /></svg>
  ),
  wifi: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M3 9 a13 13 0 0 1 18 0" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M6 12.5 a9 9 0 0 1 12 0" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M9 16 a5 5 0 0 1 6 0" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round"/><circle cx="12" cy="19" r="1.6" fill={c}/></svg>
  ),
  bluetooth: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M7 7 L17 17 L12 21 V3 L17 7 L7 17" stroke={c} strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round"/></svg>
  ),
  cellular: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="15" width="3" height="6" rx="1" fill={c}/><rect x="8" y="11" width="3" height="10" rx="1" fill={c}/><rect x="13" y="7" width="3" height="14" rx="1" fill={c}/><rect x="18" y="3" width="3" height="18" rx="1" fill={c}/></svg>
  ),
  bell: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M18 16 v-5 a6 6 0 1 0 -12 0 v5 l-2 2 h16 z" fill={c}/><path d="M10 20 a2 2 0 0 0 4 0" stroke={c} strokeWidth="2" fill="none"/></svg>
  ),
  speaker: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 9 h4 l4 -4 v14 l-4 -4 h-4 z" fill={c}/><path d="M15 8 a5 5 0 0 1 0 8" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M18 5 a9 9 0 0 1 0 14" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7"/></svg>
  ),
  moon: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M20 14 a9 9 0 1 1 -10 -10 7 7 0 0 0 10 10 z" fill={c}/></svg>
  ),
  brightness: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill={c}/><path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" stroke={c} strokeWidth="1.8" strokeLinecap="round"/></svg>
  ),
  battery: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="2" y="8" width="18" height="9" rx="2" stroke={c} strokeWidth="1.6" fill="none"/><rect x="4" y="10" width="13" height="5" rx="1" fill="#34c759"/><rect x="20.5" y="10.5" width="1.5" height="4" rx="0.6" fill={c}/></svg>
  ),
  gear: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={c} strokeWidth="1.8" fill="none"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" stroke={c} strokeWidth="1.6" fill="none"/></svg>
  ),
  faceid: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 8 V5 a1 1 0 0 1 1 -1 h3 M20 8 V5 a1 1 0 0 0 -1 -1 h-3 M4 16 v3 a1 1 0 0 0 1 1 h3 M20 16 v3 a1 1 0 0 1 -1 1 h-3 M9 10 v2 M15 10 v2 M12 13 v3 M9 17 q3 2 6 0" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>
  ),
  lock: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" fill={c}/><path d="M8 11 V7 a4 4 0 1 1 8 0 v4" stroke={c} strokeWidth="2" fill="none"/></svg>
  ),
  shield: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z" fill={c}/></svg>
  ),
  accessibility: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4.5" r="2" fill={c}/><path d="M4 8 h16 M12 8 v6 M9 20 L12 14 L15 20" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  wallpaper: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke={c} strokeWidth="1.8" fill="none"/><circle cx="8" cy="9" r="1.5" fill={c}/><path d="M3 18 L9 12 L13 16 L17 12 L21 16" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  siri: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.8" fill="none"/><circle cx="12" cy="12" r="3" fill={c}/></svg>
  ),
  storage: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="8" ry="3" stroke={c} strokeWidth="1.6" fill="none"/><path d="M4 6 v12 c0 1.66 3.58 3 8 3 s8 -1.34 8 -3 V6" stroke={c} strokeWidth="1.6" fill="none"/><path d="M4 12 c0 1.66 3.58 3 8 3 s8 -1.34 8 -3" stroke={c} strokeWidth="1.6" fill="none"/></svg>
  ),
  info: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={c} strokeWidth="1.8" fill="none"/><path d="M12 8 v.01 M11 11 h1 v6" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>
  ),
  update: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M20 5 v5 h-5 M4 19 v-5 h5" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 10 a7 7 0 0 0 -13 -3 L4 10 M5 14 a7 7 0 0 0 13 3 L20 14" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  language: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.8" fill="none"/><path d="M3 12 H21 M12 3 a15 15 0 0 1 0 18 M12 3 a15 15 0 0 0 0 18" stroke={c} strokeWidth="1.4" fill="none"/></svg>
  ),
  clock: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.8" fill="none"/><path d="M12 7 v5 l3 2" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>
  ),
  keyboard: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="12" rx="2" stroke={c} strokeWidth="1.6" fill="none"/><path d="M6 10 h.01 M10 10 h.01 M14 10 h.01 M18 10 h.01 M6 14 h12" stroke={c} strokeWidth="1.8" strokeLinecap="round"/></svg>
  ),
  privacy: (c = '#fff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z" stroke={c} strokeWidth="1.6" fill="none"/><path d="M9 12 L11 14 L15 10" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  chevron: (c = 'rgba(255,255,255,0.32)', s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M9 6 L15 12 L9 18" stroke={c} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  back: (c = '#0a84ff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M15 6 L9 12 L15 18" stroke={c} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  search: (c = 'rgba(255,255,255,0.5)', s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke={c} strokeWidth="2" fill="none"/><path d="M16 16 L21 21" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Componentes base
// ─────────────────────────────────────────────────────────────────────────────

/** Icono cuadrado con color de fondo (estilo iOS Settings). */
function SectionIcon({ render, bg, size = 28 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.26,
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {typeof render === 'function' ? render('#fff', size * 0.68) : render}
    </div>
  );
}

/** Fila con icono, título, valor opcional, y chevron. */
function Row({ icon, bg, title, value, onTap, last, danger, subtitle }) {
  return (
    <div
      onClick={() => { if (onTap) { haptic('light'); onTap(); } }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 16px',
        cursor: onTap ? 'pointer' : 'default',
        borderBottom: last ? 'none' : '0.5px solid rgba(255,255,255,0.08)',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {icon && <SectionIcon render={icon} bg={bg || '#8e8e93'} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: danger ? '#ff453a' : '#fff',
            fontSize: 16,
            fontWeight: 400,
            letterSpacing: -0.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ marginTop: 2, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {value != null && (
        <div
          style={{
            color: 'rgba(255,255,255,0.5)',
            fontSize: 15,
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </div>
      )}
      {onTap && I.chevron()}
    </div>
  );
}

/** Toggle iOS. */
function Toggle({ value, onChange, disabled }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        haptic('light');
        onChange?.(!value);
      }}
      disabled={disabled}
      style={{
        width: 51,
        height: 31,
        borderRadius: 16,
        border: 'none',
        background: value ? '#34c759' : 'rgba(120,120,128,0.32)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        transition: 'background 200ms ease',
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
      aria-checked={value}
      role="switch"
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: value ? 22 : 2,
          width: 27,
          height: 27,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 2px 6px rgba(0,0,0,0.28)',
          transition: 'left 200ms cubic-bezier(.22,1,.36,1)',
        }}
      />
    </button>
  );
}

/** Fila con toggle. */
function ToggleRow({ icon, bg, title, value, onChange, last, disabled }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 16px',
        borderBottom: last ? 'none' : '0.5px solid rgba(255,255,255,0.08)',
      }}
    >
      {icon && <SectionIcon render={icon} bg={bg || '#8e8e93'} />}
      <div style={{ flex: 1, color: '#fff', fontSize: 16, letterSpacing: -0.2 }}>
        {title}
      </div>
      <Toggle value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** Slider horizontal. */
function Slider({ value, onChange, min = 0, max = 1, step = 0.01 }) {
  const ref = useRef(null);
  const dragging = useRef(false);
  const compute = (e) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const v = min + (x / rect.width) * (max - min);
    onChange?.(Math.round(v / step) * step);
  };
  const onDown = (e) => { dragging.current = true; compute(e); e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { if (dragging.current) compute(e); };
  const onUp = () => { dragging.current = false; };
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{
        flex: 1,
        height: 28,
        position: 'relative',
        cursor: 'pointer',
        touchAction: 'none',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, background: 'rgba(120,120,128,0.32)' }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 4, borderRadius: 2, background: '#fff' }} />
      <div
        style={{
          position: 'absolute',
          left: `calc(${pct}% - 14px)`,
          width: 28, height: 28, borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 2px 6px rgba(0,0,0,0.28)',
        }}
      />
    </div>
  );
}

/** Card de sección (agrupa filas). */
function Section({ children, title, footer }) {
  return (
    <div style={{ marginBottom: 22 }}>
      {title && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: 'rgba(255,255,255,0.5)',
            padding: '0 28px 6px',
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          margin: '0 16px',
          background: 'rgba(28,28,30,0.9)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
      {footer && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', padding: '6px 28px 0', lineHeight: 1.4 }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes de pantalla específicos
// ─────────────────────────────────────────────────────────────────────────────

function RootScreen({ os, navigate }) {
  const snap = os?.snapshot || {};
  const airplane = !!snap.cellular?.airplaneMode;
  const wifi = snap.wifi?.enabled !== false;
  const bt = !!snap.bluetooth?.enabled;
  const cell = snap.cellular?.enabled !== false;
  const focus = snap.focus?.active;
  const btName = snap.bluetooth?.connected ? (snap.bluetooth.name || 'Conectado') : 'Desactivado';

  return (
    <div>
      <Section>
        <ToggleRow
          icon={I.airplane}
          bg="#ff9500"
          title="Modo avión"
          value={airplane}
          onChange={() => os?.toggleAirplaneMode?.()}
        />
        <Row
          icon={I.wifi}
          bg="#0a84ff"
          title="Wi-Fi"
          value={wifi ? (snap.wifi?.ssid || 'Activado') : 'Desactivado'}
          onTap={() => navigate('wifi')}
        />
        <Row
          icon={I.bluetooth}
          bg="#0a84ff"
          title="Bluetooth"
          value={btName}
          onTap={() => navigate('bluetooth')}
        />
        <Row
          icon={I.cellular}
          bg="#34c759"
          title="Datos móviles"
          value={cell ? 'Activado' : 'Desactivado'}
          onTap={() => navigate('cellular')}
          last
        />
      </Section>

      <Section>
        <Row icon={I.bell} bg="#ff3b30" title="Notificaciones" onTap={() => navigate('notifications')} />
        <Row icon={I.speaker} bg="#ff2d55" title="Sonidos y vibración" onTap={() => navigate('sounds')} />
        <Row
          icon={I.moon}
          bg="#5e5ce6"
          title="Concentración"
          value={focus ? (focus.label || 'Activada') : 'Desactivada'}
          onTap={() => navigate('focus')}
        />
        <Row icon={I.clock} bg="#1c1c1e" title="Tiempo de uso" onTap={() => navigate('screentime')} last />
      </Section>

      <Section>
        <Row icon={I.gear} bg="#8e8e93" title="General" onTap={() => navigate('general')} />
        <Row icon={I.accessibility} bg="#007aff" title="Accesibilidad" onTap={() => navigate('accessibility')} />
        <Row icon={I.wallpaper} bg="#5ac8fa" title="Fondo de pantalla" onTap={() => navigate('wallpaper')} />
        <Row icon={I.siri} bg="#af52de" title="Siri y Buscar" onTap={() => navigate('siri')} />
        <Row icon={I.faceid} bg="#34c759" title="Face ID y código" onTap={() => navigate('faceid')} last />
      </Section>

      <Section>
        <Row icon={I.privacy} bg="#0a84ff" title="Privacidad y seguridad" onTap={() => navigate('privacy')} last />
      </Section>

      <div style={{ textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '12px 0 24px' }}>
        iOS Remastered · 1.0.0
      </div>
    </div>
  );
}

function WifiScreen({ os }) {
  const snap = os?.snapshot || {};
  const enabled = snap.wifi?.enabled !== false;
  const ssid = snap.wifi?.ssid;
  const networks = snap.wifi?.available || [
    { ssid: 'Casa-5G', signal: 3, secure: true },
    { ssid: 'Vecino_2.4G', signal: 2, secure: true },
    { ssid: 'Cafe-Guest', signal: 1, secure: false },
  ];
  return (
    <div>
      <Section>
        <ToggleRow
          icon={I.wifi}
          bg="#0a84ff"
          title="Wi-Fi"
          value={enabled}
          onChange={() => os?.toggleWifi?.()}
          last
        />
      </Section>
      {enabled && (
        <>
          <Section title="Mis redes">
            {ssid && (
              <Row
                icon={(c, s) => I.wifi('#0a84ff', s)}
                bg="rgba(10,132,255,0.15)"
                title={ssid}
                subtitle="Conectado"
                onTap={() => os?.disconnectWifi?.()}
                last
              />
            )}
            {!ssid && (
              <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
                Sin conexión
              </div>
            )}
          </Section>
          <Section title="Otras redes">
            {networks.map((n, i) => (
              <Row
                key={n.ssid}
                icon={(c, s) => I.wifi(c, s)}
                bg="rgba(120,120,128,0.3)"
                title={n.ssid}
                value={n.secure ? '🔒' : ''}
                onTap={() => os?.connectWifi?.(n.ssid)}
                last={i === networks.length - 1}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

function BluetoothScreen({ os }) {
  const snap = os?.snapshot || {};
  const enabled = !!snap.bluetooth?.enabled;
  const devices = snap.bluetooth?.devices || [
    { id: 'airpods', name: 'AirPods Pro', connected: !!snap.bluetooth?.connected, type: 'audio' },
    { id: 'watch', name: 'Apple Watch', connected: false, type: 'watch' },
  ];
  return (
    <div>
      <Section>
        <ToggleRow
          icon={I.bluetooth}
          bg="#0a84ff"
          title="Bluetooth"
          value={enabled}
          onChange={() => os?.toggleBluetooth?.()}
          last
        />
      </Section>
      {enabled && (
        <Section title="Mis dispositivos">
          {devices.map((d, i) => (
            <Row
              key={d.id}
              icon={I.bluetooth}
              bg="rgba(10,132,255,0.15)"
              title={d.name}
              value={d.connected ? 'Conectado' : 'No conectado'}
              onTap={() => os?.toggleBluetoothDevice?.(d.id)}
              last={i === devices.length - 1}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function CellularScreen({ os }) {
  const snap = os?.snapshot || {};
  const enabled = snap.cellular?.enabled !== false;
  const roaming = !!snap.cellular?.roaming;
  return (
    <div>
      <Section>
        <ToggleRow icon={I.cellular} bg="#34c759" title="Datos móviles" value={enabled} onChange={() => os?.toggleCellular?.()} />
        <ToggleRow icon={I.cellular} bg="#34c759" title="Itinerancia de datos" value={roaming} onChange={() => os?.toggleRoaming?.()} last />
      </Section>
      <Section title="Datos móviles">
        <Row title="Opciones de datos" value={snap.cellular?.type || '5G'} onTap={() => {}} />
        <Row title="Uso actual" value={`${snap.cellular?.usage?.toFixed(1) || '0.0'} GB`} onTap={() => {}} last />
      </Section>
    </div>
  );
}

function NotificationsScreen({ os }) {
  const snap = os?.snapshot || {};
  const showPreview = snap.notifications?.showPreviews !== false;
  const sounds = snap.notifications?.sounds !== false;
  return (
    <div>
      <Section title="Mostrar avisos">
        <ToggleRow icon={I.bell} bg="#ff3b30" title="Mostrar en pantalla bloqueada" value={showPreview} onChange={(v) => os?.setNotificationSettings?.({ showPreviews: v })} />
        <ToggleRow icon={I.bell} bg="#ff3b30" title="Sonidos" value={sounds} onChange={(v) => os?.setNotificationSettings?.({ sounds: v })} last />
      </Section>
      <Section title="Apps">
        <Row title="Ver todas las apps" onTap={() => {}} last />
      </Section>
    </div>
  );
}

function SoundsScreen({ os }) {
  const snap = os?.snapshot || {};
  const [volume, setVolume] = useState(snap.audio?.volume ?? 0.6);
  const changeVolume = (v) => {
    setVolume(v);
    os?.setVolume?.(v);
  };
  return (
    <div>
      <Section title="Timbre y alertas">
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18, color: 'rgba(255,255,255,0.5)' }}>🔈</span>
          <Slider value={volume} onChange={changeVolume} />
          <span style={{ fontSize: 18, color: 'rgba(255,255,255,0.9)' }}>🔊</span>
        </div>
      </Section>
      <Section>
        <Row title="Tono de llamada" value={snap.audio?.ringtone || 'Reflection'} onTap={() => {}} />
        <Row title="Tono de mensaje" value={snap.audio?.messageTone || 'Note'} onTap={() => {}} last />
      </Section>
    </div>
  );
}

function FocusScreen({ os }) {
  const focus = os?.snapshot?.focus;
  const modes = ['No molestar', 'Trabajo', 'Personal', 'Sueño', 'Conducción'];
  return (
    <div>
      <Section title="Modos">
        {modes.map((m, i) => (
          <Row
            key={m}
            icon={I.moon}
            bg="#5e5ce6"
            title={m}
            value={focus?.label === m ? 'Activado' : ''}
            onTap={() => os?.setFocus?.(focus?.label === m ? null : { label: m })}
            last={i === modes.length - 1}
          />
        ))}
      </Section>
    </div>
  );
}

function GeneralScreen({ os, navigate }) {
  const snap = os?.snapshot || {};
  return (
    <div>
      <Section>
        <Row icon={I.info} bg="#8e8e93" title="Información" onTap={() => navigate('about')} />
        <Row icon={I.update} bg="#007aff" title="Actualización de software" value="Al día" onTap={() => navigate('update')} />
        <Row icon={I.storage} bg="#ff9500" title="Almacenamiento" value={`${snap.storage?.usedPct?.toFixed(0) || 0}% usado`} onTap={() => navigate('storage')} last />
      </Section>
      <Section>
        <Row icon={I.clock} bg="#1c1c1e" title="Fecha y hora" onTap={() => navigate('datetime')} />
        <Row icon={I.keyboard} bg="#1c1c1e" title="Teclado" onTap={() => navigate('keyboard')} />
        <Row icon={I.language} bg="#0a84ff" title="Idioma y región" value="Español" onTap={() => navigate('language')} />
        <Row icon={I.update} bg="#8e8e93" title="Restablecer" onTap={() => navigate('reset')} last />
      </Section>
    </div>
  );
}

function AboutScreen({ os }) {
  const snap = os?.snapshot || {};
  const rows = [
    ['Nombre', snap.device?.name || 'iPhone de iOS Remastered'],
    ['Versión de iOS', 'Remastered 1.0.0'],
    ['Nombre del modelo', snap.device?.model || 'iPhone 15 Pro (simulado)'],
    ['Número de serie', 'IOSR-X0001'],
    ['Capacidad', formatBytes(snap.storage?.total || 256 * 1024 * 1024 * 1024)],
    ['Disponible', formatBytes(snap.storage?.free || 128 * 1024 * 1024 * 1024)],
  ];
  return (
    <div>
      <Section>
        {rows.map(([k, v], i) => (
          <div
            key={k}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '11px 16px',
              borderBottom: i === rows.length - 1 ? 'none' : '0.5px solid rgba(255,255,255,0.08)',
              fontSize: 15,
            }}
          >
            <span style={{ color: '#fff' }}>{k}</span>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>{v}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

function StorageScreen({ os }) {
  const snap = os?.snapshot || {};
  const total = snap.storage?.total || 256 * 1024 * 1024 * 1024;
  const used = snap.storage?.used || 96 * 1024 * 1024 * 1024;
  const free = total - used;
  const pct = (used / total) * 100;
  return (
    <div>
      <Section title="Uso del almacenamiento">
        <div style={{ padding: 16 }}>
          <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'rgba(120,120,128,0.3)', marginBottom: 12 }}>
            <div style={{ width: `${Math.min(60, pct)}%`, background: '#ff9500' }} />
            <div style={{ width: `${Math.min(20, pct - 60)}%`, background: '#5ac8fa' }} />
            <div style={{ width: `${Math.min(15, pct - 80)}%`, background: '#af52de' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
            <span>Usado: {formatBytes(used)}</span>
            <span>Libre: {formatBytes(free)}</span>
          </div>
        </div>
      </Section>
      <Section title="Por categoría">
        <Row title="Apps" value={formatBytes(used * 0.4)} />
        <Row title="Fotos" value={formatBytes(used * 0.3)} />
        <Row title="Música" value={formatBytes(used * 0.15)} />
        <Row title="Sistema" value={formatBytes(used * 0.15)} last />
      </Section>
    </div>
  );
}

function FaceIdScreen({ os }) {
  const snap = os?.snapshot || {};
  const [faceId, setFaceId] = useState(snap.security?.faceId !== false);
  const [attention, setAttention] = useState(snap.security?.attention ?? true);
  const [passcode, setPasscode] = useState(!!snap.security?.passcode);
  return (
    <div>
      <Section footer="Face ID se usa para desbloquear el dispositivo, autenticarte en apps y pagar.">
        <ToggleRow icon={I.faceid} bg="#34c759" title="Usar Face ID" value={faceId} onChange={(v) => { setFaceId(v); os?.setSecurity?.({ faceId: v }); }} />
        <ToggleRow icon={I.faceid} bg="#34c759" title="Requerir atención" value={attention} onChange={(v) => { setAttention(v); os?.setSecurity?.({ attention: v }); }} last />
      </Section>
      <Section>
        <Row icon={I.lock} bg="#0a84ff" title="Cambiar código" value={passcode ? 'Activado' : 'Desactivado'} onTap={() => os?.changePasscode?.()} last />
      </Section>
    </div>
  );
}

function PrivacyScreen() {
  const items = ['Ubicación', 'Contactos', 'Calendarios', 'Fotos', 'Bluetooth', 'Micrófono', 'Cámara', 'Salud', 'Movimiento y forma física'];
  return (
    <div>
      <Section title="Permisos">
        {items.map((it, i) => (
          <Row key={it} title={it} onTap={() => {}} last={i === items.length - 1} />
        ))}
      </Section>
    </div>
  );
}

function AccessibilityScreen({ os }) {
  const snap = os?.snapshot || {};
  const [largerText, setLargerText] = useState(snap.a11y?.largerText ?? false);
  const [reduceMotion, setReduceMotion] = useState(snap.a11y?.reduceMotion ?? false);
  const [reduceTransparency, setReduceTransparency] = useState(snap.a11y?.reduceTransparency ?? false);
  return (
    <div>
      <Section title="Visión">
        <ToggleRow icon={I.accessibility} bg="#007aff" title="Texto más grande" value={largerText} onChange={(v) => { setLargerText(v); os?.setAccessibility?.({ largerText: v }); }} />
        <ToggleRow icon={I.accessibility} bg="#007aff" title="Reducir movimiento" value={reduceMotion} onChange={(v) => { setReduceMotion(v); os?.setAccessibility?.({ reduceMotion: v }); }} />
        <ToggleRow icon={I.accessibility} bg="#007aff" title="Reducir transparencia" value={reduceTransparency} onChange={(v) => { setReduceTransparency(v); os?.setAccessibility?.({ reduceTransparency: v }); }} last />
      </Section>
    </div>
  );
}

function WallpaperScreen({ os }) {
  const wallpapers = [
    { id: 'default', name: 'Por defecto', bg: 'linear-gradient(160deg, #1c1c2e, #3b1f3d)' },
    { id: 'ocean', name: 'Océano', bg: 'linear-gradient(160deg, #007aff, #5ac8fa)' },
    { id: 'sunset', name: 'Atardecer', bg: 'linear-gradient(160deg, #ff9500, #ff3b30)' },
    { id: 'forest', name: 'Bosque', bg: 'linear-gradient(160deg, #34c759, #30b0c7)' },
    { id: 'mono', name: 'Monocromo', bg: 'linear-gradient(160deg, #000, #48484a)' },
  ];
  return (
    <div>
      <Section title="Fondos">
        {wallpapers.map((w, i) => (
          <div
            key={w.id}
            onClick={() => { haptic('light'); os?.setWallpaper?.(w.bg); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: 12,
              borderBottom: i === wallpapers.length - 1 ? 'none' : '0.5px solid rgba(255,255,255,0.08)',
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 44, height: 60, borderRadius: 6, background: w.bg, flexShrink: 0 }} />
            <span style={{ color: '#fff', fontSize: 15 }}>{w.name}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

function SearchResults({ query, onNavigate }) {
  const q = query.toLowerCase();
  const all = [
    { title: 'Wi-Fi', screen: 'wifi' },
    { title: 'Bluetooth', screen: 'bluetooth' },
    { title: 'Datos móviles', screen: 'cellular' },
    { title: 'Notificaciones', screen: 'notifications' },
    { title: 'Sonidos y vibración', screen: 'sounds' },
    { title: 'Concentración', screen: 'focus' },
    { title: 'General', screen: 'general' },
    { title: 'Almacenamiento', screen: 'storage' },
    { title: 'Face ID y código', screen: 'faceid' },
    { title: 'Privacidad y seguridad', screen: 'privacy' },
    { title: 'Accesibilidad', screen: 'accessibility' },
    { title: 'Fondo de pantalla', screen: 'wallpaper' },
    { title: 'Siri y Buscar', screen: 'siri' },
  ];
  const results = all.filter((i) => i.title.toLowerCase().includes(q));
  return (
    <Section>
      {results.length === 0 && (
        <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center' }}>
          Sin resultados
        </div>
      )}
      {results.map((r, i) => (
        <Row key={r.screen} title={r.title} onTap={() => onNavigate(r.screen)} last={i === results.length - 1} />
      ))}
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapa de pantallas
// ─────────────────────────────────────────────────────────────────────────────

const SCREENS = {
  root:          { title: 'Ajustes',                  render: RootScreen },
  wifi:          { title: 'Wi-Fi',                    render: WifiScreen },
  bluetooth:     { title: 'Bluetooth',                render: BluetoothScreen },
  cellular:      { title: 'Datos móviles',            render: CellularScreen },
  notifications: { title: 'Notificaciones',           render: NotificationsScreen },
  sounds:        { title: 'Sonidos y vibración',      render: SoundsScreen },
  focus:         { title: 'Concentración',            render: FocusScreen },
  general:       { title: 'General',                  render: GeneralScreen },
  about:         { title: 'Información',              render: AboutScreen },
  storage:       { title: 'Almacenamiento',           render: StorageScreen },
  faceid:        { title: 'Face ID y código',         render: FaceIdScreen },
  privacy:       { title: 'Privacidad y seguridad',   render: PrivacyScreen },
  accessibility: { title: 'Accesibilidad',            render: AccessibilityScreen },
  wallpaper:     { title: 'Fondo de pantalla',        render: WallpaperScreen },
  update:        { title: 'Actualización',            render: () => <Section><Row title="iOS Remastered está al día" last /></Section> },
  datetime:      { title: 'Fecha y hora',             render: () => <Section><Row title="Automático" value="Activado" last /></Section> },
  keyboard:      { title: 'Teclado',                  render: () => <Section><Row title="Teclados" value="Español, Inglés" last /></Section> },
  language:      { title: 'Idioma y región',          render: () => <Section><Row title="Idioma" value="Español" last /></Section> },
  reset:         { title: 'Restablecer',              render: () => <Section><Row title="Restablecer todo el contenido" danger onTap={() => {}} last /></Section> },
  screentime:    { title: 'Tiempo de uso',            render: () => <Section><Row title="Hoy" value="0 min" last /></Section> },
  siri:          { title: 'Siri y Buscar',            render: () => <Section><Row title="Escuchar «Oye Siri»" value="Activado" last /></Section> },
};

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settings
 *
 * @param {Object} props
 * @param {Object} [props.os]      Contexto del OS (si no, se lee con useOS)
 * @param {Function} [props.onClose]
 * @param {string} [props.initialScreen='root']
 */
export default function Settings({ os: osProp, onClose, initialScreen = 'root' }) {
  const osCtx = useOS();
  const os = osProp || osCtx;

  const [stack, setStack] = useState([initialScreen]);
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const current = stack[stack.length - 1];
  const screen = SCREENS[current] || SCREENS.root;

  const navigate = useCallback((id) => {
    if (!SCREENS[id]) return;
    haptic('light');
    setStack((s) => [...s, id]);
  }, []);

  const goBack = useCallback(() => {
    haptic('light');
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  // Swipe desde el borde izquierdo → atrás
  const onPointerDown = useCallback((e) => {
    if (e.clientX > 40) return;
    if (stack.length <= 1) return;
    let moved = false;
    const move = (ev) => {
      if (ev.clientX - e.clientX > 80) {
        moved = true;
        goBack();
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
  }, [stack.length, goBack]);

  const Screen = screen.render;
  const showBack = stack.length > 1;

  const content = useMemo(() => {
    if (search.trim() && current === 'root') {
      return <SearchResults query={search} onNavigate={navigate} />;
    }
    return (
      <Screen
        os={os}
        navigate={navigate}
        goBack={goBack}
        screenId={current}
      />
    );
  }, [screen, os, navigate, goBack, current, search]);

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        color: '#fff',
        overflow: 'hidden',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Barra superior */}
      <div
        style={{
          paddingTop: 60,
          paddingBottom: 8,
          paddingLeft: showBack ? 8 : 16,
          paddingRight: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          position: 'relative',
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        {showBack && (
          <button
            onClick={goBack}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 6,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              color: '#0a84ff',
              fontSize: 17,
            }}
          >
            {I.back()}
            <span style={{ marginLeft: -4 }}>Ajustes</span>
          </button>
        )}
        <div
          style={{
            flex: 1,
            textAlign: showBack ? 'center' : 'left',
            paddingRight: showBack ? 60 : 0,
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: -0.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {screen.title}
        </div>
        {onClose && !showBack && (
          <button
            onClick={() => { haptic('light'); onClose(); }}
            style={{
              background: 'rgba(120,120,128,0.32)',
              border: 'none',
              borderRadius: 16,
              padding: '6px 14px',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Hecho
          </button>
        )}
      </div>

      {/* Buscador (solo en root) */}
      {current === 'root' && (
        <div style={{ padding: '8px 16px 0', flexShrink: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(120,120,128,0.24)',
              borderRadius: 10,
              padding: '7px 10px',
            }}
          >
            {I.search()}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Buscar"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#fff',
                fontSize: 15,
                fontFamily: 'inherit',
              }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                style={{
                  background: 'rgba(120,120,128,0.4)',
                  border: 'none',
                  borderRadius: '50%',
                  width: 18,
                  height: 18,
                  color: '#fff',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {/* Contenido */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingTop: 16,
          paddingBottom: 40,
        }}
      >
        {content}
      </div>

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
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
