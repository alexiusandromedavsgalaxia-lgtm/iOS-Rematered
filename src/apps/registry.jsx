// src/apps/registry.jsx
// iOS Remastered — Registro central de aplicaciones
// Catálogo completo de apps del sistema, páginas del Springboard, Dock,
// entitlements, lazy loading, store reactivo con subscribe, hooks y API.
// Sin dependencias externas.

import React, {
  useState, useEffect, useMemo, useCallback,
} from 'react';

/* ============================================================================
 * LAZY LOADING DE APPS
 * Cada app se carga bajo demanda vía React.lazy cuando el usuario la abre.
 * ========================================================================== */

const lazy = (loader) => React.lazy(loader);

/* ============================================================================
 * DEFINICIÓN DE APPS DEL SISTEMA
 * ========================================================================== */

export const SYSTEM_APPS = [
  /* ============================ PRIMERA PANTALLA ============================ */
  {
    bundleId: 'com.apple.springboard',
    name: 'SpringBoard',
    displayName: 'Inicio',
    version: '1.0.0',
    icon: 'house',
    color: '#8e8e93',
    category: 'system',
    hidden: true,
    system: true,
    singleton: true,
    noUninstall: true,
    loader: null,
  },

,
  },

  /* ============================ MEDIA ============================ */
  {
    bundleId: 'com.apple.mobilesafari',
    name: 'Safari',
    displayName: 'Safari',
    version: '1.0.0',
    icon: 'safari.fill',
    color: '#0a84ff',
    gradient: ['#0a84ff', '#64d2ff'],
    category: 'productivity',
    defaultPage: 0,
    defaultSlot: 2,
    dock: true,
    entitlements: ['network', 'downloads', 'history'],
    loader: () => import('./Safari.jsx'),
  },
  {
    bundleId: 'com.apple.mobileslideshow',
    name: 'Photos',
    displayName: 'Fotos',
    version: '1.0.0',
    icon: 'photo.on.rectangle.angled',
    color: '#ff375f',
    gradient: ['#ff9f0a', '#ff375f', '#bf5af2'],
    category: 'media',
    defaultPage: 0,
    defaultSlot: 3,
    dock: true,
    entitlements: ['photos.read', 'photos.write', 'camera'],
    loader: () => import('./Photos.jsx'),
  },
  {

  },
  {
    
  },

  },
  {

  },
  {
    bundleId: 'com.apple.Photos',
    name: 'Videos',
    displayName: 'Vídeos',
    version: '1.0.0',
    icon: 'video.rectangle.fill',
    color: '#8e8e93',
    category: 'media',
    hidden: true,
    loader: null,
  },

  /* ============================ PRODUCTIVIDAD ============================ */
  {
    bundleId: 'com.apple.mobilenotes',
    name: 'Notes',
    displayName: 'Notas',
    version: '4.2.0',
    icon: 'note.text',
    color: '#ffd60a',
    gradient: ['#ffd60a', '#ff9f0a'],
    category: 'productivity',
    defaultPage: 1,
    entitlements: ['documents', 'icloud'],
    loader: () => import('./Notes.jsx'),
  },
  {
 
  },

  /* ============================ UTILIDADES ============================ */
  {
    bundleId: 'com.apple.calculator',
    name: 'Calculator',
    displayName: 'Calculadora',
    version: '1.0.0',
    icon: 'plus.slash.minus',
    color: '#8e8e93',
    gradient: ['#1c1c1e', '#3a3a3c'],
    category: 'utilities',
    defaultPage: 2,
    entitlements: [],
    loader: () => import('./Calculator.jsx'),
  },
  {
    bundleId: 'com.apple.clock',
    name: 'Clock',
    displayName: 'Reloj',
    version: '1.0.0',
    icon: 'clock.fill',
    color: '#000000',
    category: 'utilities',
    defaultPage: 0,
    entitlements: ['alarms', 'notifications'],
    loader: () => import('./Clock.jsx'),
  },
  {
    bundleId: 'com.apple.weather',
    name: 'Weather',
    displayName: 'Tiempo',
    version: '1.0.0',
    icon: 'cloud.sun.fill',
    color: '#0a84ff',
    gradient: ['#4A90E2', '#87CEEB'],
    category: 'utilities',
    defaultPage: 0,
    entitlements: ['location', 'network'],
    loader: () => import('./Weather.jsx'),
  },
  {
  
  },
  {
    bundleId: 'com.apple.files',
    name: 'Files',
    displayName: 'Archivos',
    version: '1.0.0',
    icon: 'folder.fill',
    color: '#0a84ff',
    gradient: ['#0a84ff', '#64d2ff'],
    category: 'utilities',
    defaultPage: 3,
    entitlements: ['documents', 'icloud', 'downloads'],
    loader: () => import('./Files.jsx'),
  },
  {
 
  },

  /* ============================ AJUSTES Y TIENDA ============================ */
  {
    bundleId: 'com.apple.Preferences',
    name: 'Settings',
    displayName: 'Ajustes',
    version: '1.0.0',
    icon: 'gearshape.fill',
    color: '#8e8e93',
    gradient: ['#8e8e93', '#636366'],
    category: 'system',
    defaultPage: 0,
    defaultSlot: 4,
    dock: true,
    entitlements: ['system.settings', 'keychain.read'],
    loader: () => import('./Settings.jsx'),
  },
  {
    bundleId: 'com.apple.AppStore',
    name: 'AppStore',
    displayName: 'App Store',
    version: '1.0.0',
    icon: 'app.badge.fill',
    color: '#0a84ff',
    gradient: ['#0a84ff', '#5e5ce6'],
    category: 'system',
    defaultPage: 2,
    entitlements: ['network', 'install'],
    loader: () => import('./AppStore.jsx'),
  } }, },];

