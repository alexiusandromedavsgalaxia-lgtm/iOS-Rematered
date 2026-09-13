// src/drivers/VBT.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VBT (Virtual Bluetooth)
 * ═══════════════════════════════════════════════════════════════
 *
 * Radio Bluetooth virtual. Modela el stack completo de Bluetooth
 * Clásico (BR/EDR) y Bluetooth Low Energy (BLE) que un iPhone lleva:
 *
 *   - Estados de radio: off / enabling / on / scanning / pairing /
 *     connected / disconnecting / error / airplane
 *   - Perfiles clásicos: A2DP, AVRCP, HFP, HSP, HID, SPP, PBAP, MAP
 *   - Perfiles BLE: GATT, ANCS, HOGP, LE Audio (LC3)
 *   - Descubrimiento (inquiry) con resultados progresivos
 *   - Pairing / bonding con PIN y almacenamiento de bonds
 *   - Advertising BLE con servicios GATT
 *   - Multi-conexión (hasta 7 dispositivos simultáneos, como iOS real)
 *   - Batería por dispositivo (AirPods: L/R/case, Watch, etc)
 *   - Codec de audio negociado (SBC / AAC / LC3 / aptX)
 *   - Estadísticas: bytes tx/rx, paquetes, RSSI, errores de enlace
 *   - Hotspot Bluetooth (tethering)
 *   - Suscriptores de eventos: discovery, pairing, connection,
 *     battery, advertisement
 *   - IRQs: IRQ_BLUETOOTH con tipos device-found, paired, connected,
 *     disconnected, battery-update, adv-received
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const BTState = {
  OFF:           'off',
  ENABLING:      'enabling',
  ON:            'on',
  SCANNING:      'scanning',
  PAIRING:       'pairing',
  CONNECTING:    'connecting',
  CONNECTED:     'connected',
  DISCONNECTING: 'disconnecting',
  ERROR:         'error',
  AIRPLANE:      'airplane',
};

export const BTRadio = {
  CLASSIC: 'BR/EDR',
  LE:      'BLE',
  DUAL:    'dual',
};

export const BTProfile = {
  A2DP:  'A2DP',      // Audio avanzado (streaming)
  AVRCP: 'AVRCP',     // Control remoto audio
  HFP:   'HFP',       // Hands-free (manos libres)
  HSP:   'HSP',       // Headset
  HID:   'HID',       // Human Interface Device (teclado, ratón)
  HOGP:  'HOGP',      // HID over GATT
  SPP:   'SPP',       // Serial Port
  PBAP:  'PBAP',      // Phone Book Access
  MAP:   'MAP',       // Message Access
  ANCS:  'ANCS',      // Apple Notification Center Service
  GATT:  'GATT',      // Generic Attribute Profile
  LE_AUDIO: 'LE_AUDIO', // LC3 codec
  BATTERY: 'BATTERY',
  FIND_MY: 'FIND_MY', // Find My network
  TETHER:  'TETHER',  // Bluetooth tethering
};

export const BTCodec = {
  SBC:    'SBC',
  AAC:    'AAC',
  LC3:    'LC3',
  APTX:   'aptX',
  APTX_HD:'aptX HD',
  LDAC:   'LDAC',
};

export const BTClass = {
  UNKNOWN:         0x000000,
  HEADSET:         0x040400,   // Audio/Video, Wearable Headset
  HANDSFREE:       0x040200,
  HEADPHONES:      0x040800,   // A2DP
  KEYBOARD:        0x054000,
  MOUSE:           0x058000,
  GAMEPAD:         0x050800,
  SPEAKER:         0x042000,
  CAR_AUDIO:       0x200400,
  WATCH:           0x070400,
  PHONE:           0x020200,
  COMPUTER:        0x010000,
  PRINTER:         0x068000,
};

// ───────────────────────────────────────────────────────────────
// BTDevice — un dispositivo descubierto / emparejado
// ───────────────────────────────────────────────────────────────
class BTDevice {
  constructor({ address, name, class: cls = BTClass.UNKNOWN, rssi = -60, radio = BTRadio.DUAL, vendor = 'unknown' }) {
    this.address    = address;      // MAC (XX:XX:XX:XX:XX:XX)
    this.name       = name;
    this.class      = cls;
    this.rssi       = rssi;
    this.radio      = radio;
    this.vendor     = vendor;

    // Estado de emparejamiento
    this.paired     = false;
    this.bonded     = false;
    this.trusted    = false;
    this.pairedAt   = null;

    // Estado de conexión
    this.connected  = false;
    this.connectedAt= null;
    this.activeProfiles = new Set();
    this.codec      = null;

    // Servicios GATT (si aplica)
    this.gattServices = new Set();
    this.advertisments = [];

    // Batería (si aplica)
    this.battery = null;    // { level: 0..1, components: { left, right, case } }

    // Contadores
    this.txBytes = 0;
    this.rxBytes = 0;
    this.txPackets = 0;
    this.rxPackets = 0;
    this.linkErrors = 0;

    // Timestamps
    this.firstSeen  = Date.now();
    this.lastSeen   = Date.now();
    this.lastError  = null;
  }

