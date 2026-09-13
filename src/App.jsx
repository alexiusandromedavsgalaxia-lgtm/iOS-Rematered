// src/App.jsx
// iOS Remastered — Root component
// Monta OSContext + Toast + Alert + Gesture + Device y gestiona la máquina de fases:
// boot → lock → home. Cablea atajos globales, notificaciones y el registro de apps.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useCallback, Suspense,
} from 'react';

// Instala las compatibilidades del HardwareBus antes de que OSProvider arranque el bus.
import './drivers/HardwareBusCompat.js';

import { OSProvider, useOS } from './context/OSContext.jsx';
import { ToastProvider, useToast } from './ui/Toast.jsx';
import { AlertProvider } from './ui/Alert.jsx';
import { GestureProvider } from './ui/GestureHandler.jsx';

import { Device } from './ui/Device.jsx';
import BootScreen from './ui/BootScreen.jsx';
import LockScreen from './ui/LockScreen.jsx';
import SpringBoard from './ui/Springboard.jsx';
import AppWindow from './ui/AppWindow.jsx';
import ControlCenter from './ui/ControlCenter.jsx';
import NotificationCenterUI from './ui/NotificationCenterUI.jsx';
import { StatusBar } from './ui/StatusBar.jsx';

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
 * PROVIDERS
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
 * SYSTEM SHELL
 * ========================================================================== */

function SystemShell() {
  const os = useOS();
  const toast = useToast();

  const [phase, setPhase] = useState(PHASES.BOOT);
  const [appWindows, setAppWindows] = useState([]);
  const [activeWindowId, setActiveWindowId] = useState(null);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showNotificationCenter, setShowNotificationCenter] = useState(false);
  const [wallpaper, setWallpaper] = useState(null);
  const [orientation, setOrientation] = useState('portrait');

  const bootStartRef = useRef(Date.now());

  /* -------------------------- Arranque -------------------------- */

  const handleBootComplete = useCallback(() => {
    const bootTime = Date.now() - bootStartRef.current;
    const minBoot = 2200;
    const delay = Math.max(0, minBoot - bootTime);

    setTimeout(() => {
      const faceIdEnabled = os?.keychain?.has?.('faceid.enabled');
      setPhase(faceIdEnabled === false ? PHASES.HOME : PHASES.LOCK);
    }, delay);
  }, [os]);

  const handleUnlock = useCallback(() => {
    setPhase(PHASES.HOME);
    os?.haptics?.impact?.('light');
    os?.notificationCenter?.post?.({
      bundleId: 'com.apple.springboard',
      title: 'Bienvenido',
      body: 'iOS Remastered desbloqueado',
    });
  }, [os]);

  const handleLock = useCallback(() => {
    setAppWindows([]);
    setActiveWindowId(null);
    setShowControlCenter(false);
    setShowNotificationCenter(false);
    setPhase(PHASES.LOCK);
    os?.haptics?.impact?.('medium');
  }, [os]);

  /* -------------------------- Ventanas -------------------------- */

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

  /* -------------------------- API del OS -------------------------- */

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

  /* -------------------------- Atajos -------------------------- */

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (showControlCenter) { setShowControlCenter(false); return; }
        if (showNotificationCenter) { setShowNotificationCenter(false); return; }
        if (activeWindowId) { closeApp(activeWindowId); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleLock();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        if (activeWindowId) minimizeApp(activeWindowId);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        closeAllApps();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowControlCenter((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showControlCenter, showNotificationCenter, activeWindowId, closeApp, minimizeApp, closeAllApps, handleLock]);

  /* -------------------------- Orientación -------------------------- */

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

  /* -------------------------- Notificaciones -------------------------- */

  useEffect(() => {
    if (!os?.notificationCenter?.subscribe) return;
    const unsub = os.notificationCenter.subscribe((notif) => {
      if (phase === PHASES.HOME) {
        const app = registry.get(notif.bundleId);
        toast.info(
          `${app?.displayName || notif.bundleId}: ${notif.title || notif.body || ''}`.slice(0, 80)
        );
      }
    });
    return unsub;
  }, [os, phase, toast]);

  /* -------------------------- Render -------------------------- */

  if (!os?.ready) {
    return (
      <Device orientation={orientation}>
        <BootScreen
          onComplete={() => {
            console.warn('[App] BootScreen completó pero os.ready=false. Forzando salida.');
            setPhase(PHASES.HOME);
          }}
          forceCompleteAfter={8000}
          minDuration={2400}
        />
      </Device>
    );
  }

  return (
    <Device orientation={orientation}>
      {phase === PHASES.BOOT && (
        <BootScreen onComplete={handleBootComplete} />
      )}

      {phase === PHASES.LOCK && (
        <LockScreen
          onUnlock={handleUnlock}
          wallpaper={wallpaper}
        />
      )}

      {phase === PHASES.HOME && (
        <>
          <SpringBoard
            wallpaper={wallpaper}
            onLaunchApp={launchApp}
            onOpenControlCenter={() => setShowControlCenter(true)}
            onOpenNotificationCenter={() => setShowNotificationCenter(true)}
          />

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

          {activeWindowId && (
            <div
              className="home-indicator"
              onClick={() => minimizeApp(activeWindowId)}
              title="Volver al inicio"
            />
          )}
        </>
      )}

      <ControlCenter
        open={showControlCenter}
        onClose={() => setShowControlCenter(false)}
      />

      <NotificationCenterUI
        open={showNotificationCenter}
        onClose={() => setShowNotificationCenter(false)}
      />
    </Device>
  );
}

/* ============================================================================
 * CARGA LAZY DE APPS
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
      console.error('[App] Error creando lazy:', e);
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
      <div
        className="app-loader-icon"
        style={{
          background: app?.gradient
            ? `linear-gradient(135deg, ${app.gradient.join(', ')})`
            : color,
        }}
      >
        <span>{app?.displayName?.[0] || '?'}</span>
      </div>
      <div className="app-loader-spinner" />
      <span className="app-loader-name">{app?.displayName || app?.name}</span>
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
