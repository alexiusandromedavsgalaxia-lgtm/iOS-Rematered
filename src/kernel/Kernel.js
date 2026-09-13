// src/kernel/Kernel.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — Kernel
 * ═══════════════════════════════════════════════════════════════
 *
 * El Kernel es el orquestador central del OS. Su responsabilidad:
 *
 *   1. Secuenciar el arranque (boot) por fases bien definidas.
 *   2. Instanciar y conectar los subsistemas:
 *        - MemoryManager  (memoria)
 *        - Scheduler      (planificación temporal)
 *        - ProcessManager (procesos)
 *        - Syscalls       (API de llamadas al sistema)
 *        - HardwareBus    (drivers)  → inyectado al boot
 *   3. Exponer estado de sistema (uptime, stats, phase).
 *   4. Ejecutar el shutdown ordenado (fase reversa del boot).
 *   5. Capturar panic cuando algo irrecuperable ocurre.
 *
 *  El Kernel NO conoce la UI. La UI se suscribe al Kernel mediante
 *  callbacks y al Logger mediante subscribe().
 * ═══════════════════════════════════════════════════════════════
 */

import { logger, LogLevel } from '../system/Logger.js';
import { Scheduler } from './Scheduler.js';
import { ProcessManager } from './ProcessManager.js';
import { Syscalls } from './Syscalls.js';

// Fases del ciclo de vida del Kernel
export const KernelState = {
  OFF:       'OFF',
  BOOTING:   'BOOTING',
  RUNNING:   'RUNNING',
  SUSPENDED: 'SUSPENDED',
  SHUTDOWN:  'SHUTDOWN',
  PANIC:     'PANIC',
};

// Pasos del boot — cada uno se loguea y se puede ralentizar para que
// la BootScreen muestre progreso visual. El orden importa.
const BOOT_STEPS = [
  { id: 'logger',      label: 'Inicializando subsistema de logging' },
  { id: 'hardware',    label: 'Sondeando bus de hardware' },
  { id: 'drivers',     label: 'Cargando drivers de dispositivo' },
  { id: 'scheduler',   label: 'Arrancando scheduler' },
  { id: 'syscalls',    label: 'Registrando tabla de syscalls' },
  { id: 'processes',   label: 'Arrancando ProcessManager' },
  { id: 'launchd',     label: 'Lanzando launchd (PID 1)' },
  { id: 'springboard', label: 'Arrancando SpringBoard' },
  { id: 'backboardd',  label: 'Arrancando backboardd' },
  { id: 'ready',       label: 'Sistema listo' },
];

