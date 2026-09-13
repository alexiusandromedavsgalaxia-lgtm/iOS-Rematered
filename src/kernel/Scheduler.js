// src/kernel/Scheduler.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — Scheduler
 * ═══════════════════════════════════════════════════════════════
 *
 * Planificador cooperativo a 60Hz (16.67ms por tick).
 *
 * Responsabilidades:
 *   - Mantener la cola de tareas listas ordenadas por prioridad.
 *   - Ejecutar cada tarea READY una vez por tick, respetando un
 *     presupuesto de tiempo por tick (budgetMs).
 *   - Gestionar tareas dormidas (sleep) y despertarlas al vencer.
 *   - Gestionar tareas en espera (waiting) resueltas por eventos.
 *   - Medir carga de CPU (EMA), context switches, tick time.
 *   - Permitir spawn/kill/pause/resume de tareas desde cualquier
 *     parte del OS.
 *
 * NO es un scheduler preemptivo real (JS es single-threaded), pero
 * emula el comportamiento: si una tarea se pasa del quantum, se
 * registra como "overrun" y se penaliza su prioridad efectiva en
 * el siguiente tick (aging inverso).
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────

export const TASK_STATE = {
  READY:    'READY',
  RUNNING:  'RUNNING',
  SLEEPING: 'SLEEPING',
  WAITING:  'WAITING',
  ZOMBIE:   'ZOMBIE',
};

// Prioridad tipo "nice" pero invertida: mayor número = más importante.
export const PRIORITY = {
  KERNEL:  100,
  SYSTEM:   80,
  HIGH:     60,
  NORMAL:   40,
  LOW:      20,
  IDLE:      5,
};

const DEFAULT_TICK_HZ     = 60;
const DEFAULT_BUDGET_MS   = 12;      // presupuesto por tick para no saturar el frame
const OVERRUN_PENALTY     = 5;       // se resta a la prioridad efectiva cuando hay overrun
const AGING_BONUS         = 1;       // se suma a la prioridad efectiva por tick en READY
const MAX_AGING           = 20;      // tope del aging

// ───────────────────────────────────────────────────────────────
// Task — unidad de ejecución
// ───────────────────────────────────────────────────────────────
class Task {
  constructor({ tid, name, priority, fn, interval, state }) {
    this.tid        = tid;
    this.name       = name;
    this.basePrio   = priority;
    this.effPrio    = priority;
    this.fn         = fn;
    this.interval   = interval ?? null;  // si != null, es periódica (ms)
    this.state      = state ?? TASK_STATE.READY;

    this.createdAt  = Date.now();
    this.startedAt  = null;
    this.lastRunAt  = null;
    this.nextRunAt  = 0;                 // para periódicas
    this.sleepUntil = 0;
    this.waitReason = null;

    // Métricas
    this.runs        = 0;
    this.totalMs     = 0;
    this.lastMs      = 0;
    this.maxMs       = 0;
    this.overruns    = 0;
    this.errors      = 0;
    this.aging       = 0;

    // Para tareas en WAITING: promesa resolutora
    this._resolveWait = null;
  }

  isPeriodic() { return this.interval !== null; }
}

