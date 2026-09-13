// src/drivers/VCellular.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — VCellular (Virtual Cellular / Modem)
 * ═══════════════════════════════════════════════════════════════
 *
 * Radio celular virtual. Modela el módem 5G/LTE del iPhone con
 * toda la pila: registro, attach, portadoras de datos, roaming,
 * voz (VoLTE / VoWiFi), SMS y SIM/eSIM.
 *
 * Responsabilidades:
 *   - Estado del módem: off / enabling / searching / registered /
 *     roaming / no-service / error / airplane
 *   - Tecnología de red: 5G NR (SA/NSA), LTE, UMTS, GSM
 *   - Bandas: NR sub-6 / mmWave, LTE, UMTS, GSM
 *   - Señal: RSSI, RSRP, RSRQ, SINR, bars (1-5), calidad
 *   - SIM / eSIM: IMSI, ICCID, estado, PIN, PUK, locked
 *   - Portadora: nombre, MCC/MNC, país, ISO, tipo (MNO/MVNO)
 *   - Attach / detach con latencias realistas
 *   - Portadora de datos (APN) con IP asignada por la operadora
 *   - Tráfico up/down con throttle por plan de datos
 *   - Voz: llamada entrante/saliente, duración, VoLTE, VoWiFi, HD voice
 *   - SMS: envío / recepción con estado de entrega
 *   - Roaming nacional / internacional
 *   - Handovers entre celdas (LTE ↔ 5G)
 *   - Modo avión
 *   - IRQs: IRQ_CELLULAR con call-incoming, call-ended,
 *     sms-received, data-connected, signal-changed, roaming-entered,
 *     handover, sim-state-changed
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

// ───────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────
export const ModemState = {
  OFF:         'off',
  ENABLING:    'enabling',
  SEARCHING:   'searching',
  REGISTERED:  'registered',
  ROAMING:     'roaming',
  NO_SERVICE:  'no-service',
  EMERGENCY:   'emergency-only',
  ERROR:       'error',
  AIRPLANE:    'airplane',
};

export const RatType = {
  NR_SA:  '5G NR SA',      // Standalone
  NR_NSA: '5G NR NSA',     // Non-standalone (ancla LTE)
  LTE:    'LTE',
  LTE_A:  'LTE-A',
  UMTS:   'UMTS',
  HSPA:   'HSPA',
  GSM:    'GSM',
  EDGE:   'EDGE',
  NONE:   'none',
};

export const SimState = {
  MISSING:    'missing',
  PIN_REQUIRED:'pin-required',
  PUK_REQUIRED:'puk-required',
  READY:      'ready',
  LOCKED:     'locked',
  ERROR:      'error',
};

export const CallState = {
  IDLE:      'idle',
  DIALLING:  'dialling',
  RINGING:   'ringing',          // entrante, aún no aceptada
  INCOMING:  'incoming',         // alias de ringing
  ACTIVE:    'active',
  HOLDING:   'holding',
  ENDED:     'ended',
  FAILED:    'failed',
};

export const CallType = {
  VOICE:    'voice',
  VIDEO:    'video',
  EMERGENCY:'emergency',
};

export const SmsStatus = {
  PENDING:  'pending',
  SENT:     'sent',
  DELIVERED:'delivered',
  FAILED:   'failed',
  RECEIVED: 'received',
};

// Operadoras simuladas (España)
const CARRIERS = [
  { mcc: '214', mnc: '01', name: 'Vodafone ES',  country: 'España', iso: 'ES', type: 'MNO' },
  { mcc: '214', mnc: '03', name: 'Orange ES',    country: 'España', iso: 'ES', type: 'MNO' },
  { mcc: '214', mnc: '07', name: 'Movistar',     country: 'España', iso: 'ES', type: 'MNO' },
  { mcc: '214', mnc: '16', name: 'Telecable',    country: 'España', iso: 'ES', type: 'MVNO' },
  { mcc: '214', mnc: '18', name: 'Simyo',        country: 'España', iso: 'ES', type: 'MVNO' },
  { mcc: '310', mnc: '260',name: 'T-Mobile US',  country: 'EE.UU.', iso: 'US', type: 'MNO' },
  { mcc: '208', mnc: '01', name: 'Orange FR',    country: 'Francia',iso: 'FR', type: 'MNO' },
];

// ───────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomHex(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
  return out;
}

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

// ───────────────────────────────────────────────────────────────
// Signal — calidad de señal
// ───────────────────────────────────────────────────────────────
class Signal {
  constructor() {
    this.rssi  = -70;    // dBm
    this.rsrp  = -90;    // dBm (LTE/5G)
    this.rsrq  = -10;    // dB
    this.sinr  = 15;     // dB
    this.bars  = 4;      // 0-5
    this.quality = 80;   // 0-100
  }

