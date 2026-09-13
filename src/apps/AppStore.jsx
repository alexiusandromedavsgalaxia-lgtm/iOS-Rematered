// src/apps/AppStore.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — AppStore
//
// App Store simulada. Reproduce las secciones de https://apps.apple.com/us/iphone/:
//   • Today — Highlights, In-App Events, Editors' Favorites
//   • Games — Hot This Week, Indie Games We Love, Play Well With Others
//   • Apps — Level Up Your Socials, That's Entertainment!, Hot This Week
//   • Arcade — juegos premium
//   • Search — búsqueda con filtro
//
// Además, embebe todas las apps del sistema restantes como "instalables":
//   • Calculator, Notes, Photos, Terminal, MachOViewer, HardwareMonitor,
//     Clock, Weather, Files, Safari, Installer.
//
// El botón "OBTENER" registra la app en el registry y muestra el progreso
// circular como iOS. Las apps nativas ya están registradas; el botón solo
// las abre. Las "descargables" se registran on-the-fly.
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
import registry from './registry.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'today',  label: 'Today',  icon: 'today' },
  { id: 'games',  label: 'Juegos', icon: 'games' },
  { id: 'apps',   label: 'Apps',   icon: 'apps' },
  { id: 'arcade', label: 'Arcade', icon: 'arcade' },
  { id: 'search', label: 'Buscar', icon: 'search' },
];

const SPRING = 'cubic-bezier(.22,1,.36,1)';

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG
// ─────────────────────────────────────────────────────────────────────────────

