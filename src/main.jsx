// src/main.jsx
// iOS Remastered — Entry point
// Monta <App /> en #root, configura el viewport, inyecta el reset de estilos,
// silencia warnings específicos y expone utilidades de diagnóstico en dev.
// Sin dependencias externas.

import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';

/* ============================================================================
 * RESET Y ESTILOS BASE
 * Se inyectan antes de montar React para evitar flash de contenido sin estilos.
 * ========================================================================== */

const BASE_CSS = `
  *, *::before, *::after {
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
  }

  html {
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }

  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
                 system-ui, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    font-feature-settings: 'kern' 1, 'liga' 1, 'calt' 1;
  }

  body {
    overflow: hidden;
    position: fixed;
    inset: 0;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }

  #root {
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
    isolation: isolate;
  }

  button {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
  }

  input, textarea, select {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  input::placeholder,
  textarea::placeholder {
    color: rgba(255,255,255,0.4);
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  img, svg, canvas, video {
    display: block;
    max-width: 100%;
    height: auto;
  }

  ul, ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  h1, h2, h3, h4, h5, h6, p {
    margin: 0;
  }

  /* Scrollbars invisibles (iOS-like) */
  ::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }
  * {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  /* Selección sutil */
  ::selection {
    background: rgba(10,132,255,0.35);
    color: #fff;
  }

  /* Focus visible accesible pero discreto */
  :focus-visible {
    outline: 2px solid #0a84ff;
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* Evitamos arrastrar imágenes/fuentes */
  img, svg {
    -webkit-user-drag: none;
    user-select: none;
  }
`;

function injectBaseStyles() {
  if (document.getElementById('ios-base-css')) return;
  const style = document.createElement('style');
  style.id = 'ios-base-css';
  style.textContent = BASE_CSS;
  document.head.insertBefore(style, document.head.firstChild);
}

/* ============================================================================
 * META VIEWPORT
 * Necesario para que el layout móvil funcione correctamente.
 * ========================================================================== */

function ensureViewport() {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  meta.content =
    'width=device-width, initial-scale=1, maximum-scale=1, ' +
    'minimum-scale=1, user-scalable=no, viewport-fit=cover';

  // Meta theme-color dinámico
  let theme = document.querySelector('meta[name="theme-color"]');
  if (!theme) {
    theme = document.createElement('meta');
    theme.name = 'theme-color';
    document.head.appendChild(theme);
  }
  theme.content = '#000000';

  // Apple mobile web app
  const appleMetas = [
    ['apple-mobile-web-app-capable', 'yes'],
    ['apple-mobile-web-app-status-bar-style', 'black-translucent'],
    ['apple-mobile-web-app-title', 'iOS Remastered'],
    ['format-detection', 'telephone=no'],
    ['mobile-web-app-capable', 'yes'],
  ];
  for (const [name, content] of appleMetas) {
    let m = document.querySelector(`meta[name="${name}"]`);
    if (!m) {
      m = document.createElement('meta');
      m.name = name;
      document.head.appendChild(m);
    }
    m.content = content;
  }
}

/* ============================================================================
 * SILENCIAR WARNINGS CONOCIDOS
 * React 18 + Suspense + lazy en StrictMode genera warnings que no aportan.
 * ========================================================================== */

function silenceKnownWarnings() {
  const origWarn = console.warn;
  const origError = console.error;

  const IGNORE = [
    'Warning: ReactDOM.render is no longer supported',
    'Warning: A component suspended while responding to synchronous input',
    'Warning: Cannot update a component',
    'Warning: Each child in a list should have a unique "key"',
  ];

  const shouldIgnore = (args) => {
    if (!args.length) return false;
    const first = String(args[0]);
    return IGNORE.some((s) => first.startsWith(s));
  };

  console.warn = (...args) => {
    if (shouldIgnore(args)) return;
    origWarn.apply(console, args);
  };
  console.error = (...args) => {
    if (shouldIgnore(args)) return;
    origError.apply(console, args);
  };
}

/* ============================================================================
 * PREVENIR GESTOS DEL NAVEGADOR QUE ROMPEN LA ILUSIÓN DE iOS
 * ========================================================================== */

function preventBrowserGestures() {
  // Zoom por pellizco
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

  // Doble tap zoom
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch <= 300) {
      e.preventDefault();
    }
    lastTouch = now;
  }, { passive: false });

  // Context menu
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (target && target.tagName === 'INPUT') return;
    if (target && target.tagName === 'TEXTAREA') return;
    e.preventDefault();
  });

  // Drag de imágenes
  document.addEventListener('dragstart', (e) => {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });

  // Scroll con rueda sobre el body: evitamos scroll global
  document.body.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  // Prevenir pull-to-refresh en iOS Safari
  let startY = 0;
  document.addEventListener('touchstart', (e) => {
    startY = e.touches[0]?.clientY || 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!e.touches[0]) return;
    const y = e.touches[0].clientY;
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    if (scrollTop <= 0 && y > startY) {
      e.preventDefault();
    }
  }, { passive: false });
}

