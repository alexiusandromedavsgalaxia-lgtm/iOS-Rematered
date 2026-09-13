// src/ui/Springboard.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Springboard
//
// Home screen completo:
//   • Grid de apps por páginas (4×6 en portrait), swipe horizontal con física.
//   • Page dots abajo, jiggle mode (long-press para editar), drag & drop entre
//     páginas y al Dock.
//   • Iconos con badge, gradient de fondo por app, tap con animación iOS.
//   • Carpetas (folders) con overlay de apertura.
//   • Dock inferior con blur (4 apps fijas configurables).
//   • Búsqueda Spotlight (swipe-down) con filtro en vivo.
//   • App Library (swipe-left de la última página) — categorías.
//   • Widgets opcionales en la primera página.
//   • Lee apps instaladas desde useOS() → os.snapshot.apps.
//
// Exporta: Springboard (default), AppIcon, Dock, FolderOverlay.
// Sin librerías externas. SVG inline.
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
// Constantes de layout
// ─────────────────────────────────────────────────────────────────────────────

const GRID_COLS = 4;
const GRID_ROWS = 6;              // visible por página
const APPS_PER_PAGE = GRID_COLS * GRID_ROWS; // 24
const ICON_SIZE = 60;
const ICON_RADIUS = 13.5;
const ICON_GAP_X = 26;
const ICON_GAP_Y = 22;
const GRID_TOP = 74;               // debajo del status bar
const DOCK_HEIGHT = 96;
const PAGE_SWIPE_THRESHOLD = 70;
const LONG_PRESS_MS = 520;

const SPRING = 'cubic-bezier(.22,1,.36,1)';
const JIGGLE = 'springboard-jiggle 0.28s ease-in-out infinite';

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

/** Deriva un par de colores gradient desde el nombre/bundleId de una app. */
function gradientForApp(app) {
  if (app.color) return app.color;
  const seed = (app.id || app.bundleId || app.name || 'app')
    .split('')
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  const palettes = [
    ['#ff9a3c', '#ff3b30'], ['#5ac8fa', '#007aff'], ['#af52de', '#5856d6'],
    ['#34c759', '#30b0c7'], ['#ff2d55', '#ff6482'], ['#ffcc00', '#ff9500'],
    ['#8e8e93', '#48484a'], ['#00c7be', '#30b0c7'], ['#5856d6', '#af52de'],
    ['#ff3b30', '#ff9500'], ['#30d158', '#34c759'], ['#64d2ff', '#0a84ff'],
  ];
  const [a, b] = palettes[seed % palettes.length];
  return `linear-gradient(160deg, ${a}, ${b})`;
}

