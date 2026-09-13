// src/drivers/VThermal.jsx
// iOS Remastered — Driver VThermal
// Sensor térmico virtual con múltiples zonas, mitigación dinámica,
// política de throttling, histórico y eventos al HardwareBus.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, useReducer,
} from 'react';

/* ============================================================================
 * CONSTANTES
 * ========================================================================== */

export const THERMAL_STATE = {
  NOMINAL:  'nominal',
  FAIR:     'fair',
  SERIOUS:  'serious',
  CRITICAL: 'critical',
  SHUTDOWN: 'shutdown',
};

export const THERMAL_LEVELS = {
  nominal:  { level: 0, color: '#30d158', label: 'Nominal',   maxTemp: 35, throttle: 1.00 },
  fair:     { level: 1, color: '#ffd60a', label: 'Templado',  maxTemp: 40, throttle: 0.90 },
  serious:  { level: 2, color: '#ff9f0a', label: 'Serio',     maxTemp: 45, throttle: 0.70 },
  critical: { level: 3, color: '#ff453a', label: 'Crítico',   maxTemp: 50, throttle: 0.40 },
  shutdown: { level: 4, color: '#bf5af2', label: 'Apagado',   maxTemp: 60, throttle: 0.00 },
};

export const THERMAL_SENSORS = [
  { id: 'cpu',     label: 'CPU',          icon: 'cpu',                weight: 0.30, baseTemp: 32 },
  { id: 'gpu',     label: 'GPU',          icon: 'square.grid.3x3',    weight: 0.20, baseTemp: 33 },
  { id: 'battery', label: 'Batería',      icon: 'battery.100',        weight: 0.15, baseTemp: 28 },
  { id: 'display', label: 'Pantalla',     icon: 'display',            weight: 0.10, baseTemp: 30 },
  { id: 'radio',   label: 'Radio',        icon: 'antenna.radiowaves', weight: 0.10, baseTemp: 29 },
  { id: 'soc',     label: 'SoC',          icon: 'cpu',                weight: 0.15, baseTemp: 34 },
];

export const MITIGATION = {
  none:     { label: 'Sin mitigación',         action: 'none' },
  cpuDown:  { label: 'Reducir CPU',            action: 'cpu' },
  gpuDown:  { label: 'Reducir GPU',            action: 'gpu' },
  brightDn: { label: 'Bajar brillo pantalla',  action: 'brightness' },
  chargeOff:{ label: 'Detener carga',          action: 'charge' },
  radioOff: { label: 'Reducir radio',          action: 'radio' },
  full:     { label: 'Mitigación completa',    action: 'full' },
};

export const THERMAL_SCENARIOS = {
  idle:      { label: 'Reposo',       load: 0.05, ambient: 22 },
  light:     { label: 'Uso ligero',   load: 0.20, ambient: 24 },
  normal:    { label: 'Uso normal',   load: 0.45, ambient: 25 },
  heavy:     { label: 'Uso intenso',  load: 0.75, ambient: 27 },
  gaming:    { label: 'Juego',        load: 0.95, ambient: 28 },
  charging:  { label: 'Cargando',     load: 0.30, ambient: 26, charge: true },
  benchmark: { label: 'Benchmark',    load: 1.00, ambient: 30 },
};

/* ============================================================================
 * UTILIDADES
 * ========================================================================== */

let _seq = 0;
const uid = (p = 'tmp') => `${p}_${Date.now().toString(36)}_${(++_seq).toString(36)}`;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(n, decimals = 1) {
  const m = Math.pow(10, decimals);
  return Math.round(n * m) / m;
}

function now() { return Date.now(); }

/* Ruido blanco determinista por sensor + tiempo */
function noise(sensor, t) {
  const seed = sensor.id.charCodeAt(0) * 37 + Math.floor(t / 200);
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) - 0.5; // [-0.5, 0.5]
}

/* Estado térmico a partir de la temperatura */
function stateFromTemp(temp) {
  if (temp >= 55) return THERMAL_STATE.SHUTDOWN;
  if (temp >= 47) return THERMAL_STATE.CRITICAL;
  if (temp >= 43) return THERMAL_STATE.SERIOUS;
  if (temp >= 38) return THERMAL_STATE.FAIR;
  return THERMAL_STATE.NOMINAL;
}