const I = {
  today: (c = 'currentColor', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="16" rx="3" stroke={c} strokeWidth="1.8" fill="none"/>
      <path d="M3 9 H21" stroke={c} strokeWidth="1.8"/>
      <path d="M8 3 V7 M16 3 V7" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="12" cy="15" r="2.4" fill={c}/>
    </svg>
  ),
  games: (c = 'currentColor', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="7" width="20" height="12" rx="6" stroke={c} strokeWidth="1.8" fill="none"/>
      <circle cx="8" cy="13" r="1" fill={c}/>
      <circle cx="8" cy="10" r="1" fill={c}/>
      <circle cx="11" cy="13" r="1" fill={c}/>
      <circle cx="8" cy="13" r="0.01" fill={c}/>
      <circle cx="16" cy="12" r="1.2" fill={c}/>
      <circle cx="18.5" cy="14" r="1.2" fill={c}/>
    </svg>
  ),
  apps: (c = 'currentColor', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="4" width="6" height="6" rx="1.6" stroke={c} strokeWidth="1.8" fill="none"/>
      <rect x="14" y="4" width="6" height="6" rx="1.6" stroke={c} strokeWidth="1.8" fill="none"/>
      <rect x="4" y="14" width="6" height="6" rx="1.6" stroke={c} strokeWidth="1.8" fill="none"/>
      <rect x="14" y="14" width="6" height="6" rx="1.6" stroke={c} strokeWidth="1.8" fill="none"/>
    </svg>
  ),
  arcade: (c = 'currentColor', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M6 20 V6 a4 4 0 0 1 4 -4 h4 a4 4 0 0 1 4 4 v14" stroke={c} strokeWidth="1.8" fill="none"/>
      <path d="M6 10 H18" stroke={c} strokeWidth="1.8"/>
      <circle cx="10" cy="15" r="1" fill={c}/>
      <circle cx="14" cy="15" r="1" fill={c}/>
    </svg>
  ),
  search: (c = 'currentColor', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke={c} strokeWidth="2" fill="none"/>
      <path d="M16 16 L21 21" stroke={c} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  star: (c = '#8e8e93', s = 12) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M12 2 L15 9 L22 9.5 L17 14.5 L18.5 21.5 L12 18 L5.5 21.5 L7 14.5 L2 9.5 L9 9 Z" fill={c}/>
    </svg>
  ),
  chevron: (c = 'rgba(255,255,255,0.4)', s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M9 6 L15 12 L9 18" stroke={c} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  back: (c = '#0a84ff', s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M15 6 L9 12 L15 18" stroke={c} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Iconos de apps del sistema restantes (mini)
// ─────────────────────────────────────────────────────────────────────────────

function SysGlyph({ kind, size = 52 }) {
  const s = size;
  const w = s * 0.5;
  const common = { display: 'block', width: w, height: w };
  switch (kind) {
    case 'calculator':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="4" y="3" width="16" height="18" rx="2" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <rect x="6" y="5" width="12" height="4" rx="1" fill="#fff" opacity="0.6"/>
          <circle cx="9" cy="13" r="0.9" fill="#fff"/><circle cx="12" cy="13" r="0.9" fill="#fff"/><circle cx="15" cy="13" r="0.9" fill="#fff"/>
          <circle cx="9" cy="17" r="0.9" fill="#fff"/><circle cx="12" cy="17" r="0.9" fill="#fff"/><circle cx="15" cy="17" r="0.9" fill="#fff"/>
        </svg>
      );
    case 'notes':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M8 8 H16 M8 12 H16 M8 16 H13" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      );
    case 'photos':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M3 16 L9 10 L13 14 L17 10 L21 14" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="16" cy="8" r="1.5" fill="#fff"/>
        </svg>
      );
    case 'terminal':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="16" rx="2" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M7 10 L10 13 L7 16" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M12 16 H17" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      );
    case 'macho':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M5 3 H14 L19 8 V21 H5 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
          <path d="M14 3 V8 H19" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
          <circle cx="12" cy="15" r="2" stroke="#fff" strokeWidth="1.6" fill="none"/>
        </svg>
      );
    case 'hardware':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="5" y="5" width="14" height="14" rx="2" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <rect x="9" y="9" width="6" height="6" rx="1" fill="#fff" opacity="0.7"/>
          <path d="M9 2 V5 M15 2 V5 M9 19 V22 M15 19 V22 M2 9 H5 M2 15 H5 M19 9 H22 M19 15 H22" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      );
    case 'clock':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M12 6 V12 L16 14" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      );
    case 'weather':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill="#fff"/>
          <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      );
    case 'files':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M3 6 H8 L10 8 H21 V19 H3 Z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
        </svg>
      );
    case 'safari':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M16 8 L14 14 L8 16 L10 10 Z" fill="#fff"/>
        </svg>
      );
    case 'installer':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M12 3 V15" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
          <path d="M7 10 L12 15 L17 10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4 17 V20 A1 1 0 0 0 5 21 H19 A1 1 0 0 0 20 20 V17" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
        </svg>
      );
    case 'settings':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="#fff" strokeWidth="1.8" fill="none"/>
          <path d="M19.4 15 a1.7 1.7 0 0 0 .34 1.87 l.06.06 a2 2 0 1 1 -2.83 2.83 l-.06-.06 a1.7 1.7 0 0 0 -1.87 -.34 a1.7 1.7 0 0 0 -1 1.55 V21 a2 2 0 1 1 -4 0 v-.09 a1.7 1.7 0 0 0 -1.11 -1.55 a1.7 1.7 0 0 0 -1.87 .34 l-.06 .06 a2 2 0 1 1 -2.83 -2.83 l.06 -.06 a1.7 1.7 0 0 0 .34 -1.87 a1.7 1.7 0 0 0 -1.55 -1 H3 a2 2 0 1 1 0 -4 h.09 A1.7 1.7 0 0 0 4.64 9 a1.7 1.7 0 0 0 -.34 -1.87 l-.06 -.06 a2 2 0 1 1 2.83 -2.83 l.06 .06 a1.7 1.7 0 0 0 1.87 .34 H9 a1.7 1.7 0 0 0 1 -1.55 V3 a2 2 0 1 1 4 0 v.09 a1.7 1.7 0 0 0 1 1.55 a1.7 1.7 0 0 0 1.87 -.34 l.06 -.06 a2 2 0 1 1 2.83 2.83 l-.06 .06 a1.7 1.7 0 0 0 -.34 1.87 V9 a1.7 1.7 0 0 0 1.55 1 H21 a2 2 0 1 1 0 4 h-.09 a1.7 1.7 0 0 0 -1.51 1 z" stroke="#fff" strokeWidth="1.6" fill="none"/>
        </svg>
      );
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo — mezcla de las apps del sistema restantes + apps ficticias
// Estructura: { id, name, developer, category, color, glyph, stars, size,
//               installable, section }
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_CATALOG = [
  {
    id: 'com.apple.calculator',
    name: 'Calculadora',
    developer: 'Apple',
    category: 'Utilidades',
    color: 'linear-gradient(160deg, #8e8e93, #48484a)',
    glyph: <SysGlyph kind="calculator" />,
    stars: 4.7,
    size: 2.1,
    installable: true,
    section: 'apps',
    description: 'Calculadora básica y científica con historial.',
  },
  {
    id: 'com.apple.mobilenotes',
    name: 'Notas',
    developer: 'Apple',
    category: 'Productividad',
    color: 'linear-gradient(160deg, #ffcc00, #ff9500)',
    glyph: <SysGlyph kind="notes" />,
    stars: 4.8,
    size: 5.4,
    installable: true,
    section: 'apps',
    description: 'Toma notas con formato, listas y dibujos.',
  },
  {
    id: 'com.apple.mobileslideshow',
    name: 'Fotos',
    developer: 'Apple',
    category: 'Foto y vídeo',
    color: 'linear-gradient(160deg, #ffcc00, #ff9500)',
    glyph: <SysGlyph kind="photos" />,
    stars: 4.9,
    size: 12.8,
    installable: true,
    section: 'apps',
    description: 'Tu biblioteca de fotos y vídeos, organizada.',
  },
  {
    id: 'com.apple.Terminal',
    name: 'Terminal',
    developer: 'iOS Remastered',
    category: 'Desarrollo',
    color: 'linear-gradient(160deg, #1c1c1e, #000)',
    glyph: <SysGlyph kind="terminal" />,
    stars: 4.6,
    size: 1.4,
    installable: true,
    section: 'apps',
    description: 'Consola con comandos del kernel y del sistema.',
  },
  {
    id: 'com.iosremastered.machoviewer',
    name: 'Mach-O Viewer',
    developer: 'iOS Remastered',
    category: 'Desarrollo',
    color: 'linear-gradient(160deg, #af52de, #5856d6)',
    glyph: <SysGlyph kind="macho" />,
    stars: 4.9,
    size: 3.2,
    installable: true,
    section: 'apps',
    description: 'Carga y explora binarios Mach-O y fat binaries.',
  },
  {
    id: 'com.iosremastered.hardware',
    name: 'Hardware Monitor',
    developer: 'iOS Remastered',
    category: 'Desarrollo',
    color: 'linear-gradient(160deg, #ff375f, #af52de)',
    glyph: <SysGlyph kind="hardware" />,
    stars: 4.8,
    size: 2.6,
    installable: true,
    section: 'apps',
    description: 'Estadísticas en vivo de todos los drivers V*.',
  },
  {
    id: 'com.apple.mobiletimer',
    name: 'Reloj',
    developer: 'Apple',
    category: 'Utilidades',
    color: 'linear-gradient(160deg, #1c1c1e, #3a3a3c)',
    glyph: <SysGlyph kind="clock" />,
    stars: 4.6,
    size: 4.8,
    installable: true,
    section: 'apps',
    description: 'Alarmas, cronómetro y temporizadores.',
  },
  {
    id: 'com.apple.weather',
    name: 'Tiempo',
    developer: 'Apple',
    category: 'Tiempo',
    color: 'linear-gradient(160deg, #5ac8fa, #007aff)',
    glyph: <SysGlyph kind="weather" />,
    stars: 4.5,
    size: 3.9,
    installable: true,
    section: 'apps',
    description: 'Pronóstico del tiempo para tu ciudad.',
  },
  {
    id: 'com.apple.files',
    name: 'Archivos',
    developer: 'Apple',
    category: 'Productividad',
    color: 'linear-gradient(160deg, #5ac8fa, #0a84ff)',
    glyph: <SysGlyph kind="files" />,
    stars: 4.4,
    size: 3.1,
    installable: true,
    section: 'apps',
    description: 'Navega por el sistema de archivos virtual.',
  },
  {
    id: 'com.apple.mobilesafari',
    name: 'Safari',
    developer: 'Apple',
    category: 'Internet',
    color: 'linear-gradient(160deg, #5ac8fa, #007aff)',
    glyph: <SysGlyph kind="safari" />,
    stars: 4.7,
    size: 8.2,
    installable: true,
    section: 'apps',
    description: 'Navegador web rápido y privado.',
  },
  {
    id: 'com.iosremastered.installer',
    name: 'Instalador',
    developer: 'iOS Remastered',
    category: 'Utilidades',
    color: 'linear-gradient(160deg, #34c759, #30b0c7)',
    glyph: <SysGlyph kind="installer" />,
    stars: 4.9,
    size: 1.8,
    installable: true,
    section: 'apps',
    description: 'Instala IPAs desde archivos o URLs.',
  },
  {
    id: 'com.apple.Preferences',
    name: 'Ajustes',
    developer: 'Apple',
    category: 'Utilidades',
    color: 'linear-gradient(160deg, #8e8e93, #48484a)',
    glyph: <SysGlyph kind="settings" />,
    stars: 4.3,
    size: 6.7,
    installable: true,
    section: 'apps',
    description: 'Configura todos los ajustes del sistema.',
  },
];

