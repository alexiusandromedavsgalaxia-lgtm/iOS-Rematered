// src/ui/Device.jsx
// Pantalla del dispositivo — SIN marco, SOLO vertical 9:19.5.
// - Relación de aspecto fija 9:19.5 (como iPhone 16 Pro)
// - Se centra en el contenedor padre y escala a la altura disponible
// - Sin rotación (portrait only)
// - Safe areas portrait (top 59px, bottom 34px en unidades lógicas)
// - Dynamic Island (opcional)
// - Home indicator
// - Aplica brillo y True Tone de VDisplay
// - Captura edge gestures y las reenvía a VTouch
// - Respeta reduced motion/transparency y text size multiplier
// Sin dependencias externas.

import React, {
  useRef, useEffect, useMemo, useCallback, forwardRef, useState,
} from 'react';
import { useOS, useOSSelector } from '../context/OSContext.jsx';

/* ------------------------------------------------------------------ *
 * Constantes de diseño (iPhone 16 Pro lógicos)
 * ------------------------------------------------------------------ */

// Resolución lógica (puntos) del iPhone 16 Pro
export const SCREEN = {
  WIDTH:  402,
  HEIGHT: 874,
  RATIO:  402 / 874,       // ≈ 0.4599 → 9:19.57
  ASPECT: '9 / 19.5',
};

// Safe areas en puntos lógicos (portrait)
export const SAFE_AREA = {
  top:    59,
  bottom: 34,
  left:   0,
  right:  0,
};

// Dynamic Island
const ISLAND = {
  width:    126,
  height:   36,
  radius:   20,
  topGap:   11,
  expandedW: 340,
  expandedH: 70,
  compactW:  96,
  compactH:  30,
};

// Edge gestures (px lógicos)
const EDGE_ZONE = 22;

/* ------------------------------------------------------------------ *
 * Estilos base inyectados una sola vez
 * ------------------------------------------------------------------ */

const STYLE_ID = 'ios-device-base-styles';

function injectBaseStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ios-device-host {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      overflow: hidden;
    }

    .ios-device {
      position: relative;
      aspect-ratio: 9 / 19.5;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      background: #000;
      overflow: hidden;
      color-scheme: var(--ios-appearance, light);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      color: var(--ios-fg, #000);
    }

    /* Si la pantalla es muy estrecha (móvil real), ocupa todo el ancho */
    @media (max-aspect-ratio: 9/19.5) {
      .ios-device {
        height: 100vh;
        width: 100vw;
        aspect-ratio: auto;
        max-width: none;
      }
    }

    .ios-device__screen {
      position: absolute;
      inset: 0;
      overflow: hidden;
      background: var(--ios-bg, #fff);
    }

    .ios-device__brightness {
      position: absolute;
      inset: 0;
      background: #000;
      pointer-events: none;
      z-index: 9000;
      transition: opacity .25s ease;
      opacity: 0;
    }

    .ios-device__truetone {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 8999;
      mix-blend-mode: multiply;
      background: rgb(255, 231, 186);
      transition: opacity .35s ease;
      opacity: 0;
    }

    .ios-device__island {
      position: absolute;
      top: ${ISLAND.topGap}px;
      left: 50%;
      transform: translateX(-50%);
      width: ${ISLAND.width}px;
      height: ${ISLAND.height}px;
      border-radius: ${ISLAND.radius}px;
      background: #000;
      z-index: 9500;
      pointer-events: auto;
      transition: width .28s cubic-bezier(.4,0,.2,1), height .28s cubic-bezier(.4,0,.2,1);
    }
    .ios-device__island--compact  { width: ${ISLAND.compactW}px; height: ${ISLAND.compactH}px; }
    .ios-device__island--expanded { width: ${ISLAND.expandedW}px; height: ${ISLAND.expandedH}px; }

    .ios-device__home-indicator {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      width: 140px;
      height: 5px;
      border-radius: 3px;
      background: var(--ios-home-indicator, rgba(255,255,255,.85));
      z-index: 9400;
      pointer-events: none;
      transition: opacity .2s ease;
    }
    .ios-device__home-indicator--hidden { opacity: 0; }

    .ios-device__edge {
      position: absolute;
      z-index: 9300;
      pointer-events: auto;
    }
    .ios-device__edge--top    { top: 0;    left: 0;  right: 0;  height: ${EDGE_ZONE}px; }
    .ios-device__edge--bottom { bottom: 0; left: 0;  right: 0;  height: ${EDGE_ZONE}px; }
    .ios-device__edge--left   { top: 0;    bottom: 0; left: 0;  width: ${EDGE_ZONE}px; }
    .ios-device__edge--right  { top: 0;    bottom: 0; right: 0; width: ${EDGE_ZONE}px; }

    .ios-device__content {
      position: absolute;
      inset: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .ios-device__safe-top    { height: ${SAFE_AREA.top}px; flex: 0 0 auto; }
    .ios-device__safe-bottom { height: ${SAFE_AREA.bottom}px; flex: 0 0 auto; }
    .ios-device__body        { flex: 1 1 auto; position: relative; overflow: hidden; }

    .ios-device--reduced-transparency .ios-device__blur-target {
      backdrop-filter: none !important;
      background: rgba(28,28,30,.95) !important;
    }

    .ios-device--reduced-motion *,
    .ios-device--reduced-motion *::before,
    .ios-device--reduced-motion *::after {
      animation-duration: .001ms !important;
      transition-duration: .001ms !important;
    }

    /* Sobres */
    .ios-device__status-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 9200;
    }

    /* Apagado de pantalla */
    .ios-device--screen-off .ios-device__screen { background: #000 !important; }
    .ios-device--screen-off .ios-device__content > * { visibility: hidden; }
  `;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function toHexChannel(n) { return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0'); }

// Color de True Tone en función de CCT ambiental (2000K cálido → 8000K frío)
function trueToneColor(cct) {
  const t = clamp((cct - 2000) / 6000, 0, 1);
  // Cálido (rojo alto, azul bajo) → neutro (blanco)
  const r = 255;
  const g = Math.round(lerp(220, 245, t));
  const b = Math.round(lerp(160, 230, t));
  return `rgb(${r}, ${g}, ${b})`;
}
function lerp(a, b, t) { return a + (b - a) * t; }

/* ------------------------------------------------------------------ *
 * Componente principal
 * ------------------------------------------------------------------ */

export const Device = forwardRef(function Device(props, ref) {
  const {
    children,
    showIsland = true,
    showHomeIndicator = true,
    islandState = 'normal',        // 'compact' | 'normal' | 'expanded'
    onIslandClick,
    onEdgeGesture,
    className = '',
    style = {},
    // Override manual de brillo/appearance (para demos)
    brightnessOverride = null,
    appearanceOverride = null,
    screenOffOverride = null,
  } = props;

  const {
    isBooted, osState,
    getDisplay, getProx, getALS, getTouch, getTaptic,
  } = useOS();

  injectBaseStyles();

  const rootRef = useRef(null);
  const screenRef = useRef(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  // --- Suscripción al snapshot para brillo/appearance (baja frecuencia) ---
  const displaySnapshot = useOSSelector(
    (s) => ({
      brightness:  s?.display?.brightness ?? null,
      trueTone:    s?.display?.trueTone ?? null,
      nightShift:  s?.display?.nightShift ?? null,
      appearance:  s?.display?.appearance ?? null,
      screenOff:   s?.display?.screenOff ?? null,
      reduceMotion: s?.display?.reduceMotion ?? null,
      reduceTransparency: s?.display?.reduceTransparency ?? null,
      textSizeMultiplier: s?.display?.textSizeMultiplier ?? null,
      cct:         s?.als?.cct ?? 6500,
    }),
    (a, b) => a.brightness === b.brightness
      && a.trueTone === b.trueTone
      && a.nightShift === b.nightShift
      && a.appearance === b.appearance
      && a.screenOff === b.screenOff
      && a.reduceMotion === b.reduceMotion
      && a.reduceTransparency === b.reduceTransparency
      && a.textSizeMultiplier === b.textSizeMultiplier
      && a.cct === b.cct
  );

  // --- Medir el contenedor para el escalado ---
  useEffect(() => {
    if (!rootRef.current) return;
    const el = rootRef.current.parentElement || rootRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setViewport({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // --- Aplicar variables CSS reactivas ---
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const brightness = brightnessOverride != null
      ? brightnessOverride
      : (displaySnapshot.brightness != null ? displaySnapshot.brightness / 100 : 1);
    const appearance = appearanceOverride
      || displaySnapshot.appearance
      || 'light';
    const screenOff = screenOffOverride != null
      ? screenOffOverride
      : !!displaySnapshot.screenOff;

    const isDark = appearance === 'dark';

    root.style.setProperty('--ios-brightness', String(clamp(brightness, 0.05, 1)));
    root.style.setProperty('--ios-appearance', appearance);
    root.style.setProperty('--ios-bg', isDark ? '#000' : '#fff');
    root.style.setProperty('--ios-fg', isDark ? '#fff' : '#000');
    root.style.setProperty('--ios-home-indicator', isDark ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.75)');
    root.style.setProperty('--ios-text-size-multiplier', String(displaySnapshot.textSizeMultiplier ?? 1));

    // True Tone
    const trueToneOn = displaySnapshot.trueTone !== false;
    const ttColor = trueToneColor(displaySnapshot.cct || 6500);
    const ttStrength = trueToneOn ? 0.18 : 0;
    root.style.setProperty('--ios-truetone-color', ttColor);
    root.style.setProperty('--ios-truetone-strength', String(ttStrength));

    root.classList.toggle('ios-device--dark', isDark);
    root.classList.toggle('ios-device--light', !isDark);
    root.classList.toggle('ios-device--reduced-motion', !!displaySnapshot.reduceMotion);
    root.classList.toggle('ios-device--reduced-transparency', !!displaySnapshot.reduceTransparency);
    root.classList.toggle('ios-device--screen-off', screenOff);
  }, [
    displaySnapshot.brightness, displaySnapshot.appearance, displaySnapshot.trueTone,
    displaySnapshot.reduceMotion, displaySnapshot.reduceTransparency,
    displaySnapshot.textSizeMultiplier, displaySnapshot.cct, displaySnapshot.screenOff,
    brightnessOverride, appearanceOverride, screenOffOverride,
  ]);

  // --- Routing de edge gestures a VTouch ---
  const edgeRef = useRef({ active: null, startX: 0, startY: 0, startT: 0 });

  const handleEdgePointerDown = useCallback((edge) => (e) => {
    const touch = getTouch?.();
    edgeRef.current = { active: edge, startX: e.clientX, startY: e.clientY, startT: performance.now() };
    touch?.onEdgeTouchStart?.(edge, e.clientX, e.clientY);
  }, [getTouch]);

  const handleEdgePointerMove = useCallback((e) => {
    if (!edgeRef.current.active) return;
    const touch = getTouch?.();
    touch?.onEdgeTouchMove?.(edgeRef.current.active, e.clientX, e.clientY);
  }, [getTouch]);

  const handleEdgePointerUp = useCallback((e) => {
    const st = edgeRef.current;
    if (!st.active) return;
    const touch = getTouch?.();
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    const dt = performance.now() - st.startT;

    touch?.onEdgeTouchEnd?.(st.active, e.clientX, e.clientY, { dx, dy, dt });

    // Clasificación de gestos por edge
    let gesture = null;
    if (st.active === 'bottom' && dy < -50 && dt < 600)     gesture = 'home';
    else if (st.active === 'top' && dy > 30 && dt < 600)    gesture = 'notification-center';
    else if (st.active === 'top' && Math.abs(dx) > 40 && dt < 600) gesture = 'control-center';
    else if (st.active === 'left' && dx > 40 && dt < 600)   gesture = 'back';
    else if (st.active === 'right' && dx < -40 && dt < 600) gesture = 'forward';

    if (gesture) {
      getTaptic?.()?.play?.('light');
      onEdgeGesture?.(gesture, { dx, dy, dt });
    }

    edgeRef.current = { active: null, startX: 0, startY: 0, startT: 0 };
  }, [getTouch, getTaptic, onEdgeGesture]);

  // --- Click en la isla ---
  const handleIslandClick = useCallback(() => {
    getTaptic?.()?.play?.('light');
    onIslandClick?.();
  }, [getTaptic, onIslandClick]);

  // --- Estilo del contenedor (escala) ---
  const hostStyle = useMemo(() => {
    // Escala limitada por la altura del viewport
    return { ...style };
  }, [style]);

  // --- Clase de la isla ---
  const islandClass = useMemo(() => {
    if (islandState === 'compact')  return 'ios-device__island ios-device__island--compact';
    if (islandState === 'expanded') return 'ios-device__island ios-device__island--expanded';
    return 'ios-device__island';
  }, [islandState]);

  // --- Brillo overlay opacity ---
  const brightnessOpacity = useMemo(() => {
    const b = brightnessOverride != null
      ? brightnessOverride
      : (displaySnapshot.brightness != null ? displaySnapshot.brightness / 100 : 1);
    // A 100% → 0; a 5% → 0.9
    return clamp(1 - b, 0, 0.95);
  }, [displaySnapshot.brightness, brightnessOverride]);

  return (
    <div ref={rootRef} className={`ios-device-host ${className}`} style={hostStyle}>
      <div
        className="ios-device"
        ref={ref}
        data-os-state={osState}
        data-booted={isBooted ? 'true' : 'false'}
      >
        {/* Pantalla */}
        <div className="ios-device__screen" ref={screenRef}>
          {/* Contenido con safe areas */}
          <div className="ios-device__content">
            <div className="ios-device__safe-top" />
            <div className="ios-device__body">
              {children}
            </div>
            <div className="ios-device__safe-bottom" />
          </div>
        </div>

        {/* True Tone (multiplicativo) */}
        <div
          className="ios-device__truetone"
          style={{
            background: `var(--ios-truetone-color, rgb(255,231,186))`,
            opacity: `var(--ios-truetone-strength, 0)`,
          }}
        />

        {/* Brillo (atenuación) */}
        <div
          className="ios-device__brightness"
          style={{ opacity: brightnessOpacity }}
        />

        {/* Dynamic Island */}
        {showIsland && (
          <div
            className={islandClass}
            onClick={handleIslandClick}
            role="button"
            aria-label="Dynamic Island"
            tabIndex={0}
          />
        )}

        {/* Home indicator */}
        {showHomeIndicator && (
          <div
            className={`ios-device__home-indicator${
              (!isBooted || displaySnapshot.screenOff) ? ' ios-device__home-indicator--hidden' : ''
            }`}
          />
        )}

        {/* Zonas de edge gestures */}
        <div
          className="ios-device__edge ios-device__edge--top"
          onPointerDown={handleEdgePointerDown('top')}
          onPointerMove={handleEdgePointerMove}
          onPointerUp={handleEdgePointerUp}
          onPointerCancel={handleEdgePointerUp}
        />
        <div
          className="ios-device__edge ios-device__edge--bottom"
          onPointerDown={handleEdgePointerDown('bottom')}
          onPointerMove={handleEdgePointerMove}
          onPointerUp={handleEdgePointerUp}
          onPointerCancel={handleEdgePointerUp}
        />
        <div
          className="ios-device__edge ios-device__edge--left"
          onPointerDown={handleEdgePointerDown('left')}
          onPointerMove={handleEdgePointerMove}
          onPointerUp={handleEdgePointerUp}
          onPointerCancel={handleEdgePointerUp}
        />
        <div
          className="ios-device__edge ios-device__edge--right"
          onPointerDown={handleEdgePointerDown('right')}
          onPointerMove={handleEdgePointerMove}
          onPointerUp={handleEdgePointerUp}
          onPointerCancel={handleEdgePointerUp}
        />
      </div>
    </div>
  );
});

export default Device;
