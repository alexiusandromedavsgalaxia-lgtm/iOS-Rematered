// src/kernel/Syscalls.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — Syscalls
 * ═══════════════════════════════════════════════════════════════
 *
 * Tabla de llamadas al sistema. Es la frontera entre userland (apps,
 * SpringBoard, apps nativas) y el kernel.
 *
 * Responsabilidades:
 *   - Registrar y despachar syscalls por nombre.
 *   - Validar argumentos y devolver códigos de error POSIX (errno).
 *   - Enrutar IRQs del hardware hacia los handlers registrados.
 *   - Mantener contadores y latencias por syscall (para HardwareMonitor).
 *   - Permitir hooks de tracing para debugging (Terminal).
 *
 * Convención de retorno:
 *   - Éxito  → el valor real devuelto.
 *   - Error  → se lanza SyscallError con `errno` y `message`.
 *              El wrapper invoke() lo captura y devuelve -errno, igual
 *              que hace el kernel de Linux/Darwin.
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';

// ───────────────────────────────────────────────────────────────
// Códigos de error estilo POSIX (negativos como en C)
// ───────────────────────────────────────────────────────────────
export const Errno = {
  EPERM:   1,   // Operation not permitted
  ENOENT:  2,   // No such file or directory
  ESRCH:   3,   // No such process
  EINTR:   4,   // Interrupted system call
  EIO:     5,   // I/O error
  ENXIO:   6,   // No such device or address
  E2BIG:   7,   // Argument list too long
  ENOEXEC: 8,   // Exec format error
  EBADF:   9,   // Bad file descriptor
  ECHILD: 10,   // No child processes
  EAGAIN: 11,   // Try again
  ENOMEM: 12,   // Out of memory
  EACCES: 13,   // Permission denied
  EFAULT: 14,   // Bad address
  EBUSY:  16,   // Device or resource busy
  EEXIST: 17,   // File exists
  ENODEV: 19,   // No such device
  ENOTDIR:20,   // Not a directory
  EISDIR: 21,   // Is a directory
  EINVAL: 22,   // Invalid argument
  ENFILE: 23,   // Too many open files in system
  EMFILE: 24,   // Too many open files
  ENOSPC: 28,   // No space left on device
  ESPIPE: 29,   // Illegal seek
  EROFS:  30,   // Read-only file system
  EPIPE:  32,   // Broken pipe
  ENOSYS: 38,   // Function not implemented
  ENOTEMPTY: 39,// Directory not empty
  ELOOP:  40,   // Too many symbolic links
  ETIMEDOUT: 110, // Connection timed out
  ECONNREFUSED: 111,
};

// ───────────────────────────────────────────────────────────────
// Error de syscall
// ───────────────────────────────────────────────────────────────
export class SyscallError extends Error {
  constructor(errno, message, syscall = null) {
    super(message || `syscall error ${errno}`);
    this.name = 'SyscallError';
    this.errno = errno;
    this.syscall = syscall;
  }
}

const errnoName = (code) => {
  for (const [name, val] of Object.entries(Errno)) {
    if (val === code) return name;
  }
  return `E${code}`;
};

// ───────────────────────────────────────────────────────────────
// File descriptor table (simulada)
// ───────────────────────────────────────────────────────────────
class FdTable {
  constructor() {
    this.nextFd = 3;    // 0/1/2 reservados: stdin, stdout, stderr
    this.entries = new Map();
    // Reservamos 0,1,2
    this.entries.set(0, { type: 'stdin',  path: '<stdin>',  flags: 'r' });
    this.entries.set(1, { type: 'stdout', path: '<stdout>', flags: 'w' });
    this.entries.set(2, { type: 'stderr', path: '<stderr>', flags: 'w' });
  }

  open(path, flags = 'r') {
    if (this.entries.size >= 256) {
      throw new SyscallError(Errno.ENFILE, 'too many open files');
    }
    const fd = this.nextFd++;
    this.entries.set(fd, { type: 'file', path, flags, offset: 0, openedAt: Date.now() });
    return fd;
  }

  close(fd) {
    if (!this.entries.has(fd)) {
      throw new SyscallError(Errno.EBADF, `bad fd ${fd}`);
    }
    if (fd < 3) {
      throw new SyscallError(Errno.EPERM, `cannot close fd ${fd}`);
    }
    this.entries.delete(fd);
    return 0;
  }

  get(fd) {
    const e = this.entries.get(fd);
    if (!e) throw new SyscallError(Errno.EBADF, `bad fd ${fd}`);
    return e;
  }

  list() {
    return [...this.entries.entries()].map(([fd, e]) => ({ fd, ...e }));
  }
}

