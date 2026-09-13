// src/loader/MachOStructures.js
// Constantes y structs del formato Mach-O (Apple).
// - Magics: MH_MAGIC, MH_MAGIC_64, MH_CIGAM, FAT_MAGIC, FAT_MAGIC_64
// - CPU types: ARM64, ARM64e, x86_64, etc.
// - Filetypes: OBJECT, EXECUTE, DYLIB, BUNDLE, ...
// - Load commands: LC_SEGMENT_64, LC_SYMTAB, LC_DYLD_INFO, LC_MAIN, ...
// - Segment/Section flags
// - nlist (símbolos)
// - dyld info opcodes (rebase/bind/export)
// - BinaryReader endian-aware con helpers (u8/u16/u32/u64, cstring, fixed, uuid)
// Sin dependencias externas.

/* ------------------------------------------------------------------ *
 * Magics
 * ------------------------------------------------------------------ */

export const MH_MAGIC      = 0xfeedface;   // 32-bit
export const MH_CIGAM      = 0xcefaedfe;   // 32-bit byte-swapped
export const MH_MAGIC_64   = 0xfeedfacf;   // 64-bit
export const MH_CIGAM_64   = 0xcffaedfe;   // 64-bit byte-swapped

export const FAT_MAGIC     = 0xcafebabe;   // fat binary (big-endian)
export const FAT_CIGAM     = 0xbebafeca;
export const FAT_MAGIC_64  = 0xcafebabf;   // fat con offsets 64-bit
export const FAT_CIGAM_64  = 0xbfbafeca;

// Used to detect static archives (ar)
export const ARMAG         = 0x213c617263683e0a; // "!<arch>\n" (64-bit view)
export const ARMAG_SHORT   = 0x213c6172;         // "!<ar"

/* ------------------------------------------------------------------ *
 * CPU types
 * ------------------------------------------------------------------ */

export const CPU_ARCH_ABI64     = 0x01000000;
export const CPU_ARCH_ABI64_32  = 0x02000000;

export const CPU_TYPE_X86       = 7;
export const CPU_TYPE_X86_64    = CPU_TYPE_X86 | CPU_ARCH_ABI64;
export const CPU_TYPE_ARM       = 12;
export const CPU_TYPE_ARM64     = CPU_TYPE_ARM | CPU_ARCH_ABI64;
export const CPU_TYPE_ARM64_32  = CPU_TYPE_ARM | CPU_ARCH_ABI64_32;
export const CPU_TYPE_POWERPC   = 18;
export const CPU_TYPE_POWERPC64 = CPU_TYPE_POWERPC | CPU_ARCH_ABI64;

export const CPU_SUBTYPE_MASK   = 0xff000000;
export const CPU_SUBTYPE_LIB64  = 0x80000000;

export const CPU_SUBTYPE_ARM64_ALL   = 0;
export const CPU_SUBTYPE_ARM64_V8    = 1;
export const CPU_SUBTYPE_ARM64E      = 2;
export const CPU_SUBTYPE_ARM64E_V2   = 3;

export const CPU_SUBTYPE_X86_64_ALL  = 3;
export const CPU_SUBTYPE_X86_64_H    = 8;

// Mapa nombre → valor para impresión
export const CPU_NAMES = {
  [CPU_TYPE_X86]:      'x86',
  [CPU_TYPE_X86_64]:   'x86_64',
  [CPU_TYPE_ARM]:      'arm',
  [CPU_TYPE_ARM64]:    'arm64',
  [CPU_TYPE_ARM64_32]: 'arm64_32',
  [CPU_TYPE_POWERPC]:  'ppc',
  [CPU_TYPE_POWERPC64]:'ppc64',
};

export const CPU_SUBTYPE_NAMES = {
  [CPU_TYPE_ARM64]: {
    [CPU_SUBTYPE_ARM64_ALL]: 'arm64 (all)',
    [CPU_SUBTYPE_ARM64_V8]:  'arm64 (v8)',
    [CPU_SUBTYPE_ARM64E]:    'arm64e',
    [CPU_SUBTYPE_ARM64E_V2]: 'arm64e (v2)',
  },
  [CPU_TYPE_X86_64]: {
    [CPU_SUBTYPE_X86_64_ALL]: 'x86_64 (all)',
    [CPU_SUBTYPE_X86_64_H]:   'x86_64 (Haswell)',
  },
};

/* ------------------------------------------------------------------ *
 * Filetypes
 * ------------------------------------------------------------------ */

export const MH_OBJECT      = 0x1;    // .o
export const MH_EXECUTE     = 0x2;    // ejecutable
export const MH_FVMLIB      = 0x3;    // fixed VM shared library
export const MH_CORE        = 0x4;    // core dump
export const MH_PRELOAD     = 0x5;    // preloaded executable
export const MH_DYLIB       = 0x6;    // dynamic library (.dylib)
export const MH_DYLINKER    = 0x7;    // dyld
export const MH_BUNDLE      = 0x8;    // .bundle
export const MH_DYLIB_STUB  = 0x9;
export const MH_DSYM        = 0xa;
export const MH_KEXT_BUNDLE = 0xb;    // kernel extension
export const MH_FILESET     = 0xc;    // kernel cache fileset

