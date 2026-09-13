// src/apps/Files.jsx
// iOS Remastered — Files.app (v2)
// Navegador completo del FileSystem virtual del OS, con importación desde
// archivo/URL/texto, exportación, papelera funcional, búsqueda recursiva,
// vista lista/cuadrícula/columnas, breadcrumb interactivo, integración con
// IPAInstaller al tocar .ipa, y persistencia.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, useReducer,
} from 'react';

import { useOS } from '../context/OSContext.jsx';
import { toast } from '../ui/Toast.jsx';
import { alert } from '../ui/Alert.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Blur } from '../ui/Blur.jsx';
import { TapHandler, useGesture, Swipeable } from '../ui/GestureHandler.jsx';

/* ============================================================================
 * CONSTANTES
 * ========================================================================== */

const FILES_DB = '/private/var/mobile/Library/Files/Files.json';
const TRASH_DIR = '/private/var/mobile/.Trash';
const DOWNLOADS_DIR = '/private/var/mobile/Downloads';
const FAVORITES_DIR = '/private/var/mobile/Library/Files/Favorites';

const LOCATIONS = [
  { id: 'recents',   name: 'Recientes',    icon: 'clock',              path: null,        special: 'recents' },
  { id: 'shared',    name: 'Compartido',   icon: 'person.2',           path: null,        special: 'shared' },
  { id: 'favorites', name: 'Favoritos',    icon: 'star',               path: null,        special: 'favorites' },
  { id: 'icloud',    name: 'iCloud Drive', icon: 'cloud',              path: '/private/var/mobile/Library/Mobile Documents', special: null },
  { id: 'onmy',      name: 'En mi iPhone', icon: 'iphone',             path: '/private/var/mobile', special: null },
  { id: 'downloads', name: 'Descargas',    icon: 'arrow.down.circle',  path: '/private/var/mobile/Downloads', special: null },
  { id: 'apps',      name: 'Aplicaciones', icon: 'square.grid.2x2',    path: '/Applications',     special: null },
  { id: 'books',     name: 'Libros',       icon: 'book',               path: '/private/var/mobile/Library/Books', special: null },
  { id: 'media',     name: 'Media',        icon: 'photo.on.rectangle', path: '/private/var/mobile/Media/DCIM', special: null },
  { id: 'library',   name: 'Biblioteca',   icon: 'building.columns',   path: '/private/var/mobile/Library', special: null },
  { id: 'trash',     name: 'Papelera',     icon: 'trash',              path: '/private/var/mobile/.Trash', special: null },
];

const FILE_ICONS = {
  ipa:  { icon: 'shippingbox.fill', color: '#0a84ff', label: 'IPA' },
  app:  { icon: 'app.fill',         color: '#0a84ff', label: 'App' },
  zip:  { icon: 'doc.zipper',       color: '#8e8e93', label: 'Zip' },
  tar:  { icon: 'doc.zipper',       color: '#8e8e93', label: 'Tar' },
  gz:   { icon: 'doc.zipper',       color: '#8e8e93', label: 'Gzip' },
  txt:  { icon: 'doc.text',         color: '#8e8e93', label: 'Texto' },
  md:   { icon: 'doc.text',         color: '#8e8e93', label: 'Markdown' },
  json: { icon: 'curlybraces',      color: '#ffd60a', label: 'JSON' },
  plist:{ icon: 'list.bullet',      color: '#ff9f0a', label: 'Plist' },
  xml:  { icon: 'chevron.left.forwardslash.chevron.right', color: '#ff9f0a', label: 'XML' },
  yml:  { icon: 'list.bullet.indent', color: '#ff9f0a', label: 'YAML' },
  yaml: { icon: 'list.bullet.indent', color: '#ff9f0a', label: 'YAML' },
  js:   { icon: 'curlybraces',      color: '#ffd60a', label: 'JS' },
  jsx:  { icon: 'curlybraces',      color: '#ffd60a', label: 'JSX' },
  ts:   { icon: 'curlybraces',      color: '#0a84ff', label: 'TS' },
  tsx:  { icon: 'curlybraces',      color: '#0a84ff', label: 'TSX' },
  css:  { icon: 'paintbrush',       color: '#64d2ff', label: 'CSS' },
  scss: { icon: 'paintbrush',       color: '#ff375f', label: 'SCSS' },
  html: { icon: 'chevron.left.forwardslash.chevron.right', color: '#ff9f0a', label: 'HTML' },
  png:  { icon: 'photo',            color: '#30d158', label: 'PNG' },
  jpg:  { icon: 'photo',            color: '#30d158', label: 'JPG' },
  jpeg: { icon: 'photo',            color: '#30d158', label: 'JPEG' },
  heic: { icon: 'photo',            color: '#30d158', label: 'HEIC' },
  svg:  { icon: 'photo',            color: '#30d158', label: 'SVG' },
  gif:  { icon: 'photo',            color: '#30d158', label: 'GIF' },
  webp: { icon: 'photo',            color: '#30d158', label: 'WebP' },
  mov:  { icon: 'video',            color: '#bf5af2', label: 'MOV' },
  mp4:  { icon: 'video',            color: '#bf5af2', label: 'MP4' },
  m4v:  { icon: 'video',            color: '#bf5af2', label: 'M4V' },
  mp3:  { icon: 'music.note',       color: '#ff375f', label: 'MP3' },
  m4a:  { icon: 'music.note',       color: '#ff375f', label: 'M4A' },
  wav:  { icon: 'waveform',         color: '#ff375f', label: 'WAV' },
  pdf:  { icon: 'doc.richtext',     color: '#ff453a', label: 'PDF' },
  doc:  { icon: 'doc.richtext',     color: '#0a84ff', label: 'Word' },
  docx: { icon: 'doc.richtext',     color: '#0a84ff', label: 'Word' },
  xls:  { icon: 'tablecells',       color: '#30d158', label: 'Excel' },
  xlsx: { icon: 'tablecells',       color: '#30d158', label: 'Excel' },
  ppt:  { icon: 'rectangle.on.rectangle', color: '#ff9f0a', label: 'PowerPoint' },
  pptx: { icon: 'rectangle.on.rectangle', color: '#ff9f0a', label: 'PowerPoint' },
  db:   { icon: 'cylinder',         color: '#8e8e93', label: 'Base de datos' },
  sqlite: { icon: 'cylinder',       color: '#8e8e93', label: 'SQLite' },
  sh:   { icon: 'terminal',         color: '#30d158', label: 'Shell' },
  log:  { icon: 'doc.plaintext',    color: '#8e8e93', label: 'Log' },
  bin:  { icon: 'cpu',              color: '#bf5af2', label: 'Binario' },
  dylib:{ icon: 'cpu',              color: '#bf5af2', label: 'Dylib' },
  macho:{ icon: 'cpu',              color: '#bf5af2', label: 'Mach-O' },
  pem:  { icon: 'lock.shield',      color: '#ffd60a', label: 'Certificado' },
  crt:  { icon: 'lock.shield',      color: '#ffd60a', label: 'Certificado' },
  key:  { icon: 'key.fill',         color: '#ffd60a', label: 'Clave' },
};

const SORTS = [
  { id: 'name-asc',   label: 'Nombre ↑' },
  { id: 'name-desc',  label: 'Nombre ↓' },
  { id: 'date-desc',  label: 'Más recientes' },
  { id: 'date-asc',   label: 'Más antiguos' },
  { id: 'size-desc',  label: 'Mayor tamaño' },
  { id: 'size-asc',   label: 'Menor tamaño' },
  { id: 'kind',       label: 'Tipo' },
];

const VIEWS = [
  { id: 'list',   label: 'Lista',       icon: 'list.bullet' },
  { id: 'grid',   label: 'Cuadrícula',  icon: 'square.grid.2x2' },
  { id: 'columns',label: 'Columnas',    icon: 'rectangle.split.3x1' },
];

/* ============================================================================
 * UTILS
 * ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

function formatBytes(b) {
  if (b == null || b < 0) return '—';
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  const v = b / Math.pow(1024, i);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Ahora';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `Hace ${d} d`;
  const date = new Date(ts);
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${date.getDate()} ${months[date.getMonth()]}`
    : `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function nameWithoutExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function iconFor(name, isDir) {
  if (isDir) return { icon: 'folder.fill', color: '#0a84ff', label: 'Carpeta' };
  const ext = extOf(name);
  return FILE_ICONS[ext] || { icon: 'doc', color: '#8e8e93', label: ext.toUpperCase() || 'Archivo' };
}

function joinPath(base, name) {
  if (!base || base === '/') return `/${name}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

function parentPath(p) {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

function normalizePath(p) {
  if (!p) return '/';
  const parts = p.split('/').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function isSubPath(parent, child) {
  if (!parent || !child) return false;
  if (parent === '/') return true;
  return child === parent || child.startsWith(parent + '/');
}

function uniqueName(name, existing) {
  if (!existing.includes(name)) return name;
  const base = nameWithoutExt(name);
  const ext = extOf(name);
  let i = 2;
  while (existing.includes(`${base} ${i}${ext ? '.' + ext : ''}`)) i++;
  return `${base} ${i}${ext ? '.' + ext : ''}`;
}

/* ============================================================================
 * NORMALIZACIÓN DE ENTRADAS DEL FS
 * ========================================================================== */

function normalizeEntry(raw, parentPath) {
  if (!raw) return null;
  const name = raw.name || raw.path?.split('/').pop() || 'Sin nombre';
  const isDir = raw.isDir ?? raw.type === 'dir' ?? raw.kind === 'directory' ?? false;
  const size = raw.size ?? raw.length ?? 0;
  const modifiedAt = raw.modifiedAt ?? raw.mtime ?? raw.updatedAt ?? null;
  const createdAt = raw.createdAt ?? raw.ctime ?? modifiedAt ?? null;
  const path = raw.path || joinPath(parentPath, name);

  return {
    id: path,
    name,
    isDir,
    size,
    modifiedAt,
    createdAt,
    path,
    kind: raw.kind,
    __raw: raw,
  };
}

