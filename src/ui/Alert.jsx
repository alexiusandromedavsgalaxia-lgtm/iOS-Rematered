// src/ui/Alert.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Alert
//
// Sistema de alertas y action sheets al estilo UIAlertController de iOS.
//
//   • Alert modal centrado con título + mensaje + 1-3 botones.
//   • Action Sheet deslizante desde abajo con acciones + Cancelar.
//   • Inputs opcionales (uno o varios) para prompts.
//   • Botones con estilos: default, cancel, destructive.
//   • Teclado: Escape cierra, Enter confirma.
//   • Blur + animación spring iOS.
//   • API imperativa con promesas:
//       await alert.confirm({ title, message, confirm: 'Aceptar' }) → true | false
//       await alert.prompt({ title, placeholder }) → string | null
//       await alert.destructive({ title, message }) → true | false
//
// Uso:
//   import alert from './Alert.jsx';
//
//   // Simple
//   alert.info('Hola', 'Esto es un mensaje');
//
//   // Confirmación con promesa
//   if (await alert.confirm({ title: '¿Borrar?', message: 'No se puede deshacer' })) {
//     borrar();
//   }
//
//   // Prompt con input
//   const name = await alert.prompt({
//     title: 'Nueva carpeta',
//     placeholder: 'Nombre',
//     confirm: 'Crear',
//   });
//   if (name) crearCarpeta(name);
//
//   // Action sheet
//   const action = await alert.sheet({
//     title: 'Acciones',
//     actions: [
//       { label: 'Compartir', value: 'share' },
//       { label: 'Duplicar', value: 'dup' },
//       { label: 'Eliminar', value: 'del', style: 'destructive' },
//     ],
//   });
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const KIND = {
  ALERT: 'alert',
  SHEET: 'sheet',
};

const BTN_STYLE = {
  DEFAULT: 'default',
  CANCEL: 'cancel',
  DESTRUCTIVE: 'destructive',
};

const SPRING = 'cubic-bezier(.22,1,.36,1)';

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, double: [12, 40, 12], tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

let _alertId = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Store global
// ─────────────────────────────────────────────────────────────────────────────

