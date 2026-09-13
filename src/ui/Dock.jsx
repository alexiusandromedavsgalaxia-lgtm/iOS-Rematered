// src/ui/Dock.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Dock
//
// Dock inferior estilo iOS 17+:
//   • Hasta 5 slots. Default 4. Configurable.
//   • Blur real: backdrop-filter blur(34px) saturate(180%) con borde 0.5px.
//   • Hover "shelf": al pasar el dedo/cursor sobre un icono, se agranda y los
//     vecinos se separan (efecto magnificación tipo macOS/iPadOS).
//   • Drop-target real: si arrastras un icono del springboard encima, los
//     slots se separan y aparece un hueco punteado donde caería.
//   • Reorden interno por drag.
//   • Persistencia: guarda el orden en os.fileSystem si está disponible
//     (ruta /private/var/mobile/Library/SpringBoard/Dock.plist).
//   • Vinculación opcional con LaunchServices del IPAInstaller para resolver
//     bundleId → app real.
//
// Exporta: Dock (default), DockSlot.
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
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const SLOT_SIZE = 58;
const SLOT_RADIUS = 13;
const MAX_SLOTS = 5;
const MIN_SLOTS = 1;
const DOCK_HEIGHT = 96;
const DOCK_RADIUS = 34;
const DOCK_PADDING_X = 12;
const HOVER_LIFT = 8;         // px que sube el icono en hover
const HOVER_SCALE = 1.12;     // escala del icono en hover
const NEIGHBOR_SPREAD = 6;    // px extra entre iconos cuando uno está hover
const SPRING = 'cubic-bezier(.22,1,.36,1)';

// Ruta estándar de iOS para el plist del Dock.
const DOCK_PLIST_PATH =
  '/private/var/mobile/Library/SpringBoard/Dock.plist';

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

function gradientForApp(app) {
  if (!app) return 'linear-gradient(160deg, #8e8e93, #48484a)';
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

function AppGlyph({ app, size = 28 }) {
  if (!app) return null;
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
// DockSlot — icono individual del Dock (exportado)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {Object}  props.app               App o null (slot vacío)
 * @param {number} [props.size=58]
 * @param {boolean}[props.hovered=false]
 * @param {boolean}[props.pressed=false]
 * @param {boolean}[props.dragging=false]
 * @param {boolean}[props.dropTarget=false] Este slot es el hueco de drop
 * @param {Function}[props.onTap]
 * @param {Function}[props.onLongPress]
 * @param {Function}[props.onPointerEnter]
 * @param {Function}[props.onPointerLeave]
 * @param {Function}[props.onDragStart]
 * @param {number} [props.liftOffset=0]      Desplazamiento lateral (para spread)
 */
export function DockSlot({
  app,
  size = SLOT_SIZE,
  hovered = false,
  pressed = false,
  dragging = false,
  dropTarget = false,
  onTap,
  onLongPress,
  onPointerEnter,
  onPointerLeave,
  onDragStart,
  liftOffset = 0,
}) {
  const pressTimer = useRef(null);
  const longFired = useRef(false);
  const [localPressed, setLocalPressed] = useState(false);

  const start = useCallback((e) => {
    setLocalPressed(true);
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      haptic('heavy');
      onLongPress?.(e);
    }, 520);
  }, [onLongPress]);

  const end = useCallback((e) => {
    setLocalPressed(false);
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
    setLocalPressed(false);
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  // Slot vacío con drop target
  if (!app && dropTarget) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: SLOT_RADIUS,
          border: '2px dashed rgba(255,255,255,0.55)',
          background: 'rgba(255,255,255,0.08)',
          transform: `translateY(${-HOVER_LIFT * 0.5}px) scale(1.04)`,
          transition: `transform 200ms ${SPRING}, background 200ms ease`,
          animation: 'dock-pulse 1.1s ease-in-out infinite',
        }}
      />
    );
  }

  if (!app) {
    // Slot vacío normal
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: SLOT_RADIUS,
          background: 'transparent',
          transition: 'background 160ms ease',
        }}
      />
    );
  }

  const isActive = hovered || localPressed || pressed;
  const scale = dragging ? 1.04 : isActive ? HOVER_SCALE : 1;
  const lift = dragging ? HOVER_LIFT * 1.4 : isActive ? HOVER_LIFT : 0;

  return (
    <div
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={(e) => { cancel(); onPointerLeave?.(e); }}
      onPointerCancel={cancel}
      onPointerEnter={onPointerEnter}
      style={{
        width: size,
        height: size,
        transform: `translate(${liftOffset}px, ${-lift}px) scale(${scale})`,
        transition: dragging
          ? 'none'
          : `transform 220ms ${SPRING}, filter 200ms ease`,
        transformOrigin: 'bottom center',
        position: 'relative',
        cursor: 'pointer',
        userSelect: 'none',
        touchAction: 'none',
        filter: dragging
          ? 'drop-shadow(0 14px 22px rgba(0,0,0,0.45))'
          : isActive
          ? 'drop-shadow(0 8px 16px rgba(0,0,0,0.35))'
          : 'drop-shadow(0 3px 8px rgba(0,0,0,0.22))',
      }}
      aria-label={app.name}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: SLOT_RADIUS,
          background: gradientForApp(app),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
          boxShadow:
            'inset 0 0.5px 0 rgba(255,255,255,0.28), 0 0 0 0.5px rgba(0,0,0,0.06)',
        }}
      >
        {/* gloss superior */}
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
              top: -3,
              right: -3,
              minWidth: 18,
              height: 18,
              padding: '0 4px',
              borderRadius: 9,
              background: '#ff3b30',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1.5px solid rgba(255,255,255,0.9)',
              fontVariantNumeric: 'tabular-nums',
              boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
            }}
          >
            {app.badge > 99 ? '99+' : app.badge}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: persistencia del Dock sobre FileSystem
