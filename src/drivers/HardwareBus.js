// src/drivers/HardwareBus.js
// Bus central de hardware — v2
// Importa, instancia y orquesta TODOS los drivers V* del sistema.
// Resuelve el grafo de dependencias, arranca el tick loop, gestiona IRQs,
// y expone snapshots/diagnósticos agregados.

import { Logger } from '../system/Logger.js';

// --- Drivers de cómputo / memoria ---
import { VCPU } from './VCPU.js';
import { VGPU } from './VGPU.js';

// --- Sensores ---
import { VAccelerometer } from './VAccelerometer.js';
import { VGyroscope } from './VGyroscope.js';
import { VMagnetometer } from './VMagnetometer.js';
import { VBarometer } from './VBarometer.js';
import { VAmbientLight } from './VAmbientLight.js';
import { VProximity } from './VProximity.js';
import { VGPS } from './VGPS.jsx';

// --- Audio ---
import { VMicrophone } from './VMicrophone.js';
import { VSpeaker } from './VSpeaker.js';
import { VTapticEngine } from './VTapticEngine.js';

// --- Imagen ---
import { VDisplay } from './VDisplay.js';
import { VTouch } from './VTouch.js';
import { VCamera } from './VCamera.js';

// --- Conectividad ---
import { VWiFi } from './VWiFi.js';
import { VBT } from './VBT.js';
import { VCellular } from './VCellular.js';

// --- Energía / almacenamiento / térmica ---
import { VBattery } from './VBattery.js';
import { VStorage } from './VStorage.js';
import { VThermal } from './VThermal.js';

const LOG_TAG = 'BUS';

/* ------------------------------------------------------------------ *
 * Modelo de dispositivo (referencia, se conserva de v1)
 * ------------------------------------------------------------------ */

export const DEVICE_MODEL = {
  name: 'iPhone 16 Pro',
  soc: 'Apple A18 Pro',
  cpu: { cores: 6, config: '2P + 4E', maxClockGHz: 4.05 },
  gpu: { cores: 6, family: 'Apple GPU Gen 6' },
  ane: { cores: 16, tops: 35 },
  ram: { sizeGB: 8, type: 'LPDDR5X' },
  storage: { sizeGB: 256, type: 'NVMe' },
  display: {
    sizeInches: 6.3,
    type: 'Super Retina XDR OLED',
    refreshHz: 120,
    resolution: '2622x1206',
  },
  cameras: ['48MP wide', '48MP ultrawide', '12MP tele 5x', '12MP front TrueDepth'],
  sensors: ['accel', 'gyro', 'mag', 'baro', 'als', 'prox', 'lidar'],
  radios: ['WiFi 7', 'BT 5.3', '5G NR', 'UWB', 'NFC'],
  security: ['Secure Enclave', 'Face ID', 'Touch ID (n/a)'],
  battery: { mAh: 3582, chemistry: 'Li-Ion' },
};

/* ------------------------------------------------------------------ *
 * IRQs conocidas
 * ------------------------------------------------------------------ */

export const KNOWN_IRQS = {
  IRQ_TIMER:      0,
  IRQ_CPU:        1,
  IRQ_GPU:        2,
  IRQ_DISPLAY:    3,
  IRQ_TOUCH:      4,
  IRQ_ALS:        5,
  IRQ_PROX:       6,
  IRQ_ACCEL:      7,
  IRQ_GYRO:       8,
  IRQ_MAG:        9,
  IRQ_BARO:       10,
  IRQ_MIC:        11,
  IRQ_SPK:        12,
  IRQ_TAPTIC:     13,
  IRQ_CAMERA:     14,
  IRQ_WIFI:       15,
  IRQ_BT:         16,
  IRQ_CELLULAR:   17,
  IRQ_GPS:        18,
  IRQ_STORAGE:    19,
  IRQ_BATTERY:    20,
  IRQ_THERMAL:    21,
  IRQ_SYSTEM:     22,
};

/* ------------------------------------------------------------------ *
 * Orden de arranque (por dependencias)
 * ------------------------------------------------------------------ */

