// src/drivers/VStorage.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VStorage (Virtual NVMe / APFS)
 * ═══════════════════════════════════════════════════════════════
 *
 * Almacenamiento NVMe virtual con APFS simulado. Modela el SSD de
 * 256 GB de un iPhone: capacidad, salud, rendimiento, wear leveling,
 * cifrado hardware, y las operaciones típicas de un filesystem.
 *
 * Responsabilidades:
 *   - Capacidad: total / usada / libre con desglose por categoría
 *     (System, Apps, Photos, Music, Messages, Documents, Other)
 *   - Salud del SSD: TBW (Total Bytes Written), wear %, health %
 *   - Rendimiento: IOPS, latencia, throughput secuencial y aleatorio
 *   - Cifrado hardware AES-256 (Data Protection) con clases de
 *     protección (A, B, C, D) como APFS real
 *   - Write amplification, TRIM, wear leveling
 *   - Volúmenes APFS (System, Data, Preboot, Recovery, VM)
 *   - Snapshots (para Time Machine-like)
 *   - Purga de cachés y "Other" storage
 *   - Cuotas por app (App Sandbox storage quota)
 *   - Estadísticas: reads, writes, bytes tx/rx, errores
 *   - Thermal throttling del NAND (alta temperatura → menos IOPS)
 *   - IRQ_STORAGE: space-low, space-critical, snapshot-created,
 *     trim-completed, wear-warning
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const StorageState = {
  READY:         'ready',
  BUSY:          'busy',
  FULL:          'full',
  SPACE_WARNING: 'space-warning',
  SPACE_CRITICAL:'space-critical',
  ERROR:         'error',
  TRIMING:       'trimming',
};

export const DataProtectionClass = {
  A: 'A',   // Completamente protegido (siempre cifrado)
  B: 'B',   // Protegido salvo durante restore
  C: 'C',   // Protegido cuando está bloqueado
  D: 'D',   // Sin protección (rara vez)
};

export const VolumeRole = {
  SYSTEM:    'System',
  DATA:      'Data',
  PREBOOT:   'Preboot',
  RECOVERY:  'Recovery',
  VM:        'VM',
  USER:      'User',
};

// Categorías de uso (como en Ajustes → General → Almacenamiento)
export const StorageCategory = {
  SYSTEM:     'System',
  APPS:       'Apps',
  PHOTOS:     'Photos',
  MUSIC:      'Music',
  MESSAGES:   'Messages',
  MAIL:       'Mail',
  DOCUMENTS:  'Documents',
  BOOKS:      'Books',
  OTHER:      'Other',
  FREE:       'Free',
};

// Tamaños por defecto de categorías (bytes) — 256 GB de base
const DEFAULT_CATEGORY_SIZES = {
  [StorageCategory.SYSTEM]:    8  * 1024 * 1024 * 1024,     // 8 GB
  [StorageCategory.APPS]:     15  * 1024 * 1024 * 1024,     // 15 GB
  [StorageCategory.PHOTOS]:    6  * 1024 * 1024 * 1024,     // 6 GB
  [StorageCategory.MUSIC]:     3  * 1024 * 1024 * 1024,     // 3 GB
  [StorageCategory.MESSAGES]:  1  * 1024 * 1024 * 1024,     // 1 GB
  [StorageCategory.MAIL]:      0.5 * 1024 * 1024 * 1024,    // 512 MB
  [StorageCategory.DOCUMENTS]: 2  * 1024 * 1024 * 1024,     // 2 GB
  [StorageCategory.BOOKS]:     0.3 * 1024 * 1024 * 1024,    // 300 MB
  [StorageCategory.OTHER]:     4  * 1024 * 1024 * 1024,     // 4 GB
};

// Umbrales de aviso (%)
const WARN_PCT = 90;
const CRITICAL_PCT = 95;

