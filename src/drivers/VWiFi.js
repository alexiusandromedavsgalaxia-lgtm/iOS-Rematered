// src/drivers/VWiFi.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VWiFi
 * ═══════════════════════════════════════════════════════════════
 *
 * Radio WiFi virtual. Modela el comportamiento completo del stack
 * WiFi de un iPhone: escaneo, asociación, DHCP, roaming, hotspot,
 * estadísticas por paquete, y estados de error.
 *
 *   - Estados: off / enabling / on / scanning / connecting /
 *     connected / disconnecting / error / airplane
 *   - Bandas: 2.4 GHz / 5 GHz / 6 GHz (WiFi 7)
 *   - Anchos de canal: 20 / 40 / 80 / 160 / 320 MHz
 *   - PHY: 802.11be (WiFi 7) con MLO (Multi-Link Operation)
 *   - Seguridad: OPEN / WEP / WPA2 / WPA3 / OWE / SAE
 *   - Escaneo activo/pasivo con resultados progresivos
 *   - Asociación con handshake 4-way WPA simulado (con latencias)
 *   - DHCP simulado con pool de IPs
 *   - Roaming entre BSSes de la misma ESS
 *   - Hotspot / tethering
 *   - Modo avión, bajo consumo, background scan
 *   - Estadísticas: bytes tx/rx, paquetes, errores, retransmisiones
 *   - Historial de RSSI/SNR/throughput (para gráficos)
 *   - IRQs: IRQ_WIFI con tipos scan-complete, connected, disconnected,
 *     ip-assigned, roam, error
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const WiFiState = {
  OFF:           'off',
  ENABLING:      'enabling',
  ON:            'on',
  SCANNING:      'scanning',
  CONNECTING:    'connecting',
  CONNECTED:     'connected',
  DISCONNECTING: 'disconnecting',
  ERROR:         'error',
  AIRPLANE:      'airplane',
};

export const WiFiBand = {
  BAND_2_4: '2.4',
  BAND_5:   '5',
  BAND_6:   '6',
};

export const WiFiSecurity = {
  OPEN:  'open',
  WEP:   'wep',
  WPA2:  'wpa2',
  WPA3:  'wpa3',
  OWE:   'owe',     // Opportunistic Wireless Encryption
  SAE:   'sae',     // WPA3-Personal
  WPA2_ENT: 'wpa2-ent',
  WPA3_ENT: 'wpa3-ent',
};

export const WiFiPHY = {
  A:   '802.11a',
  B:   '802.11b',
  G:   '802.11g',
  N:   '802.11n',
  AC:  '802.11ac',
  AX:  '802.11ax',
  BE:  '802.11be',   // WiFi 7
};

// ───────────────────────────────────────────────────────────────
// BSS — un punto de acceso visible
// ───────────────────────────────────────────────────────────────
class BSS {
  constructor({ ssid, bssid, band, channel, rssi, security, phy, width, hidden = false }) {
    this.ssid     = ssid;
    this.bssid    = bssid;
    this.band     = band;
    this.channel  = channel;
    this.rssi     = rssi;         // dBm (-30 excelente, -90 malo)
    this.security = security;
    this.phy      = phy;
    this.width    = width;        // MHz
    this.hidden   = hidden;
    this.lastSeen = Date.now();
  }

  snr() {
    // SNR aproximado asumiendo noise floor de -95 dBm
    return this.rssi - (-95);
  }

  qualityPct() {
    // Mapeo simple: -30 → 100%, -90 → 0%
    const v = (this.rssi + 90) / 60;
    return Math.max(0, Math.min(100, v * 100));
  }

  maxThroughputMbps() {
    // Estimación basada en PHY, ancho y RSSI
    const phyBase = {
      [WiFiPHY.B]: 11, [WiFiPHY.G]: 54, [WiFiPHY.N]: 150,
      [WiFiPHY.AC]: 866, [WiFiPHY.AX]: 1200, [WiFiPHY.BE]: 2400,
    }[this.phy] || 100;
    const widthFactor = this.width / 80;
    const rssiFactor = Math.max(0.1, Math.min(1, (this.rssi + 90) / 60));
    return phyBase * widthFactor * rssiFactor;
  }