// Cada entrada: { id, factory, deps: [ids de drivers previos] }
const BOOT_ORDER = [
  // 1) Térmico primero (todos lo consultan)
  { id: 'thermal',   factory: (bus) => new VThermal(bus) },
  // 2) Energía + almacenamiento
  { id: 'battery',   factory: (bus) => new VBattery(bus) },
  { id: 'storage',   factory: (bus) => new VStorage(bus) },
  // 3) Cómputo
  { id: 'cpu',       factory: (bus) => new VCPU(bus) },
  { id: 'gpu',       factory: (bus) => new VGPU(bus) },
  // 4) Pantalla + entrada
  { id: 'display',   factory: (bus) => new VDisplay(bus) },
  { id: 'touch',     factory: (bus) => new VTouch(bus) },
  { id: 'taptic',    factory: (bus) => new VTapticEngine(bus) },
  // 5) Sensores ambientales
  { id: 'als',       factory: (bus) => new VAmbientLight(bus) },
  { id: 'prox',      factory: (bus) => new VProximity(bus) },
  { id: 'accel',     factory: (bus) => new VAccelerometer(bus) },
  { id: 'gyro',      factory: (bus) => new VGyroscope(bus) },
  { id: 'mag',       factory: (bus) => new VMagnetometer(bus) },
  { id: 'baro',      factory: (bus) => new VBarometer(bus) },
  { id: 'gps',       factory: (bus) => new VGPS(bus) },
  // 6) Audio
  { id: 'mic',       factory: (bus) => new VMicrophone(bus) },
  { id: 'speaker',   factory: (bus) => new VSpeaker(bus) },
  // 7) Cámara
  { id: 'camera',    factory: (bus) => new VCamera(bus) },
  // 8) Radios
  { id: 'wifi',      factory: (bus) => new VWiFi(bus) },
  { id: 'bt',        factory: (bus) => new VBT(bus) },
  { id: 'cellular',  factory: (bus) => new VCellular(bus) },
];

/* ------------------------------------------------------------------ *
 * Grafo de vinculaciones (se aplican tras instanciar)
 * ------------------------------------------------------------------ */

const LINK_GRAPH = [
  // Thermal ↔ subsistemas consumidores
  { from: 'thermal', to: 'cpu',      method: 'linkCPU' },
  { from: 'thermal', to: 'gpu',      method: 'linkGPU' },
  { from: 'thermal', to: 'storage',  method: 'linkStorage' },
  { from: 'thermal', to: 'battery',  method: 'linkBattery' },
  { from: 'thermal', to: 'wifi',     method: 'linkWiFi' },
  { from: 'thermal', to: 'bt',       method: 'linkBT' },
  { from: 'thermal', to: 'cellular', method: 'linkCellular' },
  { from: 'thermal', to: 'display',  method: 'linkDisplay' },

  // Proximity ↔ pantalla / táctil / celular / ALS
  { from: 'prox', to: 'display',  method: 'linkDisplay' },
  { from: 'prox', to: 'touch',    method: 'linkTouch' },
  { from: 'prox', to: 'cellular', method: 'linkCellular' },
  { from: 'prox', to: 'als',      method: 'linkAmbientLight' },

  // Micrófono ↔ speaker / cámara / celular
  { from: 'mic', to: 'speaker',  method: 'linkSpeaker' },
  { from: 'mic', to: 'camera',   method: 'linkCamera' },
  { from: 'mic', to: 'cellular', method: 'linkCellular' },

  // Speaker ↔ taptic / mic / bt / celular
  { from: 'speaker', to: 'taptic',   method: 'linkTaptic' },
  { from: 'speaker', to: 'mic',      method: 'linkMicrophone' },
  { from: 'speaker', to: 'bt',       method: 'linkBluetooth' },
  { from: 'speaker', to: 'cellular', method: 'linkCellular' },

  // Acelerómetro ↔ giroscopio (fusión de actitud)
  { from: 'gyro', to: 'accel', method: 'linkAccelerometer' },

  // GPS ↔ magnetómetro (declinación) y barómetro (altitud)
  { from: 'mag',  to: 'gps',  method: 'linkGPS' },
  { from: 'baro', to: 'gps',  method: 'linkGPS' },

  // Cámara ↔ display (preview) y gpu (procesado)
  { from: 'camera', to: 'display', method: 'linkDisplay' },
  { from: 'camera', to: 'gpu',     method: 'linkGPU' },

  // WiFi ↔ BT ↔ Cellular (coexistencia)
  { from: 'wifi', to: 'bt',       method: 'linkBT' },
  { from: 'bt',   to: 'wifi',     method: 'linkWiFi' },
  { from: 'wifi', to: 'cellular', method: 'linkCellular' },
];

