// src/system/Keychain.js
// Keychain virtual — almacén cifrado de secretos.
// - Item classes: generic-password, internet-password, certificate, key, identity
// - Accessibility: when-unlocked, after-first-unlock, always, when-passcode-set, ...
// - Secure Enclave simulado con claves por hardware
// - Control de acceso biométrico (Face ID / Touch ID)
// - Grupos de acceso (kSecAttrAccessGroup) + control de acceso por bundleId
// - Bloqueo por intentos fallidos + expiración + rate limiting
// - Cifrado AES-GCM simulado por item (derivación de clave vía HKDF-sim)
// - Sincronización iCloud (opt-in por item)
// - Integración con FileSystem para persistencia (opcional)

import { Logger } from './Logger.js';

const LOG_TAG = 'KEYCHAIN';

/* ------------------------------------------------------------------ *
 * Constantes (mapeo de Security.framework)
 * ------------------------------------------------------------------ */

export const ITEM_CLASS = {
  GENERIC_PASSWORD:  'genp',
  INTERNET_PASSWORD: 'inet',
  CERTIFICATE:       'cert',
  KEY:               'keys',
  IDENTITY:          'idnt',
};

export const ACCESSIBILITY = {
  WHEN_UNLOCKED:                    'when-unlocked',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY:   'when-unlocked-this-device-only',
  AFTER_FIRST_UNLOCK:               'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  ALWAYS:                           'always',
  ALWAYS_THIS_DEVICE_ONLY:          'always-this-device-only',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'when-passcode-set-this-device-only',
};

// Restricciones por clase de accesibilidad
const ACCESSIBILITY_RULES = {
  [ACCESSIBILITY.WHEN_UNLOCKED]:                    { needUnlock: true,  needPasscode: false, migratable: true,  biometric: false },
  [ACCESSIBILITY.WHEN_UNLOCKED_THIS_DEVICE_ONLY]:   { needUnlock: true,  needPasscode: false, migratable: false, biometric: false },
  [ACCESSIBILITY.AFTER_FIRST_UNLOCK]:               { needUnlock: false, needPasscode: true,  migratable: true,  biometric: false },
  [ACCESSIBILITY.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY]: { needUnlock: false, needPasscode: true, migratable: false, biometric: false },
  [ACCESSIBILITY.ALWAYS]:                           { needUnlock: false, needPasscode: false, migratable: true,  biometric: false },
  [ACCESSIBILITY.ALWAYS_THIS_DEVICE_ONLY]:          { needUnlock: false, needPasscode: false, migratable: false, biometric: false },
  [ACCESSIBILITY.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY]: { needUnlock: true, needPasscode: true, migratable: false, biometric: false },
};

// Clases de autenticación biométrica
export const BIOMETRY = {
  NONE:      'none',
  FACE_ID:   'face-id',
  TOUCH_ID:  'touch-id',
  OPTIC_ID:  'optic-id',
  PASSCODE:  'passcode',
};

// Políticas de control de acceso (kSecAccessControl*)
export const ACCESS_CONTROL = {
  NONE:                         0x0000,
  USER_PRESENCE:                0x0001,
  BIOMETRY_ANY:                 0x0002,
  BIOMETRY_CURRENT_SET:         0x0004,
  DEVICE_PASSCODE:              0x0008,
  OR:                           0x4000,
  AND:                          0x8000,
  PRIVATE_KEY_USAGE:            0x10000,
  APPLICATION_PASSWORD:         0x20000,
};

// Tipos de cifrado del item
export const ENCRYPTION = {
  NONE:       'none',
  AES_128:    'aes-128',
  AES_256:    'aes-256',
  SECURE_ENCLAVE: 'secure-enclave',
};