  snapshot() {
    return {
      address:    this.address,
      name:       this.name,
      class:      this.class,
      classLabel: this.classLabel(),
      rssi:       parseFloat(this.rssi.toFixed(1)),
      radio:      this.radio,
      vendor:     this.vendor,
      paired:     this.paired,
      bonded:     this.bonded,
      trusted:    this.trusted,
      pairedAt:   this.pairedAt,
      connected:  this.connected,
      connectedAt:this.connectedAt,
      profiles:   [...this.activeProfiles],
      codec:      this.codec,
      gattServices: [...this.gattServices],
      battery:    this.battery,
      stats: {
        txBytes:   this.txBytes,
        rxBytes:   this.rxBytes,
        txPackets: this.txPackets,
        rxPackets: this.rxPackets,
        linkErrors:this.linkErrors,
      },
      lastSeen:   this.lastSeen,
    };
  }

  classLabel() {
    const m = {
      [BTClass.HEADSET]:   'Headset',
      [BTClass.HANDSFREE]: 'Handsfree',
      [BTClass.HEADPHONES]:'Headphones',
      [BTClass.KEYBOARD]:  'Keyboard',
      [BTClass.MOUSE]:     'Mouse',
      [BTClass.GAMEPAD]:   'Gamepad',
      [BTClass.SPEAKER]:   'Speaker',
      [BTClass.CAR_AUDIO]: 'Car Audio',
      [BTClass.WATCH]:     'Watch',
      [BTClass.PHONE]:     'Phone',
      [BTClass.COMPUTER]:  'Computer',
      [BTClass.PRINTER]:   'Printer',
    };
    return m[this.class] || 'Unknown';
  }
}

// ───────────────────────────────────────────────────────────────
// Servicios GATT típicos
// ───────────────────────────────────────────────────────────────
const GATT_SERVICES = {
  GENERIC_ACCESS:      '1800',
  GENERIC_ATTRIBUTE:   '1801',
  IMMEDIATE_ALERT:     '1802',
  LINK_LOSS:           '1803',
  TX_POWER:            '1804',
  CURRENT_TIME:        '1805',
  REFERENCE_TIME:      '1806',
  NEXT_DST_CHANGE:     '1807',
  GLUCOSE:             '1808',
  HEALTH_THERMOMETER:  '1809',
  DEVICE_INFORMATION:  '180A',
  HEART_RATE:          '180D',
  BATTERY_SERVICE:     '180F',
  BLOOD_PRESSURE:      '1810',
  HUMAN_INTERFACE:     '1812',
  SCAN_PARAMETERS:     '1813',
  RUNNING_SPEED:       '1814',
  AUTOMATION_IO:       '1815',
  CYCLING_SPEED:       '1816',
  CYCLING_POWER:       '1818',
  LOCATION_NAVIGATION: '1819',
  ENVIRONMENTAL:       '181A',
  BODY_COMPOSITION:    '181B',
  USER_DATA:           '181C',
  WEIGHT_SCALE:        '181D',
  FITNESS_MACHINE:     '1826',
  APPLE_NOTIFICATION:  '7905F431-B5CE-4E99-A40F-4B1E122D00D0',
  APPLE_MEDIA_SERVICE: '89D3502B-0F36-433A-8EF4-C502AD55F8DC',
};

// ───────────────────────────────────────────────────────────────
// Bonds guardados
// ───────────────────────────────────────────────────────────────
class Bond {
  constructor(device) {
    this.address  = device.address;
    this.name     = device.name;
    this.pairedAt = Date.now();
    this.ltk      = this._fakeKey();     // Long Term Key
    this.irk      = this._fakeKey();     // Identity Resolving Key
    this.csrk     = this._fakeKey();     // Connection Signature Resolving Key
    this.trusted  = true;
  }

  _fakeKey() {
    let k = '';
    for (let i = 0; i < 32; i++) k += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return k;
  }

