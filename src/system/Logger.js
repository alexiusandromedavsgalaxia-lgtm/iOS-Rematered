// src/system/Logger.js

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  KERNEL: 4,
  FATAL: 5,
};

export const LogLevelName = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.KERNEL]: 'KERNEL',
  [LogLevel.FATAL]: 'FATAL',
};

class RingBuffer {
  constructor(capacity = 5000) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('RingBuffer: capacity debe ser > 0');
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
    this.totalWritten = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
    this.totalWritten += 1;
  }

  toArray() {
    if (!this.size) return [];
    const out = new Array(this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) out[i] = this.buffer[(start + i) % this.capacity];
    return out;
  }

  last(n) {
    if (n <= 0 || !this.size) return [];
    const count = Math.min(n, this.size);
    const all = this.toArray();
    return all.slice(all.length - count);
  }

  filter(predicate) {
    return this.toArray().filter(predicate);
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

class TagRateLimiter {
  constructor(windowMs = 1000, maxPerWindow = 500) {
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.hits = new Map();
    this.dropped = new Map();
  }

  allow(tag, now) {
    const hits = this.hits.get(tag) || [];
    const cutoff = now - this.windowMs;
    while (hits.length && hits[0] < cutoff) hits.shift();
    if (hits.length >= this.maxPerWindow) {
      this.dropped.set(tag, (this.dropped.get(tag) || 0) + 1);
      this.hits.set(tag, hits);
      return false;
    }
    hits.push(now);
    this.hits.set(tag, hits);
    return true;
  }

  reset() {
    this.hits.clear();
    this.dropped.clear();
  }
}

export class Logger {
  constructor(options = {}) {
    this.capacity = options.capacity ?? 5000;
    this.minLevel = options.minLevel ?? LogLevel.DEBUG;
    this.dev = Boolean(import.meta?.env?.DEV);
    this.consoleOut = options.consoleOut ?? this.dev;
    this.buffer = new RingBuffer(this.capacity);
    this.subscribers = new Set();
    this.silencedTags = new Set();
    this.rateLimiter = new TagRateLimiter(options.rateWindowMs ?? 1000, options.rateMax ?? 500);
    this.counters = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, KERNEL: 0, FATAL: 0, dropped: 0 };
    this.bootTs = Date.now();
    this.monotonicStart = typeof performance !== 'undefined' ? performance.now() : 0;
    this._seq = 0;
    this.criticalQueue = [];
    this.maxCritical = options.maxCritical ?? 200;
    this.fatalHandlers = new Set();
    this.initializedAt = Date.now();
  }

  debug(tag, msg, data) { return this.log(LogLevel.DEBUG, tag, msg, data); }
  info(tag, msg, data) { return this.log(LogLevel.INFO, tag, msg, data); }
  warn(tag, msg, data) { return this.log(LogLevel.WARN, tag, msg, data); }
  error(tag, msg, data) { return this.log(LogLevel.ERROR, tag, msg, data); }
  kernel(tag, msg, data) { return this.log(LogLevel.KERNEL, tag, msg, data); }

  fatal(tag, msg, data) {
    const entry = this.log(LogLevel.FATAL, tag, msg, data);
    for (const handler of this.fatalHandlers) {
      try { handler(entry); } catch (_) { /* logger must never fail because of a handler */ }
    }
    return entry;
  }

  log(level, tag, message, data = null) {
    if (level < this.minLevel || this.silencedTags.has(tag)) {
      this.counters.dropped += 1;
      return null;
    }
    const now = Date.now();
    if (!this.rateLimiter.allow(tag, now)) {
      this.counters.dropped += 1;
      return null;
    }

    const entry = {
      id: `log-${this._seq.toString(36)}`,
      seq: this._seq++,
      ts: now,
      mono: (typeof performance !== 'undefined' ? performance.now() : 0) - this.monotonicStart,
      level,
      levelName: LogLevelName[level] || 'UNKNOWN',
      tag: String(tag ?? 'OS'),
      message: String(message ?? ''),
      data,
    };

    this.buffer.push(entry);
    this.counters[entry.levelName] = (this.counters[entry.levelName] || 0) + 1;
    if (level >= LogLevel.ERROR) {
      this.criticalQueue.push(entry);
      if (this.criticalQueue.length > this.maxCritical) this.criticalQueue.shift();
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(entry); } catch (_) { /* isolated subscriber */ }
    }
    if (this.consoleOut && typeof console !== 'undefined') {
      const prefix = `[${entry.levelName}][${entry.tag}]`;
      if (data !== null && data !== undefined) console.log(prefix, entry.message, data);
      else console.log(prefix, entry.message);
    }
    return entry;
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onFatal(fn) {
    if (typeof fn !== 'function') return () => {};
    this.fatalHandlers.add(fn);
    return () => this.fatalHandlers.delete(fn);
  }

  all() { return this.buffer.toArray(); }
  last(n) { return this.buffer.last(n); }

  filter({ level, minLevel, tag, tags, since, until } = {}) {
    return this.buffer.filter((entry) => {
      if (level !== undefined && entry.level !== level) return false;
      if (minLevel !== undefined && entry.level < minLevel) return false;
      if (tag && entry.tag !== tag) return false;
      if (tags && !tags.includes(entry.tag)) return false;
      if (since !== undefined && entry.ts < since) return false;
      if (until !== undefined && entry.ts > until) return false;
      return true;
    });
  }

  byTag(tag) { return this.filter({ tag }); }
  byLevel(level) { return this.filter({ level }); }
  since(ts) { return this.filter({ since: ts }); }

  countByTag() {
    return this.buffer.toArray().reduce((out, entry) => {
      out[entry.tag] = (out[entry.tag] || 0) + 1;
      return out;
    }, {});
  }

  getStats() {
    return {
      capacity: this.capacity,
      stored: this.buffer.length,
      totalWritten: this.buffer.totalWritten,
      dropped: this.counters.dropped,
      rateDropped: Object.fromEntries(this.rateLimiter.dropped),
      counters: { ...this.counters },
      uptimeMs: Date.now() - this.bootTs,
      bootTs: this.bootTs,
      initializedAt: this.initializedAt,
    };
  }

  setMinLevel(level) { this.minLevel = level; }
  silence(tag) { this.silencedTags.add(tag); }
  unsilence(tag) { this.silencedTags.delete(tag); }
  isSilenced(tag) { return this.silencedTags.has(tag); }

  clear() {
    this.buffer.clear();
    this.criticalQueue = [];
    this.rateLimiter.reset();
    this._seq = 0;
    this.counters = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, KERNEL: 0, FATAL: 0, dropped: 0 };
  }

  toText({ last = null } = {}) {
    const entries = last ? this.buffer.last(last) : this.buffer.toArray();
    return entries.map((entry) => `[${((entry.ts - this.bootTs) / 1000).toFixed(3).padStart(9, ' ')}s][${entry.levelName.padEnd(6)}][${entry.tag.padEnd(8)}] ${entry.message}`).join('\n');
  }

  toJSON({ last = null } = {}) {
    return JSON.stringify({ bootTs: this.bootTs, uptime: Date.now() - this.bootTs, entries: last ? this.buffer.last(last) : this.buffer.toArray() }, null, 2);
  }

  dumpCritical() { return this.criticalQueue.slice(); }

  // Backwards-compatible static facade used by older drivers.
  static debug(...args) { return logger.debug(...args); }
  static info(...args) { return logger.info(...args); }
  static warn(...args) { return logger.warn(...args); }
  static error(...args) { return logger.error(...args); }
  static kernel(...args) { return logger.kernel(...args); }
  static fatal(...args) { return logger.fatal(...args); }
}

export const logger = new Logger();