/* ============================================================================
 * HOOK DE DIRECTORIO
 * ========================================================================== */

function useDirectory(os, path) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!os?.fs || !path) {
      setEntries([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const list = await os.fs.list(path);
      let arr = [];
      if (Array.isArray(list)) arr = list;
      else if (list && typeof list === 'object') arr = Object.values(list);
      const normalized = arr.map((e) => normalizeEntry(e, path)).filter(Boolean);
      setEntries(normalized);
    } catch (e) {
      setError(e.message || 'Error al listar');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [os, path]);

  useEffect(() => { reload(); }, [reload]);

  return { entries, loading, error, reload };
}

/* ============================================================================
 * BÚSQUEDA RECURSIVA
 * ========================================================================== */

async function searchRecursive(os, basePath, query, maxDepth = 6) {
  const results = [];
  const q = query.toLowerCase();
  const visited = new Set();

  async function walk(path, depth) {
    if (depth > maxDepth || visited.has(path)) return;
    visited.add(path);
    try {
      const list = await os.fs.list(path);
      const arr = Array.isArray(list) ? list : Object.values(list || {});
      for (const raw of arr) {
        const entry = normalizeEntry(raw, path);
        if (!entry) continue;
        if (entry.name.toLowerCase().includes(q)) {
          results.push(entry);
          if (results.length >= 200) return;
        }
        if (entry.isDir) {
          await walk(entry.path, depth + 1);
        }
      }
    } catch { /* directorio sin permisos o inexistente */ }
  }

  await walk(basePath, 0);
  return results;
}

/* ============================================================================
 * REDUCER
 * ========================================================================== */

const initialState = {
  ready: false,
  cwd: '/private/var/mobile',
  history: ['/private/var/mobile'],
  historyIdx: 0,
  view: 'list',
  sort: 'name-asc',
  favorites: [],
  recents: [],
  search: '',
  searchActive: false,
  searchResults: null,
  searchLoading: false,
  selection: [],
  selecting: false,
  showHidden: false,
  columnsPath: [],
  specialView: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.state, ready: true };

    case 'NAVIGATE': {
      const p = normalizePath(action.path);
      if (p === state.cwd && !action.force) {
        return { ...state, selection: [], selecting: false, specialView: null };
      }
      const history = [...state.history.slice(0, state.historyIdx + 1), p];
      return {
        ...state,
        cwd: p,
        history,
        historyIdx: history.length - 1,
        selection: [],
        selecting: false,
        search: '',
        searchActive: false,
        searchResults: null,
        specialView: null,
      };
    }

    case 'BACK': {
      if (state.historyIdx <= 0) return state;
      const idx = state.historyIdx - 1;
      return {
        ...state,
        cwd: state.history[idx],
        historyIdx: idx,
        selection: [],
        selecting: false,
        specialView: null,
      };
    }

    case 'FORWARD': {
      if (state.historyIdx >= state.history.length - 1) return state;
      const idx = state.historyIdx + 1;
      return {
        ...state,
        cwd: state.history[idx],
        historyIdx: idx,
        selection: [],
        specialView: null,
      };
    }

    case 'SET_SPECIAL':
      return { ...state, specialView: action.view, cwd: action.cwd || state.cwd, selection: [], selecting: false };

    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'SET_SORT':
      return { ...state, sort: action.sort };

    case 'SET_SEARCH':
      return { ...state, search: action.value };

    case 'SET_SEARCH_ACTIVE':
      return {
        ...state,
        searchActive: action.value,
        search: action.value ? state.search : '',
        searchResults: action.value ? state.searchResults : null,
      };

    case 'SET_SEARCH_RESULTS':
      return { ...state, searchResults: action.results, searchLoading: false };

    case 'SET_SEARCH_LOADING':
      return { ...state, searchLoading: action.value };

    case 'TOGGLE_HIDDEN':
      return { ...state, showHidden: !state.showHidden };

    case 'TOGGLE_FAV': {
      const has = state.favorites.includes(action.path);
      return {
        ...state,
        favorites: has
          ? state.favorites.filter((p) => p !== action.path)
          : [...state.favorites, action.path],
      };
    }

    case 'PUSH_RECENT': {
      const filtered = state.recents.filter((r) => r.path !== action.entry.path);
      return { ...state, recents: [action.entry, ...filtered].slice(0, 50) };
    }

    case 'CLEAR_RECENTS':
      return { ...state, recents: [] };

    case 'TOGGLE_SELECT': {
      const has = state.selection.includes(action.path);
      const selection = has
        ? state.selection.filter((p) => p !== action.path)
        : [...state.selection, action.path];
      return { ...state, selection };
    }

    case 'SET_SELECTION':
      return { ...state, selection: action.paths };

    case 'CLEAR_SELECTION':
      return { ...state, selection: [], selecting: false };

    case 'SET_SELECTING':
      return {
        ...state,
        selecting: action.value,
        selection: action.value ? state.selection : [],
      };

    case 'PUSH_COLUMN':
      return { ...state, columnsPath: action.path ? [...state.columnsPath, action.path] : [] };

    default:
      return state;
  }
}

async function persist(os, state) {
  try {
    if (!os?.fs) return;
    await os.fs.mkdir('/private/var/mobile/Library/Files', { recursive: true }).catch(() => {});
    await os.fs.writeFile(FILES_DB, JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      view: state.view,
      sort: state.sort,
      favorites: state.favorites,
      recents: state.recents,
      showHidden: state.showHidden,
    }));
  } catch {}
}

async function hydrate(os) {
  try {
    if (!os?.fs) return null;
    const raw = await os.fs.readFile(FILES_DB);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function useFiles(os) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveRef = useRef(null);

  useEffect(() => {
    (async () => {
      const db = await hydrate(os);
      if (db) {
        dispatch({
          type: 'HYDRATE',
          state: {
            view: db.view || 'list',
            sort: db.sort || 'name-asc',
            favorites: db.favorites || [],
            recents: db.recents || [],
            showHidden: !!db.showHidden,
          },
        });
      } else {
        dispatch({ type: 'HYDRATE', state: {} });
      }
    })();
  }, [os]);

  useEffect(() => {
    if (!state.ready) return;
    clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => persist(os, state), 800);
    return () => clearTimeout(saveRef.current);
  }, [state, os]);

  return [state, dispatch];
}

/* ============================================================================
 * ORDENAR Y FILTRAR
 * ========================================================================== */

function applyView(entries, { sort, search, showHidden }) {
  let list = entries;

  if (!showHidden) list = list.filter((e) => !e.name.startsWith('.') || e.name === '.Trash');

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }

  const cmp = {
    'name-asc':  (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }),
    'name-desc': (a, b) => b.name.localeCompare(a.name, 'es', { numeric: true }),
    'date-desc': (a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0),
    'date-asc':  (a, b) => (a.modifiedAt || 0) - (b.modifiedAt || 0),
    'size-desc': (a, b) => b.size - a.size,
    'size-asc':  (a, b) => a.size - b.size,
    'kind':      (a, b) => {
      const ae = a.isDir ? '' : extOf(a.name);
      const be = b.isDir ? '' : extOf(b.name);
      return ae.localeCompare(be) || a.name.localeCompare(b.name, 'es', { numeric: true });
    },
  }[sort] || ((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));

  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmp(a, b);
  });
}

/* ============================================================================
 * IMPORT SHEET — el bloque clave que faltaba
 * ========================================================================== */

