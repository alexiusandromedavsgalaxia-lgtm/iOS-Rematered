// src/App.jsx
// iOS Remastered — Root component
// Monta OSContext + Toast + Alert + Device y gestiona la máquina de fases:
// boot → lock → home. Cablea atajos globales, safe areas y el registro de apps.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, Suspense,
} from 'react';

import { OSProvider, useOS } from './context/OSContext.jsx';
import { ToastProvider, useToast } from './ui/Toast.jsx';
import { AlertProvider } from './ui/Alert.jsx';
import { GestureProvider } from './ui/GestureHandler.jsx';

import { Device } from './ui/Device.jsx';
import BootScreen from './ui/BootScreen.jsx';
import LockScreen from './ui/LockScreen.jsx';
import Springboard from './ui/Springboard.jsx';
import AppWindow from './ui/AppWindow.jsx';
import ControlCenter from './ui/ControlCenter.jsx';
import NotificationCenterUI from './ui/NotificationCenterUI.jsx';

import registry from './apps/registry.jsx';

import './ios.css';

/* ============================================================================
 * FASES DEL SISTEMA
 * ========================================================================== */

const PHASES = {
  BOOT: 'boot',
  LOCK: 'lock',
  HOME: 'home',
};

/* ============================================================================
 * PROVIDERS COMPUESTOS
 * ========================================================================== */

function Providers({ children }) {
  return (
    <OSProvider>
      <ToastProvider>
        <AlertProvider>
          <GestureProvider>
            {children}
          </GestureProvider>
        </AlertProvider>
      </ToastProvider>
    </OSProvider>
  );
}

/* ============================================================================
 * ORQUESTADOR DE FASES
 * ========================================================================== */

