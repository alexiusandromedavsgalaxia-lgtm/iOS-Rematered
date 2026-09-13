// src/ui/StatusBar.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — StatusBar
//
// Barra de estado superior estilo iOS (portrait). Muestra:
//   • Hora (izquierda), formato 12/24h, opcional segundos.
//   • Indicadores centrales: ubicación, grabación, llamada, hotspot, VPN,
//     alarma, rotación, Bluetooth, AirPlay.
//   • Derecha: señal cellular (barras), operador, WiFi, batería (icono+%),
//     modo avión.
//   • Tema light/dark automático según el fondo (prop o detección).
//   • Variante "compact" para cuando Dynamic Island está expandida.
//   • Respeta safe area top (59pt en iPhone 15 Pro).
//
// Todos los indicadores se leen de useOS() → snapshot / drivers.
// Sin librerías externas. SVG inline.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../context/OSContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_AREA_TOP = 59;
const HEIGHT = 54;

/** Colores por tema. */
const THEMES = {
  dark: {
    fg: '#ffffff',
    fgDim: 'rgba(255,255,255,0.55)',
    bg: 'transparent',
    batteryOutline: 'rgba(255,255,255,0.45)',
    batteryFill: '#ffffff',
    batteryLow: '#ff3b30',
    batteryCharging: '#34c759',
  },
  light: {
    fg: '#000000',
    fgDim: 'rgba(0,0,0,0.55)',
    bg: 'transparent',
    batteryOutline: 'rgba(0,0,0,0.45)',
    batteryFill: '#000000',
    batteryLow: '#ff3b30',
    batteryCharging: '#34c759',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(date, use24h, showSeconds) {
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  if (!use24h) h = h % 12 || 12;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return showSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/**
 * Determina si el tema debe ser light u oscuro según una imagen o color.
 * Como no podemos muestrear píxeles sin canvas, usamos una heurística:
 * si el wallpaper es un gradiente/color, calculamos luminancia media aproximada.
 * Si es una URL, asumimos dark por seguridad (la mayoría de locks son dark).
 */
function inferThemeFromWallpaper(wallpaper) {
  if (!wallpaper || typeof wallpaper !== 'string') return 'dark';
  if (wallpaper.startsWith('http') || wallpaper.startsWith('url(')) return 'dark';
  // Intentar extraer colores hex del gradiente
  const hexes = wallpaper.match(/#([0-9a-fA-F]{3,8})/g);
  if (!hexes || hexes.length === 0) return 'dark';
  let total = 0;
  let count = 0;
  for (const hex of hexes) {
    const h = hex.slice(1);
    let r, g, b;
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else continue;
    // Luminancia relativa (WCAG)
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    total += lum;
    count++;
  }
  if (count === 0) return 'dark';
  return total / count > 0.6 ? 'light' : 'dark';
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline
// ─────────────────────────────────────────────────────────────────────────────

function CellularIcon({ bars = 4, fg = '#fff', dim = 'rgba(255,255,255,0.35)' }) {
  // 4 barras de altura creciente
  const heights = [4, 6, 8, 10];
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" fill="none" aria-label="Señal">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 4.2}
          y={12 - h}
          width="3"
          height={h}
          rx="0.8"
          fill={i < bars ? fg : dim}
        />
      ))}
    </svg>
  );
}

function WifiIcon({ level = 3, fg = '#fff', dim = 'rgba(255,255,255,0.3)', off = false }) {
  // 3 arcos concéntricos + punto. level: 0..3
  const arcs = [
    { r: 9,  opacity: 0.35 },
    { r: 6,  opacity: 0.65 },
    { r: 3,  opacity: 1.0  },
  ];
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-label="WiFi">
      {off ? (
        <>
          <path d="M2 5 Q8 0 14 5" stroke={dim} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M4 7 Q8 4 12 7" stroke={dim} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <circle cx="8" cy="9.6" r="1" fill={dim} />
          <path d="M2.5 10.5 L13.5 1.5" stroke={fg} strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          {arcs.map((a, i) => {
            // arc from angle -140° to -40°
            const cx = 8, cy = 10;
            const startA = (-140 * Math.PI) / 180;
            const endA = (-40 * Math.PI) / 180;
            const x1 = cx + a.r * Math.cos(startA);
            const y1 = cy + a.r * Math.sin(startA);
            const x2 = cx + a.r * Math.cos(endA);
            const y2 = cy + a.r * Math.sin(endA);
            const visible = i < level;
            return (
              <path
                key={i}
                d={`M${x1} ${y1} A${a.r} ${a.r} 0 0 1 ${x2} ${y2}`}
                stroke={visible ? fg : dim}
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            );
          })}
          <circle cx="8" cy="10" r="1.1" fill={level > 0 ? fg : dim} />
        </>
      )}
    </svg>
  );
}

