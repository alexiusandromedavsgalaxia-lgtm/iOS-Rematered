// src/drivers/VThermal.jsx
// iOS Remastered — Virtual thermal driver
// Sensor térmico virtual, simulación, throttling y API para HardwareBus.

import { useEffect, useMemo, useReducer, useRef } from 'react';

export const THERMAL_STATE = {
  NOMINAL: 'nominal',
  FAIR: 'fair',
  SERIOUS: 'serious',
  CRITICAL: 'critical',
  SHUTDOWN: 'shutdown',
};

export const THERMAL_LEVELS = {
  nominal: { level: 0, color: '#30d158', label: 'Nominal', maxTemp: 35, throttle: 1 },
  fair: { level: 1, color: '#ffd60a', label: 'Templado', maxTemp: 40, throttle: 0.9 },
  serious: { level: 2, color: '#ff9f0a', label: 'Serio', maxTemp: 45, throttle: 0.7 },
  critical: { level: 3, color: '#ff453a', label: 'Crítico', maxTemp: 50, throttle: 0.4 },
  shutdown: { level: 4, color: '#bf5af2', label: 'Apagado', maxTemp: 60, throttle: 0 },
};

export const THERMAL_SENSORS = [
  { id: 'cpu', label: 'CPU', icon: 'cpu', weight: 0.3, baseTemp: 32 },
  { id: 'gpu', label: 'GPU', icon: 'square.grid.3x3', weight: 0.2, baseTemp: 33 },
  { id: 'battery', label: 'Batería', icon: 'battery.100', weight: 0.15, baseTemp: 28 },
  { id: 'display', label: 'Pantalla', icon: 'display', weight: 0.1, baseTemp: 30 },
  { id: 'radio', label: 'Radio', icon: 'antenna.radiowaves', weight: 0.1, baseTemp: 29 },
  { id: 'soc', label: 'SoC', icon: 'cpu', weight: 0.15, baseTemp: 34 },
];

export const MITIGATION = {
  none: { label: 'Sin mitigación', action: 'none' },
  cpuDown: { label: 'Reducir CPU', action: 'cpu' },
  gpuDown: { label: 'Reducir GPU', action: 'gpu' },
  brightDn: { label: 'Bajar brillo pantalla', action: 'brightness' },
  chargeOff: { label: 'Detener carga', action: 'charge' },
  radioOff: { label: 'Reducir radio', action: 'radio' },
  full: { label: 'Mitigación completa', action: 'full' },
};

export const THERMAL_SCENARIOS = {
  idle: { label: 'Reposo', load: 0.05, ambient: 22 },
  light: { label: 'Uso ligero', load: 0.2, ambient: 24 },
  normal: { label: 'Uso normal', load: 0.45, ambient: 25 },
  heavy: { label: 'Uso intenso', load: 0.75, ambient: 27 },
  gaming: { label: 'Juego', load: 0.95, ambient: 28 },
  charging: { label: 'Cargando', load: 0.3, ambient: 26, charge: true },
  benchmark: { label: 'Benchmark', load: 1, ambient: 30 },
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function now() {
  return Date.now();
}

function noise(sensor, timestamp) {
  const seed = sensor.id.charCodeAt(0) * 37 + Math.floor(timestamp / 200);
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) - 0.5;
}

export function stateFromTemp(temp) {
  if (temp >= 55) return THERMAL_STATE.SHUTDOWN;
  if (temp >= 47) return THERMAL_STATE.CRITICAL;
  if (temp >= 43) return THERMAL_STATE.SERIOUS;
  if (temp >= 38) return THERMAL_STATE.FAIR;
  return THERMAL_STATE.NOMINAL;
}

export function throttleFromState(state) {
  return THERMAL_LEVELS[state]?.throttle ?? 1;
}