function ImportSheet({ os, cwd, onClose, onImported }) {
  const [tab, setTab] = useState('file'); // file | url | text | paste
  const [urlValue, setUrlValue] = useState('');
  const [textValue, setTextValue] = useState('');
  const [fileName, setFileName] = useState('');
  const [pasteValue, setPasteValue] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  /* --------------------------- Importar desde archivo --------------------------- */

  const handleFilePick = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    let ok = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const target = joinPath(cwd, file.name);
        await writeBinary(os, target, new Uint8Array(buf));
        ok++;
      } catch (err) {
        toast.error(`Error con ${file.name}: ${err.message}`);
      }
    }
    setBusy(false);
    if (ok > 0) {
      toast.success(`${ok} archivo${ok > 1 ? 's' : ''} importado${ok > 1 ? 's' : ''}`);
      onImported?.();
      onClose();
    }
  }, [os, cwd, onImported, onClose]);

  /* --------------------------- Importar desde URL --------------------------- */

  const handleUrlImport = useCallback(async () => {
    const url = urlValue.trim();
    if (!url) {
      toast.error('Introduce una URL');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error('La URL debe empezar por http:// o https://');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const derivedName = urlNameFromUrl(url);
      const name = uniqueName(derivedName, []);
      const target = joinPath(cwd, name);
      await writeBinary(os, target, new Uint8Array(buf));
      toast.success(`Importado ${name} (${formatBytes(buf.byteLength)})`);

      // Si es un .ipa, preguntar si instalar
      if (name.toLowerCase().endsWith('.ipa')) {
        setTimeout(() => {
          alert.confirm({
            title: '¿Instalar IPA?',
            message: name,
            confirmText: 'Instalar',
          }).then((ok) => {
            if (ok && os?.ipaInstaller?.install) {
              os.ipaInstaller.install(target).then(
                () => toast.success('Instalada'),
                (e) => toast.error(`Error: ${e.message}`)
              );
            }
          });
        }, 300);
      }
      onImported?.();
      onClose();
    } catch (e) {
      toast.error(`Fallo al descargar: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [urlValue, os, cwd, onImported, onClose]);

  /* --------------------------- Importar desde texto --------------------------- */

  const handleTextImport = useCallback(async () => {
    const content = textValue;
    if (!content) {
      toast.error('El contenido está vacío');
      return;
    }
    let name = fileName.trim();
    if (!name) {
      name = `documento-${Date.now().toString(36)}.txt`;
    } else if (!name.includes('.')) {
      name += '.txt';
    }
    setBusy(true);
    try {
      const target = joinPath(cwd, name);
      await os.fs.writeFile(target, content);
      toast.success(`Creado ${name} (${formatBytes(new Blob([content]).size)})`);
      onImported?.();
      onClose();
    } catch (e) {
      toast.error(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [textValue, fileName, os, cwd, onImported, onClose]);

  /* --------------------------- Importar desde portapapeles --------------------------- */

  const handlePasteImport = useCallback(async () => {
    let content = pasteValue;
    if (!content) {
      try {
        content = await navigator.clipboard.readText();
        setPasteValue(content);
        if (!content) {
          toast.error('Portapapeles vacío');
          return;
        }
      } catch {
        toast.error('No se pudo leer el portapapeles');
        return;
      }
    }
    const name = uniqueName(`pegado-${Date.now().toString(36)}.txt`, []);
    setBusy(true);
    try {
      await os.fs.writeFile(joinPath(cwd, name), content);
      toast.success(`Guardado como ${name}`);
      onImported?.();
      onClose();
    } catch (e) {
      toast.error(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [pasteValue, os, cwd, onImported, onClose]);

  return (
    <div className="fl-sheet fl-sheet-tall">
      <div className="fl-sheet-backdrop" onClick={onClose} />
      <div className="fl-sheet-panel">
        <div className="fl-sheet-head">
          <span className="fl-sheet-name">Importar</span>
          <button className="fl-iconbtn" onClick={onClose}>Cancelar</button>
        </div>

        <div className="fl-import-tabs">
          {[
            { id: 'file', icon: 'doc.badge.plus',  label: 'Archivo' },
            { id: 'url',  icon: 'link',            label: 'URL' },
            { id: 'text', icon: 'doc.text',        label: 'Texto' },
            { id: 'paste',icon: 'doc.on.clipboard',label: 'Portapapeles' },
          ].map((t) => (
            <button
              key={t.id}
              className={`fl-import-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={20} color={tab === t.id ? '#0a84ff' : '#8e8e93'} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="fl-import-body">
          {/* Archivo */}
          {tab === 'file' && (
            <>
              <div className="fl-import-info">
                <Icon name="folder" size={20} color="#0a84ff" />
                <span>Se guardará en <strong>{shortPath(cwd, 40)}</strong></span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handleFilePick}
              />
              <button
                className="fl-btn fl-btn-primary fl-btn-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <Icon name="doc.badge.plus" size={18} color="#fff" />
                <span>{busy ? 'Importando…' : 'Elegir archivo(s)'}</span>
              </button>
              <p className="fl-import-hint">
                Se abre el selector del sistema. Puedes arrastrar varios archivos a la vez.
              </p>
            </>
          )}

          {/* URL */}
          {tab === 'url' && (
            <>
              <div className="fl-import-info">
                <Icon name="link" size={20} color="#0a84ff" />
                <span>Descarga desde internet a <strong>{shortPath(cwd, 40)}</strong></span>
              </div>
              <input
                className="fl-input"
                type="url"
                placeholder="https://ejemplo.com/archivo.ipa"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                autoFocus
              />
              <button
                className="fl-btn fl-btn-primary fl-btn-full"
                onClick={handleUrlImport}
                disabled={busy || !urlValue.trim()}
              >
                <Icon name="arrow.down.circle" size={18} color="#fff" />
                <span>{busy ? 'Descargando…' : 'Descargar'}</span>
              </button>
              <p className="fl-import-hint">
                Si el archivo es un <code>.ipa</code>, se ofrecerá instalarlo automáticamente.
              </p>
            </>
          )}

          {/* Texto */}
          {tab === 'text' && (
            <>
              <input
                className="fl-input"
                type="text"
                placeholder="Nombre del archivo (ej: nota.txt)"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
              />
              <textarea
                className="fl-textarea"
                placeholder="Escribe o pega el contenido…"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                rows={10}
                autoFocus
              />
              <button
                className="fl-btn fl-btn-primary fl-btn-full"
                onClick={handleTextImport}
                disabled={busy || !textValue}
              >
                <Icon name="doc.badge.plus" size={18} color="#fff" />
                <span>{busy ? 'Guardando…' : 'Guardar archivo'}</span>
              </button>
            </>
          )}

          {/* Portapapeles */}
          {tab === 'paste' && (
            <>
              <div className="fl-import-info">
                <Icon name="doc.on.clipboard" size={20} color="#0a84ff" />
                <span>Lee el portapapeles y lo guarda como archivo</span>
              </div>
              <textarea
                className="fl-textarea"
                placeholder="El contenido del portapapeles aparecerá aquí (o pégalo manualmente)…"
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                rows={8}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="fl-btn fl-btn-secondary"
                  onClick={async () => {
                    try {
                      const txt = await navigator.clipboard.readText();
                      setPasteValue(txt);
                      toast.info('Portapapeles leído');
                    } catch {
                      toast.error('No se pudo leer');
                    }
                  }}
                >
                  <Icon name="arrow.clockwise" size={16} color="#0a84ff" />
                  <span>Leer</span>
                </button>
                <button
                  className="fl-btn fl-btn-primary flex-1"
                  onClick={handlePasteImport}
                  disabled={busy}
                >
                  <Icon name="doc.badge.plus" size={18} color="#fff" />
                  <span>{busy ? 'Guardando…' : 'Guardar'}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Helper: escribir bytes en el FS (soporta Uint8Array) */
async function writeBinary(os, path, bytes) {
  try {
    // Preferimos API binaria si existe
    if (os.fs.writeBytes) {
      return await os.fs.writeBytes(path, bytes);
    }
    if (os.fs.writeFile && bytes instanceof Uint8Array) {
      // Fallback: intentamos pasar el Uint8Array directamente
      try {
        return await os.fs.writeFile(path, bytes);
      } catch {
        // Último recurso: base64
        const b64 = uint8ToBase64(bytes);
        return await os.fs.writeFile(path, `data:application/octet-stream;base64,${b64}`);
      }
    }
    return await os.fs.writeFile(path, bytes);
  } catch (e) {
    throw new Error(`writeBinary: ${e.message}`);
  }
}

function uint8ToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function urlNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) return last;
    return `descarga-${Date.now().toString(36)}.bin`;
  } catch {
    return `descarga-${Date.now().toString(36)}.bin`;
  }
}

function shortPath(p, max = 42) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `/${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

/* ============================================================================
 * EXPORT SHEET
 * ========================================================================== */

function ExportSheet({ entry, os, onClose }) {
  const [busy, setBusy] = useState(false);

  const download = useCallback(async () => {
    setBusy(true);
    try {
      let content;
      if (os.fs.readBytes) {
        content = await os.fs.readBytes(entry.path);
      } else {
        content = await os.fs.readFile(entry.path, { binary: true });
      }
      let blob;
      if (content instanceof Uint8Array) {
        blob = new Blob([content]);
      } else if (content instanceof ArrayBuffer) {
        blob = new Blob([content]);
      } else {
        blob = new Blob([String(content)], { type: 'text/plain' });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Descargado');
      onClose();
    } catch (e) {
      toast.error(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [os, entry, onClose]);

  const copyToClipboard = useCallback(async () => {
    setBusy(true);
    try {
      let content;
      if (os.fs.readBytes) content = await os.fs.readBytes(entry.path);
      else content = await os.fs.readFile(entry.path, { binary: true });
      if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
        const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
        const b64 = uint8ToBase64(bytes);
        await navigator.clipboard.writeText(b64);
      } else {
        await navigator.clipboard.writeText(String(content));
      }
      toast.success('Copiado al portapapeles');
      onClose();
    } catch (e) {
      toast.error(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [os, entry, onClose]);

  const share = useCallback(async () => {
    try {
      if (!navigator.share) {
        toast.info('Compartir no disponible');
        return;
      }
      let content;
      if (os.fs.readBytes) content = await os.fs.readBytes(entry.path);
      else content = await os.fs.readFile(entry.path, { binary: true });
      const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
      const file = new File([bytes], entry.name);
      await navigator.share({ files: [file], title: entry.name });
    } catch (e) {
      if (e.name !== 'AbortError') toast.error(`Error: ${e.message}`);
    }
  }, [os, entry]);

  return (
    <div className="fl-sheet">
      <div className="fl-sheet-backdrop" onClick={onClose} />
      <div className="fl-sheet-panel">
        <div className="fl-sheet-head">
          <span className="fl-sheet-name">Exportar {entry.name}</span>
          <button className="fl-iconbtn" onClick={onClose}>Cancelar</button>
        </div>
        <div className="fl-sheet-actions" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <button className="fl-sheet-action" onClick={download} disabled={busy}>
            <Icon name="arrow.down.circle" size={26} color="#0a84ff" />
            <span>Descargar</span>
          </button>
          <button className="fl-sheet-action" onClick={copyToClipboard} disabled={busy}>
            <Icon name="doc.on.clipboard" size={26} color="#0a84ff" />
            <span>Copiar</span>
          </button>
          <button className="fl-sheet-action" onClick={share} disabled={busy}>
            <Icon name="square.and.arrow.up" size={26} color="#0a84ff" />
            <span>Compartir</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * VISTA: LISTA
 * ========================================================================== */

function FileRow({ entry, selected, selecting, onTap, onLongPress, isFav }) {
  const ico = iconFor(entry.name, entry.isDir);
  return (
    <Swipeable
      onSwipeRight={() => onLongPress?.(entry)}
      actions={[
        { label: 'Favorito', color: '#ffd60a', onAction: () => onLongPress?.(entry, 'fav') },
        { label: 'Eliminar', color: '#ff453a', onAction: () => onLongPress?.(entry, 'delete') },
      ]}
    >
      <TapHandler onTap={() => onTap(entry)} onLongPress={() => onLongPress?.(entry)}>
        <div className={`fl-row ${selected ? 'is-selected' : ''}`}>
          <div className="fl-icon" style={{ color: ico.color }}>
            <Icon name={ico.icon} size={26} color={ico.color} filled={entry.isDir} />
          </div>
          <div className="fl-meta">
            <span className="fl-name">{entry.name}</span>
            <span className="fl-sub">
              {entry.isDir ? 'Carpeta' : formatBytes(entry.size)}
              {entry.modifiedAt ? ` · ${relTime(entry.modifiedAt)}` : ''}
            </span>
          </div>
          {isFav && <Icon name="star.fill" size={14} color="#ffd60a" />}
          {selecting ? (
            <div className={`fl-check ${selected ? 'is-on' : ''}`}>
              {selected && <Icon name="checkmark" size={12} color="#fff" weight={3} />}
            </div>
          ) : entry.isDir ? (
            <Icon name="chevron.right" size={12} color="#48484a" />
          ) : null}
        </div>
      </TapHandler>
    </Swipeable>
  );
}

/* ============================================================================
 * VISTA: GRID
 * ========================================================================== */

function FileGrid({ entries, selection, selecting, onTap, onLongPress, favorites }) {
  return (
    <div className="fl-grid">
      {entries.map((e) => {
        const ico = iconFor(e.name, e.isDir);
        const selected = selection.includes(e.path);
        const isFav = favorites.includes(e.path);
        return (
          <TapHandler key={e.path} onTap={() => onTap(e)} onLongPress={() => onLongPress?.(e)}>
            <div className={`fl-grid-item ${selected ? 'is-selected' : ''}`}>
              <div className="fl-grid-icon-wrap" style={{ color: ico.color }}>
                <Icon name={ico.icon} size={54} color={ico.color} filled={e.isDir} />
                {isFav && (
                  <span className="fl-grid-fav">
                    <Icon name="star.fill" size={11} color="#ffd60a" />
                  </span>
                )}
                {selecting && (
                  <span className={`fl-grid-check ${selected ? 'is-on' : ''}`}>
                    {selected && <Icon name="checkmark" size={11} color="#fff" weight={3} />}
                  </span>
                )}
              </div>
              <span className="fl-grid-name">{e.name}</span>
              <span className="fl-grid-sub">{e.isDir ? 'Carpeta' : formatBytes(e.size)}</span>
            </div>
          </TapHandler>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * VISTA: COLUMNAS (estilo Finder)
 * ========================================================================== */

function ColumnsView({ os, root, state, onNavigate, onTap, selecting, selection, favorites, onLongPress }) {
  const [columns, setColumns] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cols = [];
      let cur = root;
      const parts = state.cwd.startsWith(root) ? state.cwd.slice(root.length).split('/').filter(Boolean) : [];
      for (let i = 0; i <= parts.length; i++) {
        try {
          const list = await os.fs.list(cur);
          const arr = Array.isArray(list) ? list : Object.values(list || {});
          const entries = arr.map((e) => normalizeEntry(e, cur)).filter(Boolean);
          cols.push({ path: cur, entries: applyView(entries, { ...state, search: '' }) });
        } catch {
          cols.push({ path: cur, entries: [] });
        }
        if (i < parts.length) cur = joinPath(cur, parts[i]);
      }
      if (!cancelled) setColumns(cols);
    })();
    return () => { cancelled = true; };
  }, [os, root, state.cwd, state.showHidden, state.sort]);

  return (
    <div className="fl-columns">
      {columns.map((col, idx) => (
        <div key={col.path} className="fl-column">
          <div className="fl-column-head">
            <span>{col.path === '/' ? '/' : col.path.split('/').filter(Boolean).pop() || '/'}</span>
          </div>
          <div className="fl-column-body">
            {col.entries.map((e) => {
              const ico = iconFor(e.name, e.isDir);
              const isCurrent = state.cwd === e.path ||
                state.cwd.startsWith(e.path + '/') && e.isDir;
              const selected = selection.includes(e.path);
              return (
                <TapHandler key={e.path} onTap={() => onTap(e)} onLongPress={() => onLongPress?.(e)}>
                  <div className={`fl-column-row ${isCurrent ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}>
                    <Icon name={ico.icon} size={16} color={ico.color} filled={e.isDir} />
                    <span className="fl-column-name">{e.name}</span>
                    {e.isDir && <Icon name="chevron.right" size={11} color="#48484a" />}
                  </div>
                </TapHandler>
              );
            })}
            {col.entries.length === 0 && (
              <div className="fl-column-empty">Vacío</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================================
 * SIDEBAR
 * ========================================================================== */

function Sidebar({ state, dispatch, os, onClose }) {
  const favCount = state.favorites.length;
  const recentsCount = state.recents.length;

  const go = (path, special = null) => {
    if (special === 'recents') {
      dispatch({ type: 'SET_SPECIAL', view: 'recents' });
    } else if (special === 'favorites') {
      dispatch({ type: 'SET_SPECIAL', view: 'favorites' });
    } else if (special === 'shared') {
      dispatch({ type: 'SET_SPECIAL', view: 'shared' });
    } else if (path) {
      dispatch({ type: 'NAVIGATE', path });
    }
    onClose?.();
  };

  return (
    <div className="fl-sidebar">
      <div className="fl-sidebar-head">Ubicaciones</div>

      <div className="fl-sidebar-section">
        <button
          className={`fl-sidebar-item ${state.cwd === '/private/var/mobile' && !state.specialView ? 'is-active' : ''}`}
          onClick={() => go('/private/var/mobile')}
        >
          <Icon name="iphone" size={22} color="#0a84ff" />
          <span>En mi iPhone</span>
        </button>
        <button
          className={`fl-sidebar-item ${state.cwd === '/private/var/mobile/Library/Mobile Documents' ? 'is-active' : ''}`}
          onClick={() => go('/private/var/mobile/Library/Mobile Documents')}
        >
          <Icon name="cloud" size={22} color="#0a84ff" />
          <span>iCloud Drive</span>
        </button>
      </div>

      <div className="fl-sidebar-section">
        <button
          className={`fl-sidebar-item ${state.specialView === 'favorites' ? 'is-active' : ''}`}
          onClick={() => go(null, 'favorites')}
        >
          <Icon name="star" size={22} color="#ffd60a" filled />
          <span>Favoritos</span>
          <span className="fl-sidebar-count">{favCount || ''}</span>
        </button>
        <button
          className={`fl-sidebar-item ${state.specialView === 'recents' ? 'is-active' : ''}`}
          onClick={() => go(null, 'recents')}
        >
          <Icon name="clock" size={22} color="#8e8e93" />
          <span>Recientes</span>
          <span className="fl-sidebar-count">{recentsCount || ''}</span>
        </button>
      </div>

      <div className="fl-sidebar-section">
        {LOCATIONS.filter((l) => l.id !== 'onmy' && l.id !== 'icloud' && l.id !== 'favorites' && l.id !== 'recents').map((loc) => (
          <button
            key={loc.id}
            className={`fl-sidebar-item ${state.cwd === loc.path ? 'is-active' : ''}`}
            onClick={() => go(loc.path)}
          >
            <Icon
              name={loc.icon}
              size={22}
              color={loc.id === 'downloads' ? '#30d158' : loc.id === 'trash' ? '#ff453a' : '#8e8e93'}
            />
            <span>{loc.name}</span>
          </button>
        ))}
      </div>

      <div className="fl-sidebar-section fl-sidebar-storage">
        <span className="fl-sidebar-storage-label">Almacenamiento</span>
        <StorageBar os={os} />
      </div>
    </div>
  );
}

function StorageBar({ os }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await os?.fs?.stats?.();
        if (s) setStats(s);
      } catch {}
    })();
  }, [os]);

  const used = stats?.used ?? 42 * 1024 * 1024 * 1024;
  const total = stats?.total ?? 128 * 1024 * 1024 * 1024;
  const pct = Math.min(100, (used / total) * 100);

  return (
    <div className="fl-storage">
      <div className="fl-storage-bar">
        <div className="fl-storage-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="fl-storage-text">
        {formatBytes(used)} usados de {formatBytes(total)}
      </div>
    </div>
  );
}

