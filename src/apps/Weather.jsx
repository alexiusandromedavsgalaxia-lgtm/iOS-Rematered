// src/apps/Weather.jsx
// iOS Remastered — Weather.app
// Tiempo: ciudad actual, pronóstico por horas, 10 días, detalles (UV, viento,
// humedad, presión, visibilidad, sensación), mapa de precipitación simulado,
// lista de ciudades, unidades C/F. Calca la app Tiempo de iOS.
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

const WEATHER_DB = '/private/var/mobile/Library/Weather/Weather.json';

async function persist(os, state) {
  try {
    if (!os?.fs) return;
    await os.fs.mkdir('/private/var/mobile/Library/Weather', { recursive: true }).catch(() => {});
    await os.fs.writeFile(WEATHER_DB, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      cities: state.cities,
      unit: state.unit,
    }));
  } catch {}
}

async function hydrate(os) {
  try {
    if (!os?.fs) return null;
    const raw = await os.fs.readFile(WEATHER_DB);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/* ============================================================================
 * CIUDADES BASE
 * ========================================================================== */

const BASE_CITIES = [
  { id: 'cupertino', name: 'Cupertino',       region: 'California',     tz: 'America/Los_Angeles', lat: 37.3230, lon: -122.0322 },
  { id: 'madrid',    name: 'Madrid',          region: 'España',         tz: 'Europe/Madrid',       lat: 40.4168, lon: -3.7038 },
  { id: 'london',    name: 'Londres',         region: 'Reino Unido',    tz: 'Europe/London',       lat: 51.5074, lon: -0.1278 },
  { id: 'paris',     name: 'París',           region: 'Francia',        tz: 'Europe/Paris',        lat: 48.8566, lon: 2.3522 },
  { id: 'tokyo',     name: 'Tokio',           region: 'Japón',          tz: 'Asia/Tokyo',          lat: 35.6762, lon: 139.6503 },
  { id: 'ny',        name: 'Nueva York',      region: 'Nueva York',     tz: 'America/New_York',    lat: 40.7128, lon: -74.0060 },
  { id: 'sydney',    name: 'Sídney',          region: 'Australia',      tz: 'Australia/Sydney',    lat: -33.8688, lon: 151.2093 },
  { id: 'dubai',     name: 'Dubái',           region: 'EAU',            tz: 'Asia/Dubai',          lat: 25.2048, lon: 55.2708 },
  { id: 'rio',       name: 'Río de Janeiro',  region: 'Brasil',         tz: 'America/Sao_Paulo',   lat: -22.9068, lon: -43.1729 },
  { id: 'moscow',    name: 'Moscú',           region: 'Rusia',          tz: 'Europe/Moscow',       lat: 55.7558, lon: 37.6173 },
  { id: 'reykjavik', name: 'Reikiavik',       region: 'Islandia',       tz: 'Atlantic/Reykjavik',  lat: 64.1466, lon: -21.9426 },
  { id: 'singapore', name: 'Singapur',        region: 'Singapur',       tz: 'Asia/Singapore',      lat: 1.3521,  lon: 103.8198 },
];

/* ============================================================================
 * CONDICIONES METEOROLÓGICAS
 * ========================================================================== */

const CONDITIONS = {
  clear:       { label: 'Despejado',           dayIcon: 'sun.max.fill',           nightIcon: 'moon.stars.fill',    gradient: ['#4A90E2', '#87CEEB'],  tint: '#FFD60A' },
  mostlyClear: { label: 'Mayormente despejado',dayIcon: 'cloud.sun.fill',          nightIcon: 'cloud.moon.fill',   gradient: ['#3A7BD5', '#6FB1E8'],  tint: '#FFD60A' },
  partlyCloudy:{ label: 'Parcialmente nublado',dayIcon: 'cloud.sun.fill',          nightIcon: 'cloud.moon.fill',   gradient: ['#5A7FA0', '#8FA9C0'],  tint: '#FFFFFF' },
  cloudy:      { label: 'Nublado',             dayIcon: 'cloud.fill',              nightIcon: 'cloud.fill',        gradient: ['#5C6670', '#8A98A5'],  tint: '#FFFFFF' },
  overcast:    { label: 'Cubierto',            dayIcon: 'smoke.fill',              nightIcon: 'smoke.fill',        gradient: ['#4A5560', '#6B7885'],  tint: '#FFFFFF' },
  rain:        { label: 'Lluvia',              dayIcon: 'cloud.rain.fill',         nightIcon: 'cloud.rain.fill',   gradient: ['#3D5769', '#5A7285'],  tint: '#64D2FF' },
  drizzle:     { label: 'Llovizna',            dayIcon: 'cloud.drizzle.fill',      nightIcon: 'cloud.drizzle.fill',gradient: ['#4A6272', '#6C8294'],  tint: '#64D2FF' },
  storm:       { label: 'Tormenta',            dayIcon: 'cloud.bolt.rain.fill',    nightIcon: 'cloud.bolt.rain.fill', gradient: ['#2D3944', '#4A5560'], tint: '#FFD60A' },
  snow:        { label: 'Nieve',               dayIcon: 'cloud.snow.fill',         nightIcon: 'cloud.snow.fill',   gradient: ['#7A8A96', '#A8B6C0'],  tint: '#FFFFFF' },
  sleet:       { label: 'Aguanieve',           dayIcon: 'cloud.sleet.fill',        nightIcon: 'cloud.sleet.fill',  gradient: ['#5A6B78', '#8595A0'],  tint: '#64D2FF' },
  fog:         { label: 'Niebla',              dayIcon: 'cloud.fog.fill',          nightIcon: 'cloud.fog.fill',    gradient: ['#6A7570', '#95A09A'],  tint: '#FFFFFF' },
  windy:       { label: 'Ventoso',             dayIcon: 'wind',                    nightIcon: 'wind',              gradient: ['#4F6B7A', '#7A96A5'],  tint: '#FFFFFF' },
  hail:        { label: 'Granizo',             dayIcon: 'cloud.hail.fill',         nightIcon: 'cloud.hail.fill',   gradient: ['#3A4A55', '#5C6D78'],  tint: '#64D2FF' },
  hot:         { label: 'Caluroso',            dayIcon: 'thermometer.sun.fill',    nightIcon: 'thermometer.sun.fill', gradient: ['#B8502A', '#E08050'], tint: '#FF9F0A' },
  freezing:    { label: 'Helado',              dayIcon: 'thermometer.snowflake',   nightIcon: 'thermometer.snowflake', gradient: ['#3D5A6C', '#6E8FA3'], tint: '#64D2FF' },
};

const CONDITION_KEYS = Object.keys(CONDITIONS);

const WIND_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

const MOON_PHASES = [
  { name: 'Luna nueva',       icon: 'moonphase.new.moon' },
  { name: 'Creciente',        icon: 'moonphase.waxing.crescent' },
  { name: 'Cuarto creciente', icon: 'moonphase.first.quarter' },
  { name: 'Gibosa creciente', icon: 'moonphase.waxing.gibbous' },
  { name: 'Luna llena',       icon: 'moonphase.full.moon' },
  { name: 'Gibosa menguante', icon: 'moonphase.waning.gibbous' },
  { name: 'Cuarto menguante', icon: 'moonphase.last.quarter' },
  { name: 'Menguante',        icon: 'moonphase.waning.crescent' },
];

/* ============================================================================
 * GENERADOR DE CLIMA DETERMINISTA
 * ========================================================================== */

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cityClimate(city) {
  const abs = Math.abs(city.lat);
  const tropic = Math.max(0, 1 - abs / 30);
  const polar  = Math.max(0, (abs - 50) / 40);
  const base = 14 + tropic * 14 - polar * 22;
  const amp = 6 + (1 - tropic) * 10;
  return { base, amp, tropic, polar };
}

function generateWeather(city, date = new Date()) {
  const key = `${city.id}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
  const rnd = mulberry32(hashSeed(key));
  const { base, amp, tropic, polar } = cityClimate(city);

  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const season = Math.sin((doy / 365) * Math.PI * 2 - Math.PI / 2);
  const northern = city.lat >= 0 ? 1 : -1;
  const seasonal = season * northern * amp;

  const hourJitter = (rnd() - 0.5) * 4;
  const temp = Math.round(base + seasonal + hourJitter);
  const feelsLike = Math.round(temp + (rnd() - 0.5) * 3 + (temp > 28 ? 2 : temp < 5 ? -3 : 0));

  let conditionKey;
  const r = rnd();
  const isRainy = r < 0.35;
  const isSnowy = temp < 3 && r < 0.5;
  const isStormy = r < 0.08 && temp > 15;
  const isFoggy = r > 0.92 && temp < 15;
  const isWindy = r > 0.85 && r < 0.9;

  if (isStormy) conditionKey = 'storm';
  else if (isSnowy) conditionKey = 'snow';
  else if (isRainy) conditionKey = r < 0.5 ? 'rain' : 'drizzle';
  else if (isFoggy) conditionKey = 'fog';
  else if (isWindy) conditionKey = 'windy';
  else if (temp > 32) conditionKey = 'hot';
  else if (temp < -5) conditionKey = 'freezing';
  else if (r < 0.55) conditionKey = 'clear';
  else if (r < 0.75) conditionKey = 'mostlyClear';
  else if (r < 0.9) conditionKey = 'partlyCloudy';
  else if (r < 0.97) conditionKey = 'cloudy';
  else conditionKey = 'overcast';

  const humidity = Math.round(40 + rnd() * 55 + (isRainy ? 15 : 0));
  const pressure = Math.round(1005 + rnd() * 30);
  const visibility = Math.round((isFoggy ? 0.4 + rnd() * 1.5 : 8 + rnd() * 12) * 10) / 10;
  const uvIndex = Math.max(0, Math.round(
    (temp > 15 ? 4 + rnd() * 7 : rnd() * 4) * (1 - polar * 0.7)
  ));
  const windSpeed = Math.round((isWindy ? 30 + rnd() * 40 : 3 + rnd() * 20));
  const windDirIdx = Math.floor(rnd() * 16);
  const windGust = windSpeed + Math.round(rnd() * 15);
  const dewPoint = Math.round(temp - (100 - humidity) / 5);
  const cloudCover = isRainy ? 70 + rnd() * 30 : rnd() * 60;
  const precipChance = isRainy ? 60 + rnd() * 40 : isSnowy ? 50 + rnd() * 40 : rnd() * 20;
  const precipMm = isRainy ? rnd() * 12 : 0;
  const airQuality = Math.max(10, Math.round(30 + rnd() * 80));
  const aqiLevel = airQuality < 50 ? 'Buena' : airQuality < 100 ? 'Moderada' :
    airQuality < 150 ? 'Insalubre (grupos sensibles)' : airQuality < 200 ? 'Insalubre' : 'Muy insalubre';
  const aqiColor = airQuality < 50 ? '#30d158' : airQuality < 100 ? '#ffd60a' :
    airQuality < 150 ? '#ff9f0a' : airQuality < 200 ? '#ff453a' : '#bf5af2';

  const sunriseH = 5 + Math.round((1 - tropic) * 2) + Math.round(rnd() * 2);
  const sunsetH = 19 - Math.round((1 - tropic) * 2) - Math.round(rnd() * 2);

  const moonIdx = Math.floor(((doy / 29.53) % 1) * 8);

  return {
    temp, feelsLike, conditionKey,
    condition: CONDITIONS[conditionKey],
    humidity, pressure, visibility, uvIndex,
    windSpeed, windDirIdx, windGust,
    windDirLabel: WIND_DIRS[windDirIdx],
    dewPoint, cloudCover, precipChance: Math.round(precipChance),
    precipMm: Math.round(precipMm * 10) / 10,
    airQuality, aqiLevel, aqiColor,
    sunrise: sunriseH + Math.floor(rnd() * 60) / 60,
    sunset: sunsetH + Math.floor(rnd() * 60) / 60,
    moonPhase: MOON_PHASES[moonIdx],
    updatedAt: Date.now(),
  };
}

function generateHourly(city, hours = 24) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const out = [];
  for (let i = 0; i < hours; i++) {
    const t = new Date(now.getTime() + i * 3600000);
    const w = generateWeather(city, t);
    out.push({
      ts: t.getTime(),
      hour: t.getHours(),
      temp: w.temp,
      feelsLike: w.feelsLike,
      conditionKey: w.conditionKey,
      condition: w.condition,
      precipChance: w.precipChance,
      isNow: i === 0,
    });
  }
  return out;
}

function generateDaily(city, days = 10) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    let hi = -999, lo = 999, cond = 'clear', precipMax = 0;
    for (let h = 0; h < 24; h += 3) {
      const w = generateWeather(city, new Date(t.getTime() + h * 3600000));
      hi = Math.max(hi, w.temp);
      lo = Math.min(lo, w.temp);
      precipMax = Math.max(precipMax, w.precipChance);
      if (h === 12) cond = w.conditionKey;
    }
    out.push({
      ts: t.getTime(),
      date: t,
      hi, lo, conditionKey: cond,
      condition: CONDITIONS[cond],
      precipChance: Math.round(precipMax),
    });
  }
  return out;
}

/* ============================================================================
 * REDUCER
 * ========================================================================== */

const initialState = {
  ready: false,
  unit: 'C',
  cities: [
    { ...BASE_CITIES[0], isCurrent: true },
    { ...BASE_CITIES[1] },
  ],
  activeCityIdx: 0,
  addingCity: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.state, ready: true };
    case 'SET_UNIT':
      return { ...state, unit: action.unit };
    case 'SET_ACTIVE':
      return { ...state, activeCityIdx: action.idx };
    case 'ADD_CITY': {
      if (state.cities.some((c) => c.id === action.city.id)) {
        return state;
      }
      const cities = [...state.cities, action.city];
      return { ...state, cities, activeCityIdx: cities.length - 1 };
    }
    case 'DELETE_CITY': {
      if (state.cities.length <= 1) return state;
      const cities = state.cities.filter((c) => c.id !== action.id);
      const activeCityIdx = Math.min(state.activeCityIdx, cities.length - 1);
      return { ...state, cities, activeCityIdx };
    }
    case 'SET_ADDING':
      return { ...state, addingCity: action.value };
    default:
      return state;
  }
}

/* ============================================================================
 * UTILS
 * ========================================================================== */

function cToF(c) { return Math.round(c * 9 / 5 + 32); }
function tempLabel(c, unit) { return unit === 'F' ? cToF(c) : Math.round(c); }
function tempSymbol(unit) { return unit === 'F' ? '°F' : '°C'; }

function fmtHour(ts, h24 = false) {
  const d = new Date(ts);
  const h = d.getHours();
  if (h24) return `${String(h).padStart(2, '0')}:00`;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function fmtDayName(ts, idx) {
  if (idx === 0) return 'Hoy';
  if (idx === 1) return 'Mañana';
  const d = new Date(ts);
  return ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()];
}

function fmtSunTime(h) {
  const H = Math.floor(h);
  const M = Math.round((h - H) * 60);
  return `${H}:${String(M).padStart(2, '0')}`;
}

function aqiBarWidth(aqi) { return `${Math.min(100, (aqi / 300) * 100)}%`; }

function uvLevel(uv) {
  if (uv <= 2) return { label: 'Bajo',       color: '#30d158' };
  if (uv <= 5) return { label: 'Moderado',   color: '#ffd60a' };
  if (uv <= 7) return { label: 'Alto',       color: '#ff9f0a' };
  if (uv <= 10) return { label: 'Muy alto',  color: '#ff453a' };
  return { label: 'Extremo',                 color: '#bf5af2' };
}

function pressureLevel(p) {
  if (p < 1000) return 'Baja';
  if (p < 1013) return 'Normal-baja';
  if (p < 1025) return 'Normal';
  return 'Alta';
}

function visibilityLevel(v) {
  if (v < 1) return 'Muy baja';
  if (v < 5) return 'Baja';
  if (v < 10) return 'Buena';
  return 'Excelente';
}

/* ============================================================================
 * HOOK PRINCIPAL
 * ========================================================================== */

function useWeather(os) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveRef = useRef(null);

  useEffect(() => {
    (async () => {
      const db = await hydrate(os);
      if (db) {
        dispatch({
          type: 'HYDRATE',
          state: {
            unit: db.unit || 'C',
            cities: (db.cities && db.cities.length ? db.cities : initialState.cities),
            activeCityIdx: 0,
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
 * COMPONENTES BASE
 * ========================================================================== */

function WeatherIcon({ conditionKey, isNight, size = 30, color = '#fff' }) {
  const c = CONDITIONS[conditionKey] || CONDITIONS.clear;
  const name = isNight ? c.nightIcon : c.dayIcon;
  return <Icon name={name} size={size} color={color} />;
}

function ConditionIconBig({ conditionKey, isNight }) {
  const c = CONDITIONS[conditionKey] || CONDITIONS.clear;
  const name = isNight ? c.nightIcon : c.dayIcon;
  return (
    <div className="wx-big-icon">
      <Icon name={name} size={110} color="#fff" />
    </div>
  );
}

/* ============================================================================
 * FONDO DEGRADADO
 * ========================================================================== */

function WeatherBackground({ conditionKey, isNight }) {
  const c = CONDITIONS[conditionKey] || CONDITIONS.clear;
  const [a, b] = c.gradient;
  const top = isNight ? shade(a, -50) : a;
  const bottom = isNight ? shade(b, -60) : b;

  return (
    <div
      className="wx-bg"
      style={{ background: `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)` }}
    >
      <div className="wx-bg-overlay" />
      {conditionKey === 'rain' || conditionKey === 'drizzle' || conditionKey === 'storm' ? (
        <RainOverlay intensity={conditionKey === 'storm' ? 3 : conditionKey === 'rain' ? 2 : 1} />
      ) : null}
      {conditionKey === 'snow' && <SnowOverlay />}
      {conditionKey === 'clear' && !isNight && <SunRays />}
      {isNight && (conditionKey === 'clear' || conditionKey === 'mostlyClear') && <StarField />}
    </div>
  );
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt;
  let g = ((n >> 8) & 0xff) + amt;
  let b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function RainOverlay({ intensity = 1 }) {
  const count = 30 + intensity * 20;
  const drops = useMemo(() => {
    const rnd = mulberry32(intensity * 100);
    return Array.from({ length: count }, (_, i) => ({
      left: rnd() * 100,
      delay: rnd() * 2,
      duration: 0.5 + rnd() * 0.7 - intensity * 0.1,
      height: 10 + rnd() * 20,
    }));
  }, [intensity, count]);

  return (
    <div className="wx-rain">
      {drops.map((d, i) => (
        <span
          key={i}
          style={{
            left: `${d.left}%`,
            height: `${d.height}px`,
            animationDelay: `${d.delay}s`,
            animationDuration: `${d.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

function SnowOverlay() {
  const flakes = useMemo(() => {
    const rnd = mulberry32(1234);
    return Array.from({ length: 40 }, (_, i) => ({
      left: rnd() * 100,
      delay: rnd() * 8,
      duration: 6 + rnd() * 6,
      size: 3 + rnd() * 5,
    }));
  }, []);
  return (
    <div className="wx-snow">
      {flakes.map((f, i) => (
        <span
          key={i}
          style={{
            left: `${f.left}%`,
            width: f.size, height: f.size,
            animationDelay: `${f.delay}s`,
            animationDuration: `${f.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

function SunRays() {
  return (
    <div className="wx-sunrays">
      <div className="wx-sunrays-circle" />
      <div className="wx-sunrays-glow" />
    </div>
  );
}

function StarField() {
  const stars = useMemo(() => {
    const rnd = mulberry32(42);
    return Array.from({ length: 60 }, (_, i) => ({
      x: rnd() * 100,
      y: rnd() * 60,
      size: 1 + rnd() * 2,
      delay: rnd() * 3,
    }));
  }, []);
  return (
    <div className="wx-stars">
      {stars.map((s, i) => (
        <span
          key={i}
          style={{
            left: `${s.x}%`, top: `${s.y}%`,
            width: s.size, height: s.size,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ============================================================================
 * VISTA PRINCIPAL DE CIUDAD
 * ========================================================================== */

function CityView({ city, unit, now }) {
  const cur = useMemo(() => generateWeather(city, now), [city, now.getHours()]);
  const hourly = useMemo(() => generateHourly(city, 24), [city, now.getHours()]);
  const daily = useMemo(() => generateDaily(city, 10), [city, now.getDate()]);
  const hour = new Date(now).getHours();
  const isNight = hour < 7 || hour >= 20;

  const dailyMin = Math.min(...daily.map((d) => d.lo));
  const dailyMax = Math.max(...daily.map((d) => d.hi));

  return (
    <div className="wx-city">
      <div className="wx-hero">
        <div className="wx-city-name">{city.name}</div>
        <div className="wx-temp">
          {tempLabel(cur.temp, unit)}°
        </div>
        <div className="wx-condition">{cur.condition.label}</div>
        <div className="wx-hilo">
          Máx. {tempLabel(daily[0].hi, unit)}° · Mín. {tempLabel(daily[0].lo, unit)}°
        </div>
        <ConditionIconBig conditionKey={cur.conditionKey} isNight={isNight} />
      </div>

      <div className="wx-card">
        <div className="wx-card-head">
          <Icon name="clock" size={12} color="#fff" />
          <span>PRONÓSTICO POR HORAS</span>
        </div>
        <div className="wx-hourly">
          {hourly.map((h) => (
            <div key={h.ts} className={`wx-hour ${h.isNow ? 'is-now' : ''}`}>
              <span className="wx-hour-time">{h.isNow ? 'Ahora' : fmtHour(h.ts, false)}</span>
              <WeatherIcon conditionKey={h.conditionKey} size={26} />
              {h.precipChance > 20 && (
                <span className="wx-hour-precip">{h.precipChance}%</span>
              )}
              <span className="wx-hour-temp">{tempLabel(h.temp, unit)}°</span>
            </div>
          ))}
        </div>
      </div>

      <div className="wx-card">
        <div className="wx-card-head">
          <Icon name="calendar" size={12} color="#fff" />
          <span>PRONÓSTICO A 10 DÍAS</span>
        </div>
        <div className="wx-daily">
          {daily.map((d, i) => {
            const range = dailyMax - dailyMin || 1;
            const leftPct = ((d.lo - dailyMin) / range) * 100;
            const widthPct = ((d.hi - d.lo) / range) * 100;
            return (
              <div key={d.ts} className="wx-day">
                <span className="wx-day-name">{fmtDayName(d.ts, i)}</span>
                <span className="wx-day-icon">
                  <WeatherIcon conditionKey={d.conditionKey} size={22} />
                </span>
                {d.precipChance > 20 && (
                  <span className="wx-day-precip">{d.precipChance}%</span>
                )}
                <span className="wx-day-lo">{tempLabel(d.lo, unit)}°</span>
                <div className="wx-day-bar-wrap">
                  <div
                    className="wx-day-bar"
                    style={{
                      left: `${leftPct}%`,
                      width: `${Math.max(4, widthPct)}%`,
                    }}
                  />
                </div>
                <span className="wx-day-hi">{tempLabel(d.hi, unit)}°</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wx-card">
        <div className="wx-card-head">
          <Icon name="info.circle" size={12} color="#fff" />
          <span>DETALLES</span>
        </div>

        <div className="wx-detail-grid">
          <DetailTile
            icon="thermometer"
            title="Sensación"
            value={`${tempLabel(cur.feelsLike, unit)}°`}
            caption={cur.feelsLike === cur.temp ? 'Igual que real' :
              cur.feelsLike > cur.temp ? 'Más caluroso' : 'Más frío'}
          />
          <DetailTile
            icon="wind"
            title="Viento"
            value={`${cur.windSpeed} km/h`}
            caption={`${cur.windDirLabel} · rachas ${cur.windGust} km/h`}
            extra={<WindDial dirIdx={cur.windDirIdx} speed={cur.windSpeed} />}
          />
          <DetailTile
            icon="humidity"
            title="Humedad"
            value={`${cur.humidity}%`}
            caption={`Punto de rocío ${tempLabel(cur.dewPoint, unit)}°`}
          />
          <DetailTile
            icon="sun.max"
            title="Índice UV"
            value={String(cur.uvIndex)}
            caption={uvLevel(cur.uvIndex).label}
            accent={uvLevel(cur.uvIndex).color}
          />
          <DetailTile
            icon="sunset"
            title="Amanecer"
            value={fmtSunTime(cur.sunrise)}
            caption={`Atardecer ${fmtSunTime(cur.sunset)}`}
          />
          <DetailTile
            icon="moon.stars"
            title="Fase lunar"
            value={cur.moonPhase.name.split(' ')[0]}
            caption={cur.moonPhase.name}
          />
          <DetailTile
            icon="barometer"
            title="Presión"
            value={`${cur.pressure} hPa`}
            caption={pressureLevel(cur.pressure)}
          />
          <DetailTile
            icon="eye"
            title="Visibilidad"
            value={`${cur.visibility} km`}
            caption={visibilityLevel(cur.visibility)}
          />
          <DetailTile
            icon="cloud"
            title="Nubosidad"
            value={`${Math.round(cur.cloudCover)}%`}
            caption={cur.cloudCover > 70 ? 'Muy nublado' :
              cur.cloudCover > 40 ? 'Parcialmente' : 'Despejado'}
          />
          <DetailTile
            icon="drop"
            title="Precipitación"
            value={`${cur.precipChance}%`}
            caption={cur.precipMm > 0 ? `${cur.precipMm} mm` : 'Sin lluvia'}
          />
        </div>

        <div className="wx-aqi">
          <div className="wx-aqi-head">
            <span>Calidad del aire</span>
            <span className="wx-aqi-value" style={{ color: cur.aqiColor }}>
              {cur.airQuality} · {cur.aqiLevel}
            </span>
          </div>
          <div className="wx-aqi-bar">
            <div
              className="wx-aqi-fill"
              style={{ width: aqiBarWidth(cur.airQuality), background: cur.aqiColor }}
            />
          </div>
        </div>
      </div>

      <div className="wx-card">
        <div className="wx-card-head">
          <Icon name="map" size={12} color="#fff" />
          <span>MAPA DE PRECIPITACIÓN</span>
        </div>
        <PrecipitationMap city={city} now={now} />
      </div>
    </div>
  );
}

function DetailTile({ icon, title, value, caption, accent, extra }) {
  return (
    <div className="wx-tile">
      <div className="wx-tile-head">
        <Icon name={icon} size={12} color="rgba(255,255,255,.7)" />
        <span>{title.toUpperCase()}</span>
      </div>
      <div className="wx-tile-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {extra}
      {caption && <div className="wx-tile-caption">{caption}</div>}
    </div>
  );
}

function WindDial({ dirIdx, speed }) {
  const angle = dirIdx * 22.5;
  return (
    <div className="wx-winddial">
      <svg viewBox="0 0 100 100" width="70" height="70">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="1" />
        <text x="50" y="14" fill="rgba(255,255,255,.5)" fontSize="9" textAnchor="middle">N</text>
        <text x="50" y="94" fill="rgba(255,255,255,.5)" fontSize="9" textAnchor="middle">S</text>
        <text x="10" y="53" fill="rgba(255,255,255,.5)" fontSize="9" textAnchor="middle">O</text>
        <text x="90" y="53" fill="rgba(255,255,255,.5)" fontSize="9" textAnchor="middle">E</text>
        <g transform={`rotate(${angle} 50 50)`}>
          <line x1="50" y1="70" x2="50" y2="22" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
          <polygon points="50,18 46,28 54,28" fill="#fff" />
        </g>
        <text x="50" y="55" fill="#fff" fontSize="12" fontWeight="600" textAnchor="middle">{speed}</text>
      </svg>
    </div>
  );
}

function PrecipitationMap({ city, now }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;

    const rnd = mulberry32(hashSeed(`${city.id}-${now.getDate()}-${now.getHours()}`));

    // Base: mapa abstracto
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a1a2e');
    grad.addColorStop(1, '#102840');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Manchas de "tierra"
    ctx.fillStyle = 'rgba(30,80,60,.35)';
    for (let i = 0; i < 6; i++) {
      const cx = rnd() * w, cy = rnd() * h;
      const r = 40 + rnd() * 80;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.65, rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // Manchas de precipitación
    const blobs = 8 + Math.floor(rnd() * 12);
    for (let i = 0; i < blobs; i++) {
      const cx = rnd() * w, cy = rnd() * h;
      const r = 30 + rnd() * 90;
      const intensity = rnd();
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const col = intensity > 0.7 ? '255,159,10' : intensity > 0.4 ? '48,209,88' : '10,132,255';
      g.addColorStop(0, `rgba(${col},${0.35 + intensity * 0.35})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Punto de la ciudad
    const px = w * 0.5, py = h * 0.5;
    ctx.fillStyle = 'rgba(10,132,255,.3)';
    ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Marcas de intensidad
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = '10px -apple-system, system-ui';
    ctx.fillText('dBZ', 8, 16);
    const legend = [
      ['#0a84ff', 'Débil'],
      ['#30d158', 'Moderada'],
      ['#ff9f0a', 'Fuerte'],
    ];
    legend.forEach(([col, label], i) => {
      const y = h - 14 - (legend.length - 1 - i) * 14;
      ctx.fillStyle = col;
      ctx.fillRect(w - 70, y - 8, 10, 10);
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText(label, w - 56, y);
    });
  }, [city.id, now.getDate(), now.getHours()]);

  return (
    <div className="wx-map">
      <canvas
        ref={canvasRef}
        width={320}
        height={200}
        className="wx-map-canvas"
      />
      <div className="wx-map-label">
        {city.name} · {new Date(now).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

/* ============================================================================
 * LISTA DE CIUDADES (hoja inferior)
 * ========================================================================== */

function CityListSheet({ state, dispatch, onClose, onAdd }) {
  const onDelete = async (city) => {
    if (state.cities.length <= 1) {
      toast.error('Debe haber al menos una ciudad');
      return;
    }
    const ok = await alert.destructive({
      title: '¿Eliminar ciudad?',
      message: `Se eliminará ${city.name} de la lista.`,
      confirmText: 'Eliminar',
    });
    if (ok) dispatch({ type: 'DELETE_CITY', id: city.id });
  };

  return (
    <div className="wx-sheet">
      <div className="wx-sheet-backdrop" onClick={onClose} />
      <div className="wx-sheet-panel">
        <div className="wx-sheet-head">
          <span>Ciudades</span>
          <button className="wx-iconbtn" onClick={onClose}>Cerrar</button>
        </div>
        <div className="wx-sheet-list">
          {state.cities.map((c, i) => {
            const w = generateWeather(c);
            return (
              <TapHandler
                key={c.id}
                onTap={() => { dispatch({ type: 'SET_ACTIVE', idx: i }); onClose(); }}
                onLongPress={() => onDelete(c)}
              >
                <div className={`wx-city-row ${i === state.activeCityIdx ? 'is-active' : ''}`}>
                  <div className="wx-city-meta">
                    <span className="wx-city-name-small">{c.name}</span>
                    <span className="wx-city-region">{c.region}</span>
                  </div>
                  <div className="wx-city-temp">
                    {tempLabel(w.temp, state.unit)}°
                  </div>
                  <WeatherIcon conditionKey={w.conditionKey} size={22} />
                </div>
              </TapHandler>
            );
          })}

          <button className="wx-add-city" onClick={onAdd}>
            <Icon name="plus" size={18} color="#0a84ff" />
            <span>Añadir ciudad</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * BUSCADOR DE CIUDADES
 * ========================================================================== */

function CitySearchSheet({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q.trim()) return BASE_CITIES;
    const s = q.trim().toLowerCase();
    return BASE_CITIES.filter((c) =>
      c.name.toLowerCase().includes(s) ||
      c.region.toLowerCase().includes(s)
    );
  }, [q]);

  return (
    <div className="wx-sheet">
      <div className="wx-sheet-backdrop" onClick={onClose} />
      <div className="wx-sheet-panel">
        <div className="wx-sheet-head">
          <span>Buscar ciudad</span>
          <button className="wx-iconbtn" onClick={onClose}>Cancelar</button>
        </div>
        <div className="wx-search">
          <Icon name="magnifyingglass" size={14} color="#8e8e93" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ciudad o región"
          />
        </div>
        <div className="wx-sheet-list">
          {filtered.map((c) => (
            <TapHandler key={c.id} onTap={() => onPick(c)}>
              <div className="wx-city-row">
                <div className="wx-city-meta">
                  <span className="wx-city-name-small">{c.name}</span>
                  <span className="wx-city-region">{c.region}</span>
                </div>
                <Icon name="plus.circle" size={22} color="#0a84ff" />
              </div>
            </TapHandler>
          ))}
          {filtered.length === 0 && (
            <div className="wx-empty-small">Sin resultados</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function WeatherApp({ appWindowId, instanceId }) {
  const os = useOS();
  const [state, dispatch] = useWeather(os);
  const [showCities, setShowCities] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const city = state.cities[state.activeCityIdx];
  const cur = city ? generateWeather(city, new Date(now)) : null;

  const swipe = useGesture({
    onSwipe: ({ direction }) => {
      if (showCities || showSearch) return;
      if (direction === 'left' && state.activeCityIdx < state.cities.length - 1) {
        dispatch({ type: 'SET_ACTIVE', idx: state.activeCityIdx + 1 });
      } else if (direction === 'right' && state.activeCityIdx > 0) {
        dispatch({ type: 'SET_ACTIVE', idx: state.activeCityIdx - 1 });
      }
    },
    onTap: () => {
      // tap en el header cicla página de detalles
      setPage((p) => (p + 1) % 1);
    },
  });

  const hour = new Date(now).getHours();
  const isNight = hour < 7 || hour >= 20;

  if (!state.ready || !city || !cur) {
    return (
      <div className="wx-root wx-loading">
        <div className="wx-spinner" />
      </div>
    );
  }

  return (
    <div className="wx-root" {...swipe.bind}>
      <WeatherBackground conditionKey={cur.conditionKey} isNight={isNight} />

      <div className="wx-scroll">
        <CityView city={city} unit={state.unit} now={new Date(now)} />

        <div className="wx-footer">
          <Icon name="apple.logo" size={11} color="rgba(255,255,255,.7)" />
          <span>Tiempo · Datos simulados</span>
        </div>
      </div>

      {/* Header flotante */}
      <div className="wx-header">
        <button
          className="wx-iconbtn"
          onClick={() => setShowCities(true)}
          title="Ciudades"
        >
          <Icon name="list.bullet" size={20} color="#fff" />
        </button>

        <div className="wx-pager">
          {state.cities.map((_, i) => (
            <span
              key={i}
              className={`wx-page-dot ${i === state.activeCityIdx ? 'is-active' : ''}`}
            />
          ))}
        </div>

        <button
          className="wx-iconbtn"
          onClick={() => {
            const next = state.unit === 'C' ? 'F' : 'C';
            dispatch({ type: 'SET_UNIT', unit: next });
            toast.info(`Unidades en ${tempSymbol(next)}`);
          }}
          title="Cambiar unidades"
        >
          <span className="wx-unit-btn">{tempSymbol(state.unit)}</span>
        </button>
      </div>

      {showCities && (
        <CityListSheet
          state={state}
          dispatch={dispatch}
          onClose={() => setShowCities(false)}
          onAdd={() => {
            setShowCities(false);
            setShowSearch(true);
          }}
        />
      )}

      {showSearch && (
        <CitySearchSheet
          onPick={(c) => {
            dispatch({ type: 'ADD_CITY', city: { ...c } });
            setShowSearch(false);
            toast.success(`${c.name} añadida`);
          }}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('wx-styles')) {
  const s = document.createElement('style');
  s.id = 'wx-styles';
  s.textContent = `
  .wx-root { position:relative; width:100%; height:100%; overflow:hidden;
    font-family:-apple-system, system-ui, sans-serif; color:#fff;
    -webkit-user-select:none; user-select:none; }
  .wx-loading { display:flex; align-items:center; justify-content:center; background:#1c1c1e; }
  .wx-spinner { width:32px; height:32px; border-radius:50%;
    border:3px solid rgba(255,255,255,.15); border-top-color:#fff;
    animation:wx-spin .8s linear infinite; }
  @keyframes wx-spin { to { transform:rotate(360deg); } }

  .wx-bg { position:absolute; inset:0; z-index:0; transition:background .8s ease; }
  .wx-bg-overlay { position:absolute; inset:0;
    background:radial-gradient(circle at 50% 0%, rgba(255,255,255,.08), transparent 60%); }

  .wx-rain { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .wx-rain span { position:absolute; top:-20px; width:1.5px;
    background:linear-gradient(to bottom, rgba(255,255,255,0), rgba(200,230,255,.55));
    animation:wx-rain-fall linear infinite; }
  @keyframes wx-rain-fall {
    to { transform:translateY(105vh); }
  }

  .wx-snow { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .wx-snow span { position:absolute; top:-10px; border-radius:50%;
    background:rgba(255,255,255,.9);
    animation:wx-snow-fall linear infinite; }
  @keyframes wx-snow-fall {
    to { transform:translate(20px, 105vh); }
  }

  .wx-sunrays { position:absolute; top:-40px; right:-40px; width:280px; height:280px;
    pointer-events:none; }
  .wx-sunrays-circle { position:absolute; inset:40px; border-radius:50%;
    background:radial-gradient(circle, rgba(255,240,180,.8) 0%, rgba(255,220,120,.3) 40%, transparent 70%);
    animation:wx-pulse 4s ease-in-out infinite; }
  .wx-sunrays-glow { position:absolute; inset:0; border-radius:50%;
    background:radial-gradient(circle, rgba(255,230,150,.25), transparent 60%);
    animation:wx-pulse 6s ease-in-out infinite reverse; }
  @keyframes wx-pulse { 0%,100%{transform:scale(1);} 50%{transform:scale(1.08);} }

  .wx-stars { position:absolute; inset:0; pointer-events:none; }
  .wx-stars span { position:absolute; border-radius:50%; background:#fff;
    animation:wx-twinkle 3s ease-in-out infinite; }
  @keyframes wx-twinkle { 0%,100%{opacity:.3;} 50%{opacity:1;} }

  .wx-scroll { position:relative; z-index:1; height:100%; overflow-y:auto;
    padding:60px 0 24px; }
  .wx-city { padding:0 16px 20px; }

  .wx-hero { text-align:center; padding:20px 0 40px; position:relative; }
  .wx-city-name { font-size:34px; font-weight:300; letter-spacing:-1px; }
  .wx-temp { font-size:96px; font-weight:200; line-height:1;
    letter-spacing:-6px; margin-top:4px; }
  .wx-condition { font-size:20px; font-weight:400; opacity:.85; margin-top:2px; }
  .wx-hilo { font-size:15px; opacity:.75; margin-top:6px; }
  .wx-big-icon { margin-top:12px; display:flex; justify-content:center;
    filter:drop-shadow(0 4px 20px rgba(0,0,0,.3)); }

  .wx-card { background:rgba(255,255,255,.14); backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px); border-radius:18px; padding:14px;
    margin-bottom:14px; border:.5px solid rgba(255,255,255,.12); }
  .wx-card-head { display:flex; align-items:center; gap:6px; font-size:11px;
    font-weight:600; letter-spacing:.7px; opacity:.8; margin-bottom:12px;
    text-transform:uppercase; }

  .wx-hourly { display:flex; gap:20px; overflow-x:auto; padding-bottom:4px;
    scrollbar-width:none; }
  .wx-hourly::-webkit-scrollbar { display:none; }
  .wx-hour { flex:0 0 auto; display:flex; flex-direction:column;
    align-items:center; gap:8px; min-width:52px; }
  .wx-hour.is-now .wx-hour-time { font-weight:700; }
  .wx-hour-time { font-size:13px; opacity:.85; }
  .wx-hour-precip { font-size:11px; color:#64d2ff; font-weight:600; }
  .wx-hour-temp { font-size:17px; font-weight:500; }

  .wx-daily { display:flex; flex-direction:column; }
  .wx-day { display:grid; grid-template-columns:56px 30px 40px 36px 1fr 36px;
    align-items:center; gap:8px; padding:10px 0;
    border-bottom:.5px solid rgba(255,255,255,.1); }
  .wx-day:last-child { border-bottom:none; }
  .wx-day-name { font-size:15px; font-weight:500; }
  .wx-day-icon { display:flex; justify-content:center; }
  .wx-day-precip { font-size:11px; color:#64d2ff; font-weight:600; }
  .wx-day-lo { font-size:15px; opacity:.65; text-align:right; }
  .wx-day-hi { font-size:15px; text-align:right; font-weight:500; }
  .wx-day-bar-wrap { height:4px; background:rgba(255,255,255,.15);
    border-radius:2px; position:relative; }
  .wx-day-bar { position:absolute; top:0; height:100%; border-radius:2px;
    background:linear-gradient(90deg, #64d2ff, #ffd60a 50%, #ff9f0a); }

  .wx-detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .wx-tile { background:rgba(255,255,255,.08); border-radius:12px; padding:12px;
    display:flex; flex-direction:column; gap:6px; min-height:100px; }
  .wx-tile-head { display:flex; align-items:center; gap:5px; font-size:10px;
    font-weight:600; letter-spacing:.5px; opacity:.75; }
  .wx-tile-value { font-size:30px; font-weight:300; letter-spacing:-1px; line-height:1.1; }
  .wx-tile-caption { font-size:11px; opacity:.7; }
  .wx-winddial { display:flex; justify-content:center; margin:2px 0; }

  .wx-aqi { margin-top:14px; padding-top:12px;
    border-top:.5px solid rgba(255,255,255,.1); }
  .wx-aqi-head { display:flex; justify-content:space-between; align-items:baseline;
    margin-bottom:8px; font-size:13px; }
  .wx-aqi-value { font-size:13px; font-weight:600; }
  .wx-aqi-bar { height:6px; background:rgba(255,255,255,.15); border-radius:3px;
    overflow:hidden; }
  .wx-aqi-fill { height:100%; border-radius:3px; transition:width .4s ease; }

  .wx-map { border-radius:12px; overflow:hidden; position:relative; }
  .wx-map-canvas { width:100%; height:auto; display:block; }
  .wx-map-label { position:absolute; bottom:8px; left:10px; font-size:11px;
    color:rgba(255,255,255,.85); background:rgba(0,0,0,.35);
    padding:3px 8px; border-radius:6px; backdrop-filter:blur(10px); }

  .wx-header { position:absolute; top:0; left:0; right:0; z-index:10;
    display:flex; justify-content:space-between; align-items:center;
    padding:14px 12px 10px; background:linear-gradient(to bottom,
      rgba(0,0,0,.28), transparent); pointer-events:none; }
  .wx-header > * { pointer-events:auto; }
  .wx-iconbtn { background:rgba(0,0,0,.25); border:none; border-radius:50%;
    width:36px; height:36px; display:flex; align-items:center; justify-content:center;
    cursor:pointer; color:#fff; backdrop-filter:blur(10px); }
  .wx-unit-btn { font-size:14px; font-weight:600; color:#fff; }
  .wx-pager { display:flex; gap:5px; align-items:center; }
  .wx-page-dot { width:6px; height:6px; border-radius:50%;
    background:rgba(255,255,255,.4); transition:background .2s; }
  .wx-page-dot.is-active { background:#fff; }

  .wx-sheet { position:absolute; inset:0; z-index:100; }
  .wx-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.5);
    backdrop-filter:blur(8px); }
  .wx-sheet-panel { position:absolute; bottom:0; left:0; right:0; max-height:80%;
    background:#1c1c1e; border-top-left-radius:18px; border-top-right-radius:18px;
    display:flex; flex-direction:column; overflow:hidden;
    animation:wx-slide-up .28s cubic-bezier(.25,.85,.3,1); color:#fff; }
  @keyframes wx-slide-up { from { transform:translateY(100%); } to { transform:translateY(0); } }
  .wx-sheet-head { display:flex; justify-content:space-between; align-items:center;
    padding:14px 16px; border-bottom:.5px solid rgba(255,255,255,.08); }
  .wx-sheet-head span { font-size:16px; font-weight:600; }
  .wx-sheet-list { flex:1; overflow-y:auto; padding-bottom:20px; }
  .wx-search { display:flex; align-items:center; gap:8px; padding:10px 12px;
    background:#2c2c2e; margin:10px 16px; border-radius:10px; }
  .wx-search input { flex:1; background:none; border:none; outline:none;
    color:#fff; font-size:15px; }

  .wx-city-row { display:flex; align-items:center; gap:12px; padding:14px 16px;
    border-bottom:.5px solid rgba(255,255,255,.06); cursor:pointer; }
  .wx-city-row.is-active { background:rgba(10,132,255,.1); }
  .wx-city-meta { flex:1; display:flex; flex-direction:column; gap:2px; }
  .wx-city-name-small { font-size:17px; font-weight:500; }
  .wx-city-region { font-size:12px; color:#8e8e93; }
  .wx-city-temp { font-size:24px; font-weight:300; margin-right:6px; }
  .wx-add-city { display:flex; align-items:center; justify-content:center; gap:6px;
    background:none; border:none; color:#0a84ff; font-size:15px; padding:16px;
    cursor:pointer; width:100%; }
  .wx-empty-small { padding:24px; text-align:center; color:#8e8e93; font-size:14px; }

  .wx-footer { display:flex; align-items:center; justify-content:center; gap:6px;
    padding:20px; font-size:11px; opacity:.6; }
  `;
  document.head.appendChild(s);
}

export {
  generateWeather, generateHourly, generateDaily,
  CONDITIONS, BASE_CITIES, cToF, tempLabel,
};
