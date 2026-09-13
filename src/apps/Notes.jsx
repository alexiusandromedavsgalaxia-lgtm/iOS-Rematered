// src/apps/Notes.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Notes
//
// App Notas con:
//   • Lista de notas agrupadas por fecha (Hoy, Ayer, últimos 7 días, Anteriores).
//   • Editor con título + cuerpo, y barra de formato (negrita, cursiva, título).
//   • Búsqueda en vivo por título y contenido.
//   • Carpetas: Notas, Recientes, Fijadas, Papelera.
//   • Fijar nota (pin) con swipe desde la lista.
//   • Borrar con swipe (mueve a papelera) y restaurar.
//   • Persistencia real en /private/var/mobile/Library/Notes/notes.json.
//   • Auto-guardado cada 800ms de inactividad en el editor.
//   • Nuevas notas con placeholder "Nueva nota".
//   • Contador de caracteres.
//   • Sincronización con FileSystem del OSContext si está disponible.
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOS } from '../context/OSContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const NOTES_DIR = '/private/var/mobile/Library/Notes';
const NOTES_FILE = `${NOTES_DIR}/notes.json`;
const AUTOSAVE_DELAY = 800;
const SWIPE_THRESHOLD = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

function uid() {
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Formatea fecha para el encabezado del grupo. */
function groupLabel(ts) {
  const now = new Date();
  const d = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (d >= today) return 'Hoy';
  if (d >= yesterday) return 'Ayer';
  if (d >= weekAgo) return 'Últimos 7 días';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('es-ES', { month: 'long' });
  }
  return String(d.getFullYear());
}