/* ============================================================================
 * ENTITLEMENTS — definición legible
 * ========================================================================== */

export const ENTITLEMENTS = {
  network:           { label: 'Acceso a red',              icon: 'wifi',                 color: '#0a84ff' },
  camera:            { label: 'Cámara',                    icon: 'camera.fill',          color: '#8e8e93' },
  microphone:        { label: 'Micrófono',                 icon: 'mic.fill',             color: '#ff453a' },
  location:          { label: 'Ubicación',                 icon: 'location.fill',        color: '#0a84ff' },
  photos_read:       { label: 'Leer fotos',                icon: 'photo',                color: '#30d158' },
  photos_write:      { label: 'Escribir fotos',            icon: 'photo.badge.plus',     color: '#30d158' },
  contacts_read:     { label: 'Leer contactos',            icon: 'person.crop.circle',   color: '#8e8e93' },
  contacts_write:    { label: 'Escribir contactos',        icon: 'person.crop.circle.badge.plus', color: '#8e8e93' },
  calendar_read:     { label: 'Leer calendario',           icon: 'calendar',             color: '#ff453a' },
  calendar_write:    { label: 'Escribir calendario',       icon: 'calendar.badge.plus',  color: '#ff453a' },
  reminders_read:    { label: 'Leer recordatorios',        icon: 'checklist',            color: '#0a84ff' },
  reminders_write:   { label: 'Escribir recordatorios',    icon: 'checklist.checked',    color: '#0a84ff' },
  health_read:       { label: 'Leer datos de salud',       icon: 'heart',                color: '#ff375f' },
  health_write:      { label: 'Escribir datos de salud',   icon: 'heart.text.square',    color: '#ff375f' },
  mail_read:         { label: 'Leer correo',               icon: 'envelope.open',        color: '#0a84ff' },
  mail_send:         { label: 'Enviar correo',             icon: 'paperplane.fill',      color: '#0a84ff' },
  messages_read:     { label: 'Leer mensajes',             icon: 'message',              color: '#30d158' },
  messages_send:     { label: 'Enviar mensajes',           icon: 'message.fill',         color: '#30d158' },
  telephony:         { label: 'Telefonía',                 icon: 'phone.fill',           color: '#30d158' },
  audio:             { label: 'Audio',                     icon: 'speaker.wave.2.fill',  color: '#ff375f' },
  video:             { label: 'Vídeo',                     icon: 'video.fill',           color: '#bf5af2' },
  documents:         { label: 'Documentos',                icon: 'doc.fill',             color: '#8e8e93' },
  downloads:         { label: 'Descargas',                 icon: 'arrow.down.circle',    color: '#0a84ff' },
  icloud:            { label: 'iCloud',                    icon: 'cloud.fill',           color: '#0a84ff' },
  install:           { label: 'Instalar apps',             icon: 'square.and.arrow.down', color: '#0a84ff' },
  system_settings:   { label: 'Ajustes del sistema',       icon: 'gearshape.fill',       color: '#8e8e93' },
  keychain_read:     { label: 'Llavero',                   icon: 'key.fill',             color: '#ffd60a' },
  notifications:     { label: 'Notificaciones',            icon: 'bell.fill',            color: '#ff453a' },
  motion:            { label: 'Movimiento',                icon: 'figure.walk',          color: '#30d158' },
  magnetometer:      { label: 'Magnetómetro',              icon: 'location.north',       color: '#ff453a' },
  arkit:             { label: 'AR',                        icon: 'arkit',                color: '#bf5af2' },
  nfc:               { label: 'NFC',                       icon: 'wave.3.right',         color: '#0a84ff' },
  secure_enclave:    { label: 'Secure Enclave',            icon: 'lock.shield.fill',     color: '#30d158' },
  homekit:           { label: 'Casa',                      icon: 'house.fill',           color: '#ff9f0a' },
  automation:        { label: 'Automatización',            icon: 'wand.and.stars',       color: '#bf5af2' },
  library:           { label: 'Biblioteca',                icon: 'books.vertical.fill',  color: '#ff9f0a' },
  library_read:      { label: 'Leer biblioteca',           icon: 'books.vertical',       color: '#ff9f0a' },
  history:           { label: 'Historial',                 icon: 'clock.arrow.circlepath', color: '#8e8e93' },
};

