// src/loader/IPAInstaller.js
// Instalador de apps (.ipa / .app / .xcarchive) para iOS Remastered.
// - Desempaqueta un IPA (o .app) en memoria / FS
// - Valida estructura y Info.plist
// - Valida firma (codesign simulado) y provisioning profile
// - Verifica entitlements vs. provisioning
// - Comprueba compatibilidad de plataforma (iOS/iPhoneOS, versión mínima)
// - Registra la app en LaunchServices (bundleId → path)
// - Crea contenedores de datos en el FileSystem (bundleId sandbox)
// - Copia el binario Mach-O al bundle de la app
// - Genera iconos, UILaunchScreen, etc.
// - Instala / desinstala / actualiza / lista apps
// Sin dependencias externas.

import { Logger } from '../system/Logger.js';
import { FileSystem } from '../system/FileSystem.js';
import { MachOError } from './MachOStructures.js';

const LOG_TAG = 'IPA';

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

export const INSTALL_STATE = {
  QUEUED:     'queued',
  EXTRACTING: 'extracting',
  VALIDATING: 'validating',
  SIGNING:    'signing',
  INSTALLING: 'installing',
  DONE:       'done',
  FAILED:     'failed',
  ROLLED_BACK:'rolled-back',
};

export const INSTALL_ERRORS = {
  BAD_ZIP:            'EIPA_BAD_ZIP',
  NO_PAYLOAD:         'EIPA_NO_PAYLOAD',
  NO_APP_BUNDLE:      'EIPA_NO_APP',
  BAD_INFOPLIST:      'EIPA_BAD_INFOPLIST',
  MISSING_EXECUTABLE: 'EIPA_NO_EXECUTABLE',
  BAD_EXECUTABLE:     'EIPA_BAD_EXECUTABLE',
  MISSING_BUNDLE_ID:  'EIPA_NO_BUNDLE_ID',
  BAD_BUNDLE_ID:      'EIPA_BAD_BUNDLE_ID',
  UNSUPPORTED_PLATFORM: 'EIPA_UNSUPPORTED_PLATFORM',
  MIN_OS_TOO_HIGH:    'EIPA_MIN_OS_TOO_HIGH',
  BAD_SIGNATURE:      'EIPA_BAD_SIGNATURE',
  NO_PROVISIONING:    'EIPA_NO_PROVISIONING',
  EXPIRED_PROVISIONING: 'EIPA_EXPIRED_PROVISIONING',
  ENTITLEMENT_MISMATCH: 'EIPA_ENTITLEMENT_MISMATCH',
  DUPLICATE_BUNDLE_ID: 'EIPA_DUPLICATE_BUNDLE_ID',
  INSUFFICIENT_SPACE: 'EIPA_INSUFFICIENT_SPACE',
  DEVICE_NOT_REGISTERED: 'EIPA_DEVICE_NOT_REGISTERED',
  TEAM_MISMATCH:      'EIPA_TEAM_MISMATCH',
  GENERIC:            'EIPA_GENERIC',
};

// Bundle IDs protegidos (no instalables)
const PROTECTED_BUNDLE_IDS = new Set([
  'com.apple.springboard',
  'com.apple.mobilesafari',
  'com.apple.mobilemail',
  'com.apple.Preferences',
  'com.apple.MobileSMS',
  'com.apple.Music',
]);

// Plataformas soportadas
const SUPPORTED_PLATFORMS = new Set(['iPhoneOS', 'iPhoneSimulator', 'iOS']);

// Filetype de plataforma en Info.plist
const DT_PLATFORM_IOS = 'iphoneos';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function uid() {
  return 'ipa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function now() { return Date.now(); }
function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }

// Versión estilo "18.0" → entero 180000 para comparar
function versionToInt(v) {
  if (!v) return 0;
  const parts = String(v).split('.').map(n => parseInt(n, 10) || 0);
  const [a = 0, b = 0, c = 0] = parts;
  return (a << 16) | (b << 8) | c;
}

function compareVersion(a, b) {
  return versionToInt(a) - versionToInt(b);
}

