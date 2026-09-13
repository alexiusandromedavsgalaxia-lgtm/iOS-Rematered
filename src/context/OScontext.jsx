// src/context/OSContext.jsx
// Provider global del OS: arranca y cablea todos los subsistemas.
// - Arranque por fases (bus → kernel → system → loader)
// - Wiring: bus ↔ thermal ↔ cpu/gpu, prox ↔ display/touch, als ↔ display,
//   mic ↔ speaker, keychain ↔ fs, notifications ↔ bus, macho ↔ memory/vcpu
// - Snapshot reactivo cada ~500ms para la UI
// - Acciones de alto nivel (instalar IPA, apagar, suspender, etc.)
// - Hooks: useOS, useKernel, useDriver, useSnapshot, useNotification, ...

import React, {
  createContext, useContext, useEffect, useRef, useState,
  useCallback, useMemo, useSyncExternalStore,
} from 'react';

import { Logger } from '../system/Logger.js';
import { Kernel } from '../kernel/Kernel.js';
import { HardwareBus, DEVICE_MODEL } from '../drivers/HardwareBus.js';
import { FileSystem, createDefaultFileSystem } from '../system/FileSystem.js';
import { Keychain } from '../system/Keychain.js';
import { NotificationCenter } from '../system/NotificationCenter.js';
import { MachOLoader } from '../loader/MachOLoader.js';
import { IPAInstaller } from '../loader/IPAInstaller.js';
import { AppSandbox } from '../loader/AppSandbox.js';

const LOG_TAG = 'OS';

/* ------------------------------------------------------------------ *
 * Estados del OS
 * ------------------------------------------------------------------ */

export const OS_STATE = {
  OFF:       'off',
  BOOTING:   'booting',
  RUNNING:   'running',
  SLEEPING:  'sleeping',
  LOCKED:    'locked',
  PANIC:     'panic',
  SHUTDOWN:  'shutdown',
};

export const BOOT_PHASE = {
  HARDWARE:   'hardware',
  KERNEL:     'kernel',
  SYSTEM:     'system',
  LOADER:     'loader',
  UI:         'ui',
  READY:      'ready',
};

/* ------------------------------------------------------------------ *
 * Snapshot reactivo (store minimalista)
 * ------------------------------------------------------------------ */