export class Kernel {
  constructor(options = {}) {
    this.bootTs     = Date.now();
    this.state      = KernelState.OFF;
    this.version    = options.version ?? '1.0.0';
    this.build      = options.build   ?? 'iOSR-2025.11';
    this.arch       = options.arch    ?? 'arm64-sim';

    // Subsistemas — se instancian ya, pero algunos se "activan" en boot
    this.scheduler  = new Scheduler();
    this.syscalls   = new Syscalls(this);
    this.processes  = new ProcessManager(this);

    // Inyectado externamente en boot()
    this.hardware   = null;

    // Callbacks de suscriptores (UI, tests, etc.)
    this.bootSubscribers = new Set();
    this.stateSubscribers = new Set();

    // Métricas
    this.stats = {
      bootDurationMs:  0,
      bootAttempts:    0,
      panics:          0,
      shutdowns:       0,
      lastBootStep:    null,
    };

    // Guard anti re-entrada
    this._booting = false;
    this._shutdownInProgress = false;

    // Registramos handler de fatal → panic automático
    logger.onFatal((entry) => {
      if (this.state === KernelState.RUNNING || this.state === KernelState.BOOTING) {
        // No llamamos a panic() directamente aquí para evitar recursión
        // si el panic mismo loguea FATAL. Se marca intención.
        this._pendingPanic = entry;
      }
    });

    logger.kernel('KERNEL', '═══════════════════════════════════════════════════');
    logger.kernel('KERNEL', ` iOS Remastered Kernel v${this.version} (${this.build})`);
    logger.kernel('KERNEL', ` arch=${this.arch}  mem=${this.memory.total / 1024 / 1024}MB`);
    logger.kernel('KERNEL', '═══════════════════════════════════════════════════');
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════

  /**
   * Ejecuta la secuencia de arranque.
   * @param {object} hardwareBus   Instancia de HardwareBus (ya construida)
   * @param {object} opts          { stepDelayMs, onStep }
   */
  async boot(hardwareBus, opts = {}) {
    if (this._booting) {
      logger.warn('KERNEL', 'boot() llamado mientras ya se estaba arrancando');
      return false;
    }
    if (this.state === KernelState.RUNNING) {
      logger.warn('KERNEL', 'boot() llamado pero ya está RUNNING');
      return false;
    }

    this._booting = true;
    this.stats.bootAttempts++;
    const t0 = performance.now();

    this._setState(KernelState.BOOTING);
    logger.kernel('KERNEL', `Arrancando... (intento #${this.stats.bootAttempts})`);

    const stepDelay = opts.stepDelayMs ?? 100;

    try {
      for (const step of BOOT_STEPS) {
        this._emitBootStep(step, 'start');
        logger.kernel('KERNEL', `▶ ${step.label}`);

        await this._runBootStep(step.id, hardwareBus);

        this.stats.lastBootStep = step.id;
        this._emitBootStep(step, 'done');

        if (stepDelay > 0) {
          await new Promise(r => setTimeout(r, stepDelay));
        }
      }

      this.stats.bootDurationMs = performance.now() - t0;
      this._setState(KernelState.RUNNING);
      logger.kernel('KERNEL', `✓ Boot completo en ${this.stats.bootDurationMs.toFixed(0)}ms`);
      this._booting = false;
      return true;

    } catch (err) {
      this._booting = false;
      logger.fatal('KERNEL', `Boot falló: ${err.message}`, err);
      this.panic(`Fallo durante boot: ${err.message}`);
      return false;
    }
  }

  async _runBootStep(stepId, hardwareBus) {
    switch (stepId) {
      case 'logger':
        // Ya está listo desde el import. Solo verificamos.
        if (!logger) throw new Error('logger no disponible');
        break;

      case 'memory':
        // Ya instanciado en constructor. Verificamos coherencia.
        if (!this.memory || typeof this.memory.allocate !== 'function') {
          throw new Error('MemoryManager inválido');
        }
        break;

      case 'hardware':
        if (!hardwareBus) throw new Error('HardwareBus no inyectado');
        this.hardware = hardwareBus;
        this.hardware.attachKernel(this);
        logger.info('KERNEL', `HardwareBus enlazado (${Object.keys(hardwareBus.devices || {}).length} dispositivos previos)`);
        break;

      case 'drivers':
        await this.hardware.init();
        logger.info('KERNEL', `Drivers cargados: ${Object.keys(this.hardware.devices).join(', ')}`);
        break;

      case 'scheduler':
        this.scheduler.start();
        break;

      case 'syscalls':
        // Syscalls ya instanciado en constructor, pero registramos IRQ handlers
        // comunes del hardware.
        this._registerDefaultIRQHandlers();
        break;

      case 'processes':
        // Nada especial; ProcessManager ya está listo.
        break;

      case 'launchd':
        this.processes.spawnSystemProcess('launchd', 20);
        break;

      case 'springboard':
        this.processes.spawnSystemProcess('SpringBoard', 15);
        break;

      case 'backboardd':
        this.processes.spawnSystemProcess('backboardd', 12);
        break;

      case 'ready':
        // Nada que hacer; el estado RUNNING se pone al salir del bucle.
        break;

      default:
        logger.warn('KERNEL', `Boot step desconocido: ${stepId}`);
    }
  }

  _registerDefaultIRQHandlers() {
    if (!this.hardware) return;
    const { syscalls } = this;

    syscalls.onIRQ('IRQ_DISPLAY', (payload) => {
      logger.debug('KERNEL', `IRQ_DISPLAY: ${JSON.stringify(payload)}`);
    });
    syscalls.onIRQ('IRQ_BATTERY', (payload) => {
      logger.debug('KERNEL', `IRQ_BATTERY: ${(payload.level * 100).toFixed(0)}% charging=${payload.charging}`);
    });
    syscalls.onIRQ('IRQ_HAPTIC', (payload) => {
      logger.debug('KERNEL', `IRQ_HAPTIC: ${payload.style}`);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // SHUTDOWN
  // ═══════════════════════════════════════════════════════════

  async shutdown(reason = 'user-request') {
    if (this._shutdownInProgress) return;
    this._shutdownInProgress = true;

    logger.kernel('KERNEL', `Shutdown solicitado (${reason})`);
    this._setState(KernelState.SHUTDOWN);

    try {
      // Orden reverso al boot
      await this._safeAsync('matar procesos de usuario', () => {
        this.processes.killAll();
      });
      await this._safeAsync('detener scheduler', () => {
        this.scheduler.stop();
      });
      await this._safeAsync('detener drivers', () => {
        if (this.hardware) this.hardware.shutdown?.();
      });
      await this._safeAsync('liberar memoria', () => {
        // No liberamos todo de golpe; solo logueamos estado final
        const stats = this.memory.getStats();
        logger.info('KERNEL', `Estado final memoria: used=${(stats.used / 1024 / 1024).toFixed(0)}MB`);
      });

      this.stats.shutdowns++;
      this._setState(KernelState.OFF);
      logger.kernel('KERNEL', 'Shutdown completo');

    } catch (err) {
      logger.error('KERNEL', `Error durante shutdown: ${err.message}`, err);
      this._setState(KernelState.OFF);
    } finally {
      this._shutdownInProgress = false;
    }
  }

  async _safeAsync(label, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      logger.error('KERNEL', `Fallo en shutdown step "${label}": ${err.message}`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PANIC
  // ═══════════════════════════════════════════════════════════

  panic(reason, error = null) {
    this.stats.panics++;

    // Marcamos estado ANTES de loguear para no reentrar
    this.state = KernelState.PANIC;
    this._emitStateChange();

    const icon = '☠';
    logger.error('KERNEL', '═══════════════════════════════════════════════════');
    logger.error('KERNEL', `${icon}  KERNEL PANIC`);
    logger.error('KERNEL', ` razón: ${reason}`);
    if (error) logger.error('KERNEL', ` error: ${error.message}`);
    logger.error('KERNEL', '═══════════════════════════════════════════════════');

    // Volcado de logs críticos
    const critical = logger.dumpCritical();
    logger.error('KERNEL', `Volcado de ${critical.length} logs críticos:`);
    critical.slice(-20).forEach(e => {
      logger.error('KERNEL', `  [${e.levelName}][${e.tag}] ${e.message}`);
    });

    // Detenemos subsistemas para no seguir causando daño
    try { this.scheduler.stop(); } catch (_) {}
    try { this.processes.killAll(); } catch (_) {}

    // En un OS real: reiniciar tras N segundos o quedarse colgado.
    // Aquí solo dejamos constancia y devolvemos control.
    // La UI puede reaccionar al estado PANIC.
  }

  // ═══════════════════════════════════════════════════════════
  // ESTADO / SUSCRIPCIONES
  // ═══════════════════════════════════════════════════════════

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    this._emitStateChange();
  }

  _emitStateChange() {
    const info = {
      state: this.state,
      uptime: this.uptime(),
      version: this.version,
    };
    for (const fn of this.stateSubscribers) {
      try { fn(info); } catch (_) {}
    }
  }

  _emitBootStep(step, phase) {
    const payload = { step, phase, ts: Date.now() };
    for (const fn of this.bootSubscribers) {
      try { fn(payload); } catch (_) {}
    }
  }

  onBootStep(fn) {
    this.bootSubscribers.add(fn);
    return () => this.bootSubscribers.delete(fn);
  }

  onStateChange(fn) {
    this.stateSubscribers.add(fn);
    return () => this.stateSubscribers.delete(fn);
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  uptime() {
    return Date.now() - this.bootTs;
  }

  isRunning() {
    return this.state === KernelState.RUNNING;
  }

  isPanicked() {
    return this.state === KernelState.PANIC;
  }

  getStats() {
    return {
      version:  this.version,
      build:    this.build,
      arch:     this.arch,
      state:    this.state,
      uptime:   this.uptime(),
      bootTs:   this.bootTs,
      memory:   this.memory.getStats(),
      scheduler:this.scheduler.getStats(),
      processes:this.processes.getStats(),
      stats:    { ...this.stats },
      logger:   logger.getStats(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // API DE CONVENIENCIA (para la UI)
  // ═══════════════════════════════════════════════════════════

  /** Ejecuta un syscall desde cualquier parte del OS. */
  syscall(name, ...args) {
    return this.syscalls.invoke(name, ...args);
  }

  /** Snapshot rápido de procesos (para Terminal, HardwareMonitor). */
  ps() {
    return this.processes.getStats().list;
  }

  /** Snapshot rápido de memoria. */
  mem() {
    return this.memory.getStats();
  }
}

// ───────────────────────────────────────────────────────────────
// Singleton global
// ───────────────────────────────────────────────────────────────
export const kernel = new Kernel();