  update(dbm) {
    // Fluctúa suavemente
    this.rssi = clamp(dbm + (Math.random() - 0.5) * 4, -120, -40);
    this.rsrp = clamp(this.rssi - 20 + (Math.random() - 0.5) * 3, -140, -60);
    this.rsrq = clamp(-10 + (Math.random() - 0.5) * 4, -20, -5);
    this.sinr = clamp(15 + (Math.random() - 0.5) * 8, -5, 30);

    // Bars mapeados del RSSI
    if (this.rssi >= -70)      this.bars = 5;
    else if (this.rssi >= -85) this.bars = 4;
    else if (this.rssi >= -100)this.bars = 3;
    else if (this.rssi >= -110)this.bars = 2;
    else if (this.rssi >= -115)this.bars = 1;
    else this.bars = 0;

    // Quality: 0-100
    this.quality = clamp(Math.round((this.rssi + 120) / 80 * 100), 0, 100);
    return this;
  }

  snapshot() {
    return {
      rssi:    parseFloat(this.rssi.toFixed(1)),
      rsrp:    parseFloat(this.rsrp.toFixed(1)),
      rsrq:    parseFloat(this.rsrq.toFixed(1)),
      sinr:    parseFloat(this.sinr.toFixed(1)),
      bars:    this.bars,
      quality: this.quality,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// SIMCard — SIM o eSIM
// ───────────────────────────────────────────────────────────────
class SIMCard {
  constructor({ type = 'physical', iccid = null, imsi = null } = {}) {
    this.type   = type;                    // 'physical' | 'esim'
    this.iccid  = iccid || this._genIccid();
    this.imsi   = imsi  || this._genImsi();
    this.pin    = '1234';
    this.pinAttempts = 3;
    this.puk    = randomDigits(8);
    this.state  = SimState.READY;
    this.provider = randomFrom(CARRIERS);
    this.phoneNumber = '+34 ' + randomDigits(3) + ' ' + randomDigits(3) + ' ' + randomDigits(3);
    this.insertedAt = Date.now();
  }

  _genIccid() {
    // ICCID: 89 + 5 dígitos país + 12 dígitos cuenta + checksum (Luhn)
    return '89' + randomDigits(5) + randomDigits(12);
  }

  _genImsi() {
    // IMSI: MCC(3) + MNC(2-3) + MSIN(9-10)
    return '21401' + randomDigits(10);
  }

  isReady() { return this.state === SimState.READY; }
  isLocked(){ return this.state === SimState.PIN_REQUIRED || this.state === SimState.PUK_REQUIRED; }

  enterPin(pin) {
    if (this.state !== SimState.PIN_REQUIRED) return { ok: false, reason: 'no-pin-required' };
    if (pin === this.pin) {
      this.state = SimState.READY;
      this.pinAttempts = 3;
      return { ok: true };
    }
    this.pinAttempts--;
    if (this.pinAttempts <= 0) {
      this.state = SimState.PUK_REQUIRED;
    }
    return { ok: false, reason: 'wrong-pin', attemptsLeft: this.pinAttempts };
  }

  enterPuk(puk, newPin = null) {
    if (this.state !== SimState.PUK_REQUIRED) return { ok: false, reason: 'no-puk-required' };
    if (puk === this.puk) {
      this.state = SimState.PIN_REQUIRED;
      this.pinAttempts = 3;
      if (newPin) this.pin = newPin;
      return { ok: true };
    }
    return { ok: false, reason: 'wrong-puk' };
  }

  snapshot() {
    return {
      type:        this.type,
      iccid:       this.iccid,
      imsi:        this.imsi,
      state:       this.state,
      provider:    this.provider.name,
      phoneNumber: this.phoneNumber,
      pinAttempts: this.pinAttempts,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Cell — celda a la que estamos registrados
// ───────────────────────────────────────────────────────────────
class Cell {
  constructor({ id, rat, band, earfcn = null, pci = null, tac = null }) {
    this.id      = id;
    this.rat     = rat;
    this.band    = band;
    this.earfcn  = earfcn ?? Math.floor(Math.random() * 10000);
    this.pci     = pci ?? Math.floor(Math.random() * 500);
    this.tac     = tac ?? Math.floor(Math.random() * 60000);
    this.since   = Date.now();
  }

  snapshot() {
    return {
      id:     this.id,
      rat:    this.rat,
      band:   this.band,
      earfcn: this.earfcn,
      pci:    this.pci,
      tac:    this.tac,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// Call — una llamada en curso o entrante
// ───────────────────────────────────────────────────────────────
class Call {
  constructor({ id, direction, number, name = null, type = CallType.VOICE, voLte = false, voWiFi = false }) {
    this.id         = id;
    this.direction  = direction;    // 'incoming' | 'outgoing'
    this.number     = number;
    this.name       = name;
    this.type       = type;
    this.state      = direction === 'incoming' ? CallState.INCOMING : CallState.DIALLING;
    this.voLte      = voLte;
    this.voWiFi     = voWiFi;
    this.hdVoice    = false;
    this.startTs    = Date.now();
    this.answeredTs = null;
    this.endedTs    = null;
    this.endReason  = null;
  }

  answer() {
    if (this.state !== CallState.INCOMING) return false;
    this.state = CallState.ACTIVE;
    this.answeredTs = Date.now();
    return true;
  }

  hangup(reason = 'local') {
    this.state = CallState.ENDED;
    this.endedTs = Date.now();
    this.endReason = reason;
    return true;
  }

  durationMs() {
    if (!this.answeredTs) return 0;
    return (this.endedTs || Date.now()) - this.answeredTs;
  }

  snapshot() {
    return {
      id:         this.id,
      direction:  this.direction,
      number:     this.number,
      name:       this.name,
      type:       this.type,
      state:      this.state,
      voLte:      this.voLte,
      voWiFi:     this.voWiFi,
      hdVoice:    this.hdVoice,
      startTs:    this.startTs,
      answeredTs: this.answeredTs,
      endedTs:    this.endedTs,
      endReason:  this.endReason,
      durationMs: this.durationMs(),
    };
  }
}

// ───────────────────────────────────────────────────────────────
// SMSMessage
// ───────────────────────────────────────────────────────────────
class SMSMessage {
  constructor({ id, direction, number, body, status = SmsStatus.PENDING }) {
    this.id        = id;
    this.direction = direction;   // 'incoming' | 'outgoing'
    this.number    = number;
    this.body      = body;
    this.status    = status;
    this.ts        = Date.now();
    this.deliveredAt = null;
    this.readAt    = null;
  }

  snapshot() {
    return {
      id:        this.id,
      direction: this.direction,
      number:    this.number,
      body:      this.body,
      status:    this.status,
      ts:        this.ts,
      deliveredAt:this.deliveredAt,
      readAt:    this.readAt,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// VCellular — driver completo
// ───────────────────────────────────────────────────────────────
export class VCellular {
  constructor(bus) {
    this.bus   = bus;
    this.name  = 'VCellular';
    this.model = DEVICE_MODEL.radios.cellular.name;

    // Estado
    this.initialized = false;
    this.running     = false;
    this.state       = ModemState.OFF;
    this.airplane    = false;
    this.lowPower    = false;

    // Radio
    this.rat        = RatType.NONE;
    this.supportedRats = [RatType.NR_SA, RatType.NR_NSA, RatType.LTE, RatType.LTE_A, RatType.UMTS, RatType.GSM];
    this.supportedBands5G = [...DEVICE_MODEL.radios.cellular.bands5G];
    this.supportedBandsLTE = ['B1','B2','B3','B4','B5','B7','B8','B12','B13','B14','B17','B18','B19','B20','B25','B26','B28','B29','B30','B38','B40','B41','B46','B48','B66','B71'];
    this.supportedMimo = DEVICE_MODEL.radios.cellular.mimo;   // '4x4'
    this.maxSpeedGbps = DEVICE_MODEL.radios.cellular.maxSpeedGbps;

    // Celda actual
    this.currentCell = null;

    // Señal
    this.signal = new Signal();

    // SIM / eSIM
    this.sim = new SIMCard({ type: 'physical' });
    this.esim = new SIMCard({ type: 'esim' });
    this.activeSim = 'physical';    // 'physical' | 'esim'

    // Portadora activa
    this.carrier = null;

    // Data connection
    this.data = {
      connected: false,
      apn:       null,
      ip:        null,
      ipv6:      null,
      mtu:       1500,
      since:     null,
      rxBytes:   0,
      txBytes:   0,
      currentRxBps: 0,
      currentTxBps: 0,
      dataPlanGb: 50,
      dataUsedGb: 0.3,
      throttled: false,
    };

    // Voz
    this.currentCall  = null;
    this.callHistory  = [];
    this.maxCallHistory = 50;

    // SMS
    this.messages     = [];
    this.maxMessages  = 500;

    // Roaming
    this.roaming      = { active: false, country: null, carrier: null, since: null };

    // Handover / cell history
    this.cellHistory  = [];
    this.maxCellHistory = 20;

    // Historial de señal (para gráficos)
    this.historySize = 120;
    this.history = {
      ts:    [],
      rssi:  [],
      rsrp:  [],
      bars:  [],
      rxMbps:[],
      txMbps:[],
    };

    // Suscriptores
    this.subscribers         = new Set();
    this.signalSubscribers   = new Set();
    this.callSubscribers     = new Set();
    this.smsSubscribers      = new Set();
    this.dataSubscribers     = new Set();

    // Tick loop
    this.tickIntervalMs = 500;
    this.tickId = null;
    this.tickCount = 0;

    // Métricas
    this.metrics = {
      attachAttempts:     0,
      attachSuccesses:    0,
      detaches:           0,
      handovers:          0,
      callsOutgoing:      0,
      callsIncoming:      0,
      callsAnswered:      0,
      callsMissed:        0,
      smsSent:            0,
      smsReceived:        0,
      dataConnectAttempts:0,
      dataConnectSuccesses:0,
      dataDisconnects:    0,
      roamingEntries:     0,
      signalChanges:      0,
      startedAt:          null,
    };

    logger.kernel('VCellular', `creado: ${this.model} (${this.supportedRats.length} RATs)`);
  }

  // ═══════════════════════════════════════════════════════════
  // CICLO DE VIDA
  // ═══════════════════════════════════════════════════════════

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.metrics.startedAt = Date.now();
    this._startTickLoop();

    logger.info('VCellular',
      `✓ init: ${this.model}, RATs=${this.supportedRats.length}, ` +
      `bands5G=${this.supportedBands5G.length}, bandsLTE=${this.supportedBandsLTE.length}`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'ready',
    }, 'vcellular');
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

    // Terminar llamada si hay
    if (this.currentCall) this.endCall('shutdown');
    // Desconectar datos
    if (this.data.connected) this.disconnectData('shutdown');

    logger.info('VCellular', 'apagado');
  }

  // ═══════════════════════════════════════════════════════════
  // TICK
  // ═══════════════════════════════════════════════════════════

  _tick() {
    if (!this.running) return;

    // 1) Actualizar señal (si estamos registrados)
    if (this.state === ModemState.REGISTERED || this.state === ModemState.ROAMING) {
      this._updateSignal();
      this._maybeHandover();
    }

    // 2) Simular tráfico de datos
    if (this.data.connected) {
      this._simulateDataTraffic();
    }

    // 3) Handlers automáticos de llamadas
    if (this.currentCall) {
      this._updateCall();
    }

    // 4) Random events (SMS entrante, llamada entrante, etc.) — solo
    // si estamos "conectados" y el usuario tiene el módem activo.
    this._maybeRandomEvent();

    // 5) Historial
    this._pushHistory();

    // 6) Emitir snapshot
    this._emit();

    this.tickCount++;
  }

  _updateSignal() {
    // La señal fluctúa suavemente
    const prevBars = this.signal.bars;
    this.signal.update(this.signal.rssi);
    if (this.signal.bars !== prevBars) {
      this.metrics.signalChanges++;
      this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
        source: 'vcellular', event: 'signal-changed', bars: this.signal.bars,
      }, 'vcellular');
    }
    for (const fn of this.signalSubscribers) {
      try { fn(this.signal.snapshot()); } catch (_) {}
    }
  }

  _maybeHandover() {
    // ~0.5% de probabilidad por tick de handover entre celdas
    if (Math.random() > 0.005) return;
    const prevBand = this.currentCell?.band;
    const newBand = randomFrom(this.supportedBandsLTE);
    if (newBand === prevBand) return;
    const prevCell = this.currentCell;
    this.currentCell = new Cell({
      id: `cell-${Date.now()}`,
      rat: this.rat,
      band: newBand,
    });
    this.cellHistory.push(this.currentCell.snapshot());
    if (this.cellHistory.length > this.maxCellHistory) this.cellHistory.shift();
    this.metrics.handovers++;
    logger.info('VCellular', `handover: ${prevCell?.band} → ${newBand}`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'handover',
      from: prevCell?.snapshot(), to: this.currentCell.snapshot(),
    }, 'vcellular');
  }

  _simulateDataTraffic() {
    const d = this.data;
    if (!d.connected) return;

    // Velocidad según RAT y señal
    const base = {
      [RatType.NR_SA]:  500_000_000,   // 500 MB/s (5G)
      [RatType.NR_NSA]: 300_000_000,
      [RatType.LTE_A]:   80_000_000,
      [RatType.LTE]:     40_000_000,
      [RatType.UMTS]:     2_000_000,
      [RatType.GSM]:        100_000,
    }[this.rat] || 20_000_000;

    const quality = this.signal.quality / 100;
    const maxRx = base * quality;
    const maxTx = maxRx / 4;

    // Tráfico instantáneo
    const spike = Math.random() < 0.1 ? 5 : 1;
    d.currentRxBps = maxRx * 0.05 * spike * (0.5 + Math.random());
    d.currentTxBps = maxTx * 0.05 * spike * (0.5 + Math.random());

    // Throttle por plan de datos
    if (d.dataUsedGb >= d.dataPlanGb) {
      if (!d.throttled) {
        d.throttled = true;
        logger.warn('VCellular', `plan de datos agotado (${d.dataPlanGb}GB), throttling activado`);
        this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
          source: 'vcellular', event: 'data-throttled',
        }, 'vcellular');
      }
      d.currentRxBps = Math.min(d.currentRxBps, 128_000);
      d.currentTxBps = Math.min(d.currentTxBps, 128_000);
    }

    const dtSec = this.tickIntervalMs / 1000;
    const rx = d.currentRxBps * dtSec;
    const tx = d.currentTxBps * dtSec;
    d.rxBytes += rx;
    d.txBytes += tx;
    d.dataUsedGb += (rx + tx) / 1e9;
  }

  _updateCall() {
    const c = this.currentCall;

    // Si es entrante y no se contesta en 30s, missed
    if (c.state === CallState.INCOMING && Date.now() - c.startTs > 30000) {
      this.metrics.callsMissed++;
      this.endCall('no-answer');
    }
  }

  _maybeRandomEvent() {
    if (this.state !== ModemState.REGISTERED && this.state !== ModemState.ROAMING) return;
    if (this.airplane) return;

    // 0.02% por tick: llamada entrante
    if (!this.currentCall && Math.random() < 0.0002) {
      this.receiveCall({
        number: '+' + randomDigits(11),
        name:   randomFrom(['Ana', 'Carlos', 'Mamá', 'Trabajo', 'Desconocido']),
      });
    }

    // 0.03% por tick: SMS entrante
    if (Math.random() < 0.0003) {
      this.receiveSMS({
        number: '+' + randomDigits(11),
        body:   randomFrom([
          'Hola, ¿qué tal?',
          'Tu código de verificación es 123456',
          'Nos vemos mañana a las 20:00',
          'Tu pedido ha sido enviado',
          'Recordatorio: cita médica el martes',
        ]),
      });
    }
  }

  _pushHistory() {
    this.history.ts.push(Date.now());
    this.history.rssi.push(this.signal.rssi);
    this.history.rsrp.push(this.signal.rsrp);
    this.history.bars.push(this.signal.bars);
    this.history.rxMbps.push((this.data.currentRxBps * 8) / 1e6);
    this.history.txMbps.push((this.data.currentTxBps * 8) / 1e6);
    for (const k of Object.keys(this.history)) {
      if (this.history[k].length > this.historySize) this.history[k].shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ENCENDIDO / APAGADO
  // ═══════════════════════════════════════════════════════════

  async powerOn() {
    if (this.airplane) {
      logger.warn('VCellular', 'powerOn rechazado: modo avión activo');
      return false;
    }
    if (this.state === ModemState.REGISTERED || this.state === ModemState.ROAMING) return true;

    this.state = ModemState.ENABLING;
    this._emit();
    logger.info('VCellular', 'encendiendo módem...');
    await this._delay(500 + Math.random() * 500);

    // ¿SIM lista?
    const sim = this.activeSim === 'physical' ? this.sim : this.esim;
    if (!sim.isReady()) {
      logger.warn('VCellular', `SIM no lista: ${sim.state}`);
      this.state = ModemState.NO_SERVICE;
      this._emit();
      return false;
    }

    // Buscar red
    this.state = ModemState.SEARCHING;
    logger.info('VCellular', 'buscando red...');
    await this._delay(800 + Math.random() * 1000);

    // Registrar
    return this._attach();
  }

  async powerOff() {
    if (this.state === ModemState.OFF) return true;

    if (this.currentCall) this.endCall('power-off');
    if (this.data.connected) this.disconnectData('power-off');

    this.metrics.detaches++;
    this.state = ModemState.OFF;
    this.rat = RatType.NONE;
    this.currentCell = null;
    this.carrier = null;
    logger.info('VCellular', 'módem off');
    this._emit();
    return true;
  }

  setAirplaneMode(on) {
    this.airplane = !!on;
    logger.info('VCellular', `airplane mode ${this.airplane ? 'ON' : 'OFF'}`);
    if (this.airplane) {
      this.powerOff().catch(() => {});
      this.state = ModemState.AIRPLANE;
    } else {
      this.state = ModemState.OFF;
    }
    this._emit();
  }

  setLowPowerMode(on) {
    this.lowPower = !!on;
    logger.info('VCellular', `low power ${this.lowPower ? 'ON' : 'OFF'}`);
    this._emit();
  }

  // ═══════════════════════════════════════════════════════════
  // ATTACH / DETACH
  // ═══════════════════════════════════════════════════════════

  async _attach() {
    this.metrics.attachAttempts++;

    // Elegir RAT según disponibilidad
    const rat = this._pickRat();
    const sim = this.activeSim === 'physical' ? this.sim : this.esim;
    const carrier = sim.provider;

    // Elegir banda según RAT
    const band = rat.startsWith('5G')
      ? randomFrom(this.supportedBands5G)
      : randomFrom(this.supportedBandsLTE);

    this.rat = rat;
    this.carrier = carrier;
    this.currentCell = new Cell({
      id:   `cell-${Date.now()}`,
      rat, band,
    });
    this.cellHistory.push(this.currentCell.snapshot());
    if (this.cellHistory.length > this.maxCellHistory) this.cellHistory.shift();

    // ¿Roaming?
    const isHome = carrier.iso === 'ES';
    this.state = isHome ? ModemState.REGISTERED : ModemState.ROAMING;
    if (!isHome) {
      this.roaming = { active: true, country: carrier.country, carrier: carrier.name, since: Date.now() };
      this.metrics.roamingEntries++;
      logger.info('VCellular', `🌍 roaming en ${carrier.country} (${carrier.name})`);
      this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
        source: 'vcellular', event: 'roaming-entered', country: carrier.country,
      }, 'vcellular');
    } else {
      this.roaming = { active: false, country: null, carrier: null, since: null };
    }

    this.metrics.attachSuccesses++;
    logger.info('VCellular', `✓ registrado en ${carrier.name} (${rat}, banda ${band})`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'registered', carrier: carrier.name, rat, band,
    }, 'vcellular');
    this._emit();
    return true;
  }

  _pickRat() {
    // Preferencia 5G SA > 5G NSA > LTE-A > LTE, con algo de azar
    const r = Math.random();
    if (r < 0.3) return RatType.NR_SA;
    if (r < 0.55) return RatType.NR_NSA;
    if (r < 0.8) return RatType.LTE_A;
    if (r < 0.95) return RatType.LTE;
    return RatType.UMTS;
  }

  async detach() {
    if (this.state !== ModemState.REGISTERED && this.state !== ModemState.ROAMING) return false;
    if (this.data.connected) await this.disconnectData('detach');
    this.metrics.detaches++;
    this.state = ModemState.NO_SERVICE;
    this.rat = RatType.NONE;
    this.currentCell = null;
    logger.info('VCellular', 'detach completado');
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // DATA CONNECTION
  // ═══════════════════════════════════════════════════════════

  async connectData({ apn = null } = {}) {
    if (this.state !== ModemState.REGISTERED && this.state !== ModemState.ROAMING) {
      logger.warn('VCellular', 'connectData rechazado: sin servicio');
      return false;
    }
    if (this.data.connected) return true;

    this.metrics.dataConnectAttempts++;

    // APN por defecto según carrier
    if (!apn) {
      const c = this.carrier;
      apn = c ? `${c.name.toLowerCase().replace(/\s/g, '')}.internet` : 'internet';
    }

    logger.info('VCellular', `activando datos móviles (APN=${apn})...`);
    await this._delay(300 + Math.random() * 400);

    const ip   = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
    const ipv6 = `2001:${randomHex(4)}:${randomHex(4)}::${randomHex(4)}`;

    this.data = {
      ...this.data,
      connected: true,
      apn,
      ip,
      ipv6,
      since: Date.now(),
      throttled: false,
    };
    this.metrics.dataConnectSuccesses++;

    logger.info('VCellular', `✓ datos conectados: IP=${ip}`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'data-connected', ip, apn, rat: this.rat,
    }, 'vcellular');
    this._emitData({ type: 'connected', ip, apn, rat: this.rat });
    this._emit();
    return true;
  }

  async disconnectData(reason = 'user') {
    if (!this.data.connected) return false;
    const ip = this.data.ip;
    this.data = {
      ...this.data,
      connected: false,
      apn: null,
      ip: null,
      ipv6: null,
      since: null,
      currentRxBps: 0,
      currentTxBps: 0,
      throttled: false,
    };
    this.metrics.dataDisconnects++;
    logger.info('VCellular', `datos desconectados (${reason})`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'data-disconnected', reason,
    }, 'vcellular');
    this._emitData({ type: 'disconnected', ip, reason });
    this._emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // VOZ
  // ═══════════════════════════════════════════════════════════

  async makeCall({ number, name = null, type = CallType.VOICE }) {
    if (this.state !== ModemState.REGISTERED && this.state !== ModemState.ROAMING) {
      logger.warn('VCellular', 'makeCall rechazado: sin servicio');
      return null;
    }
    if (this.currentCall) {
      logger.warn('VCellular', 'makeCall rechazado: ya hay una llamada en curso');
      return null;
    }
    if (!number) {
      logger.warn('VCellular', 'makeCall: número requerido');
      return null;
    }

    const id = `call-${Date.now()}`;
    const call = new Call({
      id, direction: 'outgoing', number, name, type,
      voLte: this.rat.startsWith('5G') || this.rat.startsWith('LTE'),
      voWiFi: false,
    });
    this.currentCall = call;
    this.metrics.callsOutgoing++;
    this._emitCall({ type: 'dialling', call: call.snapshot() });

    logger.info('VCellular', `📞 llamada saliente → ${number}`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'call-dialling', number, name,
    }, 'vcellular');

    // Simular que la otra parte contesta (o no)
    const willAnswer = Math.random() < 0.8;
    if (willAnswer) {
      await this._delay(2000 + Math.random() * 3000);
      if (this.currentCall === call && call.state === CallState.DIALLING) {
        call.answer();
        call.hdVoice = Math.random() < 0.7;
        this.metrics.callsAnswered++;
        this._emitCall({ type: 'answered', call: call.snapshot() });
        logger.info('VCellular', `📞 llamada contestada`);
      }
    }

    return id;
  }

  receiveCall({ number, name = null, type = CallType.VOICE }) {
    if (this.currentCall) {
      logger.warn('VCellular', 'receiveCall: ya hay una llamada en curso');
      return null;
    }
    const id = `call-${Date.now()}`;
    const call = new Call({
      id, direction: 'incoming', number, name, type,
      voLte: this.rat.startsWith('5G') || this.rat.startsWith('LTE'),
    });
    this.currentCall = call;
    this.metrics.callsIncoming++;
    this._emitCall({ type: 'incoming', call: call.snapshot() });
    logger.info('VCellular', `📞 llamada entrante de ${name || number}`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'call-incoming', number, name,
    }, 'vcellular');

    // Auto-terminar tras 30s si no se contesta (lo hace el tick)
    return id;
  }

  answerCall() {
    if (!this.currentCall) return false;
    if (this.currentCall.state !== CallState.INCOMING) return false;
    this.currentCall.answer();
    this.currentCall.hdVoice = Math.random() < 0.7;
    this.metrics.callsAnswered++;
    this._emitCall({ type: 'answered', call: this.currentCall.snapshot() });
    logger.info('VCellular', '📞 llamada aceptada');
    return true;
  }

  endCall(reason = 'local') {
    if (!this.currentCall) return false;
    const call = this.currentCall;
    call.hangup(reason);
    this.currentCall = null;

    this.callHistory.push(call.snapshot());
    if (this.callHistory.length > this.maxCallHistory) this.callHistory.shift();

    this._emitCall({ type: 'ended', call: call.snapshot() });
    logger.info('VCellular',
      `📞 llamada finalizada (${reason}, duración ${(call.durationMs() / 1000).toFixed(1)}s)`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'call-ended', reason, durationMs: call.durationMs(),
    }, 'vcellular');
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // SMS
  // ═══════════════════════════════════════════════════════════

  async sendSMS({ number, body }) {
    if (this.state !== ModemState.REGISTERED && this.state !== ModemState.ROAMING) {
      logger.warn('VCellular', 'sendSMS rechazado: sin servicio');
      return null;
    }
    if (!number || !body) {
      logger.warn('VCellular', 'sendSMS: number y body requeridos');
      return null;
    }

    const id = `sms-${Date.now()}`;
    const msg = new SMSMessage({ id, direction: 'outgoing', number, body, status: SmsStatus.PENDING });
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) this.messages.shift();

    this.metrics.smsSent++;
    this._emitSMS({ type: 'sending', message: msg.snapshot() });

    // Simular envío y entrega
    await this._delay(500 + Math.random() * 1000);
    msg.status = SmsStatus.SENT;
    this._emitSMS({ type: 'sent', message: msg.snapshot() });

    await this._delay(800 + Math.random() * 1500);
    if (Math.random() < 0.95) {
      msg.status = SmsStatus.DELIVERED;
      msg.deliveredAt = Date.now();
      this._emitSMS({ type: 'delivered', message: msg.snapshot() });
    } else {
      msg.status = SmsStatus.FAILED;
      this._emitSMS({ type: 'failed', message: msg.snapshot() });
    }

    return msg.snapshot();
  }

  receiveSMS({ number, body }) {
    if (!number || !body) return null;
    const id = `sms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const msg = new SMSMessage({ id, direction: 'incoming', number, body, status: SmsStatus.RECEIVED });
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) this.messages.shift();

    this.metrics.smsReceived++;
    this._emitSMS({ type: 'received', message: msg.snapshot() });
    logger.info('VCellular', `💬 SMS recibido de ${number}: "${body.slice(0, 40)}..."`);
    this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
      source: 'vcellular', event: 'sms-received', number, body,
    }, 'vcellular');
    return msg.snapshot();
  }

  getMessages({ number = null, limit = 50 } = {}) {
    let msgs = this.messages;
    if (number) msgs = msgs.filter(m => m.number === number);
    return msgs.slice(-limit).map(m => m.snapshot());
  }

  markRead(id) {
    const m = this.messages.find(m => m.id === id);
    if (!m) return false;
    m.readAt = Date.now();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // SIM
  // ═══════════════════════════════════════════════════════════

  enterPin(pin, { esim = false } = {}) {
    const sim = esim ? this.esim : this.sim;
    const result = sim.enterPin(pin);
    if (result.ok) {
      logger.info('VCellular', `SIM desbloqueada (${sim.type})`);
      this.bus?.raiseInterrupt?.('IRQ_CELLULAR', {
        source: 'vcellular', event: 'sim-state-changed', sim: sim.snapshot(),
      }, 'vcellular');
      // Reintentar attach
      if (this.state === ModemState.NO_SERVICE) this._attach().catch(() => {});
    } else {
      logger.warn('VCellular', `PIN incorrecto, ${result.attemptsLeft} intentos restantes`);
    }
    this._emit();
    return result;
  }

  enterPuk(puk, newPin = null, { esim = false } = {}) {
    const sim = esim ? this.esim : this.sim;
    const result = sim.enterPuk(puk, newPin);
    this._emit();
    return result;
  }

  switchActiveSim(which) {
    if (which !== 'physical' && which !== 'esim') return false;
    if (this.activeSim === which) return true;
    const prev = this.activeSim;
    this.activeSim = which;

    // Detach y attach de nuevo
    this.detach().then(() => this._attach()).catch(() => {});

    logger.info('VCellular', `SIM activa: ${prev} → ${which}`);
    this._emit();
    return true;
  }

  getActiveSim() {
    return this.activeSim === 'physical' ? this.sim : this.esim;
  }

  // ═══════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════

  isRegistered() {
    return this.state === ModemState.REGISTERED || this.state === ModemState.ROAMING;
  }

  isDataConnected() {
    return this.data.connected;
  }

  isInCall() {
    return !!this.currentCall;
  }

  getCarrier() {
    return this.carrier ? { ...this.carrier } : null;
  }

  getSignal() {
    return this.signal.snapshot();
  }

  getCurrentCell() {
    return this.currentCell ? this.currentCell.snapshot() : null;
  }

  getDataUsage() {
    return {
      apn:       this.data.apn,
      ip:        this.data.ip,
      since:     this.data.since,
      rxBytes:   this.data.rxBytes,
      txBytes:   this.data.txBytes,
      rxMB:      parseFloat((this.data.rxBytes / 1024 / 1024).toFixed(2)),
      txMB:      parseFloat((this.data.txBytes / 1024 / 1024).toFixed(2)),
      usedGb:    parseFloat(this.data.dataUsedGb.toFixed(3)),
      planGb:    this.data.dataPlanGb,
      usedPct:   parseFloat(((this.data.dataUsedGb / this.data.dataPlanGb) * 100).toFixed(2)),
      throttled: this.data.throttled,
    };
  }

  getCallHistory(n = 20) {
    return this.callHistory.slice(-n);
  }

  getCellHistory() {
    return [...this.cellHistory];
  }

  // ═══════════════════════════════════════════════════════════
  // SUSCRIPTORES
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onSignal(fn) {
    this.signalSubscribers.add(fn);
    return () => this.signalSubscribers.delete(fn);
  }

  onCall(fn) {
    this.callSubscribers.add(fn);
    return () => this.callSubscribers.delete(fn);
  }

  onSMS(fn) {
    this.smsSubscribers.add(fn);
    return () => this.smsSubscribers.delete(fn);
  }

  onData(fn) {
    this.dataSubscribers.add(fn);
    return () => this.dataSubscribers.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (err) {
        logger.error('VCellular', `subscriber falló: ${err.message}`, err);
      }
    }
  }

  _emitCall(evt) {
    for (const fn of this.callSubscribers) { try { fn(evt); } catch (_) {} }
  }

  _emitSMS(evt) {
    for (const fn of this.smsSubscribers) { try { fn(evt); } catch (_) {} }
  }

  _emitData(evt) {
    for (const fn of this.dataSubscribers) { try { fn(evt); } catch (_) {} }
  }

  // ═══════════════════════════════════════════════════════════
  // SNAPSHOTS / STATS
  // ═══════════════════════════════════════════════════════════

  getSnapshot() {
    return {
      model:       this.model,
      state:       this.state,
      airplane:    this.airplane,
      lowPower:    this.lowPower,
      rat:         this.rat,
      carrier:     this.carrier ? this.carrier.name : null,
      roaming:     { ...this.roaming },
      signal:      this.signal.snapshot(),
      cell:        this.getCurrentCell(),
      sim:         this.getActiveSim().snapshot(),
      data:        this.getDataUsage(),
      inCall:      !!this.currentCall,
      call:        this.currentCall ? this.currentCall.snapshot() : null,
      messages:    this.messages.length,
    };
  }

  getStats() {
    return {
      model:       this.model,
      initialized: this.initialized,
      running:     this.running,
      state:       this.state,
      rat:         this.rat,
      metrics:     { ...this.metrics },
      sim: {
        physical: this.sim.snapshot(),
        esim:     this.esim.snapshot(),
        active:   this.activeSim,
      },
      data:        this.getDataUsage(),
      callsHistory:this.callHistory.length,
      messages:    this.messages.length,
    };
  }

  dump() {
    const s = this.getStats();
    const sig = this.signal.snapshot();
    const lines = [
      `VCellular [${s.state}] — ${s.model}`,
      `  RAT:         ${s.rat}`,
      `  carrier:     ${this.carrier ? `${this.carrier.name} (${this.carrier.mcc}-${this.carrier.mnc})` : '—'}`,
      `  roaming:     ${this.roaming.active ? `sí (${this.roaming.country})` : 'no'}`,
      `  señal:       ${sig.bars}/5 bars  RSSI=${sig.rssi}dBm  RSRP=${sig.rsrp}dBm  SINR=${sig.sinr}dB  calidad=${sig.quality}%`,
      `  celda:       ${this.currentCell ? `${this.currentCell.band} / PCI ${this.currentCell.pci}` : '—'}`,
      `  SIM:         ${s.sim.active} (${s.sim[s.sim.active].state}) — ${s.sim[s.sim.active].provider}`,
      `  datos:       ${this.data.connected ? `${this.data.apn} → ${this.data.ip}` : 'desconectado'}`,
      `  uso datos:   ${s.data.usedGb}GB / ${s.data.planGb}GB (${s.data.usedPct}%)${s.data.throttled ? ' [THROTTLED]' : ''}`,
      `  llamada:     ${this.currentCall ? `${this.currentCall.direction} ${this.currentCall.number} [${this.currentCall.state}]` : 'ninguna'}`,
      `  SMS:         ${s.messages}`,
      `  métricas:`,
      `    attach=${s.metrics.attachSuccesses}/${s.metrics.attachAttempts} handovers=${s.metrics.handovers}`,
      `    calls: out=${s.metrics.callsOutgoing} in=${s.metrics.callsIncoming} missed=${s.metrics.callsMissed}`,
      `    sms: sent=${s.metrics.smsSent} recv=${s.metrics.smsReceived}`,
      `    data: connect=${s.metrics.dataConnectSuccesses}/${s.metrics.dataConnectAttempts} disconnect=${s.metrics.dataDisconnects}`,
    ];
    return lines.join('\n');
  }

  getHistory() {
    return {
      ts:    [...this.history.ts],
      rssi:  [...this.history.rssi],
      rsrp:  [...this.history.rsrp],
      bars:  [...this.history.bars],
      rxMbps:[...this.history.rxMbps],
      txMbps:[...this.history.txMbps],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