/* ============================================================================
 * NAVBAR
 * ========================================================================== */

function NavBar({ state, dispatch, entries, onAction, onImport, onBack, onSearch }) {
  const crumbs = useMemo(() => {
    const parts = state.cwd.split('/').filter(Boolean);
    const items = [{ name: 'iPhone', path: '/private/var/mobile' }];
    const tail = parts.slice(-2);
    for (let i = 0; i < tail.length; i++) {
      const p = '/' + parts.slice(0, parts.length - tail.length + i + 1).join('/');
      items.push({ name: tail[i], path: p });
    }
    return items;
  }, [state.cwd]);

  const allSelected = state.selection.length === entries.length && entries.length > 0;

  if (state.selecting) {
    return (
      <div className="fl-navbar fl-navbar-select">
        <button className="fl-navbtn" onClick={() => dispatch({ type: 'CLEAR_SELECTION' })}>
          Cancelar
        </button>
        <span className="fl-navbar-count">
          {state.selection.length} seleccionado{state.selection.length !== 1 ? 's' : ''}
        </span>
        <button
          className="fl-navbtn"
          onClick={() => {
            if (allSelected) dispatch({ type: 'SET_SELECTION', paths: [] });
            else dispatch({ type: 'SET_SELECTION', paths: entries.map((e) => e.path) });
          }}
        >
          {allSelected ? 'Ninguno' : 'Todos'}
        </button>
      </div>
    );
  }

  return (
    <div className="fl-navbar">
      <button
        className="fl-navbtn"
        disabled={state.historyIdx <= 0}
        onClick={onBack}
      >
        <Icon name="chevron.left" size={20} color={state.historyIdx <= 0 ? '#48484a' : '#0a84ff'} />
      </button>

      {state.searchActive ? (
        <div className="fl-search fl-search-full">
          <Icon name="magnifyingglass" size={14} color="#8e8e93" />
          <input
            autoFocus
            value={state.search}
            onChange={(e) => dispatch({ type: 'SET_SEARCH', value: e.target.value })}
            placeholder="Buscar en esta carpeta y subcarpetas"
          />
          <button
            className="fl-iconbtn"
            onClick={() => {
              dispatch({ type: 'SET_SEARCH', value: '' });
              dispatch({ type: 'SET_SEARCH_ACTIVE', value: false });
            }}
          >
            Cancelar
          </button>
        </div>
      ) : (
        <div className="fl-crumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path + i}>
              {i > 0 && <span className="fl-crumb-sep">›</span>}
              <button
                className="fl-crumb"
                onClick={() => dispatch({ type: 'NAVIGATE', path: c.path })}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {!state.searchActive && (
        <>
          <button className="fl-navbtn" onClick={onSearch}>
            <Icon name="magnifyingglass" size={18} color="#0a84ff" />
          </button>
          <button className="fl-navbtn" onClick={onImport} title="Importar">
            <Icon name="doc.badge.plus" size={18} color="#0a84ff" />
          </button>
          <button className="fl-navbtn" onClick={onAction}>
            <Icon name="ellipsis.circle" size={20} color="#0a84ff" />
          </button>
        </>
      )}
    </div>
  );
}

/* ============================================================================
 * CONTEXT SHEET
 * ========================================================================== */

function ContextSheet({ entry, onClose, onAction, isFav }) {
  const ico = iconFor(entry.name, entry.isDir);
  const actions = [
    { id: 'open',   label: 'Abrir',       icon: 'arrow.up.right.square' },
    ...(!entry.isDir ? [{ id: 'share', label: 'Exportar', icon: 'square.and.arrow.up' }] : []),
    { id: 'fav',    label: isFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos', icon: isFav ? 'star.slash' : 'star' },
    { id: 'copy',   label: 'Copiar',      icon: 'doc.on.doc' },
    { id: 'move',   label: 'Mover',       icon: 'folder' },
    { id: 'rename', label: 'Renombrar',   icon: 'pencil' },
    { id: 'info',   label: 'Información', icon: 'info.circle' },
  ];

  return (
    <div className="fl-sheet">
      <div className="fl-sheet-backdrop" onClick={onClose} />
      <div className="fl-sheet-panel">
        <div className="fl-sheet-head">
          <div className="fl-sheet-head-icon">
            <Icon name={ico.icon} size={26} color={ico.color} filled={entry.isDir} />
          </div>
          <div className="fl-sheet-head-meta">
            <span className="fl-sheet-name">{entry.name}</span>
            <span className="fl-sheet-sub">
              {entry.isDir ? 'Carpeta' : `${ico.label} · ${formatBytes(entry.size)}`}
            </span>
          </div>
        </div>

        <div className="fl-sheet-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              className="fl-sheet-action"
              onClick={() => { onAction(a.id, entry); onClose(); }}
            >
              <Icon name={a.icon} size={20} color="#0a84ff" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>

        <button
          className="fl-sheet-delete"
          onClick={() => { onAction('delete', entry); onClose(); }}
        >
          <Icon name="trash" size={20} color="#ff453a" />
          <span>Eliminar</span>
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
 * INFO SHEET
 * ========================================================================== */

function InfoSheet({ entry, onClose }) {
  return (
    <div className="fl-sheet">
      <div className="fl-sheet-backdrop" onClick={onClose} />
      <div className="fl-sheet-panel">
        <div className="fl-sheet-head">
          <span className="fl-sheet-name">Información</span>
          <button className="fl-iconbtn" onClick={onClose}>Cerrar</button>
        </div>
        <div className="fl-info">
          <InfoRow k="Nombre" v={entry.name} />
          <InfoRow k="Tipo" v={entry.isDir ? 'Carpeta' : iconFor(entry.name, false).label} />
          <InfoRow k="Tamaño" v={entry.isDir ? '—' : formatBytes(entry.size)} />
          <InfoRow k="Ruta" v={entry.path} mono />
          <InfoRow k="Modificado" v={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString('es-ES') : '—'} />
          <InfoRow k="Creado" v={entry.createdAt ? new Date(entry.createdAt).toLocaleString('es-ES') : '—'} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ k, v, mono }) {
  return (
    <div className="fl-info-row">
      <span className="fl-info-k">{k}</span>
      <span className={`fl-info-v ${mono ? 'is-mono' : ''}`}>{v}</span>
    </div>
  );
}

/* ============================================================================
 * VISTA ESPECIAL: RECIENTES / FAVORITOS
 * ========================================================================== */

function SpecialView({ mode, state, os, onTap, onOpen, onLongPress }) {
  if (mode === 'recents') {
    if (!state.recents.length) {
      return (
        <div className="fl-empty">
          <Icon name="clock" size={44} color="#48484a" />
          <p>Sin archivos recientes</p>
        </div>
      );
    }
    return (
      <div className="fl-list">
        {state.recents.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            selected={false}
            selecting={false}
            onTap={onTap}
            onLongPress={onLongPress}
            isFav={state.favorites.includes(entry.path)}
          />
        ))}
      </div>
    );
  }

  if (mode === 'favorites') {
    if (!state.favorites.length) {
      return (
        <div className="fl-empty">
          <Icon name="star" size={44} color="#48484a" />
          <p>Sin favoritos</p>
        </div>
      );
    }
    return (
      <div className="fl-list">
        {state.favorites.map((path) => {
          const name = path.split('/').filter(Boolean).pop();
          const entry = {
            id: path,
            path,
            name,
            isDir: false,
            size: 0,
            modifiedAt: null,
          };
          return (
            <FileRow
              key={path}
              entry={entry}
              selected={false}
              selecting={false}
              onTap={() => onOpen(path)}
              onLongPress={onLongPress}
              isFav
            />
          );
        })}
      </div>
    );
  }

  return null;
}

/* ============================================================================
 * CONTENT AREA
 * ========================================================================== */

function ContentArea({ state, dispatch, os, entries, loading, error, reload, onImport, onExport }) {
  const [sheetEntry, setSheetEntry] = useState(null);
  const [infoEntry, setInfoEntry] = useState(null);

  const filtered = useMemo(
    () => applyView(entries, state),
    [entries, state.sort, state.search, state.showHidden]
  );

  /* ---- Tap: abrir carpeta o archivo ---- */

  const onTap = useCallback(async (entry) => {
    if (state.selecting) {
      dispatch({ type: 'TOGGLE_SELECT', path: entry.path });
      return;
    }
    if (entry.isDir) {
      dispatch({ type: 'NAVIGATE', path: entry.path });
      return;
    }
    dispatch({ type: 'PUSH_RECENT', entry });

    const ext = extOf(entry.name);
    if (ext === 'ipa') {
      await handleInstallIpa(os, entry);
      return;
    }
    // Otros formatos: intentamos previsualizar (o toast)
    await previewFile(os, entry);
  }, [state.selecting, dispatch, os]);

  /* ---- Long-press: abrir context sheet ---- */

  const onLongPress = useCallback((entry, hint) => {
    if (hint === 'fav') {
      dispatch({ type: 'TOGGLE_FAV', path: entry.path });
      toast.success(
        state.favorites.includes(entry.path) ? 'Quitado de Favoritos' : 'Añadido a Favoritos'
      );
      return;
    }
    if (hint === 'delete') {
      handleDelete(os, [entry], reload);
      return;
    }
    setSheetEntry(entry);
  }, [dispatch, state.favorites, os, reload]);

  /* ---- Acciones del context sheet ---- */

  const handleAction = useCallback(async (actionId, entry) => {
    switch (actionId) {
      case 'open':
        onTap(entry);
        break;
      case 'share':
        onExport(entry);
        break;
      case 'fav':
        dispatch({ type: 'TOGGLE_FAV', path: entry.path });
        toast.success(
          state.favorites.includes(entry.path) ? 'Quitado de Favoritos' : 'Añadido a Favoritos'
        );
        break;
      case 'info':
        setInfoEntry(entry);
        break;
      case 'rename': {
        const name = await alert.prompt({
          title: 'Renombrar',
          message: entry.name,
          placeholder: 'Nuevo nombre',
        });
        if (!name || name === entry.name) return;
        try {
          if (os.fs.rename) {
            await os.fs.rename(entry.path, joinPath(parentPath(entry.path), name));
          } else {
            // Fallback: leer y escribir
            const content = await os.fs.readFile(entry.path, { binary: true });
            await os.fs.writeFile(joinPath(parentPath(entry.path), name), content);
            await os.fs.remove(entry.path);
          }
          toast.success('Renombrado');
          reload();
        } catch (e) {
          toast.error(`No se pudo renombrar: ${e.message}`);
        }
        break;
      }
      case 'copy': {
        try {
          const content = await os.fs.readFile(entry.path, { binary: true });
          const name = uniqueName(`${nameWithoutExt(entry.name)} copia.${extOf(entry.name)}`, filtered.map((f) => f.name));
          await writeBinary(os, joinPath(state.cwd, name), content instanceof Uint8Array ? content : new Uint8Array(content));
          toast.success('Copiado');
          reload();
        } catch (e) {
          toast.error(`Error: ${e.message}`);
        }
        break;
      }
      case 'move':
        toast.info('Mover — selecciona destino después de cortar');
        try {
          const content = await os.fs.readFile(entry.path, { binary: true });
          window.__flClipboard = { path: entry.path, content, name: entry.name };
          toast.success('Copiado al portapapeles interno');
        } catch {}
        break;
      case 'delete':
        handleDelete(os, [entry], reload);
        break;
      default:
        break;
    }
  }, [onTap, onExport, dispatch, state.favorites, state.cwd, os, reload, filtered]);

  /* ---- Selección múltiple: acciones ---- */

  const handleBatchDelete = useCallback(async () => {
    const sel = state.selection.map((path) => ({
      path,
      name: path.split('/').filter(Boolean).pop(),
      isDir: false,
    }));
    await handleDelete(os, sel, reload);
    dispatch({ type: 'CLEAR_SELECTION' });
  }, [state.selection, os, reload, dispatch]);

  const handleBatchFav = useCallback(() => {
    const allFav = state.selection.every((path) => state.favorites.includes(path));
    for (const path of state.selection) {
      const has = state.favorites.includes(path);
      if (allFav && has) dispatch({ type: 'TOGGLE_FAV', path });
      if (!allFav && !has) dispatch({ type: 'TOGGLE_FAV', path });
    }
    toast.success(allFav ? 'Quitado de Favoritos' : 'Añadido a Favoritos');
    dispatch({ type: 'CLEAR_SELECTION' });
  }, [state.selection, state.favorites, dispatch]);

  /* ---- Menú global ---- */

  const onMenuAction = useCallback(async () => {
    const pick = await alert.sheet({
      title: 'Opciones',
      actions: [
        { label: 'Nueva carpeta',        value: 'newfolder' },
        { label: 'Importar…',            value: 'import' },
        { label: 'Ordenar por…',         value: 'sort' },
        { label: VIEWS.find((v) => v.id !== state.view)?.label || 'Cambiar vista', value: 'view' },
        { label: state.showHidden ? 'Ocultar ocultos' : 'Mostrar ocultos', value: 'hidden' },
        { label: 'Limpiar recientes',    value: 'clearrecents' },
      ],
    });
    if (!pick) return;

    if (pick === 'newfolder') {
      const name = await alert.prompt({ title: 'Nueva carpeta', placeholder: 'Nombre' });
      if (!name) return;
      try {
        await os.fs.mkdir(joinPath(state.cwd, name), { recursive: false });
        toast.success('Carpeta creada');
        reload();
      } catch (e) {
        toast.error(`Error: ${e.message}`);
      }
    } else if (pick === 'import') {
      onImport();
    } else if (pick === 'sort') {
      const s = await alert.sheet({
        title: 'Ordenar por',
        actions: SORTS.map((x) => ({ label: x.label, value: x.id })),
      });
      if (s) dispatch({ type: 'SET_SORT', sort: s });
    } else if (pick === 'view') {
      const idx = VIEWS.findIndex((v) => v.id === state.view);
      dispatch({ type: 'SET_VIEW', view: VIEWS[(idx + 1) % VIEWS.length].id });
    } else if (pick === 'hidden') {
      dispatch({ type: 'TOGGLE_HIDDEN' });
    } else if (pick === 'clearrecents') {
      dispatch({ type: 'CLEAR_RECENTS' });
      toast.success('Recientes limpiados');
    }
  }, [state.view, state.cwd, state.showHidden, os, reload, dispatch, onImport]);

  /* ---- Filtro por búsqueda activa ---- */

  if (state.searchActive && state.search.trim()) {
    return (
      <SearchResults
        state={state}
        dispatch={dispatch}
        os={os}
        onTap={onTap}
        onLongPress={onLongPress}
      />
    );
  }

  /* ---- Vistas especiales ---- */

  if (state.specialView === 'recents' || state.specialView === 'favorites') {
    return (
      <SpecialView
        mode={state.specialView}
        state={state}
        os={os}
        onTap={onTap}
        onOpen={(path) => {
          const entry = { id: path, path, name: path.split('/').filter(Boolean).pop(), isDir: false };
          onTap(entry);
        }}
        onLongPress={onLongPress}
      />
    );
  }

  /* ---- Vista normal ---- */

  const showSelectionBar = state.selection.length > 0;

  return (
    <>
      {loading ? (
        <div className="fl-empty">
          <div className="fl-spinner" />
          <p>Cargando…</p>
        </div>
      ) : error ? (
        <div className="fl-empty">
          <Icon name="exclamationmark.triangle" size={40} color="#ff453a" />
          <p>{error}</p>
          <button className="fl-btn" onClick={reload}>Reintentar</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="fl-empty">
          <Icon name={state.cwd === TRASH_DIR ? 'trash' : 'folder'} size={44} color="#48484a" />
          <p>{state.search ? 'Sin resultados' : 'Carpeta vacía'}</p>
          <button className="fl-btn" onClick={onImport}>
            <Icon name="doc.badge.plus" size={16} color="#fff" />
            <span>Importar archivo</span>
          </button>
        </div>
      ) : state.view === 'list' ? (
        <div className="fl-list">
          {filtered.map((e) => (
            <FileRow
              key={e.path}
              entry={e}
              selected={state.selection.includes(e.path)}
              selecting={state.selecting}
              onTap={onTap}
              onLongPress={onLongPress}
              isFav={state.favorites.includes(e.path)}
            />
          ))}
        </div>
      ) : state.view === 'grid' ? (
        <FileGrid
          entries={filtered}
          selection={state.selection}
          selecting={state.selecting}
          onTap={onTap}
          onLongPress={onLongPress}
          favorites={state.favorites}
        />
      ) : (
        <ColumnsView
          os={os}
          root="/private/var/mobile"
          state={state}
          onNavigate={(p) => dispatch({ type: 'NAVIGATE', path: p })}
          onTap={onTap}
          selecting={state.selecting}
          selection={state.selection}
          favorites={state.favorites}
          onLongPress={onLongPress}
        />
      )}

      {showSelectionBar && (
        <div className="fl-selection-bar">
          <button className="fl-sel-btn" onClick={() => onExport({ path: state.selection[0], name: state.selection[0].split('/').pop() })}>
            <Icon name="square.and.arrow.up" size={22} color="#0a84ff" />
            <span>Exportar</span>
          </button>
          <button className="fl-sel-btn" onClick={handleBatchFav}>
            <Icon name="star" size={22} color="#0a84ff" />
            <span>Favorito</span>
          </button>
          <button className="fl-sel-btn" onClick={() => toast.info('Mover — pendiente')}>
            <Icon name="folder" size={22} color="#0a84ff" />
            <span>Mover</span>
          </button>
          <button className="fl-sel-btn fl-sel-btn-danger" onClick={handleBatchDelete}>
            <Icon name="trash" size={22} color="#ff453a" />
            <span>Borrar</span>
          </button>
        </div>
      )}

      {sheetEntry && (
        <ContextSheet
          entry={sheetEntry}
          isFav={state.favorites.includes(sheetEntry.path)}
          onClose={() => setSheetEntry(null)}
          onAction={handleAction}
        />
      )}

      {infoEntry && (
        <InfoSheet entry={infoEntry} onClose={() => setInfoEntry(null)} />
      )}
    </>
  );
}

/* ============================================================================
 * BÚSQUEDA RECURSIVA — componente
 * ========================================================================== */

function SearchResults({ state, dispatch, os, onTap, onLongPress }) {
  useEffect(() => {
    let cancelled = false;
    const q = state.search.trim();
    if (!q) {
      dispatch({ type: 'SET_SEARCH_RESULTS', results: [] });
      return;
    }
    dispatch({ type: 'SET_SEARCH_LOADING', value: true });
    const t = setTimeout(async () => {
      try {
        const results = await searchRecursive(os, state.cwd, q, 5);
        if (!cancelled) dispatch({ type: 'SET_SEARCH_RESULTS', results });
      } catch (e) {
        if (!cancelled) dispatch({ type: 'SET_SEARCH_RESULTS', results: [] });
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [state.search, state.cwd, os, dispatch]);

  if (state.searchLoading) {
    return (
      <div className="fl-empty">
        <div className="fl-spinner" />
        <p>Buscando «{state.search}»…</p>
      </div>
    );
  }

  const results = state.searchResults || [];
  if (!results.length) {
    return (
      <div className="fl-empty">
        <Icon name="magnifyingglass" size={40} color="#48484a" />
        <p>Sin resultados para «{state.search}»</p>
      </div>
    );
  }

  return (
    <div className="fl-list">
      <div className="fl-search-header">
        {results.length} resultado{results.length !== 1 ? 's' : ''} en {state.cwd.split('/').pop() || '/'}
      </div>
      {results.map((e) => (
        <FileRow
          key={e.path}
          entry={e}
          selected={state.selection.includes(e.path)}
          selecting={state.selecting}
          onTap={onTap}
          onLongPress={onLongPress}
          isFav={state.favorites.includes(e.path)}
        />
      ))}
    </div>
  );
}

/* ============================================================================
 * ACCIONES GLOBALES (fuera de componentes)
 * ========================================================================== */

async function handleDelete(os, entries, reload) {
  if (!entries.length) return;
  const isTrash = entries[0]?.path?.startsWith(TRASH_DIR);
  const ok = await alert.destructive({
    title: isTrash
      ? (entries.length === 1 ? '¿Eliminar definitivamente?' : `¿Eliminar ${entries.length} definitivamente?`)
      : (entries.length === 1 ? '¿Mover a la papelera?' : `¿Mover ${entries.length} a la papelera?`),
    message: entries.length === 1 ? entries[0].name : undefined,
    confirmText: isTrash ? 'Eliminar' : 'Mover',
  });
  if (!ok) return;

  let okCount = 0;
  for (const entry of entries) {
    try {
      if (isTrash) {
        if (os.fs.remove) await os.fs.remove(entry.path, { recursive: true });
      } else {
        // Mover a papelera
        await os.fs.mkdir(TRASH_DIR, { recursive: true }).catch(() => {});
        const target = joinPath(TRASH_DIR, entry.name);
        if (os.fs.rename) {
          await os.fs.rename(entry.path, target);
        } else {
          const content = await os.fs.readFile(entry.path, { binary: true });
          await writeBinary(os, target, content instanceof Uint8Array ? content : new Uint8Array(content));
          await os.fs.remove(entry.path, { recursive: true });
        }
      }
      okCount++;
    } catch (e) {
      toast.error(`Error con ${entry.name}: ${e.message}`);
    }
  }
  if (okCount > 0) {
    toast.success(
      isTrash
        ? `${okCount} eliminado${okCount > 1 ? 's' : ''}`
        : `${okCount} movido${okCount > 1 ? 's' : ''} a la papelera`
    );
    reload?.();
  }
}

async function handleInstallIpa(os, entry) {
  if (!os?.ipaInstaller) {
    toast.error('IPAInstaller no disponible');
    return;
  }

  let meta;
  try {
    meta = await os.ipaInstaller.inspect?.(entry.path);
  } catch {}

  const fileMeta = {
    path: entry.path,
    name: entry.name,
    size: entry.size,
    bundleId: meta?.bundleId || 'com.example.unknown',
    version: meta?.version || '1.0',
    displayName: meta?.displayName || entry.name.replace(/\.ipa$/i, ''),
    developer: meta?.developer || 'Desconocido',
    signature: meta?.signature || 'Desconocida',
    entitlements: meta?.entitlements || [],
  };

  // Delegamos a InstallConfirm si está disponible
  if (os?.ui?.confirmInstall) {
    const ok = await os.ui.confirmInstall(fileMeta);
    if (!ok) return;
    return doInstallIpa(os, entry);
  }

  const ok = await alert.confirm({
    title: `¿Instalar ${fileMeta.displayName}?`,
    message: `${fileMeta.bundleId} · v${fileMeta.version} · ${formatBytes(fileMeta.size)}`,
    confirmText: 'Instalar',
    cancelText: 'Cancelar',
  });
  if (!ok) return;
  return doInstallIpa(os, entry);
}

async function doInstallIpa(os, entry) {
  const tid = toast.loading?.('Instalando…') ?? null;
  try {
    await os.ipaInstaller.install(entry.path);
    if (tid) toast.dismiss?.(tid);
    toast.success(`${entry.name} instalada`);
    os.notificationCenter?.post?.({
      bundleId: 'com.apple.Installer',
      title: 'App instalada',
      body: entry.name,
    });
  } catch (e) {
    if (tid) toast.dismiss?.(tid);
    toast.error(`Fallo al instalar: ${e.message}`);
  }
}

async function previewFile(os, entry) {
  const ext = extOf(entry.name);
  const textExts = ['txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'xml', 'yml', 'yaml', 'log', 'sh', 'plist'];
  if (textExts.includes(ext)) {
    try {
      const content = await os.fs.readFile(entry.path);
      const preview = String(content).slice(0, 200);
      toast.info(preview.length < String(content).length ? preview + '…' : preview);
    } catch (e) {
      toast.error(`Error: ${e.message}`);
    }
    return;
  }
  toast.info(`Abriendo ${entry.name}`);
}

/* ============================================================================
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function FilesApp({ appWindowId, instanceId }) {
  const os = useOS();
  const [state, dispatch] = useFiles(os);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exportEntry, setExportEntry] = useState(null);

  const { entries, loading, error, reload } = useDirectory(os, state.cwd);

  /* --------------------------- Sistema de archivos: garantizar carpetas --------------------------- */

  useEffect(() => {
    (async () => {
      for (const dir of [
        '/private/var/mobile',
        DOWNLOADS_DIR,
        TRASH_DIR,
        FAVORITES_DIR,
        '/private/var/mobile/Library',
        '/private/var/mobile/Media/DCIM',
        '/Applications',
        '/private/var/mobile/Library/Mobile Documents',
        '/private/var/mobile/Library/Books',
      ]) {
        try { await os.fs.mkdir(dir, { recursive: true }); } catch {}
      }
    })();
  }, [os]);

  /* --------------------------- Atajos --------------------------- */

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        dispatch({ type: 'SET_SEARCH_ACTIVE', value: true });
      }
      if (meta && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setShowImport(true);
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        (async () => {
          const name = await alert.prompt({ title: 'Nueva carpeta', placeholder: 'Nombre' });
          if (name) {
            try {
              await os.fs.mkdir(joinPath(state.cwd, name), { recursive: false });
              toast.success('Carpeta creada');
              reload();
            } catch (e) { toast.error(e.message); }
          }
        })();
      }
      if (e.key === 'Escape') {
        if (state.searchActive) dispatch({ type: 'SET_SEARCH_ACTIVE', value: false });
        else if (state.selecting) dispatch({ type: 'CLEAR_SELECTION' });
      }
      if (e.key === 'Backspace' && meta) {
        e.preventDefault();
        dispatch({ type: 'BACK' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.cwd, state.searchActive, state.selecting, dispatch, os, reload]);

  if (!state.ready) {
    return (
      <div className="fl-root fl-loading">
        <div className="fl-spinner" />
      </div>
    );
  }

  return (
    <div className="fl-root">
      <NavBar
        state={state}
        dispatch={dispatch}
        entries={entries}
        onAction={async () => {
          // Menú global — delegamos al handler de ContentArea via prop
          const event = new CustomEvent('fl:menu');
          window.dispatchEvent(event);
        }}
        onImport={() => setShowImport(true)}
        onBack={() => dispatch({ type: 'BACK' })}
        onSearch={() => dispatch({ type: 'SET_SEARCH_ACTIVE', value: true })}
      />

      <ContentArea
        state={state}
        dispatch={dispatch}
        os={os}
        entries={entries}
        loading={loading}
        error={error}
        reload={reload}
        onImport={() => setShowImport(true)}
        onExport={(entry) => setExportEntry(entry)}
      />

      {showSidebar && (
        <div className="fl-sidebar-drawer">
          <div className="fl-sidebar-backdrop" onClick={() => setShowSidebar(false)} />
          <div className="fl-sidebar-panel">
            <Sidebar
              state={state}
              dispatch={dispatch}
              os={os}
              onClose={() => setShowSidebar(false)}
            />
            <button className="fl-sidebar-close" onClick={() => setShowSidebar(false)}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      {showImport && (
        <ImportSheet
          os={os}
          cwd={state.cwd}
          onClose={() => setShowImport(false)}
          onImported={reload}
        />
      )}

      {exportEntry && (
        <ExportSheet
          entry={exportEntry}
          os={os}
          onClose={() => setExportEntry(null)}
        />
      )}
    </div>
  );
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('fl-styles')) {
  const s = document.createElement('style');
  s.id = 'fl-styles';
  s.textContent = `
  .fl-root { display:flex; flex-direction:column; height:100%; background:#000; color:#fff;
    font-family:-apple-system, system-ui, sans-serif; -webkit-user-select:none; user-select:none;
    position:relative; }
  .fl-loading { align-items:center; justify-content:center; }
  .fl-spinner { width:32px; height:32px; border-radius:50%;
    border:3px solid rgba(255,255,255,.15); border-top-color:#0a84ff;
    animation:fl-spin .8s linear infinite; }
  @keyframes fl-spin { to { transform:rotate(360deg); } }

  .fl-navbar { display:flex; align-items:center; gap:6px; padding:8px 8px;
    background:#1c1c1e; border-bottom:.5px solid rgba(255,255,255,.08); flex:none; }
  .fl-navbar-select { justify-content:space-between; }
  .fl-navbar-count { font-size:15px; font-weight:600; }
  .fl-navbtn { background:none; border:none; color:#0a84ff; font-size:15px; padding:6px 8px;
    cursor:pointer; display:flex; align-items:center; }
  .fl-navbtn:disabled { color:#48484a; cursor:default; }
  .fl-crumbs { flex:1; display:flex; align-items:center; gap:2px; overflow:hidden; }
  .fl-crumb { background:none; border:none; color:#0a84ff; font-size:14px;
    padding:4px 2px; cursor:pointer; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; max-width:90px; }
  .fl-crumb-sep { color:#48484a; font-size:13px; }
  .fl-search-full { flex:1; display:flex; align-items:center; gap:6px; padding:6px 10px;
    background:#2c2c2e; border-radius:10px; }

  .fl-search-header { padding:10px 16px; font-size:12px; color:#8e8e93;
    text-transform:uppercase; letter-spacing:.5px; background:rgba(255,255,255,.03); }

  .fl-list { flex:1; overflow-y:auto; }
  .fl-row { display:flex; align-items:center; gap:12px; padding:10px 16px;
    border-bottom:.5px solid rgba(255,255,255,.06); cursor:pointer; }
  .fl-row:hover { background:rgba(255,255,255,.03); }
  .fl-row.is-selected { background:rgba(10,132,255,.14); }
  .fl-icon { flex:0 0 auto; width:32px; display:flex; justify-content:center; }
  .fl-meta { flex:1; display:flex; flex-direction:column; gap:2px; overflow:hidden; }
  .fl-name { font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .fl-sub { font-size:12px; color:#8e8e93; }
  .fl-check { width:22px; height:22px; border-radius:50%;
    border:1.5px solid rgba(255,255,255,.4); display:flex; align-items:center;
    justify-content:center; }
  .fl-check.is-on { background:#0a84ff; border-color:#0a84ff; }

  .fl-grid { flex:1; overflow-y:auto; padding:16px 12px 24px;
    display:grid; grid-template-columns:repeat(3, 1fr); gap:18px 12px; }
  .fl-grid-item { display:flex; flex-direction:column; align-items:center;
    gap:6px; cursor:pointer; padding:6px; border-radius:10px; }
  .fl-grid-item.is-selected { background:rgba(10,132,255,.14); }
  .fl-grid-icon-wrap { position:relative; }
  .fl-grid-name { font-size:12px; text-align:center; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .fl-grid-sub { font-size:10px; color:#8e8e93; }
  .fl-grid-fav { position:absolute; top:-2px; right:-2px;
    background:#1c1c1e; border-radius:50%; padding:2px; }
  .fl-grid-check { position:absolute; bottom:-4px; right:-4px; width:20px; height:20px;
    border-radius:50%; border:1.5px solid rgba(255,255,255,.4);
    background:#1c1c1e; display:flex; align-items:center; justify-content:center; }
  .fl-grid-check.is-on { background:#0a84ff; border-color:#0a84ff; }

  .fl-columns { flex:1; overflow-x:auto; overflow-y:hidden; display:flex; }
  .fl-column { flex:0 0 220px; border-right:.5px solid rgba(255,255,255,.08);
    display:flex; flex-direction:column; min-height:0; }
  .fl-column-head { padding:8px 12px; font-size:11px; font-weight:600;
    color:#8e8e93; text-transform:uppercase; letter-spacing:.5px;
    border-bottom:.5px solid rgba(255,255,255,.06); background:rgba(255,255,255,.02); }
  .fl-column-body { flex:1; overflow-y:auto; }
  .fl-column-row { display:flex; align-items:center; gap:8px; padding:6px 12px;
    cursor:pointer; font-size:13px; border-bottom:.5px solid rgba(255,255,255,.03); }
  .fl-column-row:hover { background:rgba(255,255,255,.04); }
  .fl-column-row.is-active { background:rgba(10,132,255,.18); }
  .fl-column-row.is-selected { background:rgba(10,132,255,.28); }
  .fl-column-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .fl-column-empty { padding:20px; text-align:center; color:#48484a; font-size:12px; }

  .fl-empty { flex:1; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:12px; color:#8e8e93; padding:60px 20px; text-align:center; }
  .fl-empty p { margin:0; font-size:15px; }
  .fl-btn { display:inline-flex; align-items:center; justify-content:center;
    gap:6px; padding:8px 16px; background:#2c2c2e; color:#fff; border:none;
    border-radius:10px; font-size:14px; font-weight:500; cursor:pointer; }
  .fl-btn-primary { background:#0a84ff; color:#fff; font-weight:600; }
  .fl-btn-secondary { background:#2c2c2e; color:#0a84ff; }
  .fl-btn-full { width:100%; padding:12px; font-size:16px; }
  .fl-btn:disabled { opacity:.5; cursor:default; }

  .fl-selection-bar { position:absolute; bottom:0; left:0; right:0;
    display:flex; justify-content:space-around; padding:10px 0 max(10px, env(safe-area-inset-bottom, 10px));
    background:rgba(28,28,30,.96); backdrop-filter:blur(20px);
    border-top:.5px solid rgba(255,255,255,.1); }
  .fl-sel-btn { display:flex; flex-direction:column; align-items:center; gap:4px;
    background:none; border:none; color:#0a84ff; font-size:11px; padding:6px 10px;
    cursor:pointer; }
  .fl-sel-btn-danger { color:#ff453a; }

  .fl-sheet { position:absolute; inset:0; z-index:50; }
  .fl-sheet-tall .fl-sheet-panel { max-height:85%; }
  .fl-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.55);
    backdrop-filter:blur(8px); }
  .fl-sheet-panel { position:absolute; bottom:0; left:0; right:0;
    background:#1c1c1e; border-top-left-radius:18px; border-top-right-radius:18px;
    overflow:hidden; animation:fl-up .25s cubic-bezier(.25,.85,.3,1);
    display:flex; flex-direction:column; max-height:70%; }
  @keyframes fl-up { from { transform:translateY(100%); } to { transform:translateY(0); } }
  .fl-sheet-head { display:flex; align-items:center; gap:12px; padding:16px;
    border-bottom:.5px solid rgba(255,255,255,.08); flex:none; }
  .fl-sheet-head-icon { width:44px; height:44px; display:flex;
    align-items:center; justify-content:center; background:rgba(255,255,255,.06);
    border-radius:10px; }
  .fl-sheet-head-meta { display:flex; flex-direction:column; gap:2px; flex:1; }
  .fl-sheet-name { font-size:16px; font-weight:600; }
  .fl-sheet-sub { font-size:12px; color:#8e8e93; }

  .fl-sheet-actions { display:grid; grid-template-columns:repeat(4, 1fr);
    gap:4px; padding:12px 12px 4px; overflow-y:auto; flex:none; }
  .fl-sheet-action { display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:10px 4px; background:none; border:none; color:#0a84ff;
    font-size:11px; cursor:pointer; border-radius:10px; }
  .fl-sheet-action:hover { background:rgba(255,255,255,.04); }
  .fl-sheet-delete { width:100%; padding:14px; background:none; border:none;
    border-top:.5px solid rgba(255,255,255,.08); color:#ff453a; font-size:15px;
    display:flex; align-items:center; justify-content:center; gap:8px;
    cursor:pointer; margin-top:6px; flex:none; }

  .fl-import-tabs { display:flex; padding:12px 16px 0; gap:4px; flex:none; }
  .fl-import-tab { flex:1; display:flex; flex-direction:column; align-items:center;
    gap:4px; padding:10px 4px; background:none; border:none; color:#8e8e93;
    font-size:11px; cursor:pointer; border-radius:10px; }
  .fl-import-tab.is-active { background:rgba(10,132,255,.14); color:#0a84ff; }

  .fl-import-body { padding:16px; display:flex; flex-direction:column; gap:12px;
    overflow-y:auto; flex:1; }
  .fl-import-info { display:flex; align-items:center; gap:8px; padding:10px 12px;
    background:rgba(10,132,255,.08); border-radius:10px; font-size:13px; color:#fff; }
  .fl-import-info strong { color:#0a84ff; font-family:ui-monospace,Menlo,monospace; font-size:11px; }
  .fl-import-hint { font-size:12px; color:#8e8e93; line-height:1.4; margin:0; }
  .fl-import-hint code { background:rgba(255,255,255,.1); padding:1px 5px;
    border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:11px; }

  .fl-input, .fl-textarea { width:100%; padding:12px 14px; background:#2c2c2e;
    border:none; border-radius:10px; color:#fff; font-size:15px; outline:none;
    font-family:inherit; }
  .fl-textarea { font-family:ui-monospace,Menlo,monospace; font-size:13px;
    resize:vertical; min-height:120px; line-height:1.4; }
  .fl-input:focus, .fl-textarea:focus { background:#3a3a3c; }

  .fl-info { padding:8px 0 20px; overflow-y:auto; }
  .fl-info-row { display:flex; justify-content:space-between; gap:14px;
    padding:10px 16px; border-bottom:.5px solid rgba(255,255,255,.05); font-size:13px; }
  .fl-info-k { color:#8e8e93; flex:0 0 auto; }
  .fl-info-v { flex:1; text-align:right; word-break:break-all; }
  .fl-info-v.is-mono { font-family:ui-monospace, Menlo, monospace; font-size:12px; }

  .fl-sidebar { display:flex; flex-direction:column; gap:16px; padding:16px;
    overflow-y:auto; }
  .fl-sidebar-head { font-size:12px; color:#8e8e93; text-transform:uppercase;
    letter-spacing:.6px; }
  .fl-sidebar-section { display:flex; flex-direction:column; gap:2px; }
  .fl-sidebar-item { display:flex; align-items:center; gap:10px; width:100%;
    padding:10px 12px; background:none; border:none; color:#fff; font-size:14px;
    cursor:pointer; border-radius:8px; text-align:left; }
  .fl-sidebar-item.is-active { background:rgba(10,132,255,.14); }
  .fl-sidebar-count { margin-left:auto; color:#8e8e93; font-size:12px; }
  .fl-sidebar-storage { margin-top:auto; padding-top:16px;
    border-top:.5px solid rgba(255,255,255,.08); }
  .fl-sidebar-storage-label { font-size:11px; color:#8e8e93; text-transform:uppercase;
    letter-spacing:.6px; }
  .fl-storage { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .fl-storage-bar { height:5px; background:rgba(255,255,255,.12); border-radius:3px;
    overflow:hidden; }
  .fl-storage-fill { height:100%; background:#0a84ff; border-radius:3px; }
  .fl-storage-text { font-size:11px; color:#8e8e93; }

  .fl-sidebar-drawer { position:absolute; inset:0; z-index:80; }
  .fl-sidebar-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.55); }
  .fl-sidebar-panel { position:absolute; left:0; top:0; bottom:0; width:78%;
    max-width:320px; background:#1c1c1e; overflow-y:auto;
    animation:fl-slide-in .28s ease; }
  @keyframes fl-slide-in { from { transform:translateX(-100%); } to { transform:translateX(0); } }
  .fl-sidebar-close { width:100%; padding:14px; background:none; border:none;
    border-top:.5px solid rgba(255,255,255,.08); color:#0a84ff; font-size:15px; cursor:pointer; }
  `;
  document.head.appendChild(s);
}

export {
  FilesApp,
  normalizeEntry,
  iconFor, extOf, formatBytes, relTime,
  joinPath, parentPath, normalizePath,
};
