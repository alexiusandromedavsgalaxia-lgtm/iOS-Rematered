// src/apps/registry.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — registry
//
// Registro central de apps del sistema. Es la fuente de verdad para:
//   • La lista de apps instaladas (usada por Springboard, StatusBar, etc.).
//   • El icono, nombre, colores y metadata de cada app.
//   • El componente render que AppWindow monta al abrir.
//   • Las pages del Springboard (qué apps en qué página).
//   • El Dock (qué apps fijas abajo).
//   • Los permisos/entitlements que la app declara.
//   • La vinculación con LaunchServices del IPAInstaller para apps instaladas.
//
// El registro se compone de dos partes:
//   1. SYSTEM_APPS  → apps nativas de iOS Remastered (definidas aquí).
//   2. USER_APPS    → apps instaladas vía IPA (inyectadas en runtime).
//
// Uso:
//   import registry, { useRegistry } from './registry.jsx';
//
//   const apps = useRegistry();              // todas las apps (sistema + user)
//   const app  = registry.get('settings');   // una app por id
//   registry.register(userApp);              // registrar una app IPA
//   registry.unregister('com.x.y');          // desinstalar
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../context/OSContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline (mini-biblioteca local para no depender de Icon.jsx
// en el registro, que debe poder importarse incluso sin la capa UI cargada)
// ─────────────────────────────────────────────────────────────────────────────

const glyphStyle = { display: 'block', color: '#fff' };

function GlyphSettings({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <circle cx="12" cy="12" r="3.4" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" stroke="#fff" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

function GlyphCalculator({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <rect x="5" y="3" width="14" height="18" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <rect x="7" y="5" width="10" height="4" rx="1" fill="#fff" opacity="0.55" />
      <circle cx="9" cy="13" r="0.9" fill="#fff" />
      <circle cx="12" cy="13" r="0.9" fill="#fff" />
      <circle cx="15" cy="13" r="0.9" fill="#fff" />
      <circle cx="9" cy="17" r="0.9" fill="#fff" />
      <circle cx="12" cy="17" r="0.9" fill="#fff" />
      <circle cx="15" cy="17" r="0.9" fill="#fff" />
    </svg>
  );
}

function GlyphNotes({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <rect x="5" y="3" width="14" height="18" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M8 8 H16 M8 12 H16 M8 16 H13" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GlyphPhotos({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M3 16 L9 10 L13 14 L17 10 L21 14" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="8" r="1.5" fill="#fff" />
    </svg>
  );
}

function GlyphTerminal({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M7 10 L10 13 L7 16" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16 H17" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GlyphMachO({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M5 3 H14 L19 8 V21 H5 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      <path d="M14 3 V8 H19" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      <circle cx="12" cy="15" r="2" stroke="#fff" strokeWidth="1.6" fill="none" />
      <path d="M12 13 V11 M12 17 V19 M10 15 H8 M14 15 H16" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GlyphHardware({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <rect x="5" y="5" width="14" height="14" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="#fff" opacity="0.7" />
      <path d="M9 2 V5 M15 2 V5 M9 19 V22 M15 19 V22 M2 9 H5 M2 15 H5 M19 9 H22 M19 15 H22" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GlyphClock({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M12 6 V12 L16 14" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 2 V3 M12 21 V22 M2 12 H3 M21 12 H22" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GlyphWeather({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <circle cx="12" cy="12" r="4" fill="#fff" />
      <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GlyphFiles({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M3 6 H8 L10 8 H21 V19 H3 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphInstaller({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M12 3 V15" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 10 L12 15 L17 10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17 V20 A1 1 0 0 0 5 21 H19 A1 1 0 0 0 20 20 V17" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function GlyphSafari({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <circle cx="12" cy="12" r="10" stroke="#fff" strokeWidth="1.8" fill="none" />
      <path d="M16 8 L14 14 L8 16 L10 10 Z" fill="#fff" />
    </svg>
  );
}

function GlyphMessages({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M4 5 H20 A2 2 0 0 1 22 7 V16 A2 2 0 0 1 20 18 H11 L6 22 V18 H4 A2 2 0 0 1 2 16 V7 A2 2 0 0 1 4 5 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphPhone({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M5 4 h4 l2 5 -2.5 1.5 a12 12 0 0 0 5 5 L15 13 l5 2 v4 a2 2 0 0 1 -2 2 A16 16 0 0 1 3 6 a2 2 0 0 1 2 -2 z" fill="#fff" />
    </svg>
  );
}

function GlyphMusic({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={glyphStyle}>
      <path d="M9 18 V6 L20 4 V16" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="3" stroke="#fff" strokeWidth="1.8" fill="none" />
      <circle cx="17" cy="16" r="3" stroke="#fff" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements estándar por categoría
// ─────────────────────────────────────────────────────────────────────────────

const ENTITLEMENTS = {
  NONE: [],
  CAMERA: ['com.apple.private.camera'],
  MICROPHONE: ['com.apple.private.microphone'],
  LOCATION: ['com.apple.private.location'],
  PHOTOS: ['com.apple.private.photos.read', 'com.apple.private.photos.write'],
  NETWORK: ['com.apple.private.network.client'],
  FILE_ACCESS: ['com.apple.private.filesystem.user'],
  FULL_DISK: ['com.apple.private.filesystem.all'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de definición
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza una definición de app. Todos los campos son opcionales salvo id y
 * name. Rellena defaults sensatos.
 */
function defineApp(def) {
  const {
    id,
    name,
    glyph,
    emoji,
    color,
    icon,
    render,
    permissions = [],
    pages = 1,
    dock = false,
    system = true,
    statusBarTheme = 'auto',
    supportsMultitasking = false,
    category = 'utilities',
    hidden = false,
    minOSVersion = '1.0',
    version = '1.0.0',
    developer = 'Apple',
    bundleId,
  } = def;
  return {
    id,
    name,
    glyph,
    emoji,
    color: color || 'linear-gradient(160deg, #8e8e93, #48484a)',
    icon: icon || glyph,
    render,
    permissions,
    entitlements: permissions,
    pages,
    dock,
    system,
    statusBarTheme,
    supportsMultitasking,
    category,
    hidden,
    minOSVersion,
    version,
    developer,
    bundleId: bundleId || id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Definición de las apps del sistema
// Cada entrada puede tener un `render` que AppWindow usará al abrir.
// Los `render` concretos viven en sus propios archivos (Settings.jsx, etc.);
// aquí se hace import dinámico con React.lazy() para no cargar todo de golpe.
// ─────────────────────────────────────────────────────────────────────────────

// Lazy imports (cada app se carga solo cuando se abre)
const LazySettings = React.lazy(() => import('./Settings.jsx'));
const LazyCalculator = React.lazy(() => import('./Calculator.jsx'));
const LazyNotes = React.lazy(() => import('./Notes.jsx'));
const LazyPhotos = React.lazy(() => import('./Photos.jsx'));
const LazyTerminal = React.lazy(() => import('./Terminal.jsx'));
const LazyMachOViewer = React.lazy(() => import('./MachOViewer.jsx'));
const LazyHardwareMonitor = React.lazy(() => import('./HardwareMonitor.jsx'));
const LazyClock = React.lazy(() => import('./Clock.jsx').catch(() => ({ default: () => null })));
const LazyWeather = React.lazy(() => import('./Weather.jsx').catch(() => ({ default: () => null })));
const LazyFiles = React.lazy(() => import('./Files.jsx').catch(() => ({ default: () => null })));
const LazySafari = React.lazy(() => import('./Safari.jsx').catch(() => ({ default: () => null })));
const LazyInstaller = React.lazy(() => import('./Installer.jsx').catch(() => ({ default: () => null })));

/** Fallback mientras carga el chunk de la app. */
function AppLoading() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255,255,255,0.7)',
        fontSize: 13,
      }}
    >
      Cargando…
    </div>
  );
}

/** Helper para envolver un lazy component en <Suspense>. */
function lazyRender(Component) {
  return (props) => (
    <React.Suspense fallback={<AppLoading />}>
      <Component {...props} />
    </React.Suspense>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPS DEL SISTEMA
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_APPS = [
  defineApp({
    id: 'com.apple.mobilesafari',
    name: 'Safari',
    glyph: <GlyphSafari />,
    color: 'linear-gradient(160deg, #5ac8fa, #007aff)',
    render: lazyRender(LazySafari),
    permissions: [ENTITLEMENTS.NETWORK],
    category: 'internet',
    statusBarTheme: 'light',
    pages: 1,
  }),
  defineApp({
    id: 'com.apple.mobilephone',
    name: 'Teléfono',
    glyph: <GlyphPhone />,
    color: 'linear-gradient(160deg, #30d158, #34c759)',
    render: null,
    permissions: [ENTITLEMENTS.NETWORK, ENTITLEMENTS.MICROPHONE],
    category: 'communication',
    dock: true,
  }),
  defineApp({
    id: 'com.apple.MobileSMS',
    name: 'Mensajes',
    glyph: <GlyphMessages />,
    color: 'linear-gradient(160deg, #30d158, #34c759)',
    render: null,
    permissions: [ENTITLEMENTS.NETWORK],
    category: 'communication',
    dock: true,
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.mobilemail',
    name: 'Mail',
    glyph: (
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" style={glyphStyle}>
        <rect x="3" y="6" width="18" height="12" rx="2" stroke="#fff" strokeWidth="1.8" fill="none" />
        <path d="M3 7 L12 13 L21 7" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    color: 'linear-gradient(160deg, #5ac8fa, #007aff)',
    render: null,
    permissions: [ENTITLEMENTS.NETWORK],
    category: 'communication',
  }),
  defineApp({
    id: 'com.apple.mobileslideshow',
    name: 'Fotos',
    glyph: <GlyphPhotos />,
    color: 'linear-gradient(160deg, #ffcc00, #ff9500)',
    render: lazyRender(LazyPhotos),
    permissions: [ENTITLEMENTS.PHOTOS],
    category: 'media',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.Music',
    name: 'Música',
    glyph: <GlyphMusic />,
    color: 'linear-gradient(160deg, #ff2d55, #ff6482)',
    render: null,
    permissions: [],
    category: 'media',
    dock: true,
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.mobiletimer',
    name: 'Reloj',
    glyph: <GlyphClock />,
    color: 'linear-gradient(160deg, #1c1c1e, #3a3a3c)',
    render: lazyRender(LazyClock),
    permissions: [],
    category: 'utilities',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.weather',
    name: 'Tiempo',
    glyph: <GlyphWeather />,
    color: 'linear-gradient(160deg, #5ac8fa, #007aff)',
    render: lazyRender(LazyWeather),
    permissions: [ENTITLEMENTS.LOCATION, ENTITLEMENTS.NETWORK],
    category: 'utilities',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.mobilenotes',
    name: 'Notas',
    glyph: <GlyphNotes />,
    color: 'linear-gradient(160deg, #ffcc00, #ff9500)',
    render: lazyRender(LazyNotes),
    permissions: [],
    category: 'productivity',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.calculator',
    name: 'Calculadora',
    glyph: <GlyphCalculator />,
    color: 'linear-gradient(160deg, #8e8e93, #48484a)',
    render: lazyRender(LazyCalculator),
    permissions: [],
    category: 'utilities',
  }),
  defineApp({
    id: 'com.apple.Preferences',
    name: 'Ajustes',
    glyph: <GlyphSettings />,
    color: 'linear-gradient(160deg, #8e8e93, #48484a)',
    render: lazyRender(LazySettings),
    permissions: [ENTITLEMENTS.FULL_DISK],
    category: 'system',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.files',
    name: 'Archivos',
    glyph: <GlyphFiles />,
    color: 'linear-gradient(160deg, #5ac8fa, #0a84ff)',
    render: lazyRender(LazyFiles),
    permissions: [ENTITLEMENTS.FILE_ACCESS],
    category: 'productivity',
    statusBarTheme: 'light',
  }),
  defineApp({
    id: 'com.apple.Terminal',
    name: 'Terminal',
    glyph: <GlyphTerminal />,
    color: 'linear-gradient(160deg, #1c1c1e, #000)',
    render: lazyRender(LazyTerminal),
    permissions: [ENTITLEMENTS.FULL_DISK],
    category: 'developer',
    developer: 'iOS Remastered',
  }),
  defineApp({
    id: 'com.iosremastered.machoviewer',
    name: 'Mach-O',
    glyph: <GlyphMachO />,
    color: 'linear-gradient(160deg, #af52de, #5856d6)',
    render: lazyRender(LazyMachOViewer),
    permissions: [ENTITLEMENTS.FULL_DISK],
    category: 'developer',
    developer: 'iOS Remastered',
  }),
  defineApp({
    id: 'com.iosremastered.hardware',
    name: 'Hardware',
    glyph: <GlyphHardware />,
    color: 'linear-gradient(160deg, #ff375f, #af52de)',
    render: lazyRender(LazyHardwareMonitor),
    permissions: [ENTITLEMENTS.FULL_DISK],
    category: 'developer',
    developer: 'iOS Remastered',
  }),
  defineApp({
    id: 'com.iosremastered.installer',
    name: 'Instalador',
    glyph: <GlyphInstaller />,
    color: 'linear-gradient(160deg, #34c759, #30b0c7)',
    render: lazyRender(LazyInstaller),
    permissions: [ENTITLEMENTS.FULL_DISK, ENTITLEMENTS.NETWORK],
    category: 'system',
    developer: 'iOS Remastered',
    statusBarTheme: 'light',
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Layout por defecto del Springboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Define en qué página y en qué orden van las apps del sistema.
 * Las apps instaladas (IPA) se añaden después en el primer hueco libre.
 */
export const DEFAULT_PAGES = [
  {
    id: 'page-0',
    apps: [
      'com.apple.mobilesafari',
      'com.apple.mobilephone',
      'com.apple.MobileSMS',
      'com.apple.mobilemail',
      'com.apple.mobileslideshow',
      'com.apple.Music',
      'com.apple.mobiletimer',
      'com.apple.weather',
      'com.apple.mobilenotes',
      'com.apple.calculator',
      'com.apple.files',
      'com.iosremastered.installer',
    ],
  },
  {
    id: 'page-1',
    apps: [
      'com.apple.Preferences',
      'com.apple.Terminal',
      'com.iosremastered.machoviewer',
      'com.iosremastered.hardware',
    ],
  },
];

/** Apps que van en el Dock por defecto. */
export const DEFAULT_DOCK = [
  'com.apple.mobilephone',
  'com.apple.mobilesafari',
  'com.apple.MobileSMS',
  'com.apple.Music',
];

// ─────────────────────────────────────────────────────────────────────────────
// Store del registro (singleton)
// ─────────────────────────────────────────────────────────────────────────────

const listeners = new Set();

const store = {
  systemApps: [...SYSTEM_APPS],
  userApps: [],
  pageOverrides: null, // si el usuario reordena
  dockOverrides: null,
  hiddenIds: new Set(),
};

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

/** Todas las apps (sistema + usuario) sin ocultas. */
function getAllApps() {
  const all = [...store.systemApps, ...store.userApps];
  return all.filter((a) => !store.hiddenIds.has(a.id));
}

/** Busca una app por id. */
function getApp(id) {
  if (!id) return null;
  return (
    store.systemApps.find((a) => a.id === id) ||
    store.userApps.find((a) => a.id === id) ||
    null
  );
}

/** Registra una app instalada (IPA). */
function registerUserApp(app) {
  const normalized = defineApp({ ...app, system: false });
  // Evitar duplicados: si ya existe el mismo bundleId, reemplazar
  const idx = store.userApps.findIndex((a) => a.id === normalized.id);
  if (idx >= 0) {
    store.userApps = [
      ...store.userApps.slice(0, idx),
      normalized,
      ...store.userApps.slice(idx + 1),
    ];
  } else {
    store.userApps = [...store.userApps, normalized];
  }
  emit();
  return normalized;
}

/** Desinstala una app. */
function unregisterUserApp(id) {
  store.userApps = store.userApps.filter((a) => a.id !== id);
  emit();
}

/** Oculta/muestra una app sin desinstalarla. */
function setHidden(id, hidden) {
  if (hidden) store.hiddenIds.add(id);
  else store.hiddenIds.delete(id);
  emit();
}

/** Define el orden de páginas manualmente. */
function setPages(pages) {
  store.pageOverrides = pages;
  emit();
}

/** Define el Dock manualmente. */
function setDock(dock) {
  store.dockOverrides = dock;
  emit();
}

/** Resetea el layout a los defaults. */
function resetLayout() {
  store.pageOverrides = null;
  store.dockOverrides = null;
  emit();
}

/**
 * Calcula las páginas efectivas: usa overrides si existen, si no, el default
 * más las apps de usuario colocadas en huecos libres.
 */
function getPages() {
  const allApps = getAllApps();
  const byId = new Map(allApps.map((a) => [a.id, a]));

  // Base: páginas default filtradas por apps existentes
  const basePages = (store.pageOverrides || DEFAULT_PAGES).map((p) => ({
    id: p.id,
    apps: p.apps
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((a) => a.id),
  }));

  // Si no hay overrides, añadir apps de usuario a las páginas default
  if (!store.pageOverrides) {
    const placed = new Set(basePages.flatMap((p) => p.apps));
    const pending = allApps
      .filter((a) => !placed.has(a.id) && !a.dock)
      .map((a) => a.id);

    const APPS_PER_PAGE = 24;
    let lastPage = basePages[basePages.length - 1];
    if (!lastPage) {
      lastPage = { id: 'page-0', apps: [] };
      basePages.push(lastPage);
    }
    for (const id of pending) {
      if (lastPage.apps.length >= APPS_PER_PAGE) {
        lastPage = { id: `page-${basePages.length}`, apps: [] };
        basePages.push(lastPage);
      }
      lastPage.apps.push(id);
    }
  }

  return basePages;
}

/** Dock efectivo (ids). */
function getDock() {
  if (store.dockOverrides) return store.dockOverrides;
  const allApps = getAllApps();
  const byId = new Map(allApps.map((a) => [a.id, a]));
  return DEFAULT_DOCK.filter((id) => byId.has(id));
}

/** Categorías para la App Library. */
function getCategories() {
  const allApps = getAllApps();
  const cats = new Map();
  for (const a of allApps) {
    const c = a.category || 'utilities';
    if (!cats.has(c)) cats.set(c, []);
    cats.get(c).push(a);
  }
  return Array.from(cats.entries()).map(([id, apps]) => ({
    id,
    name: categoryLabel(id),
    apps,
  }));
}

function categoryLabel(id) {
  const labels = {
    communication: 'Comunicación',
    media: 'Multimedia',
    productivity: 'Productividad',
    utilities: 'Utilidades',
    internet: 'Internet',
    system: 'Sistema',
    developer: 'Desarrollo',
    games: 'Juegos',
    other: 'Otras',
  };
  return labels[id] || 'Otras';
}

/** Snapshot del registro para depuración / apps. */
function snapshot() {
  return {
    systemCount: store.systemApps.length,
    userCount: store.userApps.length,
    pages: getPages(),
    dock: getDock(),
    categories: getCategories(),
    total: getAllApps().length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública del registro (singleton)
// ─────────────────────────────────────────────────────────────────────────────

const registry = {
  // Datos
  SYSTEM_APPS,
  DEFAULT_PAGES,
  DEFAULT_DOCK,
  ENTITLEMENTS,

  // Lectura
  all: getAllApps,
  get: getApp,
  getPages,
  getDock,
  getCategories,
  snapshot,

  // Escritura
  register: registerUserApp,
  unregister: unregisterUserApp,
  setHidden,
  setPages,
  setDock,
  resetLayout,

  // Suscripción
  subscribe,
};

export default registry;

// ─────────────────────────────────────────────────────────────────────────────
// Hooks de React
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useRegistry — devuelve la lista de apps (sistema + usuario) y se actualiza
 * automáticamente cuando el registro cambia (instalación, borrado, etc.).
 */
export function useRegistry() {
  const [apps, setApps] = useState(() => getAllApps());
  useEffect(() => {
    const unsub = subscribe(() => setApps(getAllApps()));
    return () => unsub();
  }, []);
  return apps;
}

/** Hook que sincroniza el registro con las apps instaladas del OSContext. */
export function useRegistrySync() {
  const os = useOS();
  const installed = os?.snapshot?.apps;

  useEffect(() => {
    if (!Array.isArray(installed)) return;
    // Buscar apps instaladas que no estén en el registro y registrarlas
    for (const raw of installed) {
      const id = raw.bundleId || raw.id;
      if (!id) continue;
      if (registry.get(id)) continue;
      registry.register({
        id,
        name: raw.name || raw.displayName || 'App',
        emoji: raw.emoji,
        glyph: raw.glyph,
        color: raw.color,
        render: raw.render || null,
        permissions: raw.entitlements || [],
        category: raw.category || 'other',
        system: false,
        developer: raw.developer || 'Desconocido',
        version: raw.version || '1.0.0',
        statusBarTheme: raw.statusBarTheme || 'auto',
      });
    }
  }, [installed]);
}

/** Hook que devuelve el layout de páginas del Springboard. */
export function usePages() {
  const [pages, setPages] = useState(() => getPages());
  useEffect(() => {
    const unsub = subscribe(() => setPages(getPages()));
    return () => unsub();
  }, []);
  return pages;
}

/** Hook que devuelve el Dock. */
export function useDock() {
  const [dock, setDock] = useState(() => getDock());
  useEffect(() => {
    const unsub = subscribe(() => setDock(getDock()));
    return () => unsub();
  }, []);
  return dock;
}

/** Hook que devuelve las categorías para la App Library. */
export function useCategories() {
  const [cats, setCats] = useState(() => getCategories());
  useEffect(() => {
    const unsub = subscribe(() => setCats(getCategories()));
    return () => unsub();
  }, []);
  return cats;
}

/**
 * useApp(id) — devuelve una app concreta y se actualiza si cambia.
 */
export function useApp(id) {
  const [app, setApp] = useState(() => getApp(id));
  useEffect(() => {
    const unsub = subscribe(() => setApp(getApp(id)));
    return () => unsub();
  }, [id]);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de presentación
// ─────────────────────────────────────────────────────────────────────────────

/** Devuelve una lista de apps a partir de una lista de ids. */
export function resolveApps(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => getApp(id)).filter(Boolean);
}

/** Cuenta las notificaciones (badge) de una app leyendo del OSContext. */
export function getBadgeCount(os, appId) {
  const notifs = os?.snapshot?.notifications || [];
  return notifs.filter((n) => n.bundleId === appId && !n.isRead).length;
}

/** Aplica los badges a las apps (devuelve nuevas instancias). */
export function withBadges(apps, os) {
  if (!Array.isArray(apps)) return [];
  return apps.map((a) => {
    const badge = getBadgeCount(os, a.id);
    return badge > 0 ? { ...a, badge } : a;
  });
}