function BatteryIcon({ level = 100, charging = false, theme }) {
  const t = THEMES[theme] || THEMES.dark;
  const pct = Math.max(0, Math.min(100, level));
  const low = pct <= 20;
  const fillColor = charging ? t.batteryCharging : low ? t.batteryLow : t.batteryFill;
  const bodyW = 24;
  const bodyH = 11;
  const innerW = bodyW - 3;
  const fillW = Math.max(1, (innerW * pct) / 100);
  return (
    <svg width="27" height="12" viewBox="0 0 27 12" fill="none" aria-label="Batería">
      {/* cuerpo */}
      <rect
        x="0.5"
        y="0.5"
        width={bodyW}
        height={bodyH}
        rx="3"
        stroke={t.batteryOutline}
        strokeWidth="1"
        fill="none"
      />
      {/* relleno */}
      <rect
        x="2"
        y="2"
        width={fillW}
        height={bodyH - 3}
        rx="1.6"
        fill={fillColor}
        style={{ transition: 'width 300ms ease, fill 300ms ease' }}
      />
      {/* terminal */}
      <rect x={bodyW + 1} y="3.5" width="1.6" height="5" rx="0.8" fill={t.batteryOutline} />
      {/* rayo si carga */}
      {charging && (
        <path
          d="M11 2.5 L8.5 6.2 H11 L9.5 9.5 L14 5.2 H11.2 L12.5 2.5 Z"
          fill="#fff"
          stroke="none"
        />
      )}
    </svg>
  );
}

function LocationIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Ubicación">
      <path
        d="M12 2 L4 20 L12 16 L20 20 Z"
        fill={fg}
        stroke={fg}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RecordingIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Grabación">
      <circle cx="12" cy="12" r="7" fill={fg} />
      <circle cx="12" cy="12" r="10" stroke={fg} strokeWidth="1.5" fill="none" opacity="0.4" />
    </svg>
  );
}

function CallIcon({ fg = '#fff', size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Llamada">
      <path
        d="M5 4 h4 l2 5 -2.5 1.5 a12 12 0 0 0 5 5 L15 13 l5 2 v4 a2 2 0 0 1 -2 2 A16 16 0 0 1 3 6 a2 2 0 0 1 2 -2 z"
        fill={fg}
      />
    </svg>
  );
}

