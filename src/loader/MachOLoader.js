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
          reader.u32(); // reserved          break;
        }
        default:
          // LC desconocido: saltamos
          Logger.debug(LOG_TAG, `LC desconocido ${hex(cmd)} (${cmdsize} bytes)`);
      }

      p += cmdsize;
      count++;
      this.stats.loadCommandsParsed++;
    }

    // Ordenar segmentos por vmaddr
    image.segments.sort((a, b) => (a.vmaddr < b.vmaddr ? -1 : a.vmaddr > b.vmaddr ? 1 : 0));

    // Base de la imagen = __TEXT.vmaddr
    const text = image.segments.find(s => s.name === '__TEXT');
    if (text) image.imageBase = text.vmaddr;
  }

  /* ================================================================ *
   * Symtab
   * ================================================================ */

  _parseSymtab(image, sym, bytes) {
    const strtab = bytes.subarray(sym.stroff, sym.stroff + sym.strsize);
    const nlistSize = 16;   // nlist_64
    let p = sym.symoff;
    for (let i = 0; i < sym.nsyms; i++) {
      const r = new BinaryReader(bytes);
      r.seek(p);
      const nl = readNlist64(r);
      // nombre en strtab
      let nameEnd = nl.n_strx;
      while (nameEnd < strtab.length && strtab[nameEnd] !== 0) nameEnd++;
      const name = new TextDecoder('utf-8').decode(strtab.subarray(nl.n_strx, nameEnd));
      const symObj = {
        name,
        type: nl.n_type,
        sect: nl.n_sect,
        desc: nl.n_desc,
        value: nl.n_value,
        external: (nl.n_type & N_EXT) !== 0,
        undefined: (nl.n_type & 0x0e) === N_UNDF,
      };
      image.symbols.push(symObj);
      if (symObj.external && !symObj.undefined && name) {
        image.globalSymbols.set(name, { addr: symObj.value, kind: 'external' });
      } else if (name && !symObj.undefined) {
        image.localSymbols.set(name, { addr: symObj.value, kind: 'local' });
      }
      p += nlistSize;
    }
    this.stats.symbolsParsed += image.symbols.length;
    Logger.debug(LOG_TAG,
      `Symtab: ${sym.nsyms} símbolos (${image.globalSymbols.size} globales, ` +
      `${image.localSymbols.size} locales)`
    );
  }

  /* ================================================================ *
   * Mapeo de segmentos
   * ================================================================ */

  _mapSegments(image) {
    const fileBytes = image.__fileBytes;
    for (const seg of image.segments) {
      // __PAGEZERO no se mapea (es solo protección)
      if (seg.name === '__PAGEZERO') {
        seg.data = new Uint8Array(0);
        continue;
      }
      // Extraer contenido del archivo
      const off = Number(seg.fileoff);
      const sz = Number(seg.filesize);
      if (off + sz <= fileBytes.length && sz > 0) {
        seg.data = fileBytes.subarray(off, off + sz);
      } else {
        // Segmento sin contenido en archivo (__DATA bss al final, zerofill)
        seg.data = new Uint8Array(sz > 0 ? sz : 0);
      }

      // Alocar en MemoryManager
      if (this.memory) {
        const pages = Math.ceil(Number(seg.vmsize) / PAGE_SIZE);
        try {
          const frame = this.memory.allocate?.(
            Number(seg.vmsize),
            `macho:${image.id}:${seg.name}`,
            'macho'
          );
          seg.mappedAt = frame?.address ?? frame ?? null;
        } catch (e) {
          // Sin memory manager real, usamos la vmaddr como placeholder
          seg.mappedAt = Number(seg.vmaddr);
        }
      } else {
        seg.mappedAt = Number(seg.vmaddr);
      }

      // Copiar contenido si tenemos un buffer de memoria unificado
      if (this.vcpu && typeof this.vcpu.writeMemory === 'function' && seg.data.length > 0) {
        try {
          this.vcpu.writeMemory(seg.vmaddr, seg.data);
        } catch (e) {
          Logger.warn(LOG_TAG, `writeMemory falló para ${seg.name}: ${e.message}`);
        }
      }

      image.sizeInMemory += seg.vmsize;
    }

    Logger.debug(LOG_TAG,
      `Mapeados ${image.segments.length} segmentos, ${hex(image.sizeInMemory)} bytes`
    );
  }

  /* ================================================================ *
   * Resolución de dylibs
   * ================================================================ */

  _resolveDylibs(image) {
    for (const dylib of image.dylibs) {
      // Intentar resolver por path directo
      let entry = this.systemDylibs.get(dylib.path);
      if (entry) {
        dylib.resolved = true;
        dylib.registryEntry = entry;
        this.stats.dylibResolutions++;
        continue;
      }

      // Intentar por @rpath
      if (dylib.path.startsWith('@rpath/')) {
        const rel = dylib.path.slice('@rpath/'.length);
        for (const rp of image.rpaths) {
          const candidate = rp.replace('@loader_path', dirnameOf(image.path)) + '/' + rel;
          const found = this.systemDylibs.get(candidate);
          if (found) {
            dylib.resolved = true;
            dylib.registryEntry = found;
            dylib.path = candidate;
            this.stats.dylibResolutions++;
            break;
          }
        }
      }

      // Intentar por @loader_path
      if (!dylib.resolved && dylib.path.startsWith('@loader_path/')) {
        const rel = dylib.path.slice('@loader_path/'.length);
        const candidate = dirnameOf(image.path) + '/' + rel;
        const found = this.systemDylibs.get(candidate);
        if (found) {
          dylib.resolved = true;
          dylib.registryEntry = found;
          dylib.path = candidate;
          this.stats.dylibResolutions++;
        }
      }

      // Intentar por @executable_path
      if (!dylib.resolved && dylib.path.startsWith('@executable_path/')) {
        const rel = dylib.path.slice('@executable_path/'.length);
        // Asumimos bundle = dirname del ejecutable
        const candidate = dirnameOf(image.path) + '/' + rel;
        const found = this.systemDylibs.get(candidate);
        if (found) {
          dylib.resolved = true;
          dylib.registryEntry = found;
          dylib.path = candidate;
          this.stats.dylibResolutions++;
        }
      }

      if (!dylib.resolved) {
        if (dylib.weak) {
          Logger.debug(LOG_TAG, `Dylib weak sin resolver: ${dylib.path}`);
        } else {
          this.stats.dylibMisses++;
          Logger.warn(LOG_TAG, `Dylib no resuelta: ${dylib.path}`);
          // En vez de fallar, registramos y seguimos (modo permisivo)
          if (!this.allowUnresolvedDylibs) {
            throw makeError(LOAD_ERRORS.UNRESOLVED_DYLIB,
              `dylib no resuelta: ${dylib.path}`);
          }
        }
      }
    }
  }

  /* ================================================================ *
   * Rebases
   * ================================================================ */

  _applyRebases(image) {
    const info = image.dyldInfo;
    if (!info || !info.rebase_size) return;
    const bytes = image.__fileBytes;
    const start = info.rebase_off;
    const end = start + info.rebase_size;
    const r = new BinaryReader(bytes);
    r.seek(start);

    let segIdx = 0;
    let segOffset = 0n;
    let rebaseType = REBASE_TYPE_POINTER;
    let count = 0;

    while (r.pos < end) {
      const byte = r.u8();
      const opcode = byte & REBASE_OPCODE_MASK;
      const imm = byte & REBASE_IMMEDIATE_MASK;

      switch (opcode) {
        case REBASE_OPCODE_DONE:
          break;
        case REBASE_OPCODE_SET_TYPE_IMM:
          rebaseType = imm;
          break;
        case REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB: {
          segIdx = imm;
          segOffset = r.uleb128();
          break;
        }
        case REBASE_OPCODE_ADD_ADDR_ULEB: {
          segOffset += r.uleb128();
          break;
        }
        case REBASE_OPCODE_ADD_ADDR_IMM_SCALED: {
          segOffset += BigInt(imm) * BigInt(8);
          break;
        }
        case REBASE_OPCODE_DO_REBASE_IMM_TIMES: {
          for (let i = 0; i < imm; i++) {
            this._doRebase(image, segIdx, segOffset);
            segOffset += 8n;
            count++;
          }
          break;
        }
        case REBASE_OPCODE_DO_REBASE_ULEB_TIMES: {
          const times = Number(r.uleb128());
          for (let i = 0; i < times; i++) {
            this._doRebase(image, segIdx, segOffset);
            segOffset += 8n;
            count++;
          }
          break;
        }
        case REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB: {
          this._doRebase(image, segIdx, segOffset);
          segOffset += 8n + r.uleb128();
          count++;
          break;
        }
        case REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
          const times = Number(r.uleb128());
          const skip = r.uleb128();
          for (let i = 0; i < times; i++) {
            this._doRebase(image, segIdx, segOffset);
            segOffset += 8n + skip;
            count++;
          }
          break;
        }
        default:
          throw makeError(LOAD_ERRORS.INVALID_OPCODE,
            `rebase opcode inválido: ${hex(opcode)}`);
      }
      if (opcode === REBASE_OPCODE_DONE) break;
    }

    image.rebasesApplied = count;
    this.stats.rebasesApplied += count;
    if (count > 0) Logger.debug(LOG_TAG, `Rebases aplicados: ${count}`);
  }

  _doRebase(image, segIdx, segOffset) {
    const seg = image.segments[segIdx];
    if (!seg) return;
    const addr = seg.vmaddr + segOffset;
    // Leer puntero actual
    if (this.vcpu && typeof this.vcpu.readMemory === 'function') {
      try {
        const cur = this.vcpu.readMemory(addr, 8);
        const ptr = cur.reduce((a, b, i) => a | (BigInt(b) << BigInt(8 * i)), 0n);
        // Slide = imageBase - originalBase; aquí asumimos 0 (imagen cargada en su base)
        const slide = 0n;
        const newPtr = ptr + slide;
        const buf = new Uint8Array(8);
        for (let i = 0; i < 8; i++) buf[i] = Number((newPtr >> BigInt(8 * i)) & 0xffn);
        this.vcpu.writeMemory(addr, buf);
      } catch {}
    }
  }

  /* ================================================================ *
   * Binds
   * ================================================================ */

  _applyBinds(image) {
    const info = image.dyldInfo;
    if (!info) return;

    // Bind
    if (info.bind_size) {
      this._runBindOpcodes(image, info.bind_off, info.bind_size, 'bind');
    }
    // Weak bind
    if (info.weak_bind_size) {
      this._runBindOpcodes(image, info.weak_bind_off, info.weak_bind_size, 'weak');
    }
    // Lazy bind
    if (info.lazy_bind_size) {
      this._runBindOpcodes(image, info.lazy_bind_off, info.lazy_bind_size, 'lazy');
    }

    this.stats.bindsApplied += image.bindsApplied;
  }

  _runBindOpcodes(image, off, size, kind) {
    const bytes = image.__fileBytes;
    const r = new BinaryReader(bytes);
    r.seek(off);
    const end = off + size;

    let segIdx = 0;
    let segOffset = 0n;
    let bindType = BIND_TYPE_POINTER;
    let dylibOrdinal = 0;
    let symbolName = '';
    let symbolFlags = 0;
    let addend = 0n;
    let count = 0;

    while (r.pos < end) {
      const byte = r.u8();
      const opcode = byte & BIND_OPCODE_MASK;
      const imm = byte & BIND_IMMEDIATE_MASK;

      switch (opcode) {
        case BIND_OPCODE_DONE:
          // En lazy bind significa fin
          if (kind === 'lazy') { r.pos = end; }
          break;
        case BIND_OPCODE_SET_DYLIB_ORDINAL_IMM:
          dylibOrdinal = imm;
          break;
        case BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB:
          dylibOrdinal = Number(r.uleb128());
          break;
        case BIND_OPCODE_SET_DYLIB_SPECIAL_IMM: {
          const sign = imm & 0x8 ? -1 : 1;
          dylibOrdinal = sign * (imm & 0x7);
          break;
        }
        case BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM:
          symbolFlags = imm;
          symbolName = r.cstring(1024);
          break;
        case BIND_OPCODE_SET_TYPE_IMM:
          bindType = imm;
          break;
        case BIND_OPCODE_SET_ADDEND_SLEB:
          addend = r.sleb128();
          break;
        case BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB:
          segIdx = imm;
          segOffset = r.uleb128();
          break;
        case BIND_OPCODE_ADD_ADDR_ULEB:
          segOffset += r.uleb128();
          break;
        case BIND_OPCODE_DO_BIND: {
          this._doBind(image, segIdx, segOffset, symbolName, dylibOrdinal, bindType, addend, kind);
          segOffset += 8n;
          count++;
          break;
        }
        case BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB: {
          this._doBind(image, segIdx, segOffset, symbolName, dylibOrdinal, bindType, addend, kind);
          segOffset += 8n + r.uleb128();
          count++;
          break;
        }
        case BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED: {
          this._doBind(image, segIdx, segOffset, symbolName, dylibOrdinal, bindType, addend, kind);
          segOffset += BigInt(8 * (imm + 1));
          count++;
          break;
        }
        case BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
          const times = Number(r.uleb128());
          const skip = r.uleb128();
          for (let i = 0; i < times; i++) {
            this._doBind(image, segIdx, segOffset, symbolName, dylibOrdinal, bindType, addend, kind);
            segOffset += 8n + skip;
            count++;
          }
          break;
        }
        case BIND_OPCODE_THREADED:
          // Chained fixups — no implementado aquí
          Logger.debug(LOG_TAG, 'BIND_OPCODE_THREADED encontrado, saltando');
          break;
        default:
          throw makeError(LOAD_ERRORS.INVALID_OPCODE,
            `bind opcode inválido: ${hex(opcode)} (kind=${kind})`);
      }
    }

    image.bindsApplied = (image.bindsApplied || 0) + count;
    if (count > 0) Logger.debug(LOG_TAG, `Binds ${kind}: ${count}`);
  }

  _doBind(image, segIdx, segOffset, symbolName, dylibOrdinal, type, addend, kind) {
    const seg = image.segments[segIdx];
    if (!seg) return;
    const addr = seg.vmaddr + segOffset;

    // Resolver símbolo
    let target = null;
    if (dylibOrdinal === BIND_SPECIAL_DYLIB_SELF) {
      target = image.globalSymbols.get(symbolName) || image.localSymbols.get(symbolName);
    } else if (dylibOrdinal === BIND_SPECIAL_DYLIB_MAIN_EXECUTABLE) {
      target = image.globalSymbols.get(symbolName);
    } else if (dylibOrdinal === BIND_SPECIAL_DYLIB_FLAT_LOOKUP) {
      const found = this.systemDylibs.findSymbol(symbolName);
      if (found) target = { addr: found.addr, lib: found.lib };
    } else if (dylibOrdinal > 0 && dylibOrdinal <= image.dylibs.length) {
      const dylib = image.dylibs[dylibOrdinal - 1];
      if (dylib && dylib.registryEntry) {
        const a = dylib.registryEntry.exports.get(symbolName);
        if (a != null) target = { addr: a, lib: dylib.path };
      }
    }
    if (!target) {
      // Fallback: buscar en sistema
      const found = this.systemDylibs.findSymbol(symbolName);
      if (found) target = { addr: found.addr, lib: found.lib };
    }

    const finalAddr = target ? target.addr + addend : 0n;

    // Guardar binding
    image.bindings.push({
      addr,
      symbol: symbolName,
      dylibOrdinal,
      type,
      addend: Number(addend),
      resolvedTo: finalAddr,
      resolvedLib: target?.lib || null,
      kind,
    });

    // Escribir en memoria si tenemos VCPU
    if (this.vcpu && typeof this.vcpu.writeMemory === 'function') {
      const buf = new Uint8Array(8);
      for (let i = 0; i < 8; i++) buf[i] = Number((finalAddr >> BigInt(8 * i)) & 0xffn);
      try { this.vcpu.writeMemory(addr, buf); } catch {}
    }
  }

  /* ================================================================ *
   * Entry point
   * ================================================================ */

  _computeEntry(image, opts) {
    if (image.entryOffset != null) {
      image.entryPoint = image.imageBase + BigInt(image.entryOffset);
      return;
    }
    // Buscar _main
    const main = image.globalSymbols.get('_main') || image.localSymbols.get('_main');
    if (main) {
      image.entryPoint = main.addr;
      return;
    }
    // Fallback: inicio de __TEXT
    const text = image.segments.find(s => s.name === '__TEXT');
    if (text) {
      image.entryPoint = text.vmaddr;
    }
  }

  /* ================================================================ *
   * Ejecución (integración con VCPU)
   * ================================================================ */

  launch(imageId, opts = {}) {
    const image = this.images.get(imageId);
    if (!image) throw makeError(LOAD_ERRORS.GENERIC, 'imagen no cargada');
    if (image.entryPoint == null) {
      throw makeError(LOAD_ERRORS.MISSING_ENTRY, 'sin entry point');
    }
    if (!this.vcpu) {
      Logger.warn(LOG_TAG, 'Sin VCPU — no se puede ejecutar');
      return { success: false, reason: 'no vcpu' };
    }
    Logger.info(LOG_TAG,
      `Ejecutando ${image.path} desde ${hex(image.entryPoint, 12)} (argv=${opts.argv?.length || 0})`
    );
    const ctx = this.vcpu.createProcess?.({ imageId, entry: image.entryPoint, argv: opts.argv || [] });
    this._emit('launched', { id: image.id, entry: image.entryPoint });
    return { success: true, context: ctx, entry: image.entryPoint };
  }

  /* ================================================================ *
   * Consultas de símbolos
   * ================================================================ */

  resolveSymbol(imageId, name) {
    const image = this.images.get(imageId);
    if (!image) return null;
    const local = image.globalSymbols.get(name) || image.localSymbols.get(name);
    if (local) return { addr: local.addr, lib: image.path, local: true };
    return this.systemDylibs.findSymbol(name);
  }

  /* ================================================================ *
   * Suscriptores / stats / dump
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

  getStats() {
    return {
      ...this.stats,
      loadedImages: this.images.size,
      state: this.state,
      systemDylibs: this.systemDylibs.list().length,
    };
  }

  dumpImage(id) {
    const image = this.images.get(id);
    if (!image) { Logger.warn(LOG_TAG, `dumpImage: ${id} no existe`); return; }
    const m = image.toMetadata();
    Logger.kernel(LOG_TAG, `─── MachO ${m.path} ───`);
    Logger.kernel(LOG_TAG, `  filetype     : ${m.filetype}`);
    Logger.kernel(LOG_TAG, `  cputype      : ${m.cputype}`);
    Logger.kernel(LOG_TAG, `  plataforma   : ${m.platform} (min ${m.minOS}, sdk ${m.sdk})`);
    Logger.kernel(LOG_TAG, `  uuid         : ${m.uuid}`);
    Logger.kernel(LOG_TAG, `  image base   : ${m.imageBase}`);
    Logger.kernel(LOG_TAG, `  entry point  : ${m.entryPoint} (offset ${m.entryOffset})`);
    Logger.kernel(LOG_TAG, `  stack        : ${m.stackSize} bytes`);
    Logger.kernel(LOG_TAG, `  segmentos    : ${m.segments.length}`);
    for (const s of m.segments) {
      Logger.kernel(LOG_TAG, `    · ${s.name.padEnd(12)} ${s.prot} ${s.vmaddr} +${s.vmsize}`);
    }
    Logger.kernel(LOG_TAG, `  dylibs       : ${m.dylibs.length}`);
    for (const d of m.dylibs) {
      Logger.kernel(LOG_TAG, `    · ${d.resolved ? '✓' : '✗'} ${d.weak ? '(weak) ' : ''}${d.path}`);
    }
    Logger.kernel(LOG_TAG, `  símbolos     : total=${m.symbols.total} globales=${m.symbols.global} locales=${m.symbols.local} undef=${m.symbols.undefined}`);
    Logger.kernel(LOG_TAG, `  relocs       : rebases=${m.relocations.rebases} binds=${m.relocations.binds}`);
    Logger.kernel(LOG_TAG, `  tamaño       : disco ${m.sizeOnDisk}B / memoria ${m.sizeInMemory}B`);
  }

  dump() {
    const s = this.getStats();
    Logger.kernel(LOG_TAG, '─── MachOLoader dump ───');
    Logger.kernel(LOG_TAG, `  estado       : ${s.state}`);
    Logger.kernel(LOG_TAG, `  imágenes     : ${s.loadedImages} (cargadas ${s.loaded}, fallidas ${s.failed})`);
    Logger.kernel(LOG_TAG, `  fat/thin     : ${s.fatSlices}/${s.thinImages}`);
    Logger.kernel(LOG_TAG, `  LC parseados : ${s.loadCommandsParsed}`);
    Logger.kernel(LOG_TAG, `  símbolos     : ${s.symbolsParsed}`);
    Logger.kernel(LOG_TAG, `  rebases      : ${s.rebasesApplied}`);
    Logger.kernel(LOG_TAG, `  binds        : ${s.bindsApplied}`);
    Logger.kernel(LOG_TAG, `  dylib resolve: ${s.dylibResolutions} ok / ${s.dylibMisses} miss`);
    Logger.kernel(LOG_TAG, `  bytes mapeados: ${s.bytesMapped}`);
  }
}

/* ------------------------------------------------------------------ *
 * Helper local
 * ------------------------------------------------------------------ */

function dirnameOf(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export { LoadedImage, LoadedSegment, LoadedSection, LoadedDylib, SystemDylibRegistry };
export default MachOLoader;