class OSStore {
  constructor() {
    this.listeners = new Set();
    this.snapshot = { version: 0 };
  }

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  setSnapshot(partial) {
    this.snapshot = {
      ...this.snapshot,
      ...partial,
      version: (this.snapshot.version || 0) + 1,
      updatedAt: Date.now(),
    };
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { /* noop */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Contexto
 * ------------------------------------------------------------------ */

const OSContext = createContext(null);

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export function OSProvider({
  children,
  autoBoot = true,
  bootOptions = {},
  tickIntervalMs = 100,      // drivers
  snapshotIntervalMs = 500,  // snapshot reactivo
}) {
  // --- Instancias de subsistemas (estables durante todo el ciclo) ---
  const instancesRef = useRef(null);
  if (!instancesRef.current) {
    instancesRef.current = {
      bus: null,
      kernel: null,
      fs: null,
      keychain: null,
      notifications: null,
      loader: null,
      ipa: null,
      sandboxes: new Map(),
      store: new OSStore(),
      bootStart: 0,
      bootEnd: 0,
      errors: [],
    };
  }
  const inst = instancesRef.current;

  const [osState, setOsState] = useState(OS_STATE.OFF);
  const [bootPhase, setBootPhase] = useState(null);
  const [bootProgress, setBootProgress] = useState(0);

  const tickHandleRef = useRef(null);
  const snapHandleRef = useRef(null);

  /* ================================================================ *
   * Boot
   * ================================================================ */

  const boot = useCallback(() => {
    if (osState !== OS_STATE.OFF && osState !== OS_STATE.SHUTDOWN) return;
    setOsState(OS_STATE.BOOTING);
    inst.bootStart = performance.now();
    inst.errors = [];

    Logger.kernel(LOG_TAG, '════════ iOS Remastered boot ════════');
    Logger.kernel(LOG_TAG, `Modelo: ${DEVICE_MODEL.name} (${DEVICE_MODEL.soc})`);

    try {
      // --- Fase 1: Hardware bus ---
      setBootPhase(BOOT_PHASE.HARDWARE);
      setBootProgress(5);
      const bus = new HardwareBus({ tickIntervalMs, ...bootOptions.bus });
      bus.subscribe((evt) => {
        // Reenvía eventos críticos del bus al Logger global
        if (evt.type === 'panic') Logger.fatal?.(LOG_TAG, `Bus panic: ${evt.payload?.reason}`);
      });
      inst.bus = bus;

      // Boot del bus: instancia todos los drivers y resuelve links
      const bootReport = bus.boot();
      if (bootReport.bootErrors > 0) {
        Logger.warn(LOG_TAG, `Bus arrancó con ${bootReport.bootErrors} errores`);
      }
      setBootProgress(30);

      // --- Fase 2: Kernel ---
      setBootPhase(BOOT_PHASE.KERNEL);
      setBootProgress(40);
      const kernel = new Kernel({
        memory: bootOptions.memory,
        schedulerHz: bootOptions.schedulerHz || 60,
      });
      kernel.boot?.();
      inst.kernel = kernel;
      // Cede el tick del bus al kernel (si procede)
      if (kernel.onTick) {
        // Encadenamos: bus.tick → kernel.tick
        // (en este diseño el kernel tiene su propio scheduler)
      }
      setBootProgress(60);

      // --- Fase 3: Sistema (FS, Keychain, Notifications) ---
      setBootPhase(BOOT_PHASE.SYSTEM);
      setBootProgress(65);

      const fs = createDefaultFileSystem(bus.getStorage?.() || null);
      inst.fs = fs;

      const keychain = new Keychain({ fs });
      keychain.registerApp('com.apple.Preferences', { groups: ['system'] });
      keychain.registerApp('com.apple.mobilesafari', { groups: ['system', 'web'] });
      inst.keychain = keychain;

      const notifications = new NotificationCenter({ fs });
      notifications.connectAPNs();
      notifications.registerCategory('MESSAGE', [
        { id: 'reply', title: 'Responder', options: ['foreground'] },
        { id: 'mark-read', title: 'Marcar como leída' },
      ]);
      notifications.registerCategory('CALL', [
        { id: 'accept', title: 'Aceptar', options: ['foreground'] },
        { id: 'decline', title: 'Rechazar', options: ['destructive'] },
      ]);
      inst.notifications = notifications;

      setBootProgress(75);

      // --- Fase 4: Loader / Mach-O / IPA ---
      setBootPhase(BOOT_PHASE.LOADER);
      setBootProgress(85);

      const loader = new MachOLoader({
        memory: kernel.getMemory?.() || null,
        fs,
        vcpu: bus.getCPU?.() || null,
      });
      inst.loader = loader;

      const ipa = new IPAInstaller({ fs });
      ipa.subscribe((evt) => {
        if (evt.type === 'installed') {
          const { bundleId, name, version } = evt.payload.bundle;
          notifications.post({
            bundleId: 'com.apple.install',
            title: 'App instalada',
            body: `${name} ${version} (${bundleId})`,
            style: 'banner',
          });
        }
      });
      inst.ipa = ipa;

      setBootProgress(95);

      // --- Fase 5: UI ready ---
      setBootPhase(BOOT_PHASE.UI);

      inst.bootEnd = performance.now();
      const dur = Math.round(inst.bootEnd - inst.bootStart);
      Logger.kernel(LOG_TAG, `════════ Boot completo en ${dur}ms ════════`);

      setBootProgress(100);
      setBootPhase(BOOT_PHASE.READY);
      setOsState(OS_STATE.RUNNING);

      // Arranca tick loop y snapshot loop
      _startLoops();
    } catch (e) {
      inst.errors.push(e);
      Logger.fatal?.(LOG_TAG, `Boot falló: ${e.message}`);
      setOsState(OS_STATE.PANIC);
      setBootPhase(null);
      setBootProgress(0);
    }
  }, [osState, tickIntervalMs, bootOptions]);

  /* ================================================================ *
   * Tick / Snapshot loops
   * ================================================================ */

  const _startLoops = useCallback(() => {
    // El bus ya tiene su propio tick loop interno. Aquí solo hacemos
    // el snapshot reactivo para la UI.
    if (snapHandleRef.current) clearInterval(snapHandleRef.current);
    snapHandleRef.current = setInterval(() => {
      if (!inst.bus || !inst.kernel) return;
      _updateSnapshot();
    }, snapshotIntervalMs);
  }, [snapshotIntervalMs]);

  const _stopLoops = useCallback(() => {
    if (tickHandleRef.current) { clearInterval(tickHandleRef.current); tickHandleRef.current = null; }
    if (snapHandleRef.current) { clearInterval(snapHandleRef.current); snapHandleRef.current = null; }
  }, []);

  const _updateSnapshot = useCallback(() => {
    const s = {};
    s.osState = osState;
    s.time = Date.now();

    // Batería
    const bat = inst.bus?.getBattery?.();
    if (bat?.getReading) {
      try { s.battery = bat.getReading(); } catch {}
    }

    // Térmica
    const th = inst.bus?.getThermal?.();
    if (th?.getReading) {
      try { s.thermal = th.getReading(); } catch {}
    }

    // WiFi / Cellular
    try { s.wifi = inst.bus?.getWiFi?.()?.getReading?.(); } catch {}
    try { s.cellular = inst.bus?.getCellular?.()?.getReading?.(); } catch {}

    // Apps instaladas
    if (inst.ipa) {
      try {
        s.apps = inst.ipa.listApps().map(a => ({
          bundleId: a.bundleId,
          name: a.displayName || a.name,
          version: a.version,
          icon: a.icons?.assetName || null,
        }));
      } catch {}
    }

    // Notificaciones
    if (inst.notifications) {
      try {
        s.notifications = {
          total: inst.notifications.getStats().totalDelivered,
          totalBadge: inst.notifications.getTotalBadge(),
          list: inst.notifications.list({ limit: 20 }),
        };
      } catch {}
    }

    // Focus
    if (inst.notifications) {
      s.focus = inst.notifications.focus;
    }

    // Storage
    if (inst.fs) {
      try {
        const st = inst.fs.getStats();
        s.storage = {
          volumes: st.volumes,
          openFds: st.openFds,
          mountedVolumes: st.mountedVolumes,
        };
      } catch {}
    }

    // Bus global
    if (inst.bus) {
      try { s.bus = inst.bus.getGlobalStats(); } catch {}
    }

    inst.store.setSnapshot(s);
  }, [osState]);

  /* ================================================================ *
   * Apagado / suspensión / panic
   * ================================================================ */

  const shutdown = useCallback(() => {
    if (osState === OS_STATE.SHUTDOWN || osState === OS_STATE.OFF) return;
    Logger.kernel(LOG_TAG, 'Shutdown iniciado');
    _stopLoops();
    try { inst.bus?.shutdown(); } catch (e) { Logger.warn(LOG_TAG, `bus.shutdown: ${e.message}`); }
    try { inst.kernel?.shutdown?.(); } catch (e) { Logger.warn(LOG_TAG, `kernel.shutdown: ${e.message}`); }
    try { inst.keychain?.lock(); } catch {}
    try { inst.notifications?.save(); } catch {}
    setOsState(OS_STATE.SHUTDOWN);
  }, [osState, _stopLoops]);

  const sleep = useCallback(() => {
    if (osState !== OS_STATE.RUNNING && osState !== OS_STATE.LOCKED) return;
    Logger.kernel(LOG_TAG, 'Sleep');
    try { inst.bus?.getDisplay?.()?.setScreenOff?.(true); } catch {}
    try { inst.keychain?.lock(); } catch {}
    setOsState(OS_STATE.SLEEPING);
  }, [osState]);

  const wake = useCallback(() => {
    if (osState !== OS_STATE.SLEEPING) return;
    Logger.kernel(LOG_TAG, 'Wake');
    try { inst.bus?.getDisplay?.()?.setScreenOff?.(false); } catch {}
    setOsState(OS_STATE.LOCKED);
  }, [osState]);

  const panic = useCallback((reason) => {
    Logger.fatal?.(LOG_TAG, `PANIC: ${reason}`);
    _stopLoops();
    try { inst.bus?.panic?.(reason); } catch {}
    setOsState(OS_STATE.PANIC);
  }, [_stopLoops]);

  const recover = useCallback(() => {
    if (osState !== OS_STATE.PANIC) return;
    Logger.warn(LOG_TAG, 'Recover desde PANIC → boot');
    setOsState(OS_STATE.OFF);
    setBootProgress(0);
    setBootPhase(null);
    // El siguiente render permitirá boot() de nuevo
  }, [osState]);

  /* ================================================================ *
   * Acciones de alto nivel
   * ================================================================ */

  const installIPA = useCallback((ipaData, opts = {}) => {
    if (!inst.ipa) throw new Error('OS no booted');
    return inst.ipa.install(ipaData, opts);
  }, []);

  const uninstallApp = useCallback((bundleId, opts = {}) => {
    if (!inst.ipa) throw new Error('OS no booted');
    return inst.ipa.uninstall(bundleId, opts);
  }, []);

  const launchApp = useCallback((bundleId) => {
    if (!inst.ipa || !inst.loader) throw new Error('OS no booted');
    const app = inst.ipa.getApp(bundleId);
    if (!app) throw new Error(`app no instalada: ${bundleId}`);
    // Carga el binario desde el bundle instalado
    const binaryPath = `${app.bundlePath}/${app.executableName}`;
    let image;
    try {
      image = inst.loader.load(binaryPath);
    } catch (e) {
      Logger.warn(LOG_TAG, `launchApp(${bundleId}) load falló: ${e.message}`);
      return { success: false, error: e.message };
    }
    const result = inst.loader.launch(image.id, { argv: [app.executableName] });
    return { success: true, image: image.toMetadata(), launch: result };
  }, []);

  const getSandbox = useCallback((bundleId) => {
    if (inst.sandboxes.has(bundleId)) return inst.sandboxes.get(bundleId);
    const app = inst.ipa?.getApp(bundleId);
    if (!app) return null;
    const sandbox = new AppSandbox({
      bundleId,
      containerPath: app.dataPath,
      fs: inst.fs,
    });
    inst.sandboxes.set(bundleId, sandbox);
    return sandbox;
  }, []);

  const postNotification = useCallback((opts) => {
    if (!inst.notifications) return null;
    return inst.notifications.post(opts);
  }, []);

  const setFocus = useCallback((mode) => {
    if (!inst.notifications) return false;
    return inst.notifications.setFocus(mode);
  }, []);

  const unlockKeychain = useCallback((method) => {
    if (!inst.keychain) return false;
    return inst.keychain.unlock(method);
  }, []);

  /* ================================================================ *
   * Efectos de ciclo de vida
   * ================================================================ */

  useEffect(() => {
    if (autoBoot) {
      // Pequeño delay para que la UI monte primero
      const t = setTimeout(() => boot(), 50);
      return () => clearTimeout(t);
    }
  }, [autoBoot, boot]);

  useEffect(() => {
    return () => {
      _stopLoops();
      try { inst.bus?.shutdown(); } catch {}
    };
  }, [_stopLoops]);

  /* ================================================================ *
   * Valor de contexto
   * ================================================================ */

  const ctxValue = useMemo(() => ({
    // Estado
    osState,
    bootPhase,
    bootProgress,
    isRunning: osState === OS_STATE.RUNNING,
    isBooted:  osState === OS_STATE.RUNNING || osState === OS_STATE.LOCKED || osState === OS_STATE.SLEEPING,

    // Instancias (raw)
    bus: inst.bus,
    kernel: inst.kernel,
    fs: inst.fs,
    keychain: inst.keychain,
    notifications: inst.notifications,
    loader: inst.loader,
    ipa: inst.ipa,

    // Store reactivo
    store: inst.store,

    // Acciones de ciclo de vida
    boot,
    shutdown,
    sleep,
    wake,
    panic,
    recover,

    // Acciones de alto nivel
    installIPA,
    uninstallApp,
    launchApp,
    getSandbox,
    postNotification,
    setFocus,
    unlockKeychain,

    // Atajos a drivers
    getDriver: (id) => inst.bus?.get?.(id) || null,
    getCPU: () => inst.bus?.getCPU?.() || null,
    getGPU: () => inst.bus?.getGPU?.() || null,
    getThermal: () => inst.bus?.getThermal?.() || null,
    getDisplay: () => inst.bus?.getDisplay?.() || null,
    getBattery: () => inst.bus?.getBattery?.() || null,
    getWiFi: () => inst.bus?.getWiFi?.() || null,
    getCellular: () => inst.bus?.getCellular?.() || null,
    getMic: () => inst.bus?.getMic?.() || null,
    getSpeaker: () => inst.bus?.getSpeaker?.() || null,
    getTaptic: () => inst.bus?.getTaptic?.() || null,
    getCamera: () => inst.bus?.getCamera?.() || null,
    getGPS: () => inst.bus?.getGPS?.() || null,
    getALS: () => inst.bus?.getALS?.() || null,
    getProx: () => inst.bus?.getProx?.() || null,

    // Meta
    model: DEVICE_MODEL,
    errors: inst.errors,
  }), [
    osState, bootPhase, bootProgress,
    boot, shutdown, sleep, wake, panic, recover,
    installIPA, uninstallApp, launchApp, getSandbox,
    postNotification, setFocus, unlockKeychain,
  ]);

  return <OSContext.Provider value={ctxValue}>{children}</OSContext.Provider>;
}

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

export function useOS() {
  const ctx = useContext(OSContext);
  if (!ctx) throw new Error('useOS must be used within <OSProvider>');
  return ctx;
}

export function useKernel() {
  const { kernel } = useOS();
  return kernel;
}

export function useDriver(id) {
  const { bus } = useOS();
  return bus?.get?.(id) || null;
}

// Snapshot reactivo (usa useSyncExternalStore)
export function useOSSnapshot() {
  const { store } = useOS();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// Selector con re-render sólo si cambia una porción
export function useOSSelector(selector, isEqual = Object.is) {
  const { store } = useOS();
  const lastRef = useRef();
  const getSnap = useCallback(() => {
    const s = store.getSnapshot();
    const next = selector(s);
    if (lastRef.current === undefined || !isEqual(lastRef.current, next)) {
      lastRef.current = next;
    }
    return lastRef.current;
  }, [store, selector, isEqual]);
  return useSyncExternalStore(store.subscribe, getSnap, getSnap);
}

// Acciones compuestas
export function useInstaller() {
  const { installIPA, uninstallApp, ipa } = useOS();
  return useMemo(() => ({
    install: installIPA,
    uninstall: uninstallApp,
    list: () => ipa?.listApps() || [],
    validate: (data) => ipa?.validate(data) || { valid: false },
    get: (bundleId) => ipa?.getApp(bundleId) || null,
  }), [installIPA, uninstallApp, ipa]);
}

export function useNotifications() {
  const { notifications, postNotification, setFocus } = useOS();
  return useMemo(() => ({
    post: postNotification,
    setFocus,
    list: (opts) => notifications?.list(opts) || [],
    dismiss: (id) => notifications?.dismiss(id),
    dismissAll: (bundleId) => notifications?.dismissAll(bundleId),
    markRead: (id) => notifications?.markRead(id),
    markAllRead: (bundleId) => notifications?.markAllRead(bundleId),
    getBadge: (bundleId) => notifications?.getBadge(bundleId) || 0,
    getTotalBadge: () => notifications?.getTotalBadge() || 0,
    registerCategory: (id, actions, opts) => notifications?.registerCategory(id, actions, opts),
    setBadge: (bundleId, n) => notifications?.setBadge(bundleId, n),
    focus: notifications?.focus,
  }), [notifications, postNotification, setFocus]);
}

export function useFileSystem() {
  const { fs } = useOS();
  return fs;
}

export function useKeychain() {
  const { keychain, unlockKeychain } = useOS();
  return useMemo(() => ({
    unlock: unlockKeychain,
    lock: () => keychain?.lock(),
    add: (opts) => keychain?.add(opts),
    update: (id, data, opts) => keychain?.update(id, data, opts),
    delete: (id) => keychain?.delete(id),
    query: (q) => keychain?.query(q) || [],
    getData: (id) => keychain?.getData(id),
    getDataByQuery: (q) => keychain?.getDataByQuery(q),
    setPasscode: (set) => keychain?.setPasscode(set),
    setBiometry: (type) => keychain?.setBiometry(type),
    setCurrentApp: (bundleId) => keychain?.setCurrentApp(bundleId),
    registerApp: (bundleId, opts) => keychain?.registerApp(bundleId, opts),
  }), [keychain, unlockKeychain]);
}

export function useLoader() {
  const { loader, launchApp } = useOS();
  return useMemo(() => ({
    launchApp,
    load: (source, opts) => loader?.load(source, opts),
    unload: (id) => loader?.unload(id),
    list: () => loader?.list() || [],
    getStats: () => loader?.getStats(),
    resolveSymbol: (imageId, name) => loader?.resolveSymbol(imageId, name),
  }), [loader, launchApp]);
}

export default OSContext;