function HotspotIcon({ fg = '#fff', size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Hotspot">
      <circle cx="12" cy="12" r="2" fill={fg} />
      <path d="M8 8 a6 6 0 0 0 0 8" stroke={fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M16 8 a6 6 0 0 1 0 8" stroke={fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M5 5 a10 10 0 0 0 0 14" stroke={fg} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.6" />
      <path d="M19 5 a10 10 0 0 1 0 14" stroke={fg} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

function VpnIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="VPN">
      <path d="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z" fill={fg} />
    </svg>
  );
}

function AlarmIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Alarma">
      <circle cx="12" cy="13" r="7" stroke={fg} strokeWidth="1.6" fill="none" />
      <path d="M12 10 v3 l2 2" stroke={fg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M5 4 L8 6 M19 4 L16 6" stroke={fg} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RotationLockIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Bloqueo rotación">
      <rect x="7" y="3" width="10" height="14" rx="2" stroke={fg} strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="14" r="1" fill={fg} />
      <path d="M18 12 a4 4 0 1 0 -4 4" stroke={fg} strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function BluetoothIcon({ fg = '#fff', size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Bluetooth">
      <path d="M7 7 L17 17 L12 21 V3 L17 7 L7 17" stroke={fg} strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function AirPlayIcon({ fg = '#fff', size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="AirPlay">
      <rect x="3" y="4" width="18" height="12" rx="2" stroke={fg} strokeWidth="1.5" fill="none" />
      <path d="M12 15 L8 21 H16 Z" fill={fg} />
    </svg>
  );
}

function AirplaneIcon({ fg = '#fff', size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Modo avión">
      <path
        d="M12 2 L13 9 L21 13 V15 L13 13 L13 19 L16 21 V22 L12 21 L8 22 V21 L11 19 L11 13 L3 15 V13 L11 9 Z"
        fill={fg}
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponente: bloque de indicadores centrales
// ─────────────────────────────────────────────────────────────────────────────

function CenterIndicators({ indicators, theme }) {
  const t = THEMES[theme] || THEMES.dark;
  if (!indicators || indicators.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: t.fg,
      }}
    >
      {indicators.map((ind, i) => {
        switch (ind) {
          case 'location':    return <LocationIcon key={i} fg={t.fg} />;
          case 'recording':   return <RecordingIcon key={i} fg="#ff3b30" />;
          case 'call':        return <CallIcon key={i} fg="#34c759" />;
          case 'hotspot':     return <HotspotIcon key={i} fg={t.fg} />;
          case 'vpn':         return <VpnIcon key={i} fg={t.fg} />;
          case 'alarm':       return <AlarmIcon key={i} fg={t.fg} />;
          case 'rotation':    return <RotationLockIcon key={i} fg={t.fg} />;
          case 'bluetooth':   return <BluetoothIcon key={i} fg={t.fg} />;
          case 'airplay':     return <AirPlayIcon key={i} fg={t.fg} />;
          default:            return null;
        }
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StatusBar
 *
 * @param {Object} props
 * @param {'light'|'dark'|'auto'} [props.theme='auto']
 * @param {string}   [props.wallpaper]          Para inferir tema si theme='auto'
 * @param {boolean}  [props.use24h=false]
 * @param {boolean}  [props.showSeconds=false]
 * @param {string}   [props.operator]           Nombre del operador (default 'iOS')
 * @param {Array}    [props.indicators]         Forzar indicadores manualmente
 * @param {boolean}  [props.compact=false]      Modo compacto (Dynamic Island expandida)
 * @param {boolean}  [props.hidden=false]
 * @param {number}   [props.opacity=1]
 */
export default function StatusBar({
  theme = 'auto',
  wallpaper,
  use24h = false,
  showSeconds = false,
  operator,
  indicators: forcedIndicators,
  compact = false,
  hidden = false,
  opacity = 1,
}) {
  const os = useOS();
  const [now, setNow] = useState(() => new Date());

  // ── Tick del reloj ────────────────────────────────────────────────────────
  useEffect(() => {
    const interval = showSeconds ? 1000 : 5000;
    const t = setInterval(() => setNow(new Date()), interval);
    return () => clearInterval(t);
  }, [showSeconds]);

  // ── Snapshot del sistema ──────────────────────────────────────────────────
  const snap = os?.snapshot || {};

  // ── Tema efectivo ─────────────────────────────────────────────────────────
  const effectiveTheme = useMemo(() => {
    if (theme !== 'auto') return theme;
    return inferThemeFromWallpaper(wallpaper);
  }, [theme, wallpaper]);

  const t = THEMES[effectiveTheme] || THEMES.dark;

  // ── Datos: batería ────────────────────────────────────────────────────────
  const battery = useMemo(() => {
    const b = snap.battery || {};
    return {
      level: typeof b.level === 'number' ? b.level : 100,
      charging: !!b.charging || !!b.isCharging,
    };
  }, [snap.battery]);

  // ── Datos: WiFi ───────────────────────────────────────────────────────────
  const wifi = useMemo(() => {
    const w = snap.wifi || {};
    return {
      enabled: w.enabled !== false && w.powered !== false,
      // nivel 0..3
      level:
        typeof w.signal === 'number'
          ? Math.max(0, Math.min(3, Math.round((w.signal / 100) * 3)))
          : w.rssi != null
          ? w.rssi > -50 ? 3 : w.rssi > -65 ? 2 : w.rssi > -75 ? 1 : 0
          : 3,
    };
  }, [snap.wifi]);

  // ── Datos: cellular ───────────────────────────────────────────────────────
  const cellular = useMemo(() => {
    const c = snap.cellular || {};
    if (c.airplaneMode || c.airplane) {
      return { airplane: true, bars: 0, op: null };
    }
    const bars =
      typeof c.bars === 'number' ? c.bars :
      typeof c.signal === 'number' ? Math.max(0, Math.min(4, Math.round((c.signal / 100) * 4))) :
      4;
    return {
      airplane: false,
      bars,
      op: operator || c.operator || c.carrier || null,
      type: c.type || null, // '5G' | 'LTE' | '4G' | '3G' | 'E'
    };
  }, [snap.cellular, operator]);

  // ── Indicadores centrales ─────────────────────────────────────────────────
  const centerIndicators = useMemo(() => {
    if (Array.isArray(forcedIndicators)) return forcedIndicators;
    const list = [];
    // Recopilar desde el snapshot
    if (snap.location?.active || snap.location?.inUse) list.push('location');
    if (snap.recording?.active || snap.microphone?.recording || snap.camera?.recording) {
      list.push('recording');
    }
    if (snap.call?.active || snap.phone?.inCall) list.push('call');
    if (snap.hotspot?.enabled || snap.personalHotspot) list.push('hotspot');
    if (snap.vpn?.connected || snap.vpn?.active) list.push('vpn');
    if (snap.alarm?.enabled || snap.clock?.alarm) list.push('alarm');
    if (snap.rotation?.locked) list.push('rotation');
    if (snap.bluetooth?.connected && snap.bluetooth?.showIcon) list.push('bluetooth');
    if (snap.airplay?.active) list.push('airplay');
    return list;
  }, [forcedIndicators, snap]);

  if (hidden) return null;

  const time = formatTime(now, use24h, showSeconds);

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: SAFE_AREA_TOP,
        paddingTop: 14,
        paddingLeft: compact ? 24 : 30,
        paddingRight: compact ? 24 : 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        color: t.fg,
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 0.1,
        fontVariantNumeric: 'tabular-nums',
        opacity,
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 1000,
        transition: 'color 220ms ease, opacity 220ms ease',
      }}
    >
      {/* ── IZQUIERDA: hora ─────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 0.1,
          }}
        >
          {time}
        </span>
      </div>

      {/* ── CENTRO: indicadores ────────────────────────────────────────── */}
      <CenterIndicators indicators={centerIndicators} theme={effectiveTheme} />

      {/* ── DERECHA: cellular + wifi + batería ────────────────────────── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
        }}
      >
        {/* Modo avión o barras cellular */}
        {cellular.airplane ? (
          <AirplaneIcon fg={t.fg} />
        ) : (
          <>
            {cellular.type && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.2,
                  marginRight: 1,
                  color: t.fg,
                }}
              >
                {cellular.type}
              </span>
            )}
            <CellularIcon bars={cellular.bars} fg={t.fg} dim={t.fgDim} />
          </>
        )}

        {/* WiFi */}
        <WifiIcon level={wifi.level} fg={t.fg} dim={t.fgDim} off={!wifi.enabled} />

        {/* Batería + porcentaje */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginLeft: 1,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: battery.level <= 20 && !battery.charging ? t.batteryLow : t.fg,
              letterSpacing: 0.1,
            }}
          >
            {Math.round(battery.level)}%
          </span>
          <BatteryIcon
            level={battery.level}
            charging={battery.charging}
            theme={effectiveTheme}
          />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variante: StatusBarOverlay
// ─────────────────────────────────────────────────────────────────────────────
// Igual que StatusBar pero sin padding de safe area, pensada para incrustarse
// dentro de una app (AppWindow) que ya gestiona el top inset.
// ─────────────────────────────────────────────────────────────────────────────

export function StatusBarOverlay(props) {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 32 }}>
      <StatusBar {...props} opacity={props.opacity ?? 0.9} />
    </div>
  );
}
