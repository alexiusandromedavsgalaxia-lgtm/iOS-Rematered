// src/drivers/VBattery.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VBattery (Virtual Battery + Power Management)
 * ═══════════════════════════════════════════════════════════════
 *
 * Modela la batería Li-Ion del dispositivo y el subsistema de
 * gestión de energía completo que un iPhone lleva:
 *
 *   - Celdas Li-Ion con voltaje, corriente, capacidad real/diseño
 *   - Estado: charging / discharging / full / not-charging / unplugged
 *   - Fuentes de carga: USB-C (45W), MagSafe (25W), Qi (7.5W)
 *   - Carga rápida 0-50% en 30min con curva realista CC/CV
 *   - Battery Health (% capacidad actual vs diseño), ciclos, temp
 *   - Optimized Battery Charging (espera a 80% si predice que estarás
 *     enchufado mucho tiempo)
 *   - Low Power Mode (iOS) con su impacto en consumo
 *   - Consumo por subsistema (CPU, GPU, display, radios, etc)
 *     → esto es lo que ve la app Ajustes → Batería
 *   - Temperatura de la batería + protección térmica (carga lenta
 *     por frío/calor, parada de carga si se pasa)
 *   - Throttling por batería baja o envejecida
 *   - Predicción de tiempo restante (con EMA)
 *   - IRQs: IRQ_POWER, IRQ_BATTERY
 *   - Suscriptores: level, charging, health, temperature, source
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const BatteryState = {
  UNPLUGGED:      'unplugged',
  CHARGING:       'charging',
  FULL:           'full',
  NOT_CHARGING:   'not-charging',
  OPTIMIZED_HOLD: 'optimized-hold',    // cargando hasta 80% y esperando
  ERROR:          'error',
};

export const ChargingSource = {
  NONE:       'none',
  USB_C:      'usb-c',
  MAGSAFE:    'magsafe',
  QI:         'qi',
  LIGHTNING:  'lightning',
};

export const BatteryHealth = {
  NOMINAL:         'nominal',          // > 90%
  FAIR:            'fair',             // 80-90%
  DEGRADED:        'degraded',         // 70-80%
  SERVICE_REQUIRED:'service-required', // < 70%
};

export const LowPowerMode = {
  OFF: 'off',
  ON:  'on',
  AUTO:'auto',
};

// Capacidades de carga por fuente (watts)
const SOURCE_POWER_W = {
  [ChargingSource.NONE]:      0,
  [ChargingSource.USB_C]:     45,
  [ChargingSource.MAGSAFE]:   25,
  [ChargingSource.QI]:        7.5,
  [ChargingSource.LIGHTNING]: 18,
};

// Consumo base por subsistema (mW) — usado para estimar drenaje
const SUBSYSTEM_BASE_MW = {
  cpu:      120,
  gpu:      80,
  display:  450,
  wifi:     130,
  cellular: 180,
  bt:       15,
  gps:      25,
  audio:    40,
  camera:   300,
  sensors:  30,
  storage:  20,
  taptic:   5,
  modem:    50,
  misc:     60,
};

// ───────────────────────────────────────────────────────────────
// Utilidad: clamp
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ───────────────────────────────────────────────────────────────
// Curva de carga CC/CV
// ───────────────────────────────────────────────────────────────
/**
 * Calcula la corriente de carga efectiva (en W) según el % de carga.
 *
 *  - Fase CC (0-80%): carga a potencia máxima (limitada por fuente y
 *    temperatura).
 *  - Fase CV (80-100%): la potencia decrece linealmente hasta casi 0.
 *  - Por encima de 95%: goteo (trickle) a ~1W.
 */
function chargingPowerCurve(level, maxWatts, tempC) {
  if (level >= 0.999) return 0;

  // Factor de temperatura: frío (<10°C) carga lento, calor (>40°C)
  // también carga lento por protección.
  let tempFactor = 1.0;
  if (tempC < 10) tempFactor = 0.4;
  else if (tempC < 20) tempFactor = 0.75;
  else if (tempC > 45) tempFactor = 0.3;
  else if (tempC > 40) tempFactor = 0.6;
  else if (tempC > 35) tempFactor = 0.85;

  let curveFactor;
  if (level < 0.80) {
    // CC: potencia plena (con un poco de suavizado al acercarse a 80)
    curveFactor = 1.0 - Math.pow(level / 0.80, 6) * 0.15;
  } else if (level < 0.95) {
    // CV: decae linealmente de ~0.85 a 0.3
    const t = (level - 0.80) / 0.15;
    curveFactor = 0.85 - t * 0.55;
  } else {
    // Trickle
    const t = (level - 0.95) / 0.05;
    curveFactor = 0.30 - t * 0.27;
  }

  return maxWatts * tempFactor * curveFactor;
}