export const FILETYPE_NAMES = {
  [MH_OBJECT]: 'OBJECT', [MH_EXECUTE]: 'EXECUTE', [MH_FVMLIB]: 'FVMLIB',
  [MH_CORE]: 'CORE', [MH_PRELOAD]: 'PRELOAD', [MH_DYLIB]: 'DYLIB',
  [MH_DYLINKER]: 'DYLINKER', [MH_BUNDLE]: 'BUNDLE', [MH_DYLIB_STUB]: 'DYLIB_STUB',
  [MH_DSYM]: 'DSYM', [MH_KEXT_BUNDLE]: 'KEXT_BUNDLE', [MH_FILESET]: 'FILESET',
};

/* ------------------------------------------------------------------ *
 * Header flags (mach_header_64.flags)
 * ------------------------------------------------------------------ */

export const MH_NOUNDEFS                = 0x1;
export const MH_INCRLINK                = 0x2;
export const MH_DYLDLINK                = 0x4;
export const MH_BINDATLOAD              = 0x8;
export const MH_PREBOUND                = 0x10;
export const MH_SPLIT_SEGS              = 0x20;
export const MH_LAZY_INIT               = 0x40;
export const MH_TWOLEVEL                = 0x80;
export const MH_FORCE_FLAT              = 0x100;
export const MH_NOMULTIDEFS             = 0x200;
export const MH_NOFIXPREBINDING         = 0x400;
export const MH_PREBINDABLE             = 0x800;
export const MH_ALLMODSBOUND            = 0x1000;
export const MH_SUBSECTIONS_VIA_SYMBOLS = 0x2000;
export const MH_CANONICAL               = 0x4000;
export const MH_WEAK_DEFINES            = 0x8000;
export const MH_BINDS_TO_WEAK           = 0x10000;
export const MH_ALLOW_STACK_EXECUTION   = 0x20000;
export const MH_ROOT_SAFE               = 0x40000;
export const MH_SETUID_SAFE             = 0x80000;
export const MH_NO_REEXPORTED_DYLIBS    = 0x100000;
export const MH_PIE                     = 0x200000;   // position independent executable
export const MH_DEAD_STRIPPABLE_DYLIB   = 0x400000;
export const MH_HAS_TLV_DESCRIPTORS     = 0x800000;
export const MH_NO_HEAP_EXECUTION       = 0x1000000;
export const MH_APP_EXTENSION_SAFE      = 0x02000000;
export const MH_NLIST_OUTOFSYNC_WITH_DYLDINFO = 0x04000000;
export const MH_SIM_SUPPORT             = 0x08000000;
export const MH_DYLIB_IN_CACHE          = 0x80000000;

export const HEADER_FLAG_NAMES = {
  [MH_NOUNDEFS]: 'NOUNDEFS',
  [MH_INCRLINK]: 'INCRLINK',
  [MH_DYLDLINK]: 'DYLDLINK',
  [MH_BINDATLOAD]: 'BINDATLOAD',
  [MH_PREBOUND]: 'PREBOUND',
  [MH_SPLIT_SEGS]: 'SPLIT_SEGS',
  [MH_TWOLEVEL]: 'TWOLEVEL',
  [MH_FORCE_FLAT]: 'FORCE_FLAT',
  [MH_SUBSECTIONS_VIA_SYMBOLS]: 'SUBSECTIONS_VIA_SYMBOLS',
  [MH_PIE]: 'PIE',
  [MH_NO_HEAP_EXECUTION]: 'NO_HEAP_EXECUTION',
  [MH_APP_EXTENSION_SAFE]: 'APP_EXTENSION_SAFE',
  [MH_DYLIB_IN_CACHE]: 'DYLIB_IN_CACHE',
};

/* ------------------------------------------------------------------ *
 * Load commands
 * ------------------------------------------------------------------ */

export const LC_REQ_DYLD = 0x80000000;

export const LC_SEGMENT            = 0x1;
export const LC_SYMTAB             = 0x2;
export const LC_SYMSEG             = 0x3;
export const LC_THREAD             = 0x4;
export const LC_UNIXTHREAD         = 0x5;
export const LC_LOADFVMLIB         = 0x6;
export const LC_IDFVMLIB           = 0x7;
export const LC_IDENT              = 0x8;
export const LC_FVMFILE            = 0x9;
export const LC_PREPAGE            = 0xa;
export const LC_DYSYMTAB           = 0xb;
export const LC_LOAD_DYLIB         = 0xc;
export const LC_ID_DYLIB           = 0xd;
export const LC_LOAD_DYLINKER      = 0xe;
export const LC_ID_DYLINKER        = 0xf;
export const LC_PREBOUND_DYLIB     = 0x10;
export const LC_ROUTINES           = 0x11;
export const LC_SUB_FRAMEWORK      = 0x12;
export const LC_SUB_UMBRELLA       = 0x13;
export const LC_SUB_CLIENT         = 0x14;
export const LC_SUB_LIBRARY        = 0x15;
export const LC_TWOLEVEL_HINTS     = 0x16;
export const LC_PREBIND_CKSUM      = 0x17;