// Apps ficticias de las secciones de la App Store (para dar vida a la UI)
const FEATURED_APPS = [
  // Hot This Week
  { id: 'x.hot.1', name: 'Threads', developer: 'Meta', category: 'Redes sociales', color: 'linear-gradient(160deg, #1c1c1e, #3a3a3c)', glyph: <SysGlyph kind="notes" />, stars: 4.5, section: 'hot', subtitle: 'Redes sociales', tagline: 'Únete a la conversación' },
  { id: 'x.hot.2', name: 'BeReal', developer: 'BeReal', category: 'Redes sociales', color: 'linear-gradient(160deg, #1c1c1e, #000)', glyph: <SysGlyph kind="photos" />, stars: 4.2, section: 'hot', subtitle: 'Foto y vídeo' },
  { id: 'x.hot.3', name: 'LumaFusion', developer: 'Luma Touch', category: 'Foto y vídeo', color: 'linear-gradient(160deg, #ff375f, #af52de)', glyph: <SysGlyph kind="macho" />, stars: 4.8, section: 'hot' },

  // Level Up Your Socials
  { id: 'x.soc.1', name: 'Instagram', developer: 'Meta', category: 'Redes sociales', color: 'linear-gradient(160deg, #ff2d55, #af52de)', glyph: <SysGlyph kind="photos" />, stars: 4.7, section: 'social' },
  { id: 'x.soc.2', name: 'TikTok', developer: 'ByteDance', category: 'Redes sociales', color: 'linear-gradient(160deg, #000, #1c1c1e)', glyph: <SysGlyph kind="clock" />, stars: 4.6, section: 'social' },
  { id: 'x.soc.3', name: 'Beacons AI', developer: 'Beacons', category: 'Redes sociales', color: 'linear-gradient(160deg, #5e5ce6, #0a84ff)', glyph: <SysGlyph kind="hardware" />, stars: 4.5, section: 'social' },
  { id: 'x.soc.4', name: 'Linktree', developer: 'Linktree', category: 'Redes sociales', color: 'linear-gradient(160deg, #30d158, #34c759)', glyph: <SysGlyph kind="terminal" />, stars: 4.7, section: 'social' },

  // Indie Games We Love
  { id: 'x.g.1', name: 'Stardew Valley', developer: 'ConcernedApe', category: 'Juegos', color: 'linear-gradient(160deg, #34c759, #30b0c7)', glyph: <SysGlyph kind="weather" />, stars: 4.9, section: 'indie', price: '4,99 €' },
  { id: 'x.g.2', name: 'Dead Cells', developer: 'Motion Twin', category: 'Juegos', color: 'linear-gradient(160deg, #ff3b30, #ff9500)', glyph: <SysGlyph kind="hardware" />, stars: 4.8, section: 'indie', price: '8,99 €' },
  { id: 'x.g.3', name: 'Monument Valley 2', developer: 'ustwo games', category: 'Juegos', color: 'linear-gradient(160deg, #ff9500, #ffcc00)', glyph: <SysGlyph kind="clock" />, stars: 4.9, section: 'indie', price: '4,99 €' },

  // Play Well With Others
  { id: 'x.mp.1', name: 'Among Us', developer: 'Innersloth', category: 'Juegos', color: 'linear-gradient(160deg, #ff3b30, #ff2d55)', glyph: <SysGlyph kind="installer" />, stars: 4.5, section: 'multiplayer' },
  { id: 'x.mp.2', name: 'Skribbl', developer: 'Skribbl.io', category: 'Juegos', color: 'linear-gradient(160deg, #5ac8fa, #0a84ff)', glyph: <SysGlyph kind="notes" />, stars: 4.3, section: 'multiplayer' },
  { id: 'x.mp.3', name: 'Jackbox Party', developer: 'Jackbox Games', category: 'Juegos', color: 'linear-gradient(160deg, #af52de, #5e5ce6)', glyph: <SysGlyph kind="terminal" />, stars: 4.6, section: 'multiplayer' },
  { id: 'x.mp.4', name: 'Words With Friends', developer: 'Zynga', category: 'Juegos', color: 'linear-gradient(160deg, #ff9500, #ffcc00)', glyph: <SysGlyph kind="files" />, stars: 4.2, section: 'multiplayer' },

  // That's Entertainment!
  { id: 'x.e.1', name: 'Netflix', developer: 'Netflix, Inc.', category: 'Entretenimiento', color: 'linear-gradient(160deg, #1c1c1e, #000)', glyph: <SysGlyph kind="photos" />, stars: 4.8, section: 'entertainment' },
  { id: 'x.e.2', name: 'Spotify', developer: 'Spotify', category: 'Música', color: 'linear-gradient(160deg, #30d158, #34c759)', glyph: <SysGlyph kind="clock" />, stars: 4.8, section: 'entertainment' },
  { id: 'x.e.3', name: 'Podcasts', developer: 'Apple', category: 'Música', color: 'linear-gradient(160deg, #af52de, #5e5ce6)', glyph: <SysGlyph kind="hardware" />, stars: 4.6, section: 'entertainment' },
  { id: 'x.e.4', name: 'Prime Video', developer: 'Amazon', category: 'Entretenimiento', color: 'linear-gradient(160deg, #5ac8fa, #0a84ff)', glyph: <SysGlyph kind="terminal" />, stars: 4.5, section: 'entertainment' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Componentes
// ─────────────────────────────────────────────────────────────────────────────

/** Icono de app (con tamaño configurable). */
function AppIcon({ app, size = 60, radius = 13 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: app.color || 'linear-gradient(160deg, #5ac8fa, #007aff)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0) 55%)',
          pointerEvents: 'none',
        }}
      />
      {app.glyph}
    </div>
  );
}