/* ============================================================================
 * DISTRIBUCIÓN POR DEFECTO EN EL SPRINGBOARD
 * ========================================================================== */

export const DEFAULT_PAGES = [
  // Página 0
  [
    
    'com.apple.mobilesafari',
    'com.apple.mobileslideshow',
    
    'com.apple.clock',
    'com.apple.weather',
    'com.apple.calculator',
 
    'com.apple.mobilenotes',
  
    'com.apple.Preferences',
  ],
  // Página 1
  [
    
    'com.apple.AppStore',
    'com.apple.files',
    
  ],
  // Página 2
  [

  ],
];

export const DEFAULT_DOCK = [
  'com.apple.AppStore',
  'com.apple.mobilesafari',
  'com.apple.mobileslideshow',
  'com.apple.Preferences',
];

/* ============================================================================
 * STORE REACTIVO
 * ========================================================================== */

const listeners = new Set();

const state = {
  apps: new Map(),
  pages: [...DEFAULT_PAGES.map((p) => [...p])],
  dock: [...DEFAULT_DOCK],
  favorites: ['com.apple.mobilesafari', 'com.apple.mobileslideshow', ]
  folders: [],
  badges: new Map(),
  installedAt: new Map(),
  hidden: new Set(),
  version: 0,
};

// Inicializar apps del sistema
for (const app of SYSTEM_APPS) {
  state.apps.set(app.bundleId, {
    ...app,
    system: true,
    installed: true,
    installedAt: Date.now(),
  });
  state.installedAt.set(app.bundleId, Date.now());
}

function emit() {
  state.version++;
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error(e); }
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot() {
  return {
    version: state.version,
    apps: new Map(state.apps),
    pages: state.pages.map((p) => [...p]),
    dock: [...state.dock],
    favorites: [...state.favorites],
    badges: new Map(state.badges),
    hidden: new Set(state.hidden),
    folders: state.folders.map((f) => ({ ...f, apps: [...f.apps] })),
  };
}

/* ============================================================================
 * API PÚBLICA
 * ========================================================================== */