export const LC_LOAD_WEAK_DYLIB    = 0x18 | LC_REQ_DYLD;
export const LC_SEGMENT_64         = 0x19;
export const LC_ROUTINES_64        = 0x1a;
export const LC_UUID               = 0x1b;
export const LC_RPATH              = 0x1c | LC_REQ_DYLD;
export const LC_CODE_SIGNATURE     = 0x1d;
export const LC_SEGMENT_SPLIT_INFO = 0x1e;
export const LC_REEXPORT_DYLIB     = 0x1f | LC_REQ_DYLD;
export const LC_LAZY_LOAD_DYLIB    = 0x20;
export const LC_ENCRYPTION_INFO    = 0x21;
export const LC_DYLD_INFO          = 0x22;
export const LC_DYLD_INFO_ONLY     = 0x22 | LC_REQ_DYLD;
export const LC_LOAD_UPWARD_DYLIB  = 0x23 | LC_REQ_DYLD;
export const LC_VERSION_MIN_MACOSX = 0x24;
export const LC_VERSION_MIN_IPHONEOS = 0x25;
export const LC_FUNCTION_STARTS    = 0x26;
export const LC_DYLD_ENVIRONMENT   = 0x27;
export const LC_MAIN               = 0x28 | LC_REQ_DYLD;
export const LC_DATA_IN_CODE       = 0x29;
export const LC_SOURCE_VERSION     = 0x2a;
export const LC_DYLIB_CODE_SIGN_DRS = 0x2b;
export const LC_ENCRYPTION_INFO_64 = 0x2c;
export const LC_LINKER_OPTION      = 0x2d;
export const LC_LINKER_OPTIMIZATION_HINT = 0x2e;
export const LC_VERSION_MIN_TVOS   = 0x2f;
export const LC_VERSION_MIN_WATCHOS= 0x30;
export const LC_NOTE               = 0x31;
export const LC_BUILD_VERSION      = 0x32;
export const LC_DYLD_EXPORTS_TRIE  = 0x33 | LC_REQ_DYLD;
export const LC_DYLD_CHAINED_FIXUPS= 0x34 | LC_REQ_DYLD;
export const LC_FILESET_ENTRY      = 0x35 | LC_REQ_DYLD;

// LC_BUILD_VERSION platforms
export const PLATFORM_MACOS        = 1;
export const PLATFORM_IOS          = 2;
export const PLATFORM_TVOS         = 3;
export const PLATFORM_WATCHOS      = 4;
export const PLATFORM_BRIDGEOS     = 5;
export const PLATFORM_MACCATALYST  = 6;
export const PLATFORM_IOSSIMULATOR = 7;
export const PLATFORM_TVOSSIMULATOR= 8;
export const PLATFORM_WATCHOSSIMULATOR = 9;
export const PLATFORM_DRIVERKIT    = 10;
export const PLATFORM_VISIONOS     = 11;
export const PLATFORM_VISIONOSSIMULATOR = 12;

export const PLATFORM_NAMES = {
  [PLATFORM_MACOS]: 'macOS',
  [PLATFORM_IOS]: 'iOS',
  [PLATFORM_TVOS]: 'tvOS',
  [PLATFORM_WATCHOS]: 'watchOS',
  [PLATFORM_BRIDGEOS]: 'bridgeOS',
  [PLATFORM_MACCATALYST]: 'macCatalyst',
  [PLATFORM_IOSSIMULATOR]: 'iOS Simulator',
  [PLATFORM_TVOSSIMULATOR]: 'tvOS Simulator',
  [PLATFORM_WATCHOSSIMULATOR]: 'watchOS Simulator',
  [PLATFORM_DRIVERKIT]: 'DriverKit',
  [PLATFORM_VISIONOS]: 'visionOS',
  [PLATFORM_VISIONOSSIMULATOR]: 'visionOS Simulator',
};

export const LC_NAMES = {
  [LC_SEGMENT]: 'LC_SEGMENT',
  [LC_SYMTAB]: 'LC_SYMTAB',
  [LC_DYSYMTAB]: 'LC_DYSYMTAB',
  [LC_LOAD_DYLIB]: 'LC_LOAD_DYLIB',
  [LC_ID_DYLIB]: 'LC_ID_DYLIB',
  [LC_LOAD_DYLINKER]: 'LC_LOAD_DYLINKER',
  [LC_ID_DYLINKER]: 'LC_ID_DYLINKER',
  [LC_LOAD_WEAK_DYLIB]: 'LC_LOAD_WEAK_DYLIB',
  [LC_SEGMENT_64]: 'LC_SEGMENT_64',
  [LC_UUID]: 'LC_UUID',
  [LC_RPATH]: 'LC_RPATH',
  [LC_CODE_SIGNATURE]: 'LC_CODE_SIGNATURE',
  [LC_SEGMENT_SPLIT_INFO]: 'LC_SEGMENT_SPLIT_INFO',
  [LC_REEXPORT_DYLIB]: 'LC_REEXPORT_DYLIB',
  [LC_DYLD_INFO]: 'LC_DYLD_INFO',
  [LC_DYLD_INFO_ONLY]: 'LC_DYLD_INFO_ONLY',
  [LC_FUNCTION_STARTS]: 'LC_FUNCTION_STARTS',
  [LC_MAIN]: 'LC_MAIN',
  [LC_DATA_IN_CODE]: 'LC_DATA_IN_CODE',
  [LC_SOURCE_VERSION]: 'LC_SOURCE_VERSION',
  [LC_BUILD_VERSION]: 'LC_BUILD_VERSION',
  [LC_DYLD_EXPORTS_TRIE]: 'LC_DYLD_EXPORTS_TRIE',
  [LC_DYLD_CHAINED_FIXUPS]: 'LC_DYLD_CHAINED_FIXUPS',
  [LC_VERSION_MIN_IPHONEOS]: 'LC_VERSION_MIN_IPHONEOS',
  [LC_VERSION_MIN_MACOSX]: 'LC_VERSION_MIN_MACOSX',
  [LC_ENCRYPTION_INFO]: 'LC_ENCRYPTION_INFO',
  [LC_ENCRYPTION_INFO_64]: 'LC_ENCRYPTION_INFO_64',
  [LC_FILESET_ENTRY]: 'LC_FILESET_ENTRY',
};

