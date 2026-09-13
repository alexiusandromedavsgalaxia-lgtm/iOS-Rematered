// src/kernel/ProcessManager.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — ProcessManager
 * ═══════════════════════════════════════════════════════════════
 *
 * Gestión del ciclo de vida de procesos.
 *
 * Un "proceso" aquí es la abstracción que agrupa:
 *   - un PID
 *   - memoria reservada en el MemoryManager
 *   - una o más tareas en el Scheduler
 *   - un sandbox (AppSandbox) si no es de sistema
 *   - metadatos (bundleId, prioridad, uptime, uso de CPU)
 *
 * El ProcessManager NO ejecuta código directamente: delega en el
 * Scheduler. Su trabajo es contabilidad, sandboxing y aislamiento.
 *
 * Analogía real:
 *   - launchd (PID 1) → arranca y supervisa
 *   - SpringBoard      → el "home screen" de iOS
 *   - backboardd       → eventos de bajo nivel (touch, sensores)
 *   - procesos de usuario → apps abiertas
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { PRIORITY, TASK_STATE } from './Scheduler.js';
import { AppSandbox } from '../loader/AppSandbox.js';

// Estados de proceso (análogos a los de Darwin)
export const ProcessState = {
  RUNNING:    'RUNNING',
  SUSPENDED:  'SUSPENDED',
  SLEEPING:   'SLEEPING',
  ZOMBIE:     'ZOMBIE',
  EXITED:     'EXITED',
};

// Configuración por tipo de proceso
const SYSTEM_PROCESS_DEFAULTS = {
  memoryMB:    128,
  priority:    PRIORITY.SYSTEM,
  isSystem:    true,
  hasSandbox:  false,
};

const USER_PROCESS_DEFAULTS = {
  memoryMB:    64,
  priority:    PRIORITY.NORMAL,
  isSystem:    false,
  hasSandbox:  true,
};

// Procesos de sistema que arrancan por defecto si se les pide
// (Kernel los invoca explícitamente, pero aquí mantenemos la lista
// para validación y prioridades por defecto).
export const KNOWN_SYSTEM_PROCESSES = {
  launchd:     { priority: PRIORITY.KERNEL, memoryMB: 32 },
  SpringBoard: { priority: PRIORITY.SYSTEM, memoryMB: 256 },
  backboardd:  { priority: PRIORITY.SYSTEM, memoryMB: 96  },
  configd:     { priority: PRIORITY.SYSTEM, memoryMB: 32  },
  notifyd:     { priority: PRIORITY.SYSTEM, memoryMB: 16  },
  distnoted:   { priority: PRIORITY.SYSTEM, memoryMB: 16  },
};

export class ProcessManager {
  constructor(kernel) {
    this.kernel  = kernel;
    this.processes = new Map();   // pid -> Process
    this.nextPid   = 100;         // PID 1..99 reservados al kernel/boot
    this.sandboxes = new Map();   // bundleId -> AppSandbox

    // Índices auxiliares
    this.byBundle   = new Map();  // bundleId -> pid (último abierto)
    this.childrenOf = new Map();  // pid -> Set<pid>

    // Métricas
    this.metrics = {
      totalSpawned:  0,
      totalKilled:   0,
      totalCrashed:  0,
      peakProcesses: 0,
      peakMemoryMB:  0,
      lastSpawnAt:   null,
      lastKillAt:    null,
    };

    // Suscriptores de eventos (para que la UI pueda reaccionar)
    this.subscribers = new Set();

    logger.kernel('PROC', 'ProcessManager listo');
  }

  // ═══════════════════════════════════════════════════════════
  // SPAWN
  // ═══════════════════════════════════════════════════════════