/* Throttle factor a partir del estado */
function throttleFromState(state) {
  return THERMAL_LEVELS[state]?.throttle ?? 1;
}

/* ============================================================================
 * REDUCER
 * ========================================================================== */

const initialState = {
  ready: false,
  scenario: 'normal',
  ambient: 25,
  sensors: {},
  aggregate: 32,
  state: THERMAL_STATE.NOMINAL,
  throttle: 1,
  mitigations: [],
  history: [],
  peakTemp: 0,
  peakAt: 0,
  warnings: 0,
  shutdowns: 0,
  manualOverride: null,
  charging: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'INIT':
      return { ...state, ...action.state, ready: true };

    case 'SET_SCENARIO': {
      const sc = THERMAL_SCENARIOS[action.scenario] || THERMAL_SCENARIOS.normal;
      return {
        ...state,
        scenario: action.scenario,
        ambient: sc.ambient,
        charging: !!sc.charge,
      };
    }

    case 'SET_AMBIENT':
      return { ...state, ambient: clamp(action.value, -10, 50) };

    case 'TICK': {
      const s = action.payload;
      const newState = stateFromTemp(s.aggregate);
      const throttle = throttleFromState(newState);
      const level = THERMAL_LEVELS[newState];

      const mitigations = [];
      if (newState === THERMAL_STATE.FAIR) {
        mitigations.push('brightDn');
      } else if (newState === THERMAL_STATE.SERIOUS) {
        mitigations.push('brightDn', 'cpuDown');
      } else if (newState === THERMAL_STATE.CRITICAL) {
        mitigations.push('brightDn', 'cpuDown', 'gpuDown', 'chargeOff');
      } else if (newState === THERMAL_STATE.SHUTDOWN) {
        mitigations.push('full');
      }

      const history = [
        ...state.history.slice(-119),
        { t: s.t, temp: s.aggregate, state: newState },
      ];

      const peakTemp = s.aggregate > state.peakTemp ? s.aggregate : state.peakTemp;
      const peakAt = s.aggregate > state.peakTemp ? s.t : state.peakAt;

      const crossedWarn = state.state !== newState &&
        (newState === THERMAL_STATE.SERIOUS || newState === THERMAL_STATE.CRITICAL);
      const crossedShutdown = state.state !== newState && newState === THERMAL_STATE.SHUTDOWN;

      return {
        ...state,
        sensors: s.sensors,
        aggregate: s.aggregate,
        state: newState,
        throttle,
        mitigations,
        history,
        peakTemp,
        peakAt,
        warnings: state.warnings + (crossedWarn ? 1 : 0),
        shutdowns: state.shutdowns + (crossedShutdown ? 1 : 0),
      };
    }

    case 'OVERRIDE':
      return { ...state, manualOverride: action.value };

    case 'CLEAR_OVERRIDE':
      return { ...state, manualOverride: null };

    case 'RESET_STATS':
      return { ...state, peakTemp: 0, peakAt: 0, warnings: 0, shutdowns: 0, history: [] };

    case 'SHUTDOWN':
      return {
        ...state,
        state: THERMAL_STATE.SHUTDOWN,
        aggregate: 60,
        throttle: 0,
        mitigations: ['full'],
      };

    default:
      return state;
  }
}

/* ============================================================================
 * MOTOR DE SIMULACIÓN
 * ========================================================================== */

function simulateThermal({ scenario, ambient, elapsed, prevSensors, charging }) {
  const sc = THERMAL_SCENARIOS[scenario] || THERMAL_SCENARIOS.normal;
  const load = sc.load;
  const t = now();

  const sensors = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const s of THERMAL_SENSORS) {
    // Temperatura objetivo del sensor
    const target = s.baseTemp + ambient * 0.35 + load * 18 + (charging && s.id === 'battery' ? 6 : 0);

    // Suavizado: la temperatura se mueve hacia el target
    const prev = prevSensors[s.id]?.temp ?? target - 2;
    const diff = target - prev;
    const inertia = s.id === 'battery' ? 0.02 : 0.06;
    const temp = prev + diff * inertia + noise(s, t) * 0.4;

    sensors[s.id] = {
      id: s.id,
      label: s.label,
      icon: s.icon,
      temp: round(clamp(temp, -20, 90), 1),
      weight: s.weight,
      t,
    };

    weightedSum += sensors[s.id].temp * s.weight;
    totalWeight += s.weight;
  }

  const aggregate = round(weightedSum / totalWeight, 1);

  return { sensors, aggregate, t, elapsed };
}