// ───────────────────────────────────────────────────────────────
// Scheduler
// ───────────────────────────────────────────────────────────────
export class Scheduler {
  constructor(options = {}) {
    this.tickHz      = options.tickHz     ?? DEFAULT_TICK_HZ;
    this.tickMs      = 1000 / this.tickHz;
    this.budgetMs    = options.budgetMs   ?? DEFAULT_BUDGET_MS;

    this.tasks       = new Map();  // tid -> Task
    this.readyList   = [];         // array de Task, se ordena antes de cada tick
    this.sleepingSet = new Set();  // tids durmiendo
    this.waitingSet  = new Set();  // tids esperando evento

    this.running     = false;
    this.timerId     = null;
    this._tidSeq     = 1;

    this.metrics = {
      totalTicks:      0,
      idleTicks:       0,
      busyMs:          0,
      avgTickMs:       0,
      lastTickMs:      0,
      cpuLoad:         0,       // %
      contextSwitches: 0,
      tasksSpawned:    0,
      tasksKilled:     0,
      tasksCompleted:  0,
      overruns:        0,
      errors:          0,
      budgetExceeded:  0,
    };

    // Media móvil exponencial del uso de CPU
    this._loadAlpha = 0.15;
    this._loadEma   = 0;

    // Callbacks de eventos
    this._onTaskEvent = new Set();

    logger.kernel('SCHED', `Scheduler listo: ${this.tickHz}Hz (${this.tickMs.toFixed(2)}ms/tick, budget=${this.budgetMs}ms)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  start() {
    if (this.running) {
      logger.warn('SCHED', 'start() ignorado: ya está corriendo');
      return;
    }
    this.running = true;
    this.timerId = setInterval(() => this._tick(), this.tickMs);
    logger.kernel('SCHED', '▶ Scheduler arrancado');
    this._emit('start', null);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = null;
    logger.kernel('SCHED', '■ Scheduler detenido');
    this._emit('stop', null);
  }

  pause() {
    if (!this.running) return;
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = null;
    this._paused = true;
    logger.info('SCHED', '⏸ Scheduler pausado');
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.timerId = setInterval(() => this._tick(), this.tickMs);
    logger.info('SCHED', '▶ Scheduler reanudado');
  }

  // ═══════════════════════════════════════════════════════════
  // GESTIÓN DE TAREAS
  // ═══════════════════════════════════════════════════════════

  /**
   * Crea una tarea.
   * @param {string}   name        Nombre legible
   * @param {number}   priority    PRIORITY.*
   * @param {function} fn          Función a ejecutar
   * @param {object}   opts        { interval?: ms, startNow?: bool }
   * @returns {string} tid
   */
  spawn(name, priority = PRIORITY.NORMAL, fn = null, opts = {}) {
    if (fn !== null && typeof fn !== 'function') {
      throw new Error(`Scheduler.spawn: fn debe ser función o null (recibido ${typeof fn})`);
    }

    const tid = `tid-${this._tidSeq++}-${Math.random().toString(36).slice(2, 6)}`;

    const task = new Task({
      tid,
      name,
      priority,
      fn,
      interval: opts.interval ?? null,
      state:    TASK_STATE.READY,
    });

    this.tasks.set(tid, task);
    this.readyList.push(task);

    this.metrics.tasksSpawned++;

    logger.debug('SCHED', `spawn ${name} [${tid.slice(-6)}] prio=${priority}${opts.interval ? ` cada ${opts.interval}ms` : ''}`);
    this._emit('spawn', task);

    return tid;
  }

  /**
   * Elimina una tarea.
   * @returns {boolean}
   */
  kill(tid) {
    const task = this.tasks.get(tid);
    if (!task) return false;

    // Si estaba en WAITING, resolver la promesa con null para desbloquear
    if (task._resolveWait) {
      task._resolveWait(null);
      task._resolveWait = null;
    }

    this.tasks.delete(tid);
    this.sleepingSet.delete(tid);
    this.waitingSet.delete(tid);
    this.readyList = this.readyList.filter(t => t.tid !== tid);

    task.state = TASK_STATE.ZOMBIE;
    this.metrics.tasksKilled++;

    logger.debug('SCHED', `kill ${task.name} [${tid.slice(-6)}]`);
    this._emit('kill', task);

    return true;
  }

  get(tid) { return this.tasks.get(tid); }
  has(tid) { return this.tasks.has(tid); }

  // ═══════════════════════════════════════════════════════════
  // PRIMITIVAS DE BLOQUEO
  // ═══════════════════════════════════════════════════════════

  /**
   * Duerme una tarea N ms. La tarea pasa a SLEEPING y se mueve a
   * la cola de dormidos. Se despertará automáticamente al vencer.
   * @param {string} tid
   * @param {number} ms
   */
  sleep(tid, ms) {
    const task = this.tasks.get(tid);
    if (!task) return false;
    if (ms <= 0) return true;

    task.state      = TASK_STATE.SLEEPING;
    task.sleepUntil = Date.now() + ms;

    this.sleepingSet.add(tid);
    this.readyList = this.readyList.filter(t => t.tid !== tid);

    logger.debug('SCHED', `sleep ${task.name} [${tid.slice(-6)}] ${ms}ms`);
    this._emit('sleep', task);

    return true;
  }

  /**
   * Bloquea una tarea esperando un evento externo. Devuelve una
   * promesa que se resolverá cuando otro componente llame a
   * `wake(tid, payload)`.
   */
  wait(tid, reason = 'generic') {
    const task = this.tasks.get(tid);
    if (!task) return Promise.resolve(null);

    task.state      = TASK_STATE.WAITING;
    task.waitReason = reason;

    this.waitingSet.add(tid);
    this.readyList = this.readyList.filter(t => t.tid !== tid);

    logger.debug('SCHED', `wait ${task.name} [${tid.slice(-6)}] reason=${reason}`);
    this._emit('wait', task);

    return new Promise(resolve => {
      task._resolveWait = resolve;
    });
  }

  /**
   * Despierta una tarea bloqueada (por sleep o wait).
   */
  wake(tid, payload = null) {
    const task = this.tasks.get(tid);
    if (!task) return false;

    if (this.sleepingSet.has(tid)) {
      this.sleepingSet.delete(tid);
    }
    if (this.waitingSet.has(tid)) {
      this.waitingSet.delete(tid);
    }

    task.state      = TASK_STATE.READY;
    task.sleepUntil = 0;
    task.waitReason = null;

    if (!this.readyList.find(t => t.tid === tid)) {
      this.readyList.push(task);
    }

    if (task._resolveWait) {
      const r = task._resolveWait;
      task._resolveWait = null;
      r(payload);
    }

    logger.debug('SCHED', `wake ${task.name} [${tid.slice(-6)}]`);
    this._emit('wake', task);

    return true;
  }

  /**
   * Cambia la prioridad base de una tarea en caliente.
   */
  setPriority(tid, newPriority) {
    const task = this.tasks.get(tid);
    if (!task) return false;
    task.basePrio = newPriority;
    logger.debug('SCHED', `setPriority ${task.name} → ${newPriority}`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // TICK — un ciclo del scheduler
  // ═══════════════════════════════════════════════════════════

  _tick() {
    const tickStart = performance.now();
    this.metrics.totalTicks++;

    // 1) Despertar dormidos cuyo timestamp ha vencido
    const now = Date.now();
    if (this.sleepingSet.size > 0) {
      for (const tid of [...this.sleepingSet]) {
        const task = this.tasks.get(tid);
        if (!task) { this.sleepingSet.delete(tid); continue; }
        if (task.sleepUntil <= now) {
          this.sleepingSet.delete(tid);
          task.state = TASK_STATE.READY;
          task.sleepUntil = 0;
          if (!this.readyList.find(t => t.tid === tid)) {
            this.readyList.push(task);
          }
          this._emit('wake', task);
        }
      }
    }

    // 2) Envejecer: cada tick en READY suma prioridad efectiva
    for (const task of this.readyList) {
      if (task.aging < MAX_AGING) {
        task.aging += 1;
      }
      task.effPrio = task.basePrio + task.aging;
    }

    // 3) Ordenar por prioridad efectiva (desc)
    this.readyList.sort((a, b) => b.effPrio - a.effPrio);

    // 4) Ejecutar con presupuesto
    const budgetEnd = tickStart + this.budgetMs;
    let executed = 0;
    let busyThisTick = 0;

    for (const task of this.readyList.slice()) {
      if (performance.now() >= budgetEnd) {
        this.metrics.budgetExceeded++;
        break;
      }
      if (task.state !== TASK_STATE.READY) continue;
      if (!task.fn) continue;

      // Ejecutar
      const t0 = performance.now();
      task.state = TASK_STATE.RUNNING;
      task.startedAt = now;
      task.lastRunAt = Date.now();
      this.metrics.contextSwitches++;

      try {
        task.fn();
        task.runs++;
      } catch (err) {
        task.errors++;
        this.metrics.errors++;
        logger.error('SCHED', `tarea "${task.name}" [${task.tid.slice(-6)}] lanzó excepción: ${err.message}`, err);
      }

      const t1 = performance.now();
      const dur = t1 - t0;

      task.lastMs  = dur;
      task.totalMs += dur;
      if (dur > task.maxMs) task.maxMs = dur;

      // Overrun: la tarea consumió más de la mitad del presupuesto del tick
      if (dur > this.budgetMs * 0.5) {
        task.overruns++;
        this.metrics.overruns++;
        task.aging = Math.max(0, task.aging - OVERRUN_PENALTY);
        task.effPrio = task.basePrio + task.aging;
      }

      busyThisTick += dur;
      executed++;

      // Si es periódica, reprogramar
      if (task.isPeriodic()) {
        task.state = TASK_STATE.SLEEPING;
        task.sleepUntil = Date.now() + task.interval;
        this.sleepingSet.add(task.tid);
        this.readyList = this.readyList.filter(t => t.tid !== task.tid);
      } else {
        // One-shot: si sigue viva y su fn no la ha matado, vuelve a READY
        if (this.tasks.has(task.tid) && task.state === TASK_STATE.RUNNING) {
          task.state = TASK_STATE.READY;
        }
      }
    }

    // 5) Métricas
    const elapsed = performance.now() - tickStart;
    this.metrics.lastTickMs = elapsed;
    this.metrics.busyMs += elapsed;

    // EMA del uso de CPU (porcentaje del tick nominal)
    const load = Math.min(100, (elapsed / this.tickMs) * 100);
    this._loadEma = this._loadEma * (1 - this._loadAlpha) + load * this._loadAlpha;
    this.metrics.cpuLoad = this._loadEma;

    // Media de tick (media móvil simple de últimas 100)
    this.metrics.avgTickMs = this.metrics.avgTickMs * 0.98 + elapsed * 0.02;

    // Idle: nada ejecutado
    if (executed === 0) this.metrics.idleTicks++;

    this._emit('tick', { elapsed, executed, ready: this.readyList.length });
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  onEvent(fn) {
    this._onTaskEvent.add(fn);
    return () => this._onTaskEvent.delete(fn);
  }

  _emit(type, task) {
    const payload = { type, ts: Date.now(), task };
    for (const fn of this._onTaskEvent) {
      try { fn(payload); } catch (_) { /* no romper el tick por un subscriber */ }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  getStats() {
    return {
      running:          this.running,
      paused:           !!this._paused,
      tickHz:           this.tickHz,
      tickMs:           this.tickMs,
      budgetMs:         this.budgetMs,
      tasks:            this.tasks.size,
      readyCount:       this.readyList.length,
      sleepingCount:    this.sleepingSet.size,
      waitingCount:     this.waitingSet.size,
      cpuLoad:          parseFloat(this.metrics.cpuLoad.toFixed(2)),
      lastTickMs:       parseFloat(this.metrics.lastTickMs.toFixed(3)),
      avgTickMs:        parseFloat(this.metrics.avgTickMs.toFixed(3)),
      ...this.metrics,
    };
  }

  list() {
    return [...this.tasks.values()].map(t => ({
      tid:        t.tid,
      name:       t.name,
      state:      t.state,
      basePrio:   t.basePrio,
      effPrio:    t.effPrio,
      aging:      t.aging,
      runs:       t.runs,
      lastMs:     parseFloat(t.lastMs.toFixed(3)),
      totalMs:    parseFloat(t.totalMs.toFixed(3)),
      maxMs:      parseFloat(t.maxMs.toFixed(3)),
      overruns:   t.overruns,
      errors:     t.errors,
      periodic:   t.isPeriodic(),
      interval:   t.interval,
    }));
  }

  dump() {
    const stats = this.getStats();
    const lines = [
      `Scheduler ${stats.running ? 'RUNNING' : 'STOPPED'} @ ${stats.tickHz}Hz`,
      `CPU load: ${stats.cpuLoad}%`,
      `Ticks: ${stats.totalTicks} (idle: ${stats.idleTicks}, budget exceeded: ${stats.budgetExceeded})`,
      `Context switches: ${stats.contextSwitches}`,
      `Tasks: ${stats.tasks} (ready=${stats.readyCount} sleeping=${stats.sleepingCount} waiting=${stats.waitingCount})`,
    ];
    return lines.join('\n');
  }
}