/* ------------------------------------------------------------------ *
 * VM protection flags
 * ------------------------------------------------------------------ */

export const VM_PROT_NONE  = 0x00;
export const VM_PROT_READ  = 0x01;
export const VM_PROT_WRITE = 0x02;
export const VM_PROT_EXECUTE = 0x04;
export const VM_PROT_COPY  = 0x10;

/* ------------------------------------------------------------------ *
 * Segment flags
 * ------------------------------------------------------------------ */

export const SG_HIGHVM            = 0x1;
export const SG_FVMLIB            = 0x2;
export const SG_NORELOC           = 0x4;
export const SG_PROTECTED_VERSION_1 = 0x8;
export const SG_READ_ONLY         = 0x10;

/* ------------------------------------------------------------------ *
 * Section flags (type | attributes)
 * ------------------------------------------------------------------ */

export const SECTION_TYPE              = 0x000000ff;
export const SECTION_ATTRIBUTES        = 0xffffff00;
export const SECTION_ATTRIBUTES_USR    = 0xff000000;
export const SECTION_ATTRIBUTES_SYS    = 0x00ffff00;

export const S_REGULAR                 = 0x0;
export const S_ZEROFILL                = 0x1;
export const S_CSTRING_LITERALS        = 0x2;
export const S_4BYTE_LITERALS          = 0x3;
export const S_8BYTE_LITERALS          = 0x4;
export const S_LITERAL_POINTERS        = 0x5;
export const S_NON_LAZY_SYMBOL_POINTERS= 0x6;
export const S_LAZY_SYMBOL_POINTERS    = 0x7;
export const S_SYMBOL_STUBS            = 0x8;
export const S_MOD_INIT_FUNC_POINTERS  = 0x9;
export const S_MOD_TERM_FUNC_POINTERS  = 0xa;
export const S_COALESCED               = 0xb;
export const S_GB_ZEROFILL             = 0xc;
export const S_INTERPOSING             = 0xd;
export const S_16BYTE_LITERALS         = 0xe;
export const S_DTRACE_DOF              = 0xf;
export const S_LAZY_DYLIB_SYMBOL_POINTERS = 0x10;
export const S_THREAD_LOCAL_REGULAR    = 0x11;
export const S_THREAD_LOCAL_ZEROFILL   = 0x12;
export const S_THREAD_LOCAL_VARIABLES  = 0x13;
export const S_THREAD_LOCAL_VARIABLE_POINTERS = 0x14;
export const S_THREAD_LOCAL_INIT_FUNCTION_POINTERS = 0x15;
export const S_INIT_FUNC_OFFSETS       = 0x16;

export const SECTION_ATTR_PURE_INSTRUCTIONS   = 0x80000000;
export const SECTION_ATTR_NO_TOC              = 0x40000000;
export const SECTION_ATTR_STRIP_STATIC_SYMS   = 0x20000000;
export const SECTION_ATTR_NO_DEAD_STRIP       = 0x10000000;
export const SECTION_ATTR_LIVE_SUPPORT        = 0x08000000;
export const SECTION_ATTR_SELF_MODIFYING_CODE = 0x04000000;
export const SECTION_ATTR_DEBUG               = 0x02000000;
export const SECTION_ATTR_SOME_INSTRUCTIONS   = 0x00000400;
export const SECTION_ATTR_EXT_RELOC          = 0x00000200;
export const SECTION_ATTR_LOC_RELOC          = 0x00000100;

/* ------------------------------------------------------------------ *
 * nlist (símbolos)
 * ------------------------------------------------------------------ */

export const N_STAB = 0xe0;
export const N_PEXT = 0x10;
export const N_TYPE = 0x0e;
export const N_EXT  = 0x01;

export const N_UNDF = 0x0;
export const N_ABS  = 0x2;
export const N_SECT = 0xe;
export const N_PBUD = 0xc;
export const N_INDR = 0xa;

export const NO_SECT = 0;

/* ------------------------------------------------------------------ *
 * dyld info opcodes
 * ------------------------------------------------------------------ */

// Rebase types
export const REBASE_TYPE_POINTER                    = 1;
export const REBASE_TYPE_TEXT_ABSOLUTE32            = 2;
export const REBASE_TYPE_TEXT_PCREL32               = 3;