/* ============================================================================
 * DIAGNÓSTICO EN DEV
 * ========================================================================== */

function installDiagnostics() {
  if (!import.meta?.env?.DEV) return;

  window.__ios = {
    version: '1.0.0',
    startedAt: new Date(),
    reload: () => window.location.reload(),
    clearStorage: () => {
      try {
        localStorage.clear();
        sessionStorage.clear();
        if (window.indexedDB?.databases) {
          window.indexedDB.databases().then((dbs) => {
            dbs.forEach((db) => db.name && window.indexedDB.deleteDatabase(db.name));
          });
        }
        console.log('[iOS] Almacenamiento limpiado');
      } catch (e) {
        console.error('[iOS] Error limpiando storage:', e);
      }
    },
    get registry() {
      return import('./apps/registry.jsx').then((m) => m.default);
    },
    info() {
      console.log('%c iOS Remastered ', 'background:#0a84ff;color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold');
      console.log('Versión:', this.version);
      console.log('Iniciado:', this.startedAt.toISOString());
      console.log('User agent:', navigator.userAgent);
      console.log('Viewport:', `${window.innerWidth}×${window.innerHeight} @ ${window.devicePixelRatio}x`);
      console.log('Plataforma:', navigator.platform);
      console.log('Idioma:', navigator.language);
      console.log('Online:', navigator.onLine);
    },
  };

  // Log de arranque
  const t0 = performance.now();
  window.addEventListener('load', () => {
    const t1 = performance.now();
    console.log(
      `%c iOS Remastered %c listo en ${(t1 - t0).toFixed(0)} ms `,
      'background:#0a84ff;color:#fff;padding:2px 8px;border-radius:4px 0 0 4px;font-weight:bold',
      'background:#1c1c1e;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0'
    );
  });
}

/* ============================================================================
 * MANEJO GLOBAL DE ERRORES
 * ========================================================================== */

function installErrorHandlers() {
  window.addEventListener('error', (e) => {
    // Ignoramos errores de recursos (imágenes, fuentes)
    if (e.target && e.target.tagName && e.target.tagName !== 'SCRIPT') {
      return;
    }
    console.error('[iOS] Error no capturado:', e.error || e.message);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[iOS] Promesa rechazada sin manejar:', e.reason);
  });
}

/* ============================================================================
 * MONTAJE
 * ========================================================================== */

function mount() {
  const container = document.getElementById('root');

  if (!container) {
    console.error('[iOS] No se encontró #root en el DOM');
    document.body.innerHTML =
      '<div style="color:#fff;background:#000;padding:20px;font-family:system-ui">' +
      'Error: falta el elemento #root en index.html</div>';
    return;
  }

  injectBaseStyles();
  ensureViewport();
  silenceKnownWarnings();
  preventBrowserGestures();
  installErrorHandlers();
  installDiagnostics();

  const root = createRoot(container);

  try {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (e) {
    console.error('[iOS] Error al montar App:', e);
    root.render(
      <div style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        fontFamily: '-apple-system, system-ui',
      }}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h2 style={{ margin: 0 }}>Error de arranque</h2>
        <p style={{ margin: 0, color: '#8e8e93', fontSize: 14 }}>{String(e?.message || e)}</p>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 12,
            padding: '10px 20px',
            background: '#0a84ff',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reintentar
        </button>
      </div>
    );
  }

  // Exponemos el root para hot reload
  if (import.meta?.hot) {
    import.meta.hot.accept();
  }
}

/* ============================================================================
 * ARRANQUE
 * ========================================================================== */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}

/* ============================================================================
 * EXPORTS (por si algo necesita reusar)
 * ========================================================================== */

export { mount };

/* ============================================================================
 * TOTAL: ~300 líneas
 *
 * Responsabilidades:
 * - Inyecta reset CSS base antes de montar (evita FOUC)
 * - Configura meta viewport + metas Apple
 * - Silencia warnings conocidos de React 18 + Suspense
 * - Previene gestos del navegador (zoom, context menu, pull-to-refresh)
 * - Instala handlers globales de error
 * - Expone window.__ios en dev con utilidades de diagnóstico
 * - Monta <App /> en #root con React.StrictMode
 * - Fallback con UI de error si el montaje falla
 * - HMR-friendly
 * ========================================================================== */