/* ------------------------------------------------------------------ *
 * Estado del bus
 * ------------------------------------------------------------------ */

const BUS_STATE = {
  OFF:      'off',
  BOOTING:  'booting',
  RUNNING:  'running',
  PANIC:    'panic',
  SHUTDOWN: 'shutdown',
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nowMs() { return performance.now ? performance.now() : Date.now(); }
function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }

/* ------------------------------------------------------------------ *
 * Cola de IRQ con prioridades
 * ------------------------------------------------------------------ */

const IRQ_PRIORITIES = {
  [KNOWN_IRQS.IRQ_THERMAL]:  0,   // máxima
  [KNOWN_IRQS.IRQ_TIMER]:    1,
  [KNOWN_IRQS.IRQ_BATTERY]:  2,
  [KNOWN_IRQS.IRQ_TOUCH]:    3,
  [KNOWN_IRQS.IRQ_DISPLAY]:  4,
  [KNOWN_IRQS.IRQ_CPU]:      5,
  [KNOWN_IRQS.IRQ_GPU]:      5,
  [KNOWN_IRQS.IRQ_SYSTEM]:   6,
  // resto por defecto = 10
};

class IRQQueue {
  constructor(maxSize = 128) {
    this.max = maxSize;
    this.items = [];
    this.dropped = 0;
    this.delivered = 0;
    this._seq = 0;
  }

  push(irq, payload) {
    if (this.items.length >= this.max) {
      this.dropped++;
      return false;
    }
    const priority = IRQ_PRIORITIES[irq] ?? 10;
    this.items.push({ irq, payload, priority, seq: this._seq++, t: nowMs() });
    // Orden estable por prioridad y luego FIFO
    this.items.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return true;
  }

  drain(max = 32) {
    const out = this.items.splice(0, max);
    this.delivered += out.length;
    return out;
  }

  size() { return this.items.length; }
  clear() { this.items = []; }
}

/* ------------------------------------------------------------------ *
 * DeviceRegistry
 * ------------------------------------------------------------------ */

class DeviceRegistry {
  constructor() {
    this.devices = new Map();
  }

  register(device) {
    if (!device || !device.id) return false;
    if (this.devices.has(device.id)) {
      Logger.warn(LOG_TAG, `Dispositivo duplicado: ${device.id}`);
      return false;
    }
    this.devices.set(device.id, { ...device, registeredAt: nowMs() });
    return true;
  }

  unregister(id) {
    return this.devices.delete(id);
  }

  get(id) { return this.devices.get(id); }
  list() { return [...this.devices.values()]; }

  findByKind(kind) {
    return this.list().filter(d => d.kind === kind);
  }

  findByCapability(cap) {
    return this.list().filter(d => (d.capabilities || []).includes(cap));
  }

  count() { return this.devices.size; }
}

/* ------------------------------------------------------------------ *
 * Clase principal del bus
 * ------------------------------------------------------------------ */