const alertStore = {
  listeners: new Set(),
  current: null,
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  },
  emit() {
    for (const fn of this.listeners) fn(this.current);
  },
  open(config) {
    return new Promise((resolve) => {
      const id = ++_alertId;
      this.current = { ...config, id, resolve };
      this.emit();
    });
  },
  close(result) {
    if (!this.current) return;
    const { resolve } = this.current;
    this.current = null;
    this.emit();
    resolve?.(result);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// API imperativa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Muestra una alerta y devuelve una promesa que resuelve con:
 *   - el `value` del botón pulsado
 *   - `null` si se canceló (Escape, tap fuera)
 *
 * @param {Object} config
 * @param {'alert'|'sheet'} [config.kind='alert']
 * @param {string} [config.title]
 * @param {string} [config.message]
 * @param {Array}  [config.buttons]   [{ label, value?, style? }]
 * @param {Array}  [config.inputs]    [{ placeholder, value?, type?, secure? }]
 * @param {string} [config.confirm='Aceptar']
 * @param {string} [config.cancel]    Si se define, añade botón cancelar
 * @param {string} [config.placeholder]
 * @param {string} [config.defaultValue]
 */
export function showAlert(config = {}) {
  return alertStore.open(config);
}

function buildButtons(config) {
  // Si config ya trae buttons, usarlos tal cual
  if (Array.isArray(config.buttons)) return config.buttons;
  const btns = [];
  if (config.cancel) {
    btns.push({ label: config.cancel, value: null, style: BTN_STYLE.CANCEL });
  }
  btns.push({
    label: config.confirm || 'Aceptar',
    value: config.confirmValue ?? true,
    style: config.destructive ? BTN_STYLE.DESTRUCTIVE : BTN_STYLE.DEFAULT,
  });
  return btns;
}

function buildInputs(config) {
  if (Array.isArray(config.inputs)) return config.inputs;
  if (config.prompt || config.placeholder != null) {
    return [
      {
        placeholder: config.placeholder || '',
        value: config.defaultValue || '',
        secure: !!config.secure,
        type: config.type || 'text',
      },
    ];
  }
  return [];
}

const alert = {
  /** Muestra una alerta genérica. */
  show(config) {
    return showAlert(config);
  },

  /** Alert simple solo informativo. */
  info(title, message, confirm = 'Aceptar') {
    return showAlert({
      kind: KIND.ALERT,
      title,
      message,
      buttons: [{ label: confirm, value: true, style: BTN_STYLE.DEFAULT }],
    });
  },

  /** Alert de confirmación. Resuelve `true` si acepta, `false` si cancela. */
  async confirm(config = {}) {
    const result = await showAlert({
      kind: KIND.ALERT,
      title: config.title || '¿Estás seguro?',
      message: config.message,
      confirm: config.confirm || 'Aceptar',
      cancel: config.cancel || 'Cancelar',
      confirmValue: true,
      buttons: [
        { label: config.cancel || 'Cancelar', value: false, style: BTN_STYLE.CANCEL },
        { label: config.confirm || 'Aceptar', value: true, style: BTN_STYLE.DEFAULT },
      ],
    });
    return result === true;
  },

  /** Alert destructiva (rojo). Resuelve `true` si acepta. */
  async destructive(config = {}) {
    const result = await showAlert({
      kind: KIND.ALERT,
      title: config.title || '¿Eliminar?',
      message: config.message || 'Esta acción no se puede deshacer.',
      buttons: [
        { label: config.cancel || 'Cancelar', value: false, style: BTN_STYLE.CANCEL },
        {
          label: config.confirm || 'Eliminar',
          value: true,
          style: BTN_STYLE.DESTRUCTIVE,
        },
      ],
    });
    return result === true;
  },

  /** Prompt con input. Resuelve el string o `null` si cancela. */
  async prompt(config = {}) {
    const result = await showAlert({
      kind: KIND.ALERT,
      title: config.title || 'Introduce un valor',
      message: config.message,
      inputs: [
        {
          placeholder: config.placeholder || '',
          value: config.defaultValue || '',
          type: config.type || 'text',
          secure: !!config.secure,
        },
      ],
      buttons: [
        { label: config.cancel || 'Cancelar', value: null, style: BTN_STYLE.CANCEL },
        { label: config.confirm || 'Aceptar', value: '__input__', style: BTN_STYLE.DEFAULT },
      ],
    });
    if (result === null || result === undefined) return null;
    return typeof result === 'string' ? result : null;
  },

  /** Action sheet. Resuelve el `value` de la acción escogida o `null`. */
  async sheet(config = {}) {
    return showAlert({
      kind: KIND.SHEET,
      title: config.title,
      message: config.message,
      actions: config.actions || [],
      cancel: config.cancel || 'Cancelar',
    });
  },

  /** Cierra cualquier alerta abierta. */
  dismiss() {
    alertStore.close(null);
  },
};

export default alert;

// ─────────────────────────────────────────────────────────────────────────────
// Estilos de botón compartidos
// ─────────────────────────────────────────────────────────────────────────────

function getButtonColor(style, scheme) {
  const dark = scheme !== 'light';
  if (style === BTN_STYLE.DESTRUCTIVE) return '#ff453a';
  if (style === BTN_STYLE.CANCEL) return dark ? '#0a84ff' : '#007aff';
  return dark ? '#0a84ff' : '#007aff';
}

function getButtonBg(style, scheme, isPrimary) {
  const dark = scheme !== 'light';
  if (!isPrimary) return 'transparent';
  // Botón único destacado en iOS: azul con texto blanco
  if (style === BTN_STYLE.DESTRUCTIVE) return '#ff453a';
  return '#0a84ff';
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

function AlertInput({ input, value, onChange, scheme, onEnter }) {
  const ref = useRef(null);
  const dark = scheme !== 'light';
  return (
    <input
      ref={ref}
      autoFocus
      type={input.type || 'text'}
      value={value}
      placeholder={input.placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter?.();
      }}
      style={{
        width: '100%',
        padding: '9px 12px',
        borderRadius: 8,
        border: `0.5px solid ${dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'}`,
        background: dark ? 'rgba(120,120,128,0.2)' : 'rgba(120,120,128,0.12)',
        color: dark ? '#fff' : '#000',
        fontSize: 15,
        outline: 'none',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
        marginTop: 12,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Botón
// ─────────────────────────────────────────────────────────────────────────────

function AlertButton({ label, style, scheme, onClick, fullWidth }) {
  const [pressed, setPressed] = useState(false);
  const color = getButtonColor(style, scheme);
  const dark = scheme !== 'light';
  return (
    <button
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        flex: 1,
        padding: fullWidth ? '14px 10px' : '12px 10px',
        background: pressed
          ? dark
            ? 'rgba(255,255,255,0.1)'
            : 'rgba(0,0,0,0.06)'
          : 'transparent',
        border: 'none',
        color,
        fontSize: 17,
        fontWeight: style === BTN_STYLE.CANCEL ? 400 : 600,
        cursor: 'pointer',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
        transition: 'background 120ms ease',
        letterSpacing: -0.2,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert (modal centrado)
// ─────────────────────────────────────────────────────────────────────────────

function AlertModal({ config, scheme, onClose }) {
  const [phase, setPhase] = useState('closed');
  const [inputValues, setInputValues] = useState(() =>
    (config.inputs || []).map((i) => i.value ?? '')
  );

  const buttons = useMemo(() => buildButtons(config), [config]);
  const inputs = useMemo(() => buildInputs(config), [config]);

  useEffect(() => {
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  const finish = useCallback((result) => {
    setPhase('closed');
    haptic('light');
    setTimeout(() => onClose(result), 240);
  }, [onClose]);

  const handleButton = useCallback((btn) => {
    // Si el botón espera el input, lo devolvemos
    if (btn.value === '__input__') {
      finish(inputValues[0] ?? '');
    } else {
      finish(btn.value ?? null);
    }
  }, [finish, inputValues]);

  // Escape / Enter
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        const cancel = buttons.find((b) => b.style === BTN_STYLE.CANCEL);
        finish(cancel ? cancel.value ?? null : null);
      } else if (e.key === 'Enter' && inputs.length > 0) {
        const primary = buttons[buttons.length - 1];
        handleButton(primary);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [buttons, inputs, finish, handleButton]);

  const dark = scheme !== 'light';
  const bg = dark ? 'rgba(44,44,46,0.94)' : 'rgba(255,255,255,0.98)';
  const text = dark ? '#fff' : '#000';
  const subText = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
  const separator = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const cancel = buttons.find((b) => b.style === BTN_STYLE.CANCEL);
          finish(cancel ? cancel.value ?? null : null);
        }
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        opacity: phase === 'open' ? 1 : 0,
        transition: 'opacity 220ms ease',
        touchAction: 'none',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 280,
          borderRadius: 14,
          background: bg,
          backdropFilter: 'blur(34px) saturate(180%)',
          WebkitBackdropFilter: 'blur(34px) saturate(180%)',
          overflow: 'hidden',
          transform: phase === 'open' ? 'scale(1)' : 'scale(0.88)',
          opacity: phase === 'open' ? 1 : 0,
          transition: `transform 320ms ${SPRING}, opacity 220ms ease`,
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
        }}
      >
        {/* Cabecera */}
        <div style={{ padding: '18px 18px 14px', textAlign: 'center' }}>
          {config.title && (
            <div
              style={{
                fontSize: 17,
                fontWeight: 600,
                color: text,
                lineHeight: 1.3,
                letterSpacing: -0.2,
              }}
            >
              {config.title}
            </div>
          )}
          {config.message && (
            <div
              style={{
                marginTop: config.title ? 6 : 0,
                fontSize: 13,
                color: subText,
                lineHeight: 1.4,
                fontWeight: 400,
              }}
            >
              {config.message}
            </div>
          )}
          {inputs.map((inp, i) => (
            <AlertInput
              key={i}
              input={inp}
              value={inputValues[i] ?? ''}
              onChange={(v) => {
                setInputValues((prev) => {
                  const next = [...prev];
                  next[i] = v;
                  return next;
                });
              }}
              scheme={scheme}
              onEnter={() => handleButton(buttons[buttons.length - 1])}
            />
          ))}
        </div>

        {/* Botones */}
        <div
          style={{
            display: 'flex',
            borderTop: `0.5px solid ${separator}`,
            flexDirection: buttons.length > 2 ? 'column' : 'row',
          }}
        >
          {buttons.map((btn, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                borderLeft:
                  i > 0 && buttons.length <= 2
                    ? `0.5px solid ${separator}`
                    : 'none',
                borderTop:
                  i > 0 && buttons.length > 2
                    ? `0.5px solid ${separator}`
                    : 'none',
              }}
            >
              <AlertButton
                label={btn.label}
                style={btn.style}
                scheme={scheme}
                fullWidth
                onClick={() => handleButton(btn)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action Sheet (desde abajo)
// ─────────────────────────────────────────────────────────────────────────────

function SheetModal({ config, scheme, onClose }) {
  const [phase, setPhase] = useState('closed');

  useEffect(() => {
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  const finish = useCallback((value) => {
    setPhase('closed');
    haptic(value === null ? 'light' : 'medium');
    setTimeout(() => onClose(value), 300);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  const dark = scheme !== 'light';
  const bg = dark ? 'rgba(44,44,46,0.94)' : 'rgba(255,255,255,0.98)';
  const cancelBg = dark ? 'rgba(44,44,46,0.98)' : 'rgba(255,255,255,1)';
  const text = dark ? '#fff' : '#000';
  const subText = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
  const sep = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  const actions = config.actions || [];
  const cancelLabel = config.cancel || 'Cancelar';

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) finish(null);
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: '8px 8px 8px',
        opacity: phase === 'open' ? 1 : 0,
        transition: 'opacity 240ms ease',
        touchAction: 'none',
      }}
    >
      {/* Bloque de acciones */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          borderRadius: 14,
          background: bg,
          backdropFilter: 'blur(34px) saturate(180%)',
          WebkitBackdropFilter: 'blur(34px) saturate(180%)',
          overflow: 'hidden',
          transform: phase === 'open' ? 'translateY(0)' : 'translateY(40px)',
          opacity: phase === 'open' ? 1 : 0,
          transition: `transform 380ms ${SPRING}, opacity 240ms ease`,
          marginBottom: 8,
          boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        }}
      >
        {config.title && (
          <div
            style={{
              padding: '14px 18px',
              textAlign: 'center',
              fontSize: 12,
              color: subText,
              borderBottom: `0.5px solid ${sep}`,
            }}
          >
            {config.title}
          </div>
        )}
        {config.message && (
          <div
            style={{
              padding: '10px 18px',
              textAlign: 'center',
              fontSize: 11,
              color: subText,
              borderBottom: `0.5px solid ${sep}`,
            }}
          >
            {config.message}
          </div>
        )}
        {actions.map((a, i) => (
          <button
            key={i}
            onClick={() => finish(a.value ?? a.label)}
            style={{
              width: '100%',
              padding: '15px 18px',
              background: 'transparent',
              border: 'none',
              borderTop: i > 0 ? `0.5px solid ${sep}` : 'none',
              color:
                a.style === BTN_STYLE.DESTRUCTIVE
                  ? '#ff453a'
                  : dark
                  ? '#0a84ff'
                  : '#007aff',
              fontSize: 17,
              fontWeight: a.style === BTN_STYLE.DESTRUCTIVE ? 600 : 500,
              cursor: 'pointer',
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
              letterSpacing: -0.2,
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Bloque de Cancelar (separado, como iOS) */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          borderRadius: 14,
          background: cancelBg,
          backdropFilter: 'blur(34px) saturate(180%)',
          WebkitBackdropFilter: 'blur(34px) saturate(180%)',
          overflow: 'hidden',
          transform: phase === 'open' ? 'translateY(0)' : 'translateY(60px)',
          opacity: phase === 'open' ? 1 : 0,
          transition: `transform 420ms ${SPRING} 60ms, opacity 240ms ease`,
          boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        }}
      >
        <button
          onClick={() => finish(null)}
          style={{
            width: '100%',
            padding: '15px 18px',
            background: 'transparent',
            border: 'none',
            color: text,
            fontSize: 17,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
            letterSpacing: -0.2,
          }}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

const AlertContext = createContext(null);

/**
 * AlertProvider — monta el sistema de alertas. Debe estar dentro del Device
 * (o de un contenedor `position: relative`) para que las alertas se posicionen
 * dentro de la pantalla simulada.
 */
export function AlertProvider({ children, scheme = 'dark' }) {
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    const unsub = alertStore.subscribe((cfg) => setCurrent(cfg));
    return () => unsub();
  }, []);

  const handleClose = useCallback((result) => {
    alertStore.close(result);
  }, []);

  return (
    <AlertContext.Provider value={{ scheme, alert }}>
      {children}
      {current && current.kind === KIND.SHEET && (
        <SheetModal config={current} scheme={scheme} onClose={handleClose} />
      )}
      {current && current.kind !== KIND.SHEET && (
        <AlertModal config={current} scheme={scheme} onClose={handleClose} />
      )}
    </AlertContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useAlert — devuelve la API de alertas. Útil cuando quieres vincular la
 * alerta a un contexto específico (tema, etc.).
 */
export function useAlert() {
  const ctx = useContext(AlertContext);
  if (!ctx) return alert;
  return ctx.alert;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers específicos de iOS Remastered
// ─────────────────────────────────────────────────────────────────────────────

/** Confirmación para eliminar una app instalada. */
export async function confirmUninstall(appName) {
  return alert.destructive({
    title: `Eliminar "${appName}"`,
    message: 'Se eliminarán también todos sus datos.',
    confirm: 'Eliminar',
    cancel: 'Cancelar',
  });
}

/** Confirmación para reiniciar el sistema. */
export async function confirmRestart() {
  return alert.confirm({
    title: 'Reiniciar',
    message: '¿Seguro que quieres reiniciar iOS Remastered?',
    confirm: 'Reiniciar',
  });
}

/** Confirmación para instalar un IPA tras analizarlo. */
export async function confirmInstall(appName, developer) {
  return alert.confirm({
    title: `¿Instalar "${appName}"?`,
    message: developer ? `Desarrollador: ${developer}` : 'Se instalará en el dispositivo.',
    confirm: 'Instalar',
  });
}

/** Prompt para crear carpeta en Archivos. */
export async function promptFolderName() {
  return alert.prompt({
    title: 'Nueva carpeta',
    placeholder: 'Nombre',
    confirm: 'Crear',
  });
}

/** Prompt para renombrar. */
export async function promptRename(oldName) {
  return alert.prompt({
    title: 'Renombrar',
    defaultValue: oldName,
    placeholder: 'Nuevo nombre',
    confirm: 'Renombrar',
  });
}

/** Action sheet típica de long-press sobre una app. */
export async function appContextMenu(app) {
  return alert.sheet({
    title: app.name,
    actions: [
      { label: 'Añadir al Dock', value: 'dock' },
      { label: 'Editar pantalla de inicio', value: 'edit' },
      { label: 'Compartir app', value: 'share' },
      { label: 'Eliminar app', value: 'delete', style: BTN_STYLE.DESTRUCTIVE },
    ],
  });
}

/** Action sheet para la app Archivos. */
export async function fileContextMenu(file) {
  return alert.sheet({
    title: file.name,
    actions: [
      { label: 'Abrir', value: 'open' },
      { label: 'Compartir', value: 'share' },
      { label: 'Mover', value: 'move' },
      { label: 'Duplicar', value: 'dup' },
      { label: 'Renombrar', value: 'rename' },
      { label: 'Eliminar', value: 'delete', style: BTN_STYLE.DESTRUCTIVE },
    ],
  });
}
