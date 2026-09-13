// src/ui/BootScreen.jsx
// iOS Remastered — BootScreen v2
// Logo Apple SVG, barra de progreso, log del kernel en vivo, fases de boot,
// modo pánico con overlay, timeout de seguridad para no colgarse nunca,
// transición de salida. Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback,
} from 'react';

import { useOS } from '../context/OSContext.jsx';
import { Icon } from './Icon.jsx';

/* ============================================================================
 * FASES DE ARRANQUE
 * Cada fase tiene id, label, peso (cuánto dura en ms) y una función que
 * devuelve las líneas de log que se muestran durante esa fase.
 * ========================================================================== */

const BOOT_PHASES = [
  {
    id: 'firmware',
    label: 'BootROM',
    weight: 180,
    logs: [
      '[ 0.000] BootROM v2.1 — SecureROM check OK',
      '[ 0.012] Verificando iBoot…',
      '[ 0.048] iBoot verificado · firma válida',
    ],
  },
  {
    id: 'kernel',
    label: 'Kernel',
    weight: 220,
    logs: [
      '[ 0.120] XNU Kernel 24.0.0 (Darwin)',
      '[ 0.145] CPU: arm64e · 6 cores · 3.78 GHz',
      '[ 0.180] MMU: activada · páginas 16 KB',
      '[ 0.210] Scheduler: quantum 10ms · 4 prioridades',
    ],
  },
  {
    id: 'memory',
    label: 'MemoryManager',
    weight: 180,
    logs: [
      '[ 0.240] MemoryManager: init 6 GB',
      '[ 0.268] Zonas: wired, active, inactive, free',
      '[ 0.290] Compresor activo · ratio objetivo 2.4:1',
    ],
  },
  {
    id: 'drivers',
    label: 'Drivers',
    weight: 320,
    logs: [
      '[ 0.320] HardwareBus: enumerando periféricos…',
      '[ 0.352] VAmbientLight: probe OK (lux=120)',
      '[ 0.380] VProximity: probe OK',
      '[ 0.405] VMicrophone: probe OK (48 kHz)',
      '[ 0.428] VSpeaker: probe OK',
      '[ 0.452] VThermal: probe OK (31.2 °C)',
      '[ 0.478] VAccelerometer: probe OK',
      '[ 0.501] VGyroscope: probe OK',
      '[ 0.524] VMagnetometer: probe OK',
      '[ 0.548] VBarometer: probe OK (1013 hPa)',
      '[ 0.572] VGPS: probe OK',
      '[ 0.595] VDisplay: probe OK (402×874 @3x)',
      '[ 0.618] VHaptics: probe OK',
      '[ 0.640] VFaceID: probe OK · Secure Enclave',
      '[ 0.665] VWiFi: probe OK',
      '[ 0.690] VBluetooth: probe OK',
      '[ 0.712] VCellular: probe OK',
      '[ 0.735] VNFC: probe OK',
      '[ 0.758] VUWB: probe OK',
      '[ 0.780] VBattery: probe OK (87%)',
      '[ 0.802] VPower: probe OK',
      '[ 0.820] 21 drivers linked · LINK_GRAPH OK',
    ],
  },
  {
    id: 'filesystem',
    label: 'FileSystem',
    weight: 200,
    logs: [
      '[ 0.850] FileSystem: montando volúmenes',
      '[ 0.876] / → APFS (system, read-only)',
      '[ 0.900] /private/var → APFS (data, rw)',
      '[ 0.924] /private/var/mobile → APFS (user)',
      '[ 0.948] FileSystem: OK',
    ],
  },
  {
    id: 'keychain',
    label: 'Keychain',
    weight: 140,
    logs: [
      '[ 0.972] Keychain: init Secure Enclave',
      '[ 0.995] Keychain: 12 items cargados',
      '[ 1.020] Keychain: OK',
    ],
  },
  {
    id: 'network',
    label: 'Network',
    weight: 160,
    logs: [
      '[ 1.040] NetworkStack: init',
      '[ 1.062] WiFi: conectado a "iOS Remastered"',
      '[ 1.085] DHCP: 192.168.1.42/24',
      '[ 1.108] DNS: 1.1.1.1, 8.8.8.8',
    ],
  },
  {
    id: 'loader',
    label: 'MachOLoader',
    weight: 180,
    logs: [
      '[ 1.130] MachOLoader: init',
      '[ 1.155] IPAInstaller: registro de handlers',
      '[ 1.178] MachOStructures: parser cargado',
      '[ 1.200] Loader: OK',
    ],
  },
  {
    id: 'services',
    label: 'Servicios',
    weight: 260,
    logs: [
      '[ 1.230] launchd: init PID 1',
      '[ 1.258] NotificationCenter: init',
      '[ 1.285] HardwareBus: watchdog 5s',
      '[ 1.310] MemoryManager: compresión OK',
      '[ 1.340] Syscalls: tabla registrada',
      '[ 1.365] ProcessManager: init',
      '[ 1.395] Servicios listos',
    ],
  },
  {
    id: 'ui',
    label: 'SpringBoard',
    weight: 300,
    logs: [
      '[ 1.420] SpringBoard: init',
      '[ 1.450] StatusBar: ready',
      '[ 1.478] AppWindow: ready',
      '[ 1.502] GestureHandler: ready',
      '[ 1.528] Toast/Alert: ready',
      '[ 1.555] Registry: 44 apps',
      '[ 1.580] Boot completo · entregando UI',
    ],
  },
];

