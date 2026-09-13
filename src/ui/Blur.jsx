// src/ui/Blur.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Blur
//
// Sistema de materiales difuminados estilo iOS. iOS define 5 "materiales"
// (thinMaterial, regularMaterial…) que se aplican a sheets, docks, banners,
// barras de navegación, y overlays. Este componente los replica con
// backdrop-filter + fallbacks a fondo sólido cuando el navegador no lo soporta.
//
// Materiales iOS:
//   • systemUltraThinMaterial  — el más translúcido (casi cristal)
//   • systemThinMaterial       — usado en tab bars, toolbars
//   • systemMaterial           — usado en sheets, popovers
//   • systemThickMaterial      — usado en modales de fondo
//   • systemChromeMaterial     — usado en navigation bars
//   • systemUltraThinMaterialLight / Dark — variantes forzadas de tema
//
// API:
//   <Blur material="systemThinMaterial" />
//   <Blur blur={38} saturation={180} tint="rgba(255,255,255,0.16)" />
//   <Blur preset="dock" />
//
// Presets:
//   • dock            → blur(34px) saturate(180%) + borde 0.5px
//   • sheet           → blur(38px) saturate(180%)
//   • navigationBar   → blur(20px) saturate(180%)
//   • controlCenter   → blur(38px) saturate(180%) + tinte oscuro
//   • notification    → blur(30px) saturate(180%)
//   • popover         → blur(40px) saturate(200%)
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Definición de materiales iOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materiales en modo oscuro. Cada uno tiene:
 *   blur: px de blur
 *   saturation: %
 *   tint: color base con alpha (se compone encima del blur)
 *   border: borde opcional 0.5px
 *   fallback: color sólido si no hay backdrop-filter
 */
const MATERIALS_DARK = {
  systemUltraThinMaterial: {
    blur: 24,
    saturation: 200,
    tint: 'rgba(120,120,128,0.16)',
    border: '0.5px solid rgba(255,255,255,0.1)',
    fallback: 'rgba(28,28,30,0.85)',
  },
  systemThinMaterial: {
    blur: 30,
    saturation: 180,
    tint: 'rgba(120,120,128,0.24)',
    border: '0.5px solid rgba(255,255,255,0.12)',
    fallback: 'rgba(36,36,38,0.88)',
  },
  systemMaterial: {
    blur: 38,
    saturation: 180,
    tint: 'rgba(120,120,128,0.32)',
    border: '0.5px solid rgba(255,255,255,0.14)',
    fallback: 'rgba(44,44,46,0.92)',
  },
  systemThickMaterial: {
    blur: 44,
    saturation: 170,
    tint: 'rgba(120,120,128,0.42)',
    border: '0.5px solid rgba(255,255,255,0.16)',
    fallback: 'rgba(52,52,54,0.95)',
  },
  systemChromeMaterial: {
    blur: 20,
    saturation: 180,
    tint: 'rgba(20,20,22,0.55)',
    border: '0.5px solid rgba(255,255,255,0.08)',
    fallback: 'rgba(20,20,22,0.92)',
  },
};