// ─────────────────────────────────────────────────────────────────────────────

function useDockPersistence(os) {
  const fs = os?.fileSystem || os?.fs || null;

  const save = useCallback((ids) => {
    if (!fs) return;
    try {
      if (typeof fs.mkdir === 'function') {
        try { fs.mkdir('/private/var/mobile/Library/SpringBoard', { recursive: true }); }
        catch { /* puede existir */ }
      }
      const plist = serializeDockPlist(ids);
      if (typeof fs.writeFileSync === 'function') {
        fs.writeFileSync(DOCK_PLIST_PATH, plist);
      } else if (typeof fs.open === 'function') {
        const fd = fs.open(DOCK_PLIST_PATH, 'w');
        fs.write(fd, plist);
        fs.close(fd);
      }
    } catch { /* persistencia opcional */ }
  }, [fs]);

  const load = useCallback(() => {
    if (!fs) return null;
    try {
      let data = null;
      if (typeof fs.readFileSync === 'function') {
        data = fs.readFileSync(DOCK_PLIST_PATH, 'utf8');
      } else if (typeof fs.open === 'function') {
        const fd = fs.open(DOCK_PLIST_PATH, 'r');
        data = fs.read(fd, 0, 4096);
        fs.close(fd);
      }
      if (!data) return null;
      return parseDockPlist(typeof data === 'string' ? data : data.toString?.() || '');
    } catch {
      return null;
    }
  }, [fs]);

  return { save, load };
}

/** Serializa el array de bundleIds a un plist XML mínimo. */
function serializeDockPlist(ids) {
  const items = ids
    .map((id) => `        <string>${escapeXml(id)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>dock</key>
    <array>
${items}
    </array>
    <key>version</key>
    <integer>1</integer>
</dict>
</plist>
`;
}

/** Parser mínimo del plist anterior. */
function parseDockPlist(xml) {
  if (!xml || !xml.includes('<array>')) return null;
  const arr = xml.split('<array>')[1]?.split('</array>')[0] || '';
  const ids = [];
  const re = /<string>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(arr)) !== null) ids.push(unescapeXml(m[1]));
  return ids.length > 0 ? ids : null;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dock
 *
 * @param {Object} props
 * @param {Array}   [props.apps]              Array de apps (si no, se deriva de useOS)
 * @param {Function} props.onOpenApp          (app) => void
 * @param {number}  [props.maxSlots=5]
 * @param {number}  [props.bottomInset=34]
 * @param {boolean} [props.blur=true]
 * @param {boolean} [props.magnify=true]      Magnificación al hover
 * @param {boolean} [props.persist=true]      Guardar orden en FileSystem
 * @param {boolean} [props.droppable=true]    Aceptar drops de iconos externos
 * @param {boolean} [props.reorderable=true]  Reorden interno por drag
 * @param {'light'|'dark'} [props.theme='dark']
 * @param {string}  [props.accent]            Color del drop indicator
 */