const TOTAL_WEIGHT = BOOT_PHASES.reduce((a, p) => a + p.weight, 0);

/* ============================================================================
 * LOGO APPLE SVG
 * ========================================================================== */

function AppleLogo({ size = 80, color = '#fff', glow = false }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{
        fill: color,
        filter: glow
          ? 'drop-shadow(0 0 12px rgba(255,255,255,0.6)) drop-shadow(0 0 24px rgba(255,255,255,0.3))'
          : 'none',
        transition: 'filter .6s ease',
      }}
      aria-hidden="true"
    >
      <path d="M17.05 12.54c-.02-2.1 1.72-3.1 1.8-3.15-.98-1.44-2.5-1.63-3.04-1.65-1.3-.13-2.53.76-3.2.76-.66 0-1.67-.74-2.75-.72-1.42.02-2.73.82-3.46 2.09-1.48 2.56-.38 6.34 1.06 8.42.7 1.02 1.54 2.16 2.64 2.12 1.06-.04 1.46-.68 2.74-.68 1.28 0 1.64.68 2.76.66 1.14-.02 1.86-1.04 2.56-2.06.8-1.18 1.14-2.32 1.16-2.38-.03-.01-2.23-.86-2.25-3.4zM15.06 5.63c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.54.62-1 1.62-.88 2.57.93.07 1.88-.47 2.46-1.17z"/>
    </svg>
  );
}

/* ============================================================================
 * BOOT SCREEN
 * ========================================================================== */