export class HardwareBus {
  constructor(options = {}) {
    this.state = BUS_STATE.OFF;
    this.registry = new DeviceRegistry();
    this.irqQueue = new IRQQueue(options.irqQueueSize || 128);

    // Instancias de drivers (id → instancia)
    this.drivers = {};

    // Orden efectivo de boot
    this.bootOrder = BOOT_ORDER.map(e => e.id);

    // Handlers de IRQ registrados por drivers / kernel
    this.irqHandlers = new Map(); // irq → Set<fn>

    // Suscriptores globales (eventos del bus)
    this.subscribers = new Set();

    // Tick loop
    this._tickHandle = null;
    this._tickIntervalMs = options.tickIntervalMs || 16.67; // ~60Hz
    this._lastTickAt = nowMs();
    this._tickCount = 0;

    // Estado de arranque
    this._bootStartedAt = 0;
    this._bootFinishedAt = 0;
    this._bootErrors = [];

    // Hot-plug
    this.hotPlugEnabled = options.hotPlugEnabled !== false;

    // Métricas
    this.stats = {
      boots: 0,
      shutdowns: 0,
      ticks: 0,
      irqsPushed: 0,
      irqsDelivered: 0,
      linkErrors: 0,
      bootErrors: 0,
      uptimeMs: 0,
    };

    Logger.debug(LOG_TAG, 'HardwareBus v2 instanciado');
  }

  /* ================================================================ *
   * Arranque
   * ================================================================ */

  boot() {
    if (this.state === BUS_STATE.RUNNING) {
      Logger.warn(LOG_TAG, 'Bus ya en RUNNING, ignorando boot');
      return this.getBootReport();
    }
    this.state = BUS_STATE.BOOTING;
    this._bootStartedAt = nowMs();
    this.stats.boots++;

    Logger.kernel(LOG_TAG, '════════ HardwareBus boot ════════');
    Logger.kernel(LOG_TAG, `Modelo: ${DEVICE_MODEL.name} (${DEVICE_MODEL.soc})`);
    Logger.kernel(LOG_TAG, `Drivers a instanciar: ${this.bootOrder.length}`);

    // 1) Instanciar drivers en orden
    for (const entry of BOOT_ORDER) {
      const t0 = nowMs();
      try {
        const inst = entry.factory(this);
        if (!inst) throw new Error('factory returned null');
        this.drivers[entry.id] = inst;
        const dt = nowMs() - t0;
        Logger.kernel(LOG_TAG, `  ✓ ${entry.id.padEnd(9)} instanciado (${round(dt, 2)}ms)`);
      } catch (e) {
        this._bootErrors.push({ id: entry.id, error: e.message });
        this.stats.bootErrors++;
        Logger.error(LOG_TAG, `  ✗ ${entry.id} fallo: ${e.message}`);
      }
    }

    // 2) Resolver vinculaciones
    this._applyLinkGraph();

    // 3) Registrar IRQ handlers por defecto
    this._registerDefaultIRQHandlers();

    // 4) Power-on de cada driver (si tiene el método)
    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      if (d && typeof d.powerOn === 'function') {
        try { d.powerOn(); }
        catch (e) { Logger.warn(LOG_TAG, `powerOn(${id}) falló: ${e.message}`); }
      }
    }

    // 5) Arrancar tick loop
    this._startTickLoop();

