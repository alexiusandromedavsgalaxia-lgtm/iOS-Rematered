// src/system/Logger.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — Kernel Logger
 * ═══════════════════════════════════════════════════════════════
 *
 * Es el primer servicio que arranca el Kernel y el último que se apaga.
 * Todo el OS escribe aquí: kernel, drivers, loader, apps, UI.
 *
 *  Características:
 *   - Buffer circular de capacidad fija (no crece indefinidamente)
 *   - Niveles de severidad ordenados (DEBUG < INFO < WARN < ERROR < KERNEL < FATAL)
 *   - Filtros por nivel / tag / timestamp / rango de secuencia
 *   - Suscriptores reactivos (para pintar en BootScreen, Terminal, etc.)
 *   - Rate limiting por tag (evita inundar si un módulo entra en bucle)
 *   - Silenciado selectivo por tag
 *   - Exportación a texto plano y JSON
 *   - Volcado de logs críticos en caso de panic
 *   - Timestamps wall-clock + monotónico (performance.now)
 *   - Colores en consola en modo DEV
 *   - Contadores globales por nivel y de logs descartados
 * ═══════════════════════════════════════════════════════════════
 */

export const LogLevel = {
  DEBUG:  0,
  INFO:   1,
  WARN:   2,
  ERROR:  3,
  KERNEL: 4,
  FATAL:  5,
};

export const LogLevelName = {
  [LogLevel.DEBUG]:  'DEBUG',
  [LogLevel.INFO]:   'INFO',
  [LogLevel.WARN]:   'WARN',
  [LogLevel.ERROR]:  'ERROR',
  [LogLevel.KERNEL]: 'KERNEL',
  [LogLevel.FATAL]:  'FATAL',
};

const CONSOLE_STYLES = {
  [LogLevel.DEBUG]:  'color:#8a8a8e;font-style:italic',
  [LogLevel.INFO]:   'color:#0af',
  [LogLevel.WARN]:   'color:#fa0;font-weight:bold',
  [LogLevel.ERROR]:  'color:#f44;font-weight:bold',
  [LogLevel.KERNEL]: 'color:#a0f;font-weight:bold',
  [LogLevel.FATAL]:  'color:#fff;background:#c00;font-weight:bold;padding:2px 6px;border-radius:3px',
};

// ───────────────────────────────────────────────────────────────
// RingBuffer — buffer circular O(1) en push, sin shift()
// ───────────────────────────────────────────────────────────────
class RingBuffer {
  constructor(capacity) {
    if (capacity <= 0) throw new Error('RingBuffer: capacity debe ser > 0');
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
    this.totalWritten = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.totalWritten++;
  }

  toArray() {
    if (this.size === 0) return [];
    if (this.size < this.capacity) return this.buffer.slice(0, this.size);
    const out = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return out;
  }

  last(n) {
    if (n <= 0) return [];
    if (n >= this.size) return this.toArray();
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.capacity) % this.capacity;
      out[i] = this.buffer[idx];
    }
    return out;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
    this.totalWritten = 0;
  }

  get length() { return this.size; }
  get isEmpty() { return this.size === 0; }
}

// ───────────────────────────────────────────────────────────────
// RateLimiter por tag (token bucket simplificado con ventana deslizante)
// ───────────────────────────────────────────────────────────────
class TagRateLimiter {
  constructor(windowMs = 1000, maxPerWindow = 500) {
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.hits = new Map(); // tag -> array de timestamps
    this.dropped = new Map(); // tag -> contador
  }

  allow(tag, now) {
    let arr = this.hits.get(tag);
    if (!arr) { arr = []; this.hits.set(tag, arr); }

    // Purgar timestamps fuera de ventana
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();

    if (arr.length >= this.maxPerWindow) {
      this.dropped.set(tag, (this.dropped.get(tag) || 0) + 1);
      return false;
    }
    arr.push(now);
    return true;
  }

  getDropped(tag) { return this.dropped.get(tag) || 0; }
  reset() { this.hits.clear(); this.dropped.clear(); }
}