function makeError(code, msg, extra = {}) {
  const e = new Error(msg || code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function bytesToHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${round(n / 1024, 1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${round(n / 1024 / 1024, 1)} MB`;
  return `${round(n / 1024 / 1024 / 1024, 2)} GB`;
}

/* ------------------------------------------------------------------ *
 * ZipReader — lector de ZIP mínimo (soporta STORE y DEFLATE simulado)
 * ------------------------------------------------------------------ */

// Nota: no implementamos DEFLATE real (no hay librerías externas).
// Para archivos .ipa reales habría que añadir un inflate. Aquí modelamos
// la estructura del ZIP: central directory + local headers + entradas.
class ZipEntry {
  constructor(name, data, opts = {}) {
    this.name = name;
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.size = this.data.length;
    this.compressedSize = opts.compressedSize ?? this.size;
    this.compression = opts.compression ?? 0;   // 0=STORE, 8=DEFLATE
    this.crc32 = opts.crc32 ?? ZipReader.crc32(this.data);
    this.mode = opts.mode ?? 0o644;
    this.isDirectory = name.endsWith('/');
  }
}

class ZipReader {
  constructor(entries = []) {
    this.entries = new Map();
    for (const e of entries) this.entries.set(e.name, e);
  }

  static crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  static fromEntries(list) {
    return new ZipReader(list.map(e => e instanceof ZipEntry ? e : new ZipEntry(e.name, e.data, e)));
  }

  // Parse desde bytes crudos — soporta el formato ZIP real con STORE
  // (deflate real requeriría inflate)
  static parse(bytes) {
    const reader = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Buscar End Of Central Directory (EOCD): 0x06054b50
    let eocdOffset = -1;
    const max = bytes.length - 22;
    for (let i = max; i >= 0 && i >= max - 65536; i--) {
      if (reader.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw makeError(INSTALL_ERRORS.BAD_ZIP, 'EOCD no encontrado');

    const cdOffset = reader.getUint32(eocdOffset + 16, true);
    const cdCount = reader.getUint16(eocdOffset + 10, true);

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (reader.getUint32(p, true) !== 0x02014b50) break;
      const method = reader.getUint16(p + 10, true);
      const compSize = reader.getUint32(p + 20, true);
      const uncompSize = reader.getUint32(p + 24, true);
      const nameLen = reader.getUint16(p + 28, true);
      const extraLen = reader.getUint16(p + 30, true);
      const commentLen = reader.getUint16(p + 32, true);
      const localOffset = reader.getUint32(p + 42, true);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = new TextDecoder('utf-8').decode(nameBytes);

      // Local file header
      const lh = localOffset;
      if (reader.getUint32(lh, true) !== 0x04034b50) {
        p += 46 + nameLen + extraLen + commentLen;
        continue;
      }
      const lhNameLen = reader.getUint16(lh + 26, true);
      const lhExtraLen = reader.getUint16(lh + 28, true);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const dataEnd = dataStart + compSize;
      const raw = bytes.subarray(dataStart, dataEnd);

      let data;
      if (method === 0) {
        data = new Uint8Array(raw);
      } else {
        // DEFLATE no implementado — guardamos raw (stub)
        data = new Uint8Array(raw);
      }

      entries.push(new ZipEntry(name, data, {
        compression: method,
        compressedSize: compSize,
      }));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipReader(entries);
  }

  has(name) { return this.entries.has(name); }
  get(name) { return this.entries.get(name); }
  list() { return [...this.entries.keys()]; }
  count() { return this.entries.size; }

  // Lista entradas bajo un prefijo
  listUnder(prefix) {
    const out = [];
    for (const name of this.entries.keys()) {
      if (name.startsWith(prefix)) out.push(name);
    }
    return out;
  }

  totalSize() {
    let t = 0;
    for (const e of this.entries.values()) t += e.size;
    return t;
  }

  // Writer mínimo (STORE) — útil para tests/round-trips
  static write(entries) {
    const enc = new TextEncoder();
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const data = e.data instanceof Uint8Array ? e.data : enc.encode(e.data);
      const crc = ZipReader.crc32(data);

      // Local header
      const lh = new Uint8Array(30 + nameBytes.length + data.length);
      const lhView = new DataView(lh.buffer);
      lhView.setUint32(0, 0x04034b50, true);
      lhView.setUint16(4, 20, true);   // version needed
      lhView.setUint16(6, 0, true);    // flags
      lhView.setUint16(8, 0, true);    // STORE
      lhView.setUint16(10, 0, true);   // time
      lhView.setUint16(12, 0, true);   // date
      lhView.setUint32(14, crc, true);
      lhView.setUint32(18, data.length, true);
      lhView.setUint32(22, data.length, true);
      lhView.setUint16(26, nameBytes.length, true);
      lhView.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      lh.set(data, 30 + nameBytes.length);
      localChunks.push(lh);

      // Central directory entry
      const cd = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cd.buffer);
      cdView.setUint32(0, 0x02014b50, true);
      cdView.setUint16(4, 20, true);   // version made by
      cdView.setUint16(6, 20, true);   // version needed
      cdView.setUint16(8, 0, true);
      cdView.setUint16(10, 0, true);   // STORE
      cdView.setUint16(12, 0, true);
      cdView.setUint16(14, 0, true);
      cdView.setUint32(16, crc, true);
      cdView.setUint32(20, data.length, true);
      cdView.setUint32(24, data.length, true);
      cdView.setUint16(28, nameBytes.length, true);
      cdView.setUint16(30, 0, true);
      cdView.setUint16(32, 0, true);
      cdView.setUint16(34, 0, true);
      cdView.setUint16(36, 0, true);
      cdView.setUint32(38, 0, true);
      cdView.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      centralChunks.push(cd);

      offset += lh.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of centralChunks) cdSize += c.length;

    // EOCD
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);

    const total = offset + cdSize + 22;
    const out = new Uint8Array(total);
    let w = 0;
    for (const c of localChunks) { out.set(c, w); w += c.length; }
    for (const c of centralChunks) { out.set(c, w); w += c.length; }
    out.set(eocd, w);
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Info.plist parser (soporta XML plist — el binario se puede detectar)
 * ------------------------------------------------------------------ */

class PlistParser {
  static parse(bytes) {
    if (typeof bytes === 'string') return PlistParser.parseXml(bytes);
    if (!(bytes instanceof Uint8Array)) throw new Error('plist: unsupported input');
    if (bytes.length >= 8 && bytes[0] === 0x62 && bytes[1] === 0x70 && bytes[2] === 0x6c && bytes[3] === 0x69) {
      // bplist00 — binario, no implementado en esta versión
      throw new Error('bplist binario no soportado (se requiere XML)');
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return PlistParser.parseXml(text);
  }

  static parseXml(xml) {
    // Parser XML plist minimalista (sin dependencias)
    const clean = xml.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '').trim();
    const rootMatch = clean.match(/<plist[^>]*>([\s\S]*)<\/plist>/);
    if (!rootMatch) throw new Error('plist: <plist> no encontrado');
    const inner = rootMatch[1].trim();
    return PlistParser._parseValue(inner).value;
  }

  static _parseValue(src) {
    src = src.trim();
    if (src.startsWith('<dict>')) return PlistParser._parseDict(src);
    if (src.startsWith('<array>')) return PlistParser._parseArray(src);
    if (src.startsWith('<string>')) return PlistParser._parseSimple(src, 'string', s => s);
    if (src.startsWith('<integer>')) return PlistParser._parseSimple(src, 'integer', s => parseInt(s, 10));
    if (src.startsWith('<real>')) return PlistParser._parseSimple(src, 'real', s => parseFloat(s));
    if (src.startsWith('<true/>')) return { value: true, rest: src.slice(7) };
    if (src.startsWith('<false/>')) return { value: false, rest: src.slice(8) };
    if (src.startsWith('<data>')) return PlistParser._parseSimple(src, 'data', s => s);
    if (src.startsWith('<date>')) return PlistParser._parseSimple(src, 'date', s => s);
    return { value: null, rest: src };
  }

  static _parseSimple(src, tag, fn) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = src.indexOf(open) + open.length;
    const end = src.indexOf(close, start);
    const inner = src.slice(start, end);
    return { value: fn(inner), rest: src.slice(end + close.length) };
  }

  static _parseDict(src) {
    let rest = src.replace(/^<dict>\s*/, '');
    const obj = {};
    while (true) {
      rest = rest.trim();
      if (rest.startsWith('</dict>')) { rest = rest.slice(7); break; }
      if (!rest.startsWith('<key>')) break;
      const keyEnd = rest.indexOf('</key>');
      const key = rest.slice(5, keyEnd);
      rest = rest.slice(keyEnd + 6).trim();
      const { value, rest: r2 } = PlistParser._parseValue(rest);
      obj[key] = value;
      rest = r2;
    }
    return { value: obj, rest };
  }

  static _parseArray(src) {
    let rest = src.replace(/^<array>\s*/, '');
    const arr = [];
    while (true) {
      rest = rest.trim();
      if (rest.startsWith('</array>')) { rest = rest.slice(8); break; }
      const { value, rest: r2 } = PlistParser._parseValue(rest);
      arr.push(value);
      rest = r2;
    }
    return { value: arr, rest };
  }

  static serialize(obj) {
    const body = PlistParser._serializeValue(obj, 0);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;
  }

  static _serializeValue(v, depth) {
    const pad = '  '.repeat(depth + 1);
    if (v == null) return `${pad}<string></string>`;
    if (typeof v === 'string') {
      const esc = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `${pad}<string>${esc}</string>`;
    }
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return `${pad}<integer>${v}</integer>`;
      return `${pad}<real>${v}</real>`;
    }
    if (typeof v === 'boolean') return `${pad}<${v ? 'true' : 'false'}/>`;
    if (Array.isArray(v)) {
      const inner = v.map(x => PlistParser._serializeValue(x, depth + 1)).join('\n');
      return `${pad}<array>\n${inner}\n${pad}</array>`;
    }
    if (typeof v === 'object') {
      const inner = Object.entries(v).map(([k, val]) => {
        const esc = String(k).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${'  '.repeat(depth + 2)}<key>${esc}</key>\n${PlistParser._serializeValue(val, depth + 1)}`;
      }).join('\n');
      return `${pad}<dict>\n${inner}\n${pad}</dict>`;
    }
    return `${pad}<string>${String(v)}</string>`;
  }
}

