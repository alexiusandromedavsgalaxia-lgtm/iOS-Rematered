// src/ui/Blur.jsx
// rainOS Mobile — resilient blur primitive.
// Exports BOTH named and default Blur plus blurStyle compatibility.
import React from 'react';

export const BLUR_PRESETS = {
  dock: { blur: 34, saturation: 180 },
  notification: { blur: 30, saturation: 180 },
  popover: { blur: 40, saturation: 200 },
  systemMaterial: { blur: 24, saturation: 180 },
  thinMaterial: { blur: 12, saturation: 150 },
  thickMaterial: { blur: 40, saturation: 180 },
};

function resolveStyle({ material = 'systemMaterial', preset, blur, saturation, tint, opacity = 1, style = {} } = {}) {
  const p = BLUR_PRESETS[preset || material] || BLUR_PRESETS.systemMaterial;
  const b = blur ?? p.blur;
  const s = saturation ?? p.saturation;
  return {
    backdropFilter: `blur(${b}px) saturate(${s}%)`,
    WebkitBackdropFilter: `blur(${b}px) saturate(${s}%)`,
    background: tint || `rgba(255,255,255,${Math.max(0, Math.min(1, opacity * 0.12))})`,
    ...style,
  };
}

export function blurStyle(opts = {}) {
  return resolveStyle(opts);
}

export function Blur({
  material = 'systemMaterial',
  preset,
  blur,
  saturation,
  tint,
  opacity = 1,
  className = '',
  style = {},
  children,
  as: Component = 'div',
  ...props
}) {
  return (
    <Component className={className} style={resolveStyle({ material, preset, blur, saturation, tint, opacity, style })} {...props}>
      {children}
    </Component>
  );
}

export const BlurOverlay = Blur;
export default Blur;