export const REBASE_OPCODE_MASK                     = 0xf0;
export const REBASE_IMMEDIATE_MASK                  = 0x0f;
export const REBASE_OPCODE_DONE                     = 0x00;
export const REBASE_OPCODE_SET_TYPE_IMM             = 0x10;
export const REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x20;
export const REBASE_OPCODE_ADD_ADDR_ULEB            = 0x30;
export const REBASE_OPCODE_ADD_ADDR_IMM_SCALED      = 0x40;
export const REBASE_OPCODE_DO_REBASE_IMM_TIMES      = 0x50;
export const REBASE_OPCODE_DO_REBASE_ULEB_TIMES     = 0x60;
export const REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB  = 0x70;
export const REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB = 0x80;

// Bind types
export const BIND_TYPE_POINTER                      = 1;
export const BIND_TYPE_TEXT_ABSOLUTE32              = 2;
export const BIND_TYPE_TEXT_PCREL32                 = 3;

export const BIND_SPECIAL_DYLIB_SELF                = 0;
export const BIND_SPECIAL_DYLIB_MAIN_EXECUTABLE     = -1;
export const BIND_SPECIAL_DYLIB_FLAT_LOOKUP         = -2;
export const BIND_SPECIAL_DYLIB_WEAK_LOOKUP         = -3;

export const BIND_SYMBOL_FLAGS_WEAK_IMPORT          = 0x1;
export const BIND_SYMBOL_FLAGS_NON_WEAK_DEFINITION  = 0x8;

export const BIND_OPCODE_MASK                       = 0xf0;
export const BIND_IMMEDIATE_MASK                    = 0x0f;
export const BIND_OPCODE_DONE                       = 0x00;
export const BIND_OPCODE_SET_DYLIB_ORDINAL_IMM      = 0x10;
export const BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB     = 0x20;
export const BIND_OPCODE_SET_DYLIB_SPECIAL_IMM      = 0x30;
export const BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM = 0x40;
export const BIND_OPCODE_SET_TYPE_IMM               = 0x50;
export const BIND_OPCODE_SET_ADDEND_SLEB            = 0x60;
export const BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB= 0x70;
export const BIND_OPCODE_ADD_ADDR_ULEB              = 0x80;
export const BIND_OPCODE_DO_BIND                    = 0x90;
export const BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB      = 0xa0;
export const BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED= 0xb0;
export const BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB = 0xc0;
export const BIND_OPCODE_THREADED                   = 0xd0;

// Export flags
export const EXPORT_SYMBOL_FLAGS_KIND_MASK          = 0x03;
export const EXPORT_SYMBOL_FLAGS_KIND_REGULAR       = 0x00;
export const EXPORT_SYMBOL_FLAGS_KIND_THREAD_LOCAL  = 0x01;
export const EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE      = 0x02;
export const EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION    = 0x04;
export const EXPORT_SYMBOL_FLAGS_REEXPORT           = 0x08;
export const EXPORT_SYMBOL_FLAGS_STUB_AND_RESOLVER  = 0x10;

/* ------------------------------------------------------------------ *
 * Estructuras (sizes para validación)
 * ------------------------------------------------------------------ */

// Tamaños en bytes (arm64)
export const MACH_HEADER_64_SIZE   = 32;
export const FAT_HEADER_SIZE       = 8;
export const FAT_ARCH_SIZE         = 20;
export const FAT_ARCH_64_SIZE      = 32;

export const LOAD_COMMAND_SIZE     = 8;

export const SEGMENT_COMMAND_64_SIZE    = 72;
export const SECTION_64_SIZE            = 80;
export const SYMTAB_COMMAND_SIZE        = 24;
export const DYSYMTAB_COMMAND_SIZE      = 80;
export const DYLIB_COMMAND_SIZE         = 24;   // + string
export const DYLINKER_COMMAND_SIZE      = 12;   // + string
export const UUID_COMMAND_SIZE          = 24;
export const RPATH_COMMAND_SIZE         = 12;   // + string
export const LINKEDIT_DATA_COMMAND_SIZE = 16;
export const DYLD_INFO_COMMAND_SIZE     = 48;
export const MAIND_COMMAND_SIZE         = 24;   // LC_MAIN (entry_point_command)
export const SOURCE_VERSION_COMMAND_SIZE= 16;
export const BUILD_VERSION_COMMAND_SIZE = 24;   // + ntools*8
export const VERSION_MIN_COMMAND_SIZE   = 16;
export const ENCRYPTION_INFO_COMMAND_SIZE = 20;
export const ENCRYPTION_INFO_64_SIZE    = 24;
export const NLIST_64_SIZE              = 16;
export const DATA_IN_CODE_ENTRY_SIZE    = 8;

/* ------------------------------------------------------------------ *
 * BinaryReader — lectura endian-aware
 * ------------------------------------------------------------------ */

export class MachOError extends Error {
  constructor(msg, code = 'EMACHO', offset = null) {
    super(msg);
    this.name = 'MachOError';
    this.code = code;
    this.offset = offset;
  }
}

export class BinaryReader {
  /**
   * @param {ArrayBuffer|Uint8Array} buf
   * @param {boolean} littleEndian
   */
  constructor(buf, littleEndian = true) {
    if (buf instanceof ArrayBuffer) this.bytes = new Uint8Array(buf);
    else if (buf instanceof Uint8Array) this.bytes = buf;
    else throw new MachOError('BinaryReader: unsupported buffer type', 'EINVAL');
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.le = littleEndian;
    this.pos = 0;
  }