// Clases de protección por categoría (aproximación APFS real)
const CATEGORY_PROTECTION = {
  [StorageCategory.SYSTEM]:    DataProtectionClass.A,
  [StorageCategory.APPS]:      DataProtectionClass.C,
  [StorageCategory.PHOTOS]:    DataProtectionClass.C,
  [StorageCategory.MUSIC]:     DataProtectionClass.C,
  [StorageCategory.MESSAGES]:  DataProtectionClass.C,
  [StorageCategory.MAIL]:      DataProtectionClass.C,
  [StorageCategory.DOCUMENTS]: DataProtectionClass.C,
  [StorageCategory.BOOKS]:     DataProtectionClass.C,
  [StorageCategory.OTHER]:     DataProtectionClass.D,
};

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randRange = (a, b) => a + Math.random() * (b - a);
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ───────────────────────────────────────────────────────────────
// Volume — un volumen APFS
// ───────────────────────────────────────────────────────────────
class Volume {
  constructor({ name, role, quotaBytes = null, caseSensitive = false, encrypted = true }) {
    this.id             = `vol-${Math.random().toString(36).slice(2, 10)}`;
    this.name           = name;
    this.role           = role;
    this.quotaBytes     = quotaBytes;
    this.caseSensitive  = caseSensitive;
    this.encrypted      = encrypted;
    this.createdAt      = Date.now();
    this.mounted        = true;

    this.usedBytes      = 0;
    this.fileCount      = 0;
    this.dirCount       = 0;

    // Estadísticas de I/O
    this.stats = {
      reads:        0,
      writes:       0,
      bytesRead:    0,
      bytesWritten: 0,
      deletes:      0,
      creates:      0,
      lastOpTs:     null,
    };
  }

  freeBytes() {
    if (this.quotaBytes) return Math.max(0, this.quotaBytes - this.usedBytes);
    return Infinity;
  }