  snapshot() {
    return {
      address:  this.address,
      name:     this.name,
      pairedAt: this.pairedAt,
      trusted:  this.trusted,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VBT — driver completo
// ───────────────────────────────────────────────────────────────
export class VBT {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VBT';
    this.model = DEVICE_MODEL.radios.bluetooth.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = BTState.OFF;
    this.airplane    = false;
    this.lowPower    = false;

    // Config del radio
    this.address    = this._generateLocalAddress();
    this.name       = 'iPhone de iOSR';
    this.classic    = true;
    this.le         = true;
    this.leAudio    = true;
    this.maxConnections = 7;
    this.supportedCodecs = [BTCodec.SBC, BTCodec.AAC, BTCodec.LC3];
    this.supportedProfiles = [
      BTProfile.A2DP, BTProfile.AVRCP, BTProfile.HFP, BTProfile.HSP,
      BTProfile.HID, BTProfile.HOGP, BTProfile.SPP, BTProfile.PBAP,
      BTProfile.MAP, BTProfile.ANCS, BTProfile.GATT, BTProfile.LE_AUDIO,
      BTProfile.BATTERY, BTProfile.FIND_MY, BTProfile.TETHER,
    ];

    // Dispositivos conocidos y visibles
    this.knownDevices = new Map();      // address -> BTDevice
    this.discovered   = new Map();      // address -> BTDevice (resultado de scan)
    this.connected    = new Map();      // address -> BTDevice (conectados)

    // Bonds
    this.bonds = new Map();             // address -> Bond

    // Discovery en curso
    this.activeDiscovery = null;

    // Hotspot BT
    this.tethering = {
      enabled: false,
      startedAt: null,
      clients: new Map(),
    };

    // Historial
    this.historySize = 120;
    this.history = {
      ts:       [],
      connectedCount: [],
      txMbps:   [],
      rxMbps:   [],
    };

    // Tráfico instantáneo
    this.currentTxBps = 0;
    this.currentRxBps = 0;

    // Suscriptores
    this.subscribers          = new Set();
    this.discoverySubscribers = new Set();
    this.connectionSubscribers= new Set();
    this.batterySubscribers   = new Set();

    // Tick loop
    this.tickIntervalMs = 250;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas globales
    this.metrics = {
      discoveriesPerformed: 0,
      pairingsInitiated:    0,
      pairingsCompleted:    0,
      pairingsFailed:       0,
      connectionsEstablished:0,
      disconnections:       0,
      unknownDevices:       0,
      currentDiscoveryId:   null,
      lastDiscoveryMs:      0,
      startedAt:            null,
    };

    // Sembramos dispositivos conocidos (AirPods, Watch, etc)
    this._seedDevices();

    logger.kernel('VBT', `creado: ${this.model} (${this.address}, ${this.name})`);
  }

  _generateLocalAddress() {
    const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
    // El primer byte debe tener el bit LSB = 0 (unicast) y el siguiente = 1 (random)
    return `${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
  }

  _seedDevices() {
    const seeds = [
      {
        address: 'A4:C3:F0:12:34:56',
        name: "AirPods Pro de Ana",
        class: BTClass.HEADPHONES,
        rssi: -55,
        radio: BTRadio.DUAL,
        vendor: 'Apple',
        battery: { level: 0.85, components: { left: 0.87, right: 0.83, case: 0.62 } },
        gattServices: [GATT_SERVICES.BATTERY_SERVICE, GATT_SERVICES.APPLE_NOTIFICATION, GATT_SERVICES.DEVICE_INFORMATION],
      },
      {
        address: 'B8:27:EB:AA:BB:CC',
        name: 'Apple Watch',
        class: BTClass.WATCH,
        rssi: -62,
        radio: BTRadio.DUAL,
        vendor: 'Apple',
        battery: { level: 0.72 },
        gattServices: [GATT_SERVICES.BATTERY_SERVICE, GATT_SERVICES.HEART_RATE, GATT_SERVICES.APPLE_NOTIFICATION, GATT_SERVICES.DEVICE_INFORMATION],
      },
      {
        address: 'C8:E0:EB:99:88:77',
        name: 'Magic Keyboard',
        class: BTClass.KEYBOARD,
        rssi: -68,
        radio: BTRadio.LE,
        vendor: 'Apple',
        battery: { level: 0.55 },
        gattServices: [GATT_SERVICES.HUMAN_INTERFACE, GATT_SERVICES.BATTERY_SERVICE],
      },
      {
        address: 'F0:18:98:11:22:33',
        name: 'Tesla Model 3',
        class: BTClass.CAR_AUDIO,
        rssi: -78,
        radio: BTRadio.DUAL,
        vendor: 'Tesla',
        gattServices: [GATT_SERVICES.DEVICE_INFORMATION],
      },
      {
        address: 'DC:A6:32:44:55:66',
        name: 'JBL Flip 5',
        class: BTClass.SPEAKER,
        rssi: -72,
        radio: BTRadio.CLASSIC,
        vendor: 'JBL',
        battery: { level: 0.45 },
      },
    ];

    for (const s of seeds) {
      const dev = new BTDevice(s);
      if (s.battery) dev.battery = s.battery;
      if (s.gattServices) s.gattServices.forEach(g => dev.gattServices.add(g));
      this.knownDevices.set(dev.address, dev);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();
    logger.info('VBT',
      `✓ init: ${this.model}, addr=${this.address}, name="${this.name}", ` +
      `perfiles=${this.supportedProfiles.length}, codecs=${this.supportedCodecs.join('/')}`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', { source: 'vbt', event: 'ready' }, 'vbt');
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
    // Desconectar todo
    for (const addr of [...this.connected.keys()]) {
      this.disconnect(addr, 'shutdown').catch(() => {});
    }
    logger.info('VBT', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // Actualizar RSSI de dispositivos conectados (fluctúa ligeramente)
    for (const dev of this.connected.values()) {
      dev.rssi += (Math.random() - 0.5) * 1.5;
      dev.rssi = Math.max(-95, Math.min(-30, dev.rssi));

      // Error ocasional de enlace
      if (Math.random() < 0.002) {
        dev.linkErrors++;
        logger.debug('VBT', `link error en ${dev.name}`);
      }
    }

    // Simular tráfico de dispositivos conectados
    this._simulateTraffic();

    // Actualizar discovery en curso
    if (this.activeDiscovery) {
      this._updateDiscovery();
    }

    // Simular drenaje de batería de dispositivos LE
    if (this.tickCount % 20 === 0) {   // cada 5s
      this._simulateBatteryDrain();
    }

    this._pushHistory();
    this.tickCount++;
    this._emit();
  }

  _simulateTraffic() {
    let totalTx = 0;
    let totalRx = 0;

    for (const dev of this.connected.values()) {
      // Solo dispositivos con perfiles de datos generan tráfico
      const hasA2DP = dev.activeProfiles.has(BTProfile.A2DP);
      const hasHID  = dev.activeProfiles.has(BTProfile.HID) || dev.activeProfiles.has(BTProfile.HOGP);
      const hasHFP  = dev.activeProfiles.has(BTProfile.HFP);

      let devTx = 0;
      let devRx = 0;

      if (hasA2DP) {
        // Audio: 256 kbps típico para AAC
        devRx += 32_000;   // bytes/s
      }
      if (hasHFP) {
        // Voz bidireccional: 64 kbps
        devRx += 8_000;
        devTx += 4_000;
      }
      if (hasHID) {
        // Teclado: eventos esporádicos
        devTx += Math.random() < 0.1 ? 500 : 0;
      }

      const dtSec = this.tickIntervalMs / 1000;
      const txBytes = devTx * dtSec * (0.9 + Math.random() * 0.2);
      const rxBytes = devRx * dtSec * (0.9 + Math.random() * 0.2);

      dev.txBytes += txBytes;
      dev.rxBytes += rxBytes;
      dev.txPackets += Math.floor(txBytes / 300);
      dev.rxPackets += Math.floor(rxBytes / 300);

      totalTx += devTx;
      totalRx += devRx;
    }

    this.currentTxBps = totalTx;
    this.currentRxBps = totalRx;
  }

  _updateDiscovery() {
    const disc = this.activeDiscovery;
    const elapsed = Date.now() - disc.startTs;
    if (elapsed >= disc.durationMs) {
      this.metrics.lastDiscoveryMs = elapsed;
      this.state = BTState.ON;
      const results = [...this.discovered.values()].map(d => d.snapshot());
      logger.info('VBT', `discovery completo: ${results.length} dispositivos en ${elapsed}ms`);
      for (const fn of this.discoverySubscribers) {
        try { fn({ type: 'complete', results, durationMs: elapsed }); } catch (_) {}
      }
      this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
        source: 'vbt', event: 'discovery-complete', count: results.length, durationMs: elapsed,
      }, 'vbt');
      this.activeDiscovery = null;
      return;
    }
  }

  _simulateBatteryDrain() {
    for (const dev of this.knownDevices.values()) {
      if (!dev.battery) continue;
      const drainRate = dev.connected ? 0.002 : 0.0005;
      if (dev.battery.components) {
        for (const k of Object.keys(dev.battery.components)) {
          dev.battery.components[k] = Math.max(0, dev.battery.components[k] - drainRate * (0.5 + Math.random()));
        }
        // El nivel global es el mínimo de los componentes
        dev.battery.level = Math.min(...Object.values(dev.battery.components));
      } else {
        dev.battery.level = Math.max(0, dev.battery.level - drainRate);
      }

      // Emitir IRQ de batería si bajó lo suficiente
      if (this.tickCount % 40 === 0) {
        for (const fn of this.batterySubscribers) {
          try { fn({ address: dev.address, name: dev.name, battery: dev.battery }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
          source: 'vbt', event: 'battery-update', address: dev.address, battery: dev.battery,
        }, 'vbt');
      }
    }
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.connectedCount.push(this.connected.size);
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
      logger.warn('VBT', 'powerOn rechazado: modo avión activo');
      return false;
    }
    if (this.state === BTState.ON || this.state === BTState.CONNECTED) return true;

    this.state = BTState.ENABLING;
    this._emit();
    logger.info('VBT', 'encendiendo radio...');
    await this._delay(150 + Math.random() * 200);

    this.state = BTState.ON;
    logger.info('VBT', '✓ radio on');
    this._emit();
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', { source: 'vbt', event: 'powered-on' }, 'vbt');

    // Reconectar automáticamente dispositivos conocidos
    setTimeout(() => this._autoReconnect(), 500);
    return true;
  }

  async powerOff() {
    if (this.state === BTState.OFF) return true;
    for (const addr of [...this.connected.keys()]) {
      await this.disconnect(addr, 'power-off');
    }
    this.state = BTState.OFF;
    this.discovered.clear();
    logger.info('VBT', 'radio off');
    this._emit();
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', { source: 'vbt', event: 'powered-off' }, 'vbt');
    return true;
  }

  setAirplaneMode(on) {
    this.airplane = !!on;
    logger.info('VBT', `airplane mode ${this.airplane ? 'ON' : 'OFF'}`);
    if (this.airplane) {
      this.powerOff().catch(() => {});
      this.state = BTState.AIRPLANE;
    } else {
      this.state = BTState.OFF;
    }
    this._emit();
  }

  setLowPowerMode(on) {
    this.lowPower = !!on;
    logger.info('VBT', `low power ${this.lowPower ? 'ON' : 'OFF'}`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // DISCOVERY
  // ═══════════════════════════════════════════════════════════

  async startDiscovery({ durationMs = 5000, mode = BTRadio.DUAL, includeKnown = true } = {}) {
    if (this.state === BTState.OFF || this.state === BTState.AIRPLANE) {
      logger.warn('VBT', 'discovery rechazado: radio off');
      return null;
    }
    if (this.activeDiscovery) {
      logger.warn('VBT', 'discovery ya en curso');
      return null;
    }

    const id = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.state = BTState.SCANNING;
    this.metrics.discoveriesPerformed++;
    this.metrics.currentDiscoveryId = id;
    this.discovered.clear();

    // Sembrar dispositivos conocidos visibles
    if (includeKnown) {
      for (const dev of this.knownDevices.values()) {
        if (mode !== BTRadio.DUAL && dev.radio !== mode) continue;
        const clone = new BTDevice({
          address: dev.address,
          name: dev.name,
          class: dev.class,
          rssi: dev.rssi + (Math.random() - 0.5) * 6,
          radio: dev.radio,
          vendor: dev.vendor,
        });
        if (dev.battery) clone.battery = dev.battery;
        dev.gattServices.forEach(g => clone.gattServices.add(g));
        this.discovered.set(clone.address, clone);
      }
    }

    // Añadir algunos dispositivos aleatorios
    const randCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < randCount; i++) {
      const randDev = this._generateRandomDevice();
      this.discovered.set(randDev.address, randDev);
    }

    this.activeDiscovery = {
      id,
      startTs: Date.now(),
      durationMs,
      mode,
    };

    logger.info('VBT', `discovery iniciado: id=${id.slice(-6)} mode=${mode} duration=${durationMs}ms`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', { source: 'vbt', event: 'discovery-start', id }, 'vbt');

    // Notificar dispositivos encontrados progresivamente
    let delay = 200;
    for (const dev of this.discovered.values()) {
      setTimeout(() => {
        if (!this.activeDiscovery || this.activeDiscovery.id !== id) return;
        for (const fn of this.discoverySubscribers) {
          try { fn({ type: 'device-found', device: dev.snapshot() }); } catch (_) {}
        }
        this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
          source: 'vbt', event: 'device-found', address: dev.address, name: dev.name,
        }, 'vbt');
      }, delay);
      delay += 300 + Math.random() * 400;
    }

    return id;
  }

  _generateRandomDevice() {
    const names = ['Xiaomi Buds', 'Sony WH-1000XM5', 'Bose QC45', 'Logitech MX', 'Garmin Fenix', 'Anker Soundcore', 'Tile Tracker'];
    const classes = [BTClass.HEADPHONES, BTClass.SPEAKER, BTClass.KEYBOARD, BTClass.WATCH, BTClass.HEADSET];
    const vendors = ['Xiaomi', 'Sony', 'Bose', 'Logitech', 'Garmin', 'Anker', 'Tile'];
    const idx = Math.floor(Math.random() * names.length);
    const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
    return new BTDevice({
      address: `${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`,
      name: names[idx],
      class: classes[idx % classes.length],
      rssi: -60 - Math.random() * 30,
      radio: Math.random() < 0.3 ? BTRadio.CLASSIC : BTRadio.DUAL,
      vendor: vendors[idx],
    });
  }

  async stopDiscovery() {
    if (!this.activeDiscovery) return false;
    logger.info('VBT', 'discovery detenido manualmente');
    this.activeDiscovery = null;
    this.state = BTState.ON;
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // PAIRING
  // ═══════════════════════════════════════════════════════════

  async pair(address, { pin = null, timeoutMs = 10000 } = {}) {
    if (this.state === BTState.OFF || this.state === BTState.AIRPLANE) {
      logger.warn('VBT', 'pair rechazado: radio off');
      return false;
    }

    // Buscar el device en discovered o known
    let dev = this.discovered.get(address) || this.knownDevices.get(address);
    if (!dev) {
      logger.warn('VBT', `pair: device ${address} no encontrado`);
      this.metrics.pairingsFailed++;
      return false;
    }

    if (dev.paired) {
      logger.info('VBT', `pair: ${dev.name} ya emparejado`);
      return true;
    }

    this.state = BTState.PAIRING;
    this.metrics.pairingsInitiated++;
    this._emit();
    logger.info('VBT', `emparejando con ${dev.name} (${address})...`);

    // Simular handshake
    await this._delay(300 + Math.random() * 400);

    // ¿Requiere PIN? (dispositivos legacy)
    if (pin !== null && dev.radio === BTRadio.CLASSIC) {
      logger.debug('VBT', `PIN requerido: ${pin}`);
      await this._delay(200);
    }

    // Simular fallo ocasional (2%)
    if (Math.random() < 0.02) {
      logger.warn('VBT', `pair falló con ${dev.name}`);
      this.metrics.pairingsFailed++;
      this.state = BTState.ON;
      this._emit();
      return false;
    }

    // Emparejar
    dev.paired  = true;
    dev.bonded  = true;
    dev.trusted = true;
    dev.pairedAt = Date.now();

    // Guardar bond
    const bond = new Bond(dev);
    this.bonds.set(address, bond);

    // Mover a knownDevices si venía de discovered
    if (!this.knownDevices.has(address)) {
      this.knownDevices.set(address, dev);
    }

    this.metrics.pairingsCompleted++;
    this.state = BTState.ON;
    logger.info('VBT', `✓ emparejado con ${dev.name}`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
      source: 'vbt', event: 'paired', address, name: dev.name,
    }, 'vbt');
    this._emitConnection({ type: 'paired', address, name: dev.name });
    this._emit();
    return true;
  }

  async unpair(address) {
    const dev = this.knownDevices.get(address);
    if (!dev || !dev.paired) return false;

    // Desconectar primero si está conectado
    if (dev.connected) await this.disconnect(address, 'unpair');

    dev.paired  = false;
    dev.bonded  = false;
    dev.trusted = false;
    dev.pairedAt = null;
    this.bonds.delete(address);

    logger.info('VBT', `unpair: ${dev.name}`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
      source: 'vbt', event: 'unpaired', address, name: dev.name,
    }, 'vbt');
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // CONEXIÓN
  // ═══════════════════════════════════════════════════════════

  async connect(address, { profiles = null, codec = null } = {}) {
    if (this.state === BTState.OFF || this.state === BTState.AIRPLANE) {
      logger.warn('VBT', 'connect rechazado: radio off');
      return false;
    }
    if (this.connected.size >= this.maxConnections) {
      logger.warn('VBT', `connect rechazado: límite de ${this.maxConnections} conexiones alcanzado`);
      return false;
    }

    const dev = this.knownDevices.get(address);
    if (!dev) {
      logger.warn('VBT', `connect: device ${address} no conocido`);
      return false;
    }
    if (!dev.paired) {
      logger.warn('VBT', `connect: ${dev.name} no emparejado`);
      return false;
    }
    if (dev.connected) {
      logger.info('VBT', `connect: ${dev.name} ya conectado`);
      return true;
    }

    this.state = BTState.CONNECTING;
    this._emit();
    logger.info('VBT', `conectando a ${dev.name}...`);

    // Simular latencia
    await this._delay(200 + Math.random() * 300);

    // Perfiles por defecto según clase
    const defaultProfiles = this._defaultProfilesFor(dev);
    const useProfiles = profiles || defaultProfiles;

    // Codec por defecto para audio
    if (!codec && (useProfiles.includes(BTProfile.A2DP) || useProfiles.includes(BTProfile.LE_AUDIO))) {
      codec = this.supportedCodecs.includes(BTCodec.LC3) ? BTCodec.LC3 : BTCodec.AAC;
    }

    dev.connected = true;
    dev.connectedAt = Date.now();
    dev.activeProfiles = new Set(useProfiles);
    dev.codec = codec;
    this.connected.set(address, dev);

    this.metrics.connectionsEstablished++;
    this.state = BTState.CONNECTED;

    logger.info('VBT', `✓ conectado a ${dev.name} (perfiles: ${useProfiles.join(',')}${codec ? `, codec: ${codec}` : ''})`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
      source: 'vbt', event: 'connected', address, name: dev.name, profiles: useProfiles, codec,
    }, 'vbt');
    this._emitConnection({ type: 'connected', address, name: dev.name, profiles: useProfiles, codec });
    this._emit();
    return true;
  }

  _defaultProfilesFor(dev) {
    switch (dev.class) {
      case BTClass.HEADPHONES:
      case BTClass.HEADSET:
      case BTClass.SPEAKER:
        return [BTProfile.A2DP, BTProfile.AVRCP];
      case BTClass.HANDSFREE:
      case BTClass.CAR_AUDIO:
        return [BTProfile.HFP, BTProfile.PBAP, BTProfile.MAP];
      case BTClass.KEYBOARD:
      case BTClass.MOUSE:
      case BTClass.GAMEPAD:
        return [BTProfile.HID, BTProfile.HOGP];
      case BTClass.WATCH:
        return [BTProfile.GATT, BTProfile.ANCS, BTProfile.BATTERY, BTProfile.FIND_MY];
      default:
        return [BTProfile.GATT];
    }
  }

  async disconnect(address, reason = 'user') {
    const dev = this.connected.get(address);
    if (!dev) return false;

    this.state = BTState.DISCONNECTING;
    this._emit();
    logger.info('VBT', `desconectando de ${dev.name} (${reason})...`);
    await this._delay(80 + Math.random() * 100);

    dev.connected = false;
    dev.connectedAt = null;
    dev.activeProfiles.clear();
    dev.codec = null;
    this.connected.delete(address);

    this.metrics.disconnections++;
    this.state = this.connected.size > 0 ? BTState.CONNECTED : BTState.ON;

    logger.info('VBT', `✓ desconectado de ${dev.name}`);
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', {
      source: 'vbt', event: 'disconnected', address, name: dev.name, reason,
    }, 'vbt');
    this._emitConnection({ type: 'disconnected', address, name: dev.name, reason });
    this._emit();
    return true;
  }

  async _autoReconnect() {
    for (const dev of this.knownDevices.values()) {
      if (!dev.paired || dev.connected) continue;
      // Solo reconectamos dispositivos que se conectan típicamente solos
      if (dev.class === BTClass.HEADPHONES || dev.class === BTClass.WATCH) {
        try { await this.connect(dev.address); } catch (_) {}
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TETHERING (hotspot BT)
  // ═══════════════════════════════════════════════════════════

  async enableTethering() {
    if (this.tethering.enabled) return false;
    this.tethering = {
      enabled: true,
      startedAt: Date.now(),
      clients: new Map(),
    };
    logger.info('VBT', 'tethering BT habilitado');
    this.bus?.raiseInterrupt?.('IRQ_BLUETOOTH', { source: 'vbt', event: 'tethering-start' }, 'vbt');
    this._emit();
    return true;
  }

  async disableTethering() {
    if (!this.tethering.enabled) return false;
    this.tethering = { enabled: false, startedAt: null, clients: new Map() };
    logger.info('VBT', 'tethering BT deshabilitado');
    this._emit();
    return true;
  }

  tetheringClientJoin(address, hostname = 'unknown') {
    if (!this.tethering.enabled) return false;
    this.tethering.clients.set(address, { address, hostname, joinedAt: Date.now() });
    logger.info('VBT', `tethering cliente: ${hostname} (${address})`);
    this._emit();
    return true;
  }

  tetheringClientLeave(address) {
    const c = this.tethering.clients.get(address);
    if (!c) return false;
    this.tethering.clients.delete(address);
    logger.info('VBT', `tethering cliente salió: ${c.hostname}`);
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // PERFILES DE AUDIO
  // ═══════════════════════════════════════════════════════════

  setCodec(address, codec) {
    const dev = this.connected.get(address);
    if (!dev) return false;
    if (!this.supportedCodecs.includes(codec)) {
      logger.warn('VBT', `codec no soportado: ${codec}`);
      return false;
    }
    dev.codec = codec;
    logger.info('VBT', `codec de ${dev.name} cambiado a ${codec}`);
    this._emit();
    return true;
  }

  getAudioDevices() {
    return [...this.connected.values()]
      .filter(d => d.activeProfiles.has(BTProfile.A2DP) || d.activeProfiles.has(BTProfile.HFP) || d.activeProfiles.has(BTProfile.LE_AUDIO))
      .map(d => d.snapshot());
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isOn() {
    return this.state === BTState.ON || this.state === BTState.CONNECTED || this.state === BTState.SCANNING;
  }

  isConnected() {
    return this.connected.size > 0;
  }

  getKnownDevices() {
    return [...this.knownDevices.values()].map(d => d.snapshot());
  }

  getDiscoveredDevices() {
    return [...this.discovered.values()].map(d => d.snapshot());
  }

  getConnectedDevices() {
    return [...this.connected.values()].map(d => d.snapshot());
  }

  getDevice(address) {
    const d = this.knownDevices.get(address) || this.discovered.get(address);
    return d ? d.snapshot() : null;
  }

  getBattery(address) {
    const dev = this.knownDevices.get(address) || this.discovered.get(address);
    return dev?.battery || null;
  }

  listBonds() {
    return [...this.bonds.values()].map(b => b.snapshot());
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onDiscovery(fn) {
    this.discoverySubscribers.add(fn);
    return () => this.discoverySubscribers.delete(fn);
  }

  onConnection(fn) {
    this.connectionSubscribers.add(fn);
    return () => this.connectionSubscribers.delete(fn);
  }

  onBattery(fn) {
    this.batterySubscribers.add(fn);
    return () => this.batterySubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VBT', `subscriber falló: ${err.message}`, err);
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
    return {
      model:        this.model,
      state:        this.state,
      localName:    this.name,
      localAddress: this.address,
      airplane:     this.airplane,
      lowPower:     this.lowPower,
      classic:      this.classic,
      le:           this.le,
      leAudio:      this.leAudio,
      connected:    this.connected.size,
      maxConnections: this.maxConnections,
      paired:       [...this.knownDevices.values()].filter(d => d.paired).length,
      discovered:   this.discovered.size,
      discovering:  !!this.activeDiscovery,
      tethering: {
        enabled: this.tethering.enabled,
        clients: this.tethering.clients.size,
      },
      throughput: {
        txMbps: parseFloat(((this.currentTxBps * 8) / 1e6).toFixed(3)),
        rxMbps: parseFloat(((this.currentRxBps * 8) / 1e6).toFixed(3)),
      },
      connectedDevices: this.getConnectedDevices(),
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      metrics:     { ...this.metrics },
      bonds:       this.bonds.size,
      known:       this.knownDevices.size,
      connected:   this.connected.size,
      tethering:   this.tethering.enabled,
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `VBT [${s.state}] — ${s.model}`,
      `  local:       ${this.address} "${this.name}"`,
      `  airplane:    ${this.airplane}`,
      `  lowPower:    ${this.lowPower}`,
      `  bonds:       ${s.bonds}`,
      `  connected:   ${s.connected}/${this.maxConnections}`,
      `  known:       ${s.known}`,
      `  tethering:   ${s.tethering ? 'on' : 'off'}`,
      `  metrics:`,
      `    discoveries: ${s.metrics.discoveriesPerformed}`,
      `    pairings:    ${s.metrics.pairingsInitiated} (${s.metrics.pairingsCompleted} ok, ${s.metrics.pairingsFailed} fail)`,
      `    connections: ${s.metrics.connectionsEstablished}`,
      `    disconnects: ${s.metrics.disconnections}`,
      `  dispositivos conectados:`,
    ];
    for (const d of this.getConnectedDevices()) {
      const bat = d.battery ? ` bat=${(d.battery.level * 100).toFixed(0)}%` : '';
      lines.push(`    - ${d.name.padEnd(24)} ${d.address} rssi=${d.rssi}dBm codec=${d.codec || '—'}${bat}`);
    }
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:             [...this.history.ts],
      connectedCount: [...this.history.connectedCount],
      txMbps:         [...this.history.txMbps],
      rxMbps:         [...this.history.rxMbps],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
