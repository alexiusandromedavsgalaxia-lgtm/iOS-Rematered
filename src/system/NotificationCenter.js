// src/system/NotificationCenter.js
// Centro de notificaciones estilo iOS.
// - Notificaciones locales + push (APNs simulado)
// - Estilos: banner / alert / sound / badge / critical / provisional
// - Categorías registrables con acciones (interactive notifications)
// - Agrupación por app y por thread (conversaciones)
// - Focus / DND (Do Not Disturb, Sleep, Work, Personal, Driving)
// - Entrega programada (trigger: interval/time/calendar/location)
// - Badges por app con auto-clear
// - Historial + persistencia sobre FileSystem
// - Time-sensitive / Critical alerts (bypass de DND)
// - Provisional / quiet delivery

import { Logger } from './Logger.js';

const LOG_TAG = 'NOTIF';

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

export const NOTIF_STYLE = {
  BANNER:      'banner',
  ALERT:       'alert',
  SOUND:       'sound',
  BADGE:       'badge',
  CRITICAL:    'critical',      // bypass DND, requiere entitlement
  PROVISIONAL: 'provisional',   // entrega silenciosa
  TIME_SENSITIVE: 'time-sensitive',  // puede atravesar DND si permitido
};

export const NOTIF_INTERRUPTION = {
  PASSIVE:       'passive',       // sin sonido, sin banner
  ACTIVE:        'active',        // banner + sonido
  TIME_SENSITIVE:'time-sensitive',
  CRITICAL:      'critical',
};

export const NOTIF_STATE = {
  PENDING:    'pending',
  DELIVERED:  'delivered',
  READ:       'read',
  DISMISSED:  'dismissed',
  EXPIRED:    'expired',
  SCHEDULED:  'scheduled',
  FAILED:     'failed',
};

export const NOTIF_SOURCE = {
  LOCAL:  'local',
  PUSH:   'push',
  REMOTE: 'remote',
};

export const FOCUS_MODE = {
  OFF:      'off',
  DO_NOT_DISTURB: 'dnd',
  SLEEP:    'sleep',
  WORK:     'work',
  PERSONAL: 'personal',
  DRIVING:  'driving',
  READING:  'reading',
  MINDFULNESS: 'mindfulness',
  GAMING:   'gaming',
};

