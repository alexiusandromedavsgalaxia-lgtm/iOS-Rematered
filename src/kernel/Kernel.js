// src/kernel/Kernel.js
import { logger } from '../system/Logger.js';
import { MemoryManager } from './MemoryManager.js';
import { Scheduler } from './Scheduler.js';
import { ProcessManager } from './ProcessManager.js';
import { Syscalls } from './Syscalls.js';

export const KernelState = {
  OFF: 'OFF', BOOTING: 'BOOTING', RUNNING: 'RUNNING', SUSPENDED: 'SUSPENDED', SHUTDOWN: 'SHUTDOWN', PANIC: 'PANIC',
};

const BOOT_STEPS = [
  { id: 'logger', label: 'Inicializando subsistema de logging' },
  { id: 'memory', label: 'Configurando MemoryManager' },
  { id: 'hardware', label: 'Sondeando bus de hardware' },
  { id: 'drivers', label: 'Cargando drivers de dispositivo' },
  { id: 'scheduler', label: 'Arrancando scheduler' },
  { id: 'syscalls', label: 'Registrando tabla de syscalls' },
  { id: 'processes', label: 'Arrancando ProcessManager' },
  { id: 'launchd', label: 'Lanzando launchd (PID 1)' },
  { id: 'springboard', label: 'Arrancando SpringBoard' },
  { id: 'backboardd', label: 'Arrancando backboardd' },
  { id: 'ready', label: 'Sistema listo' },
];

export class Kernel {
  constructor(options = {}) {
    this.bootTs = Date.now();
    this.state = KernelState.OFF;
    this.version = options.version ?? '1.0.0';
    this.build = options.build ?? 'iOSR-2025.11';
    this.arch = options.arch ?? 'arm64-sim';

    this.memory = options.memory instanceof MemoryManager
      ? options.memory
      : new MemoryManager(options.memoryBytes);
    this.scheduler = new Scheduler();
    this.syscalls = new Syscalls(this);
    this.processes = new ProcessManager(this);
    this.hardware = null;

    this.bootSubscribers = new Set();
    this.stateSubscribers = new Set();
    this.stats = { bootDurationMs: 0, bootAttempts: 0, panics: 0, shutdowns: 0, lastBootStep: null };
    this._booting = false;
    this._shutdownInProgress = false;
    this._pendingPanic = null;

    logger.onFatal((entry) => {
      if (this.state === KernelState.RUNNING || this.state === KernelState.BOOTING) this._pendingPanic = entry;
    });

    logger.kernel('KERNEL', '═══════════════════════════════════════════════════');
    logger.kernel('KERNEL', ` iOS Remastered Kernel v${this.version} (${this.build})`);
    logger.kernel('KERNEL', ` arch=${this.arch} mem=${this.memory.total / 1024 / 1024}MB`);
    logger.kernel('KERNEL', '═══════════════════════════════════════════════════');
  }