  get length() { return this.bytes.length; }
  get remaining() { return this.length - this.pos; }
  eof() { return this.pos >= this.length; }

  _need(n) {
    if (this.pos + n > this.length) {
      throw new MachOError(`out of bounds: need ${n} bytes at 0x${this.pos.toString(16)}`, 'EOOB', this.pos);
    }
  }

  seek(offset) { this.pos = offset; return this; }
  skip(n)      { this.pos += n; if (this.pos > this.length) this.pos = this.length; return this; }
  align(a)     { const m = this.pos % a; if (m) this.skip(a - m); return this; }

  u8()  { this._need(1); const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8()  { this._need(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i16() { this._need(2); const v = this.view.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
  i32() { this._need(4); const v = this.view.getInt32(this.pos, this.le); this.pos += 4; return v; }

  u64() {
    this._need(8);
    const lo = this.view.getUint32(this.pos + (this.le ? 0 : 4), this.le);
    const hi = this.view.getUint32(this.pos + (this.le ? 4 : 0), this.le);
    this.pos += 8;
    return this.le ? (BigInt(hi) << 32n) | BigInt(lo) : (BigInt(lo) << 32n) | BigInt(hi);
  }

  i64() {
    const u = this.u64();
    const max = 1n << 63n;
    return u >= max ? u - (1n << 64n) : u;
  }

  // ULEB128 (unsigned LEB128, usado en dyld info y DWARF)
  uleb128() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new MachOError('uleb128 too long', 'ELEB', this.pos);
  }

  // SLEB128 (signed)
  sleb128() {
    let result = 0n;
    let shift = 0n;
    let b;
    for (let i = 0; i < 10; i++) {
      b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) break;
    }
    if (shift < 64n && (b & 0x40)) {
      result |= -(1n << shift);
    }
    return result;
  }

  // Fixed-point de 32-bit: 16.16
  fixed32() {
    const v = this.u32();
    const int = v >>> 16;
    const frac = v & 0xffff;
    return int + frac / 65536;
  }

  // C string (null-terminated) hasta max
  cstring(max = 4096) {
    const start = this.pos;
    let end = start;
    const limit = Math.min(this.length, start + max);
    while (end < limit && this.bytes[end] !== 0) end++;
    const s = new TextDecoder('utf-8').decode(this.bytes.subarray(start, end));
    this.pos = end < this.length ? end + 1 : end;   // consumir el null si existe
    return s;
  }

  // String con padding (campo fijo length, termina en null)
  fixedString(len) {
    this._need(len);
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    let end = slice.indexOf(0);
    if (end < 0) end = slice.length;
    return new TextDecoder('utf-8').decode(slice.subarray(0, end));
  }

  // UUID 16 bytes → string 8-4-4-4-12
  uuid() {
    this._need(16);
    const b = this.bytes.subarray(this.pos, this.pos + 16);
    this.pos += 16;
    const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  // Bytes raw
  raw(n) {
    this._need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  // Peek sin mover pos
  peekU32(offset = 0) {
    const p = this.pos + offset;
    if (p + 4 > this.length) return null;
    return this.view.getUint32(p, this.le);
  }

  // For debugging
  hex(n = 16) {
    const start = this.pos;
    const s = [];
    for (let i = 0; i < n && start + i < this.length; i++) {
      s.push(this.bytes[start + i].toString(16).padStart(2, '0'));
    }
    return s.join(' ');
  }
}

/* ------------------------------------------------------------------ *
 * Parsers de estructuras
 * ------------------------------------------------------------------ */

export function readMachHeader(reader) {
  const magic = reader.u32();
  let le = reader.le;
  let is64 = false;

  if (magic === MH_MAGIC_64)      { is64 = true;  le = true; }
  else if (magic === MH_CIGAM_64) { is64 = true;  le = false; }
  else if (magic === MH_MAGIC)    { is64 = false; le = true; }
  else if (magic === MH_CIGAM)    { is64 = false; le = false; }
  else throw new MachOError(`bad magic 0x${magic.toString(16)}`, 'EBADMAGIC', reader.pos - 4);

  reader.le = le;

  const h = {
    magic,
    is64,
    littleEndian: le,
    cputype: reader.i32(),
    cpusubtype: reader.i32(),
    filetype: reader.u32(),
    ncmds: reader.u32(),
    sizeofcmds: reader.u32(),
    flags: reader.u32(),
    reserved: is64 ? reader.u32() : 0,
    headerSize: is64 ? 32 : 28,
  };
  return h;
}

export function readFatHeader(reader) {
  const magic = reader.u32();
  let is64 = false;
  let le;

  if (magic === FAT_MAGIC)     { is64 = false; le = false; }   // fat es big-endian
  else if (magic === FAT_MAGIC_64) { is64 = true; le = false; }
  else if (magic === FAT_CIGAM)    { is64 = false; le = true; }
  else if (magic === FAT_CIGAM_64) { is64 = true; le = true; }
  else throw new MachOError(`bad fat magic 0x${magic.toString(16)}`, 'EBADMAGIC');

  reader.le = le;
  const nfat = reader.u32();
  return { magic, is64, littleEndian: le, nfat };
}

export function readFatArch(reader, is64) {
  if (is64) {
    return {
      cputype: reader.i32(),
      cpusubtype: reader.i32(),
      offset: reader.u64(),
      size: reader.u64(),
      align: reader.u32(),
      reserved: reader.u32(),
    };
  }
  return {
    cputype: reader.i32(),
    cpusubtype: reader.i32(),
    offset: reader.u32(),
    size: reader.u32(),
    align: reader.u32(),
  };
}

export function readSegmentCommand64(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const segname = reader.fixedString(16);
  const vmaddr = reader.u64();
  const vmsize = reader.u64();
  const fileoff = reader.u64();
  const filesize = reader.u64();
  const maxprot = reader.i32();
  const initprot = reader.i32();
  const nsects = reader.u32();
  const flags = reader.u32();

  const sections = [];
  for (let i = 0; i < nsects; i++) {
    sections.push(readSection64(reader));
  }

  return {
    cmd, cmdsize, segname,
    vmaddr, vmsize, fileoff, filesize,
    maxprot, initprot, nsects, flags,
    sections,
  };
}

export function readSection64(reader) {
  const sectname = reader.fixedString(16);
  const segname = reader.fixedString(16);
  const addr = reader.u64();
  const size = reader.u64();
  const offset = reader.u32();
  const align = reader.u32();
  const reloff = reader.u32();
  const nreloc = reader.u32();
  const flags = reader.u32();
  const reserved1 = reader.u32();
  const reserved2 = reader.u32();
  const reserved3 = reader.u32();
  return {
    sectname, segname,
    addr, size, offset, align,
    reloff, nreloc, flags, reserved1, reserved2, reserved3,
  };
}

export function readSymtabCommand(reader) {
  return {
    cmd: reader.u32(),
    cmdsize: reader.u32(),
    symoff: reader.u32(),
    nsyms: reader.u32(),
    stroff: reader.u32(),
    strsize: reader.u32(),
  };
}

export function readDysymtabCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const ilocalsym = reader.u32();
  const nlocalsym = reader.u32();
  const iextdefsym = reader.u32();
  const nextdefsym = reader.u32();
  const iundefsym = reader.u32();
  const nundefsym = reader.u32();
  const tocoff = reader.u32();
  const ntoc = reader.u32();
  const modtaboff = reader.u32();
  const nmodtab = reader.u32();
  const extrefsymoff = reader.u32();
  const nextrefsyms = reader.u32();
  const indirectsymoff = reader.u32();
  const nindirectsyms = reader.u32();
  const extreloff = reader.u32();
  const nextrel = reader.u32();
  const locreloff = reader.u32();
  const nlocrel = reader.u32();
  return {
    cmd, cmdsize,
    ilocalsym, nlocalsym,
    iextdefsym, nextdefsym,
    iundefsym, nundefsym,
    tocoff, ntoc,
    modtaboff, nmodtab,
    extrefsymoff, nextrefsyms,
    indirectsymoff, nindirectsyms,
    extreloff, nextrel,
    locreloff, nlocrel,
  };
}

export function readDylibCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const nameOffset = reader.u32();
  const timestamp = reader.u32();
  const currentVersion = reader.u32();
  const compatibilityVersion = reader.u32();
  // El nombre empieza en cmd_start + nameOffset
  const nameStart = reader.pos - 24 + nameOffset;
  const save = reader.pos;
  reader.seek(nameStart);
  const name = reader.cstring(1024);
  reader.seek(save);
  return { cmd, cmdsize, name, timestamp, currentVersion, compatibilityVersion };
}

export function readUuidCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const uuid = reader.uuid();
  return { cmd, cmdsize, uuid };
}

export function readDyldInfoCommand(reader) {
  return {
    cmd: reader.u32(),
    cmdsize: reader.u32(),
    rebase_off: reader.u32(),
    rebase_size: reader.u32(),
    bind_off: reader.u32(),
    bind_size: reader.u32(),
    weak_bind_off: reader.u32(),
    weak_bind_size: reader.u32(),
    lazy_bind_off: reader.u32(),
    lazy_bind_size: reader.u32(),
    export_off: reader.u32(),
    export_size: reader.u32(),
  };
}

export function readMainCommand(reader) {
  return {
    cmd: reader.u32(),
    cmdsize: reader.u32(),
    entryoff: reader.u64(),
    stacksize: reader.u64(),
  };
}

export function readLinkeditDataCommand(reader) {
  return {
    cmd: reader.u32(),
    cmdsize: reader.u32(),
    dataoff: reader.u32(),
    datasize: reader.u32(),
  };
}

export function readSourceVersionCommand(reader) {
  return {
    cmd: reader.u32(),
    cmdsize: reader.u32(),
    version: reader.u64(),
  };
}

export function readBuildVersionCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const platform = reader.u32();
  const minos = reader.u32();
  const sdk = reader.u32();
  const ntools = reader.u32();
  const tools = [];
  for (let i = 0; i < ntools; i++) {
    tools.push({ tool: reader.u32(), version: reader.u32() });
  }
  return { cmd, cmdsize, platform, minos, sdk, ntools, tools };
}