  snapshot() {
    return {
      ssid:     this.ssid,
      bssid:    this.bssid,
      band:     this.band,
      channel:  this.channel,
      rssi:     this.rssi,
      snr:      this.snr(),
      quality:  this.qualityPct(),
      security: this.security,
      phy:      this.phy,
      width:    this.width,
      hidden:   this.hidden,
      maxMbps:  parseFloat(this.maxThroughputMbps().toFixed(1)),
      lastSeen: this.lastSeen,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Perfil guardado (red conocida)
// ───────────────────────────────────────────────────────────────
class WiFiProfile {
  constructor(ssid, security, password = null) {
    this.ssid     = ssid;
    this.security = security;
    this.password = password;   // en un OS real: cifrada; aquí plaintext
    this.addedAt  = Date.now();
    this.lastUsed = null;
    this.autoJoin = true;
    this.priority = 50;         // 0-100
  }

  snapshot() {
    return {
      ssid:     this.ssid,
      security: this.security,
      autoJoin: this.autoJoin,
      priority: this.priority,
      addedAt:  this.addedAt,
      lastUsed: this.lastUsed,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Banda base — simula el PHY y los canales
// ───────────────────────────────────────────────────────────────
class Baseband {
  constructor() {
    this.channels = {
      [WiFiBand.BAND_2_4]: [1,2,3,4,5,6,7,8,9,10,11,12,13,14],
      [WiFiBand.BAND_5]:   [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165],
      [WiFiBand.BAND_6]:   Array.from({ length: 59 }, (_, i) => 1 + i * 4), // canales 1, 5, 9... de 6GHz
    };
  }

  freqMHz(band, channel) {
    if (band === WiFiBand.BAND_2_4) {
      return channel === 14 ? 2484 : 2412 + (channel - 1) * 5;
    }
    if (band === WiFiBand.BAND_5) {
      return 5000 + channel * 5;
    }
    // 6 GHz
    return 5950 + channel * 5;
  }

  channelToBand(channel) {
    if (channel <= 14) return WiFiBand.BAND_2_4;
    if (channel <= 196) return WiFiBand.BAND_5;
    return WiFiBand.BAND_6;
  }
}

// ───────────────────────────────────────────────────────────────
// VWiFi — driver completo
// ───────────────────────────────────────────────────────────────
export class VWiFi {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VWiFi';
    this.model = DEVICE_MODEL.radios.wifi.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = WiFiState.OFF;
    this.airplane    = false;
    this.poweredSave = false;

    // Config del radio
    this.supportedPHY     = [WiFiPHY.B, WiFiPHY.G, WiFiPHY.N, WiFiPHY.AC, WiFiPHY.AX, WiFiPHY.BE];
    this.supportedBands   = [WiFiBand.BAND_2_4, WiFiBand.BAND_5, WiFiBand.BAND_6];
    this.supportedWidths  = [20, 40, 80, 160, 320];
    this.maxMimo          = DEVICE_MODEL.radios.wifi.mimo;    // 2x2
    this.maxSpeedMbps     = DEVICE_MODEL.radios.wifi.maxSpeedGbps * 1000; // 5800

    // BSSes escaneados
    this.scanResults = [];         // BSS[]
    this.visibleNetworks = new Map(); // bssid -> BSS

    // Conexión actual
    this.connectedBSS = null;
    this.connectedSince = null;
    this.ipAddress = null;
    this.gateway = null;
    this.dns = [];
    this.subnet = '255.255.255.0';

    // Perfiles guardados
    this.profiles = new Map();      // ssid -> WiFiProfile
    this.autoJoinEnabled = true;

    // Hotspot
    this.hotspot = {
      enabled: false,
      ssid: null,
      password: null,
      clients: new Map(),
      startedAt: null,
    };

    // Banda base
    this.baseband = new Baseband();

    // Estadísticas de tráfico
    this.stats = {
      txBytes:        0,
      rxBytes:        0,
      txPackets:      0,
      rxPackets:      0,
      txErrors:       0,
      rxErrors:       0,
      retransmits:    0,
      drops:          0,
      beaconLosses:   0,
    };

    // Historial para gráficos
    this.historySize = 120;
    this.history = {
      ts:       [],
      rssi:     [],
      snr:      [],
      txMbps:   [],
      rxMbps:   [],
    };

    // Simulación de tráfico (bytes/s)
    this.currentTxBps = 0;
    this.currentRxBps = 0;

    // Configuración de red virtual
    this.dhcpPool = {
      base:    '192.168.1.',
      used:    new Set(),
      nextHost: 100,
    };
    this.dnsServers = ['8.8.8.8', '1.1.1.1'];

    // Suscriptores
    this.subscribers        = new Set();
    this.scanSubscribers    = new Set();
    this.connectionSubscribers = new Set();

    // Tick loop
    this.tickIntervalMs = 250;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas globales
    this.metrics = {
      scansPerformed:     0,
      connectAttempts:    0,
      connectSuccesses:   0,
      connectFailures:    0,
      disconnects:        0,
      roams:              0,
      dhcpLeases:         0,
      currentScanId:      null,
      lastScanDurationMs: 0,
      startedAt:          null,
    };

    // Scan en curso
    this.activeScan = null;

    // WiFi conocido — sembramos algunas redes típicas para que el OS
    // tenga algo con lo que interactuar desde el primer arranque.
    this._seedNetworks();
    this._seedProfiles();

    logger.kernel('VWiFi', `creado: ${this.model} (${this.maxMimo}, WiFi 7)`);
  }

  _seedNetworks() {
    // Estas redes aparecerán en los escaneos de forma estable.
    // Variamos ligeramente el RSSI con cada escaneo para realismo.
    this._seeds = [
      { ssid: 'Casa-5G',     band: WiFiBand.BAND_5,   channel: 44,  rssi: -42, security: WiFiSecurity.WPA3, phy: WiFiPHY.BE, width: 160, hidden: false },
      { ssid: 'Casa-2.4G',   band: WiFiBand.BAND_2_4, channel: 6,   rssi: -48, security: WiFiSecurity.WPA2, phy: WiFiPHY.AX, width: 40,  hidden: false },
      { ssid: 'Vecino_5G',   band: WiFiBand.BAND_5,   channel: 149, rssi: -68, security: WiFiSecurity.WPA2, phy: WiFiPHY.AC, width: 80,  hidden: false },
      { ssid: 'Oficina-WiFi',band: WiFiBand.BAND_5,   channel: 36,  rssi: -58, security: WiFiSecurity.WPA3_ENT, phy: WiFiPHY.AX, width: 80, hidden: false },
      { ssid: 'CafeGratis',  band: WiFiBand.BAND_2_4, channel: 11,  rssi: -72, security: WiFiSecurity.OPEN, phy: WiFiPHY.N,  width: 20,  hidden: false },
      { ssid: 'iOSR-Test-6E',band: WiFiBand.BAND_6,   channel: 37,  rssi: -55, security: WiFiSecurity.WPA3, phy: WiFiPHY.BE, width: 320, hidden: false },
      { ssid: '',            band: WiFiBand.BAND_5,   channel: 100, rssi: -80, security: WiFiSecurity.WPA2, phy: WiFiPHY.AC, width: 40,  hidden: true  },
    ];
  }

  _seedProfiles() {
    this.profiles.set('Casa-5G', new WiFiProfile('Casa-5G', WiFiSecurity.WPA3, 'password123'));
    this.profiles.set('Casa-2.4G', new WiFiProfile('Casa-2.4G', WiFiSecurity.WPA2, 'password123'));
    this.profiles.set('Oficina-WiFi', new WiFiProfile('Oficina-WiFi', WiFiSecurity.WPA3_ENT));
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();
    logger.info('VWiFi', `✓ init: ${this.model}, soporta ${this.supportedPHY.join(', ')}`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'ready' }, 'vwifi');
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
    logger.info('VWiFi', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;
    const now = Date.now();

    // Actualizar RSSI de las redes conectadas (roaming)
    if (this.state === WiFiState.CONNECTED && this.connectedBSS) {
      // RSSI fluctúa ligeramente
      this.connectedBSS.rssi += (Math.random() - 0.5) * 2;
      this.connectedBSS.rssi = Math.max(-92, Math.min(-25, this.connectedBSS.rssi));

      // ¿Se ha perdido la conexión?
      if (this.connectedBSS.rssi < -90) {
        this.metrics.beaconLosses++;
        if (this.metrics.beaconLosses > 20) {
          logger.warn('VWiFi', `beacon perdido: ${this.connectedBSS.ssid}`);
          this.disconnect('beacon-lost');
        }
      } else {
        this.metrics.beaconLosses = Math.max(0, this.metrics.beaconLosses - 1);
      }

      // Simular tráfico (bytes/s)
      this._simulateTraffic();
    }

    // Si hay un scan en curso, actualizarlo
    if (this.activeScan) {
      this._updateScan();
    }

    // Auto-join: si estamos desconectados y hay perfiles conocidos, intentar
    if (this.state === WiFiState.ON && this.autoJoinEnabled && !this.connectedBSS && this.visibleNetworks.size > 0) {
      const candidate = this._bestAutoJoinCandidate();
      if (candidate) {
        this.connect(candidate.ssid).catch(() => {});
      }
    }

    // Push history
    this._pushHistory();
    this.tickCount++;
    this._emit();
  }

  _simulateTraffic() {
    // Tráfico depende del estado y de la señal
    const rssiFactor = Math.max(0.05, (this.connectedBSS.rssi + 90) / 60);
    const baseTx = 200_000;   // 200 KB/s
    const baseRx = 500_000;   // 500 KB/s
    const spike = Math.random() < 0.1 ? 10 : 1;
    this.currentTxBps = baseTx * rssiFactor * spike * (0.7 + Math.random() * 0.6);
    this.currentRxBps = baseRx * rssiFactor * spike * (0.7 + Math.random() * 0.6);

    const dtSec = this.tickIntervalMs / 1000;
    const txBytes = this.currentTxBps * dtSec;
    const rxBytes = this.currentRxBps * dtSec;
    this.stats.txBytes += txBytes;
    this.stats.rxBytes += rxBytes;
    this.stats.txPackets += Math.floor(txBytes / 1400);
    this.stats.rxPackets += Math.floor(rxBytes / 1400);

    // Errores ocasionales
    if (Math.random() < 0.005) this.stats.txErrors++;
    if (Math.random() < 0.005) this.stats.rxErrors++;
    if (Math.random() < 0.01) this.stats.retransmits++;
  }

  _updateScan() {
    const scan = this.activeScan;
    const elapsed = Date.now() - scan.startTs;
    if (elapsed >= scan.durationMs) {
      // Fin del scan
      this.scanResults = [...this.visibleNetworks.values()];
      this.metrics.lastScanDurationMs = elapsed;
      this.state = WiFiState.ON;
      const results = this.scanResults.map(b => b.snapshot());
      logger.info('VWiFi', `scan completo: ${results.length} redes en ${elapsed}ms`);
      for (const fn of this.scanSubscribers) {
        try { fn({ type: 'complete', results, durationMs: elapsed }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_WIFI', {
        source: 'vwifi', event: 'scan-complete', count: results.length, durationMs: elapsed,
      }, 'vwifi');
      this.activeScan = null;
      return;
    }

    // Progreso: a mitad del scan aparecen redes
    if (!scan.halfReported && elapsed > scan.durationMs * 0.5) {
      scan.halfReported = true;
      const half = [...this.visibleNetworks.values()].slice(0, Math.ceil(this.visibleNetworks.size / 2));
      for (const fn of this.scanSubscribers) {
        try { fn({ type: 'progress', results: half.map(b => b.snapshot()) }); } catch (_) {}
      }
    }
  }

  _bestAutoJoinCandidate() {
    let best = null;
    let bestPriority = -Infinity;
    for (const bss of this.visibleNetworks.values()) {
      if (!bss.ssid) continue;    // hidden
      const profile = this.profiles.get(bss.ssid);
      if (!profile || !profile.autoJoin) continue;
      if (bss.rssi < -80) continue;
      const score = profile.priority + (bss.rssi + 90);
      if (score > bestPriority) {
        bestPriority = score;
        best = bss;
      }
    }
    return best;
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.rssi.push(this.connectedBSS ? this.connectedBSS.rssi : -100);
    this.history.snr.push(this.connectedBSS ? this.connectedBSS.snr() : 0);
    this.history.txMbps.push((this.currentTxBps * 8) / 1e6);
    this.history.rxMbps.push((this.currentRxBps * 8) / 1e6);
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ENCENDIDO / APAGADO
  // ═══════════════════════════════════════════════════════════

  async powerOn() {
    if (this.airplane) {
      logger.warn('VWiFi', 'powerOn rechazado: modo avión activo');
      return false;
    }
    if (this.state === WiFiState.ON || this.state === WiFiState.CONNECTED) return true;

    this.state = WiFiState.ENABLING;
    this._emit();
    logger.info('VWiFi', 'encendiendo radio...');
    await this._delay(200 + Math.random() * 300);

    this.state = WiFiState.ON;
    logger.info('VWiFi', '✓ radio on');
    this._emit();
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'powered-on' }, 'vwifi');

    // Auto-arrancar scan inicial
    setTimeout(() => this.scan().catch(() => {}), 300);
    return true;
  }

  async powerOff() {
    if (this.state === WiFiState.OFF) return true;

    if (this.connectedBSS) {
      await this.disconnect('power-off');
    }
    this.state = WiFiState.OFF;
    this.visibleNetworks.clear();
    this.scanResults = [];
    logger.info('VWiFi', 'radio off');
    this._emit();
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'powered-off' }, 'vwifi');
    return true;
  }

  setAirplaneMode(on) {
    this.airplane = !!on;
    logger.info('VWiFi', `airplane mode ${this.airplane ? 'ON' : 'OFF'}`);
    if (this.airplane) {
      this.powerOff().catch(() => {});
      this.state = WiFiState.AIRPLANE;
    } else {
      this.state = WiFiState.OFF;
    }
    this._emit();
  }

  setLowPowerMode(on) {
    this.poweredSave = !!on;
    logger.info('VWiFi', `wifi low power ${this.poweredSave ? 'ON' : 'OFF'}`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // ESCANEO
  // ═══════════════════════════════════════════════════════════

  async scan({ durationMs = 2000, active = true, band = null } = {}) {
    if (this.state === WiFiState.OFF || this.state === WiFiState.AIRPLANE) {
      logger.warn('VWiFi', 'scan rechazado: radio off');
      return null;
    }
    if (this.activeScan) {
      logger.warn('VWiFi', 'scan ya en curso');
      return null;
    }

    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.state = WiFiState.SCANNING;
    this.metrics.scansPerformed++;
    this.metrics.currentScanId = scanId;
    this.activeScan = {
      id: scanId,
      startTs: Date.now(),
      durationMs,
      active,
      band,
      halfReported: false,
    };

    logger.info('VWiFi', `scan iniciado: id=${scanId.slice(-6)} active=${active} band=${band || 'all'} duration=${durationMs}ms`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'scan-start', scanId }, 'vwifi');

    // Poblamos el set de redes visibles: partimos de los seeds y añadimos
    // algo de ruido aleatorio al RSSI.
    this.visibleNetworks.clear();
    for (const seed of this._seeds) {
      if (band && seed.band !== band) continue;
      const jitter = (Math.random() - 0.5) * 4;
      const bss = new BSS({
        ...seed,
        rssi: seed.rssi + jitter,
        bssid: this._fakeBssid(seed.ssid, seed.band, seed.channel),
      });
      this.visibleNetworks.set(bss.bssid, bss);
    }

    // ¿Añadimos alguna red aleatoria ocasional?
    if (Math.random() < 0.3) {
      const ssid = `Random-${Math.random().toString(36).slice(2, 6)}`;
      const bss = new BSS({
        ssid,
        bssid: this._fakeBssid(ssid, WiFiBand.BAND_2_4, 1),
        band: WiFiBand.BAND_2_4,
        channel: 1,
        rssi: -75 - Math.random() * 15,
        security: WiFiSecurity.WPA2,
        phy: WiFiPHY.N,
        width: 20,
      });
      this.visibleNetworks.set(bss.bssid, bss);
    }

    return scanId;
  }

  _fakeBssid(ssid, band, channel) {
    // Genera un BSSID determinista a partir de SSID+banda+canal
    let h = 0;
    const s = `${ssid}|${band}|${channel}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const hex = (n) => (n >>> 0).toString(16).padStart(2, '0').slice(-2);
    const parts = [];
    for (let i = 0; i < 6; i++) parts.push(hex(h * (i + 7)));
    return parts.join(':').toUpperCase();
  }

  // ═══════════════════════════════════════════════════════════
  // CONEXIÓN
  // ═══════════════════════════════════════════════════════════

  async connect(ssid, { password = null, timeoutMs = 5000 } = {}) {
    if (this.state === WiFiState.OFF || this.state === WiFiState.AIRPLANE) {
      logger.warn('VWiFi', 'connect rechazado: radio off');
      return false;
    }
    if (this.connectedBSS) {
      await this.disconnect('reconnect');
    }

    // Buscar BSS
    let target = null;
    for (const bss of this.visibleNetworks.values()) {
      if (bss.ssid === ssid) { target = bss; break; }
    }
    if (!target) {
      // Si no lo tenemos, escaneamos rápido
      await this.scan({ durationMs: 800 });
      for (const bss of this.visibleNetworks.values()) {
        if (bss.ssid === ssid) { target = bss; break; }
      }
    }
    if (!target) {
      logger.warn('VWiFi', `connect: red "${ssid}" no encontrada`);
      this.metrics.connectFailures++;
      return false;
    }

    this.state = WiFiState.CONNECTING;
    this.metrics.connectAttempts++;
    this._emit();
    logger.info('VWiFi', `conectando a "${ssid}" (${target.security}, ${target.phy}, ${target.width}MHz)...`);

    // Simular latencias del handshake
    // 1) Authentication
    await this._delay(80 + Math.random() * 120);
    // 2) Association
    await this._delay(60 + Math.random() * 100);
    // 3) 4-way handshake (solo si no es OPEN)
    if (target.security !== WiFiSecurity.OPEN) {
      if (!password && !this.profiles.has(ssid)) {
        logger.warn('VWiFi', `connect: "${ssid}" requiere contraseña`);
        this.state = WiFiState.ON;
        this.metrics.connectFailures++;
        this._emit();
        return false;
      }
      await this._delay(150 + Math.random() * 200);
    }
    // 4) DHCP
    const ip = this._allocateIP();
    if (!ip) {
      logger.error('VWiFi', 'DHCP: pool agotado');
      this.state = WiFiState.ON;
      this.metrics.connectFailures++;
      return false;
    }

    this.connectedBSS = target;
    this.connectedSince = Date.now();
    this.ipAddress = ip;
    this.gateway = '192.168.1.1';
    this.dns = [...this.dnsServers];
    this.metrics.connectSuccesses++;
    this.metrics.dhcpLeases++;
    this.state = WiFiState.CONNECTED;

    // Guardar perfil si no existía
    if (!this.profiles.has(ssid) && password) {
      const profile = new WiFiProfile(ssid, target.security, password);
      profile.lastUsed = Date.now();
      this.profiles.set(ssid, profile);
    } else if (this.profiles.has(ssid)) {
      this.profiles.get(ssid).lastUsed = Date.now();
    }

    logger.info('VWiFi', `✓ conectado a "${ssid}" (IP ${ip})`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', {
      source: 'vwifi', event: 'connected', ssid, ip, bssid: target.bssid,
    }, 'vwifi');
    this._emitConnection({ type: 'connected', ssid, ip, bssid: target.bssid });
    this._emit();
    return true;
  }

  async disconnect(reason = 'user') {
    if (!this.connectedBSS) return true;
    const ssid = this.connectedBSS.ssid;

    this.state = WiFiState.DISCONNECTING;
    this._emit();
    logger.info('VWiFi', `desconectando de "${ssid}" (${reason})...`);
    await this._delay(100 + Math.random() * 150);

    // Liberar IP
    if (this.ipAddress) this._releaseIP(this.ipAddress);

    this.connectedBSS = null;
    this.connectedSince = null;
    this.ipAddress = null;
    this.gateway = null;
    this.dns = [];
    this.state = WiFiState.ON;
    this.metrics.disconnects++;
    this.currentTxBps = 0;
    this.currentRxBps = 0;

    logger.info('VWiFi', `✓ desconectado de "${ssid}"`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', {
      source: 'vwifi', event: 'disconnected', ssid, reason,
    }, 'vwifi');
    this._emitConnection({ type: 'disconnected', ssid, reason });
    this._emit();
    return true;
  }

  async forget(ssid) {
    if (!this.profiles.has(ssid)) return false;
    this.profiles.delete(ssid);
    logger.info('VWiFi', `perfil olvidado: ${ssid}`);
    if (this.connectedBSS && this.connectedBSS.ssid === ssid) {
      await this.disconnect('forgotten');
    }
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // DHCP SIMULADO
  // ═══════════════════════════════════════════════════════════

  _allocateIP() {
    for (let i = 0; i < 200; i++) {
      const host = this.dhcpPool.nextHost++;
      if (this.dhcpPool.nextHost > 250) this.dhcpPool.nextHost = 100;
      const ip = `${this.dhcpPool.base}${host}`;
      if (!this.dhcpPool.used.has(ip)) {
        this.dhcpPool.used.add(ip);
        return ip;
      }
    }
    return null;
  }

  _releaseIP(ip) {
    this.dhcpPool.used.delete(ip);
  }

  // ═══════════════════════════════════════════════════════════
  // HOTSPOT
  // ═══════════════════════════════════════════════════════════

  async startHotspot({ ssid = `iPhone de iOSR`, password = null } = {}) {
    if (this.hotspot.enabled) return false;
    if (!password) password = Math.random().toString(36).slice(2, 12);
    this.hotspot = {
      enabled: true,
      ssid,
      password,
      clients: new Map(),
      startedAt: Date.now(),
    };
    logger.info('VWiFi', `hotspot iniciado: SSID="${ssid}" password="${password}"`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'hotspot-start', ssid }, 'vwifi');
    this._emit();
    return { ssid, password };
  }

  async stopHotspot() {
    if (!this.hotspot.enabled) return false;
    const { ssid } = this.hotspot;
    this.hotspot = { enabled: false, ssid: null, password: null, clients: new Map(), startedAt: null };
    logger.info('VWiFi', `hotspot detenido (era "${ssid}")`);
    this.bus?.raiseInterrupt?.('IRQ_WIFI', { source: 'vwifi', event: 'hotspot-stop' }, 'vwifi');
    this._emit();
    return true;
  }

  // Simula un cliente que se conecta al hotspot
  hotspotClientJoin(mac, hostname = 'unknown') {
    if (!this.hotspot.enabled) return false;
    const ip = this._allocateIP();
    this.hotspot.clients.set(mac, { mac, hostname, ip, joinedAt: Date.now() });
    logger.info('VWiFi', `hotspot cliente: ${hostname} (${mac}) → ${ip}`);
    this._emit();
    return ip;
  }

  hotspotClientLeave(mac) {
    const c = this.hotspot.clients.get(mac);
    if (!c) return false;
    this._releaseIP(c.ip);
    this.hotspot.clients.delete(mac);
    logger.info('VWiFi', `hotspot cliente salió: ${c.hostname}`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // PERFILES
  // ═══════════════════════════════════════════════════════════

  addProfile(ssid, security, password = null) {
    if (this.profiles.has(ssid)) {
      logger.warn('VWiFi', `perfil ya existe: ${ssid}`);
      return false;
    }
    this.profiles.set(ssid, new WiFiProfile(ssid, security, password));
    this._emit();
    return true;
  }

  setAutoJoin(ssid, on) {
    const p = this.profiles.get(ssid);
    if (!p) return false;
    p.autoJoin = !!on;
    this._emit();
    return true;
  }

  setProfilePriority(ssid, priority) {
    const p = this.profiles.get(ssid);
    if (!p) return false;
    p.priority = Math.max(0, Math.min(100, priority));
    this._emit();
    return true;
  }

  listProfiles() {
    return [...this.profiles.values()].map(p => p.snapshot());
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isConnected() {
    return this.state === WiFiState.CONNECTED && !!this.connectedBSS;
  }

  getCurrentNetwork() {
    return this.connectedBSS ? this.connectedBSS.snapshot() : null;
  }

  getVisibleNetworks() {
    return [...this.visibleNetworks.values()]
      .map(b => b.snapshot())
      .sort((a, b) => b.rssi - a.rssi);
  }

  getScanResults() {
    return this.scanResults.map(b => b.snapshot());
  }

  getConnectionInfo() {
    if (!this.connectedBSS) return null;
    const uptimeMs = Date.now() - this.connectedSince;
    return {
      ssid:        this.connectedBSS.ssid,
      bssid:       this.connectedBSS.bssid,
      band:        this.connectedBSS.band,
      channel:     this.connectedBSS.channel,
      rssi:        parseFloat(this.connectedBSS.rssi.toFixed(1)),
      snr:         parseFloat(this.connectedBSS.snr().toFixed(1)),
      security:    this.connectedBSS.security,
      phy:         this.connectedBSS.phy,
      width:       this.connectedBSS.width,
      ip:          this.ipAddress,
      subnet:      this.subnet,
      gateway:     this.gateway,
      dns:         this.dns,
      uptimeMs,
      maxMbps:     parseFloat(this.connectedBSS.maxThroughputMbps().toFixed(1)),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onScan(fn) {
    this.scanSubscribers.add(fn);
    return () => this.scanSubscribers.delete(fn);
  }

  onConnection(fn) {
    this.connectionSubscribers.add(fn);
    return () => this.connectionSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VWiFi', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitConnection(evt) {
    for (const fn of this.connectionSubscribers) {
      try { fn(evt); } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    const connected = this.getConnectionInfo();
    return {
      model:      this.model,
      state:      this.state,
      airplane:   this.airplane,
      lowPower:   this.poweredSave,
      connected:  this.isConnected(),
      current:    connected,
      visible:    this.visibleNetworks.size,
      profiles:   this.profiles.size,
      scanning:   !!this.activeScan,
      scanId:     this.activeScan?.id || null,
      hotspot: {
        enabled: this.hotspot.enabled,
        ssid:    this.hotspot.ssid,
        clients: this.hotspot.clients.size,
        startedAt: this.hotspot.startedAt,
      },
      throughput: {
        txMbps: parseFloat(((this.currentTxBps * 8) / 1e6).toFixed(2)),
        rxMbps: parseFloat(((this.currentRxBps * 8) / 1e6).toFixed(2)),
      },
      stats: { ...this.stats },
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      stats:       { ...this.stats },
      profiles:    this.profiles.size,
      hotspot: {
        enabled: this.hotspot.enabled,
        clients: this.hotspot.clients.size,
      },
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VWiFi [${s.state}] — ${s.model}`,
      `  airplane:   ${this.airplane}`,
      `  lowPower:   ${this.poweredSave}`,
      `  profiles:   ${s.profiles}`,
      `  hotspot:    ${s.hotspot.enabled ? `on (${s.hotspot.clients} clientes)` : 'off'}`,
      `  metrics:`,
      `    scans:      ${s.metrics.scansPerformed}`,
      `    connects:   ${s.metrics.connectAttempts} (${s.metrics.connectSuccesses} ok, ${s.metrics.connectFailures} fail)`,
      `    disconnects:${s.metrics.disconnects}`,
      `    roams:      ${s.metrics.roams}`,
      `  traffic:`,
      `    tx:         ${(s.stats.txBytes / 1024 / 1024).toFixed(2)} MB (${s.stats.txPackets} pkts, ${s.stats.txErrors} errors)`,
      `    rx:         ${(s.stats.rxBytes / 1024 / 1024).toFixed(2)} MB (${s.stats.rxPackets} pkts, ${s.stats.rxErrors} errors)`,
      `    retrans:    ${s.stats.retransmits}`,
      `  current:`,
    ];
    const cur = this.getConnectionInfo();
    if (cur) {
      lines.push(`    ssid:       ${cur.ssid} (${cur.bssid})`);
      lines.push(`    band/ch:    ${cur.band} GHz / ch ${cur.channel} (${cur.width}MHz)`);
      lines.push(`    rssi/snr:   ${cur.rssi} dBm / ${cur.snr} dB`);
      lines.push(`    ip:         ${cur.ip}`);
      lines.push(`    uptime:     ${(cur.uptimeMs / 1000).toFixed(1)}s`);
    } else {
      lines.push(`    (desconectado)`);
    }
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:      [...this.history.ts],
      rssi:    [...this.history.rssi],
      snr:     [...this.history.snr],
      txMbps:  [...this.history.txMbps],
      rxMbps:  [...this.history.rxMbps],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