/** Formatea hora corta para la lista. */
function shortTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${day}/${m}/${y}`;
}

/** Deriva un título del cuerpo si no hay título explícito. */
function deriveTitle(note) {
  if (note.title && note.title.trim()) return note.title.trim();
  const firstLine = (note.body || '').split('\n').find((l) => l.trim());
  if (firstLine) return firstLine.slice(0, 60);
  return 'Nueva nota';
}

/** Deriva un snippet del cuerpo para la lista. */
function deriveSnippet(note) {
  const body = (note.body || '').trim();
  if (!body) return 'Sin texto adicional';
  const lines = body.split('\n').filter((l) => l.trim());
  const first = lines[0] || '';
  const rest = lines.slice(1).join(' ');
  const combined = (first + ' ' + rest).replace(/\s+/g, ' ').trim();
  return combined.length > 80 ? combined.slice(0, 80) + '…' : combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia sobre FileSystem
// ─────────────────────────────────────────────────────────────────────────────

function loadNotes(fs) {
  if (!fs) return null;
  try {
    if (typeof fs.readFileSync === 'function') {
      const raw = fs.readFileSync(NOTES_FILE, 'utf8');
      if (!raw) return null;
      return JSON.parse(typeof raw === 'string' ? raw : raw.toString?.() || 'null');
    }
    if (typeof fs.open === 'function') {
      const fd = fs.open(NOTES_FILE, 'r');
      const raw = fs.read(fd, 0, 1024 * 512);
      fs.close?.(fd);
      if (!raw) return null;
      return JSON.parse(typeof raw === 'string' ? raw : raw.toString?.() || 'null');
    }
  } catch {
    return null;
  }
  return null;
}

function saveNotes(fs, notes) {
  if (!fs) return;
  const data = JSON.stringify(notes, null, 2);
  try {
    if (typeof fs.mkdir === 'function') {
      try { fs.mkdir(NOTES_DIR, { recursive: true }); } catch { /* existe */ }
    }
    if (typeof fs.writeFileSync === 'function') {
      fs.writeFileSync(NOTES_FILE, data);
      return;
    }
    if (typeof fs.open === 'function') {
      const fd = fs.open(NOTES_FILE, 'w');
      fs.write(fd, data);
      fs.close?.(fd);
    }
  } catch { /* persistencia opcional */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG
// ─────────────────────────────────────────────────────────────────────────────

const I = {
  back: (c = '#ffcc00', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M15 6 L9 12 L15 18" stroke={c} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  compose: (c = '#ffcc00', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M4 20 h4 L20 8 L16 4 L4 16 Z" stroke={c} strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
      <path d="M14 6 L18 10" stroke={c} strokeWidth="1.8"/>
    </svg>
  ),
  search: (c = 'rgba(255,255,255,0.5)', s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke={c} strokeWidth="2" fill="none"/>
      <path d="M16 16 L21 21" stroke={c} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  pin: (c = '#ffcc00', s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M12 2 L13.5 8.5 L20 10 L15 14.5 L16.5 21 L12 17.5 L7.5 21 L9 14.5 L4 10 L10.5 8.5 Z" fill={c}/>
    </svg>
  ),
  pinOutline: (c = 'rgba(255,255,255,0.4)', s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M12 2 L13.5 8.5 L20 10 L15 14.5 L16.5 21 L12 17.5 L7.5 21 L9 14.5 L4 10 L10.5 8.5 Z" stroke={c} strokeWidth="1.6" fill="none" strokeLinejoin="round"/>
    </svg>
  ),
  trash: (c = '#fff', s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M4 7 H20 M9 7 V5 a1 1 0 0 1 1 -1 h4 a1 1 0 0 1 1 1 V7 M6 7 l1 12 a2 2 0 0 0 2 2 h6 a2 2 0 0 0 2 -2 l1 -12" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  bold: (c = '#fff', s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M7 4 H14 a4 4 0 0 1 0 8 H7 Z M7 12 H15 a4 4 0 0 1 0 8 H7 Z" stroke={c} strokeWidth="2" fill="none" strokeLinejoin="round"/>
    </svg>
  ),
  italic: (c = '#fff', s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M10 4 H18 M6 20 H14 M14 4 L10 20" stroke={c} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  underline: (c = '#fff', s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M7 4 V11 a5 5 0 0 0 10 0 V4 M5 20 H19" stroke={c} strokeWidth="2" strokeLinecap="round" fill="none"/>
    </svg>
  ),
  checklist: (c = '#fff', s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M4 7 L7 10 L12 5 M4 17 L7 20 L12 15 M15 8 H20 M15 18 H20" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  folder: (c = '#ffcc00', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M3 6 H8 L10 8 H21 V19 H3 Z" stroke={c} strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Estado persistente
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_NOTES = [
  {
    id: uid(),
    title: 'Bienvenido a Notas',
    body: 'Esta es tu primera nota.\n\n• Pulsa el botón ✎ para crear una nueva.\n• Desliza una nota a la izquierda para borrarla.\n• Desliza a la derecha para fijarla.\n• Toca el título para editarlo.\n\nLas notas se guardan automáticamente.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: true,
    folder: 'notes',
    deleted: false,
  },
  {
    id: uid(),
    title: 'Ideas',
    body: 'Notas rápidas:\n\n1. Probar el Terminal\n2. Ver el Mach-O Viewer\n3. Explorar el Hardware Monitor',
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 3600000,
    pinned: false,
    folder: 'notes',
    deleted: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Componentes
// ─────────────────────────────────────────────────────────────────────────────

/** Fila de nota en la lista, con swipe. */
function NoteRow({ note, onOpen, onDelete, onPin }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);

  const onPointerDown = (e) => {
    dragStart.current = { x: e.clientX, t: performance.now() };
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!dragStart.current) return;
    const d = e.clientX - dragStart.current.x;
    setDx(d);
  };
  const onPointerUp = () => {
    if (!dragStart.current) return;
    const d = dx;
    const dt = performance.now() - dragStart.current.t;
    dragStart.current = null;
    setDragging(false);
    const velocity = Math.abs(d) / Math.max(1, dt);
    if ((d > SWIPE_THRESHOLD || velocity > 0.5) && d > 0) {
      haptic('medium');
      onPin?.(note);
    } else if ((d < -SWIPE_THRESHOLD || velocity > 0.5) && d < 0) {
      haptic('medium');
      onDelete?.(note);
    }
    setDx(0);
  };

  const bg =
    dx > 20 ? 'rgba(255,204,0,0.25)' : dx < -20 ? 'rgba(255,59,48,0.25)' : 'transparent';

  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Fondo según swipe */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: dx > 0 ? 'flex-start' : 'flex-end',
          padding: '0 20px',
          color: dx > 0 ? '#ffcc00' : '#ff453a',
          fontWeight: 600,
          fontSize: 13,
          pointerEvents: 'none',
        }}
      >
        {dx > 20 ? 'Fijar' : dx < -20 ? 'Eliminar' : ''}
      </div>

      {/* Contenido */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => { if (Math.abs(dx) < 5) onOpen?.(note); }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 260ms cubic-bezier(.22,1,.36,1)',
          padding: '12px 16px',
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          cursor: 'pointer',
          background: '#000',
          touchAction: 'pan-y',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          {note.pinned && I.pin()}
          <span style={{ fontSize: 15, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {deriveTitle(note)}
          </span>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
            {shortTime(note.updatedAt)}
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {deriveSnippet(note)}
        </div>
      </div>
    </div>
  );
}

/** Editor de nota. */
function NoteEditor({ note, onChange, onClose }) {
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef(null);
  const bodyRef = useRef(null);
  const timerRef = useRef(null);

  // Auto-focus en el título si la nota está vacía
  useEffect(() => {
    if (!note.title && !note.body) {
      setTimeout(() => titleRef.current?.focus(), 80);
    }
  }, [note.id]);

  // Auto-guardado
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (title !== note.title || body !== note.body) {
        setSaving(true);
        onChange({ title, body });
        setTimeout(() => setSaving(false), 400);
      }
    }, AUTOSAVE_DELAY);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [title, body, note.title, note.body, onChange]);

  // Guardar al cerrar
  const handleClose = () => {
    if (title !== note.title || body !== note.body) {
      onChange({ title, body });
    }
    onClose?.();
  };

  // Formato: insertar markdown en el body
  const applyFormat = (prefix, suffix = prefix) => {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = body.slice(start, end) || 'texto';
    const next = body.slice(0, start) + prefix + selected + suffix + body.slice(end);
    setBody(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    }, 0);
  };

  const applyChecklist = () => {
    const el = bodyRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const before = body.slice(0, pos);
    const after = body.slice(pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const prefix = pos > lineStart ? '\n☐ ' : '☐ ';
    const next = before + prefix + after;
    setBody(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(pos + prefix.length, pos + prefix.length);
    }, 0);
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 5,
        animation: 'notes-slide-in 320ms cubic-bezier(.22,1,.36,1)',
      }}
    >
      <style>{`
        @keyframes notes-slide-in {
          from { transform: translateX(100%); opacity: 0.4; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>

      {/* Barra superior */}
      <div
        style={{
          paddingTop: 58,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleClose}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 6,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            color: '#ffcc00',
            fontSize: 17,
          }}
        >
          {I.back()}
          <span style={{ marginLeft: -4 }}>Notas</span>
        </button>
        <div style={{ flex: 1 }} />
        {saving && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginRight: 8 }}>
            Guardando…
          </span>
        )}
        <button
          style={{
            background: 'transparent',
            border: 'none',
            color: '#ffcc00',
            fontSize: 17,
            cursor: 'pointer',
            padding: 6,
          }}
          aria-label="Más"
        >
          ⋯
        </button>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 40px' }}>
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título"
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#fff',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: -0.3,
            fontFamily: 'inherit',
            marginBottom: 10,
          }}
        />
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 14 }}>
          {new Date(note.updatedAt).toLocaleString('es-ES', {
            day: 'numeric', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })}
        </div>
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Empieza a escribir…"
          style={{
            width: '100%',
            minHeight: 400,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#fff',
            fontSize: 16,
            lineHeight: 1.55,
            fontFamily: 'inherit',
            resize: 'none',
          }}
        />
      </div>

      {/* Barra de formato */}
      <div
        style={{
          position: 'absolute',
          bottom: 40,
          left: 20,
          right: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          padding: '10px 14px',
          background: 'rgba(40,40,45,0.9)',
          backdropFilter: 'blur(30px)',
          WebkitBackdropFilter: 'blur(30px)',
          borderRadius: 22,
          border: '0.5px solid rgba(255,255,255,0.12)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        }}
      >
        <button onClick={() => applyFormat('**')} style={fmtBtn} aria-label="Negrita">{I.bold()}</button>
        <button onClick={() => applyFormat('_')} style={fmtBtn} aria-label="Cursiva">{I.italic()}</button>
        <button onClick={() => applyFormat('<u>', '</u>')} style={fmtBtn} aria-label="Subrayado">{I.underline()}</button>
        <button onClick={applyChecklist} style={fmtBtn} aria-label="Checklist">{I.checklist()}</button>
        <button
          onClick={() => {
            const n = (body.match(/\n/g) || []).length + 1;
            const w = body.trim() ? body.trim().split(/\s+/).length : 0;
            alert(`Caracteres: ${body.length}\nPalabras: ${w}\nLíneas: ${n}`);
          }}
          style={fmtBtn}
          aria-label="Info"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.8" fill="none"/>
            <path d="M12 8 v.01 M11 11 h1 v6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

const fmtBtn = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  cursor: 'pointer',
  padding: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notes
 *
 * @param {Object} props
 * @param {Object} [props.os]
 * @param {Function} [props.onClose]
 */
export default function Notes({ os: osProp, onClose }) {
  const osCtx = useOS();
  const os = osProp || osCtx;
  const fs = os?.fileSystem || os?.fs || null;

  // ── Estado de las notas ───────────────────────────────────────────────────
  const [notes, setNotes] = useState(() => {
    const stored = loadNotes(fs);
    if (Array.isArray(stored) && stored.length > 0) return stored;
    return DEFAULT_NOTES;
  });

  const [folder, setFolder] = useState('notes'); // notes | pinned | trash
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // ── Persistencia automática ──────────────────────────────────────────────
  const saveTimer = useRef(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNotes(fs, notes), 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [notes, fs]);

  // ── Filtrado ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (folder === 'trash') return n.deleted;
      if (n.deleted) return false;
      if (folder === 'pinned' && !n.pinned) return false;
      if (q) {
        const t = (n.title || '').toLowerCase();
        const b = (n.body || '').toLowerCase();
        if (!t.includes(q) && !b.includes(q)) return false;
      }
      return true;
    });
  }, [notes, folder, query]);

  // ── Agrupado por fecha ────────────────────────────────────────────────────
  const grouped = useMemo(() => {
    const pinned = filtered.filter((n) => n.pinned);
    const rest = filtered.filter((n) => !n.pinned);
    const groups = new Map();
    if (pinned.length > 0) groups.set('Fijadas', pinned);
    for (const n of rest) {
      const label = groupLabel(n.updatedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(n);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  const createNote = useCallback(() => {
    const n = {
      id: uid(),
      title: '',
      body: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      folder: 'notes',
      deleted: false,
    };
    setNotes((prev) => [n, ...prev]);
    setOpenId(n.id);
    haptic('light');
  }, []);

  const updateNote = useCallback((id, patch) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
      )
    );
  }, []);

  const deleteNote = useCallback((note) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === note.id ? { ...n, deleted: true, updatedAt: Date.now() } : n
      )
    );
    haptic('medium');
  }, []);

  const restoreNote = useCallback((note) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === note.id ? { ...n, deleted: false, updatedAt: Date.now() } : n
      )
    );
    haptic('light');
  }, []);

  const pinNote = useCallback((note) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === note.id ? { ...n, pinned: !n.pinned, updatedAt: Date.now() } : n
      )
    );
  }, []);

  const emptyTrash = useCallback(() => {
    setNotes((prev) => prev.filter((n) => !n.deleted));
    haptic('heavy');
  }, []);

  const openNote = notes.find((n) => n.id === openId) || null;

  // ── Render del editor ────────────────────────────────────────────────────
  if (openNote) {
    return (
      <NoteEditor
        note={openNote}
        onChange={(patch) => updateNote(openNote.id, patch)}
        onClose={() => setOpenId(null)}
      />
    );
  }

  // ── Render de la lista ───────────────────────────────────────────────────
  const folderTitle =
    folder === 'trash' ? 'Papelera'
    : folder === 'pinned' ? 'Fijadas'
    : 'Notas';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Barra superior */}
      <div
        style={{
          paddingTop: 58,
          paddingBottom: 8,
          paddingLeft: 16,
          paddingRight: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => { haptic('light'); setMenuOpen(true); }}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#ffcc00',
            fontSize: 17,
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {folderTitle}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M6 9 L12 15 L18 9" stroke="#ffcc00" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div style={{ flex: 1 }} />
        {folder === 'trash' && filtered.length > 0 && (
          <button
            onClick={emptyTrash}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#ff453a',
              fontSize: 15,
              cursor: 'pointer',
              padding: 6,
            }}
          >
            Vaciar
          </button>
        )}
      </div>

      {/* Buscador */}
      <div style={{ padding: '8px 16px 0', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(120,120,128,0.24)',
            borderRadius: 10,
            padding: '7px 10px',
          }}
        >
          {I.search()}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchOpen(true)}
            placeholder="Buscar"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#fff',
              fontSize: 15,
              fontFamily: 'inherit',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                background: 'rgba(120,120,128,0.4)',
                border: 'none',
                borderRadius: '50%',
                width: 18,
                height: 18,
                color: '#fff',
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 100 }}>
        {grouped.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>
            {folder === 'trash' ? 'Papelera vacía' : query ? 'Sin resultados' : 'Sin notas'}
          </div>
        )}
        {grouped.map(([label, arr]) => (
          <div key={label}>
            <div
              style={{
                padding: '12px 16px 6px',
                fontSize: 13,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.6)',
                background: '#000',
                position: 'sticky',
                top: 0,
                zIndex: 2,
              }}
            >
              {label}
            </div>
            {arr.map((n) => (
              folder === 'trash' ? (
                <div
                  key={n.id}
                  onClick={() => setOpenId(n.id)}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '0.5px solid rgba(255,255,255,0.08)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                    {deriveTitle(n)}
                  </div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>
                    {deriveSnippet(n)}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); restoreNote(n); }}
                    style={{
                      marginTop: 8,
                      background: 'rgba(255,204,0,0.15)',
                      border: 'none',
                      borderRadius: 12,
                      padding: '5px 12px',
                      color: '#ffcc00',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Restaurar
                  </button>
                </div>
              ) : (
                <NoteRow
                  key={n.id}
                  note={n}
                  onOpen={(note) => setOpenId(note.id)}
                  onDelete={deleteNote}
                  onPin={pinNote}
                />
              )
            ))}
          </div>
        ))}
      </div>

      {/* Botón flotante: nueva nota */}
      {folder !== 'trash' && (
        <button
          onClick={createNote}
          style={{
            position: 'absolute',
            bottom: 60,
            right: 24,
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(255,204,0,0.9)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
            zIndex: 10,
          }}
          aria-label="Nueva nota"
        >
          {I.compose('#000', 26)}
        </button>
      )}

      {/* Menú de carpetas */}
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            zIndex: 30,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            padding: '80px 20px',
            animation: 'notes-fade 200ms ease',
          }}
        >
          <style>{`
            @keyframes notes-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgba(40,40,45,0.95)',
              backdropFilter: 'blur(30px)',
              WebkitBackdropFilter: 'blur(30px)',
              borderRadius: 16,
              overflow: 'hidden',
              minWidth: 220,
              border: '0.5px solid rgba(255,255,255,0.12)',
            }}
          >
            {[
              { id: 'notes', label: 'Notas' },
              { id: 'pinned', label: 'Fijadas' },
              { id: 'trash', label: 'Papelera' },
            ].map((it) => (
              <button
                key={it.id}
                onClick={() => { setFolder(it.id); setMenuOpen(false); haptic('light'); }}
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  background: folder === it.id ? 'rgba(255,204,0,0.15)' : 'transparent',
                  border: 'none',
                  color: folder === it.id ? '#ffcc00' : '#fff',
                  fontSize: 16,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderBottom: '0.5px solid rgba(255,255,255,0.08)',
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Home indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 134,
          height: 5,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.85)',
          pointerEvents: 'none',
          zIndex: 11,
        }}
      />
    </div>
  );
}