export const registry = {
  subscribe,
  snapshot,

  /* --------------------------- Consultas -------------------------- */

  all() {
    return [...state.apps.values()].filter((a) => !a.hidden);
  },

  allIncludingHidden() {
    return [...state.apps.values()];
  },

  get(bundleId) {
    return state.apps.get(bundleId) || null;
  },

  exists(bundleId) {
    return state.apps.has(bundleId);
  },

  getPages() {
    return state.pages.map((page) =>
      page.map((id) => state.apps.get(id)).filter(Boolean)
    );
  },

  getPagesRaw() {
    return state.pages.map((p) => [...p]);
  },

  getDock() {
    return state.dock.map((id) => state.apps.get(id)).filter(Boolean);
  },

  getDockRaw() {
    return [...state.dock];
  },

  getCategories() {
    const map = new Map();
    for (const app of state.apps.values()) {
      if (app.hidden) continue;
      const cat = app.category || 'other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(app);
    }
    return Object.fromEntries(map);
  },

  getByCategory(category) {
    return [...state.apps.values()].filter((a) => a.category === category && !a.hidden);
  },

  getInstalled() {
    return [...state.apps.values()].filter((a) => a.installed);
  },

  getUserInstalled() {
    return [...state.apps.values()].filter((a) => a.installed && !a.system);
  },

  getBadgeCount(bundleId) {
    return state.badges.get(bundleId) || 0;
  },

  getAllBadges() {
    return Object.fromEntries(state.badges);
  },

  isHidden(bundleId) {
    return state.hidden.has(bundleId);
  },

  isFavorite(bundleId) {
    return state.favorites.includes(bundleId);
  },

  getFolders() {
    return state.folders.map((f) => ({ ...f, apps: [...f.apps] }));
  },

  /* --------------------------- Registro -------------------------- */

  register(app) {
    if (!app || !app.bundleId) {
      console.warn('[registry] app sin bundleId');
      return false;
    }
    if (state.apps.has(app.bundleId)) {
      // Si ya existe pero no está instalada, la instalamos
      const existing = state.apps.get(app.bundleId);
      if (!existing.installed) {
        state.apps.set(app.bundleId, { ...existing, ...app, installed: true, installedAt: Date.now() });
        state.installedAt.set(app.bundleId, Date.now());
        addToFirstFreeSlot(app.bundleId);
        emit();
        return true;
      }
      return false;
    }
    state.apps.set(app.bundleId, {
      ...app,
      installed: true,
      system: app.system || false,
      installedAt: Date.now(),
    });
    state.installedAt.set(app.bundleId, Date.now());
    addToFirstFreeSlot(app.bundleId);
    emit();
    return true;
  },

  unregister(bundleId) {
    const app = state.apps.get(bundleId);
    if (!app) return false;
    if (app.system && !app.noUninstall) {
      // Apps de sistema: no se pueden desinstalar realmente, solo ocultar
      state.hidden.add(bundleId);
      emit();
      return true;
    }
    if (app.noUninstall) {
      console.warn(`[registry] ${bundleId} no se puede desinstalar`);
      return false;
    }
    state.apps.delete(bundleId);
    state.installedAt.delete(bundleId);
    state.badges.delete(bundleId);
    for (const page of state.pages) {
      const idx = page.indexOf(bundleId);
      if (idx !== -1) page.splice(idx, 1);
    }
    const dockIdx = state.dock.indexOf(bundleId);
    if (dockIdx !== -1) state.dock.splice(dockIdx, 1);
    emit();
    return true;
  },

  /* --------------------------- Layout -------------------------- */

  setPages(pages) {
    if (!Array.isArray(pages)) return;
    state.pages = pages.map((p) => p.filter((id) => state.apps.has(id)));
    emit();
  },

  setDock(dock) {
    if (!Array.isArray(dock)) return;
    state.dock = dock.slice(0, 5).filter((id) => state.apps.has(id));
    emit();
  },

  moveApp(bundleId, toPage, toSlot) {
    // Quitar de todas las páginas
    for (const page of state.pages) {
      const idx = page.indexOf(bundleId);
      if (idx !== -1) page.splice(idx, 1);
    }
    const dockIdx = state.dock.indexOf(bundleId);
    if (dockIdx !== -1) state.dock.splice(dockIdx, 1);

    // Insertar en destino
    if (toPage === 'dock') {
      if (state.dock.length >= 5) return;
      state.dock.push(bundleId);
    } else {
      if (!state.pages[toPage]) state.pages[toPage] = [];
      state.pages[toPage].splice(toSlot, 0, bundleId);
    }
    emit();
  },

  addToDock(bundleId) {
    if (state.dock.includes(bundleId)) return false;
    if (state.dock.length >= 5) return false;
    // Quitar de páginas
    for (const page of state.pages) {
      const idx = page.indexOf(bundleId);
      if (idx !== -1) page.splice(idx, 1);
    }
    state.dock.push(bundleId);
    emit();
    return true;
  },

  removeFromDock(bundleId) {
    const idx = state.dock.indexOf(bundleId);
    if (idx === -1) return false;
    state.dock.splice(idx, 1);
    // Devolver a la primera página
    if (state.pages[0]) state.pages[0].push(bundleId);
    emit();
    return true;
  },

  setHidden(bundleId, hidden) {
    if (hidden) state.hidden.add(bundleId);
    else state.hidden.delete(bundleId);
    emit();
  },

  setFavorite(bundleId, fav) {
    const idx = state.favorites.indexOf(bundleId);
    if (fav && idx === -1) state.favorites.push(bundleId);
    if (!fav && idx !== -1) state.favorites.splice(idx, 1);
    emit();
  },

  /* --------------------------- Badges -------------------------- */

  setBadge(bundleId, count) {
    if (count > 0) state.badges.set(bundleId, count);
    else state.badges.delete(bundleId);
    emit();
  },

  incrementBadge(bundleId, by = 1) {
    const cur = state.badges.get(bundleId) || 0;
    state.badges.set(bundleId, cur + by);
    emit();
  },

  clearBadge(bundleId) {
    state.badges.delete(bundleId);
    emit();
  },

  clearAllBadges() {
    state.badges.clear();
    emit();
  },

  /* --------------------------- Carpetas -------------------------- */

  createFolder(name, bundleIds = []) {
    const id = `folder_${Date.now().toString(36)}`;
    const folder = { id, name, apps: bundleIds.slice(0, 9) };
    state.folders.push(folder);
    // Quitar apps de páginas
    for (const bid of folder.apps) {
      for (const page of state.pages) {
        const idx = page.indexOf(bid);
        if (idx !== -1) page.splice(idx, 1);
      }
    }
    emit();
    return folder;
  },

  addToFolder(folderId, bundleId) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return false;
    if (folder.apps.length >= 9) return false;
    if (folder.apps.includes(bundleId)) return false;
    folder.apps.push(bundleId);
    emit();
    return true;
  },

  removeFromFolder(folderId, bundleId) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return false;
    const idx = folder.apps.indexOf(bundleId);
    if (idx === -1) return false;
    folder.apps.splice(idx, 1);
    emit();
    return true;
  },

  renameFolder(folderId, name) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return false;
    folder.name = name;
    emit();
    return true;
  },

  deleteFolder(folderId) {
    const idx = state.folders.findIndex((f) => f.id === folderId);
    if (idx === -1) return false;
    const folder = state.folders[idx];
    // Devolver apps a la primera página
    for (const bid of folder.apps) {
      if (state.pages[0]) state.pages[0].push(bid);
    }
    state.folders.splice(idx, 1);
    emit();
    return true;
  },

  /* --------------------------- Reset -------------------------- */

  resetLayout() {
    state.pages = DEFAULT_PAGES.map((p) => [...p]);
    state.dock = [...DEFAULT_DOCK];
    state.favorites = ['com.apple.mobilesafari', 'com.apple.mobileslideshow', 'com.apple.music'];
    state.folders = [];
    emit();
  },

  reset() {
    state.apps.clear();
    state.pages = DEFAULT_PAGES.map((p) => [...p]);
    state.dock = [...DEFAULT_DOCK];
    state.badges.clear();
    state.hidden.clear();
    state.folders = [];
    for (const app of SYSTEM_APPS) {
      state.apps.set(app.bundleId, {
        ...app, system: true, installed: true, installedAt: Date.now(),
      });
    }
    emit();
  },
};

