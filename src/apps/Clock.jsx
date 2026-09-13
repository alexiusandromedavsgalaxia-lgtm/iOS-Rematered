// src/apps/Clock.jsx
// iOS Remastered — Clock.app
// Reloj: Mundial, Alarma, Cronómetro, Temporizador.
// Calca el diseño y comportamiento de la app Reloj de iOS.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, useReducer,
} from 'react';

import { useOS } from '../context/OSContext.jsx';
import { toast } from '../ui/Toast.jsx';
import { alert } from '../ui/Alert.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Blur } from '../ui/Blur.jsx';
import { TapHandler, useGesture } from '../ui/GestureHandler.jsx';

/* ============================================================================
 * PERSISTENCIA
 * ========================================================================== */

const CLOCK_DB = '/private/var/mobile/Library/Clock/Clock.json';

async function persist(os, state) {
  try {
    if (!os?.fs) return;
    await os.fs.mkdir('/private/var/mobile/Library/Clock', { recursive: true }).catch(() => {});
    await os.fs.writeFile(CLOCK_DB, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      alarms: state.alarms,
      worldClocks: state.worldClocks,
      timer: state.timer,
      stopwatchLaps: state.stopwatchLaps,
      settings: state.settings,
    }));
  } catch { /* best effort */ }
}

async function hydrate(os) {
  try {
    if (!os?.fs) return null;
    const raw = await os.fs.readFile(CLOCK_DB);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/* ============================================================================
 * CIUDADES
 * ========================================================================== */

const CITIES = [
  { id: 'cupertino', name: 'Cupertino',  tz: 'America/Los_Angeles', flag: '🇺🇸' },
  { id: 'ny',        name: 'Nueva York', tz: 'America/New_York',    flag: '🇺🇸' },
  { id: 'london',    name: 'Londres',    tz: 'Europe/London',       flag: '🇬🇧' },
  { id: 'paris',     name: 'París',      tz: 'Europe/Paris',        flag: '🇫🇷' },
  { id: 'madrid',    name: 'Madrid',     tz: 'Europe/Madrid',       flag: '🇪🇸' },
  { id: 'berlin',    name: 'Berlín',     tz: 'Europe/Berlin',       flag: '🇩🇪' },
  { id: 'rome',      name: 'Roma',       tz: 'Europe/Rome',         flag: '🇮🇹' },
  { id: 'moscow',    name: 'Moscú',      tz: 'Europe/Moscow',       flag: '🇷🇺' },
  { id: 'dubai',     name: 'Dubái',      tz: 'Asia/Dubai',          flag: '🇦🇪' },
  { id: 'delhi',     name: 'Nueva Delhi',tz: 'Asia/Kolkata',        flag: '🇮🇳' },
  { id: 'bangkok',   name: 'Bangkok',    tz: 'Asia/Bangkok',        flag: '🇹🇭' },
  { id: 'singapore', name: 'Singapur',   tz: 'Asia/Singapore',      flag: '🇸🇬' },
  { id: 'tokyo',     name: 'Tokio',      tz: 'Asia/Tokyo',          flag: '🇯🇵' },
  { id: 'seoul',     name: 'Seúl',       tz: 'Asia/Seoul',          flag: '🇰🇷' },
  { id: 'sydney',    name: 'Sídney',     tz: 'Australia/Sydney',    flag: '🇦🇺' },
  { id: 'auckland',  name: 'Auckland',   tz: 'Pacific/Auckland',    flag: '🇳🇿' },
  { id: 'honolulu',  name: 'Honolulú',   tz: 'Pacific/Honolulu',    flag: '🇺🇸' },
  { id: 'saopaulo',  name: 'São Paulo',  tz: 'America/Sao_Paulo',   flag: '🇧🇷' },
  { id: 'mexico',    name: 'Ciudad de México', tz: 'America/Mexico_City', flag: '🇲🇽' },
  { id: 'buenosaires', name: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires', flag: '🇦🇷' },
];

/* ============================================================================
 * UTILS
 * ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function fmtClock(date, { seconds = false, h24 = false } = {}) {
  let h = date.getHours();
  const m = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  let suffix = '';
  if (!h24) {
    suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
  }
  const hh = h24 ? pad2(h) : String(h);
  return `${hh}:${m}${seconds ? ':' + s : ''}${suffix ? ' ' + suffix : ''}`;
}

function fmtTimeMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function fmtStopwatch(ms) {
  const total = Math.max(0, Math.floor(ms));
  const cs = Math.floor((total % 1000) / 10);
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function offsetLabel(tz) {
  try {
    const now = new Date();
    const loc = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const diffH = Math.round((loc - utc) / 3600000);
    const sign = diffH >= 0 ? '+' : '−';
    const a = Math.abs(diffH);
    return `GMT${sign}${a}`;
  } catch { return 'GMT'; }
}

function relativeToNow(tz) {
  try {
    const now = new Date();
    const here = new Date(now.toLocaleString('en-US'));
    const there = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const diffH = Math.round((there - here) / 3600000);
    if (diffH === 0) return 'Hoy, misma hora';
    if (diffH > 0) return `Hoy, +${diffH} h`;
    return `Hoy, ${diffH} h`;
  } catch { return ''; }
}

function dayParts(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return {
      weekday: get('weekday'),
      day: get('day'),
      month: get('month'),
    };
  } catch { return { weekday: '', day: '', month: '' }; }
}

/* ============================================================================
 * REDUCER
 * ========================================================================== */

const initialState = {
  ready: false,
  tab: 'world',       // world | alarm | stopwatch | timer
  alarms: [],
  worldClocks: [
    { id: 'w_cup', cityId: 'cupertino', label: 'Cupertino' },
    { id: 'w_ny',  cityId: 'ny',        label: 'Nueva York' },
    { id: 'w_lon', cityId: 'london',    label: 'Londres' },
  ],
  stopwatchRunning: false,
  stopwatchStart: 0,
  stopwatchElapsed: 0,
  stopwatchLaps: [],
  timer: {
    presetMs: 5 * 60 * 1000,
    remainingMs: 5 * 60 * 1000,
    running: false,
    startAt: 0,
    originalMs: 5 * 60 * 1000,
    sound: 'Radar',
    vibrate: true,
  },
  settings: {
    h24: false,
    snoozeMin: 9,
  },
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.state, ready: true };

    case 'SET_TAB':
      return { ...state, tab: action.tab };

    case 'ADD_ALARM': {
      const a = {
        id: `al_${Date.now().toString(36)}`,
        hour: action.hour,
        minute: action.minute,
        label: action.label || 'Alarma',
        days: action.days || [],
        enabled: true,
        sound: action.sound || 'Radar',
        snooze: action.snooze !== false,
      };
      return { ...state, alarms: [...state.alarms, a].sort(alarmSort) };
    }
    case 'UPDATE_ALARM':
      return {
        ...state,
        alarms: state.alarms.map((a) => a.id === action.id ? { ...a, ...action.patch } : a)
          .sort(alarmSort),
      };
    case 'DELETE_ALARM':
      return { ...state, alarms: state.alarms.filter((a) => a.id !== action.id) };

    case 'ADD_WORLD_CLOCK':
      return {
        ...state,
        worldClocks: [...state.worldClocks, {
          id: `w_${Date.now().toString(36)}`,
          cityId: action.cityId,
          label: action.label,
        }],
      };
    case 'DELETE_WORLD_CLOCK':
      return { ...state, worldClocks: state.worldClocks.filter((w) => w.id !== action.id) };

    case 'STOPWATCH_START':
      return {
        ...state,
        stopwatchRunning: true,
        stopwatchStart: Date.now() - state.stopwatchElapsed,
      };
    case 'STOPWATCH_STOP':
      return {
        ...state,
        stopwatchRunning: false,
        stopwatchElapsed: Date.now() - state.stopwatchStart,
      };
    case 'STOPWATCH_RESET':
      return { ...state, stopwatchRunning: false, stopwatchStart: 0, stopwatchElapsed: 0, stopwatchLaps: [] };
    case 'STOPWATCH_TICK':
      return { ...state, stopwatchElapsed: action.elapsed };
    case 'STOPWATCH_LAP':
      return {
        ...state,
        stopwatchLaps: [
          { id: `lap_${Date.now().toString(36)}`, at: action.elapsed, split: action.split },
          ...state.stopwatchLaps,
        ],
      };

    case 'TIMER_SET_PRESET':
      return {
        ...state,
        timer: {
          ...state.timer,
          presetMs: action.ms,
          remainingMs: action.ms,
          originalMs: action.ms,
          running: false,
          startAt: 0,
        },
      };
    case 'TIMER_START':
      return { ...state, timer: { ...state.timer, running: true, startAt: Date.now() } };
    case 'TIMER_PAUSE':
      return {
        ...state,
        timer: {
          ...state.timer,
          running: false,
          remainingMs: Math.max(0, state.timer.remainingMs - (Date.now() - state.timer.startAt)),
        },
      };
    case 'TIMER_RESUME':
      return { ...state, timer: { ...state.timer, running: true, startAt: Date.now() } };
    case 'TIMER_RESET':
      return {
        ...state,
        timer: {
          ...state.timer,
          running: false,
          remainingMs: state.timer.presetMs,
          originalMs: state.timer.presetMs,
          startAt: 0,
        },
      };
    case 'TIMER_TICK':
      return { ...state, timer: { ...state.timer, remainingMs: action.remaining } };
    case 'TIMER_DONE':
      return {
        ...state,
        timer: { ...state.timer, running: false, remainingMs: 0, startAt: 0 },
      };
    case 'TIMER_PATCH':
      return { ...state, timer: { ...state.timer, ...action.patch } };

    case 'SET_SETTING':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };

    default:
      return state;
  }
}

