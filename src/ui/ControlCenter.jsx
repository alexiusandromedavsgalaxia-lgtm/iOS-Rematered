// src/ui/ControlCenter.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — ControlCenter
//
// Panel deslizante desde la esquina superior derecha (como iOS real).
// Contiene:
//   • Conectividad: modo avión, AirDrop, WiFi, Bluetooth, datos móviles.
//   • Focus: No molestar, Trabajo, Personal, Sueño, etc.
//   • Brillo y Volumen: sliders verticales con gesto drag.
//   • Música: reproductor compacto con artwork, título, play/pause/skip.
//   • Acciones: linterna, temporizador, calculadora, cámara, QR.
//   • AirPlay, Duplicar pantalla, Rotación.
//   • Blur iOS real, drag para ajustar, tap para toggles.
//
// Todos los toggles escriben al OSContext (os.setWifi, os.setBrightness, etc.).
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

const PANEL_WIDTH = 360;
const PANEL_PADDING = 14;
const TILE_GAP = 12;
const TILE_RADIUS = 26;
const BLUR = 'blur(38px) saturate(180%)';
const SPRING = 'cubic-bezier(.22,1,.36,1)';
const DRAG_CLOSE_THRESHOLD = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline
// ─────────────────────────────────────────────────────────────────────────────

function AirplaneIcon({ size = 20, on }) {
  const fill = on ? '#ff9500' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2 L13 9 L21 13 V15 L13 13 L13 19 L16 21 V22 L12 21 L8 22 V21 L11 19 L11 13 L3 15 V13 L11 9 Z" fill={fill} />
    </svg>
  );
}

function CellularIcon({ size = 20, on }) {
  const fill = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="15" width="3" height="6" rx="1" fill={fill} />
      <rect x="8" y="11" width="3" height="10" rx="1" fill={fill} />
      <rect x="13" y="7" width="3" height="14" rx="1" fill={fill} />
      <rect x="18" y="3" width="3" height="18" rx="1" fill={fill} opacity={on ? 1 : 0.4} />
    </svg>
  );
}

function WifiIcon({ size = 20, on }) {
  const stroke = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 9 a13 13 0 0 1 18 0" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M6 12.5 a9 9 0 0 1 12 0" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M9 16 a5 5 0 0 1 6 0" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="12" cy="19" r="1.6" fill={stroke} />
    </svg>
  );
}

function BluetoothIcon({ size = 20, on }) {
  const stroke = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M7 7 L17 17 L12 21 V3 L17 7 L7 17" stroke={stroke} strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function AirDropIcon({ size = 20, on }) {
  const stroke = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke={stroke} strokeWidth="1.8" fill="none" />
      <path d="M5 12 a7 7 0 0 1 14 0" stroke={stroke} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M2 12 a10 10 0 0 1 20 0" stroke={stroke} strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.5" />
      <path d="M12 15 v6" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BrightnessIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4.5" fill="#fff" />
      <path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M4.9 4.9 l2.1 2.1 M17 17 l2.1 2.1 M4.9 19.1 l2.1 -2.1 M17 7 l2.1 -2.1" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function VolumeIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 9 h4 l4 -4 v14 l-4 -4 h-4 z" fill="#fff" />
      <path d="M15 8 a5 5 0 0 1 0 8" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M18 5 a9 9 0 0 1 0 14" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

function FlashlightIcon({ size = 22, on }) {
  const fill = on ? '#fff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M9 3h6l-1 6h-4L9 3z" fill={fill} />
      <path d="M10 9h4v10a2 2 0 0 1-2 2 2 2 0 0 1-2-2V9z" fill={fill} />
    </svg>
  );
}

function TimerIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="13" r="8" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M12 9 v4 l3 2" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M9 2 h6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CalculatorIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="3" width="16" height="18" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <rect x="6" y="5" width="12" height="4" rx="1" fill="#fff" opacity="0.4" />
      <circle cx="8" cy="13" r="1" fill="#fff" />
      <circle cx="12" cy="13" r="1" fill="#fff" />
      <circle cx="16" cy="13" r="1" fill="#fff" />
      <circle cx="8" cy="17" r="1" fill="#fff" />
      <circle cx="12" cy="17" r="1" fill="#fff" />
      <circle cx="16" cy="17" r="1" fill="#fff" />
    </svg>
  );
}

function CameraIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="7" width="18" height="13" rx="3" fill="#fff" />
      <circle cx="12" cy="13.5" r="3.4" fill="#1a1a1a" />
      <circle cx="12" cy="13.5" r="1.6" fill="#fff" />
      <rect x="8" y="5" width="4" height="3" rx="1" fill="#fff" />
    </svg>
  );
}

