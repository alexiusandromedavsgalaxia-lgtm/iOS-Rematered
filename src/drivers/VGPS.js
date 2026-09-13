// src/drivers/VGPS.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VGPS (Virtual GPS / GNSS Receiver)
 * ═══════════════════════════════════════════════════════════════
 *
 * Receptor GNSS multi-constelación virtual. Modela el chip Broadcom
 * BCM4778 del iPhone con soporte para GPS, GLONASS, Galileo, BeiDou,
 * QZSS y NavIC.
 *
 * Responsabilidades:
 *   - Constelaciones completas: GPS, GLONASS, Galileo, BeiDou,
 *     QZSS, NavIC (IRNSS)
 *   - Estados: off / acquiring / 2D-fix / 3D-fix / error
 *   - Satélites visibles con azimut, elevación, SNR, en uso
 *   - Precisión horizontal / vertical en metros (según modo)
 *   - Velocidad, rumbo, altitud, altitud geoidal
 *   - Modos: high-accuracy (navegación), balanced, low-power,
 *     navigation (turn-by-turn)
 *   - Detección indoor / outdoor
 *   - Time-to-first-fix (TTFF) según tipo de arranque
 *   - A-GPS: almanaque, efemérides, XTRA (download simulado)
 *   - Trayectorias simuladas: se puede "conducir" o "caminar"
 *   - Geofencing básico (regiones, entrada/salida)
 *   - Historial de posiciones
 *   - IRQ_GPS con eventos: fix-acquired, fix-lost, speed-changed,
 *     geofence-entered, geofence-exited, ttff-measured
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const GPSState = {
  OFF:         'off',
  ACQUIRING:   'acquiring',
  FIX_2D:      '2d-fix',
  FIX_3D:      '3d-fix',
  ERROR:       'error',
};

export const GPSMode = {
  HIGH_ACCURACY: 'high-accuracy',   // navegación a pie o coche
  BALANCED:      'balanced',        // uso general
  LOW_POWER:     'low-power',       // background, menos fixes
  NAVIGATION:    'navigation',      // turn-by-turn, 1Hz
  FITNESS:       'fitness',         //跑步, alta tasa
};

export const GNSSConstellation = {
  GPS:     'GPS',
  GLONASS: 'GLONASS',
  GALILEO: 'Galileo',
  BEIDOU:  'BeiDou',
  QZSS:    'QZSS',
  NAVIC:   'NavIC',
};

export const StartupType = {
  COLD: 'cold',      // sin almanaque ni efemérides
  WARM: 'warm',      // con almanaque pero sin efemérides
  HOT:  'hot',       // con almanaque y efemérides
};

// Precisión por modo (metros)
const MODE_ACCURACY_M = {
  [GPSMode.HIGH_ACCURACY]: { h: 3, v: 5 },
  [GPSMode.BALANCED]:      { h: 8, v: 12 },
  [GPSMode.LOW_POWER]:     { h: 25, v: 35 },
  [GPSMode.NAVIGATION]:    { h: 2, v: 4 },
  [GPSMode.FITNESS]:       { h: 2, v: 3 },
};

// Frecuencia de fix por modo (Hz)
const MODE_FIX_HZ = {
  [GPSMode.HIGH_ACCURACY]: 1,
  [GPSMode.BALANCED]:      1,
  [GPSMode.LOW_POWER]:     0.2,
  [GPSMode.NAVIGATION]:    1,
  [GPSMode.FITNESS]:       5,
};

// TTFF (Time To First Fix) por tipo de arranque (ms)
const TTFF_MS = {
  [StartupType.COLD]: 30000,   // 30 s
  [StartupType.WARM]: 12000,   // 12 s
  [StartupType.HOT]:  2000,    // 2 s
};

// Consumo energético por modo (mW)
const MODE_POWER_MW = {
  [GPSMode.HIGH_ACCURACY]: 180,
  [GPSMode.BALANCED]:      120,
  [GPSMode.LOW_POWER]:     40,
  [GPSMode.NAVIGATION]:    220,
  [GPSMode.FITNESS]:       250,
};