// Permitir por prioridad a través de Focus
const FOCUS_ALLOWED = {
  [FOCUS_MODE.OFF]:              { passive: true, active: true, timeSensitive: true, critical: true },
  [FOCUS_MODE.DO_NOT_DISTURB]:   { passive: false, active: false, timeSensitive: true, critical: true },
  [FOCUS_MODE.SLEEP]:            { passive: false, active: false, timeSensitive: false, critical: true },
  [FOCUS_MODE.WORK]:             { passive: true, active: true, timeSensitive: true, critical: true },
  [FOCUS_MODE.PERSONAL]:         { passive: true, active: true, timeSensitive: true, critical: true },
  [FOCUS_MODE.DRIVING]:          { passive: false, active: false, timeSensitive: false, critical: true },
  [FOCUS_MODE.READING]:          { passive: false, active: false, timeSensitive: true, critical: true },
  [FOCUS_MODE.MINDFULNESS]:      { passive: false, active: false, timeSensitive: false, critical: true },
  [FOCUS_MODE.GAMING]:           { passive: false, active: false, timeSensitive: true, critical: true },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function uid() {
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function now() { return Date.now(); }
function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ------------------------------------------------------------------ *
 * Categoría registrable
 * ------------------------------------------------------------------ */

class NotificationCategory {
  constructor(id, actions = [], options = {}) {
    this.id = id;
    this.actions = actions.map(a => ({
      id: a.id,
      title: a.title || a.id,
      options: a.options || [],     // ['foreground', 'destructive', 'authentication-required']
      icon: a.icon || null,
      textInput: a.textInput || null,
    }));
    this.options = {
      hiddenPreview: options.hiddenPreview || false,
      allowInCarPlay: options.allowInCarPlay !== false,
      customDismiss: options.customDismiss || false,
      allowAnnouncement: options.allowAnnouncement !== false,
    };
    this.createdAt = now();
  }
}

/* ------------------------------------------------------------------ *
 * Notificación
 * ------------------------------------------------------------------ */

class Notification {
  constructor(opts) {
    this.id = opts.id || uid();
    this.bundleId = opts.bundleId || 'com.apple.unknown';
    this.title = opts.title || '';
    this.subtitle = opts.subtitle || '';
    this.body = opts.body || '';
    this.style = opts.style || NOTIF_STYLE.BANNER;
    this.interruption = opts.interruption || NOTIF_INTERRUPTION.ACTIVE;
    this.categoryId = opts.categoryId || null;
    this.threadId = opts.threadId || null;
    this.groupId = opts.groupId || null;

    // Payload
    this.userInfo = opts.userInfo || {};
    this.attachments = opts.attachments || [];
    this.sound = opts.sound || null;         // { name, critical, volume }
    this.badge = opts.badge ?? null;
    this.targetContentId = opts.targetContentId || null;
    this.relevanceScore = opts.relevanceScore ?? 0.5;

    // Entrega
    this.source = opts.source || NOTIF_SOURCE.LOCAL;
    this.scheduledAt = opts.scheduledAt || null;   // timestamp futuro o null
    this.expiresAt = opts.expiresAt || null;
    this.deliveredAt = null;
    this.readAt = null;
    this.dismissedAt = null;
    this.state = opts.scheduledAt ? NOTIF_STATE.SCHEDULED : NOTIF_STATE.PENDING;

    // Trigger (para programadas)
    this.trigger = opts.trigger || null;   // { type: 'time'|'interval'|'calendar', ... }

    // Metadatos
    this.createdAt = now();
    this.modifiedAt = now();
    this.retryCount = 0;
    this.priority = opts.priority || 5;    // 1 (max) … 10 (min)

    // Focus: indica si fue suprimida por un focus activo
    this.suppressedByFocus = null;
    this.bypassedFocus = false;
  }

  toMetadata() {
    return {
      id: this.id,
      bundleId: this.bundleId,
      title: this.title,
      subtitle: this.subtitle,
      body: this.body,
      style: this.style,
      interruption: this.interruption,
      categoryId: this.categoryId,
      threadId: this.threadId,
      groupId: this.groupId,
      sound: this.sound,
      badge: this.badge,
      state: this.state,
      source: this.source,
      scheduledAt: this.scheduledAt,
      deliveredAt: this.deliveredAt,
      readAt: this.readAt,
      dismissedAt: this.dismissedAt,
      expiresAt: this.expiresAt,
      createdAt: this.createdAt,
      priority: this.priority,
      suppressedByFocus: this.suppressedByFocus,
      bypassedFocus: this.bypassedFocus,
      relevanceScore: this.relevanceScore,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Grupo (para agrupación visual)
 * ------------------------------------------------------------------ */

class NotificationGroup {
  constructor(key, bundleId, threadId = null) {
    this.key = key;
    this.bundleId = bundleId;
    this.threadId = threadId;
    this.items = [];       // ids
    this.createdAt = now();
    this.updatedAt = now();
  }

  add(id) {
    this.items.push(id);
    this.updatedAt = now();
  }

  remove(id) {
    const i = this.items.indexOf(id);
    if (i >= 0) this.items.splice(i, 1);
    this.updatedAt = now();
  }

  size() { return this.items.length; }
}

/* ------------------------------------------------------------------ *
 * Programador de notificaciones (trigger)
 * ------------------------------------------------------------------ */

class NotificationScheduler {
  constructor() {
    this.pending = new Map();   // id → notification (scheduled)
    this.timers = new Map();    // id → timeoutHandle
  }

  schedule(notif, onFire) {
    this.pending.set(notif.id, notif);
    const delay = Math.max(0, (notif.scheduledAt || now()) - now());
    const h = setTimeout(() => {
      this.timers.delete(notif.id);
      this.pending.delete(notif.id);
      try { onFire(notif); }
      catch (e) { Logger.error(LOG_TAG, `scheduler fire error: ${e.message}`); }
    }, delay);
    this.timers.set(notif.id, h);
  }

  cancel(id) {
    const h = this.timers.get(id);
    if (h) clearTimeout(h);
    this.timers.delete(id);
    this.pending.delete(id);
  }

  cancelAll() {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    this.pending.clear();
  }

  size() { return this.pending.size; }

  list() {
    return [...this.pending.values()].map(n => n.toMetadata());
  }
}

/* ------------------------------------------------------------------ *
 * Clase principal: NotificationCenter
 * ------------------------------------------------------------------ */

export class NotificationCenter {
  constructor(options = {}) {
    this.delivered = new Map();       // id → Notification (ya entregadas)
    this.history = [];                // metadatos de todas las notificaciones (incluye borradas)
    this.historyMax = options.historyMax || 500;

    this.categories = new Map();      // categoryId → NotificationCategory
    this.groups = new Map();          // groupKey → NotificationGroup
    this.badges = new Map();          // bundleId → number

    this.scheduler = new NotificationScheduler();

    // Focus
    this.focus = FOCUS_MODE.OFF;
    this.focusAllowList = new Set();      // bundleIds que pueden atravesar DND
    this.focusDenyList = new Set();       // bundleIds silenciados siempre

    // Configuración global
    this.globalEnabled = true;
    this.lockscreenPreview = true;
    this.bannerStyle = 'temporary';       // 'temporary' | 'persistent'
    this.deliveryQuiet = false;            // modo "entrega silenciosa" (provisional)

    // Persistencia
    this.fs = options.fs || null;
    this.persistencePath = options.persistencePath || '/private/var/mobile/Library/Notifications/center.json';

    // Reloj del kernel (si está vinculado)
    this.clock = options.clock || null;

    // Suscriptores
    this.subscribers = new Set();

    // Estado de APNs
    this.apns = {
      token: uid(),
      connected: false,
      lastPingAt: 0,
    };

    // Métricas
    this.stats = {
      created: 0,
      delivered: 0,
      pushed: 0,
      local: 0,
      read: 0,
      dismissed: 0,
      expired: 0,
      suppressed: 0,
      bypassed: 0,
      scheduled: 0,
      cancelled: 0,
      badgeUpdates: 0,
      groupsCreated: 0,
      groupsMerged: 0,
      persistenceSaves: 0,
      persistenceLoads: 0,
      categoryRegistrations: 0,
    };

    if (this.fs) this._tryLoad();

    Logger.debug(LOG_TAG, 'NotificationCenter instanciado');
  }

  /* ================================================================ *
   * APNs (simulado)
   * ================================================================ */

  connectAPNs() {
    this.apns.connected = true;
    this.apns.lastPingAt = now();
    Logger.info(LOG_TAG, `APNs conectado (token ${this.apns.token.slice(0, 12)}…)`);
    this._emit('apns:connect', { token: this.apns.token });
  }

  disconnectAPNs() {
    this.apns.connected = false;
    Logger.info(LOG_TAG, 'APNs desconectado');
    this._emit('apns:disconnect', {});
  }

  pingAPNs() {
    this.apns.lastPingAt = now();
  }

  /* ================================================================ *
   * Categorías
   * ================================================================ */

  registerCategory(id, actions = [], options = {}) {
    const cat = new NotificationCategory(id, actions, options);
    this.categories.set(id, cat);
    this.stats.categoryRegistrations++;
    Logger.debug(LOG_TAG, `Categoría registrada: ${id} (${actions.length} acciones)`);
    this._emit('category:register', { id, actions: actions.length });
    return cat;
  }

  unregisterCategory(id) {
    return this.categories.delete(id);
  }

  getCategory(id) { return this.categories.get(id) || null; }

  /* ================================================================ *
   * Focus / DND
   * ================================================================ */

  setFocus(mode) {
    if (!Object.values(FOCUS_MODE).includes(mode)) {
      Logger.warn(LOG_TAG, `Focus desconocido: ${mode}`);
      return false;
    }
    const prev = this.focus;
    this.focus = mode;
    Logger.info(LOG_TAG, `Focus: ${prev} → ${mode}`);
    this._emit('focus', { from: prev, to: mode });
    return true;
  }

  addToAllowList(bundleId)  { this.focusAllowList.add(bundleId); }
  removeFromAllowList(bundleId) { this.focusAllowList.delete(bundleId); }
  addToDenyList(bundleId)   { this.focusDenyList.add(bundleId); }
  removeFromDenyList(bundleId) { this.focusDenyList.delete(bundleId); }

  _isAllowedByFocus(notif) {
    if (this.focus === FOCUS_MODE.OFF) return { allowed: true, bypass: false };

    // Critical siempre pasa
    if (notif.interruption === NOTIF_INTERRUPTION.CRITICAL) {
      return { allowed: true, bypass: true };
    }
    // Allow list explícito
    if (this.focusAllowList.has(notif.bundleId)) {
      return { allowed: true, bypass: true };
    }
    // Deny list explícito
    if (this.focusDenyList.has(notif.bundleId)) {
      return { allowed: false, bypass: false };
    }
    const rules = FOCUS_ALLOWED[this.focus] || FOCUS_ALLOWED[FOCUS_MODE.OFF];
    const key = notif.interruption === NOTIF_INTERRUPTION.TIME_SENSITIVE ? 'timeSensitive'
              : notif.interruption === NOTIF_INTERRUPTION.CRITICAL ? 'critical'
              : notif.interruption === NOTIF_INTERRUPTION.PASSIVE ? 'passive'
              : 'active';
    const allowed = !!rules[key];
    return { allowed, bypass: allowed && key === 'timeSensitive' };
  }

  /* ================================================================ *
   * Envío de notificaciones
   * ================================================================ */

  post(opts) {
    if (!this.globalEnabled) {
      Logger.warn(LOG_TAG, 'NotificationCenter deshabilitado globalmente');
      return null;
    }

    const notif = new Notification(opts);
    this.stats.created++;
    if (notif.source === NOTIF_SOURCE.PUSH || notif.source === NOTIF_SOURCE.REMOTE) {
      this.stats.pushed++;
    } else {
      this.stats.local++;
    }

    // Programada
    if (notif.scheduledAt && notif.scheduledAt > now()) {
      this.stats.scheduled++;
      this.scheduler.schedule(notif, (n) => this._deliver(n));
      this._recordHistory(notif);
      this._emit('scheduled', notif.toMetadata());
      return notif;
    }

    return this._deliver(notif);
  }

  _deliver(notif) {
    // Focus
    const focusCheck = this._isAllowedByFocus(notif);
    if (!focusCheck.allowed) {
      notif.state = NOTIF_STATE.PENDING;
      notif.suppressedByFocus = this.focus;
      this.stats.suppressed++;
      Logger.debug(LOG_TAG, `Notificación ${notif.id} suprimida por focus ${this.focus}`);
      this._emit('suppressed', { id: notif.id, focus: this.focus });
      return notif;
    }
    if (focusCheck.bypass) {
      notif.bypassedFocus = true;
      this.stats.bypassed++;
    }

    // Expiración inmediata
    if (notif.expiresAt && now() > notif.expiresAt) {
      notif.state = NOTIF_STATE.EXPIRED;
      this.stats.expired++;
      this._recordHistory(notif);
      this._emit('expired', notif.toMetadata());
      return notif;
    }

    // Entrega
    notif.state = NOTIF_STATE.DELIVERED;
    notif.deliveredAt = now();
    this.delivered.set(notif.id, notif);
    this.stats.delivered++;

    // Badge
    if (notif.badge != null) {
      this.setBadge(notif.bundleId, notif.badge);
    } else {
      this.badges.set(notif.bundleId, (this.badges.get(notif.bundleId) || 0) + 1);
      this.stats.badgeUpdates++;
    }

    // Grupo
    this._addToGroup(notif);

    this._recordHistory(notif);
    Logger.debug(LOG_TAG, `Entrega: [${notif.bundleId}] ${notif.title} — ${notif.body?.slice(0, 40)}`);
    this._emit('deliver', notif.toMetadata());
    this._maybePersist();
    return notif;
  }

  /* ================================================================ *
   * Grupos
   * ================================================================ */

  _addToGroup(notif) {
    const threadKey = notif.threadId || notif.groupId || null;
    const groupKey = `${notif.bundleId}::${threadKey || '_default'}`;
    let g = this.groups.get(groupKey);
    if (!g) {
      g = new NotificationGroup(groupKey, notif.bundleId, notif.threadId);
      this.groups.set(groupKey, g);
      this.stats.groupsCreated++;
    } else {
      this.stats.groupsMerged++;
    }
    g.add(notif.id);
    notif.groupId = groupKey;
  }

  getGroup(bundleId, threadId = null) {
    const key = `${bundleId}::${threadId || '_default'}`;
    return this.groups.get(key) || null;
  }

  listGroups() {
    return [...this.groups.values()].map(g => ({
      key: g.key,
      bundleId: g.bundleId,
      threadId: g.threadId,
      size: g.size(),
      updatedAt: g.updatedAt,
    }));
  }

  /* ================================================================ *
   * Acciones sobre notificaciones
   * ================================================================ */

  markRead(id) {
    const n = this.delivered.get(id);
    if (!n) return false;
    n.state = NOTIF_STATE.READ;
    n.readAt = now();
    this.stats.read++;
    this._decrementBadge(n.bundleId);
    this._emit('read', { id });
    this._maybePersist();
    return true;
  }

  markAllRead(bundleId = null) {
    let count = 0;
    for (const n of this.delivered.values()) {
      if (bundleId && n.bundleId !== bundleId) continue;
      if (n.state === NOTIF_STATE.DELIVERED) {
        n.state = NOTIF_STATE.READ;
        n.readAt = now();
        this.stats.read++;
        count++;
        this._decrementBadge(n.bundleId);
      }
    }
    if (count > 0) {
      this._emit('read:all', { bundleId, count });
      this._maybePersist();
    }
    return count;
  }

  dismiss(id) {
    const n = this.delivered.get(id);
    if (!n) return false;
    n.state = NOTIF_STATE.DISMISSED;
    n.dismissedAt = now();
    this.delivered.delete(id);
    this.stats.dismissed++;
    const g = this.groups.get(n.groupId);
    if (g) g.remove(id);
    this._decrementBadge(n.bundleId);
    this._emit('dismiss', { id });
    this._maybePersist();
    return true;
  }

  dismissAll(bundleId = null) {
    let count = 0;
    for (const [id, n] of [...this.delivered]) {
      if (bundleId && n.bundleId !== bundleId) continue;
      this.dismiss(id);
      count++;
    }
    return count;
  }

  clearAll() {
    const count = this.delivered.size;
    this.delivered.clear();
    this.groups.clear();
    this.badges.clear();
    this._emit('clear', { count });
    this._maybePersist();
    return count;
  }

  triggerAction(id, actionId) {
    const n = this.delivered.get(id);
    if (!n) return false;
    const cat = n.categoryId ? this.categories.get(n.categoryId) : null;
    const action = cat?.actions.find(a => a.id === actionId);
    if (!action) {
      Logger.warn(LOG_TAG, `Acción ${actionId} no encontrada en categoría ${n.categoryId}`);
      return false;
    }
    Logger.debug(LOG_TAG, `Acción invocada: ${actionId} sobre ${id}`);
    this._emit('action', { id, actionId, action, notif: n.toMetadata() });
    // Acciones destructivas o foreground implican dismiss
    if (action.options.includes('destructive') || action.options.includes('foreground')) {
      this.dismiss(id);
    }
    return true;
  }

  /* ================================================================ *
   * Badges
   * ================================================================ */

  setBadge(bundleId, count) {
    this.badges.set(bundleId, Math.max(0, count | 0));
    this.stats.badgeUpdates++;
    this._emit('badge', { bundleId, count: this.badges.get(bundleId) });
    this._maybePersist();
  }

  getBadge(bundleId) { return this.badges.get(bundleId) || 0; }

  _decrementBadge(bundleId) {
    const cur = this.badges.get(bundleId) || 0;
    if (cur > 0) {
      this.badges.set(bundleId, cur - 1);
      this._emit('badge', { bundleId, count: cur - 1 });
    }
  }

  getTotalBadge() {
    let t = 0;
    for (const v of this.badges.values()) t += v;
    return t;
  }

  /* ================================================================ *
   * Consultas
   * ================================================================ */

  list(opts = {}) {
    let arr = [...this.delivered.values()];
    if (opts.bundleId) arr = arr.filter(n => n.bundleId === opts.bundleId);
    if (opts.state) arr = arr.filter(n => n.state === opts.state);
    if (opts.threadId) arr = arr.filter(n => n.threadId === opts.threadId);
    if (opts.style) arr = arr.filter(n => n.style === opts.style);
    arr.sort((a, b) => b.deliveredAt - a.deliveredAt);
    if (opts.limit) arr = arr.slice(0, opts.limit);
    return arr.map(n => n.toMetadata());
  }

  get(id) {
    return this.delivered.get(id)?.toMetadata() || null;
  }

  listScheduled() {
    return this.scheduler.list();
  }

  cancelScheduled(id) {
    this.scheduler.cancel(id);
    this.stats.cancelled++;
    this._emit('cancel', { id });
    return true;
  }

  cancelAllScheduled() {
    const n = this.scheduler.size();
    this.scheduler.cancelAll();
    this.stats.cancelled += n;
    return n;
  }

  /* ================================================================ *
   * Historial
   * ================================================================ */

  _recordHistory(notif) {
    this.history.push({
      ...notif.toMetadata(),
      recordedAt: now(),
    });
    if (this.history.length > this.historyMax) this.history.shift();
  }

  getHistory(limit = 100) {
    return this.history.slice(-limit);
  }

  clearHistory() {
    const n = this.history.length;
    this.history = [];
    return n;
  }

  /* ================================================================ *
   * Mantenimiento
   * ================================================================ */

  tick() {
    // Expirar notificaciones
    const n = now();
    for (const [id, notif] of [...this.delivered]) {
      if (notif.expiresAt && n > notif.expiresAt) {
        notif.state = NOTIF_STATE.EXPIRED;
        this.delivered.delete(id);
        this.stats.expired++;
        this._decrementBadge(notif.bundleId);
        this._emit('expired', { id });
      }
    }
    // Limpiar grupos vacíos
    for (const [k, g] of [...this.groups]) {
      if (g.size() === 0) this.groups.delete(k);
    }
    // Ping APNs si conectado
    if (this.apns.connected && n - this.apns.lastPingAt > 30_000) {
      this.pingAPNs();
    }
  }

  /* ================================================================ *
   * Persistencia
   * ================================================================ */

  _maybePersist() {
    if (!this.fs) return;
    try { this.save(); }
    catch (e) { Logger.warn(LOG_TAG, `Persistencia falló: ${e.message}`); }
  }

  save() {
    if (!this.fs) return false;
    const payload = {
      version: 1,
      savedAt: now(),
      focus: this.focus,
      globalEnabled: this.globalEnabled,
      lockscreenPreview: this.lockscreenPreview,
      badges: [...this.badges.entries()],
      delivered: [...this.delivered.values()].map(n => n.toMetadata()),
      history: this.history.slice(-200),
    };
    try {
      this.fs.writeFile(this.persistencePath, JSON.stringify(payload));
      this.stats.persistenceSaves++;
      return true;
    } catch (e) {
      Logger.warn(LOG_TAG, `No se pudo guardar notificaciones: ${e.message}`);
      return false;
    }
  }

  load() {
    if (!this.fs) return false;
    try {
      if (!this.fs.exists(this.persistencePath)) return false;
      const raw = this.fs.readFileText(this.persistencePath);
      const payload = JSON.parse(raw);
      if (payload.version !== 1) return false;

      this.focus = payload.focus || FOCUS_MODE.OFF;
      this.globalEnabled = payload.globalEnabled ?? true;
      this.lockscreenPreview = payload.lockscreenPreview ?? true;
      this.badges = new Map(payload.badges || []);
      this.history = payload.history || [];

      this.delivered.clear();
      for (const meta of (payload.delivered || [])) {
        const n = new Notification(meta);
        Object.assign(n, {
          state: meta.state,
          deliveredAt: meta.deliveredAt,
          readAt: meta.readAt,
          dismissedAt: meta.dismissedAt,
        });
        this.delivered.set(n.id, n);
        this._addToGroup(n);
      }
      this.stats.persistenceLoads++;
      Logger.info(LOG_TAG, `NotificationCenter cargado desde FS: ${this.delivered.size} entregadas`);
      return true;
    } catch (e) {
      Logger.warn(LOG_TAG, `Load falló: ${e.message}`);
      return false;
    }
  }

  _tryLoad() { try { this.load(); } catch {} }

  /* ================================================================ *
   * Suscriptores
   * ================================================================ */

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.subscribers) {
      try { fn({ type, payload, ts: now() }); }
      catch (e) { Logger.error(LOG_TAG, `Subscriber error: ${e.message}`); }
    }
  }

  /* ================================================================ *
   * Estadísticas
   * ================================================================ */

  getStats() {
    const byBundle = {};
    for (const n of this.delivered.values()) {
      byBundle[n.bundleId] = (byBundle[n.bundleId] || 0) + 1;
    }
    return {
      ...this.stats,
      totalDelivered: this.delivered.size,
      totalBadge: this.getTotalBadge(),
      scheduledCount: this.scheduler.size(),
      groupCount: this.groups.size,
      categoryCount: this.categories.size,
      historySize: this.history.length,
      focus: this.focus,
      globalEnabled: this.globalEnabled,
      apnsConnected: this.apns.connected,
      byBundle,
      badges: Object.fromEntries(this.badges),
    };
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const s = this.getStats();
    Logger.kernel(LOG_TAG, '─── NotificationCenter dump ───');
    Logger.kernel(LOG_TAG, `  global       : ${s.globalEnabled ? 'enabled' : 'disabled'}`);
    Logger.kernel(LOG_TAG, `  focus        : ${s.focus}`);
    Logger.kernel(LOG_TAG, `  APNs         : ${s.apnsConnected ? 'connected' : 'disconnected'}`);
    Logger.kernel(LOG_TAG, `  entregadas   : ${s.totalDelivered}`);
    Logger.kernel(LOG_TAG, `  programadas  : ${s.scheduledCount}`);
    Logger.kernel(LOG_TAG, `  grupos       : ${s.groupCount}`);
    Logger.kernel(LOG_TAG, `  categorías   : ${s.categoryCount}`);
    Logger.kernel(LOG_TAG, `  historial    : ${s.historySize}`);
    Logger.kernel(LOG_TAG, `  badge total  : ${s.totalBadge}`);
    Logger.kernel(LOG_TAG, `  creadas      : ${s.created} (local ${s.local} / push ${s.pushed})`);
    Logger.kernel(LOG_TAG, `  entregadas   : ${s.delivered}`);
    Logger.kernel(LOG_TAG, `  leídas       : ${s.read}`);
    Logger.kernel(LOG_TAG, `  descartadas  : ${s.dismissed}`);
    Logger.kernel(LOG_TAG, `  expiradas    : ${s.expired}`);
    Logger.kernel(LOG_TAG, `  suprimidas   : ${s.suppressed}`);
    Logger.kernel(LOG_TAG, `  bypass focus : ${s.bypassed}`);
    Logger.kernel(LOG_TAG, `  badges       :`);
    for (const [b, n] of Object.entries(s.badges)) {
      Logger.kernel(LOG_TAG, `    · ${b.padEnd(28)} ${n}`);
    }
    if (Object.keys(s.byBundle).length) {
      Logger.kernel(LOG_TAG, `  activas por bundle:`);
      for (const [b, n] of Object.entries(s.byBundle)) {
        Logger.kernel(LOG_TAG, `    · ${b.padEnd(28)} ${n}`);
      }
    }
  }
}

export default NotificationCenter;