// ───────────────────────────────────────────────────────────────
// Batería física
// ───────────────────────────────────────────────────────────────
class BatteryCell {
  constructor() {
    this.designMah     = DEVICE_MODEL.battery.capacityMah;   // 3582
    this.designWh      = DEVICE_MODEL.battery.wh;            // 13.86
    this.nominalV      = DEVICE_MODEL.battery.voltage;       // 3.87

    // Salud
    this.healthPct     = DEVICE_MODEL.battery.healthPct;     // 100
    this.cycleCount    = DEVICE_MODEL.battery.cycleCount;    // 42
    this.maxCapacityMah = this.designMah * (this.healthPct / 100);

    // Estado actual
    this.level         = 0.87;             // 0..1
    this.voltageV      = 3.87;
    this.currentA      = 0;                // + cargando, - descargando
    this.tempC         = 28.5;

    // Timestamps
    this.lastUpdateTs  = Date.now();
    this.lastFullChargeTs = null;
    this.lastDeepDischargeTs = null;

    // Contadores
    this.totalChargedWh = 0;
    this.totalDischargedWh = 0;
    this.fullCyclesEquivalent = 0;
  }

  wh() {
    return this.maxCapacityMah / 1000 * this.nominalV;
  }

  currentWh() {
    return this.level * this.wh();
  }

  remainingMah() {
    return this.level * this.maxCapacityMah;
  }

  /** Voltaje estimado a partir del nivel (curva Li-Ion) */
  estimateVoltage(level) {
    // Aproximación: 3.0V vacío, 4.2V lleno, con zona plana 3.7-3.9
    if (level <= 0.05) return 3.0 + level * 6;         // 3.0 - 3.3
    if (level <= 0.90) return 3.5 + (level - 0.05) * 0.6;  // 3.53 - 4.01
    return 4.01 + (level - 0.90) * 1.9;                // 4.01 - 4.2
  }

  applyCharge(chargeWh, tempC) {
    if (chargeWh <= 0) return;
    const prevLevel = this.level;
    const wh = this.wh();
    this.level = clamp(this.level + chargeWh / wh, 0, 1);
    this.totalChargedWh += chargeWh;

    // Detectar carga completa
    if (prevLevel < 1 && this.level >= 1) {
      this.lastFullChargeTs = Date.now();
      // Un ciclo = una carga completa equivalente
      this.fullCyclesEquivalent += 1;
      this.cycleCount += 1;
      // La salud se degrada muy lentamente con cada ciclo
      this.healthPct = Math.max(50, this.healthPct - 0.0015);
      this.maxCapacityMah = this.designMah * (this.healthPct / 100);
      logger.info('VBattery', `ciclo completo: ciclos=${this.cycleCount} salud=${this.healthPct.toFixed(2)}%`);
    }

    // Actualizar voltaje y temperatura
    this.voltageV = this.estimateVoltage(this.level);
    // La carga calienta la batería (menos a mayor temperatura)
    const heatDelta = chargeWh * 0.15 * (tempC > 40 ? 0.3 : 1.0);
    this.tempC += heatDelta;
    this.tempC = clamp(this.tempC, -20, 60);
  }

  applyDischarge(dischargeWh) {
    if (dischargeWh <= 0) return;
    this.level = clamp(this.level - dischargeWh / this.wh(), 0, 1);
    this.totalDischargedWh += dischargeWh;
    this.voltageV = this.estimateVoltage(this.level);
  }

  dissipateHeat(dtMs, ambientC = 25) {
    const k = 0.0008;
    const diff = this.tempC - ambientC;
    if (diff > 0) {
      this.tempC -= diff * k * dtMs;
      if (this.tempC < ambientC) this.tempC = ambientC;
    }
  }

