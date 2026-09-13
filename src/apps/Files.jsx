// src/apps/Files.jsx
// iOS Remastered — Files.app
// Navegador del FileSystem virtual del OS: carpetas, búsqueda, ordenación,
// vista lista/grid, previsualización, y flujo de instalación al tocar un .ipa
// → conecta con IPAInstaller + ui/InstallConfirm.
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

const LOCATIONS = [
  { id: 'recents',   name: 'Recientes',         icon: 'clock',                path: null,        special: 'recents' },
  { id: 'shared',    name: 'Compartido',        icon: 'person.2',             path: null,        special: 'shared' },
  { id: 'icloud',    name: 'iCloud Drive',      icon: 'cloud',                path: '/private/var/mobile/Library/Mobile Documents', special: null },
  { id: 'onmy',      name: 'En mi iPhone',      icon: 'iphone',               path: '/private/var/mobile', special: null },
  { id: 'downloads', name: 'Descargas',         icon: 'arrow.down.circle',    path: '/private/var/mobile/Downloads', special: null },
  { id: 'apps',      name: 'Aplicaciones',      icon: 'square.grid.2x2',      path: '/Applications',     special: null },
  { id: 'books',     name: 'Libros',            icon: 'book',                 path: '/private/var/mobile/Library/Books', special: null },
  { id: 'media',     name: 'Media',             icon: 'photo.on.rectangle',   path: '/private/var/mobile/Media/DCIM', special: null },
  { id: 'trash',     name: 'Papelera',          icon: 'trash',                path: '/private/var/mobile/.Trash', special: null },
];

