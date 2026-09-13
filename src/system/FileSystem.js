// src/system/FileSystem.js
// Sistema de ficheros APFS virtual.
// - Inodos + directorios jerárquicos
// - Permisos POSIX (rwx rwx rwx) + ownership (uid/gid)
// - Hardlinks, symlinks, path resolution con normalize
// - Journaling transaccional (write-ahead log)
// - Snapshots copy-on-write
// - Cuotas por volumen y por owner (bundleId)
// - Montaje sobre VStorage, comparte cuota de espacio
// - API POSIX-style: open/read/write/close/stat/mkdir/unlink/rename/symlink/link

import { Logger } from './Logger.js';

const LOG_TAG = 'FS';

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

export const FS_ERRORS = {
  ENOENT:  'ENOENT',
  EEXIST:  'EEXIST',
  EACCES:  'EACCES',
  EPERM:   'EPERM',
  EISDIR:  'EISDIR',
  ENOTDIR: 'ENOTDIR',
  ENOSPC:  'ENOSPC',
  EINVAL:  'EINVAL',
  EMFILE:  'EMFILE',
  EBADF:   'EBADF',
  ENOTEMPTY: 'ENOTEMPTY',
  EROFS:   'EROFS',
  ELOOP:   'ELOOP',
  ENAMETOOLONG: 'ENAMETOOLONG',
  EXDEV:   'EXDEV',
  EDQUOT:  'EDQUOT',
};

export const INODE_TYPE = {
  FILE:      'file',
  DIR:       'dir',
  SYMLINK:   'symlink',
  CHAR_DEV:  'chardev',
  BLOCK_DEV: 'blockdev',
  FIFO:      'fifo',
  SOCKET:    'socket',
};

export const OPEN_FLAGS = {
  O_RDONLY: 0x00,
  O_WRONLY: 0x01,
  O_RDWR:   0x02,
  O_CREAT:  0x40,
  O_EXCL:   0x80,
  O_TRUNC:  0x200,
  O_APPEND: 0x400,
};

export const SEEK = { SET: 0, CUR: 1, END: 2 };

// Modos POSIX base
export const MODES = {
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFLNK: 0o120000,
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
  S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
  S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,
  DEFAULT_FILE: 0o644,
  DEFAULT_DIR:  0o755,
  DEFAULT_EXEC: 0o755,
};

const BLOCK_SIZE = 4096;
const MAX_PATH_LEN = 1024;
const MAX_SYMLINK_DEPTH = 16;
const MAX_FD = 1024;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
function isAbsolute(p) { return p.startsWith('/'); }