  snapshot() {
    return {
      id:            this.id,
      name:          this.name,
      role:          this.role,
      encrypted:     this.encrypted,
      caseSensitive: this.caseSensitive,
      mounted:       this.mounted,
      quotaBytes:    this.quotaBytes,
      quotaFormatted:this.quotaBytes ? formatBytes(this.quotaBytes) : 'unlimited',
      usedBytes:     this.usedBytes,
      usedFormatted: formatBytes(this.usedBytes),
      freeBytes:     this.quotaBytes ? this.freeBytes() : null,
      fileCount:     this.fileCount,
      dirCount:      this.dirCount,
      stats:         { ...this.stats },
      createdAt:     this.createdAt,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Snapshot — punto de restauración
// ───────────────────────────────────────────────────────────────
class Snapshot {
  constructor({ name, volumeId, sizeBytes }) {
    this.id         = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.name       = name;
    this.volumeId   = volumeId;
    this.sizeBytes  = sizeBytes;
    this.createdAt  = Date.now();
  }

  snapshot() {
    return {
      id:        this.id,
      name:      this.name,
      volumeId:  this.volumeId,
      sizeBytes: this.sizeBytes,
      sizeFormatted: formatBytes(this.sizeBytes),
      createdAt: this.createdAt,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// IOOperation — una operación de E/S (para trackear latencia)
// ───────────────────────────────────────────────────────────────
class IOOperation {
  constructor({ type, bytes, volumeId, source = 'user', priority = 'normal' }) {
    this.id       = `io-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.type     = type;   // 'read' | 'write' | 'delete' | 'create' | 'trim'
    this.bytes    = bytes;
    this.volumeId = volumeId;
    this.source   = source;
    this.priority = priority;   // 'low' | 'normal' | 'high' | 'realtime'
    this.startTs  = Date.now();
    this.endTs    = null;
    this.latencyMs= null;
    this.error    = null;
  }

  finish(error = null) {
    this.endTs = Date.now();
    this.latencyMs = this.endTs - this.startTs;
    this.error = error;
    return this;
  }

  snapshot() {
    return {
      id:        this.id,
      type:      this.type,
      bytes:     this.bytes,
      bytesFormatted: formatBytes(this.bytes),
      volumeId:  this.volumeId,
      source:    this.source,
      priority:  this.priority,
      startTs:   this.startTs,
      endTs:     this.endTs,
      latencyMs: this.latencyMs,
      error:     this.error,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VStorage — driver completo
// ───────────────────────────────────────────────────────────────
export class VStorage {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VStorage';
    this.model = `${DEVICE_MODEL.storage.sizeBytes / GB}GB NVMe (${DEVICE_MODEL.storage.filesystem})`;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = StorageState.READY;

    // Capacidad total (256 GB nominal; ~240 GB usables como en iOS)
    this.totalBytes    = DEVICE_MODEL.storage.sizeBytes;
    this.usableBytes   = Math.floor(this.totalBytes * 0.94);    // overhead APFS

    // Categorías de uso (desglose estilo iOS)
    this.categories = new Map();
    for (const [cat, size] of Object.entries(DEFAULT_CATEGORY_SIZES)) {
      this.categories.set(cat, { bytes: Math.round(size * (0.9 + Math.random() * 0.2)) });
    }

    // Volúmenes APFS
    this.volumes = new Map();
    this._createDefaultVolumes();

    // Snapshots
    this.snapshots = new Map();

    // Cifrado hardware
    this.encryption = {
      enabled:      true,
      algorithm:    'AES-256-XTS',
      keyInSEP:     true,       // clave custodiada por Secure Enclave
      hardwareAccel:true,
      unlockState:  'locked',   // 'locked' | 'unlocked'
    };

    // Salud del SSD
    this.health = {
      wearPercent:      3.2,          // % de desgaste (0-100)
      tbwWrittenBytes:  42 * GB,      // Total Bytes Written
      tbwLimitBytes:    150 * 1024 * GB,  // ~150 TBW típicos
      spareBlocksPct:   7.0,          // bloques de reserva
      temperatureC:     35,
      lastTrimTs:       Date.now() - 24 * 3600 * 1000,
      badBlocks:        0,
    };

    // Rendimiento (parámetros nominales del NVMe)
    this.performance = {
      readSeqMBs:      DEVICE_MODEL.storage.readMBs,     // 3200
      writeSeqMBs:     DEVICE_MODEL.storage.writeMBs,    // 2600
      readRandomIOPS:  800_000,
      writeRandomIOPS: 400_000,
      latencyReadUs:   80,       // microsegundos
      latencyWriteUs:  120,
    };

    // Estado de throttling térmico
    this.thermalThrottle = 0;    // 0..1, 1 = full throttle

    // Cola de I/O (para simular)
    this.ioQueue = [];
    this.maxIOQueue = 128;
    this.pendingOperations = 0;

    // Cuotas por app (bundleId → bytes)
    this.appQuotas = new Map();
    this.appUsage  = new Map();

    // Historial de throughput
    this.historySize = 120;
    this.history = {
      ts:      [],
      readMBs: [],
      writeMBs:[],
      usedGB:  [],
    };

    // Tráfico instantáneo
    this.currentReadMBs  = 0;
    this.currentWriteMBs = 0;

    // Suscriptores
    this.subscribers        = new Set();
    this.spaceSubscribers   = new Set();
    this.ioSubscribers      = new Set();

    // Tick loop
    this.tickIntervalMs = 250;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      ioOperations:        0,
      ioErrors:            0,
      totalBytesRead:      0,
      totalBytesWritten:   0,
      totalBytesDeleted:   0,
      filesCreated:        0,
      filesDeleted:        0,
      spaceWarnings:       0,
      spaceCriticals:      0,
      trims:               0,
      snapshotsCreated:    0,
      snapshotsDeleted:    0,
      appQuotasExceeded:   0,
      encryptionOperations:0,
      startedAt:           null,
    };

    // Aviso: ya se ha lanzado el aviso de espacio?
    this._spaceWarningFired    = false;
    this._spaceCriticalFired   = false;

    logger.kernel('VStorage',
      `creado: ${this.model}, usables=${formatBytes(this.usableBytes)}`);
  }

  _createDefaultVolumes() {
    const mkVol = (name, role, quotaBytes) => {
      const v = new Volume({ name, role, quotaBytes });
      this.volumes.set(v.id, v);
      return v;
    };
    // Volúmenes al estilo macOS/iOS
    this.systemVolume  = mkVol('System',   VolumeRole.SYSTEM,   12 * GB);
    this.dataVolume    = mkVol('Data',     VolumeRole.DATA,     null);
    this.preBootVolume = mkVol('Preboot',  VolumeRole.PREBOOT,  1 * GB);
    this.recoveryVolume= mkVol('Recovery', VolumeRole.RECOVERY, 1 * GB);
    this.vmVolume      = mkVol('VM',       VolumeRole.VM,       4 * GB);

    // Inicializamos el volumen System con los bytes de System
    this.systemVolume.usedBytes = this.categories.get(StorageCategory.SYSTEM).bytes;
    this.systemVolume.fileCount = 45000;
    this.systemVolume.dirCount  = 8000;
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    // Calcular uso inicial total
    this._recalcUsage();

    logger.info('VStorage',
      `✓ init: ${this.model}, usado=${formatBytes(this.usedBytes())} / ${formatBytes(this.usableBytes)} (${this.usedPct().toFixed(1)}%)`);
    this.bus?.raiseInterrupt?.('IRQ_STORAGE', {
      source: 'vstorage', event: 'ready', usedPct: this.usedPct(),
    }, 'vstorage');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this.tickId = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.tickId);
    this.tickId = null;
    logger.info('VStorage', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // 1) Actualizar temperatura del NAND
    this._updateTemperature();

    // 2) Throttling térmico
    this._updateThermalThrottle();

    // 3) Simular tráfico si hay operaciones pendientes
    this._simulateTraffic();

    // 4) Comprobar espacio
    this._checkSpace();

    // 5) Historial
    this._pushHistory();

    // 6) Notificar
    this._emit();

    this.tickCount++;
  }

  _updateTemperature() {
    // El NAND se calienta con I/O, se enfría en reposo
    const ioLoad = (this.currentReadMBs + this.currentWriteMBs) / (this.performance.readSeqMBs);
    const target = 32 + ioLoad * 25;
    this.health.temperatureC = this.health.temperatureC * 0.95 + target * 0.05;
  }

  _updateThermalThrottle() {
    const t = this.health.temperatureC;
    if (t < 50)      this.thermalThrottle = 0;
    else if (t < 65) this.thermalThrottle = (t - 50) / 15 * 0.3;
    else if (t < 80) this.thermalThrottle = 0.3 + ((t - 65) / 15) * 0.4;
    else             this.thermalThrottle = 0.7 + ((t - 80) / 10) * 0.3;
    this.thermalThrottle = clamp(this.thermalThrottle, 0, 1);
  }

  _simulateTraffic() {
    // Decae hacia 0 si no hay operaciones
    if (this.pendingOperations === 0) {
      this.currentReadMBs  *= 0.85;
      this.currentWriteMBs *= 0.85;
      if (this.currentReadMBs < 1) this.currentReadMBs = 0;
      if (this.currentWriteMBs < 1) this.currentWriteMBs = 0;
    }
  }

  _checkSpace() {
    const pct = this.usedPct();

    if (pct >= CRITICAL_PCT && !this._spaceCriticalFired) {
      this._spaceCriticalFired = true;
      this._spaceWarningFired = true;
      this.state = StorageState.SPACE_CRITICAL;
      this.metrics.spaceCriticals++;
      logger.warn('VStorage', `☠ almacenamiento CRÍTICO: ${pct.toFixed(1)}%`);
      this.bus?.raiseInterrupt?.('IRQ_STORAGE', {
        source: 'vstorage', event: 'space-critical', usedPct: pct,
      }, 'vstorage');
      for (const fn of this.spaceSubscribers) {
        try { fn({ level: 'critical', usedPct: pct }); } catch (_) {}
      }
    } else if (pct >= WARN_PCT && !this._spaceWarningFired) {
      this._spaceWarningFired = true;
      this.state = StorageState.SPACE_WARNING;
      this.metrics.spaceWarnings++;
      logger.warn('VStorage', `⚠ almacenamiento bajo: ${pct.toFixed(1)}%`);
      this.bus?.raiseInterrupt?.('IRQ_STORAGE', {
        source: 'vstorage', event: 'space-low', usedPct: pct,
      }, 'vstorage');
      for (const fn of this.spaceSubscribers) {
        try { fn({ level: 'warning', usedPct: pct }); } catch (_) {}
      }
    } else if (pct < WARN_PCT - 5) {
      // Hysteresis para resetear
      this._spaceWarningFired = false;
      this._spaceCriticalFired = false;
      if (this.state !== StorageState.READY && this.state !== StorageState.BUSY) {
        this.state = StorageState.READY;
      }
    }
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.readMBs.push(this.currentReadMBs);
    this.history.writeMBs.push(this.currentWriteMBs);
    this.history.usedGB.push(this.usedBytes() / GB);
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CÁLCULOS DE USO
  // ═══════════════════════════════════════════════════════════

  usedBytes() {
    let total = 0;
    for (const { bytes } of this.categories.values()) total += bytes;
    return total;
  }

  freeBytes() {
    return Math.max(0, this.usableBytes - this.usedBytes());
  }

  usedPct() {
    return (this.usedBytes() / this.usableBytes) * 100;
  }

  _recalcUsage() {
    // Sincroniza los volúmenes con las categorías (aproximado)
    let dataUsed = 0;
    for (const [cat, { bytes }] of this.categories) {
      if (cat === StorageCategory.SYSTEM) continue;
      dataUsed += bytes;
    }
    this.dataVolume.usedBytes = dataUsed;
  }

  // ═══════════════════════════════════════════════════════════
  // OPERACIONES DE ALTO NIVEL
  // ═══════════════════════════════════════════════════════════

  /**
   * Escribe en la categoría indicada.
   */
  writeToCategory(category, bytes, { source = 'user' } = {}) {
    if (bytes <= 0) return { ok: false, reason: 'invalid-bytes' };
    if (!this.categories.has(category)) {
      return { ok: false, reason: 'invalid-category' };
    }
    if (this.freeBytes() < bytes) {
      this.metrics.ioErrors++;
      logger.warn('VStorage', `sin espacio para escribir ${formatBytes(bytes)} en ${category}`);
      return { ok: false, reason: 'no-space' };
    }

    const op = new IOOperation({
      type: 'write', bytes, volumeId: this.dataVolume.id, source,
    });
    this._executeIO(op);

    this.categories.get(category).bytes += bytes;
    this.dataVolume.usedBytes += bytes;
    this.dataVolume.stats.bytesWritten += bytes;
    this.dataVolume.stats.writes++;
    this.dataVolume.stats.lastOpTs = Date.now();

    this.metrics.ioOperations++;
    this.metrics.totalBytesWritten += bytes;
    this.health.tbwWrittenBytes += bytes;

    // Recalcular wear
    this._updateWear();

    this._notifyIO(op);

    return { ok: true, op: op.snapshot() };
  }

  /**
   * Borra bytes de una categoría.
   */
  deleteFromCategory(category, bytes, { source = 'user' } = {}) {
    if (bytes <= 0) return { ok: false, reason: 'invalid-bytes' };
    const cat = this.categories.get(category);
    if (!cat) return { ok: false, reason: 'invalid-category' };

    const removed = Math.min(bytes, cat.bytes);
    if (removed <= 0) return { ok: false, reason: 'nothing-to-delete' };

    const op = new IOOperation({
      type: 'delete', bytes: removed, volumeId: this.dataVolume.id, source,
    });
    this._executeIO(op);

    cat.bytes -= removed;
    this.dataVolume.usedBytes = Math.max(0, this.dataVolume.usedBytes - removed);
    this.dataVolume.stats.deletes++;
    this.dataVolume.stats.lastOpTs = Date.now();

    this.metrics.ioOperations++;
    this.metrics.totalBytesDeleted += removed;

    this._notifyIO(op);

    return { ok: true, removed, op: op.snapshot() };
  }

  /**
   * Lee bytes (no modifica estado, solo registra estadísticas).
   */
  readBytes(bytes, { source = 'user', volumeId = null } = {}) {
    const op = new IOOperation({
      type: 'read', bytes, volumeId: volumeId || this.dataVolume.id, source,
    });
    this._executeIO(op);

    this.metrics.ioOperations++;
    this.metrics.totalBytesRead += bytes;

    this._notifyIO(op);

    return { ok: true, op: op.snapshot() };
  }

  /**
   * Simula una operación de E/S: calcula latencia y la completa.
   */
  _executeIO(op) {
    this.pendingOperations++;
    this.state = StorageState.BUSY;

    // Latencia base
    let latencyUs = op.type === 'write'
      ? this.performance.latencyWriteUs
      : this.performance.latencyReadUs;

    // Ajustar según prioridad
    if (op.priority === 'realtime') latencyUs *= 0.5;
    else if (op.priority === 'high') latencyUs *= 0.7;
    else if (op.priority === 'low') latencyUs *= 2;

    // Ajustar según throttling térmico
    latencyUs *= (1 + this.thermalThrottle * 3);

    // Ajustar según tamaño (para ops grandes)
    if (op.bytes > 10 * MB) {
      const seqMBs = op.type === 'write' ? this.performance.writeSeqMBs : this.performance.readSeqMBs;
      const seqLatency = (op.bytes / MB) / seqMBs * 1000 * 1000;  // μs
      latencyUs = Math.max(latencyUs, seqLatency);
    }

    // Error ocasional (0.001%)
    if (Math.random() < 0.00001) {
      op.finish('io-error');
      this.metrics.ioErrors++;
      this.pendingOperations--;
      return op;
    }

    op.finish(null);

    // Actualizar throughput instantáneo
    const mbTransferred = op.bytes / MB;
    const secs = Math.max(0.001, (op.latencyMs || 1) / 1000);
    const mbs = mbTransferred / secs;
    if (op.type === 'write') {
      this.currentWriteMBs = this.currentWriteMBs * 0.7 + mbs * 0.3;
    } else if (op.type === 'read') {
      this.currentReadMBs = this.currentReadMBs * 0.7 + mbs * 0.3;
    }

    this.pendingOperations--;
    if (this.pendingOperations <= 0 && this.state === StorageState.BUSY) {
      this.state = StorageState.READY;
    }

    return op;
  }

  _updateWear() {
    const written = this.health.tbwWrittenBytes;
    const limit = this.health.tbwLimitBytes;
    this.health.wearPercent = clamp((written / limit) * 100, 0, 100);
  }

  // ═══════════════════════════════════════════════════════════
  // APLICACIONES Y CUOTAS
  // ═══════════════════════════════════════════════════════════

  setAppQuota(bundleId, bytes) {
    this.appQuotas.set(bundleId, bytes);
    logger.debug('VStorage', `cuota para ${bundleId}: ${formatBytes(bytes)}`);
    return true;
  }

  getAppUsage(bundleId) {
    return this.appUsage.get(bundleId) || 0;
  }

  appWrite(bundleId, bytes) {
    const quota = this.appQuotas.get(bundleId);
    const used = this.appUsage.get(bundleId) || 0;
    if (quota && used + bytes > quota) {
      this.metrics.appQuotasExceeded++;
      logger.warn('VStorage', `app ${bundleId} excede cuota (${formatBytes(quota)})`);
      return { ok: false, reason: 'quota-exceeded' };
    }

    const result = this.writeToCategory(StorageCategory.APPS, bytes, { source: bundleId });
    if (result.ok) {
      this.appUsage.set(bundleId, used + bytes);
    }
    return result;
  }

  appDelete(bundleId, bytes) {
    const used = this.appUsage.get(bundleId) || 0;
    const removed = Math.min(bytes, used);
    if (removed <= 0) return { ok: false, reason: 'nothing' };
    const result = this.deleteFromCategory(StorageCategory.APPS, removed, { source: bundleId });
    if (result.ok) {
      this.appUsage.set(bundleId, used - removed);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS
  // ═══════════════════════════════════════════════════════════

  createSnapshot(name = null, volumeId = null) {
    const vol = volumeId ? this.volumes.get(volumeId) : this.systemVolume;
    if (!vol) return null;

    const snap = new Snapshot({
      name:    name || `snapshot-${new Date().toISOString().slice(0, 10)}`,
      volumeId:vol.id,
      sizeBytes: vol.usedBytes * 0.05,   // snapshot delta aproximado
    });
    this.snapshots.set(snap.id, snap);
    this.metrics.snapshotsCreated++;
    logger.info('VStorage', `📸 snapshot creado: ${snap.name}`);
    this.bus?.raiseInterrupt?.('IRQ_STORAGE', {
      source: 'vstorage', event: 'snapshot-created', id: snap.id,
    }, 'vstorage');
    this._emit();
    return snap.snapshot();
  }

  deleteSnapshot(id) {
    const s = this.snapshots.get(id);
    if (!s) return false;
    this.snapshots.delete(id);
    this.metrics.snapshotsDeleted++;
    logger.info('VStorage', `snapshot eliminado: ${s.name}`);
    this._emit();
    return true;
  }

  listSnapshots() {
    return [...this.snapshots.values()].map(s => s.snapshot());
  }

  // ═══════════════════════════════════════════════════════════
  // TRIM / MANTENIMIENTO
  // ═══════════════════════════════════════════════════════════

  async runTRIM() {
    if (this.state === StorageState.TRIMING) {
      logger.warn('VStorage', 'TRIM ya en curso');
      return false;
    }
    this.state = StorageState.TRIMING;
    logger.info('VStorage', 'iniciando TRIM...');
    this._emit();

    // Simular duración
    await this._delay(2000 + Math.random() * 2000);

    this.health.lastTrimTs = Date.now();
    // Recuperar algo de espacio (bloques en blanco)
    for (const { } of this.categories.values()) {}
    this.metrics.trims++;
    this.state = StorageState.READY;

    logger.info('VStorage', '✓ TRIM completado');
    this.bus?.raiseInterrupt?.('IRQ_STORAGE', {
      source: 'vstorage', event: 'trim-completed',
    }, 'vstorage');
    this._emit();
    return true;
  }

  /**
   * Purga cachés de apps (equivalente a "Offload Unused Apps"
   * o borrar caché).
   */
  purgeCaches(bytes = null) {
    const cacheBytes = bytes ?? Math.round(this.categories.get(StorageCategory.OTHER).bytes * 0.3);
    const result = this.deleteFromCategory(StorageCategory.OTHER, cacheBytes, { source: 'system' });
    if (result.ok) {
      logger.info('VStorage', `cachés purgadas: ${formatBytes(cacheBytes)} liberados`);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // CIFRADO
  // ═══════════════════════════════════════════════════════════

  unlock() {
    if (this.encryption.unlockState === 'unlocked') return true;
    this.encryption.unlockState = 'unlocked';
    this.metrics.encryptionOperations++;
    logger.info('VStorage', '🔓 almacenamiento desbloqueado');
    this._emit();
    return true;
  }

  lock() {
    if (this.encryption.unlockState === 'locked') return true;
    this.encryption.unlockState = 'locked';
    this.metrics.encryptionOperations++;
    logger.info('VStorage', '🔒 almacenamiento bloqueado');
    this._emit();
    return true;
  }

  isUnlocked() {
    return this.encryption.unlockState === 'unlocked';
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  getCategoryBreakdown() {
    const out = [];
    let totalUsed = 0;
    for (const [cat, { bytes }] of this.categories) {
      totalUsed += bytes;
      out.push({
        category:     cat,
        bytes,
        formatted:    formatBytes(bytes),
        percent:      parseFloat(((bytes / this.usableBytes) * 100).toFixed(2)),
        protection:   CATEGORY_PROTECTION[cat] || DataProtectionClass.D,
      });
    }
    out.push({
      category:  StorageCategory.FREE,
      bytes:     this.freeBytes(),
      formatted: formatBytes(this.freeBytes()),
      percent:   parseFloat(((this.freeBytes() / this.usableBytes) * 100).toFixed(2)),
      protection:null,
    });
    out.sort((a, b) => b.bytes - a.bytes);
    return out;
  }

  getVolumeList() {
    return [...this.volumes.values()].map(v => v.snapshot());
  }

  getHealthReport() {
    const tbwPct = (this.health.tbwWrittenBytes / this.health.tbwLimitBytes) * 100;
    return {
      wearPercent:       parseFloat(this.health.wearPercent.toFixed(2)),
      healthPercent:     parseFloat((100 - this.health.wearPercent).toFixed(2)),
      tbwWritten:        formatBytes(this.health.tbwWrittenBytes),
      tbwLimit:          formatBytes(this.health.tbwLimitBytes),
      tbwPct:            parseFloat(tbwPct.toFixed(2)),
      spareBlocksPct:    this.health.spareBlocksPct,
      temperatureC:      parseFloat(this.health.temperatureC.toFixed(1)),
      thermalThrottle:   parseFloat(this.thermalThrottle.toFixed(2)),
      lastTrimTs:        this.health.lastTrimTs,
      badBlocks:         this.health.badBlocks,
      status:            this._healthStatus(),
    };
  }

  _healthStatus() {
    const w = this.health.wearPercent;
    if (w < 20) return 'excellent';
    if (w < 50) return 'good';
    if (w < 80) return 'fair';
    if (w < 95) return 'degraded';
    return 'service-required';
  }

  getPerformanceReport() {
    const throttleFactor = 1 - this.thermalThrottle * 0.7;
    return {
      readSeqMBs:      parseFloat((this.performance.readSeqMBs * throttleFactor).toFixed(0)),
      writeSeqMBs:     parseFloat((this.performance.writeSeqMBs * throttleFactor).toFixed(0)),
      readRandomIOPS:  Math.round(this.performance.readRandomIOPS * throttleFactor),
      writeRandomIOPS: Math.round(this.performance.writeRandomIOPS * throttleFactor),
      latencyReadUs:   Math.round(this.performance.latencyReadUs / throttleFactor),
      latencyWriteUs:  Math.round(this.performance.latencyWriteUs / throttleFactor),
      currentReadMBs:  parseFloat(this.currentReadMBs.toFixed(1)),
      currentWriteMBs: parseFloat(this.currentWriteMBs.toFixed(1)),
      throttled:       this.thermalThrottle > 0,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onSpaceWarning(fn) {
    this.spaceSubscribers.add(fn);
    return () => this.spaceSubscribers.delete(fn);
  }

  onIO(fn) {
    this.ioSubscribers.add(fn);
    return () => this.ioSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VStorage', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _notifyIO(op) {
    const snap = op.snapshot();
    for (const fn of this.ioSubscribers) {
      try { fn(snap); } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:        this.model,
      state:        this.state,
      totalBytes:   this.totalBytes,
      usableBytes:  this.usableBytes,
      usedBytes:    this.usedBytes(),
      freeBytes:    this.freeBytes(),
      usedPct:      parseFloat(this.usedPct().toFixed(2)),
      usedFormatted:formatBytes(this.usedBytes()),
      freeFormatted:formatBytes(this.freeBytes()),
      capacityFormatted: formatBytes(this.usableBytes),
      categories:   this.getCategoryBreakdown(),
      volumes:      this.getVolumeList(),
      snapshots:    this.snapshots.size,
      encryption:   { ...this.encryption },
      health:       this.getHealthReport(),
      performance:  this.getPerformanceReport(),
      pendingOps:   this.pendingOperations,
      throughput: {
        readMBs:  parseFloat(this.currentReadMBs.toFixed(1)),
        writeMBs: parseFloat(this.currentWriteMBs.toFixed(1)),
      },
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      health:      this.getHealthReport(),
      volumes:     this.volumes.size,
      snapshots:   this.snapshots.size,
      appQuotas:   this.appQuotas.size,
    };
  }

  dump() {
    const s = this.getStats();
    const health = s.health;
    const lines = [
      `VStorage [${s.state}] — ${s.model}`,
      `  capacidad:   ${formatBytes(this.usableBytes)} usables (${formatBytes(this.totalBytes)} nominal)`,
      `  usado:       ${formatBytes(this.usedBytes())} (${this.usedPct().toFixed(1)}%)`,
      `  libre:       ${formatBytes(this.freeBytes())}`,
      `  cifrado:     ${this.encryption.algorithm} (${this.encryption.unlockState})`,
      `  salud:       ${health.healthPercent}% (wear ${health.wearPercent}%) — ${health.status}`,
      `  TBW:         ${health.tbwWritten} / ${health.tbwLimit} (${health.tbwPct}%)`,
      `  temperatura: ${health.temperatureC}°C  throttling=${health.thermalThrottle}`,
      `  volúmenes:`,
    ];
    for (const v of this.getVolumeList()) {
      lines.push(`    ${v.name.padEnd(10)} ${v.role.padEnd(9)} ${v.usedFormatted.padStart(12)} / ${v.quotaFormatted}`);
    }
    lines.push('  categorías:');
    for (const c of this.getCategoryBreakdown()) {
      lines.push(`    ${c.category.padEnd(12)} ${c.formatted.padStart(12)} (${c.percent}%)`);
    }
    lines.push(`  métricas: ops=${s.metrics.ioOperations} errors=${s.metrics.ioErrors}`);
    lines.push(`            read=${formatBytes(s.metrics.totalBytesRead)} write=${formatBytes(s.metrics.totalBytesWritten)}`);
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:       [...this.history.ts],
      readMBs:  [...this.history.readMBs],
      writeMBs: [...this.history.writeMBs],
      usedGB:   [...this.history.usedGB],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