/* ------------------------------------------------------------------ *
 * Code signature / provisioning (simulados)
 * ------------------------------------------------------------------ */

class CodeSignature {
  constructor(opts = {}) {
    this.identifier = opts.identifier || null;
    this.teamId = opts.teamId || null;
    this.cdHash = opts.cdHash || uid();
    this.flags = opts.flags || 0;
    this.timestamp = opts.timestamp || now();
    this.entitlements = opts.entitlements || {};
    this.valid = opts.valid !== false;
  }

  verify() {
    // Simulamos verificación: válido si identifier y teamId están presentes
    return this.valid && !!this.identifier && !!this.teamId;
  }
}

class ProvisioningProfile {
  constructor(opts = {}) {
    this.uuid = opts.uuid || uid();
    this.name = opts.name || 'iOS Team Provisioning Profile';
    this.teamId = opts.teamId || null;
    this.teamName = opts.teamName || 'Development Team';
    this.bundleId = opts.bundleId || '*';
    this.creationDate = opts.creationDate || now();
    this.expirationDate = opts.expirationDate || (now() + 365 * 24 * 3600 * 1000);
    this.devices = opts.devices || [];
    this.entitlements = opts.entitlements || {};
    this.provisionsAllDevices = !!opts.provisionsAllDevices;
    this.type = opts.type || 'development';
  }

  isExpired(at = now()) {
    return at > this.expirationDate;
  }

  allowsBundleId(bundleId) {
    if (this.bundleId === '*') return true;
    if (this.bundleId.endsWith('.*')) {
      const prefix = this.bundleId.slice(0, -2);
      return bundleId === prefix || bundleId.startsWith(prefix + '.');
    }
    return bundleId === this.bundleId;
  }

  allowsDevice(udid) {
    if (this.provisionsAllDevices) return true;
    return this.devices.includes(udid);
  }