export default function Dock({
  apps: appsProp,
  onOpenApp,
  maxSlots = MAX_SLOTS,
  bottomInset = 34,
  blur = true,
  magnify = true,
  persist = true,
  droppable = true,
  reorderable = true,
  theme = 'dark',
  accent = 'rgba(255,255,255,0.55)',
}) {
  const os = useOS();
  const { save, load } = useDockPersistence(os);

  // ── Resolver apps: prop → OS → LaunchServices ─────────────────────────────
  const allApps = useMemo(() => {
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

  // ── Orden del Dock: estado local, inicializado desde OS o plist ───────────
  const defaultIds = useMemo(() => {
    const explicit = allApps.filter((a) => a.dock).map((a) => a.id);
    if (explicit.length > 0) return explicit.slice(0, maxSlots);
    const prefer = ['phone', 'safari', 'messages', 'music', 'camera'];
    const picked = [];
    for (const key of prefer) {
      const found = allApps.find(
        (a) =>
          (a.id || '').toLowerCase().includes(key) ||
          (a.name || '').toLowerCase().includes(key)
      );
      if (found && !picked.includes(found.id)) picked.push(found.id);
      if (picked.length >= maxSlots) break;
    }
    while (picked.length < Math.min(4, maxSlots) && allApps[picked.length]) {
      picked.push(allApps[picked.length].id);
    }
    return picked;
  }, [allApps, maxSlots]);

  const [ids, setIds] = useState(() => {
    if (!persist) return defaultIds;
    const saved = load();
    return Array.isArray(saved) && saved.length > 0 ? saved.slice(0, maxSlots) : defaultIds;
  });

  // Si cambia la lista de apps (instalación/desinstalación), sanear ids
  useEffect(() => {
    setIds((prev) => {
      const valid = prev.filter((id) => allApps.some((a) => a.id === id));
      // Rellenar huecos hasta el default si quedó corto
      if (valid.length < Math.min(4, maxSlots)) {
        for (const d of defaultIds) {
          if (!valid.includes(d)) valid.push(d);
          if (valid.length >= Math.min(4, maxSlots)) break;
        }
      }
      return valid.slice(0, maxSlots);
    });
  }, [allApps, defaultIds, maxSlots]);

  // Persistir cambios
  useEffect(() => {
    if (!persist) return;
    save(ids);
  }, [ids, persist, save]);

  const apps = useMemo(
    () => ids.map((id) => allApps.find((a) => a.id === id)).filter(Boolean),
    [ids, allApps]
  );

  // ── Estado de interacción ─────────────────────────────────────────────────
  const [hoverIndex, setHoverIndex] = useState(-1);
  const [dragIndex, setDragIndex] = useState(-1);
  const [dragOverIndex, setDragOverIndex] = useState(-1);
  const [externalDrop, setExternalDrop] = useState(null);
  // externalDrop: { index, app } cuando algo de fuera está encima

  const dockRef = useRef(null);

  // ── Magnificación: calcular offset de spread por vecino ───────────────────
  const lifts = useMemo(() => {
    if (!magnify || hoverIndex < 0) return apps.map(() => 0);
    return apps.map((_, i) => {
      const d = Math.abs(i - hoverIndex);
      if (d === 0) return 0;
      if (d === 1) return NEIGHBOR_SPREAD * (i < hoverIndex ? -1 : 1);
      if (d === 2) return NEIGHBOR_SPREAD * 0.4 * (i < hoverIndex ? -1 : 1);
      return 0;
    });
  }, [apps, hoverIndex, magnify]);

  // ── Tap en un slot ────────────────────────────────────────────────────────
  const handleTap = useCallback((app, index) => {
    haptic('medium');
    onOpenApp?.(app, index);
  }, [onOpenApp]);

  // ── Reorden interno: drag desde un slot ───────────────────────────────────
  const handleDragStart = useCallback((index, e) => {
    if (!reorderable) return;
    setDragIndex(index);
    haptic('medium');

    const move = (ev) => {
      if (!dockRef.current) return;
      const rect = dockRef.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const slotW = SLOT_SIZE + 8; // gap visual
      const pad = DOCK_PADDING_X;
      const idx = Math.max(
        0,
        Math.min(apps.length, Math.round((x - pad) / slotW))
      );
      setDragOverIndex(idx);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragIndex(-1);
      const target = dragOverIndex;
      setDragOverIndex(-1);
      if (target < 0) return;
      setIds((prev) => {
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        const insertAt = target > index ? target - 1 : target;
        next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, moved);
        return next.slice(0, maxSlots);
      });
      haptic('light');
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [reorderable, apps.length, dragOverIndex, maxSlots]);

  // ── Drop externo: otro componente puede llamar a dockRef.handleDrop ───────
  // Exponemos una API imperativa vía ref para integración con Springboard.
  useEffect(() => {
    const el = dockRef.current;
    if (!el || !droppable) return;

    const onDragOver = (e) => {
      // El springboard emite un CustomEvent con la posición
      if (!e.detail || !e.detail.app) return;
      const rect = el.getBoundingClientRect();
      const x = (e.detail.clientX ?? rect.left + rect.width / 2) - rect.left;
      const slotW = SLOT_SIZE + 8;
      const idx = Math.max(
        0,
        Math.min(apps.length, Math.round((x - DOCK_PADDING_X) / slotW))
      );
      setDragOverIndex(idx);
      setExternalDrop({ index: idx, app: e.detail.app });
    };

    const onDragLeave = () => {
      setDragOverIndex(-1);
      setExternalDrop(null);
    };

    const onDrop = (e) => {
      const app = e.detail?.app;
      if (!app) return;
      const target = dragOverIndex >= 0 ? dragOverIndex : apps.length;
      setIds((prev) => {
        const without = prev.filter((id) => id !== app.id);
        const next = [...without];
        next.splice(Math.max(0, Math.min(next.length, target)), 0, app.id);
        return next.slice(0, maxSlots);
      });
      haptic('medium');
      setDragOverIndex(-1);
      setExternalDrop(null);
    };

    el.addEventListener('dock:dragover', onDragOver);
    el.addEventListener('dock:dragleave', onDragLeave);
    el.addEventListener('dock:drop', onDrop);
    return () => {
      el.removeEventListener('dock:dragover', onDragOver);
      el.removeEventListener('dock:dragleave', onDragLeave);
      el.removeEventListener('dock:drop', onDrop);
    };
  }, [droppable, apps.length, dragOverIndex, maxSlots]);

  // ── Render ────────────────────────────────────────────────────────────────
  const bg = theme === 'light'
    ? 'rgba(255,255,255,0.55)'
    : 'rgba(255,255,255,0.16)';
  const border = theme === 'light'
    ? '0.5px solid rgba(0,0,0,0.08)'
    : '0.5px solid rgba(255,255,255,0.16)';
  const shadow = theme === 'light'
    ? '0 8px 28px rgba(0,0,0,0.16)'
    : '0 10px 32px rgba(0,0,0,0.28)';

  const showSlotCount = Math.max(apps.length, Math.min(4, maxSlots));

  return (
    <div
      ref={dockRef}
      data-dock
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: bottomInset + 4,
        height: DOCK_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: `0 ${DOCK_PADDING_X}px`,
        borderRadius: DOCK_RADIUS,
        background: bg,
        backdropFilter: blur ? 'blur(34px) saturate(180%)' : 'none',
        WebkitBackdropFilter: blur ? 'blur(34px) saturate(180%)' : 'none',
        border,
        boxShadow: shadow,
        zIndex: 30,
        overflow: 'visible',
        touchAction: 'none',
      }}
    >
      <style>{`
        @keyframes dock-pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @keyframes dock-pop {
          0% { transform: scale(1); }
          50% { transform: scale(1.18); }
          100% { transform: scale(1); }
        }
      `}</style>

      {/* Hueco virtual si el drop va antes del primer slot */}
      {dragOverIndex === 0 && (dragIndex >= 0 || externalDrop) && (
        <DockSlot app={null} dropTarget />
      )}

      {Array.from({ length: showSlotCount }).map((_, i) => {
        const app = apps[i] || null;
        const isHover = hoverIndex === i;
        const isDragging = dragIndex === i;
        // Insertamos hueco antes de este slot si el drag apunta aquí
        const showDropBefore =
          dragOverIndex === i &&
          i !== dragIndex &&
          (dragIndex >= 0 || !!externalDrop) &&
          i > 0;

        return (
          <React.Fragment key={app?.id || `slot-${i}`}>
            {showDropBefore && <DockSlot app={null} dropTarget />}
            <DockSlot
              app={app}
              hovered={isHover}
              dragging={isDragging}
              liftOffset={lifts[i] || 0}
              onTap={() => app && handleTap(app, i)}
              onLongPress={(e) => handleDragStart(i, e)}
              onPointerEnter={() => setHoverIndex(i)}
              onPointerLeave={() => setHoverIndex((v) => (v === i ? -1 : v))}
              onDragStart={(e) => handleDragStart(i, e)}
            />
          </React.Fragment>
        );
      })}

      {/* Hueco al final */}
      {dragOverIndex >= apps.length &&
        (dragIndex >= 0 || externalDrop) && (
          <DockSlot app={null} dropTarget />
        )}

      {/* Empty state */}
      {apps.length === 0 && (
        <div
          style={{
            color: 'rgba(255,255,255,0.55)',
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: 0.2,
          }}
        >
          Arrastra apps aquí
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// API imperativa para integración con Springboard
// ─────────────────────────────────────────────────────────────────────────────
// El Springboard puede hacer:
//   const dock = document.querySelector('[data-dock]');
//   dock.dispatchEvent(new CustomEvent('dock:dragover', {
//     detail: { app, clientX, clientY }
//   }));
//   dock.dispatchEvent(new CustomEvent('dock:drop', { detail: { app } }));
//
// O simplemente pasar `apps` como prop y gestionar el estado desde fuera.
// ─────────────────────────────────────────────────────────────────────────────