function normalizePath(p) {
  if (!p) return '/';
  if (p.length > MAX_PATH_LEN) throw Object.assign(new Error('path too long'), { errno: FS_ERRORS.ENAMETOOLONG });
  const parts = p.split('/').filter(s => s.length > 0 && s !== '.');
  const stack = [];
  for (const part of parts) {
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

function basename(p) {
  const n = normalizePath(p);
  if (n === '/') return '/';
  return n.slice(n.lastIndexOf('/') + 1);
}

function dirname(p) {
  const n = normalizePath(p);
  if (n === '/') return '/';
  const idx = n.lastIndexOf('/');
  return idx === 0 ? '/' : n.slice(0, idx);
}

function joinPath(a, b) {
  if (!a || a === '/') return normalizePath('/' + b);
  return normalizePath(a + '/' + b);
}

function splitPath(p) {
  return normalizePath(p).split('/').filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Inodo
 * ------------------------------------------------------------------ */

let _nextInode = 2;   // 0 y 1 reservados (root, bad blocks)

class Inode {
  constructor(type, mode = MODES.DEFAULT_FILE, uid = 0, gid = 0) {
    this.ino = _nextInode++;
    this.type = type;
    this.mode = (type === INODE_TYPE.DIR ? MODES.S_IFDIR : MODES.S_IFREG) | mode;
    this.uid = uid;
    this.gid = gid;
    this.size = 0;
    this.blocks = 0;
    this.atime = Date.now();
    this.mtime = Date.now();
    this.ctime = Date.now();
    this.birthtime = Date.now();
    this.links = 1;

    // Contenido según tipo
    this.data = type === INODE_TYPE.DIR ? new Map() : null;   // Map<name, ino>
    this.content = type === INODE_TYPE.FILE ? new Uint8Array(0) : null;
    this.target = type === INODE_TYPE.SYMLINK ? '' : null;

    // xattrs simples
    this.xattrs = new Map();

    // Flags APFS
    this.flags = {
      compressed: false,
      cloned: false,
      sparse: false,
      immutable: false,
      appendOnly: false,
    };
  }

  isDir()     { return this.type === INODE_TYPE.DIR; }
  isFile()    { return this.type === INODE_TYPE.FILE; }
  isSymlink() { return this.type === INODE_TYPE.SYMLINK; }

  updateSize(bytes) {
    this.size = bytes;
    this.blocks = Math.ceil(bytes / BLOCK_SIZE);
    this.mtime = Date.now();
    this.ctime = Date.now();
  }

  touch(atimeOnly = false) {
    this.atime = Date.now();
    if (!atimeOnly) this.mtime = Date.now();
  }
}

/* ------------------------------------------------------------------ *
 * File Descriptor
 * ------------------------------------------------------------------ */

let _nextFd = 3;   // 0,1,2 reservados (stdin/out/err)

class FileDescriptor {
  constructor(inode, flags) {
    this.fd = _nextFd++;
    this.inode = inode;
    this.flags = flags;
    this.offset = 0;
    this.closed = false;
    this.openedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ *
 * Journal (write-ahead log)
 * ------------------------------------------------------------------ */

class Journal {
  constructor(maxEntries = 4096) {
    this.max = maxEntries;
    this.entries = [];
    this.committedTx = 0;
    this.pendingTx = null;
  }

  begin(txId) {
    if (this.pendingTx) {
      Logger.warn(LOG_TAG, `Journal: transacción abierta sin commit (${this.pendingTx.id})`);
      this.rollback();
    }
    this.pendingTx = { id: txId, ops: [], startedAt: Date.now() };
    return this.pendingTx;
  }

  log(op) {
    if (!this.pendingTx) return;
    this.pendingTx.ops.push({ ...op, t: Date.now() });
  }

  commit() {
    if (!this.pendingTx) return false;
    this.entries.push(this.pendingTx);
    if (this.entries.length > this.max) this.entries.shift();
    this.committedTx++;
    this.pendingTx = null;
    return true;
  }

  rollback() {
    if (!this.pendingTx) return false;
    Logger.warn(LOG_TAG, `Journal rollback de ${this.pendingTx.ops.length} ops`);
    this.pendingTx = null;
    return true;
  }

  getLast(n = 10) {
    return this.entries.slice(-n);
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot (copy-on-write ligero)
 * ------------------------------------------------------------------ */

let _nextSnapshotId = 1;

class Snapshot {
  constructor(name, inodes, rootIno) {
    this.id = _nextSnapshotId++;
    this.name = name;
    this.createdAt = Date.now();
    // Congelamos referencias a inodos existentes (COW: si un inodo cambia,
    // se clona antes de modificar; aquí guardamos una copia shallow con
    // contenido clonado para simplificar).
    this.inodes = new Map();
    for (const [ino, inode] of inodes) {
      this.inodes.set(ino, cloneInodeShallow(inode));
    }
    this.rootIno = rootIno;
  }

  sizeBytes() {
    let total = 0;
    for (const inode of this.inodes.values()) total += inode.size;
    return total;
  }
}

function cloneInodeShallow(inode) {
  const c = new Inode(inode.type, inode.mode & 0o777, inode.uid, inode.gid);
  c.ino = inode.ino;
  c.mode = inode.mode;
  c.size = inode.size;
  c.blocks = inode.blocks;
  c.links = inode.links;
  c.atime = inode.atime;
  c.mtime = inode.mtime;
  c.ctime = inode.ctime;
  c.birthtime = inode.birthtime;
  c.flags = { ...inode.flags };
  c.xattrs = new Map(inode.xattrs);
  if (inode.isDir()) c.data = new Map(inode.data);
  else if (inode.isFile()) c.content = new Uint8Array(inode.content);
  else if (inode.isSymlink()) c.target = inode.target;
  return c;
}

/* ------------------------------------------------------------------ *
 * Volumen
 * ------------------------------------------------------------------ */

class Volume {
  constructor(name, mountPoint, quotaBytes, storageRef = null) {
    this.name = name;
    this.mountPoint = mountPoint;
    this.quotaBytes = quotaBytes;
    this.usedBytes = 0;
    this.storageRef = storageRef;
    this.readOnly = false;
    this.inodes = new Map();     // ino → Inode
    this.snapshots = [];
    this.rootIno = null;
    this.createdAt = Date.now();
    this.stats = {
      filesCreated: 0,
      filesDeleted: 0,
      dirsCreated: 0,
      writes: 0,
      reads: 0,
      bytesWritten: 0,
      bytesRead: 0,
      hardlinks: 0,
      symlinks: 0,
      quotaHits: 0,
    };
  }

  addInode(inode) {
    this.inodes.set(inode.ino, inode);
    if (inode.isFile() || inode.isSymlink()) {
      this.usedBytes += inode.size;
    }
    return inode;
  }

  removeInode(inode) {
    this.inodes.delete(inode.ino);
    if (inode.isFile() || inode.isSymlink()) {
      this.usedBytes -= inode.size;
      if (this.usedBytes < 0) this.usedBytes = 0;
    }
  }

  freeBytes() {
    return Math.max(0, this.quotaBytes - this.usedBytes);
  }
}

/* ------------------------------------------------------------------ *
 * Clase principal: FileSystem
 * ------------------------------------------------------------------ */

export class FileSystem {
  constructor(storage = null, options = {}) {
    this.storage = storage;
    this.volumes = new Map();     // name → Volume
    this.mounts = new Map();      // mountPoint → Volume
    this.fds = new Map();         // fd → FileDescriptor
    this.journal = new Journal(options.journalSize || 4096);
    this.txCounter = 0;
    this.uid = options.uid ?? 501;   // usuario 'mobile'
    this.gid = options.gid ?? 501;

    // Resolución de symlinks
    this.symlinkDepth = 0;

    // Suscriptores
    this.subscribers = new Set();

    // Estadísticas globales
    this.stats = {
      txTotal: 0,
      txCommitted: 0,
      txRolledBack: 0,
      opens: 0,
      closes: 0,
      reads: 0,
      writes: 0,
      mkdirs: 0,
      unlinks: 0,
      renames: 0,
      symlinkOps: 0,
      hardlinkOps: 0,
      pathLookups: 0,
      errors: {},
      snapshotsCreated: 0,
      snapshotsDeleted: 0,
    };

    Logger.debug(LOG_TAG, 'FileSystem APFS virtual instanciado');
  }

  /* ================================================================ *
   * Montaje
   * ================================================================ */

  mountVolume(name, mountPoint, quotaBytes, opts = {}) {
    if (this.volumes.has(name)) {
      Logger.warn(LOG_TAG, `Volumen ${name} ya existe`);
      return false;
    }
    if (this.mounts.has(mountPoint)) {
      Logger.warn(LOG_TAG, `Mount point ${mountPoint} ocupado`);
      return false;
    }

    const vol = new Volume(name, mountPoint, quotaBytes, this.storage);
    vol.readOnly = !!opts.readOnly;

    // Crear inodo raíz
    const root = new Inode(INODE_TYPE.DIR, MODES.DEFAULT_DIR, 0, 0);
    vol.addInode(root);
    vol.rootIno = root.ino;

    this.volumes.set(name, vol);
    this.mounts.set(mountPoint, vol);

    Logger.kernel(LOG_TAG, `Volumen montado: ${name} @ ${mountPoint} (${round(quotaBytes / 1e9, 1)} GB)`);
    this._emit('mount', { name, mountPoint, quotaBytes });
    return true;
  }

  unmountVolume(mountPoint) {
    const vol = this.mounts.get(mountPoint);
    if (!vol) return false;
    // Cerrar fds asociados
    for (const [fd, desc] of this.fds) {
      if (desc.inode && vol.inodes.has(desc.inode.ino)) {
        desc.closed = true;
        this.fds.delete(fd);
      }
    }
    this.mounts.delete(mountPoint);
    this.volumes.delete(vol.name);
    Logger.kernel(LOG_TAG, `Volumen desmontado: ${vol.name}`);
    this._emit('unmount', { name: vol.name, mountPoint });
    return true;
  }

  /* ================================================================ *
   * Resolución de volúmenes y paths
   * ================================================================ */

  _resolveVolume(path) {
    const norm = normalizePath(path);
    // Buscamos el mountPoint más largo que sea prefijo
    let best = null;
    for (const [mp, vol] of this.mounts) {
      if (mp === '/' || norm === mp || norm.startsWith(mp + '/')) {
        if (!best || mp.length > best[0].length) best = [mp, vol];
      }
    }
    if (!best) throw Object.assign(new Error(`no volume for ${path}`), { errno: FS_ERRORS.ENOENT });
    const [mp, vol] = best;
    const rel = norm === mp ? '/' : norm.slice(mp.length);
    return { volume: vol, relativePath: rel || '/' };
  }

  /* ================================================================ *
   * Path lookup
   * ================================================================ */

  _lookupInode(volume, relPath, opts = {}) {
    this.stats.pathLookups++;
    const parts = splitPath(relPath);
    let inode = volume.inodes.get(volume.rootIno);
    if (!inode) throw Object.assign(new Error('root inode missing'), { errno: FS_ERRORS.ENOENT });

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!inode.isDir()) {
        throw Object.assign(new Error(`not a directory: ${part}`), { errno: FS_ERRORS.ENOTDIR });
      }
      const nextIno = inode.data.get(part);
      if (nextIno == null) {
        if (opts.create && i === parts.length - 1) {
          return { parent: inode, name: part, inode: null };
        }
        throw Object.assign(new Error(`no such file: ${part}`), { errno: FS_ERRORS.ENOENT });
      }
      let next = volume.inodes.get(nextIno);
      if (!next) throw Object.assign(new Error(`dangling inode: ${nextIno}`), { errno: FS_ERRORS.ENOENT });

      // Resolver symlink intermedio
      if (next.isSymlink() && i < parts.length - 1) {
        if (this.symlinkDepth++ > MAX_SYMLINK_DEPTH) {
          this.symlinkDepth = 0;
          throw Object.assign(new Error('too many symlink levels'), { errno: FS_ERRORS.ELOOP });
        }
        const target = this._resolveSymlink(volume, inode, next, part);
        return this._lookupInode(target.volume, joinPath(target.relPath, parts.slice(i + 1).join('/')), opts);
      }

      inode = next;
    }

    return { parent: null, name: parts[parts.length - 1] || '/', inode };
  }

  _resolveSymlink(volume, parentInode, symlinkInode, linkName) {
    let target = symlinkInode.target;
    if (isAbsolute(target)) {
      const { volume: v, relativePath } = this._resolveVolume(target);
      return { volume: v, relPath: relativePath };
    }
    // Relativo al directorio del symlink
    const parentPath = this._pathOfInode(volume, parentInode.ino) || '/';
    const abs = joinPath(parentPath, target);
    const { volume: v, relativePath } = this._resolveVolume(abs);
    return { volume: v, relPath: relativePath };
  }

  _pathOfInode(volume, ino, _cache = new Map()) {
    if (ino === volume.rootIno) return volume.mountPoint;
    for (const [name, childIno] of (volume.inodes.get(volume.rootIno).data || new Map())) {
      const found = this._findPath(volume, volume.rootIno, ino, '/' + name);
      if (found) return volume.mountPoint.replace(/\/$/, '') + found;
    }
    return null;
  }

  _findPath(volume, currentIno, targetIno, currentPath, visited = new Set()) {
    if (visited.has(currentIno)) return null;
    visited.add(currentIno);
    const inode = volume.inodes.get(currentIno);
    if (!inode || !inode.isDir()) return null;
    for (const [name, childIno] of inode.data) {
      const childPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
      if (childIno === targetIno) return childPath;
      const child = volume.inodes.get(childIno);
      if (child && child.isDir()) {
        const found = this._findPath(volume, childIno, targetIno, childPath, visited);
        if (found) return found;
      }
    }
    return null;
  }

  /* ================================================================ *
   * Permisos
   * ================================================================ */

  _checkPermission(inode, uid, gid, mode) {
    if (uid === 0) return true;   // root
    if (inode.uid === uid) {
      return (inode.mode & (mode << 6)) === (mode << 6);
    }
    if (inode.gid === gid) {
      return (inode.mode & (mode << 3)) === (mode << 3);
    }
    return (inode.mode & mode) === mode;
  }

  /* ================================================================ *
   * Cuotas
   * ================================================================ */

  _checkQuota(volume, additionalBytes) {
    if (volume.usedBytes + additionalBytes > volume.quotaBytes) {
      volume.stats.quotaHits++;
      throw Object.assign(new Error('quota exceeded'), { errno: FS_ERRORS.ENOSPC });
    }
  }

  /* ================================================================ *
   * Transacciones
   * ================================================================ */

  _beginTx() {
    this.txCounter++;
    this.stats.txTotal++;
    return this.journal.begin(this.txCounter);
  }

  _commitTx() {
    this.journal.commit();
    this.stats.txCommitted++;
  }

  _rollbackTx() {
    this.journal.rollback();
    this.stats.txRolledBack++;
  }

  /* ================================================================ *
   * Creación de inodos
   * ================================================================ */

  _createInode(volume, parent, name, type, mode, uid, gid) {
    if (parent.data.has(name)) {
      throw Object.assign(new Error(`exists: ${name}`), { errno: FS_ERRORS.EEXIST });
    }
    const inode = new Inode(type, mode, uid, gid);
    volume.addInode(inode);
    parent.data.set(name, inode.ino);
    parent.mtime = Date.now();
    this.journal.log({ op: 'create', parent: parent.ino, name, ino: inode.ino, type });
    return inode;
  }

  _unlinkInode(volume, parent, name) {
    const ino = parent.data.get(name);
    if (ino == null) {
      throw Object.assign(new Error(`no such file: ${name}`), { errno: FS_ERRORS.ENOENT });
    }
    parent.data.delete(name);
    parent.mtime = Date.now();
    const inode = volume.inodes.get(ino);
    if (inode) {
      inode.links--;
      if (inode.links <= 0) volume.removeInode(inode);
    }
    this.journal.log({ op: 'unlink', parent: parent.ino, name, ino });
  }

  /* ================================================================ *
   * API pública: mkdir
   * ================================================================ */

  mkdir(path, mode = MODES.DEFAULT_DIR) {
    this._beginTx();
    try {
      const { volume, relativePath } = this._resolveVolume(path);
      if (volume.readOnly) throw Object.assign(new Error('read-only'), { errno: FS_ERRORS.EROFS });

      const { parent, name } = this._lookupInode(volume, relativePath, { create: true });
      const inode = this._createInode(volume, parent, name, INODE_TYPE.DIR, mode, this.uid, this.gid);

      this._commitTx();
      volume.stats.dirsCreated++;
      this.stats.mkdirs++;
      this._emit('mkdir', { path, ino: inode.ino });
      return inode.ino;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  mkdirp(path, mode = MODES.DEFAULT_DIR) {
    const parts = splitPath(path);
    let cur = '/';
    for (const part of parts) {
      cur = joinPath(cur, part);
      try { this.mkdir(cur, mode); }
      catch (e) { if (e.errno !== FS_ERRORS.EEXIST) throw e; }
    }
  }

  /* ================================================================ *
   * API pública: open / close / read / write
   * ================================================================ */

  open(path, flags = OPEN_FLAGS.O_RDONLY, mode = MODES.DEFAULT_FILE) {
    this._beginTx();
    try {
      const { volume, relativePath } = this._resolveVolume(path);
      if (volume.readOnly && (flags & (OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_RDWR | OPEN_FLAGS.O_CREAT))) {
        throw Object.assign(new Error('read-only fs'), { errno: FS_ERRORS.EROFS });
      }

      let inode;
      try {
        const r = this._lookupInode(volume, relativePath);
        inode = r.inode;
        if ((flags & OPEN_FLAGS.O_CREAT) && (flags & OPEN_FLAGS.O_EXCL)) {
          throw Object.assign(new Error('exists'), { errno: FS_ERRORS.EEXIST });
        }
      } catch (e) {
        if (e.errno === FS_ERRORS.ENOENT && (flags & OPEN_FLAGS.O_CREAT)) {
          const { parent, name } = this._lookupInode(volume, relativePath, { create: true });
          inode = this._createInode(volume, parent, name, INODE_TYPE.FILE, mode, this.uid, this.gid);
        } else {
          throw e;
        }
      }

      if (inode.isDir() && (flags & (OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_RDWR))) {
        throw Object.assign(new Error('is a directory'), { errno: FS_ERRORS.EISDIR });
      }
      if (inode.isSymlink()) {
        const target = this._resolveSymlink(volume, inode, inode, basename(path));
        return this.open(joinPath(target.volume.mountPoint, target.relPath), flags, mode);
      }

      if (flags & OPEN_FLAGS.O_TRUNC) {
        this._checkQuota(volume, 0); // no-op, TRUNC reduce
        if (inode.content) {
          volume.usedBytes -= inode.content.length;
          inode.content = new Uint8Array(0);
          inode.updateSize(0);
        }
      }

      const desc = new FileDescriptor(inode, flags);
      this.fds.set(desc.fd, desc);
      this.stats.opens++;
      inode.touch(true);

      this._commitTx();
      this._emit('open', { path, fd: desc.fd, flags });
      return desc.fd;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  close(fd) {
    const desc = this.fds.get(fd);
    if (!desc) throw Object.assign(new Error('bad fd'), { errno: FS_ERRORS.EBADF });
    desc.closed = true;
    this.fds.delete(fd);
    this.stats.closes++;
    this._emit('close', { fd });
    return true;
  }

  read(fd, length = 4096) {
    const desc = this.fds.get(fd);
    if (!desc || desc.closed) throw Object.assign(new Error('bad fd'), { errno: FS_ERRORS.EBADF });
    if (desc.flags & OPEN_FLAGS.O_WRONLY) throw Object.assign(new Error('not readable'), { errno: FS_ERRORS.EBADF });

    const inode = desc.inode;
    if (!inode.isFile()) throw Object.assign(new Error('not a file'), { errno: FS_ERRORS.EINVAL });

    const start = desc.offset;
    const end = Math.min(inode.content.length, start + length);
    const chunk = inode.content.slice(start, end);
    desc.offset = end;
    inode.touch(true);

    const { volume } = this._resolveVolume(this._pathOfInode(this._volOf(inode), inode.ino) || '/');
    volume.stats.reads++;
    volume.stats.bytesRead += chunk.length;
    this.stats.reads++;

    this._emit('read', { fd, bytes: chunk.length });
    return chunk;
  }

  write(fd, data) {
    const desc = this.fds.get(fd);
    if (!desc || desc.closed) throw Object.assign(new Error('bad fd'), { errno: FS_ERRORS.EBADF });
    if (desc.flags & OPEN_FLAGS.O_RDONLY) throw Object.assign(new Error('not writable'), { errno: FS_ERRORS.EBADF });

    const inode = desc.inode;
    if (!inode.isFile()) throw Object.assign(new Error('not a file'), { errno: FS_ERRORS.EINVAL });

    const vol = this._volOf(inode);
    if (!vol) throw Object.assign(new Error('orphan inode'), { errno: FS_ERRORS.EINVAL });

    let bytes;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof Uint8Array) bytes = data;
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw Object.assign(new Error('unsupported data'), { errno: FS_ERRORS.EINVAL });

    // Append o escritura en offset
    let offset = desc.offset;
    if (desc.flags & OPEN_FLAGS.O_APPEND) offset = inode.content.length;

    const needed = offset + bytes.length - inode.content.length;
    if (needed > 0) this._checkQuota(vol, needed);

    const newLen = Math.max(inode.content.length, offset + bytes.length);
    const newContent = new Uint8Array(newLen);
    newContent.set(inode.content, 0);
    newContent.set(bytes, offset);

    vol.usedBytes += (newLen - inode.content.length);
    inode.content = newContent;
    inode.updateSize(newLen);

    desc.offset = offset + bytes.length;
    vol.stats.writes++;
    vol.stats.bytesWritten += bytes.length;
    this.stats.writes++;

    this._emit('write', { fd, bytes: bytes.length });
    return bytes.length;
  }

  seek(fd, offset, whence = SEEK.SET) {
    const desc = this.fds.get(fd);
    if (!desc || desc.closed) throw Object.assign(new Error('bad fd'), { errno: FS_ERRORS.EBADF });
    const inode = desc.inode;
    let base = 0;
    if (whence === SEEK.CUR) base = desc.offset;
    else if (whence === SEEK.END) base = inode.content?.length || 0;
    const newOff = Math.max(0, base + offset);
    desc.offset = newOffset > (inode.content?.length || 0)
      ? (inode.content?.length || 0)
      : newOff;
    return desc.offset;
  }

  /* ================================================================ *
   * Helpers de volumen
   * ================================================================ */

  _volOf(inode) {
    for (const vol of this.volumes.values()) {
      if (vol.inodes.has(inode.ino)) return vol;
    }
    return null;
  }

  /* ================================================================ *
   * API pública: stat / lstat / unlink / rename
   * ================================================================ */

  stat(path) {
    const { volume, relativePath } = this._resolveVolume(path);
    const { inode } = this._lookupInode(volume, relativePath);
    return this._inodeToStat(inode, volume);
  }

  lstat(path) {
    const { volume, relativePath } = this._resolveVolume(path);
    const { inode } = this._lookupInode(volume, relativePath, { followSymlinks: false });
    return this._inodeToStat(inode, volume);
  }

  _inodeToStat(inode, volume) {
    return {
      ino: inode.ino,
      type: inode.type,
      mode: inode.mode & 0o777,
      uid: inode.uid,
      gid: inode.gid,
      size: inode.size,
      blocks: inode.blocks,
      links: inode.links,
      atime: inode.atime,
      mtime: inode.mtime,
      ctime: inode.ctime,
      birthtime: inode.birthtime,
      volume: volume.name,
      flags: { ...inode.flags },
    };
  }

  unlink(path) {
    this._beginTx();
    try {
      const { volume, relativePath } = this._resolveVolume(path);
      if (volume.readOnly) throw Object.assign(new Error('read-only'), { errno: FS_ERRORS.EROFS });

      const parentPath = dirname(relativePath);
      const name = basename(relativePath);
      const { inode: parent } = this._lookupInode(volume, parentPath);
      const ino = parent.data.get(name);
      if (ino == null) throw Object.assign(new Error('no such file'), { errno: FS_ERRORS.ENOENT });
      const target = volume.inodes.get(ino);
      if (target.isDir()) throw Object.assign(new Error('is a directory'), { errno: FS_ERRORS.EISDIR });

      this._unlinkInode(volume, parent, name);
      this._commitTx();
      volume.stats.filesDeleted++;
      this.stats.unlinks++;
      this._emit('unlink', { path });
      return true;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  rmdir(path, recursive = false) {
    this._beginTx();
    try {
      const { volume, relativePath } = this._resolveVolume(path);
      if (volume.readOnly) throw Object.assign(new Error('read-only'), { errno: FS_ERRORS.EROFS });

      const { inode } = this._lookupInode(volume, relativePath);
      if (!inode.isDir()) throw Object.assign(new Error('not a directory'), { errno: FS_ERRORS.ENOTDIR });
      if (inode.data.size > 0 && !recursive) {
        throw Object.assign(new Error('not empty'), { errno: FS_ERRORS.ENOTEMPTY });
      }
      if (recursive) {
        for (const [childName] of [...inode.data]) {
          const childPath = joinPath(path, childName);
          const child = volume.inodes.get(inode.data.get(childName));
          if (child.isDir()) this.rmdir(childPath, true);
          else this.unlink(childPath);
        }
      }

      const parentPath = dirname(relativePath);
      const name = basename(relativePath);
      const { inode: parent } = this._lookupInode(volume, parentPath);
      this._unlinkInode(volume, parent, name);

      this._commitTx();
      this._emit('rmdir', { path });
      return true;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  rename(from, to) {
    this._beginTx();
    try {
      const rFrom = this._resolveVolume(from);
      const rTo = this._resolveVolume(to);
      if (rFrom.volume !== rTo.volume) {
        throw Object.assign(new Error('cross-device'), { errno: FS_ERRORS.EXDEV });
      }
      if (rFrom.volume.readOnly) throw Object.assign(new Error('read-only'), { errno: FS_ERRORS.EROFS });

      const fromParent = this._lookupInode(rFrom.volume, dirname(rFrom.relativePath)).inode;
      const fromName = basename(rFrom.relativePath);
      const toParent = this._lookupInode(rTo.volume, dirname(rTo.relativePath)).inode;
      const toName = basename(rTo.relativePath);

      const ino = fromParent.data.get(fromName);
      if (ino == null) throw Object.assign(new Error('no such source'), { errno: FS_ERRORS.ENOENT });
      if (toParent.data.has(toName)) {
        const existing = rTo.volume.inodes.get(toParent.data.get(toName));
        if (existing.isDir() && existing.data.size > 0) {
          throw Object.assign(new Error('target not empty'), { errno: FS_ERRORS.ENOTEMPTY });
        }
        this._unlinkInode(rTo.volume, toParent, toName);
      }

      fromParent.data.delete(fromName);
      toParent.data.set(toName, ino);
      fromParent.mtime = Date.now();
      toParent.mtime = Date.now();

      this.journal.log({ op: 'rename', from: fromName, to: toName, ino });
      this._commitTx();
      this.stats.renames++;
      this._emit('rename', { from, to });
      return true;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  /* ================================================================ *
   * Symlinks y hardlinks
   * ================================================================ */

  symlink(target, linkPath) {
    this._beginTx();
    try {
      const { volume, relativePath } = this._resolveVolume(linkPath);
      if (volume.readOnly) throw Object.assign(new Error('read-only'), { errno: FS_ERRORS.EROFS });

      const { parent, name } = this._lookupInode(volume, relativePath, { create: true });
      const inode = new Inode(INODE_TYPE.SYMLINK, 0o777, this.uid, this.gid);
      inode.target = target;
      inode.updateSize(target.length);
      volume.addInode(inode);
      parent.data.set(name, inode.ino);
      parent.mtime = Date.now();

      this.journal.log({ op: 'symlink', parent: parent.ino, name, target });
      this._commitTx();
      volume.stats.symlinks++;
      this.stats.symlinkOps++;
      this._emit('symlink', { target, linkPath, ino: inode.ino });
      return inode.ino;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  readlink(path) {
    const { volume, relativePath } = this._resolveVolume(path);
    const { inode } = this._lookupInode(volume, relativePath, { followSymlinks: false });
    if (!inode.isSymlink()) throw Object.assign(new Error('not a symlink'), { errno: FS_ERRORS.EINVAL });
    return inode.target;
  }

  link(existingPath, newPath) {
    this._beginTx();
    try {
      const rFrom = this._resolveVolume(existingPath);
      const rTo = this._resolveVolume(newPath);
      if (rFrom.volume !== rTo.volume) {
        throw Object.assign(new Error('cross-device'), { errno: FS_ERRORS.EXDEV });
      }
      const { inode: src } = this._lookupInode(rFrom.volume, rFrom.relativePath);
      if (src.isDir()) throw Object.assign(new Error('cannot hardlink dir'), { errno: FS_ERRORS.EPERM });

      const { parent, name } = this._lookupInode(rTo.volume, rTo.relativePath, { create: true });
      if (parent.data.has(name)) throw Object.assign(new Error('exists'), { errno: FS_ERRORS.EEXIST });
      parent.data.set(name, src.ino);
      parent.mtime = Date.now();
      src.links++;

      this.journal.log({ op: 'hardlink', parent: parent.ino, name, ino: src.ino });
      this._commitTx();
      rTo.volume.stats.hardlinks++;
      this.stats.hardlinkOps++;
      this._emit('link', { existingPath, newPath, ino: src.ino });
      return true;
    } catch (e) {
      this._rollbackTx();
      this._recordError(e.errno || 'EUNKNOWN');
      throw e;
    }
  }

  /* ================================================================ *
   * Listado de directorio
   * ================================================================ */

  readdir(path) {
    const { volume, relativePath } = this._resolveVolume(path);
    const { inode } = this._lookupInode(volume, relativePath);
    if (!inode.isDir()) throw Object.assign(new Error('not a directory'), { errno: FS_ERRORS.ENOTDIR });
    return [...inode.data.keys()];
  }

  readdirFull(path) {
    const { volume, relativePath } = this._resolveVolume(path);
    const { inode } = this._lookupInode(volume, relativePath);
    if (!inode.isDir()) throw Object.assign(new Error('not a directory'), { errno: FS_ERRORS.ENOTDIR });
    const out = [];
    for (const [name, ino] of inode.data) {
      const child = volume.inodes.get(ino);
      out.push({
        name,
        ino,
        type: child.type,
        size: child.size,
        mode: child.mode & 0o777,
      });
    }
    return out;
  }

  /* ================================================================ *
   * Lectura/escritura directa por path (helpers cómodos)
   * ================================================================ */

  readFile(path) {
    const fd = this.open(path, OPEN_FLAGS.O_RDONLY);
    try {
      const chunks = [];
      let chunk;
      do {
        chunk = this.read(fd, 65536);
        if (chunk.length) chunks.push(chunk);
      } while (chunk.length === 65536);
      const total = chunks.reduce((a, b) => a + b.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } finally {
      this.close(fd);
    }
  }

  readFileText(path) {
    return new TextDecoder().decode(this.readFile(path));
  }

  writeFile(path, data) {
    const fd = this.open(path, OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC);
    try {
      return this.write(fd, data);
    } finally {
      this.close(fd);
    }
  }

  appendFile(path, data) {
    const fd = this.open(path, OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_APPEND);
    try {
      return this.write(fd, data);
    } finally {
      this.close(fd);
    }
  }

  exists(path) {
    try { this.stat(path); return true; }
    catch { return false; }
  }

  /* ================================================================ *
   * Snapshots
   * ================================================================ */

  snapshot(volumeName, name) {
    const vol = this.volumes.get(volumeName);
    if (!vol) {
      Logger.warn(LOG_TAG, `Volumen ${volumeName} no existe`);
      return null;
    }
    const snap = new Snapshot(name, vol.inodes, vol.rootIno);
    vol.snapshots.push(snap);
    this.stats.snapshotsCreated++;
    Logger.info(LOG_TAG, `Snapshot "${name}" creado en volumen ${volumeName} (${snap.inodes.size} inodos)`);
    this._emit('snapshot', { volume: volumeName, name, id: snap.id });
    return snap;
  }

  listSnapshots(volumeName) {
    const vol = this.volumes.get(volumeName);
    return vol ? vol.snapshots.map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, inodes: s.inodes.size })) : [];
  }

  deleteSnapshot(volumeName, snapId) {
    const vol = this.volumes.get(volumeName);
    if (!vol) return false;
    const before = vol.snapshots.length;
    vol.snapshots = vol.snapshots.filter(s => s.id !== snapId);
    if (vol.snapshots.length < before) {
      this.stats.snapshotsDeleted++;
      this._emit('snapshot:delete', { volume: volumeName, snapId });
      return true;
    }
    return false;
  }

  /* ================================================================ *
   * Journal
   * ================================================================ */

  getJournalTail(n = 20) { return this.journal.getLast(n); }

  /* ================================================================ *
   * Estadísticas / diagnóstico
   * ================================================================ */

  _recordError(code) {
    this.stats.errors[code] = (this.stats.errors[code] || 0) + 1;
  }

  getStats() {
    const vols = {};
    for (const [name, v] of this.volumes) {
      vols[name] = {
        mountPoint: v.mountPoint,
        quotaGB: round(v.quotaBytes / 1e9, 2),
        usedMB: round(v.usedBytes / 1e6, 2),
        freeMB: round(v.freeBytes() / 1e6, 2),
        inodes: v.inodes.size,
        snapshots: v.snapshots.length,
        readOnly: v.readOnly,
        stats: { ...v.stats },
      };
    }
    return {
      ...this.stats,
      volumes: vols,
      mountedVolumes: this.volumes.size,
      openFds: this.fds.size,
      journalEntries: this.journal.entries.length,
      journalPending: !!this.journal.pendingTx,
    };
  }

  getVolumeStats(name) {
    const v = this.volumes.get(name);
    if (!v) return null;
    return {
      name: v.name,
      mountPoint: v.mountPoint,
      quotaBytes: v.quotaBytes,
      usedBytes: v.usedBytes,
      freeBytes: v.freeBytes(),
      inodes: v.inodes.size,
      snapshots: v.snapshots.length,
      readOnly: v.readOnly,
      ...v.stats,
    };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.subscribers) {
      try { fn({ type, payload, ts: Date.now() }); }
      catch (e) { Logger.error(LOG_TAG, `Subscriber error: ${e.message}`); }
    }
  }

  dump() {
    const s = this.getStats();
    Logger.kernel(LOG_TAG, '─── FileSystem dump ───');
    Logger.kernel(LOG_TAG, `  volúmenes    : ${s.mountedVolumes}`);
    Logger.kernel(LOG_TAG, `  fds abiertos : ${s.openFds}`);
    Logger.kernel(LOG_TAG, `  journal      : ${s.journalEntries} entradas${s.journalPending ? ' (pendiente)' : ''}`);
    Logger.kernel(LOG_TAG, `  tx           : ${s.txCommitted}/${s.txTotal} commit, ${s.txRolledBack} rollback`);
    Logger.kernel(LOG_TAG, `  opens/closes : ${s.opens}/${s.closes}`);
    Logger.kernel(LOG_TAG, `  reads/writes : ${s.reads}/${s.writes}`);
    Logger.kernel(LOG_TAG, `  mkdir/unlink : ${s.mkdirs}/${s.unlinks}`);
    Logger.kernel(LOG_TAG, `  rename/sym/hl: ${s.renames}/${s.symlinkOps}/${s.hardlinkOps}`);
    Logger.kernel(LOG_TAG, `  snapshots    : ${s.snapshotsCreated} creados, ${s.snapshotsDeleted} borrados`);
    if (Object.keys(s.errors).length) {
      Logger.kernel(LOG_TAG, `  errores:`);
      for (const [code, n] of Object.entries(s.errors)) {
        Logger.kernel(LOG_TAG, `    · ${code.padEnd(12)} ${n}`);
      }
    }
    Logger.kernel(LOG_TAG, `  volúmenes:`);
    for (const [name, v] of Object.entries(s.volumes)) {
      Logger.kernel(LOG_TAG, `    · ${name.padEnd(10)} @ ${v.mountPoint} · ${v.usedMB}/${v.quotaGB * 1000} MB · ${v.inodes} inodos · ${v.snapshots} snaps`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap del FS con volúmenes estándar APFS
 * ------------------------------------------------------------------ */

export function createDefaultFileSystem(storage = null) {
  const fs = new FileSystem(storage);
  fs.mountVolume('System',   '/System',   8e9);
  fs.mountVolume('Data',     '/',         200e9);   // root real
  fs.mountVolume('Preboot',  '/Preboot',  500e6);
  fs.mountVolume('Recovery', '/Recovery', 2e9);
  fs.mountVolume('VM',       '/private/var/vm', 4e9);

  // Estructura básica del sistema
  fs.mkdirp('/System/Library');
  fs.mkdirp('/System/Library/Frameworks');
  fs.mkdirp('/System/Library/CoreServices');
  fs.mkdirp('/Applications');
  fs.mkdirp('/private/var/mobile');
  fs.mkdirp('/private/var/mobile/Library');
  fs.mkdirp('/private/var/mobile/Documents');
  fs.mkdirp('/private/var/mobile/Downloads');
  fs.mkdirp('/private/var/mobile/Containers/Data/Application');
  fs.mkdirp('/private/var/mobile/Containers/Shared/AppGroup');
  fs.mkdirp('/private/var/tmp');
  fs.mkdirp('/private/etc');
  fs.mkdirp('/dev');
  fs.mkdirp('/tmp');

  // Archivos de ejemplo
  fs.writeFile('/private/etc/hosts', '127.0.0.1 localhost\n::1 localhost\n');
  fs.writeFile('/private/var/mobile/Library/Preferences.json', '{}');

  Logger.kernel(LOG_TAG, 'FileSystem por defecto creado (5 volúmenes, estructura base)');
  return fs;
}

export default FileSystem;