/** Materiales en modo claro. */
const MATERIALS_LIGHT = {
  systemUltraThinMaterial: {
    blur: 24,
    saturation: 200,
    tint: 'rgba(255,255,255,0.42)',
    border: '0.5px solid rgba(0,0,0,0.06)',
    fallback: 'rgba(242,242,247,0.9)',
  },
  systemThinMaterial: {
    blur: 30,
    saturation: 180,
    tint: 'rgba(255,255,255,0.55)',
    border: '0.5px solid rgba(0,0,0,0.08)',
    fallback: 'rgba(242,242,247,0.94)',
  },
  systemMaterial: {
    blur: 38,
    saturation: 180,
    tint: 'rgba(255,255,255,0.68)',
    border: '0.5px solid rgba(0,0,0,0.1)',
    fallback: 'rgba(255,255,255,0.96)',
  },
  systemThickMaterial: {
    blur: 44,
    saturation: 170,
    tint: 'rgba(255,255,255,0.78)',
    border: '0.5px solid rgba(0,0,0,0.12)',
    fallback: 'rgba(255,255,255,0.98)',
  },
  systemChromeMaterial: {
    blur: 20,
    saturation: 180,
    tint: 'rgba(255,255,255,0.7)',
    border: '0.5px solid rgba(0,0,0,0.08)',
    fallback: 'rgba(249,249,249,0.94)',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Presets de uso común
// ─────────────────────────────────────────────────────────────────────────────

export const BLUR_PRESETS = {
  dock: {
    blur: 34,
    saturation: 180,
    tint: 'rgba(120,120,128,0.24)',
    border: '0.5px solid rgba(255,255,255,0.16)',
    fallback: 'rgba(30,30,32,0.85)',
    radius: 34,
  },
  sheet: {
    blur: 38,
    saturation: 180,
    tint: 'rgba(28,28,30,0.5)',
    border: '0.5px solid rgba(255,255,255,0.08)',
    fallback: 'rgba(28,28,30,0.95)',
    radius: 44,
  },
  navigationBar: {
    blur: 20,
    saturation: 180,
    tint: 'rgba(20,20,22,0.6)',
    border: 'none',
    fallback: 'rgba(20,20,22,0.92)',
  },
  controlCenter: {
    blur: 38,
    saturation: 180,
    tint: 'rgba(30,30,35,0.35)',
    border: 'none',
    fallback: 'rgba(30,30,35,0.9)',
  },
  notification: {
    blur: 30,
    saturation: 180,
    tint: 'rgba(120,120,128,0.42)',
    border: 'none',
    fallback: 'rgba(40,40,42,0.92)',
    radius: 20,
  },
  popover: {
    blur: 40,
    saturation: 200,
    tint: 'rgba(60,60,65,0.55)',
    border: '0.5px solid rgba(255,255,255,0.12)',
    fallback: 'rgba(50,50,54,0.95)',
    radius: 18,
  },
  lockScreen: {
    blur: 0,
    saturation: 100,
    tint: 'rgba(0,0,0,0.35)',
    border: 'none',
    fallback: 'rgba(0,0,0,0.35)',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Detección de soporte de backdrop-filter
// ─────────────────────────────────────────────────────────────────────────────

let _supportsBackdrop = null;

function supportsBackdropFilter() {
  if (_supportsBackdrop !== null) return _supportsBackdrop;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    _supportsBackdrop = false;
    return _supportsBackdrop;
  }
  try {
    const el = document.createElement('div');
    el.style.backdropFilter = 'blur(1px)';
    _supportsBackdrop =
      el.style.backdropFilter === 'blur(1px)' ||
      el.style.WebkitBackdropFilter === 'blur(1px)';
  } catch {
    _supportsBackdrop = false;
  }
  return _supportsBackdrop;
}

/** Hook: ¿el navegador soporta backdrop-filter? */
export function useBackdropFilterSupport() {
  const [ok, setOk] = useState(() => supportsBackdropFilter());
  useEffect(() => {
    setOk(supportsBackdropFilter());
  }, []);
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolución de estilo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.material]           Nombre del material iOS
 * @param {string} [opts.preset]             Nombre de un preset
 * @param {number} [opts.blur]               px de blur (override)
 * @param {number} [opts.saturation]         % saturación (override)
 * @param {string} [opts.tint]               color de tinte (override)
 * @param {string} [opts.border]             borde CSS (override)
 * @param {string} [opts.fallback]           color sólido (override)
 * @param {number} [opts.radius]             border-radius (override)
 * @param {'light'|'dark'} [opts.scheme]     tema
 * @param {boolean} [opts.forceBlur]         forzar blur aunque no esté soportado
 */
function resolveStyle(opts) {
  const {
    material,
    preset,
    blur,
    saturation,
    tint,
    border,
    fallback,
    radius,
    scheme = 'dark',
    forceBlur = false,
  } = opts;

  const palette = scheme === 'light' ? MATERIALS_LIGHT : MATERIALS_DARK;
  let base = null;

  if (preset && BLUR_PRESETS[preset]) {
    base = BLUR_PRESETS[preset];
  } else if (material && palette[material]) {
    base = palette[material];
  } else {
    // Default: systemMaterial
    base = palette.systemMaterial;
  }

  const b = blur ?? base.blur ?? 30;
  const s = saturation ?? base.saturation ?? 180;
  const t = tint ?? base.tint ?? 'rgba(120,120,128,0.32)';
  const bd = border ?? base.border ?? 'none';
  const fb = fallback ?? base.fallback ?? 'rgba(30,30,32,0.9)';
  const r = radius ?? base.radius;

  const supported = forceBlur || supportsBackdropFilter();

  const style = {
    background: t,
    border: bd,
    borderRadius: r,
    WebkitBackdropFilter: supported ? `blur(${b}px) saturate(${s}%)` : undefined,
    backdropFilter: supported ? `blur(${b}px) saturate(${s}%)` : undefined,
  };

  if (!supported) {
    // Fallback: fondo sólido sin blur
    style.background = fb;
  }

  return style;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blur
 *
 * @param {Object} props
 * @param {string}  [props.material='systemMaterial']  Material iOS
 * @param {string}  [props.preset]                     Preset que sobreescribe material
 * @param {number}  [props.blur]                       Override blur px
 * @param {number}  [props.saturation]                 Override saturación %
 * @param {string}  [props.tint]                       Override color de tinte
 * @param {string}  [props.border]                     Override borde
 * @param {string}  [props.fallback]                   Override fallback sólido
 * @param {number}  [props.radius]                     Override border-radius
 * @param {'light'|'dark'} [props.scheme='dark']       Tema
 * @param {boolean} [props.forceBlur=false]            Forzar blur aunque no esté soportado
 * @param {boolean} [props.fullscreen=false]           position absolute inset 0
 * @param {string}  [props.as='div']                   Tag HTML
 * @param {React.ReactNode} [props.children]
 * @param {Object}  [props.style]                      Estilos extra
 * @param {string}  [props.className]
 */
export default function Blur({
  material = 'systemMaterial',
  preset,
  blur,
  saturation,
  tint,
  border,
  fallback,
  radius,
  scheme = 'dark',
  forceBlur = false,
  fullscreen = false,
  as: Tag = 'div',
  children,
  style,
  className,
  ...rest
}) {
  const resolved = useMemo(
    () =>
      resolveStyle({
        material,
        preset,
        blur,
        saturation,
        tint,
        border,
        fallback,
        radius,
        scheme,
        forceBlur,
      }),
    [material, preset, blur, saturation, tint, border, fallback, radius, scheme, forceBlur]
  );

  const finalStyle = {
    ...resolved,
    ...(fullscreen
      ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
      : null),
    ...style,
  };

  return (
    <Tag className={className} style={finalStyle} {...rest}>
      {children}
    </Tag>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variantes específicas (azúcar sintáctico)
// ─────────────────────────────────────────────────────────────────────────────

/** Material ultra fino — para overlays casi transparentes. */
export function UltraThinBlur(props) {
  return <Blur {...props} material="systemUltraThinMaterial" />;
}

/** Material fino — tab bars, toolbars. */
export function ThinBlur(props) {
  return <Blur {...props} material="systemThinMaterial" />;
}

/** Material regular — sheets, popovers. */
export function RegularBlur(props) {
  return <Blur {...props} material="systemMaterial" />;
}

/** Material grueso — modales de fondo. */
export function ThickBlur(props) {
  return <Blur {...props} material="systemThickMaterial" />;
}

/** Material chrome — navigation bars, status bars. */
export function ChromeBlur(props) {
  return <Blur {...props} material="systemChromeMaterial" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blur absoluto (cubre un contenedor padre)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BlurOverlay — cubre completamente el contenedor padre con un material.
 * Útil para modales, popovers, y menús contextuales.
 */
export function BlurOverlay({
  material = 'systemMaterial',
  scheme = 'dark',
  opacity = 1,
  onClick,
  zIndex = 100,
  children,
  style,
  ...rest
}) {
  return (
    <Blur
      material={material}
      scheme={scheme}
      fullscreen
      onClick={onClick}
      style={{
        zIndex,
        opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
      {...rest}
    >
      {children}
    </Blur>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Blur con degradado (para transiciones hacia transparente)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BlurGradient — aplica un blur que se desvanece hacia abajo.
 * Ideal para el "fade" del contenido al hacer scroll bajo una nav bar.
 */
export function BlurGradient({
  material = 'systemChromeMaterial',
  scheme = 'dark',
  direction = 'to bottom',
  height = 80,
  style,
  ...rest
}) {
  const resolved = resolveStyle({ material, scheme });
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height,
        zIndex: 10,
        pointerEvents: 'none',
        ...resolved,
        // Máscara que desvanece el blur de opaco a transparente
        maskImage: `linear-gradient(${direction}, black 0%, black 40%, transparent 100%)`,
        WebkitMaskImage: `linear-gradient(${direction}, black 0%, black 40%, transparent 100%)`,
        ...style,
      }}
      {...rest}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: valor de blur reactivo al scroll
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useScrollBlur — devuelve la intensidad de blur (0..1) según el scroll de un
 * contenedor. Útil para nav bars que aparecen al hacer scroll.
 *
 * @param {React.RefObject} ref     Ref al contenedor con scroll
 * @param {number} [threshold=60]   px de scroll donde el blur llega a 1
 * @returns {number}  Valor 0..1
 */
export function useScrollBlur(ref, threshold = 60) {
  const [intensity, setIntensity] = useState(0);
  useEffect(() => {
    const el = ref?.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = el.scrollTop || 0;
        setIntensity(Math.min(1, y / threshold));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, threshold]);
  return intensity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidad de estilo (para usar fuera de React)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve el objeto style con blur aplicado. Útil para inyectar en componentes
 * que no usan <Blur> directamente.
 */
export function blurStyle(opts = {}) {
  return resolveStyle(opts);
}

/**
 * Lista los materiales disponibles.
 */
export function listMaterials() {
  return Object.keys(MATERIALS_DARK);
}

/**
 * Lista los presets disponibles.
 */
export function listPresets() {
  return Object.keys(BLUR_PRESETS);
}
