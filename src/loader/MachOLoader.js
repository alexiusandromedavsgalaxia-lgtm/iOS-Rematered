// src/loader/MachOLoader.js
// Cargador de Mach-O para iOS Remastered.
// - Acepta fat binary (universal) o thin Mach-O
// - Selecciona slice arm64/arm64e
// - Parse completo de load commands (segmentos, secciones, symtab, dyld info,
//   main, uuid, build version, encryption info, code signature, exports trie)
// - Mapeo a memoria virtual vía MemoryManager
// - Resolución de dylibs (cache + sistema simulado)
// - Rebase / Bind desde LC_DYLD_INFO y LC_DYLD_CHAINED_FIXUPS
// - Export trie parsing
// - Entry point desde LC_MAIN o LC_UNIXTHREAD
// - Entrega del LoadedImage al VCPU
// Sin dependencias externas.

import { Logger } from '../system/Logger.js';
import {
  BinaryReader, MachOError,
  readMachHeader, readFatHeader, readFatArch,
  readSegmentCommand64, readSymtabCommand, readDysymtabCommand,
  readDylibCommand, readUuidCommand, readDyldInfoCommand, readMainCommand,
  readLinkeditDataCommand, readSourceVersionCommand, readBuildVersionCommand,
  readRpathCommand, readDylinkerCommand, readEncryptionInfoCommand, readNlist64,
  MH_MAGIC_64, MH_CIGAM_64, MH_MAGIC, MH_CIGAM,
  MH_EXECUTE, MH_DYLIB, MH_BUNDLE, MH_OBJECT, MH_FILESET,
  FAT_MAGIC, FAT_MAGIC_64, FAT_CIGAM, FAT_CIGAM_64,
  LC_SEGMENT_64, LC_SYMTAB, LC_DYSYMTAB, LC_LOAD_DYLIB, LC_ID_DYLIB,
  LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB,
  LC_LOAD_DYLINKER, LC_ID_DYLINKER, LC_UUID, LC_RPATH,
  LC_DYLD_INFO, LC_DYLD_INFO_ONLY,
  LC_MAIN, LC_CODE_SIGNATURE, LC_SEGMENT_SPLIT_INFO, LC_FUNCTION_STARTS,
  LC_DATA_IN_CODE, LC_SOURCE_VERSION, LC_BUILD_VERSION,
  LC_VERSION_MIN_IPHONEOS, LC_VERSION_MIN_MACOSX, LC_VERSION_MIN_TVOS,
  LC_VERSION_MIN_WATCHOS, LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64,
  LC_DYLD_EXPORTS_TRIE, LC_DYLD_CHAINED_FIXUPS, LC_FILESET_ENTRY,
  LC_REQ_DYLD, LC_NAMES,
  CPU_TYPE_ARM64, CPU_TYPE_ARM64_32, CPU_TYPE_X86_64,
  CPU_SUBTYPE_ARM64E,
  VM_PROT_READ, VM_PROT_WRITE, VM_PROT_EXECUTE,
  REBASE_OPCODE_MASK, REBASE_IMMEDIATE_MASK,
  REBASE_OPCODE_DONE, REBASE_OPCODE_SET_TYPE_IMM,
  REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB,
  REBASE_OPCODE_ADD_ADDR_ULEB, REBASE_OPCODE_ADD_ADDR_IMM_SCALED,
  REBASE_OPCODE_DO_REBASE_IMM_TIMES,
  REBASE_OPCODE_DO_REBASE_ULEB_TIMES,
  REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB,
  REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB,
  BIND_OPCODE_MASK, BIND_IMMEDIATE_MASK,
  BIND_OPCODE_DONE, BIND_OPCODE_SET_DYLIB_ORDINAL_IMM,
  BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB, BIND_OPCODE_SET_DYLIB_SPECIAL_IMM,
  BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM, BIND_OPCODE_SET_TYPE_IMM,
  BIND_OPCODE_SET_ADDEND_SLEB, BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB,
  BIND_OPCODE_ADD_ADDR_ULEB, BIND_OPCODE_DO_BIND,
  BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB,
  BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED,
  BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB,
  BIND_OPCODE_THREADED,
  BIND_TYPE_POINTER, BIND_SPECIAL_DYLIB_SELF,
  BIND_SPECIAL_DYLIB_MAIN_EXECUTABLE, BIND_SPECIAL_DYLIB_FLAT_LOOKUP,
  EXPORT_SYMBOL_FLAGS_KIND_MASK, EXPORT_SYMBOL_FLAGS_KIND_REGULAR,
  EXPORT_SYMBOL_FLAGS_KIND_THREAD_LOCAL, EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE,
  EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION, EXPORT_SYMBOL_FLAGS_REEXPORT,
  EXPORT_SYMBOL_FLAGS_STUB_AND_RESOLVER,
  S_REGULAR, S_ZEROFILL, S_CSTRING_LITERALS, S_NON_LAZY_SYMBOL_POINTERS,
  S_LAZY_SYMBOL_POINTERS, S_SYMBOL_STUBS, S_MOD_INIT_FUNC_POINTERS,
  S_MOD_TERM_FUNC_POINTERS, S_THREAD_LOCAL_REGULAR,
  N_STAB, N_PEXT, N_TYPE, N_EXT,
  N_UNDF, N_ABS, N_SECT, N_PBUD, N_INDR,
  formatVersion, cputypeName, filetypeName, lcName, decodeProtection,
  PLATFORM_NAMES,
} from './MachOStructures.js';