const FILE_ICONS = {
  ipa:  { icon: 'shippingbox.fill', color: '#0a84ff', label: 'IPA' },
  app:  { icon: 'app.fill',         color: '#0a84ff', label: 'App' },
  zip:  { icon: 'doc.zipper',       color: '#8e8e93', label: 'Zip' },
  txt:  { icon: 'doc.text',         color: '#8e8e93', label: 'Texto' },
  md:   { icon: 'doc.text',         color: '#8e8e93', label: 'Markdown' },
  json: { icon: 'curlybraces',      color: '#ffd60a', label: 'JSON' },
  plist:{ icon: 'list.bullet',      color: '#ff9f0a', label: 'Plist' },
  js:   { icon: 'curlybraces',      color: '#ffd60a', label: 'JS' },
  jsx:  { icon: 'curlybraces',      color: '#ffd60a', label: 'JSX' },
  css:  { icon: 'paintbrush',       color: '#64d2ff', label: 'CSS' },
  html: { icon: 'chevron.left.forwardslash.chevron.right', color: '#ff9f0a', label: 'HTML' },
  png:  { icon: 'photo',            color: '#30d158', label: 'PNG' },
  jpg:  { icon: 'photo',            color: '#30d158', label: 'JPG' },
  jpeg: { icon: 'photo',            color: '#30d158', label: 'JPEG' },
  heic: { icon: 'photo',            color: '#30d158', label: 'HEIC' },
  svg:  { icon: 'photo',            color: '#30d158', label: 'SVG' },
  gif:  { icon: 'photo',            color: '#30d158', label: 'GIF' },
  mov:  { icon: 'video',            color: '#bf5af2', label: 'MOV' },
  mp4:  { icon: 'video',            color: '#bf5af2', label: 'MP4' },
  mp3:  { icon: 'music.note',       color: '#ff375f', label: 'MP3' },
  m4a:  { icon: 'music.note',       color: '#ff375f', label: 'M4A' },
  pdf:  { icon: 'doc.richtext',     color: '#ff453a', label: 'PDF' },
  db:   { icon: 'cylinder',         color: '#8e8e93', label: 'DB' },
  json_:{ icon: 'curlybraces',      color: '#ffd60a', label: 'JSON' },
  sh:   { icon: 'terminal',         color: '#30d158', label: 'Shell' },
  log:  { icon: 'doc.plaintext',    color: '#8e8e93', label: 'Log' },
  bin:  { icon: 'cpu',              color: '#bf5af2', label: 'Binario' },
  dylib:{ icon: 'cpu',              color: '#bf5af2', label: 'Dylib' },
  macho:{ icon: 'cpu',              color: '#bf5af2', label: 'Mach-O' },
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

/* ============================================================================
 * UTILS
 * ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

function formatBytes(b) {
  if (!b || b < 0) return '—';
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
  return `${date.getDate()} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][date.getMonth()]} ${date.getFullYear() !== new Date().getFullYear() ? date.getFullYear() : ''}`.trim();
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function iconFor(name, isDir) {
  if (isDir) return { icon: 'folder.fill', color: '#0a84ff', label: 'Carpeta' };
  const ext = extOf(name);
  return FILE_ICONS[ext] || { icon: 'doc', color: '#8e8e93', label: ext.toUpperCase() || 'Archivo' };
}

function joinPath(base, name) {
  if (base === '/' || base === '') return `/${name}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

function parentPath(p) {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

function shortPath(p, max = 42) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

/* ============================================================================
 * NORMALIZACIÓN DE ENTRADAS DEL FS
 * El FileSystem del OS puede devolver arrays, objetos, con nombres variados.
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
 * HOOK DEL FS
 * ========================================================================== */

function useDirectory(os, path) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!os?.fs || !path) return;
    try {
      setLoading(true);
      setError(null);
      const list = await os.fs.list(path);
      let arr = [];
      if (Array.isArray(list)) arr = list;
      else if (list && typeof list === 'object') arr = Object.values(list);
      const normalized = arr
        .map((e) => normalizeEntry(e, path))
        .filter(Boolean);
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
 * REDUCER
 * ========================================================================== */

const initialState = {
  ready: false,
  cwd: '/private/var/mobile',
  history: [],
  historyIdx: -1,
  view: 'list',          // list | grid
  sort: 'name-asc',
  favorites: [],
  recents: [],
  search: '',
  selection: [],
  selecting: false,
  showHidden: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.state, ready: true };
    case 'NAVIGATE': {
      const history = [...state.history.slice(0, state.historyIdx + 1), action.path];
      return {
        ...state,
        cwd: action.path,
        history,
        historyIdx: history.length - 1,
        selection: [],
        selecting: false,
        search: '',
      };
    }
    case 'BACK': {
      if (state.historyIdx <= 0) return state;
      const idx = state.historyIdx - 1;
      return { ...state, cwd: state.history[idx], historyIdx: idx, selection: [], selecting: false };
    }
    case 'FORWARD': {
      if (state.historyIdx >= state.history.length - 1) return state;
      const idx = state.historyIdx + 1;
      return { ...state, cwd: state.history[idx], historyIdx: idx };
    }
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_SORT':
      return { ...state, sort: action.sort };
    case 'SET_SEARCH':
      return { ...state, search: action.value };
    case 'TOGGLE_HIDDEN':
      return { ...state, showHidden: !state.showHidden };
    case 'TOGGLE_FAV': {
      const has = state.favorites.includes(action.path);
      return {
        ...state,
        favorites: has ? state.favorites.filter((p) => p !== action.path)
                       : [...state.favorites, action.path],
      };
    }
    case 'PUSH_RECENT': {
      const filtered = state.recents.filter((r) => r.path !== action.entry.path);
      return { ...state, recents: [action.entry, ...filtered].slice(0, 30) };
    }
    case 'TOGGLE_SELECT': {
      const has = state.selection.includes(action.path);
      const selection = has
        ? state.selection.filter((p) => p !== action.path)
        : [...state.selection, action.path];
      return { ...state, selection };
    }
    case 'CLEAR_SELECTION':
      return { ...state, selection: [], selecting: false };
    case 'SET_SELECTING':
      return { ...state, selecting: action.value, selection: action.value ? state.selection : [] };
    default:
      return state;
  }
}