  async boot(hardwareBus, opts = {}) {
    if (this._booting || this.state === KernelState.RUNNING) {
      logger.warn('KERNEL', this._booting ? 'boot() llamado mientras ya se estaba arrancando' : 'boot() llamado pero ya está RUNNING');
      return false;
    }
    this._booting = true;
    this.stats.bootAttempts += 1;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._setState(KernelState.BOOTING);

    try {
      for (const step of BOOT_STEPS) {
        this._emitBootStep(step, 'start');
        logger.kernel('KERNEL', `▶ ${step.label}`);
        await this._runBootStep(step.id, hardwareBus);
        this.stats.lastBootStep = step.id;
        this._emitBootStep(step, 'done');
        const delay = Math.max(0, opts.stepDelayMs ?? 100);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.stats.bootDurationMs = now - t0;
      this._setState(KernelState.RUNNING);
      logger.kernel('KERNEL', `✓ Boot completo en ${this.stats.bootDurationMs.toFixed(0)}ms`);
      return true;
    } catch (err) {
      logger.fatal('KERNEL', `Boot falló: ${err?.message || err}`, err);
      this.panic(`Fallo durante boot: ${err?.message || err}`, err);
      return false;
    } finally {
      this._booting = false;
    }
  }

  async _runBootStep(stepId, hardwareBus) {
    switch (stepId) {
      case 'logger':
        if (!logger) throw new Error('logger no disponible');
        break;
      case 'memory':
        if (!this.memory || typeof this.memory.allocate !== 'function') throw new Error('MemoryManager inválido');
        break;
      case 'hardware':
        if (!hardwareBus) throw new Error('HardwareBus no inyectado');
        this.hardware = hardwareBus;
        this.hardware.attachKernel?.(this);
        logger.info('KERNEL', 'HardwareBus enlazado');
        break;
      case 'drivers':
        if (!this.hardware?.init) throw new Error('HardwareBus inválido');
        await this.hardware.init();
        logger.info('KERNEL', `Drivers cargados: ${Object.keys(this.hardware.devices || {}).join(', ')}`);
        break;
      case 'scheduler': this.scheduler.start(); break;
      case 'syscalls': this._registerDefaultIRQHandlers(); break;
      case 'processes': break;
      case 'launchd': this.processes.spawnSystemProcess('launchd', 20); break;
      case 'springboard': this.processes.spawnSystemProcess('SpringBoard', 15); break;
      case 'backboardd': this.processes.spawnSystemProcess('backboardd', 12); break;
      case 'ready': break;
      default: logger.warn('KERNEL', `Boot step desconocido: ${stepId}`);
    }
  }

  _registerDefaultIRQHandlers() {
    if (!this.hardware) return;
    this.syscalls.onIRQ('IRQ_DISPLAY', (payload) => logger.debug('KERNEL', `IRQ_DISPLAY: ${JSON.stringify(payload)}`));
    this.syscalls.onIRQ('IRQ_BATTERY', (payload) => logger.debug('KERNEL', `IRQ_BATTERY: ${(Number(payload?.level || 0) * 100).toFixed(0)}% charging=${Boolean(payload?.charging)}`));
    this.syscalls.onIRQ('IRQ_HAPTIC', (payload) => logger.debug('KERNEL', `IRQ_HAPTIC: ${payload?.style || 'unknown'}`));
  }

  async shutdown(reason = 'user-request') {
    if (this._shutdownInProgress) return;
    this._shutdownInProgress = true;
    this._setState(KernelState.SHUTDOWN);
    try {
      await this._safeAsync('matar procesos', () => this.processes.killAll());
      await this._safeAsync('detener scheduler', () => this.scheduler.stop());
      await this._safeAsync('detener drivers', () => this.hardware?.shutdown?.());
      await this._safeAsync('liberar memoria', () => logger.info('KERNEL', `Memoria: used=${(this.memory.getStats().used / 1024 / 1024).toFixed(0)}MB`));
      this.stats.shutdowns += 1;
      this._setState(KernelState.OFF);
      logger.kernel('KERNEL', `Shutdown completo (${reason})`);
    } finally {
      this._shutdownInProgress = false;
    }
  }

  async _safeAsync(label, fn) {
    try { const result = fn(); if (result?.then) await result; }
    catch (err) { logger.error('KERNEL', `Fallo en shutdown step "${label}": ${err?.message || err}`, err); }
  }

  panic(reason, error = null) {
    this.stats.panics += 1;
    this.state = KernelState.PANIC;
    this._emitStateChange();
    logger.error('KERNEL', '☠ KERNEL PANIC');
    logger.error('KERNEL', `razón: ${reason}`);
    if (error) logger.error('KERNEL', `error: ${error.message || error}`);
    try { this.scheduler.stop(); } catch (_) {}
    try { this.processes.killAll(); } catch (_) {}
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    this._emitStateChange();
  }

  _emitStateChange() {
    const info = { state: this.state, uptime: this.uptime(), version: this.version };
    for (const fn of this.stateSubscribers) { try { fn(info); } catch (_) {} }
  }

  _emitBootStep(step, phase) {
    const payload = { step, phase, ts: Date.now() };
    for (const fn of this.bootSubscribers) { try { fn(payload); } catch (_) {} }
  }

  onBootStep(fn) { this.bootSubscribers.add(fn); return () => this.bootSubscribers.delete(fn); }
  onStateChange(fn) { this.stateSubscribers.add(fn); return () => this.stateSubscribers.delete(fn); }
  uptime() { return Date.now() - this.bootTs; }
  isRunning() { return this.state === KernelState.RUNNING; }
  isPanicked() { return this.state === KernelState.PANIC; }

  getStats() {
    return {
      version: this.version, build: this.build, arch: this.arch, state: this.state,
      uptime: this.uptime(), bootTs: this.bootTs, memory: this.memory.getStats(),
      scheduler: this.scheduler.getStats(), processes: this.processes.getStats(),
      stats: { ...this.stats }, logger: logger.getStats(),
    };
  }

  syscall(name, ...args) { return this.syscalls.invoke(name, ...args); }
  ps() { return this.processes.getStats().list; }
  mem() { return this.memory.getStats(); }
}

export const kernel = new Kernel();