// ───────────────────────────────────────────────────────────────
// Syscalls
// ───────────────────────────────────────────────────────────────
export class Syscalls {
  constructor(kernel) {
    this.kernel = kernel;
    this.fds = new FdTable();
    this.handlers = new Map();      // nombre -> { fn, description }
    this.irqHandlers = new Map();   // irq -> Set<fn>
    this.traceHooks = new Set();
    this.enableTracing = false;

    // Métricas
    this.metrics = {
      totalCalls: 0,
      totalErrors: 0,
      perName: new Map(),   // name -> { calls, errors, totalMs, maxMs }
      lastCall: null,
    };

    // Registrar syscalls base
    this._registerDefaults();

    logger.kernel('SYS', `Syscall table inicializada con ${this.handlers.size} entradas`);
  }

  // ═══════════════════════════════════════════════════════════
  // REGISTRO
  // ═══════════════════════════════════════════════════════════

  /**
   * Registra una syscall.
   * @param {string} name          Nombre (ej: "sys_open")
   * @param {function} fn          Implementación
   * @param {string} description   Descripción corta
   */
  register(name, fn, description = '') {
    if (typeof fn !== 'function') {
      throw new Error(`Syscalls.register: fn debe ser función (${name})`);
    }
    if (this.handlers.has(name)) {
      logger.warn('SYS', `re-registrando syscall: ${name}`);
    }
    this.handlers.set(name, { fn, description });
    logger.debug('SYS', `registrada syscall ${name}${description ? ` (${description})` : ''}`);
    return this;
  }

  unregister(name) {
    return this.handlers.delete(name);
  }

  /**
   * Registra un handler para un IRQ.
   */
  onIRQ(irqName, handler) {
    if (!this.irqHandlers.has(irqName)) {
      this.irqHandlers.set(irqName, new Set());
    }
    this.irqHandlers.get(irqName).add(handler);
    logger.debug('SYS', `IRQ handler registrado: ${irqName}`);
    return () => this.irqHandlers.get(irqName)?.delete(handler);
  }