/** Botón "OBTENER" / "ABRIR" / progreso. */
function GetButton({ app, installed, installing, progress, onTap }) {
  if (installing) {
    return (
      <div
        style={{
          width: 60,
          height: 28,
          borderRadius: 14,
          background: 'rgba(120,120,128,0.32)',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.2)" strokeWidth="2.5" fill="none" />
          <path d="M12 3 a9 9 0 0 1 9 9" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </svg>
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: 2,
            width: `${progress * 100}%`,
            background: '#0a84ff',
            transition: 'width 200ms linear',
          }}
        />
      </div>
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onTap?.(); }}
      style={{
        height: 28,
        padding: '0 16px',
        borderRadius: 14,
        border: 'none',
        background: installed ? 'rgba(120,120,128,0.32)' : '#0a84ff',
        color: '#fff',
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
        letterSpacing: 0.3,
        fontFamily: 'inherit',
      }}
    >
      {installed ? 'ABRIR' : 'OBTENER'}
    </button>
  );
}

/** Fila de app horizontal (listado). */
function AppRow({ app, installed, installing, progress, onTap }) {
  return (
    <div
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        cursor: 'pointer',
        borderBottom: '0.5px solid rgba(255,255,255,0.08)',
      }}
    >
      <AppIcon app={app} size={56} radius={12} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {app.name}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {app.subtitle || app.category}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
          {app.stars != null && (
            <>
              {I.star('#8e8e93')}
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>{app.stars.toFixed(1)}</span>
            </>
          )}
          {app.price && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginLeft: 8 }}>{app.price}</span>
          )}
        </div>
      </div>
      <GetButton app={app} installed={installed} installing={installing} progress={progress} onTap={onTap} />
    </div>
  );
}