export function simulateThermal({
  scenario = 'normal',
  ambient = 25,
  elapsed = 0,
  prevSensors = {},
  charging = false,
} = {}) {
  const selected = THERMAL_SCENARIOS[scenario] || THERMAL_SCENARIOS.normal;
  const load = selected.load;
  const timestamp = now();
  const sensors = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const sensor of THERMAL_SENSORS) {
    const target = sensor.baseTemp + ambient * 0.35 + load * 18
      + (charging && sensor.id === 'battery' ? 6 : 0);
    const previous = Number.isFinite(prevSensors[sensor.id]?.temp)
      ? prevSensors[sensor.id].temp
      : target - 2;
    const inertia = sensor.id === 'battery' ? 0.02 : 0.06;
    const temperature = previous + (target - previous) * inertia + noise(sensor, timestamp) * 0.4;
    const temp = round(clamp(temperature, -20, 90), 1);

    sensors[sensor.id] = {
      id: sensor.id,
      label: sensor.label,
      icon: sensor.icon,
      temp,
      weight: sensor.weight,
      t: timestamp,
    };

    weightedSum += temp * sensor.weight;
    totalWeight += sensor.weight;
  }

  return {
    sensors,
    aggregate: round(weightedSum / totalWeight, 1),
    t: timestamp,
    elapsed,
  };
}

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
      const scenario = THERMAL_SCENARIOS[action.scenario] ? action.scenario : 'normal';
      const selected = THERMAL_SCENARIOS[scenario];
      return {
        ...state,
        scenario,
        ambient: selected.ambient,
        charging: !!selected.charge,
      };
    }
    case 'SET_AMBIENT':
      return { ...state, ambient: clamp(action.value, -10, 50) };
    case 'OVERRIDE':
      return { ...state, manualOverride: action.value && typeof action.value === 'object' ? action.value : null };
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
    case 'TICK': {
      const payload = action.payload;
      const thermalState = stateFromTemp(payload.aggregate);
      const throttle = throttleFromState(thermalState);
      const mitigations = thermalState === THERMAL_STATE.FAIR
        ? ['brightDn']
        : thermalState === THERMAL_STATE.SERIOUS
          ? ['brightDn', 'cpuDown']
          : thermalState === THERMAL_STATE.CRITICAL
            ? ['brightDn', 'cpuDown', 'gpuDown', 'chargeOff']
            : thermalState === THERMAL_STATE.SHUTDOWN
              ? ['full']
              : [];
      const crossedWarn = state.state !== thermalState
        && (thermalState === THERMAL_STATE.SERIOUS || thermalState === THERMAL_STATE.CRITICAL);
      const crossedShutdown = state.state !== thermalState && thermalState === THERMAL_STATE.SHUTDOWN;
      const isNewPeak = payload.aggregate > state.peakTemp;

      return {
        ...state,
        ready: true,
        sensors: payload.sensors,
        aggregate: payload.aggregate,
        state: thermalState,
        throttle,
        mitigations,
        history: [...state.history.slice(-119), {
          t: payload.t,
          temp: payload.aggregate,
          state: thermalState,
        }],
        peakTemp: isNewPeak ? payload.aggregate : state.peakTemp,
        peakAt: isNewPeak ? payload.t : state.peakAt,
        warnings: state.warnings + (crossedWarn ? 1 : 0),
        shutdowns: state.shutdowns + (crossedShutdown ? 1 : 0),
      };
    }
    default:
      return state;
  }
}

export function useThermal({ tickMs = 500, onEvent } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const timerRef = useRef(null);
  const startRef = useRef(now());
  const subscribersRef = useRef(new Set());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const tick = () => {
      const current = stateRef.current;
      const override = current.manualOverride || {};
      const scenario = override.scenario ?? current.scenario;
      const ambient = override.ambient ?? current.ambient;
      const result = simulateThermal({
        scenario,
        ambient,
        elapsed: now() - startRef.current,
        prevSensors: current.sensors,
        charging: current.charging || !!override.charging,
      });
      dispatch({ type: 'TICK', payload: result });
      for (const subscriber of subscribersRef.current) {
        try { subscriber(result); } catch (error) { console.error(error); }
      }
    };

    tick();
    timerRef.current = setInterval(tick, Math.max(50, Number(tickMs) || 500));
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [tickMs]);

  const previousStateRef = useRef(state.state);
  useEffect(() => {
    if (typeof onEvent !== 'function') return;
    if (state.state === previousStateRef.current) return;
    const from = previousStateRef.current;
    const to = state.state;
    previousStateRef.current = to;
    if (to === THERMAL_STATE.SERIOUS || to === THERMAL_STATE.CRITICAL
      || to === THERMAL_STATE.SHUTDOWN || to === THERMAL_STATE.NOMINAL) {
      onEvent({ type: `thermal:${to}`, from, to, temp: state.aggregate });
    }
  }, [state.state, state.aggregate, onEvent]);

  const api = useMemo(() => ({
    setScenario(scenario) {
      if (!THERMAL_SCENARIOS[scenario]) return false;
      dispatch({ type: 'SET_SCENARIO', scenario });
      return true;
    },
    setAmbient(value) { dispatch({ type: 'SET_AMBIENT', value }); },
    setOverride(value) { dispatch({ type: 'OVERRIDE', value }); },
    clearOverride() { dispatch({ type: 'CLEAR_OVERRIDE' }); },
    forceShutdown() { dispatch({ type: 'SHUTDOWN' }); },
    resetStats() { dispatch({ type: 'RESET_STATS' }); },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subscribersRef.current.add(fn);
      return () => subscribersRef.current.delete(fn);
    },
    getState() { return stateRef.current; },
    getSensors() { return Object.values(stateRef.current.sensors); },
    getSensor(id) { return stateRef.current.sensors[id] || null; },
  }), []);

  return { state, dispatch, api };
}

export function useThermalState(state) {
  return THERMAL_LEVELS[state] || THERMAL_LEVELS.nominal;
}

export function useThermalColor(temp) {
  if (temp >= 50) return '#bf5af2';
  if (temp >= 45) return '#ff453a';
  if (temp >= 40) return '#ff9f0a';
  if (temp >= 35) return '#ffd60a';
  return '#30d158';
}

export function ThermalBar({ temp = 0, max = 60, height = 6, showLabel = false }) {
  const color = useThermalColor(temp);
  const pct = clamp((temp / max) * 100, 0, 100);
  return (
    <div className="vt-bar-wrap">
      <div className="vt-bar" style={{ height }}>
        <div className="vt-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      {showLabel && <span className="vt-bar-label" style={{ color }}>{round(temp, 1)} °C</span>}
    </div>
  );
}

