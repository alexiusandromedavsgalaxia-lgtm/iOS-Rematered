// src/loader/AppSandbox.js

/**
 * ═══════════════════════════════════════════════════════════════
 *  iOS Remastered — AppSandbox
 * ═══════════════════════════════════════════════════════════════
 *
 * Sandbox de aplicación. Modela el aislamiento que iOS impone a
 * cada app de usuario:
 *
 *   - Cada app tiene un contenedor propio en el FS virtual.
 *   - No puede leer/escribir fuera de su contenedor salvo permiso
 *     explícito (fotos, contactos, ubicación, etc).
 *   - Los permisos se conceden al pedirlos (TCC style) y se
 *     revocan cuando el usuario los retira en Ajustes.
 *   - Los "entitlements" se conceden en el momento del install y
 *     no se pueden revocar (son parte del binario firmado).
 *   - Los accesos se auditan en un log interno para que la app
 *     Ajustes → Privacidad pueda mostrarlos.
 *
 * Referencias conceptuales:
 *   - Apple: App Sandbox Design Guide
 *   - Apple: Entitlements
 *   - Apple: TCC (Transparency, Consent, and Control)
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from '../system/Logger.js';

// ───────────────────────────────────────────────────────────────
// Permisos TCC (los que el usuario concede en runtime)
// ───────────────────────────────────────────────────────────────
export const Permission = {
  CAMERA:          'camera',
  MICROPHONE:      'microphone',
  PHOTOS_READ:     'photos.read',
  PHOTOS_WRITE:    'photos.write',
  LOCATION_WHEN:   'location.whenInUse',
  LOCATION_ALWAYS: 'location.always',
  CONTACTS:        'contacts',
  CALENDAR:        'calendar',
  REMINDERS:       'reminders',
  HEALTH_READ:     'health.read',
  HEALTH_WRITE:    'health.write',
  MOTION:          'motion',
  BLUETOOTH:       'bluetooth',
  LOCAL_NETWORK:   'localNetwork',
  TRACKING:        'tracking',
  NOTIFICATIONS:   'notifications',
  FACE_ID:         'faceId',
  SPEECH:          'speech',
  HOME_KIT:        'homekit',
  SIRI:            'siri',
};

// ───────────────────────────────────────────────────────────────
// Entitlements (declarados en el binario; no revocables)
// ───────────────────────────────────────────────────────────────
export const Entitlement = {
  APP_IDENTIFIER:        'application-identifier',
  TEAM_IDENTIFIER:       'com.apple.developer.team-identifier',
  KEYCHAIN_GROUPS:       'keychain-access-groups',
  GET_TASK_ALLOW:        'get-task-allow',
  RUN_AS_ROOT:           'com.apple.private.run-as-root',
  NETWORK_CLIENT:        'com.apple.security.network.client',
  NETWORK_SERVER:        'com.apple.security.network.server',
  FILE_READ_USER:        'com.apple.security.files.user-selected.read-only',
  FILE_READ_WRITE_USER:  'com.apple.security.files.user-selected.read-write',
  DEVICE_CAMERA:         'com.apple.developer.avfoundation.camera',
  BACKGROUND_AUDIO:      'com.apple.developer.background-modes.audio',
  PUSH_NOTIFICATIONS:    'aps-environment',
  ASSOCIATED_DOMAINS:    'com.apple.developer.associated-domains',
  EXTENSION:             'com.apple.developer.app-extensions',
};

// Estados de un permiso TCC
export const PermissionStatus = {
  NOT_DETERMINED: 'not-determined',
  GRANTED:        'granted',
  DENIED:         'denied',
  RESTRICTED:     'restricted',      // no revocable por el usuario (parental control)
  LIMITED:        'limited',         // p.ej. "solo fotos seleccionadas"
};

// Códigos de error específicos del sandbox (extienden errno de POSIX)
export const SandboxError = {
  EPERM:     1,   // operación prohibida
  EACCES:   13,   // sin acceso al recurso
  ENOENT:    2,   // recurso no existe
  EBADF:     9,
  EFAULT:   14,
  EINVAL:   22,
  EROFS:    30,   // intento de escritura en read-only
  ENAMETOOLONG: 36,
};

// Clase de error específica
export class SandboxViolation extends Error {
  constructor(errno, message, details = {}) {
    super(message);
    this.name = 'SandboxViolation';
    this.errno = errno;
    this.details = details;
  }
}

// ───────────────────────────────────────────────────────────────
// Helpers internos
// ───────────────────────────────────────────────────────────────

/**
 * Normaliza un path para prevenir escapes tipo "../../etc/passwd".
 * Devuelve el path canónico absoluto o null si es inválido.
 */