/* ============================================================================
 * HOOK PRINCIPAL
 * ========================================================================== */

function useThermal({ tickMs = 500, onEvent } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const timerRef = useRef(null);
  const startRef = useRef(now());
  const subscribersRef = useRef(new Set());

  // Mantener una referencia del estado actual para el loop
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /* --------------------------- Loop de simulación --------------------------- */

  useEffect(() => {
    const tick = () => {
      const current = stateRef.current;
      const override = current.manualOverride;

      let scenario = current.scenario;
      let ambient = current.ambient;
      if (override) {
        scenario = override.scenario ?? scenario;
        ambient = override.ambient ?? ambient;
      }

      const result = simulateThermal({
        scenario,
        ambient,
        elapsed: now() - startRef.current,
        prevSensors: current.sensors,
        charging: current.charging || (override && override.charging),
      });

      dispatch({ type: 'TICK', payload: result });

      // Notificar a suscriptores
      for (const fn of subscribersRef.current) {
        try { fn(result); } catch (e) { console.error(e); }
      }
    };

    // Primer tick inmediato
    tick();

    timerRef.current = setInterval(tick, tickMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickMs]);

  /* --------------------------- Eventos al OS --------------------------- */

  const prevStateRef = useRef(state.state);
  useEffect(() => {
    if (!onEvent) return;
    if (state.state !== prevStateRef.current) {
      const from = prevStateRef.current;
      const to = state.state;
      prevStateRef.current = to;

      if (to === THERMAL_STATE.SERIOUS) {
        onEvent({ type: 'thermal:serious', from, to, temp: state.aggregate });
      } else if (to === THERMAL_STATE.CRITICAL) {
        onEvent({ type: 'thermal:critical', from, to, temp: state.aggregate });
      } else if (to === THERMAL_STATE.SHUTDOWN) {
        onEvent({ type: 'thermal:shutdown', from, to, temp: state.aggregate });
      } else if (to === THERMAL_STATE.NOMINAL) {
        onEvent({ type: 'thermal:nominal', from, to, temp: state.aggregate });
      }
    }
  }, [state.state, state.aggregate, onEvent]);

  /* --------------------------- API --------------------------- */

  const api = useMemo(() => ({
    setScenario(scenario) {
      if (!THERMAL_SCENARIOS[scenario]) return false;
      dispatch({ type: 'SET_SCENARIO', scenario });
      return true;
    },

    setAmbient(value) {
      dispatch({ type: 'SET_AMBIENT', value });
    },

    setOverride(value) {
      dispatch({ type: 'OVERRIDE', value });
    },

    clearOverride() {
      dispatch({ type: 'CLEAR_OVERRIDE' });
    },

    forceShutdown() {
      dispatch({ type: 'SHUTDOWN' });
    },

    resetStats() {
      dispatch({ type: 'RESET_STATS' });
    },

    subscribe(fn) {
      subscribersRef.current.add(fn);
      return () => subscribersRef.current.delete(fn);
    },

    getState() {
      return stateRef.current;
    },

    getSensors() {
      return Object.values(stateRef.current.sensors);
    },

    getSensor(id) {
      return stateRef.current.sensors[id] || null;
    },
  }), []);

  return { state, dispatch, api };
}

/* ============================================================================
 * HOOKS AUXILIARES
 * ========================================================================== */

function useThermalState(state) {
  return THERMAL_LEVELS[state] || THERMAL_LEVELS.nominal;
}

function useThermalColor(temp) {
  if (temp >= 50) return '#bf5af2';
  if (temp >= 45) return '#ff453a';
  if (temp >= 40) return '#ff9f0a';
  if (temp >= 35) return '#ffd60a';
  return '#30d158';
}

/* ============================================================================
 * COMPONENTES REUTILIZABLES
 * ========================================================================== */

function ThermalBar({ temp, max = 60, height = 6, showLabel = false }) {
  const color = useThermalColor(temp);
  const pct = clamp((temp / max) * 100, 0, 100);
  return (
    <div className="vt-bar-wrap">
      <div className="vt-bar" style={{ height }}>
        <div
          className="vt-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {showLabel && (
        <span className="vt-bar-label" style={{ color }}>
          {round(temp, 1)} °C
        </span>
      )}
    </div>
  );
}

