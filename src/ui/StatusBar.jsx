// src/ui/StatusBar.jsx
// rainOS Mobile — resilient iOS-style status bar.
// Exports BOTH named and default StatusBar for compatibility.
import React, { useEffect, useState } from 'react';

function formatTime(date, use24h = false, showSeconds = false) {
  let h = date.getHours();
  if (!use24h) h = h % 12 || 12;
  const value = `${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return showSeconds ? `${value}:${String(date.getSeconds()).padStart(2, '0')}` : value;
}

function Battery({ level = 100, charging = false }) {
  const pct = Math.max(0, Math.min(100, Number(level) || 0));
  return (
    <span className="statusbar-battery" aria-label={`Batería ${Math.round(pct)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{ position: 'relative', display: 'inline-block', width: 24, height: 11, border: '1px solid currentColor', borderRadius: 3, opacity: 0.9 }}>
        <span style={{ position: 'absolute', left: 2, top: 2, bottom: 2, width: `${Math.max(1, pct * 0.2)}px`, maxWidth: 19, borderRadius: 1.5, background: charging ? '#34c759' : pct <= 20 ? '#ff3b30' : 'currentColor' }} />
      </span>
      <span style={{ fontSize: 11 }}>{Math.round(pct)}%</span>
    </span>
  );
}

export function StatusBar({
  theme = 'auto',
  wallpaper,
  use24h = false,
  showSeconds = false,
  hidden = false,
  opacity = 1,
  compact = false,
  battery = 100,
  batteryLevel,
  charging = false,
  wifi = true,
  wifiLevel = 3,
  cellular = true,
  cellularLevel = 4,
  airplane = false,
  bluetooth = false,
  hotspot = false,
  vpn = false,
  location = false,
  recording = false,
  call = false,
  alarm = false,
  rotationLock = false,
  airplay = false,
  operator = '',
  className = '',
  style = {},
  ...props
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), showSeconds ? 1000 : 30000);
    return () => clearInterval(id);
  }, [showSeconds]);

  if (hidden) return null;
  const dark = theme === 'dark' || (theme === 'auto' && !wallpaper);
  const fg = dark ? '#fff' : '#000';
  const dim = dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.6)';
  const level = batteryLevel ?? battery;
  const indicators = [
    location && '⌖', recording && '●', call && '☎', hotspot && '⌁', vpn && 'VPN', alarm && '◷',
    rotationLock && '↻', bluetooth && 'ᛒ', airplay && '⌁',
  ].filter(Boolean);

  return (
    <div
      className={`status-bar ${compact ? 'status-bar--compact' : ''} ${className}`.trim()}
      style={{ color: fg, opacity, position: 'absolute', top: 0, left: 0, right: 0, height: 54, zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '0 18px 8px', boxSizing: 'border-box', pointerEvents: 'none', ...style }}
      {...props}
    >
      <span className="status-bar__time" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 15 }}>{formatTime(now, use24h, showSeconds)}</span>
      <span className="status-bar__indicators" style={{ display: 'flex', alignItems: 'center', gap: 5, color: dim, fontSize: 11 }}>
        {indicators.map((item, i) => <span key={`${item}-${i}`}>{item}</span>)}
      </span>
      <span className="status-bar__right" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
        {operator ? <span style={{ opacity: .8 }}>{operator}</span> : null}
        {airplane ? <span aria-label="Modo avión">✈</span> : null}
        {!airplane && cellular ? <span aria-label="Señal celular">▮▮▮▮</span> : null}
        {!airplane && wifi ? <span aria-label="WiFi" style={{ opacity: Math.max(.35, wifiLevel / 3) }}>⌁</span> : null}
        <Battery level={level} charging={charging} />
      </span>
    </div>
  );
}

export default StatusBar;