  dispatchIRQ(irqName, payload) {
    const set = this.irqHandlers.get(irqName);
    if (!set || set.size === 0) {
      logger.debug('SYS', `IRQ sin handler: ${irqName}`);
      return;
    }
    for (const fn of set) {
      try { fn(payload); }
      catch (err) {
        logger.error('SYS', `IRQ handler falló (${irqName}): ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // INVOCACIÓN
  // ═══════════════════════════════════════════════════════════

  /**
   * Invoca una syscall.
   * @returns {*} valor real, o -errno si falla.
   */
  invoke(name, ...args) {
    const entry = this.handlers.get(name);
    if (!entry) {
      logger.error('SYS', `syscall desconocida: ${name}`);
      this._bumpError(name);
      return -Errno.ENOSYS;
    }

    const t0 = performance.now();
    this.metrics.totalCalls++;

    // Tracing hook
    if (this.enableTracing) {
      this._emitTrace({ phase: 'enter', name, args, ts: Date.now() });
    }

    let result, failed = false;

    try {
      result = entry.fn.apply(this, args);
    } catch (err) {
      failed = true;
      this.metrics.totalErrors++;
      this._bumpError(name);

      if (err instanceof SyscallError) {
        logger.debug('SYS', `${name} → -${errnoName(err.errno)} (${err.message})`);
        result = -err.errno;
      } else {
        logger.error('SYS', `${name} lanzó excepción no controlada: ${err.message}`, err);
        result = -Errno.EFAULT;
      }
    }

    const dt = performance.now() - t0;
    this._recordTiming(name, dt, failed);

    if (this.enableTracing) {
      this._emitTrace({ phase: 'exit', name, result, durationMs: dt, ts: Date.now() });
    }

    this.metrics.lastCall = { name, args, result, durationMs: dt, failed, ts: Date.now() };

    return result;
  }

  /**
   * Igual que invoke() pero lanza SyscallError en caso de fallo.
   * Útil para llamadas internas del kernel.
   */
  invokeOrThrow(name, ...args) {
    const entry = this.handlers.get(name);
    if (!entry) throw new SyscallError(Errno.ENOSYS, `unknown syscall ${name}`, name);
    return entry.fn.apply(this, args);
  }

  // ═══════════════════════════════════════════════════════════
  // MÉTRICAS / TRACING
  // ═══════════════════════════════════════════════════════════

  _recordTiming(name, ms, failed) {
    let rec = this.metrics.perName.get(name);
    if (!rec) {
      rec = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
      this.metrics.perName.set(name, rec);
    }
    rec.calls++;
    if (failed) rec.errors++;
    rec.totalMs += ms;
    if (ms > rec.maxMs) rec.maxMs = ms;
  }

  _bumpError(name) {
    let rec = this.metrics.perName.get(name);
    if (!rec) {
      rec = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
      this.metrics.perName.set(name, rec);
    }
    rec.errors++;
  }

  _emitTrace(event) {
    for (const fn of this.traceHooks) {
      try { fn(event); } catch (_) {}
    }
  }

  onTrace(fn) {
    this.traceHooks.add(fn);
    return () => this.traceHooks.delete(fn);
  }

  setTracing(on) {
    this.enableTracing = !!on;
    logger.info('SYS', `tracing ${this.enableTracing ? 'activado' : 'desactivado'}`);
  }

  // ═══════════════════════════════════════════════════════════
  // REGISTRO POR DEFECTO
  // ═══════════════════════════════════════════════════════════

  _registerDefaults() {
    // ─── Proceso ──────────────────────────────────────────────
    this.register('sys_fork',
      (opts = {}) => {
        const p = this.kernel.processes.spawn(opts.name ?? 'forked', opts);
        return p.pid;
      }, 'Crea un proceso');

    this.register('sys_exec',
      (bundleId) => {
        if (typeof bundleId !== 'string' || !bundleId) {
          throw new SyscallError(Errno.EINVAL, 'bundleId requerido');
        }
        logger.info('SYS', `exec(${bundleId})`);
        return this.kernel.processes.spawn(bundleId, { bundleId });
      }, 'Ejecuta un binario/paquete');

    this.register('sys_exit',
      (pid, code = 0) => {
        if (typeof pid !== 'number') throw new SyscallError(Errno.EINVAL, 'pid inválido');
        const ok = this.kernel.processes.kill(pid);
        if (!ok) throw new SyscallError(Errno.ESRCH, `no such process ${pid}`);
        logger.info('SYS', `exit(${pid}, ${code})`);
        return 0;
      }, 'Termina un proceso');

    this.register('sys_kill',
      (pid, signal = 15) => {
        if (typeof pid !== 'number') throw new SyscallError(Errno.EINVAL, 'pid inválido');
        const ok = this.kernel.processes.kill(pid);
        if (!ok) throw new SyscallError(Errno.ESRCH, `no such process ${pid}`);
        logger.info('SYS', `kill(${pid}, signal=${signal})`);
        return 0;
      }, 'Envía señal a un proceso');

    this.register('sys_getpid',
      () => this.kernel.processes.nextPid,
      'Devuelve el último PID asignado');

    this.register('sys_gettime',
      () => Date.now(),
      'Timestamp actual');

    this.register('sys_uptime',
      () => this.kernel.uptime(),
      'Uptime del kernel');

    // ─── Memoria ──────────────────────────────────────────────
    this.register('sys_mmap',
      (size, owner = 'user', flags = 'RW') => {
        if (typeof size !== 'number' || size <= 0) {
          throw new SyscallError(Errno.EINVAL, 'size inválido');
        }
        try {
          const alloc = this.kernel.memory.allocate(size, owner, flags);
          return alloc.handle;
        } catch (e) {
          throw new SyscallError(Errno.ENOMEM, e.message);
        }
      }, 'Asigna memoria');

    this.register('sys_munmap',
      (handle, owner = null) => {
        const ok = this.kernel.memory.free(handle, owner);
        if (!ok) throw new SyscallError(Errno.EINVAL, `handle inválido ${handle}`);
        return 0;
      }, 'Libera memoria');

    // ─── Ficheros (fd) ────────────────────────────────────────
    this.register('sys_open',
      (path, flags = 'r') => {
        if (typeof path !== 'string' || !path) {
          throw new SyscallError(Errno.EINVAL, 'path requerido');
        }
        // Comprobamos que existe en el FS (si el FS está accesible)
        const fs = this.kernel.fs;
        if (fs) {
          const node = fs.resolve(path);
          if (!node && !flags.includes('w') && !flags.includes('+')) {
            throw new SyscallError(Errno.ENOENT, `no such file: ${path}`);
          }
        }
        const fd = this.fds.open(path, flags);
        logger.debug('SYS', `open(${path}, ${flags}) → fd=${fd}`);
        return fd;
      }, 'Abre un fichero');

    this.register('sys_close',
      (fd) => this.fds.close(fd),
      'Cierra un fd');

    this.register('sys_read',
      (fd, size = 0) => {
        const entry = this.fds.get(fd);
        const fs = this.kernel.fs;
        if (!fs) throw new SyscallError(Errno.EIO, 'filesystem no disponible');
        const data = fs.readFile(entry.path);
        if (data === null || data === undefined) {
          throw new SyscallError(Errno.EIO, `read falló: ${entry.path}`);
        }
        const start = entry.offset;
        const end = size > 0 ? Math.min(start + size, data.length) : data.length;
        entry.offset = end;
        return data.slice(start, end);
      }, 'Lee de un fd');

    this.register('sys_write',
      (fd, buf) => {
        const entry = this.fds.get(fd);
        if (fd === 1 || fd === 2) {
          // stdout/stderr → logger
          logger.info('STDOUT', String(buf));
          return String(buf).length;
        }
        const fs = this.kernel.fs;
        if (!fs) throw new SyscallError(Errno.EIO, 'filesystem no disponible');
        const ok = fs.writeFile(entry.path, String(buf));
        if (!ok) throw new SyscallError(Errno.EACCES, `write falló: ${entry.path}`);
        return String(buf).length;
      }, 'Escribe a un fd');

    this.register('sys_lseek',
      (fd, offset, whence = 'SET') => {
        const entry = this.fds.get(fd);
        if (whence === 'SET') entry.offset = offset;
        else if (whence === 'CUR') entry.offset += offset;
        else if (whence === 'END') {
          const fs = this.kernel.fs;
          const data = fs?.readFile(entry.path) || '';
          entry.offset = data.length + offset;
        } else {
          throw new SyscallError(Errno.EINVAL, `whence inválido: ${whence}`);
        }
        return entry.offset;
      }, 'Reposiciona el offset de un fd');

    // ─── Scheduler ────────────────────────────────────────────
    this.register('sys_spawn_task',
      (name, priority, fn, opts = {}) => this.kernel.scheduler.spawn(name, priority, fn, opts),
      'Crea una tarea en el scheduler');

    this.register('sys_kill_task',
      (tid) => {
        const ok = this.kernel.scheduler.kill(tid);
        if (!ok) throw new SyscallError(Errno.ESRCH, `no such task ${tid}`);
        return 0;
      }, 'Mata una tarea');

    this.register('sys_sleep',
      (tid, ms) => {
        const ok = this.kernel.scheduler.sleep(tid, ms);
        if (!ok) throw new SyscallError(Errno.ESRCH, `no such task ${tid}`);
        return 0;
      }, 'Duerme una tarea');

    this.register('sys_wake',
      (tid, payload = null) => {
        const ok = this.kernel.scheduler.wake(tid, payload);
        if (!ok) throw new SyscallError(Errno.ESRCH, `no such task ${tid}`);
        return 0;
      }, 'Despierta una tarea');

    // ─── Info del sistema ─────────────────────────────────────
    this.register('sys_uname',
      () => ({
        sysname:  'iOSR',
        nodename: 'iPhone',
        release:  this.kernel.version,
        version:  this.kernel.build,
        machine:  this.kernel.arch,
      }), 'Información del sistema');

    this.register('sys_ps',
      () => this.kernel.ps(),
      'Lista de procesos');

    this.register('sys_free',
      () => this.kernel.mem(),
      'Estado de memoria');

    this.register('sys_sched_stats',
      () => this.kernel.scheduler.getStats(),
      'Estadísticas del scheduler');

    // ─── Logging ──────────────────────────────────────────────
    this.register('sys_log',
      (level, tag, message, data = null) => {
        const fn = logger[level] || logger.info;
        fn.call(logger, tag, message, data);
        return 0;
      }, 'Escribe en el log del kernel');

    // ─── Placeholder filesystem ───────────────────────────────
    this.register('sys_mount',
      (path) => {
        logger.info('SYS', `mount(${path})`);
        return 0;
      }, 'Monta un FS');

    this.register('sys_sync',
      () => {
        logger.info('SYS', 'sync() — flush de buffers');
        return 0;
      }, 'Sincroniza el FS');
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  list() {
    return [...this.handlers.entries()].map(([name, e]) => {
      const rec = this.metrics.perName.get(name) || { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
      return {
        name,
        description: e.description,
        calls:       rec.calls,
        errors:      rec.errors,
        avgMs:       rec.calls ? parseFloat((rec.totalMs / rec.calls).toFixed(3)) : 0,
        maxMs:       parseFloat(rec.maxMs.toFixed(3)),
      };
    });
  }

  getStats() {
    return {
      registered: this.handlers.size,
      irqHandlers: [...this.irqHandlers.entries()].map(([k, v]) => ({ irq: k, count: v.size })),
      totalCalls: this.metrics.totalCalls,
      totalErrors: this.metrics.totalErrors,
      errorRate: this.metrics.totalCalls
        ? parseFloat(((this.metrics.totalErrors / this.metrics.totalCalls) * 100).toFixed(2))
        : 0,
      lastCall: this.metrics.lastCall,
      fdCount: this.fds.entries.size,
      openFds: this.fds.list(),
      tracing: this.enableTracing,
    };
  }
}