  /**
   * Crea un proceso.
   *
   * @param {string} name    Nombre legible
   * @param {object} opts
   *   @param {string} bundleId     Identificador (com.apple.xxx)
   *   @param {string} executable   Ruta al binario
   *   @param {number} priority     PRIORITY.*
   *   @param {number} memoryMB     Memoria reservada
   *   @param {boolean} isSystem    true = sin sandbox
   *   @param {number} parentPid    PID del padre (por defecto: kernel=0)
   *   @param {function} mainFn     Función principal (se pasa al scheduler)
   *
   * @returns {object} El proceso creado.
   */
  spawn(name, opts = {}) {
    if (typeof name !== 'string' || !name) {
      throw new Error('ProcessManager.spawn: name requerido');
    }

    const isSystem = !!opts.isSystem;
    const defaults = isSystem ? SYSTEM_PROCESS_DEFAULTS : USER_PROCESS_DEFAULTS;

    const pid = this._allocatePid();
    const priority  = opts.priority  ?? defaults.priority;
    const memoryMB  = opts.memoryMB  ?? defaults.memoryMB;
    const bundleId  = opts.bundleId  ?? (isSystem ? null : `com.iosremastered.${name.toLowerCase()}`);
    const parentPid = opts.parentPid ?? 0;

    // 1) Reservar memoria
    let memHandle = null;
    try {
      const alloc = this.kernel.memory.allocate(
        memoryMB * 1024 * 1024,
        `proc:${pid}`,
        isSystem ? 'RWX' : 'RW',
      );
      memHandle = alloc.handle;
    } catch (err) {
      logger.error('PROC', `spawn falló (OOM): ${name} pid=${pid} mem=${memoryMB}MB`);
      throw err;
    }

    // 2) Crear sandbox si es app de usuario
    let sandbox = null;
    if (!isSystem && bundleId) {
      sandbox = this.sandboxes.get(bundleId) || new AppSandbox(bundleId);
      this.sandboxes.set(bundleId, sandbox);
    }

    // 3) Construir el registro de proceso
    const proc = {
      pid,
      name,
      bundleId,
      executable: opts.executable ?? null,
      parentPid,
      isSystem,
      state: ProcessState.RUNNING,

      priority,
      memoryMB,
      memoryHandle: memHandle,

      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,

      // Contabilidad de CPU (incrementada por el scheduler cuando corre su tarea)
      cpuTimeMs: 0,
      lastCpuTickAt: Date.now(),

      // Tareas del scheduler asociadas a este proceso
      tasks: new Set(),

      // Sandbox
      sandbox,

      // Extensiones de app (si es una app cargada por Mach-O loader)
      machoImage: opts.machoImage ?? null,

      // Etiquetas
      tags: opts.tags ?? [],
    };

    // 4) Registrar
    this.processes.set(pid, proc);
    if (bundleId) this.byBundle.set(bundleId, pid);
    if (parentPid) {
      if (!this.childrenOf.has(parentPid)) this.childrenOf.set(parentPid, new Set());
      this.childrenOf.get(parentPid).add(pid);
    }

    // 5) Crear tarea en el scheduler (si hay mainFn)
    const taskName = `proc:${pid}:${name}`;
    const fn = opts.mainFn ?? (() => {
      // Tarea por defecto: solo acumula tiempo de CPU para que el
      // HardwareMonitor tenga algo que mostrar.
      const now = Date.now();
      proc.cpuTimeMs += now - proc.lastCpuTickAt;
      proc.lastCpuTickAt = now;
    });

    const tid = this.kernel.scheduler.spawn(taskName, priority, fn, {
      interval: opts.interval ?? null,
    });
    proc.tasks.add(tid);

    // 6) Métricas
    this.metrics.totalSpawned++;
    this.metrics.lastSpawnAt = Date.now();
    if (this.processes.size > this.metrics.peakProcesses) {
      this.metrics.peakProcesses = this.processes.size;
    }
    const totalMB = this._totalMemoryMB();
    if (totalMB > this.metrics.peakMemoryMB) {
      this.metrics.peakMemoryMB = totalMB;
    }

    // 7) Log + notificación
    logger.info('PROC', `▶ spawn pid=${pid} name=${name} prio=${priority} mem=${memoryMB}MB${bundleId ? ` bundle=${bundleId}` : ''}`);
    this._emit('spawn', proc);

    return proc;
  }