  allowsEntitlements(ent) {
    for (const [k, v] of Object.entries(ent)) {
      const pv = this.entitlements[k];
      if (pv === undefined) {
        if (k.startsWith('get-task-allow') || k.startsWith('com.apple.developer.')) return false;
        continue;
      }
      if (Array.isArray(v) && Array.isArray(pv)) {
        for (const x of v) if (!pv.includes(x)) return false;
      } else if (v !== pv) {
        return false;
      }
    }
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * AppBundle — modelo de app instalada
 * ------------------------------------------------------------------ */

class AppBundle {
  constructor(info) {
    this.bundleId = info.bundleId;
    this.name = info.name;
    this.displayName = info.displayName || info.name;
    this.version = info.version || '1.0';
    this.build = info.build || '1';
    this.minOS = info.minOS || '17.0';
    this.platform = info.platform || 'iPhoneOS';
    this.executableName = info.executableName;
    this.entitlements = info.entitlements || {};
    this.urlSchemes = info.urlSchemes || [];
    this.documentTypes = info.documentTypes || [];
    this.icons = info.icons || {};
    this.bundlePath = info.bundlePath;
    this.dataPath = info.dataPath;
    this.binarySize = info.binarySize || 0;
    this.totalSize = info.totalSize || 0;
    this.signature = info.signature || null;
    this.provisioning = info.provisioning || null;
    this.installedAt = now();
    this.updatedAt = now();
    this.source = info.source || 'ipa';
    this.installerVersion = '1.0';
    this.state = 'installed';
  }

  toMetadata() {
    return {
      bundleId: this.bundleId,
      name: this.name,
      displayName: this.displayName,
      version: this.version,
      build: this.build,
      minOS: this.minOS,
      platform: this.platform,
      executableName: this.executableName,
      entitlements: this.entitlements,
      urlSchemes: this.urlSchemes,
      documentTypes: this.documentTypes,
      icons: this.icons,
      bundlePath: this.bundlePath,
      dataPath: this.dataPath,
      binarySize: this.binarySize,
      totalSize: this.totalSize,
      teamId: this.signature?.teamId || null,
      provisioningName: this.provisioning?.name || null,
      installedAt: this.installedAt,
      updatedAt: this.updatedAt,
      source: this.source,
      state: this.state,
    };
  }
}

/* ------------------------------------------------------------------ *
 * LaunchServices — registro de apps instaladas
 * ------------------------------------------------------------------ */

class LaunchServices {
  constructor() {
    this.apps = new Map();         // bundleId → AppBundle
    this.urlHandlers = new Map();  // scheme → Set<bundleId>
    this.docHandlers = new Map();  // UTI → Set<bundleId>
  }

  register(app) {
    this.apps.set(app.bundleId, app);
    for (const scheme of app.urlSchemes) {
      if (!this.urlHandlers.has(scheme)) this.urlHandlers.set(scheme, new Set());
      this.urlHandlers.get(scheme).add(app.bundleId);
    }
    for (const dt of app.documentTypes) {
      const uti = dt.LSItemContentTypes?.[0] || dt.CFBundleTypeExtensions?.[0] || dt;
      if (!this.docHandlers.has(uti)) this.docHandlers.set(uti, new Set());
      this.docHandlers.get(uti).add(app.bundleId);
    }
  }

  unregister(bundleId) {
    const app = this.apps.get(bundleId);
    if (!app) return false;
    for (const scheme of app.urlSchemes) {
      this.urlHandlers.get(scheme)?.delete(bundleId);
    }
    for (const dt of app.documentTypes) {
      const uti = dt.LSItemContentTypes?.[0] || dt.CFBundleTypeExtensions?.[0] || dt;
      this.docHandlers.get(uti)?.delete(bundleId);
    }
    return this.apps.delete(bundleId);
  }

  get(bundleId) { return this.apps.get(bundleId) || null; }
  list() { return [...this.apps.values()]; }
  count() { return this.apps.size; }

  findUrlHandler(scheme) {
    const set = this.urlHandlers.get(scheme);
    if (!set || set.size === 0) return null;
    return [...set][0];
  }

  findDocHandler(uti) {
    const set = this.docHandlers.get(uti);
    if (!set || set.size === 0) return null;
    return [...set][0];
  }
}

/* ------------------------------------------------------------------ *
 * Clase principal: IPAInstaller
 * ------------------------------------------------------------------ */

export class IPAInstaller {
  constructor(opts = {}) {
    this.fs = opts.fs || null;
    this.launchServices = opts.launchServices || new LaunchServices();
    this.udid = opts.udid || '00008110-000A1B2C3D4E5F6G';   // device UDID simulado
    this.currentTeamId = opts.teamId || 'ABCDE12345';
    this.currentOSVersion = opts.osVersion || '18.0';
    this.currentPlatform = opts.platform || 'iPhoneOS';

    // Directorios estándar iOS
    this.paths = {
      apps:    opts.appsPath    || '/private/var/containers/Bundle/Application',
      data:    opts.dataPath    || '/private/var/mobile/Containers/Data/Application',
      temp:    opts.tempPath    || '/private/var/tmp/ipa',
    };

    // Políticas
    this.allowDowngrades = opts.allowDowngrades || false;
    this.allowDevSigning = opts.allowDevSigning !== false;
    this.requireProvisioning = opts.requireProvisioning !== false;
    this.verifySignatures = opts.verifySignatures !== false;

    // Estado
    this.installing = new Map();   // id → { state, progress, error }
    this.history = [];

    // Suscriptores
    this.subscribers = new Set();

    // Métricas
    this.stats = {
      attempts: 0,
      installed: 0,
      updated: 0,
      failed: 0,
      uninstalled: 0,
      rolledBack: 0,
      bytesInstalled: 0,
      signatureChecks: 0,
      provisioningChecks: 0,
      entitlementChecks: 0,
      platformChecks: 0,
      minOSChecks: 0,
    };

    Logger.debug(LOG_TAG, 'IPAInstaller instanciado');
  }

  /* ================================================================ *
   * API principal: install
   * ================================================================ */

  install(ipa, opts = {}) {
    this.stats.attempts++;
    const id = uid();
    const ctx = {
      id,
      state: INSTALL_STATE.QUEUED,
      startedAt: now(),
      ipa,
      zip: null,
      bundle: null,
      progress: 0,
      error: null,
      stages: [],
      source: opts.source || 'ipa-file',
      force: !!opts.force,
      replace: opts.replace !== false,
    };
    this.installing.set(id, ctx);
    this._emit('queued', { id });

    try {
      // 1) Extraer
      ctx.state = INSTALL_STATE.EXTRACTING;
      ctx.stages.push('extract');
      const zip = this._extract(ipa);
      ctx.zip = zip;
      ctx.progress = 20;

      // 2) Parsear Info.plist y validar bundle
      ctx.state = INSTALL_STATE.VALIDATING;
      ctx.stages.push('parse-plist');
      const info = this._extractInfoPlist(zip);
      ctx.info = info;
      ctx.progress = 35;

      // 3) Validar plataforma y min OS
      ctx.stages.push('platform-check');
      this._validatePlatform(info);
      ctx.progress = 45;

      // 4) Validar firma
      if (this.verifySignatures) {
        ctx.stages.push('signature');
        this._verifySignature(zip, info);
        this.stats.signatureChecks++;
      }
      ctx.progress = 55;

      // 5) Validar provisioning
      if (this.requireProvisioning) {
        ctx.stages.push('provisioning');
        const prov = this._verifyProvisioning(zip, info);
        ctx.provisioning = prov;
        this.stats.provisioningChecks++;
      }
      ctx.progress = 65;

      // 6) Validar entitlements vs provisioning
      ctx.stages.push('entitlements');
      this._verifyEntitlements(info, ctx.provisioning);
      this.stats.entitlementChecks++;
      ctx.progress = 72;

      // 7) Comprobar duplicados / actualizaciones
      ctx.stages.push('duplicate-check');
      const existing = this.launchServices.get(info.bundleId);
      if (existing && !ctx.replace) {
        throw makeError(INSTALL_ERRORS.DUPLICATE_BUNDLE_ID,
          `ya instalado: ${info.bundleId}`);
      }
      ctx.existing = existing;

      // 8) Espacio
      ctx.stages.push('space-check');
      const totalSize = zip.totalSize();
      this._checkSpace(totalSize);
      ctx.progress = 80;

      // 9) Instalar en FS
      ctx.state = INSTALL_STATE.INSTALLING;
      ctx.stages.push('install-fs');
      const bundle = this._installToFS(zip, info, existing);
      ctx.bundle = bundle;
      ctx.progress = 95;

      // 10) Registrar en LaunchServices
      ctx.stages.push('register');
      this.launchServices.register(bundle);

      // Hecho
      ctx.state = INSTALL_STATE.DONE;
      ctx.finishedAt = now();
      ctx.durationMs = ctx.finishedAt - ctx.startedAt;
      ctx.progress = 100;

      if (existing) this.stats.updated++;
      else this.stats.installed++;
      this.stats.bytesInstalled += bundle.totalSize;

      this.history.push({
        id, bundleId: bundle.bundleId, version: bundle.version,
        state: ctx.state, at: ctx.finishedAt, durationMs: ctx.durationMs,
        action: existing ? 'update' : 'install',
      });

      Logger.info(LOG_TAG,
        `Instalado ${bundle.bundleId} v${bundle.version} ` +
        `(${bytesToHuman(bundle.totalSize)}) en ${ctx.durationMs}ms`
      );
      this._emit('installed', { id, bundle: bundle.toMetadata() });
      return { success: true, bundle };
    } catch (e) {
      ctx.state = INSTALL_STATE.FAILED;
      ctx.error = { code: e.code || INSTALL_ERRORS.GENERIC, message: e.message };
      ctx.finishedAt = now();
      ctx.durationMs = ctx.finishedAt - ctx.startedAt;
      this.stats.failed++;

      // Rollback si ya habíamos tocado FS
      if (ctx.stages.includes('install-fs')) {
        try {
          this._rollback(ctx);
          ctx.state = INSTALL_STATE.ROLLED_BACK;
          this.stats.rolledBack++;
        } catch (re) {
          Logger.error(LOG_TAG, `Rollback falló: ${re.message}`);
        }
      }

      this.history.push({
        id, bundleId: ctx.info?.CFBundleIdentifier || '?',
        state: ctx.state, at: ctx.finishedAt, error: ctx.error,
      });

      Logger.warn(LOG_TAG, `Instalación falló: ${ctx.error.code} — ${ctx.error.message}`);
      this._emit('failed', { id, error: ctx.error });
      return { success: false, error: ctx.error };
    } finally {
      this.installing.delete(id);
    }
  }

  /* ================================================================ *
   * Fase 1: extracción
   * ================================================================ */

  _extract(ipa) {
    // Formatos de entrada:
    // 1) Uint8Array (ZIP real)
    // 2) ZipReader (ya parseado)
    // 3) string de path (leer desde FS)
    // 4) object { name, data }[] (lista de entradas simulada)
    if (ipa instanceof ZipReader) return ipa;
    if (ipa instanceof Uint8Array) return ZipReader.parse(ipa);
    if (Array.isArray(ipa)) return ZipReader.fromEntries(ipa);
    if (typeof ipa === 'string') {
      if (!this.fs) throw makeError(INSTALL_ERRORS.GENERIC, 'sin FS para leer path');
      const bytes = this.fs.readFile(ipa);
      return ZipReader.parse(bytes);
    }
    throw makeError(INSTALL_ERRORS.BAD_ZIP, 'formato de entrada no soportado');
  }

  /* ================================================================ *
   * Fase 2: Info.plist
   * ================================================================ */

  _extractInfoPlist(zip) {
    // Buscamos bajo Payload/*.app/Info.plist
    const payloadKeys = zip.listUnder('Payload/');
    if (payloadKeys.length === 0) {
      throw makeError(INSTALL_ERRORS.NO_PAYLOAD, 'Payload/ no encontrado');
    }
    const appKey = payloadKeys.find(k => k.endsWith('.app/') || /Payload\/[^/]+\.app\/?$/.test(k));
    if (!appKey) throw makeError(INSTALL_ERRORS.NO_APP_BUNDLE, '.app no encontrado en Payload/');

    const appPrefix = appKey.endsWith('/') ? appKey : appKey.replace(/\/?$/, '/');
    const plistKey = appPrefix + 'Info.plist';
    const plistEntry = zip.get(plistKey);
    if (!plistEntry) throw makeError(INSTALL_ERRORS.BAD_INFOPLIST, 'Info.plist no encontrado');

    let plist;
    try {
      plist = PlistParser.parse(plistEntry.data);
    } catch (e) {
      throw makeError(INSTALL_ERRORS.BAD_INFOPLIST, `Info.plist inválido: ${e.message}`);
    }

    // Validar campos mínimos
    if (!plist.CFBundleIdentifier) {
      throw makeError(INSTALL_ERRORS.MISSING_BUNDLE_ID, 'CFBundleIdentifier requerido');
    }
    if (!/^[A-Za-z0-9.\-]+$/.test(plist.CFBundleIdentifier)) {
      throw makeError(INSTALL_ERRORS.BAD_BUNDLE_ID, `bundle id inválido: ${plist.CFBundleIdentifier}`);
    }
    if (!plist.CFBundleExecutable) {
      throw makeError(INSTALL_ERRORS.MISSING_EXECUTABLE, 'CFBundleExecutable requerido');
    }

    plist.__appPrefix = appPrefix;
    plist.__zip = zip;
    return plist;
  }

  /* ================================================================ *
   * Fase 3: plataforma / min OS
   * ================================================================ */

  _validatePlatform(info) {
    this.stats.platformChecks++;
    const platform = info.CFBundleSupportedPlatforms?.[0] || 'iPhoneOS';
    const isSim = info.DTPlatformName === 'iphonesimulator' || platform === 'iPhoneSimulator';
    if (!SUPPORTED_PLATFORMS.has(platform) && !isSim) {
      throw makeError(INSTALL_ERRORS.UNSUPPORTED_PLATFORM,
        `plataforma no soportada: ${platform}`);
    }

    const minOS = info.MinimumOSVersion || info.LSMinimumSystemVersion || info.DTPlatformVersion;
    this.stats.minOSChecks++;
    if (minOS && compareVersion(minOS, this.currentOSVersion) > 0) {
      throw makeError(INSTALL_ERRORS.MIN_OS_TOO_HIGH,
        `requiere iOS ${minOS}, dispositivo en ${this.currentOSVersion}`);
    }

    if (PROTECTED_BUNDLE_IDS.has(info.CFBundleIdentifier)) {
      throw makeError(INSTALL_ERRORS.GENERIC,
        `bundle id protegido: ${info.CFBundleIdentifier}`);
    }
  }

  /* ================================================================ *
   * Fase 4: firma
   * ================================================================ */

  _verifySignature(zip, info) {
    const prefix = info.__appPrefix;
    const sigKey = prefix + '_CodeSignature/CodeResources';
    const hasSig = zip.has(sigKey) || zip.has(prefix + '_CodeSignature/CodeDirectory');

    // Si no hay firma en el ZIP, intentamos derivarla del Info.plist (dev builds)
    if (!hasSig) {
      if (!this.allowDevSigning) {
        throw makeError(INSTALL_ERRORS.BAD_SIGNATURE, 'no hay _CodeSignature');
      }
      Logger.debug(LOG_TAG, 'Sin _CodeSignature — se asume dev signing');
    }

    const sig = new CodeSignature({
      identifier: info.CFBundleIdentifier,
      teamId: this.currentTeamId,
      entitlements: info.Entitlements || {},
      valid: true,
    });
    if (!sig.verify()) {
      throw makeError(INSTALL_ERRORS.BAD_SIGNATURE, 'firma inválida');
    }
    info.__signature = sig;
    return sig;
  }

  /* ================================================================ *
   * Fase 5: provisioning
   * ================================================================ */

  _verifyProvisioning(zip, info) {
    const prefix = info.__appPrefix;
    const provKey = prefix + 'embedded.mobileprovision';
    const entry = zip.get(provKey);
    if (!entry) {
      if (this.allowDevSigning) {
        Logger.debug(LOG_TAG, 'Sin embedded.mobileprovision — se asume dev');
        return new ProvisioningProfile({
          bundleId: info.CFBundleIdentifier,
          teamId: this.currentTeamId,
          provisionsAllDevices: true,
          entitlements: info.Entitlements || {},
        });
      }
      throw makeError(INSTALL_ERRORS.NO_PROVISIONING, 'embedded.mobileprovision ausente');
    }
    // Simulamos parseo — normalmente es un CMS/PKCS#7 firmado, con un plist dentro
    const prov = new ProvisioningProfile({
      bundleId: info.CFBundleIdentifier,
      teamId: this.currentTeamId,
      name: 'iOS Team Provisioning Profile: ' + info.CFBundleIdentifier,
      entitlements: info.Entitlements || {},
    });
    if (prov.isExpired()) {
      throw makeError(INSTALL_ERRORS.EXPIRED_PROVISIONING, 'provisioning profile expirado');
    }
    if (!prov.allowsBundleId(info.CFBundleIdentifier)) {
      throw makeError(INSTALL_ERRORS.ENTITLEMENT_MISMATCH,
        `provisioning no permite ${info.CFBundleIdentifier}`);
    }
    if (!prov.provisionsAllDevices && !prov.allowsDevice(this.udid)) {
      throw makeError(INSTALL_ERRORS.DEVICE_NOT_REGISTERED,
        `device ${this.udid.slice(0, 12)}… no registrado en provisioning`);
    }
    if (prov.teamId !== this.currentTeamId) {
      throw makeError(INSTALL_ERRORS.TEAM_MISMATCH,
        `team ${prov.teamId} ≠ ${this.currentTeamId}`);
    }
    return prov;
  }

  /* ================================================================ *
   * Fase 6: entitlements
   * ================================================================ */

  _verifyEntitlements(info, prov) {
    const ent = info.Entitlements || {};
    if (!prov) return;
    if (!prov.allowsEntitlements(ent)) {
      throw makeError(INSTALL_ERRORS.ENTITLEMENT_MISMATCH,
        'entitlements no permitidos por provisioning');
    }
  }

  /* ================================================================ *
   * Fase 7: espacio
   * ================================================================ */

  _checkSpace(size) {
    if (!this.fs) return;
    // Comprobamos el volumen de datos
    const vol = this.fs.getVolumeStats?.('Data');
    if (vol && vol.freeBytes < size * 1.2) {
      throw makeError(INSTALL_ERRORS.INSUFFICIENT_SPACE,
        `necesario ~${bytesToHuman(size)}, libre ${bytesToHuman(vol.freeBytes)}`);
    }
  }

  /* ================================================================ *
   * Fase 8: instalación en FS
   * ================================================================ */

  _installToFS(zip, info, existing) {
    const bundleId = info.CFBundleIdentifier;
    const appDir = `${this.paths.apps}/${bundleId}`;
    const dataDir = `${this.paths.data}/${bundleId}`;

    // Crear estructura en FS si lo tenemos
    if (this.fs) {
      try { this.fs.mkdirp?.(appDir); } catch {}
      try { this.fs.mkdirp?.(dataDir); } catch {}
    }

    // Si ya existe, limpiamos (update in-place)
    if (existing && this.fs) {
      try { this.fs.rmdir?.(appDir, true); } catch {}
      try { this.fs.mkdirp?.(appDir); } catch {}
    }

    // Escribir Info.plist
    const plistXml = PlistParser.serialize(this._stripInternal(info));
    if (this.fs) {
      try { this.fs.writeFile(`${appDir}/Info.plist`, plistXml); } catch (e) {
        Logger.warn(LOG_TAG, `No se pudo escribir Info.plist: ${e.message}`);
      }
    }

    // Escribir binario Mach-O
    const binKey = info.__appPrefix + info.CFBundleExecutable;
    const binEntry = zip.get(binKey);
    let binarySize = 0;
    if (binEntry) {
      binarySize = binEntry.size;
      if (this.fs) {
        try { this.fs.writeFile(`${appDir}/${info.CFBundleExecutable}`, binEntry.data); } catch (e) {
          Logger.warn(LOG_TAG, `No se pudo escribir binario: ${e.message}`);
        }
      }
    } else {
      throw makeError(INSTALL_ERRORS.MISSING_EXECUTABLE,
        `binario ${info.CFBundleExecutable} no encontrado en bundle`);
    }

    // Copiar recursos (aplanados — en un instalador real se preserva estructura)
    let copiedResources = 0;
    const appPrefix = info.__appPrefix;
    for (const name of zip.list()) {
      if (!name.startsWith(appPrefix)) continue;
      if (name.endsWith('/')) continue;
      if (name === `${appPrefix}Info.plist`) continue;
      if (name === `${appPrefix}${info.CFBundleExecutable}`) continue;
      if (name.includes('_CodeSignature')) continue;
      if (name.endsWith('embedded.mobileprovision')) continue;
      const rel = name.slice(appPrefix.length);
      if (this.fs) {
        const target = `${appDir}/${rel}`;
        const parent = target.slice(0, target.lastIndexOf('/'));
        try { this.fs.mkdirp?.(parent); } catch {}
        const entry = zip.get(name);
        try { this.fs.writeFile(target, entry.data); } catch {}
        copiedResources++;
      }
    }

    // Iconos
    const icons = this._extractIcons(info);

    const totalSize = binarySize + zip.totalSize() * 0.05;   // aproximación

    const bundle = new AppBundle({
      bundleId,
      name: info.CFBundleName || info.CFBundleDisplayName || info.CFBundleExecutable,
      displayName: info.CFBundleDisplayName || info.CFBundleName || info.CFBundleExecutable,
      version: info.CFBundleShortVersionString || '1.0',
      build: info.CFBundleVersion || '1',
      minOS: info.MinimumOSVersion || info.LSMinimumSystemVersion || '17.0',
      platform: 'iPhoneOS',
      executableName: info.CFBundleExecutable,
      entitlements: info.Entitlements || {},
      urlSchemes: (info.CFBundleURLTypes || []).map(t => (t.CFBundleURLSchemes || [])[0]).filter(Boolean),
      documentTypes: info.CFBundleDocumentTypes || [],
      icons,
      bundlePath: appDir,
      dataPath: dataDir,
      binarySize,
      totalSize,
      signature: info.__signature,
      provisioning: existing?.provisioning || new ProvisioningProfile({ bundleId }),
      source: 'ipa',
    });

    // Guardar metadatos del bundle
    if (this.fs) {
      try {
        this.fs.writeFile(`${appDir}/.installed.json`, JSON.stringify(bundle.toMetadata()));
      } catch {}
    }

    Logger.debug(LOG_TAG,
      `Bundle escrito: ${bundle.bundleId} → ${appDir} (${bytesToHuman(binarySize)} binario, ${copiedResources} recursos)`
    );
    return bundle;
  }

  _stripInternal(info) {
    const out = {};
    for (const [k, v] of Object.entries(info)) {
      if (k.startsWith('__')) continue;
      out[k] = v;
    }
    return out;
  }

  _extractIcons(info) {
    const icons = {};
    const bundleIcons = info.CFBundleIcons || {};
    if (bundleIcons.CFBundlePrimaryIcon) {
      icons.primary = bundleIcons.CFBundlePrimaryIcon.CFBundleIconName || 'AppIcon';
    }
    const iphone = bundleIcons.CFBundlePrimaryIcon?.CFBundleIconFiles || [];
    if (iphone.length) icons.files = iphone;
    icons.assetName = info.CFBundleIconName || icons.primary || 'AppIcon';
    return icons;
  }

  /* ================================================================ *
   * Rollback
   * ================================================================ */

  _rollback(ctx) {
    if (!this.fs || !ctx.info) return;
    const appDir = `${this.paths.apps}/${ctx.info.CFBundleIdentifier}`;
    try { this.fs.rmdir?.(appDir, true); } catch (e) {
      Logger.warn(LOG_TAG, `Rollback: ${e.message}`);
    }
  }

  /* ================================================================ *
   * Uninstall
   * ================================================================ */

  uninstall(bundleId, opts = {}) {
    const app = this.launchServices.get(bundleId);
    if (!app) {
      Logger.warn(LOG_TAG, `uninstall: ${bundleId} no instalada`);
      return { success: false, error: { code: INSTALL_ERRORS.GENERIC, message: 'no instalada' } };
    }
    const keepData = !!opts.keepData;

    try {
      if (this.fs) {
        try { this.fs.rmdir?.(app.bundlePath, true); } catch {}
        if (!keepData) {
          try { this.fs.rmdir?.(app.dataPath, true); } catch {}
        }
      }
      this.launchServices.unregister(bundleId);
      this.stats.uninstalled++;

      this.history.push({
        id: uid(), bundleId, state: 'uninstalled', at: now(), action: 'uninstall',
      });
      Logger.info(LOG_TAG, `Desinstalado ${bundleId}${keepData ? ' (datos preservados)' : ''}`);
      this._emit('uninstalled', { bundleId, keepData });
      return { success: true };
    } catch (e) {
      Logger.error(LOG_TAG, `uninstall falló: ${e.message}`);
      return { success: false, error: { code: INSTALL_ERRORS.GENERIC, message: e.message } };
    }
  }

  /* ================================================================ *
   * Update
   * ================================================================ */

  update(bundleId, newIpa) {
    const existing = this.launchServices.get(bundleId);
    if (!existing) {
      Logger.warn(LOG_TAG, `update: ${bundleId} no instalada`);
      return { success: false, error: { code: INSTALL_ERRORS.GENERIC, message: 'no instalada' } };
    }
    return this.install(newIpa, { replace: true, source: 'update' });
  }

  /* ================================================================ *
   * Consultas
   * ================================================================ */

  getApp(bundleId) { return this.launchServices.get(bundleId); }

  listApps() {
    return this.launchServices.list().map(a => a.toMetadata());
  }

  isInstalled(bundleId) { return !!this.launchServices.get(bundleId); }

  getAppDataPath(bundleId) {
    const app = this.launchServices.get(bundleId);
    return app ? app.dataPath : null;
  }

  getAppBundlePath(bundleId) {
    const app = this.launchServices.get(bundleId);
    return app ? app.bundlePath : null;
  }

  /* ================================================================ *
   * Compatibilidad y validación standalone
   * ================================================================ */

  validate(ipa) {
    try {
      const zip = this._extract(ipa);
      const info = this._extractInfoPlist(zip);
      this._validatePlatform(info);
      if (this.verifySignatures) this._verifySignature(zip, info);
      return {
        valid: true,
        bundleId: info.CFBundleIdentifier,
        name: info.CFBundleName || info.CFBundleDisplayName,
        version: info.CFBundleShortVersionString || '1.0',
        build: info.CFBundleVersion || '1',
        minOS: info.MinimumOSVersion || info.LSMinimumSystemVersion,
        entries: zip.count(),
        size: zip.totalSize(),
      };
    } catch (e) {
      return { valid: false, error: { code: e.code || INSTALL_ERRORS.GENERIC, message: e.message } };
    }
  }

  /* ================================================================ *
   * Utilidades para construir IPAs (test/demo)
   * ================================================================ */

  createTestIPA(opts = {}) {
    const bundleId = opts.bundleId || 'com.example.testapp';
    const appName = opts.appName || 'TestApp';
    const version = opts.version || '1.0';
    const build = opts.build || '1';
    const minOS = opts.minOS || '17.0';
    const executable = opts.executable || appName;
    const binaryData = opts.binaryData || new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

    const info = {
      CFBundleIdentifier: bundleId,
      CFBundleName: appName,
      CFBundleDisplayName: opts.displayName || appName,
      CFBundleExecutable: executable,
      CFBundleVersion: build,
      CFBundleShortVersionString: version,
      CFBundlePackageType: 'APPL',
      MinimumOSVersion: minOS,
      CFBundleSupportedPlatforms: ['iPhoneOS'],
      DTPlatformName: 'iphoneos',
      DTPlatformVersion: minOS,
      UIDeviceFamily: [1, 2],
      UILaunchScreen: {},
      CFBundleURLTypes: opts.urlSchemes ? [{ CFBundleURLSchemes: opts.urlSchemes }] : [],
      Entitlements: opts.entitlements || { 'get-task-allow': true },
    };

    const prefix = `Payload/${appName}.app/`;
    const entries = [
      { name: `${prefix}Info.plist`, data: new TextEncoder().encode(PlistParser.serialize(info)) },
      { name: `${prefix}${executable}`, data: binaryData },
      { name: `${prefix}_CodeSignature/CodeResources`, data: new Uint8Array([0x3c, 0x3f, 0x78]) },
      { name: `${prefix}embedded.mobileprovision`, data: new Uint8Array([0x30, 0x82]) },
    ];

    if (opts.extraFiles) {
      for (const [name, data] of Object.entries(opts.extraFiles)) {
        entries.push({ name: prefix + name, data: typeof data === 'string' ? new TextEncoder().encode(data) : data });
      }
    }

    return ZipReader.write(entries);
  }

  /* ================================================================ *
   * Suscriptores
   * ================================================================ */

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.subscribers) {
      try { fn({ type, payload, ts: now() }); }
      catch (e) { Logger.error(LOG_TAG, `Subscriber error: ${e.message}`); }
    }
  }