    this._bootFinishedAt = nowMs();
    this.state = BUS_STATE.RUNNING;
    Logger.kernel(LOG_TAG, `════════ Boot completo en ${round(this._bootFinishedAt - this._bootStartedAt, 1)}ms ════════`);
    this._emit('boot', this.getBootReport());
    return this.getBootReport();
  }

  shutdown() {
    if (this.state === BUS_STATE.SHUTDOWN) return;
    Logger.kernel(LOG_TAG, 'HardwareBus shutdown iniciado');
    this._stopTickLoop();
    for (const id of [...this.bootOrder].reverse()) {
      const d = this.drivers[id];
      if (d && typeof d.powerOff === 'function') {
        try { d.powerOff(); }
        catch (e) { Logger.warn(LOG_TAG, `powerOff(${id}) falló: ${e.message}`); }
      }
    }
    this.state = BUS_STATE.SHUTDOWN;
    this.stats.shutdowns++;
    Logger.kernel(LOG_TAG, 'HardwareBus apagado');
    this._emit('shutdown', {});
  }

  panic(reason = 'unknown') {
    Logger.fatal?.(LOG_TAG, `PANIC: ${reason}`);
    this.state = BUS_STATE.PANIC;
    this._stopTickLoop();
    this._emit('panic', { reason });
  }

  /* ================================================================ *
   * Vinculaciones
   * ================================================================ */

  _applyLinkGraph() {
    let applied = 0;
    for (const link of LINK_GRAPH) {
      const from = this.drivers[link.from];
      const to = this.drivers[link.to];
      if (!from || !to) {
        Logger.debug(LOG_TAG, `Link saltado ${link.from}→${link.to} (driver ausente)`);
        continue;
      }
      if (typeof from[link.method] !== 'function') {
        this.stats.linkErrors++;
        Logger.warn(LOG_TAG, `Link ${link.from}.${link.method} no existe`);
        continue;
      }
      try {
        from[link.method](to);
        applied++;
      } catch (e) {
        this.stats.linkErrors++;
        Logger.warn(LOG_TAG, `Link ${link.from}→${link.to} falló: ${e.message}`);
      }
    }
    Logger.kernel(LOG_TAG, `Vinculaciones aplicadas: ${applied}/${LINK_GRAPH.length}`);
  }

  /* ================================================================ *
   * IRQ handlers
   * ================================================================ */

  _registerDefaultIRQHandlers() {
    // El bus mismo consume IRQs de thermal y battery para log
    this.onIRQ(KNOWN_IRQS.IRQ_THERMAL, (payload) => {
      if (payload?.kind === 'shutdown') this.panic(`thermal shutdown @ ${payload.tempC}°C`);
    });
  }

  onIRQ(irq, fn) {
    if (!this.irqHandlers.has(irq)) this.irqHandlers.set(irq, new Set());
    this.irqHandlers.get(irq).add(fn);
    return () => this.irqHandlers.get(irq)?.delete(fn);
  }

  offIRQ(irq, fn) {
    this.irqHandlers.get(irq)?.delete(fn);
  }

  raiseIRQ(irq, payload) {
    this.stats.irqsPushed++;
    return this.irqQueue.push(irq, payload);
  }

  _dispatchIRQs() {
    const items = this.irqQueue.drain(32);
    for (const it of items) {
      this.stats.irqsDelivered++;
      const handlers = this.irqHandlers.get(it.irq);
      if (handlers) {
        for (const fn of handlers) {
          try { fn(it.payload, it); }
          catch (e) { Logger.error(LOG_TAG, `IRQ handler error (${it.irq}): ${e.message}`); }
        }
      }
      this._emit('irq', it);
    }
  }

  /* ================================================================ *
   * Tick loop
   * ================================================================ */

  _startTickLoop() {
    if (this._tickHandle) return;
    this._lastTickAt = nowMs();
    const tick = () => {
      if (this.state !== BUS_STATE.RUNNING) return;
      const now = nowMs();
      const dt = now - this._lastTickAt;
      this._lastTickAt = now;
      this._tickAll(dt);
      this._tickHandle = setTimeout(tick, this._tickIntervalMs);
    };
    this._tickHandle = setTimeout(tick, this._tickIntervalMs);
    Logger.debug(LOG_TAG, `Tick loop arrancado (${this._tickIntervalMs}ms)`);
  }

  _stopTickLoop() {
    if (this._tickHandle) {
      clearTimeout(this._tickHandle);
      this._tickHandle = null;
      Logger.debug(LOG_TAG, 'Tick loop detenido');
    }
  }

  _tickAll(dtMs) {
    const t0 = nowMs();
    this._tickCount++;
    this.stats.ticks++;
    this.stats.uptimeMs += dtMs;

    // Tick cada driver (orden de boot)
    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      if (d && typeof d.tick === 'function') {
        try { d.tick(dtMs); }
        catch (e) { Logger.error(LOG_TAG, `tick(${id}) error: ${e.message}`); }
      }
    }

    // Drenar IRQs
    this._dispatchIRQs();

    // Emitir tick global
    const elapsed = nowMs() - t0;
    this._emit('tick', { dtMs: round(dtMs, 2), elapsedMs: round(elapsed, 2) });
  }

  /* Útil para tests / demos: forzar N ticks sin timer real */
  tickN(n = 1, dtMs = 16.67) {
    for (let i = 0; i < n; i++) this._tickAll(dtMs);
    return this.stats.ticks;
  }

  /* ================================================================ *
   * Registro de dispositivos (API para drivers)
   * ================================================================ */

  registerDevice(device) {
    const ok = this.registry.register(device);
    if (ok) this._emit('device:registered', device);
    return ok;
  }

  unregisterDevice(id) {
    const ok = this.registry.unregister(id);
    if (ok) this._emit('device:unregistered', { id });
    return ok;
  }

  /* ================================================================ *
   * Hot-plug
   * ================================================================ */

  hotPlug(id, factory) {
    if (!this.hotPlugEnabled) {
      Logger.warn(LOG_TAG, 'Hot-plug deshabilitado');
      return false;
    }
    if (this.drivers[id]) {
      Logger.warn(LOG_TAG, `Driver ${id} ya existe`);
      return false;
    }
    try {
      const inst = factory(this);
      this.drivers[id] = inst;
      this.bootOrder.push(id);
      if (typeof inst.powerOn === 'function') inst.powerOn();
      Logger.info(LOG_TAG, `Hot-plug: ${id} añadido`);
      this._emit('hotplug', { id });
      return true;
    } catch (e) {
      Logger.error(LOG_TAG, `Hot-plug ${id} falló: ${e.message}`);
      return false;
    }
  }

  hotUnplug(id) {
    const d = this.drivers[id];
    if (!d) return false;
    try {
      if (typeof d.powerOff === 'function') d.powerOff();
      delete this.drivers[id];
      this.bootOrder = this.bootOrder.filter(x => x !== id);
      Logger.info(LOG_TAG, `Hot-unplug: ${id} eliminado`);
      this._emit('hotunplug', { id });
      return true;
    } catch (e) {
      Logger.error(LOG_TAG, `Hot-unplug ${id} falló: ${e.message}`);
      return false;
    }
  }

  /* ================================================================ *
   * Acceso a drivers
   * ================================================================ */

  get(id) { return this.drivers[id]; }

  getCPU()       { return this.drivers.cpu; }
  getGPU()       { return this.drivers.gpu; }
  getThermal()   { return this.drivers.thermal; }
  getDisplay()   { return this.drivers.display; }
  getTouch()     { return this.drivers.touch; }
  getBattery()   { return this.drivers.battery; }
  getStorage()   { return this.drivers.storage; }
  getWiFi()      { return this.drivers.wifi; }
  getBT()        { return this.drivers.bt; }
  getCellular()  { return this.drivers.cellular; }
  getGPS()       { return this.drivers.gps; }
  getALS()       { return this.drivers.als; }
  getProx()      { return this.drivers.prox; }
  getMic()       { return this.drivers.mic; }
  getSpeaker()   { return this.drivers.speaker; }
  getCamera()    { return this.drivers.camera; }
  getTaptic()    { return this.drivers.taptic; }
  getAccel()     { return this.drivers.accel; }
  getGyro()      { return this.drivers.gyro; }
  getMag()       { return this.drivers.mag; }
  getBaro()      { return this.drivers.baro; }

  /* ================================================================ *
   * Suscriptores
   * ================================================================ */

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event, payload) {
    this._emit(event, payload);
  }

  _emit(type, payload) {
    for (const fn of this.subscribers) {
      try { fn({ type, payload, ts: nowMs() }); }
      catch (e) { Logger.error(LOG_TAG, `Subscriber error: ${e.message}`); }
    }
  }

  /* ================================================================ *
   * Snapshots / diagnósticos
   * ================================================================ */

  getBootReport() {
    return {
      state: this.state,
      drivers: this.bootOrder.length,
      bootErrors: this._bootErrors.length,
      linkErrors: this.stats.linkErrors,
      registered: this.registry.count(),
      durationMs: round((this._bootFinishedAt || nowMs()) - this._bootStartedAt, 2),
      errors: [...this._bootErrors],
    };
  }

  getSnapshot() {
    const snap = {
      state: this.state,
      ticks: this.stats.ticks,
      uptimeMs: round(this.stats.uptimeMs, 0),
      devices: this.registry.count(),
      irqs: {
        pending: this.irqQueue.size(),
        pushed: this.stats.irqsPushed,
        delivered: this.stats.irqsDelivered,
        dropped: this.irqQueue.dropped,
      },
      drivers: {},
    };
    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      if (!d) continue;
      if (typeof d.getStats === 'function') {
        try { snap.drivers[id] = d.getStats(); }
        catch (e) { snap.drivers[id] = { error: e.message }; }
      } else {
        snap.drivers[id] = { present: true };
      }
    }
    return snap;
  }

  getGlobalStats() {
    return {
      ...this.stats,
      state: this.state,
      ticksPerSec: this.stats.uptimeMs > 0
        ? round(this.stats.ticks / (this.stats.uptimeMs / 1000), 1)
        : 0,
      devices: this.registry.count(),
      irqPending: this.irqQueue.size(),
    };
  }

  /* ================================================================ *
   * Diagnóstico de arranque
   * ================================================================ */

  runDiagnostics() {
    Logger.kernel(LOG_TAG, '════════ Diagnostics ════════');
    const report = {
      drivers: [],
      missing: [],
      degraded: [],
      failed: [],
    };

    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      if (!d) {
        report.missing.push(id);
        continue;
      }
      const s = typeof d.getStats === 'function' ? d.getStats() : {};
      const powerOk = s.powered !== false;
      const health = s.health || (powerOk ? 'ok' : 'fault');
      report.drivers.push({ id, health, powered: s.powered });
      if (health !== 'ok' && health !== undefined) {
        if (health === 'fault' || health === 'dead') report.failed.push(id);
        else report.degraded.push(id);
      }
    }

    Logger.kernel(LOG_TAG, `Drivers OK:      ${report.drivers.length - report.failed.length}`);
    Logger.kernel(LOG_TAG, `Drivers ausentes: ${report.missing.length}`);
    Logger.kernel(LOG_TAG, `Degradados:      ${report.degraded.length}`);
    Logger.kernel(LOG_TAG, `Fallidos:        ${report.failed.length}`);
    return report;
  }

  dump() {
    const s = this.getGlobalStats();
    Logger.kernel(LOG_TAG, '─── HardwareBus v2 dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${s.state}`);
    Logger.kernel(LOG_TAG, `  boots        : ${s.boots}`);
    Logger.kernel(LOG_TAG, `  ticks        : ${s.ticks} (${s.ticksPerSec}/s)`);
    Logger.kernel(LOG_TAG, `  uptime       : ${round(s.uptimeMs / 1000, 1)}s`);
    Logger.kernel(LOG_TAG, `  dispositivos : ${s.devices}`);
    Logger.kernel(LOG_TAG, `  IRQ (pushed/deliv/drop/pend): ${s.irqsPushed}/${s.irqsDelivered}/${this.irqQueue.dropped}/${this.irqQueue.size()}`);
    Logger.kernel(LOG_TAG, `  link errors  : ${s.linkErrors}`);
    Logger.kernel(LOG_TAG, `  boot errors  : ${s.bootErrors}`);
    Logger.kernel(LOG_TAG, '  drivers:');
    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      const ok = d ? '✓' : '✗';
      const name = d ? (d.constructor.name || 'Driver') : 'MISSING';
      Logger.kernel(LOG_TAG, `    ${ok} ${id.padEnd(9)} ${name}`);
    }
  }

  /* ================================================================ *
   * Serialización
   * ================================================================ */

  serialize() {
    const out = { drivers: {} };
    for (const id of this.bootOrder) {
      const d = this.drivers[id];
      if (d && typeof d.serialize === 'function') {
        try { out.drivers[id] = d.serialize(); }
        catch (e) { out.drivers[id] = { error: e.message }; }
      }
    }
    out.state = this.state;
    out.stats = { ...this.stats };
    return out;
  }

  deserialize(data) {
    if (!data || !data.drivers) return;
    for (const [id, drvData] of Object.entries(data.drivers)) {
      const d = this.drivers[id];
      if (d && typeof d.deserialize === 'function') {
        try { d.deserialize(drvData); }
        catch (e) { Logger.warn(LOG_TAG, `deserialize(${id}) falló: ${e.message}`); }
      }
    }
    Logger.info(LOG_TAG, 'Estado del bus restaurado');
  }
}

export { BUS_STATE, BOOT_ORDER, LINK_GRAPH };

export default HardwareBus;