// Número de satélites visibles por constelación (nominal)
const CONSTELLATION_SATS = {
  [GNSSConstellation.GPS]:     { min: 6, max: 12, band: 'L1/L5' },
  [GNSSConstellation.GLONASS]: { min: 4, max: 10, band: 'L1/L2' },
  [GNSSConstellation.GALILEO]: { min: 5, max: 11, band: 'E1/E5' },
  [GNSSConstellation.BEIDOU]:  { min: 5, max: 12, band: 'B1/B2' },
  [GNSSConstellation.QZSS]:    { min: 1, max: 4,  band: 'L1/L5' },
  [GNSSConstellation.NAVIC]:   { min: 2, max: 6,  band: 'L5' },
};

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;
const randRange = (a, b) => a + Math.random() * (b - a);

/**
 * Distancia entre dos puntos (lat/lon) usando Haversine.
 * Devuelve metros.
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ───────────────────────────────────────────────────────────────
// Satellite — satélite visible
// ───────────────────────────────────────────────────────────────
class Satellite {
  constructor({ prn, constellation, elevation, azimuth, snr, inUse, band }) {
    this.prn         = prn;
    this.constellation = constellation;
    this.elevation   = elevation;   // grados 0-90
    this.azimuth     = azimuth;     // grados 0-360
    this.snr         = snr;         // dB-Hz (típico 20-45)
    this.inUse       = inUse;
    this.band        = band;
    this.lastUpdate  = Date.now();
  }

  snapshot() {
    return {
      prn:          this.prn,
      constellation:this.constellation,
      elevation:    parseFloat(this.elevation.toFixed(1)),
      azimuth:      parseFloat(this.azimuth.toFixed(1)),
      snr:          parseFloat(this.snr.toFixed(1)),
      inUse:        this.inUse,
      band:         this.band,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Geofence — región circular con entrada/salida
// ───────────────────────────────────────────────────────────────
class Geofence {
  constructor({ id, name, lat, lon, radiusM, onEnter = null, onExit = null }) {
    this.id       = id;
    this.name     = name;
    this.lat      = lat;
    this.lon      = lon;
    this.radiusM  = radiusM;
    this.onEnter  = onEnter;
    this.onExit   = onExit;
    this.inside   = false;
    this.createdAt= Date.now();
    this.enterCount = 0;
    this.exitCount  = 0;
  }

  contains(lat, lon) {
    return haversineM(lat, lon, this.lat, this.lon) <= this.radiusM;
  }

  snapshot() {
    return {
      id:       this.id,
      name:     this.name,
      lat:      this.lat,
      lon:      this.lon,
      radiusM:  this.radiusM,
      inside:   this.inside,
      enterCount: this.enterCount,
      exitCount:  this.exitCount,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Route — trayectoria simulada
// ───────────────────────────────────────────────────────────────
class Route {
  constructor({ name, waypoints = [], speedMps = 10 }) {
    this.name     = name;
    this.waypoints= waypoints;    // [{ lat, lon, alt? }]
    this.speedMps = speedMps;
    this.currentIndex = 0;
    this.progress = 0;            // 0..1 entre waypoints
    this.startedAt= Date.now();
    this.finished = false;
  }

  /** Avanza `distanceM` a lo largo de la ruta. Devuelve la posición. */
  advance(distanceM) {
    if (this.finished || this.waypoints.length < 2) {
      return this.waypoints[this.waypoints.length - 1] || null;
    }

    let remaining = distanceM;
    while (remaining > 0 && !this.finished) {
      const from = this.waypoints[this.currentIndex];
      const to   = this.waypoints[this.currentIndex + 1];
      if (!to) { this.finished = true; break; }

      const segLen = haversineM(from.lat, from.lon, to.lat, to.lon);
      const segRemaining = segLen * (1 - this.progress);

      if (remaining < segRemaining) {
        this.progress += remaining / segLen;
        remaining = 0;
      } else {
        remaining -= segRemaining;
        this.currentIndex++;
        this.progress = 0;
        if (this.currentIndex >= this.waypoints.length - 1) {
          this.finished = true;
          this.currentIndex = this.waypoints.length - 2;
          this.progress = 1;
        }
      }
    }

    const from = this.waypoints[this.currentIndex];
    const to   = this.waypoints[this.currentIndex + 1] || from;
    return {
      lat: from.lat + (to.lat - from.lat) * this.progress,
      lon: from.lon + (to.lon - from.lon) * this.progress,
      alt: (from.alt ?? 0) + ((to.alt ?? 0) - (from.alt ?? 0)) * this.progress,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VGPS — driver completo
// ───────────────────────────────────────────────────────────────
export class VGPS {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VGPS';
    this.model = DEVICE_MODEL.radios.gps.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = GPSState.OFF;
    this.mode        = GPSMode.BALANCED;
    this.airplane    = false;

    // Constelaciones soportadas
    this.constellations = DEVICE_MODEL.radios.gps.systems.slice();
    this.supportedStartups = [StartupType.COLD, StartupType.WARM, StartupType.HOT];

    // Estado del fix
    this.fix = {
      valid:        false,
      lat:          0,
      lon:          0,
      alt:          0,
      altGeoid:     0,
      speedMps:     0,
      heading:      0,        // grados
      accuracyH:    0,        // metros
      accuracyV:    0,        // metros
      hdop:         0,
      vdop:         0,
      pdop:         0,
      satsUsed:     0,
      satsVisible:  0,
      fixTs:        null,
      lastUpdateTs: null,
    };

    // Posición inicial (Madrid)
    this.homePosition = { lat: 40.4168, lon: -3.7038, alt: 650 };
    this.currentPosition = { ...this.homePosition };

    // Satélites visibles
    this.satellites = new Map();   // key: constellation+prn

    // A-GPS
    this.agps = {
      almanacDownloaded: true,
      ephemerisDownloaded: true,
      xtraValidUntil: Date.now() + 24 * 3600 * 1000,
      lastDownload: Date.now(),
    };

    // Indoor/outdoor
    this.indoor = false;

    // TTFF tracking
    this.startup = null;           // StartupType en curso
    this.startupTs = null;
    this.lastTTFF = null;

    // Ruta simulada (opcional)
    this.route = null;

    // Geofences
    this.geofences = new Map();    // id -> Geofence

    // Historial de posiciones
    this.historySize = 240;
    this.history = {
      ts:       [],
      lat:      [],
      lon:      [],
      alt:      [],
      speed:    [],
      heading:  [],
      accuracyH:[],
    };

    // Suscriptores
    this.subscribers       = new Set();
    this.fixSubscribers    = new Set();
    this.speedSubscribers  = new Set();
    this.geofenceSubscribers = new Set();

    // Tick loop — se ajusta dinámicamente según modo
    this.tickIntervalMs = 1000;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      fixesAcquired:     0,
      fixesLost:         0,
      ttffSamples:       [],
      avgTTFFMs:         0,
      lastAcquisitionTs: null,
      speedChanges:      0,
      geofenceEntries:   0,
      geofenceExits:     0,
      agpsDownloads:     0,
      routesCompleted:   0,
      powerOns:          0,
      powerOffs:         0,
      startedAt:         null,
    };

    // Consumo energético
    this.currentPowerMw = 0;

    // Speed tracking para detectar cambios
    this._lastSpeed = 0;

    logger.kernel('VGPS',
      `creado: ${this.model} (${this.constellations.length} constelaciones, precisión ${DEVICE_MODEL.radios.gps.accuracyM}m)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VGPS',
      `✓ init: ${this.model}, constelaciones=[${this.constellations.join(', ')}]`);
    this.bus?.raiseInterrupt?.('IRQ_GPS', {
      source: 'vgps', event: 'ready',
    }, 'vgps');
  }

  _startTickLoop() {
    if (this.running) return;
    this.running = true;
    this._scheduleNextTick();
  }

  _scheduleNextTick() {
    if (!this.running) return;
    this.tickId = setTimeout(() => {
      this._tick();
      this._scheduleNextTick();
    }, this._currentTickInterval());
  }

  _currentTickInterval() {
    const hz = MODE_FIX_HZ[this.mode] || 1;
    return Math.max(200, Math.round(1000 / hz));
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    if (this.tickId) {
      clearTimeout(this.tickId);
      this.tickId = null;
    }
    this.currentPowerMw = 0;
    this.state = GPSState.OFF;
    logger.info('VGPS', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // 1) Si está adquiriendo, simular TTFF
    if (this.state === GPSState.ACQUIRING) {
      this._updateAcquisition();
    } else if (this.state === GPSState.FIX_2D || this.state === GPSState.FIX_3D) {
      // 2) Actualizar satélites
      this._updateSatellites();

      // 3) Mover si hay ruta
      if (this.route && !this.route.finished) {
        this._advanceRoute();
      } else {
        // Sin ruta: posición estática con jitter
        this._jitterPosition();
      }

      // 4) Actualizar fix
      this._updateFix();

      // 5) Geofences
      this._checkGeofences();

      // 6) Actualizar modo 2D/3D según sats usados
      const inUse = [...this.satellites.values()].filter(s => s.inUse).length;
      if (inUse >= 4 && this.state !== GPSState.FIX_3D) {
        this.state = GPSState.FIX_3D;
      } else if (inUse >= 3 && this.state === GPSState.FIX_3D) {
        this.state = GPSState.FIX_2D;
      } else if (inUse < 3 && this.state !== GPSState.ACQUIRING) {
        this.state = GPSState.ACQUIRING;
        this.fix.valid = false;
        this.metrics.fixesLost++;
        logger.warn('VGPS', 'fix perdido (pocos satélites)');
        this.bus?.raiseInterrupt?.('IRQ_GPS', {
          source: 'vgps', event: 'fix-lost',
        }, 'vgps');
      }
    }

    // 7) Consumo
    this._updatePower();

    // 8) Historial
    this._pushHistory();

    // 9) Emitir
    this._emit();

    // 10) Notificar cambios de velocidad
    this._detectSpeedChange();

    this.tickCount++;
  }

  _updateAcquisition() {
    if (!this.startupTs) {
      this.startupTs = Date.now();
      return;
    }
    const elapsed = Date.now() - this.startupTs;
    const targetTTFF = TTFF_MS[this.startup] || TTFF_MS[StartupType.WARM];

    // Simular progreso con algo de azar (95% de éxito)
    const effective = targetTTFF * (0.6 + Math.random() * 0.8);

    if (elapsed >= effective) {
      // Adquirir fix
      this.lastTTFF = elapsed;
      this.metrics.ttffSamples.push(elapsed);
      if (this.metrics.ttffSamples.length > 20) this.metrics.ttffSamples.shift();
      this.metrics.avgTTFFMs = this.metrics.ttffSamples.reduce((a, b) => a + b, 0) / this.metrics.ttffSamples.length;
      this.metrics.fixesAcquired++;
      this.metrics.lastAcquisitionTs = Date.now();

      this._generateSatellites();
      this.state = GPSState.FIX_3D;
      this.fix.valid = true;
      this.fix.fixTs = Date.now();

      logger.info('VGPS',
        `✓ fix adquirido (TTFF=${elapsed}ms, startup=${this.startup}, sats=${this.satellites.size})`);

      this.bus?.raiseInterrupt?.('IRQ_GPS', {
        source: 'vgps', event: 'fix-acquired', ttffMs: elapsed, sats: this.satellites.size,
      }, 'vgps');
      this.bus?.raiseInterrupt?.('IRQ_GPS', {
        source: 'vgps', event: 'ttff-measured', ms: elapsed,
      }, 'vgps');
    }
  }

  _generateSatellites() {
    this.satellites.clear();
    for (const constellation of this.constellations) {
      const cfg = CONSTELLATION_SATS[constellation];
      if (!cfg) continue;
      const count = Math.floor(randRange(cfg.min, cfg.max + 1));
      for (let i = 0; i < count; i++) {
        const prn = i + 1 + Math.floor(Math.random() * 100);
        const elevation = Math.random() * 90;
        // A mayor elevación, mayor SNR
        const snrBase = 20 + (elevation / 90) * 25;
        const snr = snrBase + (Math.random() - 0.5) * 6;
        // 70% de probabilidad de estar en uso si elevación > 10
        const inUse = elevation > 10 && Math.random() < 0.7;
        const key = `${constellation}:${prn}`;
        this.satellites.set(key, new Satellite({
          prn, constellation, elevation, azimuth: Math.random() * 360,
          snr: clamp(snr, 15, 50),
          inUse,
          band: cfg.band,
        }));
      }
    }
  }

  _updateSatellites() {
    // Los SNR fluctúan y algunos sats entran/salen de uso
    for (const sat of this.satellites.values()) {
      sat.snr = clamp(sat.snr + (Math.random() - 0.5) * 2, 15, 50);
      sat.elevation = clamp(sat.elevation + (Math.random() - 0.5) * 0.5, 0, 90);
      sat.azimuth = (sat.azimuth + (Math.random() - 0.5) * 1 + 360) % 360;
      sat.inUse = sat.elevation > 10 && sat.snr > 22 && Math.random() < 0.85;
      sat.lastUpdate = Date.now();
    }

    // Reemplazar satélites que "se ponen" (elevación < 5)
    for (const [key, sat] of [...this.satellites.entries()]) {
      if (sat.elevation < 5) {
        this.satellites.delete(key);
      }
    }
    // Añadir nuevos ocasionalmente
    if (Math.random() < 0.3) {
      const constellation = this.constellations[Math.floor(Math.random() * this.constellations.length)];
      const cfg = CONSTELLATION_SATS[constellation];
      if (cfg) {
        const prn = Math.floor(Math.random() * 200);
        const key = `${constellation}:${prn}`;
        if (!this.satellites.has(key)) {
          const elevation = Math.random() * 90;
          this.satellites.set(key, new Satellite({
            prn, constellation, elevation, azimuth: Math.random() * 360,
            snr: clamp(20 + (elevation / 90) * 25 + (Math.random() - 0.5) * 6, 15, 50),
            inUse: elevation > 10,
            band: cfg.band,
          }));
        }
      }
    }
  }

  _jitterPosition() {
    // Posición estática: jitter de precisión
    const acc = MODE_ACCURACY_M[this.mode] || MODE_ACCURACY_M[GPSMode.BALANCED];
    const jitterM = acc.h * 0.3;
    // 1 grado lat ≈ 111km
    const dLat = (Math.random() - 0.5) * (jitterM / 111000);
    const dLon = (Math.random() - 0.5) * (jitterM / (111000 * Math.cos(deg2rad(this.currentPosition.lat))));
    this.currentPosition.lat = this.homePosition.lat + dLat;
    this.currentPosition.lon = this.homePosition.lon + dLon;
    this.currentPosition.alt = this.homePosition.alt + (Math.random() - 0.5) * acc.v;
  }

  _advanceRoute() {
    const dtSec = this._currentTickInterval() / 1000;
    const distance = this.route.speedMps * dtSec;
    const pos = this.route.advance(distance);
    if (pos) {
      this.currentPosition.lat = pos.lat;
      this.currentPosition.lon = pos.lon;
      this.currentPosition.alt = pos.alt ?? this.currentPosition.alt;
    }
    if (this.route.finished) {
      this.metrics.routesCompleted++;
      logger.info('VGPS', `ruta "${this.route.name}" completada`);
      this.route = null;
    }
  }

  _updateFix() {
    const inUse = [...this.satellites.values()].filter(s => s.inUse);
    const acc = MODE_ACCURACY_M[this.mode] || MODE_ACCURACY_M[GPSMode.BALANCED];
    const accBoost = 1 + (1 - Math.min(1, inUse.length / 8)) * 2;   // peor con menos sats

    // Calcular heading si nos estamos moviendo
    let speed = 0;
    let heading = this.fix.heading;
    if (this.route && !this.route.finished) {
      speed = this.route.speedMps;
      // heading del segmento actual
      const wp = this.route.waypoints;
      const from = wp[this.route.currentIndex];
      const to   = wp[this.route.currentIndex + 1];
      if (from && to) {
        heading = rad2deg(Math.atan2(to.lon - from.lon, to.lat - from.lat));
        if (heading < 0) heading += 360;
      }
    } else {
      // Ruido de velocidad
      speed = this._lastSpeed * 0.9;
    }

    this.fix = {
      valid:        true,
      lat:          parseFloat(this.currentPosition.lat.toFixed(7)),
      lon:          parseFloat(this.currentPosition.lon.toFixed(7)),
      alt:          parseFloat(this.currentPosition.alt.toFixed(2)),
      altGeoid:     parseFloat((this.currentPosition.alt - 48).toFixed(2)),
      speedMps:     parseFloat(speed.toFixed(2)),
      heading:      parseFloat(heading.toFixed(1)),
      accuracyH:    parseFloat((acc.h * accBoost).toFixed(2)),
      accuracyV:    parseFloat((acc.v * accBoost).toFixed(2)),
      hdop:         parseFloat((1.0 + Math.random() * 1.5).toFixed(2)),
      vdop:         parseFloat((1.2 + Math.random() * 1.8).toFixed(2)),
      pdop:         parseFloat((1.5 + Math.random() * 2.0).toFixed(2)),
      satsUsed:     inUse.length,
      satsVisible:  this.satellites.size,
      fixTs:        this.fix.fixTs || Date.now(),
      lastUpdateTs: Date.now(),
    };

    for (const fn of this.fixSubscribers) {
      try { fn(this.fix); } catch (_) {}
    }
  }

  _checkGeofences() {
    for (const gf of this.geofences.values()) {
      const inside = gf.contains(this.fix.lat, this.fix.lon);
      if (inside && !gf.inside) {
        gf.inside = true;
        gf.enterCount++;
        this.metrics.geofenceEntries++;
        logger.info('VGPS', `📍 geofence ENTER: ${gf.name}`);
        if (gf.onEnter) try { gf.onEnter(gf); } catch (_) {}
        this.bus?.raiseInterrupt?.('IRQ_GPS', {
          source: 'vgps', event: 'geofence-entered', id: gf.id, name: gf.name,
        }, 'vgps');
        for (const fn of this.geofenceSubscribers) {
          try { fn({ type: 'entered', geofence: gf.snapshot() }); } catch (_) {}
        }
      } else if (!inside && gf.inside) {
        gf.inside = false;
        gf.exitCount++;
        this.metrics.geofenceExits++;
        logger.info('VGPS', `📍 geofence EXIT: ${gf.name}`);
        if (gf.onExit) try { gf.onExit(gf); } catch (_) {}
        this.bus?.raiseInterrupt?.('IRQ_GPS', {
          source: 'vgps', event: 'geofence-exited', id: gf.id, name: gf.name,
        }, 'vgps');
        for (const fn of this.geofenceSubscribers) {
          try { fn({ type: 'exited', geofence: gf.snapshot() }); } catch (_) {}
        }
      }
    }
  }

  _updatePower() {
    if (this.state === GPSState.OFF) {
      this.currentPowerMw = 0;
      return;
    }
    const base = MODE_POWER_MW[this.mode] || MODE_POWER_MW[GPSMode.BALANCED];
    // Con mala señal, más potencia (busca más)
    const satsUsed = this.fix.satsUsed || 0;
    const poorSignalPenalty = satsUsed < 5 ? 1.3 : 1.0;
    this.currentPowerMw = base * poorSignalPenalty;
  }

  _pushHistory() {
    if (!this.fix.valid) return;
    this.history.ts.push(Date.now());
    this.history.lat.push(this.fix.lat);
    this.history.lon.push(this.fix.lon);
    this.history.alt.push(this.fix.alt);
    this.history.speed.push(this.fix.speedMps);
    this.history.heading.push(this.fix.heading);
    this.history.accuracyH.push(this.fix.accuracyH);
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  _detectSpeedChange() {
    const s = this.fix.speedMps;
    const delta = Math.abs(s - this._lastSpeed);
    if (delta > 0.5) {
      this.metrics.speedChanges++;
      for (const fn of this.speedSubscribers) {
        try { fn({ speedMps: s, prevSpeed: this._lastSpeed, delta }); } catch (_) {}
      }
    }
    this._lastSpeed = s;
  }

  // ═══════════════════════════════════════════════════════════
  // ENCENDIDO / APAGADO
  // ═══════════════════════════════════════════════════════════

  async powerOn({ startup = StartupType.WARM } = {}) {
    if (this.airplane) {
      logger.warn('VGPS', 'powerOn rechazado: modo avión activo');
      return false;
    }
    if (this.state !== GPSState.OFF) return true;

    if (!this.supportedStartups.includes(startup)) {
      logger.warn('VGPS', `startup inválido: ${startup}`);
      startup = StartupType.WARM;
    }

    this.startup = startup;
    this.startupTs = Date.now();
    this.state = GPSState.ACQUIRING;
    this.metrics.powerOns++;

    logger.info('VGPS', `encendiendo (startup=${startup}, TTFF estimado=${TTFF_MS[startup]}ms)`);
    this.bus?.raiseInterrupt?.('IRQ_GPS', {
      source: 'vgps', event: 'acquiring', startup,
    }, 'vgps');
    this._emit();
    return true;
  }

  async powerOff() {
    if (this.state === GPSState.OFF) return true;
    this.state = GPSState.OFF;
    this.fix.valid = false;
    this.satellites.clear();
    this.currentPowerMw = 0;
    this.metrics.powerOffs++;
    logger.info('VGPS', 'apagado');
    this._emit();
    return true;
  }

  setAirplaneMode(on) {
    this.airplane = !!on;
    logger.info('VGPS', `airplane mode ${this.airplane ? 'ON' : 'OFF'}`);
    if (this.airplane) {
      this.powerOff().catch(() => {});
    }
    this._emit();
  }

  setMode(mode) {
    if (!Object.values(GPSMode).includes(mode)) {
      logger.warn('VGPS', `modo inválido: ${mode}`);
      return false;
    }
    if (this.mode === mode) return true;
    const prev = this.mode;
    this.mode = mode;
    logger.info('VGPS', `modo: ${prev} → ${mode}`);
    // Reajustar tick
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // RUTAS SIMULADAS
  // ═══════════════════════════════════════════════════════════

  startRoute({ name = 'ruta', waypoints, speedMps = 10 }) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) {
      logger.warn('VGPS', 'startRoute: se necesitan al menos 2 waypoints');
      return false;
    }
    this.route = new Route({ name, waypoints, speedMps });
    logger.info('VGPS', `ruta "${name}" iniciada: ${waypoints.length} waypoints a ${speedMps} m/s`);
    this._emit();
    return true;
  }

  stopRoute() {
    if (!this.route) return false;
    logger.info('VGPS', `ruta "${this.route.name}" detenida`);
    this.route = null;
    this._emit();
    return true;
  }

  // Simulación de trayecto predefinido
  simulateDrive({ speedMps = 14 } = {}) {
    const madrid = [
      { lat: 40.4168, lon: -3.7038, alt: 650 },  // Puerta del Sol
      { lat: 40.4205, lon: -3.6985, alt: 655 },
      { lat: 40.4237, lon: -3.6906, alt: 660 },
      { lat: 40.4274, lon: -3.6832, alt: 665 },
      { lat: 40.4310, lon: -3.6757, alt: 670 },
      { lat: 40.4351, lon: -3.6684, alt: 675 },
    ];
    return this.startRoute({ name: 'Paseo del Prado', waypoints: madrid, speedMps });
  }

  simulateWalk({ speedMps = 1.4 } = {}) {
    const sol = [
      { lat: 40.4168, lon: -3.7038, alt: 650 },
      { lat: 40.4172, lon: -3.7033, alt: 651 },
      { lat: 40.4176, lon: -3.7026, alt: 652 },
      { lat: 40.4179, lon: -3.7019, alt: 652 },
    ];
    return this.startRoute({ name: 'Paseo por Sol', waypoints: sol, speedMps });
  }

  // ═══════════════════════════════════════════════════════════
  // A-GPS
  // ═══════════════════════════════════════════════════════════

  async downloadAGPSData() {
    logger.info('VGPS', 'descargando datos A-GPS...');
    await this._delay(500 + Math.random() * 800);
    this.agps.lastDownload = Date.now();
    this.agps.almanacDownloaded = true;
    this.agps.ephemerisDownloaded = true;
    this.agps.xtraValidUntil = Date.now() + 24 * 3600 * 1000;
    this.metrics.agpsDownloads++;
    logger.info('VGPS', '✓ A-GPS descargado (almanaque + efemérides + XTRA)');
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // GEOFENCES
  // ═══════════════════════════════════════════════════════════

  addGeofence({ id = null, name, lat, lon, radiusM, onEnter, onExit }) {
    id = id || `gf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (this.geofences.has(id)) {
      logger.warn('VGPS', `geofence ${id} ya existe`);
      return null;
    }
    const gf = new Geofence({ id, name, lat, lon, radiusM, onEnter, onExit });
    this.geofences.set(id, gf);
    logger.info('VGPS', `geofence añadido: ${name} (${radiusM}m alrededor de ${lat},${lon})`);
    return gf.snapshot();
  }

  removeGeofence(id) {
    return this.geofences.delete(id);
  }

  listGeofences() {
    return [...this.geofences.values()].map(gf => gf.snapshot());
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  hasFix() { return this.fix.valid; }
  getFix() { return { ...this.fix }; }
  getState() { return this.state; }
  getMode() { return this.mode; }

  getVisibleSatellites() {
    return [...this.satellites.values()].map(s => s.snapshot());
  }

  getSatellitesByConstellation(constellation) {
    return [...this.satellites.values()]
      .filter(s => s.constellation === constellation)
      .map(s => s.snapshot());
  }

  getConstellationStatus() {
    const out = {};
    for (const c of this.constellations) {
      const sats = [...this.satellites.values()].filter(s => s.constellation === c);
      out[c] = {
        visible: sats.length,
        inUse:   sats.filter(s => s.inUse).length,
        avgSnr:  sats.length ? parseFloat((sats.reduce((a, s) => a + s.snr, 0) / sats.length).toFixed(1)) : 0,
      };
    }
    return out;
  }

  getLocation() {
    if (!this.fix.valid) return null;
    return {
      lat: this.fix.lat,
      lon: this.fix.lon,
      alt: this.fix.alt,
      accuracyH: this.fix.accuracyH,
      accuracyV: this.fix.accuracyV,
      speedMps: this.fix.speedMps,
      heading: this.fix.heading,
      ts: this.fix.lastUpdateTs,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onFix(fn) {
    this.fixSubscribers.add(fn);
    return () => this.fixSubscribers.delete(fn);
  }

  onSpeedChange(fn) {
    this.speedSubscribers.add(fn);
    return () => this.speedSubscribers.delete(fn);
  }

  onGeofence(fn) {
    this.geofenceSubscribers.add(fn);
    return () => this.geofenceSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VGPS', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:         this.model,
      state:         this.state,
      mode:          this.mode,
      airplane:      this.airplane,
      fix:           { ...this.fix },
      satellites:    this.satellites.size,
      satsInUse:     [...this.satellites.values()].filter(s => s.inUse).length,
      constellations:this.getConstellationStatus(),
      agps:          { ...this.agps },
      indoor:        this.indoor,
      route:         this.route ? { name: this.route.name, finished: this.route.finished } : null,
      geofences:     this.geofences.size,
      powerMw:       parseFloat(this.currentPowerMw.toFixed(1)),
      lastTTFF:      this.lastTTFF,
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      mode:        this.mode,
      metrics:     { ...this.metrics },
      lastTTFF:    this.lastTTFF,
      satCount:    this.satellites.size,
      geofences:   this.geofences.size,
    };
  }

  dump() {
    const s = this.getStats();
    const f = this.fix;
    const lines = [
      `VGPS [${s.state}] — ${s.model}`,
      `  mode:        ${s.mode}`,
      `  airplane:    ${this.airplane}`,
      `  fix:         ${f.valid ? `${f.lat}, ${f.lon} (±${f.accuracyH}m)` : 'no fix'}`,
      `  alt:         ${f.alt}m (geoid ${f.altGeoid}m)`,
      `  speed:       ${f.speedMps} m/s (${(f.speedMps * 3.6).toFixed(1)} km/h)  heading ${f.heading}°`,
      `  DOP:         HDOP=${f.hdop} VDOP=${f.vdop} PDOP=${f.pdop}`,
      `  satélites:   ${f.satsUsed} en uso / ${f.satsVisible} visibles`,
      `  constelaciones:`,
    ];
    const cs = this.getConstellationStatus();
    for (const [c, status] of Object.entries(cs)) {
      lines.push(`    ${c.padEnd(8)} visible=${status.visible} inUse=${status.inUse} avgSNR=${status.avgSnr}`);
    }
    lines.push(`  A-GPS:       almanaque=${this.agps.almanacDownloaded} efemérides=${this.agps.ephemerisDownloaded}`);
    if (this.lastTTFF) lines.push(`  último TTFF: ${this.lastTTFF}ms (avg ${s.metrics.avgTTFFMs.toFixed(0)}ms)`);
    lines.push(`  ruta:        ${this.route ? this.route.name : 'ninguna'}`);
    lines.push(`  geofences:   ${this.geofences.size}`);
    lines.push(`  consumo:     ${this.currentPowerMw.toFixed(0)}mW`);
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:       [...this.history.ts],
      lat:      [...this.history.lat],
      lon:      [...this.history.lon],
      alt:      [...this.history.alt],
      speed:    [...this.history.speed],
      heading:  [...this.history.heading],
      accuracyH:[...this.history.accuracyH],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