function normalizePath(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.length > 1024) return null;

  // Convertir todo a absoluto
  let p = input.startsWith('/') ? input : '/' + input;

  // Reemplazar múltiples "/" por uno
  p = p.replace(/\/+/g, '/');

  // Resolver ".." y "."
  const parts = p.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // escape intentado
      out.pop();
    } else {
      out.push(part);
    }
  }
  return '/' + out.join('/');
}

/**
 * Comprueba si `child` está dentro de `parent` (path-wise).
 * Ambos deben ser paths ya normalizados.
 */
function isPathInside(child, parent) {
  if (child === parent) return true;
  if (!parent.endsWith('/')) parent = parent + '/';
  return child.startsWith(parent);
}

/**
 * Genera un UUID v4 rápido para audit tokens y contenedores.
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ───────────────────────────────────────────────────────────────
// AppSandbox
// ───────────────────────────────────────────────────────────────
export class AppSandbox {
  /**
   * @param {string} bundleId     Identificador único (com.example.app)
   * @param {object} opts
   *   @param {object} entitlements  Mapa de entitlements iniciales
   *   @param {object} permissions   Permisos ya concedidos (por persistencia)
   *   @param {boolean} strict       true = cualquier violación lanza error
   */
  constructor(bundleId, opts = {}) {
    if (typeof bundleId !== 'string' || !bundleId.match(/^[a-zA-Z0-9.-]+$/)) {
      throw new Error(`AppSandbox: bundleId inválido "${bundleId}"`);
    }

    this.bundleId     = bundleId;
    this.containerUuid = uuidv4();
    this.createdAt    = Date.now();
    this.strict       = opts.strict ?? true;

    // Rutas del contenedor (mimetizan iOS)
    this.containerRoot   = `/private/var/mobile/Containers/Data/Application/${this.containerUuid}`;
    this.documentsPath   = `${this.containerRoot}/Documents`;
    this.libraryPath     = `${this.containerRoot}/Library`;
    this.cachesPath      = `${this.libraryPath}/Caches`;
    this.preferencesPath = `${this.libraryPath}/Preferences`;
    this.tmpPath         = `${this.containerRoot}/tmp`;
    this.bundlePath      = `/private/var/containers/Bundle/Application/${this.containerUuid}`;

    // Entitlements (inmutables tras el install salvo dev-signed)
    this.entitlements = new Map();
    this._seedDefaultEntitlements(opts.entitlements);

    // Permisos TCC (mutables: el usuario los concede/revoca)
    this.permissions = new Map();
    this._seedDefaultPermissions(opts.permissions);

    // Lista blanca de paths externos permitidos (por ejemplo,
    // "fotos seleccionadas" que el usuario ha dado permiso explícito)
    this.allowedExternalPaths = new Set();

    // Audit token (identifica la sesión del proceso)
    this.auditToken = uuidv4();

    // Estadísticas de uso
    this.stats = {
      reads:          0,
      writes:         0,
      opens:          0,
      networkCalls:   0,
      permissionChecks: 0,
      violations:     0,
      lastViolation:  null,
      lastAccessAt:   null,
    };

    // Log de violaciones (limitado a 200)
    this.violationLog = [];
    this.maxViolationLog = 200;

    // Suscriptores de eventos (para UI / Ajustes)
    this.subscribers = new Set();

    logger.debug('SANDBOX', `creado sandbox para ${bundleId} (container=${this.containerUuid.slice(0, 8)})`);
  }

  // ═══════════════════════════════════════════════════════════
  // INICIALIZACIÓN
  // ═══════════════════════════════════════════════════════════

  _seedDefaultEntitlements(custom = null) {
    // Todo proceso tiene APP_IDENTIFIER y TEAM_ID
    this.entitlements.set(Entitlement.APP_IDENTIFIER, this.bundleId);
    this.entitlements.set(Entitlement.TEAM_IDENTIFIER, 'IOSREMASTERED');
    this.entitlements.set(Entitlement.KEYCHAIN_GROUPS, [`${this.bundleId}.keychain`]);

    if (custom && typeof custom === 'object') {
      for (const [k, v] of Object.entries(custom)) {
        this.entitlements.set(k, v);
      }
    }
  }

  _seedDefaultPermissions(custom = null) {
    // Por defecto: NOT_DETERMINED en todos
    for (const perm of Object.values(Permission)) {
      this.permissions.set(perm, PermissionStatus.NOT_DETERMINED);
    }
    if (custom && typeof custom === 'object') {
      for (const [k, v] of Object.entries(custom)) {
        if (Object.values(Permission).includes(k)) {
          this.permissions.set(k, v);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ENTITLEMENTS
  // ═══════════════════════════════════════════════════════════

  hasEntitlement(key) {
    return this.entitlements.has(key);
  }

  getEntitlement(key) {
    return this.entitlements.get(key) ?? null;
  }

  addEntitlement(key, value = true) {
    if (this.entitlements.has(key)) {
      logger.warn('SANDBOX', `entitlement duplicado: ${key}`);
    }
    this.entitlements.set(key, value);
    this._notify('entitlement-added', { key, value });
  }

  listEntitlements() {
    return [...this.entitlements.entries()].map(([key, value]) => ({ key, value }));
  }

  // ═══════════════════════════════════════════════════════════
  // PERMISOS TCC
  // ═══════════════════════════════════════════════════════════

  /**
   * Consulta el estado actual de un permiso.
   */
  permissionStatus(perm) {
    return this.permissions.get(perm) ?? PermissionStatus.NOT_DETERMINED;
  }

  /**
   * Concede un permiso (equivale a que el usuario pulse "Permitir").
   */
  grantPermission(perm) {
    if (!Object.values(Permission).includes(perm)) {
      throw new SandboxViolation(SandboxError.EINVAL, `permiso desconocido: ${perm}`);
    }
    const prev = this.permissions.get(perm);
    if (prev === PermissionStatus.RESTRICTED) {
      throw new SandboxViolation(SandboxError.EPERM, `permiso restringido por política: ${perm}`);
    }
    this.permissions.set(perm, PermissionStatus.GRANTED);
    logger.info('SANDBOX', `✓ ${this.bundleId} concedido: ${perm}`);
    this._notify('permission-granted', { perm, prev });
    return true;
  }

  /**
   * Deniega un permiso (usuario pulsa "No permitir").
   */
  denyPermission(perm) {
    if (!Object.values(Permission).includes(perm)) {
      throw new SandboxViolation(SandboxError.EINVAL, `permiso desconocido: ${perm}`);
    }
    const prev = this.permissions.get(perm);
    this.permissions.set(perm, PermissionStatus.DENIED);
    logger.info('SANDBOX', `✗ ${this.bundleId} denegado: ${perm}`);
    this._notify('permission-denied', { perm, prev });
    return true;
  }

  /**
   * Revoca un permiso previamente concedido (Ajustes → app → permiso).
   */
  revokePermission(perm) {
    const prev = this.permissions.get(perm);
    if (prev === PermissionStatus.RESTRICTED) {
      throw new SandboxViolation(SandboxError.EPERM, `no se puede revocar restringido: ${perm}`);
    }
    this.permissions.set(perm, PermissionStatus.NOT_DETERMINED);
    logger.info('SANDBOX', `↺ ${this.bundleId} revocado: ${perm}`);
    this._notify('permission-revoked', { perm, prev });
    return true;
  }

  /**
   * Verifica un permiso. Si está GRANTED devuelve true.
   * Si no, según `strict`:
   *   - strict=true  → lanza SandboxViolation(EPERM)
   *   - strict=false → devuelve false
   */
  checkPermission(perm) {
    this.stats.permissionChecks++;
    const status = this.permissionStatus(perm);

    if (status === PermissionStatus.GRANTED) return true;

    const reason = status === PermissionStatus.DENIED
      ? `usuario denegó el permiso`
      : status === PermissionStatus.RESTRICTED
        ? `restringido por política`
        : `permiso no concedido (estado: ${status})`;

    this._recordViolation({
      type:  'permission',
      perm,
      reason,
    });

    if (this.strict) {
      throw new SandboxViolation(SandboxError.EPERM, `permiso denegado: ${perm} (${reason})`, {
        bundleId: this.bundleId, perm, status,
      });
    }
    return false;
  }

  /**
   * ¿Puede preguntarse por este permiso? (no denegado, no restringido)
   */
  canRequestPermission(perm) {
    const status = this.permissionStatus(perm);
    return status === PermissionStatus.NOT_DETERMINED;
  }

  listPermissions() {
    return [...this.permissions.entries()].map(([perm, status]) => ({ perm, status }));
  }

  // ═══════════════════════════════════════════════════════════
  // ACCESO A PATHS
  // ═══════════════════════════════════════════════════════════

  /**
   * Comprueba si el path está dentro del contenedor (permitido) o
   * fuera (potencial violación).
   *
   * @returns {object} { allowed: bool, reason: string, normalized: string|null }
   */
  resolvePath(rawPath) {
    const normalized = normalizePath(rawPath);
    if (!normalized) {
      return { allowed: false, reason: 'path inválido o intento de escape', normalized: null };
    }

    // 1) Dentro de su propio contenedor → OK
    if (isPathInside(normalized, this.containerRoot)) {
      return { allowed: true, reason: 'dentro del contenedor', normalized };
    }

    // 2) Dentro de su bundle (solo lectura)
    if (isPathInside(normalized, this.bundlePath)) {
      return { allowed: true, reason: 'dentro del bundle (read-only)', normalized, readOnly: true };
    }

    // 3) En la lista blanca (fotos seleccionadas, etc)
    for (const allowed of this.allowedExternalPaths) {
      if (isPathInside(normalized, allowed)) {
        return { allowed: true, reason: `en whitelist (${allowed})`, normalized };
      }
    }

    // 4) Zonas comunes de sistema que son read-only permitidas
    const READ_ONLY_SHARED = [
      '/System/Library',
      '/usr/lib',
      '/usr/share',
    ];
    for (const shared of READ_ONLY_SHARED) {
      if (isPathInside(normalized, shared)) {
        return { allowed: true, reason: 'shared read-only', normalized, readOnly: true };
      }
    }

    // 5) Zonas comunes donde vive el usuario (requiere permisos específicos)
    if (isPathInside(normalized, '/User/Photos')) {
      return {
        allowed: this.permissionStatus(Permission.PHOTOS_READ) === PermissionStatus.GRANTED,
        reason:  'requires photos.read',
        normalized,
        readOnly: true,
      };
    }

    if (isPathInside(normalized, '/User/Documents')) {
      return {
        allowed: this.hasEntitlement(Entitlement.FILE_READ_USER),
        reason:  'requires user-selected file entitlement',
        normalized,
      };
    }

    // 6) Fuera de todo → violación
    return { allowed: false, reason: 'fuera del contenedor', normalized };
  }

  /**
   * Registra un intento de acceso. Devuelve el path normalizado si
   * se permite, o lanza SandboxViolation si no.
   */
  authorizeAccess(rawPath, mode = 'read') {
    const { allowed, reason, normalized, readOnly } = this.resolvePath(rawPath);
    this.stats.lastAccessAt = Date.now();

    if (!allowed) {
      this._recordViolation({
        type: 'path',
        path: rawPath,
        mode,
        reason,
      });
      if (this.strict) {
        throw new SandboxViolation(SandboxError.EACCES, `acceso denegado: ${rawPath} (${reason})`, {
          bundleId: this.bundleId, path: rawPath, mode, reason,
        });
      }
      return null;
    }

    if (readOnly && mode !== 'read') {
      this._recordViolation({
        type: 'path',
        path: rawPath,
        mode,
        reason: 'path es read-only',
      });
      if (this.strict) {
        throw new SandboxViolation(SandboxError.EROFS, `path read-only: ${rawPath}`, {
          bundleId: this.bundleId, path: rawPath, mode,
        });
      }
      return null;
    }

    if (mode === 'read')  this.stats.reads++;
    if (mode === 'write') this.stats.writes++;
    if (mode === 'open')  this.stats.opens++;

    return normalized;
  }

  /**
   * Añade un path externo a la whitelist (por ejemplo, cuando el
   * usuario selecciona fotos para dar acceso "limitado").
   */
  allowExternalPath(path) {
    const normalized = normalizePath(path);
    if (!normalized) throw new SandboxViolation(SandboxError.EINVAL, `path inválido: ${path}`);
    this.allowedExternalPaths.add(normalized);
    logger.info('SANDBOX', `${this.bundleId} whitelist: ${normalized}`);
    this._notify('external-path-added', { path: normalized });
    return normalized;
  }

  revokeExternalPath(path) {
    const normalized = normalizePath(path);
    if (!normalized) return false;
    const ok = this.allowedExternalPaths.delete(normalized);
    if (ok) {
      logger.info('SANDBOX', `${this.bundleId} whitelist revocada: ${normalized}`);
      this._notify('external-path-removed', { path: normalized });
    }
    return ok;
  }

  listExternalPaths() {
    return [...this.allowedExternalPaths];
  }

  // ═══════════════════════════════════════════════════════════
  // RED
  // ═══════════════════════════════════════════════════════════

  canUseNetwork() {
    this.stats.networkCalls++;
    const hasClient = this.hasEntitlement(Entitlement.NETWORK_CLIENT);
    const hasServer = this.hasEntitlement(Entitlement.NETWORK_SERVER);
    if (!hasClient && !hasServer) {
      this._recordViolation({ type: 'network', reason: 'sin entitlement de red' });
      if (this.strict) {
        throw new SandboxViolation(SandboxError.EPERM, 'app sin entitlement de red', {
          bundleId: this.bundleId,
        });
      }
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // AUDITORÍA / VIOLACIONES
  // ═══════════════════════════════════════════════════════════

  _recordViolation(v) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      bundleId: this.bundleId,
      ...v,
    };
    this.violationLog.push(entry);
    if (this.violationLog.length > this.maxViolationLog) this.violationLog.shift();
    this.stats.violations++;
    this.stats.lastViolation = entry;
    logger.warn('SANDBOX', `⚠ ${this.bundleId} violación: ${v.type} — ${v.reason}`);
    this._notify('violation', entry);
    return entry;
  }

  getViolations(limit = 50) {
    return this.violationLog.slice(-limit);
  }

  clearViolations() {
    this.violationLog = [];
    this.stats.violations = 0;
    this.stats.lastViolation = null;
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify(type, data) {
    const payload = { type, ts: Date.now(), bundleId: this.bundleId, data };
    for (const fn of this.subscribers) {
      try { fn(payload); } catch (_) { /* nunca romper por un subscriber */ }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ESTADÍSTICAS
  // ═══════════════════════════════════════════════════════════

  getStats() {
    const permsByStatus = {};
    for (const status of Object.values(PermissionStatus)) permsByStatus[status] = 0;
    for (const status of this.permissions.values()) permsByStatus[status]++;

    return {
      bundleId:          this.bundleId,
      containerUuid:     this.containerUuid,
      auditToken:        this.auditToken,
      containerRoot:     this.containerRoot,
      createdAt:         this.createdAt,
      ageMs:             Date.now() - this.createdAt,
      strict:            this.strict,
      entitlementsCount: this.entitlements.size,
      permissionsCount:  this.permissions.size,
      permissionsByStatus: permsByStatus,
      externalPathsCount: this.allowedExternalPaths.size,
      stats:             { ...this.stats },
      recentViolations:  this.violationLog.slice(-5),
    };
  }

  dump() {
    const s = this.getStats();
    const lines = [
      `Sandbox(${this.bundleId})`,
      `  container:  ${this.containerRoot}`,
      `  bundle:     ${this.bundlePath}`,
      `  created:    ${new Date(this.createdAt).toISOString()}`,
      `  strict:     ${this.strict}`,
      `  entitlements: ${s.entitlementsCount}`,
      `  permisos:`,
    ];
    for (const [perm, status] of this.permissions) {
      lines.push(`    ${perm.padEnd(22)} ${status}`);
    }
    lines.push(`  violaciones: ${s.stats.violations}`);
    lines.push(`  stats:       reads=${s.stats.reads} writes=${s.stats.writes} opens=${s.stats.opens}`);
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // SERIALIZACIÓN
  // ═══════════════════════════════════════════════════════════

  serialize() {
    return {
      bundleId: this.bundleId,
      containerUuid: this.containerUuid,
      createdAt: this.createdAt,
      strict: this.strict,
      entitlements: [...this.entitlements.entries()],
      permissions: [...this.permissions.entries()],
      externalPaths: [...this.allowedExternalPaths],
      stats: this.stats,
    };
  }

  static deserialize(data) {
    const sb = new AppSandbox(data.bundleId, {
      strict: data.strict,
      entitlements: Object.fromEntries(data.entitlements || []),
      permissions: Object.fromEntries(data.permissions || []),
    });
    sb.containerUuid = data.containerUuid;
    (data.externalPaths || []).forEach(p => sb.allowedExternalPaths.add(p));
    Object.assign(sb.stats, data.stats || {});
    return sb;
  }
}

// ───────────────────────────────────────────────────────────────
// Caché global de sandboxes por bundleId (una instancia por app)
// ───────────────────────────────────────────────────────────────
const sandboxRegistry = new Map();

export function getOrCreateSandbox(bundleId, opts = {}) {
  if (sandboxRegistry.has(bundleId)) {
    return sandboxRegistry.get(bundleId);
  }
  const sb = new AppSandbox(bundleId, opts);
  sandboxRegistry.set(bundleId, sb);
  return sb;
}

export function getSandbox(bundleId) {
  return sandboxRegistry.get(bundleId) || null;
}

export function destroySandbox(bundleId) {
  return sandboxRegistry.delete(bundleId);
}

export function listSandboxes() {
  return [...sandboxRegistry.values()];
}

export function getSandboxStats() {
  return {
    count: sandboxRegistry.size,
    bundles: [...sandboxRegistry.keys()],
    totalViolations: [...sandboxRegistry.values()].reduce((acc, sb) => acc + sb.stats.violations, 0),
  };
}