  healthCategory() {
    if (this.healthPct >= 90) return BatteryHealth.NOMINAL;
    if (this.healthPct >= 80) return BatteryHealth.FAIR;
    if (this.healthPct >= 70) return BatteryHealth.DEGRADED;
    return BatteryHealth.SERVICE_REQUIRED;
  }
}

// ───────────────────────────────────────────────────────────────
// Contabilidad por subsistema
// ───────────────────────────────────────────────────────────────
class SubsystemTracker {
  constructor() {
    this.accumulatedMj = {};
    this.instantMw = {};
    for (const k of Object.keys(SUBSYSTEM_BASE_MW)) {
      this.accumulatedMj[k] = 0;
      this.instantMw[k] = 0;
    }
    this.startedAt = Date.now();
  }

  /**
   * Actualiza el consumo instantáneo por subsistema.
   * @param {object} overrides  { cpu: mw, gpu: mw, ... } — si no se pasa
   *                            un subsistema, se usa la base.
   */
  update(overrides = {}) {
    for (const k of Object.keys(SUBSYSTEM_BASE_MW)) {
      const target = overrides[k] ?? SUBSYSTEM_BASE_MW[k];
      // Suavizar cambios para evitar saltos bruscos
      this.instantMw[k] = this.instantMw[k] * 0.7 + target * 0.3;
    }
  }

  accumulate(dtMs) {
    for (const k of Object.keys(this.instantMw)) {
      this.accumulatedMj[k] += this.instantMw[k] * dtMs / 1000;
    }
  }

  totalMw() {
    return Object.values(this.instantMw).reduce((a, b) => a + b, 0);
  }

  totalMj() {
    return Object.values(this.accumulatedMj).reduce((a, b) => a + b, 0);
  }

  breakdown() {
    const total = this.totalMw() || 1;
    const out = [];
    for (const [k, mw] of Object.entries(this.instantMw)) {
      out.push({
        subsystem: k,
        mw: parseFloat(mw.toFixed(1)),
        percent: parseFloat(((mw / total) * 100).toFixed(2)),
        accumulatedMj: parseFloat(this.accumulatedMj[k].toFixed(2)),
      });
    }
    out.sort((a, b) => b.mw - a.mw);
    return out;
  }

  reset() {
    for (const k of Object.keys(this.accumulatedMj)) {
      this.accumulatedMj[k] = 0;
    }
    this.startedAt = Date.now();
  }
}

// ───────────────────────────────────────────────────────────────
// VBattery — driver completo
// ───────────────────────────────────────────────────────────────
export class VBattery {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VBattery';
    this.model = `Li-Ion ${DEVICE_MODEL.battery.capacityMah}mAh`;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = BatteryState.UNPLUGGED;

    // Celda física
    this.cell = new BatteryCell();

    // Fuente de carga
    this.source        = ChargingSource.NONE;
    this.sourceWatts   = 0;
    this.sourcePluggedAt = null;

    // Config
    this.lowPowerMode     = LowPowerMode.OFF;
    this.optimizedCharging= true;
    this.optimizedTarget  = 0.80;
    this.thermalProtection= true;

    // Modo "hold" (optimized charging esperando)
    this.holdUntilMorning = false;
    this.holdStartedAt    = null;

    // Contabilidad
    this.tracker = new SubsystemTracker();

    // Predicción
    this.timeToEmptyMs = null;
    this.timeToFullMs  = null;

    // Historial
    this.historySize = 240;
    this.history = {
      ts:       [],
      level:    [],
      voltage:  [],
      current:  [],
      tempC:    [],
      powerMw:  [],
    };

    // Suscriptores
    this.subscribers        = new Set();
    this.levelSubscribers   = new Set();
    this.chargingSubscribers= new Set();
    this.healthSubscribers  = new Set();

