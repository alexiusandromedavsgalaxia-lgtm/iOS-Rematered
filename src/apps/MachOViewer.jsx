// src/apps/MachOViewer.jsx
// iOS Remastered — MachOViewer.app
// Visor de binarios Mach-O: cabecera, load commands, segmentos, secciones,
// símbolos, dylibs, entitlements, hex viewer y disassembler ARM64 simulado.
// Reutiliza MachOStructures + MachOLoader del loader del OS.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, useReducer,
} from 'react';

import { useOS } from '../context/OSContext.jsx';
import { toast } from '../ui/Toast.jsx';
import { alert } from '../ui/Alert.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Blur } from '../ui/Blur.jsx';
import { TapHandler, useGesture } from '../ui/GestureHandler.jsx';

/* ============================================================================
 * CONSTANTES MACH-O
 * ========================================================================== */

const MH_MAGIC     = 0xFEEDFACE;
const MH_CIGAM     = 0xCEFAEDFE;
const MH_MAGIC_64  = 0xFEEDFACF;
const MH_CIGAM_64  = 0xCFFAEDFE;
const FAT_MAGIC    = 0xCAFEBABE;
const FAT_CIGAM    = 0xBEBAFECA;

const CPU_NAMES = {
  7: 'x86', 0x01000007: 'x86_64',
  12: 'arm', 0x0100000C: 'arm64',
  0x0100000C + 0x1000000: 'arm64e',
};

const FILETYPE_NAMES = {
  1: 'MH_OBJECT', 2: 'MH_EXECUTE', 3: 'MH_FVMLIB', 4: 'MH_CORE',
  5: 'MH_PRELOAD', 6: 'MH_DYLIB', 7: 'MH_DYLINKER', 8: 'MH_BUNDLE',
  9: 'MH_DYLIB_STUB', 10: 'MH_DSYM', 11: 'MH_KEXT_BUNDLE',
};

const MH_FLAGS = [
  [0x1, 'MH_NOUNDEFS'], [0x2, 'MH_INCRLINK'], [0x4, 'MH_DYLDLINK'],
  [0x8, 'MH_BINDATLOAD'], [0x10, 'MH_PREBOUND'], [0x20, 'MH_SPLIT_SEGS'],
  [0x40, 'MH_LAZY_INIT'], [0x80, 'MH_TWOLEVEL'], [0x100, 'MH_FORCE_FLAT'],
  [0x200, 'MH_NOMULTIDEFS'], [0x400, 'MH_NOFIXPREBINDING'], [0x800, 'MH_PREBINDABLE'],
  [0x1000, 'MH_ALLMODSBOUND'], [0x2000, 'MH_SUBSECTIONS_VIA_SYMBOLS'],
  [0x4000, 'MH_CANONICAL'], [0x8000, 'MH_WEAK_DEFINES'], [0x10000, 'MH_BINDS_TO_WEAK'],
  [0x20000, 'MH_ALLOW_STACK_EXECUTION'], [0x40000, 'MH_ROOT_SAFE'],
  [0x80000, 'MH_SETUID_SAFE'], [0x100000, 'MH_NO_REEXPORTED_DYLIBS'],
  [0x200000, 'MH_PIE'], [0x400000, 'MH_DEAD_STRIPPABLE_DYLIB'],
  [0x800000, 'MH_HAS_TLV_DESCRIPTORS'], [0x1000000, 'MH_NO_HEAP_EXECUTION'],
  [0x2000000, 'MH_APP_EXTENSION_SAFE'], [0x4000000, 'MH_NLIST_OUTOFSYNC_WITH_DYLDINFO'],
  [0x8000000, 'MH_SIM_SUPPORT'], [0x80000000, 'MH_DYLIB_IN_CACHE'],
];

const LC_NAMES = {
  0x1:  'LC_SEGMENT',
  0x2:  'LC_SYMTAB',
  0x3:  'LC_SYMSEG',
  0x4:  'LC_THREAD',
  0x5:  'LC_UNIXTHREAD',
  0x6:  'LC_LOADFVMLIB',
  0x7:  'LC_IDFVMLIB',
  0x8:  'LC_IDENT',
  0x9:  'LC_FVMFILE',
  0xA:  'LC_PREPAGE',
  0xB:  'LC_DYSYMTAB',
  0xC:  'LC_LOAD_DYLIB',
  0xD:  'LC_ID_DYLIB',
  0xE:  'LC_LOAD_DYLINKER',
  0xF:  'LC_ID_DYLINKER',
  0x10: 'LC_PREBOUND_DYLIB',
  0x11: 'LC_ROUTINES',
  0x12: 'LC_SUB_FRAMEWORK',
  0x13: 'LC_SUB_UMBRELLA',
  0x14: 'LC_SUB_CLIENT',
  0x15: 'LC_SUB_LIBRARY',
  0x16: 'LC_TWOLEVEL_HINTS',
  0x17: 'LC_PREBIND_CKSUM',
  0x18: 'LC_LOAD_WEAK_DYLIB',
  0x19: 'LC_SEGMENT_64',
  0x1A: 'LC_ROUTINES_64',
  0x1B: 'LC_UUID',
  0x1C: 'LC_RPATH',
  0x1D: 'LC_CODE_SIGNATURE',
  0x1E: 'LC_SEGMENT_SPLIT_INFO',
  0x1F: 'LC_REEXPORT_DYLIB',
  0x20: 'LC_LAZY_LOAD_DYLIB',
  0x21: 'LC_ENCRYPTION_INFO',
  0x22: 'LC_DYLD_INFO',
  0x23: 'LC_DYLD_INFO_ONLY',
  0x24: 'LC_LOAD_UPWARD_DYLIB',
  0x25: 'LC_VERSION_MIN_MACOSX',
  0x26: 'LC_VERSION_MIN_IPHONEOS',
  0x27: 'LC_FUNCTION_STARTS',
  0x28: 'LC_DYLD_ENVIRONMENT',
  0x29: 'LC_MAIN',
  0x2A: 'LC_DATA_IN_CODE',
  0x2B: 'LC_SOURCE_VERSION',
  0x2C: 'LC_DYLIB_CODE_SIGN_DRS',
  0x2D: 'LC_ENCRYPTION_INFO_64',
  0x2E: 'LC_LINKER_OPTION',
  0x2F: 'LC_LINKER_OPTIMIZATION_HINT',
  0x30: 'LC_VERSION_MIN_TVOS',
  0x31: 'LC_VERSION_MIN_WATCHOS',
  0x32: 'LC_NOTE',
  0x33: 'LC_BUILD_VERSION',
  0x34: 'LC_DYLD_EXPORTS_TRIE',
  0x35: 'LC_DYLD_CHAINED_FIXUPS',
  0x36: 'LC_FILESET_ENTRY',
};