// ───────────────────────────────────────────────────────────────
// Logger
// ───────────────────────────────────────────────────────────────
class Logger {
  constructor(options = {}) {
    this.capacity      = options.capacity      ?? 5000;
    this.minLevel      = options.minLevel      ?? LogLevel.DEBUG;
    this.dev           = !!(import.meta?.env?.DEV);
    this.consoleOut    = options.consoleOut    ?? this.dev;

    this.buffer        = new RingBuffer(this.capacity);
    this.subscribers   = new Set();
    this.silencedTags  = new Set();
    this.rateLimiter   = new TagRateLimiter(
      options.rateWindowMs ?? 1000,
      options.rateMax     ?? 500,
    );

    this.counters = {
      DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, KERNEL: 0, FATAL: 0,
      dropped: 0,
    };

    this.bootTs        = Date.now();
    this.monotonicStart= performance.now();
    this._seq          = 0;

    // Cola de logs críticos para volcado en panic
    this.criticalQueue = [];
    this.maxCritical   = options.maxCritical ?? 200;

    // Hooks que se invocan SOLO en FATAL (para panic)
    this.fatalHandlers = new Set();

    this.initializedAt = Date.now();
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════

  debug(tag, msg, data)  { return this.log(LogLevel.DEBUG,  tag, msg, data); }
  info(tag, msg, data)   { return this.log(LogLevel.INFO,   tag, msg, data); }
  warn(tag, msg, data)   { return this.log(LogLevel.WARN,   tag, msg, data); }
  error(tag, msg, data)  { return this.log(LogLevel.ERROR,  tag, msg, data); }
  kernel(tag, msg, data) { return this.log(LogLevel.KERNEL, tag, msg, data); }

  fatal(tag, msg, data) {
    const entry = this.log(LogLevel.FATAL, tag, msg, data);
    // En FATAL, notificamos a los handlers (Kernel.panic los usará)
    this.fatalHandlers.forEach(fn => {
      try { fn(entry); } catch (_) { /* no romper el logger */ }
    });
    return entry;
  }

  log(level, tag, message, data = null) {
    // 1) Filtro por nivel
    if (level < this.minLevel) {
      this.counters.dropped++;
      return null;
    }

    // 2) Silenciado por tag
    if (this.silencedTags.has(tag)) {
      this.counters.dropped++;
      return null;
    }

    // 3) Rate limit
    const now = Date.now();
    if (!this.rateLimiter.allow(tag, now)) {
      this.counters.dropped++;
      return null;
    }

    // 4) Construir entrada
    const entry = {
      id:        `log-${this._seq.toString(36)}`,
      seq:       this._seq++,
      ts:        now,
      mono:      performance.now() - this.monotonicStart,
      level,
      levelName: LogLevelName[level],
      tag,
      message:   String(message),
      data,
    };

    // 5) Al buffer circular
    this.buffer.push(entry);

    // 6) Contador por nivel
    this.counters[entry.levelName] = (this.counters[entry.levelName] || 0) + 1;

    // 7) Cola crítica
    if (level >= LogLevel.ERROR) {
      this.criticalQueue.push(entry);
      if (this.criticalQueue.length > this.maxCritical) this.criticalQueue.shift();
    }

    // 8) Notificar suscriptores
    for (const fn of this.subscribers) {
      try { fn(entry); }
      catch (err) { /* jamás romper el logger por un subscriber */ }
    }

    // 9) Consola DEV
    if (this.consoleOut) {
      const style = CONSOLE_STYLES[level] || 'color:#fff';
      const prefix = `%c[${entry.levelName}][${tag}]`;
      // eslint-disable-next-line no-console
      if (data !== null && data !== undefined) console.log(`${prefix} ${message}`, style, data);
      // eslint-disable-next-line no-console
      else console.log(`${prefix} ${message}`, style);
    }

    return entry;
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPCIONES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onFatal(fn) {
    this.fatalHandlers.add(fn);
    return () => this.fatalHandlers.delete(fn);
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  all() { return this.buffer.toArray(); }
  last(n) { return this.buffer.last(n); }

  filter({ level, minLevel, tag, tags, since, until } = {}) {
    return this.buffer.filter(e => {
      if (level !== undefined && e.level !== level) return false;
      if (minLevel !== undefined && e.level < minLevel) return false;
      if (tag && e.tag !== tag) return false;
      if (tags && !tags.includes(e.tag)) return false;
      if (since && e.ts < since) return false;
      if (until && e.ts > until) return false;
      return true;
    });
  }

  byTag(tag)     { return this.filter({ tag }); }
  byLevel(level) { return this.filter({ level }); }
  since(ts)      { return this.filter({ since: ts }); }

  countByTag() {
    const out = {};
    for (const e of this.buffer.toArray()) {
      out[e.tag] = (out[e.tag] || 0) + 1;
    }
    return out;
  }

  getStats() {
    return {
      capacity:      this.capacity,
      stored:        this.buffer.length,
      totalWritten:  this.buffer.totalWritten,
      dropped:       this.counters.dropped,
      rateDropped:   Object.fromEntries(this.rateLimiter.dropped),
      counters:      { ...this.counters },
      uptimeMs:      Date.now() - this.bootTs,
      bootTs:        this.bootTs,
      initializedAt: this.initializedAt,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIGURACIÓN EN CALIENTE
  // ═══════════════════════════════════════════════════════════

  setMinLevel(level) { this.minLevel = level; }
  silence(tag)       { this.silencedTags.add(tag); }
  unsilence(tag)     { this.silencedTags.delete(tag); }
  isSilenced(tag)    { return this.silencedTags.has(tag); }

  clear() {
    this.buffer.clear();
    this.criticalQueue = [];
    this.rateLimiter.reset();
    this._seq = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORTACIÓN
  // ═══════════════════════════════════════════════════════════

  toText({ last = null } = {}) {
    const entries = last ? this.buffer.last(last) : this.buffer.toArray();
    const base = this.bootTs;
    return entries.map(e => {
      const dt = ((e.ts - base) / 1000).toFixed(3).padStart(9, ' ');
      const lvl = e.levelName.padEnd(6);
      const tag = e.tag.padEnd(8);
      return `[${dt}s][${lvl}][${tag}] ${e.message}`;
    }).join('\n');
  }

  toJSON({ last = null } = {}) {
    const entries = last ? this.buffer.last(last) : this.buffer.toArray();
    return JSON.stringify({
      bootTs: this.bootTs,
      uptime: Date.now() - this.bootTs,
      entries,
    }, null, 2);
  }

  dumpCritical() {
    return this.criticalQueue.slice();
  }
}

// ───────────────────────────────────────────────────────────────
// Singleton global del OS
// ───────────────────────────────────────────────────────────────
export const logger = new Logger();