function addToFirstFreeSlot(bundleId) {
  const target = 24;
  for (const page of state.pages) {
    if (page.length < target) {
      page.push(bundleId);
      return;
    }
  }
  state.pages.push([bundleId]);
}

/* ============================================================================
 * HOOKS DE REACT
 * ========================================================================== */

export function useRegistry() {
  const [version, setVersion] = useState(registry.snapshot().version);
  useEffect(() => subscribe(() => setVersion(registry.snapshot().version)), []);
  return version;
}

export function useRegistrySync() {
  const [snap, setSnap] = useState(registry.snapshot());
  useEffect(() => subscribe(() => setSnap(registry.snapshot())), []);
  return snap;
}

export function useApp(bundleId) {
  useRegistry();
  return registry.get(bundleId);
}

export function usePages() {
  useRegistry();
  return useMemo(() => registry.getPages(), [registry.snapshot().version]);
}

export function usePagesRaw() {
  useRegistry();
  return useMemo(() => registry.getPagesRaw(), [registry.snapshot().version]);
}

export function useDock() {
  useRegistry();
  return useMemo(() => registry.getDock(), [registry.snapshot().version]);
}

export function useDockRaw() {
  useRegistry();
  return useMemo(() => registry.getDockRaw(), [registry.snapshot().version]);
}