function AirPlayIcon({ size = 20, on }) {
  const stroke = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="12" rx="2" stroke={stroke} strokeWidth="1.8" fill="none" />
      <path d="M12 15 L8 21 H16 Z" fill={stroke} />
    </svg>
  );
}

function RotationIcon({ size = 20, on }) {
  const stroke = on ? '#0a84ff' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="7" y="3" width="10" height="14" rx="2" stroke={stroke} strokeWidth="1.8" fill="none" />
      <path d="M18 12 a4 4 0 1 0 -4 4" stroke={stroke} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon({ size = 20, on }) {
  const fill = on ? '#5e5ce6' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M20 14 a9 9 0 1 1 -10 -10 7 7 0 0 0 10 10 z" fill={fill} />
    </svg>
  );
}

function FocusIcon({ size = 20, on, color = '#5e5ce6' }) {
  const fill = on ? color : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke={fill} strokeWidth="1.8" fill="none" />
      <circle cx="12" cy="12" r="3" fill={fill} />
    </svg>
  );
}

function PlayIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M7 5 L19 12 L7 19 Z" fill="#fff" />
    </svg>
  );
}

function PauseIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="#fff" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="#fff" />
    </svg>
  );
}

function PrevIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M18 6 L8 12 L18 18 Z M6 6 v12" fill="#fff" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function NextIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 6 L16 12 L6 18 Z M18 6 v12" fill="#fff" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes base: Toggle, Slider
// ─────────────────────────────────────────────────────────────────────────────

function ToggleTile({ icon, label, sublabel, active, color = '#0a84ff', onTap, size = 1 }) {
  return (
    <button
      onClick={() => { haptic('light'); onTap?.(); }}
      style={{
        height: 74 * size,
        borderRadius: TILE_RADIUS,
        border: 'none',
        background: active ? color : 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        color: '#fff',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        transition: 'background 220ms ease',
        padding: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
      aria-label={label}
    >
      {typeof icon === 'function' ? icon({ on: active }) : icon}
      <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.95 }}>{label}</span>
      {sublabel && <span style={{ fontSize: 8, opacity: 0.65 }}>{sublabel}</span>}
    </button>
  );
}

function ConnectivityCluster({ os, wifi, bt, cell, airplane, airdrop }) {
  const snap = os?.snapshot || {};
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: TILE_GAP,
        height: 160,
      }}
    >
      {/* Airplane */}
      <button
        onClick={() => { haptic('light'); os?.toggleAirplaneMode?.(); }}
        style={{
          borderRadius: TILE_RADIUS,
          border: 'none',
          background: airplane ? '#ff9500' : 'rgba(120,120,128,0.32)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          transition: 'background 220ms ease',
          padding: 0,
        }}
        aria-label="Modo avión"
      >
        <AirplaneIcon on={airplane} />
        <span style={{ fontSize: 10, fontWeight: 500 }}>Modo avión</span>
      </button>

      {/* AirDrop */}
      <button
        onClick={() => { haptic('light'); os?.cycleAirDrop?.(); }}
        style={{
          borderRadius: TILE_RADIUS,
          border: 'none',
          background: airdrop !== 'off' ? '#0a84ff' : 'rgba(120,120,128,0.32)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          transition: 'background 220ms ease',
          padding: 0,
        }}
        aria-label="AirDrop"
      >
        <AirDropIcon on={airdrop !== 'off'} />
        <span style={{ fontSize: 10, fontWeight: 500 }}>AirDrop</span>
      </button>

      {/* Cluster WiFi/BT/Cell */}
      <div
        style={{
          gridColumn: 'span 2',
          borderRadius: TILE_RADIUS,
          background: 'rgba(120,120,128,0.32)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          padding: '0 8px',
        }}
      >
        <button
          onClick={() => { haptic('light'); os?.toggleWifi?.(); }}
          style={iconBtnStyle}
          aria-label="WiFi"
        >
          <WifiIcon on={wifi} />
          <span style={iconSubStyle}>{wifi ? (snap.wifi?.ssid || 'WiFi') : 'WiFi'}</span>
        </button>
        <div style={{ width: 1, height: 34, background: 'rgba(255,255,255,0.15)' }} />
        <button
          onClick={() => { haptic('light'); os?.toggleBluetooth?.(); }}
          style={iconBtnStyle}
          aria-label="Bluetooth"
        >
          <BluetoothIcon on={bt} />
          <span style={iconSubStyle}>{bt ? (snap.bluetooth?.name || 'Bluetooth') : 'Bluetooth'}</span>
        </button>
        <div style={{ width: 1, height: 34, background: 'rgba(255,255,255,0.15)' }} />
        <button
          onClick={() => { haptic('light'); os?.toggleCellular?.(); }}
          style={iconBtnStyle}
          aria-label="Datos móviles"
        >
          <CellularIcon on={cell} />
          <span style={iconSubStyle}>{cell ? 'Datos' : 'Datos'}</span>
        </button>
      </div>
    </div>
  );
}