function ThermalChip({ state }) {
  const meta = THERMAL_LEVELS[state] || THERMAL_LEVELS.nominal;
  return (
    <span className="vt-chip" style={{ background: meta.color }}>
      {meta.label}
    </span>
  );
}

function ThermalSensorRow({ sensor }) {
  const color = useThermalColor(sensor.temp);
  return (
    <div className="vt-sensor-row">
      <span className="vt-sensor-label">{sensor.label}</span>
      <div className="vt-sensor-bar">
        <div
          className="vt-sensor-bar-fill"
          style={{ width: `${clamp((sensor.temp / 60) * 100, 0, 100)}%`, background: color }}
        />
      </div>
      <span className="vt-sensor-temp" style={{ color }}>
        {sensor.temp.toFixed(1)}°
      </span>
    </div>
  );
}

/* ============================================================================
 * CLASE VThermal — driver para el HardwareBus
 * ========================================================================== */

class VThermalDriver {
  constructor(opts = {}) {
    this.name = 'VThermal';
    this.version = '1.0.0';
    this.tickMs = opts.tickMs || 500;
    this.startRef = now();
    this.timer = null;
    this.listeners = new Set();
    this.state = {
      scenario: 'normal',
      ambient: 25,
      sensors: {},
      aggregate: 32,
      state: THERMAL_STATE.NOMINAL,
      throttle: 1,
      mitigations: [],
      peakTemp: 0,
    };
    this.charging = false;
  }

  probe() {
    return {
      ok: true,
      name: this.name,
      sensors: THERMAL_SENSORS.map((s) => s.id),
      scenario: this.state.scenario,
    };
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      const result = simulateThermal({
        scenario: this.state.scenario,
        ambient: this.state.ambient,
        elapsed: now() - this.startRef,
        prevSensors: this.state.sensors,
        charging: this.charging,
      });

      const newState = stateFromTemp(result.aggregate);
      const throttle = throttleFromState(newState);

      this.state = {
        ...this.state,
        sensors: result.sensors,
        aggregate: result.aggregate,
        state: newState,
        throttle,
        peakTemp: Math.max(this.state.peakTemp, result.aggregate),
      };

      for (const fn of this.listeners) {
        try { fn(this.state); } catch (e) { console.error(e); }
      }
    };

    tick();
    this.timer = setInterval(tick, this.tickMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  read() {
    return this.state;
  }

  readSensor(id) {
    return this.state.sensors[id] || null;
  }

  readAll() {
    return Object.values(this.state.sensors);
  }

  setScenario(scenario) {
    if (!THERMAL_SCENARIOS[scenario]) return false;
    const sc = THERMAL_SCENARIOS[scenario];
    this.state.scenario = scenario;
    this.state.ambient = sc.ambient;
    this.charging = !!sc.charge;
    return true;
  }

  setAmbient(value) {
    this.state.ambient = clamp(value, -10, 50);
  }

  getThrottle() {
    return this.state.throttle;
  }

  getState() {
    return this.state.state;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  shutdown() {
    this.state.state = THERMAL_STATE.SHUTDOWN;
    this.state.aggregate = 60;
    this.state.throttle = 0;
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (e) { console.error(e); }
    }
  }

  destroy() {
    this.stop();
    this.listeners.clear();
  }
}

/* ============================================================================
 * EXPORTS
 * ========================================================================== */

export {
  VThermalDriver,
  useThermal,
  useThermalState,
  useThermalColor,
  simulateThermal,
  stateFromTemp,
  throttleFromState,
  ThermalBar,
  ThermalChip,
  ThermalSensorRow,
  THERMAL_LEVELS,
};

export default VThermal;