/** Card grande con imagen de fondo (Today, Hot, etc.). */
function FeatureCard({ item, installed, installing, progress, onTap }) {
  return (
    <div
      onClick={onTap}
      style={{
        width: '100%',
        marginBottom: 14,
        borderRadius: 18,
        overflow: 'hidden',
        cursor: 'pointer',
        background: item.color,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        position: 'relative',
      }}
    >
      <div style={{ padding: '16px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 132 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: 'rgba(255,255,255,0.85)', textTransform: 'uppercase' }}>
          {item.subtitle || item.category}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', lineHeight: 1.15, letterSpacing: -0.3 }}>
          {item.name}
        </div>
        {item.tagline && (
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>{item.tagline}</div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>{item.developer}</div>
          <GetButton app={item} installed={installed} installing={installing} progress={progress} onTap={onTap} />
        </div>
      </div>
    </div>
  );
}

/** Sección con título + contenido. */
function Section({ title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ padding: '0 16px 10px' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: -0.3 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Carrusel horizontal. */
function Carousel({ items, renderItem }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        paddingLeft: 16,
        paddingRight: 16,
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {items.map((it) => (
        <div key={it.id} style={{ flexShrink: 0, width: 260 }}>
          {renderItem(it)}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AppStore
 *
 * @param {Object} props
 * @param {Function} [props.onOpenApp]  (bundleId) => void
 * @param {string}   [props.initialTab='today']
 */
export default function AppStore({ onOpenApp, initialTab = 'today' }) {
  const os = useOS();
  const [tab, setTab] = useState(initialTab);
  const [search, setSearch] = useState('');
  const [installing, setInstalling] = useState({}); // { id: progress }
  const [justInstalled, setJustInstalled] = useState({}); // { id: true }

  // ── Apps instaladas actuales ──────────────────────────────────────────────
  const installedIds = useMemo(() => {
    const set = new Set();
    for (const a of registry.all()) set.add(a.id);
    return set;
  }, [os?.snapshot?.apps]);

  // ── Catálogo completo ─────────────────────────────────────────────────────
  const catalog = useMemo(
    () => [...SYSTEM_CATALOG, ...FEATURED_APPS],
    []
  );

  // ── Instalación (registrar en registry) ───────────────────────────────────
  const handleGet = useCallback(async (app) => {
    haptic('light');

    // Si ya está instalada → abrir
    if (installedIds.has(app.id)) {
      onOpenApp?.(app.id);
      return;
    }

    // Simular progreso de descarga + instalación
    const steps = [0.08, 0.22, 0.4, 0.58, 0.75, 0.9, 1.0];
    let i = 0;
    const tick = () => {
      const p = steps[i++];
      setInstalling((prev) => ({ ...prev, [app.id]: p }));
      if (i < steps.length) {
        setTimeout(tick, 180 + Math.random() * 120);
      } else {
        // Registrar en registry
        const def = SYSTEM_CATALOG.find((c) => c.id === app.id);
        if (def) {
          const registryDef = (registry.SYSTEM_APPS || []).find((a) => a.id === app.id);
          if (registryDef) {
            registry.setHidden(app.id, false);
          } else {
            registry.register({
              id: app.id,
              name: app.name,
              glyph: app.glyph,
              color: app.color,
              render: null,
              category: 'other',
              developer: app.developer,
              system: false,
            });
          }
        } else {
          registry.register({
            id: app.id,
            name: app.name,
            glyph: app.glyph,
            color: app.color,
            render: null,
            category: 'other',
            developer: app.developer,
            system: false,
          });
        }

        setInstalling((prev) => {
          const n = { ...prev };
          delete n[app.id];
          return n;
        });
        setJustInstalled((prev) => ({ ...prev, [app.id]: true }));
        haptic('medium');
        try { os?.notify?.({ title: app.name, body: 'App instalada', app: 'App Store' }); } catch {}
        setTimeout(() => {
          setJustInstalled((prev) => {
            const n = { ...prev };
            delete n[app.id];
            return n;
          });
        }, 2400);
      }
    };
    setInstalling((prev) => ({ ...prev, [app.id]: 0.02 }));
    tick();
  }, [installedIds, onOpenApp, os]);

  // ── Búsqueda ──────────────────────────────────────────────────────────────
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return catalog.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.developer.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
    );
  }, [search, catalog]);

  const renderApp = useCallback(
    (app) => (
      <AppRow
        key={app.id}
        app={app}
        installed={installedIds.has(app.id) || justInstalled[app.id]}
        installing={installing[app.id] != null}
        progress={installing[app.id] || 0}
        onTap={() => handleGet(app)}
      />
    ),
    [installedIds, justInstalled, installing, handleGet]
  );

  const renderFeature = useCallback(
    (app) => (
      <FeatureCard
        key={app.id}
        item={app}
        installed={installedIds.has(app.id) || justInstalled[app.id]}
        installing={installing[app.id] != null}
        progress={installing[app.id] || 0}
        onTap={() => handleGet(app)}
      />
    ),
    [installedIds, justInstalled, installing, handleGet]
  );

  // ── Filtros por sección ───────────────────────────────────────────────────
  const bySection = useCallback(
    (s) => catalog.filter((a) => a.section === s),
    [catalog]
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        color: '#fff',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
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
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          position: 'relative',
          zIndex: 5,
          flexShrink: 0,
        }}
      >
        {tab === 'search' ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(120,120,128,0.24)',
              borderRadius: 10,
              padding: '7px 10px',
            }}
          >
            {I.search('rgba(255,255,255,0.5)', 16)}
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar apps y juegos"
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
            {search && (
              <button
                onClick={() => setSearch('')}
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
        ) : (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.4, flex: 1 }}>
              {tab === 'today' ? 'Hoy' : tab === 'games' ? 'Juegos' : tab === 'apps' ? 'Apps' : 'Arcade'}
            </div>
            <button
              onClick={() => setTab('search')}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 8,
                cursor: 'pointer',
                color: '#0a84ff',
                display: 'flex',
              }}
              aria-label="Buscar"
            >
              {I.search('#0a84ff', 20)}
            </button>
          </>
        )}
      </div>

      {/* Contenido scrolleable */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 90 }}>
        {/* ── TODAY ─────────────────────────────────────────────────── */}
        {tab === 'today' && (
          <div style={{ paddingTop: 16 }}>
            <Section title="Hot This Week" subtitle="Catch what's trending on the App Store">
              <Carousel items={bySection('hot')} renderItem={renderFeature} />
            </Section>

            <Section title="Level Up Your Socials" subtitle="Make meaningful connections">
              <Carousel items={bySection('social')} renderItem={renderFeature} />
            </Section>

            <Section title="Editors' Favorites" subtitle="We try every app we recommend">
              <div>{SYSTEM_CATALOG.slice(0, 4).map(renderApp)}</div>
            </Section>

            <Section title="Today's Highlights">
              <div>{SYSTEM_CATALOG.slice(4, 8).map(renderApp)}</div>
            </Section>

            <Section title="Today's In-App Events">
              <Carousel items={bySection('hot')} renderItem={renderFeature} />
            </Section>
          </div>
        )}

        {/* ── GAMES ─────────────────────────────────────────────────── */}
        {tab === 'games' && (
          <div style={{ paddingTop: 16 }}>
            <Section title="Hot This Week">
              <Carousel items={bySection('hot')} renderItem={renderFeature} />
            </Section>

            <Section title="Indie Games We Love" subtitle="Small developers, big fun">
              <div>{bySection('indie').map(renderApp)}</div>
            </Section>

            <Section title="Play Well With Others">
              <Carousel items={bySection('multiplayer')} renderItem={renderFeature} />
            </Section>
          </div>
        )}

        {/* ── APPS ──────────────────────────────────────────────────── */}
        {tab === 'apps' && (
          <div style={{ paddingTop: 16 }}>
            <Section title="Level Up Your Socials">
              <Carousel items={bySection('social')} renderItem={renderFeature} />
            </Section>

            <Section title="Apps del sistema" subtitle="Ya disponibles en iOS Remastered">
              <div>{SYSTEM_CATALOG.map(renderApp)}</div>
            </Section>

            <Section title="That's Entertainment!" subtitle="Movies, podcasts, and more">
              <Carousel items={bySection('entertainment')} renderItem={renderFeature} />
            </Section>
          </div>
        )}

        {/* ── ARCADE ────────────────────────────────────────────────── */}
        {tab === 'arcade' && (
          <div style={{ paddingTop: 16 }}>
            <Section title="Juegos Arcade" subtitle="Sin anuncios. Sin compras dentro de la app.">
              <div>{bySection('indie').map(renderApp)}</div>
            </Section>
            <Section title="Próximamente">
              <Carousel items={bySection('multiplayer')} renderItem={renderFeature} />
            </Section>
          </div>
        )}

        {/* ── SEARCH ────────────────────────────────────────────────── */}
        {tab === 'search' && (
          <div style={{ paddingTop: 16 }}>
            {search.trim() === '' ? (
              <Section title="Buscar" subtitle="Escribe para encontrar apps y juegos">
                <div>{SYSTEM_CATALOG.slice(0, 6).map(renderApp)}</div>
              </Section>
            ) : (
              <Section title={`${searchResults.length} resultados`}>
                {searchResults.length === 0 ? (
                  <div style={{ padding: 16, color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center' }}>
                    Sin resultados
                  </div>
                ) : (
                  <div>{searchResults.map(renderApp)}</div>
                )}
              </Section>
            )}
          </div>
        )}
      </div>

      {/* Tab bar inferior */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 84,
          background: 'rgba(20,20,22,0.92)',
          backdropFilter: 'blur(34px) saturate(180%)',
          WebkitBackdropFilter: 'blur(34px) saturate(180%)',
          borderTop: '0.5px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-around',
          paddingTop: 8,
          paddingBottom: 26,
          zIndex: 10,
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          const color = active ? '#0a84ff' : 'rgba(255,255,255,0.5)';
          return (
            <button
              key={t.id}
              onClick={() => { haptic('light'); setTab(t.id); }}
              style={{
                background: 'transparent',
                border: 'none',
                color,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                cursor: 'pointer',
                padding: '4px 8px',
                flex: 1,
                maxWidth: 72,
              }}
            >
              {I[t.icon](color, 22)}
              <span style={{ fontSize: 10, fontWeight: 500, color }}>{t.label}</span>
            </button>
          );
        })}
      </div>

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

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32 };
    navigator.vibrate(map[pattern] || 8);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar App Store en el registry (auto-registro al importar)
// ─────────────────────────────────────────────────────────────────────────────

try {
  if (registry && !registry.get('com.apple.AppStore')) {
    registry.register({
      id: 'com.apple.AppStore',
      name: 'App Store',
      glyph: (
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
          <path d="M12 3 L14 9 L20 9 L15 13 L17 19 L12 15 L7 19 L9 13 L4 9 L10 9 Z" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinejoin="round"/>
        </svg>
      ),
      color: 'linear-gradient(160deg, #0a84ff, #5ac8fa)',
      render: (props) => <AppStore {...props} />,
      category: 'system',
      developer: 'Apple',
      system: true,
      statusBarTheme: 'light',
    });
  }
} catch { /* registro opcional */ }