    // Tick loop
    this.tickIntervalMs = 500;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      ticks:                  0,
      chargingSessions:       0,
      fullCharges:            0,
      lowBatteryEvents:       0,
      criticalBatteryEvents:  0,
      thermalSlowdowns:       0,
      thermalStops:           0,
      lowPowerActivations:    0,
      peakPowerMw:            0,
      peakTempC:              this.cell.tempC,
      peakChargeWatts:        0,
      startedAt:              null,
    };

    // Control de eventos
    this._lastWarnLevel     = null;
    this._lastNotifiedLevel = null;

    logger.kernel('VBattery',
      `creado: ${this.model} level=${(this.cell.level * 100).toFixed(0)}% ` +
      `health=${this.cell.healthPct}% cycles=${this.cell.cycleCount}`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VBattery',
      `✓ init: ${this.model}, ${this.cell.designWh.toFixed(2)}Wh, ` +
      `health=${this.cell.healthPct}%, cycles=${this.cell.cycleCount}`);
    this.bus?.raiseInterrupt?.('IRQ_POWER', {
      source: 'vbattery', event: 'ready',
    }, 'vbattery');
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
    logger.info('VBattery', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK — simulación de carga/descarga
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const dtMs = this.tickIntervalMs;

    // 1) Disipar calor de la batería
    this.cell.dissipateHeat(dtMs, this._ambientTemp());

    // 2) Actualizar consumo de subsistemas según drivers activos
    const overrides = this._estimateSubsystemLoads();
    this.tracker.update(overrides);
    this.tracker.accumulate(dtMs);

    // 3) Aplicar consumo o carga
    if (this.state === BatteryState.CHARGING || this.state === BatteryState.OPTIMIZED_HOLD) {
      this._applyCharging(dtMs);
    } else {
      this._applyDischarge(dtMs);
    }

    // 4) Actualizar estado público
    this._updateState();

    // 5) Predicciones
    this._updatePredictions();

    // 6) Detección de eventos (bajo, crítico, etc)
    this._detectEvents();

    // 7) Historial
    this._pushHistory();

    // 8) Notificar
    this._emit();

    this.metrics.ticks++;
    this.tickCount++;
  }

  _ambientTemp() {
    // La temperatura ambiente puede venir de otro driver (VCamera, VCPU),
    // por defecto 25°C. Aquí lo dejamos fijo.
    return 25;
  }

  /**
   * Estima las cargas por subsistema según los drivers enlazados al bus.
   * Esto es lo que en iOS hace "powerd" y "backboardd" para reportar
   * a Ajustes → Batería.
   */
  _estimateSubsystemLoads() {
    const overrides = {};
    const devices = this.bus?.devices || {};

    // CPU: consumo proporcional a la carga media
    if (devices.cpu) {
      const load = devices.cpu.avgLoad?.() ?? 30;
      overrides.cpu = SUBSYSTEM_BASE_MW.cpu * (0.4 + load / 100 * 2.0);
    }

    // GPU: proporcional a su carga
    if (devices.gpu) {
      const snap = devices.gpu.getSnapshot?.();
      if (snap) {
        const load = snap.avgLoad ?? 10;
        overrides.gpu = SUBSYSTEM_BASE_MW.gpu * (0.3 + load / 100 * 2.5);
      }
    }

    // Pantalla: proporcional al brillo
    if (devices.display) {
      const snap = devices.display.getSnapshot?.();
      if (snap) {
        const brightness = snap.brightness ?? 0.5;
        // Brillo 0% = 150mW, brillo 100% = 900mW
        overrides.display = 150 + brightness * 750;
        // True Tone / HDR / 120Hz: +10%
        if (snap.trueTone) overrides.display *= 1.05;
        if (snap.proMotion) overrides.display *= 1.08;
      }
    }

    // WiFi: proporcional a throughput
    if (devices.wifi) {
      const snap = devices.wifi.getSnapshot?.();
      if (snap) {
        const txMbps = snap.throughput?.txMbps ?? 0;
        const rxMbps = snap.throughput?.rxMbps ?? 0;
        const idle = snap.state === 'connected' ? 80 : 20;
        const active = (txMbps + rxMbps) * 3;   // 3mW por Mbps
        overrides.wifi = idle + active;
      }
    }

    // Bluetooth
    if (devices.bt) {
      const snap = devices.bt.getSnapshot?.();
      if (snap) {
        const n = snap.connected ?? 0;
        const txMbps = snap.throughput?.txMbps ?? 0;
        const rxMbps = snap.throughput?.rxMbps ?? 0;
        overrides.bt = 10 + n * 5 + (txMbps + rxMbps) * 2;
      }
    }

    // Audio (si hay taptic engine o futuros altavoces)
    if (devices.taptic) {
      const snap = devices.taptic.getSnapshot?.();
      if (snap) {
        const mw = snap.motor?.powerMw ?? 0;
        // El motor táctil consume intermitentemente
        overrides.taptic = SUBSYSTEM_BASE_MW.taptic + mw;
      }
    }

    // Camera (si está activa)
    if (devices.camera?.isActive?.()) {
      overrides.camera = SUBSYSTEM_BASE_MW.camera;
    }

    return overrides;
  }

  _applyCharging(dtMs) {
    const cell = this.cell;
    const dtSec = dtMs / 1000;

    // Optimized charging: si estamos en hold, no cargamos
    if (this.state === BatteryState.OPTIMIZED_HOLD) {
      // Consumir el consumo residual para no subir de nivel
      const drainW = this.tracker.totalMw() / 1000;
      const drainWh = drainW * dtSec / 3600;
      cell.applyDischarge(drainWh);
      // Pero la energía consumida la compensa el cargador
      cell.applyCharge(drainWh, cell.tempC);
      return;
    }

    // Protección térmica: si la célula pasa de 45°C, paramos
    if (this.thermalProtection && cell.tempC > 45) {
      if (this.state !== BatteryState.NOT_CHARGING) {
        this.metrics.thermalStops++;
        logger.warn('VBattery', `carga detenida por temperatura (${cell.tempC.toFixed(1)}°C)`);
      }
      this.state = BatteryState.NOT_CHARGING;
      return;
    }
    if (this.thermalProtection && cell.tempC > 40) {
      // Carga lenta
      this.metrics.thermalSlowdowns++;
    }

    // Calcular potencia de carga según curva
    let maxWatts = this.sourceWatts;
    if (this.optimizedCharging && cell.level >= this.optimizedTarget && this.holdUntilMorning) {
      // Ya llegamos al 80% y estamos en hold
      this.state = BatteryState.OPTIMIZED_HOLD;
      this.holdStartedAt = this.holdStartedAt ?? Date.now();
      logger.info('VBattery', 'optimized charging: hold hasta mañana');
      return;
    }

    const chargeWatts = chargingPowerCurve(cell.level, maxWatts, cell.tempC);
    if (chargeWatts > 0) {
      const chargeWh = (chargeWatts * dtSec) / 3600;
      cell.applyCharge(chargeWh, cell.tempC);
      this.metrics.peakChargeWatts = Math.max(this.metrics.peakChargeWatts, chargeWatts);

      // El propio consumo del sistema se resta de la carga neta
      const drainW = this.tracker.totalMw() / 1000;
      const drainWh = (drainW * dtSec) / 3600;
      cell.applyDischarge(drainWh);

      // Corriente efectiva (A) = potencia / voltaje
      cell.currentA = (chargeWatts - drainW) / cell.voltageV;
    }
  }

  _applyDischarge(dtMs) {
    const cell = this.cell;
    const dtSec = dtMs / 1000;

    // Consumo total en W
    let watts = this.tracker.totalMw() / 1000;

    // Low Power Mode reduce el consumo
    if (this.lowPowerMode === LowPowerMode.ON) {
      watts *= 0.75;
    }

    const dischargeWh = (watts * dtSec) / 3600;
    cell.applyDischarge(dischargeWh);
    cell.currentA = -watts / cell.voltageV;

    // Calor por descarga (menor que por carga)
    cell.tempC += watts * dtSec * 0.00015;
    cell.tempC = Math.min(cell.tempC, 55);
  }

  _updateState() {
    const cell = this.cell;

    // Detectar si hay fuente enchufada
    if (this.source === ChargingSource.NONE) {
      this.state = cell.level >= 0.999 ? BatteryState.FULL : BatteryState.UNPLUGGED;
      return;
    }

    // Fuente presente
    if (cell.level >= 0.999) {
      this.state = BatteryState.FULL;
      return;
    }

    // Optimized charging hold?
    if (this.holdUntilMorning && cell.level >= this.optimizedTarget && this.optimizedCharging) {
      this.state = BatteryState.OPTIMIZED_HOLD;
      return;
    }

    // Temperatura
    if (this.thermalProtection && cell.tempC > 45) {
      this.state = BatteryState.NOT_CHARGING;
      return;
    }

    this.state = BatteryState.CHARGING;
  }

  _updatePredictions() {
    const cell = this.cell;
    const mw = this.tracker.totalMw();

    if (this.state === BatteryState.UNPLUGGED && mw > 0) {
      const remainingWh = cell.currentWh();
      const hours = remainingWh / (mw / 1000);
      this.timeToEmptyMs = hours * 3600 * 1000;
    } else {
      this.timeToEmptyMs = null;
    }

    if ((this.state === BatteryState.CHARGING) && this.source !== ChargingSource.NONE) {
      const remainingWh = cell.wh() - cell.currentWh();
      const watts = this.sourceWatts;
      if (watts > 0) {
        const hours = remainingWh / watts;
        this.timeToFullMs = hours * 3600 * 1000;
      }
    } else {
      this.timeToFullMs = null;
    }
  }

  _detectEvents() {
    const level = this.cell.level;

    // Umbrales de "level changed" (cada 1%)
    const levelPct = Math.floor(level * 100);
    if (this._lastNotifiedLevel !== levelPct) {
      this._lastNotifiedLevel = levelPct;
      for (const fn of this.levelSubscribers) {
        try { fn({ level, levelPct }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_BATTERY', {
        source: 'vbattery', event: 'level-changed', level, levelPct,
      }, 'vbattery');
    }

    // Batería baja (20%)
    if (level <= 0.20 && this._lastWarnLevel !== 'low') {
      this._lastWarnLevel = 'low';
      this.metrics.lowBatteryEvents++;
      logger.warn('VBattery', `batería baja: ${(level * 100).toFixed(0)}%`);
      this.bus?.raiseInterrupt?.('IRQ_POWER', {
        source: 'vbattery', event: 'low-battery', level,
      }, 'vbattery');
    }
    if (level > 0.25) this._lastWarnLevel = this._lastWarnLevel === 'low' ? null : this._lastWarnLevel;

    // Batería crítica (10%)
    if (level <= 0.10 && this._lastWarnLevel !== 'critical') {
      this._lastWarnLevel = 'critical';
      this.metrics.criticalBatteryEvents++;
      logger.warn('VBattery', `batería crítica: ${(level * 100).toFixed(0)}%`);
      this.bus?.raiseInterrupt?.('IRQ_POWER', {
        source: 'vbattery', event: 'critical-battery', level,
      }, 'vbattery');
    }

    // Batería vacía (0.5%)
    if (level <= 0.005) {
      logger.error('VBattery', '☠ batería agotada');
      this.bus?.raiseInterrupt?.('IRQ_POWER', {
        source: 'vbattery', event: 'battery-empty',
      }, 'vbattery');
    }
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.level.push(this.cell.level);
    this.history.voltage.push(this.cell.voltageV);
    this.history.current.push(this.cell.currentA);
    this.history.tempC.push(this.cell.tempC);
    this.history.powerMw.push(this.tracker.totalMw());
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // API DE CARGA
  // ═══════════════════════════════════════════════════════════

  /**
   * Conecta una fuente de carga.
   * @param {string} source  ChargingSource.*
   */
  plug(source) {
    if (!Object.values(ChargingSource).includes(source) || source === ChargingSource.NONE) {
      logger.warn('VBattery', `plug: fuente desconocida ${source}`);
      return false;
    }
    if (this.source !== ChargingSource.NONE) {
      this.unplug('replaced');
    }

    this.source = source;
    this.sourceWatts = SOURCE_POWER_W[source] || 0;
    this.sourcePluggedAt = Date.now();
    this.metrics.chargingSessions++;

    // Reset de holds
    this.holdUntilMorning = false;
    this.holdStartedAt = null;

    logger.info('VBattery', `🔌 conectado: ${source} (${this.sourceWatts}W)`);
    this.bus?.raiseInterrupt?.('IRQ_POWER', {
      source: 'vbattery', event: 'charging-started', sourceName: source, watts: this.sourceWatts,
    }, 'vbattery');
    this._emitCharging({ type: 'started', source, watts: this.sourceWatts });
    this._emit();
    return true;
  }

  unplug(reason = 'user') {
    if (this.source === ChargingSource.NONE) return false;
    const prev = this.source;
    this.source = ChargingSource.NONE;
    this.sourceWatts = 0;
    this.sourcePluggedAt = null;
    this.holdUntilMorning = false;
    this.holdStartedAt = null;

    logger.info('VBattery', `🔌 desconectado (era ${prev}, ${reason})`);
    this.bus?.raiseInterrupt?.('IRQ_POWER', {
      source: 'vbattery', event: 'charging-stopped', prevSource: prev, reason,
    }, 'vbattery');
    this._emitCharging({ type: 'stopped', prevSource: prev, reason });
    this._emit();
    return true;
  }

  /**
   * Activa/desactiva la carga optimizada (iOS: "Carga optimizada").
   * Cuando está activa y el sistema predice que el usuario no va a
   * necesitar el móvil en horas, se queda al 80% hasta el momento
   * estimado de desconexión.
   */
  setOptimizedCharging(on) {
    this.optimizedCharging = !!on;
    if (!on) {
      this.holdUntilMorning = false;
    }
    logger.info('VBattery', `optimized charging = ${this.optimizedCharging}`);
    this._emit();
  }

  /**
   * Fuerza el "hold hasta mañana" (para demos / simulación).
   */
  enableOvernightHold() {
    if (!this.optimizedCharging) {
      logger.warn('VBattery', 'enableOvernightHold requiere optimizedCharging');
      return false;
    }
    this.holdUntilMorning = true;
    this.holdStartedAt = Date.now();
    logger.info('VBattery', 'overnight hold activado (cargará hasta 80%)');
    this._emit();
    return true;
  }

  disableOvernightHold() {
    if (!this.holdUntilMorning) return false;
    this.holdUntilMorning = false;
    this.holdStartedAt = null;
    logger.info('VBattery', 'overnight hold desactivado, carga completa');
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // LOW POWER MODE
  // ═══════════════════════════════════════════════════════════

  setLowPowerMode(mode) {
    if (!Object.values(LowPowerMode).includes(mode)) {
      logger.warn('VBattery', `low power mode inválido: ${mode}`);
      return false;
    }
    if (this.lowPowerMode === mode) return true;
    const prev = this.lowPowerMode;
    this.lowPowerMode = mode;

    if (mode === LowPowerMode.ON && prev !== LowPowerMode.ON) {
      this.metrics.lowPowerActivations++;
      logger.info('VBattery', '⚡ Low Power Mode ACTIVADO');
    } else if (mode === LowPowerMode.OFF) {
      logger.info('VBattery', 'Low Power Mode desactivado');
    } else if (mode === LowPowerMode.AUTO) {
      logger.info('VBattery', 'Low Power Mode AUTO (se activa al 20%)');
    }

    this.bus?.raiseInterrupt?.('IRQ_POWER', {
      source: 'vbattery', event: 'low-power-mode', mode,
    }, 'vbattery');
    this._emit();
    return true;
  }

  /**
   * AUTO: activa LPM al 20% y lo desactiva al 80%.
   * Se llama desde el propio tick.
   */
  _autoLowPower() {
    if (this.lowPowerMode !== LowPowerMode.AUTO) return;
    const level = this.cell.level;
    if (level <= 0.20 && this._autoLpmActive !== true) {
      this._autoLpmActive = true;
      logger.info('VBattery', 'AUTO: activando Low Power Mode (nivel 20%)');
    } else if (level >= 0.80 && this._autoLpmActive === true) {
      this._autoLpmActive = false;
      logger.info('VBattery', 'AUTO: desactivando Low Power Mode (nivel 80%)');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isCharging() {
    return this.state === BatteryState.CHARGING || this.state === BatteryState.OPTIMIZED_HOLD;
  }

  isPlugged() {
    return this.source !== ChargingSource.NONE;
  }

  level() { return this.cell.level; }
  levelPct() { return Math.floor(this.cell.level * 100); }
  health() { return this.cell.healthPct; }
  cycles() { return this.cell.cycleCount; }
  tempC() { return this.cell.tempC; }

  getUsageBySubsystem() {
    return this.tracker.breakdown();
  }

  getUsageSinceBoot() {
    const totalMj = this.tracker.totalMj();
    return {
      sinceMs: Date.now() - this.tracker.startedAt,
      totalMj: parseFloat(totalMj.toFixed(2)),
      totalWh: parseFloat((totalMj / 3600).toFixed(4)),
      breakdown: this.tracker.breakdown(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onLevelChange(fn) {
    this.levelSubscribers.add(fn);
    return () => this.levelSubscribers.delete(fn);
  }

  onChargingChange(fn) {
    this.chargingSubscribers.add(fn);
    return () => this.chargingSubscribers.delete(fn);
  }

  onHealthChange(fn) {
    this.healthSubscribers.add(fn);
    return () => this.healthSubscribers.delete(fn);
  }

  _emit() {
    this._autoLowPower();
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VBattery', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitCharging(evt) {
    for (const fn of this.chargingSubscribers) {
      try { fn(evt); } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    const cell = this.cell;
    return {
      model:         this.model,
      state:         this.state,
      level:         parseFloat(cell.level.toFixed(4)),
      levelPct:      Math.floor(cell.level * 100),
      voltageV:      parseFloat(cell.voltageV.toFixed(3)),
      currentA:      parseFloat(cell.currentA.toFixed(3)),
      tempC:         parseFloat(cell.tempC.toFixed(2)),
      designMah:     cell.designMah,
      maxCapacityMah:parseFloat(cell.maxCapacityMah.toFixed(0)),
      remainingMah:  parseFloat(cell.remainingMah().toFixed(0)),
      healthPct:     parseFloat(cell.healthPct.toFixed(2)),
      healthCategory:cell.healthCategory(),
      cycleCount:    cell.cycleCount,
      source:        this.source,
      sourceWatts:   this.sourceWatts,
      lowPowerMode:  this.lowPowerMode,
      optimized:     this.optimizedCharging,
      holdUntilMorning: this.holdUntilMorning,
      timeToEmptyMs: this.timeToEmptyMs,
      timeToFullMs:  this.timeToFullMs,
      subsystemMw:   parseFloat(this.tracker.totalMw().toFixed(1)),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      source:      this.source,
      metrics:     { ...this.metrics },
      cell: {
        healthPct: parseFloat(this.cell.healthPct.toFixed(2)),
        cycles:    this.cell.cycleCount,
        maxMah:    parseFloat(this.cell.maxCapacityMah.toFixed(0)),
      },
      tracker: {
        totalMw: parseFloat(this.tracker.totalMw().toFixed(1)),
        totalMj: parseFloat(this.tracker.totalMj().toFixed(2)),
      },
    };
  }

  dump() {
    const s = this.getStats();
    const cell = this.cell;
    const lines = [
      `VBattery [${s.state}] — ${s.model}`,
      `  nivel:       ${(cell.level * 100).toFixed(0)}% (${cell.remainingMah().toFixed(0)}/${cell.maxCapacityMah.toFixed(0)}mAh)`,
      `  voltaje:     ${cell.voltageV.toFixed(3)}V  corriente: ${cell.currentA >= 0 ? '+' : ''}${cell.currentA.toFixed(3)}A`,
      `  potencia:    ${this.tracker.totalMw().toFixed(0)}mW (total consumo)`,
      `  temp:        ${cell.tempC.toFixed(1)}°C`,
      `  salud:       ${cell.healthPct.toFixed(1)}% (${cell.healthCategory()}) ciclos=${cell.cycleCount}`,
      `  fuente:      ${this.source} (${this.sourceWatts}W)`,
      `  lowPower:    ${this.lowPowerMode}`,
      `  optimized:   ${this.optimizedCharging}${this.holdUntilMorning ? ' (hold activo)' : ''}`,
    ];
    if (this.timeToEmptyMs) lines.push(`  tiempo restante: ${(this.timeToEmptyMs / 3600000).toFixed(2)}h`);
    if (this.timeToFullMs)  lines.push(`  tiempo a lleno:  ${(this.timeToFullMs / 3600000).toFixed(2)}h`);
    lines.push('  consumo por subsistema:');
    for (const s of this.tracker.breakdown()) {
      lines.push(`    ${s.subsystem.padEnd(10)} ${String(s.mw).padStart(7)}mW  ${String(s.percent).padStart(5)}%`);
    }
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:      [...this.history.ts],
      level:   [...this.history.level],
      voltage: [...this.history.voltage],
      current: [...this.history.current],
      tempC:   [...this.history.tempC],
      powerMw: [...this.history.powerMw],
    };
  }
}