function alarmSort(a, b) {
  return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute);
}

/* ============================================================================
 * HOOK PRINCIPAL
 * ========================================================================== */

function useClock(os) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveRef = useRef(null);

  useEffect(() => {
    (async () => {
      const db = await hydrate(os);
      if (db) {
        dispatch({
          type: 'HYDRATE',
          state: {
            alarms: db.alarms || [],
            worldClocks: db.worldClocks || initialState.worldClocks,
            stopwatchLaps: db.stopwatchLaps || [],
            timer: { ...initialState.timer, ...(db.timer || {}), running: false, startAt: 0 },
            settings: { ...initialState.settings, ...(db.settings || {}) },
          },
        });
      } else {
        dispatch({ type: 'HYDRATE', state: {} });
      }
    })();
  }, [os]);

  useEffect(() => {
    if (!state.ready) return;
    clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => persist(os, state), 700);
    return () => clearTimeout(saveRef.current);
  }, [state, os]);

  return [state, dispatch];
}

/* ============================================================================
 * TABS
 * ========================================================================== */

const TABS = [
  { id: 'world',     label: 'Mundial',      icon: 'globe' },
  { id: 'alarm',     label: 'Alarma',       icon: 'alarm' },
  { id: 'stopwatch', label: 'Cronómetro',   icon: 'stopwatch' },
  { id: 'timer',     label: 'Temporizador', icon: 'hourglass' },
];