const LOG_TAG = 'MACHO';

/* ------------------------------------------------------------------ *
 * Constantes del cargador
 * ------------------------------------------------------------------ */

export const LOADER_STATE = {
  IDLE:       'idle',
  PARSING:    'parsing',
  MAPPING:    'mapping',
  LINKING:    'linking',
  RELOCATING: 'relocating',
  READY:      'ready',
  FAILED:     'failed',
};

export const LOAD_ERRORS = {
  BAD_MAGIC:          'EMACHO_BAD_MAGIC',
  BAD_HEADER:         'EMACHO_BAD_HEADER',
  NO_ARM64_SLICE:     'EMACHO_NO_ARM64',
  BAD_LOAD_COMMAND:   'EMACHO_BAD_LC',
  MISSING_SEGMENT:    'EMACHO_MISSING_SEGMENT',
  MISSING_ENTRY:      'EMACHO_MISSING_ENTRY',
  UNRESOLVED_SYMBOL:  'EMACHO_UNRESOLVED_SYMBOL',
  UNRESOLVED_DYLIB:   'EMACHO_UNRESOLVED_DYLIB',
  ENOMEM:             'EMACHO_NOMEM',
  INVALID_OPCODE:     'EMACHO_INVALID_OPCODE',
  DYLIB_CYCLE:        'EMACHO_DYLIB_CYCLE',
  ENCRYPTED:          'EMACHO_ENCRYPTED',
  NOT_IMPLEMENTED:    'EMACHO_NOT_IMPLEMENTED',
  GENERIC:            'EMACHO_GENERIC',
};

// Dirección base por defecto para iOS arm64
export const DEFAULT_IMAGE_BASE = 0x100000000n;

// Tamaño de página del sistema
const PAGE_SIZE = 0x4000;   // 16KB en arm64 iOS