export function ThermalChip({ state }) {
  const meta = THERMAL_LEVELS[state] || THERMAL_LEVELS.nominal;
  return <span className="vt-chip" style={{ background: meta.color }}>{meta.label}</span>;
}

export function ThermalSensorRow({ sensor }) {
  const safeSensor = sensor || { label: 'Sensor', temp: 0 };
  const color = useThermalColor(safeSensor.temp);
  return (
    <div className="vt-sensor-row">
      <span className="vt-sensor-label">{safeSensor.label}</span>
      <div className="vt-sensor-bar">
        <div
          className="vt-sensor-bar-fill"
          style={{ width: `${clamp((safeSensor.temp / 60) * 100, 0, 100)}%`, background: color }}
        />
      </div>
      <span className="vt-sensor-temp" style={{ color }}>{round(safeSensor.temp, 1)}°</span>
    </div>
  );
}

export class VThermalDriver {
  constructor(options = {}) {
    this.name = 'VThermal';
    this.version = '1.1.0';
    this.bus = options && typeof options === 'object' ? options : null;
    this.tickMs = Math.max(50, Number(options?.tickMs) || 500);
    this.startRef = now();
    this.timer = null;
    this.listeners = new Set();
    this.links = new Map();
    this.charging = false;
    this.state = {
      scenario: 'normal',
      ambient: 25,
      sensors: {},
      aggregate: 32,
      state: THERMAL_STATE.NOMINAL,
      throttle: 1,
      mitigations: [],
      peakTemp: 0,
      peakAt: 0,
    };
  }

  probe() {
    return {
      ok: true,
      name: this.name,
      version: this.version,
      sensors: THERMAL_SENSORS.map((sensor) => sensor.id),
      scenario: this.state.scenario,
      temperatureC: this.state.aggregate,
    };
  }

  powerOn() { this.start(); return this.probe(); }

  powerOff() { this.stop(); return true; }

  start() {
    if (this.timer) return this;
    const tick = () => {
      const result = simulateThermal({
        scenario: this.state.scenario,
        ambient: this.state.ambient,
        elapsed: now() - this.startRef,
        prevSensors: this.state.sensors,
        charging: this.charging,
      });
      const thermalState = stateFromTemp(result.aggregate);
      this.state = {
        ...this.state,
        sensors: result.sensors,
        aggregate: result.aggregate,
        state: thermalState,
        throttle: throttleFromState(thermalState),
        mitigations: thermalState === THERMAL_STATE.SHUTDOWN ? ['full'] : [],
        peakTemp: Math.max(this.state.peakTemp, result.aggregate),
        peakAt: result.aggregate >= this.state.peakTemp ? result.t : this.state.peakAt,
      };
      for (const listener of this.listeners) {
        try { listener(this.state); } catch (error) { console.error(error); }
      }
      if (thermalState === THERMAL_STATE.SHUTDOWN && this.bus?.raiseIRQ) {
        this.bus.raiseIRQ(21, { kind: 'shutdown', tempC: result.aggregate });
      }
    };
    tick();
    this.timer = setInterval(tick, this.tickMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  read() { return this.state; }
  readSensor(id) { return this.state.sensors[id] || null; }
  readAll() { return Object.values(this.state.sensors); }
  getThrottle() { return this.state.throttle; }
  getState() { return this.state.state; }

  setScenario(scenario) {
    if (!THERMAL_SCENARIOS[scenario]) return false;
    const selected = THERMAL_SCENARIOS[scenario];
    this.state.scenario = scenario;
    this.state.ambient = selected.ambient;
    this.charging = !!selected.charge;
    return true;
  }

  setAmbient(value) {
    this.state.ambient = clamp(value, -10, 50);
    return this.state.ambient;
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  shutdown() {
    this.state = {
      ...this.state,
      state: THERMAL_STATE.SHUTDOWN,
      aggregate: 60,
      throttle: 0,
      mitigations: ['full'],
      peakTemp: Math.max(this.state.peakTemp, 60),
      peakAt: now(),
    };
    for (const listener of this.listeners) {
      try { listener(this.state); } catch (error) { console.error(error); }
    }
  }

  destroy() {
    this.stop();
    this.listeners.clear();
    this.links.clear();
  }

  link(name, driver) {
    if (driver) this.links.set(name, driver);
    return this;
  }

  linkCPU(driver) { return this.link('cpu', driver); }
  linkGPU(driver) { return this.link('gpu', driver); }
  linkStorage(driver) { return this.link('storage', driver); }
  linkBattery(driver) { return this.link('battery', driver); }
  linkWiFi(driver) { return this.link('wifi', driver); }
  linkBT(driver) { return this.link('bt', driver); }
  linkCellular(driver) { return this.link('cellular', driver); }
  linkDisplay(driver) { return this.link('display', driver); }
}

// HardwareBus imports { VThermal } and instantiates it as a driver.
// Keep the public name as a class alias so the named import is always defined.
export const VThermal = VThermalDriver;