function TabBar({ tab, onChange, alarmsActive, timerActive }) {
  return (
    <div className="ck-tabbar">
      {TABS.map((t) => {
        const active = tab === t.id;
        let showDot = false;
        if (t.id === 'alarm' && alarmsActive) showDot = true;
        if (t.id === 'timer' && timerActive) showDot = true;
        return (
          <button
            key={t.id}
            className={`ck-tab ${active ? 'is-active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            <span className="ck-tab-icon-wrap">
              <Icon name={t.icon} size={22} color={active ? '#ff9f0a' : '#8e8e93'} filled={active} />
              {showDot && <span className="ck-tab-dot" />}
            </span>
            <span className="ck-tab-label">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * TAB MUNDIAL
 * ========================================================================== */

function WorldClockTab({ state, dispatch, now }) {
  const [adding, setAdding] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  const clocks = state.worldClocks;

  const filtered = useMemo(() => {
    if (!pickerQuery.trim()) return CITIES;
    const q = pickerQuery.trim().toLowerCase();
    return CITIES.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.tz.toLowerCase().includes(q)
    );
  }, [pickerQuery]);

  const onAdd = (city) => {
    dispatch({ type: 'ADD_WORLD_CLOCK', cityId: city.id, label: city.name });
    setAdding(false);
    setPickerQuery('');
    toast.success(`Añadido ${city.name}`);
  };

  const onDelete = async (wc) => {
    const ok = await alert.destructive({
      title: '¿Eliminar reloj?',
      message: `Se eliminará ${wc.label} de la lista.`,
      confirmText: 'Eliminar',
    });
    if (ok) dispatch({ type: 'DELETE_WORLD_CLOCK', id: wc.id });
  };

  return (
    <div className="ck-world">
      {clocks.length === 0 ? (
        <div className="ck-empty">
          <Icon name="globe" size={48} color="#48484a" />
          <p>Sin relojes mundiales</p>
          <button className="ck-btn" onClick={() => setAdding(true)}>
            Añadir ciudad
          </button>
        </div>
      ) : (
        <div className="ck-world-list">
          {clocks.map((wc) => {
            const city = CITIES.find((c) => c.id === wc.cityId);
            if (!city) return null;
            let date;
            try {
              date = new Date(now.toLocaleString('en-US', { timeZone: city.tz }));
            } catch { date = now; }
            const rel = relativeToNow(city.tz);
            const isNight = date.getHours() < 7 || date.getHours() >= 20;
            const dp = dayParts(city.tz);

            return (
              <TapHandler key={wc.id} onLongPress={() => onDelete(wc)}>
                <div className="ck-world-row">
                  <div className="ck-world-left">
                    <span className="ck-world-rel">{rel}</span>
                    <span className="ck-world-name">{wc.label}</span>
                    <span className="ck-world-date">
                      {dp.weekday}, {dp.day} de {dp.month}
                    </span>
                  </div>
                  <div className="ck-world-right">
                    <span className={`ck-world-time ${isNight ? 'is-night' : ''}`}>
                      {fmtClock(date, { h24: state.settings.h24 })}
                    </span>
                    <span className="ck-world-offset">{offsetLabel(city.tz)}</span>
                  </div>
                </div>
              </TapHandler>
            );
          })}

          <button className="ck-world-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} color="#ff9f0a" />
            <span>Añadir ciudad</span>
          </button>
        </div>
      )}

      {adding && (
        <div className="ck-sheet">
          <div className="ck-sheet-backdrop" onClick={() => setAdding(false)} />
          <div className="ck-sheet-panel">
            <div className="ck-sheet-head">
              <span>Elegir ciudad</span>
              <button className="ck-iconbtn" onClick={() => setAdding(false)}>Cerrar</button>
            </div>
            <div className="ck-sheet-search">
              <Icon name="magnifyingglass" size={14} color="#8e8e93" />
              <input
                autoFocus
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Buscar ciudad"
              />
            </div>
            <div className="ck-sheet-list">
              {filtered.map((c) => {
                const already = clocks.some((w) => w.cityId === c.id);
                return (
                  <TapHandler key={c.id} onTap={() => !already && onAdd(c)}>
                    <div className={`ck-city-row ${already ? 'is-disabled' : ''}`}>
                      <span className="ck-city-flag">{c.flag}</span>
                      <div className="ck-city-meta">
                        <span className="ck-city-name">{c.name}</span>
                        <span className="ck-city-tz">{c.tz}</span>
                      </div>
                      {already && <Icon name="checkmark" size={16} color="#30d158" />}
                    </div>
                  </TapHandler>
                );
              })}
              {filtered.length === 0 && (
                <div className="ck-empty-small">Sin resultados</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * TAB ALARMA
 * ========================================================================== */

function AlarmTab({ state, dispatch }) {
  const [editing, setEditing] = useState(null);

  const onToggle = (a) => {
    dispatch({ type: 'UPDATE_ALARM', id: a.id, patch: { enabled: !a.enabled } });
    osHaptic('light');
  };

  const onNew = () => {
    setEditing({
      id: null,
      hour: new Date().getHours(),
      minute: 0,
      label: 'Alarma',
      days: [],
      sound: 'Radar',
      snooze: true,
    });
  };

  const onSave = (payload) => {
    if (payload.id) {
      dispatch({ type: 'UPDATE_ALARM', id: payload.id, patch: payload });
    } else {
      dispatch({ type: 'ADD_ALARM', ...payload });
    }
    setEditing(null);
    toast.success(payload.id ? 'Alarma actualizada' : 'Alarma guardada');
  };

  const onDelete = async (a) => {
    const ok = await alert.destructive({
      title: '¿Eliminar alarma?',
      confirmText: 'Eliminar',
    });
    if (ok) {
      dispatch({ type: 'DELETE_ALARM', id: a.id });
      toast.success('Alarma eliminada');
    }
  };

  const activeCount = state.alarms.filter((a) => a.enabled).length;

  return (
    <div className="ck-alarm">
      <div className="ck-alarm-head">
        <span className="ck-alarm-title">Alarmas</span>
        <button className="ck-iconbtn" onClick={onNew}>
          <Icon name="plus" size={22} color="#ff9f0a" />
        </button>
      </div>

      {state.alarms.length === 0 ? (
        <div className="ck-empty">
          <Icon name="alarm" size={48} color="#48484a" />
          <p>Sin alarmas</p>
          <button className="ck-btn" onClick={onNew}>Añadir alarma</button>
        </div>
      ) : (
        <div className="ck-alarm-list">
          {state.alarms.map((a) => (
            <div key={a.id} className="ck-alarm-row">
              <TapHandler onTap={() => setEditing(a)}>
                <div className="ck-alarm-info">
                  <span className={`ck-alarm-time ${a.enabled ? '' : 'is-off'}`}>
                    {fmtAlarmTime(a.hour, a.minute, state.settings.h24)}
                  </span>
                  <span className={`ck-alarm-label ${a.enabled ? '' : 'is-off'}`}>
                    {a.label}
                    {a.days.length > 0 && (
                      <span className="ck-alarm-days"> · {fmtDays(a.days)}</span>
                    )}
                  </span>
                </div>
              </TapHandler>
              <div className="ck-alarm-actions">
                <button className="ck-iconbtn" onClick={() => onDelete(a)}>
                  <Icon name="trash" size={16} color="#8e8e93" />
                </button>
                <label className="ck-switch">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={() => onToggle(a)}
                  />
                  <span className="ck-switch-track" />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeCount > 0 && (
        <div className="ck-alarm-footer">
          {activeCount} alarma{activeCount > 1 ? 's' : ''} activa{activeCount > 1 ? 's' : ''}
        </div>
      )}

      {editing && (
        <AlarmEditor
          value={editing}
          onSave={onSave}
          onCancel={() => setEditing(null)}
          onDelete={() => { onDelete(editing); setEditing(null); }}
          h24={state.settings.h24}
        />
      )}
    </div>
  );
}

function fmtAlarmTime(h, m, h24) {
  if (h24) return `${pad2(h)}:${pad2(m)}`;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 || 12;
  return `${hh}:${pad2(m)} ${suffix}`;
}

function fmtDays(days) {
  if (days.length === 7) return 'Todos los días';
  if (days.length === 0) return 'Sólo una vez';
  const names = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  if (days.length === 5 && [1,2,3,4,5].every((d) => days.includes(d))) return 'Días laborables';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Fin de semana';
  return days.sort().map((d) => names[d]).join(' ');
}

function AlarmEditor({ value, onSave, onCancel, onDelete, h24 }) {
  const [hour, setHour] = useState(value.hour);
  const [minute, setMinute] = useState(value.minute);
  const [label, setLabel] = useState(value.label);
  const [days, setDays] = useState(value.days || []);
  const [sound, setSound] = useState(value.sound || 'Radar');
  const [snooze, setSnooze] = useState(value.snooze !== false);

  const dayNames = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  const sounds = ['Radar', 'Amanecer', 'Cascada', 'Reflejos', 'Centelleo', 'Bruma'];

  const bumpHour = (delta) => setHour((h) => (h + delta + 24) % 24);
  const bumpMinute = (delta) => setMinute((m) => (m + delta + 60) % 60);

  return (
    <div className="ck-editor">
      <div className="ck-editor-backdrop" onClick={onCancel} />
      <div className="ck-editor-panel">
        <div className="ck-editor-head">
          <button className="ck-iconbtn" onClick={onCancel}>Cancelar</button>
          <span>{value.id ? 'Editar alarma' : 'Añadir alarma'}</span>
          <button
            className="ck-iconbtn ck-iconbtn-accent"
            onClick={() => onSave({ id: value.id, hour, minute, label, days, sound, snooze })}
          >
            Guardar
          </button>
        </div>

        <div className="ck-editor-picker">
          <div className="ck-editor-col">
            <button className="ck-editor-bump" onClick={() => bumpHour(1)}>
              <Icon name="chevron.up" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-num">{pad2(hour)}</span>
            <button className="ck-editor-bump" onClick={() => bumpHour(-1)}>
              <Icon name="chevron.down" size={18} color="#8e8e93" />
            </button>
          </div>
          <span className="ck-editor-sep">:</span>
          <div className="ck-editor-col">
            <button className="ck-editor-bump" onClick={() => bumpMinute(1)}>
              <Icon name="chevron.up" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-num">{pad2(minute)}</span>
            <button className="ck-editor-bump" onClick={() => bumpMinute(-1)}>
              <Icon name="chevron.down" size={18} color="#8e8e93" />
            </button>
          </div>
          {!h24 && (
            <span className="ck-editor-ampm">{hour >= 12 ? 'PM' : 'AM'}</span>
          )}
        </div>

        <div className="ck-editor-section">
          <span className="ck-editor-section-label">Repetir</span>
          <div className="ck-days">
            {dayNames.map((d, i) => {
              const active = days.includes(i);
              return (
                <button
                  key={i}
                  className={`ck-day ${active ? 'is-active' : ''}`}
                  onClick={() => setDays((prev) =>
                    prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ck-editor-section">
          <span className="ck-editor-section-label">Etiqueta</span>
          <input
            className="ck-editor-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Alarma"
          />
        </div>

        <div className="ck-editor-section">
          <span className="ck-editor-section-label">Sonido</span>
          <select
            className="ck-editor-select"
            value={sound}
            onChange={(e) => setSound(e.target.value)}
          >
            {sounds.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="ck-editor-section">
          <div className="ck-editor-toggle-row">
            <span>Posponer</span>
            <label className="ck-switch">
              <input type="checkbox" checked={snooze} onChange={(e) => setSnooze(e.target.checked)} />
              <span className="ck-switch-track" />
            </label>
          </div>
        </div>

        {value.id && (
          <button className="ck-editor-delete" onClick={onDelete}>
            <Icon name="trash" size={16} color="#ff453a" />
            <span>Eliminar alarma</span>
          </button>
        )}
      </div>
    </div>
  );
}

function osHaptic(style) {
  try { window?.webkit?.messageHandlers?.haptic?.postMessage?.(style); } catch {}
}

/* ============================================================================
 * TAB CRONÓMETRO
 * ========================================================================== */

function StopwatchTab({ state, dispatch, now }) {
  const running = state.stopwatchRunning;
  const elapsed = running ? now - state.stopwatchStart : state.stopwatchElapsed;

  const onStart = () => dispatch({ type: 'STOPWATCH_START' });
  const onStop = () => dispatch({ type: 'STOPWATCH_STOP' });
  const onReset = () => dispatch({ type: 'STOPWATCH_RESET' });

  const onLap = () => {
    const laps = state.stopwatchLaps;
    const prev = laps.length ? laps[0].at : 0;
    dispatch({ type: 'STOPWATCH_LAP', at: elapsed, split: elapsed - prev });
  };

  const laps = state.stopwatchLaps;
  const fastest = useMemo(() => {
    if (laps.length < 2) return null;
    return laps.reduce((a, b) => (a.split < b.split ? a : b));
  }, [laps]);
  const slowest = useMemo(() => {
    if (laps.length < 2) return null;
    return laps.reduce((a, b) => (a.split > b.split ? a : b));
  }, [laps]);

  return (
    <div className="ck-stopwatch">
      <div className="ck-stopwatch-display">
        <span className="ck-stopwatch-time">{fmtStopwatch(elapsed)}</span>
      </div>

      <div className="ck-stopwatch-actions">
        {!running && elapsed === 0 ? (
          <button className="ck-round ck-round-green" onClick={onStart}>
            <span>Iniciar</span>
          </button>
        ) : (
          <>
            <button className="ck-round ck-round-gray" onClick={running ? onLap : onReset}>
              <span>{running ? 'Vuelta' : 'Reiniciar'}</span>
            </button>
            <button
              className={`ck-round ${running ? 'ck-round-red' : 'ck-round-green'}`}
              onClick={running ? onStop : onStart}
            >
              <span>{running ? 'Parar' : 'Reanudar'}</span>
            </button>
          </>
        )}
      </div>

      {laps.length > 0 && (
        <div className="ck-laps">
          <div className="ck-lap-head">
            <span>Vuelta</span>
            <span>Tiempo</span>
          </div>
          {laps.map((lap, i) => {
            const n = laps.length - i;
            const isFast = fastest && lap.id === fastest.id && laps.length >= 2;
            const isSlow = slowest && lap.id === slowest.id && laps.length >= 2;
            return (
              <div key={lap.id} className="ck-lap-row">
                <span>Vuelta {n}</span>
                <span className={isFast ? 'is-fast' : isSlow ? 'is-slow' : ''}>
                  {fmtStopwatch(lap.split)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * TAB TEMPORIZADOR
 * ========================================================================== */

function TimerTab({ state, dispatch, now }) {
  const t = state.timer;
  const [setting, setSetting] = useState(false);

  const remaining = t.running
    ? Math.max(0, t.remainingMs - (now - t.startAt))
    : t.remainingMs;

  useEffect(() => {
    if (t.running && remaining <= 0) {
      dispatch({ type: 'TIMER_DONE' });
      toast.info('⏰ Temporizador finalizado');
      if (t.vibrate) osHaptic('heavy');
    }
  }, [remaining, t.running]);

  const progress = t.originalMs > 0
    ? 1 - Math.max(0, Math.min(1, remaining / t.originalMs))
    : 0;

  const presets = [
    { label: '1 min',  ms: 60 * 1000 },
    { label: '5 min',  ms: 5 * 60 * 1000 },
    { label: '10 min', ms: 10 * 60 * 1000 },
    { label: '15 min', ms: 15 * 60 * 1000 },
    { label: '30 min', ms: 30 * 60 * 1000 },
    { label: '1 h',    ms: 60 * 60 * 1000 },
  ];

  const r = 120;
  const circ = 2 * Math.PI * r;

  return (
    <div className="ck-timer">
      <div className="ck-timer-ring-wrap">
        <svg width="280" height="280" viewBox="0 0 280 280" className="ck-timer-ring">
          <circle cx="140" cy="140" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="8" />
          <circle
            cx="140" cy="140" r={r}
            fill="none"
            stroke="#ff9f0a"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - progress)}
            transform="rotate(-90 140 140)"
            style={{ transition: 'stroke-dashoffset .25s linear' }}
          />
        </svg>
        <div className="ck-timer-display">
          <span className="ck-timer-time">{fmtTimerDisplay(remaining)}</span>
        </div>
      </div>

      <div className="ck-timer-actions">
        {!t.running && t.remainingMs === t.originalMs ? (
          <button className="ck-round ck-round-green" onClick={() => setSetting(true)}>
            <span>Establecer</span>
          </button>
        ) : !t.running ? (
          <>
            <button className="ck-round ck-round-gray" onClick={() => dispatch({ type: 'TIMER_RESET' })}>
              <span>Cancelar</span>
            </button>
            <button className="ck-round ck-round-green" onClick={() => dispatch({ type: 'TIMER_RESUME' })}>
              <span>Reanudar</span>
            </button>
          </>
        ) : (
          <>
            <button className="ck-round ck-round-red" onClick={() => dispatch({ type: 'TIMER_PAUSE' })}>
              <span>Pausar</span>
            </button>
            <button className="ck-round ck-round-gray" onClick={() => dispatch({ type: 'TIMER_RESET' })}>
              <span>Cancelar</span>
            </button>
          </>
        )}
      </div>

      {!t.running && t.remainingMs === t.originalMs && (
        <div className="ck-timer-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              className={`ck-preset ${t.presetMs === p.ms ? 'is-active' : ''}`}
              onClick={() => dispatch({ type: 'TIMER_SET_PRESET', ms: p.ms })}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {setting && (
        <TimerEditor
          value={{ ms: t.originalMs }}
          onSave={(ms) => {
            dispatch({ type: 'TIMER_SET_PRESET', ms });
            dispatch({ type: 'TIMER_START' });
            setSetting(false);
          }}
          onCancel={() => setSetting(false)}
        />
      )}
    </div>
  );
}

function fmtTimerDisplay(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${pad2(m)}:${pad2(sec)}`;
}

function TimerEditor({ value, onSave, onCancel }) {
  const total = Math.max(0, Math.floor(value.ms / 1000));
  const [h, setH] = useState(Math.floor(total / 3600));
  const [m, setM] = useState(Math.floor((total % 3600) / 60));
  const [s, setS] = useState(total % 60);

  const bump = (setter, cur, max) => (d) =>
    setter((cur + d + max) % max);

  return (
    <div className="ck-editor">
      <div className="ck-editor-backdrop" onClick={onCancel} />
      <div className="ck-editor-panel">
        <div className="ck-editor-head">
          <button className="ck-iconbtn" onClick={onCancel}>Cancelar</button>
          <span>Temporizador</span>
          <button
            className="ck-iconbtn ck-iconbtn-accent"
            onClick={() => onSave((h * 3600 + m * 60 + s) * 1000)}
          >
            Iniciar
          </button>
        </div>

        <div className="ck-editor-picker">
          <div className="ck-editor-col">
            <button className="ck-editor-bump" onClick={() => bump(setH, h, 24)(1)}>
              <Icon name="chevron.up" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-num">{pad2(h)}</span>
            <button className="ck-editor-bump" onClick={() => bump(setH, h, 24)(-1)}>
              <Icon name="chevron.down" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-unit">horas</span>
          </div>
          <span className="ck-editor-sep">:</span>
          <div className="ck-editor-col">
            <button className="ck-editor-bump" onClick={() => bump(setM, m, 60)(1)}>
              <Icon name="chevron.up" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-num">{pad2(m)}</span>
            <button className="ck-editor-bump" onClick={() => bump(setM, m, 60)(-1)}>
              <Icon name="chevron.down" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-unit">min</span>
          </div>
          <span className="ck-editor-sep">:</span>
          <div className="ck-editor-col">
            <button className="ck-editor-bump" onClick={() => bump(setS, s, 60)(1)}>
              <Icon name="chevron.up" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-num">{pad2(s)}</span>
            <button className="ck-editor-bump" onClick={() => bump(setS, s, 60)(-1)}>
              <Icon name="chevron.down" size={18} color="#8e8e93" />
            </button>
            <span className="ck-editor-unit">seg</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function ClockApp({ appWindowId, instanceId }) {
  const os = useOS();
  const [state, dispatch] = useClock(os);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let raf;
    let last = performance.now();
    const loop = (t) => {
      const dt = t - last;
      if (dt > 40) {
        setNow(Date.now());
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const alarmsActive = state.alarms.some((a) => a.enabled);
  const timerActive = state.timer.running;

  if (!state.ready) {
    return (
      <div className="ck-root ck-loading">
        <div className="ck-spinner" />
      </div>
    );
  }

  return (
    <div className="ck-root">
      <div className="ck-body">
        {state.tab === 'world'     && <WorldClockTab state={state} dispatch={dispatch} now={now} />}
        {state.tab === 'alarm'     && <AlarmTab state={state} dispatch={dispatch} />}
        {state.tab === 'stopwatch' && <StopwatchTab state={state} dispatch={dispatch} now={now} />}
        {state.tab === 'timer'     && <TimerTab state={state} dispatch={dispatch} now={now} />}
      </div>

      <TabBar
        tab={state.tab}
        onChange={(t) => dispatch({ type: 'SET_TAB', tab: t })}
        alarmsActive={alarmsActive}
        timerActive={timerActive}
      />
    </div>
  );
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('ck-styles')) {
  const s = document.createElement('style');
  s.id = 'ck-styles';
  s.textContent = `
  .ck-root { display:flex; flex-direction:column; height:100%; background:#000; color:#fff;
    font-family:-apple-system, system-ui, sans-serif; -webkit-user-select:none; user-select:none; }
  .ck-loading { align-items:center; justify-content:center; }
  .ck-spinner { width:32px; height:32px; border-radius:50%;
    border:3px solid rgba(255,255,255,.15); border-top-color:#ff9f0a;
    animation:ck-spin .8s linear infinite; }
  @keyframes ck-spin { to { transform:rotate(360deg); } }

  .ck-body { flex:1; overflow-y:auto; }
  .ck-tabbar { display:flex; background:#1c1c1e; border-top:.5px solid rgba(255,255,255,.08);
    padding-bottom: env(safe-area-inset-bottom, 0); }
  .ck-tab { flex:1; display:flex; flex-direction:column; align-items:center; gap:2px;
    background:none; border:none; padding:8px 4px 6px; cursor:pointer; color:#8e8e93; }
  .ck-tab.is-active { color:#ff9f0a; }
  .ck-tab-icon-wrap { position:relative; }
  .ck-tab-dot { position:absolute; top:-1px; right:-3px; width:6px; height:6px;
    border-radius:50%; background:#ff453a; }
  .ck-tab-label { font-size:10px; }
  .ck-tab.is-active .ck-tab-label { font-weight:600; }

  .ck-empty { display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:14px; padding:60px 20px; color:#8e8e93; }
  .ck-empty p { margin:0; font-size:15px; }
  .ck-empty-small { padding:24px; text-align:center; color:#8e8e93; font-size:14px; }
  .ck-btn { padding:10px 20px; background:#ff9f0a; color:#fff; border:none; border-radius:10px;
    font-size:15px; font-weight:600; cursor:pointer; }

  .ck-iconbtn { background:none; border:none; color:#ff9f0a; font-size:15px; padding:8px; cursor:pointer; }
  .ck-iconbtn-accent { font-weight:600; }

  /* World */
  .ck-world { padding:8px 0 24px; }
  .ck-world-list { display:flex; flex-direction:column; }
  .ck-world-row { display:flex; justify-content:space-between; align-items:flex-start;
    padding:14px 16px; border-bottom:.5px solid rgba(255,255,255,.06); }
  .ck-world-left { display:flex; flex-direction:column; gap:2px; }
  .ck-world-rel { font-size:11px; color:#8e8e93; }
  .ck-world-name { font-size:22px; font-weight:300; letter-spacing:-.5px; }
  .ck-world-date { font-size:11px; color:#8e8e93; }
  .ck-world-right { display:flex; flex-direction:column; align-items:flex-end; gap:2px; }
  .ck-world-time { font-size:40px; font-weight:200; font-variant-numeric: tabular-nums;
    letter-spacing:-1px; line-height:1; }
  .ck-world-time.is-night { color:#8e8e93; }
  .ck-world-offset { font-size:11px; color:#8e8e93; }
  .ck-world-add { display:flex; align-items:center; justify-content:center; gap:6px;
    background:none; border:none; color:#ff9f0a; font-size:15px; padding:16px; cursor:pointer; }

  /* Alarm */
  .ck-alarm { padding:8px 0 24px; }
  .ck-alarm-head { display:flex; justify-content:space-between; align-items:center;
    padding:12px 16px 4px; }
  .ck-alarm-title { font-size:28px; font-weight:700; letter-spacing:-.4px; }
  .ck-alarm-list { display:flex; flex-direction:column; }
  .ck-alarm-row { display:flex; align-items:center; justify-content:space-between;
    padding:12px 16px; border-bottom:.5px solid rgba(255,255,255,.06); }
  .ck-alarm-info { display:flex; flex-direction:column; gap:2px; cursor:pointer; }
  .ck-alarm-time { font-size:44px; font-weight:200; letter-spacing:-1.5px;
    font-variant-numeric: tabular-nums; line-height:1; }
  .ck-alarm-time.is-off { color:#48484a; }
  .ck-alarm-label { font-size:13px; color:#8e8e93; }
  .ck-alarm-label.is-off { color:#48484a; }
  .ck-alarm-days { color:#8e8e93; }
  .ck-alarm-actions { display:flex; align-items:center; gap:6px; }
  .ck-alarm-footer { padding:14px 16px; font-size:12px; color:#8e8e93; text-align:center; }

  .ck-switch { position:relative; display:inline-block; width:51px; height:31px; flex:0 0 auto; }
  .ck-switch input { opacity:0; width:0; height:0; }
  .ck-switch-track { position:absolute; inset:0; background:#39393d; border-radius:31px;
    transition:background .2s; cursor:pointer; }
  .ck-switch-track::before { content:''; position:absolute; width:27px; height:27px;
    left:2px; top:2px; background:#fff; border-radius:50%; transition:transform .2s;
    box-shadow:0 1px 3px rgba(0,0,0,.4); }
  .ck-switch input:checked + .ck-switch-track { background:#30d158; }
  .ck-switch input:checked + .ck-switch-track::before { transform:translateX(20px); }

  /* Editor */
  .ck-editor { position:absolute; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; }
  .ck-editor-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(8px); }
  .ck-editor-panel { position:relative; width:calc(100% - 32px); max-width:360px;
    background:#1c1c1e; border-radius:16px; overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.6); }
  .ck-editor-head { display:flex; align-items:center; justify-content:space-between;
    padding:12px 12px; border-bottom:.5px solid rgba(255,255,255,.08); }
  .ck-editor-head span { font-size:15px; font-weight:600; }
  .ck-editor-picker { display:flex; align-items:center; justify-content:center; gap:6px;
    padding:22px 12px 8px; }
  .ck-editor-col { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .ck-editor-num { font-size:48px; font-weight:200; letter-spacing:-2px;
    font-variant-numeric: tabular-nums; min-width:70px; text-align:center; }
  .ck-editor-bump { background:none; border:none; padding:4px 10px; cursor:pointer; }
  .ck-editor-sep { font-size:40px; font-weight:200; color:#8e8e93; margin-bottom:6px; }
  .ck-editor-ampm { font-size:18px; font-weight:500; color:#8e8e93; margin-left:4px; align-self:center; }
  .ck-editor-unit { font-size:11px; color:#8e8e93; }
  .ck-editor-section { padding:12px 16px; border-top:.5px solid rgba(255,255,255,.06); }
  .ck-editor-section-label { display:block; font-size:11px; color:#8e8e93;
    text-transform:uppercase; letter-spacing:.6px; margin-bottom:8px; }
  .ck-days { display:flex; justify-content:space-between; gap:4px; }
  .ck-day { width:36px; height:36px; border-radius:50%; border:1.5px solid rgba(255,255,255,.15);
    background:none; color:#fff; font-size:14px; font-weight:500; cursor:pointer; }
  .ck-day.is-active { background:#ff9f0a; border-color:#ff9f0a; color:#000; font-weight:600; }
  .ck-editor-input, .ck-editor-select { width:100%; background:#2c2c2e; border:none;
    border-radius:8px; padding:10px 12px; color:#fff; font-size:15px; outline:none; }
  .ck-editor-toggle-row { display:flex; justify-content:space-between; align-items:center; }
  .ck-editor-delete { display:flex; align-items:center; justify-content:center; gap:8px;
    width:100%; padding:14px; background:none; border:none; border-top:.5px solid rgba(255,255,255,.06);
    color:#ff453a; font-size:15px; cursor:pointer; }

  /* Sheet */
  .ck-sheet { position:absolute; inset:0; z-index:100; }
  .ck-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(8px); }
  .ck-sheet-panel { position:absolute; bottom:0; left:0; right:0; max-height:75%;
    background:#1c1c1e; border-top-left-radius:16px; border-top-right-radius:16px;
    display:flex; flex-direction:column; overflow:hidden; animation:ck-slide-up .25s ease; }
  @keyframes ck-slide-up { from { transform:translateY(100%); } to { transform:translateY(0); } }
  .ck-sheet-head { display:flex; justify-content:space-between; align-items:center;
    padding:14px 16px; border-bottom:.5px solid rgba(255,255,255,.08); }
  .ck-sheet-head span { font-size:16px; font-weight:600; }
  .ck-sheet-search { display:flex; align-items:center; gap:8px; padding:10px 12px;
    background:#2c2c2e; margin:10px 16px; border-radius:10px; }
  .ck-sheet-search input { flex:1; background:none; border:none; outline:none; color:#fff;
    font-size:15px; }
  .ck-sheet-list { flex:1; overflow-y:auto; padding-bottom:20px; }
  .ck-city-row { display:flex; align-items:center; gap:12px; padding:12px 16px;
    border-bottom:.5px solid rgba(255,255,255,.05); cursor:pointer; }
  .ck-city-row.is-disabled { opacity:.4; cursor:default; }
  .ck-city-flag { font-size:22px; }
  .ck-city-meta { flex:1; display:flex; flex-direction:column; gap:2px; }
  .ck-city-name { font-size:15px; }
  .ck-city-tz { font-size:11px; color:#8e8e93; }

  /* Stopwatch */
  .ck-stopwatch { display:flex; flex-direction:column; align-items:center; padding:40px 20px 24px; }
  .ck-stopwatch-display { margin-bottom:50px; }
  .ck-stopwatch-time { font-size:76px; font-weight:200; letter-spacing:-2px;
    font-variant-numeric: tabular-nums; }
  .ck-stopwatch-actions { display:flex; gap:60px; margin-bottom:30px; }
  .ck-round { width:80px; height:80px; border-radius:50%; border:none; cursor:pointer;
    display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:500;
    position:relative; }
  .ck-round span { position:relative; z-index:1; }
  .ck-round-green { background:rgba(48,209,88,.18); color:#30d158;
    box-shadow:inset 0 0 0 2px rgba(48,209,88,.3); }
  .ck-round-red { background:rgba(255,69,58,.18); color:#ff453a;
    box-shadow:inset 0 0 0 2px rgba(255,69,58,.3); }
  .ck-round-gray { background:rgba(120,120,128,.16); color:#fff;
    box-shadow:inset 0 0 0 2px rgba(120,120,128,.3); }
  .ck-round:active { transform:scale(.96); }

  .ck-laps { width:100%; max-width:360px; margin-top:16px; }
  .ck-lap-head { display:flex; justify-content:space-between; padding:8px 0;
    border-bottom:.5px solid rgba(255,255,255,.1); font-size:12px; color:#8e8e93; }
  .ck-lap-row { display:flex; justify-content:space-between; padding:10px 0;
    border-bottom:.5px solid rgba(255,255,255,.06); font-size:15px;
    font-variant-numeric: tabular-nums; }
  .ck-lap-row .is-fast { color:#30d158; }
  .ck-lap-row .is-slow { color:#ff453a; }

  /* Timer */
  .ck-timer { display:flex; flex-direction:column; align-items:center; padding:30px 20px 24px; }
  .ck-timer-ring-wrap { position:relative; display:flex; align-items:center; justify-content:center;
    margin-bottom:40px; }
  .ck-timer-ring { display:block; }
  .ck-timer-display { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
  .ck-timer-time { font-size:56px; font-weight:200; letter-spacing:-1.5px;
    font-variant-numeric: tabular-nums; }
  .ck-timer-actions { display:flex; gap:60px; margin-bottom:26px; }
  .ck-timer-presets { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; max-width:340px; }
  .ck-preset { padding:8px 14px; background:#1c1c1e; border:none; border-radius:16px;
    color:#fff; font-size:13px; cursor:pointer; }
  .ck-preset.is-active { background:#ff9f0a; color:#000; font-weight:600; }
  `;
  document.head.appendChild(s);
}

export { fmtClock, fmtStopwatch, fmtTimeMS, CITIES };