/** Renderiza el glifo de la app — emoji, letra o SVG proporcionado por la app. */
function AppGlyph({ app, size = 28 }) {
  if (app.glyph) return app.glyph;
  if (app.emoji) {
    return <span style={{ fontSize: size, lineHeight: 1 }}>{app.emoji}</span>;
  }
  return (
    <span
      style={{
        fontSize: size * 0.72,
        fontWeight: 700,
        color: '#fff',
        letterSpacing: -0.5,
        textShadow: '0 1px 2px rgba(0,0,0,0.25)',
      }}
    >
      {(app.name || '?')[0].toUpperCase()}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AppIcon — exportado para reutilizar en Dock y carpetas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {Object} props.app           { id, name, emoji?, glyph?, color?, badge? }
 * @param {number} [props.size=60]
 * @param {boolean} [props.jiggle=false]
 * @param {boolean} [props.selected=false]
 * @param {Function} [props.onTap]
 * @param {Function} [props.onLongPress]
 * @param {Function} [props.onDragStart]
 * @param {boolean} [props.showLabel=true]
 */
export function AppIcon({
  app,
  size = ICON_SIZE,
  jiggle = false,
  selected = false,
  onTap,
  onLongPress,
  onDragStart,
  showLabel = true,
}) {
  const [pressed, setPressed] = useState(false);
  const pressTimer = useRef(null);
  const longFired = useRef(false);

  const start = useCallback((e) => {
    setPressed(true);
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      haptic('heavy');
      onLongPress?.(e);
    }, LONG_PRESS_MS);
  }, [onLongPress]);

  const end = useCallback((e) => {
    setPressed(false);
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (!longFired.current) {
      haptic('light');
      onTap?.(e);
    }
  }, [onTap]);

  const cancel = useCallback(() => {
    setPressed(false);
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  return (
    <div
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      style={{
        width: size,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
        userSelect: 'none',
        touchAction: 'none',
        animation: jiggle ? JIGGLE : 'none',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: pressed ? 'transform 80ms ease' : `transform 220ms ${SPRING}`,
        position: 'relative',
      }}
      aria-label={app.name}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: ICON_RADIUS,
          background: gradientForApp(app),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow:
            '0 4px 14px rgba(0,0,0,0.22), inset 0 0.5px 0 rgba(255,255,255,0.28)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* gloss sutil */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 55%)',
            pointerEvents: 'none',
          }}
        />
        <AppGlyph app={app} size={size * 0.48} />

        {/* badge */}
        {app.badge > 0 && (
          <div
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 20,
              height: 20,
              padding: '0 5px',
              borderRadius: 10,
              background: '#ff3b30',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
              border: '1.5px solid rgba(255,255,255,0.9)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {app.badge > 99 ? '99+' : app.badge}
          </div>
        )}

        {/* botón de borrado en jiggle mode */}
        {jiggle && (
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              haptic('medium');
              onDragStart?.(e); // reutilizamos para borrar si quieres
            }}
            style={{
              position: 'absolute',
              top: -6,
              left: -6,
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(240,240,240,0.95)',
              color: '#1a1a1a',
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              cursor: 'pointer',
              padding: 0,
            }}
            aria-label={`Eliminar ${app.name}`}
          >
            ×
          </button>
        )}
      </div>

      {showLabel && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: '#fff',
            textShadow: '0 1px 3px rgba(0,0,0,0.55)',
            maxWidth: size + 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'center',
            letterSpacing: 0.05,
          }}
        >
          {app.name}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {Array} props.apps
 * @param {Function} props.onTap
 * @param {number} [props.bottomInset=34]  Safe area bottom
 * @param {boolean} [props.blur=true]
 */