const iconBtnStyle = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  padding: '6px 10px',
  borderRadius: 12,
  flex: 1,
};

const iconSubStyle = {
  fontSize: 9,
  opacity: 0.75,
  fontWeight: 500,
};

// ─────────────────────────────────────────────────────────────────────────────
// Slider vertical (brillo, volumen)
// ─────────────────────────────────────────────────────────────────────────────

function VerticalSlider({ icon, value = 0.5, onChange, height = 160, onRelease }) {
  const ref = useRef(null);
  const dragging = useRef(false);

  const computeFromEvent = useCallback((e) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const y = e.clientY - rect.top;
    const pct = clamp(1 - y / rect.height, 0, 1);
    onChange?.(pct);
  }, [onChange]);

  const onPointerDown = useCallback((e) => {
    dragging.current = true;
    haptic('tick');
    computeFromEvent(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [computeFromEvent]);

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    computeFromEvent(e);
  }, [computeFromEvent]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    onRelease?.();
  }, [onRelease]);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'relative',
        width: 74,
        height,
        borderRadius: TILE_RADIUS,
        background: 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        overflow: 'hidden',
        cursor: 'pointer',
        touchAction: 'none',
        userSelect: 'none',
      }}
      aria-label="Slider"
    >
      {/* relleno desde abajo */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: `${value * 100}%`,
          background: 'rgba(255,255,255,0.92)',
          transition: dragging.current ? 'none' : 'height 180ms ease',
        }}
      />
      {/* icono encima */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          color: value > 0.35 ? '#1a1a1a' : '#fff',
          transition: 'color 200ms ease',
          pointerEvents: 'none',
        }}
      >
        {icon}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reproductor de música
// ─────────────────────────────────────────────────────────────────────────────