  /**
   * Atajo para procesos del sistema. Fuerza isSystem=true y aplica
   * prioridad específica si el nombre es conocido.
   */
  spawnSystemProcess(name, priorityOverride = null) {
    const known = KNOWN_SYSTEM_PROCESSES[name];
    const priority = priorityOverride ?? known?.priority ?? PRIORITY.SYSTEM;
    const memoryMB = known?.memoryMB ?? SYSTEM_PROCESS_DEFAULTS.memoryMB;

    return this.spawn(name, {
      isSystem: true,
      priority,
      memoryMB,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // KILL / EXIT
  // ═══════════════════════════════════════════════════════════

  /**
   * Mata un proceso: libera memoria, mata sus tareas, marca ZOMBIE
   * y notifica a hijos (que pasan a reparentarse a launchd=1 si existiera).
   */
  kill(pid, exitCode = 0) {
    const proc = this.processes.get(pid);
    if (!proc) {
      logger.warn('PROC', `kill: no such process pid=${pid}`);
      return false;
    }
    if (proc.isSystem && pid === 1) {
      logger.error('PROC', 'kill: intento de matar PID 1 (launchd)');
      return false;
    }

    logger.info('PROC', `■ kill pid=${pid} name=${proc.name} exit=${exitCode}`);

    // 1) Matar tareas asociadas
    for (const tid of proc.tasks) {
      try { this.kernel.scheduler.kill(tid); }
      catch (err) { logger.warn('PROC', `kill: tarea ${tid} no se pudo matar: ${err.message}`); }
    }
    proc.tasks.clear();

    // 2) Liberar memoria
    if (proc.memoryHandle) {
      try { this.kernel.memory.free(proc.memoryHandle, `proc:${pid}`); }
      catch (err) { logger.warn('PROC', `kill: no se pudo liberar memoria de pid=${pid}: ${err.message}`); }
    }

    // 3) Marcar estado
    proc.state   = ProcessState.EXITED;
    proc.endedAt = Date.now();
    proc.exitCode = exitCode;

    // 4) Reparentar hijos
    const children = this.childrenOf.get(pid);
    if (children) {
      for (const childPid of children) {
        const child = this.processes.get(childPid);
        if (child) {
          child.parentPid = 1; // reparentar a launchd
          logger.debug('PROC', `reparent pid=${childPid} → 1 (huérfano)`);
        }
      }
      this.childrenOf.delete(pid);
    }

    // 5) Eliminar del mapa activo
    this.processes.delete(pid);
    if (proc.bundleId && this.byBundle.get(proc.bundleId) === pid) {
      this.byBundle.delete(proc.bundleId);
    }

    // 6) Métricas + notificación
    this.metrics.totalKilled++;
    this.metrics.lastKillAt = Date.now();
    this._emit('kill', proc);

    return true;
  }

  /**
   * Mata todos los procesos EXCEPTO los que se indiquen.
   * Usado en shutdown.
   */
  killAll(exceptPids = []) {
    const except = new Set(exceptPids);
    const pids = [...this.processes.keys()].filter(p => !except.has(p));
    // Matamos primero los de usuario, luego sistema (para que launchd
    // sea el último en caer).
    pids.sort((a, b) => {
      const pa = this.processes.get(a);
      const pb = this.processes.get(b);
      return (pa.isSystem ? 1 : 0) - (pb.isSystem ? 1 : 0);
    });
    for (const pid of pids) {
      this.kill(pid, 0);
    }
    logger.kernel('PROC', `killAll: ${pids.length} procesos terminados`);
    return pids.length;
  }

  /**
   * Suspende un proceso (no lo mata, lo pausa).
   */
  suspend(pid) {
    const proc = this.processes.get(pid);
    if (!proc) return false;
    if (proc.state === ProcessState.SUSPENDED) return true;
    proc.state = ProcessState.SUSPENDED;
    for (const tid of proc.tasks) {
      const t = this.kernel.scheduler.get(tid);
      if (t) t.state = TASK_STATE.WAITING;
    }
    logger.info('PROC', `⏸ suspend pid=${pid} name=${proc.name}`);
    this._emit('suspend', proc);
    return true;
  }

  /**
   * Reanuda un proceso suspendido.
   */
  resume(pid) {
    const proc = this.processes.get(pid);
    if (!proc) return false;
    if (proc.state !== ProcessState.SUSPENDED) return true;
    proc.state = ProcessState.RUNNING;
    for (const tid of proc.tasks) {
      const t = this.kernel.scheduler.get(tid);
      if (t) t.state = TASK_STATE.READY;
    }
    logger.info('PROC', `▶ resume pid=${pid} name=${proc.name}`);
    this._emit('resume', proc);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  get(pid) { return this.processes.get(pid); }
  has(pid) { return this.processes.has(pid); }

  byBundleId(bundleId) {
    const pid = this.byBundle.get(bundleId);
    return pid ? this.processes.get(pid) : null;
  }

  findByPrefix(prefix) {
    const lower = prefix.toLowerCase();
    return [...this.processes.values()].filter(p =>
      p.name.toLowerCase().includes(lower) ||
      (p.bundleId && p.bundleId.toLowerCase().includes(lower))
    );
  }

  children(pid) {
    const set = this.childrenOf.get(pid);
    return set ? [...set].map(c => this.processes.get(c)).filter(Boolean) : [];
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES INTERNAS
  // ═══════════════════════════════════════════════════════════

  _allocatePid() {
    // Buscamos el siguiente PID libre a partir de nextPid.
    // En la práctica no hay colisiones porque nunca decrementamos.
    const pid = this.nextPid++;
    return pid;
  }

  _totalMemoryMB() {
    let sum = 0;
    for (const p of this.processes.values()) sum += p.memoryMB;
    return sum;
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(type, proc) {
    const payload = { type, ts: Date.now(), proc: { ...proc } };
    for (const fn of this.subscribers) {
      try { fn(payload); } catch (_) { /* nunca romper por un subscriber */ }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ESTADÍSTICAS
  // ═══════════════════════════════════════════════════════════

  getStats() {
    const now = Date.now();
    const list = [];
    let systemCount = 0;
    let userCount = 0;
    let totalCpuMs = 0;

    for (const p of this.processes.values()) {
      const uptimeMs = now - p.startedAt;
      // Estimar CPU acumulada si la tarea por defecto está corriendo
      if (p.state === ProcessState.RUNNING) {
        p.cpuTimeMs += now - p.lastCpuTickAt;
        p.lastCpuTickAt = now;
      }
      totalCpuMs += p.cpuTimeMs;
      if (p.isSystem) systemCount++; else userCount++;

      list.push({
        pid:         p.pid,
        name:        p.name,
        bundleId:    p.bundleId,
        state:       p.state,
        isSystem:    p.isSystem,
        priority:    p.priority,
        memMB:       p.memoryMB,
        cpuMs:       Math.round(p.cpuTimeMs),
        cpuSec:      parseFloat((p.cpuTimeMs / 1000).toFixed(2)),
        uptimeMs,
        tasks:       p.tasks.size,
        parentPid:   p.parentPid,
        hasSandbox:  !!p.sandbox,
      });
    }

    // Orden por CPU desc
    list.sort((a, b) => b.cpuMs - a.cpuMs);

    return {
      count:        this.processes.size,
      systemCount,
      userCount,
      totalMemoryMB: this._totalMemoryMB(),
      totalCpuMs:   Math.round(totalCpuMs),
      sandboxes:    this.sandboxes.size,
      list,
      metrics:      { ...this.metrics },
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `ProcessManager — ${s.count} procesos (${s.systemCount} sistema, ${s.userCount} usuario)`,
      `Memoria total reservada: ${s.totalMemoryMB} MB`,
      `CPU acumulada: ${(s.totalCpuMs / 1000).toFixed(2)} s`,
      '',
    ];
    for (const p of s.list) {
      const tag = p.isSystem ? '[SYS]' : '[USR]';
      lines.push(`  ${tag} pid=${String(p.pid).padEnd(4)} ${p.name.padEnd(20)} ${p.state.padEnd(10)} ${String(p.memMB).padStart(4)}MB ${p.cpuSec}s`);
    }
    return lines.join('\n');
  }
}
