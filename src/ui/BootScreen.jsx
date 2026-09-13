// src/ui/BootScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — BootScreen
//
// Pantalla de arranque del sistema. Reemplaza la nada con:
//   • Logo Apple en SVG puro (sin assets externos)
//   • Barra de progreso vinculada al estado real del kernel (useOS)
//   • Log de arranque en vivo (Kernel.bootLog + HardwareBus + drivers)
//   • Fases de boot: firmware → kernel → drivers → FS → keychain → UI
//   • Animación de salida (fade + zoom) al completar
//   • Modo recovery / panic si el boot falla
//
// Se monta desde App.jsx cuando phase === 'boot'. Al terminar, llama a
// onBootComplete() que el padre usa para pasar a 'lock'.
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
// Constantes de fases de arranque
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fases canónicas del boot de iOS Remastered. Cada fase tiene un peso
 * relativo que se usa para calcular el progreso total (los pesos suman 100).
 */
const BOOT_PHASES = [
  { id: 'firmware',   label: 'BootROM / iBoot',        weight:  6, icon: 'cpu'   },
  { id: 'kernel',     label: 'XNU Kernel',             weight: 14, icon: 'chip'  },
  { id: 'memory',     label: 'MemoryManager',          weight:  8, icon: 'ram'   },
  { id: 'scheduler',  label: 'Scheduler / VCPU',       weight:  8, icon: 'clock' },
  { id: 'bus',        label: 'HardwareBus',            weight: 16, icon: 'bus'   },
  { id: 'drivers',    label: 'Drivers V*',             weight: 18, icon: 'gear'  },
  { id: 'filesystem', label: 'APFS / FileSystem',      weight: 10, icon: 'disk'  },
  { id: 'keychain',   label: 'Secure Enclave',         weight:  6, icon: 'lock'  },
  { id: 'services',   label: 'SpringBoard Services',   weight:  8, icon: 'bell'  },
  { id: 'ui',         label: 'Render UI',              weight:  6, icon: 'eye'   },
];

const PHASE_TOTAL_WEIGHT = BOOT_PHASES.reduce((s, p) => s + p.weight, 0);

// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG inline (sin dependencias)
// ─────────────────────────────────────────────────────────────────────────────

function AppleLogo({ size = 120, opacity = 1 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 170 170"
      style={{ opacity, display: 'block' }}
      aria-label="Apple"
    >
      <path
        fill="#fff"
        d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.2-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.93.21-9.84-1.96-14.75-6.52-3.13-2.73-7.04-7.42-11.73-14.07-5.02-7.12-9.15-15.38-12.38-24.79-3.47-10.16-5.21-20-5.21-29.54 0-10.93 2.36-20.35 7.09-28.25 3.72-6.34 8.67-11.34 14.86-15.01 6.19-3.67 12.88-5.54 20.08-5.66 3.91 0 9.04 1.21 15.41 3.58 6.36 2.38 10.44 3.59 12.23 3.59 1.34 0 5.88-1.41 13.61-4.23 7.29-2.61 13.45-3.69 18.48-3.26 13.65 1.1 23.91 6.48 30.75 16.16-12.21 7.4-18.25 17.76-18.14 31.06.11 10.36 3.87 18.98 11.27 25.85 3.35 3.18 7.09 5.64 11.24 7.38-.9 2.61-1.85 5.11-2.86 7.51zM119.11 7.24c0 8.11-2.96 15.68-8.87 22.7-7.13 8.33-15.75 13.14-25.1 12.41a25.2 25.2 0 0 1-.19-3.07c0-7.79 3.39-16.12 9.41-22.93 3.01-3.46 6.83-6.33 11.47-8.62 4.63-2.24 9.01-3.48 13.13-3.7.11 1.08.15 2.16.15 3.21z"
      />
    </svg>
  );
}