function MusicPlayer({ os, track, playing, onToggle, onNext, onPrev }) {
  if (!track) {
    return (
      <div
        style={{
          height: 120,
          borderRadius: TILE_RADIUS,
          background: 'rgba(120,120,128,0.32)',
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,0.6)',
          fontSize: 12,
        }}
      >
        Nada en reproducción
      </div>
    );
  }

  return (
    <div
      style={{
        height: 120,
        borderRadius: TILE_RADIUS,
        background: 'rgba(120,120,128,0.32)',
        backdropFilter: BLUR,
        WebkitBackdropFilter: BLUR,
        display: 'flex',
        alignItems: 'center',
        padding: 12,
        gap: 12,
      }}
    >
      {/* Artwork */}
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: 12,
          background: track.artwork || 'linear-gradient(160deg, #5ac8fa, #af52de)',
          flexShrink: 0,
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        }}
      />
      {/* Info + controles */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {track.title}
        </div>
        <div
          style={{
            color: 'rgba(255,255,255,0.65)',
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {track.artist}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
          <button onClick={onPrev} style={ctrlBtn} aria-label="Anterior">
            <PrevIcon />
          </button>
          <button onClick={onToggle} style={ctrlBtn} aria-label={playing ? 'Pausa' : 'Play'}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button onClick={onNext} style={ctrlBtn} aria-label="Siguiente">
            <NextIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

const ctrlBtn = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  cursor: 'pointer',
  padding: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// ─────────────────────────────────────────────────────────────────────────────
// Panel principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ControlCenter
 *
 * @param {Object} props
 * @param {boolean} props.open                Si el panel está abierto
 * @param {Function} props.onClose            Cerrar (swipe-down o tap fuera)
 * @param {Function} [props.onOpenApp]        Abrir apps (calculadora, cámara…)
 * @param {boolean} [props.showMusic=true]
 * @param {boolean} [props.showHomeControls=true]
 */
export default function ControlCenter({
  open,
  onClose,
  onOpenApp,
  showMusic = true,
  showHomeControls = true,
}) {
  const os = useOS();
  const snap = os?.snapshot || {};
  const [drag, setDrag] = useState({ y: 0, dragging: false });
  const dragStart = useRef(null);

  // ── Estado derivado del snapshot ──────────────────────────────────────────
  const wifi = snap.wifi?.enabled !== false && snap.wifi?.powered !== false;
  const bt = !!snap.bluetooth?.enabled;
  const cell = snap.cellular?.enabled !== false && !snap.cellular?.airplaneMode;
  const airplane = !!snap.cellular?.airplaneMode;
  const airdrop = snap.airdrop?.mode || 'off';
  const brightness = typeof snap.display?.brightness === 'number' ? snap.display.brightness : 0.7;
  const volume = typeof snap.audio?.volume === 'number' ? snap.audio.volume : 0.6;
  const focus = snap.focus?.active || null;
  const flashlight = !!snap.flashlight?.on;
  const rotationLocked = !!snap.rotation?.locked;
  const airplay = !!snap.airplay?.active;
  const track = snap.music?.currentTrack || null;
  const playing = !!snap.music?.playing;

  // ── Gestos de cierre ──────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (e.target.closest('[data-cc-interactive]')) return;
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

  // ── Escape para cerrar ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  const setBrightness = useCallback((v) => {
    os?.setBrightness?.(v);
  }, [os]);

  const setVolume = useCallback((v) => {
    os?.setVolume?.(v);
  }, [os]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      onClick={(e) => {
        // Cerrar si toca el fondo (fuera del panel)
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 900,
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
        data-cc-interactive
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: PANEL_WIDTH,
          height: '100%',
          padding: `70px ${PANEL_PADDING}px 40px`,
          display: 'flex',
          flexDirection: 'column',
          gap: TILE_GAP,
          overflowY: 'auto',
          transform: open ? `translateY(${drag.y}px)` : 'translateY(-102%)',
          opacity: open ? Math.max(0.4, 1 - drag.y / 600) : 0,
          transition: drag.dragging
            ? 'none'
            : `transform 520ms ${SPRING}, opacity 320ms ease`,
          willChange: 'transform, opacity',
          touchAction: 'none',
        }}
      >
        {/* ── Conectividad ─────────────────────────────────────────── */}
        <ConnectivityCluster
          os={os}
          wifi={wifi}
          bt={bt}
          cell={cell}
          airplane={airplane}
          airdrop={airdrop}
        />

        {/* ── Focus ─────────────────────────────────────────────────── */}
        <button
          onClick={() => { haptic('light'); os?.toggleFocus?.(); }}
          style={{
            height: 74,
            borderRadius: TILE_RADIUS,
            border: 'none',
            background: focus ? '#5e5ce6' : 'rgba(120,120,128,0.32)',
            backdropFilter: BLUR,
            WebkitBackdropFilter: BLUR,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 18px',
            cursor: 'pointer',
            transition: 'background 220ms ease',
          }}
        >
          <MoonIcon on={!!focus} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {focus ? focus.label || 'Concentración' : 'Concentración'}
            </span>
            <span style={{ fontSize: 10, opacity: 0.75 }}>
              {focus ? 'Activada' : 'Desactivada'}
            </span>
          </div>
        </button>

        {/* ── Brillo + Volumen ──────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: TILE_GAP }}>
          <VerticalSlider
            icon={<BrightnessIcon />}
            value={brightness}
            onChange={setBrightness}
          />
          <VerticalSlider
            icon={<VolumeIcon />}
            value={volume}
            onChange={setVolume}
          />
        </div>

        {/* ── Música ────────────────────────────────────────────────── */}
        {showMusic && (
          <MusicPlayer
            os={os}
            track={track}
            playing={playing}
            onToggle={() => os?.toggleMusic?.()}
            onNext={() => os?.nextTrack?.()}
            onPrev={() => os?.prevTrack?.()}
          />
        )}

        {/* ── Controles hogar ───────────────────────────────────────── */}
        {showHomeControls && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: TILE_GAP }}>
              <ToggleTile
                icon={<FlashlightIcon on={flashlight} />}
                label="Linterna"
                active={flashlight}
                color="#ff9500"
                onTap={() => os?.toggleFlashlight?.()}
              />
              <ToggleTile
                icon={<TimerIcon />}
                label="Temporizador"
                active={false}
                color="#0a84ff"
                onTap={() => onOpenApp?.('clock')}
              />
              <ToggleTile
                icon={<CalculatorIcon />}
                label="Calculadora"
                active={false}
                color="#ff9500"
                onTap={() => onOpenApp?.('calculator')}
              />
              <ToggleTile
                icon={<CameraIcon />}
                label="Cámara"
                active={false}
                color="#34c759"
                onTap={() => onOpenApp?.('camera')}
              />
            </div>
          </>
        )}

        {/* ── Sistema ──────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: TILE_GAP }}>
          <ToggleTile
            icon={<AirPlayIcon on={airplay} />}
            label="AirPlay"
            active={airplay}
            color="#0a84ff"
            onTap={() => os?.toggleAirPlay?.()}
          />
          <ToggleTile
            icon={<RotationIcon on={rotationLocked} />}
            label="Bloq. rotación"
            active={rotationLocked}
            color="#0a84ff"
            onTap={() => os?.toggleRotationLock?.()}
          />
        </div>

        {/* ── Pie: línea de arrastre inferior ──────────────────────── */}
        <div
          style={{
            marginTop: 'auto',
            height: 5,
            width: 80,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.35)',
            alignSelf: 'center',
            marginBottom: 8,
          }}
        />
      </div>
    </div>
  );
}