export function readRpathCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const pathOffset = reader.u32();
  const nameStart = reader.pos - 12 + pathOffset;
  const save = reader.pos;
  reader.seek(nameStart);
  const path = reader.cstring(1024);
  reader.seek(save);
  return { cmd, cmdsize, path };
}

export function readDylinkerCommand(reader) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const nameOffset = reader.u32();
  const nameStart = reader.pos - 12 + nameOffset;
  const save = reader.pos;
  reader.seek(nameStart);
  const name = reader.cstring(1024);
  reader.seek(save);
  return { cmd, cmdsize, name };
}

export function readEncryptionInfoCommand(reader, is64) {
  const cmd = reader.u32();
  const cmdsize = reader.u32();
  const cryptoff = reader.u32();
  const cryptsize = reader.u32();
  const cryptid = reader.u32();
  const pad = is64 ? reader.u32() : 0;
  return { cmd, cmdsize, cryptoff, cryptsize, cryptid, pad };
}

export function readNlist64(reader) {
  return {
    n_strx: reader.u32(),
    n_type: reader.u8(),
    n_sect: reader.u8(),
    n_desc: reader.u16(),
    n_value: reader.u64(),
  };
}

/* ------------------------------------------------------------------ *
 * Helpers de formato
 * ------------------------------------------------------------------ */