  /* ================================================================ *
   * Estadísticas / diagnóstico
   * ================================================================ */

  getStats() {
    return {
      ...this.stats,
      installedApps: this.launchServices.count(),
      historySize: this.history.length,
      currentTeamId: this.currentTeamId,
      deviceUDID: this.udid.slice(0, 12) + '…',
      osVersion: this.currentOSVersion,
      paths: { ...this.paths },
    };
  }

  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  dump() {
    const s = this.getStats();
    Logger.kernel(LOG_TAG, '─── IPAInstaller dump ───');
    Logger.kernel(LOG_TAG, `  team         : ${s.currentTeamId}`);
    Logger.kernel(LOG_TAG, `  device UDID  : ${s.deviceUDID}`);
    Logger.kernel(LOG_TAG, `  iOS          : ${s.osVersion}`);
    Logger.kernel(LOG_TAG, `  apps         : ${s.installedApps}`);
    Logger.kernel(LOG_TAG, `  intentos     : ${s.attempts}`);
    Logger.kernel(LOG_TAG, `  instaladas   : ${s.installed}`);
    Logger.kernel(LOG_TAG, `  actualizadas : ${s.updated}`);
    Logger.kernel(LOG_TAG, `  fallidas     : ${s.failed}`);
    Logger.kernel(LOG_TAG, `  rollbacks    : ${s.rolledBack}`);
    Logger.kernel(LOG_TAG, `  uninstalls   : ${s.uninstalled}`);
    Logger.kernel(LOG_TAG, `  bytes        : ${bytesToHuman(s.bytesInstalled)}`);
    Logger.kernel(LOG_TAG, `  checks: sig=${s.signatureChecks} prov=${s.provisioningChecks} ent=${s.entitlementChecks} plat=${s.platformChecks} os=${s.minOSChecks}`);
    Logger.kernel(LOG_TAG, `  apps instaladas:`);
    for (const app of this.launchServices.list()) {
      Logger.kernel(LOG_TAG, `    · ${app.bundleId.padEnd(34)} v${app.version} (${bytesToHuman(app.totalSize)})`);
    }
  }
}

export { ZipReader, ZipEntry, PlistParser, CodeSignature, ProvisioningProfile, AppBundle, LaunchServices };

export default IPAInstaller;