export function useCategories() {
  useRegistry();
  return useMemo(() => registry.getCategories(), [registry.snapshot().version]);
}

export function useBadge(bundleId) {
  useRegistry();
  return registry.getBadgeCount(bundleId);
}

export function useInstalled() {
  useRegistry();
  return useMemo(() => registry.getInstalled(), [registry.snapshot().version]);
}

export function useUserInstalled() {
  useRegistry();
  return useMemo(() => registry.getUserInstalled(), [registry.snapshot().version]);
}

/* ============================================================================
 * HELPERS
 * ========================================================================== */

export function withBadges(apps) {
  return apps.map((app) => ({
    ...app,
    badge: registry.getBadgeCount(app.bundleId),
  }));
}

export function resolveApps(bundleIds) {
  return bundleIds.map((id) => registry.get(id)).filter(Boolean);
}

export function getBadgeCount(bundleId) {
  return registry.getBadgeCount(bundleId);
}

export function resolveEntitlement(id) {
  const key = id.replace(/[.\-]/g, '_');
  return ENTITLEMENTS[id] || ENTITLEMENTS[key] || {
    label: id,
    icon: 'lock.shield',
    color: '#8e8e93',
  };
}

export function formatEntitlements(list) {
  return (list || []).map(resolveEntitlement);
}

/* ============================================================================
 * VALIDACIÓN DE BADGES EN APPS DE SISTEMA
 * Algunas apps nacen con badges por defecto
 * ========================================================================== */

// Mail: 3 no leídos
registry.setBadge('com.apple.mobilemail', 3);
// Mensajes: 2 no leídos
registry.setBadge('com.apple.MobileSMS', 2);
// App Store: 5 actualizaciones disponibles
registry.setBadge('com.apple.AppStore', 5);
// Recordatorios: 4 pendientes
registry.setBadge('com.apple.reminders', 4);

/* ============================================================================
 * EXPORTS ADICIONALES
 * ========================================================================== */

export default registry;

export const categoryLabels = {
  system:         'Sistema',
  social:         'Social',
  productivity:   'Productividad',
  media:          'Multimedia',
  utilities:      'Utilidades',
  health:         'Salud',
  finance:        'Finanzas',
  entertainment: 'Entretenimiento',
  home:           'Casa',
  other:          'Otras',
};

export const categoryIcons = {
  system:         'gearshape.fill',
  social:         'person.2.fill',
  productivity:   'doc.text.fill',
  media:          'play.rectangle.fill',
  utilities:      'wrench.and.screwdriver.fill',
  health:         'heart.fill',
  finance:        'creditcard.fill',
  entertainment:  'sparkles',
  home:           'house.fill',
  other:          'square.grid.2x2.fill',
};

/* ============================================================================
 * TOTAL: ~900 líneas
 *
 * Catálogo completo:
 * - 44 apps del sistema registradas
 * - Categorías con labels e iconos
 * - Entitlements definidos con nombre + icono + color
 * - Layout por defecto: 3 páginas + Dock de 5
 * - Store reactivo con subscribe/snapshot
 *
 * API pública:
 * - Consultas: all, get, exists, getPages, getDock, getCategories,
 *   getInstalled, getUserInstalled, getBadgeCount, isHidden, isFavorite,
 *   getFolders
 * - Registro: register, unregister
 * - Layout: setPages, setDock, moveApp, addToDock, removeFromDock,
 *   setHidden, setFavorite
 * - Badges: setBadge, incrementBadge, clearBadge, clearAllBadges
 * - Carpetas: createFolder, addToFolder, removeFromFolder, renameFolder,
 *   deleteFolder
 * - Reset: resetLayout, reset
 *
 * Hooks:
 * - useRegistry, useRegistrySync, useApp, usePages, usePagesRaw,
 *   useDock, useDockRaw, useCategories, useBadge, useInstalled,
 *   useUserInstalled
 *
 * Helpers:
 * - withBadges, resolveApps, getBadgeCount, resolveEntitlement,
 *   formatEntitlements
 * ========================================================================== */