async function persist(os, state) {
  try {
    if (!os?.fs) return;
    await os.fs.mkdir('/private/var/mobile/Library/Files', { recursive: true }).catch(() => {});
    await os.fs.writeFile(FILES_DB, JSON.stringify({
      version: 1,
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

  if (!showHidden) list = list.filter((e) => !e.name.startsWith('.'));

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }

  const cmp = {
    'name-asc':  (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'date-desc': (a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0),
    'date-asc':  (a, b) => (a.modifiedAt || 0) - (b.modifiedAt || 0),
    'size-desc': (a, b) => b.size - a.size,
    'size-asc':  (a, b) => a.size - b.size,
    'kind':      (a, b) => {
      const ae = a.isDir ? '' : extOf(a.name);
      const be = b.isDir ? '' : extOf(b.name);
      return ae.localeCompare(be) || a.name.localeCompare(b.name);
    },
  }[sort] || ((a, b) => a.name.localeCompare(b.name));

  // Carpetas primero
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmp(a, b);
  });
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
 * SIDEBAR (barra lateral iOS)
 * ========================================================================== */

function Sidebar({ state, dispatch, os, currentDirReload }) {
  const recentsCount = state.recents.length;
  const favCount = state.favorites.length;

  return (
    <div className="fl-sidebar">
      <div className="fl-sidebar-head">Ubicaciones</div>

      <div className="fl-sidebar-section">
        <button
          className={`fl-sidebar-item ${state.cwd === '/' ? 'is-active' : ''}`}
          onClick={() => dispatch({ type: 'NAVIGATE', path: '/private/var/mobile' })}
        >
          <Icon name="iphone" size={22} color="#0a84ff" />
          <span>En mi iPhone</span>
        </button>
        <button
          className="fl-sidebar-item"
          onClick={() => dispatch({ type: 'NAVIGATE', path: '/private/var/mobile/Library/Mobile Documents' })}
        >
          <Icon name="cloud" size={22} color="#0a84ff" />
          <span>iCloud Drive</span>
        </button>
      </div>

      <div className="fl-sidebar-section">
        <button
          className="fl-sidebar-item"
          onClick={() => dispatch({ type: 'NAVIGATE', path: '/private/var/mobile/Library/Files' })}
        >
          <Icon name="star" size={22} color="#ffd60a" filled />
          <span>Favoritos</span>
          <span className="fl-sidebar-count">{favCount || ''}</span>
        </button>
        <button
          className="fl-sidebar-item"
          onClick={() => dispatch({ type: 'NAVIGATE', path: '/private/var/mobile/Library/Files' })}
        >
          <Icon name="clock" size={22} color="#8e8e93" />
          <span>Recientes</span>
          <span className="fl-sidebar-count">{recentsCount || ''}</span>
        </button>
      </div>

      <div className="fl-sidebar-section">
        {LOCATIONS.map((loc) => (
          <button
            key={loc.id}
            className={`fl-sidebar-item ${state.cwd === loc.path ? 'is-active' : ''}`}
            onClick={() => loc.path && dispatch({ type: 'NAVIGATE', path: loc.path })}
          >
            <Icon name={loc.icon} size={22} color={loc.id === 'downloads' ? '#30d158' : '#8e8e93'} />
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
 * BARRA DE NAVEGACIÓN (breadcrumb + acciones)
 * ========================================================================== */

function NavBar({ state, dispatch, entries, onAction }) {
  const crumbs = useMemo(() => {
    const parts = state.cwd.split('/').filter(Boolean);
    const items = [{ name: 'iPhone', path: '/private/var/mobile' }];
    // Mostramos solo las 2 últimas partes para no saturar
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
            if (allSelected) dispatch({ type: 'CLEAR_SELECTION' });
            else dispatch({ type: 'SET_SELECTING', value: true });
          }}
        >
          {allSelected ? 'Deseleccionar' : 'Todos'}
        </button>
      </div>
    );
  }

  return (
    <div className="fl-navbar">
      <button
        className="fl-navbtn"
        disabled={state.historyIdx <= 0}
        onClick={() => dispatch({ type: 'BACK' })}
      >
        <Icon name="chevron.left" size={20} color={state.historyIdx <= 0 ? '#48484a' : '#0a84ff'} />
      </button>
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
      <button className="fl-navbtn" onClick={() => onAction('menu')}>
        <Icon name="ellipsis.circle" size={20} color="#0a84ff" />
      </button>
    </div>
  );
}

/* ============================================================================
 * SHEET DE OPCIONES (long-press / ellipsis)
 * ========================================================================== */

function ContextSheet({ entry, onClose, onAction, isFav }) {
  const ico = iconFor(entry.name, entry.isDir);
  const actions = [
    { id: 'open',     label: 'Abrir',           icon: 'arrow.up.right.square' },
    ...(entry.isDir ? [] : [{ id: 'share', label: 'Compartir', icon: 'square.and.arrow.up' }]),
    { id: 'fav',      label: isFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos', icon: isFav ? 'star.slash' : 'star' },
    { id: 'copy',     label: 'Copiar',          icon: 'doc.on.doc' },
    { id: 'move',     label: 'Mover',           icon: 'folder' },
    { id: 'rename',   label: 'Renombrar',       icon: 'pencil' },
    { id: 'info',     label: 'Información',     icon: 'info.circle' },
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
 * SHEET DE INFO
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
 * ACCIÓN: INSTALAR IPA
 * ========================================================================== */

function useIpaInstall(os) {
  return useCallback(async (entry) => {
    if (!entry?.path) return;

    if (!os?.ipaInstaller) {
      toast.error('IPAInstaller no disponible');
      return;
    }

    // Leer metadatos del IPA si es posible; si no, mostramos lo que haya
    let meta;
    try {
      meta = await os.ipaInstaller.inspect?.(entry.path);
    } catch { /* seguimos con lo mínimo */ }

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

    // Delegamos a InstallConfirm (global) si está disponible
    if (os?.ui?.confirmInstall) {
      const ok = await os.ui.confirmInstall(fileMeta);
      if (!ok) return;
      return doInstall(os, entry, meta);
    }

    // Fallback: alert.confirm
    const ok = await alert.confirm({
      title: `¿Instalar ${fileMeta.displayName}?`,
      message: `${fileMeta.bundleId} · v${fileMeta.version} · ${formatBytes(fileMeta.size)}`,
      confirmText: 'Instalar',
      cancelText: 'Cancelar',
    });
    if (!ok) return;
    return doInstall(os, entry, meta);
  }, [os]);
}

async function doInstall(os, entry, meta) {
  const toastId = toast.loading?.('Instalando…') ?? null;
  try {
    await os.ipaInstaller.install(entry.path);
    if (toastId) toast.dismiss?.(toastId);
    toast.success(`${entry.name} instalada`);
    os.notificationCenter?.post?.({
      bundleId: 'com.apple.installer',
      title: 'App instalada',
      body: entry.name,
    });
  } catch (e) {
    if (toastId) toast.dismiss?.(toastId);
    toast.error(`Fallo al instalar: ${e.message}`);
  }
}

/* ============================================================================
 * VISTA PRINCIPAL DE CONTENIDO
 * ========================================================================== */

function ContentArea({ state, dispatch, os, entries, loading, error, reload }) {
  const installIpa = useIpaInstall(os);
  const [sheetEntry, setSheetEntry] = useState(null);
  const [infoEntry, setInfoEntry] = useState(null);

  const filtered = useMemo(
    () => applyView(entries, state),
    [entries, state.sort, state.search, state.showHidden]
  );

  const onTap = useCallback((entry) => {
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
      installIpa(entry);
      return;
    }
    // Otros formatos: previsualizar (o toast por ahora)
    toast.info(`Previsualización: ${entry.name}`);
  }, [state.selecting, dispatch, installIpa]);

  const onLongPress = useCallback((entry, hint) => {
    if (hint === 'fav') {
      dispatch({ type: 'TOGGLE_FAV', path: entry.path });
      return;
    }
    if (hint === 'delete') {
      handleDelete(entry);
      return;
    }
    setSheetEntry(entry);
  }, [dispatch]);

  const handleDelete = useCallback(async (entry) => {
    const ok = await alert.destructive({
      title: `¿Eliminar ${entry.isDir ? 'carpeta' : 'archivo'}?`,
      message: entry.name,
      confirmText: 'Eliminar',
    });
    if (!ok) return;
    try {
      await os.fs.remove(entry.path, { recursive: entry.isDir });
      toast.success('Eliminado');
      reload();
    } catch (e) {
      toast.error(`No se pudo eliminar: ${e.message}`);
    }
  }, [os, reload]);

  const handleAction = useCallback(async (actionId, entry) => {
    switch (actionId) {
      case 'open':
        onTap(entry);
        break;
      case 'fav':
        dispatch({ type: 'TOGGLE_FAV', path: entry.path });
        toast.success(
          state.favorites.includes(entry.path)
            ? 'Quitado de Favoritos'
            : 'Añadido a Favoritos'
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
          defaultValue: entry.name,
        });
        if (!name || name === entry.name) return;
        try {
          await os.fs.rename(entry.path, joinPath(parentPath(entry.path), name));
          toast.success('Renombrado');
          reload();
        } catch (e) {
          toast.error(`No se pudo renombrar: ${e.message}`);
        }
        break;
      }
      case 'delete':
        handleDelete(entry);
        break;
      case 'share':
        toast.info(`Compartir ${entry.name}`);
        break;
      case 'copy':
        toast.info('Copiar en portapapeles');
        break;
      case 'move':
        toast.info('Mover — pendiente');
        break;
      default:
        break;
    }
  }, [onTap, dispatch, state.favorites, os, reload, handleDelete]);

  const onMenuAction = useCallback(async (which) => {
    if (which === 'menu') {
      const pick = await alert.sheet({
        title: 'Opciones',
        actions: [
          { label: 'Nueva carpeta',     value: 'newfolder' },
          { label: 'Ordenar por…',      value: 'sort' },
          { label: state.view === 'list' ? 'Vista en cuadrícula' : 'Vista en lista', value: 'view' },
          { label: state.showHidden ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos', value: 'hidden' },
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
      } else if (pick === 'sort') {
        const s = await alert.sheet({
          title: 'Ordenar por',
          actions: SORTS.map((x) => ({ label: x.label, value: x.id })),
        });
        if (s) dispatch({ type: 'SET_SORT', sort: s });
      } else if (pick === 'view') {
        dispatch({ type: 'SET_VIEW', view: state.view === 'list' ? 'grid' : 'list' });
      } else if (pick === 'hidden') {
        dispatch({ type: 'TOGGLE_HIDDEN' });
      }
    }
  }, [state.cwd, state.view, state.showHidden, dispatch, os, reload]);

  return (
    <>
      <div className="fl-toolbar">
        <div className="fl-search">
          <Icon name="magnifyingglass" size={14} color="#8e8e93" />
          <input
            value={state.search}
            onChange={(e) => dispatch({ type: 'SET_SEARCH', value: e.target.value })}
            placeholder="Buscar"
          />
          {state.search && (
            <button className="fl-iconbtn" onClick={() => dispatch({ type: 'SET_SEARCH', value: '' })}>
              <Icon name="xmark.circle.fill" size={16} color="#8e8e93" />
            </button>
          )}
        </div>
        <button
          className="fl-iconbtn"
          onClick={() => dispatch({ type: 'SET_VIEW', view: state.view === 'list' ? 'grid' : 'list' })}
        >
          <Icon name={state.view === 'list' ? 'square.grid.2x2' : 'list.bullet'} size={18} color="#0a84ff" />
        </button>
      </div>

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
          <Icon name="folder" size={44} color="#48484a" />
          <p>{state.search ? 'Sin resultados' : 'Carpeta vacía'}</p>
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
      ) : (
        <FileGrid
          entries={filtered}
          selection={state.selection}
          selecting={state.selecting}
          onTap={onTap}
          onLongPress={onLongPress}
          favorites={state.favorites}
        />
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
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function FilesApp({ appWindowId, instanceId }) {
  const os = useOS();
  const [state, dispatch] = useFiles(os);
  const [showSidebar, setShowSidebar] = useState(false);
  const { entries, loading, error, reload } = useDirectory(os, state.cwd);

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
        onAction={async (which) => {
          if (which === 'menu') {
            const pick = await alert.sheet({
              title: 'Opciones',
              actions: [
                { label: 'Nueva carpeta',     value: 'newfolder' },
                { label: 'Ordenar por…',      value: 'sort' },
                { label: state.view === 'list' ? 'Vista cuadrícula' : 'Vista lista', value: 'view' },
                { label: state.showHidden ? 'Ocultar ocultos' : 'Mostrar ocultos', value: 'hidden' },
                { label: 'Ubicaciones',       value: 'sidebar' },
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
            } else if (pick === 'sort') {
              const s = await alert.sheet({
                title: 'Ordenar por',
                actions: SORTS.map((x) => ({ label: x.label, value: x.id })),
              });
              if (s) dispatch({ type: 'SET_SORT', sort: s });
            } else if (pick === 'view') {
              dispatch({ type: 'SET_VIEW', view: state.view === 'list' ? 'grid' : 'list' });
            } else if (pick === 'hidden') {
              dispatch({ type: 'TOGGLE_HIDDEN' });
            } else if (pick === 'sidebar') {
              setShowSidebar(true);
            }
          }
        }}
      />

      <ContentArea
        state={state}
        dispatch={dispatch}
        os={os}
        entries={entries}
        loading={loading}
        error={error}
        reload={reload}
      />

      {showSidebar && (
        <div className="fl-sidebar-drawer">
          <div className="fl-sidebar-backdrop" onClick={() => setShowSidebar(false)} />
          <div className="fl-sidebar-panel">
            <Sidebar state={state} dispatch={dispatch} os={os} currentDirReload={reload} />
            <button className="fl-sidebar-close" onClick={() => setShowSidebar(false)}>
              Cerrar
            </button>
          </div>
        </div>
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
    background:#1c1c1e; border-bottom:.5px solid rgba(255,255,255,.08); }
  .fl-navbar-select { justify-content:space-between; }
  .fl-navbar-count { font-size:15px; font-weight:600; }
  .fl-navbtn { background:none; border:none; color:#0a84ff; font-size:15px; padding:6px 10px;
    cursor:pointer; display:flex; align-items:center; }
  .fl-navbtn:disabled { color:#48484a; cursor:default; }
  .fl-crumbs { flex:1; display:flex; align-items:center; gap:2px; overflow:hidden; }
  .fl-crumb { background:none; border:none; color:#0a84ff; font-size:14px;
    padding:4px 2px; cursor:pointer; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; max-width:90px; }
  .fl-crumb-sep { color:#48484a; font-size:13px; }

  .fl-toolbar { display:flex; align-items:center; gap:8px; padding:8px 12px;
    background:#0d0d0d; border-bottom:.5px solid rgba(255,255,255,.06); }
  .fl-search { flex:1; display:flex; align-items:center; gap:6px; padding:7px 10px;
    background:#1c1c1e; border-radius:10px; }
  .fl-search input { flex:1; background:none; border:none; outline:none; color:#fff;
    font-size:14px; }
  .fl-iconbtn { background:none; border:none; padding:4px; cursor:pointer; }

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

  .fl-empty { flex:1; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:12px; color:#8e8e93; padding:60px 20px; }
  .fl-empty p { margin:0; font-size:15px; }
  .fl-btn { padding:8px 16px; background:#0a84ff; color:#fff; border:none;
    border-radius:10px; font-size:15px; font-weight:600; cursor:pointer; }

  /* Sheet */
  .fl-sheet { position:absolute; inset:0; z-index:50; }
  .fl-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.55);
    backdrop-filter:blur(8px); }
  .fl-sheet-panel { position:absolute; bottom:0; left:0; right:0;
    background:#1c1c1e; border-top-left-radius:18px; border-top-right-radius:18px;
    overflow:hidden; animation:fl-up .25s cubic-bezier(.25,.85,.3,1); }
  @keyframes fl-up { from { transform:translateY(100%); } to { transform:translateY(0); } }
  .fl-sheet-head { display:flex; align-items:center; gap:12px; padding:16px;
    border-bottom:.5px solid rgba(255,255,255,.08); }
  .fl-sheet-head-icon { width:44px; height:44px; display:flex;
    align-items:center; justify-content:center; background:rgba(255,255,255,.06);
    border-radius:10px; }
  .fl-sheet-head-meta { display:flex; flex-direction:column; gap:2px; flex:1; }
  .fl-sheet-name { font-size:16px; font-weight:600; }
  .fl-sheet-sub { font-size:12px; color:#8e8e93; }

  .fl-sheet-actions { display:grid; grid-template-columns:repeat(4, 1fr);
    gap:4px; padding:12px 12px 4px; }
  .fl-sheet-action { display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:10px 4px; background:none; border:none; color:#0a84ff;
    font-size:11px; cursor:pointer; border-radius:10px; }
  .fl-sheet-action:hover { background:rgba(255,255,255,.04); }
  .fl-sheet-delete { width:100%; padding:14px; background:none; border:none;
    border-top:.5px solid rgba(255,255,255,.08); color:#ff453a; font-size:15px;
    display:flex; align-items:center; justify-content:center; gap:8px;
    cursor:pointer; margin-top:6px; }

  .fl-info { padding:8px 0 20px; }
  .fl-info-row { display:flex; justify-content:space-between; gap:14px;
    padding:10px 16px; border-bottom:.5px solid rgba(255,255,255,.05); font-size:13px; }
  .fl-info-k { color:#8e8e93; flex:0 0 auto; }
  .fl-info-v { flex:1; text-align:right; word-break:break-all; }
  .fl-info-v.is-mono { font-family:ui-monospace, Menlo, monospace; font-size:12px; }

  /* Sidebar */
  .fl-sidebar { display:flex; flex-direction:column; gap:16px; padding:16px; }
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
  joinPath, parentPath,
};