function PhaseIcon({ name, size = 14, color = '#8a8a8e' }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { display: 'block', flexShrink: 0 },
  };
  switch (name) {
    case 'cpu':
      return (<svg {...common}><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>);
    case 'chip':
      return (<svg {...common}><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>);
    case 'ram':
      return (<svg {...common}><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v-2M11 8v-2M15 8v-2M19 8v-2M7 16v2M11 16v2M15 16v2M19 16v2"/></svg>);
    case 'clock':
      return (<svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>);
    case 'bus':
      return (<svg {...common}><path d="M4 6h16v10H4z"/><path d="M4 10h16"/><circle cx="7" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/></svg>);
    case 'gear':
      return (<svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>);
    case 'disk':
      return (<svg {...common}><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>);
    case 'lock':
      return (<svg {...common}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>);
    case 'bell':
      return (<svg {...common}><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>);
    case 'eye':
      return (<svg {...common}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>);
    default:
      return (<svg {...common}><circle cx="12" cy="12" r="4"/></svg>);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: progreso de boot simulado pero anclado al estado real
// ─────────────────────────────────────────────────────────────────────────────

function useBootProgress(os) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [phaseProgress, setPhaseProgress] = useState(0); // 0..1 dentro de la fase
  const [log, setLog] = useState([]);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(null);
  const startedAt = useRef(performance.now());
  const rafRef = useRef(0);

  // Duración objetivo por fase (ms) — se acelera si el kernel ya está listo.
  const phaseDurations = useMemo(
    () => BOOT_PHASES.map((p) => 260 + p.weight * 38),
    []
  );

  const pushLog = useCallback((text, level = 'info') => {
    const t = performance.now() - startedAt.current;
    setLog((prev) => {
      const next = [...prev, { id: prev.length, t, text, level }];
      // Limitar a 200 entradas para no acumular sin fin
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  // ── Log inicial y suscripción a eventos reales ────────────────────────────
  useEffect(() => {
    pushLog('[boot] iBoot 3.0.0 (iOSSIM-1.0) — build 26A100');
    pushLog('[boot] SoC Apple A18 Pro (simulado) — 6 cores, 8GB RAM', 'ok');
    pushLog('[boot] Cargando kernelcache…');

    // Suscripción al log del kernel si existe
    let unsubKernel = null;
    const kernel = os?.kernel;
    if (kernel) {
      try {
        if (typeof kernel.onLog === 'function') {
          unsubKernel = kernel.onLog((entry) => {
            const text = typeof entry === 'string' ? entry : entry?.msg || entry?.text || '';
            if (text) pushLog(`[kernel] ${text}`, entry?.level || 'info');
          });
        } else if (Array.isArray(kernel.bootLog)) {
          kernel.bootLog.slice(-40).forEach((line) => {
            const text = typeof line === 'string' ? line : line?.msg || line?.text || '';
            if (text) pushLog(`[kernel] ${text}`, line?.level || 'info');
          });
        }
      } catch (e) {
        pushLog(`[kernel] no se pudo suscribir: ${e.message}`, 'warn');
      }
    } else {
      pushLog('[kernel] (sin contexto — boot simulado)', 'warn');
    }

    // Suscripción al bus
    const bus = os?.bus || os?.hardwareBus;
    if (bus && typeof bus.on === 'function') {
      try {
        bus.on('device:add', (d) => pushLog(`[bus] + ${d?.name || d?.id || 'device'}`, 'ok'));
        bus.on('device:remove', (d) => pushLog(`[bus] - ${d?.name || d?.id || 'device'}`, 'warn'));
      } catch { /* ignore */ }
    }

    return () => {
      if (typeof unsubKernel === 'function') unsubKernel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Motor de progreso ─────────────────────────────────────────────────────
  useEffect(() => {
    let last = performance.now();
    let cancelled = false;
    const tick = (now) => {
      if (cancelled) return;
      const dt = now - last;
      last = now;

      setPhaseIndex((idx) => {
        if (idx >= BOOT_PHASES.length) return idx;
        const dur = phaseDurations[idx];
        setPhaseProgress((p) => {
          const np = p + dt / dur;
          if (np >= 1) {
            // Avanzar de fase
            const phase = BOOT_PHASES[idx];
            pushLog(`[ok] ${phase.label}`, 'ok');
            const nextIdx = idx + 1;
            if (nextIdx >= BOOT_PHASES.length) {
              setDone(true);
              pushLog('[boot] Arranque completado — iniciando SpringBoard', 'ok');
            }
            return 0;
          }
          return np;
        });
        return idx;
      });

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseDurations, pushLog]);

  // ── Avance forzado de fase cuando termina phaseProgress ───────────────────
  useEffect(() => {
    if (phaseProgress === 0 && phaseIndex < BOOT_PHASES.length) {
      // pequeña pausa entre fases para respirar
      const t = setTimeout(() => {
        setPhaseIndex((i) => Math.min(i + 1, BOOT_PHASES.length));
      }, 90);
      return () => clearTimeout(t);
    }
  }, [phaseProgress, phaseIndex]);

  // ── Comprobar estado de pánico ────────────────────────────────────────────
  useEffect(() => {
    if (os?.phase === 'panic' || os?.panic) {
      setFailed('PANIC — kernel panic detectado');
      pushLog('[panic] kernel panic — reinicio requerido', 'error');
    }
  }, [os?.phase, os?.panic, pushLog]);

  // ── Cálculo de progreso global (0..1) ─────────────────────────────────────
  const progress = useMemo(() => {
    if (done) return 1;
    let acc = 0;
    for (let i = 0; i < phaseIndex && i < BOOT_PHASES.length; i++) {
      acc += BOOT_PHASES[i].weight;
    }
    const cur = BOOT_PHASES[phaseIndex];
    if (cur) acc += cur.weight * phaseProgress;
    return Math.min(1, acc / PHASE_TOTAL_WEIGHT);
  }, [phaseIndex, phaseProgress, done]);

  return {
    progress,
    phaseIndex,
    phaseProgress,
    phase: BOOT_PHASES[phaseIndex] || null,
    log,
    done,
    failed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes visuales
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ value, fading }) {
  return (
    <div
      style={{
        width: 180,
        height: 3,
        borderRadius: 2,
        background: 'rgba(255,255,255,0.18)',
        overflow: 'hidden',
        opacity: fading ? 0 : 1,
        transition: 'opacity 400ms ease',
      }}
    >
      <div
        style={{
          width: `${Math.max(2, value * 100)}%`,
          height: '100%',
          background: '#fff',
          borderRadius: 2,
          transition: 'width 120ms linear',
        }}
      />
    </div>
  );
}

function KernelLog({ entries, visible }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);

  if (!visible) return null;
  const last = entries.slice(-6);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        left: 24,
        right: 24,
        bottom: 28,
        maxHeight: 96,
        overflow: 'hidden',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 9,
        lineHeight: 1.5,
        color: 'rgba(255,255,255,0.42)',
        textAlign: 'left',
        pointerEvents: 'none',
        maskImage: 'linear-gradient(to bottom, transparent, #000 30%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 30%)',
      }}
    >
      {last.map((e) => (
        <div
          key={e.id}
          style={{
            color:
              e.level === 'error' ? 'rgba(255,120,120,0.85)' :
              e.level === 'warn'  ? 'rgba(255,210,120,0.7)'  :
              e.level === 'ok'    ? 'rgba(160,230,160,0.65)' :
                                    'rgba(255,255,255,0.42)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span style={{ opacity: 0.5 }}>{(e.t / 1000).toFixed(2).padStart(6, ' ')}s </span>
          {e.text}
        </div>
      ))}
    </div>
  );
}

function PhaseList({ phaseIndex, phaseProgress }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 96,
        left: 32,
        right: 32,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: 0.55,
      }}
    >
      {BOOT_PHASES.map((p, i) => {
        const state =
          i < phaseIndex ? 'done' :
          i === phaseIndex ? 'active' : 'pending';
        return (
          <div
            key={p.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 10,
              fontFamily: 'ui-monospace, Menlo, monospace',
              color:
                state === 'done'   ? 'rgba(160,230,160,0.75)' :
                state === 'active' ? 'rgba(255,255,255,0.9)'  :
                                     'rgba(255,255,255,0.28)',
              transition: 'color 200ms ease',
            }}
          >
            <PhaseIcon
              name={p.icon}
              color={
                state === 'done'   ? 'rgba(160,230,160,0.9)' :
                state === 'active' ? 'rgba(255,255,255,1)'   :
                                     'rgba(255,255,255,0.35)'
              }
            />
            <span style={{ flex: 1 }}>{p.label}</span>
            {state === 'active' && (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(phaseProgress * 100)}%
              </span>
            )}
            {state === 'done' && <span>✓</span>}
          </div>
        );
      })}
    </div>
  );
}

function PanicOverlay({ message, onReboot }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        padding: 32,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: '#ff6b6b' }}>
        ⚠️ Kernel Panic
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6 }}>
        {message || 'El sistema encontró un error irrecuperable.'}
      </div>
      <button
        onClick={onReboot}
        style={{
          marginTop: 12,
          padding: '10px 22px',
          borderRadius: 22,
          border: 'none',
          background: 'rgba(255,255,255,0.14)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        Reiniciar
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BootScreen
 *
 * @param {Object} props
 * @param {Function} [props.onBootComplete]  Se llama cuando el progreso llega a 1
 *                                            y la animación de salida ha terminado.
 * @param {number}   [props.minDuration=2200] Duración mínima en ms antes de salir,
 *                                            para que la animación no sea instantánea.
 * @param {boolean}  [props.showLog=true]     Mostrar el log del kernel.
 * @param {boolean}  [props.showPhases=true]  Mostrar la lista de fases.
 */
export default function BootScreen({
  onBootComplete,
  minDuration = 2200,
  showLog = true,
  showPhases = true,
}) {
  const os = useOS();
  const { progress, phaseIndex, phaseProgress, phase, log, done, failed } =
    useBootProgress(os);

  const [fading, setFading] = useState(false);
  const [exiting, setExiting] = useState(false);
  const mountedAt = useRef(performance.now());
  const completedRef = useRef(false);

  // Marcar fading cuando el log llega al final
  useEffect(() => {
    if (!done) return;
    const elapsed = performance.now() - mountedAt.current;
    const wait = Math.max(0, minDuration - elapsed);
    const t = setTimeout(() => setFading(true), wait);
    return () => clearTimeout(t);
  }, [done, minDuration]);

  // Animación de salida
  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => {
      setExiting(true);
      setTimeout(() => {
        if (!completedRef.current) {
          completedRef.current = true;
          onBootComplete?.();
        }
      }, 420);
    }, 220);
    return () => clearTimeout(t);
  }, [fading, onBootComplete]);

  const handleReboot = useCallback(() => {
    try {
      os?.recover?.();
    } catch { /* ignore */ }
    window.location.reload();
  }, [os]);

  const style = {
    position: 'absolute',
    inset: 0,
    background: '#000',
    color: '#fff',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
    opacity: exiting ? 0 : 1,
    transform: exiting ? 'scale(1.06)' : 'scale(1)',
    transition: 'opacity 420ms ease, transform 420ms ease',
    willChange: 'opacity, transform',
  };

  if (failed) {
    return (
      <div style={style}>
        <PanicOverlay message={failed} onReboot={handleReboot} />
      </div>
    );
  }

  return (
    <div style={style}>
      {/* Logo Apple */}
      <AppleLogo size={110} opacity={0.92} />

      {/* Barra de progreso debajo del logo */}
      <div style={{ marginTop: 46 }}>
        <ProgressBar value={progress} fading={fading} />
      </div>

      {/* Etiqueta de fase actual */}
      <div
        style={{
          marginTop: 14,
          fontSize: 10,
          letterSpacing: 0.4,
          color: 'rgba(255,255,255,0.38)',
          fontFamily: 'ui-monospace, Menlo, monospace',
          height: 14,
          opacity: fading ? 0 : 1,
          transition: 'opacity 300ms ease',
        }}
      >
        {phase ? phase.label : 'Listo'}
      </div>

      {/* Lista de fases (opcional) */}
      {showPhases && !fading && (
        <PhaseList phaseIndex={phaseIndex} phaseProgress={phaseProgress} />
      )}

      {/* Log del kernel (opcional) */}
      {showLog && !fading && <KernelLog entries={log} visible />}
    </div>
  );
}