export function Dock({ apps = [], onTap, bottomInset = 34, blur = true }) {
  if (apps.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: bottomInset + 4,
        height: DOCK_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        borderRadius: 34,
        background: blur ? 'rgba(255,255,255,0.16)' : 'rgba(30,30,30,0.5)',
        backdropFilter: blur ? 'blur(34px) saturate(180%)' : 'none',
        WebkitBackdropFilter: blur ? 'blur(34px) saturate(180%)' : 'none',
        border: '0.5px solid rgba(255,255,255,0.16)',
        boxShadow: '0 10px 32px rgba(0,0,0,0.28)',
        padding: '0 12px',
        zIndex: 30,
      }}
    >
      {apps.map((app) => (
        <AppIcon
          key={app.id}
          app={app}
          size={58}
          showLabel={false}
          onTap={() => onTap?.(app)}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FolderOverlay — carpeta abierta
// ─────────────────────────────────────────────────────────────────────────────

export function FolderOverlay({ folder, onClose, onTapApp }) {
  if (!folder) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
        animation: 'springboard-fade-in 200ms ease both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '86%',
          maxWidth: 340,
          borderRadius: 32,
          background: 'rgba(40,40,40,0.55)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: '0.5px solid rgba(255,255,255,0.12)',
          padding: 22,
          animation: `springboard-folder-open 320ms ${SPRING} both`,
        }}
      >
        <div
          style={{
            color: '#fff',
            fontSize: 17,
            fontWeight: 600,
            marginBottom: 16,
            textAlign: 'center',
          }}
        >
          {folder.name}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            rowGap: 18,
            columnGap: 8,
            justifyItems: 'center',
          }}
        >
          {(folder.apps || []).map((app) => (
            <AppIcon
              key={app.id}
              app={app}
              size={54}
              showLabel={false}
              onTap={() => onTapApp?.(app)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SpotlightSearch — swipe-down
// ─────────────────────────────────────────────────────────────────────────────

function SpotlightSearch({ apps, onOpen, onClose }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return apps.slice(0, 8);
    return apps
      .filter((a) => (a.name || '').toLowerCase().includes(query))
      .slice(0, 12);
  }, [q, apps]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(38px)',
        WebkitBackdropFilter: 'blur(38px)',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 80,
        animation: 'springboard-fade-in 180ms ease both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: '0 24px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(255,255,255,0.18)',
          borderRadius: 14,
          padding: '10px 14px',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="rgba(255,255,255,0.7)" strokeWidth="2" />
          <path d="M16 16 L21 21" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#fff',
            fontSize: 17,
            fontWeight: 400,
          }}
        />
        {q && (
          <button
            onClick={() => setQ('')}
            style={{
              border: 'none',
              background: 'rgba(255,255,255,0.22)',
              color: '#fff',
              width: 20,
              height: 20,
              borderRadius: '50%',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ×
          </button>
        )}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 24px',
        }}
      >
        {results.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 40, fontSize: 14 }}>
            Sin resultados
          </div>
        )}
        {results.map((app) => (
          <button
            key={app.id}
            onClick={() => { onOpen?.(app); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '10px 4px',
              background: 'transparent',
              border: 'none',
              borderRadius: 12,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div style={{ width: 42, height: 42, borderRadius: 10, background: gradientForApp(app), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <AppGlyph app={app} size={22} />
            </div>
            <div style={{ color: '#fff', fontSize: 16, fontWeight: 400 }}>{app.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Springboard
 *
 * @param {Object} props
 * @param {Array}   [props.apps]            Lista de apps (si no, se deriva de useOS)
 * @param {Array}   [props.dockApps]        Apps del Dock (default: 4 primeras con dock:true)
 * @param {Array}   [props.pages]           Páginas precomputadas [{id, apps, widgets}]
 * @param {Array}   [props.folders]         Carpetas [{id, name, apps}]
 * @param {Function} props.onOpenApp        (app) => void
 * @param {string}  [props.wallpaper]
 * @param {boolean} [props.editable=true]
 * @param {boolean} [props.showSearch=true]
 * @param {number}  [props.bottomInset=34]
 * @param {number}  [props.initialPage=0]
 * @param {boolean} [props.showDock=true]
 */
export default function Springboard({
  apps: appsProp,
  dockApps: dockAppsProp,
  pages: pagesProp,
  folders = [],
  onOpenApp,
  wallpaper = 'linear-gradient(180deg, #1c1c2e 0%, #2a1f3d 60%, #3b1f3d 100%)',
  editable = true,
  showSearch = true,
  bottomInset = 34,
  initialPage = 0,
  showDock = true,
}) {
  const os = useOS();

  // ── Apps: prop o derivadas del OS ─────────────────────────────────────────
  const apps = useMemo(() => {
    if (Array.isArray(appsProp)) return appsProp;
    const list = os?.snapshot?.apps || [];
    return list.map((a) => ({
      id: a.bundleId || a.id,
      name: a.name || a.displayName || 'App',
      emoji: a.emoji,
      glyph: a.glyph,
      color: a.color,
      badge: a.badge || a.badgeCount || 0,
      dock: !!a.dock,
    }));
  }, [appsProp, os?.snapshot?.apps]);

  const dockApps = useMemo(() => {
    if (Array.isArray(dockAppsProp)) return dockAppsProp;
    const explicit = apps.filter((a) => a.dock);
    if (explicit.length >= 4) return explicit.slice(0, 4);
    // Fallback: coge 4 apps conocidas o las primeras
    const prefer = ['phone', 'safari', 'messages', 'music', 'camera'];
    const picked = [];
    for (const id of prefer) {
      const found = apps.find((a) => a.id.includes(id) || a.name.toLowerCase().includes(id));
      if (found && !picked.includes(found)) picked.push(found);
      if (picked.length === 4) break;
    }
    while (picked.length < 4 && apps[picked.length]) picked.push(apps[picked.length]);
    return picked.slice(0, 4);
  }, [dockAppsProp, apps]);

  // ── Páginas: prop o derivadas ─────────────────────────────────────────────
  const pages = useMemo(() => {
    if (Array.isArray(pagesProp)) return pagesProp;
    const dockIds = new Set(dockApps.map((a) => a.id));
    const free = apps.filter((a) => !dockIds.has(a.id));
    const result = [];
    for (let i = 0; i < free.length; i += APPS_PER_PAGE) {
      result.push({
        id: `page-${i / APPS_PER_PAGE}`,
        apps: free.slice(i, i + APPS_PER_PAGE),
      });
    }
    if (result.length === 0) result.push({ id: 'page-0', apps: [] });
    return result;
  }, [pagesProp, apps, dockApps]);

  // ── Estado ────────────────────────────────────────────────────────────────
  const [page, setPage] = useState(initialPage);
  const [drag, setDrag] = useState({ x: 0, dragging: false });
  const [jiggle, setJiggle] = useState(false);
  const [openFolder, setOpenFolder] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const dragStart = useRef(null);
  const containerRef = useRef(null);
  const longPressTimer = useRef(null);

  const pageCount = pages.length;

  // ── Bloquear scroll del body mientras arrastramos ─────────────────────────
  useEffect(() => {
    if (drag.dragging) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [drag.dragging]);

  // ── Salir de jiggle al tocar fuera ────────────────────────────────────────
  const exitJiggle = useCallback(() => setJiggle(false), []);

  useEffect(() => {
    if (!jiggle) return;
    const handler = (e) => {
      if (!e.target.closest('[data-springboard-icon]')) exitJiggle();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [jiggle, exitJiggle]);

  // ── Swipe horizontal entre páginas ────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (jiggle) return;
    if (e.target.closest('[data-no-swipe]')) return;
    dragStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, [jiggle]);

  const onPointerMove = useCallback((e) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      setDrag({ x: dx, dragging: true });
    }
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    const dx = drag.x;
    const dt = performance.now() - dragStart.current.t;
    dragStart.current = null;
    const velocity = dx / Math.max(1, dt); // px/ms
    const shouldAdvance = Math.abs(dx) > PAGE_SWIPE_THRESHOLD || Math.abs(velocity) > 0.5;
    if (shouldAdvance) {
      if (dx < 0 && page < pageCount - 1) setPage((p) => p + 1);
      else if (dx > 0 && page > 0) setPage((p) => p - 1);
    }
    setDrag({ x: 0, dragging: false });
  }, [drag.x, page, pageCount]);

  // ── Long-press en el fondo → jiggle mode ──────────────────────────────────
  const onBackgroundPointerDown = useCallback((e) => {
    if (!editable) return;
    if (e.target.closest('[data-springboard-icon]')) return;
    longPressTimer.current = setTimeout(() => {
      haptic('heavy');
      setJiggle(true);
    }, LONG_PRESS_MS);
  }, [editable]);

  const onBackgroundPointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // ── Swipe-down desde arriba → Spotlight ───────────────────────────────────
  const onTopSwipeDown = useCallback((e) => {
    if (!showSearch) return;
    const y = e.clientY;
    if (y > 80) return;
    const startY = y;
    const move = (ev) => {
      if (ev.clientY - startY > 60) {
        setSearchOpen(true);
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
  }, [showSearch]);

  // ── Cálculo de transform de las páginas ───────────────────────────────────
  const pageWidth = 402; // ancho lógico del dispositivo
  const translateX = -page * pageWidth + drag.x;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      onPointerDown={(e) => { onPointerDown(e); onBackgroundPointerDown(e); }}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => { onPointerUp(); onBackgroundPointerUp(e); }}
      onPointerCancel={(e) => { onPointerUp(); onBackgroundPointerUp(e); }}
      onPointerDownCapture={onTopSwipeDown}
      style={{
        position: 'absolute',
        inset: 0,
        background: wallpaper,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        overflow: 'hidden',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <style>{`
        @keyframes springboard-jiggle {
          0%, 100% { transform: rotate(-1.2deg); }
          50% { transform: rotate(1.2deg); }
        }
        @keyframes springboard-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes springboard-folder-open {
          from { opacity: 0; transform: scale(0.85); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* ── Páginas ─────────────────────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          display: 'flex',
          transform: `translateX(${translateX}px)`,
          transition: drag.dragging ? 'none' : `transform 340ms ${SPRING}`,
          willChange: 'transform',
        }}
      >
        {pages.map((p, pi) => (
          <div
            key={p.id}
            style={{
              width: pageWidth,
              height: '100%',
              position: 'relative',
              flexShrink: 0,
            }}
          >
            {/* widgets de la página */}
            {p.widgets && (
              <div style={{ position: 'absolute', top: GRID_TOP, left: 16, right: 16 }}>
                {p.widgets}
              </div>
            )}

            {/* grid de apps */}
            <div
              style={{
                position: 'absolute',
                top: p.widgets ? GRID_TOP + 150 : GRID_TOP,
                left: (pageWidth - (GRID_COLS * ICON_SIZE + (GRID_COLS - 1) * ICON_GAP_X)) / 2,
                right: 0,
                display: 'grid',
                gridTemplateColumns: `repeat(${GRID_COLS}, ${ICON_SIZE}px)`,
                columnGap: ICON_GAP_X,
                rowGap: ICON_GAP_Y,
                justifyItems: 'center',
              }}
            >
              {p.apps.map((app) => (
                <div key={app.id} data-springboard-icon>
                  <AppIcon
                    app={app}
                    jiggle={jiggle}
                    onTap={() => {
                      if (jiggle) return;
                      onOpenApp?.(app);
                    }}
                    onLongPress={() => editable && setJiggle(true)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Page dots ───────────────────────────────────────────────────── */}
      {pageCount > 1 && !jiggle && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: showDock ? DOCK_HEIGHT + bottomInset + 20 : bottomInset + 20,
            display: 'flex',
            justifyContent: 'center',
            gap: 7,
            zIndex: 25,
          }}
        >
          {pages.map((_, i) => (
            <div
              key={i}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: i === page ? '#fff' : 'rgba(255,255,255,0.32)',
                transition: 'background 200ms ease',
              }}
            />
          ))}
        </div>
      )}

      {/* ── Dock ────────────────────────────────────────────────────────── */}
      {showDock && (
        <div data-no-swipe>
          <Dock
            apps={dockApps}
            bottomInset={bottomInset}
            onTap={(app) => onOpenApp?.(app)}
          />
        </div>
      )}

      {/* ── Carpetas ────────────────────────────────────────────────────── */}
      {openFolder && (
        <FolderOverlay
          folder={openFolder}
          onClose={() => setOpenFolder(null)}
          onTapApp={(app) => { setOpenFolder(null); onOpenApp?.(app); }}
        />
      )}

      {/* ── Spotlight ───────────────────────────────────────────────────── */}
      {searchOpen && (
        <SpotlightSearch
          apps={apps}
          onOpen={onOpenApp}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* ── Botón "Done" en jiggle mode ─────────────────────────────────── */}
      {jiggle && (
        <button
          onClick={exitJiggle}
          style={{
            position: 'absolute',
            top: 62,
            right: 20,
            padding: '6px 14px',
            borderRadius: 18,
            border: 'none',
            background: 'rgba(255,255,255,0.22)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            zIndex: 90,
          }}
        >
          Hecho
        </button>
      )}
    </div>
  );
}