// Errores
export const KC_ERRORS = {
  ITEM_NOT_FOUND:       'errSecItemNotFound',
  DUPLICATE_ITEM:       'errSecDuplicateItem',
  AUTH_FAILED:          'errSecAuthFailed',
  USER_CANCELED:        'errSecUserCanceled',
  INTERACTION_NOT_ALLOWED: 'errSecInteractionNotAllowed',
  MISSING_ENTITLEMENT:  'errSecMissingEntitlement',
  DECODE:               'errSecDecode',
  INVALID_PARAMETER:    'errSecInvalidParameter',
  NOT_AVAILABLE:        'errSecNotAvailable',
  LOCKED:               'errSecLocked',
  RATE_LIMITED:         'errSecRateLimited',
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now() { return Date.now(); }
function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }

// Hash simple (FNV-1a 64) — usado para persistencia e integridad
function fnv1a(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Derivación HKDF-sim: HMAC-like usando FNV repetido
function deriveKey(master, info, length = 32) {
  let out = '';
  let counter = 0;
  while (out.length < length * 2) {
    const block = fnv1a(master + ':' + info + ':' + counter);
    out += block;
    counter++;
  }
  return out.slice(0, length * 2);
}

// Cifrado simulado (XOR stream + hash de autenticación)
// NO es criptografía real — solo para simular el flujo del Keychain.
function encryptSim(plaintext, keyHex) {
  const pt = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext;
  const ct = new Uint8Array(pt.length);
  const keyBytes = new Uint8Array(keyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  for (let i = 0; i < pt.length; i++) {
    ct[i] = pt[i] ^ keyBytes[i % keyBytes.length];
  }
  // Tag de autenticación simulado
  const tag = fnv1a(keyHex + Array.from(ct).join(','));
  return { ct, tag };
}

function decryptSim(ct, keyHex, expectedTag) {
  const tag = fnv1a(keyHex + Array.from(ct).join(','));
  if (tag !== expectedTag) throw Object.assign(new Error('auth tag mismatch'), { code: KC_ERRORS.DECODE });
  const pt = new Uint8Array(ct.length);
  const keyBytes = new Uint8Array(keyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  for (let i = 0; i < ct.length; i++) {
    pt[i] = ct[i] ^ keyBytes[i % keyBytes.length];
  }
  return pt;
}

/* ------------------------------------------------------------------ *
 * Secure Enclave simulado
 * ------------------------------------------------------------------ */

class SecureEnclave {
  constructor() {
    this.uid = uid();
    this.keys = new Map();     // keyId → { algorithm, createdAt, usage }
    this.unlocked = false;
    this.biometry = BIOMETRY.NONE;
    this.passcodeSet = false;
    this.locked = true;
    this.failedAttempts = 0;
    this.lockoutUntil = 0;
    this.stats = {
      keyGenerated: 0,
      keyDeleted: 0,
      signOps: 0,
      verifyOps: 0,
      unwrapOps: 0,
      biometricAuths: 0,
      biometricFails: 0,
      unlockEvents: 0,
    };
  }

  setPasscode(set) {
    this.passcodeSet = !!set;
  }

  setBiometry(type) {
    this.biometry = type;
  }

  unlock(method = BIOMETRY.PASSCODE) {
    if (now() < this.lockoutUntil) {
      const wait = Math.ceil((this.lockoutUntil - now()) / 1000);
      throw Object.assign(new Error(`locked for ${wait}s`), { code: KC_ERRORS.LOCKED });
    }
    if (method === BIOMETRY.NONE) {
      // Sin passcode ni biometría — solo se desbloquea si no hay protección
      if (!this.passcodeSet) {
        this.unlocked = true;
        this.locked = false;
        this.stats.unlockEvents++;
        return true;
      }
      throw Object.assign(new Error('no method'), { code: KC_ERRORS.NOT_AVAILABLE });
    }

    // Simulamos éxito 98% para biometría, 100% passcode
    const success = method === BIOMETRY.PASSCODE
      ? true
      : Math.random() < 0.98;

    if (success) {
      this.unlocked = true;
      this.locked = false;
      this.failedAttempts = 0;
      this.stats.unlockEvents++;
      if (method !== BIOMETRY.PASSCODE) this.stats.biometricAuths++;
      return true;
    } else {
      this.failedAttempts++;
      this.stats.biometricFails++;
      if (this.failedAttempts >= 5) {
        this.lockoutUntil = now() + 60_000;
      }
      throw Object.assign(new Error('auth failed'), { code: KC_ERRORS.AUTH_FAILED });
    }
  }

  lock() {
    this.unlocked = false;
    this.locked = true;
    Logger.debug(LOG_TAG, 'Secure Enclave bloqueada');
  }

  generateKey(algorithm = 'P-256', usage = 'sign') {
    const keyId = 'se-' + uid();
    this.keys.set(keyId, {
      id: keyId,
      algorithm,
      usage,
      createdAt: now(),
      bytes: uid() + uid(),  // material simulado
    });
    this.stats.keyGenerated++;
    Logger.debug(LOG_TAG, `Secure Enclave: clave ${algorithm} generada (${keyId.slice(0, 12)}…)`);
    return keyId;
  }

  deleteKey(keyId) {
    if (this.keys.delete(keyId)) {
      this.stats.keyDeleted++;
      return true;
    }
    return false;
  }

  hasKey(keyId) { return this.keys.has(keyId); }

  getKey(keyId) { return this.keys.get(keyId) || null; }

  sign(keyId, data) {
    if (!this.unlocked) throw Object.assign(new Error('locked'), { code: KC_ERRORS.LOCKED });
    const key = this.keys.get(keyId);
    if (!key) throw Object.assign(new Error('no key'), { code: KC_ERRORS.ITEM_NOT_FOUND });
    this.stats.signOps++;
    return fnv1a(key.bytes + ':' + data);
  }

  verify(keyId, data, signature) {
    const key = this.keys.get(keyId);
    if (!key) return false;
    this.stats.verifyOps++;
    return this.sign(keyId, data) === signature;
  }
}

/* ------------------------------------------------------------------ *
 * Item del keychain
 * ------------------------------------------------------------------ */

let _nextItemId = 1;

class KeychainItem {
  constructor(opts) {
    this.id = 'kci-' + (_nextItemId++);
    this.itemClass = opts.itemClass || ITEM_CLASS.GENERIC_PASSWORD;
    this.service = opts.service || null;
    this.account = opts.account || null;
    this.accessGroup = opts.accessGroup || null;
    this.creatorBundleId = opts.creatorBundleId || null;

    // Datos cifrados
    this.encryptedData = null;   // Uint8Array
    this.authTag = null;
    this.dataType = opts.dataType || 'utf8';   // 'utf8' | 'binary'

    // Metadatos
    this.label = opts.label || '';
    this.description = opts.description || '';
    this.comment = opts.comment || '';
    this.creationDate = now();
    this.modificationDate = now();
    this.creationBundleId = opts.creatorBundleId;

    // Accesibilidad y control
    this.accessibility = opts.accessibility || ACCESSIBILITY.WHEN_UNLOCKED;
    this.accessControl = opts.accessControl ?? ACCESS_CONTROL.NONE;
    this.encryption = opts.encryption || ENCRYPTION.AES_256;
    this.synchronizable = !!opts.synchronizable;   // iCloud
    this.secureEnclaveKeyId = opts.secureEnclaveKeyId || null;

    // Internet password
    this.server = opts.server || null;
    this.protocol = opts.protocol || null;
    this.port = opts.port || null;
    this.path = opts.path || null;
    this.authenticationType = opts.authenticationType || null;

    // Ciclo de vida
    this.expiresAt = opts.expiresAt || null;
    this.accessedAt = null;
    this.accessCount = 0;
    this.lastFailedAuth = null;
  }

  isExpired() {
    return this.expiresAt != null && now() > this.expiresAt;
  }

  matches(query) {
    if (query.itemClass && query.itemClass !== this.itemClass) return false;
    if (query.service && query.service !== this.service) return false;
    if (query.account && query.account !== this.account) return false;
    if (query.accessGroup && query.accessGroup !== this.accessGroup) return false;
    if (query.server && query.server !== this.server) return false;
    if (query.label && query.label !== this.label) return false;
    if (query.creatorBundleId && query.creatorBundleId !== this.creatorBundleId) return false;
    return true;
  }

  toMetadata() {
    return {
      id: this.id,
      itemClass: this.itemClass,
      service: this.service,
      account: this.account,
      accessGroup: this.accessGroup,
      label: this.label,
      description: this.description,
      comment: this.comment,
      accessibility: this.accessibility,
      accessControl: this.accessControl,
      encryption: this.encryption,
      synchronizable: this.synchronizable,
      secureEnclaveKeyId: this.secureEnclaveKeyId,
      server: this.server,
      port: this.port,
      path: this.path,
      createdAt: this.creationDate,
      modifiedAt: this.modificationDate,
      expiresAt: this.expiresAt,
      accessCount: this.accessCount,
      lastAccess: this.accessedAt,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Control de acceso por bundleId
 * ------------------------------------------------------------------ */

class AccessControlList {
  constructor() {
    // bundleId → { groups: Set<string>, services: Set<string> }
    this.rules = new Map();
  }

  registerApp(bundleId, { groups = [], services = [] } = {}) {
    this.rules.set(bundleId, {
      groups: new Set(groups),
      services: new Set(services),
    });
  }

  canAccess(bundleId, item) {
    if (!bundleId) return false;
    const rule = this.rules.get(bundleId);
    if (!rule) return false;

    // Sin access group: el creador siempre puede acceder
    if (!item.accessGroup) {
      return item.creatorBundleId === bundleId;
    }
    // Con access group: hay que estar en el grupo
    if (!rule.groups.has(item.accessGroup)) return false;

    // Restricción opcional por servicio
    if (item.service && rule.services.size > 0 && !rule.services.has(item.service)) {
      return false;
    }
    return true;
  }

  listRules() {
    return [...this.rules.entries()].map(([b, r]) => ({
      bundleId: b,
      groups: [...r.groups],
      services: [...r.services],
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Clase principal: Keychain
 * ------------------------------------------------------------------ */

export class Keychain {
  constructor(options = {}) {
    this.enclave = new SecureEnclave();
    this.acl = new AccessControlList();
    this.items = new Map();       // id → KeychainItem
    this.index = new Map();       // service:account → id (para búsquedas rápidas)

    // Master key (se rota con cada unlock simulado del dispositivo)
    this.masterKey = uid() + uid();
    this.rotationCounter = 0;

    // Estado del keychain
    this.locked = true;
    this.currentBundleId = null;

    // Política de rate limiting
    this.rateLimitWindowMs = 60_000;
    this.maxOpsPerWindow = 500;
    this.opsInWindow = 0;
    this.windowStart = now();

    // Persistencia
    this.fs = options.fs || null;
    this.persistencePath = options.persistencePath || '/private/var/mobile/Library/Keychains/keychain.json';

    // Suscriptores
    this.subscribers = new Set();

    // Métricas
    this.stats = {
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsDeleted: 0,
      queries: 0,
      reads: 0,
      readFails: 0,
      authFailures: 0,
      iCloudSyncs: 0,
      rotations: 0,
      persistenceSaves: 0,
      persistenceLoads: 0,
    };

    // Cargar desde FS si hay
    if (this.fs) this._tryLoad();

    Logger.debug(LOG_TAG, 'Keychain virtual instanciado');
  }

  /* ================================================================ *
   * Ciclo de vida
   * ================================================================ */

  setPasscode(set) {
    this.enclave.setPasscode(set);
    this._emit('passcode', { set: !!set });
  }

  setBiometry(type) {
    this.enclave.setBiometry(type);
    this._emit('biometry', { type });
  }

  unlock(method = BIOMETRY.PASSCODE) {
    const ok = this.enclave.unlock(method);
    this.locked = false;
    // Rotar master key en cada unlock
    this.masterKey = uid() + uid();
    this.rotationCounter++;
    this.stats.rotations++;
    Logger.info(LOG_TAG, `Keychain desbloqueado (${method}) — master key rotada #${this.rotationCounter}`);
    this._emit('unlock', { method });
    return ok;
  }

  lock() {
    this.enclave.lock();
    this.locked = true;
    Logger.info(LOG_TAG, 'Keychain bloqueado');
    this._emit('lock', {});
  }

  /* ================================================================ *
   * Control de acceso por bundleId
   * ================================================================ */

  registerApp(bundleId, opts) {
    this.acl.registerApp(bundleId, opts);
    Logger.debug(LOG_TAG, `App registrada: ${bundleId} (groups=${(opts?.groups || []).join(',')})`);
  }

  setCurrentApp(bundleId) {
    this.currentBundleId = bundleId;
  }

  /* ================================================================ *
   * Rate limiting
   * ================================================================ */

  _checkRateLimit() {
    const n = now();
    if (n - this.windowStart > this.rateLimitWindowMs) {
      this.windowStart = n;
      this.opsInWindow = 0;
    }
    this.opsInWindow++;
    if (this.opsInWindow > this.maxOpsPerWindow) {
      throw Object.assign(new Error('rate limit'), { code: KC_ERRORS.RATE_LIMITED });
    }
  }

  /* ================================================================ *
   * Cifrado por item
   * ================================================================ */

  _keyFor(item) {
    const base = this.masterKey + ':' + (item.accessGroup || 'default') + ':' + item.itemClass;
    return deriveKey(base, item.id, 32);
  }

  _encryptForItem(item, plaintext) {
    if (item.encryption === ENCRYPTION.NONE) {
      return { ct: new TextEncoder().encode(plaintext), tag: null };
    }
    if (item.encryption === ENCRYPTION.SECURE_ENCLAVE && item.secureEnclaveKeyId) {
      // En este caso, el cifrado usa la clave del Secure Enclave (simulado igual)
      if (!this.enclave.hasKey(item.secureEnclaveKeyId)) {
        throw Object.assign(new Error('SE key missing'), { code: KC_ERRORS.NOT_AVAILABLE });
      }
    }
    const key = this._keyFor(item);
    return encryptSim(plaintext, key);
  }

  _decryptForItem(item) {
    if (!item.encryptedData) return '';
    if (item.encryption === ENCRYPTION.NONE) {
      return new TextDecoder().decode(item.encryptedData);
    }
    const key = this._keyFor(item);
    const pt = decryptSim(item.encryptedData, key, item.authTag);
    return new TextDecoder().decode(pt);
  }

  /* ================================================================ *
   * Verificación de acceso
   * ================================================================ */

  _checkAccess(item, op = 'read') {
    // 1) FSM: si el item requiere desbloqueo
    const rules = ACCESSIBILITY_RULES[item.accessibility] || {};
    if (rules.needUnlock && this.locked) {
      throw Object.assign(new Error('locked'), { code: KC_ERRORS.INTERACTION_NOT_ALLOWED });
    }
    if (rules.needPasscode && !this.enclave.passcodeSet) {
      throw Object.assign(new Error('no passcode set'), { code: KC_ERRORS.INTERACTION_NOT_ALLOWED });
    }

    // 2) ACL: por bundleId
    if (this.currentBundleId) {
      if (!this.acl.canAccess(this.currentBundleId, item)) {
        throw Object.assign(new Error('missing entitlement'), { code: KC_ERRORS.MISSING_ENTITLEMENT });
      }
    }

    // 3) Control de acceso biométrico
    if (item.accessControl & ACCESS_CONTROL.BIOMETRY_ANY) {
      if (this.enclave.biometry === BIOMETRY.NONE) {
        throw Object.assign(new Error('no biometry'), { code: KC_ERRORS.NOT_AVAILABLE });
      }
      // Simulamos éxito biométrico 98%
      if (Math.random() >= 0.98) {
        this.stats.authFailures++;
        throw Object.assign(new Error('biometric auth failed'), { code: KC_ERRORS.AUTH_FAILED });
      }
    }
    if (item.accessControl & ACCESS_CONTROL.USER_PRESENCE) {
      // Requiere que el dispositivo esté desbloqueado y con algún método de auth disponible
      if (this.locked) {
        throw Object.assign(new Error('user presence required'), { code: KC_ERRORS.INTERACTION_NOT_ALLOWED });
      }
    }

    return true;
  }

  /* ================================================================ *
   * API principal: add / update / delete / query
   * ================================================================ */

  add(opts) {
    this._checkRateLimit();
    if (!opts.itemClass) {
      throw Object.assign(new Error('itemClass required'), { code: KC_ERRORS.INVALID_PARAMETER });
    }
    if (!opts.data && opts.data !== '') {
      throw Object.assign(new Error('data required'), { code: KC_ERRORS.INVALID_PARAMETER });
    }

    const item = new KeychainItem({
      ...opts,
      creatorBundleId: opts.creatorBundleId || this.currentBundleId,
    });

    // Duplicado por (class, service, account)
    const key = `${item.itemClass}:${item.service}:${item.account}`;
    if (this.index.has(key)) {
      throw Object.assign(new Error('duplicate item'), { code: KC_ERRORS.DUPLICATE_ITEM });
    }

    // Cifrado
    const { ct, tag } = this._encryptForItem(item, opts.data);
    item.encryptedData = ct;
    item.authTag = tag;

    // Si es Secure Enclave, generamos clave
    if (item.encryption === ENCRYPTION.SECURE_ENCLAVE && !item.secureEnclaveKeyId) {
      item.secureEnclaveKeyId = this.enclave.generateKey('P-256', 'decrypt');
    }

    this.items.set(item.id, item);
    this.index.set(key, item.id);
    this.stats.itemsAdded++;

    Logger.debug(LOG_TAG, `Item añadido: ${item.itemClass}/${item.service}/${item.account} (${item.id})`);
    this._emit('add', item.toMetadata());
    if (item.synchronizable) this._syncToICloud(item);
    this._maybePersist();
    return item.id;
  }

  update(itemId, newData, opts = {}) {
    this._checkRateLimit();
    const item = this.items.get(itemId);
    if (!item) throw Object.assign(new Error('not found'), { code: KC_ERRORS.ITEM_NOT_FOUND });

    this._checkAccess(item, 'update');

    const { ct, tag } = this._encryptForItem(item, newData);
    item.encryptedData = ct;
    item.authTag = tag;
    item.modificationDate = now();
    if (opts.label != null) item.label = opts.label;
    if (opts.description != null) item.description = opts.description;
    if (opts.comment != null) item.comment = opts.comment;
    if (opts.accessibility != null) item.accessibility = opts.accessibility;
    if (opts.accessControl != null) item.accessControl = opts.accessControl;

    this.stats.itemsUpdated++;
    this._emit('update', item.toMetadata());
    if (item.synchronizable) this._syncToICloud(item);
    this._maybePersist();
    return true;
  }

  updateByQuery(query, newData, opts = {}) {
    const found = this.query(query);
    if (!found.length) throw Object.assign(new Error('not found'), { code: KC_ERRORS.ITEM_NOT_FOUND });
    for (const meta of found) this.update(meta.id, newData, opts);
    return found.length;
  }

  delete(itemId) {
    this._checkRateLimit();
    const item = this.items.get(itemId);
    if (!item) throw Object.assign(new Error('not found'), { code: KC_ERRORS.ITEM_NOT_FOUND });

    this._checkAccess(item, 'delete');

    const key = `${item.itemClass}:${item.service}:${item.account}`;
    this.index.delete(key);
    this.items.delete(itemId);
    if (item.secureEnclaveKeyId) this.enclave.deleteKey(item.secureEnclaveKeyId);

    this.stats.itemsDeleted++;
    this._emit('delete', { id: itemId });
    this._maybePersist();
    return true;
  }

  deleteByQuery(query) {
    const found = this.query(query);
    for (const meta of found) this.delete(meta.id);
    return found.length;
  }

  /* ================================================================ *
   * Consulta
   * ================================================================ */

  query(query = {}) {
    this._checkRateLimit();
    this.stats.queries++;
    const out = [];
    for (const item of this.items.values()) {
      if (item.isExpired()) continue;
      if (!item.matches(query)) continue;
      if (this.currentBundleId && !this.acl.canAccess(this.currentBundleId, item)) continue;
      out.push(item.toMetadata());
    }
    return out;
  }

  getData(itemId, opts = {}) {
    this._checkRateLimit();
    const item = this.items.get(itemId);
    if (!item) throw Object.assign(new Error('not found'), { code: KC_ERRORS.ITEM_NOT_FOUND });
    if (item.isExpired()) throw Object.assign(new Error('expired'), { code: KC_ERRORS.ITEM_NOT_FOUND });

    try {
      this._checkAccess(item, 'read');
    } catch (e) {
      this.stats.readFails++;
      item.lastFailedAuth = now();
      throw e;
    }

    const data = this._decryptForItem(item);
    item.accessedAt = now();
    item.accessCount++;
    this.stats.reads++;
    this._emit('read', { id: itemId, count: item.accessCount });
    return data;
  }

  getDataByQuery(query, opts = {}) {
    const found = this.query(query);
    if (!found.length) throw Object.assign(new Error('not found'), { code: KC_ERRORS.ITEM_NOT_FOUND });
    return this.getData(found[0].id, opts);
  }

  /* ================================================================ *
   * iCloud (simulado)
   * ================================================================ */

  _syncToICloud(item) {
    this.stats.iCloudSyncs++;
    Logger.debug(LOG_TAG, `Item ${item.id} sincronizado a iCloud (sincronizable=${item.synchronizable})`);
  }

  /* ================================================================ *
   * Persistencia
   * ================================================================ */

  _maybePersist() {
    if (!this.fs) return;
    try {
      this.save();
    } catch (e) {
      Logger.warn(LOG_TAG, `Persistencia falló: ${e.message}`);
    }
  }

  save() {
    if (!this.fs) return false;
    const payload = {
      version: 1,
      savedAt: now(),
      items: [],
    };
    for (const item of this.items.values()) {
      payload.items.push({
        ...item.toMetadata(),
        encryptedData: Array.from(item.encryptedData || []),
        authTag: item.authTag,
        dataType: item.dataType,
        creationBundleId: item.creationBundleId,
      });
    }
    try {
      this.fs.writeFile(this.persistencePath, JSON.stringify(payload));
      this.stats.persistenceSaves++;
      return true;
    } catch (e) {
      Logger.warn(LOG_TAG, `No se pudo escribir keychain: ${e.message}`);
      return false;
    }
  }

  load() {
    if (!this.fs) return false;
    try {
      if (!this.fs.exists(this.persistencePath)) return false;
      const raw = this.fs.readFileText(this.persistencePath);
      const payload = JSON.parse(raw);
      if (payload.version !== 1) return false;

      this.items.clear();
      this.index.clear();
      for (const meta of payload.items) {
        const item = new KeychainItem(meta);
        item.encryptedData = new Uint8Array(meta.encryptedData || []);
        item.authTag = meta.authTag;
        this.items.set(item.id, item);
        this.index.set(`${item.itemClass}:${item.service}:${item.account}`, item.id);
      }
      this.stats.persistenceLoads++;
      Logger.info(LOG_TAG, `Keychain cargado desde FS: ${this.items.size} items`);
      return true;
    } catch (e) {
      Logger.warn(LOG_TAG, `Load falló: ${e.message}`);
      return false;
    }
  }

  _tryLoad() { try { this.load(); } catch {} }

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
   * Estadísticas
   * ================================================================ */

  getStats() {
    const byClass = {};
    const byAccessibility = {};
    const byGroup = {};
    let synchronizableCount = 0;
    let secureEnclaveCount = 0;

    for (const item of this.items.values()) {
      byClass[item.itemClass] = (byClass[item.itemClass] || 0) + 1;
      byAccessibility[item.accessibility] = (byAccessibility[item.accessibility] || 0) + 1;
      if (item.accessGroup) byGroup[item.accessGroup] = (byGroup[item.accessGroup] || 0) + 1;
      if (item.synchronizable) synchronizableCount++;
      if (item.encryption === ENCRYPTION.SECURE_ENCLAVE) secureEnclaveCount++;
    }

    return {
      ...this.stats,
      totalItems: this.items.size,
      locked: this.locked,
      currentBundleId: this.currentBundleId,
      rotationCounter: this.rotationCounter,
      byClass,
      byAccessibility,
      byGroup,
      synchronizableCount,
      secureEnclaveCount,
      enclave: {
        uid: this.enclave.uid,
        locked: this.enclave.locked,
        biometry: this.enclave.biometry,
        passcodeSet: this.enclave.passcodeSet,
        keys: this.enclave.keys.size,
        ...this.enclave.stats,
      },
    };
  }

  /* ================================================================ *
   * Diagnóstico
   * ================================================================ */

  dump() {
    const s = this.getStats();
    Logger.kernel(LOG_TAG, '─── Keychain dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${s.locked ? 'LOCKED' : 'UNLOCKED'}`);
    Logger.kernel(LOG_TAG, `  bundleId     : ${s.currentBundleId || '(ninguno)'}`);
    Logger.kernel(LOG_TAG, `  items        : ${s.totalItems}`);
    Logger.kernel(LOG_TAG, `  iCloud       : ${s.synchronizableCount}`);
    Logger.kernel(LOG_TAG, `  SE items     : ${s.secureEnclaveCount}`);
    Logger.kernel(LOG_TAG, `  rotaciones   : ${s.rotationCounter}`);
    Logger.kernel(LOG_TAG, `  add/upd/del  : ${s.itemsAdded}/${s.itemsUpdated}/${s.itemsDeleted}`);
    Logger.kernel(LOG_TAG, `  queries      : ${s.queries}`);
    Logger.kernel(LOG_TAG, `  reads/fails  : ${s.reads}/${s.readFails}`);
    Logger.kernel(LOG_TAG, `  auth failures: ${s.authFailures}`);
    Logger.kernel(LOG_TAG, `  iCloud syncs : ${s.iCloudSyncs}`);
    Logger.kernel(LOG_TAG, `  Secure Enclave:`);
    Logger.kernel(LOG_TAG, `    · uid       : ${s.enclave.uid.slice(0, 12)}…`);
    Logger.kernel(LOG_TAG, `    · biometry  : ${s.enclave.biometry}`);
    Logger.kernel(LOG_TAG, `    · passcode  : ${s.enclave.passcodeSet}`);
    Logger.kernel(LOG_TAG, `    · keys      : ${s.enclave.keys}`);
    Logger.kernel(LOG_TAG, `    · auths     : ${s.enclave.biometricAuths} ok / ${s.enclave.biometricFails} fail`);
    Logger.kernel(LOG_TAG, `  items por clase:`);
    for (const [k, n] of Object.entries(s.byClass)) {
      Logger.kernel(LOG_TAG, `    · ${k.padEnd(6)} ${n}`);
    }
  }
}

export default Keychain;