function SystemShell() {
  const os = useOS();
  const toast = useToast();

  const [phase, setPhase] = useState(PHASES.BOOT);
  const [previousPhase, setPreviousPhase] = useState(null);
  const [appWindows, setAppWindows] = useState([]);
  const [activeWindowId, setActiveWindowId] = useState(null);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showNotificationCenter, setShowNotificationCenter] = useState(false);
  const [wallpaper, setWallpaper] = useState(null);
  const [orientation, setOrientation] = useState('portrait');
  const [uiHidden, setUiHidden] = useState(false);

  const bootStartRef = useRef(Date.now());

  /* -------------------------- Arranque -------------------------- */

  useEffect(() => {
    if (!os?.ready) return;
    // Cuando el OS termina de arrancar, pasamos a lock
    if (os.phase === 'ready' && phase === PHASES.BOOT) {
      bootStartRef.current = Date.now();
    }
  }, [os?.ready, os?.phase, phase]);

  const handleBootComplete = useCallback(() => {
    const bootTime = Date.now() - bootStartRef.current;
    const minBoot = 2200;
    const delay = Math.max(0, minBoot - bootTime);

    setTimeout(() => {
      setPreviousPhase(PHASES.BOOT);
      // Si Face ID está configurado, arrancamos en lock; si no, en home
      const faceIdEnabled = os?.keychain?.has?.('faceid.enabled');
      setPhase(faceIdEnabled === false ? PHASES.HOME : PHASES.LOCK);
    }, delay);
  }, [os]);

  const handleUnlock = useCallback(() => {
    setPreviousPhase(PHASES.LOCK);
    setPhase(PHASES.HOME);
    os?.haptics?.impact?.('light');
    os?.notificationCenter?.post?.({
      bundleId: 'com.apple.springboard',
      title: 'Bienvenido',
      body: 'iOS Remastered desbloqueado',
    });
  }, [os]);

  const handleLock = useCallback(() => {
    // Cerrar todas las ventanas antes de bloquear
    setAppWindows([]);
    setActiveWindowId(null);
    setShowControlCenter(false);
    setShowNotificationCenter(false);
    setPhase(PHASES.LOCK);
    os?.haptics?.impact?.('medium');
  }, [os]);

  /* -------------------------- Gestión de ventanas -------------------------- */

  const launchApp = useCallback((bundleId, opts = {}) => {
    const app = registry.get(bundleId);
    if (!app) {
      toast.error(`App no encontrada: ${bundleId}`);
      return null;
    }
    if (!app.loader) {
      toast.error(`${app.displayName || app.name} no tiene contenido`);
      return null;
    }

    // Singleton: si ya hay una ventana abierta, la traemos al frente
    if (app.singleton || opts.singleton) {
      const existing = appWindows.find((w) => w.bundleId === bundleId);
      if (existing) {
        setActiveWindowId(existing.id);
        return existing.id;
      }
    }

    const id = `win_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const win = {
      id,
      bundleId,
      app,
      openedAt: Date.now(),
      heroRect: opts.heroRect || null,
      sourceIconRect: opts.sourceIconRect || null,
      payload: opts.payload || null,
      status: 'launching',
    };

    setAppWindows((prev) => [...prev, win]);
    setActiveWindowId(id);
    os?.haptics?.impact?.('light');

    // Transición launching → running
    setTimeout(() => {
      setAppWindows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, status: 'running' } : w))
      );
    }, 220);

    return id;
  }, [appWindows, os, toast]);

  const closeApp = useCallback((windowId) => {
    const win = appWindows.find((w) => w.id === windowId);
    if (!win) return;

    setAppWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, status: 'closing' } : w))
    );

    setTimeout(() => {
      setAppWindows((prev) => prev.filter((w) => w.id !== windowId));
      setActiveWindowId((cur) => (cur === windowId ? null : cur));
    }, 260);

    os?.haptics?.impact?.('light');
  }, [appWindows, os]);

  const minimizeApp = useCallback((windowId) => {
    setAppWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, status: 'background' } : w))
    );
    setActiveWindowId(null);
  }, []);

  const focusApp = useCallback((windowId) => {
    setAppWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, status: 'running' } : w))
    );
    setActiveWindowId(windowId);
  }, []);

  const closeAllApps = useCallback(() => {
    setAppWindows([]);
    setActiveWindowId(null);
  }, []);

  /* -------------------------- Exponer API al OSContext -------------------------- */

  useEffect(() => {
    if (!os) return;
    os.launchApp = launchApp;
    os.closeApp = closeApp;
    os.minimizeApp = minimizeApp;
    os.focusApp = focusApp;
    os.closeAllApps = closeAllApps;
    os.lock = handleLock;
    os.unlock = handleUnlock;
    os.openControlCenter = () => setShowControlCenter(true);
    os.closeControlCenter = () => setShowControlCenter(false);
    os.openNotificationCenter = () => setShowNotificationCenter(true);
    os.closeNotificationCenter = () => setShowNotificationCenter(false);
    os.setWallpaper = setWallpaper;
    os.getWallpaper = () => wallpaper;
  }, [os, launchApp, closeApp, minimizeApp, focusApp, closeAllApps, handleLock, handleUnlock, wallpaper]);

  /* -------------------------- Atajos de teclado -------------------------- */

  useEffect(() => {
    const onKey = (e) => {
      // Escape: cerrar control center / notification center / app activa
      if (e.key === 'Escape') {
        if (showControlCenter) { setShowControlCenter(false); return; }
        if (showNotificationCenter) { setShowNotificationCenter(false); return; }
        if (activeWindowId) { closeApp(activeWindowId); return; }
      }
      // Cmd/Ctrl + L: bloquear
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleLock();
      }
      // Cmd/Ctrl + H: home (cerrar ventana activa)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        if (activeWindowId) minimizeApp(activeWindowId);
      }
      // Cmd/Ctrl + Q: cerrar todas
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        closeAllApps();
      }
      // Cmd/Ctrl + C: centro de control
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowControlCenter((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showControlCenter, showNotificationCenter, activeWindowId, closeApp, minimizeApp, closeAllApps, handleLock]);

  /* -------------------------- Detección de orientación -------------------------- */

  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setOrientation(w > h ? 'landscape' : 'portrait');
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  /* -------------------------- Notificaciones del OS -------------------------- */

  useEffect(() => {
    if (!os?.notificationCenter?.subscribe) return;
    const unsub = os.notificationCenter.subscribe((notif) => {
      // Si estamos en home, mostrar banner toast
      if (phase === PHASES.HOME) {
        const app = registry.get(notif.bundleId);
        toast.info(
          `${app?.displayName || notif.bundleId}: ${notif.title || notif.body || ''}`.slice(0, 80)
        );
      }
    });
    return unsub;
  }, [os, phase, toast]);

  /* -------------------------- Boot: fases internas -------------------------- */

  // Si el OS aún no está listo, forzamos boot screen
  if (!os?.ready) {
    return (
      <Device orientation={orientation}>
        <BootScreen onComplete={() => { /* esperamos a os.ready */ }} />
      </Device>
    );
  }

  /* -------------------------- Render principal -------------------------- */

  return (
    <Device orientation={orientation}>
      {/* Boot */}
      {phase === PHASES.BOOT && (
        <BootScreen onComplete={handleBootComplete} />
      )}

      {/* Lock */}
      {phase === PHASES.LOCK && (
        <LockScreen
          onUnlock={handleUnlock}
          wallpaper={wallpaper}
        />
      )}

      {/* Home */}
      {phase === PHASES.HOME && (
        <>
          <Springboard
            wallpaper={wallpaper}
            onLaunchApp={launchApp}
            onOpenControlCenter={() => setShowControlCenter(true)}
            onOpenNotificationCenter={() => setShowNotificationCenter(true)}
          />

          {/* Ventanas de apps */}
          <div className="app-windows-layer">
            {appWindows.map((win) => (
              <AppWindow
                key={win.id}
                window={win}
                active={win.id === activeWindowId}
                onClose={() => closeApp(win.id)}
                onMinimize={() => minimizeApp(win.id)}
                onFocus={() => focusApp(win.id)}
              >
                <Suspense fallback={<AppLoader app={win.app} />}>
                  <LazyApp app={win.app} window={win} />
                </Suspense>
              </AppWindow>
            ))}
          </div>

          {/* Indicador Home */}
          {activeWindowId && (
            <div
              className="home-indicator"
              onClick={() => minimizeApp(activeWindowId)}
              title="Volver al inicio"
            />
          )}
        </>
      )}

      {/* Control Center (overlay global) */}
      <ControlCenter
        open={showControlCenter}
        onClose={() => setShowControlCenter(false)}
      />

      {/* Notification Center (overlay global) */}
      <NotificationCenterUI
        open={showNotificationCenter}
        onClose={() => setShowNotificationCenter(false)}
      />

      {/* Debug overlay en dev */}
      {import.meta?.env?.DEV && (
        <DebugOverlay
          phase={phase}
          windows={appWindows.length}
          active={activeWindowId}
          orientation={orientation}
        />
      )}
    </Device>
  );
}

/* ============================================================================
 * CARGA DE APPS LAZY
 * ========================================================================== */

function LazyApp({ app, window: win }) {
  if (!app || !app.loader) {
    return (
      <div className="app-error">
        <div className="app-error-icon">⚠️</div>
        <h2>App no disponible</h2>
        <p>{app?.displayName || app?.name || 'Desconocida'}</p>
      </div>
    );
  }

  const Component = React.useMemo(() => {
    try {
      return React.lazy(app.loader);
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [app.bundleId]);

  if (!Component) {
    return (
      <div className="app-error">
        <div className="app-error-icon">⚠️</div>
        <h2>Error al cargar</h2>
        <p>{app.displayName}</p>
      </div>
    );
  }

  return (
    <Component
      appWindowId={win.id}
      instanceId={win.id}
      payload={win.payload}
    />
  );
}

function AppLoader({ app }) {
  const color = app?.color || '#0a84ff';
  return (
    <div className="app-loader">
      <div className="app-loader-icon" style={{
        background: app?.gradient
          ? `linear-gradient(135deg, ${app.gradient.join(', ')})`
          : color,
      }}>
        <span>{app?.displayName?.[0] || '?'}</span>
      </div>
      <div className="app-loader-spinner" />
      <span className="app-loader-name">{app?.displayName || app?.name}</span>
    </div>
  );
}

/* ============================================================================
 * DEBUG OVERLAY
 * ========================================================================== */

function DebugOverlay({ phase, windows, active, orientation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`debug-overlay ${open ? 'is-open' : ''}`}>
      <button className="debug-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '×' : 'ⓘ'}
      </button>
      {open && (
        <div className="debug-panel">
          <div className="debug-row">
            <span>Fase</span>
            <strong>{phase}</strong>
          </div>
          <div className="debug-row">
            <span>Ventanas</span>
            <strong>{windows}</strong>
          </div>
          <div className="debug-row">
            <span>Activa</span>
            <strong>{active || '—'}</strong>
          </div>
          <div className="debug-row">
            <span>Orientation</span>
            <strong>{orientation}</strong>
          </div>
          <div className="debug-row">
            <span>Apps registradas</span>
            <strong>{registry.all().length}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * ROOT
 * ========================================================================== */

export default function App() {
  return (
    <Providers>
      <SystemShell />
    </Providers>
  );
}

/* ============================================================================
 * ESTILOS INLINE DEL ROOT
 * Los principales van en ios.css; aquí solo lo esencial para no romper
 * el render si ios.css no estuviese cargado.
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('app-root-styles')) {
  const s = document.createElement('style');
  s.id = 'app-root-styles';
  s.textContent = `
  html, body, #root {
    width: 100%; height: 100%;
    margin: 0; padding: 0;
    overflow: hidden;
    background: #000;
    font-family: -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-tap-highlight-color: transparent;
    overscroll-behavior: none;
  }

  .app-windows-layer {
    position: absolute; inset: 0;
    pointer-events: none;
    z-index: 100;
  }
  .app-windows-layer > * {
    pointer-events: auto;
  }

  .home-indicator {
    position: absolute;
    bottom: 6px; left: 50%; transform: translateX(-50%);
    width: 140px; height: 5px;
    border-radius: 3px;
    background: rgba(255,255,255,0.85);
    z-index: 500;
    cursor: pointer;
    transition: opacity .2s;
  }
  .home-indicator:hover {
    background: rgba(255,255,255,1);
  }

  .app-loader {
    position: absolute; inset: 0;
    background: #000;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 16px;
    color: #8e8e93;
  }
  .app-loader-icon {
    width: 78px; height: 78px;
    border-radius: 18px;
    display: flex; align-items: center; justify-content: center;
    font-size: 36px;
    color: #fff;
    font-weight: 300;
    box-shadow: 0 8px 30px rgba(0,0,0,.4);
  }
  .app-loader-spinner {
    width: 24px; height: 24px;
    border-radius: 50%;
    border: 2.5px solid rgba(255,255,255,.15);
    border-top-color: #0a84ff;
    animation: app-spin .7s linear infinite;
  }
  @keyframes app-spin { to { transform: rotate(360deg); } }
  .app-loader-name {
    font-size: 15px;
    color: #fff;
    font-weight: 500;
  }

  .app-error {
    position: absolute; inset: 0;
    background: #1c1c1e;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 12px;
    color: #fff;
    padding: 40px;
    text-align: center;
  }
  .app-error-icon {
    font-size: 48px;
    filter: grayscale(.4);
  }
  .app-error h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  .app-error p {
    margin: 0;
    color: #8e8e93;
    font-size: 14px;
  }

  .debug-overlay {
    position: absolute;
    top: 8px; right: 8px;
    z-index: 10000;
    font-family: ui-monospace, Menlo, monospace;
  }
  .debug-toggle {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: rgba(0,0,0,.7);
    color: #0a84ff;
    border: 1px solid rgba(10,132,255,.4);
    font-size: 16px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .debug-panel {
    position: absolute;
    top: 40px; right: 0;
    background: rgba(0,0,0,.9);
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 8px;
    padding: 10px 12px;
    min-width: 200px;
    font-size: 11px;
    color: #fff;
  }
  .debug-row {
    display: flex; justify-content: space-between;
    padding: 3px 0;
    gap: 12px;
  }
  .debug-row span { color: #8e8e93; }
  .debug-row strong { color: #0a84ff; font-weight: 600; }
  `;
  document.head.appendChild(s);
}