export default function BootScreen({
  onComplete,
  forceCompleteAfter = 8000,   // timeout duro: nunca colgarse más de esto
  minDuration = 2400,          // duración mínima antes de llamar a onComplete
}) {
  const os = useOS();

  const [phaseIdx, setPhaseIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [panic, setPanic] = useState(false);
  const [showLogs, setShowLogs] = useState(true);

  const startRef = useRef(Date.now());
  const logEndRef = useRef(null);
  const completedRef = useRef(false);
  const logQueueRef = useRef([]);
  const timeoutsRef = useRef([]);

  /* --------------------------- Programación de logs --------------------------- */

  const scheduleLog = useCallback((text, at) => {
    const t = setTimeout(() => {
      setLogs((prev) => [...prev.slice(-40), text]);
    }, at);
    timeoutsRef.current.push(t);
  }, []);

  /* --------------------------- Motor de fases --------------------------- */

  useEffect(() => {
    const start = Date.now();
    let cancelled = false;

    let acc = 0;
    BOOT_PHASES.forEach((phase, idx) => {
      const phaseStart = acc;
      const phaseEnd = acc + phase.weight;

      // Programar logs de esta fase
      phase.logs.forEach((line, i) => {
        const offset = phaseStart + (phase.weight / (phase.logs.length + 1)) * (i + 1);
        scheduleLog(line, offset);
      });

      // Cambio de fase
      const tChange = setTimeout(() => {
        if (!cancelled) setPhaseIdx(idx);
      }, phaseStart);
      timeoutsRef.current.push(tChange);

      acc = phaseEnd;
    });

    // Progreso continuo
    const tick = setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - start;
      const p = Math.min(1, elapsed / TOTAL_WEIGHT);
      setProgress(p);

      if (p >= 1) {
        clearInterval(tick);
        // Esperamos minDuration desde el inicio
        const totalElapsed = Date.now() - startRef.current;
        const remaining = Math.max(0, minDuration - totalElapsed);
        const tDone = setTimeout(() => {
          if (!cancelled) finish('ok');
        }, remaining);
        timeoutsRef.current.push(tDone);
      }
    }, 40);
    timeoutsRef.current.push(tick);

    return () => {
      cancelled = true;
      clearInterval(tick);
      timeoutsRef.current.forEach((t) => clearTimeout(t));
      timeoutsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------- Timeout de seguridad --------------------------- */

  useEffect(() => {
    const t = setTimeout(() => {
      if (!completedRef.current) {
        console.warn('[BootScreen] Timeout de seguridad alcanzado');
        finish('timeout');
      }
    }, forceCompleteAfter);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceCompleteAfter]);

  /* --------------------------- Finalizar --------------------------- */

  const finish = useCallback((reason) => {
    if (completedRef.current) return;
    completedRef.current = true;

    // Forzamos progreso al 100% y esperamos a que la barra termine
    setProgress(1);
    setLogs((prev) => [
      ...prev,
      `[ boot ] ${reason === 'timeout' ? 'Timeout de seguridad' : 'Arranque completado'}`,
    ]);

    setTimeout(() => {
      setExiting(true);
      setTimeout(() => {
        if (typeof onComplete === 'function') {
          try {
            onComplete();
          } catch (e) {
            console.error('[BootScreen] Error en onComplete:', e);
          }
        } else {
          console.warn('[BootScreen] onComplete no es función; el sistema se quedará en boot');
        }
      }, 420);
    }, 300);
  }, [onComplete]);

  /* --------------------------- Observar os.ready --------------------------- */

  useEffect(() => {
    if (!os) return;
    // Si el OS ya está listo, podemos acelerar el boot
    if (os.ready === true) {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, minDuration - elapsed);
      const t = setTimeout(() => finish('os-ready'), remaining);
      timeoutsRef.current.push(t);
    }
  }, [os?.ready, minDuration, finish]);

  /* --------------------------- Auto-scroll del log --------------------------- */

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [logs]);

  /* --------------------------- Detección de pánico --------------------------- */

  useEffect(() => {
    if (!os) return;
    if (os.panic === true) {
      setPanic(true);
      setPaused(true);
    }
  }, [os?.panic]);

  /* --------------------------- Render --------------------------- */

  const currentPhase = BOOT_PHASES[phaseIdx] || BOOT_PHASES[BOOT_PHASES.length - 1];
  const pct = Math.round(progress * 100);

  return (
    <div className={`boot-screen ${exiting ? 'is-exiting' : ''} ${panic ? 'is-panic' : ''}`}>
      {/* Fondo */}
      <div className="boot-bg" />

      {/* Contenido central */}
      <div className="boot-center">
        <div className="boot-logo">
          <AppleLogo size={84} color="#fff" glow={progress > 0.02} />
        </div>

        {!panic && (
          <>
            <div className="boot-progress">
              <div
                className="boot-progress-fill"
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="boot-phase">
              <span className="boot-phase-label">{currentPhase.label}</span>
              <span className="boot-phase-pct">{pct}%</span>
            </div>
          </>
        )}

        {panic && (
          <div className="boot-panic">
            <div className="boot-panic-icon">
              <Icon name="exclamationmark.triangle.fill" size={40} color="#ff453a" />
            </div>
            <h2>Kernel Panic</h2>
            <p>El sistema se ha detenido por un error crítico.</p>
            <pre className="boot-panic-trace">
              {os?.panicMessage || 'Unrecoverable kernel error'}
            </pre>
            <button
              className="boot-panic-btn"
              onClick={() => window.location.reload()}
            >
              Reiniciar
            </button>
          </div>
        )}
      </div>

      {/* Log del kernel */}
      {showLogs && !panic && (
        <div className="boot-logs" ref={logEndRef}>
          {logs.map((line, i) => (
            <div key={i} className="boot-log-line">{line}</div>
          ))}
          {logs.length === 0 && (
            <div className="boot-log-line boot-log-dim">[ boot ] Iniciando…</div>
          )}
        </div>
      )}

      {/* Botón para ocultar/mostrar logs */}
      <button
        className="boot-toggle-logs"
        onClick={() => setShowLogs((v) => !v)}
        title={showLogs ? 'Ocultar log' : 'Mostrar log'}
      >
        <Icon
          name={showLogs ? 'eye.slash' : 'eye'}
          size={14}
          color="rgba(255,255,255,0.45)"
        />
      </button>

      {/* Botón de escape por si algo va mal */}
      <button
        className="boot-skip"
        onClick={() => finish('manual')}
        title="Saltar arranque"
      >
        Saltar
      </button>

      {/* Subtítulo inferior */}
      <div className="boot-footer">
        <span>iOS Remastered</span>
        <span className="boot-footer-sep">·</span>
        <span>v1.0.0</span>
      </div>
    </div>
  );
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('boot-styles')) {
  const s = document.createElement('style');
  s.id = 'boot-styles';
  s.textContent = `
  .boot-screen {
    position: absolute;
    inset: 0;
    background: #000;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    font-family: -apple-system, system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    z-index: 1300;
    opacity: 1;
    transition: opacity .4s ease;
  }
  .boot-screen.is-exiting {
    opacity: 0;
    pointer-events: none;
  }
  .boot-screen.is-panic {
    background: #1a0a0a;
  }

  .boot-bg {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 45%, #0a0a0a 0%, #000 70%);
    pointer-events: none;
  }

  .boot-center {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    z-index: 1;
    width: 100%;
    padding: 0 40px;
    transform: translateY(-30px);
  }

  .boot-logo {
    display: flex;
    align-items: center;
    justify-content: center;
    animation: boot-logo-in 1s cubic-bezier(.2,.8,.3,1);
  }
  @keyframes boot-logo-in {
    0%   { opacity: 0; transform: scale(0.7); }
    100% { opacity: 1; transform: scale(1); }
  }

  .boot-progress {
    width: 180px;
    height: 4px;
    background: rgba(255,255,255,0.12);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 12px;
  }
  .boot-progress-fill {
    height: 100%;
    background: #fff;
    border-radius: 2px;
    transition: width .12s linear;
  }

  .boot-phase {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: rgba(255,255,255,0.55);
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }
  .boot-phase-label {
    font-weight: 500;
  }
  .boot-phase-pct {
    font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,0.35);
  }

  /* Panic */
  .boot-panic {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    max-width: 320px;
  }
  .boot-panic-icon {
    margin-bottom: 6px;
  }
  .boot-panic h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: #ff453a;
  }
  .boot-panic p {
    margin: 0;
    font-size: 13px;
    color: rgba(255,255,255,0.6);
    line-height: 1.4;
  }
  .boot-panic-trace {
    margin-top: 8px;
    padding: 10px 12px;
    background: rgba(255,69,58,0.08);
    border: 1px solid rgba(255,69,58,0.3);
    border-radius: 8px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    color: #ff453a;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
  }
  .boot-panic-btn {
    margin-top: 12px;
    padding: 10px 24px;
    background: #ff453a;
    color: #fff;
    border: none;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }

  /* Log del kernel */
  .boot-logs {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 30%;
    overflow-y: auto;
    padding: 16px 20px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 10px;
    line-height: 1.5;
    color: rgba(255,255,255,0.4);
    pointer-events: auto;
    scrollbar-width: none;
    mask-image: linear-gradient(to bottom, transparent 0%, #000 30%, #000 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 30%, #000 100%);
  }
  .boot-logs::-webkit-scrollbar { display: none; }
  .boot-log-line {
    white-space: pre;
    opacity: 0;
    animation: boot-log-in .3s ease forwards;
  }
  .boot-log-dim { color: rgba(255,255,255,0.25); }
  @keyframes boot-log-in {
    from { opacity: 0; transform: translateX(-4px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  /* Botones auxiliares */
  .boot-toggle-logs,
  .boot-skip {
    position: absolute;
    bottom: 16px;
    background: none;
    border: none;
    color: rgba(255,255,255,0.3);
    font-size: 11px;
    padding: 6px 10px;
    cursor: pointer;
    border-radius: 6px;
    transition: background .15s, color .15s;
  }
  .boot-toggle-logs:hover,
  .boot-skip:hover {
    background: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.7);
  }
  .boot-toggle-logs {
    left: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .boot-skip {
    right: 12px;
  }

  /* Footer */
  .boot-footer {
    position: absolute;
    bottom: 48px;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 11px;
    color: rgba(255,255,255,0.28);
    letter-spacing: 0.3px;
    pointer-events: none;
  }
  .boot-footer-sep {
    opacity: 0.5;
  }
  `;
  document.head.appendChild(s);
}