// Ruta por defecto del dyld shared cache (simulada)
const DYLD_SHARED_CACHE = '/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64e';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function uid() {
  return 'mh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function now() { return Date.now(); }
function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
function hex(v, pad = 8) {
  if (typeof v === 'bigint') return '0x' + v.toString(16).padStart(pad, '0');
  return '0x' + Number(v).toString(16).padStart(pad, '0');
}
function align(v, a) {
  const n = BigInt(a);
  const x = typeof v === 'bigint' ? v : BigInt(v);
  return (x + n - 1n) & ~(n - 1n);
}
function makeError(code, msg, extra = {}) {
  const e = new Error(msg || code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/* ------------------------------------------------------------------ *
 * Dylib stub registry — "cache" de librerías del sistema
 * ------------------------------------------------------------------ */

class SystemDylibRegistry {
  constructor() {
    this.dylibs = new Map();          // installName → { exports: Map<name,addr>, fake: true }
    this._initStandardLibrary();
  }

  _initStandardLibrary() {
    // Librerías típicas de iOS
    const std = [
      '/usr/lib/libSystem.B.dylib',
      '/usr/lib/libobjc.A.dylib',
      '/usr/lib/libc++.1.dylib',
      '/usr/lib/libz.1.dylib',
      '/System/Library/Frameworks/Foundation.framework/Foundation',
      '/System/Library/Frameworks/UIKit.framework/UIKit',
      '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
      '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',
      '/System/Library/Frameworks/SwiftUI.framework/SwiftUI',
      '/System/Library/Frameworks/Combine.framework/Combine',
      '/usr/lib/swift/libswiftCore.dylib',
      '/usr/lib/swift/libswiftFoundation.dylib',
      '/usr/lib/swift/libswiftDispatch.dylib',
      '/usr/lib/swift/libswiftos.dylib',
    ];
    for (const name of std) {
      this.dylibs.set(name, {
        installName: name,
        exports: new Map(),
        fake: true,
        base: DEFAULT_IMAGE_BASE + BigInt(this.dylibs.size + 1) * 0x400000n,
      });
    }
    // Algunos exports conocidos (direcciones ficticias)
    this._addExports('/usr/lib/libSystem.B.dylib', [
      'malloc', 'free', 'realloc', 'memcpy', 'memset', 'strlen', 'printf', 'puts',
      'exit', 'abort', 'write', 'read', 'open', 'close',
    ]);
    this._addExports('/usr/lib/libobjc.A.dylib', [
      'objc_msgSend', 'objc_release', 'objc_retain', 'objc_autorelease',
      'class_getName', 'object_getClass', 'sel_registerName',
    ]);
    this._addExports('/System/Library/Frameworks/Foundation.framework/Foundation', [
      'NSLog', 'NSStringFromClass', 'NSClassFromString',
      'objc_autoreleasePoolPush', 'objc_autoreleasePoolPop',
    ]);
    this._addExports('/System/Library/Frameworks/UIKit.framework/UIKit', [
      'UIApplicationMain', 'UIGraphicsBeginImageContext',
    ]);
    this._addExports('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', [
      'CFRelease', 'CFRetain', 'CFArrayCreate', 'CFDictionaryCreate',
    ]);
  }

  _addExports(lib, symbols) {
    const d = this.dylibs.get(lib);
    if (!d) return;
    let addr = d.base;
    for (const s of symbols) {
      d.exports.set(s, addr);
      addr += 0x40n;
    }
  }

  has(installName) { return this.dylibs.has(installName); }

  get(installName) { return this.dylibs.get(installName) || null; }

  // Busca un símbolo en cualquier dylib
  findSymbol(name) {
    for (const d of this.dylibs.values()) {
      if (d.exports.has(name)) return { lib: d.installName, addr: d.exports.get(name) };
    }
    return null;
  }

  register(installName, exports = []) {
    const d = {
      installName,
      exports: new Map(),
      fake: true,
      base: DEFAULT_IMAGE_BASE + BigInt(this.dylibs.size + 1) * 0x400000n,
    };
    let addr = d.base;
    for (const s of exports) {
      d.exports.set(s, addr);
      addr += 0x40n;
    }
    this.dylibs.set(installName, d);
    return d;
  }

  list() { return [...this.dylibs.keys()]; }
}

/* ------------------------------------------------------------------ *
 * Estructuras cargadas
 * ------------------------------------------------------------------ */

class LoadedSegment {
  constructor(seg) {
    this.name = seg.segname;
    this.vmaddr = seg.vmaddr;
    this.vmsize = seg.vmsize;
    this.fileoff = BigInt(seg.fileoff);
    this.filesize = BigInt(seg.filesize);
    this.maxprot = seg.maxprot;
    this.initprot = seg.initprot;
    this.sections = seg.sections.map(s => new LoadedSection(s));
    this.data = null;   // Uint8Array con el contenido (después del mapping)
    this.mappedAt = null;
  }
}

class LoadedSection {
  constructor(s) {
    this.sectname = s.sectname;
    this.segname = s.segname;
    this.addr = s.addr;
    this.size = s.size;
    this.offset = s.offset;
    this.align = s.align;
    this.flags = s.flags;
    this.type = s.flags & 0xff;
    this.attrs = s.flags & 0xffffff00;
  }

  get qualifiedName() { return `${this.segname},${this.sectname}`; }
  contains(addr) {
    return addr >= this.addr && addr < this.addr + this.size;
  }
}

class LoadedDylib {
  constructor(name, cmd, path) {
    this.name = name;
    this.cmd = cmd;             // LC_LOAD_DYLIB, LC_REEXPORT_DYLIB, etc.
    this.path = path;
    this.currentVersion = cmd.currentVersion;
    this.compatibilityVersion = cmd.compatibilityVersion;
    this.weak = cmd === LC_LOAD_WEAK_DYLIB;
    this.reexported = cmd === LC_REEXPORT_DYLIB;
    this.resolved = false;
    this.registryEntry = null;
  }
}

class LoadedImage {
  constructor(opts) {
    this.id = uid();
    this.path = opts.path || '<memory>';
    this.filetype = opts.filetype;
    this.cputype = opts.cputype;
    this.cpusubtype = opts.cpusubtype;
    this.flags = opts.flags;
    this.ncmds = opts.ncmds;
    this.sizeofcmds = opts.sizeofcmds;
    this.uuid = opts.uuid || null;
    this.platform = opts.platform || 'iOS';
    this.minOS = opts.minOS || '17.0';
    this.sdk = opts.sdk || this.minOS;
    this.sourceVersion = opts.sourceVersion || null;

    this.segments = [];         // LoadedSegment[]
    this.sections = [];         // LoadedSection[]
    this.symbols = [];          // { name, type, sect, desc, value }
    this.dylibs = [];           // LoadedDylib[]
    this.rpaths = [];
    this.dylinker = null;

    this.dyldInfo = null;
    this.rebaseOpcodes = null;
    this.bindOpcodes = null;
    this.weakBindOpcodes = null;
    this.lazyBindOpcodes = null;
    this.exportsTrie = null;

    this.codeSignature = null;
    this.encryptionInfo = null;

    this.imageBase = DEFAULT_IMAGE_BASE;
    this.entryPoint = null;       // dirección absoluta
    this.entryOffset = null;      // offset relativo a imageBase
    this.stackSize = 0;

    this.globalSymbols = new Map();     // name → { addr, lib, weak, kind }
    this.localSymbols = new Map();
    this.bindings = [];                 // { addr, symbol, dylibOrdinal, addend, type }

    this.rebasesApplied = 0;
    this.bindsApplied = 0;
    this.chainedFixupsApplied = 0;

    this.loadedAt = now();
    this.state = LOADER_STATE.IDLE;
    this.sizeOnDisk = 0;
    this.sizeInMemory = 0n;
  }

  toMetadata() {
    return {
      id: this.id,
      path: this.path,
      filetype: filetypeName(this.filetype),
      cputype: cputypeName(this.cputype),
      platform: this.platform,
      minOS: this.minOS,
      sdk: this.sdk,
      uuid: this.uuid,
      sourceVersion: this.sourceVersion,
      imageBase: hex(this.imageBase, 12),
      entryPoint: this.entryPoint != null ? hex(this.entryPoint, 12) : null,
      entryOffset: this.entryOffset != null ? hex(this.entryOffset) : null,
      stackSize: this.stackSize,
      segments: this.segments.map(s => ({
        name: s.name,
        vmaddr: hex(s.vmaddr, 12),
        vmsize: hex(s.vmsize),
        fileoff: Number(s.fileoff),
        filesize: Number(s.filesize),
        prot: decodeProtection(s.initprot),
        sections: s.sections.map(x => `${x.segname},${x.sectname}`),
      })),
      dylibs: this.dylibs.map(d => ({
        path: d.path,
        weak: d.weak,
        reexported: d.reexported,
        resolved: d.resolved,
      })),
      rpaths: this.rpaths,
      symbols: {
        total: this.symbols.length,
        global: this.globalSymbols.size,
        local: this.localSymbols.size,
        undefined: this.symbols.filter(s => s.type === N_UNDF && (s.type & N_EXT)).length,
      },
      relocations: {
        rebases: this.rebasesApplied,
        binds: this.bindsApplied,
        chainedFixups: this.chainedFixupsApplied,
      },
      sizeOnDisk: this.sizeOnDisk,
      sizeInMemory: Number(this.sizeInMemory),
      state: this.state,
    };
  }

  // Encuentra la sección que contiene una dirección
  findSection(addr) {
    for (const s of this.sections) if (s.contains(addr)) return s;
    return null;
  }

  // Encuentra el segmento que contiene una dirección
  findSegment(addr) {
    for (const s of this.segments) {
      if (addr >= s.vmaddr && addr < s.vmaddr + s.vmsize) return s;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Clase principal
 * ------------------------------------------------------------------ */

export class MachOLoader {
  constructor(opts = {}) {
    this.memory = opts.memory || null;    // MemoryManager
    this.fs = opts.fs || null;            // FileSystem
    this.vcpu = opts.vcpu || null;        // VCPU
    this.systemDylibs = opts.systemDylibs || new SystemDylibRegistry();

    this.images = new Map();              // id → LoadedImage
    this.byPath = new Map();              // path → id
    this.byUuid = new Map();              // uuid → id

    this.state = LOADER_STATE.IDLE;
    this.subscribers = new Set();

    this.stats = {
      loaded: 0,
      failed: 0,
      fatSlices: 0,
      thinImages: 0,
      bytesMapped: 0,
      rebasesApplied: 0,
      bindsApplied: 0,
      dylibResolutions: 0,
      dylibMisses: 0,
      loadCommandsParsed: 0,
      symbolsParsed: 0,
    };

    Logger.debug(LOG_TAG, 'MachOLoader instanciado');
  }

  /* ================================================================ *
   * API principal
   * ================================================================ */

  /**
   * Carga un Mach-O desde distintas fuentes:
   * - Uint8Array (bytes crudos)
   * - string (path en FS)
   * - { path, bytes } (mixto)
   * - LoadedImage (ya cargada, no-op)
   */
  load(source, opts = {}) {
    this.state = LOADER_STATE.PARSING;
    const t0 = now();
    try {
      const { bytes, path } = this._resolveSource(source);

      // 1) Detectar fat vs thin
      const first = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      let image;

      if (first === FAT_MAGIC || first === FAT_MAGIC_64 || first === FAT_CIGAM || first === FAT_CIGAM_64) {
        this.stats.fatSlices++;
        image = this._loadFat(bytes, path, opts);
      } else if (first === MH_MAGIC_64 || first === MH_CIGAM_64 || first === MH_MAGIC || first === MH_CIGAM) {
        this.stats.thinImages++;
        image = this._loadThin(bytes, path, opts);
      } else {
        throw makeError(LOAD_ERRORS.BAD_MAGIC, `magic desconocido: ${hex(first)}`);
      }

      // 2) Mapear segmentos a memoria virtual
      this.state = LOADER_STATE.MAPPING;
      this._mapSegments(image);

      // 3) Resolver dylibs
      this.state = LOADER_STATE.LINKING;
      this._resolveDylibs(image);

      // 4) Rebase / Bind
      this.state = LOADER_STATE.RELOCATING;
      this._applyRebases(image);
      this._applyBinds(image);

      // 5) Entry point
      this._computeEntry(image, opts);

      // 6) Registrar
      image.state = LOADER_STATE.READY;
      image.loadedAt = now();
      image.loadDurationMs = image.loadedAt - t0;
      this.images.set(image.id, image);
      this.byPath.set(image.path, image.id);
      if (image.uuid) this.byUuid.set(image.uuid, image.id);

      this.stats.loaded++;
      this.stats.bytesMapped += Number(image.sizeInMemory);
      this.state = LOADER_STATE.IDLE;

      Logger.info(LOG_TAG,
        `Cargado ${path} — ${image.segments.length} segmentos, ` +
        `${image.symbols.length} símbolos, entry ${hex(image.entryPoint ?? 0n, 12)}, ` +
        `${round(image.loadDurationMs, 2)}ms`
      );
      this._emit('loaded', image.toMetadata());
      return image;
    } catch (e) {
      this.stats.failed++;
      this.state = LOADER_STATE.FAILED;
      Logger.error(LOG_TAG, `load falló: ${e.code || ''} ${e.message}`);
      this._emit('failed', { error: { code: e.code || LOAD_ERRORS.GENERIC, message: e.message } });
      throw e;
    }
  }

  unload(id) {
    const image = this.images.get(id);
    if (!image) return false;
    // Liberar memoria de cada segmento
    if (this.memory) {
      for (const seg of image.segments) {
        if (seg.mappedAt != null && seg.vmsize > 0n) {
          try {
            this.memory.free(seg.mappedAt, Number(seg.vmsize), `macho:${image.id}`);
          } catch {}
        }
      }
    }
    this.images.delete(id);
    this.byPath.delete(image.path);
    if (image.uuid) this.byUuid.delete(image.uuid);
    Logger.debug(LOG_TAG, `Imagen descargada: ${image.path}`);
    this._emit('unloaded', { id, path: image.path });
    return true;
  }

  get(id) { return this.images.get(id) || null; }
  getByPath(path) {
    const id = this.byPath.get(path);
    return id ? this.images.get(id) : null;
  }
  getByUuid(uuid) {
    const id = this.byUuid.get(uuid);
    return id ? this.images.get(id) : null;
  }
  list() { return [...this.images.values()]; }

  /* ================================================================ *
   * Resolución de fuente
   * ================================================================ */

  _resolveSource(source) {
    if (source instanceof LoadedImage) {
      throw makeError(LOAD_ERRORS.GENERIC, 'ya cargada');
    }
    if (source instanceof Uint8Array) {
      return { bytes: source, path: '<memory>' };
    }
    if (typeof source === 'string') {
      if (!this.fs) throw makeError(LOAD_ERRORS.GENERIC, 'sin FS');
      const bytes = this.fs.readFile(source);
      return { bytes, path: source };
    }
    if (source && source.bytes instanceof Uint8Array) {
      return { bytes: source.bytes, path: source.path || '<memory>' };
    }
    throw makeError(LOAD_ERRORS.GENERIC, 'fuente no soportada');
  }

  /* ================================================================ *
   * Fat binary
   * ================================================================ */

  _loadFat(bytes, path, opts) {
    const reader = new BinaryReader(bytes);
    const hdr = readFatHeader(reader);
    const slices = [];
    for (let i = 0; i < hdr.nfat; i++) {
      slices.push(readFatArch(reader, hdr.is64));
    }

    // Elegir slice preferida
    const preferred = opts.arch
      ? this._findSliceForArch(slices, opts.arch)
      : this._pickBestSlice(slices);

    if (!preferred) {
      throw makeError(LOAD_ERRORS.NO_ARM64_SLICE,
        `sin slice compatible (disponibles: ${slices.map(s => cputypeName(s.cputype)).join(', ')})`);
    }

    const off = Number(preferred.offset);
    const size = Number(preferred.size);
    const sliceBytes = bytes.subarray(off, off + size);
    Logger.debug(LOG_TAG,
      `Fat: elegido slice ${cputypeName(preferred.cputype)}/${preferred.cpusubtype} ` +
      `(${size} bytes @ offset ${off})`
    );
    return this._loadThin(sliceBytes, path, opts);
  }

  _findSliceForArch(slices, arch) {
    // arch puede ser "arm64", "arm64e", "x86_64"
    return slices.find(s => {
      if (arch === 'arm64' && s.cputype === CPU_TYPE_ARM64) return true;
      if (arch === 'arm64e' && s.cputype === CPU_TYPE_ARM64 && s.cpusubtype === CPU_SUBTYPE_ARM64E) return true;
      if (arch === 'x86_64' && s.cputype === CPU_TYPE_X86_64) return true;
      return false;
    });
  }

  _pickBestSlice(slices) {
    // Preferimos arm64e > arm64 > x86_64 > primero
    const arm64e = slices.find(s => s.cputype === CPU_TYPE_ARM64 && s.cpusubtype === CPU_SUBTYPE_ARM64E);
    if (arm64e) return arm64e;
    const arm64 = slices.find(s => s.cputype === CPU_TYPE_ARM64);
    if (arm64) return arm64;
    const x64 = slices.find(s => s.cputype === CPU_TYPE_X86_64);
    if (x64) return x64;
    return slices[0];
  }

  /* ================================================================ *
   * Mach-O thin: parseo completo
   * ================================================================ */

  _loadThin(bytes, path, opts) {
    const reader = new BinaryReader(bytes);
    const hdr = readMachHeader(reader);

    if (!hdr.is64) {
      throw makeError(LOAD_ERRORS.BAD_HEADER, 'solo Mach-O 64-bit soportado');
    }
    if (hdr.filetype === MH_FILESET) {
      throw makeError(LOAD_ERRORS.NOT_IMPLEMENTED, 'fileset no soportado (extraer antes)');
    }

    const image = new LoadedImage({
      path,
      filetype: hdr.filetype,
      cputype: hdr.cputype,
      cpusubtype: hdr.cpusubtype,
      flags: hdr.flags,
      ncmds: hdr.ncmds,
      sizeofcmds: hdr.sizeofcmds,
      sizeOnDisk: bytes.length,
    });

    this._parseLoadCommands(reader, hdr, image, bytes);

    if (!image.entryPoint && !image.entryOffset && image.filetype === MH_EXECUTE) {
      // LC_MAIN faltante: puede ser LC_UNIXTHREAD (no soportado aquí)
      Logger.warn(LOG_TAG, `${path}: sin LC_MAIN en ejecutable`);
    }

    return image;
  }

  _parseLoadCommands(reader, hdr, image, bytes) {
    const cmdStart = reader.pos;
    const cmdEnd = cmdStart + hdr.sizeofcmds;
    let p = cmdStart;
    let count = 0;

    // Guardamos el file bytes para extraer bloques (symtab, dyld info, etc.)
    image.__fileBytes = bytes;

    while (p < cmdEnd && count < hdr.ncmds) {
      reader.seek(p);
      const cmd = reader.u32();
      const cmdsize = reader.u32();
      if (cmdsize < 8) {
        throw makeError(LOAD_ERRORS.BAD_LOAD_COMMAND, `cmdsize inválido en LC 0x${cmd.toString(16)}`);
      }

      switch (cmd) {
        case LC_SEGMENT_64: {
          const seg = readSegmentCommand64(reader);
          const ls = new LoadedSegment(seg);
          image.segments.push(ls);
          image.sections.push(...ls.sections);
          break;
        }
        case LC_SYMTAB: {
          const sym = readSymtabCommand(reader);
          this._parseSymtab(image, sym, bytes);
          break;
        }
        case LC_DYSYMTAB: {
          const ds = readDysymtabCommand(reader);
          image.__dysymtab = ds;
          break;
        }
        case LC_DYLD_INFO:
        case LC_DYLD_INFO_ONLY: {
          const info = readDyldInfoCommand(reader);
          image.dyldInfo = info;
          break;
        }
        case LC_LOAD_DYLIB:
        case LC_LOAD_WEAK_DYLIB:
        case LC_REEXPORT_DYLIB:
        case LC_LOAD_UPWARD_DYLIB:
        case LC_ID_DYLIB: {
          const d = readDylibCommand(reader);
          image.dylibs.push(new LoadedDylib(cmd, cmd, d.name));
          break;
        }
        case LC_LOAD_DYLINKER:
        case LC_ID_DYLINKER: {
          const d = readDylinkerCommand(reader);
          image.dylinker = d.name;
          break;
        }
        case LC_UUID: {
          const u = readUuidCommand(reader);
          image.uuid = u.uuid;
          break;
        }
        case LC_RPATH: {
          const r = readRpathCommand(reader);
          image.rpaths.push(r.path);
          break;
        }
        case LC_MAIN: {
          const m = readMainCommand(reader);
          image.entryOffset = m.entryoff;
          image.stackSize = Number(m.stacksize);
          break;
        }
        case LC_CODE_SIGNATURE:
        case LC_SEGMENT_SPLIT_INFO:
        case LC_FUNCTION_STARTS:
        case LC_DATA_IN_CODE:
        case LC_DYLD_EXPORTS_TRIE: {
          const d = readLinkeditDataCommand(reader);
          if (cmd === LC_CODE_SIGNATURE) image.codeSignature = d;
          else if (cmd === LC_FUNCTION_STARTS) image.__functionStarts = d;
          else if (cmd === LC_DATA_IN_CODE) image.__dataInCode = d;
          else if (cmd === LC_DYLD_EXPORTS_TRIE) image.exportsTrie = d;
          else image.__segmentSplitInfo = d;
          break;
        }
        case LC_DYLD_CHAINED_FIXUPS: {
          const d = readLinkeditDataCommand(reader);
          image.__chainedFixups = d;
          break;
        }
        case LC_SOURCE_VERSION: {
          const sv = readSourceVersionCommand(reader);
          image.sourceVersion = formatVersion(sv.version);
          break;
        }
        case LC_BUILD_VERSION: {
          const b = readBuildVersionCommand(reader);
          image.platform = PLATFORM_NAMES[b.platform] || `plat(${b.platform})`;
          image.minOS = formatVersion(b.minos);
          image.sdk = formatVersion(b.sdk);
          image.__buildVersion = b;
          break;
        }
        case LC_VERSION_MIN_IPHONEOS:
        case LC_VERSION_MIN_MACOSX:
        case LC_VERSION_MIN_TVOS:
        case LC_VERSION_MIN_WATCHOS: {
          const plat = cmd === LC_VERSION_MIN_IPHONEOS ? 'iOS'
                     : cmd === LC_VERSION_MIN_MACOSX ? 'macOS'
                     : cmd === LC_VERSION_MIN_TVOS ? 'tvOS' : 'watchOS';
          reader.u32(); // version
          reader.u32(); // sdk
          image.platform = plat;
          break;
        }
        case LC_ENCRYPTION_INFO:
        case LC_ENCRYPTION_INFO_64: {
          const e = readEncryptionInfoCommand(reader, cmd === LC_ENCRYPTION_INFO_64);
          image.encryptionInfo = e;
          if (e.cryptid !== 0) {
            Logger.warn(LOG_TAG, `${image.path}: imagen cifrada (cryptid=${e.cryptid})`);
          }
          break;
        }
        case LC_FILESET_ENTRY: {
          // Leemos y descartamos (no soportamos fileset)
          reader.u32(); reader.u32(); reader.u32(); // vmaddr, fileoff, entry_id_offset
          reader.u32(); // reserved

          -- UNENDED
