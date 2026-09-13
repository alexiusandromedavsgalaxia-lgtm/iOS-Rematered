// src/ui/Icon.jsx
// rainOS Mobile — unified icon component
// Exports BOTH named and default Icon so every importer style is supported.
import React from 'react';

const PATHS = {
  plus: ['M12 5V19', 'M5 12H19'],
  minus: ['M5 12H19'],
  close: ['M6 6L18 18', 'M18 6L6 18'],
  xmark: ['M6 6L18 18', 'M18 6L6 18'],
  check: ['M4 12L9 17L20 6'],
  'checkmark.circle': ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M7 12l3 3 7-7'],
  'checkmark.circle.fill': ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M7 12l3 3 7-7'],
  'plus.circle': ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M12 7v10', 'M7 12h10'],
  'minus.circle': ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M7 12h10'],
  'chevron.up': ['M6 15l6-6 6 6'],
  'chevron.down': ['M6 9l6 6 6-6'],
  'chevron.left': ['M15 6l-6 6 6 6'],
  'chevron.right': ['M9 6l6 6-6 6'],
  'arrow.up': ['M12 19V5', 'M5 12l7-7 7 7'],
  'arrow.down': ['M12 5v14', 'M5 12l7 7 7-7'],
  'arrow.left': ['M19 12H5', 'M12 5l-7 7 7 7'],
  'arrow.right': ['M5 12h14', 'M12 5l7 7-7 7'],
  'arrow.down.circle': ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M12 7v10', 'M7 12l5 5 5-5'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14', 'M16 16l5 5'],
  menu: ['M4 7H20', 'M4 12H20', 'M4 17H20'],
  'more.horizontal': ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  'more.vertical': ['M12 6h.01', 'M12 12h.01', 'M12 18h.01'],
  wifi: ['M3 9a13 13 0 0 1 18 0', 'M6 13a9 9 0 0 1 12 0', 'M9 17a5 5 0 0 1 6 0', 'M12 20h.01'],
  bluetooth: ['M12 3v18', 'M7 7l10 10-5 4V3l5 4L7 17'],
  battery: ['M3 7h17v10H3z', 'M20 10h2v4h-2'],
  'battery.100': ['M3 7h17v10H3z', 'M20 10h2v4h-2', 'M5 9h13v6H5z'],
  camera: ['M4 7h4l2-2h4l2 2h4v12H4z', 'M12 10a3 3 0 1 0 0 6a3 3 0 0 0 0-6'],
  phone: ['M6 3l4 1 2 5-3 2a12 12 0 0 0 4 4l2-3 5 2 1 4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z'],
  lock: ['M6 10h12v11H6z', 'M9 10V7a3 3 0 0 1 6 0v3'],
  unlock: ['M6 10h12v11H6z', 'M9 10V7a3 3 0 0 1 5-2'],
  info: ['M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20', 'M12 10v6', 'M12 7h.01'],
  warning: ['M12 3L2 21h20L12 3z', 'M12 9v5', 'M12 17h.01'],
  error: ['M12 3L2 21h20L12 3z', 'M8 9l8 8', 'M16 9l-8 8'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
  heart: ['M20 8c0 6-8 11-8 11S4 14 4 8a4 4 0 0 1 7-3 4 4 0 0 1 9 3z'],
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3z'],
  'doc.on.clipboard': ['M8 4h9v16H5V7z', 'M8 4V2h8v2', 'M8 12h6', 'M8 16h6'],
  'lock.shield': ['M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z', 'M9 12l2 2 4-4'],
  faceid: ['M4 8V5a2 2 0 0 1 2-2h3', 'M20 8V5a2 2 0 0 0-2-2h-3', 'M4 16v3a2 2 0 0 0 2 2h3', 'M20 16v3a2 2 0 0 1-2 2h-3', 'M9 10h.01', 'M15 10h.01', 'M9 15a4 4 0 0 0 6 0'],
};

function normalizeName(name) {
  if (!name) return 'info';
  if (PATHS[name]) return name;
  const aliases = {
    'chevron-up': 'chevron.up', 'chevron-down': 'chevron.down',
    'chevron-left': 'chevron.left', 'chevron-right': 'chevron.right',
    'arrow-up': 'arrow.up', 'arrow-down': 'arrow.down',
    'arrow-left': 'arrow.left', 'arrow-right': 'arrow.right',
    'plus.circle.fill': 'plus.circle', 'minus.circle.fill': 'minus.circle',
    'questionmark.circle': 'info', 'questionmark.circle.fill': 'info',
    'exclamationmark.triangle': 'warning', 'exclamationmark.triangle.fill': 'warning',
    'xmark.circle': 'close', 'xmark.circle.fill': 'close',
    'doc': 'doc.on.clipboard', 'document': 'doc.on.clipboard',
    'lock.fill': 'lock', 'lock.shield.fill': 'lock.shield',
    'square.grid.3x3': 'menu', 'antenna.radiowaves': 'wifi',
    display: 'menu', cpu: 'menu', 'battery.50': 'battery',
  };
  return aliases[name] || 'info';
}

export function Icon({
  name,
  size = 24,
  color = 'currentColor',
  weight = 2,
  filled = false,
  className,
  style,
  title,
  linecap = 'round',
  linejoin = 'round',
  ...props
}) {
  const paths = PATHS[normalizeName(name)] || PATHS.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      xmlns="http://www.w3.org/2000/svg" className={className}
      style={{ display: 'inline-block', flexShrink: 0, ...style }}
      aria-hidden={title ? undefined : true} aria-label={title} {...props}>
      {title ? <title>{title}</title> : null}
      {paths.map((d, i) => (
        <path key={i} d={d} stroke={color} strokeWidth={weight}
          strokeLinecap={linecap} strokeLinejoin={linejoin}
          fill={filled ? color : 'none'} />
      ))}
    </svg>
  );
}

export default Icon;