export function formatVersion(v) {
  // Mach-O version: A.B.C packed como A<<16 | B<<8 | C
  if (typeof v === 'bigint') v = Number(v & 0xffffffffn);
  const major = (v >>> 16) & 0xffff;
  const minor = (v >>> 8) & 0xff;
  const patch = v & 0xff;
  return `${major}.${minor}.${patch}`;
}

export function formatSourceVersion(v) {
  if (typeof v !== 'bigint') v = BigInt(v);
  const a = (v >> 40n) & 0xffffffn;
  const b = (v >> 30n) & 0x3ffn;
  const c = (v >> 20n) & 0x3ffn;
  const d = (v >> 10n) & 0x3ffn;
  const e = v & 0x3ffn;
  return `${a}.${b}.${c}.${d}.${e}`;
}

export function cputypeName(cputype) {
  return CPU_NAMES[cputype] || `unknown(${cputype})`;
}

export function cpusubtypeName(cputype, cpusubtype) {
  const map = CPU_SUBTYPE_NAMES[cputype];
  if (map && map[cpusubtype]) return map[cpusubtype];
  return `subtype(${cpusubtype})`;
}

export function filetypeName(ft) {
  return FILETYPE_NAMES[ft] || `unknown(${ft})`;
}

export function lcName(cmd) {
  return LC_NAMES[cmd] || `LC_?(${cmd.toString(16)})`;
}

export function decodeHeaderFlags(flags) {
  const out = [];
  for (const [bit, name] of Object.entries(HEADER_FLAG_NAMES)) {
    if (flags & Number(bit)) out.push(name);
  }
  return out;
}

export function decodeProtection(prot) {
  const parts = [];
  if (prot & VM_PROT_READ) parts.push('r');
  if (prot & VM_PROT_WRITE) parts.push('w');
  if (prot & VM_PROT_EXECUTE) parts.push('x');
  return parts.join('') || '---';
}

/* ------------------------------------------------------------------ *
 * Exports agregados
 * ------------------------------------------------------------------ */

export const MACHO_CONSTANTS = {
  MH_MAGIC, MH_MAGIC_64, MH_CIGAM, MH_CIGAM_64,
  FAT_MAGIC, FAT_MAGIC_64, FAT_CIGAM, FAT_CIGAM_64,
  CPU_TYPE_ARM64, CPU_TYPE_X86_64,
  MH_EXECUTE, MH_DYLIB, MH_BUNDLE, MH_OBJECT, MH_FILESET,
  LC_SEGMENT_64, LC_SYMTAB, LC_DYLD_INFO, LC_MAIN, LC_UUID, LC_BUILD_VERSION,
};

export default {
  // magics
  MH_MAGIC, MH_MAGIC_64, MH_CIGAM, MH_CIGAM_64,
  FAT_MAGIC, FAT_MAGIC_64, FAT_CIGAM, FAT_CIGAM_64,
  // cpu
  CPU_TYPE_ARM64, CPU_TYPE_X86_64, CPU_SUBTYPE_ARM64E,
  // filetypes
  MH_OBJECT, MH_EXECUTE, MH_DYLIB, MH_BUNDLE, MH_FILESET,
  // load commands
  LC_SEGMENT_64, LC_SYMTAB, LC_DYSYMTAB, LC_DYLD_INFO, LC_DYLD_INFO_ONLY,
  LC_MAIN, LC_UUID, LC_BUILD_VERSION, LC_CODE_SIGNATURE, LC_FUNCTION_STARTS,
  LC_LOAD_DYLIB, LC_ID_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_RPATH,
  // helpers
  BinaryReader, MachOError,
  readMachHeader, readFatHeader, readFatArch,
  readSegmentCommand64, readSection64, readSymtabCommand, readDysymtabCommand,
  readDylibCommand, readUuidCommand, readDyldInfoCommand, readMainCommand,
  readLinkeditDataCommand, readSourceVersionCommand, readBuildVersionCommand,
  readRpathCommand, readDylinkerCommand, readEncryptionInfoCommand, readNlist64,
  formatVersion, formatSourceVersion,
  cputypeName, cpusubtypeName, filetypeName, lcName,
  decodeHeaderFlags, decodeProtection,
};