/* ============================================================================
 * PARSER MACH-O — completo y autónomo
 * No depende del loader real para funcionar como viewer (el loader lo usamos
 * para "reproducir" la carga y ver el comportamiento). Así el viewer puede
 * abrir cualquier binario sin registrarlo en el kernel.
 * ========================================================================== */

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer ?? buf);
    this.off = 0;
  }
  seek(o) { this.off = o; return this; }
  skip(n) { this.off += n; return this; }
  u8()  { const v = this.view.getUint8(this.off);  this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i32() { const v = this.view.getInt32(this.off, true);  this.off += 4; return v; }
  u64() {
    const lo = this.view.getUint32(this.off, true);
    const hi = this.view.getUint32(this.off + 4, true);
    this.off += 8;
    return hi * 0x100000000 + lo;
  }
  str(len) {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.off, len);
    this.off += len;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0+$/, '');
  }
  cstr() {
    let s = '';
    while (this.off < this.view.byteLength) {
      const c = this.view.getUint8(this.off++);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

function readMachO(input) {
  let buf;
  if (input instanceof ArrayBuffer) buf = new Uint8Array(input);
  else if (input instanceof Uint8Array) buf = input;
  else if (typeof input === 'string') {
    // input = hex string
    const clean = input.replace(/\s+/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    buf = out;
  } else throw new Error('Tipo de input no soportado');

  const r = new Reader(buf);
  const magic = r.u32();

  if (magic === FAT_MAGIC || magic === FAT_CIGAM) {
    return readFat(buf, r, magic === FAT_CIGAM);
  }
  if (magic === MH_MAGIC_64 || magic === MH_MAGIC) {
    return readThin(buf, r, magic);
  }
  throw new Error(`No es Mach-O (magic=0x${magic.toString(16)})`);
}

function readFat(buf, r, swapped) {
  const nfat = r.u32();
  const arches = [];
  for (let i = 0; i < nfat; i++) {
    const cputype = r.u32();
    const cpusubtype = r.u32();
    const offset = r.u32();
    const size = r.u32();
    const align = r.u32();
    arches.push({ cputype, cpusubtype, offset, size, align });
  }
  const slices = arches.map((a) => {
    const sub = new Reader(buf);
    sub.seek(a.offset);
    const inner = readThin(buf, sub, sub.u32());
    return { ...a, ...inner };
  });
  return {
    kind: 'fat',
    magic: '0xCAFEBABE (fat)',
    size: buf.byteLength,
    arches,
    slices,
    bytes: buf,
  };
}

function readThin(buf, r, magic) {
  const is64 = magic === MH_MAGIC_64 || magic === MH_CIGAM_64;
  const endianSwap = magic === MH_CIGAM || magic === MH_CIGAM_64;

  if (is64) r.seek(0);
  else r.seek(0);

  const headerMagic = r.u32();
  const cputype = r.u32();
  const cpusubtype = r.u32();
  const filetype = r.u32();
  const ncmds = r.u32();
  const sizeofcmds = r.u32();
  const flags = r.u32();
  const reserved = is64 ? r.u32() : 0;

  const cmds = [];
  const cmdStart = r.off;
  for (let i = 0; i < ncmds; i++) {
    if (r.off - cmdStart >= sizeofcmds) break;
    const cmdOff = r.off;
    const cmd = r.u32();
    const cmdsize = r.u32();

    if (r.off + cmdsize - 8 > buf.byteLength) break;

    const parsed = parseLoadCommand(cmd, cmdsize, r, buf, is64);
    parsed.offset = cmdOff;
    parsed.size = cmdsize;
    parsed.name = LC_NAMES[cmd] || `LC_0x${cmd.toString(16)}`;
    cmds.push(parsed);

    r.seek(cmdOff + cmdsize);
  }

  const segments = cmds.filter((c) => c.type === 'segment');
  const sections = segments.flatMap((s) => s.sections || []);

  const symtab = cmds.find((c) => c.type === 'symtab');
  const symbols = symtab ? readSymbols(buf, symtab, is64) : [];

  const dylibs = cmds.filter((c) =>
    c.type === 'load_dylib' || c.type === 'load_weak_dylib' ||
    c.type === 'reexport_dylib' || c.type === 'id_dylib' ||
    c.type === 'lazy_load_dylib' || c.type === 'load_upward_dylib'
  );

  const uuid = cmds.find((c) => c.type === 'uuid');
  const main = cmds.find((c) => c.type === 'main');
  const codeSig = cmds.find((c) => c.type === 'code_signature');
  const encryption = cmds.find((c) => c.type === 'encryption_info' || c.type === 'encryption_info_64');
  const buildVersion = cmds.find((c) => c.type === 'build_version');

  return {
    kind: 'thin',
    magic: magic === MH_MAGIC_64 ? '0xFEEDFACF (MH_MAGIC_64)'
      : magic === MH_MAGIC ? '0xFEEDFACE (MH_MAGIC)'
      : magic === MH_CIGAM_64 ? '0xCFFAEDFE (MH_CIGAM_64)'
      : '0xCEFAEDFE (MH_CIGAM)',
    is64,
    header: {
      magic: `0x${headerMagic.toString(16).toUpperCase().padStart(8, '0')}`,
      cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags, reserved,
      cpuName: CPU_NAMES[cputype] || `cpu_${cputype}`,
      filetypeName: FILETYPE_NAMES[filetype] || `ft_${filetype}`,
      flagNames: MH_FLAGS.filter(([m]) => flags & m).map(([, n]) => n),
    },
    cmds,
    segments,
    sections,
    symbols,
    dylibs,
    uuid: uuid?.uuid,
    main: main,
    codeSig,
    encryption,
    buildVersion,
    size: buf.byteLength,
    bytes: buf,
  };
}

function parseLoadCommand(cmd, cmdsize, r, buf, is64) {
  switch (cmd) {
    case 0x19: return parseSegment64(r, buf);
    case 0x1:  return parseSegment32(r, buf);
    case 0x2:  return parseSymtab(r);
    case 0xB:  return parseDysymtab(r);
    case 0xC:  return parseDylib(r, buf, 'load_dylib');
    case 0xD:  return parseDylib(r, buf, 'id_dylib');
    case 0x18: return parseDylib(r, buf, 'load_weak_dylib');
    case 0x1F: return parseDylib(r, buf, 'reexport_dylib');
    case 0x20: return parseDylib(r, buf, 'lazy_load_dylib');
    case 0x24: return parseDylib(r, buf, 'load_upward_dylib');
    case 0x1B: return parseUUID(r);
    case 0x29: return parseMain(r);
    case 0x1D: return parseLinkeditData(r, 'code_signature');
    case 0x1E: return parseLinkeditData(r, 'segment_split_info');
    case 0x27: return parseLinkeditData(r, 'function_starts');
    case 0x2A: return parseLinkeditData(r, 'data_in_code');
    case 0x2C: return parseLinkeditData(r, 'dylib_code_sign_drs');
    case 0x34: return parseLinkeditData(r, 'dyld_exports_trie');
    case 0x35: return parseLinkeditData(r, 'dyld_chained_fixups');
    case 0x21: return parseEncryption(r, false);
    case 0x2D: return parseEncryption(r, true);
    case 0x33: return parseBuildVersion(r);
    case 0x22: case 0x23: return parseDyldInfo(r);
    case 0x26: return parseVersionMin(r, 'version_min_iphoneos');
    case 0x25: return parseVersionMin(r, 'version_min_macosx');
    case 0x30: return parseVersionMin(r, 'version_min_tvos');
    case 0x31: return parseVersionMin(r, 'version_min_watchos');
    case 0x2B: return parseSourceVersion(r);
    case 0x1C: return parseRpath(r, buf);
    case 0x2E: return parseLinkerOption(r, buf);
    default: return { type: 'unknown', cmd };
  }
}

function parseSegment64(r, buf) {
  const segnameRaw = r.str(16);
  const vmaddr = r.u64();
  const vmsize = r.u64();
  const fileoff = r.u64();
  const filesize = r.u64();
  const maxprot = r.i32();
  const initprot = r.i32();
  const nsects = r.u32();
  const flags = r.u32();

  const sections = [];
  for (let i = 0; i < nsects; i++) {
    const sectname = r.str(16);
    const segn = r.str(16);
    const addr = r.u64();
    const size = r.u64();
    const offset = r.u32();
    const align = r.u32();
    const reloff = r.u32();
    const nreloc = r.u32();
    const sflags = r.u32();
    r.u32(); r.u32(); r.u32();
    sections.push({
      sectname, segname: segn, addr, size, offset, align,
      reloff, nreloc, flags: sflags, is64: true,
    });
  }

  return {
    type: 'segment', is64: true,
    segname: segnameRaw,
    vmaddr, vmsize, fileoff, filesize, maxprot, initprot, nsects, flags,
    sections,
  };
}

function parseSegment32(r, buf) {
  const segnameRaw = r.str(16);
  const vmaddr = r.u32();
  const vmsize = r.u32();
  const fileoff = r.u32();
  const filesize = r.u32();
  const maxprot = r.i32();
  const initprot = r.i32();
  const nsects = r.u32();
  const flags = r.u32();
  const sections = [];
  for (let i = 0; i < nsects; i++) {
    const sectname = r.str(16);
    const segn = r.str(16);
    const addr = r.u32();
    const size = r.u32();
    const offset = r.u32();
    const align = r.u32();
    const reloff = r.u32();
    const nreloc = r.u32();
    const sflags = r.u32();
    r.u32(); r.u32();
    sections.push({ sectname, segname: segn, addr, size, offset, align, reloff, nreloc, flags: sflags, is64: false });
  }
  return {
    type: 'segment', is64: false,
    segname: segnameRaw, vmaddr, vmsize, fileoff, filesize,
    maxprot, initprot, nsects, flags, sections,
  };
}

function parseSymtab(r) {
  const symoff = r.u32();
  const nsyms = r.u32();
  const stroff = r.u32();
  const strsize = r.u32();
  return { type: 'symtab', symoff, nsyms, stroff, strsize };
}

function parseDysymtab(r) {
  return {
    type: 'dysymtab',
    ilocalsym: r.u32(), nlocalsym: r.u32(),
    iextdefsym: r.u32(), nextdefsym: r.u32(),
    iundefsym: r.u32(), nundefsym: r.u32(),
    tocoff: r.u32(), ntoc: r.u32(),
    modtaboff: r.u32(), nmodtab: r.u32(),
    extrefsymoff: r.u32(), nextrefsyms: r.u32(),
    indirectsymoff: r.u32(), nindirectsyms: r.u32(),
    extreloff: r.u32(), nextrel: r.u32(),
    locreloff: r.u32(), nlocrel: r.u32(),
  };
}

function parseDylib(r, buf, type) {
  const nameOffset = r.u32();
  const timestamp = r.u32();
  const currentVersion = r.u32();
  const compatibilityVersion = r.u32();
  const cmdStart = r.off - 24;
  r.seek(cmdStart + nameOffset);
  const name = r.cstr();
  return {
    type,
    nameOffset, timestamp,
    currentVersion: versionStr(currentVersion),
    compatibilityVersion: versionStr(compatibilityVersion),
    name,
  };
}

function parseUUID(r) {
  const bytes = [];
  for (let i = 0; i < 16; i++) bytes.push(r.u8());
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`.toUpperCase();
  return { type: 'uuid', uuid };
}

function parseMain(r) {
  const entryoff = r.u64();
  const stacksize = r.u64();
  return { type: 'main', entryoff, stacksize };
}

function parseLinkeditData(r, type) {
  const dataoff = r.u32();
  const datasize = r.u32();
  return { type, dataoff, datasize };
}

function parseEncryption(r, is64) {
  const cryptoff = r.u32();
  const cryptsize = r.u32();
  const cryptid = r.u32();
  const pad = is64 ? r.u32() : 0;
  return { type: is64 ? 'encryption_info_64' : 'encryption_info', cryptoff, cryptsize, cryptid, pad };
}

function parseBuildVersion(r) {
  const platform = r.u32();
  const minos = r.u32();
  const sdk = r.u32();
  const ntools = r.u32();
  const tools = [];
  for (let i = 0; i < ntools; i++) {
    tools.push({ tool: r.u32(), version: r.u32() });
  }
  const PLAT = { 1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 5: 'bridgeOS', 6: 'macCatalyst', 7: 'iOSSimulator' };
  return {
    type: 'build_version',
    platform, platformName: PLAT[platform] || `platform_${platform}`,
    minos: versionStr(minos), sdk: versionStr(sdk),
    ntools, tools,
  };
}

function parseDyldInfo(r) {
  return {
    type: 'dyld_info',
    rebase_off: r.u32(), rebase_size: r.u32(),
    bind_off: r.u32(), bind_size: r.u32(),
    weak_bind_off: r.u32(), weak_bind_size: r.u32(),
    lazy_bind_off: r.u32(), lazy_bind_size: r.u32(),
    export_off: r.u32(), export_size: r.u32(),
  };
}

function parseVersionMin(r, type) {
  const version = r.u32();
  const sdk = r.u32();
  return { type, version: versionStr(version), sdk: versionStr(sdk) };
}

function parseSourceVersion(r) {
  return { type: 'source_version', version: r.u64() };
}

function parseRpath(r, buf) {
  const pathOffset = r.u32();
  const cmdStart = r.off - 12;
  r.seek(cmdStart + pathOffset);
  const path = r.cstr();
  return { type: 'rpath', path };
}

function parseLinkerOption(r, buf) {
  const count = r.u32();
  const strings = [];
  const cmdStart = r.off - 12;
  for (let i = 0; i < count; i++) {
    const off = r.u32();
    const cur = r.off;
    r.seek(cmdStart + off);
    strings.push(r.cstr());
    r.seek(cur);
  }
  return { type: 'linker_option', count, strings };
}

function readSymbols(buf, symtab, is64) {
  const r = new Reader(buf);
  const symSize = is64 ? 16 : 12;
  const out = [];
  const max = Math.min(symtab.nsyms, 4000);
  for (let i = 0; i < max; i++) {
    r.seek(symtab.symoff + i * symSize);
    const strx = r.u32();
    const type = r.u8();
    const sect = r.u8();
    const desc = r.u16();
    const value = is64 ? r.u64() : r.u32();

    r.seek(symtab.stroff + strx);
    const name = r.cstr();
    if (!name) continue;

    out.push({
      index: i, name, type, sect, desc, value,
      external: !!(type & 0x01),
      defined: (type & 0x0E) !== 0,
    });
  }
  return out;
}

function versionStr(v) {
  const major = (v >> 16) & 0xFFFF;
  const minor = (v >> 8) & 0xFF;
  const patch = v & 0xFF;
  return `${major}.${minor}${patch ? `.${patch}` : ''}`;
}

function protStr(p) {
  const r = p & 1 ? 'r' : '-';
  const w = p & 2 ? 'w' : '-';
  const x = p & 4 ? 'x' : '-';
  return `${r}${w}${x}`;
}

function hex(n, width = 8) {
  if (n === undefined || n === null) return '-';
  if (typeof n !== 'number') return String(n);
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
}

/* ============================================================================
 * BINARIOS DE EJEMPLO — fabricamos un Mach-O sintético válido para que el
 * usuario pueda abrir algo aunque no haya IPAs en el FileSystem.
 * ========================================================================== */

function buildSyntheticMachO({ name = 'Demo', dylibs = [] } = {}) {
  // Construimos un Mach-O 64 bits mínimo pero consistente.
  const HDR = 32;
  const SEG = 72;
  const SECT = 80;
  const UUID = 24;
  const MAIN = 24;
  const BUILTIN = 24;
  const BUILDVER = 32;

  const segs = [
    { name: '__PAGEZERO', vmaddr: 0, vmsize: 0x100000000, fileoff: 0, filesize: 0, prot: 0, sections: [] },
    {
      name: '__TEXT', vmaddr: 0x100000000, vmsize: 0x4000, fileoff: 0, filesize: 0x4000, prot: 5,
      sections: [
        { sectname: '__text',      segname: '__TEXT', addr: 0x100001000, size: 0x2000, offset: 0x1000, align: 4, flags: 0x80000400 },
        { sectname: '__stubs',     segname: '__TEXT', addr: 0x100003000, size: 0x400,  offset: 0x3000, align: 1, flags: 0x80000408 },
        { sectname: '__cstring',   segname: '__TEXT', addr: 0x100003400, size: 0x800,  offset: 0x3400, align: 0, flags: 0x00000002 },
        { sectname: '__unwind_info', segname: '__TEXT', addr: 0x100003C00, size: 0x400, offset: 0x3C00, align: 2, flags: 0x00000000 },
      ],
    },
    {
      name: '__DATA_CONST', vmaddr: 0x100004000, vmsize: 0x4000, fileoff: 0x4000, filesize: 0x4000, prot: 3,
      sections: [
        { sectname: '__got',      segname: '__DATA_CONST', addr: 0x100004000, size: 0x200, offset: 0x4000, align: 3, flags: 0x00000006 },
        { sectname: '__const',    segname: '__DATA_CONST', addr: 0x100004200, size: 0x1000, offset: 0x4200, align: 4, flags: 0x00000000 },
      ],
    },
    {
      name: '__DATA', vmaddr: 0x100008000, vmsize: 0x4000, fileoff: 0x8000, filesize: 0x4000, prot: 3,
      sections: [
        { sectname: '__data',     segname: '__DATA', addr: 0x100008000, size: 0x800, offset: 0x8000, align: 3, flags: 0x00000000 },
        { sectname: '__bss',      segname: '__DATA', addr: 0x100008800, size: 0x1000, offset: 0,     align: 3, flags: 0x00000001 },
      ],
    },
    { name: '__LINKEDIT', vmaddr: 0x10000C000, vmsize: 0x4000, fileoff: 0xC000, filesize: 0x4000, prot: 1, sections: [] },
  ];

  const dylibsSpec = dylibs.length ? dylibs : [
    { name: '/usr/lib/libSystem.B.dylib',      current: '1311.0.0', compat: '1.0.0' },
    { name: '/System/Library/Frameworks/Foundation.framework/Foundation', current: '1977.0.0', compat: '300.0.0' },
    { name: '/System/Library/Frameworks/UIKit.framework/UIKit',           current: '7109.0.0', compat: '1.0.0' },
  ];

  const dylibCmds = dylibsSpec.map((d) => {
    const nameLen = d.name.length + 1;
    const cmdsize = 24 + Math.ceil(nameLen / 8) * 8;
    return { name: d.name, current: d.current, compat: d.compat, cmdsize, nameOffset: 24 };
  });

  const totalDylibSize = dylibCmds.reduce((a, d) => a + d.cmdsize, 0);
  const ncmds = segs.length + dylibCmds.length + 4; // segments + dylibs + uuid + main + buildver + codesig
  const sizeofcmds = segs.reduce((a, s) => a + SEG + s.sections.length * SECT, 0)
    + totalDylibSize
    + UUID + MAIN + BUILDVER + 16; // codesig 16

  const totalSize = 0x10000;
  const buf = new Uint8Array(totalSize);

  const w = new DataView(buf.buffer);

  let off = 0;
  w.setUint32(off, MH_MAGIC_64, true); off += 4;
  w.setUint32(off, 0x0100000C, true); off += 4;
  w.setUint32(off, 0, true); off += 4;
  w.setUint32(off, 2, true); off += 4;
  w.setUint32(off, ncmds, true); off += 4;
  w.setUint32(off, sizeofcmds, true); off += 4;
  w.setUint32(off, 0x00200085, true); off += 4;
  w.setUint32(off, 0, true); off += 4;

  const writeStr16 = (s) => {
    const arr = new Uint8Array(16);
    const enc = new TextEncoder().encode(s.slice(0, 15));
    arr.set(enc);
    for (let i = 0; i < 16; i++) w.setUint8(off + i, arr[i]);
    off += 16;
  };

  for (const seg of segs) {
    const cmdOff = off;
    w.setUint32(off, 0x19, true); off += 4;
    w.setUint32(off, SEG + seg.sections.length * SECT, true); off += 4;
    writeStr16(seg.name);
    const write64 = (v) => {
      const lo = v % 0x100000000;
      const hi = Math.floor(v / 0x100000000);
      w.setUint32(off, lo, true); w.setUint32(off + 4, hi, true); off += 8;
    };
    write64(seg.vmaddr); write64(seg.vmsize);
    write64(seg.fileoff); write64(seg.filesize);
    w.setInt32(off, seg.prot, true); off += 4;
    w.setInt32(off, seg.prot, true); off += 4;
    w.setUint32(off, seg.sections.length, true); off += 4;
    w.setUint32(off, 0, true); off += 4;
    for (const sec of seg.sections) {
      writeStr16(sec.sectname);
      writeStr16(sec.segname);
      write64(sec.addr); write64(sec.size);
      w.setUint32(off, sec.offset, true); off += 4;
      w.setUint32(off, sec.align, true); off += 4;
      w.setUint32(off, 0, true); off += 4;
      w.setUint32(off, 0, true); off += 4;
      w.setUint32(off, sec.flags, true); off += 4;
      w.setUint32(off, 0, true); off += 4;
      w.setUint32(off, 0, true); off += 4;
      w.setUint32(off, 0, true); off += 4;
    }
    // reservado: nada que escribir
  }

  // UUID
  {
    const cmdOff = off;
    w.setUint32(off, 0x1B, true); off += 4;
    w.setUint32(off, UUID, true); off += 4;
    const uuid = [0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78,
                  0x9A, 0xBC, 0xDE, 0xF0, 0x11, 0x22, 0x33, 0x44];
    for (const b of uuid) { w.setUint8(off, b); off += 1; }
  }

  // LC_BUILD_VERSION
  {
    w.setUint32(off, 0x33, true); off += 4;
    w.setUint32(off, BUILDVER, true); off += 4;
    w.setUint32(off, 2, true); off += 4;      // iOS
    w.setUint32(off, (17 << 16) | (0 << 8), true); off += 4;
    w.setUint32(off, (17 << 16) | (4 << 8), true); off += 4;
    w.setUint32(off, 1, true); off += 4;
    w.setUint32(off, 3, true); off += 4;      // LD
    w.setUint32(off, (820 << 16) | (1 << 8), true); off += 4;
  }

  // LC_MAIN
  {
    w.setUint32(off, 0x29, true); off += 4;
    w.setUint32(off, MAIN, true); off += 4;
    w.setUint32(off, 0x100001234, true); off += 4;
    w.setUint32(off, 0x100000000, true); off += 4; // entryoff = 0x1234
    w.setUint32(off, 0x100000000, true); off += 4; // stacksize = 0
  }

  // Dylibs
  for (const d of dylibCmds) {
    w.setUint32(off, 0xC, true); off += 4;
    w.setUint32(off, d.cmdsize, true); off += 4;
    w.setUint32(off, 24, true); off += 4; // name offset
    w.setUint32(off, 2, true); off += 4;
    w.setUint32(off, (1311 << 16) | (0 << 8), true); off += 4;
    w.setUint32(off, (1 << 16), true); off += 4;
    const strStart = off;
    const bytes = new TextEncoder().encode(d.name);
    for (let i = 0; i < bytes.length; i++) w.setUint8(off + i, bytes[i]);
    off = strStart + Math.ceil((d.name.length + 1) / 8) * 8;
  }

  // LC_CODE_SIGNATURE
  {
    w.setUint32(off, 0x1D, true); off += 4;
    w.setUint32(off, 16, true); off += 4;
    w.setUint32(off, 0xF000, true); off += 4;
    w.setUint32(off, 0x1000, true); off += 4;
  }

  return buf;
}

/* ============================================================================
 * HEX DUMP
 * ========================================================================== */

function HexDump({ bytes, start = 0, length = 4096 }) {
  const [page, setPage] = useState(0);
  const pageSize = 1024;
  const total = Math.min(length, Math.max(0, bytes.byteLength - start));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, pages - 1);
  const from = start + p * pageSize;
  const to = Math.min(bytes.byteLength, from + pageSize);

  const rows = [];
  for (let off = from; off < to; off += 16) {
    const hexes = [];
    const ascii = [];
    for (let i = 0; i < 16; i++) {
      const o = off + i;
      if (o < to) {
        const b = bytes[o];
        hexes.push(b.toString(16).padStart(2, '0').toUpperCase());
        ascii.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
      } else { hexes.push('  '); ascii.push(' '); }
    }
    rows.push({ off, hexes, ascii: ascii.join('') });
  }

  return (
    <div className="mv-hexdump">
      <div className="mv-hexdump-nav">
        <button disabled={p === 0} onClick={() => setPage(p - 1)}>◀</button>
        <span>Página {p + 1} / {pages} · {hex(from, 6)} – {hex(to, 6)}</span>
        <button disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>▶</button>
      </div>
      <pre className="mv-hexdump-pre">
        {rows.map((r) => (
          <div key={r.off} className="mv-hexdump-row">
            <span className="mv-off">{hex(r.off, 8)}</span>
            <span className="mv-hex">
              {r.hexes.slice(0, 8).join(' ')}  {r.hexes.slice(8).join(' ')}
            </span>
            <span className="mv-ascii">{r.ascii}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/* ============================================================================
 * DISASSEMBLER ARM64 SIMULADO
 * No es un disassembler real: clasifica patrones de bits comunes y produce
 * una representación legible. Suficiente para inspeccionar __text.
 * ========================================================================== */

const A64_REGS = ['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x18','x19','x20','x21','x22','x23','x24','x25','x26','x27','x28','x29','x30','sp'];

function disasmArm64(bytes, startOff, count = 64) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = startOff + i * 4;
    if (off + 4 > bytes.byteLength) break;
    const lo = bytes[off] | (bytes[off+1] << 8);
    const hi = bytes[off+2] | (bytes[off+3] << 16);
    const w = (hi * 0x10000 + lo) >>> 0;
    out.push({ off, word: w, text: decodeA64(w, off) });
  }
  return out;
}

function decodeA64(w, off) {
  if (w === 0xD65F03C0) return 'ret';
  if (w === 0xD503201F) return 'nop';
  if ((w & 0xFFFFFC1F) === 0xD63F0000) {
    const rn = (w >> 5) & 0x1F;
    return `blr ${A64_REGS[rn]}`;
  }
  if ((w & 0xFFFFFC1F) === 0xD61F0000) {
    const rn = (w >> 5) & 0x1F;
    return `br ${A64_REGS[rn]}`;
  }
  if ((w & 0xFC000000) === 0x94000000) {
    const imm = w & 0x03FFFFFF;
    const sign = imm & 0x02000000 ? imm - 0x04000000 : imm;
    return `bl ${hex(off + sign * 4, 8)}`;
  }
  if ((w & 0xFC000000) === 0x14000000) {
    const imm = w & 0x03FFFFFF;
    const sign = imm & 0x02000000 ? imm - 0x04000000 : imm;
    return `b ${hex(off + sign * 4, 8)}`;
  }
  if ((w & 0x7F000000) === 0x53000000) {
    const rd = w & 0x1F;
    const rn = (w >> 5) & 0x1F;
    const sh = (w >> 22) & 0x3;
    const imm = (w >> 16) & 0x1F;
    return `lsl ${A64_REGS[rd]}, ${A64_REGS[rn]}, #${imm}`;
  }
  if ((w & 0x7F800000) === 0x11000000 || (w & 0x7F800000) === 0x51000000) {
    const isSub = (w & 0x40000000) !== 0;
    const rd = w & 0x1F;
    const rn = (w >> 5) & 0x1F;
    const imm = (w >> 10) & 0xFFF;
    return `${isSub ? 'sub' : 'add'} ${A64_REGS[rd]}, ${A64_REGS[rn]}, #${imm}`;
  }
  if ((w & 0x7F800000) === 0x52800000 || (w & 0x7F800000) === 0x72800000) {
    const rd = w & 0x1F;
    const imm = (w >> 5) & 0xFFFF;
    const isMovz = (w & 0x80000000) === 0x52800000;
    return isMovz ? `movz ${A64_REGS[rd]}, #${imm}` : `movk ${A64_REGS[rd]}, #${imm}`;
  }
  if ((w & 0xFFC00000) === 0xA9000000 || (w & 0xFFC00000) === 0xA9800000) {
    const rt = w & 0x1F;
    const rn = (w >> 5) & 0x1F;
    const isLdp = (w & 0x00400000) !== 0;
    return `${isLdp ? 'ldp' : 'stp'} ${A64_REGS[rt]}, ${A64_REGS[rt+1]}, [${A64_REGS[rn]}]`;
  }
  if ((w & 0xFFC00000) === 0xF9400000 || (w & 0xFFC00000) === 0xF9000000) {
    const isLdr = (w & 0x00400000) === 0;
    const rt = w & 0x1F;
    const rn = (w >> 5) & 0x1F;
    const imm = ((w >> 10) & 0xFFF) * 8;
    return `${isLdr ? 'ldr' : 'str'} ${A64_REGS[rt]}, [${A64_REGS[rn]}, #${imm}]`;
  }
  if ((w & 0x7F000000) === 0x32000000) {
    const rd = w & 0x1F;
    const rn = (w >> 5) & 0x1F;
    return `orr ${A64_REGS[rd]}, ${A64_REGS[rn]}, ${A64_REGS[rn]}`;
  }
  if ((w & 0x7FE0FFE0) === 0x2A0003E0) {
    const rd = w & 0x1F;
    const rm = (w >> 16) & 0x1F;
    return `mov ${A64_REGS[rd]}, ${A64_REGS[rm]}`;
  }
  return `.long 0x${w.toString(16).padStart(8, '0').toUpperCase()}`;
}

/* ============================================================================
 * COMPONENTES UI
 * ========================================================================== */

const TABS = [
  { id: 'header',   label: 'Cabecera',      icon: 'doc.text' },
  { id: 'commands', label: 'Load Commands', icon: 'list.bullet.indent' },
  { id: 'segments', label: 'Segmentos',     icon: 'square.stack.3d.up' },
  { id: 'sections', label: 'Secciones',     icon: 'rectangle.split.3x1' },
  { id: 'symbols',  label: 'Símbolos',      icon: 'function' },
  { id: 'dylibs',   label: 'Dylibs',        icon: 'shippingbox' },
  { id: 'entitle',  label: 'Entitlements',  icon: 'lock.shield' },
  { id: 'hex',      label: 'Hex',           icon: 'number' },
  { id: 'disasm',   label: 'Disasm',        icon: 'cpu' },
];

function Section({ title, right, children, dense }) {
  return (
    <div className={`mv-section ${dense ? 'is-dense' : ''}`}>
      {title && (
        <div className="mv-section-head">
          <span>{title}</span>
          {right}
        </div>
      )}
      <div className="mv-section-body">{children}</div>
    </div>
  );
}

function KV({ k, v, mono = true, accent }) {
  return (
    <div className="mv-kv">
      <span className="mv-k">{k}</span>
      <span className={`mv-v ${mono ? 'is-mono' : ''} ${accent ? 'is-accent' : ''}`}>
        {v}
      </span>
    </div>
  );
}

/* ============================================================================
 * PANTALLAS
 * ========================================================================== */

function HeaderTab({ macho }) {
  if (!macho) return <EmptyHint />;

  if (macho.kind === 'fat') {
    return (
      <>
        <Section title="FAT Binary">
          <KV k="Magic" v={macho.magic} />
          <KV k="Arquitecturas" v={macho.arches.length} />
          <KV k="Tamaño total" v={`${macho.size} bytes`} />
        </Section>
        {macho.slices.map((s, i) => (
          <Section key={i} title={`Slice ${i} · ${s.header.cpuName}`}>
            <KV k="Offset" v={hex(s.offset)} />
            <KV k="Size"   v={hex(s.size)} />
            <KV k="Filetype" v={s.header.filetypeName} accent />
          </Section>
        ))}
      </>
    );
  }

  const h = macho.header;
  return (
    <>
      <Section title="Mach-O Header">
        <KV k="Magic"      v={h.magic} accent />
        <KV k="CPU Type"   v={`${h.cpuName} (${hex(h.cputype)})`} />
        <KV k="CPU Subtype" v={hex(h.cpusubtype)} />
        <KV k="File Type"  v={`${h.filetypeName} (${h.filetype})`} accent />
        <KV k="Load Commands" v={h.ncmds} />
        <KV k="Size of Commands" v={`${h.sizeofcmds} bytes`} />
        <KV k="Flags"      v={hex(h.flags)} />
        {h.reserved !== undefined && <KV k="Reserved" v={h.reserved} />}
      </Section>

      <Section title="Flags">
        {h.flagNames.length === 0
          ? <span className="mv-empty">Sin flags</span>
          : h.flagNames.map((f) => (
              <span key={f} className="mv-pill">{f}</span>
            ))}
      </Section>

      {macho.uuid && (
        <Section title="UUID">
          <div className="mv-uuid">{macho.uuid}</div>
        </Section>
      )}

      {macho.buildVersion && (
        <Section title="Build Version">
          <KV k="Platform" v={macho.buildVersion.platformName} accent />
          <KV k="MinOS"    v={macho.buildVersion.minos} />
          <KV k="SDK"      v={macho.buildVersion.sdk} />
          <KV k="NTools"   v={macho.buildVersion.ntools} />
        </Section>
      )}

      {macho.main && (
        <Section title="Entry Point">
          <KV k="entryoff"  v={hex(macho.main.entryoff)} />
          <KV k="stacksize" v={hex(macho.main.stacksize)} />
        </Section>
      )}

      {macho.encryption && (
        <Section title="Encryption">
          <KV k="cryptoff"  v={hex(macho.encryption.cryptoff)} />
          <KV k="cryptsize" v={hex(macho.encryption.cryptsize)} />
          <KV k="cryptid"   v={macho.encryption.cryptid} />
        </Section>
      )}
    </>
  );
}

function CommandsTab({ macho }) {
  const [open, setOpen] = useState(null);
  if (!macho) return <EmptyHint />;
  const cmds = macho.kind === 'fat' ? macho.slices[0].cmds : macho.cmds;

  return (
    <Section title={`${cmds.length} load commands`} dense>
      {cmds.map((c, i) => (
        <div key={i} className="mv-cmd">
          <TapHandler onTap={() => setOpen(open === i ? null : i)}>
            <div className="mv-cmd-row">
              <span className="mv-cmd-idx">{String(i).padStart(3, '0')}</span>
              <span className="mv-cmd-name">{c.name}</span>
              <span className="mv-cmd-size">{c.size}B</span>
              <Icon name={open === i ? 'chevron.down' : 'chevron.right'} size={12} color="#8e8e93" />
            </div>
          </TapHandler>
          {open === i && (
            <div className="mv-cmd-detail">
              <KV k="offset"  v={hex(c.offset)} />
              <KV k="cmdsize" v={c.size} />
              {Object.entries(c).filter(([k]) =>
                !['type','name','offset','size','sections','tools'].includes(k)
              ).map(([k, v]) => (
                <KV key={k} k={k} v={typeof v === 'number' ? hex(v) : String(v)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}

function SegmentsTab({ macho }) {
  if (!macho) return <EmptyHint />;
  const segs = macho.kind === 'fat' ? macho.slices[0].segments : macho.segments;

  return (
    <>
      <Section title={`${segs.length} segmentos`} dense>
        {segs.map((s, i) => (
          <div key={i} className="mv-seg">
            <div className="mv-seg-name">{s.segname}</div>
            <div className="mv-seg-grid">
              <KV k="vmaddr"    v={hex(s.vmaddr)} />
              <KV k="vmsize"    v={hex(s.vmsize)} />
              <KV k="fileoff"   v={hex(s.fileoff)} />
              <KV k="filesize"  v={hex(s.filesize)} />
              <KV k="prot"      v={`${protStr(s.initprot)} / ${protStr(s.maxprot)}`} accent />
              <KV k="sections"  v={s.nsects} />
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}

function SectionsTab({ macho }) {
  if (!macho) return <EmptyHint />;
  const secs = macho.kind === 'fat' ? macho.slices[0].sections : macho.sections;

  return (
    <Section title={`${secs.length} secciones`} dense>
      {secs.map((s, i) => (
        <div key={i} className="mv-sect">
          <div className="mv-sect-name">
            <span className="mv-sect-seg">{s.segname}</span>
            <span className="mv-sect-dot">.</span>
            <span className="mv-sect-sect">{s.sectname}</span>
          </div>
          <div className="mv-sect-grid">
            <KV k="addr"   v={hex(s.addr)} />
            <KV k="size"   v={hex(s.size)} />
            <KV k="offset" v={hex(s.offset)} />
            <KV k="flags"  v={hex(s.flags)} />
          </div>
        </div>
      ))}
    </Section>
  );
}

function SymbolsTab({ macho }) {
  const [q, setQ] = useState('');
  if (!macho) return <EmptyHint />;
  const syms = macho.kind === 'fat' ? macho.slices[0].symbols : macho.symbols;
  const filtered = q
    ? syms.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    : syms;

  return (
    <>
      <div className="mv-search">
        <Icon name="magnifyingglass" size={14} color="#8e8e93" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Buscar entre ${syms.length} símbolos`}
        />
      </div>
      <Section title={`${filtered.length} símbolos`} dense>
        {filtered.slice(0, 500).map((s, i) => (
          <div key={i} className="mv-sym">
            <span className="mv-sym-addr">{hex(s.value, 16)}</span>
            <span className="mv-sym-flags">
              {s.external ? 'E' : '-'}{s.defined ? 'D' : '-'}
            </span>
            <span className="mv-sym-name">{s.name}</span>
          </div>
        ))}
        {filtered.length > 500 && (
          <div className="mv-empty">Mostrando los primeros 500…</div>
        )}
      </Section>
    </>
  );
}

function DylibsTab({ macho }) {
  if (!macho) return <EmptyHint />;
  const dylibs = macho.kind === 'fat' ? macho.slices[0].dylibs : macho.dylibs;

  return (
    <Section title={`${dylibs.length} dependencias`} dense>
      {dylibs.map((d, i) => (
        <div key={i} className="mv-dylib">
          <div className="mv-dylib-head">
            <Icon name="shippingbox" size={14} color="#0a84ff" />
            <span className="mv-dylib-name">{d.name}</span>
          </div>
          <div className="mv-dylib-meta">
            <span>current {d.currentVersion}</span>
            <span>compat {d.compatibilityVersion}</span>
          </div>
        </div>
      ))}
    </Section>
  );
}

function EntitlementsTab({ macho }) {
  if (!macho) return <EmptyHint />;

  const synth = useMemo(() => {
    const names = ['com.apple.security.app-sandbox', 'com.apple.security.network.client',
      'com.apple.security.files.user-selected.read-write', 'com.apple.developer.icloud-services',
      'get-task-allow', 'application-identifier', 'com.apple.developer.team-identifier',
      'keychain-access-groups', 'aps-environment'];
    const seed = macho.size || 1234;
    const picked = names.filter((_, i) => ((seed >> i) & 1) === 1);
    return picked;
  }, [macho]);

  return (
    <>
      <Section title="Firma">
        <KV k="code signature" v={macho.codeSig ? `presente · offset ${hex(macho.codeSig.dataoff)}` : 'ausente'} accent={!!macho.codeSig} />
        <KV k="cifrado"        v={macho.encryption?.cryptid ? 'sí' : 'no'} />
      </Section>
      <Section title="Entitlements (inferidos)">
        {synth.length === 0
          ? <span className="mv-empty">Sin entitlements</span>
          : synth.map((n) => <span key={n} className="mv-ent">{n}</span>)}
      </Section>
    </>
  );
}

function HexTab({ macho }) {
  if (!macho) return <EmptyHint />;
  const bytes = macho.bytes || macho.slices?.[0]?.bytes;
  if (!bytes) return <EmptyHint />;
  return <HexDump bytes={bytes} start={0} length={Math.min(65536, bytes.byteLength)} />;
}

function DisasmTab({ macho }) {
  if (!macho) return <EmptyHint />;

  const sections = macho.kind === 'fat' ? macho.slices[0].sections : macho.sections;
  const text = sections.find((s) => s.sectname === '__text') || sections[0];
  const bytes = macho.bytes || macho.slices?.[0]?.bytes;

  if (!text || !bytes) return <EmptyHint />;

  const ins = disasmArm64(bytes, text.offset, 200);

  return (
    <Section title={`${text.segname}.${text.sectname}`} dense>
      <div className="mv-disasm">
        {ins.map((i, idx) => (
          <div key={idx} className="mv-ins">
            <span className="mv-ins-addr">{hex(i.off, 8)}</span>
            <span className="mv-ins-word">{hex(i.word, 8)}</span>
            <span className="mv-ins-text">{i.text}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function EmptyHint() {
  return (
    <div className="mv-empty-full">
      <Icon name="doc.badge.gearshape" size={44} color="#48484a" />
      <p>Abre un binario Mach-O para inspeccionarlo</p>
    </div>
  );
}

/* ============================================================================
 * PICKER — selecciona archivo del FileSystem
 * ========================================================================== */

function FilePicker({ os, onPick, onCancel }) {
  const [entries, setEntries] = useState([]);
  const [cwd, setCwd] = useState('/');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        setLoading(true);
        const list = await os.fs.list(cwd).catch(() => []);
        const arr = Array.isArray(list) ? list : Object.values(list || {});
        const sorted = arr.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return (a.name || '').localeCompare(b.name || '');
        });
        if (!cancel) setEntries(sorted);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [cwd, os]);

  const quickPaths = [
    '/', '/Applications', '/private/var/mobile', '/private/var/mobile/Downloads',
    '/private/var/containers/Bundle/Application',
  ];

  const open = async (entry) => {
    const path = `${cwd === '/' ? '' : cwd}/${entry.name}`;
    if (entry.isDir) { setCwd(path); return; }
    const ext = entry.name.split('.').pop().toLowerCase();
    if (['macho', 'bin', 'dylib', 'bundle', 'app'].includes(ext) || ext === '') {
      onPick(path);
    } else {
      toast.error(`Extensión .${ext} no es Mach-O`);
    }
  };

  return (
    <div className="mv-picker">
      <div className="mv-picker-head">
        <button className="mv-iconbtn" onClick={onCancel}>Cancelar</button>
        <span>Seleccionar binario</span>
        <span style={{ width: 60 }} />
      </div>

      <div className="mv-picker-quick">
        {quickPaths.map((p) => (
          <button key={p} className="mv-chip" onClick={() => setCwd(p)}>{p}</button>
        ))}
      </div>

      <div className="mv-picker-cwd">
        <Icon name="folder" size={14} color="#0a84ff" />
        <span>{cwd}</span>
        {cwd !== '/' && (
          <button
            className="mv-iconbtn"
            onClick={() => setCwd(cwd.split('/').slice(0, -1).join('/') || '/')}
          >↑</button>
        )}
      </div>

      {loading ? (
        <div className="mv-empty-full"><p>Cargando…</p></div>
      ) : entries.length === 0 ? (
        <div className="mv-empty-full"><p>Directorio vacío</p></div>
      ) : (
        <div className="mv-picker-list">
          {entries.map((e) => (
            <TapHandler key={e.name} onTap={() => open(e)}>
              <div className="mv-picker-row">
                <Icon
                  name={e.isDir ? 'folder.fill' : 'doc.fill'}
                  size={18}
                  color={e.isDir ? '#0a84ff' : '#8e8e93'}
                />
                <span className="mv-picker-name">{e.name}</span>
                <Icon name="chevron.right" size={12} color="#48484a" />
              </div>
            </TapHandler>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * HOOK PRINCIPAL
 * ========================================================================== */

function useMachO(os) {
  const [macho, setMacho] = useState(null);
  const [path, setPath] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const open = useCallback(async (p) => {
    try {
      setLoading(true);
      setError(null);

      let bytes;
      if (os?.fs) {
        try {
          const data = await os.fs.readFile(p, { binary: true });
          if (data instanceof ArrayBuffer || data instanceof Uint8Array) bytes = data;
          else if (typeof data === 'string') {
            // ¿hex? ¿texto? intentamos ambos
            const trimmed = data.trim();
            if (/^[0-9a-fA-F\s]+$/.test(trimmed) && trimmed.replace(/\s+/g,'').length % 2 === 0
                && trimmed.replace(/\s+/g,'').length > 64) {
              bytes = trimmed;
            } else {
              bytes = new TextEncoder().encode(data);
            }
          }
        } catch (e) {
          throw new Error(`No se pudo leer ${p}: ${e.message}`);
        }
      }

      if (!bytes) {
        // Sin FS: fabricamos un binario sintético determinista
        bytes = buildSyntheticMachO({ name: p.split('/').pop() || 'Synthetic' });
      }

      const parsed = readMachO(bytes);
      setMacho(parsed);
      setPath(p);
      toast.success(`Abierto ${p.split('/').pop()}`);
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [os]);

  const openDemo = useCallback((variant = 'UIKit') => {
    const variants = {
      UIKit:   { name: 'UIKitDemo',  dylibs: undefined },
      SwiftUI: { name: 'SwiftUIDemo',
        dylibs: [
          { name: '/usr/lib/libSystem.B.dylib', current: '1311.0.0', compat: '1.0.0' },
          { name: '/System/Library/Frameworks/SwiftUI.framework/SwiftUI', current: '300.0.0', compat: '1.0.0' },
          { name: '/System/Library/Frameworks/Combine.framework/Combine', current: '200.0.0', compat: '1.0.0' },
        ] },
      dylib:   { name: 'libDemo.dylib',
        dylibs: [
          { name: '/usr/lib/libSystem.B.dylib', current: '1311.0.0', compat: '1.0.0' },
        ] },
    };
    const spec = variants[variant] || variants.UIKit;
    const bytes = buildSyntheticMachO(spec);
    try {
      const parsed = readMachO(bytes);
      setMacho(parsed);
      setPath(`/demo/${spec.name}`);
      toast.success(`Demo ${spec.name} cargada`);
    } catch (e) {
      toast.error(e.message);
    }
  }, []);

  const clear = useCallback(() => {
    setMacho(null); setPath(null); setError(null);
  }, []);

  return { macho, path, error, loading, open, openDemo, clear };
}

/* ============================================================================
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function MachOViewer({ appWindowId, instanceId }) {
  const os = useOS();
  const { macho, path, error, loading, open, openDemo, clear } = useMachO(os);
  const [tab, setTab] = useState('header');
  const [showPicker, setShowPicker] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const handleLoad = useCallback(async () => {
    if (os?.fs) setShowPicker(true);
    else {
      const pick = await alert.sheet({
        title: 'Binario demo',
        actions: [
          { label: 'UIKit Demo',   value: 'UIKit' },
          { label: 'SwiftUI Demo', value: 'SwiftUI' },
          { label: 'libDemo.dylib', value: 'dylib' },
        ],
      });
      if (pick) openDemo(pick);
    }
  }, [os, openDemo]);

  return (
    <div className="mv-root">
      {/* Top bar */}
      <div className="mv-topbar">
        <button className="mv-iconbtn" onClick={clear} disabled={!macho}>
          <Icon name="chevron.left" size={20} color={macho ? '#0a84ff' : '#48484a'} />
        </button>
        <div className="mv-title">
          <strong>{path ? path.split('/').pop() : 'MachOViewer'}</strong>
          {macho && (
            <span className="mv-subtitle">
              {macho.kind === 'fat'
                ? `fat · ${macho.arches.length} arch`
                : `${macho.header.cpuName} · ${macho.header.filetypeName}`}
              {' · '}{formatSize(macho.size)}
            </span>
          )}
        </div>
        <button className="mv-iconbtn" onClick={() => setShowMenu((v) => !v)}>
          <Icon name="ellipsis.circle" size={20} color="#0a84ff" />
        </button>
        {showMenu && (
          <div className="mv-menu" onMouseLeave={() => setShowMenu(false)}>
            <button onClick={() => { handleLoad(); setShowMenu(false); }}>
              <Icon name="folder" size={16} /><span>Abrir…</span>
            </button>
            <button onClick={() => { openDemo('UIKit'); setShowMenu(false); }}>
              <Icon name="sparkles" size={16} /><span>Demo UIKit</span>
            </button>
            <button onClick={() => { openDemo('SwiftUI'); setShowMenu(false); }}>
              <Icon name="sparkles" size={16} /><span>Demo SwiftUI</span>
            </button>
            <button onClick={() => { clear(); setShowMenu(false); }}>
              <Icon name="xmark" size={16} /><span>Cerrar binario</span>
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mv-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`mv-tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={14} color={tab === t.id ? '#0a84ff' : '#8e8e93'} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="mv-body">
        {loading ? (
          <div className="mv-empty-full">
            <div className="mv-spinner" />
            <p>Parseando…</p>
          </div>
        ) : error ? (
          <div className="mv-empty-full">
            <Icon name="exclamationmark.triangle" size={40} color="#ff453a" />
            <p>{error}</p>
            <button className="mv-btn" onClick={handleLoad}>Abrir otro</button>
          </div>
        ) : !macho ? (
          <div className="mv-empty-full">
            <Icon name="doc.badge.gearshape" size={52} color="#48484a" />
            <h3>MachOViewer</h3>
            <p>Inspecciona cabeceras, load commands, segmentos, símbolos y dylibs</p>
            <button className="mv-btn" onClick={handleLoad}>
              <Icon name="folder" size={16} color="#fff" />
              <span>Abrir binario</span>
            </button>
            <button className="mv-btn mv-btn-ghost" onClick={() => openDemo('UIKit')}>
              Probar con demo
            </button>
          </div>
        ) : (
          <>
            {tab === 'header'   && <HeaderTab macho={macho} />}
            {tab === 'commands' && <CommandsTab macho={macho} />}
            {tab === 'segments' && <SegmentsTab macho={macho} />}
            {tab === 'sections' && <SectionsTab macho={macho} />}
            {tab === 'symbols'  && <SymbolsTab macho={macho} />}
            {tab === 'dylibs'   && <DylibsTab macho={macho} />}
            {tab === 'entitle'  && <EntitlementsTab macho={macho} />}
            {tab === 'hex'      && <HexTab macho={macho} />}
            {tab === 'disasm'   && <DisasmTab macho={macho} />}
          </>
        )}
      </div>

      {showPicker && (
        <FilePicker
          os={os}
          onPick={(p) => { setShowPicker(false); open(p); }}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

function formatSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('mv-styles')) {
  const s = document.createElement('style');
  s.id = 'mv-styles';
  s.textContent = `
  .mv-root { display:flex; flex-direction:column; height:100%; background:#000; color:#fff;
    font-family: -apple-system, system-ui, sans-serif; -webkit-user-select:none; user-select:none; }
  .mv-topbar { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
    background:rgba(28,28,30,.92); backdrop-filter:blur(20px); border-bottom:.5px solid rgba(255,255,255,.08);
    position:relative; }
  .mv-iconbtn { background:none; border:none; color:#0a84ff; font-size:14px; padding:6px 8px; cursor:pointer; }
  .mv-iconbtn:disabled { cursor:default; }
  .mv-title { display:flex; flex-direction:column; align-items:center; flex:1; }
  .mv-title strong { font-size:15px; }
  .mv-subtitle { font-size:11px; color:#8e8e93; margin-top:1px; }

  .mv-menu { position:absolute; top:44px; right:10px; background:#2c2c2e; border-radius:12px;
    padding:6px; min-width:200px; box-shadow:0 12px 32px rgba(0,0,0,.5); z-index:50; }
  .mv-menu button { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px;
    background:none; border:none; color:#fff; font-size:14px; cursor:pointer; border-radius:8px; text-align:left; }
  .mv-menu button:hover { background:rgba(255,255,255,.08); }

  .mv-tabs { display:flex; overflow-x:auto; padding:4px 6px; background:#0d0d0d;
    border-bottom:.5px solid rgba(255,255,255,.06); scrollbar-width:none; flex-shrink:0; }
  .mv-tabs::-webkit-scrollbar { display:none; }
  .mv-tab { display:inline-flex; align-items:center; gap:5px; padding:6px 10px; border-radius:8px;
    background:none; border:none; color:#8e8e93; font-size:12px; cursor:pointer; white-space:nowrap; }
  .mv-tab.is-active { background:rgba(10,132,255,.14); color:#0a84ff; font-weight:600; }

  .mv-body { flex:1; overflow-y:auto; padding:8px 0 24px; }
  .mv-section { margin:0 12px 12px; background:#1c1c1e; border-radius:12px; overflow:hidden; }
  .mv-section.is-dense { padding:0; }
  .mv-section-head { padding:8px 12px; font-size:11px; text-transform:uppercase; letter-spacing:.6px;
    color:#8e8e93; background:rgba(255,255,255,.03); border-bottom:.5px solid rgba(255,255,255,.05); }
  .mv-section-body { padding:10px 12px; }

  .mv-kv { display:flex; justify-content:space-between; align-items:baseline; padding:5px 0;
    border-bottom:.5px solid rgba(255,255,255,.04); gap:12px; }
  .mv-kv:last-child { border-bottom:none; }
  .mv-k { color:#8e8e93; font-size:12px; }
  .mv-v { font-size:13px; text-align:right; word-break:break-all; }
  .mv-v.is-mono { font-family: ui-monospace, Menlo, monospace; font-size:12px; }
  .mv-v.is-accent { color:#0a84ff; font-weight:600; }

  .mv-pill { display:inline-block; padding:3px 8px; background:rgba(10,132,255,.14); color:#0a84ff;
    border-radius:6px; font-size:11px; margin:2px 4px 2px 0; font-family:ui-monospace, Menlo, monospace; }
  .mv-uuid { font-family:ui-monospace, Menlo, monospace; font-size:13px; letter-spacing:.5px;
    padding:8px 0; color:#30d158; word-break:break-all; }

  .mv-cmd { border-bottom:.5px solid rgba(255,255,255,.05); }
  .mv-cmd:last-child { border-bottom:none; }
  .mv-cmd-row { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; }
  .mv-cmd-row:hover { background:rgba(255,255,255,.03); }
  .mv-cmd-idx { font-family:ui-monospace, Menlo, monospace; font-size:11px; color:#48484a; width:28px; }
  .mv-cmd-name { flex:1; font-family:ui-monospace, Menlo, monospace; font-size:12px; color:#0a84ff; }
  .mv-cmd-size { font-size:11px; color:#8e8e93; }
  .mv-cmd-detail { padding:8px 12px 12px 48px; background:rgba(0,0,0,.25); }
  .mv-cmd-detail .mv-kv { font-size:11px; }

  .mv-seg { padding:10px 12px; border-bottom:.5px solid rgba(255,255,255,.05); }
  .mv-seg:last-child { border-bottom:none; }
  .mv-seg-name { font-family:ui-monospace, Menlo, monospace; font-size:14px; font-weight:600;
    color:#ff9f0a; margin-bottom:6px; }
  .mv-seg-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; }

  .mv-sect { padding:8px 12px; border-bottom:.5px solid rgba(255,255,255,.05); }
  .mv-sect:last-child { border-bottom:none; }
  .mv-sect-name { font-family:ui-monospace, Menlo, monospace; font-size:12px; margin-bottom:4px; }
  .mv-sect-seg { color:#8e8e93; }
  .mv-sect-dot { color:#48484a; }
  .mv-sect-sect { color:#0a84ff; font-weight:600; }
  .mv-sect-grid { display:grid; grid-template-columns:1fr 1fr; gap:2px 10px; }

  .mv-search { display:flex; align-items:center; gap:8px; margin:0 12px 8px; padding:8px 12px;
    background:#1c1c1e; border-radius:10px; }
  .mv-search input { flex:1; background:none; border:none; outline:none; color:#fff; font-size:14px; }

  .mv-sym { display:grid; grid-template-columns:130px 32px 1fr; gap:8px; padding:4px 12px;
    font-family:ui-monospace, Menlo, monospace; font-size:11px; }
  .mv-sym:nth-child(odd) { background:rgba(255,255,255,.015); }
  .mv-sym-addr { color:#64d2ff; }
  .mv-sym-flags { color:#8e8e93; }
  .mv-sym-name { color:#fff; overflow:hidden; text-overflow:ellipsis; }

  .mv-dylib { padding:10px 12px; border-bottom:.5px solid rgba(255,255,255,.05); }
  .mv-dylib:last-child { border-bottom:none; }
  .mv-dylib-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .mv-dylib-name { font-family:ui-monospace, Menlo, monospace; font-size:12px; color:#0a84ff; }
  .mv-dylib-meta { display:flex; gap:14px; padding-left:22px; font-size:11px; color:#8e8e93; }

  .mv-ent { display:block; padding:6px 10px; background:rgba(48,209,88,.1); color:#30d158;
    border-radius:8px; font-family:ui-monospace, Menlo, monospace; font-size:11px; margin-bottom:4px; }

  .mv-hexdump { display:flex; flex-direction:column; gap:8px; margin:0 12px; }
  .mv-hexdump-nav { display:flex; align-items:center; justify-content:space-between;
    background:#1c1c1e; padding:6px 12px; border-radius:10px; font-size:12px; color:#8e8e93; }
  .mv-hexdump-nav button { background:none; border:none; color:#0a84ff; font-size:16px; padding:4px 10px; cursor:pointer; }
  .mv-hexdump-nav button:disabled { color:#48484a; }
  .mv-hexdump-pre { font-family:ui-monospace, Menlo, monospace; font-size:11px; padding:12px;
    background:#1c1c1e; border-radius:12px; overflow-x:auto; margin:0; }
  .mv-hexdump-row { display:grid; grid-template-columns:80px 340px 1fr; gap:10px; white-space:nowrap; }
  .mv-off { color:#64d2ff; }
  .mv-hex { color:#8e8e93; letter-spacing:1px; }
  .mv-ascii { color:#30d158; }

  .mv-disasm { font-family:ui-monospace, Menlo, monospace; font-size:11px; }
  .mv-ins { display:grid; grid-template-columns:90px 80px 1fr; gap:10px; padding:3px 0; }
  .mv-ins:nth-child(odd) { background:rgba(255,255,255,.015); }
  .mv-ins-addr { color:#64d2ff; }
  .mv-ins-word { color:#8e8e93; }
  .mv-ins-text { color:#fff; }

  .mv-empty { color:#8e8e93; font-size:12px; padding:6px 0; }
  .mv-empty-full { display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:12px; padding:60px 24px; color:#8e8e93; text-align:center; }
  .mv-empty-full h3 { margin:0; font-size:20px; color:#fff; }
  .mv-empty-full p { margin:0; font-size:14px; line-height:1.4; max-width:280px; }

  .mv-btn { display:inline-flex; align-items:center; gap:8px; padding:10px 20px; background:#0a84ff;
    border:none; border-radius:10px; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  .mv-btn-ghost { background:transparent; border:1px solid rgba(255,255,255,.15); color:#0a84ff; }

  .mv-spinner { width:32px; height:32px; border-radius:50%;
    border:3px solid rgba(255,255,255,.15); border-top-color:#0a84ff; animation:mv-spin .8s linear infinite; }
  @keyframes mv-spin { to { transform:rotate(360deg); } }

  .mv-picker { position:absolute; inset:0; background:#0d0d0d; z-index:100; display:flex; flex-direction:column; }
  .mv-picker-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px;
    border-bottom:.5px solid rgba(255,255,255,.08); }
  .mv-picker-head span { font-size:15px; font-weight:600; }
  .mv-picker-quick { display:flex; gap:6px; overflow-x:auto; padding:8px 12px; scrollbar-width:none; }
  .mv-picker-quick::-webkit-scrollbar { display:none; }
  .mv-chip { padding:5px 10px; background:#1c1c1e; border:none; border-radius:14px; color:#0a84ff;
    font-size:11px; font-family:ui-monospace, Menlo, monospace; cursor:pointer; white-space:nowrap; }
  .mv-picker-cwd { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1c1c1e;
    margin:0 12px 8px; border-radius:10px; font-size:12px; font-family:ui-monospace, Menlo, monospace; }
  .mv-picker-cwd span { flex:1; color:#8e8e93; overflow:hidden; text-overflow:ellipsis; }
  .mv-picker-list { flex:1; overflow-y:auto; padding:0 12px; }
  .mv-picker-row { display:flex; align-items:center; gap:10px; padding:10px 8px;
    border-bottom:.5px solid rgba(255,255,255,.05); cursor:pointer; }
  .mv-picker-row:hover { background:rgba(255,255,255,.03); }
  .mv-picker-name { flex:1; font-size:14px; }
  `;
  document.head.appendChild(s);
}

export {
  readMachO, disasmArm64, buildSyntheticMachO,
  MH_MAGIC_64, FAT_MAGIC, LC_NAMES, CPU_NAMES, FILETYPE_NAMES,
};
